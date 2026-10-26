(ns proxx.runtime.routes.sessions
  "Session routes (src/routes/sessions). The session store and semantic index
  are JS collaborators; message/search decisions are proxx.http.sessions."
  (:require [proxx.http.sessions :as sessions]
            [proxx.runtime.ring :as ring]))

(defn- path [prefix suffix] (str (if (.endsWith prefix "/") (subs prefix 0 (dec (count prefix))) prefix) suffix))

(defn- err-detail [e] (if (instance? js/Error e) (.-message e) (js/String e)))

(defn- prop
  "`body?.name` on the undecoded request body (undefined for a missing body)."
  [^js raw name]
  (let [body (.-body raw)]
    (if (some? body) (aget body name) js/undefined)))

(defn- ^:async index-message! [^js index ^js session ^js message]
  (await (.indexMessage index #js {:sessionId (.-id session) :sessionTitle (.-title session)
                                   :messageId (.-id message) :role (.-role message)
                                   :content (.-content message) :createdAt (.-createdAt message)})))

(defn- initial-sync
  "A fn returning the one shared promise that indexes every stored message
  (failures are reported to `warn` and do not fail the request)."
  [^js store ^js index warn]
  (let [state (atom nil)]
    (fn []
      (or @state
          (reset! state
                  ((fn ^:async sync! []
                     (try (doseq [m (array-seq (await (.collectSearchDocuments store)))]
                            (await (.indexMessage index m)))
                          (catch :default e (when warn (warn e)))))))))))

(defn routes
  "deps: {:session-store :session-index :warn}; prefix e.g. \"/api/v1\"."
  [{:keys [^js session-store ^js session-index warn]} prefix]
  (let [ensure-sync (initial-sync session-store session-index warn)
        session-path #(path prefix %)]
    [{:method :get :path (session-path "/sessions")
      :handler (fn ^:async list-sessions [_] {:body #js {:sessions (await (.listSessions session-store))}})}

     {:method :post :path (session-path "/sessions")
      :handler (fn ^:async create-session [{:keys [raw]}]
                 {:status 201 :body #js {:session (await (.createSession session-store (prop raw "title")))}})}

     {:method :get :path (session-path "/sessions/:sessionId")
      :handler (fn ^:async get-session [{:keys [params]}]
                 (if-let [session (await (.getSession session-store (get params "sessionId")))]
                   {:body #js {:session session}}
                   (sessions/not-found)))}

     {:method :get :path (session-path "/sessions/:sessionId/cache-key")
      :handler (fn ^:async cache-key [{:keys [params]}]
                 (if-let [^js session (await (.getSession session-store (get params "sessionId")))]
                   {:body #js {:sessionId (.-id session) :promptCacheKey (.-promptCacheKey session)}}
                   (sessions/not-found)))}

     {:method :post :path (session-path "/sessions/:sessionId/messages")
      :handler (fn ^:async append-message [{:keys [params body raw]}]
                 (let [{:keys [response role content reasoning-content]} (sessions/message-input body)]
                   (or response
                       (try
                         (let [^js result (await (.appendMessage session-store (get params "sessionId")
                                                                 #js {:role role :content content
                                                                      :reasoningContent (or reasoning-content js/undefined)
                                                                      :model (prop raw "model")}))
                               session (.-session result)
                               message (.-message result)]
                           (await (index-message! session-index session message))
                           {:status 201 :body #js {:message message :sessionId (.-id session)}})
                         (catch :default e
                           {:status 404 :body {"error" "session_not_found" "detail" (err-detail e)}})))))}

     {:method :post :path (session-path "/sessions/:sessionId/fork")
      :handler (fn ^:async fork-session [{:keys [params raw]}]
                 (try
                   (let [^js session (await (.forkSession session-store (get params "sessionId") (prop raw "messageId")))]
                     (doseq [m (array-seq (.-messages session))]
                       (await (index-message! session-index session m)))
                     {:status 201 :body #js {:session session}})
                   (catch :default e
                     {:status 404 :body {"error" "fork_failed" "detail" (err-detail e)}})))}

     {:method :post :path (session-path "/sessions/search")
      :handler (fn ^:async search [{:keys [body]}]
                 (await (ensure-sync))
                 (let [{:keys [query limit]} (sessions/search-request body)]
                   (if (empty? query)
                     {:body sessions/no-results}
                     (let [semantic (await (.search session-index query limit))]
                       (if (pos? (.-length ^js semantic))
                         {:body #js {:source "chroma" :results semantic}}
                         (let [fallback (await (.searchLexical session-store query limit))]
                           {:body #js {:source "fallback"
                                       :results (.map ^js fallback
                                                      (fn [r] (let [o (js/Object.assign #js {} r)]
                                                                (aset o "distance" 0)
                                                                o)))}}))))))}]))

(defn register-session-routes-js
  "`deps`: {sessionStore, sessionIndex, warn?}; `prefix`: route prefix."
  [app ^js deps prefix]
  (ring/register! app (routes {:session-store (.-sessionStore deps)
                               :session-index (.-sessionIndex deps)
                               :warn (.-warn deps)}
                              prefix)))
