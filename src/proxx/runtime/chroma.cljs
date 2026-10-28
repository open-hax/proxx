(ns proxx.runtime.chroma
  "The semantic session index (formerly src/lib/chroma-session-index.ts and
  chroma-ollama-embedding.ts): a stateful component over the Chroma client.
  Decisions (vectors from Ollama replies, connection options, search rows) are the
  pure functions of proxx.chroma.index; this namespace owns the client, the
  Ollama embedding function and the `disabled` latch (one atom)."
  (:require ["chromadb" :as chromadb]
            [proxx.chroma.index :as idx]))

(defn- rethrow [f]
  (try (f)
       (catch :default e
         (throw (if (some? (ex-data e)) (js/Error. (ex-message e)) e)))))

(defn- ->jsobj [m]
  (let [o #js {}] (doseq [[k v] m] (aset o k v)) o))

(defn ollama-batch-vectors-js [payload expected-count]
  (rethrow #(to-array (map to-array (idx/batch-vectors (js->clj payload) expected-count)))))

(defn ollama-legacy-vector-js [payload]
  (rethrow #(to-array (idx/legacy-vector (js->clj payload)))))

(defn ollama-validate-config-js [config]
  (rethrow #(idx/validate-config (js->clj config)))
  js/undefined)

(defn ollama-build-config-js [config]
  (->jsobj (idx/build-config (js->clj config))))

(defn chroma-connection-options-js [^js url]
  (rethrow #(->jsobj (idx/connection-options {"protocol" (.-protocol url) "hostname" (.-hostname url) "port" (.-port url)}))))

(defn chroma-search-results-js [ids docs metas distances now]
  (to-array (map ->jsobj (idx/search-results (js->clj ids) (js->clj docs) (js->clj metas) (js->clj distances) now))))

;; ---------------------------------------------------------------------------
;; Ollama embedding function (an object Chroma can persist and rebuild)
;; ---------------------------------------------------------------------------

(defn- embed-url [base path] (.toString (js/URL. path (str base "/"))))

(defn- post-json! [url body]
  (js/fetch url #js {"method" "POST" "headers" #js {"content-type" "application/json"} "body" (js/JSON.stringify body)}))

(defn- ^:async generate-batch
  "Vectors for all `texts` through /api/embed, or nil when the server predates it (404)."
  [url model texts]
  (let [^js response (await (post-json! (embed-url url "/api/embed") #js {"model" model "input" (to-array texts)}))]
    (cond
      (= 404 (.-status response)) nil
      (not (.-ok response)) (throw (js/Error. (str "Ollama /api/embed request failed: " (.-status response))))
      :else (ollama-batch-vectors-js (await (.json response)) (count texts)))))

(defn- ^:async generate-legacy [url model text]
  (let [^js response (await (post-json! (embed-url url "/api/embeddings") #js {"model" model "prompt" text}))]
    (if-not (.-ok response)
      (throw (js/Error. (str "Ollama /api/embeddings request failed: " (.-status response))))
      (ollama-legacy-vector-js (await (.json response))))))

(declare ollama-embedding-function)

(defn- ^:async generate [url model texts]
  (if (zero? (.-length texts))
    #js []
    (let [batch (await (generate-batch url model (array-seq texts)))]
      (if (some? batch)
        batch
        (await (js/Promise.all (.map texts (fn [text] (generate-legacy url model text)))))))))

(defn ollama-embedding-function
  "An Ollama EmbeddingFunction over `url` and `model`."
  [url model]
  (let [f (js-obj)]
    (aset f "name" "ollama")
    (aset f "generate" (fn [texts] (generate url model texts)))
    (aset f "generateForQueries" (fn [texts] (generate url model texts)))
    (aset f "defaultSpace" (fn [] "cosine"))
    (aset f "supportedSpaces" (fn [] #js ["cosine" "l2" "ip"]))
    (aset f "getConfig" (fn [] #js {"url" url "model_name" model}))
    (aset f "validateConfig" (fn [config] (ollama-validate-config-js config)))
    (aset f "validateConfigUpdate" (fn [_] js/undefined))
    f))

(def ^:private ollama-embedding-constructor
  "What Chroma's registry holds under \"ollama\": `new` it with {url, model}; `buildFromConfig` rebuilds it from a stored config."
  (let [c (fn [^js options] (ollama-embedding-function (.-url options) (.-model options)))]
    (aset c "buildFromConfig"
          (fn [config] (let [^js built (ollama-build-config-js config)] (ollama-embedding-function (.-url built) (.-model built)))))
    c))

(defn- register-ollama-embedding-function! []
  (when-not (.has ^js (.-knownEmbeddingFunctions ^js chromadb) "ollama")
    ((.-registerEmbeddingFunction ^js chromadb) "ollama" ollama-embedding-constructor)))

;; ---------------------------------------------------------------------------
;; The session index
;; ---------------------------------------------------------------------------

(defn create-session-index-js
  "A semantic index of session messages. `config`: {url collectionName ollamaBaseUrl embeddingModel}.
  Methods: indexMessage(message), search(query, limit). Any failure of Chroma or the embedder latches the
  index off for the life of the process (as the TypeScript class did)."
  [^js config]
  (register-ollama-embedding-function!)
  (let [client (new (.-ChromaClient ^js chromadb) (chroma-connection-options-js (js/URL. (.-url config))))
        embedder (ollama-embedding-function (.-ollamaBaseUrl config) (.-embeddingModel config))
        disabled (atom false)
        collection-promise (atom nil)
        ensure-collection (fn ^:async ensure-collection []
                            (if @disabled
                              nil
                              (do
                                (when-not @collection-promise
                                  (reset! collection-promise
                                          (.getOrCreateCollection client
                                                                  #js {"name" (.-collectionName config)
                                                                       "embeddingFunction" embedder
                                                                       "metadata" #js {"source" "open-hax-openai-proxy"}})))
                                (try (await @collection-promise)
                                     (catch :default _ (reset! disabled true) nil)))))
        embed-text (fn ^:async embed-text [text]
                     (let [embedding (aget (await ((aget embedder "generate") #js [text])) 0)]
                       (if (or (not embedding) (zero? (.-length ^js embedding)))
                         (throw (js/Error. "Embedding response had empty vector"))
                         embedding)))
        index-obj (js-obj)]
    (aset index-obj "indexMessage"
          (fn ^:async index-message [^js message]
            (when-not (or @disabled (zero? (.-length (.trim (.-content message)))))
              (when-let [^js collection (await (ensure-collection))]
                (try
                  (let [embedding (await (embed-text (.-content message)))]
                    (await (.upsert collection
                                    #js {"ids" #js [(.-messageId message)]
                                         "documents" #js [(.-content message)]
                                         "embeddings" #js [embedding]
                                         "metadatas" #js [#js {"sessionId" (.-sessionId message)
                                                               "sessionTitle" (.-sessionTitle message)
                                                               "messageId" (.-messageId message)
                                                               "role" (.-role message)
                                                               "createdAt" (.-createdAt message)}]})))
                  (catch :default _ (reset! disabled true)))))
            js/undefined))
    (aset index-obj "search"
          (fn ^:async search [query limit]
            (if (or @disabled (zero? (.-length (.trim query))))
              #js []
              (if-let [^js collection (await (ensure-collection))]
                (try
                  (let [embedding (await (embed-text query))
                        ^js results (await (.query collection
                                                   #js {"queryEmbeddings" #js [embedding]
                                                        "nResults" (js/Math.max 1 (js/Math.min limit 50))
                                                        "include" #js [(.-documents ^js (.-IncludeEnum ^js chromadb))
                                                                       (.-metadatas ^js (.-IncludeEnum ^js chromadb))
                                                                       (.-distances ^js (.-IncludeEnum ^js chromadb))]}))
                        first-of (fn [^js xs] (let [row (when xs (aget xs 0))] (if (some? row) row #js [])))]
                    (chroma-search-results-js (first-of (.-ids results)) (first-of (.-documents results))
                                              (first-of (.-metadatas results)) (first-of (.-distances results))
                                              (js/Date.now)))
                  (catch :default _ (reset! disabled true) #js []))
                #js []))))
    index-obj))
