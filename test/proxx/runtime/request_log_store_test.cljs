(ns proxx.runtime.request-log-store-test
  (:require [cljs.test :refer [deftest is]]
            ["node:fs" :as fs]
            ["node:os" :as os]
            ["node:path" :as path]
            [proxx.runtime.pricing :as pricing]
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

;; ---- src/tests/request-log-store.test.ts: the store with the real pricing estimator -----------
;; (the TypeScript class is a thin shell over exactly this kernel, estimating with the
;; policy-manifest pricing index at 1800 mL/kWh water use efficiency)

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")

(defn- real-estimate [provider-id model prompt-tokens completion-tokens]
  (pricing/estimate-request-cost-js manifest provider-id model prompt-tokens completion-tokens 1800))

(defn- real-store [file & {:keys [max interval mirror]}]
  (rl/create-request-log-store-js
   #js {:filePath file :maxEntries (or max 100) :persistIntervalMs (or interval 1000) :mirror mirror
        :estimate real-estimate}))

(defn- ^:async with-temp-dir [f]
  (let [dir (.mkdtempSync fs (path/join (.tmpdir os) "request-log-store-test-"))]
    (try (await (f dir))
         (finally (cleanup dir)))))

(defn- parse-jsonl [file]
  (mapv #(js->clj (js/JSON.parse %)) (lines file)))

(defn- record-input [m] (clj->js (merge {"providerId" "openai" "accountId" "acct-1" "authType" "oauth_bearer"
                                         "model" "gpt-5.4" "upstreamMode" "responses" "upstreamPath" "/v1/responses"
                                         "status" 200 "latencyMs" 100}
                                        m)))

(defn- entry-with [m] (merge {"id" "entry-1" "providerId" "openai" "accountId" "acct-1" "authType" "oauth_bearer"
                              "model" "gpt-5.4" "upstreamMode" "responses" "upstreamPath" "/v1/responses"
                              "status" 200 "latencyMs" 250}
                             m))

(defn- legacy-payload [entries]
  {"entries" entries "hourlyBuckets" [] "dailyBuckets" [] "dailyModelBuckets" []
   "dailyAccountBuckets" [] "accountAccumulators" []})

(defn- snapshot-of [^js s] (js->clj (.snapshot s)))
(defn- n [x] (or x 0))

(deftest ^:async ts-warmup-quarantines-a-corrupted-legacy-request-log-file-and-starts-empty
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             corrupt-json "{\n  \"entries\": [\n    {\n      \"id\": \"entry-1\",\n      \"timestamp\": 1773701127508,\n      \"providerId\": \"openai\",\n      \"accountId\": \"acct-1\",\n      \"authType\": \"api_key\",\n      \"model\": \"gpt-5.4\",\n      \"upstreamMode\": \"responses\",\n      \"upstreamPath\": \"/v1/responses\",\n      \"status\": 200,\n      \"latencyMs\": 125,\n      \"pro"
             _ (.writeFileSync fs file corrupt-json "utf8")
             ^js store (real-store file :interval 1000)
             [_ restore] (capture! "warn")]
         (try
           (await (.warmup store))
           (is (= [] (snapshot-of store)))
           (is (= "" (.readFileSync fs file "utf8")))
           (let [corrupt-name (first (filter #(.startsWith % "request-logs.jsonl.corrupt-") (ls dir)))]
             (is (some? corrupt-name))
             (is (= corrupt-json (.readFileSync fs (path/join dir corrupt-name) "utf8"))))
           (await (.close store))
           (finally (restore))))))))

(deftest ^:async ts-warmup-migrates-a-legacy-request-logs-json-file-into-jsonl
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             legacy (path/join dir "request-logs.json")
             [_ restore] (capture! "info")]
         (.writeFileSync fs legacy
                         (js/JSON.stringify
                          (clj->js (legacy-payload [(entry-with {"timestamp" 1773701127508 "latencyMs" 125 "authType" "api_key"
                                                                 "totalTokens" 20})]))
                          nil 2)
                         "utf8")
         (let [^js store (real-store file :interval 1000)]
           (try
             (await (.warmup store))
             (let [entries (snapshot-of store)]
               (is (= 1 (count entries)))
               (is (= "openai" (get-in entries [0 "providerId"]))))
             (let [migrated (parse-jsonl file)]
               (is (= 1 (count migrated)))
               (is (= "openai" (get-in migrated [0 "providerId"]))))
             (let [files (ls dir)]
               (is (not (some #{"request-logs.json"} files)))
               (is (some #(.startsWith % "request-logs.json.migrated-") files)))
             (await (.close store))
             (finally (restore)))))))))

(deftest ^:async ts-persistence-reloads-cleanly-without-leaving-temp-files-behind
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             ^js store (real-store file :interval 1000)]
         (await (.warmup store))
         (.record store (record-input {"authType" "api_key" "latencyMs" 125 "promptTokens" 12 "completionTokens" 8
                                       "totalTokens" 20}))
         (await (.close store))
         (is (not (some #(.endsWith % ".tmp") (ls dir))))
         (let [^js reloaded (real-store file :interval 1000)]
           (await (.warmup reloaded))
           (let [entries (snapshot-of reloaded)]
             (is (= 1 (count entries)))
             (is (= "openai" (get-in entries [0 "providerId"])))
             (is (= "acct-1" (get-in entries [0 "accountId"])))
             (is (= "gpt-5.4" (get-in entries [0 "model"])))
             (is (= 20 (get-in entries [0 "totalTokens"]))))
           (await (.close reloaded))))))))

