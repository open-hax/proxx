(ns proxx.runtime.routes.federation
  "Federation control-plane routes (src/routes/federation/ui.ts): peers, bridge
  sessions and lease import, account knowledge/export/import, usage exchange,
  sync pull, projected-account routing and tenant provider policies.

  Stores, the bridge relay and peer HTTP are JS collaborators read here; every
  decision (validation, visibility, import planning, sanitizing, merging) is
  proxx.http.federation. Responses reuse the store's own JS records where the
  TypeScript did, so absent/undefined fields stay absent."
  (:require [proxx.http.federation :as fed]
            [proxx.http.guard :as guard]
            [proxx.http.params :as params]
            [proxx.http.ui-auth :as ui-auth]
            [proxx.analytics.usage :as usage]
            [proxx.runtime.federation :as fed-rt]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.ring :as ring]
            [proxx.runtime.sql :as sql]))

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defn- join-path [prefix suffix]
  (str (if (.endsWith prefix "/") (subs prefix 0 (dec (count prefix))) prefix) suffix))

(defn- err-message [e] (if (instance? js/Error e) (.-message e) (js/String e)))

(defn- prop
  "`obj?.name` on an undecoded JS value (undefined for null/undefined)."
  [obj name]
  (if (some? obj) (aget obj name) js/undefined))

(defn- or-undefined [x] (if (nil? x) js/undefined x))

(defn- not-iterable [what] (js/TypeError. (str what " is not iterable")))

(defn- iterable-array [x what]
  (if (js/Array.isArray x) x (throw (not-iterable what))))

(defn- or-undefined-str
  "`a ?? b`"
  [a b] (if (nil? a) b a))

(defn- str-or-undefined [x] (if (string? x) x js/undefined))

