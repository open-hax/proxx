(ns proxx.strategy.chains-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.policy.loader :as loader]
            [proxx.schema :as schema]
            [proxx.strategy.chains :as chains]))

(def ^:private c (chains/chains-from-contracts (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn")))

(deftest contract-is-valid
  (is (some? (schema/validate :proxx/policy-contract c))))

(deftest candidate-limits
  (is (= 8 (chains/max-candidates c nil)))
  (is (= 8 (chains/max-candidates c "")))
  (is (= 8 (chains/max-candidates c "abc")))
  (is (= 8 (chains/max-candidates c "0")))
  (is (= 8 (chains/max-candidates c "-3")))
  (is (= 5 (chains/max-candidates c "5")))
  (is (= 24 (chains/max-candidates c "100")))
  (is (= 7 (chains/max-candidates c "7x"))))

(deftest advance-rule
  (is (chains/advance? c {:has-more? true :auto-model? true} {:saw-rate-limit true}))
  (is (not (chains/advance? c {:has-more? false :auto-model? true} {:saw-rate-limit true})))
  (is (not (chains/advance? c {:has-more? true :auto-model? false} {:saw-rate-limit true})))
  (is (not (chains/advance? c {:has-more? true :auto-model? true} {:saw-upstream-invalid-request true}))
      "an invalid request is the client's fault: no point trying another model"))

(deftest vision
  (is (chains/vision-model? " AUTO:Vision "))
  (is (not (chains/vision-model? "auto:smartest")))
  (is (= ["glm-5v-turbo" "Kimi-K2.5" "gpt-5.4-mini"] (chains/vision-candidates c ["gpt-5.4-mini" "GLM-5V-Turbo" "kimi-k2.5" "x"])))
  (is (= 4 (count (chains/vision-candidates c ["x"]))) "nothing offered: the whole chain")
  (let [ids ["vivgrid" "zai" "rotussy" "ollama-cloud" "ollama-stealth"]]
    (is (= [1 0 2 3 4] (chains/vision-route-order c "glm-5v-turbo" ids)))
    (is (= [3 0 1 2 4] (chains/vision-route-order c "Kimi" ids)))
    (is (= [3 4 0 1 2] (chains/vision-route-order c "qwen3.5:4b-q8_0" ids)))
    (is (= [3 4 0 1 2] (chains/vision-route-order c "mystery:1b" ids)) "any colon-tagged model is local")
    (is (= [0 1 2 3 4] (chains/vision-route-order c "gpt-5.4-mini" ids)))))

(deftest intentional-divergence-cephalon-suffix
  (testing "fastest/smartest are now selectable (TS parsed `cephalon:fastest` and always fell back to cheapest)"
    (is (= "auto:fastest" (:inner-model (chains/cephalon-plan c "auto:cephalon:fastest" []))))
    (is (= "auto:smartest" (:inner-model (chains/cephalon-plan c "auto:cephalon:SMARTEST" []))))
    (is (= "auto:cheapest" (:inner-model (chains/cephalon-plan c "auto:cephalon:other" []))))))

(deftest cephalon
  (is (chains/cephalon-model? "auto:cephalon"))
  (is (chains/cephalon-model? "AUTO:CEPHALON:fastest"))
  (is (not (chains/cephalon-model? "auto:cephalonx")))
  (is (= "auto:fastest" (:inner-model (chains/cephalon-plan c "auto:cephalon:fastest" []))))
  (is (= "auto:cheapest" (:inner-model (chains/cephalon-plan c "auto:cephalon" []))))
  (is (= "auto:smartest" (:inner-model (chains/cephalon-plan c "auto:cephalon: Smartest " []))))
  (is (= ["m1" "gpt-oss:20b" "gpt-oss:120b" "qwen3-coder:480b" "gemma3:27b" "gemma3:12b" "gemma3:4b"]
         (:candidates (chains/cephalon-plan c "auto:cephalon" ["m1" "gpt-oss:20b"]))) "the pool is deduplicated, catalog first")
  (testing "choice"
    (is (= "gpt-5.4-nano" (chains/cephalon-choice c "auto:cephalon" [])))
    (is (= "gemma3:12b" (chains/cephalon-choice c "auto:cephalon:fastest" ["x" "GEMMA3:12B" "gemma3:27b"])) "fast order, spelled as the list spells it")
    (is (= "gpt-oss:120b" (chains/cephalon-choice c "auto:cephalon:smartest" ["gpt-oss:20b" "gpt-oss:120b"])))
    (is (= "GPT-5-MINI" (chains/cephalon-choice c "auto:cephalon" ["zzz" "GPT-5-MINI"])) "the ranked spelling is kept")
    (is (= "zzz" (chains/cephalon-choice c "auto:cephalon" ["zzz" "yyy"])))))
