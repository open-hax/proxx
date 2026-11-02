(ns proxx.runtime.config-test
  "src/tests/config.test.ts: the environment-to-config edge, driven through process.env."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.config :as edge]))

(def manifest "resources/policies/runtime/00-manifest.edn")

(defn- with-env
  "Run `f` with `values` ({name string-or-nil}) applied to process.env; nil deletes. Restores after."
  [values f]
  (let [env (.-env js/process)
        previous (into {} (map (fn [k] [k (aget env k)])) (keys values))
        apply-env! (fn [m] (doseq [[k v] m] (if (nil? v) (js-delete env k) (aset env k v))))]
    (apply-env! values)
    (try (f) (finally (apply-env! previous)))))

(defn- load-config [] (edge/load-config-js (.-env js/process) "/tmp/open-hax-openai-proxy-config-test" manifest))

(deftest falls-back-to-port-when-proxy-port-is-unset
  (with-env {"PROXY_AUTH_TOKEN" "test-token" "PROXY_PORT" nil "PORT" "9191"}
    #(is (= 9191 (.-port ^js (load-config))))))

(deftest defaults-openai-responses-path-to-codex-responses
  (with-env {"PROXY_AUTH_TOKEN" "test-token" "OPENAI_RESPONSES_PATH" nil}
    #(is (= "/codex/responses" (.-openaiResponsesPath ^js (load-config))))))

(deftest reads-cljs-policy-authoritative-flag
  (with-env {"PROXY_AUTH_TOKEN" "test-token" "PROXX_CLJS_POLICY_AUTHORITATIVE" "true"}
    #(is (true? (.-cljsPolicyAuthoritative ^js (load-config))))))

(deftest preserves-openai-responses-path-override
  (with-env {"PROXY_AUTH_TOKEN" "test-token" "OPENAI_RESPONSES_PATH" "/v1/responses"}
    #(is (= "/v1/responses" (.-openaiResponsesPath ^js (load-config))))))

(deftest falls-back-to-session-secret-for-proxy-token-pepper
  (with-env {"PROXY_AUTH_TOKEN" "test-token" "SESSION_SECRET" "session-secret-a" "PROXY_TOKEN_PEPPER" nil}
    #(is (= "session-secret-a" (.-proxyTokenPepper ^js (load-config))))))

(deftest preserves-explicit-proxy-token-pepper
  (with-env {"PROXY_AUTH_TOKEN" "test-token" "SESSION_SECRET" "session-secret-a" "PROXY_TOKEN_PEPPER" "pepper-b"}
    #(is (= "pepper-b" (.-proxyTokenPepper ^js (load-config))))))

(deftest derives-upstream-base-url-from-default-provider-id
  (with-env {"PROXY_AUTH_TOKEN" "test-token"}
    #(let [^js config (load-config)]
       (is (= "https://api.vivgrid.com" (.-upstreamBaseUrl config)))
       (is (= "https://api.vivgrid.com" (aget (.-upstreamProviderBaseUrls config) "vivgrid"))))))
