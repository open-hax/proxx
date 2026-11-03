(ns proxx.runtime.auth-persistence
  "Edge of the OAuth persistence tables (`src/lib/auth/sql-persistence.ts`):
  statements are `proxx.auth.persistence`, rows become views through
  `proxx.runtime.sql`, and this namespace only runs them over a postgres.js client."
  (:require [proxx.auth.persistence :as ap]
            [proxx.runtime.db-schema :as db-schema]
            [proxx.runtime.sql :as sql-views]
            [proxx.runtime.sql-util :as u]))

(defn- now-s [] (js/Math.floor (/ (js/Date.now) 1000)))

(defn- json [x] (js/JSON.stringify x))

(defn- optional-json
  "`value ? JSON.stringify(value) : null` (the TS truthiness, kept: persisted)."
  [x] (if (u/truthy? x) (json x) nil))

(defn- token-params [^js t]
  {:token (.-token t) :client-id (.-clientId t) :subject (.-subject t) :scopes-json (json (.-scopes t))
   :resource (let [r (.-resource t)] (if (nil? r) nil r)) :extra-json (optional-json (.-extra t))
   :expires-at (.-expiresAt t)})

(defn create-sql-auth-persistence-js
  "The facade `SqlAuthPersistence` forwards to."
  [^js sql]
  (let [view-of (fn [view rows] (let [row (u/first-row rows)] (if row (view row) js/undefined)))
        select! (fn [table column view key]
                  (.then (u/template-call sql (ap/select-by-id table column key (now-s))) #(view-of view %)))
        run! (fn [stmt] (.then (u/template-call sql stmt) (fn [_] js/undefined)))
        update-extra! (fn [table token extra]
                        (let [{:strs [text values]} (ap/update-token-extra table token (optional-json extra))]
                          (.then (u/unsafe sql text values) (fn [rows] (pos? (.-length rows))))))]
    #js {"init" (fn ^:async init []
                  (doseq [id ap/ddl-statement-ids]
                    (await (.unsafe sql (db-schema/sql-statement-js id))))
                  js/undefined)

         "getSession" (fn [id] (select! "sessions" "id" sql-views/auth-session-view-js id))
         "setSession" (fn [^js s]
                        (run! (ap/upsert-session {:id (.-id s) :subject (.-subject s) :client-id (.-clientId s)
                                                  :scopes-json (json (.-scopes s))
                                                  :resource (let [r (.-resource s)] (if (nil? r) nil r))
                                                  :extra-json (optional-json (.-extra s)) :expires-at (.-expiresAt s)})))
         "deleteSession" (fn [id] (run! (ap/delete-by-key "sessions" "id" id)))

         "getAccessToken" (fn [token] (select! "access_tokens" "token" sql-views/auth-token-view-js token))
         "setAccessToken" (fn [t] (run! (ap/insert-token "access_tokens" (token-params t))))
         "deleteAccessToken" (fn [token] (run! (ap/delete-by-key "access_tokens" "token" token)))
         "updateAccessTokenExtra" (fn [token extra] (update-extra! "access_tokens" token extra))

         "getRefreshToken" (fn [token] (select! "refresh_tokens" "token" sql-views/auth-token-view-js token))
         "setRefreshToken" (fn [t] (run! (ap/insert-token "refresh_tokens" (token-params t))))
         "deleteRefreshToken" (fn [token] (run! (ap/delete-by-key "refresh_tokens" "token" token)))
         "updateRefreshTokenExtra" (fn [token extra] (update-extra! "refresh_tokens" token extra))

         "getClient" (fn [client-id]
                       (.then (u/template-call sql (ap/select-client client-id)) #(view-of sql-views/auth-client-view-js %)))
         "setClient" (fn [^js c]
                       (run! (ap/upsert-client {:client-id (.-clientId c) :client-secret (.-clientSecret c)
                                                :client-name (.-clientName c)
                                                :redirect-uris-json (json (.-redirectUris c))
                                                :token-endpoint-auth-method (.-tokenEndpointAuthMethod c)
                                                :grant-types-json (json (.-grantTypes c))
                                                :response-types-json (json (.-responseTypes c))})))

         "cleanup" (fn ^:async cleanup []
                     (let [now (now-s)
                           sessions (await (u/template-call sql (ap/delete-expired "sessions" now)))
                           access (await (u/template-call sql (ap/delete-expired "access_tokens" now)))
                           refresh (await (u/template-call sql (ap/delete-expired "refresh_tokens" now)))]
                       (+ (.-count sessions) (.-count access) (.-count refresh))))}))
