(ns proxx.credentials.federation-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.credentials.federation :as fed]))

(defn- parse [s] (try (js->clj (js/JSON.parse s)) (catch :default _ nil)))

(deftest json-columns
  (is (= {} (fed/parse-json-object nil parse)))
  (is (= {} (fed/parse-json-object "" parse)))
  (is (= {"a" 1} (fed/parse-json-object "{\"a\":1}" parse)))
  (doseq [bad ["[1]" "5" "not json" "null" "\"s\""]]
    (is (= {} (fed/parse-json-object bad parse)) bad))
  (is (= {"x" 1} (fed/parse-json-object {"x" 1} parse)) "already-parsed objects pass through"))

(deftest thresholds-and-limits
  (doseq [[raw expected] [[nil 3] ["" 3] ["  " 3] ["5" 5] ["0" 0] ["-2" 3] ["abc" 3] [" 7 " 7]]]
    (is (= expected (fed/warm-import-threshold raw)) (pr-str raw)))
  (is (true? (fed/should-warm-import? 3 3)))
  (is (false? (fed/should-warm-import? 2 3)))
  (is (false? (fed/should-warm-import? js/NaN 0)))
  (doseq [[limit expected] [[nil 200] [0 200] [-3 200] [5.7 5] [99999 500] [js/NaN 200] [js/Infinity 200]]]
    (is (= expected (fed/sanitize-limit limit 200)) (pr-str limit))))

(deftest base-url-and-conflicts
  (is (= "http://x" (fed/peer-base-url-input "  http://x ")))
  (is (thrown-with-msg? ExceptionInfo #"baseUrl must not be empty" (fed/peer-base-url-input "  ")))
  (is (true? (fed/base-url-conflict? {:code "23505" :constraint "federation_peers_base_url_key"})))
  (is (true? (fed/base-url-conflict? {:code "23505" :message "duplicate key ... base_url"})))
  (is (false? (fed/base-url-conflict? {:code "23505" :constraint "other"})))
  (is (false? (fed/base-url-conflict? {:code "42P01" :constraint "federation_peers_base_url_key"}))))

(deftest records
  (let [r (fed/peer-record {"id" "p" "owner_subject" "o" "peer_did" nil "label" "l" "base_url" "u" "auth_mode" "admin_key"
                            "auth_json" "{\"k\":1}" "status" "s" "capabilities" nil "created_at" "c" "updated_at" "u2"} parse)]
    (is (= {"k" 1} (get r "auth")))
    (is (= {} (get r "capabilities")))
    (is (not (contains? r "peerDid")) "SQL NULL is omitted"))
  (is (= 12 (get (fed/diff-event-record {"seq" "12"} parse) "seq")))
  (is (= 0 (get (fed/sync-state-record {"last_pulled_seq" "0" "last_pushed_seq" 5}) "lastPulledSeq"))))
