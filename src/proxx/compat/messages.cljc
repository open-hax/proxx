(ns proxx.compat.messages
  "Pure translation between OpenAI chat-completions and Anthropic /v1/messages.

  Payloads are string-keyed data. Every function is a value-to-value
  transformation; the only ambient inputs (the clock, JSON) are explicit:
  `proxx.json` for serialization and a `now-ms` argument for timestamps.

  Malformed *provider* values are tolerated (dropped or passed through), while a
  request that cannot be honoured at all throws `ex-info` with an `:error/type`."
  (:require [clojure.string :as str]
            [proxx.json :as json]))

;; ---------------------------------------------------------------------------
;; Small total helpers
;; ---------------------------------------------------------------------------

(defn- nes
  "`x` when it is a non-empty string, else nil."
  [x]
  (when (and (string? x) (seq x)) x))

(defn- first-nes [& xs] (some nes xs))

(defn- finite-number [x]
  (when (and (number? x)
             #?(:cljs (js/Number.isFinite x)
                :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x))))))
    x))

(defn- as-map [x] (when (map? x) x))

(defn- stringify [x]
  (if (string? x) x (json/write x)))

(defn- text-part? [part]
  (and (map? part) (contains? #{"text" "input_text" "output_text"} (get part "type"))))

;; ---------------------------------------------------------------------------
;; Content parts (OpenAI/Responses -> Messages)
;; ---------------------------------------------------------------------------

(defn- parse-base64-data-url
  "{:media-type :data} for a non-empty `data:*;base64,` URL, else nil."
  [value]
  (when (str/starts-with? value "data:")
    (let [comma (str/index-of value ",")]
      (when (and comma (> comma 5))
        (let [metadata (subs value 5 comma)
              data (subs value (inc comma))
              media-type (subs metadata 0 (or (str/index-of metadata ";") (count metadata)))]
          (when (and (str/includes? (str/lower-case metadata) ";base64") (seq data))
            {:media-type (or (nes media-type) "application/octet-stream")
             :data data}))))))

(defn- image-source [url]
  (if-let [{:keys [media-type data]} (parse-base64-data-url url)]
    {"type" "base64" "media_type" media-type "data" data}
    {"type" "url" "url" url}))

(defn- image-block [source] {"type" "image" "source" source})

(defn- normalize-image-part
  "An image block for the many shapes clients send images in, or nil when the
  part carries no usable image. Candidates are tried in order of specificity."
  [part]
  (let [image-url (get part "image_url")
        source (as-map (get part "source"))]
    (or (some-> (first-nes (get (as-map image-url) "url") image-url) image-source image-block)
        (when (= "url" (get source "type"))
          (some-> (nes (get source "url")) image-source image-block))
        (when (= "base64" (get source "type"))
          (when-let [data (nes (get source "data"))]
            (image-block {"type" "base64"
                          "media_type" (or (nes (get source "media_type")) "application/octet-stream")
                          "data" data})))
        (some-> (nes (get part "url")) image-source image-block)
        (when-let [data (nes (get part "data"))]
          (image-block {"type" "base64"
                        "media_type" (first-nes (get part "mime_type") (get part "mimeType")
                                                (get part "media_type") "application/octet-stream")
                        "data" data})))))

(defn- normalize-content-part [part]
  (cond
    (string? part) {"type" "text" "text" part}
    (not (map? part)) part
    (text-part? part) {"type" "text" "text" (or (nes (get part "text")) "")}
    (contains? #{"image_url" "input_image" "image"} (get part "type"))
    (or (normalize-image-part part) part)
    :else part))

(defn- normalize-message-content [content]
  (if (sequential? content) (mapv normalize-content-part content) content))

(defn- content->text [content]
  (cond
    (string? content) content
    (nil? content) ""
    (sequential? content)
    (apply str (map (fn [part]
                      (cond (string? part) part
                            (text-part? part) (or (nes (get part "text")) "")
                            :else ""))
                    content))
    :else (stringify content)))

(defn- keep-part?
  "A normalized part survives when it is a typed map, and text parts must say something."
  [part]
  (and (map? part)
       (if-let [type (nes (get part "type"))]
         (or (not= "text" type) (some? (nes (get part "text"))))
         false)))

(defn- content->parts [content]
  (cond
    (string? content) (if (seq content) [{"type" "text" "text" content}] [])
    (nil? content) []
    (sequential? content) (into [] (comp (map normalize-content-part) (filter keep-part?)) content)
    :else [{"type" "text" "text" (stringify content)}]))

;; ---------------------------------------------------------------------------
;; Messages
;; ---------------------------------------------------------------------------

(defn- tool-use-input
  "Tool arguments as the object Anthropic requires; anything else is wrapped
  under \"value\" rather than lost."
  [arguments]
  (cond
    (map? arguments) arguments
    (nil? arguments) {}
    (string? arguments) (try (let [parsed (json/parse arguments)]
                               (cond (map? parsed) parsed
                                     (nil? parsed) {}
                                     :else {"value" parsed}))
                             (catch #?(:clj Exception :cljs :default) _
                               {"value" arguments}))
    :else {"value" arguments}))

(defn- tool-use-parts [tool-calls]
  (if (sequential? tool-calls)
    (into []
          (keep-indexed
           (fn [index call]
             (let [fn-data (as-map (get call "function"))
                   name (nes (get fn-data "name"))]
               (when (and (map? call)
                          (= "function" (or (nes (get call "type")) "function"))
                          name)
                 {"type" "tool_use"
                  "id" (or (nes (get call "id")) (str "toolu_" index))
                  "name" name
                  "input" (tool-use-input (get fn-data "arguments"))}))))
          tool-calls)
    []))

(defn- assistant-message [message]
  (let [tool-uses (tool-use-parts (get message "tool_calls"))
        content (into (content->parts (get message "content")) tool-uses)
        [only] content]
    (cond
      (empty? content) nil
      (and (empty? tool-uses) (= 1 (count content)) (= "text" (get only "type")))
      {"role" "assistant" "content" (or (nes (get only "text")) "")}
      :else {"role" "assistant" "content" content})))

(defn- tool-result [message]
  (when-let [id (nes (get message "tool_call_id"))]
    (cond-> {"type" "tool_result"
             "tool_use_id" id
             "content" (content->text (get message "content"))}
      (boolean? (get message "is_error")) (assoc "is_error" (get message "is_error")))))

;; ---------------------------------------------------------------------------
;; Tools
;; ---------------------------------------------------------------------------

(def ^:private any-choice {"type" "any"})

(def ^:private tool-choice-by-keyword
  {"required" any-choice "auto" any-choice "none" {"type" "none"}})

(defn- normalize-tool-choice [choice]
  (cond
    (string? choice) (get tool-choice-by-keyword choice choice)
    (not (map? choice)) choice
    (= "function" (get choice "type"))
    (let [fn-data (as-map (get choice "function"))
          name (nes (get (or fn-data choice) "name"))]
      (if name {"type" "tool" "name" name} any-choice))
    :else (get tool-choice-by-keyword (get choice "type") choice)))

(defn- normalize-tool [tool]
  (when (map? tool)
    (let [fn-data (as-map (get tool "function"))
          source (or fn-data tool)
          name (nes (get source "name"))
          parameters (let [p (get fn-data "parameters")] (if (some? p) p (get tool "input_schema")))]
      (when (and name (= "function" (or (nes (get tool "type")) "function")))
        (cond-> {"name" name}
          (nes (get source "description")) (assoc "description" (get source "description"))
          (some? parameters) (assoc "input_schema" parameters))))))

(defn- normalize-tools [tools]
  (if (sequential? tools) (into [] (keep normalize-tool) tools) tools))

(defn should-use-messages-upstream?
  "Does `model` start with any of `prefixes` (case-insensitive)?"
  [model prefixes]
  (and (string? model)
       (let [lower (str/lower-case model)]
         (boolean (some #(str/starts-with? lower (str/lower-case %)) prefixes)))))

;; ---------------------------------------------------------------------------
;; Extended thinking
;; ---------------------------------------------------------------------------

(def ^:private min-thinking-budget 1024)
(def ^:private default-thinking-budget 12288)

(def ^:private budget-by-effort
  {:minimal 1024 :low 4096 :medium 12288 :high 24576 :xhigh 32768})

(def ^:private effort-aliases
  {"none" :disabled "disable" :disabled "disabled" :disabled "off" :disabled
   "minimal" :minimal "low" :low
   "medium" :medium "normal" :medium "auto" :medium
   "high" :high
   "xhigh" :xhigh "very_high" :xhigh "max" :xhigh})

(defn- normalize-effort [value]
  (some-> (nes value) str/trim str/lower-case effort-aliases))

(defn- requested-max-tokens [body]
  (or (finite-number (get body "max_completion_tokens"))
      (finite-number (get body "max_tokens"))))

(defn- floor-long [x] (long (Math/floor x)))

(defn- clamp-budget
  "Budget tokens honouring both the 1024-token floor and the response cap
  (the budget must leave at least one token for the answer); nil when the cap
  is too small for extended thinking at all."
  [target max-tokens]
  (let [target (max min-thinking-budget (floor-long target))
        cap (some-> max-tokens floor-long)]
    (cond
      (or (nil? cap) (not (pos? cap))) target
      (<= cap min-thinking-budget) nil
      :else (max min-thinking-budget (min target (dec cap))))))

(defn- enabled-budget
  "Clamped budget tokens, or throws when `max-tokens` leaves no room."
  [target max-tokens]
  (or (clamp-budget target max-tokens)
      (throw (ex-info (str "Extended thinking requires max_tokens greater than " min-thinking-budget
                           " for messages-compatible models")
                      {:error/type :thinking/max-tokens-too-small
                       :max-tokens max-tokens}))))

(defn- enabled-thinking [target max-tokens]
  {"type" "enabled" "budget_tokens" (enabled-budget target max-tokens)})

(defn- requested-budget [thinking]
  (let [budget (finite-number (get thinking "budget_tokens"))]
    (if (and budget (pos? ^number budget)) budget default-thinking-budget)))

(defn normalize-messages-thinking-budget
  "Clamp an enabled `thinking.budget_tokens` to the payload's `max_tokens`.
  Returns the payload itself (identical) when nothing needs to change."
  [payload]
  (let [thinking (as-map (get payload "thinking"))]
    (if-not (= "enabled" (get thinking "type"))
      payload
      (let [budget (enabled-budget (requested-budget thinking) (finite-number (get payload "max_tokens")))]
        (if (= budget (finite-number (get thinking "budget_tokens")))
          payload
          (assoc-in payload ["thinking" "budget_tokens"] budget))))))

(defn- includes-reasoning-trace? [body]
  (let [include (get body "include")]
    (and (sequential? include) (boolean (some #{"reasoning.encrypted_content"} include)))))

(defn- thinking-request
  "The `thinking` block implied by a chat request, or nil. Precedence: an
  explicit `thinking` block, then a reasoning effort, then a request for an
  encrypted reasoning trace."
  [body]
  (let [max-tokens (requested-max-tokens body)
        explicit (as-map (get body "thinking"))
        effort (normalize-effort (first (remove nil? [(get (as-map (get body "reasoning")) "effort")
                                                      (get body "reasoning_effort")
                                                      (get body "reasoningEffort")])))]
    (cond
      (= "disabled" (get explicit "type")) {"type" "disabled"}
      (= "enabled" (get explicit "type")) (enabled-thinking (requested-budget explicit) max-tokens)
      (= :disabled effort) {"type" "disabled"}
      effort (enabled-thinking (budget-by-effort effort) max-tokens)
      (includes-reasoning-trace? body) (enabled-thinking default-thinking-budget max-tokens))))

;; ---------------------------------------------------------------------------
;; chat request -> messages request
;; ---------------------------------------------------------------------------

(defn- flush-tool-results
  "Consecutive tool results travel as one user message."
  [{:keys [pending] :as acc}]
  (if (seq pending)
    (-> acc
        (update :messages conj {"role" "user" "content" pending})
        (assoc :pending []))
    acc))

(defn- fold-message [acc raw]
  (if-not (map? raw)
    acc
    (let [role (get raw "role")]
      (case (if (string? role) role "user")
        "system" (let [text (content->text (normalize-message-content (get raw "content")))]
                   (cond-> acc
                     (seq text) (update :system #(if (seq %) (str % "\n" text) text))))
        "tool" (if-let [result (tool-result raw)] (update acc :pending conj result) acc)
        "assistant" (let [acc (flush-tool-results acc)]
                      (if-let [message (assistant-message raw)] (update acc :messages conj message) acc))
        "user" (let [content (get raw "content")]
                 (-> (flush-tool-results acc)
                     (update :messages conj {"role" "user"
                                             "content" (normalize-message-content (if (some? content) content ""))})))
        (flush-tool-results acc)))))

(defn chat-request->messages-request
  "Translate an OpenAI chat-completions request body into a /v1/messages body.
  Throws `ex-info` (:thinking/max-tokens-too-small) when extended thinking is
  requested but `max_tokens` leaves no room for it."
  [body]
  (let [raw-messages (get body "messages")
        {:keys [system messages]} (-> (reduce fold-message {:system nil :messages [] :pending []}
                                              (when (sequential? raw-messages) raw-messages))
                                      flush-tool-results)
        max-tokens (requested-max-tokens body)
        thinking (thinking-request body)]
    (-> (cond-> {"messages" messages "stream" false}
          (contains? body "model") (assoc "model" (get body "model"))
          (not (str/blank? system)) (assoc "system" system)
          (some? max-tokens) (assoc "max_tokens" max-tokens)
          (contains? body "temperature") (assoc "temperature" (get body "temperature"))
          (contains? body "top_p") (assoc "top_p" (get body "top_p"))
          thinking (assoc "thinking" thinking)
          (contains? body "tools") (assoc "tools" (normalize-tools (get body "tools")))
          (contains? body "tool_choice") (assoc "tool_choice" (normalize-tool-choice (get body "tool_choice"))))
        normalize-messages-thinking-budget)))

;; ---------------------------------------------------------------------------
;; messages response -> chat completion
;; ---------------------------------------------------------------------------

(defn- response-text [content]
  (if (string? content)
    content
    (apply str (for [part (when (sequential? content) content)
                     :when (and (map? part) (= "text" (get part "type")))]
                 (or (nes (get part "text")) "")))))

(defn- response-reasoning [content]
  (apply str
         (for [part (when (sequential? content) content)
               :when (map? part)
               :let [type (get part "type")]]
           (cond
             (contains? #{"thinking" "reasoning"} type)
             (or (first-nes (get part "thinking") (get part "text") (get part "reasoning")) "")
             (and (= "text" type) (true? (get part "thought"))) (or (nes (get part "text")) "")
             :else ""))))

(defn- response-tool-calls [content]
  (into []
        (keep-indexed
         (fn [index part]
           (when-let [name (and (map? part) (= "tool_use" (get part "type")) (nes (get part "name")))]
             (let [input (get part "input")]
               {"id" (or (nes (get part "id")) (str "call_" index))
                "type" "function"
                "function" {"name" name
                            "arguments" (if (string? input) input (json/write (if (nil? input) {} input)))}}))))
        (when (sequential? content) content)))

(defn- completion-usage [usage]
  (let [prompt (finite-number (get usage "input_tokens"))
        completion (finite-number (get usage "output_tokens"))
        cached (finite-number (get usage "cache_read_input_tokens"))]
    (when (and prompt completion)
      (cond-> {"prompt_tokens" prompt
               "completion_tokens" completion
               "total_tokens" (+ ^number prompt ^number completion)}
        cached (assoc "prompt_tokens_details" {"cached_tokens" cached})))))

(defn messages->chat-completion
  "Translate a /v1/messages response into a chat.completion. `now-ms` supplies
  the clock for `created` and for a missing response id."
  [body fallback-model now-ms]
  (when-not (map? body)
    (throw (ex-info "Invalid /v1/messages response payload" {:error/type :messages/invalid-response})))
  (let [content (get body "content")
        tool-calls (response-tool-calls content)
        tool-calls? (seq tool-calls)
        text (response-text content)
        reasoning (or (first-nes (response-reasoning content) (get body "reasoning_content") (get body "reasoning")) "")
        message (cond-> {"role" "assistant"
                         "content" (if tool-calls? (nes text) text)}
                  (seq reasoning) (assoc "reasoning_content" reasoning)
                  tool-calls? (assoc "tool_calls" tool-calls))]
    (cond-> {"id" (or (nes (get body "id")) (str "chatcmpl_" now-ms))
             "object" "chat.completion"
             "created" (floor-long (/ now-ms 1000))
             "model" (or (nes (get body "model")) fallback-model)
             "choices" [{"index" 0 "message" message "finish_reason" (if tool-calls? "tool_calls" "stop")}]
             "system_fingerprint" ""}
      (completion-usage (as-map (get body "usage")))
      (assoc "usage" (completion-usage (as-map (get body "usage")))))))
