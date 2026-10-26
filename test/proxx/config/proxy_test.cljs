(ns proxx.config.proxy-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.config.proxy :as c]
            [proxx.policy.loader :as loader]
            [proxx.runtime.config :as edge]
            [proxx.schema :as schema]))

(def facts (c/facts-from-contracts (loader/load-policy-contracts! "resources/policies/runtime/00-manifest.edn")))

(defn- build
  ([env] (build env "/work"))
  ([env cwd] (c/build-config #(get env %) (fn [base p] (if (.startsWith p "/") p (str base "/" (.replace p "./" "")))) cwd facts)))

(defn- thrown-message [f] (try (f) nil (catch :default e (ex-message e))))

(def authed {"PROXY_AUTH_TOKEN" "tok"})

(deftest defaults
  (let [cfg (build authed)]
    (is (= ["127.0.0.1" 8789 "vivgrid"] ((juxt #(get % "host") #(get % "port") #(get % "upstreamProviderId")) cfg)))
    (is (= "/codex/responses" (get cfg "openaiResponsesPath")))
    (is (= "/work/keys.json" (get cfg "keysFilePath")))
    (is (= "tok" (get cfg "sessionSecret")) "the session secret falls back to the proxy token")
    (is (= "tok" (get cfg "proxyTokenPepper")))
    (is (= "https://api.vivgrid.com" (get cfg "upstreamBaseUrl")))
    (is (= "https://ollama.com" (get-in cfg ["upstreamProviderBaseUrls" "ollama-cloud"])))
    (is (nil? (get cfg "databaseUrl")))
    (is (= "interleaved-thinking-2025-05-14" (get cfg "messagesInterleavedThinkingBeta")))
    (testing "the result satisfies the schema"
      (is (= cfg (schema/assert! :proxx/proxy-config cfg))))))

(deftest authentication-is-required
  (is (= "PROXY_AUTH_TOKEN is required unless PROXY_ALLOW_UNAUTHENTICATED=true" (thrown-message #(build {}))))
  (is (= "PROXY_AUTH_TOKEN is required unless PROXY_ALLOW_UNAUTHENTICATED=true" (thrown-message #(build {"PROXY_AUTH_TOKEN" "  "}))))
  (is (true? (get (build {"VIVGRID_ALLOW_UNAUTHENTICATED" "yes"}) "allowUnauthenticated")))
  (is (= "OPENAI_PROVIDER_ID must not be empty" (thrown-message #(build (assoc authed "OPENAI_PROVIDER_ID" "  "))))))

(deftest environment-readers
  (testing "numbers: first set alias wins, must be finite and positive"
    (is (= 9191 (get (build (assoc authed "PORT" "9191")) "port")))
    (is (= 1 (get (build (assoc authed "PROXY_PORT" "1" "PORT" "2")) "port")))
    (is (= "Invalid numeric environment variable PROXY_PORT: 0" (thrown-message #(build (assoc authed "PROXY_PORT" "0")))))
    (is (= 8789 (get (build (assoc authed "PROXY_PORT" "")) "port")) "an empty value counts as unset")
    (is (= 0 (get (build (assoc authed "PROXY_REQUEST_LOGS_FLUSH_MS" "0")) "requestLogsFlushMs")) "flush interval may be zero"))
  (testing "booleans"
    (is (false? (get (build (assoc authed "PROXY_KEY_RANDOM_WALK" " OFF ")) "enableKeyRandomWalk")))
    (is (= "Invalid boolean environment variable LOCAL_OLLAMA_ENABLED: maybe"
           (thrown-message #(build (assoc authed "LOCAL_OLLAMA_ENABLED" "maybe"))))))
  (testing "lists: unset takes the default, empty is empty"
    (is (= ["factory/" "factory:"] (get (build authed) "factoryModelPrefixes")))
    (is (= [] (get (build (assoc authed "FACTORY_MODEL_PREFIXES" "")) "factoryModelPrefixes")))
    (is (= ["a" "b"] (get (build (assoc authed "FACTORY_MODEL_PREFIXES" " a ,, b ")) "factoryModelPrefixes"))))
  (testing "per-provider image costs"
    (is (= {"zai" 0.5 "openai" 2} (get (build (assoc authed "IMAGE_COST_USD_BY_PROVIDER" "ZAI=0.5, openai=2")) "imageCostUsdByProvider")))
    (is (= "Invalid numeric map in IMAGE_COST_USD_BY_PROVIDER: zai=" (thrown-message #(build (assoc authed "IMAGE_COST_USD_BY_PROVIDER" "zai="))))))
  (testing "images upstream mode accepts aliases"
    (is (= "platform" (get (build (assoc authed "OPENAI_IMAGES_UPSTREAM_MODE" "API")) "openaiImagesUpstreamMode")))
    (is (= "Invalid OPENAI_IMAGES_UPSTREAM_MODE: x (expected: platform|chatgpt|auto)"
           (thrown-message #(build (assoc authed "OPENAI_IMAGES_UPSTREAM_MODE" "x")))))))

(deftest provider-urls
  (let [urls #(get (build (merge authed %)) "upstreamProviderBaseUrls")]
    (is (= "https://router.requesty.ai/v1" (get (urls {}) "requesty")))
    (is (= "https://o.test" (get (urls {"OPENROUTER_BASE_URL" "https://o.test///"}) "openrouter")))
    (is (= "https://second.test" (get (urls {"ZENMUX_BASE_URL" "https://second.test/"}) "zen")) "later alias is used when the first is unset")
    (is (= "https://first.test" (get (urls {"ZEN_BASE_URL" "https://first.test" "ZENMUX_BASE_URL" "x"}) "zen")))
    (is (= "" (get (urls {"GEMINI_BASE_URL" ""}) "gemini")) "an empty override is an override (only unset falls back)")
    (is (= "https://ollama.com" (get (urls {"OLLAMA_BASE_URL" "x"}) "ollama-cloud")) "fixed providers ignore the environment")))

(deftest first-invalid-variable-is-reported
  (is (= "Invalid boolean environment variable PROXY_ALLOW_UNAUTHENTICATED: nope"
         (thrown-message #(build {"PROXY_ALLOW_UNAUTHENTICATED" "nope" "PROXY_PORT" "0"})))
      "booleans read before the late numeric block")
  (is (= "Invalid numeric environment variable IMAGE_COST_USD_DEFAULT: -1"
         (thrown-message #(build (assoc authed "IMAGE_COST_USD_DEFAULT" "-1" "PROXY_PORT" "0"))))))

(deftest ^:async edge-builds-a-js-config
  (let [env #js {"PROXY_AUTH_TOKEN" "t" "PORT" "9000"}
        cfg (edge/load-config-js env "/tmp/x" "resources/policies/runtime/00-manifest.edn")]
    (is (= 9000 (.-port cfg)))
    (is (= "/tmp/x/keys.json" (.-keysFilePath cfg)))
    (is (nil? (.-databaseUrl cfg)))
    (is (contains? (js->clj cfg) "databaseUrl") "absent optional settings are present-but-undefined")
    (is (array? (.-factoryModelPrefixes cfg)))
    (is (thrown-with-msg? js/Error #"PROXY_AUTH_TOKEN is required" (edge/load-config-js #js {} "/tmp" "resources/policies/runtime/00-manifest.edn")))
    (is (> (.-length (edge/default-models-js "resources/policies/runtime/00-manifest.edn")) 20))))
