(ns proxx.runtime.session
  "Edge of the chat-session store: the file, the cache, and the queue that
  serialises mutations. Every decision is in proxx.session.store; this
  namespace holds one atom of db, one promise chain, and converts to and from
  the JS records callers already use.

  Property writes use `aset`, and objects are built key by key so the
  persisted JSON keeps the field order the TypeScript store wrote."
  (:require ["node:fs" :as fs]
            ["node:path" :as path]
            [proxx.session.store :as store]))

(defn- put-some! [o k v] (when (some? v) (aset o k v)) o)

(defn- message->js [{:keys [id role content reasoning-content model created-at] :as m}]
  (let [o #js {}]
    (aset o "id" id)
    (aset o "role" role)
    (aset o "content" content)
    (when (contains? m :reasoning-content) (aset o "reasoningContent" reasoning-content))
    (when (contains? m :model) (aset o "model" model))
    (aset o "createdAt" created-at)
    o))

(defn- session->js [{:keys [id title created-at updated-at prompt-cache-key forked-from-session-id
                            forked-from-message-id messages]}]
  (let [o #js {}]
    (aset o "id" id)
    (aset o "title" title)
    (aset o "createdAt" created-at)
    (aset o "updatedAt" updated-at)
    (aset o "promptCacheKey" prompt-cache-key)
    (put-some! o "forkedFromSessionId" forked-from-session-id)
    (put-some! o "forkedFromMessageId" forked-from-message-id)
    (aset o "messages" (to-array (map message->js messages)))
    o))

(defn- list-item->js [{:keys [id title created-at updated-at prompt-cache-key message-count
                              last-message-preview forked-from-session-id forked-from-message-id]}]
  (let [o #js {}]
    (aset o "id" id)
    (aset o "title" title)
    (aset o "createdAt" created-at)
    (aset o "updatedAt" updated-at)
    (aset o "promptCacheKey" prompt-cache-key)
    (aset o "messageCount" message-count)
    (aset o "lastMessagePreview" last-message-preview)
    (put-some! o "forkedFromSessionId" forked-from-session-id)
    (put-some! o "forkedFromMessageId" forked-from-message-id)
    o))

(defn- document->js [{:keys [session-id session-title message-id role content created-at]}]
  #js {:sessionId session-id :sessionTitle session-title :messageId message-id
       :role role :content content :createdAt created-at})

(defn- db->js [db]
  #js {:sessions (to-array (map session->js (:sessions db)))})

(defn- js-input [^js input]
  (reduce (fn [m [k prop]] (let [v (aget input prop)] (if (undefined? v) m (assoc m k v))))
          {}
          [[:role "role"] [:content "content"] [:reasoning-content "reasoningContent"] [:model "model"]]))

(defn- rethrow
  "Domain failures reach the HTTP layer as plain Errors with the same message."
  [e]
  (throw (if (= ::store/not-found (:error/type (ex-data e))) (js/Error. (ex-message e)) e)))

(def ^:private default-env
  {:now (fn [] (js/Date.now)) :uuid (fn [] (js/crypto.randomUUID))})

(defn- read-db!
  "Cached db; the first read hydrates from the file and any failure means empty."
  [cache file-path env]
  (if-let [db @cache]
    (js/Promise.resolve db)
    (-> (.readFile (.-promises fs) file-path "utf8")
        (.then (fn [contents] (store/hydrate (js->clj (js/JSON.parse contents)) env)))
        (.catch (fn [_] store/empty-db))
        (.then (fn [db] (reset! cache db) db)))))

(defn- write-db! [file-path db]
  (-> (.mkdir (.-promises fs) (.dirname path file-path) #js {:recursive true})
      (.then (fn [] (.writeFile (.-promises fs) file-path (str (js/JSON.stringify (db->js db) nil 2) "\n") "utf8")))))

(defn create-session-store-js
  "JS facade with the SessionStore method names. `deps` may supply
  {now, uuid} (tests); defaults are Date.now and crypto.randomUUID."
  ([file-path] (create-session-store-js file-path nil))
  ([file-path ^js deps]
   (let [env (cond-> default-env
               (and deps (.-now deps)) (assoc :now (.-now deps))
               (and deps (.-uuid deps)) (assoc :uuid (.-uuid deps)))
         cache (atom nil)
         chain (atom (js/Promise.resolve))
         read! (fn [] (read-db! cache file-path env))
         mutate! (fn [f]
                   (let [result (.then @chain
                                       (fn []
                                         (-> (read!)
                                             (.then (fn [db]
                                                      (let [[value db'] (try (f db) (catch :default e (rethrow e)))]
                                                        (reset! cache db')
                                                        (-> (write-db! file-path db')
                                                            (.then (fn [] value)))))))))]
                     (reset! chain (.then result (fn [_] nil) (fn [_] nil)))
                     result))]
     #js {:listSessions (fn [] (.then (read!) (fn [db] (to-array (map list-item->js (store/list-items db))))))
          :getSession (fn [id] (.then (read!) (fn [db] (if-let [s (store/find-session db id)] (session->js s) js/undefined))))
          :createSession (fn [title]
                           (mutate! (fn [db] (let [[s db'] (store/create-session db title env)] [(session->js s) db']))))
          :appendMessage (fn [id input]
                           (mutate! (fn [db]
                                      (let [[{:keys [session message]} db'] (store/append-message db id (js-input input) env)]
                                        [#js {:session (session->js session) :message (message->js message)} db']))))
          :forkSession (fn [id message-id]
                         (mutate! (fn [db]
                                    (let [[s db'] (store/fork-session db id
                                                                      (if (undefined? message-id) {} {:message-id message-id})
                                                                      env)]
                                      [(session->js s) db']))))
          :collectSearchDocuments (fn [] (.then (read!) (fn [db] (to-array (map document->js (store/search-documents db))))))
          :searchLexical (fn [query limit]
                           (if (store/blank-query? query)
                             (js/Promise.resolve (to-array []))
                             (.then (read!) (fn [db] (to-array (map document->js (store/search-lexical db query limit)))))))})))
