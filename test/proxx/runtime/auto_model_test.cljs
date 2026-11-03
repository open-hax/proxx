(ns proxx.runtime.auto-model-test
  "Ported from src/tests/auto-model-selector.test.ts (3 tests). The TS shim passed
  getModelPricing (the pricing kernel) into the ranking edge; so does this."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.auto-model :as edge]
            [proxx.runtime.pricing :as pricing]))

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")

(defn- get-model-pricing [provider-id model] (pricing/get-model-pricing-js manifest provider-id model))

(defn- rank [model body models provider-id & [log-store health-store]]
  (vec (array-seq (edge/rank-auto-models-js manifest model (clj->js body) (clj->js models) provider-id
                                           log-store health-store get-model-pricing))))

(defn- sorted-ids [ranked] (vec (sort (map #(.-modelId ^js %) ranked))))

(deftest text-mentions-of-images-do-not-force-vision-only-filtering
  (is (= ["deepseek-v3.2" "gpt-5.4-mini"]
         (sorted-ids (rank "auto:cheapest"
                           {"messages" [{"role" "user" "content" "Please do not generate an image. Just say hello."}]}
                           ["gpt-5.4-mini" "deepseek-v3.2"] "openai")))))

(deftest auto-model-ranking-aggregates-perf-and-health-without-model-ids-as-account-ids
  (let [log-store #js {:getModelPerfSummary
                       (fn [provider-id model upstream-mode]
                         (is (= "openai" provider-id))
                         (is (= "chat" upstream-mode))
                         (case model
                           "gpt-5.4-mini" #js {:providerId provider-id :accountId "*" :model model :upstreamMode upstream-mode
                                               :sampleCount 4 :ewmaTtftMs 120 :ewmaTps 18 :ewmaEndToEndTps 15 :updatedAt 1}
                           "deepseek-v3.2" #js {:providerId provider-id :accountId "*" :model model :upstreamMode upstream-mode
                                                :sampleCount 3 :ewmaTtftMs 860 :ewmaTps 7 :ewmaEndToEndTps 6 :updatedAt 1}
                           js/undefined))
                       :getPerfSummary (fn [] (throw (js/Error. "rankAutoModels should not use per-account perf lookups here")))}
        health-store #js {:getAllHealthScores
                          (fn [] #js [#js {:providerId "openai" :accountId "acct-a" :score 0.9 :successCount 12 :failureCount 1}
                                      #js {:providerId "openai" :accountId "acct-b" :score 0.7 :successCount 9 :failureCount 2}])
                          :getHealthScore (fn [] (throw (js/Error. "rankAutoModels should not use model ids as account ids for health lookups")))}
        ranked (rank "auto:fastest" {"messages" [{"role" "user" "content" "hello"}]}
                     ["gpt-5.4-mini" "deepseek-v3.2"] "openai" log-store health-store)]
    (is (= "gpt-5.4-mini" (.-modelId ^js (first ranked))))
    (is (true? (.-observedSpeed ^js (first ranked))))
    (is (= 80 (.-healthScore ^js (first ranked))))))

(deftest top-level-reasoning-effort-marks-the-request-as-needing-thinking-support
  (is (= ["deepseek-v3.2" "gpt-5.4-mini"]
         (sorted-ids (rank "auto:cheapest"
                           {"messages" [{"role" "user" "content" "hello"}]
                            "tools" [{"type" "function" "function" {"name" "ping" "parameters" {"type" "object" "properties" {}}}}]
                            "reasoning_effort" "medium"}
                           ["gpt-5.4-nano" "gpt-5.4-mini" "deepseek-v3.2"] "requesty")))))
