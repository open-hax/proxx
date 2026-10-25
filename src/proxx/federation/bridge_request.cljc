(ns proxx.federation.bridge-request
  "Which advertised capability can serve a request, and which response headers
  cross the bridge. Capabilities are wire maps as advertised by the agent.

  Divergence from the TypeScript: it spread `paths`/`routes` with `...`, so a
  string where an array belongs was walked character by character. Only
  sequences count here."
  (:require [clojure.string :as str]))

(def legacy-path-prefixes
  ["/v1/chat/completions" "/v1/models" "/v1/responses" "/v1/embeddings" "/v1/images/generations"])

(defn- trimmed-strings [xs]
  (into [] (comp (filter string?) (map str/trim) (remove empty?)) (when (sequential? xs) xs)))

(defn- starts-with-any? [path prefixes] (boolean (some #(str/starts-with? path %) prefixes)))

(defn supports-path?
  "An advertised route list wins; without one, the boolean `supports*` flags
  decide for the three structured paths, and a capability with no structured
  hints at all is assumed to serve the legacy path set."
  [capability normalized-path]
  (let [routes (into (trimmed-strings (get capability "paths")) (trimmed-strings (get capability "routes")))]
    (cond
      (seq routes) (starts-with-any? normalized-path routes)
      (str/starts-with? normalized-path "/v1/models") (= true (get capability "supportsModelsList"))
      (str/starts-with? normalized-path "/v1/chat/completions") (= true (get capability "supportsChatCompletions"))
      (str/starts-with? normalized-path "/v1/responses") (= true (get capability "supportsResponses"))
      :else (and (not-any? #(contains? capability %) ["supportsModelsList" "supportsChatCompletions" "supportsResponses"])
                 (starts-with-any? normalized-path legacy-path-prefixes)))))

(defn supports-model?
  "No requested model matches everything; otherwise an exact advertised model
  or an advertised prefix of it."
  [capability requested-model]
  (let [model (when (string? requested-model) (str/trim requested-model))]
    (or (not (seq model))
        (boolean (some #{model} (trimmed-strings (get capability "models"))))
        (starts-with-any? model (trimmed-strings (get capability "modelPrefixes"))))))

(defn forwardable-header?
  "Whether a response header may be copied onto our reply: the body length is
  ours to compute. With `hide-upstream-account?`, the headers that name the
  upstream account and its auth type stay behind too."
  [name hide-upstream-account?]
  (let [n (str/lower-case (str name))]
    (not (or (= n "content-length")
             (and hide-upstream-account?
                  (contains? #{"x-open-hax-upstream-account" "x-open-hax-upstream-auth-type"} n))))))
