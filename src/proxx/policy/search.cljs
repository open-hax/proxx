(ns proxx.policy.search
  "Prolog-inspired depth-first policy tree search with backtracking.

   The policy engine compiles declarative EDN contracts into a search tree:

     routing-clause
       └── provider
             └── strategy
                   └── account (terminal)

   Execution is lazy depth-first search. When a terminal account fails,
   the search backtracks to the nearest sibling with unexplored children.
   This replaces the flat candidate-list approach with a structured decision
   tree that respects provider-strategy-account hierarchy."
  (:require [clojure.string :as str]
            [proxx.policy.contracts :as contracts]))

;; ─────────────────────────────────────────────────────────────────────────────
;; Search tree nodes

(defrecord TreeNode [branch-type rule children-fn context])

(defn- terminal-node
  "Create a leaf node carrying the full projected context."
  [context]
  (->TreeNode :terminal nil nil context))

(defn- branch-node
  "Create an internal node with a lazy children factory."
  [branch-type rule children-fn context]
  (->TreeNode branch-type rule children-fn context))

;; ─────────────────────────────────────────────────────────────────────────────
;; Tree compilation from compiled policy contracts

(defn- provider-route-for-id
  "Find the provider route map for a given provider id."
  [compiled provider-id]
  (some #(when (= provider-id (or (:provider/id %) (:provider-id %))) %)
        (:provider-routes compiled)))

(defn- strategies-for-provider-input
  "Return ordered strategy modes for a provider + request kind from input."
  [compiled route provider-id request-kind input]
  (let [strategies (contracts/strategies-for-provider input provider-id)
        ordered (contracts/order-strategy-candidates compiled route provider-id request-kind strategies)]
    (mapv contracts/strategy-mode ordered)))

(defn- accounts-for-provider
  "Return ordered accounts for a provider from the input context."
  [input provider-id]
  (let [provider-key (if (keyword? provider-id) provider-id (keyword provider-id))
        accounts (vec (or (get-in input [:accounts-by-provider provider-key])
                          (get-in input [:accountsByProvider provider-key])
                          (get-in input [:accounts-by-provider provider-id])
                          (get-in input [:accountsByProvider provider-id])
                          []))]
    accounts))

(defn- build-account-children
  "Build terminal account nodes for a provider+strategy path."
  [compiled route provider-id strategy-mode input base-url paths]
  (let [raw-accounts (accounts-for-provider input provider-id)
        account-result (contracts/order-account-candidates compiled route raw-accounts)
        ordered-accounts (:ordered account-result)]
    (mapv (fn [account]
            (terminal-node
             {:provider-id provider-id
              :base-url base-url
              :paths paths
              :account account
              :strategy-mode (name strategy-mode)
              :routing-clause-id (:contract/id route)
              :projected-facts {:routing-clause route
                                :provider-id provider-id
                                :strategy-mode strategy-mode
                                :account account
                                :applies-account-constraint (:applies-constraint account-result)}}))
          ordered-accounts)))

(defn- build-strategy-children
  "Build strategy branch nodes for a provider."
  [compiled route provider-id input base-url paths]
  (let [request-kind (contracts/normalized-keyword
                      (or (get input :request-kind)
                          (get input :requestKind)
                          :chat))
        strategy-modes (strategies-for-provider-input compiled route provider-id request-kind input)]
    (mapv (fn [mode]
            (branch-node
             :strategy
             {:strategy-mode mode}
             (fn [] (build-account-children compiled route provider-id mode input base-url paths))
             {:provider-id provider-id
              :strategy-mode mode}))
          strategy-modes)))

