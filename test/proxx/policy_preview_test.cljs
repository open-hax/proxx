(ns proxx.policy-preview-test
  "src/tests/cljs-policy-preview.test.ts: the declarative policy previews, driven through the same
  JS-facing entry points the built runtime exports (previewPolicyDecision, resolveFederationRouteCandidates,
  authorizeTenantProviderPolicy) against the real policy manifest."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime :as rt]))

(def ^:private manifest "resources/policies/runtime/00-manifest.edn")

(defn- preview
  "previewPolicyDecision over plain data; the result as string-keyed data."
  [input]
  (js->clj (rt/preview-policy-decision-js manifest (clj->js input))))

(defn- decision [result]
  (is (= "ok" (get result "status")))
  (is (map? (get result "decision")))
  (get result "decision"))

(def ^:private openai-routes
  {"provider-id" "openai" "base-url" "https://chatgpt.com/backend-api"
   "paths" {"chat-completions" "/codex/responses/compact" "responses" "/codex/responses"
            "images-generations" "/images/generations"}})

(def ^:private ollama-route
  {"provider-id" "ollama" "base-url" "http://ollama:11434" "auth-required?" false
   "paths" {"chat-completions" "/v1/chat/completions"}})

(deftest previews-declarative-policy-decisions-from-manifest
  (let [d (decision (preview {"modelId" "gpt-5-mini" "requestKind" "chat"
                              "tenantSettings" {"allowedProviderIds" ["openai" "factory"]}
                              "providerIds" ["rotussy" "factory" "openai"]
                              "accountsByProvider" {"openai" [{"accountId" "free" "planType" "free"}
                                                              {"accountId" "plus" "planType" "plus"}]
                                                    "factory" [{"accountId" "team" "planType" "team"}]}
                              "strategiesByProvider" {"openai" [{"mode" "chat-completions" "priority" 1}]
                                                      "factory" [{"mode" "openai-responses" "priority" 1}]}}))]
    (is (= "ok" (get d "status")))
    (is (= "gpt-free-blocked" (get d "route-id")))
    (is (= "openai" (get d "provider-id")))
    (is (= [openai-routes
            {"provider-id" "factory" "base-url" "https://api.factory.ai"
             "paths" {"chat-completions" "/v1/chat/completions" "responses" "/v1/responses"
                      "images-generations" "/v1/images/generations"}}]
           (get d "provider-routes")))
    (is (= "plus" (get-in d ["account" "accountId"])))
    (is (= "chat-completions" (get-in d ["strategy" "mode"])))))

(deftest routes-bare-qwen3-embeddings-through-the-declarative-embedding-provider-order
  (let [d (decision (preview {"modelId" "qwen3-embedding:0.6b" "requestKind" "embeddings" "tenantSettings" {}
                              "providerIds" ["openai" "ollama" "llamacpp-embed" "requesty"]
                              "strategies" [{"mode" "embeddings" "priority" 1}]}))]
    (is (= "qwen3-embedding" (get d "route-id")))
    (is (= "llamacpp-embed" (get d "provider-id")))
    (is (= ["llamacpp-embed" "ollama"] (get d "providers")))
    (is (= [{"provider-id" "llamacpp-embed" "base-url" "http://llamacpp-embed:8081"
             "paths" {"chat-completions" "/v1/chat/completions"}}
            ollama-route]
           (get d "provider-routes")))
    (is (= "embeddings" (get-in d ["strategy" "mode"])))))

(deftest constrains-embeddings-to-requested-provider-facts-before-tenant-enforcement
  (let [base {"modelId" "qwen3-embedding:0.6b" "requestKind" "embeddings"
              "providerIds" ["llamacpp-embed" "ollama" "ollama-lan"]
              "requestedProviderIds" ["ollama"]
              "strategiesByProvider" {"llamacpp-embed" [{"mode" "embeddings" "priority" 0}]
                                      "ollama" [{"mode" "embeddings" "priority" 1}]
                                      "ollama-lan" [{"mode" "embeddings" "priority" 1}]}}
        allowed-result (preview (assoc base "tenantSettings" {}))
        disabled-result (preview (assoc base "tenantSettings" {"disabledProviderIds" ["ollama"]}))
        allowed (decision allowed-result)
        disabled (decision disabled-result)]
    (is (= "ok" (get allowed "status")))
    (is (= ["ollama"] (get allowed "providers")))
    (is (= "ollama" (get allowed "provider-id")))
    (is (= ["ollama"] (mapv #(get % "provider-id") (get allowed "provider-routes"))))
    (let [route (first (get allowed "provider-routes"))]
      (is (= "ollama" (get route "provider-id")))
      (is (= "http://ollama:11434" (get route "base-url")))
      (is (= false (get route "auth-required?"))))
    (is (= "exhausted" (get disabled "status")))
    (is (= "no-provider-candidates" (get disabled "reason")))
    (is (= [] (get disabled "providers")))))

(deftest keeps-gpt-and-mimo-routes-pinned-to-their-canonical-providers
  (let [gpt (decision (preview {"modelId" "gpt-5.4" "requestKind" "chat" "tenantSettings" {}
                                "providerIds" ["openai" "factory" "requesty" "vivgrid"]}))]
    (is (= "gpt" (get gpt "route-id")))
    (is (= ["vivgrid" "openai" "requesty" "factory"] (get gpt "providers")))
    (is (= [{"provider-id" "vivgrid" "base-url" "https://api.vivgrid.com"
             "paths" {"chat-completions" "/v1/chat/completions" "responses" "/v1/responses"
                      "messages" "/v1/messages" "images-generations" "/v1/images/generations"}}
            openai-routes
            {"provider-id" "requesty" "base-url" "https://router.requesty.ai/v1"}
            {"provider-id" "factory" "base-url" "https://api.factory.ai"
             "paths" {"chat-completions" "/v1/chat/completions" "responses" "/v1/responses"
                      "images-generations" "/v1/images/generations"}}]
           (get gpt "provider-routes"))))
  (let [mimo (decision (preview {"modelId" "mimo-v2.5-pro" "requestKind" "chat" "tenantSettings" {}
                                 "providerIds" ["openai" "xiaomi" "requesty" "vivgrid"]}))]
    (is (= "mimo-v2-5-pro" (get mimo "route-id")))
    (is (= ["xiaomi"] (get mimo "providers")))
    (is (= [{"provider-id" "xiaomi" "base-url" "https://api.xiaomimimo.com/v1"}] (get mimo "provider-routes"))))
  (let [gemma (decision (preview {"modelId" "gemma4:e4b" "requestKind" "chat" "tenantSettings" {}
                                  "providerIds" ["ollama" "ollama-cloud" "ollama-lan"]
                                  "strategies" [{"mode" "chat_completions" "priority" 1}
                                                {"mode" "ollama_chat" "priority" 2}]}))]
    (is (= "gemma4-e4b" (get gemma "route-id")))
    (is (= ["ollama" "ollama-lan"] (get gemma "providers")))
    (is (= [ollama-route
            {"provider-id" "ollama-lan" "base-url" "http://192.168.12.68:11434" "auth-required?" false
             "paths" {"chat-completions" "/v1/chat/completions"}}]
           (get gemma "provider-routes")))
    (is (= "chat_completions" (get-in gemma ["strategy" "mode"])))))

(deftest orders-federation-projected-accounts-from-declarative-policy
  (let [result (js->clj
                (rt/resolve-federation-route-candidates-js
                 manifest
                 (clj->js
                  {"requestKind" "responses" "providerIds" ["openai"] "nowMs" 1000
                   "localProviderAccountKeys" ["openai\u0000local-account"]
                   "projectedAccounts"
                   [{"sourcePeerId" "peer-b" "providerId" "openai" "accountId" "descriptor-hot"
                     "availabilityState" "descriptor" "warmRequestCount" 10 "metadata" {}}
                    {"sourcePeerId" "peer-a" "providerId" "openai" "accountId" "remote-cold"
                     "availabilityState" "remote_route" "warmRequestCount" 0 "metadata" {}}
                    {"sourcePeerId" "peer-c" "providerId" "openai" "accountId" "remote-hot"
                     "availabilityState" "remote_route" "warmRequestCount" 5 "metadata" {}}
                    {"sourcePeerId" "peer-d" "providerId" "openai" "accountId" "cooling"
                     "availabilityState" "remote_route" "warmRequestCount" 99 "metadata" {"cooldownUntilMs" 2000}}
                    {"sourcePeerId" "peer-e" "providerId" "openai" "accountId" "local-account"
                     "availabilityState" "remote_route" "warmRequestCount" 99 "metadata" {}}]})))]
    (is (= "ok" (get result "status")))
    (is (= ["remote-hot" "remote-cold" "descriptor-hot"]
           (mapv #(or (get % "accountId") (get % "account_id")) (get result "candidates"))))))

(deftest authorizes-tenant-provider-share-modes-from-federation-policy
  (let [base-policy {"ownerSubject" "did:plc:owner" "providerKind" "peer_proxx" "shareMode" "warm_import"
                     "allowedModels" ["gpt-5.5"]}
        authorize (fn [required-share-mode]
                    (js->clj (rt/authorize-tenant-provider-policy-js
                              manifest
                              (clj->js {"policy" base-policy "ownerSubject" "did:plc:owner" "providerKind" "peer_proxx"
                                        "requestedModel" "gpt-5.5" "requiredShareMode" required-share-mode}))))
        relay (authorize "relay")
        projection (authorize "project_credentials")]
    (is (= "ok" (get relay "status")))
    (is (true? (get relay "allowed")))
    (is (= "ok" (get projection "status")))
    (is (false? (get projection "allowed")))))
