(ns proxx.usage.sql-test
  (:require [clojure.string :as str]
            [cljs.test :refer [deftest is]]
            [proxx.usage.sql :as sql]))

(deftest limits
  (is (= 200 (sql/sanitize-limit nil 200)))
  (is (= 200 (sql/sanitize-limit js/NaN 200)))
  (is (= 200 (sql/sanitize-limit 0 200)))
  (is (= 2 (sql/sanitize-limit 2.7 200)))
  (is (= 5000 (sql/sanitize-limit 99999 200))))

(deftest numbers-at-the-database-boundary
  (is (= 7 (sql/optional-number "7")))
  (is (= 16 (sql/optional-number "0x10")) "Number() semantics, as before")
  (is (nil? (sql/optional-number " ")))
  (is (nil? (sql/optional-number js/Infinity)))
  (is (thrown-with-msg? js/Error #"Expected numeric database value, got z" (sql/required-number "z")))
  ;; Intentional divergence: a missing (undefined) required column reports
  ;; "null"; the TypeScript message said "undefined". The database never
  ;; returns undefined, and absent/null are one thing in the pure core.
  (is (thrown-with-msg? js/Error #"got null" (sql/required-number nil))))

(deftest where-numbering
  (is (= {"text" "SELECT COUNT(*) FROM x"} (select-keys {"text" "SELECT COUNT(*) FROM x"} ["text"])))
  (let [q (sql/list-query {"providerId" "p" "tenantId" "t" "limit" 10}
                          {"timestampMs" 5 "id" "z"})]
    (is (str/includes? (get q "text") "WHERE provider_id = $1 AND tenant_id = $2 AND (timestamp_ms < $3 OR (timestamp_ms = $3 AND id < $4)) ORDER BY timestamp_ms DESC, id DESC LIMIT 10"))
    (is (= ["p" "t" 5 "z"] (get q "values"))))
  (let [q (sql/list-since-query 9 {"keyId" "k"} 3 {"timestampMs" 1 "id" "a"})]
    (is (str/includes? (get q "text") "WHERE timestamp_ms >= $1 AND key_id = $2 AND (timestamp_ms > $3 OR (timestamp_ms = $3 AND id > $4)) ORDER BY timestamp_ms ASC, id ASC LIMIT 3"))
    (is (= [9 "k" 1 "a"] (get q "values")))))

(deftest upsert-shape
  (let [{:strs [strings values]} (sql/upsert-statement {"id" "e" "promptCacheKeyUsed" nil "factoryDiagnosticsJson" "{}"})]
    (is (= (count values) (dec (count strings))))
    (is (= 39 (count values)))
    (is (= "e" (first values)))
    (is (= false (nth values 26)) "boolean columns are strict")
    (is (str/starts-with? (first strings) "\n      INSERT INTO request_usage_entries ("))
    (is (= "::jsonb,\n        " (nth strings 36)))))

(deftest entries
  (let [e (sql/row->entry {"id" "i" "timestamp_ms" "5" "status" 200 "latency_ms" 1 "route_kind" "x" "auth_type" "weird"
                           "service_tier_source" "q" "tenant_id" "" "prompt_tokens" "9"} nil)]
    (is (= {"id" "i" "timestamp" 5 "routeKind" "local" "authType" "none" "status" 200 "latencyMs" 1
            "serviceTierSource" "none" "promptCacheKeyUsed" false "cacheHit" false "promptTokens" 9}
           (select-keys e ["id" "timestamp" "routeKind" "authType" "status" "latencyMs" "serviceTierSource" "promptCacheKeyUsed" "cacheHit" "promptTokens" "tenantId"]))
        "empty strings and nulls are absent; unknown enums normalise"))
  (is (= {"earliestEntryAtMs" nil "retainedEntryCount" 0 "maxRetainedEntries" 0} (sql/coverage nil))))
