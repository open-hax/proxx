(ns proxx.strategy.credential-selector-test
  "Credential reordering for affinities. The TypeScript entry points
  (`reorderCandidatesForAffinities` / `reorderCandidatesForAffinity`) map the
  kernel's index order back onto the candidates; the same mapping is done here
  over the CLJS function they delegate to."
  (:require [cljs.test :refer [deftest is]]
            [proxx.strategy.routing :as routing]))

(defn- candidate [account-id]
  {:provider-id "openai" :account {:provider-id "openai" :account-id account-id :token "x" :auth-type :api-key}})

(defn- pair [{:keys [provider-id account]}] [provider-id (:account-id account)])

(defn- reorder-for-affinities [candidates preferred]
  (mapv #(nth candidates %)
        (routing/candidate-order-for-affinities (mapv pair candidates) (mapv (juxt :provider-id :account-id) preferred))))

(defn- reorder-for-affinity [candidates preferred]
  (reorder-for-affinities candidates (if preferred [preferred] [])))

(deftest reorder-candidates-for-affinities-moves-preferred-candidates-to-front
  (let [candidates (mapv candidate ["a1" "a2" "a3"])
        result (reorder-for-affinities candidates [{:provider-id "openai" :account-id "a3"}])]
    (is (= "a3" (get-in (first result) [:account :account-id])))
    (is (= 3 (count result)))))

(deftest reorder-candidates-for-affinities-returns-copy-when-no-preferences
  (let [candidates [(candidate "a1")]
        result (reorder-for-affinities candidates [])]
    (is (= candidates result))
    (is (not (identical? result candidates)))))

(deftest reorder-candidates-for-affinity-delegates-to-reorder-candidates-for-affinities
  (let [candidates (mapv candidate ["a1" "a2"])
        with-pref (reorder-for-affinity candidates {:provider-id "openai" :account-id "a2"})]
    (is (= "a2" (get-in (first with-pref) [:account :account-id])))
    (is (= candidates (reorder-for-affinity candidates nil)))))
