(ns proxx.http.events-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.events :as events]
            [proxx.http.params :as p]))

(deftest filters-follow-js-coercions
  (is (= {:limit 50 :includePayload false} (events/query-filter {})))
  (let [f (events/query-filter {"status" "7x" "status_gte" "abc" "limit" "" "since" "2024-01-02"
                                "kind" ["a" "b"] "include_payload" "true" "offset" "3"})]
    (is (= 7 (:status f)))
    (is (p/nan? (:statusGte f)) "an unparsable status is NaN, not dropped")
    (is (= 50 (:limit f)) "an empty limit is falsy -> default")
    (is (= ["a" "b"] (:kind f)) "a repeated parameter passes through")
    (is (= "2024-01-02" (:since f)))
    (is (= 3 (:offset f)))
    (is (true? (:includePayload f))))
  (testing "count filter has no paging"
    (is (= {:tag "t"} (events/count-filter {"tag" "t" "limit" "5"})))))

(deftest tags
  (is (= ["x" nil] (events/tag-or-error {"tag" "x"})))
  (is (= ["null" nil] (events/tag-or-error {"tag" nil})) "String(null) is truthy")
  (is (= ["5" nil] (events/tag-or-error {"tag" 5})))
  (is (= ["a,b" nil] (events/tag-or-error {"tag" ["a" "b"]})))
  (testing "missing/empty/non-object -> 400"
    (doseq [b [nil {} {"tag" ""} [] "str" 5 {"other" 1}]]
      (is (= 400 (:status (second (events/tag-or-error b)))) (pr-str b)))))

(deftest list-body-omits-uncounted-total
  (is (= {"events" [] "count" 0} (events/list-body [] 0 nil)))
  (is (= {"events" [] "count" 0 "totalCount" 0} (events/list-body [] 0 0))))
