(ns proxx.runtime.auth
  "Edge of request authentication: sequences the tenant-key and UI-session
  lookups around the decisions in `proxx.auth.request`. Results are plain JS
  objects with only the fields that apply (callers JSON-encode them).
  Lookup results (scopes, memberships) are passed through untouched."
  (:require [proxx.auth.request :as req]))

(defn- match->clj
  "Shallow copy of a JS match object's fields we read, keeping nested arrays opaque."
  [^js m ks]
  (into {} (map (fn [k] [k (aget m k)])) ks))

(defn- ->js-result [result]
  (let [o #js {}]
    (doseq [[k v] result :when (some? v)] (aset o k v))
    o))

(defn ^:async resolve-request-auth-js
  "`input` is the legacy options object; `default-tenant-id` is the legacy
  admin tenant."
  [^js input default-tenant-id]
  (let [bearer (req/bearer-token (.-authorization input))
        cookie (req/cookie-token (.-cookieToken input))
        oauth (req/cookie-token (.-oauthAccessToken input))
        proxy-token (.-proxyAuthToken input)
        resolve-key (.-resolveTenantApiKey input)
        resolve-session (.-resolveUiSession input)]
    (if-let [source (req/legacy-admin-source proxy-token bearer cookie)]
      (->js-result (req/legacy-admin source default-tenant-id))
      (let [key-match (when (and bearer resolve-key) (await (resolve-key bearer)))]
        (if key-match
          (->js-result (req/tenant-api-key-auth (match->clj key-match ["id" "tenantId" "scopes"])))
          (let [session
                (when resolve-session
                  (loop [candidates (req/ui-session-candidates bearer oauth)]
                    (when-let [[source token] (first candidates)]
                      (if-let [match (await (resolve-session token))]
                        [source match]
                        (recur (rest candidates))))))]
            (cond
              session (->js-result (req/ui-session-auth (first session)
                                                        (match->clj (second session)
                                                                    ["userId" "subject" "activeTenantId" "role" "memberships"])))
              (.-allowUnauthenticated input) (->js-result req/unauthenticated)
              :else nil)))))))
