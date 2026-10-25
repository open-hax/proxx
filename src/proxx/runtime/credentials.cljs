(ns proxx.runtime.credentials
  "Edge of the file-backed credential store (`src/lib/credential-store.ts`):
  one atom holding the pure store state (`proxx.credentials.store`), the
  debounced/serialised flush to disk, and the process-exit hooks.

  Persistence contract: the file is `JSON.stringify(payload, null, 2) + \"\\n\"`
  where payload is `store/persisted-json`; writes are debounced by 500ms,
  serialised (one in flight at a time), and flushed synchronously on exit and on
  SIGINT/SIGTERM. Callers of `upsert*`/`removeAccount` await a flush, so a
  returned promise means the data is on disk."
  (:require ["node:fs" :as fs]
            ["node:path" :as path]
            [proxx.credentials.store :as store]))

(def ^:private flush-debounce-ms 500)

;; ---------------------------------------------------------------------------
;; Process hooks (shared by every store in the process)
;; ---------------------------------------------------------------------------

(defonce ^:private stores (atom #{}))
(defonce ^:private hooks (atom nil))

(defn- flush-all! []
  (doseq [^js s @stores]
    (try (.flushOnExit s) (catch :default _ nil))))

(defn- install-hooks! []
  (when-not @hooks
    (let [on-sigint (fn [] (flush-all!) (aset js/process "exitCode" 130))
          on-sigterm (fn [] (flush-all!) (aset js/process "exitCode" 143))]
      (reset! hooks {:flush-all flush-all! :sigint on-sigint :sigterm on-sigterm})
      (.once js/process "beforeExit" flush-all!)
      (.once js/process "exit" flush-all!)
      (.once js/process "SIGINT" on-sigint)
      (.once js/process "SIGTERM" on-sigterm))))

(defn- uninstall-hooks! []
  (when-let [{:keys [flush-all sigint sigterm]} @hooks]
    (.off js/process "beforeExit" flush-all)
    (.off js/process "exit" flush-all)
    (.off js/process "SIGINT" sigint)
    (.off js/process "SIGTERM" sigterm)
    (reset! hooks nil)))

;; ---------------------------------------------------------------------------
;; JS views
;; ---------------------------------------------------------------------------

(defn- account-view->js [{:keys [id auth-type display-name secret-preview secret refresh-token-preview refresh-token
                                 expires-at chatgpt-account-id email subject plan-type]}]
  (let [o #js {"id" id "authType" (store/auth-type->wire auth-type) "displayName" display-name
               "secretPreview" secret-preview}]
    (when (some? secret) (aset o "secret" secret))
    (when (some? refresh-token-preview) (aset o "refreshTokenPreview" refresh-token-preview))
    (when (some? refresh-token) (aset o "refreshToken" refresh-token))
    (when (some? expires-at) (aset o "expiresAt" expires-at))
    (when (some? chatgpt-account-id) (aset o "chatgptAccountId" chatgpt-account-id))
    (when (some? email) (aset o "email" email))
    (when (some? subject) (aset o "subject" subject))
    (when (some? plan-type) (aset o "planType" plan-type))
    o))

(defn- provider-view->js [{:keys [id auth-type account-count accounts]}]
  #js {"id" id "authType" (store/auth-type->wire auth-type) "accountCount" account-count
       "accounts" (to-array (map account-view->js accounts))})

(defn- metadata->clj [^js m]
  (cond-> {}
    (some? (.-chatgptAccountId m)) (assoc :chatgpt-account-id (.-chatgptAccountId m))
    (some? (.-email m)) (assoc :email (.-email m))
    (some? (.-subject m)) (assoc :subject (.-subject m))
    (some? (.-planType m)) (assoc :plan-type (.-planType m))))

(defn- document->state
  "Normalize a parsed keys document; provider keys are read from the raw JS
  object so that JavaScript's key order (which the file's order follows) is kept."
  [^js raw default-provider-id derive-metadata]
  (let [providers (when (and (some? raw) (identical? "object" (goog/typeOf raw))) (.-providers raw))
        provider-keys (when (and (some? providers) (identical? "object" (goog/typeOf providers)))
                        (vec (js/Object.keys providers)))]
    (store/normalize-credentials {:derive-metadata (fn [token] (metadata->clj (derive-metadata token)))
                                  :provider-keys provider-keys}
                                 (js->clj raw) default-provider-id)))

;; ---------------------------------------------------------------------------
;; The store
;; ---------------------------------------------------------------------------

