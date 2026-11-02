(ns proxx.proxy.sessions-test
  "Session routes (legacy UI surface and canonical /api/v1 control plane) and the credential
   summary route. Ported from src/tests/proxy.test.ts."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-d :as h :refer [with-proxy-app]]))

(defn- json-ok [body] {:status 200 :headers {"content-type" "application/json"} :body (h/json-str body)})

(defn- opts-for [extra]
  (merge {:keys ["key-a"] :upstream-handler (fn [_ _] (json-ok {"ok" true}))} extra))

(defn- auth-headers [token extra]
  (merge (when token {"authorization" (str "Bearer " token)}) extra))

(defn- post [app token url payload]
  (h/inject app {:method "POST" :url url :headers (auth-headers token {"content-type" "application/json"}) :payload payload}))

(defn- get-req [app token url]
  (h/inject app (cond-> {:method "GET" :url url}
                  token (assoc :headers (auth-headers token {})))))

(defn- non-empty-string? [x] (and (string? x) (pos? (count x))))

(defn- ^:async check-cache-keys [token title]
  (await
   (with-proxy-app
     (opts-for (when token {:proxy-auth-token token}))
     (fn ^:async run [{:keys [app]}]
      (let [created (await (post app token "/api/v1/sessions" {"title" title}))
            session (get (:json created) "session")
            prompt-cache-key (get session "promptCacheKey")
            session-id (get session "id")]
        (is (= 201 (:status created)))
        (is (map? (:json created)))
        (is (map? session))
        (is (non-empty-string? prompt-cache-key))
        (is (non-empty-string? session-id))
        (let [ck (await (get-req app token (str "/api/v1/sessions/" session-id "/cache-key")))
              got (await (get-req app token (str "/api/v1/sessions/" session-id)))]
          (is (= 200 (:status ck)))
          (is (map? (:json ck)))
          (is (= prompt-cache-key (get (:json ck) "promptCacheKey")))
          (is (map? (:json got)))
          (is (map? (get (:json got) "session")))
          (is (= prompt-cache-key (get-in (:json got) ["session" "promptCacheKey"])))))))))

(defn- ^:async check-append-fork-search [token title content query]
  (await
   (with-proxy-app
     (opts-for (when token {:proxy-auth-token token}))
     (fn ^:async run [{:keys [app]}]
      (let [created (await (post app token "/api/v1/sessions" {"title" title}))
            session-id (get-in created [:json "session" "id"])]
        (is (= 201 (:status created)))
        (is (map? (:json created)))
        (is (map? (get (:json created) "session")))
        (is (non-empty-string? session-id))
        (let [appended (await (post app token (str "/api/v1/sessions/" session-id "/messages")
                                    {"role" "user" "content" content}))]
          (is (= 201 (:status appended)))
          (is (map? (:json appended)))
          (is (= session-id (get (:json appended) "sessionId")))
          (is (map? (get (:json appended) "message")))
          (is (= content (get-in (:json appended) ["message" "content"]))))
        (let [forked (await (post app token (str "/api/v1/sessions/" session-id "/fork") {}))
              fork-session (get (:json forked) "session")]
          (is (= 201 (:status forked)))
          (is (map? (:json forked)))
          (is (map? fork-session))
          (is (= session-id (get fork-session "forkedFromSessionId")))
          (is (vector? (get fork-session "messages")))
          (is (= 1 (count (get fork-session "messages")))))
        (let [searched (await (post app token "/api/v1/sessions/search" {"query" query "limit" 5}))
              body (:json searched)]
          (is (= 200 (:status searched)))
          (is (map? body))
          (is (contains? #{"fallback" "chroma"} (get body "source")))
          (is (vector? (get body "results")))
          (is (>= (count (get body "results")) 1))
          (is (map? (first (get body "results"))))
          (is (= session-id (get-in body ["results" 0 "sessionId"])))))))))

(deftest ^:async persists-stable-prompt-cache-keys-on-sessions-and-exposes-them-via-ui-api
  (await (check-cache-keys nil "Caching test")))

(deftest ^:async session-ui-routes-support-append-fork-and-search-after-extraction-from-ui-routes-monolith
  (await (check-append-fork-search nil "Session route extraction test"
                                   "hello extracted session routes" "extracted session routes")))

(deftest ^:async api-v1-sessions-persist-stable-prompt-cache-keys-and-expose-them-via-canonical-control-plane-routes
  (await (check-cache-keys "ui-token" "Canonical caching test")))

(deftest ^:async api-v1-sessions-support-append-fork-and-search-on-canonical-control-plane-routes
  (await (check-append-fork-search "ui-token" "Canonical session route extraction test"
                                   "hello canonical session routes" "canonical session routes")))

(defn- ^:async check-credentials-summary []
  (await
   (h/with-cleared-ambient-providers
     (fn ^:async run []
      (await
       (with-proxy-app
         {:keys []
          :keys-payload {"providers" {"vivgrid" {"auth" "api_key" "accounts" [{"id" "viv-a" "api_key" "viv-secret-a"}]} ; pragma: allowlist secret
                                      "openai" {"auth" "oauth_bearer"
                                                "accounts" [{"id" "openai-a" "access_token" "openai-secret-a" ; pragma: allowlist secret
                                                             "refresh_token" "refresh-a"}]}}}
          :upstream-handler (fn [_ _] (json-ok {"ok" true}))}
         (fn ^:async run [{:keys [app]}]
          (let [hidden (await (h/inject app {:method "GET" :url "/api/v1/credentials"}))
                payload (:json hidden)
                first-account (get-in payload ["providers" 0 "accounts" 0])]
            (is (= 200 (:status hidden)))
            (is (map? payload))
            (is (vector? (get payload "providers")))
            (is (= 2 (count (get payload "providers"))))
            (is (map? (get-in payload ["providers" 0])))
            (is (vector? (get-in payload ["providers" 0 "accounts"])))
            (is (map? first-account))
            (is (not (contains? first-account "secret")))
            (is (string? (get first-account "secretPreview")))
            (is (map? (get payload "keyPoolStatuses")))
            (is (map? (get payload "requestLogSummary")))
            (let [revealed (await (h/inject app {:method "GET" :url "/api/v1/credentials?reveal=1"}))
                  rp (:json revealed)
                  vivgrid (first (filter #(= "vivgrid" (get % "id")) (get rp "providers")))]
              (is (= 200 (:status revealed)))
              (is (map? rp))
              (is (vector? (get rp "providers")))
              (is (some? vivgrid))
              (is (vector? (get vivgrid "accounts")))
              (is (= "viv-secret-a" (get-in vivgrid ["accounts" 0 "secret"]))))))))))))

(deftest ^:async credential-summary-route-works-after-extraction-from-ui-routes-monolith
  (await (check-credentials-summary)))

(deftest ^:async api-v1-credentials-summary-route-works-on-the-canonical-control-plane-surface
  (await (check-credentials-summary)))
