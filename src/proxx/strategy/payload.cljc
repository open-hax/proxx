(ns proxx.strategy.payload
  "Pure shaping of upstream request payloads shared by every provider strategy:
  service-tier selection, trailing-prefill stripping, stream-usage opt-in, the
  image-generation bridge to the Responses API, and what a logged attempt records
  about its caller. Payloads and request context are string-keyed data; header maps
  are as Node delivers them (lower-case names, string or string-array values)."
  (:require [clojure.string :as str]
            [proxx.compat.wire :as wire]))

(defn- as-string [x] (when (string? x) x))

(defn- as-boolean [x] (when (boolean? x) x))

(defn- trimmed [x] (some-> (as-string x) str/trim))

(defn- non-blank [x] (let [t (trimmed x)] (when (seq t) t)))

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
;; Headers and service tier
;; ---------------------------------------------------------------------------

(defn header-value
  "A request header as one string (arrays joined with `, `), or nil."
  [headers name]
  (let [value (when (map? headers) (get headers (str/lower-case name)))]
    (cond (sequential? value) (str/join ", " value)
          (string? value) value)))

(defn parse-boolean-header [value]
  (when (seq value)
    (let [normalized (str/lower-case (str/trim value))]
      (cond (contains? #{"1" "true" "yes" "on"} normalized) true
            (contains? #{"0" "false" "no" "off"} normalized) false))))

(defn- open-hax [request-body] (wire/as-map (get request-body "open_hax")))

(defn explicit-service-tier-request?
  "Did the client name a service tier outright (body or header), as opposed to
  asking for fast mode?"
  [request-body headers]
  (let [open-hax (open-hax request-body)]
    (boolean (or (non-blank (get request-body "service_tier"))
                 (non-blank (get open-hax "service_tier"))
                 (non-blank (get open-hax "serviceTier"))
                 (non-blank (header-value headers "x-open-hax-service-tier"))))))

(defn- fast-mode-value [request-body headers]
  (let [open-hax (open-hax request-body)]
    (reduce (fn [_ v] (when (some? v) (reduced v))) nil
            [(as-boolean (get open-hax "fast_mode"))
             (as-boolean (get open-hax "fastMode"))
             (parse-boolean-header (header-value headers "x-open-hax-fast-mode"))])))

(defn requested-fast-mode? [request-body headers]
  (boolean (fast-mode-value request-body headers)))

(defn requested-service-tier
  "The tier the client asked for: an explicit `open_hax` field, else the header,
  else `priority` when fast mode is on. Blank values name nothing."
  [request-body headers]
  (let [open-hax (open-hax request-body)]
    (or (non-blank (get open-hax "service_tier"))
        (non-blank (get open-hax "serviceTier"))
        (non-blank (header-value headers "x-open-hax-service-tier"))
        (when (fast-mode-value request-body headers) "priority"))))

(defn apply-requested-service-tier
  "`payload` with the requested service tier, unless it already carries one."
  [payload request-body headers]
  (if (contains? payload "service_tier")
    payload
    (if-let [tier (requested-service-tier request-body headers)]
      (assoc payload "service_tier" tier)
      payload)))

(defn logged-service-tier
  "`{:service-tier :service-tier-source}` recorded for a built payload. Without a
  request context a tier is always `explicit`; `fast_mode` only when fast mode,
  not a named tier, produced `priority`."
  [payload request-context]
  (if-let [tier (trimmed (get payload "service_tier"))]
    (if (empty? tier)
      {:service-tier-source "none"}
      {:service-tier tier
       :service-tier-source
       (if (and request-context
                (not (explicit-service-tier-request? (:request-body request-context) (:headers request-context)))
                (requested-fast-mode? (:request-body request-context) (:headers request-context))
                (= "priority" tier))
         "fast_mode"
         "explicit")})
    {:service-tier-source "none"}))

;; ---------------------------------------------------------------------------
;; Payload adjustments
;; ---------------------------------------------------------------------------

(defn strip-trailing-assistant-prefill
  "Drop assistant items at the end of a Responses `input`: providers reject a
  conversation that ends on an assistant turn."
  [payload]
  (let [input (get payload "input")]
    (if (and (sequential? input) (seq input))
      (let [kept (->> (vec input)
                      rseq
                      (drop-while #(and (map? %) (= "assistant" (get % "role"))))
                      reverse
                      vec)]
        (if (< (count kept) (count input)) (assoc payload "input" kept) payload))
      payload)))

(defn ensure-usage-in-stream
  "Ask streamed chat completions to report usage, without overriding the client."
  [payload]
  (if-not (= true (get payload "stream"))
    payload
    (let [existing (get payload "stream_options")]
      (cond
        (not (map? existing)) (assoc payload "stream_options" {"include_usage" true})
        (contains? existing "include_usage") payload
        :else (assoc payload "stream_options" (assoc existing "include_usage" true))))))

(defn prepare-upstream-body
  "The request body to translate for an upstream: the routed model replaces the
  client's when they differ, and the proxy-only `open_hax` extension is removed."
  [request-body routed-model requested-model]
  (cond-> (dissoc request-body "open_hax")
    (not= routed-model requested-model) (assoc "model" routed-model)))

(defn with-model
  "`payload` addressed to `model`, or unchanged when it has no model or already uses it."
  [payload model]
  (let [current (get payload "model")]
    (if (or (not (string? current)) (empty? current) (empty? model) (= current model))
      payload
      (assoc payload "model" model))))

(defn requesty-model
  "Requesty addresses models as `provider/model`."
  [model prefix]
  (if (and (seq model) (not (str/includes? model "/")))
    (str prefix "/" model)
    model))

;; ---------------------------------------------------------------------------
;; Image generation through the Codex Responses backend
;; ---------------------------------------------------------------------------

(def codex-images-model "gpt-5.4-mini")

(defn codex-responses-images-body
  "The Responses request that asks the image_generation tool to satisfy an Images
  API request: it needs a text model that has the tool, and must always call it."
  [images-body]
  (let [tool (reduce (fn [tool [from to]]
                       (let [v (get images-body from)]
                         (if (and (string? v) (seq v)) (assoc tool to v) tool)))
                     {"type" "image_generation"}
                     [["size" "size"] ["quality" "quality"] ["background" "background"] ["output_format" "output_format"]])]
    {"model" codex-images-model
     "input" (if (string? (get images-body "prompt")) (get images-body "prompt") "")
     "instructions" ""
     "tools" [tool]
     "tool_choice" "required"
     "store" false
     "stream" true}))

(defn images-from-responses-output
  "An Images API response from the `image_generation_call` items of a Responses
  object, or nil when there are none with a result."
  [response now-ms]
  (let [output (let [o (get response "output")] (if (sequential? o) o []))
        images (into []
                     (keep (fn [item]
                             (when (and (map? item) (= "image_generation_call" (get item "type")))
                               (let [result (if (string? (get item "result")) (get item "result") "")
                                     revised (as-string (get item "revised_prompt"))]
                                 (when (seq result)
                                   (cond-> {"b64_json" result} (seq revised) (assoc "revised_prompt" revised)))))))
                     output)]
    (when (seq images)
      {"created" (wire/now-seconds now-ms) "data" images "background" "opaque"})))

(defn images-from-codex-response
  "Images from a non-streamed Codex response body (possibly an SSE `response.completed` wrapper)."
  [response now-ms]
  (when (map? response)
    (images-from-responses-output
     (if (and (= "response.completed" (get response "type")) (map? (get response "response")))
       (get response "response")
       response)
     now-ms)))

;; ---------------------------------------------------------------------------
;; What a logged attempt says about its caller
;; ---------------------------------------------------------------------------

(defn usage-attribution
  "`{:tenant-id :issuer :key-id}` from the resolved request auth (`{:kind :tenant-id
  :key-id :subject}`). Local-origin auth kinds are attributed to `local`."
  [auth]
  (if-not (map? auth)
    {}
    {:tenant-id (:tenant-id auth)
     :issuer (if (contains? #{"legacy_admin" "tenant_api_key" "ui_session"} (:kind auth)) "local" (:subject auth))
     :key-id (:key-id auth)}))
