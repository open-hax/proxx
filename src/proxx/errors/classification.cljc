(ns proxx.errors.classification
  "Pure classification of upstream provider failures.

  Provider output is untrusted data. Every function here is a decision over
  already-parsed values (string-keyed maps, strings, nil); reading bodies off a
  `Response`, cloning, and JSON parsing live at the runtime edge.

  A verdict is computed from a `facts` map:
    {:status       int
     :content-type string | nil
     :payload      parsed JSON (string-keyed map), raw text, or nil}"
  (:require [clojure.string :as str]
            [proxx.sse :as sse]))

;; ---------------------------------------------------------------------------
;; Pattern tables (data)
;; ---------------------------------------------------------------------------

(def model-not-supported-patterns
  ["model is not supported"
   "model is not available"
   "not supported when using codex"
   "not supported with a chatgpt account"
   "not supported with chatgpt account"
   "model_not_supported_for_account"])

(def subscription-patterns
  ["requires a subscription"
   "subscription required"
   "upgrade for access"])

(def access-denied-patterns
  ["not allowed to call"
   "not allowed to use"
   "not allowed to access"
   "do not have access to"
   "does not have access to"
   "access to this model is restricted"
   "model access denied"
   "not available on your current plan"])

(def quota-patterns
  "Quota phrases. Separator variants (`_`, `-`, space) are equivalent, so the
  table lists each concept once and matching normalizes both sides."
  ["outstanding balance" "outstanding balence" "insufficient balance"
   "balance exhausted" "outstanding quota" "insufficient quota"
   "quota exceeded" "credits exhausted" "credit exhausted"
   "insufficient credits" "payment required" "monthly limit"])

;; ---------------------------------------------------------------------------
;; Text helpers
;; ---------------------------------------------------------------------------

(defn- non-blank [x]
  (when (and (string? x) (not (str/blank? x))) x))

(defn- normalize-separators [s]
  (-> s str/lower-case (str/replace #"[\s_-]+" " ")))

(defn- includes-any? [haystack needles]
  (boolean (some #(str/includes? haystack %) needles)))

(defn truncate-for-log
  "Collapse whitespace and cap at `max-length` chars, ending with an ellipsis."
  ([value] (truncate-for-log value 240))
  ([value max-length]
   (let [compact (-> value (str/replace #"\s+" " ") str/trim)]
     (if (<= (count compact) max-length)
       compact
       (str (subs compact 0 (max 0 (dec max-length))) "…")))))

;; ---------------------------------------------------------------------------
;; Payload inspection
;; ---------------------------------------------------------------------------

(defn extract-error-message
  "First meaningful message in a payload: the text itself, `message`,
  `error` (string), or `error.{message,error,code}`."
  [payload]
  (cond
    (string? payload) payload
    (map? payload)
    (let [err (get payload "error")]
      (or (non-blank (get payload "message"))
          (when (string? err) err)
          (when (map? err)
            (some #(non-blank (get err %)) ["message" "error" "code"]))))))

(defn error-like-payload?
  "True when a payload declares itself an error: an `error` key, or a
  type/event/object whose value mentions \"error\"."
  [payload]
  (and (map? payload)
       (or (some? (get payload "error"))
           (boolean
            (some (fn [k]
                    (some-> (non-blank (get payload k))
                            str/lower-case
                            (str/includes? "error")))
                  ["type" "event" "object"])))))

(defn quota-message? [message]
  (let [lowered (str/lower-case message)
        normalized (normalize-separators message)]
    (boolean
     (some (fn [pattern]
             (or (str/includes? lowered pattern)
                 (str/includes? normalized (normalize-separators pattern))))
           quota-patterns))))

;; ---------------------------------------------------------------------------
;; Verdicts over facts
;; ---------------------------------------------------------------------------

(defn- success? [status] (<= 200 status 299))

(defn quota-body-needed?
  "Only a response that can plausibly carry a JSON error body is worth reading.
  Statuses with a fixed verdict, event streams, and header-less responses
  (likely SSE from Codex backends) are decided from the head alone, so the
  caller never clones them."
  [{:keys [status content-type]}]
  (not (or (= 402 status)
           (contains? #{429 403 503} status)
           (str/blank? (or content-type ""))
           (str/includes? (str/lower-case content-type) "text/event-stream"))))

(defn quota-error?
  "Does this upstream response mean the account is out of quota/credit?
  Without a `:payload`, only head-decidable verdicts can be true."
  [{:keys [status payload] :as facts}]
  (cond
    (= 402 status)                    true
    (not (quota-body-needed? facts))  false
    :else
    (let [error-like? (error-like-payload? payload)]
      (cond
        (and (success? status) (not error-like?)) false
        :else (if-let [message (extract-error-message payload)]
                (quota-message? message)
                (and error-like? (quota-message? (pr-str payload))))))))

(defn missing-model?
  "Does a 400/404/422 say the requested model does not exist?"
  [{:keys [status payload]} requested-model]
  (boolean
   (when (#{400 404 422} status)
     (when-let [lowered (some-> (extract-error-message payload) str/lower-case)]
       (let [wanted (str/lower-case (str/trim (or requested-model "")))]
         (and (str/includes? lowered "model")
              (str/includes? lowered "not found")
              (or (str/blank? wanted)
                  (str/includes? lowered wanted)
                  (str/includes? lowered "model_not_found"))))))))

(defn model-not-supported-for-account?
  "Does a 400/403/422 say this account may not use the requested model?"
  [{:keys [status payload]} requested-model]
  (boolean
   (when (#{400 403 422} status)
     (when-let [lowered (some-> (extract-error-message payload) str/lower-case)]
       (let [wanted (str/lower-case (str/trim (or requested-model "")))]
         (or (includes-any? lowered subscription-patterns)
             (and (or (includes-any? lowered access-denied-patterns)
                      (includes-any? lowered model-not-supported-patterns))
                  (or (str/blank? wanted)
                      (str/includes? lowered wanted)
                      (str/includes? lowered "chatgpt")
                      (str/includes? lowered "account")))))))))

(defn summarize-upstream-error
  "Compact, log-safe summary of a parsed upstream error payload."
  [payload]
  (cond
    (and (string? payload) (seq payload))
    {:upstream-error-message (truncate-for-log payload)}

    (map? payload)
    (let [err (when (map? (get payload "error")) (get payload "error"))
          pick (fn [k] (or (non-blank (get err k)) (non-blank (get payload k))))
          code (pick "code")
          etype (pick "type")
          message (extract-error-message payload)]
      (cond-> {}
        code    (assoc :upstream-error-code (truncate-for-log code 80))
        etype   (assoc :upstream-error-type (truncate-for-log etype 80))
        message (assoc :upstream-error-message (truncate-for-log message))))

    :else {}))

;; ---------------------------------------------------------------------------
;; Event streams
;; ---------------------------------------------------------------------------

(defn- quota-event?
  "Unparseable events are judged as raw text; parsed ones must declare
  themselves errors first."
  [{:keys [data parsed malformed?]}]
  (if malformed?
    (quota-message? data)
    (and (error-like-payload? parsed)
         (or (some-> (extract-error-message parsed) quota-message?)
             (quota-message? data)))))

(defn stream-quota-error?
  "Does any event in an SSE body report a quota failure?"
  [parse-json body]
  (boolean (some quota-event? (sse/events parse-json body))))
