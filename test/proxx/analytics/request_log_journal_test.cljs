(ns proxx.analytics.request-log-journal-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.analytics.request-log-journal :as j]
            [proxx.json :as json]
            [proxx.analytics.request-log :as rl]))

(deftest names
  (is (= "request-logs.jsonl" (j/file-name "/var/x/request-logs.jsonl")))
  (is (= "a.jsonl" (j/file-name "a.jsonl")))
  (is (= ".a.jsonl.7.u.tmp" (j/temp-name "/d/a.jsonl" 7 "u")))
  (is (= "a.jsonl.corrupt-5-7-u" (j/corrupt-name "/d/a.jsonl" 5 7 "u")))
  (is (= "a.jsonl.migrated-5-7-u" (j/migrated-name "/d/a.jsonl" 5 7 "u")))
  (is (= "/d/a.json" (j/legacy-path "/d/a.jsonl")))
  (is (nil? (j/legacy-path "/d/a.json")))
  (is (= ["/d/a.jsonl" "/d/a.json"] (j/source-candidates "/d/a.jsonl")))
  (is (= ["/d/a.log"] (j/source-candidates "/d/a.log")))
  (is (= "/d/a.meta.json" (j/metadata-path "/d/a.jsonl")))
  (is (= "/d/a.meta.json" (j/metadata-path "/d/a.json")))
  (is (= "/d/a.log.meta.json" (j/metadata-path "/d/a.log"))))

(deftest persist-plan-and-transitions
  (let [j0 (-> j/empty-journal (j/queue-entry :a) (j/queue-entry :b))]
    (testing "append takes the queue; success counts lines"
      (let [[plan j1] (j/persist-plan j0 false 100 2)]
        (is (= {:op :append :entries [:a :b]} plan))
        (is (= [] (:pending j1)))
        (is (= 2 (:lines (j/appended j1 plan))))))
    (testing "failure restores in front of newer entries"
      (let [[plan j1] (j/persist-plan j0 false 100 2)
            j2 (j/queue-entry j1 :c)]
        (is (= [:a :b :c] (:pending (j/persist-failed j2 plan))))))
    (testing "nothing pending -> metadata only"
      (is (= :metadata (:op (first (j/persist-plan j/empty-journal false 100 0))))))
    (testing "force or overflow compacts, and compaction resets the flag and line count"
      (is (= :compact (:op (first (j/persist-plan j0 true 100 2)))))
      (let [o (j/queue-entry j/empty-journal :x true)
            [plan _] (j/persist-plan o false 100 1)]
        (is (= :compact (:op plan)))
        (is (= {:pending [] :lines 1 :needs-compaction? false} (j/compacted (assoc o :pending []) 1)))))
    (testing "stale journal compacts"
      (is (= :compact (:op (first (j/persist-plan (assoc j/empty-journal :lines 5000 :pending [:a]) false 10 10))))))))

(defn- line [m] (json/write m))
(defn- ingest [lines max]
  (j/ingest-lines lines max json/parse #(rl/hydrate-entry % {:now (constantly 1) :uuid (constantly "minted")})))

(def valid {"providerId" "p" "accountId" "a" "model" "m" "upstreamMode" "u" "upstreamPath" "/x" "status" 200 "latencyMs" 1})

(deftest ingest-lines-folds-a-journal
  (let [l1 (line (assoc valid "id" "a"))
        l2 (line (assoc valid "id" "b"))
        l1b (line (assoc valid "id" "a" "status" 500))
        r (ingest ["" "  " l1 "{bad" "5" l2 (str "  " l1b "  ") "null"] 10)]
    (testing "later line for an id replaces in place; blanks are not counted; junk is kept raw"
      (is (= ["a" "b"] (mapv #(get % "id") (:entries r))))
      (is (= 500 (get (first (:entries r)) "status")))
      (is (= ["{bad" "5" "null"] (:malformed r)))
      (is (= 6 (:line-count r))))
    (testing "retention drops the oldest distinct id"
      (let [r (ingest [l1 l2 (line (assoc valid "id" "c"))] 2)]
        (is (= ["b" "c"] (mapv #(get % "id") (:entries r)))))
      (let [r (ingest [l1 l2 l1b (line (assoc valid "id" "c"))] 2)]
        (is (= ["b" "c"] (mapv #(get % "id") (:entries r))) "touching a does not refresh its age")))
    (testing "an id minted for a line without one comes from the injected env"
      (is (= ["minted"] (mapv #(get % "id") (:entries (ingest [(line valid)] 5))))))))

(deftest warmup-verdicts
  (is (j/looks-like-legacy-json? {:entries [] :malformed ["{"]}))
  (is (not (j/looks-like-legacy-json? {:entries [] :malformed []})))
  (is (not (j/looks-like-legacy-json? {:entries [1] :malformed ["{"]})))
  (is (j/legacy-payload? {:array? true}))
  (is (j/legacy-payload? {:entries-array? true}))
  (is (not (j/legacy-payload? {})))
  (is (= [:quarantine-lines :persist] (j/post-load-steps {:malformed ["x"]} true)))
  (is (= [:persist] (j/post-load-steps {:malformed []} true)))
  (is (= [] (j/post-load-steps {:malformed []} false))))

(deftest mirror-failure-throttle
  (let [run (fn [times] (reduce (fn [[ws s] t] (let [[w s'] (j/mirror-failure s t)] [(conj ws w) s'])) [[] {}] times))
        [ws _] (run [1 2 3 4 5 6 7 8 9 10 11 12])]
    (is (= [true true true false true false false false false true false false] ws)))
  (let [[w s] (j/mirror-failure {:count 20 :last-warning-at 1000} 70000)]
    (is (true? w) "a minute later warns again")
    (is (= 70000 (:last-warning-at s))))
  (let [[w s] (j/mirror-failure {:count 20 :last-warning-at 1000} 30000)]
    (is (false? w))
    (is (= 1000 (:last-warning-at s)))))

(deftest operator-lines
  (is (= "[request-log-store] mirror upsert failed (#2): boom" (j/mirror-warning "upsert" 2 "boom")))
  (is (= "[request-log-store] Ignored 2 malformed JSONL request log lines from s; wrote them to c"
         (j/corrupt-lines-warning 2 "s" "c"))))
