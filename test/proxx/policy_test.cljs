(ns proxx.policy-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.policy :as policy]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.evidence :as evidence]
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

(deftest sorted-outcome-orders-target-context-before-trying-children
  (policy/clear-strategies!)
  (let [seen (atom [])
        tree [{:contract/id :router/root
               :contract/kind :policy
               :policy/outcome :sorted
               :policy/sort {:eval/op :all
                             :eval/target :credentials
                             :eval/forms ['(get it :rank)
                                          '(get it :account-id)]}
               :policy/children [(strategy :strategy/sorted :try 'test/sorted)]}]]
    (policy/register-strategy!
     'test/sorted
     (fn [ctx]
       (let [account-id (-> ctx :credentials first :account-id)]
         (swap! seen conj account-id)
         (when (= "best" account-id)
           {:account-id account-id}))))
    (is (= {:account-id "best"}
           (router/route-request!
            tree
            {:credentials [{:account-id "last" :rank 9}
                           {:account-id "best" :rank 0}
                           {:account-id "middle" :rank 3}]}
            (atom []))))
    (is (= ["best"] @seen))))

(deftest project-outcome-derives-target-facts-before-children
  (policy/clear-strategies!)
  (let [tree [{:contract/id :router/root
               :contract/kind :policy
               :policy/outcome :project
               :policy/project [{:project/from :credentials
                                 :project/to :provider-ids
                                 :project/form '(get it :provider-id)
                                 :project/distinct? true}]
               :policy/children [(strategy :strategy/projected :try 'test/projected)]}]]
    (policy/register-strategy!
     'test/projected
     (fn [ctx]
       {:provider-ids (:provider-ids ctx)}))
    (is (= {:provider-ids ["xiaomi" "requesty"]}
           (router/route-request!
            tree
            {:credentials [{:provider-id "xiaomi"}
                           {:provider-id "xiaomi"}
                           {:provider-id "requesty"}]}
            (atom []))))))

(deftest eval-forms-support-dynamic-get-in-paths
  (is (= true
         (policy/eval-form '(get-in ctx [:provider-model-snapshots
                                         (get it :provider-id)
                                         (get ctx :model-id)])
                           {:model-id "novel-model"
                            :it {:provider-id "requesty"}
                            :provider-model-snapshots {"requesty" {"novel-model" true}}}
                           (atom [])))))

(deftest models-dev-api-payload-builds-provider-model-index
  (is (= {"openai" {"gpt-5" true}
          "xiaomi" {"mimo-v2-omni" true}}
         (evidence/models-dev-provider-models
          {:openai {:models {"gpt-5" {:input 1}}}
           :xiaomi {:models {"mimo-v2-omni" {:input 0.4}}}}))))

(deftest v1-models-payload-builds-model-id-list
  (is (= ["mimo-v2-omni" "gpt-5"]
         (evidence/model-ids-from-v1-models-payload
          {:data [{:id "mimo-v2-omni"} {:id "gpt-5"}]})))
  (is (= ["local-a" "local-b"]
         (evidence/model-ids-from-v1-models-payload
          {:models [{:name "local-a"} "local-b"]}))))

(deftest contract-apply-resolves-registered-contract-kind-by-tuple
  (policy/clear-contracts!)
  (policy/clear-contract-kinds!)
  (policy/register-contract-kind!
   :model-family
   (fn [contract value]
     (boolean (re-find (re-pattern (:match/model-pattern contract)) (str value)))))
  (policy/register-contract! {:contract/id :model-family/gpt
                              :contract/kind :model-family
                              :match/model-pattern "^gpt-"})
  (is (= true
         (policy/eval-form '(contract/apply [:model-family :gpt] (get ctx :model))
                           {:model "gpt-5.2"}
                           (atom []))))
  (is (nil?
       (policy/eval-form '(contract/apply [:model-family :gpt] (get ctx :model))
                         {:model "claude-opus-4-6"}
                         (atom []))))
  (policy/clear-contracts!)
  (policy/clear-contract-kinds!))

(deftest provider-route-filtering-applies-tenant-and-openai-model-support-in-cljs
  (let [result (contracts/filter-provider-routes
                {}
                {:model-id "mimo-v2-omni"
                 :config {:openaiProviderId "openai"
                          :openaiBaseUrl "https://chatgpt.com/backend-api"
                          :openaiResponsesPath "/codex/responses"
                          :openaiChatCompletionsPath "/codex/responses/compact"}
                 :tenantSettings {:disabledProviderIds ["vivgrid"]}
                 :providerRoutes [{:providerId "openai" :baseUrl "https://api.openai.test"}
                                  {:providerId "vivgrid" :baseUrl "https://vivgrid.test"}
                                  {:providerId "xiaomi" :baseUrl "https://xiaomi.test"}]})]
    (is (= ["xiaomi"]
           (mapv :providerId (:providerRoutes result))))))

(deftest provider-route-filtering-applies-catalog-rules-in-cljs
  (let [base-input {:model-id "target-model"
                    :config {:openaiProviderId "openai"}
                    :tenantSettings {}
                    :providerRoutes [{:providerId "requesty" :baseUrl "https://requesty.test"}
                                     {:providerId "openrouter" :baseUrl "https://openrouter.test"}]}
        filtered (contracts/filter-provider-routes
                  {}
                  (assoc base-input
                         :catalogBundle {:catalog {:declaredModelIds []
                                                   :dynamicOllamaModelIds []}
                                         :preferences {:disabled []}
                                         :providerCatalogs {"requesty" {:modelIds ["other-model"]}
                                                            "openrouter" {:modelIds ["target-model"]}}}))
        rejected (contracts/filter-provider-routes
                  {}
                  (assoc base-input
                         :providerRoutes [{:providerId "requesty" :baseUrl "https://requesty.test"}]
                         :catalogBundle {:catalog {:declaredModelIds []
                                                   :dynamicOllamaModelIds []}
                                         :preferences {:disabled []}
                                         :providerCatalogs {"requesty" {:modelIds ["other-model"]}}}))
        disabled (contracts/filter-provider-routes
                  {}
                  (assoc base-input
                         :catalogBundle {:catalog {:declaredModelIds []
                                                   :dynamicOllamaModelIds []}
                                         :preferences {:disabled ["target-model"]}
                                         :providerCatalogs {}}))
        alias-filtered (contracts/filter-provider-routes
                        {:model-aliases [{:contract/id :model-alias/gemma4-gemini
                                          :contract/kind :model-alias
                                          :match/model-pattern "(?i)^gemma4:31b$"
                                          :match/provider-pattern "^gemini$"
                                          :alias/model-id "gemma-4-31b-it"}]}
                        {:model-id "gemma4:31b"
                         :config {:openaiProviderId "openai"}
                         :tenantSettings {}
                         :providerRoutes [{:providerId "gemini" :baseUrl "https://gemini.test"}
                                          {:providerId "ollama-cloud" :baseUrl "https://ollama.test"}]
                         :catalogBundle {:catalog {:declaredModelIds []
                                                   :dynamicOllamaModelIds []}
                                         :preferences {:disabled []}
                                         :providerCatalogs {"gemini" {:modelIds ["models/gemma-4-31b-it"]}
                                                            "ollama-cloud" {:modelIds ["gemma4:31b"]}}}})]
    (is (= ["openrouter"]
           (mapv :providerId (:providerRoutes filtered))))
    (is (= ["gemini" "ollama-cloud"]
           (mapv :providerId (:providerRoutes alias-filtered))))
    (is (= true (get-in rejected [:catalog :rejected])))
    (is (= true (get-in disabled [:catalog :disabled])))))

(deftest decision-tree-policy-can-call-contract-apply-in-condition
  (policy/clear-strategies!)
  (policy/clear-contracts!)
  (policy/clear-contract-kinds!)
  (policy/register-contract-kind!
   :model-family
   (fn [contract value]
     (boolean (re-find (re-pattern (:match/model-pattern contract)) (str value)))))
  (policy/register-contract! {:contract/id :model-family/gpt
                              :contract/kind :model-family
                              :match/model-pattern "^gpt-"})
  (policy/register-strategy! 'test/gpt (constantly :gpt-route))
  (let [tree [(policy-node :router/root :reduce
                           [{:contract/id :router/gpt
                             :contract/kind :policy
                             :policy/condition {:eval/op :all
                                                :eval/forms ['(contract/apply [:model-family :gpt]
                                                                             (get ctx :model))]}
                             :policy/outcome :reduce
                             :policy/children [(strategy :strategy/gpt :try 'test/gpt)]}])]]
    (is (= :gpt-route (router/route-request! tree {:model "gpt-5.2"} (atom []))))
    (is (thrown-with-msg? js/Error #"Policy tree exhausted"
                          (router/route-request! tree {:model "mimo-v2-omni"} (atom [])))))
  (policy/clear-contracts!)
  (policy/clear-contract-kinds!))

(deftest default-contract-kinds-apply-runtime-policy-contracts
  (policy/clear-contracts!)
  (policy/clear-contract-kinds!)
  (policy/register-default-contract-kinds!)
  (policy/register-contracts!
   (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
  (is (= true
         (policy/eval-form '(contract/apply [:model-family :mimo] (get ctx :model))
                           {:model "mimo-v2-omni"}
                           (atom []))))
  (is (= true
         (policy/eval-form '(contract/apply [:model :gpt-5-mini] (get ctx :payload))
                           {:payload {:model "gpt-5-mini"}}
                           (atom []))))
  (is (= true
         (policy/eval-form '(contract/apply [:provider-capability :openai-compatible-chat] ctx)
                           {:provider-id "xiaomi" :request-kind :chat}
                           (atom []))))
  (is (= true
         (policy/eval-form '(contract/apply [:routing-clause :mimo] ctx)
                           {:model-id "xiaomi/mimo-v2-omni"}
                           (atom []))))
  (is (= true
         (policy/eval-form '(contract/apply [:model-family :mimo-v2-5-pro] (get ctx :model))
                           {:model "mimo-v2.5-pro"}
                           (atom []))))
  (is (= true
         (policy/eval-form '(contract/apply [:routing-clause :mimo-v2-5-pro] ctx)
                           {:model-id "xiaomi/mimo-v2.5-pro"}
                           (atom []))))
  (is (nil?
       (policy/eval-form '(contract/apply [:routing-clause :mimo] ctx)
                         {:model-id "gpt-5.2"}
                         (atom []))))
  (is (= true
         (policy/eval-form '(contract/apply [:authorization-clause :model-allow-list] ctx)
                           {:model-id "ollama/qwen3.5:2b"
                            :tenant-settings {:allowed-models ["qwen3.5:2b"]}}
                           (atom []))))
  (is (nil?
       (policy/eval-form '(contract/apply [:authorization-clause :provider-allow-list] ctx)
                         {:provider-id "openai"
                          :tenant-settings {:allowed-provider-ids ["xiaomi"]}}
                         (atom []))))
  (is (= true
         (policy/eval-form '(contract/apply [:account-constraint :free-blocked-models] ctx)
                           {:model-id "gpt-5-mini"
                            :plan-type :plus}
                           (atom []))))
  (is (nil?
       (policy/eval-form '(contract/apply [:account-constraint :free-blocked-models] ctx)
                         {:model-id "gpt-5-mini"
                          :plan-type :free}
                         (atom []))))
  (policy/clear-contracts!)
  (policy/clear-contract-kinds!))

(deftest loader-validates-model-router-resource
  (let [policies (loader/load-policies! "resources/policies/model-router.edn")]
    (is (= :router/root (-> policies first :contract/id)))))

(deftest model-router-contract-routes-openai-chat-end-to-end
  (policy/clear-strategies!)
  (let [policies (loader/load-policies! "resources/policies/model-router.edn")
        trace (atom [])
        strategy-ctx (atom nil)]
    (policy/register-strategy!
     'proxx.strategies.openai/chat-completions-passthrough
     (fn [ctx]
       (reset! strategy-ctx ctx)
       {:provider-id (-> ctx :credentials first :provider-id)
        :model (get ctx :model)}))
    (policy/register-strategy!
     'proxx.strategies.anthropic/messages-passthrough
     (constantly {:provider-id "anthropic"}))
    (is (= {:provider-id "openai" :model "gpt-5.2"}
           (router/route-request!
            policies
            {:endpoint-type :openai-chat
             :model "gpt-5.2"
             :credentials [{:provider-id "anthropic"
                            :disabled? false
                            :rate-limited? false}
                           {:provider-id "openai"
                            :account-id "blocked"
                            :disabled? true
                            :rate-limited? false}
                           {:provider-id "openai"
                            :account-id "ready"
                            :disabled? false
                            :rate-limited? false}]}
            trace)))
    (is (= [{:provider-id "openai"
             :account-id "ready"
             :disabled? false
             :rate-limited? false}]
           (:credentials @strategy-ctx)))
    (is (= [:strategy/openai-chat-completions]
           (mapv :trace/node-id @trace)))))

(deftest model-router-contract-routes-anthropic-messages-end-to-end
  (policy/clear-strategies!)
  (let [policies (loader/load-policies! "resources/policies/model-router.edn")
        trace (atom [])]
    (policy/register-strategy!
     'proxx.strategies.openai/chat-completions-passthrough
     (constantly {:provider-id "openai"}))
    (policy/register-strategy!
     'proxx.strategies.anthropic/messages-passthrough
     (fn [ctx]
       {:provider-id (-> ctx :credentials first :provider-id)}))
    (is (= {:provider-id "anthropic"}
           (router/route-request!
            policies
            {:endpoint-type :anthropic-messages
             :credentials [{:provider-id "openai"
                            :disabled? false
                            :rate-limited? false}
                           {:provider-id "anthropic"
                            :disabled? false
                            :rate-limited? false}]}
            trace)))
    (is (= [:strategy/anthropic-messages]
           (mapv :trace/node-id @trace)))))

(deftest contract-router-edn-uses-runtime-contracts-as-decision-tree-rules
  (policy/clear-strategies!)
  (policy/clear-contracts!)
  (policy/clear-contract-kinds!)
  (policy/register-default-contract-kinds!)
  (policy/register-contracts!
   (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
  (let [policies (loader/load-policies! "resources/policies/contract-router.edn")
        trace (atom [])
        strategy-ctx (atom nil)]
    (policy/register-strategy!
     'proxx.strategies.openai/chat-completions-passthrough
     (fn [ctx]
       (reset! strategy-ctx ctx)
       {:provider-id (-> ctx :credentials first :provider-id)
        :provider-ids (:provider-ids ctx)
        :model-id (:model-id ctx)}))
    (is (= {:provider-id "xiaomi"
            :provider-ids ["xiaomi"]
            :model-id "mimo-v2-omni"}
           (router/route-request!
            policies
            {:request-kind :chat
             :model-id "mimo-v2-omni"
             :tenant-settings {:allowed-models ["mimo-v2-omni"]
                               :allowed-provider-ids ["xiaomi" "requesty"]
                               :disabled-provider-ids ["requesty"]}
             :credentials [{:provider-id "openai"
                            :disabled? false
                            :rate-limited? false}
                           {:provider-id "xiaomi"
                            :account-id "later"
                            :rank 9
                            :plan-type :free
                            :disabled? false
                            :rate-limited? false}
                           {:provider-id "xiaomi"
                            :account-id "ready"
                            :rank 0
                            :plan-type :free
                            :disabled? false
                            :rate-limited? false}
                           {:provider-id "requesty"
                            :rank 1
                            :disabled? false
                            :rate-limited? false}]}
            trace)))
    (is (= [{:provider-id "xiaomi"
             :account-id "ready"
             :rank 0
             :plan-type :free
             :disabled? false
             :rate-limited? false}]
           (:credentials @strategy-ctx)))
    (is (= [:strategy/mimo-chat-completions]
           (mapv :trace/node-id @trace))))
  (policy/clear-strategies!)
  (policy/clear-contracts!)
  (policy/clear-contract-kinds!))

(deftest contract-router-default-policy-requires-provider-model-evidence
  (policy/clear-strategies!)
  (policy/clear-contracts!)
  (policy/clear-contract-kinds!)
  (policy/register-default-contract-kinds!)
  (policy/register-contracts!
   (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
  (let [policies (loader/load-policies! "resources/policies/contract-router.edn")]
    (policy/register-strategy!
     'proxx.strategies.openai/chat-completions-passthrough
     (fn [ctx]
       {:provider-id (-> ctx :credentials first :provider-id)
        :provider-ids (:provider-ids ctx)}))
    (is (= {:provider-id "requesty" :provider-ids ["requesty"]}
           (router/route-request!
            policies
            {:request-kind :chat
             :model-id "novel-model"
             :tenant-settings {:allowed-provider-ids ["requesty"]}
             :models-dev/provider-models {"factory" {"novel-model" true}}
             :provider-model-snapshots {"requesty" {"novel-model" true}}
             :credentials [{:provider-id "openai"
                            :rank 0
                            :disabled? false
                            :rate-limited? false}
                           {:provider-id "requesty"
                            :rank 1
                            :disabled? false
                            :rate-limited? false}]}
            (atom []))))
    (is (thrown-with-msg? js/Error #"Policy tree exhausted"
                          (router/route-request!
                           policies
                           {:request-kind :chat
                            :model-id "unknown-model"
                            :credentials [{:provider-id "openai"
                                           :disabled? false
                                           :rate-limited? false}]}
                           (atom [])))))
  (policy/clear-strategies!)
  (policy/clear-contracts!)
  (policy/clear-contract-kinds!))

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
    (is (= [:route/gemma4-e4b
            :route/gemma4
            :route/gemma-e
            :route/gemma
            :route/glm
            :route/claude-opus-4-6
            :route/claude
            :route/gpt-oss
            :route/gpt-free-blocked
            :route/gpt-6-plus
            :route/gpt
            :route/mimo-v2-5-pro
            :route/mimo
            :route/mistral
            :route/qwen3-embedding
            :route/kimi
            :route/blaze-text
            :route/blaze-images
            :route/blaze-video
            :route/minimax-music
            :route/musicgen
            :route/gemini
            :route/blaze-tts
            :route/ollama-llama
            :route/ollama-qwen
            :route/ollama-phi
            :route/ollama-mistral
            :route/ollama-codellama
            :route/ollama-deepseek
            :route/ollama-default
            :route/default]
           route-ids))
    (is (= "^(?:gpt-5\\.3-codex|gpt-5-mini)$"
           (get-in gpt-paid [:match/family-contract :match/model-pattern])))
    (is (= ["vivgrid" "openai" "requesty" "openrouter" "factory" "blaze"]
           (:prefer/provider-order gpt-paid)))
    (is (= [:plus :pro :business :enterprise :team]
           (:require/plan-set gpt-paid)))
    (is (= 18 (count (:provider-capabilities compiled))))
    (is (= 24 (count (:provider-routes compiled))))
    (is (= 7 (count (:request-surface-defaults compiled))))
    (is (= 4 (count (:tenant-authorization-clauses compiled))))
    (is (= :router/root (get-in compiled [:root-program :contract/id])))))

(deftest compiler-selects-first-matching-routing-clause
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))]
    (is (= :route/gpt-free-blocked
           (:contract/id (contracts/select-routing-clause compiled "gpt-5-mini"))))
    (is (= :route/gemma4-e4b
           (:contract/id (contracts/select-routing-clause compiled "gemma4:e4b"))))
    (is (= :route/gpt-oss
           (:contract/id (contracts/select-routing-clause compiled "gpt-oss-120b"))))
    (is (= :route/claude-opus-4-6
           (:contract/id (contracts/select-routing-clause compiled "claude-opus-4-6-fast"))))
    (is (= :route/gpt
           (:contract/id (contracts/select-routing-clause compiled "gpt-5.2"))))
    (is (= :route/mimo-v2-5-pro
           (:contract/id (contracts/select-routing-clause compiled "mimo-v2.5-pro"))))
    (is (= :route/mimo-v2-5-pro
           (:contract/id (contracts/select-routing-clause compiled "xiaomi/mimo-v2.5-pro"))))
    (is (= :route/mimo
           (:contract/id (contracts/select-routing-clause compiled "mimo-v2-omni"))))
    (is (= :route/qwen3-embedding
           (:contract/id (contracts/select-routing-clause compiled "qwen3-embedding:0.6b"))))
    (is (= :route/kimi
           (:contract/id (contracts/select-routing-clause compiled "kimi-k2.6"))))
    (is (= :route/mistral
           (:contract/id (contracts/select-routing-clause compiled "mistral-large"))))
    (is (= :route/default
           (:contract/id (contracts/select-routing-clause compiled "some-unknown-model"))))))

(deftest compiler-applies-provider-and-strategy-matching-helpers
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        gpt-route (contracts/select-routing-clause compiled "gpt-5.2")]
    (is (= ["vivgrid" "openai" "requesty" "factory"]
           (contracts/order-provider-candidates
            gpt-route
            ["anthropic" "rotussy" "requesty" "factory" "openai" "vivgrid"])))
    (is (= [:provider-capability/openai-compatible-chat]
           (mapv :contract/id
                 (contracts/strategy-preference-clauses compiled "openrouter" :chat))))
    (is (= [:provider-capability/blaze-music
            :request-surface/music]
           (mapv :contract/id
                 (contracts/strategy-preference-clauses compiled "blaze" :music))))
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

(deftest compiler-normalizes-reasoning-by-model-family-contract
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))]
    (is (= "xhigh"
           (get-in (contracts/normalize-reasoning-request
                    compiled
                    {:model-id "gpt-5.2"
                     :request-body {:model "gpt-5.2"
                                    :reasoning {:effort "max"}}})
                   [:request-body :reasoning :effort])))
    (is (= "max"
           (get-in (contracts/normalize-reasoning-request
                    compiled
                    {:model-id "glm-5"
                     :request-body {:model "glm-5"
                                    :reasoning {:effort "xhigh"}}})
                   [:request-body :reasoning :effort])))
    (is (= {:type "enabled" :budget_tokens 24576}
           (get-in (contracts/normalize-reasoning-request
                    compiled
                    {:model-id "claude-opus-4-6"
                     :request-body {:model "claude-opus-4-6"
                                    :reasoning_effort "high"}})
                   [:request-body :thinking])))))

(deftest compiler-orders-strategies-from-route-provider-and-request-clauses
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        route (contracts/select-routing-clause compiled "gpt-5.2")]
    (is (= [:chat-completions]
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
    (is (= [{:provider-id "openai"
             :base-url "https://chatgpt.com/backend-api"
             :paths {:chat-completions "/codex/responses/compact"
                     :responses "/codex/responses"
                     :images-generations "/images/generations"}}
            {:provider-id "factory"
             :base-url "https://api.factory.ai"
             :paths {:chat-completions "/v1/chat/completions"
                     :responses "/v1/responses"
                     :images-generations "/v1/images/generations"}}]
           (:provider-routes decision)))
    (is (= "openai" (:provider-id decision)))
    (is (= "plus" (get-in decision [:account :account-id])))
    (is (= true (:applies-account-constraint decision)))
    (is (= :chat-completions (get-in decision [:strategy :mode])))))

(deftest compiler-previews-mimo-v2-5-pro-official-xiaomi-policy-decision
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        decision (contracts/preview-policy-decision
                  compiled
                  {:model-id "mimo-v2.5-pro"
                   :request-kind :chat
                   :tenant-settings {:allowed-provider-ids ["xiaomi" "requesty" "factory"]}
                   :provider-ids ["requesty" "factory" "xiaomi"]
                   :accounts-by-provider {"xiaomi" [{:account-id "xiaomi-ready" :plan-type :free}]
                                          "requesty" [{:account-id "requesty-ready" :plan-type :free}]
                                          "factory" [{:account-id "factory-ready" :plan-type :team}]}
                   :strategies-by-provider {"xiaomi" [{:mode :chat-completions :priority 0}]
                                            "requesty" [{:mode :chat-completions :priority 0}]
                                            "factory" [{:mode :chat-completions :priority 0}]}})]
    (is (= :ok (:status decision)))
    (is (= :route/mimo-v2-5-pro (:route-id decision)))
    (is (= ["xiaomi"] (:providers decision)))
    (is (= [{:provider-id "xiaomi"
             :base-url "https://api.xiaomimimo.com/v1"}]
           (:provider-routes decision)))
    (is (= "xiaomi" (:provider-id decision)))
    (is (= "xiaomi-ready" (get-in decision [:account :account-id])))
    (is (= :chat-completions (get-in decision [:strategy :mode])))))

(deftest compiler-preview-derives-provider-candidates-from-route-policy
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        decision (contracts/preview-policy-decision
                  compiled
                  {:model-id "mimo-v2.5-pro"
                   :request-kind :chat
                   :tenant-settings {:allowed-provider-ids ["xiaomi" "requesty"]}
                   :accounts-by-provider {"xiaomi" [{:account-id "xiaomi-ready" :plan-type :free}]}
                   :strategies-by-provider {"xiaomi" [{:mode :chat-completions :priority 0}]}})]
    (is (= :ok (:status decision)))
    (is (= :route/mimo-v2-5-pro (:route-id decision)))
    (is (= ["xiaomi"] (:providers decision)))
    (is (= [{:provider-id "xiaomi"
             :base-url "https://api.xiaomimimo.com/v1"}]
           (:provider-routes decision)))
    (is (= "xiaomi" (:provider-id decision)))
    (is (= "xiaomi-ready" (get-in decision [:account :account-id])))))

(deftest compiler-preview-default-route-does-not-invent-provider-candidates
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        decision (contracts/preview-policy-decision
                  compiled
                  {:model-id "unknown-model"
                   :request-kind :chat})]
    (is (= :exhausted (:status decision)))
    (is (= :no-provider-candidates (:reason decision)))
    (is (= :route/default (:route-id decision)))
    (is (= [] (:providers decision)))))

(deftest compiler-previews-embedding-policy-decision
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        decision (contracts/preview-policy-decision
                  compiled
                  {:model-id "qwen3-embedding:0.6b"
                   :request-kind :embeddings
                   :tenant-settings {:allowed-provider-ids ["llamacpp-embed" "ollama" "ollama-lan"]}
                   :provider-ids ["ollama" "llamacpp-embed" "ollama-lan"]
                   :provider-model-snapshots {"llamacpp-embed" {"qwen3-embedding:0.6b" true
                                                                 "qwen3-embedding-0.6b" true}}
                   :strategies-by-provider {"llamacpp-embed" [{:mode :embeddings :priority 0}]
                                            "ollama" [{:mode :embeddings :priority 1}]}})]
    (is (= :ok (:status decision)))
    (is (= :route/qwen3-embedding (:route-id decision)))
    (is (= ["llamacpp-embed" "ollama" "ollama-lan"] (:providers decision)))
    (is (= [{:provider-id "llamacpp-embed"
             :base-url "http://llamacpp-embed:8081"
             :auth-required? false
             :paths {:embeddings "/v1/embeddings"}}
            {:provider-id "ollama"
             :base-url "http://ollama:11434"
             :auth-required? false
             :paths {:embeddings "/api/embed"
                     :chat-completions "/v1/chat/completions"}}
            {:provider-id "ollama-lan"
             :base-url "http://192.168.12.68:11434"
             :auth-required? false
             :paths {:embeddings "/api/embed"
                     :chat-completions "/v1/chat/completions"}}]
           (:provider-routes decision)))
    (is (= "llamacpp-embed" (:provider-id decision)))
    (is (= :embeddings (get-in decision [:strategy :mode])))))

(deftest compiler-previews-blaze-media-policy-decision
  (let [compiled (contracts/compile-contracts
                  (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn"))
        music-decision (contracts/preview-policy-decision
                        compiled
                        {:model-id "MiniMax-music-2.6-highspeed"
                         :request-kind :music
                         :tenant-settings {:allowed-provider-ids ["minimax"]}
                         :accounts-by-provider {"minimax" [{:account-id "minimax-key" :plan-type :free}]}
                         :strategies-by-provider {"minimax" [{:mode :music :priority 0}
                                                              {:mode :chat-completions :priority 1}]}})
        video-decision (contracts/preview-policy-decision
                        compiled
                        {:model-id "qwen3.6-plus-video"
                         :request-kind :video
                         :tenant-settings {:allowed-provider-ids ["blaze"]}
                         :accounts-by-provider {"blaze" [{:account-id "blaze-free" :plan-type :free}]}
                         :strategies-by-provider {"blaze" [{:mode :video :priority 0}
                                                            {:mode :chat-completions :priority 1}]}})]
    (is (= :ok (:status music-decision)))
    (is (= :route/minimax-music (:route-id music-decision)))
    (is (= "minimax" (:provider-id music-decision)))
    (is (= :music (get-in music-decision [:strategy :mode])))
    (is (= [{:provider-id "minimax"
             :base-url "https://api.minimax.io"}]
           (:provider-routes music-decision)))
    (is (= :ok (:status video-decision)))
    (is (= "blaze" (:provider-id video-decision)))
    (is (= :video (get-in video-decision [:strategy :mode])))))

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
                      :tenant-settings {:allowed-provider-ids ["no-such-provider"]}
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
