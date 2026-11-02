(ns proxx.runtime.strategies-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.strategy :as strategy]
            [proxx.runtime.strategies :as strategies]))

(def ^:private config
  #js {"cljsPolicyManifestPath" "resources/policies/runtime/00-manifest.edn"
       "chatCompletionsPath" "/v1/chat/completions" "messagesPath" "/v1/messages"
       "messagesInterleavedThinkingBeta" "beta-1" "ollamaModelPrefixes" #js []})

(defn- ctx [overrides]
  (js/Object.assign #js {"config" config "clientHeaders" #js {}
                         "requestBody" #js {"model" "m" "messages" #js [#js {"role" "user" "content" "hi"}]}
                         "requestedModelInput" "m" "routedModel" "m" "routeProviderId" "vivgrid"
                         "explicitOllama" false "openAiPrefixed" false "factoryPrefixed" false "localOllama" false
                         "account" #js {"token" "tok"}}
                    overrides))

(deftest strategies-follow-the-registry
  (let [all (strategies/strategies-js)]
    (is (= 27 (alength all)))
    (is (identical? (strategies/strategy-for-id-js "messages") (strategies/strategy-for-id-js "messages")))
    (let [^js ollama (strategies/strategy-for-id-js "ollama")
          ^js remote (strategies/strategy-for-id-js "remote-ollama")]
      (is (true? (.-isLocal ollama)))
      (is (false? (.-isLocal remote)))
      (is (= "ollama_chat" (.-mode remote))))
    (is (some? (aget (strategies/strategy-for-id-js "gemini-chat") "executeDirect")))
    (is (nil? (aget (strategies/strategy-for-id-js "messages") "executeDirect")))
    (is (thrown-with-msg? js/Error #"unknown strategy 'nope'" (strategies/strategy-for-id-js "nope")))))

(deftest chat-strategy-path-and-payload
  (let [^js s (strategies/strategy-for-id-js "chat-completions")
        c (ctx #js {"routeProviderId" "vivgrid" "clientWantsStream" true})]
    (is (.matches s c))
    (is (= "/v1/chat/completions" (.getUpstreamPath s c)))
    (let [^js payload (.buildPayload s c)]
      (is (= "none" (.-serviceTierSource payload)))
      (is (= (js/JSON.stringify (.-upstreamPayload payload)) (.-bodyText payload))))))

(deftest messages-adds-the-interleaved-beta-once
  (let [^js s (strategies/strategy-for-id-js "messages")
        c (ctx #js {})
        headers (js/Headers. #js {"anthropic-beta" "other"})
        thinking #js {"thinking" #js {"type" "enabled"}}]
    (.applyRequestHeaders s headers c thinking)
    (.applyRequestHeaders s headers c thinking)
    (is (= "other, beta-1" (.get headers "anthropic-beta")))
    (let [plain (js/Headers.)]
      (.applyRequestHeaders s plain c #js {})
      (is (nil? (.get plain "anthropic-beta"))))))

(deftest gemini-authenticates-with-a-key-header
  (let [^js s (strategies/strategy-for-id-js "gemini-chat")
        headers (js/Headers. #js {"authorization" "Bearer x"})]
    (.applyRequestHeaders s headers (ctx #js {}) #js {})
    (is (nil? (.get headers "authorization")))
    (is (= "tok" (.get headers "x-goog-api-key")))
    (is (= "application/json" (.get headers "content-type")))))

;; ---- ported from src/tests/llamacpp-audio-passthrough.test.ts (1 test) ----

(deftest llamacpp-chat-strategy-preserves-openai-input-audio-content-parts
  (let [tools [{"type" "function"
                "function" {"name" "grab_latest_unseen_audio_buffers"
                            "parameters" {"type" "object" "properties" {}}}}]
        audio {"type" "input_audio" "input_audio" {"data" "UklGRiQAAABXQVZFZm10IBAAAAABAAEA" "format" "wav"}}
        strategy ^js (strategies/strategy-for-id-js "llamacpp-chat")
        context (clj->js {"routeProviderId" "llamacpp"
                          "requestedModelInput" "gemma4:e4b" "routingModelInput" "gemma4:e4b" "routedModel" "gemma4:e4b"
                          "requestBody" {"model" "gemma4:e4b" "stream" true
                                         "messages" [{"role" "user"
                                                      "content" [{"type" "text" "text" "Use the audio buffer and decide whether to call a tool."}
                                                                 audio]}]
                                         "tools" tools}
                          "config" {} "clientHeaders" {}
                          "explicitOllama" false "openAiPrefixed" false "factoryPrefixed" false "localOllama" false
                          "clientWantsStream" true "needsReasoningTrace" false "upstreamAttemptTimeoutMs" 1000})
        payload (js->clj (.-upstreamPayload ^js (.buildPayload strategy context)))]
    (is (= "gemma4-e4b" (get payload "model")))
    (is (vector? (get payload "messages")))
    (is (= audio (get-in payload ["messages" 0 "content" 1])))
    (is (= tools (get payload "tools")))))

;; ---- ported from src/tests/vision-auto-model.test.ts (4 tests) -----------

(defn- vision-candidates [available]
  (vec (array-seq (strategy/vision-model-candidates-js (clj->js available) js/undefined))))

(defn- vision-route-order [routes model]
  (let [order (array-seq (strategy/vision-route-order-js model (clj->js (map #(get % "providerId") routes)) js/undefined))]
    (mapv #(get (nth routes %) "providerId") order)))

(deftest auto-vision-advertises-itself-as-a-synthetic-auto-model
  (is (true? (strategy/is-vision-auto-model-js "auto:vision")))
  (is (true? (strategy/is-vision-auto-model-js "AUTO:VISION")))
  (is (false? (strategy/is-vision-auto-model-js "auto:smartest"))))

(deftest auto-vision-preserves-the-configured-fallback-chain-order
  (is (= ["glm-5v-turbo" "Kimi-K2.5" "gpt-5.4-mini"]
         (vision-candidates ["gpt-5.4-mini" "glm-5v-turbo" "Kimi-K2.5" "deepseek-v3.2"]))))

(deftest auto-vision-falls-back-to-the-full-chain-when-preferred-models-are-not-surfaced
  (is (= ["glm-5v-turbo" "Kimi-K2.5" "gpt-5.4-mini" "qwen3.5:4b-q8_0"]
         (vision-candidates ["deepseek-v3.2"]))))

(deftest auto-vision-provider-ordering
  (let [routes [{"providerId" "vivgrid" "baseUrl" "https://vivgrid.example"}
                {"providerId" "zai" "baseUrl" "https://zai.example"}
                {"providerId" "rotussy" "baseUrl" "https://rotussy.example"}
                {"providerId" "ollama-cloud" "baseUrl" "https://ollama.example"}
                {"providerId" "ollama-stealth" "baseUrl" "http://127.0.0.1:11434"}]]
    (is (= ["zai" "vivgrid" "rotussy" "ollama-cloud" "ollama-stealth"] (vision-route-order routes "glm-5v-turbo")))
    (is (= ["zai" "vivgrid" "rotussy" "ollama-cloud" "ollama-stealth"] (vision-route-order routes "glm-4.6v")))
    (is (= ["ollama-cloud" "ollama-stealth" "vivgrid" "zai" "rotussy"] (vision-route-order routes "qwen3.5:4b-q8_0")))))
