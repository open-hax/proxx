(ns proxx.proxy.key-rotation-test
  "Port of the key-rotation, cooldown and upstream-error tests of src/tests/proxy.test.ts
  (end to end through the application)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-b :as h :refer [with-proxy-app]]))

(defn- chat-reply [id content]
  {:id id :object "chat.completion"
   :choices [{:index 0 :message {:role "assistant" :content content} :finish_reason "stop"}]})

(deftest ^:async returns-429-when-every-key-is-rate-limited
  (await
   (with-proxy-app
     {:keys ["key-a" "key-b"]
      :upstream-handler (fn [_ _] (h/json-reply 429 {:error {:message "rate limit"}} {"retry-after" "60"}))}
     (fn ^:async body [{:keys [app]}]
       (let [response (await (h/chat app (h/hello "gpt-5.3-codex")))]
         (is (= 429 (:status response)))
         (is (get-in response [:headers "retry-after"]))
         (is (map? (get-in response [:json :error])))
         (is (= "no_available_key" (get-in response [:json :error :code]))))))))

(deftest ^:async ollama-weekly-limit-applies-the-multiplied-cooldown-until-it-expires
  (let [base-cooldown-ms 10000
        weekly-cooldown-ms (* base-cooldown-ms 24)
        upstream-calls (atom 0)
        now (atom 1700000000000)]
    (await
     (h/with-frozen-clock
       now
       (fn ^:async clocked []
         (await
          (with-proxy-app
            {:keys []
             :keys-payload {:providers {"ollama-cloud" ["ollama-weekly-key"]}}
             :config-overrides {:upstreamProviderId "ollama-cloud"}
             :upstream-handler
             (fn [_ _]
               (swap! upstream-calls inc)
               (h/json-reply 429 {:error "you (weekly-test) have reached your weekly usage limit, upgrade for higher limits: https://ollama.com/upgrade"}))}
            (fn ^:async body [{:keys [app]}]
              (let [payload (h/hello "gemma3:12b")
                    first-r (await (h/chat app payload))]
                (is (= 429 (:status first-r)))
                (is (= 1 @upstream-calls)))
              (let [second-r (await (h/chat app (h/hello "gemma3:12b")))]
                (is (= 429 (:status second-r)))
                (is (= 1 @upstream-calls) "cooled weekly-limited account should be skipped immediately"))
              (swap! now + (dec weekly-cooldown-ms))
              (let [third (await (h/chat app (h/hello "gemma3:12b")))]
                (is (= 429 (:status third)))
                (is (= 1 @upstream-calls) "weekly cooldown should still block before multiplied interval expires"))
              (swap! now inc)
              (let [fourth (await (h/chat app (h/hello "gemma3:12b")))]
                (is (= 429 (:status fourth)))
                (is (= 2 @upstream-calls) "provider should be retried once the multiplied cooldown expires"))))))))))

