(ns proxx.runtime.request-log-store-test
  (:require [cljs.test :refer [deftest is]]
            ["node:fs" :as fs]
            ["node:os" :as os]
            ["node:path" :as path]
            [proxx.runtime.request-log :as rl]))

(defn- tmp-dir [] (.mkdtempSync fs (path/join (.tmpdir os) "rl-store-test-")))
(defn- estimate [_ _ _ _] #js {:costUsd 0 :energyJoules 0 :waterEvaporatedMl 0})
(defn- entry [id] #js {:id id :providerId "p" :accountId "a" :authType "api_key" :model "m"
                      :upstreamMode "u" :upstreamPath "/x" :status 200 :latencyMs 1 :timestamp 1700000000000})
(defn- store [file & {:keys [max interval mirror]}]
  (rl/create-request-log-store-js
   #js {:filePath file :maxEntries (or max 100) :persistIntervalMs (or interval 0) :mirror mirror :estimate estimate}))
(defn- ls [dir] (vec (sort (.readdirSync fs dir))))
(defn- ids [^js s] (mapv #(.-id ^js %) (.snapshot s)))

(defn- cleanup [dir] (.rmSync fs dir #js {:recursive true :force true}))
(defn- lines [file] (vec (filter seq (.split (.readFileSync fs file "utf8") "\n"))))
(defn- capture! [k]
  (let [log (atom []) orig (aget js/console k)]
    (aset js/console k (fn [m] (swap! log conj m)))
    [log (fn [] (aset js/console k orig))]))

(deftest ^:async journal-roundtrip-and-corrupt-lines
  (let [dir (tmp-dir) file (path/join dir "r.jsonl")
        _ (.writeFileSync fs file (str (js/JSON.stringify (entry "a")) "\n{broken\n" (js/JSON.stringify (entry "b")) "\n"))
        [warnings restore] (capture! "warn")
        ^js s (store file)]
    (try
      (await (.warmup s))
      (is (= ["a" "b"] (ids s)))
      (is (= 1 (count (filter #(re-find #"Ignored 1 malformed" %) @warnings))))
      (let [corrupt (first (filter #(re-find #"^r\.jsonl\.corrupt-" %) (ls dir)))]
        (is (some? corrupt) "malformed lines are quarantined")
        (is (= "{broken\n" (.readFileSync fs (path/join dir corrupt) "utf8"))))
      (is (= 2 (count (lines file))) "the warmup rewrote the journal without the broken line")
      (.record s (entry "c"))
      (await (.close s))
      (is (= 3 (count (lines file))) "close flushes")
      (is (every? #(not (re-find #"\.tmp$" %)) (ls dir)) "no temp files left behind")
      (finally (restore) (cleanup dir)))))

(deftest ^:async closed-store-and-subscribers
  (let [dir (tmp-dir) file (path/join dir "r.jsonl")
        ^js s (store file)
        events (atom [])]
    (try
      (await (.warmup s))
      (let [off (.subscribe s (fn [ev] (swap! events conj (.-type ^js ev))))
            _ (.subscribe s (fn [_] (throw (js/Error. "boom"))))
            a (.record s (entry "a"))]
        (is (= (.-id ^js a) (.-id ^js (.update s (.-id ^js a) #js {:promptTokens 5}))))
        (is (undefined? (.update s "missing" #js {})))
        (off)
        (.record s (entry "b"))
        (is (= ["record" "update"] @events) "unsubscribed listeners stay silent; throwing ones are isolated"))
      (await (.close s))
      (is (undefined? (.update s "a" #js {})))
      (is (= 0 (.refreshDerivedEstimates s)))
      (is (thrown-with-msg? js/Error #"request log store is closed" (.record s (entry "z"))))
      (is (= 2 (count (ids s))))
      (finally (cleanup dir)))))

(deftest ^:async mirror-failures-are-throttled-and-never-fail-logging
  (let [dir (tmp-dir) file (path/join dir "r.jsonl")
        [warnings restore] (capture! "warn")
        mirror #js {:upsertEntry (fn [_] (js/Promise.reject (js/Error. "down")))
                    :close (fn [] (js/Promise.reject (js/Error. "close down")))}
        ^js s (store file :interval 1000000 :mirror mirror)]
    (try
      (await (.warmup s))
      (dotimes [i 12] (.record s (entry (str "e" i))))
      (await (.close s))
      (is (= ["mirror upsert failed (#1): down" "mirror upsert failed (#2): down" "mirror upsert failed (#3): down"
              "mirror upsert failed (#5): down" "mirror upsert failed (#10): down"]
             (mapv #(subs % (.indexOf % "mirror")) @warnings))
          "first three, the 5th and 10th; the close failure (#13) falls inside the minute")
      (finally (restore) (cleanup dir)))))

(deftest ^:async legacy-document-is-migrated
  (let [dir (tmp-dir) file (path/join dir "r.jsonl") legacy (path/join dir "r.json")
        _ (.writeFileSync fs legacy (js/JSON.stringify #js {:entries #js [(entry "a") (entry "b")]}))
        [infos restore] (capture! "info")
        ^js s (store file)]
    (try
      (await (.warmup s))
      (is (= ["a" "b"] (ids s)))
      (is (not (.existsSync fs legacy)))
      (is (some #(re-find #"^r\.json\.migrated-" %) (ls dir)))
      (is (= 2 (count (lines file))))
      (is (= 1 (count @infos)))
      (await (.close s))
      (finally (restore) (cleanup dir)))))

(deftest ^:async unparseable-legacy-document-is-quarantined
  (let [dir (tmp-dir) file (path/join dir "r.jsonl")
        _ (.writeFileSync fs file "{\"entries\": [")
        [warnings restore] (capture! "warn")
        ^js s (store file)]
    (try
      (await (.warmup s))
      (is (= [] (ids s)))
      (is (= "" (.readFileSync fs file "utf8")))
      (is (some #(re-find #"^r\.jsonl\.corrupt-" %) (ls dir)))
      (is (= 1 (count @warnings)))
      (await (.close s))
      (finally (restore) (cleanup dir)))))
