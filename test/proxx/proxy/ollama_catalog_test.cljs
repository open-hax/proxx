(ns proxx.proxy.ollama-catalog-test
  "Ollama provider catalog models, largest-size aliases and unknown-model handling.
   Ported from src/tests/proxy.test.ts."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-d :as h :refer [with-proxy-app]]))

(defn- json-ok [body] {:status 200 :headers {"content-type" "application/json"} :body (h/json-str body)})

(defn- models-list-request? [^js request]
  (and (= "GET" (.-method request)) (= "/v1/models" (.-url request))))

(deftest ^:async includes-ollama-provider-catalog-models-and-largest-size-aliases-in-v1-models
  (await
   (with-proxy-app
     {:keys [] :handle-model-catalog true
      :keys-payload {"providers" {"ollama-cloud" ["ollama-catalog-key"]}}
      :models {"preferred" ["gpt-5.3-codex"] "disabled" [] "aliases" {}}
      :config-overrides {"upstreamProviderId" "ollama-cloud"}
      :upstream-handler (fn [request _]
                          (json-ok (if (models-list-request? request)
                                     {"object" "list"
                                      "data" (mapv (fn [id] {"id" id})
                                                   ["qwen3.5:32b" "qwen3.5:397b" "qwen3-coder:30b" "qwen3-coder:480b"
                                                    "qwen3-vl:90b-instruct" "qwen3-vl:235b"])}
                                     {"ok" true})))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/inject app {:method "GET" :url "/v1/models"}))
            ids (set (keep #(when (map? %) (let [id (get % "id")] (when (string? id) id))) (get (:json r) "data")))]
        (is (= 200 (:status r)))
        (is (map? (:json r)))
        (is (= "list" (get (:json r) "object")))
        (is (vector? (get (:json r) "data")))
        (is (contains? ids "qwen3.5:397b"))
        (is (contains? ids "qwen3-coder:480b"))
        (is (contains? ids "qwen3-vl:235b"))
        (is (contains? ids "qwen3.5"))
        (is (contains? ids "qwen3-coder"))
        (is (contains? ids "qwen3-vl"))
        (is (not (contains? ids "gpt-5.3-codex"))))))))

(deftest ^:async returns-404-when-requested-model-is-not-in-provider-catalogs
  (await
   (with-proxy-app
     {:keys ["key-a"] :handle-model-catalog true
      :models {"preferred" ["gpt-5.3-codex"] "disabled" [] "aliases" {}}
      :keys-payload {"providers" {"vivgrid" ["key-a"]}}
      :config-overrides {"upstreamProviderId" "vivgrid"}
      :upstream-handler (fn [request _]
                          (json-ok (if (models-list-request? request)
                                     {"object" "list" "data" [{"id" "gpt-5.3-codex"}]}
                                     {"ok" true})))}
     (fn ^:async run [{:keys [app]}]
      (let [r (await (h/chat app {"model" "gemini-3.1-pro-preview"
                                  "messages" [{"role" "user" "content" "hello"}] "stream" false}))]
        (is (= 404 (:status r)))
        (is (= "model_not_found" (get (:headers r) "x-open-hax-error-code")))
        (is (map? (:json r)))
        (is (map? (get (:json r) "error")))
        (is (= "model_not_found" (get-in (:json r) ["error" "code"]))))))))

(deftest ^:async rewrites-largest-model-alias-requests-for-ollama-catalog-models
  (let [observed-models (atom [])]
    (await
     (with-proxy-app
       {:keys [] :handle-model-catalog true
        :keys-payload {"providers" {"ollama-cloud" ["ollama-alias-key"]}}
        :config-overrides {"upstreamProviderId" "ollama-cloud"}
        :upstream-handler
        (fn [request body]
          (cond
            (models-list-request? request)
            (json-ok {"object" "list" "data" [{"id" "qwen3.5:32b"} {"id" "qwen3.5:397b"}]})

            (and (= "POST" (.-method request)) (= "/v1/chat/completions" (.-url request)))
            (let [parsed (h/parse-json body)]
              (is (map? parsed))
              (swap! observed-models conj (let [m (get parsed "model")] (if (string? m) m "")))
              (json-ok {"id" "chatcmpl-qwen-alias" "object" "chat.completion" "model" "qwen3.5:397b"
                        "choices" [{"index" 0 "message" {"role" "assistant" "content" "alias-ok"}
                                    "finish_reason" "stop"}]}))

            :else {:status 404 :headers {"content-type" "application/json"}
                   :body (h/json-str {"error" {"message" "unexpected path"}})}))}
       (fn ^:async run [{:keys [app]}]
        (let [r (await (h/chat app {"model" "qwen3.5" "messages" [{"role" "user" "content" "hello"}]
                                    "stream" false}))]
          (is (= 200 (:status r)))
          (is (= "qwen3.5->qwen3.5:397b" (get (:headers r) "x-open-hax-model-alias")))
          (is (= ["qwen3.5:397b"] @observed-models))
          (is (map? (:json r)))
          (is (vector? (get (:json r) "choices")))
          (is (map? (get-in (:json r) ["choices" 0])))
          (is (map? (get-in (:json r) ["choices" 0 "message"])))
          (is (= "alias-ok" (get-in (:json r) ["choices" 0 "message" "content"])))))))))
