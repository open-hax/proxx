;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.oidc-renewal-test
  (:require [cljs.test :refer [async deftest is]]
            [proxx.auth.oidc-runtime :as runtime]
            [proxx.auth.oidc-integration-test :as browser]
            [proxx.extern.oidc-client :as io]
            [proxx.extern.oidc-fixture :as fixture]))

(defn- ^:async setup! []
  (let [f (fixture/create) state (runtime/create-state)
        config (io/require-config! (js->clj (browser/raw-config f) :keywordize-keys true))
        native (browser/adapters)
        adapters {:get-user (.-getUser native) :get-memberships (.-getMemberships native) :now io/now}
        begin (await (runtime/begin! state config (io/now)))
        issued ((:issue-code f) (:url begin))
        tx (runtime/consume! state (:state issued) (:binding begin) (io/now))
        login (await (runtime/complete! state config adapters (str "?code=" (:code issued) "&state=" (:state issued)) tx (io/now)))]
    {:fixture f :state state :config config :adapters adapters :handle (:handle login)}))

(defn- near-expiry! [{:keys [state handle]}]
  (swap! (:sessions state) update (io/digest handle) assoc :expires-at (+ (io/now) 1000)))

(defn- ^:async refused? [operation]
  (try (await operation) false (catch :default _ true)))

(defn- ^:async renewal* []
  (let [{:keys [state fixture config adapters handle] :as f} (await (setup!))
        initial (runtime/session state handle)
        _ (near-expiry! f)
        results (await (js/Promise.all
                         (into-array (repeatedly 6 #(runtime/verify! state config adapters
                                                       (runtime/session state handle) (io/now))))))
        renewed (runtime/session state handle)]
    (is (= 6 (.-length results)))
    (is (= 1 @(:rotations fixture)) "one maintained-library rotation for concurrent requests")
    (is (not= (:refresh-token initial) (:refresh-token renewed)))
    (is (= (:subject initial) (:subject renewed)))
    (is (= (:session-expires-at initial) (:session-expires-at renewed)) "renewal cannot move the original bound")
    (swap! (:mode fixture) assoc :evidence {:active false})
    (is (await (refused? (runtime/verify! state config adapters renewed (io/now)))))
    (is (nil? (runtime/session state handle)))))

(deftest rotating-renewal-singleflight-and-live-revocation
  (async done (-> (renewal*) (.catch (fn [e] (is false (str e)))) (.finally done))))

(defn- ^:async substitution* []
  (doseq [claims [{:iss "https://other.invalid"} {:aud "other-client"}
                  {:sub "other-actor"} {:nonce "substituted"}]]
    (let [{:keys [state fixture config adapters handle] :as f} (await (setup!))]
      (near-expiry! f)
      (swap! (:mode fixture) assoc :refresh-claims claims)
      (is (await (refused? (runtime/verify! state config adapters (runtime/session state handle) (io/now)))))
      (is (nil? (runtime/session state handle)))))
  (let [{:keys [state fixture config adapters handle] :as f} (await (setup!))]
    (near-expiry! f)
    (swap! (:mode fixture) assoc :refresh-claims {:nonce nil})
    (is (:userId (await (runtime/verify! state config adapters (runtime/session state handle) (io/now)))))
    (near-expiry! f)
    (swap! (:mode fixture) assoc :unavailable true)
    (is (await (refused? (runtime/verify! state config adapters (runtime/session state handle) (io/now)))))
    (is (some? (runtime/session state handle)))
    (reset! (:mode fixture) {})
    (is (:userId (await (runtime/verify! state config adapters (runtime/session state handle) (io/now)))))))

(deftest refreshed-id-token-issuer-audience-subject-nonce-and-outage
  (async done (-> (substitution*) (.catch (fn [e] (is false (str e)))) (.finally done))))

