(ns proxx.http.request-facts
  "Facts read off an OpenAI-style request, as pure functions over wire data
  (string-keyed maps): the prompt cache key and its log-safe hash, the shape of
  a Responses body for the logs, CSV header merging and the interleaved-thinking
  check. The digest is injected (`sha256-hex`), so nothing here touches the host."
  (:require [clojure.string :as str]))

(defn prompt-cache-key
  "The trimmed, non-empty `prompt_cache_key` (else `promptCacheKey`) of a body.
  The snake_case field wins whenever it is a string, even an empty one."
  [body]
  (let [raw (let [snake (get body "prompt_cache_key")
                  camel (get body "promptCacheKey")]
              (cond (string? snake) snake
                    (string? camel) camel))
        trimmed (some-> raw str/trim)]
    (when (seq trimmed) trimmed)))

(defn hash-prompt-cache-key
  "A key that is safe to log: `sha256:` plus the first 12 hex digits of the
  digest of the trimmed key, or `<REDACTED>` when nothing is left of it."
  [sha256-hex key]
  (let [trimmed (str/trim key)]
    (if (empty? trimmed)
      "<REDACTED>"
      (str "sha256:" (subs (sha256-hex trimmed) 0 12)))))

(defn- csv-tokens [header]
  (into [] (comp (map str/trim) (remove empty?)) (str/split header #",")))

(defn csv-header-with
  "The value a CSV-style header should hold once `value` is part of it: `value`
  itself when the header is empty, the header with `value` appended when it is
  missing, and nil when the header already lists it (nothing to set)."
  [existing value]
  (cond (empty? existing) value
        (some #{value} (csv-tokens existing)) nil
        :else (str existing ", " value)))

(defn interleaved-thinking?
  "Does the upstream payload ask for extended thinking (`thinking.type` is
  \"enabled\")?"
  [payload]
  (let [thinking (get payload "thinking")]
    (and (map? thinking) (= "enabled" (get thinking "type")))))

;; ---------------------------------------------------------------------------
;; Responses request summary
;; ---------------------------------------------------------------------------

(defn- js-typeof [x]
  (cond (string? x) "string"
        (number? x) "number"
        (boolean? x) "boolean"
        (nil? x) "undefined"
        :else "object"))

(defn- image-part? [part]
  (let [t (get part "type")]
    (boolean (or (and (string? t) (str/includes? (str/lower-case t) "image"))
                 (contains? part "image_url")
                 (contains? part "imageUrl")))))

(defn- part-chars [part]
  (let [text (get part "text")] (if (and (string? text) (seq text)) (count text) 0)))

(defn- summarize-item
  "`[text-chars image-count]` of one `input` item: a string `content`, or the
  `text` and image parts of an array `content`. Anything else adds nothing."
  [item]
  (let [content (when (map? item) (get item "content"))]
    (cond
      (string? content) [(count content) 0]
      (sequential? content)
      (reduce (fn [[chars images] part]
                (if (map? part)
                  [(+ chars (part-chars part)) (+ images (if (image-part? part) 1 0))]
                  [chars images]))
              [0 0]
              content)
      :else [0 0])))

(defn- finite-number? [x]
  (and (number? x)
       #?(:cljs (js/Number.isFinite x)
          :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x)))))))

(defn summarize-responses-request
  "A log-safe summary of a Responses API body: model, stream flag and output cap
  when well-formed, and the size of `input` (never its text)."
  [body]
  (let [model (get body "model")
        stream (get body "stream")
        cap (get body "max_output_tokens")
        input (get body "input")
        base (cond-> {}
               (and (string? model) (seq (str/trim model))) (assoc "model" model)
               (boolean? stream) (assoc "stream" stream)
               (finite-number? cap) (assoc "max_output_tokens" cap))]
    (assoc base "input"
           (cond
             (string? input) {"kind" "text" "length" (count input)}
             (sequential? input)
             (let [[chars images] (reduce (fn [[c i] item]
                                            (let [[c' i'] (summarize-item item)] [(+ c c') (+ i i')]))
                                          [0 0] input)]
               {"kind" "structured" "itemCount" (count input) "textChars" chars "imageCount" images})
             ;; `null` is an object to JavaScript; only an absent field is undefined.
             (and (nil? input) (contains? body "input")) {"kind" "object"}
             :else {"kind" (js-typeof input)}))))