(defn- file-text [state]
  (str (js/JSON.stringify (clj->js (store/persisted-json state)) nil 2) "\n"))

(defn create-credential-store-js
  "`deps`: {deriveOAuthMetadata(token) => {chatgptAccountId?, email?, subject?, planType?}}.
  Returns the facade the TS `CredentialStore` forwards to."
  [file-path default-provider-id ^js deps]
  (let [derive-metadata (.-deriveOAuthMetadata deps)
        cache (atom nil)
        dirty (atom false)
        write-epoch (atom 0)
        flush-timer (atom nil)
        flush-in-flight (atom nil)
        clear-timer! (fn [] (when-let [t @flush-timer] (js/clearTimeout t) (reset! flush-timer nil)))
        read-normalized
        (fn ^:async read-normalized []
          (or @cache
              (try
                (let [contents (await (.readFile (.-promises fs) file-path "utf8"))
                      state (document->state (js/JSON.parse contents) default-provider-id derive-metadata)]
                  (reset! cache state)
                  state)
                (catch :default _ store/empty-state))))
        flush-to-disk
        (fn ^:async flush-to-disk []
          (loop []
            (when @cache
              (cond
                @flush-in-flight
                (do (await @flush-in-flight)
                    (when @dirty (recur)))

                (not @dirty) nil

                :else
                (let [epoch @write-epoch
                      text (file-text @cache)
                      write (-> (.mkdir (.-promises fs) (.dirname path file-path) #js {"recursive" true})
                                (.then (fn [_] (.writeFile (.-promises fs) file-path text "utf8"))))]
                  (reset! flush-in-flight write)
                  (try (await write) (finally (reset! flush-in-flight nil)))
                  (when (= @write-epoch epoch) (reset! dirty false))
                  (when @dirty (recur)))))))
        schedule-flush!
        (fn []
          (when-not @flush-timer
            (reset! flush-timer
                    (js/setTimeout (fn []
                                     (reset! flush-timer nil)
                                     (.catch (flush-to-disk) (fn [_] nil)))
                                   flush-debounce-ms))))
        write-normalized!
        (fn [state]
          (reset! cache state)
          (reset! dirty true)
          (swap! write-epoch inc)
          (schedule-flush!))
        flush (fn ^:async flush [] (clear-timer!) (await (flush-to-disk)))
        self (atom nil)
        dispose (fn []
                  (clear-timer!)
                  (swap! stores disj @self)
                  (when (empty? @stores) (uninstall-hooks!)))
        facade
        #js {"dispose" dispose

             "flush" flush

             "close"
             (fn ^:async close []
               (try (await (flush)) (finally (dispose))))

             "flushOnExit"
             (fn []
               (clear-timer!)
               (when (and @dirty @cache)
                 (try
                   (let [text (file-text @cache)]
                     (.mkdirSync fs (.dirname path file-path) #js {"recursive" true})
                     (.writeFileSync fs file-path text "utf8")
                     (reset! dirty false))
                   (catch :default _ nil))))

             "listProviders"
             (fn ^:async list-providers [reveal-secrets]
               (let [state (await (read-normalized))]
                 (->> (store/provider-views state (boolean reveal-secrets))
                      (sort-by :id (fn [a b] (.localeCompare ^string a b)))
                      (map provider-view->js)
                      to-array)))

             "upsertApiKeyAccount"
             (fn ^:async upsert-api-key-account [provider-id account-id api-key]
               (write-normalized! (store/upsert-api-key-account (await (read-normalized)) default-provider-id
                                                                provider-id account-id api-key))
               (await (flush)))

             "upsertOAuthAccount"
             (fn ^:async upsert-oauth-account [provider-id account-id access-token refresh-token expires-at
                                               chatgpt-account-id email subject plan-type]
               (write-normalized! (store/upsert-oauth-account (await (read-normalized)) default-provider-id
                                                              provider-id account-id access-token
                                                              {:refresh-token refresh-token :expires-at expires-at
                                                               :chatgpt-account-id chatgpt-account-id :email email
                                                               :subject subject :plan-type plan-type}))
               (await (flush)))

             "removeAccount"
             (fn ^:async remove-account [provider-id account-id]
               (let [[removed? state'] (store/remove-account (await (read-normalized)) default-provider-id
                                                             provider-id account-id)]
                 (when removed?
                   (write-normalized! state')
                   (await (flush)))
                 removed?))}]
    (reset! self facade)
    (swap! stores conj facade)
    (install-hooks!)
    facade))
