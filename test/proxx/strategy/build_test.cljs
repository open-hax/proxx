(ns proxx.strategy.build-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.policy.loader :as loader]
            [proxx.schema :as schema]
            [proxx.strategy.build :as build]
            [proxx.strategy.select :as select]))

(def ^:private registry (select/registry-from-contracts (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn")))
(def ^:private rules (:registry/payload-rules registry))

(defn- payload [id inputs] (build/build-payload id (assoc inputs :rules rules)))

(deftest registry-with-paths-and-rules-is-valid
  (is (some? (schema/validate :proxx/policy-contract registry))))

(deftest paths
  (let [path (fn [id facts] (build/upstream-path (select/entry registry id) facts))]
    (is (= "/chat/completions" (path :zai-chat {})))
    (is (= "/v1/messages" (path :messages {:config {"messagesPath" "/v1/messages"}})))
    (is (= "/pm" (path :messages {:provider-paths {"messages" "/pm"} :config {"messagesPath" "/v1/messages"}})) "provider override wins")
    (is (= "/codex" (path :openai-responses {:provider-paths {"responses" "/x"} :config {"openaiResponsesPath" "/codex"}})) "no override key for OpenAI")
    (is (= "/pipeline/feature-extraction/Qwen%2FQwen3-Embedding-4B" (path :hf-embeddings {})))
    (is (= "/pipeline/feature-extraction/a%20b" (path :hf-embeddings {:model "a b"})))
    (is (nil? (path :factory-chat {})) "owned by the Factory wire profile")))

(deftest codex-recipes
  (let [body {"model" "gpt-5" "messages" [{"role" "user" "content" "hi"}] "temperature" 0.2 "user" "u"}
        p (payload :openai-responses {:upstream-body body :request-body {"open_hax" {"service_tier" "flex"}} :headers {}})]
    (is (= false (get p "store")))
    (is (= true (get p "stream")))
    (is (= "" (get p "instructions")))
    (is (not-any? #(contains? p %) (:codex-unsupported-params rules)) "unsupported parameters are stripped, service tier included"))
  (let [p (payload :openai-responses-passthrough {:upstream-body {"input" [{"role" "user"} {"role" "assistant"}] "temperature" 1 "instructions" nil}})]
    (is (= [{"role" "user"}] (get p "input")))
    (is (= "" (get p "instructions")))))

(deftest factory-recipes
  (let [p (payload :factory-responses {:upstream-body {"model" "gpt-5" "messages" [{"role" "system" "content" "  sys  "} {"role" "user" "content" "hi"}]}
                                       :request-body {} :headers {}})]
    (is (not (contains? p "instructions")))
    (is (= {"role" "developer" "content" [{"type" "input_text" "text" "sys"}]} (first (get p "input")))))
  (let [p (payload :factory-messages {:upstream-body {"model" "claude" "messages" [{"role" "system" "content" "SYS"} {"role" "user" "content" "hi"}]}
                                      :sanitize-system (fn [s] (str s "!"))})]
    (is (= 4096 (get p "max_tokens")))
    (is (not (contains? p "system")))
    (is (= "SYS!\n\nhi" (get-in p ["messages" 0 "content"])) "sanitised system is inlined into the first user message")))

(deftest passthroughs-and-embeddings
  (is (= {"prompt" "p"} (payload :images-passthrough {:request-body {"prompt" "p" "open_hax" {}}})))
  (is (= {"stream" true "stream_options" {"include_usage" true} "model" "gemma4-e4b"}
         (payload :llamacpp-chat {:upstream-body {"stream" true "model" "gemma4:e4b"}})))
  (is (= {"model" "a-b"} (payload :openai-compat-embeddings {:request-body {"model" "a:b"}})))
  (is (= {"inputs" ["x"] "parameters" {"prompt" "i" "truncate_dim" 3}}
         (payload :hf-embeddings {:request-body {"input" "x" "instruction" "i" "dimensions" 3}})))
  (is (= {"inputs" ["a" "b"] "truncate_dim" 2} (payload :tei-embeddings {:request-body {"input" ["a" "b"] "dimensions" 2}})))
  (is (= {"model" "OpenVINO/Qwen3-Embedding-0.6B-int8-ov" "input" [nil]} (payload :ovm-embeddings {:request-body {}}))))
