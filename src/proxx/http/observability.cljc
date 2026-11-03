(ns proxx.http.observability
  "Decisions for the observability routes (/request-logs, /dashboard/overview,
  /analytics/provider-model, /tools, /mcp-servers): which tenant/key a caller may
  look at, how query values become store filters, and which data source answers
  a usage query. Facts (stores, clocks, the filesystem) are the edge's."
  (:require [clojure.string :as str]
            [proxx.analytics.usage :as usage]
            [proxx.http.guard :as guard]
            [proxx.http.params :as params]
            [proxx.http.ui-auth :as ui-auth]))

(def default-tool-model "gpt-5.3-codex")

(defn- trimmed [v] (when (string? v) (let [t (str/trim v)] (when (seq t) t))))

(defn- unscoped?
  "Callers that see every tenant: the legacy admin and the (auth-disabled) anonymous identity."
  [auth]
  (contains? #{"legacy_admin" "unauthenticated"} (get auth "kind")))

(defn- tenant-of [auth] (let [t (get auth "tenantId")] (when (params/truthy-string? t) t)))
(defn- key-of [auth] (let [k (get auth "keyId")] (when (params/truthy-string? k) k)))

(defn- requested [q]
  {:tenant-id (some-> (trimmed (get q "tenantId")) ui-auth/normalize-tenant-id)
   :issuer (trimmed (get q "issuer"))
   :key-id (trimmed (get q "keyId"))})

(defn- forbidden [] (guard/error 403 "forbidden"))

(defn request-log-scope
  "How a request-logs call is scoped: {:tenant-id :key-id} (either may be nil),
  or {:response r} when the caller asked for something it may not see. Callers
  below the legacy admin default to their own tenant, and a tenant API key is
  pinned to its own key."
  [auth q]
  (let [{:keys [tenant-id key-id]} (requested q)]
    (if (unscoped? auth)
      {:tenant-id tenant-id :key-id key-id}
      (let [tenant-id' (if tenant-id tenant-id (tenant-of auth))]
        (cond
          (and tenant-id (not (ui-auth/can-view-tenant? auth tenant-id))) {:response (forbidden)}
          (and (= "tenant_api_key" (get auth "kind")) key-id (key-of auth) (not= key-id (key-of auth)))
          {:response (forbidden)}
          :else {:tenant-id tenant-id'
                 ;; a tenant API key is pinned to its own key id, even when it has none
                 :key-id (if (= "tenant_api_key" (get auth "kind")) (get auth "keyId") key-id)})))))

(defn- present [m] (into {} (remove (comp nil? val)) m))

(defn request-log-filters
  "The entry filter for the request log listing; absent filters are omitted."
  [q {:keys [tenant-id key-id]}]
  (present {:providerId (get q "providerId")
            :accountId (get q "accountId")
            :tenantId tenant-id
            :issuer (trimmed (get q "issuer"))
            :keyId key-id
            :limit (usage/to-safe-limit (get q "limit") 200 2000)
            :before (let [b (get q "before")] (when (and (string? b) (seq b)) b))}))

(defn usage-scope
  "The {:tenant-id :issuer :key-id} a usage query is computed over, or
  {:response r} (403) when the caller may not view the requested tenant/key."
  [auth q]
  (let [{:keys [tenant-id issuer key-id]} (requested q)]
    (if (unscoped? auth)
      {:scope (present {:tenantId tenant-id :issuer issuer :keyId key-id})}
      (let [tenant-id' (if (some? tenant-id) tenant-id (get auth "tenantId"))]
        (cond
          (and (params/truthy-string? tenant-id') (not (ui-auth/can-view-tenant? auth tenant-id'))) {:response (forbidden)}
          (= "tenant_api_key" (get auth "kind"))
          (if (and key-id (key-of auth) (not= key-id (key-of auth)))
            {:response (forbidden)}
            {:scope (present {:tenantId tenant-id' :issuer issuer :keyId (get auth "keyId")})})
          :else {:scope (present {:tenantId tenant-id' :issuer issuer :keyId key-id})})))))

(defn tool-model
  "The model a /tools query asks about (trimmed), defaulting to the Codex model."
  [q]
  (or (trimmed (get q "model")) default-tool-model))

(defn overview-source
  "Which source answers a dashboard overview: :sql (the usage table), :scoped
  (in-memory entries filtered to the scope), :entries (the whole in-memory log)
  or :rollups (persisted buckets, when the log is empty or holds only what the
  buckets of a wider window already cover)."
  [{:keys [sql? scoped? log-count persisted-rollups?]}]
  (cond sql? :sql
        scoped? :scoped
        (and (pos? log-count) (not persisted-rollups?)) :entries
        :else :rollups))

(defn analytics-source
  "As overview-source for the provider/model analytics: a non-empty log always
  answers from entries."
  [{:keys [sql? scoped? log-count]}]
  (cond sql? :sql
        scoped? :scoped
        (pos? log-count) :entries
        :else :rollups))

(defn mcp-seed-cache-fresh?
  "Is a cache loaded at `loaded-at` still good at `now` (30 s)?"
  [loaded-at now]
  (and (some? loaded-at) (< (- now loaded-at) 30000)))
