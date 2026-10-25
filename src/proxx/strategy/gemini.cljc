(ns proxx.strategy.gemini
  "Pure OpenAI <-> Gemini translation for the `gemini_chat` strategy.

  Everything here is value-to-value over string-keyed wire data: building the
  Gemini request from an OpenAI chat body, reading a Gemini response back into a
  chat completion, shaping the @google/genai SDK request, folding streamed chunks
  and classifying SDK failures. The SDK call, the HTTP reply and the clock stay at
  the edge (`proxx.runtime.strategy`); time arrives as `now-ms`.

  Regression history pinned by tests (test/proxx/strategy/gemini_test.cljs):
  tool calls and tool results must round-trip, and SDK requests must preserve
  every part shape (text, functionCall, functionResponse), never `{text}` only."
  (:require [clojure.string :as str]
            [proxx.compat.reasoning :as reasoning]
            [proxx.json :as json]
            [proxx.compat.wire :as wire]))

;; ---------------------------------------------------------------------------
;; Small total helpers
;; ---------------------------------------------------------------------------

(defn- as-string [x] (when (string? x) x))

(defn- as-number [x] (wire/finite-number x))

(defn- clean-lower [x] (some-> (as-string x) str/trim str/lower-case))

(defn- first-some
  "First non-nil value (JavaScript `??`: an empty string still wins)."
  [& xs]
  (reduce (fn [_ v] (when (some? v) (reduced v))) nil xs))

(defn- records [xs] (filter map? (when (sequential? xs) xs)))

(defn content->text
  "Concatenated text of an OpenAI `content` (string, or parts with string `text`)."
  [content]
  (cond
    (string? content) content
    (sequential? content)
    (apply str (map (fn [part]
                      (cond (string? part) part
                            (and (map? part) (string? (get part "text"))) (get part "text")
                            :else ""))
                    content))
    :else ""))

;; ---------------------------------------------------------------------------
;; Reasoning effort -> thinking config
;; ---------------------------------------------------------------------------

(def ^:private effort-aliases
  {"none" "none" "disable" "none" "disabled" "none" "off" "none"
   "minimal" "minimal"
   "low" "low"
   "medium" "medium" "normal" "medium" "auto" "medium"
   "high" "high"
   "xhigh" "xhigh" "very_high" "xhigh" "max" "xhigh"})

(defn normalize-reasoning-effort
  "`none|minimal|low|medium|high|xhigh` for the many spellings clients send, else nil."
  [value]
  (when-let [raw (not-empty (clean-lower value))]
    (get effort-aliases raw)))

(defn- request-effort [body]
  (let [reasoning (get body "reasoning")]
    (normalize-reasoning-effort
     (first-some (when (map? reasoning) (get reasoning "effort"))
                 (get body "reasoning_effort")
                 (get body "reasoningEffort")))))

(defn- thinking-budget-25
  "Gemini 2.5 thinking budget: -1 (dynamic) without an effort, otherwise a
  fraction of the model's maximum clamped to its minimum."
  [effort min-budget max-budget supports-off?]
  (let [fraction (fn [f] (max min-budget (min max-budget (long (Math/floor (* max-budget f))))))]
    (case effort
      nil -1
      "none" (if supports-off? 0 min-budget)
      "minimal" min-budget
      "low" (fraction 0.25)
      "medium" (fraction 0.5)
      "high" (fraction 0.75)
      "xhigh" max-budget)))

(defn- thinking-level-3 [model effort]
  (if (str/includes? (str/lower-case model) "flash")
    (case effort
      (nil "medium") "MEDIUM"
      ("none" "minimal") "MINIMAL"
      "low" "LOW"
      ("high" "xhigh") "HIGH")
    (case effort
      ("high" "xhigh") "HIGH"
      "LOW")))

(defn thinking-config
  "The `generationConfig.thinkingConfig` for a request, or nil when the request
  asks for nothing or the model family has no thinking controls."
  [body model]
  (let [effort (request-effort body)
        wants-trace? (reasoning/wants-reasoning-trace? body)]
    (when (or wants-trace? (some? effort))
      (when-let [config (let [lower (str/lower-case model)]
                          (cond
                          (str/starts-with? lower "gemini-2.5-flash")
                          {"thinkingBudget" (thinking-budget-25 effort 1024 24576 true)}
                          (str/starts-with? lower "gemini-2.5-pro")
                          {"thinkingBudget" (thinking-budget-25 effort 128 32768 false)}
                          (str/starts-with? lower "gemini-3")
                          {"thinkingLevel" (thinking-level-3 model effort)}))]
        (cond-> config wants-trace? (assoc "includeThoughts" true))))))

