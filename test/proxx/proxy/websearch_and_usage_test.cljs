(ns proxx.proxy.websearch-and-usage-test
  "`/api/tools/websearch` (OpenAI Responses web_search with an Exa MCP fallback) and
  the token-usage columns recorded in the request log, through the real application."
  (:require [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.proxy.fixture-c :as fx :refer [with-proxy-app post-json inject]]))

(def ^:private proxy-auth {"authorization" "Bearer proxy-token"})

(def ^:private openai-keys
  {:providers {:openai {:auth "oauth_bearer"
                        :accounts [{:id "openai-a" :access_token "oa-token-a" :chatgpt_account_id "chatgpt-a"}]}}})

(defn- sse-text [& events]
  (apply str (map (fn [[event data]] (fx/sse-frame event data)) events)))

(defn- exa-response
  "The Exa MCP answer carrying `text`."
  [text]
  (fx/sse-response (str "data: " (fx/json-str {:jsonrpc "2.0" :result {:content [{:type "text" :text text}]}}) "\n\n")))

(defn- exa-fetch-handler
  "A patched-fetch handler answering the Exa MCP endpoint with `text` (recording the
  call in `calls`), passing loopback requests through and refusing every other URL."
  [calls order text]
  (fn [input init _]
    (let [url (fx/request-url input)]
      (cond
        (str/includes? url "mcp.exa.ai")
        (do (swap! order conj "exa")
            (swap! calls conj (fx/parse-json (.-body init)))
            (exa-response text))

        (str/starts-with? url "http://127.0.0.1:") nil

        :else (throw (js/Error. (str "Unexpected fetch URL: " url)))))))

(defn- websearch [app payload]
  (inject app {:method "POST" :url "/api/tools/websearch"
               :headers (merge fx/json-headers proxy-auth) :payload payload}))

(deftest ^:async api-tools-websearch-proxies-via-responses-web-search-and-extracts-url-citations
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :keys-payload openai-keys
        :proxy-auth-token "proxy-token"
        :config-overrides {:upstreamProviderId "openai"}
        :upstream-handler
        (fn [req body]
          (reset! seen {:path (fx/req-url req) :body (fx/parse-json body)})
          (fx/sse-reply
           (fx/sse-frame "response.created" {:type "response.created"
                                             :response {:id "resp_ws" :status "in_progress" :model "gpt-5.4-mini" :output []}})
           (fx/sse-frame "response.completed"
                         {:type "response.completed"
                          :response {:id "resp_ws" :status "completed" :model "gpt-5.4-mini"
                                     :output [{:type "web_search_call" :id "ws_1" :status "completed"
                                               :action {:type "search" :query "example query"}}
                                              {:type "message" :role "assistant"
                                               :content [{:type "output_text"
                                                          :text "- [Example](https://example.com) — Example snippet."
                                                          :annotations [{:type "url_citation" :url "https://example.com" :title "Example"}]}]}]
                                     :usage {:input_tokens 5 :output_tokens 2 :total_tokens 7}}})))}
       (^:async fn [{:keys [app]}]
         (let [response (await (websearch app {:query "example query" :numResults 5
                                               :searchContextSize "medium" :model "gpt-5.4-mini"}))
               body (:json response)
               {:keys [path] observed :body} @seen]
           (is (= 200 (:status response)))
           (is (= "/v1/responses" path))
           (is (some? observed))
           (is (vector? (get observed "tools")))
           (is (some #(and (map? %) (= "web_search" (get % "type"))) (get observed "tools")))
           (is (map? body))
           (is (string? (get body "output")))
           (is (vector? (get body "sources")))
           (is (= "resp_ws" (get body "responseId")))
           (is (= "gpt-5.4-mini" (get body "model")))
           (is (= "openai" (get body "backend")))
           (is (map? (get-in body ["sources" 0])))
           (is (= "https://example.com" (get-in body ["sources" 0 "url"])))))))))

(deftest ^:async api-tools-websearch-falls-back-to-exa-when-openai-fails
  (let [order (atom []) exa-calls (atom [])]
    (await
     (fx/with-patched-fetch
       (exa-fetch-handler exa-calls order "- [Exa Result](https://exa.example.com) — Found via Exa fallback.")
       (^:async fn []
         (await
          (with-proxy-app
            {:keys []
             :keys-payload openai-keys
             :proxy-auth-token "proxy-token"
             :config-overrides {:upstreamProviderId "openai"}
             :upstream-handler (fn [_ _]
                                 (swap! order conj "openai")
                                 {:status 500 :headers fx/json-headers
                                  :body (fx/json-str {:error {:message "OpenAI web search unavailable"}})})}
            (^:async fn [{:keys [app]}]
              (let [response (await (websearch app {:query "test query" :numResults 5}))
                    body (:json response)]
                (is (= 200 (:status response)))
                (is (seq @exa-calls) "Exa MCP should have been called")
                (is (= "tools/call" (get (first @exa-calls) "method")))
                (is (= "web_search_exa" (get-in (first @exa-calls) ["params" "name"])))
                (is (= ["openai" "exa"] @order))
                (is (map? body))
                (is (= "exa" (get body "backend")))
                (is (string? (get body "output")))
                (is (str/includes? (get body "output") "Exa Result"))
                (is (vector? (get body "sources"))))))))))))

