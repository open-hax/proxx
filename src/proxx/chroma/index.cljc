(ns proxx.chroma.index
  "Decisions of the Chroma session index and the Ollama embedding function,
  over already-fetched facts. The HTTP calls, the Chroma client and the
  \"disabled after first failure\" latch stay at the edge.

  Wire data is string-keyed, as parsed from JSON."
  (:require [clojure.string :as str]))

(def default-ollama-url "http://127.0.0.1:11434")
(def default-embedding-model "nomic-embed-text:latest")

(def ^:private roles #{"system" "user" "assistant" "tool"})

(defn- finite? [v]
  (and (number? v)
       #?(:cljs (js/Number.isFinite v)
          :clj (and (not (Double/isNaN (double v))) (not (Double/isInfinite (double v)))))))

(defn- as-string [v] (when (string? v) v))
(defn- as-number [v] (when (finite? v) v))

(defn- nonblank-trimmed [v]
  (when (string? v)
    (let [t (str/trim v)] (when (seq t) t))))

(defn- fail [message] (throw (ex-info message {:error/type ::embedding-failure})))

;; ---------------------------------------------------------------------------
;; Ollama embeddings

(defn to-vector
  "The finite numbers of a sequence; nil when none (or not a sequence)."
  [v]
  (when (sequential? v)
    (let [xs (filterv finite? v)] (when (seq xs) xs))))

(defn batch-vectors
  "Vectors of an /api/embed payload; every input text must have one."
  [payload expected-count]
  (when-not (and (map? payload) (sequential? (get payload "embeddings")))
    (fail "Ollama /api/embed response missing embeddings"))
  (let [vectors (into [] (keep to-vector) (get payload "embeddings"))]
    (when-not (= (count vectors) expected-count)
      (fail "Ollama /api/embed returned an unexpected embedding count"))
    vectors))

(defn legacy-vector
  "Vector of an /api/embeddings payload."
  [payload]
  (or (when (map? payload) (to-vector (get payload "embedding")))
      (fail "Ollama /api/embeddings response missing embedding")))

(defn validate-config
  "Throws unless the config names a url and a model. A present-but-blank
  `model_name` is not overridden by `model` (it never was)."
  [config]
  (when-not (nonblank-trimmed (get config "url"))
    (fail "Ollama embedding config requires a non-empty url"))
  (let [model-name (cond (string? (get config "model_name")) (get config "model_name")
                         (string? (get config "model")) (get config "model")
                         :else "")]
    (when (zero? (count (str/trim model-name)))
      (fail "Ollama embedding config requires a non-empty model_name"))))

(defn build-config
  "{\"url\" \"model\"} with trimmed values and defaults."
  [config]
  {"url" (or (nonblank-trimmed (get config "url")) default-ollama-url)
   "model" (or (nonblank-trimmed (get config "model_name"))
               (nonblank-trimmed (get config "model"))
               default-embedding-model)})

;; ---------------------------------------------------------------------------
;; Chroma session index

(defn connection-options
  "{\"host\" \"ssl\" \"port\"?} from the parts of a parsed URL."
  [{:strs [protocol hostname port]}]
  (let [ssl (= protocol "https:")]
    (when (and (not ssl) (not= protocol "http:"))
      (throw (ex-info (str "Unsupported Chroma protocol: " protocol) {:error/type ::unsupported-protocol})))
    (let [p (str/trim (or port ""))]
      (cond-> {"host" hostname "ssl" ssl}
        (seq p) (assoc "port" #?(:cljs (js/parseInt p 10) :clj (Long/parseLong p)))))))

(defn search-results
  "Rows of a Chroma query for one embedding. `now` stands in for a missing
  timestamp; rows lacking a session or message id are dropped."
  [ids docs metas distances now]
  (into []
        (keep (fn [i]
                (let [raw (nth metas i nil)
                      meta (if (or (map? raw) (sequential? raw)) raw {})
                      session-id (or (as-string (get meta "sessionId")) "")
                      message-id (or (as-string (get meta "messageId")) (as-string (nth ids i nil)) "")]
                  (when (and (seq session-id) (seq message-id))
                    {"sessionId" session-id
                     "sessionTitle" (or (as-string (get meta "sessionTitle")) "")
                     "messageId" message-id
                     "role" (let [r (get meta "role")] (if (roles r) r "user"))
                     "content" (or (as-string (nth docs i nil)) "")
                     "createdAt" (or (as-number (get meta "createdAt")) now)
                     "distance" (or (as-number (nth distances i nil)) 0)}))))
        (range (count ids))))

(defn indexable? [disabled? content]
  (and (not disabled?) (pos? (count (str/trim content)))))

(defn clamp-result-limit [limit]
  (max 1 (min limit 50)))
