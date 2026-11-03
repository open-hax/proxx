(ns proxx.routing.outcome-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.routing.outcome :as o]
            [proxx.routing.pipeline :as p]
            [proxx.runtime.routing :as edge]))

(defn- exec [n & flags] {:candidate-count n :summary (zipmap flags (repeat true))})

(deftest classification-precedence
  (is (= :keys-missing (o/classify (exec 0) {})))
  (is (= :all-disabled (o/classify (exec 0) {:saw-configured-provider true :saw-only-disabled-providers true})))
  (is (= :all-rate-limited (o/classify (exec 0) {:saw-configured-provider true})))
  (is (= :invalid-request (o/classify (exec 2 :saw-rate-limit :saw-upstream-invalid-request) {})))
  (is (= :rate-limited (o/classify (exec 2 :saw-rate-limit :saw-upstream-server-error) {})))
  (is (= :server-error (o/classify (exec 2 :saw-upstream-server-error :saw-model-not-found) {})))
  (is (= :model-not-found (o/classify (exec 2 :saw-model-not-found :saw-model-not-supported-for-account) {})))
  (is (= :model-not-supported (o/classify (exec 2 :saw-model-not-found :saw-request-error :saw-model-not-supported-for-account) {}))
      "model-not-found is dropped when a transport error was also seen")
  (is (= :unavailable (o/classify (exec 2 :saw-request-error) {}))))

(deftest retry-hint-only-for-cooldown-outcomes
  (is (every? o/needs-retry-hint? [:keys-missing :all-disabled :all-rate-limited :rate-limited]))
  (is (not-any? o/needs-retry-hint? [:invalid-request :server-error :model-not-found :model-not-supported :unavailable])))

(deftest responses
  (is (= {:status 500 :message "Proxy is missing upstream account configuration" :type "server_error" :code "keys_unavailable" :retry-after-seconds 3.0}
         (o/response :keys-missing {} 2100)))
  (is (not (contains? (o/response :keys-missing {} 0) :retry-after-seconds)))
  (is (= 503 (:status (o/response :all-disabled {} 0))))
  (is (= "all_keys_rate_limited" (:code (o/response :all-rate-limited {} 0))))
  (is (not (contains? (o/response :invalid-request {} 5000) :retry-after-seconds)) "no hint where the TS sent none")
  (let [r (o/response :invalid-request {:last-upstream-error {:provider-id nil :status 422 :body "bad"} :log-prefix "chat"} 0)]
    (is (= 400 (:status r)))
    (is (= "No upstream account accepted the request payload. Check model availability and request parameters. Last upstream error (unknown, HTTP 422): bad"
           (:message r)))
    (is (= {:level :warn :message "chat: all attempts exhausted due to upstream invalid-request responses"} (:log r))))
  (is (= "No upstream account accepted the request payload. Check model availability and request parameters."
         (:message (o/response :invalid-request {} 0))))
  (let [r (o/response :rate-limited {} 1)]
    (is (= [429 "no_available_key" 1.0] [(:status r) (:code r) (:retry-after-seconds r)])))
  (is (= "Model not found across available upstream providers: m" (:message (o/response :model-not-found {:routed-model "m"} 0))))
  (is (= [403 "model_not_supported_for_account"] ((juxt :status :code) (o/response :model-not-supported {:routed-model "m"} 0))))
  (is (= "All upstream attempts failed due to network/transport errors." (:message (o/response :unavailable {:saw-request-error true} 0))))
  (let [r (o/response :unavailable {} 0)]
    (is (= [502 "upstream_unavailable" :error true] [(:status r) (:code r) (get-in r [:log :level]) (:with-request-error? r)])))
  (is (= 502 (:status (o/response :server-error {} 0)))))

(deftest edge-reads-js-summaries
  (let [exec #js {:candidateCount 2 :summary #js {:sawRateLimit true :attempts 3}}
        avail #js {:sawConfiguredProvider true}]
    (is (= "rate-limited" (edge/classify-routing-outcome-js exec avail)))
    (is (true? (edge/routing-outcome-needs-retry-hint-js "rate-limited")))
    (let [r (edge/routing-outcome-response-js "rate-limited" #js {:routedModel "m" :logPrefix "p"} 1500)]
      (is (= 2 (.-retryAfterSeconds r)))
      (is (= "warn" (.. r -log -level)))
      (is (= "p: all attempts exhausted due to upstream rate limits" (.. r -log -message))))))

(deftest pipeline-decisions
  (is (= {:model "m"} (p/check-requested-model {"model" "m"})))
  (is (= "missing_model" (get-in (p/check-requested-model {"model" ""}) [:error :code])))
  (is (= "missing_model" (get-in (p/check-requested-model {"model" 5}) [:error :code])))
  (is (p/tenant-denies-model? {"status" "ok" "decision" {"status" "denied" "reason" "tenant-model-not-allowed"}}))
  (is (not (p/tenant-denies-model? {"status" "ok" "decision" {"status" "denied" "reason" "other"}})))
  (is (not (p/tenant-denies-model? {"status" "error" "decision" {"status" "denied" "reason" "tenant-model-not-allowed"}})))
  (is (not (p/tenant-denies-model? nil)))
  (is (= :cephalon (p/candidate-source {:cephalon? true :vision? true :auto? true})))
  (is (= :vision (p/candidate-source {:vision? true :auto? true})))
  (is (= :auto (p/candidate-source {:auto? true})))
  (is (= :plain (p/candidate-source {})))
  (is (= "model_not_found" (get-in (p/finish "m" :auto []) [:error :code])))
  (is (= {:candidates ["a"] :auto? false} (p/finish "m" :plain ["a"])))
  (is (= {:candidates (vec (map str (range 14))) :auto? true :candidates-header "0,1,2,3,4,5,6,7,8,9,10,11"}
         (p/finish "m" :auto (map str (range 14))))))