(defn- ^:async logout* []
  (let [{:keys [state fixture config adapters handle] :as f} (await (setup!))
        release (atom nil) started (atom nil)
        barrier (js/Promise. (fn [resolve _] (reset! release resolve)))
        entered (js/Promise. (fn [resolve _] (reset! started resolve)))]
    (near-expiry! f)
    (swap! (:mode fixture) assoc :refresh-wait barrier :refresh-entered #(deref started))
    (let [previous (runtime/session state handle)
          admission (runtime/verify! state config adapters previous (io/now))]
      ;; Wait for the real token endpoint fixture rather than relying on timing.
      (await entered)
      (runtime/remove-session! state handle)
      (@release)
      (is (await (refused? admission)))
      (is (nil? (runtime/session state handle)))
      (is (pos? (count @(:revoked fixture))) "a late rotated grant is revoked"))))

(deftest logout-wins-inflight-refresh-with-orphan-cleanup
  (async done (-> (logout*) (.catch (fn [e] (is false (str e)))) (.finally done))))

(deftest ^:async tenant-selection-during-refresh-preserves-grant-and-selection
  (let [{:keys [state fixture config adapters handle] :as f} (await (setup!))
        release (atom nil) started (atom nil)
        barrier (js/Promise. (fn [resolve _] (reset! release resolve)))
        entered (js/Promise. (fn [resolve _] (reset! started resolve)))]
    (near-expiry! f)
    (swap! (:mode fixture) assoc :refresh-wait barrier :refresh-entered #(deref started))
    (let [admission (runtime/verify! state config adapters (runtime/session state handle) (io/now))]
      (await entered)
      (swap! (:sessions state) update (io/digest handle) assoc :active-tenant-id "local-tenant")
      (@release)
      (is (:userId (await admission)))
      (is (= "local-tenant" (:active-tenant-id (runtime/session state handle))))
      (is (= 1 @(:rotations fixture)))
      (is (empty? @(:revoked fixture))))))

(defn- ^:async straddling* []
  (doseq [old-policy-missing? [false true]]
    (let [{:keys [state fixture config adapters handle]} (await (setup!))
          clock (atom (io/now)) calls (atom 0) release (atom nil) entered (atom nil)
          barrier (js/Promise. (fn [resolve _] (reset! release resolve)))
          started (js/Promise. (fn [resolve _] (reset! entered resolve)))
          blocked (assoc adapters :now #(deref clock)
                    :get-user (fn ^:async get-user [id]
                                (if (= 1 (swap! calls inc))
                                  (do (@entered) (await barrier)
                                      (when-not old-policy-missing? (await ((:get-user adapters) id))))
                                  (await ((:get-user adapters) id)))))]
      (swap! (:sessions state) update (io/digest handle) assoc :expires-at (+ @clock 31000))
      (let [old (runtime/verify! state config blocked (runtime/session state handle) @clock)]
        (await started)
        (swap! clock + 2000)
        (is (:userId (await (runtime/verify! state config blocked (runtime/session state handle) @clock))))
        (@release)
        (if old-policy-missing? (is (await (refused? old))) (is (:userId (await old))))
        (is (some? (runtime/session state handle)))
        (is (= 1 @(:rotations fixture)))
        (is (empty? @(:revoked fixture)))))))

(defn- ^:async run-straddling! [done]
  (try (await (straddling*))
       (catch :default error (is false (str error)))
       (finally (done))))

(deftest an-admission-before-the-renewal-window-cannot-destroy-its-successor
  (async done (run-straddling! done)))

(defn- ^:async bounded-start* []
  (let [{:keys [state config adapters fixture]} (await (setup!)) now (io/now)]
    (reset! (:transactions state)
      (into {} (for [n (range 1000)] [(str "pending-" n) {:created-at (+ (- now 1000) n)}])))
    (let [start (await (runtime/begin! state config now))
          issued ((:issue-code fixture) (:url start))
          tx (runtime/consume! state (:state issued) (:binding start) now)]
      (is (not (contains? @(:transactions state) "pending-0")))
      (is (= 999 (count @(:transactions state))))
      (is (some? tx))
      (is (:handle (await (runtime/complete! state config adapters
                     (str "?code=" (:code issued) "&state=" (:state issued)) tx now)))))))

(defn- ^:async run-bounded-start! [done]
  (try (await (bounded-start*))
       (catch :default error (is false (str error)))
       (finally (done))))

(deftest saturated-pending-transactions-still-permit-a-new-valid-login
  (async done (run-bounded-start! done)))

(defn- ^:async transient-retention* []
  (doseq [rotate? [false true]
          fault [{:introspection-unavailable true} {:introspection-status 503}]]
    (let [{:keys [state fixture config adapters handle] :as f} (await (setup!))
          initial (runtime/session state handle)]
      (when rotate? (near-expiry! f))
      (reset! (:mode fixture) fault)
      (is (await (refused? (runtime/verify! state config adapters (runtime/session state handle) (io/now)))))
      (let [retained (runtime/session state handle)]
        (is (some? retained))
        (is (empty? @(:revoked fixture)))
        (when rotate? (is (not= (:refresh-token initial) (:refresh-token retained)))))
      (reset! (:mode fixture) {})
      (is (:userId (await (runtime/verify! state config adapters (runtime/session state handle) (io/now)))))
      (is (= (if rotate? 1 0) @(:rotations fixture)))))
  (let [{:keys [state fixture config adapters handle] :as f} (await (setup!))]
    (near-expiry! f)
    (reset! (:refreshes fixture) {})
    (is (await (refused? (runtime/verify! state config adapters (runtime/session state handle) (io/now)))))
    (is (nil? (runtime/session state handle)) "confirmed invalid_grant still removes admission")))

(deftest transient-introspection-after-rotation-preserves-retryable-session
  (async done (-> (transient-retention*) (.catch (fn [e] (is false (str e)))) (.finally done))))

(defn- ^:async stale-evidence-retention* []
  (let [{:keys [state fixture config adapters handle]} (await (setup!))
        clock (atom (io/now))
        delayed (assoc adapters :now #(deref clock)
                  :get-user (fn ^:async delayed-user [id]
                              (swap! clock + 6000)
                              (await ((:get-user adapters) id))))]
    (is (await (refused? (runtime/verify! state config delayed (runtime/session state handle) @clock))))
    (is (some? (runtime/session state handle)))
    (is (empty? @(:revoked fixture)))
    (is (:userId (await (runtime/verify! state config (assoc adapters :now #(deref clock))
                         (runtime/session state handle) @clock))))))

(deftest freshness-refusal-does-not-revoke-an-otherwise-current-session
  (async done (-> (stale-evidence-retention*) (.catch (fn [e] (is false (str e)))) (.finally done))))
