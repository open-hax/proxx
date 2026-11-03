(ns proxx.pricing.model-test
  (:require [cljs.reader :as reader]
            [cljs.test :refer [deftest is testing]]
            ["node:fs" :as fs]
            [proxx.policy.loader :as loader]
            [proxx.pricing.model :as m]
            [proxx.runtime.pricing :as edge]
            [proxx.schema :as schema]))

(def manifest "resources/policies/runtime/00-manifest.edn")
(def contracts (loader/load-policy-contracts! manifest))
(def profile (m/profile-from-contracts contracts))

(def snapshot
  {:generated-at "t" :source-url "u"
   :providers {"openai" [["gpt-5.4" {:input 2.5 :output 15}]
                         ["gpt-5.4-mini" {:input 0.75 :output 4.5 :cache-read 0.075}]]
               "anthropic" [["claude-opus-4-6" {:input 5 :output 25}]]
               "zai" [["glm-5-turbo" {:input 1.2 :output 4}] ["glm-5" {:input 1 :output 3.2}]]}})
(def indexes (m/build-indexes snapshot))

(defn- price [overrides provider model] (m/model-pricing profile indexes overrides provider model))

(deftest lookup-spellings
  (is (= ["a-b" "a:b"] (m/candidate-aliases "x/A:B")) "routing prefix dropped, lower-cased, colon variant")
  (is (= ["gemma4-31b-latest" "gemma4:31b:latest" "gemma4-31b" "gemma4:31b"] (m/candidate-aliases "gemma4:31b:latest"))
      "longest first, then locale order; the :latest-less form is also tried")
  (testing "glm-5v is looked up as glm-5"
    (is (some #{"glm-5-turbo"} (m/candidate-aliases "glm-5v-turbo")))
    (is (some #{"glm-5"} (m/candidate-aliases "glm-5v")))
    (is (some #{"glm-5ision"} (m/candidate-aliases "glm-5vision")) "the v is dropped before any character, as the TypeScript did"))
  (is (= [] (m/candidate-aliases "")) "an empty model has nothing to look up"))

(deftest catalogue-resolution
  (testing "direct provider, exact"
    (is (= {:found? true :source "models.dev" :provider-id "openai" :model-id "gpt-5.4" :input 2.5 :output 15}
           (select-keys (price [] "openai" "gpt-5.4") [:found? :source :provider-id :model-id :input :output]))))
  (testing "a router falls back to the canonical vendor"
    (let [p (price [] "factory" "factory/claude-opus-4-6")]
      (is (= ["anthropic" "claude-opus-4-6" 5] ((juxt :provider-id :model-id :input) p)))))
  (testing "fuzzy prefix match beats nothing but loses to an exact alias"
    (is (= "gpt-5.4" (:model-id (price [] "openai" "gpt-5.4"))))
    (is (= "gpt-5.4" (:model-id (price [] "openai" "gpt-5")))
        "the shorter-id entry wins the prefix tie"))
  (testing "unknown models are unpriced, with a default energy profile"
    (let [p (price [] "openai" "no-such-thing")]
      (is (= {:found? false :source "unpriced" :input 0} (select-keys p [:found? :source :input])))
      (is (= [0.5 1.5] ((juxt :joules-per-input-token :joules-per-output-token) p)))))
  (testing "gemini is models.dev's google; local providers are free"
    (is (= "unpriced" (:source (price [] "gemini" "gemini-2.5-pro"))) "no google table in this snapshot")
    (doseq [p ["ollama" "Local " "local-ollama"]]
      (is (= ["local" true 0] ((juxt :source :found? :input) (price [] p "gpt-5.4")))))))

(deftest energy-profiles-are-ordered-contracts
  (is (= [1.0 3.0] ((juxt :joules-per-input-token :joules-per-output-token) (m/resolve-energy profile "gpt-5.4"))))
  (is (= [0.3 1.0] ((juxt :joules-per-input-token :joules-per-output-token) (m/resolve-energy profile "gpt-5.4-mini"))))
  (is (= [1.5 4.0] ((juxt :joules-per-input-token :joules-per-output-token) (m/resolve-energy profile "claude-opus-4-6-fast"))) "specific clause precedes the general one"))

(deftest policy-overrides
  (let [rules (m/parse-override-rules
               (js->clj #js [#js {:contractId ":a" :modelPattern "(?i)^gemma4:31b$" :inputPer1MTokens 0.134 :outputPer1MTokens 0.395}
                             #js {:modelPattern "(?i)^gpt-5\\.4$" :mode ":force" :inputPer1MTokens 1 :outputPer1MTokens 2}
                             #js {:modelPattern "x" :inputPer1MTokens -1 :outputPer1MTokens 1}
                             #js {:modelPattern "" :inputPer1MTokens 1 :outputPer1MTokens 1}
                             #js {:inputPer1MTokens 1 :outputPer1MTokens 1}
                             5 nil]))]
    (is (= 2 (count rules)) "negative prices, empty/absent patterns and non-objects are dropped")
    (testing "fallback-unpriced applies only without a catalogue price"
      (is (= ["policy" 0.134 "policy" "gemma4:31b"]
             ((juxt :source :input :provider-id :model-id) (price rules "ollama-cloud" "gemma4:31b")))))
    (testing "force beats the catalogue"
      (is (= ["policy" 1] ((juxt :source :input) (price rules "openai" "gpt-5.4")))))
    (testing "unrelated models are untouched"
      (is (= "models.dev" (:source (price rules "openai" "gpt-5.4-mini")))))))

(deftest request-cost
  (let [pricing (price [] "openai" "gpt-5.4")
        {:keys [cost-usd energy-joules water-evaporated-ml]} (m/estimate-cost pricing 1000000 500000 1800)]
    (is (= 10 cost-usd) "1M * 2.5 + 0.5M * 15 per 1M = 2.5 + 7.5")
    (is (= (+ 1000000 1500000) energy-joules))
    (is (= (* (/ 2500000 3600000) 1800) water-evaporated-ml))))

(deftest compacting-an-upstream-payload
  (let [s (m/compact-snapshot (js->clj #js {:providers #js {:b #js {:models #js {:z #js {:cost #js {:input 1 :cache_read 2 :bogus 3}}
                                                                                 :a #js {:cost #js {}}
                                                                                 :c #js {:output 4}}}
                                                            :a #js {:models #js {}}
                                                            :n 5}})
                              "now" "url")]
    (is (= {"b" [["c" {:output 4}] ["z" {:input 1 :cache-read 2}]]} (:providers s))
        "only priced models and providers survive, in locale order; cost may sit directly on the model")
    (is (= {:generated-at "now" :source-url "url" :provider-count 1 :model-count 2} (m/snapshot-status s))))
  (is (thrown-with-msg? js/Error #"did not contain any priced models" (m/compact-snapshot {} "t" "u"))
      "an empty payload must not replace the active snapshot"))

(deftest bundled-snapshot-and-contracts
  (let [snap (schema/assert! :proxx/models-dev-pricing-snapshot
                             (reader/read-string (.readFileSync fs "resources/data/models-dev-pricing.edn" "utf8")))]
    (is (> (:model-count (m/snapshot-status snap)) 3000))
    (is (= "../../data/models-dev-pricing.edn" (m/snapshot-path contracts))))
  (is (= 3 (count (filter :local? (vals (:provider-rules profile))))) "ollama, local-ollama, local")
  (is (thrown? js/Error (m/profile-from-contracts [])) "a policy without a default energy profile is rejected"))

(deftest edge-serves-the-bundled-snapshot
  (let [p (edge/get-model-pricing-js manifest "openai" "gpt-5.4")]
    (is (= 2.5 (.-inputPer1MTokens p)))
    (is (= "models.dev" (.-pricingSource p))))
  (is (> (.-modelCount (edge/get-model-pricing-index-status-js manifest)) 3000))
  (edge/set-policy-model-pricing-overrides-js "not an array")
  (is (= "models.dev" (.-pricingSource (edge/get-model-pricing-js manifest "openai" "gpt-5.4")))))
