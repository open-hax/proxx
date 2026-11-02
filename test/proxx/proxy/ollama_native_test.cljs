(ns proxx.proxy.ollama-native-test
  "Local-vs-cloud Ollama routing, ollama usage logging, provider option validation
  and the native `/api/*` surface (`tags`, `chat`, `generate`), through the real application."
  (:require [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.proxy.fixture-c :as fx :refer [with-proxy-app post-json inject]]))

(deftest ^:async routes-local-only-ollama-models-even-when-ollama-cloud-is-also-configured
  (let [observed (atom [])]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload {:providers {:ollama-cloud ["ollama-cloud-key"]}}
        :handle-model-catalog true
        :config-overrides {:upstreamProviderId "zai"}
        :upstream-handler
        (fn [req body]
          (let [authorization (fx/req-header req "authorization")
                method (fx/req-method req)
                url (fx/req-url req)]
            (cond
              (and (= "GET" method) (= "/api/tags" url))
              (fx/json-reply {:models (if (= "Bearer ollama-cloud-key" authorization)
                                        [{:name "gemma4:31b"}]
                                        [{:name "gemma4:e4b"}])})

              (and (= "POST" method) (= "/v1/chat/completions" url))
              (let [model (get (fx/parse-json body) "model")]
                (swap! observed conj {:url url :authorization authorization :model model})
                (fx/json-reply {:id "chatcmpl-local" :object "chat.completion" :created 1 :model model
                                :choices [{:index 0 :message {:role "assistant" :content "hello-local"} :finish_reason "stop"}]
                                :usage {:prompt_tokens 2 :completion_tokens 1 :total_tokens 3}}))

              :else (fx/json-reply 404 {:error {:message (str "Unhandled " method " " url)}}))))}
       (^:async fn [{:keys [app]}]
         (let [response (await (post-json app "/v1/chat/completions"
                                          {:model "gemma4:e4b" :messages [{:role "user" :content "hello"}] :stream false}))
               parsed (:json response)]
           (is (= 200 (:status response)))
           (is (= "gemma4:e4b" (get parsed "model")))
           (is (= "hello-local" (get-in parsed ["choices" 0 "message" "content"])))
           (is (= [{:url "/v1/chat/completions" :authorization nil :model "gemma4:e4b"}] @observed))))))))

(deftest ^:async records-ollama-token-usage-in-request-logs
  (await
   (with-proxy-app
     {:keys []
      :upstream-handler (fn [_ _]
                          (fx/json-reply {:model "llama3.2:latest" :created_at "2026-03-03T00:00:00.000Z"
                                          :message {:role "assistant" :content "ollama-log-ok"}
                                          :done true :done_reason "stop" :prompt_eval_count 9 :eval_count 4}))}
     (^:async fn [{:keys [app]}]
       (let [response (await (post-json app "/v1/chat/completions"
                                        {:model "ollama/llama3.2:latest" :messages [{:role "user" :content "hello"}] :stream false}))
             logs-response (await (inject app {:method "GET" :url "/api/v1/request-logs?providerId=ollama&limit=1"}))
             payload (:json logs-response)
             entry (get-in payload ["entries" 0])]
         (is (= 200 (:status response)))
         (is (= 200 (:status logs-response)))
         (is (map? payload))
         (is (vector? (get payload "entries")))
         (is (map? entry))
         (is (= "ollama" (get entry "providerId")))
         (is (= 9 (get entry "promptTokens")))
         (is (= 4 (get entry "completionTokens")))
         (is (= 13 (get entry "totalTokens"))))))))

(deftest ^:async rejects-invalid-ollama-num-ctx-values
  (await
   (with-proxy-app
     {:keys [] :upstream-handler (fn [_ _] (fx/json-reply {:ok true}))}
     (^:async fn [{:keys [app]}]
       (let [response (await (post-json app "/v1/chat/completions"
                                        {:model "ollama/llama3.2:latest"
                                         :messages [{:role "user" :content "hello"}]
                                         :open_hax {:ollama {:num_ctx -1}}}))
             payload (:json response)]
         (is (= 400 (:status response)))
         (is (= "invalid_provider_options" (get-in response [:headers "x-open-hax-error-code"])))
         (is (map? payload))
         (is (map? (get payload "error")))
         (is (= "invalid_provider_options" (get-in payload ["error" "code"])))
         (is (re-find #"num_ctx" (str (get-in payload ["error" "message"])))))))))

(deftest ^:async serves-native-api-tags-from-the-discovered-model-catalog
  (let [seen-path (atom "")]
    (await
     (with-proxy-app
       {:keys []
        :handle-model-catalog true
        :models {:preferred ["qwen3.5:4b-q8_0" "qwen3.5:2b-bf16"] :disabled [] :aliases {}}
        :keys-payload {:providers {:ollama-cloud ["ollama-local-key"]}}
        :config-overrides {:upstreamProviderId "ollama-cloud"}
        :upstream-handler (fn [req _]
                            (reset! seen-path (fx/req-url req))
                            (fx/json-reply {:models [{:name "qwen3.5:4b-q8_0"} {:name "qwen3.5:2b-bf16"}]}))}
       (^:async fn [{:keys [app]}]
         (let [response (await (inject app {:method "GET" :url "/api/tags"}))
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= "/v1/models" @seen-path))
           (is (map? payload))
           (is (vector? (get payload "models")))
           (is (some #(and (map? %) (= "qwen3.5:4b-q8_0" (get % "name"))) (get payload "models")))))))))

(deftest ^:async bridges-native-api-chat-requests-through-the-openai-compatible-upstream-chat-endpoint
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :upstream-handler (fn [req body]
                            (reset! seen {:path (fx/req-url req) :body (fx/parse-json body)})
                            (fx/json-reply {:model "qwen3.5:4b-q8_0" :created_at "2026-03-09T00:00:00.000Z"
                                            :message {:role "assistant" :content "native-chat-ok" :thinking "native-thinking-ok"}
                                            :done true :done_reason "stop" :prompt_eval_count 4 :eval_count 2}))}
       (^:async fn [{:keys [app]}]
         (let [response (await (inject app {:method "POST" :url "/api/chat"
                                            :payload {:model "qwen3.5:4b-q8_0"
                                                      :messages [{:role "user" :content "hello"}]
                                                      :think false :stream false}}))
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= "/v1/chat/completions" (:path @seen)))
           (is (map? (:body @seen)))
           (is (= "qwen3.5:4b-q8_0" (get-in @seen [:body "model"])))
           (is (map? payload))
           (is (map? (get payload "message")))
           (is (= "native-chat-ok" (get-in payload ["message" "content"])))
           (is (= "native-thinking-ok" (get-in payload ["message" "thinking"])))))))))

(deftest ^:async proxies-native-api-generate-through-the-upstream-ollama-generate-endpoint
  (await
   (with-proxy-app
     {:keys []
      :upstream-handler (fn [req _]
                          (fx/json-reply {:model (if (= "/api/generate" (fx/req-url req)) "qwen3.5:2b-bf16" "unknown")
                                          :response "{\"ok\":true}" :done true :done_reason "stop" :context [1 2 3]}))}
     (^:async fn [{:keys [app]}]
       (let [response (await (inject app {:method "POST" :url "/api/generate"
                                          :payload {:model "qwen3.5:2b-bf16" :prompt "Return JSON"}}))
             payload (:json response)]
         (is (= 200 (:status response)))
         (is (map? payload))
         (is (= "{\"ok\":true}" (get payload "response"))))))))
