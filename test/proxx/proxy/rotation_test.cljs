(ns proxx.proxy.rotation-test
  "Account selection through the whole application: rotation on rate limits and
  invalid keys, prompt_cache_key affinity, and provider classification of the model."
  (:require [cljs.test :refer [deftest is]]
            [clojure.string :as str]
            [proxx.proxy.support :as s]))

(def ^:private gemini-chat
  {"model" "gemini-3.1-pro-preview" "messages" [{"role" "user" "content" "hello"}] "stream" false})

(defn- chat [app payload] (s/post-json app "/v1/chat/completions" payload))

(deftest ^:async rotates-api-key-when-first-key-is-rate-limited
  (let [observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys ["key-a" "key-b"]
        :upstream-handler
        (fn [request body]
          (when-let [token (s/bearer-token request)] (swap! observed conj token))
          (is (str/includes? body "gemini-3.1-pro-preview"))
          (if (= "Bearer key-a" (s/header request "authorization"))
            (s/json-response 429 {"retry-after" "60"} {"error" {"message" "rate limit"}})
            (s/json-response 200 {"id" "chatcmpl-123" "object" "chat.completion" "choices" []})))}
       (fn ^:async run [{:keys [app]}]
         (let [response (await (chat app gemini-chat))]
           (is (= 200 (:status response)))
           (is (map? (:json response)))
           (is (= "chatcmpl-123" (get (:json response) "id")))
           (is (= ["key-a" "key-b"] @observed))))))))

(deftest ^:async reuses-the-same-upstream-account-for-repeated-prompt-cache-key-requests
  (let [observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys ["key-a" "key-b"]
        :upstream-handler
        (fn [request _body]
          (when-let [token (s/bearer-token request)] (swap! observed conj token))
          (s/json-response 200 {"id" (str (random-uuid)) "object" "chat.completion" "choices" []}))}
       (fn ^:async run [{:keys [app]}]
         (dotimes [_ 3]
           (let [response (await (chat app (assoc gemini-chat "prompt_cache_key" "sticky-key-1")))]
             (is (= 200 (:status response)))))
         (is (= ["key-a" "key-a" "key-a"] @observed)))))))

(deftest ^:async reassigns-prompt-cache-key-affinity-when-the-pinned-account-becomes-rate-limited
  (let [observed (atom [])
        key-a-attempts (atom 0)]
    (await
     (s/with-proxy-app
       {:keys ["key-a" "key-b"]
        :upstream-handler
        (fn [request _body]
          (let [auth (s/header request "authorization")]
            (when-let [token (s/bearer-token request)] (swap! observed conj token))
            (when (= auth "Bearer key-a") (swap! key-a-attempts inc))
            (if (and (= auth "Bearer key-a") (>= @key-a-attempts 2))
              (s/json-response 429 {"retry-after" "60"} {"error" {"message" "rate limit"}})
              (s/json-response 200 {"id" (str (random-uuid)) "object" "chat.completion" "choices" []}))))}
       (fn ^:async run [{:keys [app]}]
         (let [payload (assoc gemini-chat "prompt_cache_key" "sticky-key-2")]
           (is (= 200 (:status (await (chat app payload)))))
           (is (= 200 (:status (await (chat app payload)))))
           (is (= 200 (:status (await (chat app payload))))))
         (is (= ["key-a" "key-a" "key-b" "key-b"] @observed)))))))

(deftest ^:async reassigns-ollama-session-limited-prompt-cache-key-affinity-after-one-fallback-success
  (let [observed (atom [])
        ollama-a-attempts (atom 0)]
    (await
     (s/with-proxy-app
       {:keys [] :keys-payload {"providers" {"ollama-cloud" ["ollama-a" "ollama-b"]}}
        :config-overrides {:upstreamProviderId "ollama-cloud" :keyCooldownJitterFactor 0}
        :upstream-handler
        (fn [request _body]
          (let [auth (s/header request "authorization")]
            (when-let [token (s/bearer-token request)] (swap! observed conj token))
            (when (= auth "Bearer ollama-a") (swap! ollama-a-attempts inc))
            (if (and (= auth "Bearer ollama-a") (>= @ollama-a-attempts 2))
              (s/json-response
               429 {"retry-after" "1"}
               {"error" {"message" "you (ollama-a) have reached your session usage limit, upgrade for higher limits: https://ollama.com/upgrade"}})
              (s/json-response 200 (dissoc (s/chat-completion (str (random-uuid)) "glm-5.1" "glm-ok") "created")))))}
       (fn ^:async run [{:keys [app]}]
         (let [payload {"model" "glm-5.1" "messages" [{"role" "user" "content" "hello"}]
                        "prompt_cache_key" "sticky-ollama-session-1" "stream" false}]
           (is (= 200 (:status (await (chat app payload)))))
           (is (= 200 (:status (await (chat app payload)))))
           (await (s/sleep 1100))
           (is (= 200 (:status (await (chat app payload))))))
         (is (= ["ollama-a" "ollama-a" "ollama-b" "ollama-b"] @observed)))))))

(deftest ^:async does-not-misclassify-gemini-models-as-local-ollama-because-they-contain-mini
  (let [observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys ["key-a"]
        :upstream-handler
        (fn [request _body]
          (when-let [token (s/bearer-token request)] (swap! observed conj token))
          (s/json-response 200 {"id" "chatcmpl-gemini" "object" "chat.completion" "choices" []}))}
       (fn ^:async run [{:keys [app]}]
         (let [response (await (chat app gemini-chat))]
           (is (= 200 (:status response)))
           (is (= "chat_completions" (get-in response [:headers "x-open-hax-upstream-mode"])))
           (is (= ["key-a"] @observed))))))))

(deftest ^:async tries-all-candidate-keys-until-one-succeeds
  (let [observed (atom [])]
    (await
     (s/with-proxy-app
       {:keys ["key-a" "key-b" "key-c"]
        :upstream-handler
        (fn [request _body]
          (let [auth (s/header request "authorization")]
            (when-let [token (s/bearer-token request)] (swap! observed conj token))
            (if (contains? #{"Bearer key-a" "Bearer key-b"} auth)
              (s/json-response 401 {"error" {"message" "invalid key"}})
              (s/json-response 200 {"id" "chatcmpl-final-key-success" "object" "chat.completion" "choices" []}))))}
       (fn ^:async run [{:keys [app]}]
         (let [response (await (chat app gemini-chat))]
           (is (= 200 (:status response)))
           (is (= ["key-a" "key-b" "key-c"] @observed))))))))
