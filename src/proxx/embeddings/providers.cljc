(ns proxx.embeddings.providers
  "Embedding backends (src/lib/embeddings-strategy.ts, embeddings-providers/index.ts):
  environment -> provider config, and per provider a pure request builder and
  response normaliser. The fetch lives at the edge.

  Configs and requests are string-keyed maps built with `omap`-style ordering
  (nil values dropped, like an `undefined` property)."
  (:require [clojure.string :as str]
            [proxx.jsval :as jv]))

(defn- omap [& kvs]
  (apply array-map (into [] (comp (partition-all 2) (remove (fn [[_ v]] (nil? v))) cat) kvs)))

(defn- parse-int [s]
  #?(:cljs (js/parseInt s 10) :clj (try (Long/parseLong s) (catch Exception _ ##NaN))))

(defn- env-int [env k default]
  (let [v (get env k)]
    (if (jv/truthy? v) (parse-int v) default)))

(defn- env-or [env k default]
  (let [v (get env k)] (if (some? v) v default)))

(defn embeddings-config
  "The per-provider configuration read from `env` (a string-keyed map)."
  [env]
  (omap
   "ollama" (omap "endpoint" (env-or env "OLLAMA_ENDPOINT" "http://localhost:11434")
                  "defaultModel" (env-or env "OLLAMA_EMBED_MODEL" "nomic-embed-text"))
   "llamacpp-embed" (omap "endpoint" (env-or env "LLAMACPP_EMBED_BASE_URL" "http://llamacpp-embed:8081")
                          "defaultModel" (env-or env "LLAMACPP_EMBED_MODEL" "qwen3-embedding-0.6b")
                          "defaultDimensions" (env-int env "LLAMACPP_EMBED_DIMENSIONS" 1024))
   "huggingface-cloud" (omap "endpoint" (env-or env "HF_INFERENCE_ENDPOINT" "https://api-inference.huggingface.co")
                             "apiKey" (get env "HF_API_KEY")
                             "defaultModel" (env-or env "HF_EMBED_MODEL" "Qwen/Qwen3-Embedding-4B")
                             "defaultDimensions" (env-int env "HF_EMBED_DIMENSIONS" nil))
   "tei" (omap "endpoint" (env-or env "TEI_ENDPOINT" "http://localhost:8080")
               "apiKey" (get env "TEI_API_KEY")
               "defaultModel" (env-or env "TEI_EMBED_MODEL" "Qwen/Qwen3-Embedding-4B")
               "defaultDimensions" (env-int env "TEI_EMBED_DIMENSIONS" nil))
   "ovm-npu" (omap "endpoint" (env-or env "OVM_NPU_ENDPOINT" "http://localhost:9000")
                   "apiKey" (get env "OVM_NPU_API_KEY")
                   "defaultModel" (env-or env "OVM_NPU_EMBED_MODEL" "OpenVINO/Qwen3-Embedding-0.6B-int8-ov")
                   "defaultDimensions" (env-int env "OVM_NPU_EMBED_DIMENSIONS" nil))
   "defaultProvider" (env-or env "EMBED_DEFAULT_PROVIDER" "ollama")))

(defn- inputs [req] (let [i (get req "input")] (if (sequential? i) i [i])))

(defn timeout-ms [cfg req] (jv/first-non-nil (get req "timeoutMs") (get cfg "timeoutMs") 30000))

(defn- auth-headers [cfg]
  (cond-> (array-map "Content-Type" "application/json")
    (jv/truthy? (get cfg "apiKey")) (assoc "Authorization" (str "Bearer " (get cfg "apiKey")))))

(def json-headers (array-map "Content-Type" "application/json"))

(defn- encode-uri-component [s]
  #?(:cljs (js/encodeURIComponent s) :clj (java.net.URLEncoder/encode s "UTF-8")))

(defn request
  "{:url :headers :body} for `provider` (\"ollama\" \"huggingface-cloud\" \"tei\" \"ovm-npu\")."
  [provider cfg req]
  (let [endpoint (get cfg "endpoint")
        dims (get req "dimensions")
        instruction (get req "instruction")]
    (case provider
      "ollama" {:url (str endpoint "/api/embed") :headers json-headers
                :body (array-map "model" (get req "model") "input" (inputs req))}
      "huggingface-cloud"
      {:url (str endpoint "/pipeline/feature-extraction/" (encode-uri-component (get req "model")))
       :headers (auth-headers cfg)
       :body (let [params (cond-> nil
                            (jv/truthy? instruction) (assoc "prompt" instruction)
                            (jv/truthy? dims) (-> (or (array-map)) (assoc "truncate_dim" dims)))]
               (cond-> (array-map "inputs" (inputs req)) params (assoc "parameters" params)))}
      "tei" {:url (str endpoint "/embed") :headers (auth-headers cfg)
             :body (cond-> (array-map "inputs" (inputs req)) (jv/truthy? dims) (assoc "truncate_dim" dims))}
      "ovm-npu" {:url (str endpoint "/v3/embeddings") :headers (auth-headers cfg)
                 :body (cond-> (array-map "model" (get req "model") "input" (inputs req))
                         (jv/truthy? dims) (assoc "dimensions" dims))})))

(def error-labels {"ollama" "Ollama" "huggingface-cloud" "HF cloud" "tei" "TEI" "ovm-npu" "ovm-npu"})

(defn error-message [provider status text]
  (str (get error-labels provider) " embed error " status ": " text))

(defn- dimension
  "`embeddings[0]?.length ?? 0`."
  [embeddings]
  (if (or (sequential? embeddings) (string? embeddings))
    (let [v (first embeddings)]
      (cond (sequential? v) (count v) (string? v) (count v) :else 0))
    0))

(defn- type-error! [message] (throw (ex-info message {:error/type :js/type-error})))

(defn- read-null! [prop]
  (type-error! (str "Cannot read properties of null (reading '" prop "')")))

(defn response
  "Normalised {provider model embeddings dimensions [usage]} from the parsed upstream JSON."
  [provider req data]
  (let [model (get req "model")
        done (fn [embeddings & more]
               (apply omap "provider" provider "model" model "embeddings" embeddings
                      "dimensions" (dimension embeddings) more))]
    (case provider
      "ollama" (let [e (when (map? data) (get data "embeddings"))]
                 (when (nil? data) (read-null! "embeddings"))
                 (when-not (sequential? e)
                   (type-error! "Cannot read properties of undefined (reading '0')"))
                 (done e))
      ;; every element of a [batch, dims] answer is itself an array, so this takes the
      ;; first value of each row (original behaviour, pinned)
      "huggingface-cloud" (done (if-not (sequential? data)
                                  (if (nil? data)
                                    (read-null! "every")
                                    (type-error! "data.every is not a function"))
                                  (if (every? sequential? data) (mapv first data) data)))
      "tei" (do (when (nil? data) (read-null! "0")) (done data))
      "ovm-npu" (let [_ (when (nil? data) (read-null! "data"))
                      _ (when-not (sequential? (when (map? data) (get data "data")))
                          (type-error! "Cannot read properties of undefined (reading 'sort')"))
                      rows (sort-by #(get % "index") (get data "data"))
                      usage (get data "usage")]
                  (done (mapv #(get % "embedding") rows)
                        "usage" (when (jv/truthy? usage)
                                  (array-map "promptTokens" (get usage "prompt_tokens")
                                             "totalTokens" (get usage "total_tokens"))))))))
