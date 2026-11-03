(ns proxx.proxy.health-models-test
  "Health, landing page and the models surface of the proxy: preferred ordering, declared and
   alias models, auto:cheapest ranking and disabled models. Ported from src/tests/proxy.test.ts."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-d :as h :refer [with-proxy-app bearer-key]]))

(defn- json-ok [body] {:status 200 :headers {"content-type" "application/json"} :body (h/json-str body)})
(defn- json-reply [status body] {:status status :headers {"content-type" "application/json"} :body (h/json-str body)})

(defn- models-list-request? [^js request]
  (and (= "GET" (.-method request)) (= "/v1/models" (.-url request))))

(defn- model-ids [r] (keep #(get % "id") (get (:json r) "data")))

(defn- hello [model] {"model" model "messages" [{"role" "user" "content" "hello"}] "stream" false})

(deftest ^:async reports-health-diagnostics-with-key-pool-state
  (await
   (with-proxy-app
     {:keys ["key-a"] :upstream-handler (fn [_ _] (json-ok {"ok" true}))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/inject app {:method "GET" :url "/health"}))
            payload (:json r)]
        (is (= 200 (:status r)))
        (is (map? payload))
        (is (= "unauthenticated" (get payload "authMode")))
        (is (map? (get payload "keyPool")))
        (is (= 1 (get-in payload ["keyPool" "totalKeys"])))
        (is (= 1 (get-in payload ["keyPool" "availableKeys"])))
        (is (= 0 (get-in payload ["keyPool" "cooldownKeys"])))
        (is (= 0 (get-in payload ["keyPool" "nextReadyInMs"]))))))))

(deftest ^:async allows-unauthenticated-access-to-health-when-proxy-auth-is-enabled
  (await
   (with-proxy-app
     {:proxy-auth-token "proxy-secret" :keys ["key-a"] :upstream-handler (fn [_ _] (json-ok {"ok" true}))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/inject app {:method "GET" :url "/health"}))]
        (is (= 200 (:status r)))
        (is (map? (:json r)))
        (is (true? (get (:json r) "ok")))
        (is (= "token" (get (:json r) "authMode"))))))))

