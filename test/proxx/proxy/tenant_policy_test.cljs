(ns proxx.proxy.tenant-policy-test
  "Port of the tenant policy tests of src/tests/proxy.test.ts: request quota and provider
  allow/deny lists (end to end through the application)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-b :as h :refer [with-proxy-app]]))

(def ^:private admin {"authorization" "Bearer tenant-admin-token"})

(defn- ^:async set-settings! [app payload]
  (await (h/inject app {:method "POST" :url "/api/v1/settings"
                        :headers (merge admin h/json-headers) :payload payload})))

(deftest ^:async tenant-requests-per-minute-quota-blocks-excess-requests
  (let [upstream-call-count (atom 0)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :proxy-auth-token "tenant-admin-token"
        :upstream-handler
        (fn [_ _]
          (let [n (swap! upstream-call-count inc)]
            (h/json-reply 200 {:id (str "resp_quota_" n) :object "response" :created_at 1772516800
                               :model "gpt-5.3-codex" :output []})))}
       (fn ^:async body [{:keys [app]}]
         (is (= 200 (:status (await (set-settings! app {:requestsPerMinute 1})))))
         (let [first-r (await (h/chat app {:model "gpt-5.3-codex" :messages [{:role "user" :content "hello once"}] :stream false} admin))]
           (is (= 200 (:status first-r))))
         (let [second-r (await (h/chat app {:model "gpt-5.3-codex" :messages [{:role "user" :content "hello twice"}] :stream false} admin))]
           (is (= 429 (:status second-r)))
           (is (= "tenant_quota_exceeded" (get-in second-r [:headers "x-open-hax-error-code"])))
           (is (= "60" (get-in second-r [:headers "retry-after"])))
           (is (= 1 @upstream-call-count))))))))

(deftest ^:async tenant-allowed-provider-ids-blocks-disallowed-upstream-providers
  (let [upstream-call-count (atom 0)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :proxy-auth-token "tenant-admin-token"
        :upstream-handler
        (fn [_ _]
          (let [n (swap! upstream-call-count inc)]
            (h/json-reply 200 {:id (str "resp_provider_policy_" n) :object "response" :created_at 1772516800
                               :model "gpt-5.3-codex" :output []})))}
       (fn ^:async body [{:keys [app]}]
         (is (= 200 (:status (await (set-settings! app {:allowedProviderIds ["openai"]})))))
         (let [response (await (h/chat app {:model "factory/gpt-5.3-codex" :messages [{:role "user" :content "blocked"}] :stream false} admin))]
           (is (= 403 (:status response)))
           (is (= "provider_not_allowed" (get-in response [:headers "x-open-hax-error-code"])))
           (is (= 0 @upstream-call-count))))))))

(deftest ^:async tenant-disabled-provider-ids-blocks-local-ollama-usage
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :proxy-auth-token "tenant-admin-token"
      :upstream-handler (fn [_ _] (throw (js/Error. "upstream should not be called")))}
     (fn ^:async body [{:keys [app]}]
       (is (= 200 (:status (await (set-settings! app {:disabledProviderIds ["ollama"]})))))
       (let [response (await (h/inject app {:method "POST" :url "/v1/embeddings"
                                            :headers (merge admin h/json-headers)
                                            :payload {:model "ollama/llama3.2" :input "blocked"}}))]
         (is (= 403 (:status response)))
         (is (= "provider_not_allowed" (get-in response [:headers "x-open-hax-error-code"]))))))))

(deftest ^:async explicit-ollama-lan-embedding-prefix-does-not-collapse-to-native-ollama
  (let [upstream-called (atom false)]
    (await
     (with-proxy-app
       {:keys []
        :config-overrides {:ollamaModelPrefixes ["ollama/" "ollama:" "ollama-lan/" "ollama-lan:"]}
        :upstream-handler (fn [_ _]
                            (reset! upstream-called true)
                            (throw (js/Error. "explicit ollama-lan embeddings should not fall back to ollama")))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/inject app {:method "POST" :url "/v1/embeddings" :headers h/json-headers
                                              :payload {:model "ollama-lan/qwen3-embedding:0.6b" :input "must not fall back"}}))]
           (is (= 403 (:status response)))
           (is (= "provider_not_allowed" (get-in response [:headers "x-open-hax-error-code"])))
           (is (= false @upstream-called))))))))
