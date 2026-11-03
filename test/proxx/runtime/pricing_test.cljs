(ns proxx.runtime.pricing-test
  "Ported from src/tests/model-pricing.test.ts (7 tests) and
  src/tests/gemma4-pricing.test.ts (3 tests). The TS module was a shim over the
  pricing edge, which is driven directly (same manifest, same 1800 mL/kWh water
  constant the shim passed). The TS gemma4 tests skipped when the CLJS artifact
  was unbuilt; here the code under test is the test build itself, so no skip."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime :as runtime]
            [proxx.runtime.pricing :as edge]))

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")
(def ^:private wue-ml-per-kwh 1800)

(defn- pricing ^js [provider model] (edge/get-model-pricing-js manifest provider model))
(defn- estimate ^js [provider model in out] (edge/estimate-request-cost-js manifest provider model in out wue-ml-per-kwh))
(defn- reset-overrides! [] (edge/set-policy-model-pricing-overrides-js #js []))

(deftest uses-models-dev-pricing-for-direct-openai-models
  (reset-overrides!)
  (let [p (pricing "openai" "gpt-5.4")]
    (is (true? (.-pricingFound p)))
    (is (= "models.dev" (.-pricingSource p)))
    (is (= "openai" (.-pricingProviderId p)))
    (is (= 2.5 (.-inputPer1MTokens p)))
    (is (= 15 (.-outputPer1MTokens p)))))

(deftest falls-back-to-canonical-vendor-pricing-for-factory-claude-models
  (reset-overrides!)
  (let [p (pricing "factory" "factory/claude-opus-4-6")]
    (is (true? (.-pricingFound p)))
    (is (= "anthropic" (.-pricingProviderId p)))
    (is (= "claude-opus-4-6" (.-pricingModelId p)))
    (is (= 5 (.-inputPer1MTokens p)))
    (is (= 25 (.-outputPer1MTokens p)))))

(deftest falls-back-from-ollama-cloud-router-entries-to-vendor-pricing
  (reset-overrides!)
  (let [p (pricing "ollama-cloud" "glm-5")]
    (is (true? (.-pricingFound p)))
    (is (= "zai" (.-pricingProviderId p)))
    (is (= 1 (.-inputPer1MTokens p)))
    (is (= 3.2 (.-outputPer1MTokens p)))))

(deftest glm-5v-variants-fall-back-to-glm-5-pricing-when-models-dev-omits-the-v-tag
  (reset-overrides!)
  (let [p (pricing "ollama-cloud" "glm-5v-turbo")]
    (is (true? (.-pricingFound p)))
    (is (= "zai" (.-pricingProviderId p)))
    (is (= "glm-5-turbo" (.-pricingModelId p)))
    (is (= 1.2 (.-inputPer1MTokens p)))
    (is (= 4 (.-outputPer1MTokens p)))))

(deftest local-ollama-models-remain-zero-cost-but-track-energy
  (reset-overrides!)
  (let [e (estimate "ollama" "ollama/qwen3.5:4b-q8_0" 1000 500)]
    (is (= 0 (.-costUsd e)))
    (is (> (.-energyJoules e) 0))
    (is (> (.-waterEvaporatedMl e) 0))))

(deftest policy-pricing-overrides-provide-fallback-prices-for-unpriced-models
  (edge/set-policy-model-pricing-overrides-js
   #js [#js {:contractId ":model-pricing-override/gemma4-31b"
             :modelPattern "(?i)^gemma4:31b$"
             :mode "fallback-unpriced"
             :inputPer1MTokens 0.134
             :outputPer1MTokens 0.395}])
  (let [p (pricing "ollama-cloud" "gemma4:31b")]
    (is (true? (.-pricingFound p)))
    (is (= "policy" (.-pricingSource p)))
    (is (= 0.134 (.-inputPer1MTokens p)))
    (is (= 0.395 (.-outputPer1MTokens p))))
  (reset-overrides!))

(deftest ^:async refreshes-the-in-memory-pricing-index-from-models-dev-compatible-payloads
  (reset-overrides!)
  (let [bundled (js->clj (.-providers ^js (edge/get-models-dev-pricing-snapshot-js manifest)))
        payload (assoc bundled "freshprovider" {"models" {"fresh-model-2026" {"input" 0.25 "output" 0.75}}})
        fetch-fn (fn [_url _opts] (js/Promise.resolve (js/Response. (js/JSON.stringify (clj->js {"providers" payload}))
                                                                     #js {:status 200})))
        ^js status (await (edge/refresh-models-dev-pricing-index-js
                           manifest #js {:sourceUrl "https://example.test/models-dev-api.json" :fetchFn fetch-fn :timeoutMs 1000}))
        p (pricing "freshprovider" "fresh-model-2026")]
    (is (= "https://example.test/models-dev-api.json" (.-sourceUrl status)))
    (is (> (.-providerCount status) 1))
    (is (> (.-modelCount status) 1))
    (is (true? (.-pricingFound p)))
    (is (= "models.dev" (.-pricingSource p)))
    (is (= "freshprovider" (.-pricingProviderId p)))
    (is (= 0.25 (.-inputPer1MTokens p)))
    (is (= 0.75 (.-outputPer1MTokens p)))))

;; ---- gemma4-pricing -------------------------------------------------------

(defn- gemma4-overrides [] (runtime/load-model-pricing-overrides-js manifest))

(deftest cljs-runtime-loads-gemma4-pricing-override-from-manifest
  (let [overrides (gemma4-overrides)]
    (is (array? overrides) "overrides should be an array")
    (let [^js override (.find overrides (fn [^js o] (= "(?i)^gemma4:31b$" (.-modelPattern o))))]
      (is (some? override) "should find gemma4:31b pricing override")
      (is (= 0.134 (.-inputPer1MTokens override)))
      (is (= 0.395 (.-outputPer1MTokens override))))))

(deftest gemma4-31b-cost-calculation-with-2-9b-tokens-is-correct
  (edge/set-policy-model-pricing-overrides-js (gemma4-overrides))
  (try
    (let [e (estimate "gemini" "gemma4:31b" 2900000000 0)]
      ;; at $0.134 per 1M tokens, 2.9B tokens = 2900 * $0.134 = $388.60
      (is (> (.-costUsd e) 300) (str "cost should be > $300 for 2.9B tokens, got $" (.-costUsd e)))
      (is (< (.-costUsd e) 400) (str "cost should be < $400 for 2.9B tokens, got $" (.-costUsd e))))
    (finally (reset-overrides!))))

(deftest gemma4-31b-pricing-is-found-for-gemini-provider
  (edge/set-policy-model-pricing-overrides-js (gemma4-overrides))
  (try
    (let [p (pricing "gemini" "gemma4:31b")]
      (is (true? (.-pricingFound p)))
      (is (= "policy" (.-pricingSource p)))
      (is (= 0.134 (.-inputPer1MTokens p)))
      (is (= 0.395 (.-outputPer1MTokens p))))
    (finally (reset-overrides!))))
