(ns proxx.strategy.candidates
  "Facts behind routing-candidate construction (src/lib/provider-strategy/routing/
  candidate-builder.ts): which credential an admin forced, the synthetic account
  of an auth-free provider, and the prompt-affinity preferences stored for a
  cache key. The key pool, quota monitor and stores stay with the caller."
  (:require [clojure.string :as str]
            [proxx.jsval :as jv]))

(defn- header-string
  "`headers[name] ?? headers[lower] ?? headers[UPPER]` when it is a string."
  [headers name]
  (let [v (jv/first-non-nil (get headers name) (get headers (str/lower-case name)) (get headers (str/upper-case name)))]
    (when (string? v) v)))

(defn forced-selection
  "{:provider-id :account-id} an administrator forced through the
  x-open-hax-forced-* headers; empty for any other caller."
  [auth-kind headers]
  (if (= "legacy_admin" auth-kind)
    (let [provider (some-> (header-string headers "x-open-hax-forced-provider") jv/trim jv/lower)
          account (some-> (header-string headers "x-open-hax-forced-account-id") jv/trim)]
      (cond-> {}
        (seq provider) (assoc :provider-id provider)
        (seq account) (assoc :account-id account)))
    {}))

(defn no-auth-account
  "The placeholder credential for a provider that needs none."
  [provider-id]
  {"providerId" provider-id "accountId" (str provider-id "-no-auth") "token" "" "authType" "api_key" "planType" "free"})

(defn affinities
  "{:preferred :provisional} ({:provider-id :account-id} or nil) from a stored
  prompt-affinity record."
  [record]
  (when (map? record)
    {:preferred {:provider-id (get record "providerId") :account-id (get record "accountId")}
     :provisional (when (and (jv/truthy? (get record "provisionalProviderId"))
                             (jv/truthy? (get record "provisionalAccountId")))
                    {:provider-id (get record "provisionalProviderId") :account-id (get record "provisionalAccountId")})}))
