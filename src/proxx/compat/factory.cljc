(ns proxx.compat.factory
  "Pure Factory.ai wire compatibility.

  Every Factory fact (which model uses which endpoint, required headers, the
  rejected-prompt substitution) is declared in 75-provider-wire-profiles.edn and
  passed in as `profile`; this namespace only interprets it. Per-request random
  ids are inputs, not generated here."
  (:require [clojure.string :as str]
            [proxx.compat.wire :as wire]))

(def profile wire/profile)

(def route wire/route)

(defn model-type [profile model] (:wire/model-type (route profile model)))

(def api-provider wire/api-provider)

(defn endpoint-path
  "Endpoint of the first route serving `model-type`."
  [profile model-type]
  (some #(when (= model-type (:wire/model-type %)) (:wire/endpoint-path %)) (:wire/model-routes profile)))

(defn common-headers
  "Headers for every Factory request. `ids` supplies :session-id and :message-id."
  [profile model {:keys [session-id message-id]}]
  (merge (:wire/static-headers profile)
         {"x-api-provider" (api-provider profile model)
          "x-session-id" session-id
          "x-assistant-message-id" message-id}))

(defn- thinking-enabled? [payload]
  (let [thinking (get payload "thinking")]
    (and (map? thinking) (= "enabled" (get thinking "type")))))

(defn anthropic-headers
  "Common headers plus the Anthropic Messages set; the thinking beta header is
  added only when the payload enables thinking and a beta value is given."
  [profile model payload interleaved-thinking-beta ids]
  (cond-> (merge (common-headers profile model ids) (:wire/anthropic-headers profile))
    (and (string? interleaved-thinking-beta) (seq interleaved-thinking-beta) (thinking-enabled? payload))
    (assoc "anthropic-beta" interleaved-thinking-beta)))

(defn fk-key?
  "Is this credential a Factory static key (`api_key` auth with the profile's prefix)?"
  [profile credential]
  (and (= "api_key" (get credential "authType"))
       (when-let [prefix (:wire/static-key-prefix profile)]
         (let [token (get credential "token")]
           (and (string? token) (str/starts-with? token prefix))))))

(defn sanitize-system-prompt
  "Apply the first matching prompt rewrite (case-insensitive substring), else return the text."
  [profile system-text]
  (let [lowered (str/lower-case system-text)]
    (or (some #(when (str/includes? lowered (:match/system-contains %)) (:wire/replace-with %))
              (:wire/prompt-rewrites profile))
        system-text)))

;; ---------------------------------------------------------------------------
;; System prompt inlining
;; ---------------------------------------------------------------------------

(defn- system-text [system]
  (cond
    (string? system) system
    (sequential? system)
    (->> system
         (keep (fn [part]
                 (cond (string? part) part
                       (and (map? part) (= "text" (get part "type"))) (get part "text"))))
         (filter #(and (string? %) (seq %)))
         (str/join "\n"))
    :else ""))

(defn- merge-into-user [message text]
  (let [content (get message "content")]
    (assoc message "content"
           (cond (string? content) (str text "\n\n" content)
                 (sequential? content) (into [{"type" "text" "text" text}] content)
                 :else text))))

(defn inline-system-prompt
  "Fold `system` into the first user message (prepended), or into a new leading
  user message when there is none. Factory answers 403 to `system` with fk- keys."
  [payload]
  (let [system (get payload "system")]
    (if (nil? system)
      payload
      (let [text (system-text system)
            payload' (dissoc payload "system")]
        (if (empty? text)
          payload'
          (let [messages (let [m (get payload "messages")] (if (sequential? m) (vec m) []))
                idx (first (keep-indexed #(when (and (map? %2) (= "user" (get %2 "role"))) %1) messages))]
            (assoc payload' "messages"
                   (cond idx (update messages idx merge-into-user text)
                         (seq messages) (into [{"role" "user" "content" text}] messages)
                         :else messages))))))))
