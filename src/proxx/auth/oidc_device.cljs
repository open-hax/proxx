;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.oidc-device
  "Server-only bounded device transactions, with cancellation as an admission fence."
  (:require [proxx.auth.oidc-law :as law]
            [proxx.auth.oidc-runtime :as runtime]
            [proxx.extern.oidc-client :as io]))

(defn require-origin! [config origin]
  (when-not (and (:deviceEnabled config) (law/same-origin? config origin))
    (throw (ex-info "invalid_origin" {:status 403 :error "invalid_origin"}))))

(defn- ^:async revoke! [state config grant]
  (when grant
    (try (await (io/revoke-session! (await (runtime/relying-party! state config)) grant))
         (catch :default _ nil))))

(defn ^:async cancel! [state config id]
  (let [[before _] (swap-vals! (:devices state) dissoc id)]
    (when-let [tx (get before id)]
      (when (:handle tx) (io/cancel-device! (:handle tx)))
      (await (revoke! state config (:grant tx))))))

(defn- ^:async expire! [state config id]
  ;; Drop the sensitive handle immediately, retaining only a public terminal status.
  (when-let [tx (get @(:devices state) id)]
    (swap! (:devices state) assoc id
           {:status "expired" :expires-at (+ (io/now) 60000) :next-poll 0 :public {:interval 5}})
    (await (revoke! state config (:grant tx)))))

(defn- ^:async work! [state config rp id tx]
  (try
    (let [grant (await (io/device-grant! rp config (:handle tx)))
          current (get @(:devices state) id)]
      (if (and (= (:handle tx) (:handle current)) (= "pending" (:status current))
               (< (io/now) (:expires-at tx)))
        (swap! (:devices state) update id assoc :status "ready" :grant grant)
        (await (revoke! state config grant))))
    (catch :default error
      (when-let [current (get @(:devices state) id)]
        (when (and (= (:handle tx) (:handle current)) (= "pending" (:status current)))
          (swap! (:devices state) update id assoc :status (io/device-failure error)))))))

(defn ^:async begin! [state config origin previous]
  (require-origin! config origin)
  (await (cancel! state config previous))
  (doseq [[id tx] @(:devices state)]
    (when (<= (:expires-at tx) (io/now)) (await (cancel! state config id))))
  (when (>= (count @(:devices state)) law/max-transactions)
    (throw (ex-info "login_busy" {:status 503 :error "login_busy"})))
  (let [rp (await (runtime/relying-party! state config))
        result (await (io/device-start! rp config))
        handle (io/random-secret) id (io/digest handle)
        tx (assoc result :status "pending" :next-poll 0)]
    (when (>= (count @(:devices state)) law/max-transactions)
      (when (:handle tx) (io/cancel-device! (:handle tx)))
      (throw (ex-info "login_busy" {:status 503 :error "login_busy"})))
    (swap! (:devices state) assoc id tx)
    (io/on-device-expiry! (:handle tx) #(expire! state config id))
    (work! state config rp id tx)
    {:handle handle :public (:public tx)}))

(defn ^:async poll! [state config adapters origin handle]
  (require-origin! config origin)
  (let [id (when handle (io/digest handle))
        tx (get @(:devices state) id) now (io/now)]
    (case (law/device-poll-admission tx now)
      :refuse (throw (ex-info "invalid_device_transaction" {:status 400 :error "invalid_device_transaction"}))
      :expired (do (await (cancel! state config id)) {:status "expired"})
      :slow (let [interval (+ 5 (get-in tx [:public :interval]))]
              (swap! (:devices state) update id #(-> % (assoc-in [:public :interval] interval)
                                                       (assoc :next-poll (+ now (* 1000 interval)))))
              {:status "pending" :http-status 429 :interval interval})
      :continue
      (let [updated (assoc tx :next-poll (+ now (* 1000 (get-in tx [:public :interval]))))]
        (swap! (:devices state) assoc id updated)
        (case (:status tx)
          "ready" (let [completing (assoc updated :status "completing")]
                    (swap! (:devices state) assoc id completing)
                    (try
                      (assoc (await (runtime/establish! state config adapters (:grant tx)
                                      #(= completing (get @(:devices state) id)) now)) :status "complete")
                      (finally (swap! (:devices state) dissoc id))))
          "pending" {:status "pending" :interval (get-in tx [:public :interval])}
          (do (await (cancel! state config id)) {:status (:status tx)}))))))
