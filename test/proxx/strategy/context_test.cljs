(ns proxx.strategy.context-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.strategy.context :as ctx]))

(def ^:private config {:request-timeout-ms 600000 :stream-bootstrap-timeout-ms 20000 :upstream-provider-id "rotussy" :openai-provider-id "openai"})

(defn- facts [m] (ctx/derive-facts (merge {:surface "chat" :routing {} :request-body {} :config config} m)))

(deftest routing-provider
  (is (= "rotussy" (:route-provider-id (facts {}))))
  (is (= "factory" (:route-provider-id (facts {:routing {:factory-prefixed true :open-ai-prefixed true}}))))
  (is (= "openai" (:route-provider-id (facts {:routing {:open-ai-prefixed true}}))))
  (is (= "ollama" (:route-provider-id (facts {:routing {:local-ollama true}}))))
  (is (= "rotussy" (:route-provider-id (facts {:surface "images-passthrough" :routing {:local-ollama true}}))) "only chat requests use local Ollama"))

(deftest stream-and-timeout
  (is (= 600000 (:upstream-attempt-timeout-ms (facts {}))))
  (is (= 20000 (:upstream-attempt-timeout-ms (facts {:request-body {"stream" true}}))))
  (is (false? (:client-wants-stream (facts {:request-body {"stream" "true"}}))) "only a literal true streams")
  (is (false? (:client-wants-stream (facts {:surface "images-passthrough" :request-body {"stream" true}})))))

(deftest reasoning-and-prefixes
  (is (true? (:needs-reasoning-trace (facts {:request-body {"reasoning_effort" "high"}}))))
  (is (false? (:needs-reasoning-trace (facts {:surface "responses-passthrough" :request-body {"reasoning_effort" "high"}}))))
  (is (true? (:open-ai-prefixed (facts {:surface "responses-passthrough" :config (assoc config :upstream-provider-id "openai") :hosted-openai-family? true}))))
  (is (false? (:open-ai-prefixed (facts {:surface "responses-passthrough" :routing {:factory-prefixed true}
                                         :config (assoc config :upstream-provider-id "openai") :hosted-openai-family? true}))))
  (is (false? (:open-ai-prefixed (facts {:config (assoc config :upstream-provider-id "openai") :hosted-openai-family? true}))) "the hosted-family rule is for passthrough only"))
