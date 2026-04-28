(ns proxx.schema-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.schema :as s]))

;; ── Fixtures ────────────────────────────────────────────────────────────────

(def valid-provenance
  {:source :rest :ingested-at 1713484800000 :request-id "req-abc"})

(def valid-provider
  {:id "openai" :display-name "OpenAI" :enabled true :provenance valid-provenance})

(def valid-provider-endpoint
  {:provider-id "openai" :endpoint :completions :path "/v1/chat/completions"
   :supported true :provenance valid-provenance})

(def valid-provider-model
  {:provider-id "openai" :model-id "gpt-4o" :context-tokens 128000
   :streaming true :vision true :provenance valid-provenance})

(def valid-affinity
  {:prompt-cache-key "abc12345" :provider-id "openai" :account-id "acct-1"
   :updated-at 1713484800000 :provenance valid-provenance})

(def valid-pheromone
  {:provider-id "openai" :model-id "gpt-4o"
   :score 0.85 :last-event-at 1713484800000 :provenance valid-provenance})

(def valid-scoring-weight
  {:profile-id "default" :metric-key "latency.p99" :weight 0.4 :transform :invert
   :provenance valid-provenance})

(def valid-routing-policy
  {:id "default" :scoring-profile "default" :sampler :softmax
   :max-attempts 3 :provenance valid-provenance})

(def valid-affinity-policy
  {:provisional-promotion-threshold 3 :enabled true :provenance valid-provenance})

;; ── Green: valid records pass ────────────────────────────────────────────────

(deftest provenance-valid
  (is (= :ok (first (s/validate :provenance valid-provenance)))))

(deftest provider-valid
  (is (= :ok (first (s/validate :provider valid-provider)))))

(deftest provider-endpoint-valid
  (is (= :ok (first (s/validate :provider-endpoint valid-provider-endpoint)))))

(deftest provider-model-valid
  (is (= :ok (first (s/validate :provider-model valid-provider-model)))))

(deftest prompt-affinity-valid
  (is (= :ok (first (s/validate :prompt-affinity valid-affinity)))))

(deftest pheromone-state-valid
  (is (= :ok (first (s/validate :pheromone-state valid-pheromone)))))

(deftest scoring-weight-valid
  (is (= :ok (first (s/validate :scoring-weight valid-scoring-weight)))))

(deftest routing-policy-valid
  (is (= :ok (first (s/validate :routing-policy valid-routing-policy)))))

(deftest affinity-policy-valid
  (is (= :ok (first (s/validate :affinity-policy valid-affinity-policy)))))

;; ── Red: invalid records fail with humanized errors ──────────────────────────

(deftest provenance-bad-source
  (let [[status err] (s/validate :provenance (assoc valid-provenance :source :unknown))]
    (is (= :error status))
    (is (some? err))))

(deftest provider-missing-id
  (let [[status err] (s/validate :provider (dissoc valid-provider :id))]
    (is (= :error status))
    (is (some? err))))

(deftest provider-empty-id
  (let [[status _] (s/validate :provider (assoc valid-provider :id ""))]
    (is (= :error status))))

(deftest provider-model-bad-tokens
  (let [[status _] (s/validate :provider-model (assoc valid-provider-model :context-tokens 0))]
    (is (= :error status))))

(deftest pheromone-score-out-of-range
  (let [[status _] (s/validate :pheromone-state (assoc valid-pheromone :score 99.0))]
    (is (= :error status))))

(deftest routing-policy-bad-sampler
  (let [[status _] (s/validate :routing-policy (assoc valid-routing-policy :sampler :random-walk))]
    (is (= :error status))))

(deftest routing-policy-max-attempts-exceeded
  (let [[status _] (s/validate :routing-policy (assoc valid-routing-policy :max-attempts 99))]
    (is (= :error status))))

(deftest affinity-record-optional-provisional-fields
  (is (= :ok (first (s/validate :prompt-affinity
                                (dissoc valid-affinity
                                        :provisional-provider-id
                                        :provisional-account-id
                                        :provisional-success-count))))))

;; ── assert! throws on failure ─────────────────────────────────────────────────

(deftest assert-throws-on-bad-record
  (is (thrown-with-msg?
        js/Error #"Schema assertion failed"
        (s/assert! :provider (dissoc valid-provider :id)))))

;; ── Registry completeness ─────────────────────────────────────────────────────

(deftest all-entity-types-in-registry
  (doseq [k [:provenance :provider :provider-endpoint :provider-model
             :prompt-affinity :pheromone-state :scoring-weight
             :routing-policy :affinity-policy]]
    (is (some? (s/schema-for k))
        (str "Missing schema for " k))))

(deftest unknown-entity-type-throws
  (is (thrown-with-msg?
        js/Error #"Unknown entity-type"
        (s/schema-for :does-not-exist))))
