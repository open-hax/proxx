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
    (is (nil? (runtime/session state handle)))))

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
