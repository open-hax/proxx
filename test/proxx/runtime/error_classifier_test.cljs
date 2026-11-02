(ns proxx.runtime.error-classifier-test
  "Ported from src/tests/error-classifier.test.ts (7 tests) and
  src/tests/upstream-error-classification.test.ts (3 tests). The TS shim only
  forwarded to the strategy/classification edges, which are driven directly."
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime :as runtime]
            [proxx.runtime.strategy :as s]))

(defn- retry-same? [status] (s/should-retry-same-credential-for-server-error-js status js/undefined))
(defn- cooldown-on-auth? [provider status] (s/should-cooldown-credential-on-auth-failure-js provider status js/undefined))
(defn- permanently-disable? [credential status]
  (s/should-permanently-disable-credential-js (clj->js credential) status js/undefined))
(defn- classify-auth [credential provider status cooldown]
  (s/classify-auth-error-js (clj->js credential) provider status cooldown js/undefined))

(def api-key {"providerId" "vivgrid" "accountId" "1" "token" "x" "authType" "api_key"})
(def oauth {"providerId" "openai" "accountId" "1" "token" "x" "authType" "oauth_bearer"})
(def requesty {"providerId" "requesty" "accountId" "1" "token" "x" "authType" "api_key"})

(deftest retry-same-credential-for-server-error-true-for-502-503-504
  (is (retry-same? 502))
  (is (retry-same? 503))
  (is (retry-same? 504))
  (is (not (retry-same? 400)))
  (is (not (retry-same? 429)))
  (is (not (retry-same? 500))))

(deftest cooldown-on-auth-failure-401-and-403-except-factory
  (is (cooldown-on-auth? "openai" 401))
  (is (cooldown-on-auth? "factory" 401))
  (is (cooldown-on-auth? "openai" 403))
  (is (not (cooldown-on-auth? "factory" 403)))
  (is (not (cooldown-on-auth? "openai" 402))))

(deftest permanently-disable-credential-only-for-api-key-accounts
  (is (permanently-disable? api-key 402))
  (is (permanently-disable? api-key 403))
  (is (not (permanently-disable? api-key 401)))
  (is (not (permanently-disable? oauth 402)))
  (is (not (permanently-disable? oauth 403)))
  (is (not (permanently-disable? requesty 403)) "Requesty is an exception for 403")
  (is (permanently-disable? requesty 402)))

(deftest classify-auth-error-permanent-disable-for-api-key-402
  (let [^js result (classify-auth api-key "vivgrid" 402 300000)]
    (is (= "auth_permanent_disable" (.-classification result)))
    (is (= (s/permanent-disable-cooldown-ms-js js/undefined) (.-cooldownMs result))
        "PERMANENT_DISABLE_COOLDOWN_MS")))

(deftest classify-auth-error-cooldown-for-oauth-401
  (let [^js result (classify-auth oauth "openai" 401 300000)]
    (is (= "auth_cooldown" (.-classification result)))
    (is (= 10000 (.-cooldownMs result)))))

(deftest classify-auth-error-transient-for-non-actionable-errors
  (let [^js result (classify-auth oauth "openai" 500 300000)]
    (is (= "transient" (.-classification result)))
    (is (undefined? (.-cooldownMs result)))))

(deftest classify-model-not-supported-with-capped-cooldown
  (let [^js result (s/classify-model-not-supported-js 300000 js/undefined)
        ^js result2 (s/classify-model-not-supported-js 10000 js/undefined)]
    (is (= "model_not_supported" (.-classification result)))
    (is (= 60000 (.-cooldownMs result)))
    (is (= 10000 (.-cooldownMs result2)))))

;; ---- upstream-error-classification ---------------------------------------

(defn- json-response [body status]
  (js/Response. (js/JSON.stringify (clj->js body))
                #js {:status status :headers #js {"content-type" "application/json"}}))

(deftest ^:async ollama-cloud-subscription-gated-403-is-model-not-supported-for-account
  (let [response (json-response {"error" "this model requires a subscription, upgrade for access: https://ollama.com/upgrade (ref: test-ref)"} 403)]
    (is (true? (await (runtime/response-indicates-model-not-supported-js response "glm-5"))))))

(deftest ^:async unauthorized-401-is-not-model-not-supported-for-account
  (let [response (json-response {"error" "unauthorized"} 401)]
    (is (false? (await (runtime/response-indicates-model-not-supported-js response "gemma4:31b"))))))

(deftest ^:async model-access-denied-wording-is-model-not-supported-for-account
  (let [response (json-response {"error" {"message" "account is not allowed to call glm-5 on this plan"}} 403)]
    (is (true? (await (runtime/response-indicates-model-not-supported-js response "glm-5"))))))