(deftest ^:async permanently-disables-api-key-accounts-on-402-payment-required
  (let [request-count (atom 0)]
    (await
     (with-proxy-app
       {:keys ["suspended-key"]
        :upstream-handler (fn [_ _]
                            (swap! request-count inc)
                            (h/json-reply 402 {:error {:message "Payment required"}}))}
       (fn ^:async body [{:keys [app]}]
         (let [first-r (await (h/chat app (h/hello "gpt-5.3-codex")))]
           (is (contains? #{402 429 500 502} (:status first-r)) (str "first request should fail, got " (:status first-r)))
           (is (= 1 @request-count) "should have made exactly one upstream attempt"))
         (let [first-count @request-count
               second-r (await (h/chat app (h/hello "gpt-5.3-codex")))]
           (is (= first-count @request-count) "second request must not reach upstream — account is permanently disabled")
           (is (contains? #{429 500 502} (:status second-r)) (str "second request should fail with no keys, got " (:status second-r)))))))))

(deftest ^:async permanently-disables-api-key-accounts-on-403-forbidden-suspended
  (let [request-count (atom 0)]
    (await
     (with-proxy-app
       {:keys ["banned-key"]
        :upstream-handler (fn [_ _]
                            (swap! request-count inc)
                            (h/json-reply 403 {:error {:message "Forbidden"}}))}
       (fn ^:async body [{:keys [app]}]
         (let [first-r (await (h/chat app (h/hello "gpt-5.3-codex")))
               first-count @request-count]
           (is (>= (:status first-r) 400) (str "first request should fail, got " (:status first-r)))
           (await (h/chat app (h/hello "gpt-5.3-codex")))
           (is (= first-count @request-count) "second request must not reach upstream — account is permanently disabled")))))))

(deftest ^:async model-gated-glm-5-accounts-stay-usable-for-gemma4
  (let [requests-by-model (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload {:providers {"ollama-cloud" ["ollama-cloud-key-a"]}}
        :config-overrides {:upstreamProviderId "ollama-cloud" :localOllamaEnabled false :keyCooldownJitterFactor 0}
        :upstream-handler
        (fn [_ body]
          (let [model (let [m (:model (h/parse-json body))] (if (string? m) m ""))]
            (swap! requests-by-model update model (fnil inc 0))
            (if (= model "glm-5")
              (h/json-reply 403 {:error {:message "this model requires a subscription, upgrade for access"}})
              (do
                (is (= "gemma4:31b" model))
                (h/json-reply 200 {:id "chatcmpl_gemma4_ok" :object "chat.completion" :model "gemma4:31b"
                                   :choices [{:index 0 :message {:role "assistant" :content "gemma4-still-works"}
                                              :finish_reason "stop"}]})))))}
       (fn ^:async body [{:keys [app]}]
         (let [first-r (await (h/chat app (h/hello "glm-5")))]
           (is (= 403 (:status first-r))))
         (let [third (await (h/chat app {:model "gemma4:31b" :messages [{:role "user" :content "hello gemma"}] :stream false}))]
           (is (= 200 (:status third)))
           (is (>= (get @requests-by-model "gemma4:31b" 0) 1))
           (is (= "gemma4-still-works" (get-in (:json third) [:choices 0 :message :content])))))))))

(deftest ^:async does-not-classify-successful-payload-text-as-quota-exhaustion
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-a" "key-b"]
        :upstream-handler
        (fn [request _]
          (let [auth (h/req-header request "authorization")]
            (when auth (swap! observed-keys conj (h/bearer auth)))
            (if (= auth "Bearer key-a")
              (h/json-reply 200 {:id "chatcmpl-first-key-success" :object "chat.completion"
                                 :message "An outstanding balance sheet can still be healthy."
                                 :choices [{:index 0 :message {:role "assistant" :content "ok-from-first-key"}
                                            :finish_reason "stop"}]})
              (h/json-reply 200 (chat-reply "chatcmpl-second-key-should-not-run" "unexpected-second-key")))))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "glm-5")))]
           (is (= 200 (:status response)))
           (is (= ["key-a"] @observed-keys))
           (is (= "chatcmpl-first-key-success" (get-in response [:json :id])))))))))

(deftest ^:async treats-503-retry-after-as-upstream-server-error-not-account-rate-limit
  (await
   (with-proxy-app
     {:keys ["key-a" "key-b"]
      :upstream-handler (fn [_ _] (h/json-reply 503 {:error {:message "temporary upstream outage"}} {"retry-after" "1"}))}
     (fn ^:async body [{:keys [app]}]
       (let [response (await (h/chat app (h/hello "glm-5")))]
         (is (= 502 (:status response)))
         (is (map? (get-in response [:json :error])))
         (is (= "upstream_server_error" (get-in response [:json :error :code]))))))))

(deftest ^:async returns-400-when-invalid-request-and-rate-limit-responses-are-mixed
  (await
   (with-proxy-app
     {:keys ["key-a" "key-b"]
      :upstream-handler
      (fn [request _]
        (if (= "Bearer key-a" (h/req-header request "authorization"))
          (h/json-reply 400 {:error {:type "invalid_request_error" :code "bad_request"
                                     :message "unsupported request parameter: stream_options"}})
          (h/json-reply 429 {:error {:message "rate limit"}} {"retry-after" "1"})))}
     (fn ^:async body [{:keys [app]}]
       (let [response (await (h/chat app (h/hello "glm-5" {:stream_options {:include_usage true}})))]
         (is (= 400 (:status response)))
         (is (map? (get-in response [:json :error])))
         (is (= "invalid_request_error" (get-in response [:json :error :type])))
         (is (= "upstream_rejected_request" (get-in response [:json :error :code]))))))))

