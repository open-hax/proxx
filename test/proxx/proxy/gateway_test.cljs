(ns proxx.proxy.gateway-test
  "Port of the gateway tests of src/tests/proxy.test.ts: proxy authentication, unsupported
  endpoints and OPTIONS preflight (end to end through the application)."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.harness-b :as h :refer [with-proxy-app]]))

(deftest ^:async requires-bearer-token-when-proxy-auth-token-is-configured
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :proxy-auth-token "proxy-secret"
      :allow-unauthenticated false
      :upstream-handler (fn [_ _] (h/json-reply 200 {:id "chatcmpl-auth" :object "chat.completion" :choices []}))}
     (fn ^:async body [{:keys [app]}]
       (let [unauthorized (await (h/chat app (h/hello "gemini-3.1-pro-preview")))]
         (is (= 401 (:status unauthorized)))
         (is (= "unauthorized" (get-in unauthorized [:headers "x-open-hax-error-code"])))
         (is (map? (:error (:json unauthorized))))
         (is (= "unauthorized" (get-in unauthorized [:json :error :code]))))
       (let [authorized (await (h/chat app (h/hello "gemini-3.1-pro-preview") {"authorization" "Bearer proxy-secret"}))]
         (is (= 200 (:status authorized)))
         (is (= "chat_completions" (get-in authorized [:headers "x-open-hax-upstream-mode"]))))))))

(deftest ^:async accepts-proxy-auth-token-from-cookie-for-browser-served-ui-and-api-requests
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :proxy-auth-token "proxy-secret"
      :allow-unauthenticated false
      :upstream-handler (fn [_ _] (h/json-reply 200 {:id "chatcmpl-cookie-auth" :object "chat.completion" :choices []}))}
     (fn ^:async body [{:keys [app]}]
       (let [authorized (await (h/chat app (h/hello "gemini-3.1-pro-preview")
                                       {"cookie" "open_hax_proxy_auth_token=proxy-secret"}))]
         (is (= 200 (:status authorized)))
         (is (= "chat_completions" (get-in authorized [:headers "x-open-hax-upstream-mode"]))))))))

(deftest ^:async returns-openai-style-error-for-unsupported-v1-endpoints
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler (fn [_ _] (h/json-reply 200 {:ok true}))}
     (fn ^:async body [{:keys [app]}]
       (let [response (await (h/inject app {:method "GET" :url "/v1/unknown"}))]
         (is (= 404 (:status response)))
         (is (= "unsupported_endpoint" (get-in response [:headers "x-open-hax-error-code"])))
         (is (map? (get-in response [:json :error])))
         (is (= "unsupported_endpoint" (get-in response [:json :error :code])))
         (is (re-find #"Supported endpoints:" (str (get-in response [:json :error :message])))))))))

(deftest ^:async restricts-options-preflight-to-declared-endpoints
  (await
   (with-proxy-app
     {:keys ["key-a"]
      :upstream-handler (fn [_ _] (h/json-reply 200 {:ok true}))}
     (fn ^:async body [{:keys [app]}]
       (let [known (await (h/inject app {:method "OPTIONS" :url "/v1/chat/completions"}))]
         (is (= 204 (:status known))))
       (let [unknown (await (h/inject app {:method "OPTIONS" :url "/v1/unknown"}))]
         (is (= 404 (:status unknown)))
         (is (= "unsupported_endpoint" (get-in unknown [:headers "x-open-hax-error-code"]))))))))
