(ns proxx.compat.ollama-native
  "Ollama native API (/api/chat, /api/generate, /api/embed, /api/embeddings, /api/tags)
  <-> OpenAI wire shapes. Pure translation over string-keyed wire data; time and
  random digests are arguments.

  Output objects are built with `omap`, which keeps field order (a JSON body's
  field order is visible to clients) and drops nil values (a TypeScript
  `undefined` property is absent on the wire, never `null`)."
  (:require [clojure.string :as str]
            [proxx.jsval :as jv]))

(defn- omap
  "Insertion-ordered map of the non-nil values among `kvs`."
  [& kvs]
  (apply array-map (into [] (comp (partition-all 2) (remove (fn [[_ v]] (nil? v))) cat) kvs)))

(defn- record-like? [x] (or (map? x) (sequential? x)))

(defn- field [x k] (when (map? x) (get x k)))

(defn- positive-number
  "A positive finite number (or numeric string) floored, else nil."
  [value]
  (cond
    (number? value) (when (and (jv/finite? value) (pos? value)) (long (Math/floor value)))
    (string? value) (let [n (jv/js-number value)]
                      (when (and (jv/finite? n) (pos? n)) (long (Math/floor n))))))

(defn- as-boolean [value]
  (cond (boolean? value) value
        (string? value) (case (jv/lower (jv/trim value)) "true" true "false" false nil)))

