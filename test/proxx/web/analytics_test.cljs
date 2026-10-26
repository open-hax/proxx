(ns proxx.web.analytics-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.web.format :as fmt]
            [proxx.web.pages.analytics :as an]
            [proxx.web.update :as u]))

(defn- boot [& [stored]] (u/init-db {:stored (or stored {}) :token "t" :path "/analytics"}))
(defn- paths [fx*] (keep #(when (= :http (first %)) (:path (second %))) fx*))
(defn- row [m] (merge {:requestCount 12 :errorCount 0 :errorRate 0 :totalTokens 3400 :promptTokens 1200 :completionTokens 2200
                       :cachedPromptTokens 200 :cacheHitRate 20 :avgTtftMs 420 :avgDecodeTps 18 :avgTps 14 :avgEndToEndTps 10
                       :costUsd 1.23 :energyJoules 12000 :waterEvaporatedMl 34 :firstSeenAt "2026-04-03T00:00:00Z"
                       :lastSeenAt "2026-04-03T00:00:00Z" :confidenceScore 0.9 :suitabilityScore 0.86} m))

(def payload
  {:window "weekly" :generatedAt "2026-04-03T00:00:00Z"
   :coverage {:requestedWindowStart "2026-03-27T00:00:00Z" :coverageStart "2026-04-01T00:00:00Z" :hasFullWindowCoverage false}
   :models [(row {:model "gpt-5.3-codex" :providerCoverageCount 1}) (row {:model "other" :suitabilityScore nil})]
   :providers [(row {:providerId "openai" :modelCoverageCount 2})]
   :providerModels [(row {:providerId "openai" :model "gpt-5.3-codex"}) (row {:providerId "x" :model "other"})]})

(deftest number-formatting
  (is (= "999" (fmt/compact-number 999)))
  (is (= "3.4K" (fmt/compact-number 3400)))
  (is (= "$1.23" (fmt/usd 1.234)))
  (is (= "$0.1200" (fmt/usd 0.12)))
  (is (= "20%" (fmt/percent 20)))
  (is (= "5.5%" (fmt/percent 5.5)))
  (is (= "34.0 mL" (fmt/water 34)))
  (is (= "1.50 L" (fmt/water 1500)))
  (is (= "500.0 uL" (fmt/water 0.5)))
  (is (= "0.0001 mL" (fmt/water 0.0001)))
  (is (= "420 ms" (fmt/maybe-ms 420.4)))
  (is (= "-" (fmt/maybe-ms nil)))
  (is (= "18 t/s" (fmt/maybe-tps 18)))
  (is (= "1.5 t/s" (fmt/maybe-tps 1.5)))
  (is (= "86%" (fmt/maybe-fraction-percent 0.86)))
  (is (= "-" (fmt/maybe-fraction-percent nil))))

(deftest enter-and-controls
  (let [[db fx*] (u/handle (boot) [:route/changed "/analytics"])]
    (is (= ["/api/v1/analytics/provider-model?sort=suitability&window=weekly"] (paths fx*)))
    (is (some #(= [:interval/start :analytics 30000 [:analytics/load]] %) fx*))
    (let [[db2 fx2] (u/handle db [:analytics/set-sort " TOKENS "])]
      (is (= "tokens" (an/sort-key db2)))
      (is (= ["/api/v1/analytics/provider-model?sort=tokens&window=weekly"] (paths fx2))))
    (let [[db2 fx2] (u/handle db [:analytics/set-window "daily"])]
      (is (= "daily" (an/window db2)))
      (is (= ["/api/v1/analytics/provider-model?sort=suitability&window=daily"] (paths fx2))))
    (let [[db2 _] (u/handle db [:analytics/set-sort "bogus"])]
      (is (= "suitability" (an/sort-key db2)) "invalid sort falls back"))))

(deftest stale-responses-and-focus-reset
  (let [db (first (u/handle (boot {an/ls-provider "gone" an/ls-model "gpt-5.3-codex"}) [:route/changed "/analytics"]))
        [db1 fx1] (u/handle db [:analytics/loaded 1 payload])]
    (is (= "" (an/provider-focus db1)) "vanished provider focus cleared")
    (is (= "gpt-5.3-codex" (an/model-focus db1)) "still-present focus kept")
    (is (= [[:storage/write an/ls-provider ""]] fx1))
    (let [[db2] (u/handle db [:analytics/load])
          [db3] (u/handle db2 [:analytics/loaded 1 payload])]
      (is (nil? (:analytics (get-in db3 [:pages :analytics]))) "stale"))))

(deftest view-model
  (let [db (-> (boot {an/ls-provider "openai"})
               (assoc-in [:pages :analytics :analytics] payload)
               (assoc-in [:pages :analytics :loading?] false))
        vm (an/view-model db)
        [models providers pairs] (:tabs vm)]
    (is (= ["models" "providers" "pairs"] (mapv :id (:tabs vm))) "no duplicate tabs")
    (is (= ["2" "1" "1"] (mapv :badge (:tabs vm))) "pairs filtered by provider focus")
    (is (= ["gpt-5.3-codex" "other"] (:model-options vm)))
    (is (re-find #"^Selected window is not fully covered yet" (:coverage-warning vm)))
    (is (= "Top model: gpt-5.3-codex" (get-in vm [:tiles 0 :detail])))
    (is (= "86%" (get-in vm [:tiles 3 :value])))
    (let [r (first (get-in models [:table :rows]))]
      (is (= "model-gpt-5.3-codex" (get r "rowKey")))
      (is (= "gpt-5.3-codex" (get r "model")))
      (is (= "86%" (get r "suitability")))
      (is (= "420 ms" (get r "ttft")))
      (is (= "$1.23" (get r "cost")))
      (is (= "20%" (get r "cacheHit"))))
    (is (= "-" (get (second (get-in models [:table :rows])) "suitability")))
    (is (= "34.0 mL" (get (first (get-in pairs [:table :rows])) "water")))
    (is (= 13 (count (get-in models [:table :columns]))))
    (is (= 15 (count (get-in pairs [:table :columns]))))))

(deftest searching
  (let [db (-> (boot) (assoc-in [:pages :analytics :analytics] payload))
        [db1] (u/handle db [:analytics/set-model-search "  OTH "])
        [db2] (u/handle db [:analytics/set-provider-search "zzz"])]
    (is (= ["other"] (mapv #(get % "model") (get-in (first (:tabs (an/view-model db1))) [:table :rows]))))
    (is (= "0" (:badge (second (:tabs (an/view-model db2))))))
    (is (empty? (:coverage-warning (an/view-model (assoc-in db [:pages :analytics :analytics :coverage :hasFullWindowCoverage] true)))))))
