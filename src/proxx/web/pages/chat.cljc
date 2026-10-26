(ns proxx.web.pages.chat
  "Chat page. The send pipeline (user message -> latest session -> prompt cache
  key -> completion -> assistant message -> refreshed session -> session list)
  is a chain of events, each step's effect naming the next; every failure lands
  in `:chat/send-failed`. Request-body construction and completion parsing are
  pure functions over wire data."
  (:require [clojure.string :as str]
            [proxx.web.api :as api]
            [proxx.web.fx :as fx]
            [proxx.web.state :as st]
            [proxx.web.storage :as storage]))

(def default-models ["gpt-5.3-codex" "openai/gpt-5.3-codex" "ollama/qwen3-vl:2b"])
(def default-model "ollama/qwen3-vl:2b")
(def copy-reset-ms 1200)

;; ---------------------------------------------------------------------------
;; Pure shaping

(defn escape-html [s]
  (-> (str s)
      (str/replace "&" "&amp;") (str/replace "<" "&lt;") (str/replace ">" "&gt;")
      (str/replace "\"" "&quot;") (str/replace "'" "&#39;")))

(def ^:private hidden-text-types #{"reasoning" "thinking" "reasoning_content" "reasoning_details"})
(def ^:private reasoning-part-types #{"reasoning" "thinking" "summary_text" "reasoning_content" "reasoning_details"})

(defn first-text-content
  "Visible text of a message `content` (string, or list of parts; reasoning
  parts are skipped)."
  [content]
  (cond
    (string? content) content
    (sequential? content)
    (apply str (map (fn [part]
                      (cond
                        (string? part) part
                        (and (map? part) (string? (get part "text")))
                        (if (hidden-text-types (let [t (get part "type")] (if (string? t) t "")))
                          ""
                          (get part "text"))
                        :else ""))
                    content))
    :else ""))

(defn first-reasoning-content
  "Reasoning trace of a completion message: `reasoning_content`, then `reasoning`,
  then reasoning-typed content parts."
  [message]
  (if-not (map? message)
    ""
    (let [direct (first-text-content (get message "reasoning_content"))
          fallback (first-text-content (get message "reasoning"))
          content (get message "content")]
      (cond
        (seq direct) direct
        (seq fallback) fallback
        (sequential? content)
        (apply str (map (fn [part]
                          (if (map? part)
                            (let [t (get part "type")]
                              (if (and (string? t) (reasoning-part-types t) (string? (get part "text")))
                                (get part "text")
                                ""))
                            ""))
                        content))
        :else ""))))

(defn to-openai-messages [messages]
  (->> messages
       (filter #(#{"system" "user" "assistant"} (:role %)))
       (mapv (fn [m] {:role (:role m) :content (:content m)}))))

(defn completion-request-body [model prompt-cache-key messages]
  {:model model :stream false :prompt_cache_key prompt-cache-key :messages (to-openai-messages messages)})

(defn parse-completion
  "`{:content :reasoning}` for the stored assistant message from a completion response."
  [response]
  (let [choices (when (map? response) (get response "choices"))
        message (when (sequential? choices) (let [c (first choices)] (when (map? c) (get c "message"))))
        content (if (map? message) (first-text-content (get message "content")) "")
        reasoning (first-reasoning-content message)]
    {:content (cond (seq content) content
                    (seq reasoning) "(Reasoning trace only)"
                    :else "(No text returned)")
     :reasoning (when (seq reasoning) reasoning)}))

(defn copy-text [{:keys [content reasoningContent]}]
  (if (and reasoningContent (not (str/blank? reasoningContent)))
    (str content "\n\n[Reasoning trace]\n" reasoningContent)
    content))

(defn ui-messages
  "Messages for the chat widget: HTML-escaped content (existing behaviour),
  copy/fork actions, model metadata."
  [messages copied-id]
  (->> messages
       (filter #(#{"system" "user" "assistant"} (:role %)))
       (mapv (fn [{:keys [id role content reasoningContent createdAt model]}]
               (cond-> {:id id :role role :content (escape-html content)
                        :actions [(if (= copied-id id) "Copied" "Copy") "Fork here"]}
                 (and reasoningContent (not (str/blank? reasoningContent))) (assoc :reasoningContent (escape-html reasoningContent))
                 (number? createdAt) (assoc :timestamp-ms createdAt)
                 model (assoc :metadata {:model model}))))))

;; ---------------------------------------------------------------------------
;; State

(defn model [db] (st/stored db storage/ls-chat-model default-model storage/validate-string))
(defn stored-active-id [db] (st/stored db storage/ls-chat-active-session "" storage/validate-string))

(defn init []
  {:sessions [] :active nil :model-options default-models :sending? false
   :search-query "" :search-source "none" :search-results [] :error nil :copied-id nil})

(defn- slice [db] (st/page-slice db :chat))
(defn- put [db & kvs] (apply st/update-page db :chat assoc kvs))

(defn- list-sessions-fx [tag] (fx/http (api/list-sessions) [:chat/sessions-loaded tag] [:chat/failed]))

(defn- activate
  "Make `session` active and remember it."
  [db session]
  (let [[db' fx*] (st/set-stored (put db :active session) storage/ls-chat-active-session (:id session))]
    [db' fx*]))

(defn enter [db]
  [db [(list-sessions-fx :initial)
       (fx/http (api/list-models) [:chat/models-loaded] [:chat/failed])]])

(defn- sessions-loaded [db [_ tag sessions]]
  (let [db (put db :sessions sessions)
        {:keys [active]} (slice db)
        fx* (cond-> []
              (and (not active) (seq sessions))
              (conj (let [preferred (str/trim (stored-active-id db))
                          desired (if (and (seq preferred) (some #(= preferred (:id %)) sessions))
                                    preferred
                                    (:id (first sessions)))]
                      (fx/http (api/get-session desired) [:chat/session-loaded] [:chat/failed]))))
        ;; after a send, the pipeline ends once the list is refreshed
        db (if (= tag :after-send) (put db :sending? false) db)]
    [db fx*]))

(defn- session-loaded [db [_ session]] (activate db session))

(defn- models-loaded [db [_ models]]
  (if (empty? models)
    [(put db :model-options default-models) []]
    (let [db (put db :model-options models)]
      (if (str/blank? (str/trim (model db)))
        (st/set-stored db storage/ls-chat-model (or (first models) "gpt-5.3-codex"))
        [db []]))))

(defn- failed [db [_ message]] [(put db :error message) []])

(defn- set-model [db [_ v]] (st/set-stored db storage/ls-chat-model v))

(defn- refresh-models [db _] [db [(fx/http (api/list-models) [:chat/models-loaded] [:chat/failed])]])

(defn- load-session [db [_ id]] [db [(fx/http (api/get-session id) [:chat/session-loaded] [:chat/failed])]])

(defn- new-session [db _] [db [(fx/http (api/create-session "New chat") [:chat/new-session-created] [:chat/failed])]])
(defn- new-session-created [db [_ session]]
  (let [[db' fx*] (activate db session)]
    [db' (conj fx* (list-sessions-fx :refresh))]))

(defn- search-query [db [_ v]] [(put db :search-query v) []])
(defn- search [db _]
  (let [q (str/trim (:search-query (slice db)))]
    (if (str/blank? q)
      [(put db :search-source "none" :search-results []) []]
      [db [(fx/http (api/search-session-history q 10) [:chat/search-loaded] [:chat/failed])]])))
(defn- search-loaded [db [_ payload]]
  [(put db :search-source (:source payload) :search-results (:results payload)) []])

(defn- fork [db [_ message-id]]
  (if-let [active (:active (slice db))]
    [db [(fx/http (api/fork-session (:id active) message-id) [:chat/forked] [:chat/failed])]]
    [db []]))
(defn- forked [db [_ session]]
  (let [[db' fx*] (activate db session)] [db' (conj fx* (list-sessions-fx :refresh))]))

(defn- copy [db [_ message-id]]
  (if-let [m (some #(when (= message-id (:id %)) %) (:messages (:active (slice db))))]
    [db [[:clipboard/write (copy-text m) [:chat/copied message-id] [:chat/failed]]]]
    [db []]))
(defn- copied [db [_ id]] [(put db :copied-id id) [(fx/dispatch-later copy-reset-ms [:chat/clear-copied id])]])
(defn- clear-copied [db [_ id]] [(if (= id (:copied-id (slice db))) (put db :copied-id nil) db) []])

(defn- message-action [db [_ action message-id]]
  (case action
    ("Copy" "Copied") (copy db [:chat/copy message-id])
    "Fork here" (fork db [:chat/fork message-id])
    [db []]))

;; send pipeline -------------------------------------------------------------

(defn- add-user-message [ctx]
  (fx/http (api/add-session-message (:session-id ctx) {:role "user" :content (:text ctx) :model (:model ctx)})
           [:chat/send-user-added ctx] [:chat/send-failed]))

(defn- send [db [_ text]]
  (let [t (str/trim text) {:keys [sending? active]} (slice db)]
    (if (or (str/blank? t) sending?)
      [db []]
      (let [db (put db :sending? true :error nil)
            ctx {:text t :model (model db)}]
        (if active
          [db [(add-user-message (assoc ctx :session-id (:id active)))]]
          [db [(fx/http (api/create-session "New chat") [:chat/send-session-created ctx] [:chat/send-failed])]])))))

(defn- send-session-created [db [_ ctx session]]
  (let [[db' fx*] (st/set-stored db storage/ls-chat-active-session (:id session))]
    [db' (conj fx* (add-user-message (assoc ctx :session-id (:id session))))]))

(defn- send-user-added [db [_ ctx _message]]
  [db [(fx/http (api/get-session (:session-id ctx)) [:chat/send-got-latest ctx] [:chat/send-failed])]])

(defn- send-got-latest [db [_ ctx latest]]
  [db [(fx/http (api/get-session-prompt-cache-key (:id latest)) [:chat/send-got-key ctx latest] [:chat/send-failed])]])

(defn- send-got-key [db [_ ctx latest key]]
  [db [(fx/http (api/run-chat-completion (completion-request-body (:model ctx) key (:messages latest)))
                [:chat/send-completed ctx] [:chat/send-failed])]])

(defn- send-completed [db [_ ctx response]]
  (let [{:keys [content reasoning]} (parse-completion response)]
    [db [(fx/http (api/add-session-message (:session-id ctx)
                                           {:role "assistant" :content content :reasoningContent reasoning :model (:model ctx)})
                  [:chat/send-assistant-added ctx] [:chat/send-failed])]]))

(defn- send-assistant-added [db [_ ctx _message]]
  [db [(fx/http (api/get-session (:session-id ctx)) [:chat/send-updated] [:chat/send-failed])]])

(defn- send-updated [db [_ session]]
  (let [[db' fx*] (activate db session)]
    [db' (conj fx* (fx/http (api/list-sessions) [:chat/sessions-loaded :after-send] [:chat/send-failed]))]))

(defn- send-failed [db [_ message]] [(put db :error message :sending? false) []])

(def page
  {:init init :enter enter
   :handlers {:chat/sessions-loaded sessions-loaded :chat/session-loaded session-loaded
              :chat/models-loaded models-loaded :chat/failed failed
              :chat/set-model set-model :chat/refresh-models refresh-models
              :chat/load-session load-session :chat/new-session new-session
              :chat/new-session-created new-session-created
              :chat/search-query search-query :chat/search search :chat/search-loaded search-loaded
              :chat/fork fork :chat/forked forked
              :chat/copy copy :chat/copied copied :chat/clear-copied clear-copied
              :chat/message-action message-action
              :chat/send send :chat/send-session-created send-session-created
              :chat/send-user-added send-user-added :chat/send-got-latest send-got-latest
              :chat/send-got-key send-got-key :chat/send-completed send-completed
              :chat/send-assistant-added send-assistant-added :chat/send-updated send-updated
              :chat/send-failed send-failed}})

(defn view-model [db]
  (let [{:keys [sessions active model-options sending? search-query search-source search-results error copied-id]} (slice db)
        m (model db) nm (str/trim m)]
    {:sessions (mapv (fn [s] {:id (:id s) :title (:title s)
                              :preview (if (str/blank? (:lastMessagePreview s)) "No messages yet" (:lastMessagePreview s))
                              :active? (= (:id s) (:id active))})
                     sessions)
     :title (or (:title active) "No session selected")
     :description (when (:forkedFromSessionId active) (str "Forked from " (:forkedFromSessionId active)))
     :has-active? (some? active)
     :model m
     :models (if (and (seq nm) (not (some #{nm} model-options))) (into [nm] model-options) model-options)
     :sending? sending? :error error
     :search {:query search-query :source search-source
              :results (mapv (fn [r] {:key (str (:sessionId r) ":" (:messageId r)) :session-id (:sessionId r)
                                      :title (:sessionTitle r) :content (:content r)})
                             search-results)}
     :messages (ui-messages (:messages active) copied-id)
     :empty-title (if active "No messages yet" "No session selected")
     :empty-text (if active "Send a message to start the conversation."
                     "Create or select a session from the sidebar to begin chatting.")}))
