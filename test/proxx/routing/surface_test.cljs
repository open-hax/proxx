(ns proxx.routing.surface-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]
            [proxx.routing.surface :as s]))

(def f (-> (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn")
           contracts/compile-contracts s/facts))

(deftest hosted-openai-family
  (doseq [m ["gpt-5" "GPT-4o" "openai/gpt-4" "openai:x" "chatgpt-4o" "o1" "O3" "o4" "o1-mini" "o3-pro" "o4-x"]]
    (is (s/hosted-openai-family? f m) m))
  (doseq [m ["o2" "o1x" "llama3" "" "xgpt-4" "ollama/gpt-4" "o"]]
    (is (not (s/hosted-openai-family? f m)) m)))

(deftest dedicated-ollama
  (is (s/dedicated-ollama-provider? f "ollama-lan"))
  (is (s/dedicated-ollama-provider? f "  OLLAMA-local "))
  (is (s/dedicated-ollama-provider? f "ollama-"))
  (is (s/dedicated-ollama-provider? f "ollama-cloud-2"))
  (is (not (s/dedicated-ollama-provider? f "ollama-cloud")))
  (is (not (s/dedicated-ollama-provider? f "ollama")))
  (is (not (s/dedicated-ollama-provider? f ""))))

(deftest api-surfaces
  (is (s/responses-provider? f "Rotussy" nil))
  (is (not (s/openai-compatible-provider? f "rotussy" nil)))
  (is (s/openai-compatible-provider? f "xiaomi" nil))
  (is (not (s/responses-provider? f "xiaomi" nil)))
  (is (s/responses-provider? f "mine" " Mine ") "the configured OpenAI provider id is added")
  (is (not (s/responses-provider? f "mine" "  ")) "a blank configured id adds nothing")
  (is (not (s/responses-provider? f "" ""))))

(deftest catalog-source-paths
  (let [cfg {:openai-provider-id "openai" :openai-base-url "https://api.openai.com/v1"
             :openai-responses-path "/v1/responses" :openai-chat-completions-path "/v1/chat/completions"}]
    (is (= ["/models"] (s/catalog-paths f cfg "ZAI")))
    (is (= ["/v1/models" "/models"] (s/catalog-paths f cfg "rotussy")))
    (is (= ["/v1/models"] (s/catalog-paths f cfg "anything")))
    (is (= ["/v1/models"] (s/catalog-paths f cfg "openai")))
    (is (= [] (s/catalog-paths f (assoc cfg :openai-base-url "https://ChatGPT.com/backend-api/x") " OpenAI ")))
    (is (= [] (s/catalog-paths f (assoc cfg :openai-responses-path "/backend/CODEX/responses") "openai")))
    (is (= ["/v1/models"] (s/catalog-paths f (assoc cfg :openai-base-url "https://chatgpt.com/backend-api") "other"))
        "only the configured OpenAI provider is affected by the Codex surface")))

(deftest explicit-ollama-and-bridge
  (is (s/explicit-ollama-model? f " Ollama/llama3"))
  (is (s/explicit-ollama-model? f "ollama-lan:x"))
  (is (not (s/explicit-ollama-model? f "ollama-cloud/x")))
  (is (s/legacy-bridge-path? f "/v1/embeddings/x"))
  (is (not (s/legacy-bridge-path? f "/v2/models"))))