(deftest ^:async ts-close-flushes-batched-writes
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             ^js store (real-store file :interval 60000)]
         (await (.warmup store))
         (.record store (record-input {"providerId" "factory" "model" "claude-opus-4-6" "upstreamMode" "messages"
                                       "upstreamPath" "/api/llm/a/v1/messages" "latencyMs" 220}))
         (.record store (record-input {"accountId" "acct-2" "latencyMs" 180}))
         (await (.close store))
         (let [persisted (parse-jsonl file)]
           (is (= 2 (count persisted)))
           (is (= "factory" (get-in persisted [0 "providerId"])))
           (is (= "gpt-5.4" (get-in persisted [1 "model"])))))))))

(deftest ^:async ts-reports-mirror-failures-during-upsert-and-close
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             [warnings restore] (capture! "warn")]
         (try
           (let [^js store (real-store file :interval 0
                                       :mirror #js {:upsertEntry (fn [_] (js/Promise.reject (js/Error. "mirror-upsert-failed")))
                                                    :close (fn [] (js/Promise.reject (js/Error. "mirror-close-failed")))})]
             (await (.warmup store))
             (.record store (record-input {"authType" "api_key" "latencyMs" 125}))
             (await (.close store)))
           (finally (restore)))
         (is (some #(and (.includes % "mirror upsert failed") (.includes % "mirror-upsert-failed")) @warnings))
         (is (some #(and (.includes % "mirror close failed") (.includes % "mirror-close-failed")) @warnings)))))))

(deftest ^:async ts-preserves-upstream-error-summaries-and-factory-diagnostics
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             ^js store (real-store file :interval 1000)]
         (await (.warmup store))
         (.record store (record-input
                         {"providerId" "factory" "accountId" "acct-factory" "upstreamMode" "responses_passthrough"
                          "upstreamPath" "/api/llm/o/v1/responses" "status" 403 "latencyMs" 812
                          "error" "Prompt rejected by upstream policy" "upstreamErrorCode" "policy_violation"
                          "upstreamErrorType" "invalid_request_error"
                          "upstreamErrorMessage" "Prompt rejected by upstream policy"
                          "factoryDiagnostics" {"requestFormat" "responses" "promptCacheKeyHash" "sha256:1234567890ab"
                                                "inputItemCount" 2 "messageCount" 1 "userMessageCount" 1
                                                "hasInstructions" true "instructionsChars" 128 "totalTextChars" 1024
                                                "maxTextBlockChars" 768 "hasReasoning" true "hasCodeFence" true
                                                "hasXmlLikeTags" true "hasOpencodeMarkers" true
                                                "hasAgentProtocolMarkers" true "textFingerprint" "sha256:abcdef123456"
                                                "instructionsFingerprint" "sha256:fedcba654321"}}))
         (await (.close store))
         (let [^js reloaded (real-store file :interval 1000)]
           (await (.warmup reloaded))
           (let [entries (snapshot-of reloaded)
                 entry (first entries)
                 diagnostics (get entry "factoryDiagnostics")]
             (is (= 1 (count entries)))
             (is (some? entry))
             (is (= "policy_violation" (get entry "upstreamErrorCode")))
             (is (= "invalid_request_error" (get entry "upstreamErrorType")))
             (is (= "Prompt rejected by upstream policy" (get entry "upstreamErrorMessage")))
             (is (some? diagnostics))
             (is (= "responses" (get diagnostics "requestFormat")))
             (is (= "sha256:1234567890ab" (get diagnostics "promptCacheKeyHash")))
             (is (true? (get diagnostics "hasOpencodeMarkers")))
             (is (true? (get diagnostics "hasAgentProtocolMarkers")))
             (is (= "sha256:abcdef123456" (get diagnostics "textFingerprint"))))
           (await (.close reloaded))))))))

