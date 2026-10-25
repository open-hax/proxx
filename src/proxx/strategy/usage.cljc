(ns proxx.strategy.usage
  "Token/image usage read out of upstream responses and event streams.

  Every function is a value-to-value decision over already-fetched text or parsed
  JSON: which wire format a mode speaks, where each format keeps its counters, and
  how the request-log patch (cache hit, TTFT, tokens/second, image cost) follows
  from the counts and timings. Reading the body, the clock and the request log are
  the edge's job (`proxx.runtime.strategy`).

  Counts are maps with only the keys that are known:
  `:prompt-tokens :completion-tokens :total-tokens :cached-prompt-tokens :image-count`."
  (:require [clojure.string :as str]
            [proxx.compat.messages :as messages]
            [proxx.compat.ollama :as ollama]
            [proxx.compat.responses :as responses]
            [proxx.compat.responses.stream :as stream]
            [proxx.compat.wire :as wire]
            [proxx.json :as json]))

(defn- as-number [x] (wire/finite-number x))

(defn- as-string [x] (when (string? x) x))

(defn- record [x] (when (or (map? x) (sequential? x)) x))

(defn- get-num [m k] (as-number (when (map? m) (get m k))))

(defn- non-nil [m] (into {} (remove (comp nil? val)) m))

(defn- parse-json [text]
  (try (json/parse text) (catch #?(:cljs :default :clj Exception) _ ::unparseable)))

;; ---------------------------------------------------------------------------
;; Mode families
;; ---------------------------------------------------------------------------

(def ^:private responses-modes
  #{"responses" "openai_responses" "responses_passthrough" "openai_responses_passthrough"})

(def ^:private ollama-modes #{"ollama_chat" "local_ollama_chat"})

(def ^:private always-sse-modes
  #{"openai_responses" "openai_responses_passthrough" "openai_chat_completions"})

(defn event-stream?
  "Does a response with this `content-type` speak a streamed wire format in `mode`?
  SSE by content type; NDJSON for Ollama; always for modes that force a stream."
  [content-type mode]
  (let [ct (str/lower-case (or content-type ""))]
    (boolean
     (or (str/includes? ct "text/event-stream")
         (and (contains? ollama-modes mode)
              (or (str/includes? ct "application/x-ndjson") (str/includes? ct "application/ndjson")))
         (contains? always-sse-modes mode)))))

(defn buffer-substantive?
  "Has the streamed text so far carried a `data:` line with real content?"
  [buffer]
  #?(:cljs (.test (js/RegExp. "(^|\\n)data:\\s*(?!\\[DONE\\])\\S" "imu") buffer)
     :clj (boolean (re-find #"(?im)(^|\n)data:\s*(?!\[DONE\])\S" buffer))))

;; ---------------------------------------------------------------------------
;; Counts from one completion-shaped payload
;; ---------------------------------------------------------------------------

(defn cached-prompt-tokens
  "Cached prompt tokens under whichever spelling the provider used, first found."
  [usage]
  (or (get-num usage "cached_tokens")
      (get-num usage "cache_read_input_tokens")
      (get-num (wire/as-map (get usage "prompt_tokens_details")) "cached_tokens")
      (get-num (wire/as-map (get usage "input_tokens_details")) "cached_tokens")))

(defn- with-total [prompt completion total]
  (or total (when (and (some? prompt) (some? completion)) (+ ^number prompt ^number completion))))

(defn counts-from-completion [completion]
  (if-let [usage (wire/as-map (when (map? completion) (get completion "usage")))]
    (let [prompt (get-num usage "prompt_tokens")
          completion-tokens (get-num usage "completion_tokens")]
      (non-nil {:prompt-tokens prompt
                :completion-tokens completion-tokens
                :total-tokens (with-total prompt completion-tokens (get-num usage "total_tokens"))
                :cached-prompt-tokens (cached-prompt-tokens usage)}))
    {}))

(defn counts-from-gemini-response [response]
  (if-let [meta (wire/as-map (when (map? response) (get response "usageMetadata")))]
    (non-nil {:prompt-tokens (get-num meta "promptTokenCount")
              :completion-tokens (get-num meta "candidatesTokenCount")
              :total-tokens (get-num meta "totalTokenCount")})
    {}))

;; ---------------------------------------------------------------------------
;; Images
;; ---------------------------------------------------------------------------

(defn image-count-from-images-payload [payload]
  (let [data (get payload "data") images (get payload "images")]
    (cond (sequential? data) (count data)
          (sequential? images) (count images))))

(defn- image-output-count [item]
  (when (map? item)
    (case (get item "type")
      "image_generation_call"
      (let [result (get item "result")]
        (cond (sequential? result) (count result)
              (string? result) (if (seq result) 1 0)
              :else 1))
      ("image" "output_image") 1
      nil)))

(defn image-count-from-responses-payload [payload]
  (let [response (if (and (= "response.completed" (get payload "type")) (map? (get payload "response")))
                   (get payload "response")
                   payload)
        output (let [o (get response "output")] (if (sequential? o) o []))
        total (reduce + 0 (keep image-output-count output))]
    (when (and (seq output) (pos? total)) total)))

;; ---------------------------------------------------------------------------
;; Counts from a whole JSON body
;; ---------------------------------------------------------------------------

(defn- with-image-count [counts image-count]
  (cond-> counts (some? image-count) (assoc :image-count image-count)))

(defn- any-token-count? [counts]
  (some counts [:prompt-tokens :completion-tokens :total-tokens :cached-prompt-tokens]))

(defn- converted-counts
  "Counts via the first translation that reads the body without throwing."
  [json-body routed-model now-ms]
  (try (counts-from-completion (responses/responses->chat-completion json-body routed-model now-ms))
       (catch #?(:cljs :default :clj Exception) _
         (try (counts-from-completion (messages/messages->chat-completion json-body routed-model now-ms))
              (catch #?(:cljs :default :clj Exception) _
                (try (counts-from-completion (ollama/ollama->chat-completion json-body routed-model now-ms))
                     (catch #?(:cljs :default :clj Exception) _ (counts-from-completion json-body))))))))

(defn counts-from-upstream-json
  "Usage of an unclassified JSON body: direct `usage` first, else through the
  Responses, Messages and Ollama readers in turn."
  [json-body routed-model now-ms]
  (if-not (map? json-body)
    {}
    (let [direct (counts-from-completion json-body)
          image-count (or (image-count-from-images-payload json-body)
                          (image-count-from-responses-payload json-body))]
      (if (any-token-count? direct)
        (with-image-count direct image-count)
        (with-image-count (converted-counts json-body routed-model now-ms) image-count)))))

(defn counts-for-mode
  "Usage of a non-streamed JSON body, read the way `mode`'s wire format keeps it."
  [mode json-body routed-model now-ms]
  (cond
    (not (map? json-body)) {}
    (= "messages" mode)
    (counts-from-completion (messages/messages->chat-completion json-body routed-model now-ms))
    (contains? responses-modes mode)
    (with-image-count (counts-from-completion (responses/responses->chat-completion json-body routed-model now-ms))
      (image-count-from-responses-payload json-body))
    (= "images" mode)
    (with-image-count {} (or (image-count-from-images-payload json-body)
                             (image-count-from-responses-payload json-body)))
    (= "gemini_chat" mode) (counts-from-gemini-response json-body)
    (contains? ollama-modes mode)
    (counts-from-completion (ollama/ollama->chat-completion json-body routed-model now-ms))
    :else (counts-from-upstream-json json-body routed-model now-ms)))

;; ---------------------------------------------------------------------------
;; Counts from streamed text
;; ---------------------------------------------------------------------------

(defn- gemini-stream-counts [stream-text]
  (let [last-payload (reduce (fn [acc line]
                               (let [trimmed (str/trim line)]
                                 (if (or (empty? trimmed) (= "data: [DONE]" trimmed) (= "[DONE]" trimmed))
                                   acc
                                   (let [json-text (if (str/starts-with? trimmed "data:")
                                                     (str/trim (subs trimmed 5))
                                                     trimmed)
                                         parsed (parse-json json-text)]
                                     (or (record (when-not (= ::unparseable parsed) parsed)) acc)))))
                             nil (str/split stream-text #"\n"))]
    (counts-from-gemini-response last-payload)))

(defn- openai-chat-line-counts [line]
  (let [trimmed (str/trim line)]
    (when (and (str/starts-with? trimmed "data: ") (not= "data: [DONE]" trimmed))
      (let [payload (parse-json (subs trimmed 6))
            usage (wire/as-map (when (map? payload) (get payload "usage")))]
        (when usage
          (let [prompt (get-num usage "prompt_tokens")
                completion (get-num usage "completion_tokens")
                total (with-total prompt completion (get-num usage "total_tokens"))
                cached (cached-prompt-tokens usage)]
            (when (or (some? prompt) (some? completion))
              (non-nil {:prompt-tokens prompt :completion-tokens completion :total-tokens total
                        ;; 0 distinguishes "no cache hit" from "no usage provided"
                        :cached-prompt-tokens (or cached (when (some? prompt) 0))}))))))))

(defn- openai-chat-stream-counts [stream-text]
  (or (some openai-chat-line-counts (reverse (str/split stream-text #"\n"))) {}))

(defn- anthropic-stream-counts [stream-text]
  (let [{:keys [input output cached]}
        (reduce (fn [acc chunk]
                  (let [data-line (some #(when (str/starts-with? % "data: ") %) (str/split chunk #"\n"))
                        payload (when data-line (parse-json (subs data-line 6)))]
                    (if-not (map? payload)
                      acc
                      (case (get payload "type")
                        "message_start"
                        (let [usage (wire/as-map (get (wire/as-map (get payload "message")) "usage"))]
                          (if usage
                            (assoc acc
                                   :input (or (get-num usage "input_tokens") (:input acc))
                                   :cached (or (get-num usage "cache_read_input_tokens") (:cached acc)))
                            acc))
                        "message_delta"
                        (let [usage (wire/as-map (get payload "usage"))]
                          (if usage (assoc acc :output (or (get-num usage "output_tokens") (:output acc))) acc))
                        acc))))
                {} (str/split stream-text #"\n\n"))]
    (if (and (nil? input) (nil? output))
      {}
      (let [completion (or output 0)]
        (non-nil {:prompt-tokens input :completion-tokens completion
                  :total-tokens (+ (or input 0) completion)
                  :cached-prompt-tokens cached})))))

(defn- responses-stream-counts [stream-text routed-model now-ms]
  (try
    (let [counts (counts-from-completion (stream/event-stream->chat-completion stream-text routed-model now-ms))
          counts (if (and (some? (:prompt-tokens counts)) (nil? (:cached-prompt-tokens counts)))
                   (assoc counts :cached-prompt-tokens 0)
                   counts)
          terminal (stream/extract-terminal-response stream-text)]
      (with-image-count counts (when terminal (image-count-from-responses-payload terminal))))
    (catch #?(:cljs :default :clj Exception) _ {})))

(defn- ollama-line-counts [line]
  (let [trimmed (str/trim line)]
    (when (seq trimmed)
      (let [payload (parse-json trimmed)]
        (when (and (map? payload) (= true (get payload "done")))
          (let [prompt (get-num payload "prompt_eval_count")
                completion (get-num payload "eval_count")]
            (when (and (some? prompt) (some? completion))
              {:prompt-tokens prompt :completion-tokens completion
               :total-tokens (+ ^number prompt ^number completion)})))))))

(defn- ollama-stream-counts [stream-text]
  (or (some ollama-line-counts (reverse (str/split stream-text #"\n"))) {}))

(defn counts-from-sse-text
  "Usage out of a finished event stream. `{}` when the stream carries none, which is
  the expected path for providers that omit it; never throws."
  [stream-text mode routed-model now-ms]
  (try
    (cond
      (= "images" mode) (responses-stream-counts stream-text routed-model now-ms)
      (= "messages" mode) (anthropic-stream-counts stream-text)
      (contains? responses-modes mode) (responses-stream-counts stream-text routed-model now-ms)
      (= "gemini_chat" mode) (gemini-stream-counts stream-text)
      (contains? ollama-modes mode) (ollama-stream-counts stream-text)
      :else (openai-chat-stream-counts stream-text))
    (catch #?(:cljs :default :clj Exception) _ {})))

;; ---------------------------------------------------------------------------
;; The request-log patch
;; ---------------------------------------------------------------------------

(defn image-cost-usd
  "Per-image price: a provider override (by lower-cased trimmed id), else the default."
  [{:keys [by-provider default]} provider-id]
  (or (get by-provider (str/lower-case (str/trim provider-id))) default))

(defn- positive-finite [x] (when (and (some? (as-number x)) (pos? x)) x))

(defn usage-patch
  "The request-log update for finished usage extraction, or nil when the response
  carried nothing to record. Throughput is only meaningful for streams: decode
  time runs from the first content to completion, end-to-end from the attempt start."
  [counts {:keys [stream? completed-at first-content-at attempt-started-at image-cost]}]
  (let [image-count (as-number (:image-count counts))
        known? (or (any-token-count? counts) (some? image-count))]
    (when known?
      (let [decode-ms (if (some? first-content-at) (max 0 (- completed-at first-content-at)) 0)
            end-to-end-ms (max 0 (- completed-at attempt-started-at))
            completion (positive-finite (:completion-tokens counts))]
        (non-nil (merge counts
                        {:image-count image-count
                         :image-cost-usd (when (some? image-count) (* ^number image-count ^number image-cost))
                         :cache-hit (and (number? (:cached-prompt-tokens counts)) (pos? (:cached-prompt-tokens counts)))
                         :ttft-ms (when (some? first-content-at) (max 0 (- first-content-at attempt-started-at)))
                         :tps (when (and stream? completion (pos? decode-ms)) (/ ^number completion (/ decode-ms 1000)))
                         :end-to-end-tps (when (and stream? completion (pos? end-to-end-ms))
                                           (/ ^number completion (/ end-to-end-ms 1000)))}))))))