(defn- ^:async fetch-federation-json
  "GET/POST JSON to a peer with a bearer credential and an abort timeout; throws
  the peer's own `error` string or `request failed with <status>`."
  [{:keys [url credential timeout-ms method body]}]
  (let [controller (js/AbortController.)
        timeout (js/setTimeout #(.abort controller) timeout-ms)]
    (try
      (let [headers (js/Headers.)
            _ (.set headers "content-type" "application/json")
            _ (when (and credential (pos? (count credential))) (.set headers "authorization" (str "Bearer " credential)))
            ^js response (await (js/fetch url #js {:method (or method "GET") :headers headers
                                                  :body (if body (js/JSON.stringify (clj->js body)) js/undefined)
                                                  :signal (.-signal controller)}))
            text (await (.text response))
            parsed (if (pos? (count text)) (js/JSON.parse text) #js {})]
        (when-not (.-ok response)
          (throw (js/Error. (let [e (aget parsed "error")] (if (string? e) e (str "request failed with " (.-status response)))))))
        parsed)
      (finally (js/clearTimeout timeout)))))

(defn- upsert-credential!
  "Store an exported credential (OAuth lease or API key) in the credential store."
  [^js credential-store ^js exported provider-id account-id]
  (if (= "oauth_bearer" (aget exported "authType"))
    (.upsertOAuthAccount credential-store provider-id account-id (aget exported "secret") js/undefined
                         (aget exported "expiresAt") (aget exported "chatgptAccountId") (aget exported "email")
                         (aget exported "subject") (aget exported "planType"))
    (.upsertApiKeyAccount credential-store provider-id account-id (aget exported "secret"))))

(defn- append-diff! [^js store event] (.appendDiffEvent store (clj->js event)))

(defn- session-facts [^js s]
  {:session-id (.-sessionId s) :agent-id (.-agentId s) :tenant-id (.-tenantId s) :state (.-state s) :js s})

;; ---------------------------------------------------------------------------
;; Routes
;; ---------------------------------------------------------------------------

(defn- ^:async warm-import!
  "Under the projected account's import lock: re-read it, and when it still needs
  its credential, fetch it from the source peer and mark it imported. Resolves to
  {account, importedCredential}, or undefined when the account vanished."
  [{:keys [^js sql-federation-store ^js credential-store ^js log timeout prefix]} ^js key]
  (await
   (.withProjectedAccountImportLock
    sql-federation-store key
    (fn ^:async locked [tx]
      (let [^js latest (await (.getProjectedAccount sql-federation-store key tx))]
        (cond
          (not latest) js/undefined
          (and (= "imported" (.-availabilityState latest)) (not (fed/oauth-lease? (interop/js->data latest))))
          #js {:account latest :importedCredential false}
          :else
          (let [^js peer (await (.getPeer sql-federation-store (.-sourcePeerId key) tx))
                credential (when peer (fed-rt/extract-peer-credential-js (.-auth peer)))]
            (if (or (not peer) (not credential))
              #js {:account latest :importedCredential false}
              (try
                (let [^js remote (await (fetch-federation-json
                                         {:url (str (or-undefined-str (.-controlBaseUrl peer) (.-baseUrl peer))
                                                    (join-path prefix "/federation/accounts/export"))
                                          :credential credential :timeout-ms timeout :method "POST"
                                          :body {"providerId" (.-providerId latest) "accountId" (.-accountId latest)}}))
                      ^js exported (aget remote "account")]
                  (await (upsert-credential! credential-store exported (aget exported "providerId") (aget exported "accountId")))
                  (let [imported (await (.markProjectedAccountImported sql-federation-store key tx))]
                    #js {:account (or imported latest) :importedCredential true}))
                (catch :default e
                  (.warn log #js {:error (err-message e) :sourcePeerId (.-sourcePeerId key)
                                  :providerId (.-providerId key) :accountId (.-accountId key)}
                         "failed warm federation credential import")
                  #js {:account latest :importedCredential false}))))))))))

(defn routes
  "deps: {:env :config-openai-provider-id :sql-federation-store :sql-tenant-provider-policy-store
  :sql-request-usage-store :sql-credential-store :credential-store :key-pool :request-log-store
  :bridge-relay :federation-request-timeout-ms :refresh-openai-oauth-accounts
  :should-warm-import :log}; prefix e.g. \"/api/v1\"."
  [{:keys [^js env openai-provider-id ^js sql-federation-store ^js policy-store ^js usage-store ^js sql-credential-store
           ^js credential-store ^js key-pool ^js request-log-store ^js bridge-relay timeout-ms refresh-oauth
           should-warm-import ^js log]}
   prefix]
  (let [p #(join-path prefix %)
        timeout (or timeout-ms 5000)
        deps-map {:sql-federation-store sql-federation-store :credential-store credential-store :log log
                  :timeout timeout :prefix prefix}
        need-federation-store (fn [] (guard/require-present sql-federation-store 503 "federation_store_not_supported"))
        gate (fn [auth] (fed/authorize auth))]
    [{:method :get :path (p "/federation/peers")
      :handler (fn ^:async list-peers [{:keys [auth query]}]
                 (or (gate auth) (need-federation-store)
                     {:body #js {:peers (await (.listPeers sql-federation-store (or-undefined (fed/trimmed-nes (get query "ownerSubject")))))}}))}

     {:method :get :path (p "/federation/self")
      :handler (fn ^:async federation-self [{:keys [auth]}]
                 (or (gate auth)
                     (let [peer-count (if sql-federation-store (.-length (await (.listPeers sql-federation-store))) 0)
                           e (fn [k] (let [v (aget env k)] (if (some? v) v nil)))]
                       {:body #js {:nodeId (e "FEDERATION_SELF_NODE_ID") :groupId (e "FEDERATION_SELF_GROUP_ID")
                                   :clusterId (e "FEDERATION_SELF_CLUSTER_ID") :peerDid (e "FEDERATION_SELF_PEER_DID")
                                   :publicBaseUrl (e "FEDERATION_SELF_PUBLIC_BASE_URL") :peerCount peer-count}})))}

     {:method :post :path (p "/federation/peers")
      :handler (fn ^:async upsert-peer [{:keys [auth body raw]}]
                 (or (gate auth) (need-federation-store)
                     (let [{:keys [response owner-credential label base-url]} (fed/peer-input body)
                           ^js rb (.-body raw)]
                       (or response
                           (let [^js peer (await (.upsertPeer sql-federation-store
                                                              #js {:id (prop rb "id") :ownerCredential owner-credential
                                                                   :peerDid (prop rb "peerDid") :label label :baseUrl base-url
                                                                   :controlBaseUrl (prop rb "controlBaseUrl") :auth (prop rb "auth")
                                                                   :capabilities (prop rb "capabilities") :status (prop rb "status")}))]
                             (await (.appendDiffEvent sql-federation-store
                                                      #js {:ownerSubject (.-ownerSubject peer) :entityType "peer" :entityKey (.-id peer)
                                                           :op "upsert"
                                                           :payload #js {:peerDid (.-peerDid peer) :label (.-label peer) :baseUrl (.-baseUrl peer)
                                                                         :controlBaseUrl (.-controlBaseUrl peer) :authMode (.-authMode peer)
                                                                         :status (.-status peer)}}))
                             {:status 201 :body #js {:peer peer}})))))}

     {:method :get :path (p "/federation/bridge/ws")
      :handler (fn [{:keys [auth]}]
                 (or (gate auth)
                     {:status 426 :headers {"upgrade" "websocket"} :body {"error" "websocket_upgrade_required"}}))}

     {:method :get :path (p "/federation/observability/ws")
      :handler (fn [{:keys [auth]}]
                 (or (gate auth)
                     {:status 426 :headers {"upgrade" "websocket"} :body {"error" "websocket_upgrade_required"}}))}

     {:method :get :path (p "/federation/bridges")
      :handler (fn [{:keys [auth]}]
                 (or (gate auth)
                     (guard/require-present bridge-relay 503 "federation_bridge_not_supported")
                     (let [sessions (.listSessions bridge-relay)
                           visible (if (= "legacy_admin" (get auth "kind"))
                                     sessions
                                     (.filter ^js sessions (fn [^js s] (= (.-tenantId s) (get auth "tenantId")))))]
                       {:body #js {:sessions visible}})))}

     {:method :post :path (p "/federation/bridges/lease/import")
      :handler
      (fn ^:async lease-import [{:keys [auth body]}]
        (or (gate auth)
            (guard/require-present bridge-relay 503 "federation_bridge_not_supported")
            (let [{:keys [response provider-id limit refresh-buffer-ms force-api-keys? session-id agent-id]} (fed/lease-import-request body)]
              (or response
                  (let [session (fed/find-session auth (mapv session-facts (array-seq (.listSessions bridge-relay))) session-id agent-id)]
                    (cond
                      (or (nil? session) (not= "connected" (:state session)))
                      (guard/error 404 "bridge_session_not_found_or_not_connected")
                      (not credential-store) (guard/error 503 "credential_store_not_supported")
                      :else
                      (let [sid (:session-id session)
                            listing (try
                                      (let [^js remote (await (.requestJson bridge-relay sid
                                                                            #js {:method "GET" :path (fed/lease-list-path provider-id limit)
                                                                                 :timeoutMs 20000 :headers #js {:accept "application/json"}}))]
                                        (if (or (< (.-status remote) 200) (>= (.-status remote) 300))
                                          {:response {:status 502 :body #js {:error "bridge_accounts_list_failed" :status (.-status remote)}}}
                                          {:accounts (interop/js->data (fed-rt/parse-bridge-lease-accounts-js (.-json remote) provider-id))}))
                                      (catch :default e
                                        {:response {:status 502 :body {"error" "bridge_accounts_list_failed" "detail" (err-message e)}}}))]
                        (or (:response listing)
                            (let [remote-accounts (:accounts listing)
                                  local-providers (await (.catch (.listProviders credential-store false) (fn [_] #js [])))
                                  ^js local-provider (.find local-providers (fn [^js c] (= (.-id c) provider-id)))
                                  local (reduce (fn [m ^js a] (assoc m (.-id a) (.-expiresAt a)))
                                                {} (when local-provider (array-seq (.-accounts local-provider))))
                                  has-account (atom (set (keys local)))
                                  now (js/Date.now)
                                  to-import (fed/lease-to-import remote-accounts local now refresh-buffer-ms force-api-keys?)
                                  errors (atom []) imported (atom 0) refreshed (atom 0)
                                  queue (atom (vec to-import))
                                  worker (fn ^:async worker []
                                           (loop []
                                             (when-let [account (first @queue)]
                                               (swap! queue subvec 1)
                                               (try
                                                 (let [^js remote-export (await (.requestJson bridge-relay sid
                                                                                               #js {:method "POST" :path "/api/bridge/credentials/export"
                                                                                                    :timeoutMs 30000
                                                                                                    :headers #js {"content-type" "application/json" :accept "application/json"}
                                                                                                    :body (js/JSON.stringify #js {:providerId provider-id :accountId (get account "accountId")})}))
                                                       aid (get account "accountId")]
                                                   (if (or (< (.-status remote-export) 200) (>= (.-status remote-export) 300))
                                                     (swap! errors conj (str aid ": export_status_" (.-status remote-export)))
                                                     (if-let [exported (fed-rt/parse-bridge-lease-export-js (.-json remote-export))]
                                                       (let [existed (contains? @has-account aid)]
                                                         (await (upsert-credential! credential-store exported provider-id aid))
                                                         (if existed
                                                           (swap! refreshed inc)
                                                           (do (swap! imported inc) (swap! has-account conj aid))))
                                                       (swap! errors conj (str aid ": export_invalid_payload")))))
                                                 (catch :default e
                                                   (swap! errors conj (str (get account "accountId") ": " (err-message e)))))
                                               (recur))))
                                  _ (await (js/Promise.all (to-array (map (fn [_] (worker)) (range (min 6 (count to-import)))))))
                                  _ (await (.catch (.warmup key-pool) (fn [_] js/undefined)))]
                              {:body (fed/lease-response
                                      (select-keys session [:session-id :agent-id]) provider-id (count remote-accounts)
                                      (count to-import) @imported @refreshed @errors)})))))))))}

     {:method :get :path (p "/federation/bridges/:sessionId")
      :handler (fn [{:keys [auth params]}]
                 (or (gate auth)
                     (guard/require-present bridge-relay 503 "federation_bridge_not_supported")
                     (let [^js session (.getSession bridge-relay (get params "sessionId"))]
                       (cond
                         (not session) (guard/error 404 "bridge_session_not_found")
                         (and (not= "legacy_admin" (get auth "kind")) (not= (.-tenantId session) (get auth "tenantId")))
                         (guard/error 404 "bridge_session_not_found")
                         :else {:body #js {:session session}}))))}

     {:method :get :path (p "/federation/diff-events")
      :handler (fn ^:async diff-events [{:keys [auth query]}]
                 (or (gate auth) (need-federation-store)
                     (let [owner-subject (fed/trimmed (get query "ownerSubject"))]
                       (if (empty? owner-subject)
                         (guard/error 400 "owner_subject_required")
                         (let [after-seq (let [s (get query "afterSeq")] (when (string? s) (params/parse-int s)))
                               limit (usage/to-safe-limit (get query "limit") 200 500)
                               events (await (.listDiffEvents sql-federation-store
                                                              (clj->js (cond-> {:ownerSubject owner-subject :limit limit}
                                                                         (some? after-seq) (assoc :afterSeq after-seq)))))]
                           {:body #js {:ownerSubject owner-subject :events events}})))))}

     {:method :get :path (p "/federation/accounts")
      :handler (fn ^:async list-accounts [{:keys [auth query]}]
                 (or (gate auth) (need-federation-store)
                     (let [owner-subject (fed/trimmed-nes (get query "ownerSubject"))
                           projected (await (.listProjectedAccounts sql-federation-store (or-undefined owner-subject)))
                           cooldowns (when (fn? (some-> sql-credential-store .-loadCooldowns)) (await (.loadCooldowns sql-credential-store)))
                           source (or sql-credential-store credential-store)
                           providers (await (.listProviders ^js source false))
                           {:keys [local-accounts known-accounts]}
                           (fed/account-knowledge (interop/js->data providers) (interop/js->data projected)
                                                  {:owner-subject owner-subject
                                                   :default-owner-subject (let [d (aget env "FEDERATION_DEFAULT_OWNER_SUBJECT")] (when (string? d) d))
                                                   :cooldowns (when cooldowns (into {} (map (fn [[k v]] [k v])) (js/Array.from (.entries ^js cooldowns))))
                                                   :now (js/Date.now)})]
                       {:body #js {:ownerSubject (if owner-subject owner-subject nil)
                                   :localAccounts (clj->js local-accounts)
                                   :projectedAccounts projected
                                   :knownAccounts (clj->js known-accounts)}})))}

     {:method :post :path (p "/federation/accounts/export")
      :handler
      (fn ^:async export-account [{:keys [auth body]}]
        (or (gate auth)
            (let [provider-id (fed/trimmed (fed/field body "providerId"))
                  account-id (fed/trimmed (fed/field body "accountId"))
                  find-credential (fn ^:async find-credential []
                                    (let [providers (await (.listProviders credential-store true))
                                          ^js provider (.find providers (fn [^js c] (= (.-id c) provider-id)))
                                          ^js account (when provider (.find (.-accounts provider) (fn [^js a] (= (.-id a) account-id))))]
                                      (when (and provider account (string? (.-secret account)) (pos? (count (.trim (.-secret account)))))
                                        #js {:providerId provider-id :accountId account-id :authType (.-authType account)
                                             :secret (.-secret account) :refreshToken (.-refreshToken account)
                                             :expiresAt (.-expiresAt account) :chatgptAccountId (.-chatgptAccountId account)
                                             :email (.-email account) :subject (.-subject account) :planType (.-planType account)})))]
              (if (or (empty? provider-id) (empty? account-id))
                (guard/error 400 "provider_id_and_account_id_required")
                (let [^js account (await (find-credential))]
                  (cond
                    (not account) (guard/error 404 "credential_account_not_found")
                    (= "oauth_bearer" (.-authType account))
                    (let [account (if (fed/export-needs-refresh? (interop/js->data account) (js/Date.now) openai-provider-id (boolean refresh-oauth))
                                    (do (try (await (refresh-oauth (.-accountId account))) (catch :default _ nil))
                                        (or (await (find-credential)) account))
                                    account)
                          out (js/Object.assign #js {} account)]
                      (aset out "refreshToken" js/undefined)
                      {:body #js {:account out}})
                    :else {:body #js {:account account}}))))))}

     {:method :post :path (p "/federation/projected-accounts/import")
      :handler
      (fn ^:async import-projected [{:keys [auth raw]}]
        (or (gate auth) (need-federation-store)
            (let [^js accounts (prop (.-body raw) "accounts")
                  accounts (if (js/Array.isArray accounts) accounts #js [])]
              (if (zero? (.-length accounts))
                (guard/error 400 "accounts_required")
                (loop [items (array-seq accounts) imported []]
                  (if-let [[^js account & more] (seq items)]
                    (let [s (fn [k] (fed/trimmed (prop account k)))
                          source-peer-id (s "sourcePeerId") owner-subject (s "ownerSubject")
                          provider-id (s "providerId") account-id (s "accountId")]
                      (if (some empty? [source-peer-id owner-subject provider-id account-id])
                        (guard/error 400 fed/projected-required-error)
                        (let [^js record (await (.upsertProjectedAccount
                                                 sql-federation-store
                                                 #js {:sourcePeerId source-peer-id :ownerSubject owner-subject :providerId provider-id
                                                      :accountId account-id :accountSubject (str-or-undefined (prop account "accountSubject"))
                                                      :chatgptAccountId (str-or-undefined (prop account "chatgptAccountId"))
                                                      :email (str-or-undefined (prop account "email")) :planType (str-or-undefined (prop account "planType"))
                                                      :availabilityState (prop account "availabilityState") :metadata (prop account "metadata")}))]
                          (await (.appendDiffEvent sql-federation-store
                                                   #js {:ownerSubject (.-ownerSubject record) :entityType "projected_account"
                                                        :entityKey (str (.-sourcePeerId record) ":" (.-providerId record) ":" (.-accountId record))
                                                        :op "upsert"
                                                        :payload #js {:providerId (.-providerId record) :accountId (.-accountId record)
                                                                      :availabilityState (.-availabilityState record) :sourcePeerId (.-sourcePeerId record)
                                                                      :email (.-email record) :chatgptAccountId (.-chatgptAccountId record)}}))
                          (recur more (conj imported record)))))
                    {:status 201 :body #js {:accounts (to-array imported)}}))))))}

     {:method :post :path (p "/federation/projected-accounts/import-all")
      :handler
      (fn ^:async import-all [{:keys [auth body]}]
        (or (gate auth)
            (when-not (and sql-federation-store credential-store) (guard/error 503 "federation_store_not_supported"))
            (let [source-peer-id (fed/trimmed (fed/field body "sourcePeerId"))
                  provider-id (fed/trimmed (fed/field body "providerId"))]
              (if (or (empty? source-peer-id) (empty? provider-id))
                (guard/error 400 "source_peer_id_and_provider_id_required")
                (let [^js peer (await (.getPeer sql-federation-store source-peer-id))
                      credential (when peer (fed-rt/extract-peer-credential-js (.-auth peer)))]
                  (if (or (not peer) (not credential))
                    (guard/error 400 "peer_or_credential_not_found")
                    (let [control-base-url (or-undefined-str (.-controlBaseUrl peer) (.-baseUrl peer))
                          all (await (.listProjectedAccounts sql-federation-store js/undefined))
                          accounts (filterv (fn [^js a] (and (= (.-sourcePeerId a) source-peer-id) (= (.-providerId a) provider-id)))
                                            (array-seq all))
                          now (js/Date.now)
                          local-expires (atom {})
                          _ (try (doseq [^js provider (array-seq (await (.listProviders credential-store false)))
                                         ^js a (array-seq (.-accounts provider))]
                                   (swap! local-expires assoc [(.-id provider) (.-id a)] (.-expiresAt a)))
                                 (catch :default _ nil))
                          imported (atom 0) failed (atom 0) errors (atom [])]
                      (doseq [^js account accounts]
                        (let [data (interop/js->data account)
                              action (fed/import-all-action data (get @local-expires [(.-providerId account) (.-accountId account)]) now)]
                          (case action
                            :skip nil
                            :fail (do (swap! failed inc) (swap! errors conj (str (.-accountId account) ": credential_non_importable")))
                            :import
                            (try
                              (let [^js remote (await (fetch-federation-json {:url (str control-base-url (p "/federation/accounts/export"))
                                                                               :credential credential :timeout-ms timeout :method "POST"
                                                                               :body {"providerId" (.-providerId account) "accountId" (.-accountId account)}}))
                                    ^js exported (aget remote "account")]
                                (await (upsert-credential! credential-store exported (aget exported "providerId") (aget exported "accountId")))
                                (let [^js marked (await (.markProjectedAccountImported sql-federation-store
                                                                                       #js {:sourcePeerId source-peer-id :providerId (.-providerId account) :accountId (.-accountId account)}))]
                                  (when marked
                                    (await (.appendDiffEvent sql-federation-store
                                                             #js {:ownerSubject (.-ownerSubject marked) :entityType "projected_account"
                                                                  :entityKey (str (.-sourcePeerId marked) ":" (.-providerId marked) ":" (.-accountId marked))
                                                                  :op "mark_imported"
                                                                  :payload #js {:providerId (.-providerId marked) :accountId (.-accountId marked)
                                                                                :availabilityState (.-availabilityState marked) :importedAt (.-importedAt marked)}}))))
                                (swap! imported inc))
                              (catch :default e
                                (swap! failed inc)
                                (swap! errors conj (str (.-accountId account) ": " (err-message e))))))))
                      (await (.catch (.warmup key-pool) (fn [_] js/undefined)))
                      {:body {"imported" @imported "failed" @failed "errors" (vec (take 10 @errors))}}))))))) }

     {:method :get :path (p "/federation/usage-export")
      :handler
      (fn ^:async usage-export [{:keys [auth query]}]
        (or (gate auth)
            (let [since (let [s (get query "sinceMs")] (if (string? s) (params/parse-int s) 0))
                  limit (usage/to-safe-limit (get query "limit") 500 5000)
                  after-ts (let [s (get query "afterTimestampMs")] (when (string? s) (params/parse-int s)))
                  after-id (fed/trimmed-nes (get query "afterId"))
                  safe-since (if (fed/finite-number? since) since 0)
                  after (when (and after-id (number? after-ts) (fed/finite-number? after-ts))
                          #js {:timestampMs after-ts :id after-id})
                  entries (if usage-store
                            (await (.listEntriesSince usage-store safe-since #js {} limit (or-undefined after)))
                            (.snapshotSinceWithLimit request-log-store safe-since limit (or-undefined after)))]
              {:body #js {:entries entries}})))}

     {:method :post :path (p "/federation/usage-import")
      :handler
      (fn ^:async usage-import [{:keys [auth raw]}]
        (or (gate auth)
            (guard/require-present usage-store 503 "request_usage_store_not_supported")
            (let [^js entries (prop (.-body raw) "entries")
                  entries (if (js/Array.isArray entries) entries #js [])]
              (if (zero? (.-length entries))
                (guard/error 400 "entries_required")
                (loop [items (array-seq entries) n 0]
                  (if-let [[candidate & more] (seq items)]
                    (if-let [entry (fed/sanitize-usage-entry (interop/js->data candidate))]
                      (do (await (.upsertEntry usage-store (clj->js entry)))
                          (recur more (inc n)))
                      (recur more n))
                    {:body {"importedCount" n}}))))))}

     {:method :post :path (p "/federation/sync/pull")
      :handler
      (fn ^:async sync-pull [{:keys [auth body raw]}]
        (or (gate auth) (need-federation-store)
            (let [peer-id (fed/trimmed (fed/field body "peerId"))]
              (if (empty? peer-id)
                (guard/error 400 "peer_id_required")
                (let [^js peer (await (.getPeer sql-federation-store peer-id))]
                  (if-not peer
                    (guard/error 404 "peer_not_found")
                    (let [owner-subject (or (fed/trimmed-nes (fed/field body "ownerSubject")) (.-ownerSubject peer))
                          credential (fed-rt/extract-peer-credential-js (.-auth peer))]
                      (if-not credential
                        (do (await (.upsertSyncState sql-federation-store #js {:peerId peer-id :lastError "peer auth credential missing"}))
                            (guard/error 400 "peer_auth_credential_missing"))
                        (let [control-base-url (or-undefined-str (.-controlBaseUrl peer) (.-baseUrl peer))
                              ^js sync-state (await (.getSyncState sql-federation-store peer-id))
                              after-seq (let [s (prop sync-state "lastPulledSeq")] (if (some? s) s 0))
                              requested-since (let [s (fed/field body "sinceMs")]
                                                (cond (fed/finite-number? s) s
                                                      (and sync-state (.-lastPullAt sync-state) (not= "" (.-lastPullAt sync-state))) (js/Date.parse (.-lastPullAt sync-state))
                                                      :else 0))
                              fetch (fn [path] (fetch-federation-json {:url (str control-base-url (p path)) :credential credential :timeout-ms timeout}))]
                          (try
                            (let [[^js remote-diff ^js remote-accounts]
                                  (await (js/Promise.all #js [(fetch (str "/federation/diff-events?ownerSubject=" (js/encodeURIComponent owner-subject)
                                                                          "&afterSeq=" after-seq "&limit=500"))
                                                              (fetch (str "/federation/accounts?ownerSubject=" (js/encodeURIComponent owner-subject)))]))
                                  seen (atom #{}) imported (atom [])
                                  append-record! (fn ^:async append-record! [^js record]
                                                   (let [k (str (.-sourcePeerId record) "\u0000" (.-providerId record) "\u0000" (.-accountId record))]
                                                     (when-not (contains? @seen k)
                                                       (swap! seen conj k)
                                                       (swap! imported conj record)
                                                       (await (.appendDiffEvent sql-federation-store
                                                                                #js {:ownerSubject (.-ownerSubject record) :entityType "projected_account"
                                                                                     :entityKey (str (.-sourcePeerId record) ":" (.-providerId record) ":" (.-accountId record))
                                                                                     :op "upsert"
                                                                                     :payload #js {:providerId (.-providerId record) :accountId (.-accountId record)
                                                                                                   :availabilityState (.-availabilityState record) :sourcePeerId (.-sourcePeerId record)
                                                                                                   :email (.-email record) :chatgptAccountId (.-chatgptAccountId record)}})))))]
                              (doseq [^js account (array-seq (iterable-array (.-localAccounts remote-accounts) "remoteAccounts.localAccounts"))]
                                (let [auth-type (.-authType account)
                                      oauth? (= "oauth_bearer" auth-type)]
                                  (await (append-record!
                                          (await (.upsertProjectedAccount
                                                  sql-federation-store
                                                  #js {:sourcePeerId (.-id peer) :ownerSubject owner-subject :providerId (.-providerId account)
                                                       :accountId (.-accountId account) :accountSubject (.-subject account)
                                                       :chatgptAccountId (.-chatgptAccountId account) :email (.-email account) :planType (.-planType account)
                                                       :availabilityState (if oauth? "remote_route" "descriptor")
                                                       :metadata #js {:hasCredentials (.-hasCredentials account) :knowledgeSources (.-knowledgeSources account)
                                                                      :authType auth-type
                                                                      :credentialMobility (if oauth? "access_token_only" "importable")
                                                                      :refreshAuthority (if oauth? "owner_only" "portable")}}))))))
                              (doseq [^js account (array-seq (iterable-array (.-projectedAccounts remote-accounts) "remoteAccounts.projectedAccounts"))]
                                (let [^js metadata (.-metadata account)
                                      auth-type (let [t (aget metadata "authType")] (if (string? t) t js/undefined))
                                      sources (let [k (aget metadata "knowledgeSources")]
                                                (if (js/Array.isArray k) (.filter k string?) js/undefined))
                                      merged (js/Object.assign #js {} metadata)]
                                  (aset merged "authType" auth-type)
                                  (aset merged "knowledgeSources" sources)
                                  (await (append-record!
                                          (await (.upsertProjectedAccount
                                                  sql-federation-store
                                                  #js {:sourcePeerId (.-id peer) :ownerSubject owner-subject :providerId (.-providerId account)
                                                       :accountId (.-accountId account) :accountSubject (.-accountSubject account)
                                                       :chatgptAccountId (.-chatgptAccountId account) :email (.-email account) :planType (.-planType account)
                                                       :availabilityState (.-availabilityState account) :metadata merged}))))))
                              (let [imported-usage
                                    (if (and (not (false? (prop (.-body raw) "pullUsage"))) usage-store)
                                      (loop [cursor nil total 0]
                                        (let [q (js/URLSearchParams. #js {:sinceMs (str (if (fed/finite-number? requested-since) requested-since 0)) :limit "5000"})
                                              _ (when cursor
                                                  (.set q "afterTimestampMs" (str (:ts cursor)))
                                                  (.set q "afterId" (:id cursor)))
                                              ^js remote-usage (await (fetch (str "/federation/usage-export?" (.toString q))))
                                              entries (iterable-array (.-entries remote-usage) "remoteUsage.entries")
                                              [total' last-entry]
                                              (loop [items (array-seq entries) n total last nil]
                                                (if-let [[candidate & more] (seq items)]
                                                  (if-let [entry (fed/sanitize-usage-entry (interop/js->data candidate))]
                                                    (do (await (.upsertEntry usage-store (clj->js entry)))
                                                        (recur more (inc n) entry))
                                                    (recur more n last))
                                                  [n last]))]
                                          (if (or (< (.-length entries) 5000) (nil? last-entry))
                                            total'
                                            (recur {:ts (get last-entry "timestamp") :id (get last-entry "id")} total'))))
                                      0)
                                    events (let [e (.-events remote-diff)]
                                             (if (and e (fn? (.-reduce ^js e))) e (throw (js/TypeError. "remoteDiff.events.reduce is not a function"))))
                                    highest (.reduce ^js events (fn [cur ^js ev] (js/Math.max cur (.-seq ev))) after-seq)
                                    ^js next-state (await (.upsertSyncState sql-federation-store
                                                                            #js {:peerId peer-id :lastPulledSeq highest :lastPullAt true :lastError nil}))]
                                {:body #js {:peer peer :ownerSubject owner-subject
                                            :importedProjectedAccountsCount (count @imported) :importedUsageCount imported-usage
                                            :remoteDiffCount (.-length events) :syncState next-state}}))
                            (catch :default e
                              (let [detail (err-message e)]
                                (await (.upsertSyncState sql-federation-store #js {:peerId peer-id :lastError detail}))
                                {:status 502 :body {"error" "federation_pull_failed" "detail" detail}}))))))))))))}

     {:method :post :path (p "/federation/projected-accounts/routed")
      :handler
      (fn ^:async note-routed [{:keys [auth body]}]
        (or (gate auth) (need-federation-store)
            (let [s (fn [k] (fed/trimmed (fed/field body k)))
                  source-peer-id (s "sourcePeerId") provider-id (s "providerId") account-id (s "accountId")]
              (if (some empty? [source-peer-id provider-id account-id])
                (guard/error 400 "source_peer_id_provider_id_and_account_id_required")
                (let [key #js {:sourcePeerId source-peer-id :providerId provider-id :accountId account-id}
                      ^js account (await (.noteProjectedAccountRouted sql-federation-store key))]
                  (if-not account
                    (guard/error 404 "projected_account_not_found")
                    (let [allow-import? (fed/projected-allows-credential-import? (interop/js->data account))
                          [^js acct imported?]
                          (if (and allow-import? (should-warm-import (.-warmRequestCount account)))
                            (let [^js result (await (warm-import! deps-map key))]
                              (if result
                                [(.-account result) (.-importedCredential result)]
                                (let [^js latest (await (.getProjectedAccount sql-federation-store key))]
                                  (if latest
                                    [latest (= "imported" (.-availabilityState latest))]
                                    [account false]))))
                            [account false])]
                      (await (.appendDiffEvent sql-federation-store
                                               #js {:ownerSubject (.-ownerSubject acct) :entityType "projected_account"
                                                    :entityKey (str (.-sourcePeerId acct) ":" (.-providerId acct) ":" (.-accountId acct))
                                                    :op "note_routed"
                                                    :payload #js {:providerId (.-providerId acct) :accountId (.-accountId acct)
                                                                  :availabilityState (.-availabilityState acct) :warmRequestCount (.-warmRequestCount acct)
                                                                  :importedCredential imported? :credentialImportAllowed allow-import?}}))
                      {:body #js {:account acct :importedCredential imported?}})))))))}

     {:method :post :path (p "/federation/projected-accounts/imported")
      :handler
      (fn ^:async mark-imported [{:keys [auth body]}]
        (or (gate auth) (need-federation-store)
            (let [s (fn [k] (fed/trimmed (fed/field body k)))
                  source-peer-id (s "sourcePeerId") provider-id (s "providerId") account-id (s "accountId")]
              (if (some empty? [source-peer-id provider-id account-id])
                (guard/error 400 "source_peer_id_provider_id_and_account_id_required")
                (let [key #js {:sourcePeerId source-peer-id :providerId provider-id :accountId account-id}
                      existing (await (.getProjectedAccount sql-federation-store key))]
                  (if (and existing (not (fed/projected-allows-credential-import? (interop/js->data existing))))
                    {:status 409 :body {"error" "credential_non_importable"
                                        "detail" "oauth_bearer projected accounts are route-only and cannot be marked imported"}}
                    (let [^js account (await (.markProjectedAccountImported sql-federation-store key))]
                      (if-not account
                        (guard/error 404 "projected_account_not_found")
                        (do (await (.appendDiffEvent sql-federation-store
                                                     #js {:ownerSubject (.-ownerSubject account) :entityType "projected_account"
                                                          :entityKey (str (.-sourcePeerId account) ":" (.-providerId account) ":" (.-accountId account))
                                                          :op "mark_imported"
                                                          :payload #js {:providerId (.-providerId account) :accountId (.-accountId account)
                                                                        :availabilityState (.-availabilityState account) :importedAt (.-importedAt account)}}))
                            {:body #js {:account account}}))))))))) }

     {:method :get :path (p "/federation/tenant-provider-policies")
      :handler (fn ^:async list-policies [{:keys [auth query]}]
                 (or (gate auth)
                     (guard/require-present policy-store 503 "tenant_provider_policy_store_not_supported")
                     {:body #js {:policies (await (.listPolicies policy-store
                                                                 (clj->js (cond-> {}
                                                                            (fed/trimmed-nes (get query "ownerSubject")) (assoc :ownerSubject (fed/trimmed-nes (get query "ownerSubject")))
                                                                            (fed/trimmed-nes (get query "subjectDid")) (assoc :subjectDid (fed/trimmed-nes (get query "subjectDid")))))))}}))}

     {:method :post :path (p "/federation/tenant-provider-policies")
      :handler
      (fn ^:async upsert-policy [{:keys [auth body raw]}]
        (or (gate auth)
            (guard/require-present policy-store 503 "tenant_provider_policy_store_not_supported")
            (let [s (fn [k] (fed/trimmed (fed/field body k)))
                  subject-did (s "subjectDid") provider-id (s "providerId") owner-subject (s "ownerSubject")]
              (if (some empty? [subject-did provider-id owner-subject])
                (guard/error 400 "subject_did_provider_id_and_owner_subject_required")
                (let [^js rb (.-body raw)
                      str-field (fn [k] (let [v (prop rb k)] (when (string? v) v)))
                      allowed (let [a (prop rb "allowedModels")] (if (js/Array.isArray a) (.filter a string?) js/undefined))
                      positive (fn [k] (let [r (ui-auth/parse-optional-positive-integer (let [v (fed/field body k)] v))] (or-undefined r)))
                      input (js-obj)]
                  (doseq [[k v] [["subjectDid" subject-did] ["providerId" provider-id]
                                 ["providerKind" (if-let [v (str-field "providerKind")] (sql/tenant-policy-kind-js v) js/undefined)]
                                 ["ownerSubject" owner-subject]
                                 ["shareMode" (if-let [v (str-field "shareMode")] (sql/tenant-policy-share-mode-js v) js/undefined)]
                                 ["trustTier" (if-let [v (str-field "trustTier")] (sql/tenant-policy-trust-tier-js v) js/undefined)]
                                 ["allowedModels" allowed]
                                 ["maxRequestsPerMinute" (positive "maxRequestsPerMinute")]
                                 ["maxConcurrentRequests" (positive "maxConcurrentRequests")]
                                 ["encryptedChannelRequired" (prop rb "encryptedChannelRequired")]
                                 ["warmImportThreshold" (positive "warmImportThreshold")]
                                 ["notes" (or-undefined (str-field "notes"))]]]
                    (aset input k v))
                  {:status 201 :body #js {:policy (await (.upsertPolicy policy-store input))}})))))}]))

(defn register-federation-routes-js
  "`deps`: the host collaborator bag (see `routes`); `prefix`: e.g. /api/v1."
  [app ^js deps prefix]
  (ring/register!
   app
   (routes {:env (.-env deps)
            :openai-provider-id (.-openaiProviderId deps)
            :sql-federation-store (.-sqlFederationStore deps)
            :policy-store (.-sqlTenantProviderPolicyStore deps)
            :usage-store (.-sqlRequestUsageStore deps)
            :sql-credential-store (.-sqlCredentialStore deps)
            :credential-store (.-credentialStore deps)
            :key-pool (.-keyPool deps)
            :request-log-store (.-requestLogStore deps)
            :bridge-relay (.-bridgeRelay deps)
            :timeout-ms (.-federationRequestTimeoutMs deps)
            :refresh-oauth (.-refreshOpenAiOauthAccounts deps)
            :should-warm-import (.-shouldWarmImportProjectedAccount deps)
            :log (.-log deps)}
           prefix)))
