(ns proxx.runtime.usage-store-test
  (:require [cljs.test :refer [deftest is async]]
            [proxx.runtime.usage-store :as store]))

(defn- fake-sql
  "Records `.unsafe` as [:unsafe text values] and tagged templates as [:tpl strings values]."
  [calls rows-for]
  (let [sql (fn [strings & values] (swap! calls conj [:tpl (vec strings) (vec values)]) (js/Promise.resolve #js []))]
    (aset sql "unsafe" (fn [text values]
                         (swap! calls conj [:unsafe text (some-> values vec)])
                         (js/Promise.resolve (to-array (rows-for text)))))
    sql))

(deftest unknown-cursor-means-empty-page
  (async done
    (let [calls (atom [])
          ^js s (store/create-sql-request-usage-store-js (fake-sql calls (fn [_] [])))]
      (-> (.listEntries s #js {"before" "gone"})
          (.then (fn [entries]
                   (is (= 0 (.-length entries)))
                   (is (= 1 (count @calls)) "only the cursor lookup ran")
                   (is (= [:unsafe "SELECT id, timestamp_ms FROM request_usage_entries WHERE id = $1 LIMIT 1" ["gone"]]
                          (first @calls)))
                   (done)))))))

(deftest cursor-then-page
  (async done
    (let [calls (atom [])
          rows-for (fn [text] (if (.includes text "WHERE id = $1 LIMIT 1") [#js {"id" "c" "timestamp_ms" "5"}] []))
          ^js s (store/create-sql-request-usage-store-js (fake-sql calls rows-for))]
      (-> (.listEntries s #js {"before" "c" "limit" 3})
          (.then (fn [_]
                   (is (= 2 (count @calls)))
                   (let [[_ text values] (second @calls)]
                     (is (.includes text "request_usage_entries"))
                     (is (some #{5} values) "the cursor's timestamp parameterises the page"))
                   (done)))))))

(deftest upsert-is-a-tagged-template
  (async done
    (let [calls (atom [])
          ^js s (store/create-sql-request-usage-store-js (fake-sql calls (fn [_] [])))]
      (-> (.upsertEntry s #js {"id" "e1" "timestamp" 1 "routeKind" "local" "providerId" "p" "accountId" "a"
                               "authType" "api_key" "model" "m" "upstreamMode" "chat" "upstreamPath" "/x"
                               "status" 200 "latencyMs" 3 "serviceTierSource" "default"})
          (.then (fn [_]
                   (let [[kind strings values] (first @calls)]
                     (is (= :tpl kind))
                     (is (= (dec (count strings)) (count values)) "one value per hole")
                     (is (some #{"e1"} values)))
                   (done)))))))
