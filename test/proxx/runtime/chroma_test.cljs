(ns proxx.runtime.chroma-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.chroma :as chroma]))

(defn- fake-deps
  "ChromaClient/IncludeEnum/embeddingFunction doubles; `calls` records upserts and queries."
  [calls {:keys [create-fails? query-result]}]
  (let [collection #js {:upsert (fn [x] (swap! calls conj [:upsert (js->clj x)]) (js/Promise.resolve nil))
                        :query (fn [x] (swap! calls conj [:query (js->clj x)]) (js/Promise.resolve query-result))}
        ;; a constructor that returns an object yields that object
        client-ctor (fn [opts]
                      (swap! calls conj [:client (js->clj opts)])
                      #js {:getOrCreateCollection
                           (fn [_] (if create-fails? (js/Promise.reject (js/Error. "nope")) (js/Promise.resolve collection)))})]
    #js {:ChromaClient client-ctor
         :IncludeEnum #js {"documents" "documents" "metadatas" "metadatas" "distances" "distances"}
         :embeddingFunction #js {:generate (fn [_texts] (js/Promise.resolve #js [#js [1 2 3]]))}}))

(def config #js {:url "https://chroma.example:8443/" :collectionName "c"})

(deftest ^:async index-and-search
  (let [calls (atom [])
        ^js index (chroma/create-chroma-session-index-js
                   config
                   (fake-deps calls {:query-result #js {:ids #js [#js ["m1"]]
                                                        :documents #js [#js ["hello"]]
                                                        :metadatas #js [#js [#js {"sessionId" "s" "role" "assistant"}]]
                                                        :distances #js [#js [0.5]]}}))
        r (await (.indexMessage index #js {:sessionId "s" :sessionTitle "T" :messageId "m1" :role "user" :content "hello" :createdAt 7}))
        _ (is (undefined? r))
        rows (await (.search index "q" 1000))]
    (is (= [[:client {"host" "chroma.example" "ssl" true "port" 8443}]
            [:upsert {"ids" ["m1"] "documents" ["hello"] "embeddings" [[1 2 3]]
                      "metadatas" [{"sessionId" "s" "sessionTitle" "T" "messageId" "m1" "role" "user" "createdAt" 7}]}]
            [:query {"queryEmbeddings" [[1 2 3]] "nResults" 50
                     "include" ["documents" "metadatas" "distances"]}]]
           @calls)
        "the result limit is clamped to 50")
    (is (= [{"sessionId" "s" "messageId" "m1" "role" "assistant" "content" "hello" "distance" 0.5}]
           (map #(select-keys % ["sessionId" "messageId" "role" "content" "distance"]) (js->clj rows))))))

(deftest ^:async blank-input-and-failed-creation-are-silent
  (let [calls (atom [])
        ^js index (chroma/create-chroma-session-index-js config (fake-deps calls {:create-fails? true}))
        _ (await (.indexMessage index #js {:content "   "}))
        blank (await (.search index "  " 5))
        _ (is (= [] (js->clj blank)))
        r (await (.indexMessage index #js {:content "x" :messageId "m"}))
        _ (is (undefined? r) "a failed collection disables the index without throwing")
        rows (await (.search index "q" 5))]
    (is (= [] (js->clj rows)))
    (is (= [[:client {"host" "chroma.example" "ssl" true "port" 8443}]] @calls))))

(defn- listen
  "Start `server` on an ephemeral port; resolves to its base URL."
  [^js server]
  (js/Promise.
   (fn [resolve _]
     (.listen server 0 "127.0.0.1"
              (fn [] (resolve (str "http://127.0.0.1:" (.-port (.address server)))))))))

(deftest ^:async ollama-generate-falls-back-to-legacy-on-404
  (let [http (js/require "node:http")
        seen (atom [])
        server (.createServer http
                              (fn [^js req ^js res]
                                (swap! seen conj (.-url req))
                                (.on req "data" (fn [_]))
                                (.on req "end"
                                     (fn []
                                       (if (= "/api/embed" (.-url req))
                                         (do (.writeHead res 404) (.end res "{}"))
                                         (do (.writeHead res 200 #js {"content-type" "application/json"})
                                             (.end res "{\"embedding\":[4,5]}")))))))
        base (await (listen server))]
    (try
      (let [vectors (await (chroma/ollama-generate-js (str base "/ignored-prefix") "m" #js ["a" "b"]))]
        (is (= [[4 5] [4 5]] (js->clj vectors)))
        (is (= ["/api/embed" "/api/embeddings" "/api/embeddings"] @seen)
            "an absolute /api path replaces any base prefix, as `new URL` does"))
      (catch :default e (is (nil? e)))
      (finally (.close server)))))

(deftest ^:async ollama-generate-empty
  (let [v (await (chroma/ollama-generate-js "http://127.0.0.1:1" "m" #js []))]
    (is (= [] (js->clj v)))))
