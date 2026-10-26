(ns proxx.http.v1-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.v1 :as v1]))

(deftest route-sets
  (is (= "factory" (v1/initial-provider-filter {:factory-prefixed true :explicit-ollama true})))
  (is (= "ollama" (v1/initial-provider-filter {:explicit-ollama true})))
  (is (nil? (v1/initial-provider-filter {})))
  (is (= ["openai" "a" "b"] (v1/prioritize-openai-route ["a" "openai" "b"] true "openai")) "stable")
  (is (= ["a" "openai"] (v1/prioritize-openai-route ["a" "openai"] false "openai")))
  (is (= {"policyPreferredStrategyMode" "m"} (v1/policy-context-overrides {:strategy-mode "m"})))
  (is (= {} (v1/policy-context-overrides {:strategy-mode "" :strategy-mode-by-provider nil}))))

(deftest catalog-gate
  (let [base {:routed-model "m" :has-more? false :routes-empty? false :local? false :check-routes? true}]
    (is (= :ok (v1/catalog-gate base)))
    (is (= "model_disabled" (get-in (v1/catalog-gate (assoc base :disabled? true)) [:error :code])))
    (is (= :continue (v1/catalog-gate (assoc base :disabled? true :has-more? true))))
    (is (= "healthy_nodes_unavailable" (get-in (v1/catalog-gate (assoc base :routes-empty? true)) [:error :code])))
    (is (= :ok (v1/catalog-gate (assoc base :routes-empty? true :local? true))) "local strategies need no routes")
    (is (= "model_not_found" (get-in (v1/catalog-gate (assoc base :rejected? true)) [:error :code])))
    (is (= :ok (v1/catalog-gate (assoc base :rejected? true :local? true))))
    (testing "the responses route does not gate on empty routes"
      (is (= :ok (v1/catalog-gate (assoc base :check-routes? false :routes-empty? true))))
      (is (= "model_not_found" (get-in (v1/catalog-gate (assoc base :check-routes? false :rejected? true :local? true)) [:error :code]))))))

(deftest context-window
  (let [budget {"model" "m" "estimatedInputTokens" 10 "requestedOutputTokens" 5 "requiredContextTokens" 15 "availableContextTokens" 12}]
    (is (v1/context-exceeded? budget))
    (is (not (v1/context-exceeded? nil)))
    (is (re-find #"Estimated input tokens: 10, requested output tokens: 5, required total: 15, available: 12"
                 (:message (v1/ollama-context-overflow budget "m"))))))

(deftest responses-model-rules
  (is (v1/explicit-ollama-model? " Ollama/x"))
  (is (v1/explicit-ollama-model? "ollama:x"))
  (is (not (v1/explicit-ollama-model? "ollamax")))
  (is (v1/auto-model? "AUTO:fast"))
  (is (= ["m"] (v1/responses-candidates "m" false nil [])))
  (is (= ["a" "b"] (v1/responses-candidates "auto:x" true {"status" "ok" "candidates" ["a" "b"]} ["c"])))
  (is (= ["c"] (v1/responses-candidates "auto:x" true {"status" "error"} ["c"])))
  (is (= ["c"] (v1/responses-candidates "auto:x" true nil ["c"])))
  (is (= 12 (count (re-seq #"[^,]+" (v1/auto-candidates-header (map str (range 20))))))))

(deftest errors
  (is (= "All allowed image providers rejected the request." (:message (v1/exhausted :images nil "m"))))
  (is (= {"requestedModel" "r"} (:meta (v1/exhausted :chat "r" nil))))
  (is (= 404 (:status (v1/requested-model-not-found "r")))))
