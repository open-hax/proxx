;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.oidc-integration-test
  (:require [clojure.string]
            [cljs.test :refer [deftest is use-fixtures]]
            [proxx.auth.oidc-runtime :as runtime]
            [proxx.extern.oidc-client :as io]
            [proxx.extern.oidc-http :as http]
            [proxx.extern.oidc-fixture :as fixture]
            ["fastify" :default Fastify]))

(use-fixtures :each {})

(deftest pinned-relying-party-is-installed
  (is (fn? (.-discovery ^js (io/library!)))))

(defn adapters []
  #js {:getUser (fn [id] (js/Promise.resolve #js {:id id :subject "retained-local-owner"}))
       :getMemberships (fn [_] (js/Promise.resolve
                                #js [#js {:tenantId "local-tenant" :tenantStatus "active" :role "viewer"}]))})

(defn raw-config [fixture]
  #js {:issuer fixture/issuer :publicOrigin fixture/origin :clientId fixture/client-id
       :clientSecret fixture/secret :transport (:transport fixture)
       :linksJson (js/JSON.stringify #js [#js {:issuer fixture/issuer :subject fixture/subject :userId "local-id"}])})

(defn cookie [^js response]
  (let [value (aget (.-headers response) "set-cookie")]
    (if (array? value) (->> (array-seq value)
                          (remove #(.includes % "Max-Age=0"))
                          (map #(first (.split % ";")))
                          (clojure.string/join "; "))
        (first (.split value ";")))))

(defn ^:async browser-flow! [^js app fixture]
  (let [^js start (await (.inject app #js {:url "/api/auth/axxium/start"}))
        location (or (aget (.-headers start) "location")
                     (throw (ex-info "Start refused; check relying-party dependency and authority fixture" {})))
        code ((:issue-code fixture) location)
        callback (str "/api/auth/axxium/callback?code=" (:code code) "&state=" (:state code))]
    {:start start :issued code :callback callback
     :response (await (.inject app #js {:url callback :headers #js {:cookie (cookie start)}}))}))

(defn app [fixture]
  (let [^js app (Fastify #js {:logger false})
        ^js consumer (http/create-consumer-js (raw-config fixture) (adapters))]
    (.register consumer app)
    (.addHook app "onRequest"
              (fn ^:async admission [^js request ^js reply]
                (when-not (.isPublicPath consumer (first (.split (.-url request) "?")))
                  (let [auth (await (.admit consumer request reply))]
                    (when-not (.-sent reply)
                      (if auth (aset request "oidcTestAuth" auth)
                          (do (.code reply 401) (.send reply #js {:error "unauthorized"}))))))))
    (.get app "/protected" (fn [request _reply] (aget request "oidcTestAuth")))
    app))

(deftest ^:async browser-pkce-protected-context-and-revocation
  (let [fixture (fixture/create) ^js server (app fixture)]
    (try
      (let [{:keys [start issued response callback]} (await (browser-flow! server fixture))
            ^js response response
            parameters (:parameters issued)
            session-cookie (cookie response)]
        (is (= 302 (.-statusCode start)))
        (is (= "S256" (:code_challenge_method parameters)))
        (is (= (str fixture/origin "/api/auth/axxium/callback") (:redirect_uri parameters)))
        (is (string? (:nonce parameters)))
        (is (= 302 (.-statusCode response)))
        (is (not (.includes session-cookie "opaque-fixture")))
        (let [^js protected (await (.inject server #js {:url "/protected" :headers #js {:cookie session-cookie}}))
              auth (js->clj (.json protected) :keywordize-keys true)]
          (is (= 200 (.-statusCode protected)))
          (is (= "retained-local-owner" (:subject auth)))
          (is (= "viewer" (:role auth)))
          (is (= fixture/subject (get-in auth [:oidc :subject]))))
        (is (= 400 (.-statusCode (await (.inject server #js {:url callback :headers #js {:cookie (cookie start)}})))))
        (swap! (:mode fixture) assoc :evidence {:active false})
        (is (= 401 (.-statusCode (await (.inject server #js {:url "/protected" :headers #js {:cookie session-cookie}})))))
        (reset! (:mode fixture) {})
        (let [next-flow (await (browser-flow! server fixture))]
          (swap! (:mode fixture) assoc :unavailable true)
          (is (= 503 (.-statusCode (await (.inject server #js {:url "/protected" :headers #js {:cookie (cookie (:response next-flow))}})))))))
      (catch :default error (is false (str "OIDC fixture failed: " (.-message error))))
      (finally (await (.close server))))))

(deftest ^:async library-refuses-nonce-issuer-audience-and-pkce-substitution
  (try
    (doseq [bad-claims [{:nonce "wrong"} {:iss "https://evil.example/oidc"} {:aud "other-client"}]]
      (let [fixture (fixture/create) ^js server (app fixture)]
        (try
          (reset! (:mode fixture) {:claims bad-claims})
          (let [{:keys [response]} (await (browser-flow! server fixture))]
            (is (not= 302 (.-statusCode response)))
            (is (nil? (aget (.-headers response) "location"))))
          (catch :default error (is false (str "OIDC fixture failed: " (.-message error))))
          (finally (await (.close server))))))
    (let [fixture (fixture/create) state (runtime/create-state)
          config (io/require-config! (js->clj (raw-config fixture) :keywordize-keys true))
          begin (await (runtime/begin! state config (io/now)))
          issued ((:issue-code fixture) (:url begin))
          tx (runtime/consume! state (:state issued) (:binding begin) (io/now))
          rp (await (runtime/relying-party! state config))]
      (try
        (await (io/exchange! rp config (str "?code=" (:code issued) "&state=" (:state issued))
                             (assoc tx :verifier "wrong-verifier")))
        (is false "real relying-party exchange must reject invalid PKCE")
        (catch :default _ (is (= 1 @(:exchanges fixture))))))
    (catch :default error (is false (str "OIDC fixture failed: " (.-message error))))))

(deftest ^:async callback-state-collision-outage-and-logout
  (let [fixture (fixture/create) ^js server (app fixture)]
    (try
      (let [^js start (await (.inject server #js {:url "/api/auth/axxium/start"}))
            issued ((:issue-code fixture) (aget (.-headers start) "location"))
            ^js wrong-browser (await (.inject server #js {:url (str "/api/auth/axxium/callback?code=" (:code issued) "&state=" (:state issued))}))]
        (is (= 400 (.-statusCode wrong-browser)))
        (is (= 0 @(:exchanges fixture))))
      (swap! (:mode fixture) assoc :claims {:sub "collision@example.com"})
      (let [{:keys [response]} (await (browser-flow! server fixture))]
        (is (= 403 (.-statusCode response)))
        (is (= "account_link_required" (aget (.json response) "error"))))
      (reset! (:mode fixture) {})
      (let [{:keys [response]} (await (browser-flow! server fixture))
            headers #js {:cookie (cookie response) :origin fixture/origin}
            ^js forbidden (await (.inject server #js {:method "POST" :url "/api/auth/axxium/logout" :headers #js {:cookie (cookie response) :origin "https://evil.example"}}))
            ^js logout (await (.inject server #js {:method "POST" :url "/api/auth/axxium/logout" :headers headers}))]
        (is (= 403 (.-statusCode forbidden)))
        (is (= 200 (.-statusCode logout)))
        (is (pos? (count @(:revoked fixture))))
        (is (= 401 (.-statusCode (await (.inject server #js {:url "/protected" :headers headers}))))))
      (reset! (:mode fixture) {:unavailable true})
      ;; Cached discovery may construct an authorization redirect while the
      ;; authority is offline. It must never complete or admit a product grant.
      (let [^js start (await (.inject server #js {:url "/api/auth/axxium/start"}))
            issued ((:issue-code fixture) (aget (.-headers start) "location"))
            ^js callback (await (.inject server
                                #js {:url (str "/api/auth/axxium/callback?code=" (:code issued) "&state=" (:state issued))
                                     :headers #js {:cookie (cookie start)}}))]
        (is (= 302 (.-statusCode start)))
        (is (= 503 (.-statusCode callback)))
        (is (nil? (aget (.-headers callback) "location")))
        (is (= 401 (.-statusCode (await (.inject server #js {:url "/protected"}))))))
      (catch :default error (is false (str "OIDC fixture failed: " (.-message error))))
      (finally (await (.close server))))))
