(ns proxx.runtime.factory-strategy-test
  "Factory routing: model classification, request headers, system-prompt handling,
  and the end-to-end route to the Factory endpoints. Ported from the TypeScript
  factory-strategy tests (and the Factory Responses payload regression from the
  factory-oauth tests), over the CLJS kernels the TypeScript modules delegate to.
  The integration tests run the real application (see `proxx.support.app`)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.config :as config]
            [proxx.runtime.factory :as factory]
            [proxx.runtime.routing :as routing]
            [proxx.runtime.strategies :as strategies]
            [proxx.runtime.strategy :as strategy]
            [proxx.support.app :as app]
            [proxx.support.tmp :refer [with-env]]))

(set! *warn-on-infer* false)

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")

(def ^:private uuid-regex #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

(defn- model-type [model] (factory/get-factory-model-type-js manifest model))

;; --- Unit tests: model type classification ------------------------------------

;; VAL-ROUTE-005: Model-to-type mapping selects correct strategy

(deftest get-factory-model-type-maps-claude-to-anthropic
  (is (= "anthropic" (model-type "claude-opus-4-5")))
  (is (= "anthropic" (model-type "claude-3.5-sonnet")))
  (is (= "anthropic" (model-type "Claude-Opus-4-5"))))

(deftest get-factory-model-type-maps-gpt-to-openai
  (is (= "openai" (model-type "gpt-5")))
  (is (= "openai" (model-type "gpt-5.4")))
  (is (= "openai" (model-type "GPT-5"))))

(deftest get-factory-model-type-maps-other-models-to-common
  (is (= "common" (model-type "gemini-3-pro-preview")))
  (is (= "common" (model-type "glm-5")))
  (is (= "common" (model-type "Kimi-K2.5")))
  (is (= "common" (model-type "DeepSeek-V3.2")))
  (is (= "common" (model-type "minimax-pro"))))

;; VAL-HEADER-002: x-api-provider mapping

(deftest get-factory-api-provider-returns-correct-provider-for-each-model-family
  (is (= "anthropic" (factory/get-factory-api-provider-js manifest "claude-opus-4-5")))
  (is (= "openai" (factory/get-factory-api-provider-js manifest "gpt-5")))
  (is (= "google" (factory/get-factory-api-provider-js manifest "gemini-3-pro-preview")))
  (is (= "fireworks" (factory/get-factory-api-provider-js manifest "glm-5")))
  (is (= "fireworks" (factory/get-factory-api-provider-js manifest "Kimi-K2.5")))
  (is (= "fireworks" (factory/get-factory-api-provider-js manifest "minimax-pro")))
  (is (= "fireworks" (factory/get-factory-api-provider-js manifest "DeepSeek-V3.2"))))

;; --- Unit tests: endpoint path --------------------------------------------------

;; VAL-ROUTE-007: Factory upstream URLs use /api/llm/ path prefixes

(deftest get-factory-endpoint-path-returns-correct-path-for-each-model-type
  (is (= "/api/llm/a/v1/messages" (factory/get-factory-endpoint-path-js manifest "anthropic")))
  (is (= "/api/llm/o/v1/responses" (factory/get-factory-endpoint-path-js manifest "openai")))
  (is (= "/api/llm/o/v1/chat/completions" (factory/get-factory-endpoint-path-js manifest "common"))))

;; --- Unit tests: headers ---------------------------------------------------------

;; VAL-HEADER-001, VAL-HEADER-002, VAL-HEADER-003, VAL-HEADER-010, VAL-HEADER-011

(deftest build-factory-common-headers-includes-all-required-factory-headers
  (let [headers (factory/build-factory-common-headers-js manifest "gemini-3-pro-preview")]
    (is (= "cli" (aget headers "x-factory-client")))
    (is (= "google" (aget headers "x-api-provider")))
    (is (re-matches uuid-regex (or (aget headers "x-session-id") "")) "x-session-id should be a UUID")
    (is (re-matches uuid-regex (or (aget headers "x-assistant-message-id") "")) "x-assistant-message-id should be a UUID")
    (is (= "factory-cli/0.74.0" (aget headers "user-agent")))
    (is (= "keep-alive" (aget headers "connection")))
    ;; Stainless SDK headers
    (is (= "js" (aget headers "x-stainless-lang")))
    (is (= "Linux" (aget headers "x-stainless-os")))
    (is (= "node" (aget headers "x-stainless-runtime")))
    (is (= "x64" (aget headers "x-stainless-arch")))
    (is (= "0" (aget headers "x-stainless-retry-count")))
    (is (= "0.70.1" (aget headers "x-stainless-package-version")))
    (is (= "v24.3.0" (aget headers "x-stainless-runtime-version")))))

;; VAL-HEADER-004, VAL-HEADER-009: Anthropic-specific headers

(deftest build-factory-anthropic-headers-includes-anthropic-specific-headers
  (let [headers (factory/build-factory-anthropic-headers-js
                 manifest "claude-opus-4-5" #js {:model "claude-opus-4-5" :messages #js []} js/undefined)]
    (is (= "2023-06-01" (aget headers "anthropic-version")))
    (is (= "placeholder" (aget headers "x-api-key")))
    (is (= "0.74.0" (aget headers "x-client-version")))
    (is (= "600" (aget headers "x-stainless-timeout")))
    (is (= "cli" (aget headers "x-factory-client")))
    (is (= "anthropic" (aget headers "x-api-provider")))))

(deftest build-factory-anthropic-headers-adds-anthropic-beta-when-thinking-enabled
  (let [thinking-payload #js {:model "claude-opus-4-5" :messages #js []
                              :thinking #js {:type "enabled" :budget_tokens 12288}}
        headers (factory/build-factory-anthropic-headers-js
                 manifest "claude-opus-4-5" thinking-payload "interleaved-thinking-2025-05-14")]
    (is (= "interleaved-thinking-2025-05-14" (aget headers "anthropic-beta")))))

(deftest build-factory-anthropic-headers-omits-anthropic-beta-when-thinking-not-enabled
  (let [no-thinking-payload #js {:model "claude-opus-4-5" :messages #js []}
        headers (factory/build-factory-anthropic-headers-js
                 manifest "claude-opus-4-5" no-thinking-payload "interleaved-thinking-2025-05-14")]
    (is (undefined? (aget headers "anthropic-beta")))))

;; --- Unit tests: system prompt inlining ---------------------------------------------

;; VAL-HEADER-005: System prompt handling for fk- keys

(deftest inline-system-prompt-moves-string-system-content-into-first-user-message
  (let [result (factory/inline-system-prompt-js
                #js {:model "claude-opus-4-5" :system "You are a helpful assistant."
                     :messages #js [#js {:role "user" :content "Hello"}]})
        messages (aget result "messages")]
    (is (undefined? (aget result "system")))
    (is (= 1 (.-length messages)))
    (is (= "You are a helpful assistant.\n\nHello" (.-content (aget messages 0))))))

(deftest inline-system-prompt-handles-array-system-content
  (let [result (factory/inline-system-prompt-js
                #js {:model "claude-opus-4-5"
                     :system #js [#js {:type "text" :text "System instruction 1"}
                                  #js {:type "text" :text "System instruction 2"}]
                     :messages #js [#js {:role "user" :content "Hello"}]})
        messages (aget result "messages")]
    (is (undefined? (aget result "system")))
    (is (= 1 (.-length messages)))
    (is (= "System instruction 1\nSystem instruction 2\n\nHello" (.-content (aget messages 0))))))

(deftest inline-system-prompt-passes-through-payload-without-system
  (let [result (factory/inline-system-prompt-js
                #js {:model "claude-opus-4-5" :messages #js [#js {:role "user" :content "Hello"}]})
        messages (aget result "messages")]
    (is (undefined? (aget result "system")))
    (is (= 1 (.-length messages)))
    (is (= "Hello" (.-content (aget messages 0))))))

(deftest inline-system-prompt-handles-array-content-on-first-user-message
  (let [result (factory/inline-system-prompt-js
                #js {:model "claude-opus-4-5" :system "Be helpful."
                     :messages #js [#js {:role "user" :content #js [#js {:type "text" :text "Hi"}]}]})
        first-content (.-content (aget (aget result "messages") 0))]
    (is (undefined? (aget result "system")))
    (is (array? first-content))
    (is (= 2 (.-length first-content)))
    (is (= "Be helpful." (.-text (aget first-content 0))))))

(deftest sanitize-factory-system-prompt-replaces-open-code-system-prompt
  (let [prompt "You are OpenCode, the best coding agent on the planet.\n\nTool usage rules..."
        sanitized (factory/sanitize-factory-system-prompt-js manifest prompt)]
    (is (not= prompt sanitized))
    (is (not (.includes sanitized "OpenCode")))
    (is (.includes (.toLowerCase sanitized) "software engineering assistant"))))

(deftest sanitize-factory-system-prompt-leaves-normal-prompts-unchanged
  (let [prompt "You are a helpful assistant."]
    (is (= prompt (factory/sanitize-factory-system-prompt-js manifest prompt)))))

;; --- Unit tests: isFkKey ----------------------------------------------------------------

(deftest is-fk-key-detects-fk-prefixed-api-keys
  (let [fk-credential #js {:providerId "factory" :accountId "test-1" :token "fk-abc123" :authType "api_key"}
        oauth-credential #js {:providerId "factory" :accountId "test-2" :token "eyJ..." :authType "oauth_bearer"
                              :refreshToken "rt-123"}]
    (is (true? (factory/is-fk-key-js manifest fk-credential)))
    (is (false? (factory/is-fk-key-js manifest oauth-credential)))))

;; --- Integration tests: endpoint routing -------------------------------------------------

(def ^:private no-factory-auth
  {"FACTORY_AUTH_V2_FILE" "/tmp/nonexistent-auth-v2-file" "FACTORY_AUTH_V2_KEY" "/tmp/nonexistent-auth-v2-key"})

(defn- claude-reply []
  {:status 200
   :headers {"content-type" "application/json"}
   :body (js/JSON.stringify
          (clj->js {"id" "msg_123" "type" "message" "role" "assistant"
                    "content" [{"type" "text" "text" "Hello from Factory Claude"}]
                    "model" "claude-opus-4-5" "usage" {"input_tokens" 10 "output_tokens" 5}}))})

(defn- ^:async post-chat [^js app model]
  (await (.inject app (clj->js {:method "POST" :url "/v1/chat/completions"
                                :payload {:model model :messages [{:role "user" :content "hello"}]}}))))

;; VAL-ROUTE-001: Claude models route to Factory Anthropic Messages endpoint

(deftest ^:async factory-claude-routes-to-api-llm-a-v1-messages
  (let [captured-url (atom "")
        captured-headers (atom {})]
    (await (with-env (merge no-factory-auth {"FACTORY_API_KEY" "fk-test-key"}) ; pragma: allowlist secret
             (fn ^:async cb []
               (await (app/with-proxy-app
                        {:keys-payload {"providers" {}}
                         :upstream-handler (fn ^:async h [^js request _body]
                                             (reset! captured-url (or (.-url request) ""))
                                             (reset! captured-headers
                                                     (into {} (filter (fn [[_ v]] (string? v)))
                                                           (map (fn [k] [k (aget (.-headers request) k)])
                                                                (js/Object.keys (.-headers request)))))
                                             (claude-reply))}
                        (fn ^:async cb [{:keys [app]}]
                          (let [response (await (post-chat app "factory/claude-opus-4-5"))]
                            (is (= 200 (.-statusCode response)))
                            (is (= "/api/llm/a/v1/messages" @captured-url))
                            (is (= "Bearer fk-test-key" (get @captured-headers "authorization"))))))))))))

;; VAL-ROUTE-006: Factory skipped when no credentials

(deftest ^:async factory-route-returns-503-when-no-factory-credentials-exist
  (await (with-env (merge no-factory-auth {"FACTORY_API_KEY" nil})
           (fn ^:async cb []
             (await (app/with-proxy-app
                      {:keys-payload {"providers" {"vivgrid" {"accounts" ["vg-key"]}}}
                       :upstream-handler (fn ^:async h [_request _body]
                                           {:status 200
                                            :headers {"content-type" "application/json"}
                                            :body (js/JSON.stringify #js {:id "should-not-reach" :object "chat.completion"})})}
                      (fn ^:async cb [{:keys [app]}]
                        (let [response (await (post-chat app "factory/claude-opus-4-5"))]
                          ;; Should get an error: no factory credentials
                          (is (>= (.-statusCode response) 400))))))))))

;; VAL-ROUTE-004: factory/ prefix forces Factory provider routing

(deftest ^:async factory-prefix-forces-routing-through-factory-provider
  (let [captured-url (atom "")]
    (await (with-env (merge no-factory-auth {"FACTORY_API_KEY" "fk-test-key"}) ; pragma: allowlist secret
             (fn ^:async cb []
               (await (app/with-proxy-app
                        {:keys-payload {"providers" {}}
                         ;; Set a different upstream provider
                         :config-overrides {"upstreamProviderId" "vivgrid"}
                         :upstream-handler (fn ^:async h [^js request _body]
                                             (reset! captured-url (or (.-url request) ""))
                                             {:status 200
                                              :headers {"content-type" "application/json"}
                                              :body (js/JSON.stringify
                                                     (clj->js {"id" "msg_123" "type" "message" "role" "assistant"
                                                               "content" [{"type" "text" "text" "OK"}]
                                                               "model" "claude-opus-4-5"
                                                               "usage" {"input_tokens" 10 "output_tokens" 5}}))})}
                        (fn ^:async cb [{:keys [app]}]
                          ;; factory/ prefix should force Factory routing regardless of upstream
                          (let [response (await (post-chat app "factory/claude-opus-4-5"))]
                            (is (= 200 (.-statusCode response)))
                            ;; Should have used Factory endpoint, not default vivgrid
                            (is (= "/api/llm/a/v1/messages" @captured-url)))))))))))

;; --- FactoryResponsesProviderStrategy max_output_tokens fix -------------------------------
;; (from the TypeScript factory-oauth tests)

(deftest ^:async factory-responses-provider-strategy-build-payload-deletes-max-output-tokens
  ;; Regression test for the scrutiny fix: Factory returns 400 on max_output_tokens.
  ;; The strategy must strip this field, matching the OpenAI Responses strategy.
  (await (with-env {"PROXY_AUTH_TOKEN" "test-token"}
           (fn []
             (let [^js cfg (config/load-config-js js/process.env (js/process.cwd) manifest)
                   request-body #js {:model "factory/gpt-5"
                                     :messages #js [#js {:role "user" :content "test"}]
                                     :stream false
                                     :max_output_tokens 4096}
                   ^js routing-state (routing/resolve-request-routing-state-js manifest cfg "factory/gpt-5")
                   ^js facts (strategy/derive-strategy-context-facts-js
                              #js {:surface "chat" :routing routing-state :requestBody request-body
                                   :hostedOpenAiFamily (routing/looks-like-hosted-open-ai-family-js manifest (.-routedModel routing-state))
                                   :config cfg})
                   context (js/Object.assign
                            #js {} facts
                            #js {:config cfg :clientHeaders #js {} :requestBody request-body
                                 :requestedModelInput "factory/gpt-5" :routingModelInput "factory/gpt-5"
                                 :routedModel (.-routedModel routing-state)
                                 :factoryPrefixed (.-factoryPrefixed routing-state)})
                   strategy-id (strategy/select-strategy-js (strategies/selection-facts-js context js/undefined) #js {} manifest)
                   ^js selected (strategies/strategy-for-id-js strategy-id)
                   ^js payload (.buildPayload selected
                                              (js/Object.assign
                                               #js {} context
                                               #js {:routedModel "gpt-5" :explicitOllama false :openAiPrefixed false
                                                    :factoryPrefixed true :localOllama false :clientWantsStream false
                                                    :needsReasoningTrace false :upstreamAttemptTimeoutMs 180000}))
                   parsed (js/JSON.parse (.-bodyText payload))]
               (is (undefined? (aget parsed "max_output_tokens")) "max_output_tokens should be deleted from Factory Responses payload")
               (is (false? (aget parsed "store")) "store should be false")
               (is (true? (aget parsed "stream")) "stream should be true"))))))
