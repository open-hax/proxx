(ns proxx.compat.responses
  "Pure translation between OpenAI chat-completions and the Responses API:
  requests in both directions and completed (non-streaming) responses in both
  directions. Streaming lives in `proxx.compat.responses.stream`.

  Payloads are string-keyed data; the clock is the explicit `now-ms` argument.
  Malformed provider values are tolerated (dropped or passed through); inputs
  that cannot be honoured throw `ex-info` carrying an `:error/type`."
  (:require [clojure.string :as str]
            [proxx.compat.wire :as w :refer [nes first-nes str-or as-map finite-number]]))

;; ---------------------------------------------------------------------------
;; Vocabulary (data)
;; ---------------------------------------------------------------------------

(def interleaved-reasoning-keys
  #{"reasoning_content" "reasoning_details" "tool_calls" "function_call"})

(def reasoning-part-types #{"reasoning" "reasoning_content" "reasoning_details"})
(def chat-roles #{"system" "developer" "user" "assistant" "tool"})
(def text-part-types #{"text" "input_text" "output_text" "refusal"})

(def ^:private plain-text-types #{"text" "input_text" "output_text"})

(def ^:private shared-passthrough-keys
  ["temperature" "top_p" "presence_penalty" "frequency_penalty" "parallel_tool_calls"
   "max_tool_calls" "include" "metadata" "user" "service_tier" "truncation" "prompt_cache_key"])

(defn- copy-present
  "Copy `ks` from `from` into `to` when present (an explicit null counts as present)."
  [to from ks]
  (reduce (fn [acc k] (cond-> acc (contains? from k) (assoc k (get from k)))) to ks))

;; ---------------------------------------------------------------------------
;; Text extraction
;; ---------------------------------------------------------------------------

(defn- part-text
  "Visible text of one content part, or nil. Reasoning and non-text parts are skipped."
  [part]
  (cond
    (string? part) part
    (not (map? part)) nil
    :else
    (let [type (get part "type")]
      (when-not (and (string? type)
                     (or (contains? reasoning-part-types type)
                         (not (contains? text-part-types type))))
        (first-nes (get part "text") (get part "refusal"))))))

(defn content->text
  "Flatten message content (string, parts, or arbitrary JSON) to plain text."
  [content]
  (cond
    (string? content) content
    (sequential? content) (apply str (keep part-text content))
    (nil? content) ""
    :else (w/stringify content)))

(defn- instruction-text
  "System/developer message texts joined by newlines."
  [messages]
  (->> (when (sequential? messages) messages)
       (filter #(and (map? %) (contains? #{"system" "developer"} (get % "role"))))
       (map #(content->text (get % "content")))
       (remove empty?)
       (str/join "\n")))

(defn reasoning-text
  "Reasoning text carried by a Responses `reasoning` item: its own text fields
  plus every summary entry."
  [item]
  (let [summary (get item "summary")]
    (apply str
           (concat (keep nes [(get item "reasoning") (get item "text")])
                   (when (string? summary) (keep nes [summary]))
                   (when (sequential? summary)
                     (mapcat #(when (map? %) (keep nes [(get % "text") (get % "summary")])) summary))))))

(defn- meaningful-content? [content]
  (cond (string? content) (seq content)
        (sequential? content) (seq content)
        :else (some? content)))

(defn tool-call-arguments
  "Tool arguments as the JSON string both APIs carry."
  [value]
  (cond (string? value) value
        (nil? value) "{}"
        :else (w/stringify value)))

(defn should-use-responses-upstream?
  [model prefixes]
  (and (string? model)
       (let [lower (str/lower-case model)]
         (boolean (some #(str/starts-with? lower (str/lower-case %)) prefixes)))))

;; ---------------------------------------------------------------------------
;; chat -> responses (request)
;; ---------------------------------------------------------------------------

(defn- data-url [media-type data] (str "data:" media-type ";base64," data))

(defn- input-image [url] {"type" "input_image" "image_url" url})

(defn- image-part->input-image
  "An `input_image` for any of the shapes clients send images in, or nil."
  [part]
  (let [image-url-data (as-map (get part "image_url"))
        url (first-nes (get image-url-data "url") (get part "image_url"))
        file-id (nes (get part "file_id"))
        detail (first-nes (get part "detail") (get image-url-data "detail"))
        source (as-map (get part "source"))
        source-type (get source "type")]
    (or (when (or url file-id)
          (cond-> {"type" "input_image"}
            url (assoc "image_url" url)
            file-id (assoc "file_id" file-id)
            detail (assoc "detail" detail)))
        (when (= "url" source-type)
          (some-> (nes (get source "url")) input-image))
        (when (= "base64" source-type)
          (when-let [data (nes (get source "data"))]
            (input-image (data-url (or (nes (get source "media_type")) "application/octet-stream") data))))
        (some-> (nes (get part "url")) input-image)
        (when-let [data (nes (get part "data"))]
          (input-image (data-url (first-nes (get part "mime_type") (get part "mimeType")
                                            (get part "media_type") "application/octet-stream")
                                 data))))))

(defn- text-type-for [role] (if (= "assistant" role) "output_text" "input_text"))

(defn- chat-part->responses-part
  "nil drops the part (reasoning parts and JSON nulls never reach Responses)."
  [role part]
  (cond
    (string? part) {"type" (text-type-for role) "text" part}
    (not (map? part)) part
    :else
    (let [type (get part "type")]
      (cond
        (contains? reasoning-part-types type) nil
        (contains? plain-text-types type) {"type" (text-type-for role) "text" (str-or (get part "text") "")}
        (contains? #{"image_url" "input_image" "image"} type) (or (image-part->input-image part) part)
        :else (apply dissoc part interleaved-reasoning-keys)))))

(defn- chat-content->responses-content [role content]
  (if (sequential? content)
    (into [] (comp (map #(chat-part->responses-part role %)) (remove nil?)) content)
    content))

(defn- ->chat-message-role [entry]
  (let [role (nes (get entry "role"))]
    (cond
      (nil? role) (throw (ex-info "messages entries must include a string role"
                                  {:error/type :responses/missing-role}))
      (not (contains? chat-roles role)) (throw (ex-info (str "unsupported messages role: " role)
                                                        {:error/type :responses/unsupported-role :role role}))
      :else role)))

(defn- assistant-function-calls [message-index tool-calls]
  (into []
        (keep-indexed
         (fn [tool-index call]
           (when (and (map? call) (= "function" (str-or (get call "type") "function")))
             (let [fn-data (as-map (get call "function"))]
               (when-let [name (nes (get fn-data "name"))]
                 {"type" "function_call"
                  "call_id" (or (nes (get call "id")) (str "call_" message-index "_" tool-index))
                  "name" name
                  "arguments" (tool-call-arguments (get fn-data "arguments"))})))))
        tool-calls))

(defn- chat-message->input-items [message-index entry]
  (let [role (->chat-message-role entry)
        content (get entry "content")]
    (case role
      "tool" (if-let [call-id (nes (get entry "tool_call_id"))]
               [{"type" "function_call_output" "call_id" call-id "output" (content->text content)}]
               [])
      "assistant" (let [tool-calls (let [tc (get entry "tool_calls")] (if (sequential? tc) tc []))]
                    (cond-> []
                      (meaningful-content? content)
                      (conj {"role" role "content" (chat-content->responses-content role content)})
                      true (into (assistant-function-calls message-index tool-calls))
                      (and (not (meaningful-content? content)) (empty? tool-calls))
                      (conj {"role" role "content" ""})))
      [{"role" role
        "content" (chat-content->responses-content role (if (some? content) content ""))}])))

(defn- chat-messages->responses-input [messages]
  (if (sequential? messages)
    (into []
          (comp (map-indexed vector)
                (filter (fn [[_ entry]] (map? entry)))
                (mapcat (fn [[i entry]] (chat-message->input-items i entry))))
          messages)
    []))

(defn- tool->responses-tool [tool]
  (when (map? tool)
    (if (not= "function" (str-or (get tool "type") "function"))
      tool
      (if (nes (get tool "name"))
        tool
        (let [config (as-map (get tool "function"))]
          (when-let [name (nes (get config "name"))]
            (cond-> {"type" "function" "name" name}
              (nes (get config "description")) (assoc "description" (get config "description"))
              (some? (get config "parameters")) (assoc "parameters" (get config "parameters"))
              (boolean? (get config "strict")) (assoc "strict" (get config "strict")))))))))

(defn- tools->responses-tools [tools]
  (if (sequential? tools) (into [] (keep tool->responses-tool) tools) tools))

(defn- tool-choice->responses [choice]
  (if (and (map? choice) (= "function" (get choice "type")))
    (if-let [name (or (nes (get choice "name"))
                      (nes (get (as-map (get choice "function")) "name")))]
      {"type" "function" "name" name}
      choice)
    choice))

(defn- merge-reasoning [payload body]
  (let [effort (let [e (first-nes (get body "reasoningEffort") (get body "reasoning_effort"))]
                 (if (= "max" e) "xhigh" e))
        summary (first-nes (get body "reasoningSummary") (get body "reasoning_summary"))]
    (if (or effort summary)
        (let [reasoning (or (as-map (get payload "reasoning")) {})]
          (assoc payload "reasoning"
                 (cond-> reasoning
                   (and effort (not (contains? reasoning "effort"))) (assoc "effort" effort)
                   (and summary (not (contains? reasoning "summary"))) (assoc "summary" summary))))
        payload)))

(defn- merge-text-verbosity [payload body]
  (if-let [verbosity (first-nes (get body "textVerbosity") (get body "text_verbosity"))]
    (let [text (or (as-map (get payload "text")) {})]
      (assoc payload "text"
             (cond-> text
               (not (map? (get text "format"))) (assoc "format" {"type" "text"})
               (not (contains? text "verbosity")) (assoc "verbosity" verbosity))))
    payload))

(defn chat-request->responses-request
  "Translate a chat-completions request body into a Responses request body."
  [body]
  (let [messages (get body "messages")
        max-tokens (or (finite-number (get body "max_tokens"))
                       (finite-number (get body "max_completion_tokens")))]
    (-> (cond-> {"instructions" (instruction-text messages)
                 "input" (chat-messages->responses-input messages)}
          (contains? body "model") (assoc "model" (get body "model"))
          (some? max-tokens) (assoc "max_output_tokens" max-tokens))
        (copy-present body shared-passthrough-keys)
        (copy-present body ["reasoning" "text"])
        (merge-reasoning body)
        (merge-text-verbosity body)
        (cond->
         (contains? body "tools") (assoc "tools" (tools->responses-tools (get body "tools")))
         (contains? body "tool_choice") (assoc "tool_choice" (tool-choice->responses (get body "tool_choice")))))))

;; ---------------------------------------------------------------------------
;; responses -> chat (request)
;; ---------------------------------------------------------------------------

(defn- responses-part->chat-part [part]
  (if-not (map? part)
    part
    (let [type (get part "type")]
      (cond
        (contains? plain-text-types type) {"type" "text" "text" (str-or (get part "text") "")}
        (= "refusal" type) {"type" "text" "text" (str-or (get part "refusal") "")}
        (= "input_image" type)
        (if-let [url (nes (get part "image_url"))]
          (let [detail (nes (get part "detail"))]
            {"type" "image_url" "image_url" (cond-> {"url" url} detail (assoc "detail" detail))})
          part)
        :else part))))

(defn- responses-content->chat-content [content]
  (if (sequential? content)
    (into [] (comp (map responses-part->chat-part) (remove nil?)) content)
    content))

(defn- flush-pending-tool-calls
  "Function calls arrive as sibling items; chat wants them on the assistant
  message that precedes them (or a new empty one)."
  [{:keys [pending messages] :as acc}]
  (if (empty? pending)
    acc
    (let [last-message (peek messages)
          attach? (and (map? last-message)
                       (= "assistant" (get last-message "role"))
                       (not (sequential? (get last-message "tool_calls"))))]
      (assoc acc
             :pending []
             :messages (if attach?
                         (conj (pop messages) (assoc last-message "tool_calls" pending))
                         (conj messages {"role" "assistant" "content" "" "tool_calls" pending}))))))

(defn- fold-input-item [instructions? acc entry]
  (if-not (map? entry)
    acc
    (let [type (get entry "type")]
      (cond
        (= "function_call_output" type)
        (let [acc (flush-pending-tool-calls acc)]
          (if-let [call-id (nes (get entry "call_id"))]
            (update acc :messages conj {"role" "tool" "tool_call_id" call-id
                                        "content" (content->text (get entry "output"))})
            acc))

        (= "function_call" type)
        (if-let [name (nes (get entry "name"))]
          (update acc :pending conj
                  {"id" (or (first-nes (get entry "call_id") (get entry "id"))
                            (str "call_" (count (:messages acc))))
                   "type" "function"
                   "function" {"name" name "arguments" (tool-call-arguments (get entry "arguments"))}})
          acc)

        :else
        (let [acc (flush-pending-tool-calls acc)
              role (get entry "role")]
          (if (or (not (contains? chat-roles role))
                  (and instructions? (contains? #{"system" "developer"} role)))
            acc
            (let [content (get entry "content")]
              (update acc :messages conj
                      {"role" role "content" (responses-content->chat-content (if (some? content) content ""))}))))))))

(defn- input->chat-messages [input instructions]
  (let [text (when (string? instructions) (nes (str/trim instructions)))
        base (cond-> [] text (conj {"role" "system" "content" text}))]
    (cond
      (string? input) (conj base {"role" "user" "content" input})
      (sequential? input) (-> (reduce #(fold-input-item (some? text) %1 %2)
                                      {:messages base :pending []}
                                      input)
                              flush-pending-tool-calls
                              :messages)
      :else base)))

(defn- tool->chat-tool [tool]
  (when (map? tool)
    (cond
      (not= "function" (str-or (get tool "type") "function")) tool
      (map? (get tool "function")) tool
      :else
      (when-let [name (nes (get tool "name"))]
        {"type" "function"
         "function" (cond-> {"name" name}
                      (nes (get tool "description")) (assoc "description" (get tool "description"))
                      (some? (get tool "parameters")) (assoc "parameters" (get tool "parameters"))
                      (boolean? (get tool "strict")) (assoc "strict" (get tool "strict")))}))))

(defn- tools->chat-tools [tools]
  (if (sequential? tools) (into [] (keep tool->chat-tool) tools) tools))

(defn- tool-choice->chat [choice]
  (if (and (map? choice) (= "function" (get choice "type")) (not (map? (get choice "function"))))
    (if-let [name (nes (get choice "name"))]
      {"type" "function" "function" {"name" name}}
      choice)
    choice))

(defn responses-request->chat-request
  "Translate a Responses request body into a chat-completions request body."
  [body]
  (let [max-output (finite-number (get body "max_output_tokens"))
        reasoning (get body "reasoning")]
    (-> (cond-> {"messages" (input->chat-messages (get body "input") (get body "instructions"))
                 "stream" (true? (get body "stream"))}
          (contains? body "model") (assoc "model" (get body "model"))
          (some? max-output) (assoc "max_completion_tokens" max-output))
        (copy-present body (conj shared-passthrough-keys "text" "open_hax"))
        (cond->
         (contains? body "reasoning")
         (-> (assoc "reasoning" reasoning)
             (cond->
              (string? (get (as-map reasoning) "effort")) (assoc "reasoning_effort" (get reasoning "effort"))
              (string? (get (as-map reasoning) "summary")) (assoc "reasoning_summary" (get reasoning "summary"))))
         (contains? body "tools") (assoc "tools" (tools->chat-tools (get body "tools")))
         (contains? body "tool_choice") (assoc "tool_choice" (tool-choice->chat (get body "tool_choice")))))))

;; ---------------------------------------------------------------------------
;; usage
;; ---------------------------------------------------------------------------

(defn- map-usage
  "Rename the three token counts (and the two optional detail blocks) of one
  usage shape into another; nil unless all three counts are finite numbers."
  [usage [in-k out-k total-k] [in-k' out-k' total-k'] [details-in details-out] [details-in' details-out']]
  (when-let [usage (as-map usage)]
    (let [in (finite-number (get usage in-k))
          out (finite-number (get usage out-k))
          total (finite-number (get usage total-k))
          detail (fn [from-k to-k field]
                   (when-let [d (as-map (get usage from-k))]
                     {to-k {field (or (finite-number (get d field)) 0)}}))]
      (when (and in out total)
        (merge {in-k' in out-k' out total-k' total}
               (detail details-in details-in' "cached_tokens")
               (detail details-out details-out' "reasoning_tokens"))))))

(defn chat-usage->responses-usage [usage]
  (map-usage usage
             ["prompt_tokens" "completion_tokens" "total_tokens"]
             ["input_tokens" "output_tokens" "total_tokens"]
             ["prompt_tokens_details" "completion_tokens_details"]
             ["input_tokens_details" "output_tokens_details"]))

(defn responses-usage->chat-usage
  "Chat usage never carries `completion_tokens_details` unless Responses sent
  `output_tokens_details`."
  [usage]
  (map-usage usage
             ["input_tokens" "output_tokens" "total_tokens"]
             ["prompt_tokens" "completion_tokens" "total_tokens"]
             ["input_tokens_details" "output_tokens_details"]
             ["prompt_tokens_details" "completion_tokens_details"]))

;; ---------------------------------------------------------------------------
;; chat completion -> responses response
;; ---------------------------------------------------------------------------

(defn- chat-message->output [message response-id]
  (let [reasoning (first-nes (get message "reasoning_content") (get message "reasoning"))
        content (nes (get message "content"))
        tool-calls (let [tc (get message "tool_calls")] (if (sequential? tc) tc []))]
    (cond-> []
      reasoning (conj {"id" (str "rs_" response-id) "type" "reasoning"
                       "summary" [{"type" "summary_text" "text" reasoning}]})
      content (conj {"id" (str "msg_" response-id) "type" "message" "role" "assistant" "status" "completed"
                     "content" [{"type" "output_text" "text" content}]})
      true (into (keep-indexed
                  (fn [index call]
                    (let [fn-data (as-map (get (as-map call) "function"))]
                      (when-let [name (nes (get fn-data "name"))]
                        {"id" (str "fc_" response-id "_" index)
                         "type" "function_call"
                         "call_id" (or (nes (get call "id")) (str "call_" index))
                         "name" name
                         "arguments" (tool-call-arguments (get fn-data "arguments"))
                         "status" "completed"})))
                  tool-calls)))))

(defn chat-completion->responses-response
  "Translate a chat.completion body into a Responses `response` object."
  [completion now-ms]
  (when-not (map? completion)
    (throw (ex-info "Invalid upstream chat completion payload" {:error/type :responses/invalid-chat-completion})))
  (let [id (or (nes (get completion "id")) (str "resp_" now-ms))
        choices (get completion "choices")
        first-choice (or (as-map (first (when (sequential? choices) choices))) {})
        message (or (as-map (get first-choice "message")) {"role" "assistant" "content" ""})
        usage (chat-usage->responses-usage (get completion "usage"))]
    (cond-> {"id" id
             "object" "response"
             "created_at" (or (finite-number (get completion "created")) (w/now-seconds now-ms))
             "model" (str-or (get completion "model") "")
             "status" "completed"
             "output" (chat-message->output message id)}
      usage (assoc "usage" usage))))

;; ---------------------------------------------------------------------------
;; responses response -> chat completion
;; ---------------------------------------------------------------------------

(defn- message-item-parts
  "Visible text and reasoning pieces of an assistant `message` output item."
  [item]
  (let [parts (filter map? (let [c (get item "content")] (when (sequential? c) c)))]
    {:reasoning (concat (keep nes [(get item "reasoning_content") (get item "reasoning")])
                        (mapcat #(when (contains? #{"reasoning" "thinking" "summary_text"} (get % "type"))
                                   (keep nes [(get % "text") (get % "reasoning")]))
                                parts))
     :text (keep #(when (= "output_text" (get % "type")) (nes (get %  "text"))) parts)}))

(defn- fold-output-item [acc [index item]]
  (if-not (map? item)
    acc
    (case (get item "type")
      "message" (if (= "assistant" (get item "role"))
                  (let [{:keys [reasoning text]} (message-item-parts item)]
                    (-> acc
                        (update :reasoning into reasoning)
                        (update :text into text)))
                  acc)
      "reasoning" (let [text (reasoning-text item)]
                    (cond-> acc (seq text) (update :reasoning conj text)))
      "function_call" (if-let [name (nes (get item "name"))]
                        (update acc :tool-calls conj
                                {"id" (or (nes (get item "call_id")) (str "call_" index))
                                 "type" "function"
                                 "function" {"name" name "arguments" (tool-call-arguments (get item "arguments"))}})
                        acc)
      acc)))

(defn- output->chat-message
  "{:content :reasoning :tool-calls :finish-reason}; content is nil (JSON null)
  when tool calls replace the text."
  [output]
  (let [{:keys [text reasoning tool-calls]}
        (reduce fold-output-item {:text [] :reasoning [] :tool-calls []}
                (when (sequential? output) (map-indexed vector output)))
        text (apply str text)]
    {:content (if (seq tool-calls) (nes text) text)
     :reasoning (apply str reasoning)
     :tool-calls tool-calls
     :finish-reason (if (seq tool-calls) "tool_calls" "stop")}))

(defn responses->chat-completion
  "Translate a Responses `response` object into a chat.completion body."
  [response fallback-model now-ms]
  (when-not (map? response)
    (throw (ex-info "Invalid upstream responses payload" {:error/type :responses/invalid-response})))
  (let [{:keys [content reasoning tool-calls finish-reason]} (output->chat-message (get response "output"))
        content (if (and (= "" content) (nes (get response "output_text"))) (get response "output_text") content)
        usage (responses-usage->chat-usage (get response "usage"))]
    (cond-> {"id" (or (nes (get response "id")) (str "chatcmpl_" now-ms))
             "object" "chat.completion"
             "created" (or (finite-number (get response "created_at")) (w/now-seconds now-ms))
             "model" (or (nes (get response "model")) fallback-model)
             "choices" [{"index" 0
                         "message" (cond-> {"role" "assistant" "content" content}
                                     (seq reasoning) (assoc "reasoning_content" reasoning)
                                     (seq tool-calls) (assoc "tool_calls" tool-calls))
                         "finish_reason" finish-reason}]
             "system_fingerprint" ""}
      usage (assoc "usage" usage))))

(defn output-has-reasoning?
  "Does a Responses body contain a `reasoning` output item?"
  [response]
  (boolean
   (and (map? response)
        (let [output (get response "output")]
          (and (sequential? output)
               (some #(and (map? %) (= "reasoning" (get % "type"))) output))))))
