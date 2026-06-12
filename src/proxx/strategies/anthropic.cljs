(ns proxx.strategies.anthropic
  (:require [clojure.string :as str]))

(def claude-code-beta-flags
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05")

(defn oauth-token? [secret]
  (and secret (str/starts-with? secret "sk-ant-oat01-")))

(defn ^:async messages-passthrough [ctx]
  (try
    (let [fetch-fn (or (:fetch ctx) js/fetch)
          endpoint (:endpoint ctx)
          body (:body ctx)
          credential (or (:it ctx) (first (:credentials ctx)))
          secret (or (:secret credential) (:token credential))
          is-oauth (oauth-token? secret)]
      (if (not (and fetch-fn endpoint secret))
        nil
        (let [body-str (js/JSON.stringify (clj->js body))
              headers (clj->js
                        (if is-oauth
                          {"anthropic-version" "2023-06-01"
                           "content-type" "application/json"
                           "Authorization" (str "Bearer " secret)
                           "anthropic-beta" claude-code-beta-flags
                           "anthropic-dangerous-direct-browser-access" "true"
                           "x-app" "cli"
                           "user-agent" "claude-cli/2.1.80 (external, sdk-cli)"}
                          {"anthropic-version" "2023-06-01"
                           "content-type" "application/json"
                           "x-api-key" secret}))]
          (await (fetch-fn endpoint #js {:method "POST" :headers headers :body body-str})))))
    (catch :default _ nil)))
