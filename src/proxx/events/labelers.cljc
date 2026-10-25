(ns proxx.events.labelers
  "Event labelling as pure functions over event facts.

  An event is a string-keyed wire map (\"kind\" \"status\" \"providerId\" \"meta\"
  \"payload\" ...); undefined fields are absent, `null` is nil. Each labeler is
  an `applies?` predicate plus a `label` function returning tags; the registry
  at the bottom is data keyed by labeler id."
  (:require [clojure.string :as str]))

(defn- obj? [v] (map? v))
(defn- non-empty? [s] (and (string? s) (pos? (count s))))
(defn- str-or [v default] (if (string? v) v default))
(defn- has? [s sub] (str/includes? s sub))
(defn- when-tag [pred tag] (when pred [tag]))

;; ---------------------------------------------------------------------------
;; error_classifier

(defn- payload-labeler
  "Labelers over a payload record yield no tags for any other payload."
  [f]
  (fn [event] (if (obj? (get event "payload")) (f event) [])))

(defn- error-applies? [{:strs [kind status]}]
  (or (= kind "error") (and (number? status) (>= status 400))))

(def ^:private status-tags
  {401 "auth_expired" 402 "payment_required" 403 "forbidden" 429 "rate_limited" 400 "bad_request"})

(defn- message-tags [message]
  (concat
   (when-tag (and (has? message "content") (or (has? message "filter") (has? message "policy"))) "content_filter")
   (when-tag (and (has? message "token") (has? message "expired")) "token_expired")
   (when-tag (or (has? message "usage limit") (has? message "rate limit") (has? message "quota")) "quota_exceeded")
   (when-tag (and (has? message "model") (or (has? message "not found") (has? message "not available") (has? message "does not")))
             "model_unavailable")
   (when-tag (or (has? message "outstanding_balance") (has? message "billing")) "billing_issue")
   (when-tag (or (has? message "timeout") (has? message "timed out")) "timeout")))

(defn- error-label [{:strs [status payload providerId]}]
  (let [status-tag (when (number? status) (status-tags status))
        payload-tags (when (obj? payload)
                       (let [error (if (obj? (get payload "error")) (get payload "error") payload)
                             lower #(str/lower-case (str-or (get error %) ""))
                             code (lower "code")
                             type (lower "type")]
                         (concat (message-tags (lower "message"))
                                 (when-tag (or (has? code "content_filter") (has? type "content_filter")) "content_filter"))))]
    (vec (distinct (concat (when status-tag [status-tag])
                           (when (and (number? status) (>= status 500)) ["server_error"])
                           payload-tags
                           (when (and (some? providerId) (not (false? providerId)) (not= providerId "") (not= providerId 0))
                             [(str "provider:" providerId)]))))))

;; ---------------------------------------------------------------------------
;; tool_use

(defn- request-with-record-payload? [{:strs [kind payload]}]
  (and (= kind "request") (obj? payload)))

(defn- tool-label [{:strs [payload]}]
  (let [tools (get payload "tools")
        choice-present? (contains? payload "tool_choice")
        choice (get payload "tool_choice")]
    (vec (concat
          (when (and (sequential? tools) (seq tools))
            (concat ["has_tools" (str "tool_count:" (count tools))]
                    (for [tool tools
                          :when (obj? tool)
                          :let [f (if (obj? (get tool "function")) (get tool "function") tool)
                                name (get f "name")]
                          :when (non-empty? name)]
                      (str "tool:" name))))
          (when (and choice-present? (not= choice "auto") (not= choice "none"))
            ["forced_tool_choice"])))))

;; ---------------------------------------------------------------------------
;; content_pattern

(defn- items-of [payload]
  (concat (let [m (get payload "messages")] (if (sequential? m) m []))
          (let [i (get payload "input")] (if (sequential? i) i []))))

(defn extract-all-text [payload]
  (vec (concat
        (let [i (get payload "instructions")] (when (string? i) [i]))
        (mapcat (fn [item]
                  (when (obj? item)
                    (let [content (get item "content")]
                      (cond (string? content) [content]
                            (sequential? content) (for [part content
                                                        :when (and (obj? part) (string? (get part "text")))]
                                                    (get part "text"))))))
                (items-of payload)))))

(def ^:private code-fence #"```[\s\S]*?```")
(def ^:private xml-tag #"</?[a-zA-Z][a-zA-Z0-9_-]*[\s>]")
(def ^:private injection-marker #"\[SYSTEM\]|\[INST\]|<\|im_start\|>|<\|system\|>")
(def ^:private agent-marker (re-pattern "(?i)opencode|agent-shell|promethean"))

(defn- image-part? [part]
  (and (obj? part)
       (or (has? (str-or (get part "type") "") "image")
           (contains? part "image_url"))))

(defn- content-label [{:strs [payload]}]
  (let [texts (extract-all-text payload)]
    (if (empty? texts)
      []
      (let [joined (str/join "\n" texts)
            records (filter obj? (items-of payload))
            message-count (count records)
            total (count joined)]
        (vec (concat
              (when-tag (re-find code-fence joined) "has_code_fence")
              (when-tag (re-find xml-tag joined) "has_xml_tags")
              (when-tag (re-find injection-marker joined) "has_prompt_injection_markers")
              (when-tag (re-find agent-marker joined) "has_agent_markers")
              (when-tag (some #(= "system" (str-or (get % "role") "")) records) "has_system_prompt")
              (when-tag (some (fn [item] (let [c (get item "content")] (and (sequential? c) (some image-part? c)))) records)
                        "has_image_input")
              (when-tag (> message-count 20) "long_conversation")
              (when-tag (> message-count 100) "very_long_conversation")
              (when-tag (> total 50000) "large_payload")
              (when-tag (> total 200000) "very_large_payload")))))))

;; ---------------------------------------------------------------------------
;; response_quality

(defn- num-or-zero [v] (if (number? v) v 0))

(defn- quality-label [{:strs [payload status]}]
  (let [choice-tags (for [choice (let [c (get payload "choices")] (if (sequential? c) c []))
                          :when (obj? choice)
                          tag (case (str-or (get choice "finish_reason") "")
                                "tool_calls" ["tool_call_response"]
                                "length" ["truncated_response"]
                                "content_filter" ["content_filter_response"]
                                [])]
                      tag)
        usage (when (obj? (get payload "usage")) (get payload "usage"))
        usage-tags (when usage
                     (let [cached (num-or-zero (get usage "cached_tokens"))
                           prompt (num-or-zero (get usage "prompt_tokens"))
                           completion (num-or-zero (get usage "completion_tokens"))
                           reasoning (num-or-zero (get usage "reasoning_tokens"))]
                       (concat (when-tag (and (pos? cached) (pos? prompt) (> (/ cached prompt) 0.5)) "cache_heavy")
                               (when-tag (and (pos? reasoning) (pos? completion) (> (/ reasoning completion) 0.5)) "reasoning_heavy"))))]
    (vec (concat choice-tags usage-tags (when-tag (= status 200) "success")))))

;; ---------------------------------------------------------------------------
;; cost_tier

(defn- cost-label [{:strs [meta]}]
  (let [cost (num-or-zero (get meta "costUsd"))]
    [(cond (> cost 1.0) "very_high_cost"
           (> cost 0.10) "high_cost"
           (> cost 0.01) "medium_cost"
           :else "low_cost")]))

;; ---------------------------------------------------------------------------
;; Registry

(def labelers
  "Default labelers in registration order."
  [{:id "error_classifier" :applies? error-applies? :label error-label}
   {:id "tool_use" :applies? request-with-record-payload? :label (payload-labeler tool-label)}
   {:id "content_pattern" :applies? request-with-record-payload? :label (payload-labeler content-label)}
   {:id "response_quality" :applies? (fn [{:strs [kind payload]}] (and (= kind "response") (obj? payload))) :label (payload-labeler quality-label)}
   {:id "cost_tier" :applies? (fn [{:strs [kind meta]}] (and (= kind "metric") (obj? meta))) :label cost-label}])

(def ^:private by-id (into {} (map (juxt :id identity)) labelers))

(defn applies? [id event] (boolean ((:applies? (by-id id)) event)))
(defn label [id event] ((:label (by-id id)) event))
