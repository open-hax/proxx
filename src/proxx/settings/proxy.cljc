(ns proxx.settings.proxy
  "Pure normalization and merging of the proxy's runtime settings.

  A settings value is the string-keyed camelCase map that is persisted as JSON
  (`config` row or settings file):
    {\"fastMode\" bool \"requestsPerMinute\" int|nil \"allowedModels\" [str]|nil
     \"allowedProviderIds\" [str]|nil \"disabledProviderIds\" [str]|nil}
  Input is untrusted: anything unusable collapses to the default for that field.
  Keys are accepted in camelCase, kebab-case or snake_case, as the CLJS key
  normalizer the TypeScript store used accepted them."
  (:require [clojure.string :as str]
            [proxx.json :as json]
            [proxx.jsval :as j]))

(def default-settings
  {"fastMode" false
   "requestsPerMinute" nil
   "allowedModels" nil
   "allowedProviderIds" nil
   "disabledProviderIds" nil})

(def config-key "proxy_settings")

(def setting-keys
  "Canonical field order (it is the order of persisted JSON)."
  ["fastMode" "requestsPerMinute" "allowedModels" "allowedProviderIds" "disabledProviderIds"])

(defn- kebab-key [k]
  (-> k (str/replace #"([A-Z])" "-$1") (str/replace #"_" "-") str/lower-case))

(defn- id-list
  "Distinct trimmed lower-cased strings of an array, nil when none or not an array."
  [value]
  (when (vector? value)
    (let [ids (vec (distinct (remove empty? (map (comp j/lower j/trim) (filter string? value)))))]
      (when (seq ids) ids))))

(defn- floor [x] #?(:cljs (js/Math.floor x) :clj (Math/floor (double x))))

(defn normalize-settings
  "A complete settings map from a stored/submitted value: a JSON string, an
  object, or junk (which yields the defaults)."
  [value]
  (cond
    (string? value)
    (let [parsed (try {:ok (json/parse value)} (catch #?(:cljs :default :clj Exception) _ nil))]
      (if parsed (normalize-settings (:ok parsed)) default-settings))

    (or (map? value) (vector? value))
    (let [settings (if (map? value) (reduce-kv (fn [m k v] (assoc m (kebab-key k) v)) {} value) {})
          fast (get settings "fast-mode")
          rpm (get settings "requests-per-minute")]
      {"fastMode" (if (boolean? fast) fast false)
       "requestsPerMinute" (when (j/finite? rpm) (max 1 (floor rpm)))
       "allowedModels" (id-list (get settings "allowed-models"))
       "allowedProviderIds" (id-list (get settings "allowed-provider-ids"))
       "disabledProviderIds" (id-list (get settings "disabled-provider-ids"))})

    :else default-settings))

(defn merge-settings
  "`next` laid over `current`: a key present in `next` wins even when its value is nil."
  [current next]
  (merge current next))

(defn tenant-key
  "The `config` row key for a normalized tenant id."
  [tenant-id default-tenant-id]
  (if (= tenant-id default-tenant-id) config-key (str config-key ":" tenant-id)))

(defn settings-tenant-id
  "The tenant a settings call addresses: the default for a missing/blank id,
  else `normalize-tenant-id` of it (which may throw for an invalid id)."
  [tenant-id default-tenant-id normalize-tenant-id]
  (if (and (string? tenant-id) (seq (j/trim tenant-id)))
    (normalize-tenant-id tenant-id)
    default-tenant-id))
