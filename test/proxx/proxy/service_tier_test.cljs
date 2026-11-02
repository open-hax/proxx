(ns proxx.proxy.service-tier-test
  "Port of the service-tier / fast-mode tests of src/tests/proxy.test.ts (end to end through the application)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-b :as h :refer [with-proxy-app]]))

(defn- responses-reply [id output]
  (h/json-reply 200 {:id id :object "response" :created_at 1772516800 :model "gpt-5.3-codex" :output output}))

(defn- ^:async latest-request-log [app]
  (let [response (await (h/inject app {:method "GET" :url "/api/v1/request-logs?limit=1"}))]
    (is (= 200 (:status response)))
    (is (vector? (get-in response [:json :entries])))
    (first (get-in response [:json :entries]))))

(defn- ^:async service-tier-summary [app]
  (let [response (await (h/inject app {:method "GET" :url "/api/v1/dashboard/overview"}))]
    (is (= 200 (:status response)))
    (is (map? (get-in response [:json :summary :serviceTierRequests24h])))
    (get-in response [:json :summary :serviceTierRequests24h])))

(deftest ^:async applies-global-fast-mode-to-responses-requests-through-proxy-settings
  (let [observed-body (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler
        (fn [_ body]
          (reset! observed-body (h/parse-json body))
          (responses-reply "resp_fast_mode"
                           [{:id "msg_fast_mode" :type "message" :role "assistant"
                             :content [{:type "output_text" :text "fast-mode-ok"}]}]))}
       (fn ^:async body [{:keys [app]}]
         (let [settings (await (h/inject app {:method "POST" :url "/api/v1/settings" :headers h/json-headers
                                              :payload {:fastMode true}}))]
           (is (= 200 (:status settings))))
         (let [response (await (h/chat app (h/hello "gpt-5.3-codex")))]
           (is (= 200 (:status response)))
           (is (map? @observed-body))
           (is (= "priority" (:service_tier @observed-body)))
           (is (not (contains? @observed-body :open_hax))))
         (let [entry (await (latest-request-log app))]
           (is (map? entry))
           (is (= "priority" (:serviceTier entry)))
           (is (= "fast_mode" (:serviceTierSource entry))))
         (let [tiers (await (service-tier-summary app))]
           (is (= 1 (:fastMode tiers)))
           (is (= 0 (:priority tiers)))
           (is (= 0 (:standard tiers)))))))))

(deftest ^:async request-level-service-tier-overrides-global-fast-mode
  (let [observed-body (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler
        (fn [_ body]
          (reset! observed-body (h/parse-json body))
          (responses-reply "resp_service_tier_override" []))}
       (fn ^:async body [{:keys [app]}]
         (await (h/inject app {:method "POST" :url "/api/v1/settings" :headers h/json-headers
                               :payload {:fastMode true}}))
         (let [response (await (h/chat app (h/hello "gpt-5.3-codex" {:service_tier "default"})))]
           (is (= 200 (:status response)))
           (is (map? @observed-body))
           (is (= "default" (:service_tier @observed-body))))
         (let [entry (await (latest-request-log app))]
           (is (map? entry))
           (is (= "default" (:serviceTier entry)))
           (is (= "explicit" (:serviceTierSource entry))))
         (let [tiers (await (service-tier-summary app))]
           (is (= 0 (:fastMode tiers)))
           (is (= 0 (:priority tiers)))
           (is (= 1 (:standard tiers)))))))))

(deftest ^:async does-not-tag-non-responses-requests-with-a-service-tier
  (let [observed-body (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler
        (fn [_ body]
          (reset! observed-body (h/parse-json body))
          (h/json-reply 200 {:id "chatcmpl_non_responses_tier" :object "chat.completion" :created 1772516801
                             :model "claude-3-7-sonnet"
                             :choices [{:index 0 :message {:role "assistant" :content "ok"} :finish_reason "stop"}]}))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "claude-3-7-sonnet") {"x-open-hax-fast-mode" "true"}))]
           (is (= 200 (:status response)))
           (is (map? @observed-body))
           (is (not (contains? @observed-body :service_tier))))
         (let [entry (await (latest-request-log app))]
           (is (map? entry))
           (is (not (contains? entry :serviceTier)))
           (is (= "none" (:serviceTierSource entry)))))))))