(defn- build-provider-children
  "Build provider branch nodes for a routing clause."
  [compiled route input]
  (let [provider-ids (contracts/request-or-route-provider-ids route input)
        surface-providers (filterv #(contracts/request-surface-provider-allowed? compiled % (:request-kind input))
                                   provider-ids)
        evidenced-providers (contracts/evidence-filtered-provider-ids route input surface-providers
                                                                      (or (get input :model-id)
                                                                          (get input :modelId)
                                                                          ""))
        tenant-settings (or (get input :tenant-settings)
                            (get input :tenantSettings)
                            {})
        tenant-allowed (filterv #(contracts/tenant-provider-allowed? tenant-settings %) evidenced-providers)
        ordered-providers (vec (contracts/order-provider-candidates route tenant-allowed))]
    (mapv (fn [provider-id]
            (let [route-info (provider-route-for-id compiled provider-id)
                  base-url (or (:provider/base-url route-info)
                               (:provider/baseUrl route-info)
                               "")
                  paths (:provider/paths route-info)]
              (branch-node
               :provider
               {:provider-id provider-id}
               (fn [] (build-strategy-children compiled route provider-id input base-url paths))
               {:provider-id provider-id
                :base-url base-url})))
          ordered-providers)))

(defn- build-routing-clause-children
  "Build routing clause branch nodes from compiled contracts."
  [compiled input]
  (let [model-id (or (get input :model-id)
                     (get input :modelId)
                     "")
        clauses (:routing-clauses compiled)
        matching (filterv #(contracts/routing-clause-matches-model? % model-id) clauses)]
    (mapv (fn [clause]
            (branch-node
             :routing-clause
             {:clause-id (:contract/id clause)}
             (fn [] (build-provider-children compiled clause input))
             {:routing-clause clause}))
          matching)))

(defn compile-policy-tree
  "Compile compiled policy contracts into a lazy search tree.

   Input is a map with:
     :model-id / :modelId        — requested model
     :request-kind / :requestKind — :chat, :embeddings, etc.
     :tenant-settings            — tenant authorization map
     :accounts-by-provider       — map of provider-id -> account array

   Returns a TreeNode (the root)."
  [compiled input]
  (branch-node
   :root
   {:model-id (or (get input :model-id) (get input :modelId) "")}
   (fn [] (build-routing-clause-children compiled input))
   {}))

;; ─────────────────────────────────────────────────────────────────────────────
;; Depth-first search with backtracking

(defn- node-children
  "Materialize children for a branch node. Caches on first access."
  [node]
  (when-let [factory (:children-fn node)]
    (factory)))

(defn dfs-execute
  "Execute depth-first search over a policy tree.

   try-candidate is a function of (terminal-context) that returns either:
     {:status :success :result <anything>}  — search terminates, returns this
     {:status :failure :reason <keyword>}   — backtrack and try next sibling

   Returns:
     {:status :success :result <anything>}  — a terminal succeeded
     {:status :exhausted :trace <vector>}   — all terminals failed"
  [tree try-candidate]
  (loop [stack [{:node tree :child-index 0}]
         trace []]
    (if (empty? stack)
      {:status :exhausted :trace trace}
      (let [frame (peek stack)
            node (:node frame)
            idx (:child-index frame)]
        (if (= :terminal (:branch-type node))
          (let [ctx (:context node)
                result (try-candidate ctx)]
            (if (= :success (:status result))
              (assoc result :trace (conj trace {:branch-type :terminal
                                                :context ctx
                                                :outcome :success}))
              (recur (pop stack)
                     (conj trace {:branch-type :terminal
                                  :context ctx
                                  :outcome (:status result)
                                  :reason (:reason result)}))))
          (let [children (node-children node)]
            (if (and (seq children) (< idx (count children)))
              (recur (conj (pop stack)
                          (assoc frame :child-index (inc idx))
                          {:node (nth children idx) :child-index 0})
                     (conj trace {:branch-type (:branch-type node)
                                  :rule (:rule node)
                                  :child-index idx
                                  :total-children (count children)}))
              (recur (pop stack)
                     (conj trace {:branch-type (:branch-type node)
                                  :rule (:rule node)
                                  :outcome :exhausted})))))))))

;; ─────────────────────────────────────────────────────────────────────────────
;; Convenience: execute with async JS callback

(defn execute-policy-tree
  "Execute policy tree with a JS async callback.

   try-candidate-js is a JS function of (context-js) returning a JS Promise.
   The promise should resolve to {:status 'success'/'failure' ...}.

   Returns a CLJS promise resolving to the search result."
  [tree try-candidate-js]
  (letfn [(advance [stack trace]
            ;; Pop exhausted frames until we find one with unexplored children
            (loop [s stack
                   t trace]
              (if (empty? s)
                {:status :exhausted :trace t}
                (let [frame (peek s)
                      node (:node frame)
                      idx (:child-index frame)
                      children (node-children node)]
                  (if (and (seq children) (< idx (count children)))
                    ;; Found a frame with unexplored children
                    (let [child (nth children idx)
                          new-stack (conj (pop s)
                                          (assoc frame :child-index (inc idx))
                                          {:node child :child-index 0})]
                      (explore new-stack (conj t {:branch-type (:branch-type node)
                                                  :rule (:rule node)
                                                  :child-index idx
                                                  :total-children (count children)})))
                    ;; This frame exhausted, keep popping
                    (recur (pop s) (conj t {:branch-type (:branch-type node)
                                            :rule (:rule node)
                                            :outcome :exhausted})))))))
          (explore [stack trace]
            (if (empty? stack)
              {:status :exhausted :trace trace}
              (let [frame (peek stack)
                    node (:node frame)]
                (if (= :terminal (:branch-type node))
                  ;; Try the terminal candidate asynchronously
                  (-> (js/Promise.resolve (try-candidate-js (clj->js (:context node))))
                      (.then (fn [js-result]
                               (let [result (js->clj js-result :keywordize-keys true)]
                                 (if (= "success" (get result :status))
                                    {:status :success
                                     :result (merge (:context node) result)
                                     :trace (conj trace {:branch-type :terminal
                                                         :context (:context node)
                                                         :outcome :success})}
                                   (advance (pop stack)
                                            (conj trace {:branch-type :terminal
                                                        :context (:context node)
                                                        :outcome :failure
                                                        :reason (get result :reason)}))))))
                      (.catch (fn [err]
                                (advance (pop stack)
                                         (conj trace {:branch-type :terminal
                                                     :context (:context node)
                                                     :outcome :exception
                                                     :error (.-message err)})))))
                  ;; Branch node — advance to next child
                  (advance stack trace)))))]
    (js/Promise.resolve (explore [{:node tree :child-index 0}] []))))
