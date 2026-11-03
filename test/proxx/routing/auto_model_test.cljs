(ns proxx.routing.auto-model-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.policy.loader :as loader]
            [proxx.routing.auto-model :as auto]))

(def profile
  (->> (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn")
       (some #(when (= :auto-model-profile (:contract/kind %)) %))))

(deftest selector-parsing
  (is (auto/auto-model? "AUTO:fastest"))
  (is (not (auto/auto-model? "gpt-5")))
  (is (= :cheapest (auto/parse-auto-type " auto:Cheapest ")))
  (is (nil? (auto/parse-auto-type "auto:wittiest")))
  (is (nil? (auto/parse-auto-type "gpt-5"))))

(deftest capability-detection
  (is (= #{} (auto/detect-capabilities nil)))
  (is (= #{} (auto/detect-capabilities {"messages" [{"content" "hi"}] "tools" []})))
  (is (= #{:vision} (auto/detect-capabilities {"messages" [nil {"content" [{"type" "text"} {"type" "image_url"}]}]})))
  (is (= #{:tools} (auto/detect-capabilities {"tools" [{}]})))
  (doseq [k ["reasoning_effort" "reasoningEffort" "reasoning_summary" "reasoningSummary"]]
    (is (= #{:thinking} (auto/detect-capabilities {k ""})) "any string value, even empty"))
  (is (= #{:thinking} (auto/detect-capabilities {"reasoning" {"effort" "low"}})))
  (is (= #{:thinking} (auto/detect-capabilities {"reasoning" {"max_tokens" 100}})))
  (is (= #{} (auto/detect-capabilities {"reasoning" {"effort" "" "max_tokens" 0}})))
  (is (= #{:vision :tools :thinking}
         (auto/detect-capabilities {"messages" [{"content" [{"type" "image_url"}]}] "tools" [1] "reasoning_effort" "high"}))))

(deftest profile-facts-come-from-edn
  (is (= 100 (auto/intelligence profile "gpt-5.4-pro")))
  (is (= 100 (auto/intelligence profile " GPT-5.4-PRO ")))
  (is (= 50 (auto/intelligence profile "unknown-model")))
  (is (auto/supports? profile "gpt-5.4" #{:vision :tools :thinking}))
  (is (not (auto/supports? profile "gpt-5" #{:thinking})))
  (is (not (auto/supports? profile "claude-haiku-4-5" #{:tools})))
  (is (not (auto/supports? profile "mystery" #{:vision})))
  (is (auto/supports? profile "mystery" #{}) "no needs: everything qualifies")
  (is (= 20 (count (:auto/default-candidates profile)))))

(deftest health-aggregation
  (is (= 50 (auto/aggregate-health [] "p")))
  (is (= 50 (auto/aggregate-health [{"providerId" "q" "score" 1}] "p")))
  (is (= 50 (auto/aggregate-health [{"providerId" "p" "score" 0.25} {"providerId" "p" "score" 0.75} {"providerId" "q" "score" 1}] "p"))))

(defn- rank [model body candidates facts]
  (mapv :model-id (auto/rank-auto-models profile model body candidates "prov" 50 facts)))

(def prices
  {"a" {:pricing {:input 1 :output 2 :found? true}}
   "b" {:pricing {:input 0.5 :output 0.5 :found? true}}
   "c" {:pricing {:input 0 :output 0 :found? false}}
   "gpt-5.4" {:pricing {:input 10 :output 20 :found? true}}
   "claude-haiku-4-5" {:pricing {:input 1 :output 5 :found? true} :ttft-ms 500}
   "glm-5" {:pricing {:input 1 :output 5 :found? true} :ttft-ms 100}})

(deftest ranking-strategies
  (testing "cheapest: priced before unpriced, then by total price"
    (is (= ["b" "a" "c"] (rank "auto:cheapest" {} ["a" "b" "c"] prices))))
  (testing "fastest: observed latency first, higher speed score wins"
    (is (= ["glm-5" "claude-haiku-4-5" "gpt-5.4"] (rank "auto:fastest" {} ["gpt-5.4" "claude-haiku-4-5" "glm-5"] prices))))
  (testing "smartest: by intelligence, ties by price"
    (is (= ["gpt-5.4" "glm-5" "claude-haiku-4-5"] (rank "auto:smartest" {} ["claude-haiku-4-5" "glm-5" "gpt-5.4"] prices))))
  (testing "healthiest: all equal health falls to speed observation then name"
    (is (= ["glm-5" "claude-haiku-4-5" "gpt-5.4"] (rank "auto:healthiest" {} ["gpt-5.4" "claude-haiku-4-5" "glm-5"] prices))))
  (testing "scores"
    (let [[cheap] (auto/rank-auto-models profile "auto:cheapest" {} ["b"] "prov" 50 prices)]
      (is (= 99 (:score cheap)))
      (is (= {:cost-score 1 :speed-score 50 :observed-speed? false :health-score 50 :pricing-found? true}
             (select-keys cheap [:cost-score :speed-score :observed-speed? :health-score :pricing-found?]))))
    (is (= 95 (:speed-score (first (auto/rank-auto-models profile "auto:fastest" {} ["claude-haiku-4-5"] "prov" 50 prices)))))))

(deftest candidate-filtering
  (is (= [] (rank "gpt-5" {} ["a"] prices)) "not an auto selector")
  (is (= [] (rank "auto:cheapest" {} [] prices)) "explicit empty candidates stay empty")
  (is (= ["gpt-5.4"] (rank "auto:smartest" {"tools" [1] "reasoning_effort" "low"} ["gpt-5" "gpt-5.4" "claude-haiku-4-5"] prices)))
  (is (= ["a"] (rank "auto:cheapest" {} ["auto:fastest" "a"] prices)) "auto selectors are never candidates")
  (is (= 20 (count (rank "auto:smartest" {} nil (constantly {:pricing {:input 0 :output 0 :found? false}}))))
      "nil candidates: the profile default list"))
