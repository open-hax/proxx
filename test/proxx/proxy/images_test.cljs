(ns proxx.proxy.images-test
  "OpenAI image generation through the application: which upstream an OAuth
  account may use, and the Codex Responses fallback."
  (:require [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.proxy.support :as s]))

(def ^:private openai-api-base-url "https://api.openai.com")
(def ^:private openai-base-url "https://chatgpt.com/backend-api")

(defn- json-response [status body]
  (js/Response. (s/json-str body)
                #js {"status" status "headers" #js {"content-type" "application/json"}}))

(def ^:private oauth-account-keys
  {"providers" {"openai" {"auth" "oauth_bearer"
                          "accounts" [{"access_token" (s/make-jwt {"https://api.openai.com/auth" {"chatgpt_account_id" "acc-1"}})
                                       "chatgpt_account_id" "acc-1"}]}}})

(def ^:private image-request
  {"model" "gpt-image-1" "prompt" "a red square" "response_format" "b64_json"})

(defn- init-body [^js init] (when init (.-body init)))

(deftest ^:async openai-images-auto-mode-routes-oauth-tokens-to-platform-api-only
  (let [seen-urls (atom [])]
    (await
     (s/with-patched-fetch
       (fn [input _init _original]
         (let [url (s/request-url input)]
           (when (str/includes? url "images")
             (swap! seen-urls conj url)
             (if (= url (str openai-api-base-url "/v1/images/generations"))
               (json-response 200 {"created" 1 "data" [{"b64_json" "AAAA"}]})
               (json-response 500 {"error" {"message" (str "Unexpected URL: " url)}})))))
       (fn ^:async run []
         (await
          (s/with-proxy-app
            {:keys [] :keys-payload oauth-account-keys
             :config-overrides {:upstreamProviderId "openai" :openaiProviderId "openai"
                                :openaiImagesUpstreamMode "auto"
                                :openaiApiBaseUrl openai-api-base-url :openaiBaseUrl openai-base-url}
             :upstream-handler (fn [_ _] {:status 500 :body "unexpected upstream call"})}
            (fn ^:async run [{:keys [app]}]
              (let [response (await (s/post-json app "/v1/images/generations" image-request s/local-auth))]
                (is (= 200 (:status response)))
                (is (map? (:json response)))
                (is (= [{"b64_json" "AAAA"}] (get (:json response) "data"))))))))))
    ;; auto mode should only hit the Platform API -- the ChatGPT backend doesn't support image gen.
    (is (= [(str openai-api-base-url "/v1/images/generations")] @seen-urls))))

(def ^:private codex-responses-sse
  (str "data: " (s/json-str {"type" "response.output_item.done"
                             "item" {"type" "image_generation_call" "id" "ig_1" "status" "completed" "result" "AAAA"}})
       "\n\n"
       "data: " (s/json-str {"type" "response.completed"
                             "response" {"id" "resp_1"
                                         "output" [{"type" "image_generation_call" "id" "ig_1"
                                                    "status" "completed" "result" "AAAA"}]}})
       "\n\n"
       "data: [DONE]\n\n"))

(deftest ^:async openai-images-auto-mode-falls-back-to-codex-responses-image-generation-when-platform-rejects-oauth-scopes
  (let [seen-urls (atom [])
        seen-bodies (atom [])]
    (await
     (s/with-patched-fetch
       (fn [input init _original]
         (let [url (s/request-url input)]
           (when (or (str/includes? url "openai.com") (str/includes? url "chatgpt.com"))
             (let [body (init-body init)]
               (when (string? body)
                 (try (swap! seen-bodies conj (s/parse-json body)) (catch :default _ nil))))
             (swap! seen-urls conj url)
             (cond
               (= url (str openai-api-base-url "/v1/images/generations"))
               (js/Response. (s/json-str {"error" {"message" "Missing scopes: api.model.images.request"
                                                   "type" "invalid_request_error"}})
                             #js {"status" 403 "headers" #js {"content-type" "application/json"}})

               (= url (str openai-base-url "/codex/responses"))
               (js/Response. codex-responses-sse
                             #js {"status" 200 "headers" #js {"content-type" "text/event-stream"}})

               :else (json-response 500 {"error" {"message" (str "Unexpected URL: " url)}})))))
       (fn ^:async run []
         (await
          (s/with-proxy-app
            {:keys [] :keys-payload oauth-account-keys
             :config-overrides {:upstreamProviderId "openai" :openaiProviderId "openai"
                                :openaiImagesUpstreamMode "auto"
                                :openaiApiBaseUrl openai-api-base-url :openaiBaseUrl openai-base-url
                                :openaiResponsesPath "/codex/responses"}
             :upstream-handler (fn [_ _] {:status 500 :body "unexpected upstream call"})}
            (fn ^:async run [{:keys [app]}]
              (let [response (await (s/post-json app "/v1/images/generations" image-request s/local-auth))]
                (is (= 200 (:status response)))
                (is (map? (:json response)))
                (is (= [{"b64_json" "AAAA"}] (get (:json response) "data"))))))))))
    (is (= [(str openai-api-base-url "/v1/images/generations") (str openai-base-url "/codex/responses")]
           @seen-urls))
    ;; the fallback request is a Responses API payload forcing image_generation
    (let [fallback (first (filter #(contains? % "tools") @seen-bodies))
          tools (get fallback "tools")]
      (is (map? fallback))
      (is (= "gpt-5.4-mini" (get fallback "model")))
      (is (= "required" (get fallback "tool_choice")))
      (is (vector? tools))
      (is (map? (first tools)))
      (is (= "image_generation" (get (first tools) "type"))))))
