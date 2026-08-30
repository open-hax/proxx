(ns proxx.strategies.anthropic
  (:require [shadow.cljs.modern :refer (js-await)]
            [clojure.string :as str]))

(def claude-code-beta-flags
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05")

(defn oauth-token? [secret]
  (and secret (str/starts-with? secret "sk-ant-oat01-")))

(defn ^:async messages-passthrough
  "Return the upstream Response for every completed HTTP exchange, including
  non-2xx responses, so the policy caller can preserve status and error body.
  Return nil only when no request can be made or fetch itself fails."
  [ctx]
  (try
    (let [fetch-fn (:fetch ctx js/fetch)
          endpoint (:endpoint ctx)
          body (:body ctx)
          credential (or (:it ctx) (first (:credentials ctx)))
          secret (or (:secret credential) (:token credential))
          is-oauth (oauth-token? secret)]
      (when (and fetch-fn endpoint credential)
        (let [base-headers {"anthropic-version" "2023-06-01"
                            "content-type" "application/json"}
              headers (if is-oauth
                        (merge base-headers
                               {"Authorization" (str "Bearer " secret)
                                "anthropic-beta" claude-code-beta-flags
                                "anthropic-dangerous-direct-browser-access" "true"
                                "x-app" "cli"
                                "user-agent" "claude-cli/2.1.80 (external, sdk-cli)"})
                        (merge base-headers
                               {"x-api-key" secret}))
              resp (js-await (fetch-fn endpoint
                                       (clj->js {:method "POST"
                                                 :headers (clj->js headers)
                                                 :body (js/JSON.stringify (clj->js body))})))]
          resp)))
    (catch :default _ nil)))
