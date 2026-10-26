(ns proxx.runtime.runtime-credential-store
  "The credential store the routes and refresh code use (src/lib/runtime-credential-store.ts):
  the SQL store when the host has one, otherwise the file-backed store.")

(defn create-runtime-credential-store-js
  "A store object whose operations go to `sql-store` when present, else to
  `file-store`. `flush` is a no-op with SQL (every write is already durable)."
  [^js file-store ^js sql-store]
  (let [target (or sql-store file-store)]
    #js {:listProviders (fn ^:async list-providers [reveal] (await (.listProviders target reveal)))
         :upsertApiKeyAccount (fn ^:async upsert-api-key [provider-id account-id api-key]
                                (await (.upsertApiKeyAccount target provider-id account-id api-key))
                                js/undefined)
         :upsertOAuthAccount (fn ^:async upsert-oauth [provider-id account-id access-token refresh-token expires-at chatgpt-account-id email subject plan-type]
                               (await (.upsertOAuthAccount target provider-id account-id access-token refresh-token expires-at
                                                           chatgpt-account-id email subject plan-type))
                               js/undefined)
         :flush (fn ^:async flush []
                  (when-not sql-store (await (.flush file-store)))
                  js/undefined)
         :removeAccount (fn ^:async remove-account [provider-id account-id]
                          (await (.removeAccount target provider-id account-id)))}))
