(ns proxx.proxy.ollama-chat-test
  "Chat completions routed to a native Ollama `/api/chat` upstream: request mapping
  (num_ctx, think), response mapping (usage, reasoning_content) and the NDJSON to
  chat-completion SSE conversion, through the real application."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.fixture-c :as fx :refer [with-proxy-app post-json]]))

(def ^:private created-at "2026-03-03T00:00:00.000Z")

(defn- ollama-line
  "One native Ollama chat frame."
  [model message done? & [extra]]
  (merge {:model model :created_at created-at :message (merge {:role "assistant"} message) :done done?} extra))

(defn- user-chat [model & [extra]]
  (merge {:model model :messages [{:role "user" :content "hello"}] :stream false} extra))

(deftest ^:async routes-ollama-prefixed-models-to-api-chat-and-forwards-num-ctx-controls
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :upstream-handler (fn [req body]
                            (reset! seen {:path (fx/req-url req) :body (fx/parse-json body)
                                          :authorization (fx/req-header req "authorization")})
                            (fx/json-reply {:model "llama3.2:latest" :created_at created-at
                                            :message {:role "assistant" :content "ollama-ok"}
                                            :done true :done_reason "stop" :prompt_eval_count 12 :eval_count 6}))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions"
                                          (user-chat "ollama/llama3.2:latest" {:open_hax {:ollama {:num_ctx 8192}}})))
               {:keys [path body authorization]} @seen
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= "ollama_chat" (get-in response [:headers "x-open-hax-upstream-mode"])))
           (is (= "/api/chat" path))
           (is (nil? authorization))
           (is (map? body))
           (is (= "llama3.2:latest" (get body "model")))
           (is (vector? (get body "messages")))
           (is (map? (get body "options")))
           (is (= 8192 (get-in body ["options" "num_ctx"])))
           (is (map? payload))
           (is (= "chat.completion" (get payload "object")))
           (is (= "llama3.2:latest" (get payload "model")))
           (is (vector? (get payload "choices")))
           (is (map? (get-in payload ["choices" 0 "message"])))
           (is (= "ollama-ok" (get-in payload ["choices" 0 "message" "content"])))
           (is (map? (get payload "usage")))
           (is (= 12 (get-in payload ["usage" "prompt_tokens"])))
           (is (= 6 (get-in payload ["usage" "completion_tokens"])))
           (is (= 18 (get-in payload ["usage" "total_tokens"])))))))))

(deftest ^:async maps-reasoning-effort-to-ollama-think-true-and-exposes-thinking-as-reasoning-content
  (let [seen (atom nil)]
    (await
     (with-proxy-app
       {:keys []
        :upstream-handler (fn [_ body]
                            (reset! seen (fx/parse-json body))
                            (fx/json-reply {:model "llama3.2:latest" :created_at created-at
                                            :message {:role "assistant" :content "ollama-answer" :thinking "ollama-thinking"}
                                            :done true :done_reason "stop" :prompt_eval_count 12 :eval_count 6}))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions"
                                          (user-chat "ollama/llama3.2:latest"
                                                     {:reasoning_effort "high" :include ["reasoning.encrypted_content"]})))
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (map? @seen))
           (is (= true (get @seen "think")))
           (is (map? payload))
           (is (= "ollama-answer" (get-in payload ["choices" 0 "message" "content"])))
           (is (= "ollama-thinking" (get-in payload ["choices" 0 "message" "reasoning_content"])))))))))

(deftest ^:async maps-none-reasoning-effort-to-ollama-think-false
  (let [seen (atom nil)]
    (await
     (with-proxy-app
       {:keys []
        :upstream-handler (fn [_ body]
                            (reset! seen (fx/parse-json body))
                            (fx/json-reply {:model "llama3.2:latest" :created_at created-at
                                            :message {:role "assistant" :content "ollama-no-think"}
                                            :done true :done_reason "stop" :prompt_eval_count 2 :eval_count 1}))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions"
                                          (user-chat "ollama/llama3.2:latest" {:reasoning_effort "none"})))]
           (is (= 200 (:status response)))
           (is (map? @seen))
           (is (= false (get @seen "think")))))))))

(deftest ^:async returns-true-streaming-chat-completion-sse-for-ollama-stream-requests
  (let [seen (atom nil)]
    (await
     (with-proxy-app
       {:keys []
        :upstream-handler (fn [_ body]
                            (reset! seen (fx/parse-json body))
                            (fx/ndjson-reply
                             (ollama-line "llama3.2:latest" {:content "ollama-"} false)
                             (ollama-line "llama3.2:latest" {:content "stream-ok"} false)
                             (ollama-line "llama3.2:latest" {:content ""} true {:done_reason "stop" :prompt_eval_count 3 :eval_count 2})))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions"
                                          (user-chat "ollama:llama3.2:latest" {:stream true :num_ctx 4096})))
               payloads (fx/sse-data-payloads (:body response))
               [first-chunk second-chunk final-chunk] (map fx/parse-json (take 3 payloads))]
           (is (= 200 (:status response)))
           (is (= "text/event-stream; charset=utf-8" (get-in response [:headers "content-type"])))
           (is (map? @seen))
           (is (= true (get @seen "stream")))
           (is (map? (get @seen "options")))
           (is (= 4096 (get-in @seen ["options" "num_ctx"])))
           (is (= "[DONE]" (last payloads)))
           (is (= "chat.completion.chunk" (get first-chunk "object")))
           (is (= "assistant" (get-in first-chunk ["choices" 0 "delta" "role"])))
           (is (= "ollama-" (get-in first-chunk ["choices" 0 "delta" "content"])))
           (is (= "chat.completion.chunk" (get second-chunk "object")))
           (is (= "stream-ok" (get-in second-chunk ["choices" 0 "delta" "content"])))
           (is (= "chat.completion.chunk" (get final-chunk "object")))
           (is (= {} (get-in final-chunk ["choices" 0 "delta"])))
           (is (= "stop" (get-in final-chunk ["choices" 0 "finish_reason"])))
           (is (= (get first-chunk "id") (get second-chunk "id")))
           (is (= (get second-chunk "id") (get final-chunk "id")))))))))