(def ^:private march-16 (js/Date.UTC 2026 2 16 23 15 0))
(def ^:private march-16-midnight (js/Date.UTC 2026 2 16 0 0 0))

(deftest ^:async ts-warmup-backfills-missing-derived-estimates-and-persists-daily-model-account-buckets
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")]
         (.writeFileSync fs file
                         (js/JSON.stringify
                          (clj->js (legacy-payload [(entry-with {"timestamp" march-16 "promptTokens" 1000 "completionTokens" 200
                                                                 "totalTokens" 1200 "costUsd" 0 "energyJoules" 0
                                                                 "waterEvaporatedMl" 0})]))
                          nil 2)
                         "utf8")
         (let [^js store (real-store file :interval 1000)]
           (await (.warmup store))
           (let [entries (snapshot-of store)]
             (is (= 1 (count entries)))
             (is (> (n (get-in entries [0 "costUsd"])) 0))
             (is (> (n (get-in entries [0 "energyJoules"])) 0))
             (is (> (n (get-in entries [0 "waterEvaporatedMl"])) 0)))
           (let [buckets (js->clj (.dailyModelBuckets store))]
             (is (= 1 (count buckets)))
             (is (= "openai" (get-in buckets [0 "providerId"])))
             (is (= "gpt-5.4" (get-in buckets [0 "model"])))
             (is (= 1200 (get-in buckets [0 "totalTokens"])))
             (is (> (n (get-in buckets [0 "costUsd"])) 0)))
           (let [buckets (js->clj (.dailyAccountBuckets store))]
             (is (= 1 (count buckets)))
             (is (= "openai" (get-in buckets [0 "providerId"])))
             (is (= "acct-1" (get-in buckets [0 "accountId"])))
             (is (= 1200 (get-in buckets [0 "totalTokens"])))
             (is (> (n (get-in buckets [0 "costUsd"])) 0)))
           (let [coverage (js->clj (.coverage store))]
             (is (= march-16-midnight (get coverage "earliestModelBreakdownAtMs")))
             (is (= march-16-midnight (get coverage "earliestAccountBreakdownAtMs"))))
           (await (.close store))))))))

