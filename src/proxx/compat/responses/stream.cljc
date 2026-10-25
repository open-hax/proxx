(ns proxx.compat.responses.stream
  "Pure stream-shaped translation for the Responses API.

  Three families, all values in / values out:
  * buffered kernels: a complete SSE body in, a translated body (or SSE body) out;
  * `interleaved-chunks`: the chunk plan for replaying a finished response as chat
    chunks (the caller owns writing and pacing);
  * the incremental translator (`translator-init` / `translator-step` /
    `translator-finish`): a reducer over parsed Responses events whose state
    carries the chat chunks it wants written (`:out`).

  Time and JSON are explicit: `now-ms` arguments and `proxx.json`."
  (:require [clojure.string :as str]
            [proxx.compat.responses :as r]
            [proxx.compat.wire :as w :refer [nes first-nes str-or as-map finite-number]]
            [proxx.json :as json]))

;; ---------------------------------------------------------------------------
;; SSE blocks
;; ---------------------------------------------------------------------------

(def ^:private block-separator #"\r?\n\r?\n")

(defn split-blocks
  "Split streaming text into [complete-blocks incomplete-tail]."
  [text]
  (let [parts (str/split text block-separator -1)]
    [(butlast parts) (last parts)]))

(defn block->payload
  "The JSON object carried by one SSE block (its `data:` lines joined by
  newlines), or nil for empty / `[DONE]` / malformed / non-object blocks."
  [block]
  (let [lines (->> (str/split block #"\r?\n")
                   (map str/trim)
                   (filter #(str/starts-with? % "data:"))
                   (map #(str/trim (subs % 5))))
        data (when (seq lines) (str/trim (str/join "\n" lines)))]
    (when (and (seq data) (not= "[DONE]" data))
      (let [parsed (try (json/parse data) (catch #?(:clj Exception :cljs :default) _ nil))]
        (when (map? parsed) parsed)))))

(defn payloads
  "All object payloads of a complete SSE body, in order."
  [text]
  (into [] (keep block->payload) (str/split text block-separator -1)))

;; ---------------------------------------------------------------------------
;; Responses event stream -> error / terminal response / chat completion
;; ---------------------------------------------------------------------------

(def reasoning-delta-types
  #{"response.reasoning.delta" "response.reasoning_text.delta" "response.reasoning_summary.delta"
    "response.reasoning_summary_text.delta" "response.reasoning_summary_part.delta"})

(def ^:private terminal-types #{"response.completed" "response.incomplete"})

(defn reasoning-delta-text
  "Text of a reasoning delta event, whatever field the provider used."
  [payload]
  (let [delta (get payload "delta")]
    (cond
      (string? delta) delta
      (map? delta) (or (first-nes (get delta "text") (get delta "reasoning") (get delta "summary")) "")
      :else (or (first-nes (get payload "text") (get payload "reasoning")) ""))))

(defn event-stream->error-payload
  "The first `error` / `response.failed` error object in the stream, or nil."
  [text]
  (some (fn [payload]
          (case (get payload "type")
            "error" (as-map (get payload "error"))
            "response.failed" (as-map (get (as-map (get payload "response")) "error"))
            nil))
        (payloads text)))

(defn extract-terminal-response
  "The last completed/incomplete `response` object in the stream, or nil."
  [text]
  (->> (payloads text)
       (keep #(when (contains? terminal-types (get % "type")) (as-map (get % "response"))))
       last))

(defn- fold-response-event [acc payload]
  (let [type (get payload "type")
        response (as-map (get payload "response"))]
    (cond-> acc
      response (assoc :latest response)
      (and (= "response.output_text.delta" type) (nes (get payload "delta")))
      (update :text conj (get payload "delta"))
      (and (contains? reasoning-delta-types type) (seq (reasoning-delta-text payload)))
      (update :reasoning conj (reasoning-delta-text payload))
      (and (contains? terminal-types type) response) (assoc :terminal response))))

(defn- fill-missing [message k pieces]
  (if (and (not (nes (get message k))) (seq pieces))
    (assoc message k (apply str pieces))
    message))

(defn event-stream->chat-completion
  "Rebuild a chat.completion from a buffered Responses event stream. A terminal
  response wins; text/reasoning deltas only fill what it left empty. Without a
  terminal response, deltas alone synthesize the output."
  [text fallback-model now-ms]
  (let [{:keys [terminal latest text reasoning]}
        (reduce fold-response-event {:text [] :reasoning []} (payloads text))]
    (cond
      terminal
      (-> (r/responses->chat-completion terminal fallback-model now-ms)
          (update-in ["choices" 0 "message"] #(-> % (fill-missing "content" text)
                                                  (fill-missing "reasoning_content" reasoning))))

      (or (seq text) (seq reasoning))
      (r/responses->chat-completion
       (assoc (or latest {})
              "output" (cond-> []
                         (seq reasoning) (conj {"type" "reasoning"
                                                "summary" [{"type" "summary_text" "text" (apply str reasoning)}]})
                         (seq text) (conj {"type" "message" "role" "assistant"
                                           "content" [{"type" "output_text" "text" (apply str text)}]})))
       fallback-model now-ms)

      :else (throw (ex-info "Invalid upstream responses event-stream payload"
                            {:error/type :responses/invalid-event-stream})))))

;; ---------------------------------------------------------------------------
;; Chat chunk stream -> chat completion -> responses
;; ---------------------------------------------------------------------------

(defn- first-choice [payload]
  (as-map (first (let [c (get payload "choices")] (when (sequential? c) c)))))

(defn- fold-tool-call-delta
  "Accumulate one streamed tool-call fragment into its slot (keyed by index, so
  fragments of the same call concatenate and slots stay ordered)."
  [acc [fallback-index entry]]
  (if-not (map? entry)
    acc
    (let [idx (or (finite-number (get entry "index")) fallback-index)
          fn-data (as-map (get entry "function"))]
      (update-in acc [:tool-calls idx]
                 (fn [existing]
                   (cond-> (or existing {:id (or (nes (get entry "id")) (str "call_" idx))
                                         :name "" :arguments ""})
                     (nes (get fn-data "name")) (assoc :name (get fn-data "name"))
                     (nes (get fn-data "arguments")) (update :arguments str (get fn-data "arguments"))))))))

(defn- fold-delta [acc delta]
  (reduce fold-tool-call-delta
          (cond-> acc
            (nes (get delta "content")) (update :content conj (get delta "content"))
            (nes (get delta "reasoning_content")) (update :reasoning conj (get delta "reasoning_content")))
          (map-indexed vector (let [tc (get delta "tool_calls")] (when (sequential? tc) tc)))))

(defn- fold-chat-chunk [acc payload]
  (let [acc (cond-> (assoc acc
                           :id (or (nes (get payload "id")) (:id acc))
                           :created (or (finite-number (get payload "created")) (:created acc))
                           :model (or (nes (get payload "model")) (:model acc)))
              (map? (get payload "usage")) (assoc :usage (get payload "usage")))]
    (if-let [choice (first-choice payload)]
      (-> (if-let [delta (as-map (get choice "delta"))] (fold-delta acc delta) acc)
          (assoc :finish-reason (or (nes (get choice "finish_reason")) (:finish-reason acc))))
      acc)))

(defn chunks->chat-completion
  "Fold parsed chat.completion.chunk payloads into one chat.completion."
  [payloads fallback-model now-ms]
  (let [{:keys [id created model finish-reason usage content reasoning tool-calls]}
        (reduce fold-chat-chunk
                {:id (str "chatcmpl_" now-ms) :created (w/now-seconds now-ms) :model fallback-model
                 :finish-reason "stop" :content [] :reasoning [] :tool-calls (sorted-map)}
                payloads)
        calls (mapv (fn [[_ {:keys [id name arguments]}]]
                      {"id" id "type" "function" "function" {"name" name "arguments" arguments}})
                    tool-calls)
        content (apply str content)
        reasoning (apply str reasoning)]
    (cond-> {"id" id "object" "chat.completion" "created" created "model" model
             "choices" [{"index" 0
                         "message" (cond-> {"role" "assistant"
                                            "content" (if (seq calls) (nes content) content)}
                                     (seq reasoning) (assoc "reasoning_content" reasoning)
                                     (seq calls) (assoc "tool_calls" calls))
                         "finish_reason" finish-reason}]}
      usage (assoc "usage" usage))))

(defn- chat-stream-payloads [text]
  (let [ps (payloads text)]
    (when (empty? ps)
      (throw (ex-info "Invalid upstream chat completion event-stream payload"
                      {:error/type :responses/invalid-chat-event-stream})))
    ps))

(defn chat-event-stream->responses-response
  [text fallback-model now-ms]
  (r/chat-completion->responses-response
   (chunks->chat-completion (chat-stream-payloads text) fallback-model now-ms) now-ms))

;; ---------------------------------------------------------------------------
;; Chat chunk stream -> Responses event stream (buffered)
;; ---------------------------------------------------------------------------

(defn- emit [st type payload]
  (update st :events conj
          (str "event: " type "\ndata: " (json/write (into (array-map "type" type) payload)) "\n\n")))

(defn- ensure-item
  "Announce an output item the first time a delta needs it."
  [st idx-key item-id added-item]
  (if (get st idx-key)
    st
    (let [idx (get-in st [:index-by-id item-id] 0)]
      (-> st
          (assoc idx-key idx)
          (emit "response.output_item.added" {"output_index" idx "item" added-item})))))

(defn- fold-tool-delta [response-id st [fallback-index entry]]
  (if-not (map? entry)
    st
    (let [idx (or (finite-number (get entry "index")) fallback-index)
          fn-data (as-map (get entry "function"))
          args (nes (get fn-data "arguments"))
          st (if (get-in st [:tool-state idx])
               st
               (let [call-id (or (nes (get entry "id")) (str "call_" idx))
                     mapped (get-in st [:fc-by-call-id call-id])
                     item-id (or (:item-id mapped) (str "fc_" response-id "_" idx))
                     out-idx (or (:output-index mapped) (get-in st [:index-by-id item-id]) 0)]
                 (-> st
                     (assoc-in [:tool-state idx] {:item-id item-id :call-id call-id :output-index out-idx})
                     (emit "response.output_item.added"
                           {"output_index" out-idx
                            "item" {"id" item-id "type" "function_call" "status" "in_progress"
                                    "call_id" call-id "name" (str-or (get fn-data "name") "") "arguments" ""}}))))
          {:keys [item-id call-id output-index]} (get-in st [:tool-state idx])]
      (cond-> st
        args (emit "response.function_call_arguments.delta"
                   {"item_id" item-id "output_index" output-index "call_id" call-id "delta" args})))))

(defn- fold-chunk-to-events [response-id st payload]
  (if-let [delta (some-> (first-choice payload) (get "delta") as-map)]
    (let [reasoning (nes (get delta "reasoning_content"))
          content (nes (get delta "content"))
          rs-id (str "rs_" response-id)
          msg-id (str "msg_" response-id)
          st (cond-> st
               reasoning (-> (ensure-item :reasoning-index rs-id
                                          {"id" rs-id "type" "reasoning" "status" "in_progress" "summary" []})
                             (as-> st (emit st "response.reasoning.delta"
                                            {"item_id" rs-id "output_index" (:reasoning-index st)
                                             "content_index" 0 "delta" reasoning})))
               content (-> (ensure-item :message-index msg-id
                                        {"id" msg-id "type" "message" "role" "assistant"
                                         "status" "in_progress" "content" []})
                           (as-> st (emit st "response.output_text.delta"
                                          {"item_id" msg-id "output_index" (:message-index st)
                                           "content_index" 0 "delta" content}))))]
      (reduce #(fold-tool-delta response-id %1 %2)
              st
              (map-indexed vector (let [tc (get delta "tool_calls")] (when (sequential? tc) tc)))))
    st))

(defn chat-event-stream->responses-event-stream
  "Replay a buffered chat chunk stream as a Responses event stream: created,
  incremental item/delta events, then completed with the full response."
  [text fallback-model now-ms]
  (let [ps (chat-stream-payloads text)
        completion (chunks->chat-completion ps fallback-model now-ms)
        response (r/chat-completion->responses-response completion now-ms)
        response-id (or (nes (get response "id")) (str "resp_" now-ms))
        items (map-indexed vector (filter map? (get response "output")))
        st (-> {:events []
                :index-by-id (into {} (keep (fn [[i item]] (when-let [id (nes (get item "id"))] [id i]))) items)
                :fc-by-call-id (into {} (keep (fn [[i item]]
                                                (when (= "function_call" (get item "type"))
                                                  (let [id (nes (get item "id")) call-id (nes (get item "call_id"))]
                                                    (when (and id call-id) [call-id {:item-id id :output-index i}])))))
                                     items)
                :tool-state {}}
               (emit "response.created"
                     {"response" {"id" response-id "object" "response"
                                  "created_at" (or (finite-number (get response "created_at")) (w/now-seconds now-ms))
                                  "model" (or (nes (get response "model")) fallback-model)
                                  "status" "in_progress" "output" []}}))]
    (-> (reduce #(fold-chunk-to-events response-id %1 %2) st ps)
        (emit "response.completed" {"response" response})
        :events
        str/join)))

;; ---------------------------------------------------------------------------
;; chat completion -> SSE (single synthetic delta)
;; ---------------------------------------------------------------------------

(defn- completion->stream-delta [completion now-ms]
  (let [choice (or (first-choice completion) {})
        message (or (as-map (get choice "message")) {})
        tool-calls (let [tc (get message "tool_calls")] (if (sequential? tc) tc []))
        content (get message "content")
        reasoning (first-nes (get message "reasoning_content") (get message "reasoning"))
        mapped-calls (into []
                           (keep-indexed
                            (fn [index entry]
                              (let [fn-data (as-map (get (as-map entry) "function"))]
                                (when-let [name (nes (get fn-data "name"))]
                                  {"index" index
                                   "id" (str-or (get entry "id") (str "call_" index))
                                   "type" "function"
                                   "function" {"name" name
                                               "arguments" (if fn-data (r/tool-call-arguments (get fn-data "arguments")) "{}")}}))))
                           tool-calls)
        delta (cond-> {"role" "assistant"}
                reasoning (assoc "reasoning_content" reasoning)
                (seq tool-calls) (assoc "tool_calls" mapped-calls))
        delta (if (or (empty? tool-calls) (string? content))
                (cond
                  (string? content) (assoc delta "content" content)
                  (and (sequential? content) (seq content)) (assoc delta "content" content)
                  (and (map? content) (seq content)) (assoc delta "content" content)
                  (or (sequential? content) (map? content)) delta
                  (empty? tool-calls) (assoc delta "content" "")
                  :else delta)
                delta)]
    {:id (or (nes (get completion "id")) (str "chatcmpl_" now-ms))
     :created (or (finite-number (get completion "created")) (w/now-seconds now-ms))
     :model (str-or (get completion "model") "unknown")
     :delta delta
     :finish-reason (str-or (get choice "finish_reason") "stop")}))

(defn- sse [data] (str "data: " (json/write data) "\n\n"))

(defn- chat-chunk [id created model delta finish-reason]
  (array-map "id" id "object" "chat.completion.chunk" "created" created "model" model
             "choices" [(array-map "index" 0 "delta" delta "finish_reason" finish-reason)]))

(defn chat-completion->sse
  "A finished chat.completion as a two-chunk SSE body (content, then finish)."
  [completion now-ms]
  (let [{:keys [id created model delta finish-reason]} (completion->stream-delta completion now-ms)]
    (str (sse (chat-chunk id created model delta nil))
         (sse (chat-chunk id created model {} finish-reason))
         "data: [DONE]\n\n")))

;; ---------------------------------------------------------------------------
;; Interleaved replay of a finished response (chunk plan)
;; ---------------------------------------------------------------------------

(defn chunk-text-by-words
  "Group `text` into pieces of `words-per-chunk` words, whitespace preserved."
  [text words-per-chunk]
  (let [{:keys [chunks current]}
        (reduce (fn [{:keys [current words] :as acc} token]
                  (let [current (str current token)
                        words (cond-> words (seq (str/trim token)) inc)]
                    (if (>= words words-per-chunk)
                      (-> acc (update :chunks conj current) (assoc :current "" :words 0))
                      (assoc acc :current current :words words))))
                {:chunks [] :current "" :words 0}
                (re-seq #"\s+|\S+" text))]
    (cond-> chunks (seq current) (conj current))))

(defn- plan-add
  "Append a chunk to the plan; the first one also announces the assistant role."
  [st delta finish-reason pace?]
  (let [delta (if (:first? st) (assoc delta "role" "assistant") delta)]
    (-> st
        (assoc :first? false)
        (update :plan conj {:data (sse (chat-chunk (:id st) (:created st) (:model st) delta finish-reason))
                            :pace? pace?}))))

(defn- plan-text [st text field]
  (reduce (fn [st piece] (plan-add st {field piece} nil true))
          st
          (when (seq text) (chunk-text-by-words text 4))))

(defn- plan-item [st item]
  (if-not (map? item)
    st
    (case (get item "type")
      "reasoning" (plan-text st (r/reasoning-text item) "reasoning_content")

      "message"
      (if (= "assistant" (get item "role"))
        (let [top (apply str (keep nes [(get item "reasoning_content") (get item "reasoning")]))
              st (cond-> st (seq top) (plan-text top "reasoning_content"))]
          (reduce (fn [st part]
                    (if-not (map? part)
                      st
                      (case (get part "type")
                        "output_text" (plan-text st (nes (get part "text")) "content")
                        ("reasoning" "thinking" "summary_text")
                        (plan-text st (apply str (keep nes [(get part "text") (get part "reasoning")])) "reasoning_content")
                        st)))
                  st
                  (let [c (get item "content")] (when (sequential? c) c))))
        st)

      "function_call"
      (if-let [name (nes (get item "name"))]
        (let [index (:tool-index st)]
          (-> st
              (plan-add {"tool_calls" [{"index" index
                                        "id" (or (nes (get item "call_id")) (str "call_" index))
                                        "type" "function"
                                        "function" {"name" name "arguments" (r/tool-call-arguments (get item "arguments"))}}]}
                        nil true)
              (update :tool-index inc)
              (assoc :tool-calls? true)))
        st)
      st)))

(defn interleaved-chunks
  "Plan for replaying a finished Responses body as chat chunks: a vector of
  {:data sse-string :pace? bool}. Text is cut into 4-word pieces; `:pace?` marks
  chunks the caller may delay between."
  [response fallback-model now-ms]
  (let [st (reduce plan-item
                   {:id (or (nes (get response "id")) (str "chatcmpl_" now-ms))
                    :created (or (finite-number (get response "created_at")) (w/now-seconds now-ms))
                    :model (or (nes (get response "model")) fallback-model)
                    :first? true :tool-index 0 :tool-calls? false :plan []}
                   (let [o (get response "output")] (when (sequential? o) o)))
        st (cond-> st (:first? st) (plan-add {"content" ""} nil false))
        st (plan-add st {} (if (:tool-calls? st) "tool_calls" "stop") false)]
    (conj (:plan st) {:data "data: [DONE]\n\n" :pace? false})))

;; ---------------------------------------------------------------------------
;; Incremental Responses SSE -> chat chunks
;; ---------------------------------------------------------------------------

(defn translator-init [fallback-model now-ms]
  {:response-id (str "chatcmpl_" now-ms)
   :created-at (w/now-seconds now-ms)
   :model fallback-model
   :first? true :tool-calls? false :tool-index 0
   :slots []
   :terminal nil :error nil
   :out []})

(defn- out-chunk
  ([st delta] (out-chunk st delta nil nil))
  ([st delta finish-reason usage]
   (let [delta (if (and (:first? st) (not= {} delta)) (assoc delta "role" "assistant") delta)
         c (cond-> (chat-chunk (:response-id st) (:created-at st) (:model st) delta finish-reason)
             usage (assoc "usage" usage))]
     (-> st
         (cond-> (not= {} delta) (assoc :first? false))
         (update :out conj (sse c))))))

(defn- open-slot
  "Register a tool call slot and announce it."
  [st call-id item-id name arguments]
  (let [idx (:tool-index st)]
    (-> st
        (update :slots conj {:name name :call-id call-id :item-id item-id})
        (update :tool-index inc)
        (assoc :tool-calls? true)
        (out-chunk {"tool_calls" [{"index" idx "id" call-id "type" "function"
                                   "function" {"name" name "arguments" arguments}}]}))))

(defn- find-slot [slots call-id item-id]
  (first (keep-indexed (fn [i {slot-call :call-id slot-item :item-id}]
                         (when (or (and call-id (= slot-call call-id))
                                   (and item-id (or (= slot-item item-id) (= slot-call item-id))))
                           i))
                       slots)))

(defn translator-step
  "Advance the translator by one parsed Responses event."
  [st payload]
  (let [type (get payload "type")
        response (as-map (get payload "response"))]
    (cond
      (not (string? type)) st

      (contains? #{"response.created" "response.in_progress"} type)
      (cond-> st
        (nes (get response "id")) (assoc :response-id (get response "id"))
        (nes (get response "model")) (assoc :model (get response "model"))
        (let [c (get response "created_at")] (and (number? c) (not (zero? c))))
        (assoc :created-at (get response "created_at")))

      (= "error" type) (assoc st :error (or (as-map (get payload "error")) payload))

      (= "response.failed" type)
      (cond-> st (as-map (get response "error")) (assoc :error (get response "error")))

      (= "response.output_text.delta" type)
      (cond-> st (nes (get payload "delta")) (out-chunk {"content" (get payload "delta")}))

      (contains? reasoning-delta-types type)
      (let [delta (reasoning-delta-text payload)]
        (cond-> st (seq delta) (out-chunk {"reasoning_content" delta})))

      (= "response.output_item.added" type)
      (let [item (as-map (get payload "item"))]
        (if (and item (= "function_call" (get item "type")) (nes (get item "call_id")))
          (open-slot st (get item "call_id") (nes (get item "id")) (str-or (get item "name") "") "")
          st))

      (= "response.function_call_arguments.delta" type)
      (let [delta (when (string? (get payload "delta")) (get payload "delta"))
            call-id (nes (get payload "call_id"))
            item-id (nes (get payload "item_id"))
            slot (find-slot (:slots st) call-id item-id)]
        (cond
          (and (nil? slot) call-id)
          (open-slot st call-id nil (str-or (get payload "name") "") (or delta ""))

          (and (seq delta) slot)
          (out-chunk st {"tool_calls" [{"index" slot "function" {"arguments" delta}}]})

          :else st))

      (contains? terminal-types type)
      (cond-> st
        response (assoc :terminal response)
        (nes (get response "model")) (assoc :model (get response "model")))

      :else st)))

(defn translator-finish
  "Close the stream: the role chunk if nothing was written, then a usage-bearing
  finish chunk when the terminal response reported usage, else a plain finish,
  then `[DONE]`."
  [st]
  (let [st (cond-> st (:first? st) (out-chunk {"role" "assistant" "content" ""}))
        finish (if (:tool-calls? st) "tool_calls" "stop")
        usage (let [u (as-map (get (:terminal st) "usage"))
                    [in out total] (map #(let [v (get u %)] (when (number? v) v))
                                        ["input_tokens" "output_tokens" "total_tokens"])]
                (when (and in out total)
                  {"prompt_tokens" in "completion_tokens" out "total_tokens" total}))]
    (-> (if usage (out-chunk st {} finish usage) (out-chunk st {} finish nil))
        (update :out conj "data: [DONE]\n\n"))))
