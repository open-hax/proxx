(ns proxx.http.sessions
  "Decisions for the /sessions routes: which fields of a message body are
  honoured and what the search request asks for. Store and index calls are the
  edge's."
  (:require [clojure.string :as str]
            [proxx.analytics.usage :as usage]
            [proxx.http.guard :as guard]))

(def ^:private chat-roles #{"system" "user" "assistant" "tool"})

(defn chat-role
  "The body's role when it is a known chat role, else \"user\"."
  [value]
  (if (contains? chat-roles value) value "user"))

(defn not-found [] (guard/error 404 "session_not_found"))

(defn message-content
  "The body's content when it is a string, else \"\"."
  [body]
  (let [content (when (map? body) (get body "content"))]
    (if (string? content) content "")))

(defn message-input
  "{:response r} for a body without usable content, else
  {:role :content :reasoning-content}: reasoning-content only when a string."
  [body]
  (let [content (message-content body)]
    (if (str/blank? content)
      {:response (guard/error 400 "message_content_required")}
      (let [reasoning (when (map? body) (get body "reasoningContent"))]
        (cond-> {:role (chat-role (when (map? body) (get body "role")))
                 :content content}
          (string? reasoning) (assoc :reasoning-content reasoning))))))

(defn search-request
  "{:query q :limit n}; :query is \"\" (meaning: answer with no results) unless
  the body carries a non-blank string."
  [body]
  (let [q (when (map? body) (get body "query"))
        query (if (string? q) (str/trim q) "")]
    {:query query
     :limit (usage/to-safe-limit (when (map? body) (get body "limit")) 8 50)}))

(def no-results {"source" "none" "results" []})
