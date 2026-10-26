(ns proxx.http.embeddings-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.embeddings :as e]))

(deftest hints
  (is (= {:explicit-llamacpp? true :explicit-ollama? false :requested-provider-ids ["llamacpp-embed"] :explicit-provider-id "llamacpp-embed"}
         (e/provider-hints "LlamaCpp/x" ["llamacpp/"] ["ollama/"])))
  (is (= ["ollama"] (:requested-provider-ids (e/provider-hints "ollama:m" [] ["ollama/" "ollama:"]))))
  (is (= {:explicit-llamacpp? false :explicit-ollama? false :requested-provider-ids nil :explicit-provider-id nil}
         (e/provider-hints "plain" ["llamacpp/"] ["ollama/"])))
  (is (some? (e/auto-model-error "AUTO:x")))
  (is (nil? (e/auto-model-error "x"))))

(deftest limits
  (is (= {:item-count 1 :total-chars 5} (e/input-summary "hello")))
  (is (= {:item-count 0 :total-chars 0} (e/input-summary "")))
  (is (= {:item-count 2 :total-chars 3} (e/input-summary ["a" "bb"])))
  (is (= "embed_batch_too_large" (:code (e/limits-error {:item-count 4 :total-chars 1} 3 10))))
  (is (= "Embedding input is too large. Received 11 chars, maximum: 10." (:message (e/limits-error {:item-count 1 :total-chars 11} 3 10))))
  (is (nil? (e/limits-error {:item-count 3 :total-chars 10} 3 10))))

(deftest context
  (testing "no budget: the configured maximum, no num_ctx"
    (is (= {:max-context-tokens 100 :num-ctx nil} (e/context-verdict nil 100))))
  (testing "overflow"
    (is (= "embed_context_overflow"
           (get-in (e/context-verdict {"model" "m" "contextLength" 50 "estimatedInputTokens" 60} 100) [:error :code]))))
  (testing "a too-small loaded window asks for a larger one, capped"
    (is (= {:max-context-tokens 50 :num-ctx 50}
           (e/context-verdict {"model" "m" "contextLength" 50 "estimatedInputTokens" 10 "requiredContextTokens" 20
                               "availableContextTokens" 10 "recommendedNumCtx" 4096} 100)))))

(deftest upstream-verdicts
  (is (= :next-provider (e/upstream-failure "p" 503 "x")))
  (is (= 429 (get-in (e/upstream-failure "p" 429 "slow") [:error :status])))
  (is (= "Embedding upstream rejected the request: slow" (get-in (e/upstream-failure "p" 429 "slow") [:error :message]))))

(deftest routes
  (is (= [{"providerId" "a"}] (e/select-routes [{"providerId" "a"} {"providerId" "b"}] "a")))
  (is (= 2 (count (e/select-routes [{"providerId" "a"} {"providerId" "b"}] nil)))))