;; ---------------------------------------------------------------------------
;; Request: OpenAI messages -> Gemini contents
;; ---------------------------------------------------------------------------

(defn- tool-call-arguments
  "OpenAI carries arguments as a JSON string; Gemini wants an object. Anything that
  is not an object is wrapped as `{value ...}` (arrays included: Gemini rejects
  non-object args)."
  [raw]
  (cond
    (map? raw) raw
    (seq (as-string raw))
    (try (let [parsed (json/parse raw)]
           (if (map? parsed) parsed {"value" parsed}))
         (catch #?(:cljs :default :clj Exception) _ {}))
    :else {}))

(defn- function-response-payload
  "Gemini `functionResponse.response` must be an object: JSON objects pass through,
  every other value (text, array, scalar) is wrapped as `{result ...}`."
  [content]
  (let [text (content->text content)]
    (if (empty? text)
      {"result" ""}
      (try (let [parsed (json/parse text)]
             (if (map? parsed) parsed {"result" parsed}))
           (catch #?(:cljs :default :clj Exception) _ {"result" text})))))

(defn- tool-call-names
  "tool_call_id -> function name across every assistant `tool_calls`, so tool
  results that omit their name can be labelled."
  [messages]
  (into {}
        (for [message (records messages)
              call (records (get message "tool_calls"))
              :let [id (wire/nes (get call "id"))
                    fn-map (wire/as-map (get call "function"))
                    name (wire/nes (some-> fn-map (get "name")))]
              :when (and id name)]
          [id name])))

(defn- message-role [message] (or (clean-lower (get message "role")) ""))

(defn- assistant-parts [message]
  (let [text (str/trim (content->text (get message "content")))]
    (into (if (seq text) [{"text" text}] [])
          (keep (fn [call]
                  (let [fn-map (wire/as-map (get call "function"))]
                    (when-let [name (wire/nes (some-> fn-map (get "name")))]
                      {"functionCall" {"name" name
                                       "args" (tool-call-arguments (get fn-map "arguments"))}}))))
          (records (get message "tool_calls")))))

(defn openai-messages->gemini-contents
  "Gemini `contents` for OpenAI messages. System messages are dropped (see
  `system-instructions`); assistant becomes `model`; tool results become
  `functionResponse` parts under the `user` role."
  [messages]
  (let [names (tool-call-names messages)]
    (into []
          (keep (fn [message]
                  (case (message-role message)
                    "user" (let [text (str/trim (content->text (get message "content")))]
                             (when (seq text) {"role" "user" "parts" [{"text" text}]}))
                    "assistant" (let [parts (assistant-parts message)]
                                  (when (seq parts) {"role" "model" "parts" parts}))
                    ("tool" "function")
                    (let [call-id (as-string (get message "tool_call_id"))
                          name (or (wire/nes (get message "name"))
                                   (when (seq call-id) (get names call-id))
                                   "tool")]
                      {"role" "user"
                       "parts" [{"functionResponse" {"name" name
                                                     "response" (function-response-payload (get message "content"))}}]})
                    nil)))
          (records messages))))

(defn system-instructions
  "Trimmed, non-empty text of every system message, in order."
  [messages]
  (into []
        (comp (filter #(= "system" (message-role %)))
              (map #(str/trim (content->text (get % "content"))))
              (filter seq))
        (records messages)))

;; ---------------------------------------------------------------------------
;; Request: tools and tool_choice
;; ---------------------------------------------------------------------------

(defn- function-declaration [tool]
  (when (= "function" (get tool "type"))
    (let [fn-map (wire/as-map (get tool "function"))
          name (wire/nes (some-> fn-map (get "name")))]
      (when name
        (let [description (wire/nes (get fn-map "description"))
              parameters (wire/as-map (get fn-map "parameters"))]
          (cond-> {"name" name}
            description (assoc "description" description)
            parameters (assoc "parameters" parameters)))))))

(defn- tool-config [tool-choice]
  (cond
    (string? tool-choice)
    {"functionCallingConfig" {"mode" (case tool-choice "none" "NONE" "required" "ANY" "AUTO")}}

    (and (map? tool-choice) (= "function" (get tool-choice "type")))
    (when-let [name (wire/nes (some-> (wire/as-map (get tool-choice "function")) (get "name")))]
      {"functionCallingConfig" {"mode" "ANY" "allowedFunctionNames" [name]}})))

(defn build-payload
  "The Gemini `generateContent` body for an already-normalized OpenAI chat body."
  [upstream-body routed-model]
  (let [messages (let [m (get upstream-body "messages")] (if (sequential? m) m []))
        system-parts (system-instructions messages)
        temperature (as-number (get upstream-body "temperature"))
        max-tokens (first-some (as-number (get upstream-body "max_output_tokens"))
                               (as-number (get upstream-body "max_tokens"))
                               (as-number (get upstream-body "maxTokens")))
        thinking (thinking-config upstream-body routed-model)
        generation-config (cond-> {}
                            (some? temperature) (assoc "temperature" temperature)
                            (some? max-tokens) (assoc "maxOutputTokens" max-tokens)
                            thinking (assoc "thinkingConfig" thinking))
        declarations (let [tools (get upstream-body "tools")]
                       (when (sequential? tools) (into [] (keep function-declaration) (records tools))))]
    (cond-> {"contents" (openai-messages->gemini-contents messages)}
      (seq system-parts) (assoc "systemInstruction" {"parts" [{"text" (str/join "\n\n" system-parts)}]})
      (seq generation-config) (assoc "generationConfig" generation-config)
      (seq declarations) (assoc "tools" [{"functionDeclarations" declarations}])
      (tool-config (get upstream-body "tool_choice")) (assoc "toolConfig" (tool-config (get upstream-body "tool_choice"))))))

;; ---------------------------------------------------------------------------
;; Response: Gemini -> OpenAI chat completion
;; ---------------------------------------------------------------------------

(defn- truthy? [x] (not (or (nil? x) (false? x) (= 0 x) (= "" x))))

(defn- response-tool-calls
  "OpenAI `tool_calls` for every well-formed functionCall part, ids numbered in
  order of appearance, or nil when there are none."
  [parts]
  (let [calls (into []
                    (keep (fn [part]
                            (let [call (wire/as-map (get part "functionCall"))
                                  name (wire/nes (some-> call (get "name")))]
                              (when name
                                [name (get call "args")]))))
                    (records parts))
        tool-calls (vec (map-indexed
                         (fn [i [name args]]
                           {"id" (str "call_gemini_" i)
                            "type" "function"
                            "function" {"name" name
                                        "arguments" (if (string? args) args (json/write (if (nil? args) {} args)))}})
                         calls))]
    (when (seq tool-calls) tool-calls)))

(defn- finish-reason [candidate]
  (let [raw (or (when (string? (get candidate "finishReason")) (get candidate "finishReason"))
                (as-string (get candidate "finish_reason")))]
    (if (and (seq raw) (= "max_tokens" (str/lower-case raw))) "length" "stop")))

(defn- usage-block [response]
  (let [meta (wire/as-map (get response "usageMetadata"))
        prompt (as-number (some-> meta (get "promptTokenCount")))
        completion (as-number (some-> meta (get "candidatesTokenCount")))
        total (as-number (some-> meta (get "totalTokenCount")))]
    (when (or (some? prompt) (some? completion) (some? total))
      (cond-> {}
        (some? prompt) (assoc "prompt_tokens" prompt)
        (some? completion) (assoc "completion_tokens" completion)
        (some? total) (assoc "total_tokens" total)
        (and (nil? total) (some? prompt) (some? completion)) (assoc "total_tokens" (+ ^number prompt ^number completion))))))

(defn response->chat-completion
  "Read a Gemini (or SDK) response as an OpenAI chat completion. Thought parts
  become `reasoning_content`; function calls become `tool_calls` (and the content
  is then `null` unless the model also said something)."
  [response routed-model now-ms]
  (let [created (wire/now-seconds now-ms)
        base {"id" (str "chatcmpl-gemini-" created)
              "object" "chat.completion"
              "created" created
              "model" routed-model}
        candidate (when (map? response)
                    (let [candidates (get response "candidates")]
                      (when (and (sequential? candidates) (map? (first candidates))) (first candidates))))
        parts (let [content (wire/as-map (get candidate "content"))
                    parts (get content "parts")]
                (if (sequential? parts) parts []))
        visible (for [part (records parts)
                      :when (not (truthy? (get part "functionCall")))
                      :let [text (str/trim (or (as-string (get part "text")) ""))]
                      :when (seq text)]
                  [(= true (get part "thought")) text])
        text (str/trim (str/join "\n" (map second (remove first visible))))
        reasoning-content (str/trim (str/join "\n" (map second (filter first visible))))
        tool-calls (response-tool-calls parts)
        message (cond-> {"role" "assistant"
                         "content" (if tool-calls (if (seq text) text nil) text)}
                  (seq reasoning-content) (assoc "reasoning_content" reasoning-content)
                  tool-calls (assoc "tool_calls" tool-calls))
        usage (when (map? response) (usage-block response))]
    (cond-> (assoc base "choices" [{"index" 0
                                    "message" message
                                    "finish_reason" (if candidate (finish-reason candidate) "stop")}])
      usage (assoc "usage" usage))))

;; ---------------------------------------------------------------------------
;; SDK request
;; ---------------------------------------------------------------------------

(defn payload->sdk-request
  "The `{model contents config}` the @google/genai SDK takes, from a built payload.
  Part shapes pass through untouched so tool calls and results are not dropped."
  [model payload]
  (let [contents (let [c (get payload "contents")] (if (sequential? c) c []))
        system-instruction (wire/as-map (get payload "systemInstruction"))
        generation-config (wire/as-map (get payload "generationConfig"))
        system-text (when (sequential? (get system-instruction "parts"))
                      (str/join "\n\n" (map #(or (as-string (get % "text")) "")
                                            (records (get system-instruction "parts")))))
        config (cond-> {}
                 (some? (get generation-config "temperature")) (assoc "temperature" (get generation-config "temperature"))
                 (some? (get generation-config "maxOutputTokens")) (assoc "maxOutputTokens" (get generation-config "maxOutputTokens"))
                 (truthy? (get generation-config "thinkingConfig")) (assoc "thinkingConfig" (get generation-config "thinkingConfig"))
                 (seq system-text) (assoc "systemInstruction" system-text)
                 (sequential? (get payload "tools")) (assoc "tools" (get payload "tools"))
                 (map? (get payload "toolConfig")) (assoc "toolConfig" (get payload "toolConfig")))]
    {"model" model
     "contents" (into [] (comp (filter map?)
                               (map (fn [content]
                                      {"role" (get content "role")
                                       "parts" (let [p (get content "parts")] (if (sequential? p) (vec p) []))})))
                      contents)
     "config" config}))

;; ---------------------------------------------------------------------------
;; Streaming: fold SDK chunks into one completion
;; ---------------------------------------------------------------------------

(def initial-stream {:text "" :reasoning "" :calls []})

(defn stream-step
  "Fold one streamed SDK chunk into the accumulator: text and thought text
  concatenate, function-call parts are kept whole so streamed tool calls survive."
  [acc chunk]
  (let [candidates (when (map? chunk) (get chunk "candidates"))
        candidate (when (and (sequential? candidates) (map? (first candidates))) (first candidates))
        parts (let [p (get (wire/as-map (get candidate "content")) "parts")] (if (sequential? p) p []))]
    (reduce (fn [acc part]
              (cond
                (not (map? part)) acc
                (truthy? (get part "functionCall")) (update acc :calls conj part)
                :else (let [text (or (as-string (get part "text")) "")]
                        (cond
                          (empty? text) acc
                          (= true (get part "thought")) (update acc :reasoning str text)
                          :else (update acc :text str text)))))
            acc parts)))

(defn stream->completion
  "The final chat completion for a fully folded stream. An empty stream yields an
  empty assistant message rather than no choice."
  [{:keys [text reasoning calls]} routed-model now-ms]
  (let [parts (cond-> []
                (seq text) (conj {"text" text})
                (seq reasoning) (conj {"text" reasoning "thought" true})
                :always (into calls))]
    (response->chat-completion
     {"candidates" [{"content" {"parts" (if (seq parts) parts [{"text" ""}])}
                     "finishReason" "STOP"}]}
     routed-model now-ms)))

;; ---------------------------------------------------------------------------
;; Edge facts as predicates
;; ---------------------------------------------------------------------------

(defn upstream-path
  "`/models/<model>:generateContent`, the alias (when the policy gives one) winning."
  [alias routed-model]
  (str "/models/"
       #?(:cljs (js/encodeURIComponent (or alias routed-model))
          :clj (or alias routed-model))
       ":generateContent"))

(defn local-base-url?
  "Is `base-url` a loopback origin? Those are spoken to over plain HTTP, not the SDK."
  [base-url]
  (boolean (re-find #"^https?://(127\.0\.0\.1|localhost)(?::\d+)?(?:/|$)" (or base-url ""))))

(defn sdk-eligible-model?
  "The SDK is only called for Gemini-family models; anything else would poison
  the routing accumulator with an invalid-request outcome."
  [model]
  (or (str/starts-with? model "gemini-")
      (str/starts-with? model "models/")
      (str/includes? model "gemma")))

(defn classify-sdk-error
  "Attempt-outcome flags for a failure message thrown by the SDK, first match wins."
  [message]
  (let [has? (fn [& needles] (some #(str/includes? message %) needles))]
    (cond
      (has? "rate limit" "RATE_LIMIT") {:rate-limit true}
      (has? "model not found" "MODEL_NOT_FOUND") {:model-not-found true}
      (has? "not supported" "NOT_SUPPORTED") {:model-not-supported-for-account true :request-error true}
      (has? "invalid request" "INVALID_ARGUMENT") {:request-error true :upstream-invalid-request true}
      :else {:request-error true})))
