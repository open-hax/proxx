(ns proxx.strategy.routing
  "Pure rules for choosing and judging credentials during provider routing.

  Constants and per-provider exceptions are facts in the `:upstream-attempt-policy`
  contract (77-upstream-attempt-policy.edn); this namespace interprets them. The
  ordering functions return *index permutations* of what the caller passed in, so
  the caller keeps its own objects (credentials, candidates) and their identity;
  nothing here copies or inspects anything the caller did not hand over as a fact."
  (:require [clojure.string :as str]))

(defn policy-from-contracts
  "The `:upstream-attempt-policy` contract in a loaded contract vector."
  [contracts]
  (or (some #(when (= :upstream-attempt-policy (:contract/kind %)) %) contracts)
      (throw (ex-info "Missing upstream attempt policy" {:error/type :policy/missing-upstream-attempt-policy}))))

;; ---------------------------------------------------------------------------
;; Status judgements
;; ---------------------------------------------------------------------------

(defn- listed?
  "Is `status` selected by `{:statuses #{..} :by-provider/:except-by-provider {..}}`?"
  [statuses except provider-id status]
  (and (contains? statuses status)
       (not (contains? (get except provider-id #{}) status))))

(defn retry-same-credential-for-server-error?
  "Should a 5xx be retried on the same credential (502/503/504 by default)?"
  [policy status]
  (contains? (get-in policy [:attempt/retry-same-credential :statuses]) status))

(defn transient-provider-retry?
  "Statuses a provider is known to return transiently (Factory's 403 during token
  rotation), retried on the same credential like a server error."
  [policy provider-id status]
  (contains? (get-in policy [:attempt/retry-same-credential :by-provider provider-id] #{}) status))

(defn cooldown-on-auth-failure? [policy provider-id status]
  (let [{:keys [statuses except-by-provider]} (:attempt/auth-cooldown policy)]
    (listed? statuses except-by-provider provider-id status)))

(defn permanently-disable?
  "A static API key answered 402/403: the key is disabled and will not recover."
  [policy auth-type provider-id status]
  (let [{:keys [auth-types statuses except-by-provider]} (:attempt/permanent-disable policy)]
    (and (contains? auth-types auth-type)
         (listed? statuses except-by-provider provider-id status))))

(defn permanent-disable-cooldown-ms [policy]
  (get-in policy [:attempt/permanent-disable :cooldown-ms]))

(defn cooldown-cap-ms [policy kind]
  (get-in policy [:attempt/cooldown-caps kind]))

(defn classify-auth-error
  "`{:classification kw :cooldown-ms n}` for a 401/402/403 on a credential."
  [policy auth-type provider-id status configured-cooldown-ms]
  (cond
    (permanently-disable? policy auth-type provider-id status)
    {:classification :auth-permanent-disable :cooldown-ms (permanent-disable-cooldown-ms policy)}

    (cooldown-on-auth-failure? policy provider-id status)
    {:classification :auth-cooldown
     :cooldown-ms (min configured-cooldown-ms (get-in policy [:attempt/auth-cooldown :cap-ms]))}

    :else {:classification :transient}))

(defn classify-model-not-supported [policy configured-cooldown-ms]
  {:classification :model-not-supported
   :cooldown-ms (min configured-cooldown-ms (cooldown-cap-ms policy :model-unsupported-ms))})

(defn clamp-route-quality
  "Route quality in [floor, 1]: 1 at the fastest bound, falling linearly to the
  floor at the slowest."
  [policy latency-ms]
  (let [{:keys [min-latency-ms max-latency-ms floor]} (:attempt/route-quality policy)
        clamped (min (max latency-ms min-latency-ms) max-latency-ms)]
    (max floor (- 1 (/ (- clamped min-latency-ms) (- max-latency-ms min-latency-ms))))))

;; ---------------------------------------------------------------------------
;; Ordering (index permutations)
;; ---------------------------------------------------------------------------

(defn plan-cost-tier [policy plan-type]
  (get (:attempt/plan-cost-tier policy)
       (str/lower-case (str/trim (if (string? plan-type) plan-type "")))
       1))

(defn account-order-for-request
  "Indices of `plan-types` (one per account, nil when unknown) in the order to try
  them for this provider and model: free-plan accounts first where the policy says
  so and at least one exists, otherwise unchanged."
  [policy provider-id routed-model plan-types]
  (let [indices (vec (range (count plan-types)))
        free-first? (some (fn [{p :provider-id prefix :model-prefix}]
                            (and (= p provider-id) (str/starts-with? routed-model prefix)))
                          (:attempt/free-plan-first policy))
        free? #(= "free" (nth plan-types %))
        free (filterv free? indices)]
    (if (and free-first? (seq free))
      (into free (remove free?) indices)
      indices)))

(defn- native-sort
  "Stable sort through the platform's own algorithm. The latency comparators are
  not transitive across the grace window, so for identical results the algorithm
  itself must match what the comparator was written against."
  [cmp xs]
  #?(:cljs (vec (.sort (to-array xs) cmp))
     :clj (vec (sort cmp xs))))

(defn- latency-comparator [policy facts]
  (let [grace (get-in policy [:attempt/latency-ordering :ttft-grace-ms])]
    (fn [a b]
      (let [{ttft-a :ttft tps-a :tps plan-a :plan-type} (nth facts a)
            {ttft-b :ttft tps-b :tps plan-b :plan-type} (nth facts b)
            ttft-a (or ttft-a ##Inf) ttft-b (or ttft-b ##Inf)
            tps-a (or tps-a ##-Inf) tps-b (or tps-b ##-Inf)
            cost-a (plan-cost-tier policy plan-a) cost-b (plan-cost-tier policy plan-b)]
        (cond
          (> (Math/abs (- ttft-a ttft-b)) grace) (- ttft-a ttft-b)
          (not= cost-a cost-b) (- cost-a cost-b)
          (not= tps-a tps-b) (- tps-b tps-a)
          :else 0)))))

(defn account-order-for-latency
  "Indices of `facts` (`{:plan-type :ttft :tps}` per account) with the first
  window reordered: clearly faster TTFT first, then cheaper plan, then higher
  throughput; ties (and everything past the window) keep their order."
  [policy facts]
  (let [window (get-in policy [:attempt/latency-ordering :window-size])
        n (count facts)
        head (vec (range (min window n)))]
    (into (native-sort (latency-comparator policy facts) head)
          (range (count head) n))))

(defn candidate-order-for-affinities
  "Indices of `candidates` (`[provider-id account-id]` pairs) with the preferred
  pairs first, in preference order. A candidate whose pair was already placed is
  dropped. With no preference match everything keeps its order."
  [candidates preferred]
  (let [all (vec (range (count candidates)))]
    (if (empty? preferred)
      all
      (let [[ordered used]
            (reduce (fn [[ordered used] preference]
                      (reduce (fn [[ordered used] i]
                                (let [candidate (nth candidates i)]
                                  (if (and (= candidate preference) (not (contains? used candidate)))
                                    [(conj ordered i) (conj used candidate)]
                                    [ordered used])))
                              [ordered used] all))
                    [[] #{}] preferred)]
        (if (empty? ordered)
          all
          (into ordered (remove #(contains? used (nth candidates %))) all))))))

(defn candidate-order-for-routes
  "Indices of `candidates` (`{:provider-index :ttft}`; provider-index nil when the
  provider is not among the routes) grouped by provider in route order, except
  that across providers a clearly lower measured TTFT (beyond the grace window)
  goes first. Equal-provider candidates keep their order."
  [policy candidates]
  (let [grace (get-in policy [:attempt/latency-ordering :ttft-grace-ms])
        index-of #(or (:provider-index %) 9007199254740991)]
    (native-sort (fn [a b]
                 (let [l (nth candidates a) r (nth candidates b)
                       idx-l (index-of l) idx-r (index-of r)]
                   (if (not= idx-l idx-r)
                     (let [ttft-l (:ttft l) ttft-r (:ttft r)]
                       (if (and (some? ttft-l) (some? ttft-r) (> (Math/abs (- ttft-l ttft-r)) grace))
                         (- ttft-l ttft-r)
                         (- idx-l idx-r)))
                     0)))
               (range (count candidates)))))
