(ns proxx.runtime.embeddings-strategies-test
  "Ported from src/tests/embeddings-strategy.test.ts (25 tests): conformance of
  the embedding provider strategies, driven through the strategy objects the
  registry builds (proxx.runtime.strategies)."
  (:require [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.runtime.strategies :as strategies]))

(defn- make-ctx [overrides]
  (js/Object.assign
   #js {"config" #js {} "clientHeaders" #js {} "requestBody" #js {"input" #js ["hello world"]}
        "requestedModelInput" "test-model" "routingModelInput" "test-model" "routedModel" "test-model"
        "explicitOllama" false "openAiPrefixed" false "factoryPrefixed" false "localOllama" false
        "clientWantsStream" false "needsReasoningTrace" false "upstreamAttemptTimeoutMs" 30000}
   (clj->js overrides)))

(defn- embed-ctx [provider & [extra]]
  (make-ctx (merge {"clientHeaders" {"x-embedding-provider" provider} "requestBody" {"input" ["hello"]}} extra)))

(defn- payload-of [^js s ctx] (js->clj (.-upstreamPayload ^js (.buildPayload s ctx))))

;; ---- HuggingFaceEmbeddingStrategy ------------------------------------------

(deftest hugging-face-embedding-strategy
  (let [^js s (strategies/strategy-for-id-js "hf-embeddings")]
    (is (= "hf_embeddings" (.-mode s)) "has mode hf_embeddings")
    (is (false? (.-isLocal s)) "is not local")
    (is (true? (.matches s (embed-ctx "hf"))) "matches on x-embedding-provider: hf")
    (is (true? (.matches s (embed-ctx "huggingface"))) "matches on x-embedding-provider: huggingface")
    (is (false? (.matches s (embed-ctx "tei"))) "does not match tei")
    (is (= "/pipeline/feature-extraction/Qwen%2FQwen3-Embedding-4B"
           (.getUpstreamPath s (embed-ctx "hf" {"requestBody" {"input" ["x"] "model" "Qwen/Qwen3-Embedding-4B"}})))
        "getUpstreamPath encodes model name")
    (is (false? (str/includes? (.getUpstreamPath s (embed-ctx "hf")) "/v1/embeddings"))
        "getUpstreamPath does NOT contain /v1/embeddings")
    (is (vector? (get (payload-of s (embed-ctx "hf" {"requestBody" {"input" "single string"}})) "inputs"))
        "buildPayload wraps scalar input in array")
    (is (= "Embed this"
           (get-in (payload-of s (embed-ctx "hf" {"requestBody" {"input" ["x"] "instruction" "Embed this"}}))
                   ["parameters" "prompt"]))
        "buildPayload forwards instruction as parameters.prompt")))

;; ---- TEIEmbeddingStrategy ---------------------------------------------------

(deftest tei-embedding-strategy
  (let [^js s (strategies/strategy-for-id-js "tei-embeddings")]
    (is (= "tei_embeddings" (.-mode s)) "has mode tei_embeddings")
    (is (false? (.-isLocal s)) "is not local")
    (is (true? (.matches s (embed-ctx "tei"))) "matches on x-embedding-provider: tei")
    (is (false? (.matches s (embed-ctx "hf"))) "does not match hf")
    (is (= "/embed" (.getUpstreamPath s (make-ctx {}))) "getUpstreamPath returns /embed")
    (is (false? (str/includes? (.getUpstreamPath s (make-ctx {})) "/v1/embeddings"))
        "getUpstreamPath does NOT contain /v1/embeddings")
    (is (= 512 (get (payload-of s (embed-ctx "tei" {"requestBody" {"input" ["x"] "dimensions" 512}})) "truncate_dim"))
        "buildPayload sets truncate_dim when dimensions provided")))

;; ---- OvmNpuEmbeddingStrategy -----------------------------------------------

(deftest ovm-npu-embedding-strategy
  (let [^js s (strategies/strategy-for-id-js "ovm-embeddings")]
    (is (= "ovm_embeddings" (.-mode s)) "has mode ovm_embeddings")
    (is (false? (.-isLocal s)) "is not local")
    (is (true? (.matches s (embed-ctx "ovm"))) "matches on x-embedding-provider: ovm")
    (is (true? (.matches s (embed-ctx "ovm-npu"))) "matches on x-embedding-provider: ovm-npu")
    (is (false? (.matches s (embed-ctx "tei"))) "does not match tei")
    (is (= "/v3/embeddings" (.getUpstreamPath s (make-ctx {}))) "getUpstreamPath returns /v3/embeddings")
    (is (true? (str/includes? (str (get (payload-of s (embed-ctx "ovm")) "model")) "0.6B"))
        "buildPayload uses 0.6B model by default")
    (is (false? (str/includes? (str (get (payload-of s (embed-ctx "ovm")) "model")) "4B"))
        "Qwen3-Embedding-4B is NOT the ovm default (route to hf/tei instead)")))

;; ---- registration guard ------------------------------------------------------

(deftest embedding-strategies-do-not-match-chat-requests
  (let [chat-ctx (make-ctx {"requestBody" {"messages" [{"role" "user" "content" "hi"}]}})]
    (doseq [id ["hf-embeddings" "tei-embeddings" "ovm-embeddings"]]
      (is (false? (.matches ^js (strategies/strategy-for-id-js id) chat-ctx)) id))))
