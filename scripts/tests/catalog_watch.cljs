;; SPDX-License-Identifier: GPL-3.0-or-later
(ns tests.catalog-watch
  (:require [cljs.reader :as reader]
            [promesa.core :as p]
            [proxx.policy.catalog-watch :as watch]
            [proxx.policy.model-availability :as availability]
            ["node:fs" :as fs]
            ["node:os" :as os]
            ["node:path" :as path]
            ["node:http" :as http]
            ["node:child_process" :as child]))

(def failures (atom []))
(def assertions (atom 0))
(def temporary-directory (atom nil))
(defn check [label pass?]
  (swap! assertions inc)
  (when-not pass? (swap! failures conj label)))
(def state (atom {:status 200 :body {:object "list" :data [{:id "alias" :target_id "version-1" :context_length 262144
                                                         :created 100 :name "Test alias" :reasoning {:type "only" :effort {:default "high" :valid ["low" "high"]}}
                                                         :modalities {:input ["text" "image"] :output ["text"]}}
                                                        {:id "removed"}]}}))
(def requests (atom 0))
(def key-value "fixture-secret-value-for-read-only-tests")
(def server
  (http/createServer
   (fn [request response]
     (swap! requests inc)
     (check "authenticated request" (= (str "Bearer " key-value) (aget (.-headers request) "authorization")))
     (cond
       (:stream? @state)
       (let [{:keys [sent-bytes closed-early]} @state
             chunk (js/Buffer.alloc 65536 120)
             total-bytes 16777216
             timer (js/setInterval
                    (fn []
                      (when-not (.-destroyed response)
                        (.write response chunk)
                        (swap! sent-bytes + (.-byteLength chunk))
                        (when (>= @sent-bytes total-bytes)
                          (.end response)))) 1)]
         (.writeHead response 200 #js {"content-type" "application/json"})
         (.once response "close"
                (fn []
                  (js/clearInterval timer)
                  (reset! closed-early (< @sent-bytes total-bytes)))))
       (:hang? @state)
       (let [timer (js/setTimeout (fn [] (when-not (.-destroyed response)
                                           (.writeHead response 200 #js {"content-type" "application/json"})
                                           (.end response "{\"object\":\"list\",\"data\":[{\"id\":\"alias\"}]}"))) 2000)]
         (.once response "close" #(js/clearTimeout timer)))
       :else
       (do (.writeHead response (:status @state) #js {"content-type" "application/json"})
           (.end response (js/JSON.stringify (clj->js (:body @state)))))))))

(defn ^:async run-cli! [config-file extra-args]
  (p/create
   (fn [resolve reject]
     (let [process (child/spawn "nbb" (clj->js (concat ["-cp" "src" "scripts/watch_model_catalogs.cljs" config-file "--allow-loopback"] extra-args))
                                #js {:env #js {:PATH (aget (.-env js/process) "PATH")
                                             :TEST_CATALOG_KEY key-value}})
           output (atom "")]
       (.on (.-stdout process) "data" #(swap! output str %))
       (.on (.-stderr process) "data" #(swap! output str %))
       (.on process "error" reject)
       (.on process "close" (fn [code] (resolve {:code code :output @output})))))))

(defn report [result]
  (check "CLI exits successfully" (zero? (:code result)))
  (check "no credential in CLI output" (not (.includes (:output result) key-value)))
  (let [summary (reader/read-string (:output result))
        raw (fs/readFileSync (:report-file summary) "utf8")]
    (check "no credential in report" (not (.includes raw key-value)))
    (reader/read-string raw)))

(defn assessment [r id] (first (filter #(= id (:model-id %)) (:assessments r))))

(defn ^:async rejection-cleanup! [temporary mode]
  (let [proof-file (path/join temporary (str "rejection-" mode ".json"))
        preload-file (path/join temporary "reject-fixture.cjs")]
    (fs/writeFileSync
     preload-file
     "const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const originalWrite = fs.writeFileSync, originalTemp = fs.mkdtempSync;
let temporary, closed = false;
function record() { originalWrite(process.env.CATALOG_WATCH_TEST_PROOF, JSON.stringify({temporary, closed})); }
fs.mkdtempSync = function(prefix, ...args) {
  const result = originalTemp.call(fs, prefix, ...args);
  if (String(prefix).includes('catalog-watch-test-')) { temporary = result; record(); }
  return result;
};
const originalClose = http.Server.prototype.close;
http.Server.prototype.close = function(...args) { closed = true; record(); return originalClose.apply(this, args); };
fs.writeFileSync = function(filename, ...args) {
  if (temporary && path.basename(String(filename)) === 'public.edn') throw new Error('Injected catalog watcher fixture rejection');
  return originalWrite.call(fs, filename, ...args);
};\n")
    (p/let [result
            (p/create
             (fn [resolve reject]
               (let [process (child/spawn "nbb" #js ["-cp" "src" "scripts/tests/catalog_watch.cljs"]
                                          #js {:env #js {:PATH (aget (.-env js/process) "PATH")
                                                       :NODE_OPTIONS (str "--require=" preload-file " --unhandled-rejections=" mode)
                                                       :CATALOG_WATCH_TEST_PROOF proof-file}})
                     output (atom "")
                     timed-out (atom false)
                     timer (js/setTimeout (fn [] (reset! timed-out true) (.kill process "SIGTERM")) 5000)]
                 (.on (.-stdout process) "data" #(swap! output str %))
                 (.on (.-stderr process) "data" #(swap! output str %))
                 (.once process "error" (fn [error] (js/clearTimeout timer) (reject error)))
                 (.once process "close" (fn [code]
                                           (js/clearTimeout timer)
                                           (resolve {:code code :timed-out? @timed-out :output @output}))))))]
      (let [proof (js->clj (js/JSON.parse (fs/readFileSync proof-file "utf8")) :keywordize-keys true)]
        (check (str mode " rejection exits nonzero without external termination")
               (and (= 1 (:code result)) (not (:timed-out? result))))
        (check (str mode " rejection closes the listening fixture server") (:closed proof))
        (check (str mode " rejection removes the fixture directory")
               (not (fs/existsSync (:temporary proof))))
        (check (str mode " rejection does not expose exception details")
               (not (.includes (:output result) "Injected catalog watcher fixture rejection")))
        ;; A failing regression still owns and removes its child fixture directory.
        (fs/rmSync (:temporary proof) #js {:recursive true :force true})))))

(defn ^:async cleanup! []
  (.closeAllConnections server)
  (-> (p/create (fn [resolve _reject]
                  (if (.-listening server)
                    (.close server #(resolve nil))
                    (resolve nil))))
      (p/finally #(when-let [directory @temporary-directory]
                    (fs/rmSync directory #js {:recursive true :force true})))))

;; Pure shape regression through the same projection the GET transport uses.
(let [unknown (get-in (watch/shape-catalog {:data [{:id "alias" :context_length 128}]}) [:models "alias"])
      known (get-in (watch/shape-catalog {:data [{:id "alias" :target_id "version-1" :context_length 128}]}) [:models "alias"])
      snapshot {:provider-id "fixture" :endpoint "https://provider.example/models" :scope "shape"
                :source-kind :provider-catalog :status :ok :complete? true :authoritative? true}
      before (assoc snapshot :observed-at-ms 1000 :models {"alias" unknown})
      after (assoc snapshot :observed-at-ms 1100 :models {"alias" known})]
  (check "pure shape leaves absent target unknown" (not (contains? unknown :target-id)))
  (check "pure shape cannot infer alias change from absent target"
         (empty? (:drift (availability/assess-model before after "alias" {:now-ms 1100 :max-age-ms 1000})))))

(-> (p/let [_ (p/create (fn [resolve reject]
                         (.once server "error" reject)
                         (.listen server 0 "127.0.0.1" resolve)))
        temporary (fs/mkdtempSync (path/join (os/tmpdir) "catalog-watch-test-"))
        _ (reset! temporary-directory temporary)
        config-file (path/join temporary "public.edn")
        baseline-file (path/join temporary "baseline.edn")
        registration-file (path/join temporary "registration.edn")
        config {:providers [{:provider-id "fixture" :scope "test-account"
                             :endpoint (str "http://127.0.0.1:" (.-port (.address server)) "/models")
                             :credential-env "TEST_CATALOG_KEY" :watch-models ["alias" "removed" "never-listed"]}]
                :max-age-ms 1000 :timeout-ms 500 :baseline-path baseline-file
                :registration-file registration-file :report-dir (path/join temporary "reports")}
        _ (fs/writeFileSync config-file (pr-str config))
        _ (fs/writeFileSync registration-file (pr-str {:observed-at-ms 1000 :models {"fixture" #{"alias"}}}))
        _ (rejection-cleanup! temporary "throw")
        _ (rejection-cleanup! temporary "warn")
        first-run (run-cli! config-file ["--now-ms" "1000"])
        first-report (report first-run)
        _ (check "first listing" (= :listed (:availability (assessment first-report "alias"))))
        _ (check "first absence is unlisted, not delisted" (= :unlisted (:availability (assessment first-report "never-listed"))))
        _ (check "registration is separate" (true? (get-in (assessment first-report "alias") [:runtime-registration :registered?])))
        _ (check "public reasoning controls captured" (= {:type "only" :effort {:default "high" :valid #{"low" "high"}}}
                                                         (get-in first-report [:observations 0 :models "alias" :capabilities :reasoning])))
        _ (check "public alias metadata captured" (= "Test alias" (get-in first-report [:observations 0 :models "alias" :capabilities :name])))
        _ (reset! state {:status 200 :body {:object "list" :data [{:id "alias" :target_id "version-2" :context_length 1048576 :created 200}]}})
        second-run (run-cli! config-file ["--now-ms" "1100"])
        second-report (report second-run)
        _ (check "second observation proves removal" (= :delisted (:availability (assessment second-report "removed"))))
        _ (check "alias and capability drift detected" (= #{:alias-target-changed :capabilities-changed} (:drift (assessment second-report "alias"))))
        _ (reset! state {:status 200 :body {:object "list" :data [{:id "alias" :target_id "version-2" :context_length 1048576 :created 300}]}})
        steady-run (run-cli! config-file ["--now-ms" "1150"])
        steady-report (report steady-run)
        _ (check "listing timestamp alone is not capability drift" (empty? (:drift (assessment steady-report "alias"))))
        good-baseline (fs/readFileSync baseline-file "utf8")
        _ (reset! state {:status 429 :body {:error {:message key-value}}})
        failure-run (run-cli! config-file ["--now-ms" "1200"])
        failure-report (report failure-run)
        _ (check "429 remains unknown" (every? #(= :unknown (:availability %)) (:assessments failure-report)))
        _ (check "last good baseline survives quota error" (= good-baseline (fs/readFileSync baseline-file "utf8")))
        _ (reset! state {:status 200 :body {:object "list" :data [] :has_more true :next_cursor "another-page"}})
        partial-run (run-cli! config-file ["--now-ms" "1300"])
        partial-report (report partial-run)
        _ (check "partial absence remains unknown" (= :unknown (:availability (assessment partial-report "alias"))))
        _ (check "partial catalog preserves baseline" (= good-baseline (fs/readFileSync baseline-file "utf8")))
        _ (reset! state {:status 200 :body {:object "list" :data [{:id "alias" :context_length 1048576 :api_key key-value}]}})
        reflected-run (run-cli! config-file ["--now-ms" "1400"])
        reflected-report (report reflected-run)
        _ (check "credential reflection rejects response" (= :unknown (:availability (assessment reflected-report "alias"))))
        _ (check "reflected credential preserves baseline" (= good-baseline (fs/readFileSync baseline-file "utf8")))
        _ (reset! state {:status 200 :body {:unexpected "not a catalog"}})
        malformed-run (run-cli! config-file ["--now-ms" "1500"])
        malformed-report (report malformed-run)
        _ (check "malformed response remains unknown" (= :unknown (:availability (assessment malformed-report "alias"))))
        _ (check "malformed response preserves baseline" (= good-baseline (fs/readFileSync baseline-file "utf8")))
        large-config-file (path/join temporary "large-body.edn")
        large-baseline-file (path/join temporary "large-baseline.edn")
        large-body {:data [{:id "alias"}] :padding (.repeat "😀" 550000)}
        large-json (js/JSON.stringify (clj->js large-body))
        _ (check "large UTF8 fixture exceeds two MiB but not two million characters"
                 (and (> (js/Buffer.byteLength large-json "utf8") 2097152)
                      (< (count large-json) 2097152)))
        _ (fs/writeFileSync large-config-file (pr-str (assoc config :baseline-path large-baseline-file)))
        _ (fs/writeFileSync large-baseline-file good-baseline)
        _ (reset! state {:status 200 :body large-body})
        large-run (run-cli! large-config-file ["--now-ms" "1550"])
        large-report (report large-run)
        _ (check "actual oversized UTF8 response is invalid"
                 (= :invalid-response (get-in large-report [:observations 0 :status])))
        _ (check "oversized UTF8 response cannot establish availability"
                 (every? #(= :unknown (:availability %)) (:assessments large-report)))
        _ (check "oversized UTF8 response preserves last good baseline"
                 (= good-baseline (fs/readFileSync large-baseline-file "utf8")))
        boundary-body {:data [{:id "alias"}] :padding ""}
        boundary-padding (.repeat "x" (- 2097152 (js/Buffer.byteLength (js/JSON.stringify (clj->js boundary-body)) "utf8")))
        boundary-body (assoc boundary-body :padding boundary-padding)
        _ (check "exact byte-limit fixture is two MiB"
                 (= 2097152 (js/Buffer.byteLength (js/JSON.stringify (clj->js boundary-body)) "utf8")))
        _ (reset! state {:status 200 :body boundary-body})
        boundary-run (run-cli! large-config-file ["--now-ms" "1560"])
        boundary-report (report boundary-run)
        _ (check "exact byte-limit response remains accepted"
                 (= :ok (get-in boundary-report [:observations 0 :status])))
        boundary-baseline (fs/readFileSync large-baseline-file "utf8")
        _ (reset! state {:status 200 :body (assoc boundary-body :padding (str boundary-padding "x"))})
        overflow-run (run-cli! large-config-file ["--now-ms" "1565"])
        overflow-report (report overflow-run)
        _ (check "one byte above the limit is invalid"
                 (= :invalid-response (get-in overflow-report [:observations 0 :status])))
        _ (check "one-byte overflow preserves last good baseline"
                 (= boundary-baseline (fs/readFileSync large-baseline-file "utf8")))
        sent-bytes (atom 0)
        closed-early (atom false)
        _ (reset! state {:stream? true :sent-bytes sent-bytes :closed-early closed-early})
        stream-run (run-cli! config-file ["--now-ms" "1575"])
        stream-report (report stream-run)
        _ (check "oversized chunked response is invalid"
                 (= :invalid-response (get-in stream-report [:observations 0 :status])))
        _ (check "oversized chunked response cancels before the tail" @closed-early)
        _ (check "chunked transport stops before a quarter of the full body"
                 (<= @sent-bytes 4194304))
        _ (check "oversized chunked response preserves last good baseline"
                 (= good-baseline (fs/readFileSync baseline-file "utf8")))
        _ (println (pr-str {:fixture :bounded-http-read
                            :utf8-bytes (js/Buffer.byteLength large-json "utf8")
                            :utf16-units (count large-json)
                            :chunked-bytes-sent @sent-bytes :cancelled-before-tail? @closed-early}))
        _ (reset! state {:status 200 :hang? true})
        timeout-run (run-cli! config-file ["--now-ms" "1600"])
        timeout-report (report timeout-run)
        _ (check "timeout remains unknown" (= :unknown (:availability (assessment timeout-report "alias"))))
        _ (check "timeout preserves baseline" (= good-baseline (fs/readFileSync baseline-file "utf8")))
        request-count @requests
        _ (fs/writeFileSync (path/join temporary "observations.edn")
                            (pr-str {:snapshots (:observations second-report)}))
        offline-run (run-cli! config-file ["--observations" (path/join temporary "observations.edn") "--now-ms" "9000"])
        offline-report (report offline-run)
        _ (check "stale supplied observations remain unknown" (= :unknown (:availability (assessment offline-report "alias"))))
        _ (check "stale registration remains separate unknown" (nil? (get-in (assessment offline-report "alias") [:runtime-registration :registered?])))
        _ (check "offline observations do not poll" (= request-count @requests))
        _ (fs/writeFileSync (path/join temporary "duplicate.edn")
                            (pr-str {:snapshots (vec (concat (:observations second-report) (:observations second-report)))}))
        duplicate-run (run-cli! config-file ["--observations" (path/join temporary "duplicate.edn") "--now-ms" "1200"])
        _ (check "duplicate observation scopes rejected" (= 2 (:code duplicate-run)))
        _ (check "duplicate scopes preserve baseline" (= good-baseline (fs/readFileSync baseline-file "utf8")))
        _ (fs/writeFileSync (path/join temporary "reflected.edn")
                            (pr-str {:snapshots [(assoc (first (:observations second-report)) :authorization key-value)]}))
        supplied-reflection (run-cli! config-file ["--observations" (path/join temporary "reflected.edn") "--now-ms" "1200"])
        _ (check "supplied credential reflection rejected" (= 2 (:code supplied-reflection)))
        _ (check "supplied reflection not echoed" (not (.includes (:output supplied-reflection) key-value)))
        _ (check "supplied reflection preserves baseline" (= good-baseline (fs/readFileSync baseline-file "utf8")))
        _ (fs/writeFileSync (path/join temporary "metadata.edn")
                            (pr-str {:snapshots [(assoc (first (:observations second-report)) :headers {:arbitrary "private-header"})]}))
        metadata-run (run-cli! config-file ["--observations" (path/join temporary "metadata.edn") "--now-ms" "1100"])
        metadata-report (report metadata-run)
        _ (check "supplied headers stripped" (not (.includes (pr-str metadata-report) "private-header")))
        negative-clock (run-cli! config-file ["--now-ms" "-1"])
        _ (check "invalid injected clock rejected" (= 2 (:code negative-clock)))
        _ (check "invalid clock does not poll" (= request-count @requests))
        _ (fs/writeFileSync (path/join temporary "missing-credential.edn")
                            (pr-str (assoc-in config [:providers 0 :credential-env] "ABSENT_TEST_CATALOG_KEY")))
        missing-credential-run (run-cli! (path/join temporary "missing-credential.edn") ["--now-ms" "1700"])
        missing-credential-report (report missing-credential-run)
        _ (check "missing credential is unknown" (= :unknown (:availability (assessment missing-credential-report "alias"))))
        _ (check "missing credential preserves baseline" (= good-baseline (fs/readFileSync baseline-file "utf8")))
        _ (check "missing credential does not poll" (= request-count @requests))
        _ (fs/writeFileSync (path/join temporary "inline-credential.edn") (pr-str (assoc config :api-key key-value)))
        inline-run (run-cli! (path/join temporary "inline-credential.edn") ["--now-ms" "1700"])
        _ (check "inline credential binding rejected" (= 2 (:code inline-run)))
        _ (check "inline credential not echoed" (not (.includes (:output inline-run) key-value)))
        _ (reset! state {:status 401 :body {:error {:message key-value}}})
        auth-run (run-cli! config-file ["--now-ms" "1800"])
        auth-report (report auth-run)
        _ (check "auth failure is unknown" (= :unknown (:availability (assessment auth-report "alias"))))
        _ (check "auth failure preserves baseline" (= good-baseline (fs/readFileSync baseline-file "utf8")))
        _ (check "live baseline snapshots carry collection provenance"
                 (every? #(= :authenticated-get (:collection-mode %))
                         (:snapshots (reader/read-string good-baseline))))
        replay-snapshot (assoc (first (:observations second-report)) :observed-at-ms 1900
                               :collection-mode :authenticated-get :models {})
        _ (fs/writeFileSync (path/join temporary "fresh-replay.edn") (pr-str {:snapshots [replay-snapshot]}))
        replay-count @requests
        replay-run (run-cli! config-file ["--observations" (path/join temporary "fresh-replay.edn") "--now-ms" "1900"])
        replay-report (report replay-run)
        _ (check "fresh supplied replay cannot delist from live history"
                 (not= :delisted (:availability (assessment replay-report "alias"))))
        _ (check "fresh supplied replay leaves live baseline byte-identical" (= good-baseline (fs/readFileSync baseline-file "utf8")))
        _ (check "supplied provenance cannot be spoofed in snapshot"
                 (= :supplied (get-in replay-report [:observations 0 :collection-mode])))
        _ (check "replay explicitly reports baseline unchanged" (false? (:baseline-updated? replay-report)))
        _ (check "fresh supplied replay makes no GET" (= replay-count @requests))
        replay-config-file (path/join temporary "replay-only.edn")
        replay-baseline (path/join temporary "must-not-create-live-baseline.edn")
        _ (fs/writeFileSync replay-config-file (pr-str (assoc config :baseline-path replay-baseline)))
        replay-only (run-cli! replay-config-file ["--observations" (path/join temporary "fresh-replay.edn") "--now-ms" "1900"])
        _ (report replay-only)
        _ (check "supplied replay cannot create authenticated baseline" (not (fs/existsSync replay-baseline)))
        _ (fs/writeFileSync replay-baseline "not-valid-edn[")
        unread-baseline-run (run-cli! replay-config-file ["--observations" (path/join temporary "fresh-replay.edn") "--now-ms" "1900"])
        _ (report unread-baseline-run)
        _ (check "replay does not read or rewrite live storage" (= "not-valid-edn[" (fs/readFileSync replay-baseline "utf8")))
        target-config-file (path/join temporary "target-shape.edn")
        _ (fs/writeFileSync target-config-file (pr-str (assoc config :baseline-path (path/join temporary "target-baseline.edn"))))
        _ (reset! state {:status 200 :body {:data [{:id "alias" :context_length 128}]}})
        target-unknown-run (run-cli! target-config-file ["--now-ms" "1000"])
        target-unknown-report (report target-unknown-run)
        _ (check "actual GET leaves target unknown" (not (contains? (get-in target-unknown-report [:observations 0 :models "alias"]) :target-id)))
        _ (reset! state {:status 200 :body {:data [{:id "alias" :target_id "version-1" :context_length 128}]}})
        target-known-run (run-cli! target-config-file ["--now-ms" "1100"])
        target-known-report (report target-known-run)
        _ (check "actual GET unknown to explicit target is not alias change" (empty? (:drift (assessment target-known-report "alias"))))
        _ (reset! state {:status 200 :body {:data [{:id "alias" :target_id "version-2" :context_length 128}]}})
        target-changed-run (run-cli! target-config-file ["--now-ms" "1200"])
        target-changed-report (report target-changed-run)
        _ (check "two actual explicit targets establish alias change" (= #{:alias-target-changed} (:drift (assessment target-changed-report "alias"))))
        legacy-config-file (path/join temporary "legacy.edn")
        legacy-baseline (path/join temporary "legacy-baseline.edn")
        legacy-snapshot (dissoc (first (:observations target-changed-report)) :collection-mode)
        _ (fs/writeFileSync legacy-config-file (pr-str (assoc config :baseline-path legacy-baseline)))
        _ (fs/writeFileSync legacy-baseline (pr-str {:snapshots [legacy-snapshot]}))
        _ (reset! state {:status 200 :body {:data []}})
        legacy-run (run-cli! legacy-config-file ["--now-ms" "2000"])
        legacy-report (report legacy-run)
        _ (check "untagged legacy baseline cannot establish authenticated removal"
                 (= :unlisted (:availability (assessment legacy-report "alias"))))
        _ (check "fresh GET establishes tagged replacement, not legacy promotion"
                 (= :authenticated-get (get-in (reader/read-string (fs/readFileSync legacy-baseline "utf8")) [:snapshots 0 :collection-mode])))]
  (println (str "Catalog watcher: " @assertions " assertions; " (count @failures) " failures."))
  (doseq [label @failures] (println "FAIL:" label))
  (when (seq @failures) (set! (.-exitCode js/process) 1)))
    (p/catch (fn [_error]
               (println "Catalog watcher integration failed; no exception detail emitted.")
               (set! (.-exitCode js/process) 1)))
    (p/finally cleanup!))
