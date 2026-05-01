(ns proxx.policy-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.policy :as policy]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]
            [proxx.policy.router :as router]))

(defn strategy [id outcome strategy-symbol]
  {:contract/id id
   :contract/kind :strategy
   :policy/outcome outcome
   :policy/strategy strategy-symbol})

(defn policy-node [id outcome children]
  {:contract/id id
   :contract/kind :policy
   :policy/outcome outcome
   :policy/children children})

(deftest all-stops-on-first-nil
  (is (nil? (policy/eval-forms :all ['(= 1 2) '(= 1 1)] {} (atom [])))))

(deftest some-returns-first-non-nil
  (is (= true (policy/eval-forms :some ['(= 1 2) '(= 1 1) '(= 2 2)] {} (atom [])))))

(deftest failing-condition-skips-filters-and-children
  (policy/clear-strategies!)
  (let [calls (atom 0)
        trace (atom [])
        p {:contract/id :policy/skip
           :contract/kind :policy
           :policy/condition {:eval/op :all :eval/forms ['(= (get ctx :allowed?) true)]}
           :policy/filters [{:eval/op :all :eval/forms ['(= (get ctx :boom) true)]}]
           :policy/outcome :reduce
           :policy/children [(strategy :strategy/child :apply 'test/child)]}]
    (policy/register-strategy! 'test/child (fn [_] (swap! calls inc) :ok))
    (is (nil? (policy/eval-node p {:allowed? false} trace)))
    (is (zero? @calls))
    (is (= [] @trace))))

(deftest filters-narrow-credentials
  (let [ctx {:credentials [{:provider-id "openai" :enabled true}
                           {:provider-id "anthropic" :enabled true}
                           {:provider-id "openai" :enabled false}]}
        narrowed (policy/apply-filters [{:eval/op :all
                                         :eval/target :credentials
                                         :eval/forms ['(= (get it :provider-id) "openai")
                                                      '(get it :enabled)]}]
                                       ctx
                                       (atom []))]
    (is (= [{:provider-id "openai" :enabled true}] (:credentials narrowed)))))

(deftest strategy-exception-becomes-nil
  (policy/clear-strategies!)
  (let [trace (atom [])]
    (policy/register-strategy! 'test/boom (fn [_] (throw (js/Error. "boom"))))
    (is (nil? (policy/run-strategy (strategy :strategy/boom :apply 'test/boom) {} trace)))
    (is (= :fail (:trace/outcome (first @trace))))))

(deftest first-provider-fails-second-succeeds-via-backtracking
  (policy/clear-strategies!)
  (let [trace (atom [])]
    (policy/register-strategy! 'test/fail (constantly nil))
    (policy/register-strategy! 'test/pass (constantly {:ok true}))
    (is (= {:ok true}
           (router/route-request! [(policy-node :router/root :reduce
                                                [(strategy :strategy/first :try 'test/fail)
                                                 (strategy :strategy/second :try 'test/pass)])]
                                  {}
                                  trace)))
    (is (= [:strategy/first :strategy/second] (mapv :trace/node-id @trace)))))

(deftest exhausted-tree-throws
  (policy/clear-strategies!)
  (policy/register-strategy! 'test/fail (constantly nil))
  (try
    (router/route-request! [(strategy :strategy/fail :try 'test/fail)] {} (atom []))
    (is false "expected exhausted tree")
    (catch :default e
      (is (= true (:proxx/exhausted (ex-data e)))))))

(deftest trace-contains-one-entry-per-attempted-strategy
  (policy/clear-strategies!)
  (let [trace (atom [])]
    (policy/register-strategy! 'test/no (constantly nil))
    (policy/register-strategy! 'test/yes (constantly :yes))
    (router/route-request! [(policy-node :router/root :reduce
                                         [(strategy :strategy/no :try 'test/no)
                                          (strategy :strategy/yes :try 'test/yes)])]
                           {}
                           trace)
    (is (= 2 (count @trace)))
    (is (= [:fail :pass] (mapv :trace/outcome @trace)))))

(deftest trace-is-not-read-for-branching
  (policy/clear-strategies!)
  (let [trace (atom [{:trace/node-id :preexisting
                      :trace/op :assert
                      :trace/outcome :fail
                      :trace/elapsed-ms 0}])]
    (policy/register-strategy! 'test/yes (constantly :yes))
    (is (= :yes (router/route-request! [(strategy :strategy/yes :try 'test/yes)] {} trace)))))

(deftest next-skips-strategy-execution
  (policy/clear-strategies!)
  (let [calls (atom 0)]
    (policy/register-strategy! 'test/nope (fn [_] (swap! calls inc) :bad))
    (is (nil? (policy/eval-node {:contract/id :policy/next
                                 :contract/kind :strategy
                                 :policy/outcome :next
                                 :policy/strategy 'test/nope}
                                {}
                                (atom []))))
    (is (zero? @calls))))

(deftest reduce-delegates-into-child-choice-space
  (policy/clear-strategies!)
  (policy/register-strategy! 'test/yes (constantly :child-ok))
  (is (= :child-ok (policy/eval-node (policy-node :router/root :reduce
                                                  [(strategy :strategy/yes :apply 'test/yes)])
                                     {}
                                     (atom [])))))

(deftest loader-validates-model-router-resource
  (let [policies (loader/load-policies! "resources/policies/model-router.edn")]
    (is (= :router/root (-> policies first :contract/id)))))

(deftest loader-loads-runtime-policy-contract-manifest-in-order
  (let [manifest (loader/load-policy-manifest! "resources/policies/runtime/00-manifest.edn")
        contracts (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn")
        ids (mapv :contract/id contracts)]
    (is (= :proxx.policy.runtime/manifest (:contract/id manifest)))
    (is (= :domain/request-kinds (first ids)))
    (is (= :router/anthropic-messages (last ids)))
    (is (some #{:route/gpt-free-blocked} ids))
    (is (some #{:tenant/provider-share-policy} ids))
    (is (every? #(and (:contract/id %) (:contract/kind %)) contracts))))

(deftest compiler-derives-runtime-contract-phases
  (let [loaded (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn")
        compiled (contracts/compile-contracts loaded)
        route-ids (mapv :contract/id (:routing-clauses compiled))
        gpt-paid (first (filter #(= :route/gpt-free-blocked (:contract/id %))
                                (:routing-clauses compiled)))]
    (is (= [:route/glm
            :route/claude-opus-4-6
            :route/claude
            :route/gpt-oss
            :route/gpt-free-blocked
            :route/gpt-6-plus
            :route/gpt
            :route/default]
           route-ids))
    (is (= "^(?:gpt-5\\.3-codex|gpt-5-mini)$"
           (get-in gpt-paid [:match/family-contract :match/model-pattern])))
    (is (= ["openai" "factory" "openrouter" "requesty" "vivgrid"]
           (:prefer/provider-order gpt-paid)))
    (is (= [:plus :pro :business :enterprise :team]
           (:require/plan-set gpt-paid)))
    (is (= 4 (count (:provider-capabilities compiled))))
    (is (= 2 (count (:request-surface-defaults compiled))))
    (is (= 4 (count (:tenant-authorization-clauses compiled))))
    (is (= 50 (:fallback/max-attempts (:fallback-policy compiled))))
    (is (= :router/root (get-in compiled [:root-program :contract/id])))))

(deftest compiler-selects-first-matching-routing-clause
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))]
    (is (= :route/gpt-free-blocked
           (:contract/id (contracts/select-routing-clause compiled "gpt-5-mini"))))
    (is (= :route/gpt-oss
           (:contract/id (contracts/select-routing-clause compiled "gpt-oss-120b"))))
    (is (= :route/claude-opus-4-6
           (:contract/id (contracts/select-routing-clause compiled "claude-opus-4-6-fast"))))
    (is (= :route/gpt
           (:contract/id (contracts/select-routing-clause compiled "gpt-5.2"))))
    (is (= :route/default
           (:contract/id (contracts/select-routing-clause compiled "mistral-large"))))))

(deftest compiler-applies-provider-and-strategy-matching-helpers
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        gpt-route (contracts/select-routing-clause compiled "gpt-5.2")]
    (is (= ["openai" "factory" "requesty" "vivgrid" "anthropic"]
           (contracts/order-provider-candidates
            gpt-route
            ["anthropic" "rotussy" "requesty" "factory" "openai" "vivgrid"])))
    (is (= [:provider-capability/openai-compatible-chat]
           (mapv :contract/id
                 (contracts/strategy-preference-clauses compiled "openrouter" :chat))))
    (is (= [:provider-capability/rotussy-responses-passthrough
            :request-surface/responses-passthrough]
           (mapv :contract/id
                 (contracts/strategy-preference-clauses compiled "rotussy" :responses-passthrough))))))

(deftest compiler-orders-accounts-by-free-preference-and-quota
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        route (contracts/select-routing-clause compiled "gpt-5.2")
        result (contracts/order-account-candidates
                compiled
                route
                [{:account-id "plus" :plan-type :plus}
                 {:account-id "free-limited" :plan-type :free :quota-exhausted? true}
                 {:account-id "free" :plan-type :free}
                 {:account-id "team" :plan-type :team}])]
    (is (= ["free" "plus" "team"]
           (mapv :account-id (:ordered result))))
    (is (= false (:applies-constraint result)))))

(deftest compiler-applies-paid-plan-constraints-and-weight-ordering
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        route (contracts/select-routing-clause compiled "gpt-5-mini")
        result (contracts/order-account-candidates
                compiled
                route
                [{:account-id "free" :plan-type :free}
                 {:account-id "team" :plan-type :team}
                 {:account-id "pro" :plan-type :pro}
                 {:account-id "plus" :plan-type :plus :quota-exhausted? true}])]
    (is (= ["pro" "team"]
           (mapv :account-id (:ordered result))))
    (is (= true (:applies-constraint result)))))

(deftest compiler-keeps-quota-exhausted-accounts-when-all-qualified-are-exhausted
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        route (contracts/select-routing-clause compiled "gpt-5-mini")
        result (contracts/order-account-candidates
                compiled
                route
                [{:account-id "free" :plan-type :free}
                 {:account-id "plus" :plan-type :plus :quota-exhausted? true}
                 {:account-id "team" :plan-type :team :quota-exhausted? true}])]
    (is (= ["plus" "team"]
           (mapv :account-id (:ordered result))))
    (is (= true (:applies-constraint result)))))

(deftest compiler-orders-strategies-from-route-provider-and-request-clauses
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        route (contracts/select-routing-clause compiled "gpt-5.2")]
    (is (= [:openai-responses :chat-completions]
           (mapv :mode
                 (contracts/order-strategy-candidates
                  compiled
                  route
                  "openrouter"
                  :chat
                  [{:mode :messages :priority 100}
                   {:mode :chat-completions :priority 1}
                   {:mode :openai-responses :priority 0}]))))
    (is (= :chat-completions
           (:mode (contracts/select-strategy-candidate
                   compiled
                   route
                   "rotussy"
                   :responses-passthrough
                   [{:mode :responses-passthrough :priority 100}
                    {:mode :openai-responses-passthrough :priority 1}
                    {:mode :chat-completions :priority 0}]))))))

(deftest compiler-falls-back-to-default-strategy-order-and-priority
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))]
    (is (= [:ollama-chat :responses :chat-completions]
           (mapv :mode
                 (contracts/order-strategy-candidates
                  compiled
                  {}
                  "unknown"
                  :chat
                  [{:mode :chat-completions :priority 99}
                   {:mode :responses :priority 1}
                   {:mode :ollama-chat :priority 0}]))))
    (is (= [:custom-b :custom-a]
           (mapv :mode
                 (contracts/order-strategy-candidates
                  compiled
                  {}
                  "unknown"
                  :chat
                  [{:mode :custom-a :priority 1}
                   {:mode :custom-b :priority 5}]))))))

(deftest compiler-keeps-original-strategies-when-all-are-excluded
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        route (contracts/select-routing-clause compiled "gpt-5.2")]
    (is (= [:responses-passthrough]
           (mapv :mode
                 (contracts/order-strategy-candidates
                  compiled
                  route
                  "rotussy"
                  :responses-passthrough
                  [{:mode :responses-passthrough :priority 100}]))))))

(deftest compiler-applies-tenant-model-authorization
  (is (= true (contracts/tenant-model-allowed? {:allowed-models []} "anything")))
  (is (= true (contracts/tenant-model-allowed? {:allowed-models ["ollama/qwen3.5:2b"]}
                                               "qwen3.5:2b")))
  (is (= true (contracts/tenant-model-allowed? {:allowedModels ["qwen3.5:2b"]}
                                               "ollama:qwen3.5:2b")))
  (is (= false (contracts/tenant-model-allowed? {:allowed-models ["ollama/gpt-oss:20b"]}
                                                "ollama/gemma3:27b")))
  ;; No requested model candidate.
  (is (= false (contracts/tenant-model-allowed? {:allowed-models ["gpt-5.2"]}))))

(deftest compiler-applies-tenant-provider-authorization
  (is (= true (contracts/tenant-provider-allowed? {:allowed-provider-ids nil
                                                   :disabled-provider-ids nil}
                                                  "OpenAI")))
  (is (= true (contracts/tenant-provider-allowed? {:allowed-provider-ids ["openai" "factory"]}
                                                  "OPENAI")))
  (is (= false (contracts/tenant-provider-allowed? {:allowed-provider-ids ["factory"]}
                                                   "openai")))
  (is (= false (contracts/tenant-provider-allowed? {:allowedProviderIds ["openai"]
                                                    :disabledProviderIds ["openai"]}
                                                   "openai"))))

(deftest compiler-applies-federated-tenant-provider-share-policy
  (let [policy {:owner-subject "did:plc:owner"
                :provider-kind "peer_proxx"
                :share-mode "warm_import"
                :allowed-models ["gpt-5.2"]}]
    (is (= true (contracts/tenant-provider-policy-allows-use?
                 policy
                 {:owner-subject "did:plc:owner"
                  :provider-kind "peer_proxx"
                  :requested-model "gpt-5.2"
                  :required-share-mode "relay"})))
    (is (= true (contracts/tenant-provider-policy-allows-use?
                 policy
                 {:owner-subject "did:plc:owner"
                  :provider-kind "peer_proxx"
                  :requested-model "gpt-5.2"
                  :required-share-mode "warm_import"})))
    (is (= false (contracts/tenant-provider-policy-allows-use?
                  policy
                  {:owner-subject "did:plc:owner"
                   :provider-kind "peer_proxx"
                   :requested-model "gpt-5.2"
                   :required-share-mode "project_credentials"})))
    (is (= false (contracts/tenant-provider-policy-allows-use?
                  policy
                  {:owner-subject "did:plc:other"
                   :provider-kind "peer_proxx"
                   :requested-model "gpt-5.2"
                   :required-share-mode "relay"})))
    (is (= false (contracts/tenant-provider-policy-allows-use?
                  policy
                  {:owner-subject "did:plc:owner"
                   :provider-kind "peer_proxx"
                   :requested-model "gpt-6"
                   :required-share-mode "relay"})))))

(deftest compiler-previews-policy-decision
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        decision (contracts/preview-policy-decision
                  compiled
                  {:model-id "gpt-5-mini"
                   :request-kind :chat
                   :tenant-settings {:allowed-provider-ids ["factory" "openai"]}
                   :provider-ids ["rotussy" "factory" "openai"]
                   :accounts-by-provider {"openai" [{:account-id "free" :plan-type :free}
                                                     {:account-id "plus" :plan-type :plus}]
                                          "factory" [{:account-id "team" :plan-type :team}
                                                     {:account-id "pro" :plan-type :pro}]}
                   :strategies-by-provider {"openai" [{:mode :chat-completions :priority 1}]
                                            "factory" [{:mode :messages :priority 100}
                                                       {:mode :openai-responses :priority 0}]}})]
    (is (= :ok (:status decision)))
    (is (= :route/gpt-free-blocked (:route-id decision)))
    (is (= ["openai" "factory"] (:providers decision)))
    (is (= "openai" (:provider-id decision)))
    (is (= "plus" (get-in decision [:account :account-id])))
    (is (= true (:applies-account-constraint decision)))
    (is (= :chat-completions (get-in decision [:strategy :mode])))))

(deftest compiler-preview-denies-tenant-model-and-exhausts-providers
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))]
    (is (= {:status :denied
            :reason :tenant-model-not-allowed
            :model-id "gpt-5.2"}
           (contracts/preview-policy-decision
            compiled
            {:model-id "gpt-5.2"
             :tenant-settings {:allowed-models ["gpt-oss:20b"]}})))
    (is (= :exhausted
           (:status (contracts/preview-policy-decision
                     compiled
                     {:model-id "gpt-5.2"
                      :tenant-settings {:allowed-provider-ids ["factory"]}
                      :provider-ids ["openai"]}))))))

(deftest compiler-rejects-duplicate-contract-ids
  (is (thrown-with-msg? js/Error #"Duplicate policy contract id"
                        (contracts/index-contracts [{:contract/id :dupe :contract/kind :x}
                                                    {:contract/id :dupe :contract/kind :y}]))))

(deftest malformed-policy-edn-fails-loader-validation
  (let [fs (js/require "fs")
        os (js/require "os")
        path (js/require "path")
        file (.join path (.tmpdir os) "bad-proxx-policy.edn")]
    (.writeFileSync fs file "[{:contract/id :bad :contract/kind :policy}]" "utf8")
    (is (thrown-with-msg? js/Error #"Invalid policy EDN" (loader/load-policies! file)))))

(deftest some-law-first-success
  (doseq [n (range 1 8)]
    (let [forms (vec (concat (repeat n '(= 1 2)) ['(= 1 1)]))]
      (is (= true (policy/eval-forms :some forms {} (atom [])))))))

(deftest all-law-any-failure-fails
  (doseq [n (range 1 8)]
    (let [forms (vec (concat (repeat n '(= 1 1)) ['(= 1 2)]))]
      (is (nil? (policy/eval-forms :all forms {} (atom [])))))))

(deftest filter-narrowing-monotonicity
  (doseq [n (range 1 8)]
    (let [credentials (mapv (fn [i] {:provider-id (if (even? i) "openai" "anthropic")}) (range n))
          narrowed (policy/apply-filters [{:eval/op :all
                                           :eval/target :credentials
                                           :eval/forms ['(= (get it :provider-id) "openai")]}]
                                         {:credentials credentials}
                                         (atom []))]
      (is (<= (count (:credentials narrowed)) (count credentials))))))
