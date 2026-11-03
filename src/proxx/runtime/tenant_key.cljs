(ns proxx.runtime.tenant-key
  "JS edge for src/lib/tenant-api-key.ts: randomness and sha256 live here, the
  derivations in proxx.routing.tenant-key. Domain errors are rethrown as plain
  Errors with the original message."
  (:require ["node:crypto" :as crypto]
            [proxx.routing.tenant-key :as tk]))

(defn- rethrow-as-error [e]
  (throw (if (ex-data e) (js/Error. (ex-message e)) e)))

(defn- sha256-hex [s]
  (-> (.createHash crypto "sha256") (.update s) (.digest "hex")))

(defn tenant-api-key-constants-js []
  #js {:defaultTenantId tk/default-tenant-id
       :apiKeyPrefix tk/api-key-prefix
       :visiblePrefixLength tk/visible-prefix-length})

(defn normalize-tenant-id-js [value]
  (try (tk/normalize-tenant-id value) (catch :default e (rethrow-as-error e))))

(defn generate-tenant-api-key-js []
  (str tk/api-key-prefix (.toString (.randomBytes crypto 24) "base64url")))

(defn build-tenant-api-key-prefix-js [token]
  (try (tk/key-prefix token) (catch :default e (rethrow-as-error e))))

(defn hash-tenant-api-key-js [token pepper]
  (try (tk/key-hash sha256-hex token pepper) (catch :default e (rethrow-as-error e))))
