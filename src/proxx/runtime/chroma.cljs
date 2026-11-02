(ns proxx.runtime.chroma
  "JS edge over proxx.chroma.index. The TypeScript classes only adapt the
  `chromadb` library's class protocol (EmbeddingFunction, ChromaClient are
  handed in, never imported here, so the runtime bundle does not load chromadb);
  the Ollama fetches and the session index's disabled latch live here."
  (:require [proxx.chroma.index :as idx]))

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
;; Ollama embeddings over HTTP

(defn- endpoint [base-url path]
  (.toString (js/URL. path (str base-url "/"))))

(defn- post-json [url body]
  (js/fetch url #js {:method "POST"
                     :headers #js {"content-type" "application/json"}
                     :body (js/JSON.stringify body)}))

(defn ^:async embed-batch
  "Vectors from /api/embed, or nil when the server predates it (404)."
  [base-url model texts]
  (let [^js response (await (post-json (endpoint base-url "/api/embed") #js {:model model :input texts}))]
    (cond
      (= 404 (.-status response)) nil
      (not (.-ok response)) (throw (js/Error. (str "Ollama /api/embed request failed: " (.-status response))))
      :else (ollama-batch-vectors-js (await (.json response)) (.-length texts)))))

(defn ^:async embed-legacy [base-url model text]
  (let [^js response (await (post-json (endpoint base-url "/api/embeddings") #js {:model model :prompt text}))]
    (when-not (.-ok response)
      (throw (js/Error. (str "Ollama /api/embeddings request failed: " (.-status response)))))
    (ollama-legacy-vector-js (await (.json response)))))

(defn ^:async ollama-generate-js
  "texts -> Promise<number[][]>: one batch call, or per-text legacy calls on 404."
  [base-url model texts]
  (if (zero? (.-length texts))
    #js []
    (or (await (embed-batch base-url model texts))
        (await (js/Promise.all (.map texts (fn [text] (embed-legacy base-url model text))))))))

;; ---------------------------------------------------------------------------
;; Chroma session index

(defn ^:async embed-text [^js embedding-function text]
  (let [embedding (aget (await (.generate embedding-function #js [text])) 0)]
    (when (or (nil? embedding) (zero? (.-length embedding)))
      (throw (js/Error. "Embedding response had empty vector")))
    embedding))

(defn- disable! [state] (swap! state assoc :disabled? true))

(defn- collection-promise!
  "The collection's creation promise: started once, then shared (a failed
  creation stays failed, which disables the index)."
  [state ^js client ^js config embedding-function]
  (or (:collection @state)
      (:collection (swap! state assoc :collection
                          (.getOrCreateCollection
                           client #js {:name (.-collectionName config)
                                       :embeddingFunction embedding-function
                                       :metadata #js {:source "open-hax-openai-proxy"}})))))

(defn ^:async ensure-collection
  "The collection; nil once the index is disabled or creation fails."
  [state client config embedding-function]
  (when-not (:disabled? @state)
    (let [p (collection-promise! state client config embedding-function)]
      (try (await p)
           (catch :default _ (disable! state) nil)))))

(defn ^:async index-message [state client config embedding-function ^js message]
  (when (idx/indexable? (:disabled? @state) (.-content message))
    (when-let [^js collection (await (ensure-collection state client config embedding-function))]
      (try
        (let [embedding (await (embed-text embedding-function (.-content message)))]
          (await (.upsert collection
                          #js {:ids #js [(.-messageId message)]
                               :documents #js [(.-content message)]
                               :embeddings #js [embedding]
                               :metadatas #js [#js {:sessionId (.-sessionId message)
                                                    :sessionTitle (.-sessionTitle message)
                                                    :messageId (.-messageId message)
                                                    :role (.-role message)
                                                    :createdAt (.-createdAt message)}]})))
        (catch :default _ (disable! state)))))
  js/undefined)

(defn- first-or-empty [xs] (or (some-> xs (aget 0)) #js []))

(defn ^:async search-index [state client config embedding-function ^js include-enum query limit]
  (if-not (idx/indexable? (:disabled? @state) query)
    #js []
    (if-let [^js collection (await (ensure-collection state client config embedding-function))]
      (try
        (let [embedding (await (embed-text embedding-function query))
              ^js results (await (.query collection
                                         #js {:queryEmbeddings #js [embedding]
                                              :nResults (idx/clamp-result-limit limit)
                                              :include #js [(aget include-enum "documents")
                                                            (aget include-enum "metadatas")
                                                            (aget include-enum "distances")]}))]
          (chroma-search-results-js (first-or-empty (.-ids results))
                                    (first-or-empty (.-documents results))
                                    (first-or-empty (.-metadatas results))
                                    (first-or-empty (.-distances results))
                                    (js/Date.now)))
        (catch :default _ (disable! state) #js []))
      #js [])))

(defn create-chroma-session-index-js
  "config {url collectionName}, deps {ChromaClient, IncludeEnum, embeddingFunction}
  -> {indexMessage(message), search(query, limit)}. The first failure disables
  the index for good, as the TypeScript class did."
  [^js config ^js deps]
  (let [client (new (.-ChromaClient deps) (chroma-connection-options-js (js/URL. (.-url config))))
        embedding-function (.-embeddingFunction deps)
        include-enum (.-IncludeEnum deps)
        state (atom {:disabled? false :collection nil})]
    #js {:indexMessage (fn [message] (index-message state client config embedding-function message))
         :search (fn [query limit] (search-index state client config embedding-function include-enum query limit))}))
