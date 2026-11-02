(ns proxx.runtime.strategies-test
  (:require [cljs.test :refer [deftest is]]
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
