(ns proxx.proxy.stream-failover-test
  "Streaming chat completions through the proxy: responses->chat reasoning, failover on
   empty/stalled/quota streams, early start and content-type normalisation.
   Ported from src/tests/proxy.test.ts."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-d :as h :refer [with-proxy-app chat-chunk sse-done includes? bearer-key]]))

(def ^:private user-hello [{"role" "user" "content" "hello"}])

(defn- stream-request [model] {"model" model "messages" user-hello "stream" true})

(defn- sse-content-type? [r]
  (boolean (re-find #"(?i)text/event-stream" (str (get (:headers r) "content-type")))))

(deftest ^:async maps-responses-reasoning-output-into-chat-reasoning-content-for-stream-clients
  (let [observed-body (atom nil)]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler
        (fn [_request body]
          (reset! observed-body (h/parse-json body))
          {:status 200 :headers {"content-type" "application/json"}
           :body (h/json-str
                  {"id" "resp_reasoning_stream" "object" "response" "created_at" 1772516803 "model" "gpt-5.3-codex"
                   "output" [{"id" "rs_1" "type" "reasoning"
                              "summary" [{"type" "summary_text" "text" "reasoning-trace-ok"}]}
                             {"id" "msg_reasoning_stream" "type" "message" "role" "assistant"
                              "content" [{"type" "output_text" "text" "stream-with-reasoning-ok"}]}]})})}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app (stream-request "gpt-5.3-codex")))]
          (is (= 200 (:status r)))
          (is (= "text/event-stream; charset=utf-8" (get (:headers r) "content-type")))
          (is (map? @observed-body))
          (is (contains? #{false nil} (get @observed-body "stream")))
          (is (includes? (:body r) "\"reasoning_content\":\"reasoning-trace-ok\""))
          (is (includes? (:body r) "stream-with-reasoning-ok"))
          (is (includes? (:body r) "data: [DONE]"))))))))

(deftest ^:async fails-over-stream-accounts-when-an-upstream-stream-returns-only-done
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-bad" "key-good"]
        :upstream-handler
        (fn [request _]
          (when-let [k (bearer-key request)] (swap! observed-keys conj k))
          (if (= "key-bad" (bearer-key request))
            {:status 200 :headers {"content-type" "text/plain; charset=utf-8"} :body (sse-done)}
            {:status 200 :headers {"content-type" "text/event-stream"}
             :body (str (chat-chunk "chatcmpl_stream_ok" "Kimi-K2.5" {"role" "assistant" "content" "stream-failover-ok"} nil)
                        (chat-chunk "chatcmpl_stream_ok" "Kimi-K2.5" {} "stop")
                        (sse-done))}))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app (stream-request "Kimi-K2.5")))]
          (is (= 200 (:status r)))
          (is (string? (get (:headers r) "content-type")))
          (is (sse-content-type? r))
          (is (includes? (:body r) "stream-failover-ok"))
          (is (includes? (:body r) "data: [DONE]"))
          (is (= ["key-bad" "key-good"] @observed-keys))))))))

(deftest ^:async fails-over-stream-accounts-when-the-first-upstream-stream-handshake-times-out
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-slow" "key-fast"]
        :config-overrides {"requestTimeoutMs" 1000 "streamBootstrapTimeoutMs" 50 "embedMaxContextTokens" 262144}
        :upstream-handler
        (fn ^:async handler [request _]
          (when-let [k (bearer-key request)] (swap! observed-keys conj k))
          (if (= "key-slow" (bearer-key request))
            (do (await (h/sleep 200))
                {:status 200 :headers {"content-type" "text/event-stream"}
                 :body (str (chat-chunk "chatcmpl_stream_slow" "glm-5" {"role" "assistant" "content" "slow"} nil)
                            (sse-done))})
            {:status 200 :headers {"content-type" "text/event-stream"}
             :body (str (chat-chunk "chatcmpl_stream_timeout_fallback" "glm-5"
                                    {"role" "assistant" "content" "stream-timeout-fallback-ok"} nil)
                        (chat-chunk "chatcmpl_stream_timeout_fallback" "glm-5" {} "stop")
                        (sse-done))}))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app (stream-request "glm-5")))]
          (is (= 200 (:status r)))
          (is (includes? (:body r) "stream-timeout-fallback-ok"))
          (is (= ["key-slow" "key-fast"] @observed-keys))))))))

(deftest ^:async fails-over-stream-accounts-when-the-first-upstream-stream-sends-headers-but-never-boots
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-stalled" "key-fast"]
        :config-overrides {"requestTimeoutMs" 1000 "streamBootstrapTimeoutMs" 50 "embedMaxContextTokens" 262144}
        :upstream-handler
        (fn [request _]
          (when-let [k (bearer-key request)] (swap! observed-keys conj k))
          (if (= "key-stalled" (bearer-key request))
            {:status 200 :headers {"content-type" "text/event-stream"}
             :stream-body (fn ^:async stall [^js response]
                            (.flushHeaders response)
                            (await (h/sleep 200))
                            (.write response (chat-chunk "chatcmpl_stream_stalled" "glm-5"
                                                         {"role" "assistant" "content" "too-late"} nil))
                            (.write response (sse-done))
                            (.end response))}
            {:status 200 :headers {"content-type" "text/event-stream"}
             :body (str (chat-chunk "chatcmpl_stream_bootstrap_fallback" "glm-5"
                                    {"role" "assistant" "content" "stream-bootstrap-fallback-ok"} nil)
                        (chat-chunk "chatcmpl_stream_bootstrap_fallback" "glm-5" {} "stop")
                        (sse-done))}))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app (stream-request "glm-5")))]
          (is (= 200 (:status r)))
          (is (includes? (:body r) "stream-bootstrap-fallback-ok"))
          ;; the stalled upstream is cut off: its late chunk must not appear
          (is (not (includes? (:body r) "too-late")) "stalled upstream should not leak late chunks")
          (is (not (includes? (:body r) "chatcmpl_stream_stalled")) "stalled upstream ID should not appear")
          (is (= ["key-stalled" "key-fast"] @observed-keys))))))))