(deftest ^:async ts-warmup-backfills-missing-cost-even-when-energy-water-estimates-are-present
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")]
         (.writeFileSync fs file
                         (js/JSON.stringify
                          (clj->js (legacy-payload [(entry-with {"timestamp" march-16 "promptTokens" 1000 "completionTokens" 200
                                                                 "totalTokens" 1200 "costUsd" 0 "energyJoules" 50
                                                                 "waterEvaporatedMl" 0.025})]))
                          nil 2)
                         "utf8")
         (let [^js store (real-store file :interval 1000)]
           (await (.warmup store))
           (let [entries (snapshot-of store)]
             (is (= 1 (count entries)))
             (is (> (n (get-in entries [0 "costUsd"])) 0) "costUsd should be backfilled from default pricing")
             (is (= 50 (get-in entries [0 "energyJoules"])) "energyJoules should remain unchanged")
             (is (= 0.025 (get-in entries [0 "waterEvaporatedMl"])) "waterEvaporatedMl should remain unchanged"))
           (await (.close store))))))))

(deftest ^:async ts-tracks-tenant-usage-attribution-separately
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             ^js store (real-store file :interval 1000)]
         (await (.warmup store))
         (.record store (record-input {"tenantId" "acme" "issuer" "local" "keyId" "key-acme" "totalTokens" 50}))
         (.record store (record-input {"tenantId" "beta" "issuer" "local" "keyId" "key-beta" "latencyMs" 120
                                       "totalTokens" 70}))
         (let [acme (js->clj (.list store #js {"tenantId" "acme"}))]
           (is (= 1 (count acme)))
           (is (= "key-acme" (get-in acme [0 "keyId"]))))
         (let [buckets (js->clj (.dailyAccountBuckets store))
               has? (fn [tenant key tokens]
                      (some #(and (= tenant (get % "tenantId")) (= key (get % "keyId")) (= tokens (get % "totalTokens"))) buckets))]
           (is (= 2 (count buckets)))
           (is (has? "acme" "key-acme" 50))
           (is (has? "beta" "key-beta" 70)))
         (let [accumulators (js->clj (.accountAccumulators store))
               has? (fn [tenant key tokens]
                      (some #(and (= tenant (get % "tenantId")) (= key (get % "keyId")) (= tokens (get % "totalTokens"))) accumulators))]
           (is (= 2 (count accumulators)))
           (is (has? "acme" "key-acme" 50))
           (is (has? "beta" "key-beta" 70)))
         (await (.close store))
         (let [persisted (parse-jsonl file)]
           (is (= 2 (count persisted)))
           (is (= "acme" (get-in persisted [0 "tenantId"])))
           (is (= "beta" (get-in persisted [1 "tenantId"])))))))))

(deftest ^:async ts-mirrors-records-and-updates-into-the-shared-usage-sink
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             mirrored (atom [])
             ^js store (real-store file :interval 60000
                                   :mirror #js {:upsertEntry (fn [entry]
                                                               (swap! mirrored conj (js->clj (js/Object.assign #js {} entry)))
                                                               (js/Promise.resolve nil))})]
         (await (.warmup store))
         (let [^js entry (.record store (record-input {"accountId" "acct-shared" "latencyMs" 150}))]
           (.update store (.-id entry) #js {"promptTokens" 21 "completionTokens" 21 "totalTokens" 42 "cacheHit" true})
           (await (.close store))
           (is (= 2 (count @mirrored)))
           (is (= (.-id entry) (get-in @mirrored [0 "id"])))
           (is (= (.-id entry) (get-in @mirrored [1 "id"])))
           (is (= 42 (get-in @mirrored [1 "totalTokens"])))
           (is (true? (get-in @mirrored [1 "cacheHit"])))))))))

(def ^:private april-4 (js/Date.UTC 2026 3 4 12 0 0))

(deftest ^:async ts-rollups-exclude-failed-prompt-cache-attempts-from-cache-counters
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             ^js store (real-store file :interval 1000)]
         (await (.warmup store))
         (.record store (record-input {"timestamp" april-4 "latencyMs" 120 "promptTokens" 800 "completionTokens" 200
                                       "totalTokens" 1000 "promptCacheKeyUsed" true "cacheHit" false
                                       "cachedPromptTokens" 0}))
         (.record store (record-input {"timestamp" (+ april-4 5000) "latencyMs" 110 "promptTokens" 700
                                       "completionTokens" 300 "totalTokens" 1000 "promptCacheKeyUsed" true
                                       "cacheHit" true "cachedPromptTokens" 600}))
         (.record store (record-input {"timestamp" (+ april-4 10000) "status" 429 "latencyMs" 40
                                       "promptCacheKeyUsed" true "cacheHit" false "error" "rate limit"}))
         (doseq [[label rows] [["hourly" (js->clj (.hourlyBuckets store))]
                               ["daily" (js->clj (.dailyBuckets store))]
                               ["daily model" (js->clj (.dailyModelBuckets store))]
                               ["daily account" (js->clj (.dailyAccountBuckets store))]
                               ["accumulators" (js->clj (.accountAccumulators store))]]]
           (is (= 1 (count rows)) label)
           (is (= 2 (get-in rows [0 "cacheKeyUseCount"])) label)
           (is (= 1 (get-in rows [0 "cacheHitCount"])) label))
         (await (.close store)))))))

