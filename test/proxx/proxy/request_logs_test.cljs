(ns proxx.proxy.request-logs-test
  "Request logs written through the whole application, and the dashboard
  surfaces that read them back."
  (:require ["node:fs/promises" :as fsp]
            ["node:path" :as path]
            [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.proxy.support :as s]))

(defn- ^:async read-request-logs
  "The request log file once it mentions `needle` (the application persists
  asynchronously), polling at most 20 times; the last text read otherwise."
  [temp-dir needle]
  (loop [attempt 0 text ""]
    (let [text (try (await (.readFile fsp (.join path temp-dir "request-logs.jsonl") "utf8"))
                    (catch :default _ text))]
      (if (or (str/includes? text needle) (>= (inc attempt) 20))
        text
        (do (await (s/sleep 10))
            (recur (inc attempt) text))))))

(deftest ^:async persists-request-logs-with-usage-counts-for-dashboard-surfaces
  (let [request-logs-json (atom "")]
    (await
     (s/with-proxy-app
       {:keys ["key-a"]
        :upstream-handler
        (fn [_ _]
          (s/json-response
           200
           (s/response-output {:id "resp_usage_dashboard" :message-id "msg_usage_dashboard"
                               :model "gpt-5.3-codex" :created-at 1772516812
                               :text "dashboard-usage-ok"
                               :usage {"input_tokens" 15 "output_tokens" 9 "total_tokens" 24}})))}
       (fn ^:async run [{:keys [app temp-dir]}]
         (let [response (await (s/post-json app "/v1/chat/completions"
                                            {"model" "gpt-5.3-codex"
                                             "messages" [{"role" "user" "content" "hello"}]
                                             "stream" false}))]
           (is (= 200 (:status response))))
         (reset! request-logs-json (await (read-request-logs temp-dir "gpt-5.3-codex")))
         (let [overview (await (s/inject app {:method "GET" :url "/api/v1/dashboard/overview"}))
               payload (:json overview)
               tiers (get-in payload ["summary" "serviceTierRequests24h"])]
           (is (= 200 (:status overview)))
           (is (map? payload))
           (is (map? (get payload "summary")))
           (is (map? tiers))
           (is (= 0 (get tiers "fastMode")))
           (is (= 0 (get tiers "priority")))
           (is (= 1 (get tiers "standard"))))
         (let [weekly (await (s/inject app {:method "GET" :url "/api/v1/dashboard/overview?window=weekly"}))
               payload (:json weekly)]
           (is (= 200 (:status weekly)))
           (is (map? payload))
           (is (= "weekly" (get payload "window")))
           (is (map? (get payload "summary")))
           (is (= 1 (get-in payload ["summary" "requests24h"])))))))
    (is (pos? (count @request-logs-json)))
    (let [parsed (->> (str/split @request-logs-json #"\r?\n")
                      (remove (comp str/blank?))
                      (mapv s/parse-json))
          ;; the log is append-only: a request appears once per state, the last wins
          latest (reduce (fn [acc entry]
                           (is (map? entry))
                           (is (string? (get entry "id")) "expected request log entry to include an id")
                           (assoc acc (get entry "id") entry))
                         {} parsed)
          entry (first (vals latest))]
      (is (= 1 (count latest)))
      (is (some? entry))
      (is (= "gpt-5.3-codex" (get entry "model")))
      (is (not (contains? entry "serviceTier")))
      (is (= "none" (get entry "serviceTierSource")))
      (is (= 15 (get entry "promptTokens")))
      (is (= 9 (get entry "completionTokens")))
      (is (= 24 (get entry "totalTokens"))))))
