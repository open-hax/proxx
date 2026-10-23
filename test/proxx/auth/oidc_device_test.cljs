;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.oidc-device-test
  (:require [cljs.test :refer [async deftest is]]
            [proxx.auth.oidc-device :as device]
            [proxx.auth.oidc-runtime :as runtime]
            [proxx.auth.oidc-integration-test :as browser]
            [proxx.extern.oidc-client :as io]
            [proxx.extern.oidc-http :as http]
            [proxx.extern.oidc-fixture :as fixture]
            ["fastify" :default Fastify]))

(defn- ^:async refused? [operation]
  (try (await operation) false (catch :default _ true)))

(defn- setup []
  (let [f (fixture/create) state (runtime/create-state)
        config (assoc (io/require-config! (js->clj (browser/raw-config f) :keywordize-keys true)) :deviceEnabled true)
        native (browser/adapters)]
    {:fixture f :state state :config config
     :adapters {:get-user (.-getUser native) :get-memberships (.-getMemberships native) :now io/now}}))

(defn- ^:async transaction* []
  (let [{:keys [state config adapters]} (setup)]
    (is (await (refused? (device/begin! state config "https://evil.invalid" nil))))
    (let [result (await (device/begin! state config fixture/origin nil))
          handle (:handle result) id (io/digest handle)
          visible (:public result)]
      (try
        (is (= #{:user_code :verification_uri :verification_uri_complete :expires_in :interval} (set (keys visible))))
        (is (not (.includes (pr-str visible) "device_code")))
        (is (await (refused? (device/poll! state config adapters fixture/origin "wrong-browser"))))
        (is (= "pending" (:status (await (device/poll! state config adapters fixture/origin handle)))))
        (is (= 10 (:interval (await (device/poll! state config adapters fixture/origin handle)))))
        (await (device/cancel! state config id))
        (is (await (refused? (device/poll! state config adapters fixture/origin handle))))
        (is (empty? @(:sessions state)))
        (finally (await (device/cancel! state config id)))))))

(deftest device-cookie-origin-cancel-and-backoff
  (async done (-> (transaction*) (.catch (fn [e] (is false (str e)))) (.finally done))))

(defn- ^:async protocol* []
  (let [{:keys [fixture state config adapters]} (setup)
        result (await (device/begin! state config fixture/origin nil))
        handle (:handle result) id (io/digest handle)]
    (try
      (swap! (:mode fixture) assoc :device-status :approved)
      ;; The pinned library's worker waits its advertised RFC8628 interval.
      (let [waited (js/Promise. (fn [resolve _] (js/setTimeout resolve 5500)))] (await waited))
      (let [result (await (device/poll! state config adapters fixture/origin handle))]
        (is (= "complete" (:status result)))
        (is (= fixture/subject (:subject (runtime/session state (:handle result)))))
        (is (not (.includes (pr-str (select-keys result [:status :interval])) "access"))))
      (is (await (refused? (device/poll! state config adapters fixture/origin handle))))
      (finally (await (device/cancel! state config id))))))

(deftest actual-rp-device-grant-and-local-linkage
  (async done (-> (protocol*) (.catch (fn [e] (is false (str e)))) (.finally done))))

(defn- ^:async http* []
  (let [f (fixture/create) ^js app (Fastify #js {:logger false})
        raw (browser/raw-config f)
        _ (aset raw "deviceEnabled" true)
        ^js consumer (http/create-consumer-js raw (browser/adapters))]
    (.register consumer app)
    (try
      (let [^js denied (await (.inject app #js {:method "POST" :url "/api/auth/axxium/device/start"}))
            ^js response (await (.inject app #js {:method "POST" :url "/api/auth/axxium/device/start"
                                                 :headers #js {:origin fixture/origin}}))
            cookie (browser/cookie response)
            visible (js->clj (.json response) :keywordize-keys true)
            ^js wrong (await (.inject app #js {:method "POST" :url "/api/auth/axxium/device/poll"
                                             :headers #js {:origin fixture/origin}}))
            ^js cancelled (await (.inject app #js {:method "POST" :url "/api/auth/axxium/device/cancel"
                                                  :headers #js {:origin fixture/origin :cookie cookie}}))]
        (is (= 403 (.-statusCode denied)))
        (is (= 200 (.-statusCode response)))
        (is (not (contains? visible :device_code)))
        (is (.includes (aget (.-headers response) "set-cookie") "HttpOnly"))
        (is (= 400 (.-statusCode wrong)))
        (is (= 200 (.-statusCode cancelled))))
      (finally (await (.close app))))))

(deftest mounted-device-endpoints-never-expose-protocol-codes
  (async done (-> (http*) (.catch (fn [e] (is false (str e)))) (.finally done))))

(defn- ^:async protocol-refusals* []
  (doseq [[mode expected] [[{:device-status :denied} "denied"]
                          [{:device-status :expired} "expired"]
                          [{:device-status :approved :device-claims {:sub "unlinked-actor"}} nil]]]
    (let [{:keys [fixture state config adapters]} (setup)
          _ (reset! (:mode fixture) mode)
          result (await (device/begin! state config fixture/origin nil))
          handle (:handle result) id (io/digest handle)]
      (try
        (await (js/Promise. (fn [resolve _] (js/setTimeout resolve 5500))))
        (if expected
          (is (= expected (:status (await (device/poll! state config adapters fixture/origin handle)))))
          (is (await (refused? (device/poll! state config adapters fixture/origin handle)))))
        (is (empty? @(:sessions state)))
        (finally (await (device/cancel! state config id)))))))

(deftest device-denial-expiry-and-unlinked-subject-refuse-product-admission
  (async done (-> (protocol-refusals*) (.catch (fn [e] (is false (str e)))) (.finally done))))
