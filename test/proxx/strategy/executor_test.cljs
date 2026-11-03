(ns proxx.strategy.executor-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.policy.loader :as loader]
            [proxx.runtime.strategy :as edge]
            [proxx.schema :as schema]
            [proxx.strategy.attempt :as attempt]
            [proxx.strategy.executor :as ex]
            [proxx.strategy.routing :as routing]
            [proxx.strategy.select :as select]))

(def ^:private contracts (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
(def ^:private policy (routing/policy-from-contracts contracts))
(def ^:private registry (select/registry-from-contracts contracts))

(def ^:private ctx {:provider-id "openai" :account-provider-id "openai" :auth-type :api-key :key-cooldown-ms 30000
                    :prompt-cache-key? false :matches-preferred? false :matches-provisional? false
                    :preferred-affinity? false :health? true :refresh-available? true :has-refresh-token? false})

(defn- run [state event] (ex/step state policy event))
(def ^:private fresh (ex/initial-state {:reassignment-allowed? true :sticky? false}))

(deftest contracts-are-valid
  (is (some? (schema/validate :proxx/policy-contract registry))))

;; --- attempt verdicts ----------------------------------------------------------

(deftest failed-response-outcomes
  (is (= {:model-not-found true} (attempt/failed-outcome {:status 404 :missing-model? true})))
  (is (= {:model-not-supported-for-account true :request-error true}
         (attempt/failed-outcome {:status 400 :model-not-supported? true})))
  (is (= {:request-error true :upstream-auth-error {:status 401 :message "bad"}}
         (attempt/failed-outcome {:status 401 :auth-message "bad"})))
  (is (= {:request-error true :upstream-auth-error {:status 403}} (attempt/failed-outcome {:status 403})))
  (is (= {:request-error true :upstream-invalid-request true :upstream-error-body ""} (attempt/failed-outcome {:status 422})))
  (is (= {:request-error true} (attempt/failed-outcome {:status 500})))
  (is (= :auth-summary (attempt/failure-body-needed 401)))
  (is (= :text (attempt/failure-body-needed 400)))
  (is (nil? (attempt/failure-body-needed 500))))

(deftest ok-body-verdicts
  (let [v #(attempt/ok-body-verdict %1 (merge {:client-wants-stream? false} %2))]
    (is (= :empty (v "" {})))
    (is (= :stream-like (v "data: {}" {:client-wants-stream? true :stream-like? true})))
    (is (= :ok (v "{\"choices\":[]}" {})))
    (is (= :ok (v "{\"id\":null}" {})) "key presence, even null")
    (is (= :invalid (v "{}" {})))
    (is (= :invalid (v "[]" {})))
    (is (= :invalid (v "nope" {})))
    (is (= :ok (v "{\"data\":[]}" {:images-passthrough? true})))
    (is (= :ok (v "{\"message\":{}}" {:provider-id "ollama"})))
    (is (= :ok (v "{\"response\":\"x\"}" {:provider-id "ollama"})))
    (is (= :invalid (v "{\"response\":\"x\"}" {:provider-id "other"})))))

(deftest bootstrap-verdicts
  (let [facts {:needs-reasoning-trace? true :has-more-candidates? true}
        v #(attempt/bootstrap-verdict % facts)]
    (is (= {:continue {:rate-limit true}} (v {:quota? true})))
    (is (= :read-more (v {:substantive? false})))
    (is (= {:continue {:request-error true}} (v {:substantive? false :done? true})))
    (is (= :read-more (v {:substantive? true :reasoning? false})))
    (is (= {:continue {:request-error true}} (v {:substantive? true :reasoning? false :done? true})))
    (is (= :ready (v {:substantive? true :reasoning? true}))))
  (is (= :ready (attempt/bootstrap-verdict {:substantive? true :reasoning? false}
                                           {:needs-reasoning-trace? true :has-more-candidates? false}))
      "the last candidate is accepted without a trace"))

;; --- the state machine ------------------------------------------------------------

(deftest transport-failure-on-sticky-routes-gives-up
  (let [state (ex/initial-state {:reassignment-allowed? true :sticky? true})
        final (reduce (fn [s _] (:state (run s {:type :transport-error :ctx ctx}))) state (range 4))]
    (is (false? (:abort? (:state (run state {:type :transport-error :ctx ctx})))))
    (is (true? (:abort? final)) "the fourth failure stops the remaining candidates"))
  (let [r (run fresh {:type :transport-error :ctx ctx})]
    (is (= [[:pheromone :failure]] (:effects r)))
    (is (false? (:abort? (:state r))) "non-sticky routes never give up early")
    (is (true? (get-in r [:state :accumulator :saw-request-error])))))

(deftest rate-limit-aftermath
  (let [r (run fresh {:type :rate-limited :ctx (assoc ctx :prompt-cache-key? true :matches-preferred? true) :limit-kind "session"})]
    (is (= [[:delete-affinity]] (:effects r)))
    (is (true? (:reassignment-allowed? (:state r)))))
  (let [state (assoc fresh :reassignment-allowed? false)
        r (run state {:type :rate-limited :ctx ctx :limit-kind "weekly"})]
    (is (= [] (:effects r)))
    (is (false? (:reassignment-allowed? (:state r))))
    (is (true? (get-in r [:state :accumulator :saw-rate-limit])))))

(deftest throttle-rules
  (is (= {:wait-ms 10000 :short-cooldown-ms 15000} (ex/throttle-plan policy 20000)))
  (is (= {:wait-ms 500 :short-cooldown-ms 500} (ex/throttle-plan policy 500)))
  (is (= :handled-ok (ex/throttle-retry-verdict {:rate-limited? false :ok? true})))
  (is (= :other-error (ex/throttle-retry-verdict {:rate-limited? false :ok? false})))
  (is (= :escalated (ex/throttle-retry-verdict {:rate-limited? true :retry-kind "quota"})))
  (is (= :still-throttled (ex/throttle-retry-verdict {:rate-limited? true :retry-kind "concurrency_throttle"}))))

(deftest quota-exhaustion
  (is (= 31536000000 (ex/quota-base-cooldown-ms policy {:status 402 :auth-type :api-key :account-provider-id "vivgrid" :key-cooldown-ms 1})))
  (is (= 86400000 (ex/quota-base-cooldown-ms policy {:status 402 :auth-type :oauth-bearer :account-provider-id "openai" :key-cooldown-ms 1})))
  (is (= 60000 (ex/quota-base-cooldown-ms policy {:status 429 :auth-type :api-key :account-provider-id "x" :key-cooldown-ms 900000})))
  (let [r (run fresh {:type :quota-exhausted :ctx (assoc ctx :matches-preferred? true) :cooldown-ms 777})]
    (is (= [[:mark-rate-limited 777] [:health :failure "quota_exhausted"] [:pheromone :failure]] (:effects r)))
    (is (= :next-candidate (:next r)))
    (is (true? (:reassignment-allowed? (:state r))))))

(deftest status-only-failures
  (is (= :transient-provider (ex/transient-status policy {:status 403 :provider-id "factory" :has-retry-remaining? true})))
  (is (nil? (ex/transient-status policy {:status 403 :provider-id "factory" :has-retry-remaining? false})) "no retries left: falls through to the strategy")
  (is (= :server-error-retry (ex/transient-status policy {:status 503 :provider-id "x" :has-retry-remaining? true})))
  (is (= :server-error (ex/transient-status policy {:status 500 :provider-id "x" :has-retry-remaining? true})))
  (is (nil? (ex/transient-status policy {:status 404 :provider-id "x" :has-retry-remaining? true})))
  (let [r (run fresh {:type :server-error :ctx ctx :kind :server-error})]
    (is (= [[:mark-rate-limited 5000] [:pheromone :failure]] (:effects r))))
  (is (= [[:sleep :transient]] (:effects (run fresh {:type :server-error :ctx ctx :kind :server-error-retry})))))

(deftest handled-credits-by-path
  (let [r (run fresh {:type :handled :variant :strategy :ctx (assoc ctx :prompt-cache-key? true :ollama-cloud? true) :ok? true :latency-ms 250})]
    (is (= [[:health :success] [:clear-model-unsupported] [:clear-account-cooldown] [:pheromone :success 1] [:emit-response] [:note-affinity-success]]
           (:effects r)))
    (is (= :handled (:next r))))
  (is (= [[:pheromone :success 1]] (:effects (run fresh {:type :handled :variant :direct :ctx ctx :latency-ms 100}))))
  (testing "a preferred affinity held by another account blocks the affinity update until reassignment is allowed"
    (let [c (assoc ctx :prompt-cache-key? true :preferred-affinity? true)
          blocked (run (assoc fresh :reassignment-allowed? false) {:type :handled :ctx c :ok? true :latency-ms 250})
          allowed (run fresh {:type :handled :ctx c :ok? true :latency-ms 250})]
      (is (not (some #{[:note-affinity-success]} (:effects blocked))))
      (is (some #{[:note-affinity-success]} (:effects allowed))))))

(deftest declined-outcomes
  (testing "a 401 on an OAuth token with a refresh token asks for a refresh"
    (let [r (run fresh {:type :declined :status 401 :ok? false
                        :ctx (assoc ctx :auth-type :oauth-bearer :has-refresh-token? true)
                        :outcome {:request-error true :upstream-auth-error {:status 401}}})]
      (is (= :refresh-token (:next r)))
      (is (= [[:pheromone :failure]] (:effects r)))))
  (testing "a static key answered 402: disabled for good"
    (let [r (run fresh {:type :declined :status 402 :ok? false :ctx ctx :outcome {:request-error true}})]
      (is (= [[:pheromone :failure] [:mark-rate-limited 31536000000] [:disable-account] [:health :failure "credential_disabled"] [:summarize-error]]
             (:effects r)))))
  (testing "an OAuth 401 without a refresh token is cooled down and disabled"
    (let [r (run fresh {:type :declined :status 401 :ok? false :ctx (assoc ctx :auth-type :oauth-bearer :refresh-available? false)
                        :outcome {:request-error true}})]
      (is (= [[:pheromone :failure] [:mark-rate-limited 10000] [:disable-account] [:health :failure "credential_disabled"] [:summarize-error]]
             (:effects r)))))
  (testing "a 200 whose stream was empty cools the credential briefly"
    (let [r (run fresh {:type :declined :status 200 :ok? true :ctx (assoc ctx :prompt-cache-key? true :matches-preferred? true)
                        :outcome {:request-error true}})]
      (is (= [[:mark-rate-limited 10000] [:pheromone :failure]
              [:log-upstream-error "stream_empty_or_invalid" "200 OK with no substantive content in stream body"]]
             (:effects r)))
      (is (true? (:reassignment-allowed? (:state r))))))
  (testing "a 200 with a quota error in the stream drops the sticky affinity"
    (let [r (run fresh {:type :declined :status 200 :ok? true :ctx (assoc ctx :prompt-cache-key? true :matches-provisional? true)
                        :outcome {:rate-limit true}})]
      (is (= [[:mark-rate-limited 30000] [:pheromone :failure]
              [:log-upstream-error "stream_quota_error" "200 OK with quota error in stream body"] [:delete-affinity]]
             (:effects r)))
      (is (true? (get-in r [:state :accumulator :saw-rate-limit])))))
  (testing "invalid requests remember the upstream's words"
    (let [r (run fresh {:type :declined :status 400 :ok? false :ctx ctx
                        :outcome {:request-error true :upstream-invalid-request true :upstream-error-body "nope"}})]
      (is (= {:status 400 :body "nope" :provider-id "openai"} (get-in r [:state :accumulator :last-upstream-error])))
      (is (= [[:summarize-error]] (remove #(= :pheromone (first %)) (:effects r))))))
  (testing "a 5xx health failure only when the strategy did not explain it"
    (is (some #{[:health :failure]} (:effects (run fresh {:type :declined :status 500 :ok? false :ctx ctx :outcome {:request-error true}}))))
    (is (not (some #{[:health :failure]} (:effects (run fresh {:type :declined :status 500 :ok? false :ctx ctx :outcome {:request-error true :model-not-found true}})))))))

(deftest refresh-paths
  (let [oauth (assoc ctx :auth-type :oauth-bearer :has-refresh-token? true)]
    (let [r (run fresh {:type :refresh-failed :ctx oauth :ok? false :outcome {:request-error true}})]
      (is (= [[:pheromone :failure] [:mark-rate-limited 10000] [:disable-account] [:summarize-error]] (:effects r))))
    (let [r (run fresh {:type :refreshed-declined :status 401 :ok? false :ctx (assoc oauth :matches-preferred? true)
                        :outcome {:request-error true}})]
      (is (= [[:pheromone :failure] [:mark-rate-limited 10000] [:disable-account]] (:effects r)))
      (is (true? (:reassignment-allowed? (:state r)))))
    (is (= [[:mark-rate-limited nil]] (:effects (run fresh {:type :refreshed-rate-limited :cooldown-ms nil}))))
    (is (= [[:health :success] [:clear-model-unsupported] [:pheromone :success 1]]
           (:effects (run fresh {:type :handled :variant :refreshed-strategy :ctx oauth :ok? true :latency-ms 250}))))))

(deftest direct-and-images
  (let [r (run fresh {:type :direct-declined :outcome {:model-not-found true}})]
    (is (true? (get-in r [:state :accumulator :saw-request-error])) "request-error defaults to true for SDK strategies")
    (is (true? (get-in r [:state :accumulator :saw-model-not-found]))))
  (is (false? (get-in (run fresh {:type :direct-declined :outcome {:request-error false}}) [:state :accumulator :saw-request-error])))
  (is (ex/images-next-base? {:status 403 :try-next-base-on-statuses [401 403] :next-base-differs? true}))
  (is (not (ex/images-next-base? {:status 500 :try-next-base-on-statuses [401 403] :next-base-differs? true})))
  (is (true? (get-in (run fresh {:type :codex-images-failed}) [:state :accumulator :saw-upstream-invalid-request]))))

;; --- selection ----------------------------------------------------------------------

(def ^:private chat {:route-provider-id "openai-like"})

(deftest strategy-selection
  (let [sel #(select/select registry %1 %2)]
    (is (= :messages (sel chat {})) "the first catch-all entry wins over the later chat-completions one")
    (is (= :images-passthrough (sel {:images-passthrough true} {})))
    (is (= :blaze-images (sel {:images-passthrough true :route-provider-id "blaze"} {})))
    (is (= :openai-responses-passthrough (sel {:responses-passthrough true :open-ai-prefixed true} {})))
    (is (= :responses-passthrough (sel {:responses-passthrough true} {})))
    (is (= :factory-responses-passthrough (sel {:responses-passthrough true :factory-prefixed true :factory-model-type "openai"} {})))
    (is (= :gemini-chat (sel {:route-provider-id "gemini"} {})))
    (is (= :zai-chat (sel {:route-provider-id "zai"} {})))
    (is (= :ollama (sel {:explicit-ollama true} {})))
    (is (= :local-ollama (sel {:local-ollama true} {})))
    (is (= :factory-messages (sel {:factory-prefixed true :factory-model-type "anthropic"} {})))
    (is (= :openai-responses (sel {:open-ai-prefixed true} {})))
    (is (= :ollama-cloud (sel {:route-provider-id "ollama-cloud"} {})))
    (is (= :tei-embeddings (sel {:embeddings-passthrough true :embedding-provider "tei"} {})))
    (is (= :openai-compat-embeddings (sel {:embeddings-passthrough true :route-provider-id "LlamaCpp-Embed "} {})))
    (is (= :ollama-embeddings (sel {:embeddings-passthrough true :route-provider-id "ollama"} {})))
    (is (= :hf-embeddings (sel {:request-body {"input" "x"} :embedding-provider "hf"} {})))
    (is (not= :hf-embeddings (sel {:request-body {"input" "x" "messages" []} :embedding-provider "hf"} {})))
    (testing "remote lookups skip local strategies; the policy's preferred mode wins among matches"
      (is (= :chat-completions (sel {:explicit-ollama true :route-provider-id "x"} {:remote-only? true})) "nothing matches: the last entry is the catch-all")
      (is (= :responses (sel chat {:remote-only? true :preferred-mode "responses"})))
      (is (= :messages (sel chat {:remote-only? true :preferred-mode "messages"})))
      (is (= :messages (sel chat {:remote-only? true :preferred-mode "nonexistent"}))))))

(deftest intentional-divergences
  (testing "a non-string x-embedding-provider header is ignored (TS threw on `.trim()`)"
    (is (nil? (select/embedding-provider-header {"x-embedding-provider" 5})))
    (is (= "tei" (select/embedding-provider-header {"x-embedding-provider" [" TEI "]})))))

(deftest edge-js
  (let [o (edge/failed-attempt-outcome-js #js {"status" 401 "authMessage" "bad"})]
    (is (= "continue" (.-kind o)))
    (is (= 401 (.. o -upstreamAuthError -status)))
    (is (= "bad" (.. o -upstreamAuthError -message))))
  (let [state (edge/create-executor-state-js #js {"reassignmentAllowed" true "sticky" false})
        r (edge/executor-step-js state #js {"type" "attempt-started"} nil)
        r2 (edge/executor-step-js (.-state r) #js {"type" "server-error" "kind" "server-error"
                                                   "ctx" #js {"keyCooldownMs" 30000 "providerId" "x"}} nil)]
    (is (= 1 (.-attempts r)))
    (is (= "next-candidate" (.-next r2)))
    (is (= "mark-rate-limited" (aget (aget (.-effects r2) 0) 0)))
    (is (true? (.-sawUpstreamServerError (edge/executor-summary-js (.-state r2)))))
    (is (= 1 (.-attempts (edge/executor-summary-js (.-state r2)))))))