(deftest ^:async serves-a-public-landing-page-at-root-when-proxy-auth-is-enabled
  (await
   (with-proxy-app
     {:proxy-auth-token "proxy-secret" :keys ["key-a"] :upstream-handler (fn [_ _] (json-ok {"ok" true}))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/inject app {:method "GET" :url "/" :headers {"host" "localhost:8789"}}))]
        (is (= 200 (:status r)))
        (is (= "text/html; charset=utf-8" (get (:headers r) "content-type")))
        (is (re-find #"Open Hax OpenAI Proxy" (:body r)))
        (is (re-find #"http://localhost:5174" (:body r)))
        (is (re-find #"Proxy Token" (:body r))))))))

(deftest ^:async landing-page-prefers-forwarded-host-when-inferring-web-console-url
  (await
   (with-proxy-app
     {:proxy-auth-token "proxy-secret" :keys ["key-a"] :upstream-handler (fn [_ _] (json-ok {"ok" true}))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/inject app {:method "GET" :url "/"
                                    :headers {"host" "internal-proxy:8789"
                                              "x-forwarded-host" "proxy.example.com:443"
                                              "x-forwarded-proto" "https"}}))]
        (is (= 200 (:status r)))
        (is (re-find #"https://proxy\.example\.com:5174" (:body r))))))))

(deftest ^:async serves-preferred-model-ordering-from-models-json-file
  (await
   (with-proxy-app
     {:keys ["key-a"] :handle-model-catalog true
      :models {"preferred" ["gpt-5.3-codex" "gemini-3.1-pro-preview"] "disabled" [] "aliases" {}}
      :keys-payload {"providers" {"vivgrid" ["key-a"]}}
      :config-overrides {"upstreamProviderId" "vivgrid"}
      :upstream-handler (fn [request _]
                          (json-ok (if (models-list-request? request)
                                     {"object" "list" "data" [{"id" "gpt-5.3-codex"} {"id" "gemini-3.1-pro-preview"}]}
                                     {"ok" true})))}
     (fn ^:async run [{:keys [app]}]
      (let [list-r (await (h/inject app {:method "GET" :url "/v1/models"}))
            model-r (await (h/inject app {:method "GET" :url "/v1/models/gpt-5.3-codex"}))]
        (is (= 200 (:status list-r)))
        (is (= "list" (get (:json list-r) "object")))
        (is (vector? (get (:json list-r) "data")))
        (is (= 2 (count (get (:json list-r) "data"))))
        (is (= "gpt-5.3-codex" (get-in (:json list-r) ["data" 0 "id"])))
        (is (= "gemini-3.1-pro-preview" (get-in (:json list-r) ["data" 1 "id"])))
        (is (= 200 (:status model-r)))
        (is (= "gpt-5.3-codex" (get (:json model-r) "id"))))))))

(deftest ^:async publishes-declared-static-and-synthetic-models-from-models-json-alongside-discovered-models
  (await
   (with-proxy-app
     {:keys ["key-a"] :handle-model-catalog true
      :models {"models" ["gpt-5.4-mini" "gpt-5.4-nano" "auto:cheapest"] "preferred" ["gpt-5.3-codex"]
               "disabled" [] "aliases" {}}
      :keys-payload {"providers" {"vivgrid" ["key-a"]}}
      :config-overrides {"upstreamProviderId" "vivgrid"}
      :upstream-handler (fn [request _]
                          (json-ok (if (models-list-request? request)
                                     {"object" "list" "data" [{"id" "gpt-5.3-codex"}]}
                                     {"ok" true})))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/inject app {:method "GET" :url "/v1/models"}))
            ids (set (model-ids r))]
        (is (= 200 (:status r)))
        (is (vector? (get (:json r) "data")))
        (is (contains? ids "gpt-5.3-codex"))
        (is (contains? ids "gpt-5.4-mini"))
        (is (contains? ids "gpt-5.4-nano"))
        (is (contains? ids "auto:cheapest")))))))

(deftest ^:async routes-declared-alias-models-without-requiring-provider-catalog-discovery
  (let [observed-models (atom [])]
    (await
     (with-proxy-app
       {:keys ["key-a"]
        :models {"models" ["model-f16.gguf"] "preferred" [] "disabled" []
                 "aliases" {"blongs-definately-legit-model" "model-f16.gguf"}}
        :keys-payload {"providers" {"vivgrid" ["key-a"]}}
        :config-overrides {"upstreamProviderId" "vivgrid"}
        :upstream-handler
        (fn [^js request body]
          (if (and (= "POST" (.-method request)) (= "/v1/chat/completions" (.-url request)))
            (let [parsed (h/parse-json body)]
              (is (map? parsed))
              (swap! observed-models conj (let [m (get parsed "model")] (if (string? m) m "")))
              (json-ok {"id" "chatcmpl-blongs" "object" "chat.completion" "model" "model-f16.gguf"
                        "choices" [{"index" 0 "message" {"role" "assistant" "content" "blongs-ok"}
                                    "finish_reason" "stop"}]}))
            (json-reply 404 {"error" {"message" "catalog not configured"}})))}
       (fn ^:async run [{:keys [app]}]
        (let [list-r (await (h/inject app {:method "GET" :url "/v1/models"}))
              ids (set (model-ids list-r))]
          (is (= 200 (:status list-r)))
          (is (vector? (get (:json list-r) "data")))
          (is (contains? ids "model-f16.gguf"))
          (is (contains? ids "blongs-definately-legit-model"))
          (let [r (await (h/chat app (hello "blongs-definately-legit-model")))]
            (is (= 200 (:status r)))
            (is (= "blongs-definately-legit-model->model-f16.gguf" (get (:headers r) "x-open-hax-model-alias")))
            (is (= ["model-f16.gguf"] @observed-models))
            (is (vector? (get (:json r) "choices")))
            (is (= "blongs-ok" (get-in (:json r) ["choices" 0 "message" "content"]))))))))))

(deftest ^:async auto-cheapest-falls-through-to-the-next-ranked-model-when-the-cheapest-priced-candidate-fails
  (let [observed-models (atom [])]
    (await
     (with-proxy-app
       {:keys [] :handle-model-catalog true
        :models {"models" ["gpt-5.4-nano" "deepseek-v3.2" "auto:cheapest"] "preferred" [] "disabled" [] "aliases" {}}
        :keys-payload {"providers" {"openai" ["openai-key"] "ollama-cloud" ["ollama-key"]}}
        :config-overrides {"upstreamProviderId" "openai" "localOllamaEnabled" false}
        :upstream-handler
        (fn [^js request body]
          (let [key (bearer-key request)
                post? (= "POST" (.-method request))
                parsed (when post? (h/parse-json body))
                model (get parsed "model")]
            (when (and post? (string? model)) (swap! observed-models conj model))
            (cond
              (and (models-list-request? request) (= "openai-key" key))
              (json-ok {"object" "list" "data" [{"id" "gpt-5.4-nano"}]})
              (and (models-list-request? request) (= "ollama-key" key))
              (json-ok {"object" "list" "data" [{"id" "deepseek-v3.2"}]})
              (and post? (= "gpt-5.4-nano" model))
              (json-reply 400 {"error" {"message" "model unavailable"}})
              (and post? (= "deepseek-v3.2" model))
              (json-ok {"id" "chatcmpl-auto" "object" "chat.completion" "created" 1 "model" "deepseek-v3.2"
                        "choices" [{"index" 0 "message" {"role" "assistant" "content" "OK"} "finish_reason" "stop"}]
                        "usage" {"prompt_tokens" 4 "completion_tokens" 1 "total_tokens" 5}})
              :else (json-reply 404 {"error" {"message" "unexpected request"}}))))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app {"model" "auto:cheapest"
                                    "messages" [{"role" "user" "content" "Reply with exactly OK."}]
                                    "stream" false}))]
          (is (= 200 (:status r)))
          (is (= "gpt-5.4-nano,deepseek-v3.2" (get (:headers r) "x-open-hax-auto-model-candidates")))
          (is (= ["gpt-5.4-nano" "deepseek-v3.2"] @observed-models))
          (is (map? (:json r)))
          (is (= "deepseek-v3.2" (get (:json r) "model")))
          (is (vector? (get (:json r) "choices")))
          (is (= "OK" (get-in (:json r) ["choices" 0 "message" "content"])))))))))

(deftest ^:async v1-responses-auto-cheapest-ranks-only-models-reachable-by-responses-providers
  (let [observed-models (atom [])]
    (await
     (with-proxy-app
       {:keys [] :handle-model-catalog true
        :models {"models" ["deepseek-v3.2" "gpt-5.4" "auto:cheapest"] "preferred" [] "disabled" [] "aliases" {}}
        :keys-payload {"providers" {"openai" ["openai-key"] "ollama-cloud" ["ollama-key"]}}
        :config-overrides {"upstreamProviderId" "openai" "localOllamaEnabled" false}
        :upstream-handler
        (fn [^js request body]
          (let [key (bearer-key request)]
            (cond
              (and (models-list-request? request) (= "openai-key" key))
              (json-ok {"object" "list" "data" [{"id" "gpt-5.4"}]})
              (and (models-list-request? request) (= "ollama-key" key))
              (json-ok {"object" "list" "data" [{"id" "deepseek-v3.2"}]})
              (and (= "POST" (.-method request)) (= "/v1/responses" (.-url request)))
              (let [model (get (h/parse-json body) "model")]
                (when (string? model) (swap! observed-models conj model))
                (json-ok {"id" "resp_auto" "object" "response" "model" model
                          "output" [{"type" "message" "role" "assistant"
                                     "content" [{"type" "output_text" "text" "OK" "annotations" []}]}]}))
              :else (json-reply 404 {"error" {"message" "unexpected request"}}))))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/inject app {:method "POST" :url "/v1/responses"
                                      :headers {"content-type" "application/json"}
                                      :payload {"model" "auto:cheapest" "input" "Reply with exactly OK."
                                                "stream" false "max_output_tokens" 8}}))]
          (is (= 200 (:status r)))
          (is (= "gpt-5.4" (get (:headers r) "x-open-hax-auto-model-candidates")))
          (is (= ["gpt-5.4"] @observed-models))
          (is (map? (:json r)))
          (is (= "gpt-5.4" (get (:json r) "model")))))))))

(deftest ^:async returns-403-when-requested-model-is-disabled
  (await
   (with-proxy-app
     {:keys ["key-a"] :handle-model-catalog true
      :models {"preferred" ["gpt-5.3-codex" "gemini-3.1-pro-preview"] "disabled" ["gemini-3.1-pro-preview"] "aliases" {}}
      :keys-payload {"providers" {"vivgrid" ["key-a"]}}
      :config-overrides {"upstreamProviderId" "vivgrid"}
      :upstream-handler (fn [request _]
                          (json-ok (if (models-list-request? request)
                                     {"object" "list" "data" [{"id" "gpt-5.3-codex"} {"id" "gemini-3.1-pro-preview"}]}
                                     {"ok" true})))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/chat app (hello "gemini-3.1-pro-preview")))]
        (is (= 403 (:status r)))
        (is (= "model_disabled" (get (:headers r) "x-open-hax-error-code")))
        (is (map? (:json r)))
        (is (map? (get (:json r) "error")))
        (is (= "model_disabled" (get-in (:json r) ["error" "code"]))))))))