(deftest ^:async returns-502-when-the-final-upstream-stream-has-no-substantive-chunks
  (await
   (with-proxy-app
     {:keys ["key-empty"]
      :upstream-handler (fn [_ _] {:status 200 :headers {"content-type" "text/event-stream"} :body (sse-done)})}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/chat app (stream-request "glm-5")))]
        (is (= 502 (:status r)))
        (is (map? (:json r)))
        (is (map? (get (:json r) "error")))
        (is (= "upstream_unavailable" (get-in (:json r) ["error" "code"]))))))))

(deftest ^:async starts-hosted-upstream-streams-after-the-first-substantive-chunk-instead-of-buffering-the-full-body
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler
      (fn [_ _]
        {:status 200 :headers {"content-type" "text/event-stream"}
         :stream-body (fn ^:async early [^js response]
                        (.flushHeaders response)
                        (.write response (chat-chunk "chatcmpl_stream_early" "glm-5"
                                                     {"role" "assistant" "content" "early-hosted-stream"} nil))
                        (await (h/sleep 250))
                        (.write response (chat-chunk "chatcmpl_stream_early" "glm-5" {} "stop"))
                        (.write response (sse-done))
                        (.end response))})}
     (fn ^:async run [{:keys [^js app]}]
      (await (.listen app #js {:host "127.0.0.1" :port 0}))
      (let [port (.-port (.address (.-server app)))
            ^js response (await (js/fetch (str "http://127.0.0.1:" port "/v1/chat/completions")
                                          #js {:method "POST" :headers #js {"content-type" "application/json"}
                                               :body (h/json-str (stream-request "glm-5"))}))]
        (is (= 200 (.-status response)))
        (is (= "text/event-stream; charset=utf-8" (.get (.-headers response) "content-type")))
        (is (some? (.-body response)))
        (let [reader (.getReader (.-body response))
              decoder (js/TextDecoder.)]
          ;; Intentionally no assertion that the upstream has not completed: on loopback the
          ;; body can be buffered far enough that it has. What matters is that the proxy emits a
          ;; valid first chat chunk rather than waiting for a fully buffered JSON response.
          (loop [buffer ""]
            (if (includes? buffer "\n\n")
              (let [first-event (first (h/parse-sse-data-payloads buffer))
                    first-chunk (h/parse-json first-event)]
                (await (.cancel reader))
                (is (some? first-event))
                (is (= "chat.completion.chunk" (get first-chunk "object")))
                (is (= "early-hosted-stream" (get-in first-chunk ["choices" 0 "delta" "content"]))))
              (let [^js r (await (.read reader))]
                (is (false? (.-done r)))
                (if (.-done r)
                  (await (.cancel reader))
                  (recur (str buffer (.decode decoder (.-value r) #js {:stream true}))))))))))))) 

(deftest ^:async does-not-classify-normal-stream-content-as-quota-errors
  (let [chunk-a (chat-chunk "chatcmpl_stream_balance_phrase" "glm-5"
                            {"role" "assistant" "content" "An outstanding balance sheet can still be healthy."} nil)
        chunk-b (chat-chunk "chatcmpl_stream_balance_phrase" "glm-5" {} "stop")]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :upstream-handler (fn [_ _] {:status 200 :headers {"content-type" "text/event-stream"}
                                     :body (str chunk-a chunk-b (sse-done))})}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app (stream-request "glm-5")))]
          (is (= 200 (:status r)))
          (is (string? (get (:headers r) "content-type")))
          (is (sse-content-type? r))
          (is (includes? (:body r) "outstanding balance sheet"))
          (is (includes? (:body r) "data: [DONE]"))))))))

(deftest ^:async fails-over-stream-accounts-when-upstream-emits-error-event-with-outstanding-balance
  (let [observed-keys (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-bad" "key-good"]
        :upstream-handler
        (fn [request _]
          (when-let [k (bearer-key request)] (swap! observed-keys conj k))
          (if (= "key-bad" (bearer-key request))
            {:status 200 :headers {"content-type" "text/event-stream"}
             :body "data: {\"type\":\"error\",\"detail\":\"outstanding_balance\"}\n\n"}
            {:status 200 :headers {"content-type" "text/event-stream"}
             :body (str (chat-chunk "chatcmpl_stream_quota_fallback" "glm-5"
                                    {"role" "assistant" "content" "fallback-stream-ok"} nil)
                        (chat-chunk "chatcmpl_stream_quota_fallback" "glm-5" {} "stop")
                        (sse-done))}))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app (stream-request "glm-5")))]
          (is (= 200 (:status r)))
          (is (includes? (:body r) "fallback-stream-ok"))
          (is (= ["key-bad" "key-good"] @observed-keys))))))))

(deftest ^:async forces-sse-content-type-for-validated-stream-pass-through
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler
      (fn [_ _]
        {:status 200 :headers {"content-type" "application/json"}
         :body (str (chat-chunk "chatcmpl_stream_content_type" "glm-5"
                                {"role" "assistant" "content" "content-type-normalized"} nil)
                    (chat-chunk "chatcmpl_stream_content_type" "glm-5" {} "stop")
                    (sse-done))})}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/chat app (stream-request "glm-5")))]
        (is (= 200 (:status r)))
        (is (= "text/event-stream; charset=utf-8" (get (:headers r) "content-type")))
        (is (includes? (:body r) "content-type-normalized"))
        (is (includes? (:body r) "data: [DONE]")))))))
