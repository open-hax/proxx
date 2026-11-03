(ns proxx.strategy.attempt-plan
  "Facts the routing loop (src/lib/provider-strategy/routing/attempt-executor.ts)
  derives before it touches the network: which upstream steps one credential
  attempt walks, how a transport error reads in a log, who matches an
  affinity. Pure data in, data out; `proxx.runtime.attempt-executor` sequences
  the I/O around the verdicts of `proxx.strategy.executor`."
  (:require [clojure.string :as str]))

(defn codex-header-profile?
  "OpenAI OAuth accounts present as the Codex CLI."
  [provider-id auth-type openai-provider-id]
  (and (= provider-id openai-provider-id) (= auth-type "oauth_bearer")))

(defn affinity-match?
  "Does the candidate (provider + account) equal the affinity?"
  [provider-id account-id affinity]
  (boolean (and affinity
                (= provider-id (:provider-id affinity))
                (= account-id (:account-id affinity)))))

(defn reassignment-allowed?
  "A preferred affinity may be reassigned unless one of the candidates is that very account."
  [preferred candidates]
  (or (nil? preferred)
      (every? (fn [{:keys [provider-id account-id]}]
                (or (not= provider-id (:provider-id preferred))
                    (not= account-id (:account-id preferred))))
              candidates)))

(defn transport-error-message
  "`base` plus the cause's code, name and message (non-empty strings only)."
  [base cause]
  (let [parts (filter (fn [p] (and (string? p) (seq p)))
                      [(:code cause) (:name cause) (:message cause)])]
    (if (seq parts)
      (str base " (" (apply str (interpose ": " parts)) ")")
      base)))

(defn upstream-steps
  "The upstream steps one attempt walks, in order. Everything but OpenAI image
  generation is one step on the candidate's base URL and the strategy's path.
  Image generation depends on the account and `images-mode`:
    api key        the Platform images API
    \"chatgpt\"      Codex Responses with the image_generation tool
    \"platform\"     the Platform images API
    otherwise      Platform first (401/403 fall through), then Codex Responses.
  `facts`: {:base-url :primary-path :openai-images? :auth-type :images-mode
            :openai-api-base-url :images-path :openai-base-url :responses-path}"
  [{:keys [base-url primary-path openai-images? auth-type images-mode
           openai-api-base-url images-path openai-base-url responses-path]}]
  (let [platform {:base-url openai-api-base-url :path images-path :kind :openai-platform}
        codex {:base-url openai-base-url :path responses-path :kind :openai-codex-responses-images}]
    (cond
      (not openai-images?) [{:base-url base-url :path primary-path :kind :default}]
      (= "api_key" auth-type) [platform]
      (= "chatgpt" images-mode) [codex]
      (= "platform" images-mode) [platform]
      :else [(assoc platform :try-next-base-on [401 403]) codex])))

(defn requesty-model?
  "Requesty names models `provider/model`."
  [provider-id]
  (= "requesty" (str/lower-case (str/trim (str provider-id)))))