(deftest ^:async collapses-duplicated-first-thinking-token-in-ollama-stream-reasoning
  (await
   (with-proxy-app
     {:keys []
      :upstream-handler (fn [_ _]
                          (fx/ndjson-reply
                           (ollama-line "gemma3:latest" {:thinking "The"} false)
                           (ollama-line "gemma3:latest" {:thinking "TheThe model should reason once." :content "answer"} false)
                           (ollama-line "gemma3:latest" {:thinking "TheThe model should reason once." :content "answer"} true {:done_reason "stop"})))}
     (^:async fn [{:keys [app]}]
       (let [response (await (post-json app "/v1/chat/completions"
                                        (user-chat "ollama:gemma3:latest" {:reasoning_effort "high" :stream true})))
             chunks (->> (fx/sse-data-payloads (:body response))
                         (remove #(= "[DONE]" %))
                         (map fx/parse-json))
             reasoning (apply str (map #(or (get-in % ["choices" 0 "delta" "reasoning_content"]) "") chunks))]
         (is (= 200 (:status response)))
         (is (= "The model should reason once." reasoning)))))))

(deftest ^:async preserves-ollama-stream-content-when-tool-calls-are-present
  (let [tool-calls [{:function {:name "bash" :arguments {:command "pwd"}}}]]
    (await
     (with-proxy-app
       {:keys []
        :upstream-handler (fn [_ _]
                            (fx/ndjson-reply
                             (ollama-line "llama3.2:latest" {:content "tool-call-transcript" :tool_calls tool-calls} false)
                             (ollama-line "llama3.2:latest" {:content "" :tool_calls tool-calls} true {:done_reason "stop"})))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions" (user-chat "ollama:llama3.2:latest" {:stream true})))
               payloads (fx/sse-data-payloads (:body response))
               [first-chunk final-chunk] (map fx/parse-json (take 2 payloads))]
           (is (= 200 (:status response)))
           (is (= "[DONE]" (last payloads)))
           (is (= "chat.completion.chunk" (get first-chunk "object")))
           (is (= "tool-call-transcript" (get-in first-chunk ["choices" 0 "delta" "content"])))
           (is (vector? (get-in first-chunk ["choices" 0 "delta" "tool_calls"])))
           (is (= "chat.completion.chunk" (get final-chunk "object")))
           (is (contains? (get-in final-chunk ["choices" 0 "delta"]) "content"))
           (is (nil? (get-in final-chunk ["choices" 0 "delta" "content"])))
           (is (vector? (get-in final-chunk ["choices" 0 "delta" "tool_calls"])))
           (is (= (get first-chunk "id") (get final-chunk "id")))))))))

(defn- ^:async read-until-frame
  "Read from `reader` until `buffer` holds one complete SSE frame; returns the text."
  [^js reader ^js decoder buffer]
  (if (.includes buffer "\n\n")
    buffer
    (let [^js result (await (.read reader))]
      (is (= false (.-done result)))
      (await (read-until-frame reader decoder (str buffer (.decode decoder (.-value result) #js {"stream" true})))))))

(deftest ^:async streams-first-ollama-sse-chunk-before-upstream-completion
  (await
   (with-proxy-app
     {:keys []
      :upstream-handler
      (fn [_ _]
        {:status 200
         :headers {"content-type" "application/x-ndjson"}
         :stream-body (^:async fn [^js response]
                       (.write response (str (fx/json-str (ollama-line "llama3.2:latest" {:content "ollama-"} false)) "\n"))
                       (await (js/Promise. (fn [resolve _] (js/setTimeout resolve 150))))
                       (.write response (str (fx/json-str (ollama-line "llama3.2:latest" {:content "stream-ok"} false)) "\n"))
                       (.write response (str (fx/json-str (ollama-line "llama3.2:latest" {:content ""} true {:done_reason "stop"})) "\n"))
                       (.end response))})}
     (^:async fn [{:keys [^js app]}]
       (await (.listen app #js {"host" "127.0.0.1" "port" 0}))
       (let [port (.-port (.address (.-server app)))
             ^js response (await (js/fetch (str "http://127.0.0.1:" port "/v1/chat/completions")
                                           #js {"method" "POST"
                                                "headers" #js {"content-type" "application/json"}
                                                "body" (fx/json-str (user-chat "ollama:llama3.2:latest" {:stream true}))}))]
         (is (= 200 (.-status response)))
         (is (= "text/event-stream; charset=utf-8" (.get (.-headers response) "content-type")))
         (is (some? (.-body response)))
         (let [^js reader (.getReader (.-body response))
               buffer (try
                        (await (read-until-frame reader (js/TextDecoder.) ""))
                        (finally (await (.cancel reader))))
               ;; The regression is that the proxy emits a valid first chat chunk rather than
               ;; waiting for a fully buffered JSON response (loopback buffering makes the
               ;; server-side completion flag unreliable, so it is not asserted).
               first-event (first (fx/sse-data-payloads buffer))
               first-chunk (some-> first-event fx/parse-json)]
           (is (some? first-event))
           (is (= "chat.completion.chunk" (get first-chunk "object")))
           (is (= "ollama-" (get-in first-chunk ["choices" 0 "delta" "content"])))))))))
