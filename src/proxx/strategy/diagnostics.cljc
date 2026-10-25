(ns proxx.strategy.diagnostics
  "Privacy-preserving shape fingerprints of upstream request payloads.

  Factory rejects some requests with an opaque 4xx; to tell which request
  *shapes* it dislikes we log counts, flags and short hashes of the payload —
  never its text. The hash is injected (`sha256-hex`) so this stays pure; the
  digest of the text blocks is the SHA-256 of their normalised concatenation."
  (:require [clojure.string :as str]
            [proxx.compat.wire :as wire]
            [proxx.json :as json]))

(defn normalize-text
  "Collapse every whitespace run to one space and trim."
  [value]
  (str/trim (str/replace value #"\s+" " ")))

(defn short-hash
  "`sha256:<12 hex>` of the normalised text, nil for empty text."
  [sha256-hex value]
  (let [normalized (normalize-text value)]
    (when (seq normalized)
      (str "sha256:" (subs (sha256-hex normalized) 0 12)))))

(defn prompt-cache-key-hash
  "Short hash of the request's `prompt_cache_key` (or `promptCacheKey`), if any."
  [sha256-hex request-body]
  (let [raw (or (when (string? (get request-body "prompt_cache_key")) (get request-body "prompt_cache_key"))
                (when (string? (get request-body "promptCacheKey")) (get request-body "promptCacheKey")))]
    (when (and raw (seq raw)) (short-hash sha256-hex raw))))

(defn- request-shape-fingerprint [sha256-hex d]
  (short-hash sha256-hex
              (json/write
               (array-map
                "requestFormat" (:request-format d)
                "hasInstructions" (true? (:has-instructions d))
                "hasReasoning" (true? (:has-reasoning d))
                "hasSystemMessages" (pos? (:system-message-count d 0))
                "hasUserMessages" (pos? (:user-message-count d 0))
                "hasAssistantMessages" (pos? (:assistant-message-count d 0))
                "hasToolMessages" (pos? (:tool-message-count d 0))
                "hasFunctionCalls" (pos? (:function-call-count d 0))
                "hasFunctionCallOutputs" (pos? (:function-call-output-count d 0))
                "hasImageInputs" (pos? (:image-input-count d 0))))))

;; ---------------------------------------------------------------------------
;; Text accumulation
;; ---------------------------------------------------------------------------

(def ^:private empty-text
  {:blocks [] :total-chars 0 :max-block-chars 0 :image-inputs 0
   :reasoning? false :code-fence? false :xml-tags? false :opencode? false :agent-protocol? false})

(defn- add-text [acc value]
  (if-not (string? value)
    acc
    (let [normalized (normalize-text value)]
      (if (empty? normalized)
        acc
        (let [lowered (str/lower-case normalized)
              chars (count normalized)]
          (-> acc
              (update :blocks conj normalized)
              (update :total-chars + chars)
              (update :max-block-chars max chars)
              (update :code-fence? #(or % (str/includes? normalized "```")))
              (update :xml-tags? #(or % (boolean (re-find #"(?i)<[/]?[a-z][^>]{0,80}>" normalized))))
              (update :opencode? #(or % (str/includes? lowered "you are opencode") (str/includes? lowered "operation-mindfuck")))
              (update :agent-protocol?
                      #(or % (some (fn [marker] (str/includes? lowered marker))
                                   ["available_skills" "agents.md" "skill.md" "contract.edn" "skill-registry"])))))))))

(def ^:private reasoning-part-types
  #{"reasoning" "reasoning_content" "reasoning_details" "summary_text" "thinking"})

(defn- add-content [acc content]
  (cond
    (string? content) (add-text acc content)
    (sequential? content)
    (reduce (fn [acc part]
              (if-not (map? part)
                acc
                (let [part-type (str/lower-case (or (when (string? (get part "type")) (get part "type")) ""))
                      acc (cond-> acc
                            (or (str/includes? part-type "image")
                                (contains? part "image_url")
                                (contains? part "imageUrl"))
                            (update :image-inputs inc)
                            (contains? reasoning-part-types part-type)
                            (assoc :reasoning? true))]
                  (add-text acc (get part "text")))))
            acc content)
    :else acc))

(defn- has-reasoning-field?
  "Present, even as JSON null: a client that sends `reasoning_content: null` still
  sent the field."
  [item]
  (or (contains? item "reasoning") (contains? item "reasoning_content") (contains? item "reasoning_details")))

(defn- tool-call-count [item]
  (let [calls (get item "tool_calls")] (if (sequential? calls) (count calls) 0)))

(defn- inc-key [m k] (update m k (fnil inc 0)))

(defn- role-key [role]
  (case role
    "system" :system-message-count
    "user" :user-message-count
    "assistant" :assistant-message-count
    "tool" :tool-message-count
    nil))

(defn- fold-item
  "Fold one `input` (Responses) or `messages` (chat) entry into [diagnostics text]."
  [responses? [d text] item]
  (if-not (map? item)
    [d text]
    (let [role (when (string? (get item "role")) (get item "role"))
          d (cond-> d
              (and responses? (role-key role)) (-> (inc-key :message-count) (inc-key (role-key role)))
              (and (not responses?) (role-key role)) (inc-key (role-key role)))
          item-type (some-> (when (string? (get item "type")) (get item "type")) str/lower-case)
          d (cond-> d
              (and responses? (= "function_call" item-type)) (inc-key :function-call-count)
              (and responses? (= "function_call_output" item-type)) (inc-key :function-call-output-count))
          d (update d :function-call-count (fnil + 0) (tool-call-count item))
          text (cond-> text (has-reasoning-field? item) (assoc :reasoning? true))
          text (-> text
                   (add-text (get item "reasoning"))
                   (add-text (get item "reasoning_content"))
                   (add-content (get item "content")))
          text (if responses? (add-text text (get item "output")) text)]
      [d text])))

(defn build-factory-4xx-diagnostics
  "Shape summary of an upstream payload (Responses, chat or Messages format).
  Returns the diagnostics map with only the fields that have a value."
  [sha256-hex upstream-payload prompt-cache-key]
  (let [instructions (when (string? (get upstream-payload "instructions")) (get upstream-payload "instructions"))
        input (get upstream-payload "input")
        messages (get upstream-payload "messages")
        base {:request-format "unknown"
              :message-count 0 :input-item-count 0 :system-message-count 0 :user-message-count 0
              :assistant-message-count 0 :tool-message-count 0 :function-call-count 0
              :function-call-output-count 0 :image-input-count 0
              :has-instructions false :instructions-chars 0}
        [d text] [(cond-> base
                    (seq prompt-cache-key) (assoc :prompt-cache-key-hash (short-hash sha256-hex prompt-cache-key))
                    (some? instructions) (assoc :has-instructions true
                                                :instructions-chars (count (normalize-text instructions))
                                                :instructions-fingerprint (short-hash sha256-hex (normalize-text instructions))))
                  (cond-> empty-text (some? instructions) (add-text instructions))]
        [d text]
        (cond
          (sequential? input)
          (reduce (partial fold-item true)
                  [(assoc d :request-format "responses" :input-item-count (count input)) text]
                  input)

          (sequential? messages)
          (let [[d text] (reduce (partial fold-item false)
                                 [(assoc d :request-format (if (contains? upstream-payload "anthropic_version") "messages" "chat_completions")
                                           :message-count (count messages))
                                  text]
                                 messages)
                system (get upstream-payload "system")]
            (if (contains? upstream-payload "system")
              [(-> d (inc-key :system-message-count) (inc-key :message-count)) (add-content text system)]
              [d text]))

          :else [d text])
        d (assoc d
                 :image-input-count (:image-inputs text)
                 :total-text-chars (:total-chars text)
                 :max-text-block-chars (:max-block-chars text)
                 :has-reasoning (:reasoning? text)
                 :has-code-fence (:code-fence? text)
                 :has-xml-like-tags (:xml-tags? text)
                 :has-opencode-markers (:opencode? text)
                 :has-agent-protocol-markers (boolean (:agent-protocol? text)))
        d (cond-> d
            (pos? (:total-chars text))
            (assoc :text-fingerprint
                   (str "sha256:" (subs (sha256-hex (apply str (map #(str % "\n") (:blocks text)))) 0 12))))]
    (cond-> d
      (request-shape-fingerprint sha256-hex d)
      (assoc :shape-fingerprint (request-shape-fingerprint sha256-hex d)))))