(deftest ^:async api-tools-websearch-falls-back-to-exa-when-openai-returns-empty-output
  (let [order (atom []) exa-calls (atom [])]
    (await
     (fx/with-patched-fetch
       (exa-fetch-handler exa-calls order "- [Exa Empty Fallback](https://exa.example.com/empty) — Recovered from empty OpenAI output.")
       (^:async fn []
         (await
          (with-proxy-app
            {:keys []
             :keys-payload openai-keys
             :proxy-auth-token "proxy-token"
             :config-overrides {:upstreamProviderId "openai"}
             :upstream-handler
             (fn [_ _]
               (swap! order conj "openai")
               (fx/sse-reply
                (fx/sse-frame "response.created" {:type "response.created"
                                                  :response {:id "resp_empty_ws" :status "in_progress" :model "gpt-5.4-mini" :output []}})
                (fx/sse-frame "response.completed" {:type "response.completed"
                                                    :response {:id "resp_empty_ws" :status "completed" :model "gpt-5.4-mini"
                                                               :output []
                                                               :usage {:input_tokens 5 :output_tokens 0 :total_tokens 5}}})))}
            (^:async fn [{:keys [app]}]
              (let [response (await (websearch app {:query "empty query" :numResults 5 :model "gpt-5.2"}))
                    body (:json response)]
                (is (= 200 (:status response)))
                (is (= "tools/call" (get (first @exa-calls) "method")))
                (is (= "web_search_exa" (get-in (first @exa-calls) ["params" "name"])))
                (is (= ["openai" "openai" "openai" "openai" "exa"] @order))
                (is (map? body))
                (is (= "exa" (get body "backend")))
                (is (string? (get body "output")))
                (is (str/includes? (get body "output") "Exa Empty Fallback"))
                (is (vector? (get body "sources"))))))))))))

(deftest ^:async records-token-usage-from-codex-sse-responses-with-missing-content-type
  ;; regression
  (await
   (with-proxy-app
     {:keys []
      :keys-payload openai-keys
      :config-overrides {:upstreamProviderId "openai" :responsesModelPrefixes ["gpt-"]}
      :upstream-handler
      (fn [_ _]
        {:status 200
         :headers {}
         :body (sse-text
                ["response.created" {:type "response.created"
                                     :response {:id "resp_usage" :status "in_progress" :model "gpt-5.4-mini" :output []}}]
                ["response.completed" {:type "response.completed"
                                       :response {:id "resp_usage" :status "completed" :model "gpt-5.4-mini"
                                                  :output [{:type "message" :role "assistant"
                                                            :content [{:type "output_text" :text "OK"}]}]
                                                  :usage {:input_tokens 42 :output_tokens 7 :total_tokens 49
                                                          :input_tokens_details {:cached_tokens 30}}}}])})}
     (^:async fn [{:keys [app]}]
       (let [response (await (post-json app "/v1/chat/completions"
                                        {:model "gpt-5.4-mini" :messages [{:role "user" :content "hello"}] :stream false}))
             logs-response (await (inject app {:method "GET" :url "/api/v1/request-logs?limit=1"}))
             logs (:json logs-response)
             entry (get-in logs ["entries" 0])]
         (is (= 200 (:status response)))
         (is (= 200 (:status logs-response)))
         (is (map? logs))
         (is (vector? (get logs "entries")))
         (is (map? entry))
         (is (= 42 (get entry "promptTokens")) "promptTokens must be extracted from codex SSE usage.input_tokens")
         (is (= 7 (get entry "completionTokens")) "completionTokens must be extracted from codex SSE usage.output_tokens")
         (is (= 49 (get entry "totalTokens")) "totalTokens must be extracted from codex SSE usage.total_tokens")
         (is (= 30 (get entry "cachedPromptTokens")) "cachedPromptTokens must be extracted from input_tokens_details.cached_tokens")
         (is (= true (get entry "cacheHit")) "cacheHit must be true when cached_tokens > 0"))))))

(deftest ^:async extracts-cached-prompt-tokens-from-messages-usage-cache-read-input-tokens
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler
      (fn [_ _]
        (fx/json-reply {:id "msg_cache_usage" :type "message" :role "assistant" :model "claude-3-7-sonnet"
                        :content [{:type "text" :text "OK"}]
                        :usage {:input_tokens 42 :output_tokens 7
                                :cache_read_input_tokens 28 :cache_creation_input_tokens 128}}))}
     (^:async fn [{:keys [app]}]
       (let [response (await (post-json app "/v1/chat/completions"
                                        {:model "claude-3-7-sonnet" :messages [{:role "user" :content "hello"}] :stream false}))
             logs-response (await (inject app {:method "GET" :url "/api/v1/request-logs?providerId=vivgrid&limit=1"}))
             logs (:json logs-response)
             entry (get-in logs ["entries" 0])]
         (is (= 200 (:status response)))
         (is (= 200 (:status logs-response)))
         (is (map? logs))
         (is (vector? (get logs "entries")))
         (is (map? entry))
         (is (= 42 (get entry "promptTokens")))
         (is (= 7 (get entry "completionTokens")))
         (is (= 49 (get entry "totalTokens")))
         (is (= 28 (get entry "cachedPromptTokens")))
         (is (= true (get entry "cacheHit"))))))))
