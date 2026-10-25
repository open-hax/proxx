(ns proxx.http.settings
  "Pure decisions of the settings/tenant routes: who may change what, and what
  a request body means. Effects (stores, session persistence, logging) are the
  edge's business."
  (:require [clojure.string :as str]
            [proxx.http.guard :as guard]
            [proxx.http.ui-auth :as ui-auth]))

(def default-tenant-id "default")

(defn tenant-id-of [auth] (or (get auth "tenantId") default-tenant-id))

;; ---------------------------------------------------------------------------
;; POST settings
;; ---------------------------------------------------------------------------

(defn- may-write-settings? [auth]
  (case (get auth "kind")
    "tenant_api_key" false
    "ui_session" (contains? #{"owner" "admin"} (get auth "role"))
    true))

(def ^:private settings-fields
  "Validated settings fields: [body-key parser error-code]."
  [["requestsPerMinute" ui-auth/parse-optional-requests-per-minute "invalid_requests_per_minute"]
   ["allowedProviderIds" ui-auth/parse-optional-provider-ids "invalid_allowed_provider_ids"]
   ["allowedModels" ui-auth/parse-optional-model-ids "invalid_allowed_models"]
   ["disabledProviderIds" ui-auth/parse-optional-provider-ids "invalid_disabled_provider_ids"]])

(defn- parse-fields
  "{:patch {key value ...}} for the provided, valid fields; {:error code} for the
  first provided-but-invalid one (in declaration order). Absent fields are
  omitted from the patch (the store reads absence as \"unchanged\"); null is kept
  (the store reads it as \"clear\")."
  [body]
  (reduce (fn [{:keys [patch]} [k parse code]]
            (let [raw (get body k ::ui-auth/absent)
                  parsed (parse raw)]
              (cond
                (and (not= ::ui-auth/absent raw) (= ::ui-auth/absent parsed)) (reduced {:error code})
                (= ::ui-auth/absent parsed) {:patch patch}
                :else {:patch (assoc patch k parsed)})))
          {:patch {}} settings-fields))

(defn settings-update
  "Decide a settings update: {:response r} to reply with, or {:tenant-id :patch}
  to hand to the settings store (patch keys are the wire names)."
  [auth body]
  (if-let [denied (or (guard/require-auth {:auth auth})
                      (guard/forbid-unless (may-write-settings? auth)))]
    {:response denied}
    (let [{:keys [patch error]} (parse-fields body)]
      (if error
        {:response (guard/error 400 error)}
        {:tenant-id (tenant-id-of auth)
         :patch (cond-> patch
                  (contains? body "fastMode") (assoc "fastMode" (ui-auth/parse-boolean (get body "fastMode"))))}))))

;; ---------------------------------------------------------------------------
;; API keys
;; ---------------------------------------------------------------------------

(defn new-api-key-spec
  "{:label :scopes} for a create-key request, or {:error \"label_required\"}."
  [body]
  (let [label (let [l (get body "label")] (if (string? l) (str/trim l) ""))
        scopes (let [s (get body "scopes")]
                 (if (sequential? s) (filterv string? s) ["proxy:use"]))]
    (if (empty? label) {:error "label_required"} {:label label :scopes scopes})))
