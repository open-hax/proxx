(ns proxx.web.events-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.web.pages.events :as ev]
            [proxx.web.update :as u]))

(defn- boot [] (u/init-db {:stored {} :token "t" :path "/events"}))
(defn- entered [] (first (u/handle (boot) [:route/changed "/events"])))
(defn- slice [db] (get-in db [:pages :events]))
(defn- paths [fx*] (keep #(when (= :http (first %)) (:path (second %))) fx*))

(deftest enter-loads-events-and-tags
  (let [[_ fx*] (u/handle (boot) [:route/changed "/events"])]
    (is (= ["/api/v1/events?limit=50&offset=0&include_count=true" "/api/v1/events/tags"] (paths fx*)))))

(deftest filters-refetch-and-trim
  (let [[db fx*] (u/handle (entered) [:events/set-filter :kind "  error "])]
    (is (= ["/api/v1/events?kind=error&limit=50&offset=0&include_count=true"] (paths fx*)))
    (is (= "  error " (get-in (slice db) [:filters :kind])) "input keeps what was typed")
    (let [[db2 fx2] (u/handle db [:events/clear])]
      (is (= ev/empty-filters (:filters (slice db2))))
      (is (= ["/api/v1/events?limit=50&offset=0&include_count=true"] (paths fx2))))))

(deftest invalid-since-is-dropped-not-fatal
  (let [[_ fx*] (u/handle (entered) [:events/set-filter :since "2026-xx"])]
    (is (= ["/api/v1/events?limit=50&offset=0&include_count=true"] (paths fx*))))
  (is (= "2026-04-28T00:00:00.000Z" (ev/since->iso "2026-04-28")))
  (is (nil? (ev/since->iso "  "))))

(deftest pagination
  (let [db (entered)
        [db1 _] (u/handle db [:events/loaded 1 {:events (vec (repeat 50 {:id "x" :tags []})) :totalCount 120}])]
    (is (true? (:can-next? (ev/view-model db1))))
    (is (false? (:can-prev? (ev/view-model db1))))
    (let [[db2 fx2] (u/handle db1 [:events/next])]
      (is (= ["/api/v1/events?limit=50&offset=50&include_count=true"] (paths fx2)))
      (is (true? (:can-prev? (ev/view-model db2))))
      (is (= "offset 50 · limit 50" (subs (:meta (ev/view-model db2)) 0 20)))
      (let [[_ fx3] (u/handle db2 [:events/prev])]
        (is (= ["/api/v1/events?limit=50&offset=0&include_count=true"] (paths fx3)))))
    (testing "next disabled at the end of the total"
      (let [[db3] (u/handle (assoc-in db1 [:pages :events :offset] 100) [:events/loaded 1 {:events (vec (repeat 50 {:id "x"})) :totalCount 150}])]
        (is (false? (:can-next? (ev/view-model db3))))))
    (testing "unknown total keeps next enabled on a full page"
      (let [[db3] (u/handle db [:events/loaded 1 {:events (vec (repeat 50 {:id "x"}))}])]
        (is (true? (:can-next? (ev/view-model db3))))))
    (testing "stale response ignored"
      (let [[db3 _] (u/handle db1 [:events/next])
            [db4] (u/handle db3 [:events/loaded 1 {:events [{:id "stale"}]}])]
        (is (= 50 (count (:events (slice db4)))))))))

(deftest limit-parsing
  (is (= 50 (ev/parse-limit "")))
  (is (= 50 (ev/parse-limit "abc")))
  (is (= 50 (ev/parse-limit "-3")))
  (is (= 500 (ev/parse-limit "9999")))
  (is (= 25 (ev/parse-limit "25x"))))

(deftest selection-and-tags
  (let [[db fx*] (u/handle (entered) [:events/select "e/1"])]
    (is (= ["/api/v1/events/e%2F1"] (paths fx*)))
    (is (true? (:selected-loading? (slice db))))
    (let [[db1] (u/handle db [:events/selected-loaded "e/1" {:id "e/1" :ts "2026-04-03T00:00:00Z" :kind "error" :entryId "en"
                                                              :tags ["a"] :payload {"k" 1} :meta {"m" 2}}])
          vm (ev/view-model db1)]
      (is (= "e/1" (get-in vm [:detail :id])))
      (is (= "{\n  \"k\": 1\n}" (get-in vm [:detail :payload-json])))
      (let [[_ fx1] (u/handle (first (u/handle db1 [:events/tag-input "  "])) [:events/add-tag])]
        (is (empty? fx1) "blank tag ignored"))
      (let [[db2] (u/handle db1 [:events/tag-input " new "])
            [_ fx2] (u/handle db2 [:events/add-tag])]
        (is (= {:tag "new"} (:body (second (first fx2)))))
        (is (= :post (:method (second (first fx2))))))
      (let [[_ fx2] (u/handle db1 [:events/remove-tag "a"])]
        (is (= :delete (:method (second (first fx2)))))
        (is (= {:tag "a"} (:body (second (first fx2))))))
      (let [[db3 fx3] (u/handle (first (u/handle db1 [:events/tag-input "x"])) [:events/tag-changed "e/1" true {}])]
        (is (= "" (:tag-input (slice db3))))
        (is (= ["/api/v1/events/e%2F1"] (paths fx3)))))
    (testing "select failure shows error and no detail"
      (let [[db2] (u/handle db [:events/selected-failed "e/1" "nope"])]
        (is (= "nope" (:error (slice db2))))
        (is (nil? (:detail (ev/view-model db2))))))))

(deftest row-and-tag-summary-views
  (let [row (ev/event-row-view "a" {:id "a" :ts "2026-04-03T00:00:00Z" :kind "response" :providerId "p" :model "m" :status 200
                                    :tags ["1" "2" "3" "4"] :payloadBytes 2048})]
    (is (true? (:selected? row)))
    (is (= "success" (:badge row)))
    (is (= "p/-" (:provider-account row)))
    (is (= ["1" "2" "3"] (:tags row)))
    (is (= "+1" (:more-tags row)))
    (is (= "2.0 kB" (:payload row)))
    (is (= "default" (ev/badge-variant "request")))
    (is (= "error" (ev/badge-variant "error"))))
  (let [[db] (u/handle (entered) [:events/tags-loaded {:tags (into {} (map (fn [i] [(str "t" i) i]) (range 20))) :since "2026-04-03T00:00:00Z"}])]
    (is (= 16 (count (get-in (ev/view-model db) [:tag-summary :pills])))))
  (let [[db fx*] (u/handle (entered) [:events/pick-tag "label:x"])]
    (is (= "label:x" (get-in (slice db) [:filters :tag])))
    (is (= ["/api/v1/events?tag=label%3Ax&limit=50&offset=0&include_count=true"] (paths fx*)))))
