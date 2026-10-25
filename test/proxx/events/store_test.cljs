(ns proxx.events.store-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.events.store :as s]))

(deftest query-text-and-params-are-the-persisted-contract
  (is (= {"text" "SELECT id, ts, kind, entry_id, provider_id, account_id, model, status, tags, meta, payload_bytes FROM events  ORDER BY ts DESC LIMIT $1 OFFSET $2"
          "values" [100 0]}
         (s/build-query {})))
  (is (= {"text" "SELECT * FROM events WHERE kind = $1 AND status = $2 AND status >= $3 AND tags ? $4 AND ts >= $5 ORDER BY ts ASC LIMIT $6 OFFSET $7"
          "values" ["request" nil 400 "t" "2024" 1000 5]}
         (s/build-query {"kind" "request" "status" nil "statusGte" 400 "tag" "t" "since" "2024"
                         "limit" 5000 "offset" 5 "orderDesc" false "includePayload" true}))
      "status uses presence (null is bound), kind uses truthiness")
  (is (= {"text" "SELECT COUNT(*) as count FROM events WHERE model = $1" "values" ["m"]}
         (s/build-count {"model" "m" "kind" ""}))))

(deftest rows
  (let [parse (fn [t] (str "parsed:" t))
        e (s/parse-row {"id" "i" "ts" 1 "kind" "k" "entry_id" "e" "provider_id" nil "tags" "[]" "meta" nil "payload" nil}
                       parse {"tags" [] "meta" {}})]
    (is (= "parsed:[]" (get e "tags")))
    (is (= {} (get e "meta")))
    (is (not (contains? e "providerId")))
    (is (nil? (get e "payload")))))

(deftest sanitising
  (is (= {"a" "xy␟z\u0001" "b" [nil 1]} (s/sanitize-payload {"a" "x\u0000y\u001Fz\u0001" "b" [nil 1]} (constantly 10))))
  (is (= {"_truncated" true "_originalBytes" 3000000 "model" "m" "_messageCount" 1
          "_urls" ["https://a" "http://b"]}
         (s/sanitize-payload {"model" "m" "messages" [{"c" "https://a"}] "z" ["ftp://x" "http://b"]}
                             (constantly 3000000)))))