(deftest ^:async returns-graceful-aggregated-error-when-all-upstream-accounts-fail-with-auth-errors
  (await
   (with-proxy-app
     {:keys ["key-a" "key-b"]
      :upstream-handler
      (fn [request _]
        (if (= "Bearer key-a" (h/req-header request "authorization"))
          (h/json-reply 401 {:error {:message "token invalidated"}})
          {:status 403 :headers {"content-type" "application/octet-stream"} :body ""}))}
     (fn ^:async body [{:keys [app]}]
       (let [response (await (h/chat app (h/hello "glm-5")))]
         (is (= 502 (:status response)))
         (is (map? (get-in response [:json :error])))
         (is (= "upstream_unavailable" (get-in response [:json :error :code]))))))))

(deftest ^:async returns-graceful-invalid-request-error-when-the-final-upstream-candidate-rejects-the-payload
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler (fn [_ _]
                          (h/json-reply 400 {:error {:type "invalid_request_error" :code "bad_request"
                                                     :message "unsupported request parameter: stream_options"}}))}
     (fn ^:async body [{:keys [app]}]
       (let [response (await (h/chat app (h/hello "glm-5" {:stream_options {:include_usage true}})))]
         (is (= 400 (:status response)))
         (is (map? (get-in response [:json :error])))
         (is (= "upstream_rejected_request" (get-in response [:json :error :code]))))))))

(deftest ^:async treats-outstanding-balance-responses-as-rate-limit-like-and-rotates-keys
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-a" "key-b"]
        :upstream-handler
        (fn [request _]
          (let [auth (h/req-header request "authorization")]
            (when auth (swap! observed-keys conj (h/bearer auth)))
            (if (= auth "Bearer key-a")
              (h/json-reply 402 {:error {:code "outstanding_balance" :message "outstanding_balance"}})
              (h/json-reply 200 {:id "chatcmpl-outstanding-fallback" :object "chat.completion" :choices []}))))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "gpt-5.3-codex")))]
           (is (= 200 (:status response)))
           (is (= ["key-a" "key-b"] @observed-keys))))))))

(deftest ^:async returns-429-when-every-key-has-outstanding-balance
  (await
   (with-proxy-app
     {:keys ["key-a" "key-b"]
      :upstream-handler (fn [_ _] (h/json-reply 402 {:error {:code "outstanding_balance" :message "outstanding_balance"}}))}
     (fn ^:async body [{:keys [app]}]
       (let [response (await (h/chat app (h/hello "gpt-5.3-codex")))]
         (is (= 429 (:status response)))
         (is (map? (get-in response [:json :error])))
         (is (= "no_available_key" (get-in response [:json :error :code])))
         (is (re-find #"(?i)outstanding balances|quota-exhausted" (str (get-in response [:json :error :message])))))))))

(deftest ^:async retries-with-next-key-when-upstream-returns-500
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-a" "key-b"]
        :upstream-handler
        (fn [request _]
          (let [auth (h/req-header request "authorization")]
            (when auth (swap! observed-keys conj (h/bearer auth)))
            (if (= auth "Bearer key-a")
              (h/json-reply 500 {:error {:message "temporary upstream error"}})
              (h/json-reply 200 {:id "chatcmpl-500-fallback" :object "chat.completion" :choices []}))))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "gemini-3.1-pro-preview")))]
           (is (= 200 (:status response)))
           (is (= "chatcmpl-500-fallback" (get-in response [:json :id])))
           (is (= ["key-a" "key-b"] @observed-keys))))))))

(deftest ^:async retries-transient-upstream-server-errors-on-the-same-key-before-rotating
  (let [observed-keys (atom [])
        key-a-attempts (atom 0)]
    (await
     (with-proxy-app
       {:keys ["key-a" "key-b"]
        :upstream-handler
        (fn [request _]
          (let [auth (h/req-header request "authorization")]
            (when auth (swap! observed-keys conj (h/bearer auth)))
            (if (and (= auth "Bearer key-a") (< (swap! key-a-attempts inc) 3))
              (h/json-reply 503 {:error {:message "temporary upstream outage"}})
              (h/json-reply 200 {:id "chatcmpl-retry-same-key" :object "chat.completion" :choices []}))))}
       (fn ^:async body [{:keys [app]}]
         (let [response (await (h/chat app (h/hello "gemini-3.1-pro-preview")))]
           (is (= 200 (:status response)))
           (is (= "chatcmpl-retry-same-key" (get-in response [:json :id])))
           (is (= ["key-a" "key-a" "key-a"] @observed-keys))))))))
