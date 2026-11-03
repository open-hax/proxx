(ns proxx.proxy.embeddings-test
  "`/v1/embeddings` and native `/api/embed`, `/api/embeddings`: llama.cpp routing by
  declarative policy, prefix stripping, size limits, and Ollama context handling,
  through the real application."
  (:require [cljs.test :refer [deftest is]]
            [proxx.proxy.fixture-c :as fx :refer [with-proxy-app with-env inject]]))

(defn- embeddings [app payload]
  (inject app {:method "POST" :url "/v1/embeddings" :payload payload}))

(defn- observe!
  "Record the request path and its JSON body (nil when empty) in `seen`."
  [seen req body]
  (reset! seen {:path (fx/req-url req) :body (when (pos? (count body)) (fx/parse-json body))}))

(defn- list-reply [embedding]
  (fx/json-reply {:object "list" :model "qwen3-embedding-0.6b"
                  :data [{:object "embedding" :index 0 :embedding embedding}]}))

(deftest ^:async routes-bare-qwen3-embeddings-through-declarative-cljs-policy-to-llama-cpp
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys [] :upstream-handler (fn [req body] (observe! seen req body) (list-reply [0.1 0.2 0.3]))}
       (^:async fn [{:keys [app]}]
         (let [response (await (embeddings app {:model "qwen3-embedding:0.6b" :input "hello world"}))
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= "/v1/embeddings" (:path @seen)))
           (is (map? (:body @seen)))
           (is (= "qwen3-embedding-0.6b" (get-in @seen [:body "model"])))
           (is (map? payload))
           (is (vector? (get payload "data")))
           (is (= [0.1 0.2 0.3] (get-in payload ["data" 0 "embedding"])))))))))

(deftest ^:async bare-qwen3-embeddings-do-not-require-typescript-alias-env-to-reach-llama-cpp
  (let [seen (atom {})]
    (await
     (with-env {"EMBED_MODEL_PROVIDER_ALIASES" nil}
       (^:async fn []
         (await
          (with-proxy-app
            {:keys [] :upstream-handler (fn [req body] (observe! seen req body) (list-reply [0.1 0.2 0.3]))}
            (^:async fn [{:keys [app]}]
              (let [response (await (embeddings app {:model "qwen3-embedding:0.6b" :input "hello world"}))
                    payload (:json response)]
                (is (= 200 (:status response)))
                (is (= "/v1/embeddings" (:path @seen)))
                (is (map? (:body @seen)))
                (is (= "qwen3-embedding-0.6b" (get-in @seen [:body "model"])))
                (is (map? payload))
                (is (= "qwen3-embedding-0.6b" (get payload "model")))
                (is (vector? (get payload "data")))
                (is (= [0.1 0.2 0.3] (get-in payload ["data" 0 "embedding"]))))))))))))

(deftest ^:async strips-explicit-llama-cpp-embed-prefixes-before-forwarding-embeddings
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :config-overrides {:llamacppModelPrefixes ["llamacpp-embed:" "llamacpp-embed/"]}
        :upstream-handler (fn [req body] (observe! seen req body) (list-reply [0.4 0.5 0.6]))}
       (^:async fn [{:keys [app]}]
         (let [response (await (embeddings app {:model "llamacpp-embed:qwen3-embedding:0.6b" :input "hello world"}))
               payload (:json response)]
           (is (= 200 (:status response)))
           (is (= "/v1/embeddings" (:path @seen)))
           (is (map? (:body @seen)))
           (is (= "qwen3-embedding-0.6b" (get-in @seen [:body "model"])))
           (is (map? payload))
           (is (vector? (get payload "data")))
           (is (= [0.4 0.5 0.6] (get-in payload ["data" 0 "embedding"])))))))))

(deftest ^:async rejects-auto-models-for-v1-embeddings
  (await
   (with-proxy-app
     {:keys [] :upstream-handler (fn [_ _] (throw (js/Error. "embedding upstream should not be called")))}
     (^:async fn [{:keys [app]}]
       (let [response (await (embeddings app {:model "auto:cheapest" :input "hello world"}))]
         (is (= 400 (:status response)))
         (is (= "model_not_supported" (get-in response [:headers "x-open-hax-error-code"]))))))))

