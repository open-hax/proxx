(ns proxx.proxy.provider-fallback-test
  "Port of the provider-fallback tests of src/tests/proxy.test.ts (end to end through the application)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-b :as h :refer [with-proxy-app]]))

(defn- responses-body
  "A Responses API payload carrying a single output_text message."
  [id model msg-id text]
  {:id id :object "response" :created_at 1772516816 :model model
   :output [{:id msg-id :type "message" :role "assistant"
             :content [{:type "output_text" :text text}]}]})

(deftest ^:async falls-back-from-ollama-cloud-to-vivgrid-for-shared-models-when-primary-provider-auth-fails
  (let [observed-auth (atom [])]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload {:providers {"ollama-cloud" ["ollama-cloud-failing-key"]
                                   :vivgrid ["vivgrid-working-key"]}}
        :config-overrides {:upstreamProviderId "ollama-cloud"}
        :upstream-handler
        (fn [request _body]
          (let [auth (h/req-header request "authorization")]
            (when auth (swap! observed-auth conj (h/bearer auth)))
            (if (= auth "Bearer ollama-cloud-failing-key")
              {:status 403 :headers h/json-headers :body (h/json-body {:error {:message "forbidden"}})}
              {:status 200 :headers h/json-headers
               :body (h/json-body {:id "chatcmpl-provider-fallback-2" :object "chat.completion" :model "Kimi-K2.5"
                                   :choices [{:index 0 :message {:role "assistant" :content "provider-fallback-reverse-ok"}
                                              :finish_reason "stop"}]})})))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app {:model "Kimi-K2.5" :messages [{:role "user" :content "hello"}] :stream false}))]
           (is (= 200 (:status response)))
           (is (= "vivgrid" (get-in response [:headers "x-open-hax-upstream-provider"])))
           (is (>= (count @observed-auth) 2))
           (is (= ["ollama-cloud-failing-key" "vivgrid-working-key"] (vec (take-last 2 @observed-auth))))
           (is (= "provider-fallback-reverse-ok" (get-in (:json response) [:choices 0 :message :content])))))))))

(deftest ^:async skips-ollama-cloud-entirely-when-routing-gpt-models
  (let [observed-auth (atom [])]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload {:providers {"ollama-cloud" ["ollama-cloud-missing-model-key"]
                                   :vivgrid ["vivgrid-gpt-key"]}}
        :config-overrides {:upstreamProviderId "ollama-cloud"}
        :upstream-handler
        (fn [request body]
          (let [auth (h/req-header request "authorization")]
            (when (and auth (= "POST" (.-method request)))
              (swap! observed-auth conj (h/bearer auth)))
            (if (= auth "Bearer ollama-cloud-missing-model-key")
              {:status 404 :headers h/json-headers
               :body (h/json-body {:error {:message "model \"gpt-5.3-codex\" not found"}})}
              (do
                (is (= "gpt-5.3-codex" (:model (h/parse-json body))))
                {:status 200 :headers h/json-headers
                 :body (h/json-body (responses-body "resp-gpt-fallback-ok" "gpt-5.3-codex" "msg-gpt-fallback-ok" "gpt-fallback-ok"))}))))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app {:model "gpt-5.3-codex" :messages [{:role "user" :content "hello"}] :stream false}))]
           (is (= 200 (:status response)))
           (is (= "vivgrid" (get-in response [:headers "x-open-hax-upstream-provider"])))
           (is (= ["vivgrid-gpt-key"] @observed-auth))
           (is (= "gpt-fallback-ok" (get-in (:json response) [:choices 0 :message :content])))))))))

(deftest ^:async skips-ollama-cloud-entirely-when-routing-gpt-5-4-mini-models
  (let [observed-auth (atom [])]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload {:providers {"ollama-cloud" ["ollama-cloud-should-not-run"]
                                   :vivgrid ["vivgrid-gpt52-key"]}}
        :config-overrides {:upstreamProviderId "ollama-cloud"}
        :upstream-handler
        (fn [request body]
          (if (not= "POST" (.-method request))
            {:status 404 :headers h/json-headers :body (h/json-body {:error {:message "not found"}})}
            (let [auth (h/req-header request "authorization")]
              (when auth (swap! observed-auth conj (h/bearer auth)))
              (if (= auth "Bearer ollama-cloud-should-not-run")
                {:status 404 :headers h/json-headers
                 :body (h/json-body {:error {:message "model \"gpt-5.4-mini\" not found"}})}
                (do
                  (is (= "gpt-5.4-mini" (:model (h/parse-json body))))
                  {:status 200 :headers h/json-headers
                   :body (h/json-body (responses-body "resp-gpt52-fallback-ok" "gpt-5.4-mini" "msg-gpt52-fallback-ok" "gpt-5.4-mini-fallback-ok"))})))))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app {:model "gpt-5.4-mini" :messages [{:role "user" :content "hello"}] :stream false}))]
           (await (h/sleep 25))
           (is (= 200 (:status response)))
           (is (= "vivgrid" (get-in response [:headers "x-open-hax-upstream-provider"])))
           (is (= ["vivgrid-gpt52-key"] @observed-auth))
           (is (= "gpt-5.4-mini-fallback-ok" (get-in (:json response) [:choices 0 :message :content])))))))))
