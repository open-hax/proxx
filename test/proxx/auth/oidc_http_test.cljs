;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.auth.oidc-http-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.extern.oidc-http :as http]
            ["fastify" :default Fastify]))

(deftest ^:async invalid-cookie-never-enters-a-protected-handler
  (let [^js app (Fastify #js {:logger false})
        protected-effects (atom 0)
        ^js consumer (http/create-consumer-js
                       #js {:issuer "https://authority.example/oidc"
                            :publicOrigin "https://proxx.example"
                            :clientId "synthetic-client" :clientSecret "synthetic-secret"
                            :linksJson "[]"}
                       #js {:getUser (fn [_] (throw (js/Error. "must not read local identity")))
                            :getMemberships (fn [_] (throw (js/Error. "must not read memberships")))})]
    (.register consumer app)
    (.addHook app "onRequest"
              (fn ^:async protect [request reply]
                (when-not (.isPublicPath consumer (first (.split (.-url request) "?")))
                  (await (.admit consumer request reply)))))
    (.get app "/protected" (fn [_request _reply] (swap! protected-effects inc) #js {:secret "not delivered"}))
    (try
      (let [^js refused (await (.inject app #js {:url "/protected"
                                                :headers #js {:cookie "__Host-proxx_axxium_session=unknown"}}))
            ^js invalid-state (await (.inject app #js {:url "/api/auth/axxium/callback?state=unknown&code=synthetic"}))
            ^js csrf (await (.inject app #js {:method "POST" :url "/api/auth/axxium/logout"
                                             :headers #js {:origin "https://other.example"}}))]
        (is (= 401 (.-statusCode refused)))
        (is (= "unauthorized" (aget (.json refused) "error")))
        (is (= 0 @protected-effects))
        (is (= 400 (.-statusCode invalid-state)))
        (is (= 403 (.-statusCode csrf)))
        (is (not (.includes (.-body refused) "synthetic-secret"))))
      (catch :default error (is false (str "HTTP refusal fixture failed: " (.-message error))))
      (finally (await (.close app))))))