(deftest ^:async rejects-oversized-embedding-batches-before-calling-upstream
  (let [called? (atom false)]
    (await
     (with-proxy-app
       {:keys []
        :config-overrides {:embedMaxBatchItems 2}
        :upstream-handler (fn [_ _] (reset! called? true) (throw (js/Error. "embedding upstream should not be called")))}
       (^:async fn [{:keys [app]}]
         (let [response (await (embeddings app {:model "qwen3-embedding:0.6b" :input ["one" "two" "three"]}))]
           (is (= 400 (:status response)))
           (is (= "embed_batch_too_large" (get-in response [:headers "x-open-hax-error-code"])))
           (is (false? @called?))))))))

(deftest ^:async rejects-oversized-embedding-character-payloads-before-calling-upstream
  (let [called? (atom false)]
    (await
     (with-proxy-app
       {:keys []
        :config-overrides {:embedMaxInputChars 10}
        :upstream-handler (fn [_ _] (reset! called? true) (throw (js/Error. "embedding upstream should not be called")))}
       (^:async fn [{:keys [app]}]
         (let [response (await (embeddings app {:model "qwen3-embedding:0.6b" :input "hello world"}))]
           (is (= 400 (:status response)))
           (is (= "embed_input_too_large" (get-in response [:headers "x-open-hax-error-code"])))
           (is (false? @called?))))))))

(defn- show-reply [] (fx/json-reply {:model_info {"qwen3.context_length" 40960}}))

(deftest ^:async proxies-native-api-embed-and-api-embeddings-to-their-matching-upstream-ollama-endpoints-with-full-embedding-context
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :upstream-handler (fn [req body]
                            (observe! seen req body)
                            (case (:path @seen)
                              "/api/show" (show-reply)
                              "/api/embeddings" (fx/json-reply {:embedding [1 2 3]})
                              (fx/json-reply {:embeddings [[1 2 3] [4 5 6]]})))}
       (^:async fn [{:keys [app]}]
         (let [batch (await (inject app {:method "POST" :url "/api/embed"
                                         :payload {:model "ollama/qwen3-embedding:0.6b" :input ["a" "b"]}}))]
           (is (= 200 (:status batch)))
           (is (= "/api/embed" (:path @seen)))
           (is (map? (:body @seen)))
           (is (map? (get-in @seen [:body "options"])))
           (is (= 40960 (get-in @seen [:body "options" "num_ctx"])))
           (is (map? (:json batch)))
           (is (= [[1 2 3] [4 5 6]] (get-in batch [:json "embeddings"])))
           (let [single (await (inject app {:method "POST" :url "/api/embeddings"
                                            :payload {:model "ollama/qwen3-embedding:0.6b" :prompt "a"}}))]
             (is (= 200 (:status single)))
             (is (= "/api/embed" (:path @seen)))
             (is (map? (:body @seen)))
             (is (map? (get-in @seen [:body "options"])))
             (is (= 40960 (get-in @seen [:body "options" "num_ctx"])))
             (is (map? (:json single)))
             (is (= [1 2 3] (get-in single [:json "embedding"]))))))))))

(deftest ^:async native-api-embed-scopes-unprefixed-models-to-native-ollama-regardless-of-prefix-order
  (let [seen (atom {})]
    (await
     (with-proxy-app
       {:keys []
        :config-overrides {:ollamaModelPrefixes ["ollama-lan/" "ollama/"]}
        :upstream-handler (fn [req body]
                            (observe! seen req body)
                            (if (= "/api/show" (:path @seen))
                              (show-reply)
                              (fx/json-reply {:embeddings [[1 2 3]]})))}
       (^:async fn [{:keys [app]}]
         (let [response (await (inject app {:method "POST" :url "/api/embed"
                                            :payload {:model "qwen3-embedding:0.6b" :input ["a"]}}))]
           (is (= 200 (:status response)))
           (is (= "/api/embed" (:path @seen)))))))))
