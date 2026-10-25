(ns proxx.compat.ollama
  "Pure translation between OpenAI chat-completions and Ollama /api/chat,
  including the streaming conversion as a per-line state machine.

  Wire payloads are string-keyed data; time and JSON are explicit inputs
  (`now-ms`, `proxx.json`). Reading bytes off a stream is the edge's job."
  (:require [clojure.string :as str]
            [proxx.compat.reasoning :as reasoning]
            [proxx.json :as json]))

;; ---------------------------------------------------------------------------
;; Small total helpers
;; ---------------------------------------------------------------------------

(defn- nes [x] (when (and (string? x) (seq x)) x))
(defn- first-nes [& xs] (some nes xs))
(defn- as-map [x] (when (map? x) x))

(defn- finite-number [x]
  (when (and (number? x)
             #?(:cljs (js/Number.isFinite x)
                :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x))))))
    x))

(defn- floor-long [x] (long (Math/floor x)))

(defn- as-boolean
  "A boolean, or the strings \"true\"/\"false\" (any case, padded); else nil."
  [x]
  (cond (boolean? x) x
        (string? x) (case (str/lower-case (str/trim x)) "true" true "false" false nil)))

(defn- stringify [x] (if (string? x) x (json/write x)))

(defn- error! [message type data]
  (throw (ex-info message (assoc data :error/type type))))

;; ---------------------------------------------------------------------------
;; chat request -> Ollama request
;; ---------------------------------------------------------------------------