(deftest ^:async ts-rollups-remove-cache-counters-when-an-updated-entry-becomes-an-error
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             ^js store (real-store file :interval 1000)]
         (await (.warmup store))
         (let [^js entry (.record store (record-input {"timestamp" (js/Date.UTC 2026 3 4 13 0 0) "latencyMs" 120
                                                       "promptCacheKeyUsed" true "cacheHit" true
                                                       "cachedPromptTokens" 500 "promptTokens" 700
                                                       "completionTokens" 300 "totalTokens" 1000}))]
           (.update store (.-id entry) #js {"error" "late upstream failure classification"}))
         (doseq [[label rows] [["hourly" (js->clj (.hourlyBuckets store))]
                               ["daily model" (js->clj (.dailyModelBuckets store))]
                               ["accumulators" (js->clj (.accountAccumulators store))]]]
           (is (= 1 (count rows)) label)
           (is (= 0 (get-in rows [0 "cacheKeyUseCount"])) label)
           (is (= 0 (get-in rows [0 "cacheHitCount"])) label))
         (await (.close store)))))))

(deftest ^:async ts-can-reprice-token-usage-after-live-pricing-refresh
  (await
   (with-temp-dir
     (fn ^:async run [dir]
       (let [file (path/join dir "request-logs.jsonl")
             ^js store (real-store file :interval 1000)]
         (await (.warmup store))
         (.record store (record-input {"providerId" "freshprovider" "authType" "api_key" "model" "fresh-model-2026"
                                       "upstreamMode" "chat_completions" "upstreamPath" "/v1/chat/completions"
                                       "promptTokens" 1000 "completionTokens" 1000 "totalTokens" 2000}))
         (is (undefined? (aget (aget (.snapshot store) 0) "costUsd")))
         (await (pricing/refresh-models-dev-pricing-index-js
                 manifest
                 #js {"sourceUrl" "https://example.test/models-dev-api.json"
                      "fetchFn" (fn [] (js/Promise.resolve
                                        (js/Response. (js/JSON.stringify
                                                       #js {"freshprovider" #js {"models" #js {"fresh-model-2026" #js {"cost" #js {"input" 0.25 "output" 0.75}}}}})
                                                      #js {"status" 200})))
                      "timeoutMs" 1000}))
         (is (= 1 (.refreshDerivedEstimates store)))
         (is (= 0.001 (aget (aget (.snapshot store) 0) "costUsd")))
         (is (= 0.001 (aget (aget (.hourlyBuckets store) 0) "costUsd")))
         (await (.close store)))))))
