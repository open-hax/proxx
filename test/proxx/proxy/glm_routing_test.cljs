(ns proxx.proxy.glm-routing-test
  "GLM models route to rotussy (never ollama-cloud nor the openai provider) when
  rotussy is configured, for chat completions and for Responses requests."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.fixture-c :as fx :refer [with-proxy-app with-env post-json]]))

(def ^:private openai-keys
  {:providers {:openai {:auth "oauth_bearer"
                        :accounts [{:id "openai-a" :access_token "oa-token-a" :chatgpt_account_id "chatgpt-a"}]}}})

(def ^:private rotussy-env
  {"ROTUSSY_API_KEY" "rotussy-key-1" ; pragma: allowlist secret
   "ROTUSSY_PROVIDER_ID" nil "REQUESTY_API_TOKEN" nil "REQUESTY_API_KEY" nil
   "OPENROUTER_API_KEY" nil "GEMINI_API_KEY" nil "ZAI_API_KEY" nil "ZHIPU_API_KEY" nil})

(def ^:private glm-overrides
  {:upstreamProviderId "openai" :localOllamaEnabled false :cljsPolicyShadowMode true})

(defn- chat-completion [id created model message]
  {:id id :object "chat.completion" :created created :model model
   :choices [{:index 0 :message message :finish_reason "stop"}]})

(deftest ^:async glm-chat-requests-route-to-rotussy-instead-of-ollama-cloud-or-the-openai-provider-when-rotussy-is-configured
  (let [attempts (atom []) seen-body (atom nil)]
    (await
     (with-env rotussy-env
       (^:async fn []
         (await
          (with-proxy-app
            {:keys [] :keys-payload openai-keys :models ["glm-5"] :config-overrides glm-overrides
             :upstream-handler
             (fn [req body]
               (if (and (= "GET" (fx/req-method req)) (= "/models" (fx/req-url req)))
                 (fx/json-reply {:object "list" :data [{:id "glm-5"}]})
                 (do (swap! attempts conj {:path (fx/req-url req) :auth (fx/req-header req "authorization")})
                     (reset! seen-body (fx/parse-json body))
                     (fx/json-reply (chat-completion "chatcmpl_rotussy_glm" 1772516811 "glm-5"
                                                     {:role "assistant" :content "rotussy-glm-routed"})))))}
            (^:async fn [{:keys [app]}]
              (let [response (await (post-json app "/v1/chat/completions"
                                               {:model "glm-5" :messages [{:role "user" :content "hello"}] :stream false}))]
                (is (= 200 (:status response)))
                (is (= [{:path "/v1/chat/completions" :auth "Bearer rotussy-key-1"}] @attempts))
                (is (map? @seen-body))
                (is (= "glm-5" (get @seen-body "model")))
                (is (= "rotussy" (get-in response [:headers "x-open-hax-upstream-provider"])))
                (is (map? (:json response)))
                (is (= "rotussy-glm-routed" (get-in response [:json "choices" 0 "message" "content"]))))))))))))

(deftest ^:async glm-chat-requests-skip-ollama-cloud-when-provider-catalog-does-not-advertise-the-requested-model
  (let [auths (atom []) bodies (atom [])]
    (await
     (with-env rotussy-env
       (^:async fn []
         (await
          (with-proxy-app
            {:keys []
             :handle-model-catalog true
             :keys-payload (assoc-in openai-keys [:providers :ollama-cloud] ["ollama-cloud-key"])
             :models ["glm-4.7-flash"]
             :config-overrides glm-overrides
             :upstream-handler
             (fn [req body]
               (let [auth (fx/req-header req "authorization")
                     catalog (fn [id] (fx/json-reply {:object "list" :data [{:id id}]}))]
                 (if (and (= "GET" (fx/req-method req)) (contains? #{"/v1/models" "/models"} (fx/req-url req)))
                   (case auth
                     "Bearer ollama-cloud-key" (catalog "Kimi-K2.5")
                     "Bearer rotussy-key-1" (catalog "glm-4.7-flash")
                     (catalog "gpt-5.4"))
                   (do (swap! auths conj (or auth ""))
                       (swap! bodies conj (fx/parse-json body))
                       (fx/json-reply (chat-completion "chatcmpl_rotussy_glm_skip_ollama" 1772516811 "glm-4.7-flash"
                                                       {:role "assistant" :content "rotussy-only"}))))))}
            (^:async fn [{:keys [app]}]
              (let [response (await (post-json app "/v1/chat/completions"
                                               {:model "glm-4.7-flash" :messages [{:role "user" :content "hello"}] :stream false}))]
                (is (= 200 (:status response)))
                (is (= "rotussy" (get-in response [:headers "x-open-hax-upstream-provider"])))
                (is (= ["Bearer rotussy-key-1"] @auths))
                (is (not-any? #(= "Bearer ollama-cloud-key" %) @auths))
                (is (= ["glm-4.7-flash"] (mapv #(get % "model") @bodies))))))))))))

(deftest ^:async glm-v1-responses-requests-route-through-rotussy-chat-completions-compatibility-when-rotussy-is-configured
  (let [attempts (atom []) seen-body (atom nil)]
    (await
     (with-env rotussy-env
       (^:async fn []
         (await
          (with-proxy-app
            {:keys [] :keys-payload openai-keys :models ["glm-5"] :config-overrides glm-overrides
             :upstream-handler
             (fn [req body]
               (if (and (= "GET" (fx/req-method req)) (= "/models" (fx/req-url req)))
                 (fx/json-reply {:object "list" :data [{:id "glm-5"}]})
                 (do (swap! attempts conj {:path (fx/req-url req) :auth (fx/req-header req "authorization")})
                     (reset! seen-body (fx/parse-json body))
                     (fx/json-reply (assoc (chat-completion "chatcmpl_rotussy_glm5" 1772516812 "glm-5"
                                                            {:role "assistant" :content "rotussy-responses-routed"
                                                             :reasoning_content "brief reasoning"})
                                           :usage {:prompt_tokens 6 :completion_tokens 3 :total_tokens 9
                                                   :completion_tokens_details {:reasoning_tokens 2}})))))}
            (^:async fn [{:keys [app]}]
              (let [response (await (post-json app "/v1/responses"
                                               {:model "glm-5"
                                                :input [{:role "user" :content [{:type "input_text" :text "hello"}]}]
                                                :instructions "" :stream false}
                                               {"authorization" "Bearer local-test"}))
                    payload (:json response)]
                (is (= 200 (:status response)))
                (is (= [{:path "/v1/chat/completions" :auth "Bearer rotussy-key-1"}] @attempts))
                (is (map? @seen-body))
                (is (= "glm-5" (get @seen-body "model")))
                (is (vector? (get @seen-body "messages")))
                (is (= "rotussy" (get-in response [:headers "x-open-hax-upstream-provider"])))
                (is (= "chat_completions" (get-in response [:headers "x-open-hax-upstream-mode"])))
                (is (map? payload))
                (is (= "response" (get payload "object")))
                (is (= "glm-5" (get payload "model")))
                (is (vector? (get payload "output")))
                (is (= "rotussy-responses-routed" (get-in payload ["output" 1 "content" 0 "text"]))))))))))))
