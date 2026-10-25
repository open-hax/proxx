(ns proxx.compat.ollama-context
  "Pure context-window budgeting for Ollama requests.

  Fetching a model's context length (HTTP + cache) is the edge's job; given that
  length, estimating how many tokens a request needs and what `num_ctx` to
  recommend is arithmetic over the request body. Where Ollama reports the length
  (`context-length-keys`) is declared in 75-provider-wire-profiles.edn."
  (:require [proxx.json :as json]))

(def ^:private default-output-tokens 2048)
(def ^:private tool-call-tokens 64)
(def ^:private image-tokens 2048)
(def ^:private message-overhead-tokens 8)
(def ^:private context-step 1024)
(def ^:private min-recommended-ctx 4096)
(def ^:private headroom-tokens 512)

(defn- finite-number [x]
  (when (and (number? x)
             #?(:cljs (js/Number.isFinite x)
                :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x))))))
    x))

(defn- as-string [x] (when (string? x) x))

(defn- count-of [x] (if (sequential? x) (count x) 0))

;; ---------------------------------------------------------------------------
;; Estimation (roughly four characters per token)
;; ---------------------------------------------------------------------------

(defn estimate-text-tokens [text]
  (if (empty? text)
    0
    (max 1 (long (Math/ceil (/ (count text) 4))))))

(defn- content-text [content]
  (cond
    (string? content) content
    (sequential? content)
    (apply str (map (fn [part]
                      (cond
                        (string? part) part
                        (not (map? part)) ""
                        (contains? #{"text" "input_text" "output_text"} (get part "type")) (or (as-string (get part "text")) "")
                        (contains? #{"image" "image_url" "input_image"} (get part "type")) " [image] "
                        :else ""))
                    content))
    :else ""))

(defn- sum-messages [messages f]
  (transduce (comp (filter map?) (map f)) + 0 (when (sequential? messages) messages)))

(defn estimate-chat-tokens
  "Tokens for OpenAI-shaped messages: role + text (images as a short placeholder)
  + a flat cost per message and per tool call."
  [messages]
  (sum-messages messages
                (fn [m]
                  (+ (estimate-text-tokens (or (as-string (get m "role")) "user"))
                     (estimate-text-tokens (content-text (get m "content")))
                     message-overhead-tokens
                     (* tool-call-tokens (count-of (get m "tool_calls")))))))

(defn estimate-native-chat-tokens
  "Tokens for Ollama-native messages: string content, base64 `images`, tool calls."
  [messages]
  (sum-messages messages
                (fn [m]
                  (+ (estimate-text-tokens (or (as-string (get m "role")) "user"))
                     (estimate-text-tokens (or (as-string (get m "content")) ""))
                     message-overhead-tokens
                     (* image-tokens (count-of (get m "images")))
                     (* tool-call-tokens (count-of (get m "tool_calls")))))))

(defn estimate-embed-tokens
  "Tokens for an embedding input: one string, or a list of strings (other entries cost nothing)."
  [input]
  (cond (string? input) (estimate-text-tokens input)
        (sequential? input) (transduce (comp (filter string?) (map estimate-text-tokens)) + 0 input)
        :else 0))

;; ---------------------------------------------------------------------------
;; Context length (from /api/show) and the budget
;; ---------------------------------------------------------------------------

(defn context-length-from-show
  "The model's context window from an /api/show payload, or nil: top-level
  `context_length`, else the first finite value among `context-length-keys` in
  `model_info`."
  [context-length-keys payload]
  (when (map? payload)
    (or (finite-number (get payload "context_length"))
        (let [info (get payload "model_info")]
          (when (map? info)
            (some #(finite-number (get info %)) context-length-keys))))))

(defn- round-up-to-step [n] (* context-step (long (Math/ceil (/ n context-step)))))

(defn- budget [model context-length input-tokens output-tokens]
  (let [required (+ input-tokens output-tokens)]
    {:model model
     :context-length context-length
     :estimated-input-tokens input-tokens
     :requested-output-tokens output-tokens
     :required-context-tokens required
     :available-context-tokens context-length
     :recommended-num-ctx (min context-length (max min-recommended-ctx (round-up-to-step (+ required headroom-tokens))))}))

(defn context-budget
  "The token budget for a request of `kind` (:chat, :native-chat or :embed) against
  a model with `context-length`; nil when there is no usable model or length."
  [kind body context-length]
  (let [model (as-string (get body "model"))]
    (when (and (seq model) (number? context-length) (pos? context-length))
      (case kind
        :chat (budget model context-length
                      (estimate-chat-tokens (get body "messages"))
                      (or (finite-number (get body "max_completion_tokens"))
                          (finite-number (get body "max_tokens"))
                          default-output-tokens))
        :native-chat (budget model context-length
                             (+ (estimate-native-chat-tokens (get body "messages"))
                                (if (sequential? (get body "tools"))
                                  (estimate-text-tokens (json/write (get body "tools")))
                                  0))
                             (or (finite-number (get (when (map? (get body "options")) (get body "options")) "num_predict"))
                                 (finite-number (get body "num_predict"))
                                 default-output-tokens))
        :embed (let [input (if (some? (get body "input")) (get body "input") (get body "prompt"))]
                 (budget model context-length (estimate-embed-tokens input) 0))))))
