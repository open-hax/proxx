(ns proxx.budget.policy-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.budget.policy :as policy]))

(def contract {:contract/kind :paid-budget :match/key-id "bot-key"
               :budget/scope-id "bot" :budget/daily-microusd 500000 :budget/monthly-microusd 5000000
               :budget/allowed-modes #{"chat_completions"}
               :budget/max-input-tokens 262144 :budget/max-output-tokens 1024
               :budget/routes [{:provider-id "router" :model-id "vendor/free" :billing :free}
                               {:provider-id "router" :model-id "vendor/paid" :billing :paid}]})
(def auth {:kind "tenant_api_key" :keyId "bot-key"})
(def attempt {:providerId "router" :model "vendor/paid" :mode "chat_completions" :payload {}})

(deftest paid-identity-is-not-session-metadata
  (is (= "paid" (:status (policy/inspect-attempt [contract] auth attempt))))
  (is (= "paid" (:status (policy/inspect-attempt [contract] auth (assoc attempt :payload {:metadata {:session_id "other"}})))))
  (is (= "unmanaged" (:status (policy/inspect-attempt [contract] (assoc auth :keyId "unrelated") attempt))))
  (is (= "unmanaged" (:status (policy/inspect-attempt [contract] {:kind "legacy_admin" :keyId "bot-key"} attempt)))))

(deftest bot-key-cannot-route-around-admission
  (doseq [changed [(assoc attempt :providerId "other") (assoc attempt :model "other")
                   (assoc attempt :mode "messages") (assoc attempt :payload {:max_tokens -1})]]
    (is (= "denied" (:status (policy/inspect-attempt [contract] auth changed))))))

(deftest policy-bounds-decoder-before-reservation
  (let [result (policy/inspect-attempt [contract] auth (assoc attempt :payload {:max_completion_tokens 10000}))]
    (is (= 1024 (:outputBound result)))
    (is (= {:max_tokens 1024} (:payload result))))
  (is (= "free" (:status (policy/inspect-attempt [contract] auth (assoc attempt :model "vendor/free"))))))

(deftest declared-route-order-and-absolute-deadlines
  (let [c (assoc contract :budget/routing-model-pattern "(?i)^(gemma4:31b|vendor/(free|paid))$"
                 :budget/free-cutoff-ms 12000 :budget/first-output-total-ms 20000
                 :budget/max-bootstrap-bytes 1048576 :budget/max-retries 0)
        plan (policy/route-plan [c] auth "vendor/paid")]
    (is (:managed plan))
    (is (= ["vendor/free" "vendor/paid"] (mapv :upstreamModel (:orderedRoutes plan))))
    (is (= [12000 20000] (mapv :firstUsableOffsetMs (:orderedRoutes plan))))
    (is (= 20000 (:totalFirstUsableMs plan)))
    (is (= {:managed true} (policy/route-plan [c] auth "local-e4b")))
    (is (nil? (policy/route-plan [c] (assoc auth :keyId "other") "vendor/paid")))))

(deftest multiple-completions-cannot-exceed-the-reserved-output-bound
  (is (= "denied" (:status (policy/inspect-attempt [contract] auth (assoc attempt :payload {:n 2})))))
  (is (= "denied" (:status (policy/inspect-attempt [contract] auth (assoc attempt :payload {:best_of 2}))))))


(deftest budget-snapshot-scope-follows-server-auth
  (let [contracts [contract (assoc contract :match/key-id "other-key" :budget/scope-id "other")]
        own (policy/snapshot-selection contracts auth nil)
        denied (policy/snapshot-selection contracts auth "other-key")
        anonymous (policy/snapshot-selection contracts {:kind "unauthenticated"} nil)
        all (policy/snapshot-selection contracts {:kind "legacy_admin"} nil)
        other (policy/snapshot-selection contracts {:kind "legacy_admin"} "other-key")]
    (is (= ["bot"] (mapv :scopeId (:policies own))))
    (is (= "forbidden" (:status denied)))
    (is (= "forbidden" (:status anonymous)))
    (is (= 2 (count (:policies all))))
    (is (= ["other"] (mapv :scopeId (:policies other))))))

(deftest snapshot-separates-charges-and-carried-holds
  (let [policy {:dailyMicrousd 500000 :monthlyMicrousd 5000000}
        usage {:dailyChargedMicrousd 100000 :monthlyChargedMicrousd 1000000
               :heldMicrousd 150000 :dailyCarriedMicrousd 50000 :monthlyCarriedMicrousd 20000}
        result (policy/snapshot-usage policy usage)
        exhausted (policy/snapshot-usage policy (assoc usage :heldMicrousd 900000))]
    (is (= 250000 (:dailyRemainingMicrousd result)))
    (is (= 3850000 (:monthlyRemainingMicrousd result)))
    (is (= usage (:usage result)))
    (is (= 0 (:dailyRemainingMicrousd exhausted)))))