(defn- map-role [value]
  (if (contains? #{"system" "assistant" "tool"} value) value "user"))

(defn- normalize-message [entry]
  (let [entry (jv/rec entry)
        pairs [["role" (map-role (get entry "role"))]
               ["content" (get entry "content")]
               ["images" (when (sequential? (get entry "images")) (get entry "images"))]
               ["tool_calls" (when (sequential? (get entry "tool_calls")) (get entry "tool_calls"))]
               ["tool_call_id" (jv/as-string (get entry "tool_call_id"))]
               ["name" (jv/as-string (get entry "name"))]]]
    ;; an explicit `content: null` is kept; every other absent field is dropped
    (apply array-map (mapcat identity (filter (fn [[k v]] (or (some? v) (and (= k "content") (contains? entry k)))) pairs)))))

(defn- normalize-messages [messages]
  (if (sequential? messages)
    (into [] (comp (filter record-like?) (map normalize-message)) messages)
    []))

(defn- spread-entries
  "`{...x}` for a record-like value: array elements become index keys."
  [x]
  (cond (map? x) (vec x)
        (sequential? x) (vec (map-indexed (fn [i v] [(str i) v]) x))
        :else []))

(defn- build-options
  "Ollama `options` from the body: explicit options win over the flat aliases.
  Returns an ordered map, or nil when empty."
  [body]
  (let [existing (spread-entries (get body "options"))
        has? (fn [k] (some (fn [[k' _]] (= k k')) existing))
        temperature (jv/as-number (get body "temperature"))
        num-predict (jv/first-non-nil (positive-number (get body "max_tokens"))
                                      (positive-number (get body "max_completion_tokens"))
                                      (positive-number (get body "num_predict")))
        num-ctx (jv/first-non-nil (positive-number (get body "num_ctx"))
                                  (positive-number (get body "ollama_num_ctx")))
        entries (cond-> existing
                  (and (some? temperature) (not (has? "temperature"))) (conj ["temperature" temperature])
                  (and (some? num-predict) (not (has? "num_predict"))) (conj ["num_predict" num-predict])
                  (and (some? num-ctx) (not (has? "num_ctx"))) (conj ["num_ctx" num-ctx]))]
    (when (seq entries)
      (apply array-map (mapcat identity entries)))))

(defn native-chat->openai-request [body]
  (let [body (or (jv/rec body) {})
        reasoning-effort (jv/as-string (get body "reasoning_effort"))
        reasoning (when (record-like? (get body "reasoning")) (get body "reasoning"))
        options (build-options body)
        think (as-boolean (get body "think"))]
    (omap "model" (jv/as-string (get body "model"))
          "messages" (normalize-messages (get body "messages"))
          "stream" (= true (get body "stream"))
          "reasoning_effort" (when (seq reasoning-effort) reasoning-effort)
          "reasoning" reasoning
          "tools" (when (sequential? (get body "tools")) (get body "tools"))
          "open_hax" (when (or options (some? think))
                       {"ollama" (apply array-map
                                        (concat (mapcat identity (or options []))
                                                (when (some? think) ["think" think])))}))))

(defn native-generate->chat-request [body]
  (let [body (or (jv/rec body) {})
        prompt (or (jv/as-string (get body "prompt")) "")
        system (jv/as-string (get body "system"))]
    (native-chat->openai-request
     (assoc body
            "messages" (cond-> []
                         (seq system) (conj {"role" "system" "content" system})
                         true (conj {"role" "user" "content" prompt}))
            "stream" false))))

(defn- first-record [choices]
  (when (sequential? choices) (first (filter record-like? choices))))

(defn- message-and-usage [response]
  (let [choice (first-record (get response "choices"))
        message (field choice "message")
        usage (get response "usage")]
    {:choice choice
     :message (if (record-like? message) (jv/rec message) {})
     :usage (if (record-like? usage) (jv/rec usage) {})}))

(defn chat-completion->native-chat [response now-iso]
  (let [{:keys [choice message usage]} (message-and-usage response)]
    (omap "model" (or (jv/as-string (get response "model")) "")
          "created_at" now-iso
          "message" (omap "role" (or (jv/as-string (get message "role")) "assistant")
                          "content" (or (jv/as-string (get message "content")) "")
                          "thinking" (jv/first-non-nil (jv/as-string (get message "reasoning_content"))
                                                       (jv/as-string (get message "reasoning")))
                          "tool_calls" (when (sequential? (get message "tool_calls")) (get message "tool_calls")))
          "done" true
          "done_reason" (or (jv/as-string (field choice "finish_reason")) "stop")
          "prompt_eval_count" (or (jv/as-number (get usage "prompt_tokens")) 0)
          "eval_count" (or (jv/as-number (get usage "completion_tokens")) 0))))

(defn chat-completion->native-generate [response now-iso]
  (let [{:keys [choice message usage]} (message-and-usage response)]
    (omap "model" (or (jv/as-string (get response "model")) "")
          "created_at" now-iso
          "response" (or (jv/as-string (get message "content")) "")
          "thinking" (jv/first-non-nil (jv/as-string (get message "reasoning_content"))
                                       (jv/as-string (get message "reasoning")))
          "done" true
          "done_reason" (or (jv/as-string (field choice "finish_reason")) "stop")
          "context" []
          "prompt_eval_count" (or (jv/as-number (get usage "prompt_tokens")) 0)
          "eval_count" (or (jv/as-number (get usage "completion_tokens")) 0))))

(defn native-embed->openai-request
  "{\"model\" \"input\"} plus num_ctx/ollama_num_ctx when the caller named a context size."
  [body]
  (let [body (or (jv/rec body) {})
        model (or (jv/as-string (get body "model")) "")
        input (jv/first-non-nil (get body "input") (get body "prompt"))
        num-ctx (jv/first-non-nil (positive-number (get body "num_ctx"))
                                  (positive-number (get body "ollama_num_ctx")))
        payload (array-map "model" model
                           "input" (if (sequential? input)
                                     (into [] (filter string?) input)
                                     (if (string? input) input "")))]
    (cond-> payload
      (some? num-ctx) (-> (assoc "num_ctx" num-ctx) (assoc "ollama_num_ctx" num-ctx)))))

(defn native-embed->ollama-request [body default-num-ctx]
  (let [embed (native-embed->openai-request body)
        num-ctx (jv/first-non-nil (get embed "num_ctx") default-num-ctx)]
    (omap "model" (get embed "model")
          "input" (get embed "input")
          "options" (when (some? num-ctx) {"num_ctx" num-ctx}))))

(defn- vectorize [data]
  (if (sequential? data)
    (into [] (comp (map (fn [entry] (when (record-like? entry)
                                      (let [e (get (jv/rec entry) "embedding")]
                                        (when (sequential? e) (into [] (filter number?) e))))))
                   (filter seq))
          data)
    []))

(defn openai-embeddings->native-embed [response]
  (let [embeddings (vectorize (field response "data"))]
    (omap "model" (or (jv/as-string (field response "model")) "")
          "embeddings" embeddings
          "total_duration" 0
          "load_duration" 0
          "prompt_eval_count" (count embeddings))))

(defn openai-embeddings->native-embeddings [response]
  {"embedding" (or (first (vectorize (field response "data"))) [])})

(defn native-embed-response->openai-embeddings [response model]
  (let [raw (cond (sequential? (field response "embeddings")) (get response "embeddings")
                  (sequential? (field response "embedding")) [(get response "embedding")]
                  :else [])
        embeddings (into [] (comp (filter sequential?) (map #(into [] (filter number?) %))) raw)]
    (omap "object" "list"
          "data" (into [] (map-indexed (fn [i e] (array-map "object" "embedding" "index" i "embedding" e))) embeddings)
          "model" model
          "usage" (array-map "prompt_tokens" 0 "total_tokens" 0))))

(defn model-ids->native-tags
  "`new-digest` is called once per model (a 32-hex-char string)."
  [model-ids now-iso new-digest]
  {"models" (into [] (map (fn [id]
                            (array-map "name" id "model" id "modified_at" now-iso "size" 0
                                       "digest" (new-digest) "details" {})))
                  model-ids)})
