(ns proxx.session.store
  "Chat sessions as an immutable value.

  The database is `{:sessions [session ...]}`; every operation is a function
  from a db (plus an `env` carrying the clock and id source) to
  `[result db']`. Reading the file, writing it back and serialising mutations
  are effects for `proxx.runtime.session`.

    session {:id :title :created-at :updated-at :prompt-cache-key
             :forked-from-session-id? :forked-from-message-id? :messages [message ...]}
    message {:id :role :content :reasoning-content? :model? :created-at}
    env     {:now (fn [] ms) :uuid (fn [] string)}

  `env` functions are the only sources of time and identity; given the same
  env behaviour the same operations always yield the same db."
  (:require [clojure.string :as str]))

(def empty-db {:sessions []})

(def ^:private roles #{"system" "user" "assistant" "tool"})

(defn normalize-title [input]
  (let [trimmed (if (string? input) (str/trim input) "")]
    (if (pos? (count trimmed)) trimmed "New chat")))

(defn- derive-prompt-cache-key [seed env]
  (let [normalized (when (string? seed) (str/trim seed))]
    (if (seq normalized) normalized ((:uuid env)))))

(defn summarize-message
  "Collapse whitespace; clip to 120 UTF-16 units with an ellipsis."
  [content]
  (let [normalized (str/trim (str/replace content #"\s+" " "))]
    (cond
      (zero? (count normalized)) ""
      (> (count normalized) 120) (str (subs normalized 0 117) "...")
      :else normalized)))

(defn- finite-number? [v]
  (and (number? v) #?(:cljs (js/Number.isFinite v) :clj (and (not (Double/isNaN v)) (not (Double/isInfinite v))))))

(defn- to-number [v fallback] (if (finite-number? v) v fallback))

(defn- to-role [v] (if (roles v) v "user"))

(defn- non-empty-string [v] (when (and (string? v) (pos? (count v))) v))

(defn- hydrate-message [m created-at env]
  (when (map? m)
    (cond-> {:id (or (non-empty-string (get m "id")) ((:uuid env)))
             :role (to-role (get m "role"))
             :content (if (string? (get m "content")) (get m "content") "")
             :created-at (to-number (get m "createdAt") created-at)}
      (string? (get m "reasoningContent")) (assoc :reasoning-content (get m "reasoningContent"))
      (string? (get m "model")) (assoc :model (get m "model")))))

(defn- hydrate-session [entry env]
  (when (map? entry)
    ;; Evaluation order mirrors the persisted contract: id, then clock,
    ;; then title, then the cache key, then message ids.
    (let [id (or (non-empty-string (get entry "id")) ((:uuid env)))
          created-at (to-number (get entry "createdAt") ((:now env)))
          updated-at (to-number (get entry "updatedAt") created-at)
          title (normalize-title (get entry "title"))
          cache-key (derive-prompt-cache-key
                     (cond (string? (get entry "promptCacheKey")) (get entry "promptCacheKey")
                           (string? (get entry "prompt_cache_key")) (get entry "prompt_cache_key"))
                     env)
          messages (if (sequential? (get entry "messages"))
                     (into [] (keep #(hydrate-message % created-at env)) (get entry "messages"))
                     [])]
      (cond-> {:id id :title title :created-at created-at :updated-at updated-at
               :prompt-cache-key cache-key :messages messages}
        (string? (get entry "forkedFromSessionId")) (assoc :forked-from-session-id (get entry "forkedFromSessionId"))
        (string? (get entry "forkedFromMessageId")) (assoc :forked-from-message-id (get entry "forkedFromMessageId"))))))

(defn hydrate
  "Persisted wire data (string-keyed) -> db. Anything unusable becomes empty."
  [raw env]
  (if (and (map? raw) (sequential? (get raw "sessions")))
    {:sessions (into [] (keep #(hydrate-session % env)) (get raw "sessions"))}
    empty-db))

;; ---------------------------------------------------------------------------
;; Reads

(defn list-items
  "Sessions as list entries, most recently updated first (stable)."
  [db]
  (->> (:sessions db)
       (map (fn [s]
              (let [last-message (peek (:messages s))]
                (cond-> {:id (:id s) :title (:title s) :created-at (:created-at s)
                         :updated-at (:updated-at s) :prompt-cache-key (:prompt-cache-key s)
                         :message-count (count (:messages s))
                         :last-message-preview (summarize-message
                                                (or (:content last-message) (:reasoning-content last-message) ""))}
                  (:forked-from-session-id s) (assoc :forked-from-session-id (:forked-from-session-id s))
                  (:forked-from-message-id s) (assoc :forked-from-message-id (:forked-from-message-id s))))))
       (sort-by :updated-at #(compare %2 %1))
       vec))

(defn find-session [db session-id]
  (some #(when (= (:id %) session-id) %) (:sessions db)))

(defn search-documents
  "One document per non-blank message."
  [db]
  (vec (for [s (:sessions db)
             m (:messages s)
             :when (pos? (count (str/trim (:content m))))]
         {:session-id (:id s) :session-title (:title s) :message-id (:id m)
          :role (:role m) :content (:content m) :created-at (:created-at m)})))

(defn- clamp-limit
  "JS `slice(0, Math.max(1, Math.min(limit, 50)))` count: truncation, NaN -> 0."
  [limit]
  (let [n (max 1 (min limit 50))]
    (if (not= n n) 0 (long n))))

(defn blank-query?
  "A blank query matches nothing, so the edge need not read the db to know."
  [query]
  (zero? (count (str/trim query))))

(defn search-lexical
  "Substring search over title+content; earlier hits first, then newer."
  [db query limit]
  (let [needle (str/lower-case (str/trim query))]
    (if (zero? (count needle))
      []
      (->> (search-documents db)
           (keep (fn [d]
                   (let [hay (str/lower-case (str (:session-title d) "\n" (:content d)))
                         idx (str/index-of hay needle)]
                     (when idx {:document d :score idx}))))
           (sort-by identity (fn [a b] (if (= (:score a) (:score b))
                                         (compare (:created-at (:document b)) (:created-at (:document a)))
                                         (compare (:score a) (:score b)))))
           (take (clamp-limit limit))
           (mapv :document)))))

;; ---------------------------------------------------------------------------
;; Transitions: each returns [result db']

(defn- not-found [message]
  (ex-info message {:error/type ::not-found}))

(defn create-session [db title env]
  (let [now ((:now env))
        session {:id ((:uuid env)) :title (normalize-title title) :created-at now :updated-at now
                 :prompt-cache-key ((:uuid env)) :messages []}]
    [session (update db :sessions conj session)]))

(defn- replace-session
  "Replace the first session with the same id (the one `find-session` found)."
  [db session]
  (update db :sessions
          (fn [ss]
            (if-let [i (first (keep-indexed #(when (= (:id %2) (:id session)) %1) ss))]
              (assoc ss i session)
              ss))))

(defn append-message
  "[{:session :message} db']; throws when the session does not exist."
  [db session-id {:keys [role content] :as input} env]
  (let [session (or (find-session db session-id)
                    (throw (not-found (str "Session not found: " session-id))))
        now ((:now env))
        message (cond-> {:id ((:uuid env)) :role role :content content :created-at now}
                  (contains? input :reasoning-content) (assoc :reasoning-content (:reasoning-content input))
                  (contains? input :model) (assoc :model (:model input)))
        untitled? (or (= (:title session) "New chat") (str/starts-with? (:title session) "Fork of "))
        next-title (when (and untitled? (= role "user")) (summarize-message content))
        session' (cond-> (-> session (update :messages conj message) (assoc :updated-at now))
                   (seq next-title) (assoc :title next-title))]
    [{:session session' :message message} (replace-session db session')]))

(defn fork-session
  "Copy a session up to (and including) `:message-id` when that key is
  present in `opts`; otherwise the whole transcript."
  [db source-id opts env]
  (let [source (or (find-session db source-id)
                   (throw (not-found (str "Session not found: " source-id))))
        has-id? (contains? opts :message-id)
        message-id (:message-id opts)
        messages (:messages source)
        max-index (if has-id?
                    (or (first (keep-indexed #(when (= (:id %2) message-id) %1) messages)) -1)
                    (dec (count messages)))]
    (when (and has-id? (neg? max-index))
      (throw (not-found (str "Message not found in session: " (if (nil? message-id) "null" message-id)))))
    (let [copied (mapv (fn [m] (assoc m :id ((:uuid env)) :created-at ((:now env))))
                       (take (inc max-index) messages))
          now ((:now env))
          forked (cond-> {:id ((:uuid env)) :title (str "Fork of " (:title source)) :created-at now
                          :updated-at now :prompt-cache-key ((:uuid env))
                          :forked-from-session-id (:id source) :messages copied}
                   has-id? (assoc :forked-from-message-id message-id))]
      [forked (update db :sessions conj forked)])))