(defn- content->text [content]
  (cond
    (string? content) content
    (nil? content) ""
    (sequential? content)
    (apply str (map (fn [part]
                      (cond (string? part) part
                            (and (map? part) (contains? #{"text" "input_text"} (get part "type")))
                            (or (nes (get part "text")) "")
                            :else ""))
                    content))
    :else (stringify content)))

(defn- normalize-role
  "Ollama knows system/user/assistant; tool results ride along as user turns."
  [role]
  (if (contains? #{"system" "assistant"} role) role "user"))

(defn- ollama-messages [messages]
  (into []
        (keep (fn [raw]
                (when (map? raw)
                  (let [role (normalize-role (get raw "role"))
                        content (content->text (get raw "content"))]
                    (when (or (seq content) (= "assistant" role))
                      {"role" role "content" content})))))
        (when (sequential? messages) messages)))

(defn- positive-number
  "A positive whole number from a number or numeric string; nil when absent;
  throws on anything else."
  [value field]
  (when-not (nil? value)
    (let [n (cond (number? value) value
                  (string? value) #?(:cljs (js/Number value) :clj (parse-double (str/trim value)))
                  :else nil)]
      (if (and (some? n) (finite-number n) (pos? n))
        (floor-long n)
        (error! (str field " must be a positive number") :ollama/invalid-number {:field field})))))

(defn- control-object
  "The Ollama-specific control object: `open_hax.ollama`, else `provider_options.ollama`."
  [body]
  (or (as-map (get (as-map (get body "open_hax")) "ollama"))
      (as-map (get (as-map (get body "provider_options")) "ollama"))))

(defn- num-ctx [body]
  (let [control (control-object body)]
    (or (when control (positive-number (get control "num_ctx") "num_ctx"))
        (positive-number (get body "num_ctx") "num_ctx")
        (positive-number (get body "ollama_num_ctx") "ollama_num_ctx"))))

(defn explicit-num-ctx?
  "Does the request pin the context window? Throws on an invalid value."
  [body]
  (some? (num-ctx body)))

(defn- think-preference
  "true/false/nil: an explicit `think` (control object first), else whatever the
  request's reasoning controls imply, else no opinion."
  [body]
  (let [control (control-object body)
        from-control (when control (as-boolean (get control "think")))
        explicit (if (some? from-control) from-control (as-boolean (get body "think")))]
    (cond
      (some? explicit) explicit
      (some #(contains? body %) ["reasoning" "reasoning_effort" "reasoningEffort" "thinking" "include"])
      (reasoning/wants-reasoning-trace? body))))

(defn- stop-sequences [stop]
  (cond
    (string? stop) (when (seq stop) [stop])
    (sequential? stop) (not-empty (into [] (comp (filter string?) (map str/trim) (remove str/blank?)) stop))))

(defn- strip-model-prefix
  "Drop the first matching routing prefix (case-insensitive); keep the model
  whole when stripping would leave nothing."
  [model prefixes]
  (let [lower (str/lower-case model)]
    (if-let [prefix (some #(when (and (seq %) (str/starts-with? lower (str/lower-case %))) %) prefixes)]
      (or (nes (str/trim (subs model (count prefix)))) model)
      model)))

(defn should-use-ollama-upstream?
  "Does `model` start with any non-empty routing prefix (case-insensitive)?"
  [model prefixes]
  (and (string? model)
       (let [lower (str/lower-case model)]
         (boolean (some #(and (seq %) (str/starts-with? lower (str/lower-case %))) prefixes)))))

(defn- options [body]
  (let [max-tokens (or (finite-number (get body "max_completion_tokens")) (finite-number (get body "max_tokens")))]
    (cond-> {}
      (num-ctx body) (assoc "num_ctx" (num-ctx body))
      max-tokens (assoc "num_predict" (max 1 (floor-long max-tokens)))
      (finite-number (get body "temperature")) (assoc "temperature" (get body "temperature"))
      (finite-number (get body "top_p")) (assoc "top_p" (get body "top_p"))
      (stop-sequences (get body "stop")) (assoc "stop" (stop-sequences (get body "stop"))))))

(defn chat-request->ollama-request
  "Translate a chat-completions body into an Ollama /api/chat body. Reasoning
  controls are passed through as policy already normalized them. Throws `ex-info`
  (:ollama/empty-model, :ollama/invalid-number) on requests that cannot be honoured."
  [body model-prefixes]
  (let [requested (get body "model")
        model (strip-model-prefix (if (string? requested) requested "") model-prefixes)
        _ (when-not (and (string? model) (seq model))
            (error! "Ollama routing requires a non-empty model name" :ollama/empty-model {}))
        think (think-preference body)
        effort (nes (first (keep #(when (string? %) %) [(get body "reasoning_effort") (get body "reasoningEffort")])))
        opts (options body)]
    (cond-> {"model" model
             "stream" (true? (get body "stream"))
             "messages" (ollama-messages (get body "messages"))}
      (some? think) (assoc "think" think)
      (sequential? (get body "tools")) (assoc "tools" (get body "tools"))
      effort (assoc "reasoning_effort" effort)
      (nes (get (as-map (get body "reasoning")) "effort")) (assoc "reasoning" (get body "reasoning"))
      (seq opts) (assoc "options" opts))))

;; ---------------------------------------------------------------------------
;; Ollama response -> chat completion
;; ---------------------------------------------------------------------------

(defn- parse-created-at
  "Unix seconds of an ISO `created_at`, or of `now-ms` when it is absent or unparseable."
  [created-at now-ms]
  (let [parsed (when (string? created-at)
                 #?(:cljs (js/Date.parse created-at)
                    :clj (try (.toEpochMilli (java.time.Instant/parse created-at)) (catch Exception _ ##NaN))))]
    (floor-long (/ (if (and (number? parsed) (= parsed parsed)) parsed now-ms) 1000))))

(defn- tool-calls [message]
  (let [calls (get message "tool_calls")]
    (into []
          (keep-indexed
           (fn [index entry]
             (when (map? entry)
               (let [fn-data (as-map (get entry "function"))
                     name (first-nes (get fn-data "name") (get entry "name"))
                     args (if fn-data (get fn-data "arguments") (get entry "arguments"))]
                 (when name
                   {"id" (str "call_" index)
                    "type" "function"
                    "function" {"name" name
                                "arguments" (if (string? args) args (json/write (if (nil? args) {} args)))}})))))
          (when (sequential? calls) calls))))

(defn- finish-reason [done-reason tool-calls?]
  (cond tool-calls? "tool_calls"
        (= "length" done-reason) "length"
        :else "stop"))

(defn- message-parts
  "{:model :created :tool-calls :content :reasoning} common to full and streamed responses."
  [body fallback-model now-ms]
  (let [message (as-map (get body "message"))]
    {:model (or (nes (get body "model")) fallback-model)
     :created (parse-created-at (get body "created_at") now-ms)
     :tool-calls (tool-calls message)
     :content (or (nes (get message "content")) "")
     :reasoning (or (first-nes (get message "thinking") (get body "thinking")) "")}))

(defn ollama->chat-completion
  "Translate an Ollama /api/chat response into a chat.completion. `now-ms` supplies
  the clock for the id and for a missing/invalid `created_at`."
  [body fallback-model now-ms]
  (when-not (map? body)
    (error! "Invalid Ollama /api/chat response payload" :ollama/invalid-response {}))
  (let [{:keys [model created tool-calls content reasoning]} (message-parts body fallback-model now-ms)
        tool-calls? (seq tool-calls)
        prompt (finite-number (get body "prompt_eval_count"))
        completion (finite-number (get body "eval_count"))]
    (cond-> {"id" (str "chatcmpl_ollama_" now-ms)
             "object" "chat.completion"
             "created" created
             "model" model
             "choices" [{"index" 0
                         "message" (cond-> {"role" "assistant"
                                            "content" (if tool-calls? (nes content) content)}
                                     (seq reasoning) (assoc "reasoning_content" reasoning)
                                     tool-calls? (assoc "tool_calls" tool-calls))
                         "finish_reason" (finish-reason (get body "done_reason") tool-calls?)}]
             "system_fingerprint" ""}
      (and prompt completion) (assoc "usage" {"prompt_tokens" prompt
                                              "completion_tokens" completion
                                              "total_tokens" (+ ^number prompt ^number completion)}))))

;; ---------------------------------------------------------------------------
;; Streaming: cumulative NDJSON -> incremental SSE chunks
;; ---------------------------------------------------------------------------

(def ^:private punctuation-or-space
  #?(:cljs (js/RegExp. "^[\\s\\p{P}\\p{S}]" "u") :clj #"^[\s\p{P}\p{S}]"))

(defn- duplicated-first-token?
  "Hosted thinking streams sometimes repeat the first token: previous \"The\"
  followed by cumulative \"TheThe answer\"."
  [previous appended]
  (and (re-matches #"[^\s]+" previous)
       (str/starts-with? appended previous)
       (boolean (re-find punctuation-or-space (subs appended (count previous))))))

(defn- max-overlap
  "Length of the longest suffix of `left` that is a prefix of `right`."
  [left right]
  (or (first (filter #(str/ends-with? left (subs right 0 %)) (range (min (count left) (count right)) 0 -1)))
      0))

(defn diff-appended-text
  "The text newly added by cumulative snapshot `current` over `previous`: the
  appended suffix when it extends it (minus a duplicated first token), the
  non-overlapping tail otherwise."
  [previous current]
  (cond
    (empty? current) ""
    (empty? previous) current
    (= current previous) ""
    (str/starts-with? current previous)
    (let [appended (subs current (count previous))]
      (if (duplicated-first-token? previous appended)
        (subs appended (count previous))
        appended))
    :else (subs current (max-overlap previous current))))

(defn- chunk-event [stream-id created model delta finish-reason]
  {"id" stream-id
   "object" "chat.completion.chunk"
   "created" created
   "model" model
   "choices" [{"index" 0 "delta" delta "finish_reason" finish-reason}]})

(defn stream-step
  "Advance the stream by one parsed NDJSON object. `state` is
  {:content :reasoning} (the cumulative text seen so far); `ctx` supplies
  :stream-id :fallback-model :now-ms. Returns {:chunks [chunk ...] :done? bool :state state'}."
  [state body {:keys [stream-id fallback-model now-ms]}]
  (let [{:keys [model created tool-calls content reasoning]} (message-parts body fallback-model now-ms)
        content-delta (diff-appended-text (:content state) content)
        reasoning-delta (diff-appended-text (:reasoning state) reasoning)
        delta (cond-> {"role" "assistant"}
                (seq reasoning-delta) (assoc "reasoning_content" reasoning-delta)
                (seq tool-calls) (assoc "tool_calls" tool-calls "content" (nes content-delta))
                (and (empty? tool-calls) (seq content-delta)) (assoc "content" content-delta))
        done? (true? (get body "done"))]
    {:state {:content content :reasoning reasoning}
     :done? done?
     :chunks (cond-> []
               (> (count delta) 1) (conj (chunk-event stream-id created model delta nil))
               done? (conj (chunk-event stream-id created model {}
                                  (finish-reason (get body "done_reason") (seq tool-calls)))))}))

(defn- sse-data [x] (str "data: " (if (string? x) x (json/write x)) "\n\n"))

(def done-event "data: [DONE]\n\n")

(defn process-line
  "Feed one NDJSON line. Blank, non-JSON and non-object lines are skipped.
  Returns {:state :events [sse-string ...]}; a finished stream ends with [DONE]."
  [state line ctx]
  (let [trimmed (str/trim line)
        parsed (when (seq trimmed) (try (json/parse trimmed) (catch #?(:clj Exception :cljs :default) _ nil)))]
    (if-not (map? parsed)
      {:state state :events []}
      (let [{:keys [chunks done?] progress :state} (stream-step (:progress state) parsed ctx)]
        {:state {:progress progress :sent-done? (or (:sent-done? state) done?)}
         :events (cond-> (mapv sse-data chunks) done? (conj done-event))}))))

(def initial-stream-state {:progress {:content "" :reasoning ""} :sent-done? false})

(defn split-lines
  "Split buffered text into complete lines and the unfinished remainder."
  [buffer]
  (let [parts (str/split buffer #"\n" -1)]
    [(butlast parts) (last parts)]))
