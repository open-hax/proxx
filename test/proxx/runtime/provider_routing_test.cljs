(ns proxx.runtime.provider-routing-test
  "Ported from src/tests/provider-routing.test.ts (6 tests) and
  src/tests/model-alias-resolution.test.ts (5 tests). The TS modules were shims
  over these edges; `select-provider-strategy` below sequences the same edges the
  TS glue (provider-strategy/contexts.ts, registry.ts) did. Config is loaded from
  an explicit env object instead of mutating process.env (the TS withEnv helper
  removed the other variables, which an object holding only the named ones does
  too, and nothing leaks into other tests)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime :as runtime]
            [proxx.runtime.config :as config]
            [proxx.runtime.routing :as routing]
            [proxx.runtime.strategies :as strategies]
            [proxx.runtime.strategy :as strategy]))

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")

(defn- local-ollama? [model patterns] (routing/should-use-local-ollama-js manifest model (clj->js patterns)))

(defn- load-test-config ^js []
  (config/load-config-js #js {"PROXY_AUTH_TOKEN" "test-token" "PROXY_ALLOW_UNAUTHENTICATED" "false"} (js/process.cwd) manifest))

(defn- routing-state ^js [config model] (routing/resolve-request-routing-state-js manifest config model))

(defn- select-provider-strategy
  "The context and default strategy id for a chat request (contexts.ts)."
  [^js config request-body model]
  (let [^js state (routing-state config model)
        facts (strategy/derive-strategy-context-facts-js
               #js {:surface "chat" :routing state :requestBody request-body
                    :hostedOpenAiFamily (routing/looks-like-hosted-open-ai-family-js manifest (.-routedModel state))
                    :config config})
        context (js/Object.assign #js {} facts #js {:config config :clientHeaders #js {} :requestBody request-body
                                                    :requestedModelInput model :routingModelInput model
                                                    :routedModel (.-routedModel state)
                                                    :factoryPrefixed (.-factoryPrefixed state)})]
    {:context context
     :strategy-id (strategy/select-strategy-js (strategies/selection-facts-js context js/undefined) #js {}
                                               (.-cljsPolicyManifestPath config))}))

(defn- select-execution-strategy
  "Which provider's strategy executes a plan (registry.ts)."
  [^js context default-id provider-ids preferred-mode]
  (let [provider-id (strategy/execution-provider-js (clj->js provider-ids))]
    (if (undefined? provider-id)
      default-id
      (let [^js c (js/Object.assign #js {} context #js {:routeProviderId (.toLowerCase (.trim provider-id))})]
        (strategy/select-remote-strategy-js (strategies/selection-facts-js c js/undefined)
                                            provider-id (.. context -config -openaiProviderId) preferred-mode
                                            (.-policyPreferredStrategyModeByProvider context)
                                            (.. context -config -cljsPolicyManifestPath))))))

(deftest gpt-5-4-mini-does-not-fall-into-the-local-ollama-heuristic-via-generic-mini-pattern
  (is (false? (local-ollama? "gpt-5.4-mini" ["mini" ":4b"]))))

(deftest explicit-ollama-prefix-still-wins-even-for-hosted-looking-model-names
  (let [routed (routing-state (load-test-config) "ollama/gpt-5.4-mini")]
    (is (true? (.-explicitOllama routed)))
    (is (true? (.-localOllama routed)))
    (is (= "gpt-5.4-mini" (.-routedModel routed)))))

(deftest explicit-ollama-lan-prefix-strips-to-the-lan-ollama-model-id
  (let [routed (routing-state (load-test-config) "ollama-lan/gemma4:e4b")]
    (is (true? (.-explicitOllama routed)))
    (is (true? (.-localOllama routed)))
    (is (= "gemma4:e4b" (.-routedModel routed)))))

(deftest policy-selected-ollama-chat-strategy-is-not-tied-to-a-hard-coded-provider-id
  (let [{:keys [context strategy-id]}
        (select-provider-strategy (load-test-config)
                                  (clj->js {"model" "gemma4:e4b" "messages" [{"role" "user" "content" "hi"}]})
                                  "gemma4:e4b")
        selected (select-execution-strategy context strategy-id ["policy-named-ollama-node"] "ollama_chat")]
    (is (= "ollama_chat" (.-mode ^js (strategies/strategy-for-id-js selected))))))

(deftest unprefixed-qwen-local-model-still-routes-to-local-ollama
  (is (true? (local-ollama? "qwen3.5:4b-q8_0" ["mini" ":4b"]))))

(deftest ollama-tags-like-e4b-match-default-4b-local-ollama-patterns
  (is (true? (local-ollama? "gemma4:e4b" [":4b"]))))

;; ---- model-alias-resolution ----------------------------------------------

(defn- resolve-alias ^js [model provider] (runtime/resolve-model-alias-js manifest model provider))

(deftest resolves-gemma4-31b-alias-for-gemini-provider
  (let [result (resolve-alias "gemma4:31b" "gemini")]
    (is (= "ok" (.-status result)))
    (is (= "gemma-4-31b-it" (.-alias result)))))

(deftest resolves-gemma4-e4b-to-128k-tag-for-ollama-lan-provider
  (let [result (resolve-alias "gemma4:e4b" "ollama-lan")]
    (is (= "ok" (.-status result)))
    (is (= "gemma4:e4b-128k" (.-alias result)))))

(deftest returns-null-for-gemma4-31b-with-non-matching-provider
  (let [result (resolve-alias "gemma4:31b" "openai")]
    (is (= "ok" (.-status result)))
    (is (nil? (.-alias result)))))

(defn- gemini-context [overrides]
  (js/Object.assign
   #js {"config" #js {"cljsPolicyManifestPath" manifest} "clientHeaders" #js {} "requestBody" #js {}
        "explicitOllama" false "openAiPrefixed" false "factoryPrefixed" false "localOllama" false
        "clientWantsStream" false "needsReasoningTrace" false "upstreamAttemptTimeoutMs" 30000}
   overrides))

(deftest gemini-strategy-get-upstream-path-resolves-alias-using-candidate-provider-id
  (let [^js s (strategies/strategy-for-id-js "gemini-chat")
        context (gemini-context #js {"routedModel" "gemma4:31b"
                                     "routeProviderId" "openai" ; the original context has the wrong provider
                                     "providerId" "gemini"      ; but the candidate provider is gemini
                                     "requestedModelInput" "gemma4:31b" "routingModelInput" "gemma4:31b"})]
    (is (= "/models/gemma-4-31b-it:generateContent" (.getUpstreamPath s context)))))

(deftest gemini-strategy-get-upstream-path-falls-back-to-routed-model-when-no-alias
  (let [^js s (strategies/strategy-for-id-js "gemini-chat")
        context (gemini-context #js {"routedModel" "gemini-2.5-pro" "routeProviderId" "gemini" "providerId" "gemini"
                                     "requestedModelInput" "gemini-2.5-pro" "routingModelInput" "gemini-2.5-pro"})]
    (is (= "/models/gemini-2.5-pro:generateContent" (.getUpstreamPath s context)))))
