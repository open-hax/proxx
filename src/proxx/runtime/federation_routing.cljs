(ns proxx.runtime.federation-routing
  "Edge of bridged and federated request routing (formerly
  src/lib/federation/bridge-routing.ts and federated-routing.ts).

  The decisions are pure: which sessions may serve (proxx.federation.routing),
  what the reply does as a bridged response arrives (proxx.federation.bridge-reply),
  what a warm import does and how a peer's reply reaches the client
  (proxx.federation.federated). This namespace gathers the facts (stores, relay,
  fetch), applies the effects to the Fastify reply and sequences them.

  Host collaborators arrive as plain objects:
    bridge deps    {bridgeRelay app config runtimeCredentialStore keyPool sqlTenantProviderPolicyStore}
    federated deps {app cljsPolicyManifestPath sqlFederationStore runtimeCredentialStore keyPool
                    sqlTenantProviderPolicyStore}"
  (:require ["node:path" :as path]
            ["node:stream" :as node-stream]
            [clojure.string :as str]
            [proxx.credentials.federation :as store-rules]
            [proxx.federation.bridge-reply :as reply-plan]
            [proxx.federation.federated :as federated]
            [proxx.federation.helpers :as helpers]
            [proxx.federation.routing :as routing]
            [proxx.runtime :as policy]
            [proxx.runtime.federation :as fed]
            [proxx.runtime.federation-projections :as projections]
            [proxx.runtime.http :as http]
            [proxx.runtime.proxy :as proxy]
            [proxx.runtime.routing :as rt-routing]))

(def ^:private default-manifest "resources/policies/runtime/00-manifest.edn")

(defn- error-message [e] (if (instance? js/Error e) (.-message e) (js/String e)))

(defn- env-manifest-path
  "Absolute path of the policy manifest named by the PROXX_/PROXY_CLJS_POLICY_MANIFEST aliases
  (else the default). Same rule as proxx.app.entry/policy-manifest-path, which cannot be
  required from here (it requires the application, which requires this)."
  []
  (let [configured (some (fn [k] (let [v (aget js/process.env k)]
                                   (when (and (string? v) (seq (str/trim v))) (str/trim v))))
                         ["PROXX_CLJS_POLICY_MANIFEST" "PROXY_CLJS_POLICY_MANIFEST"])]
    (.resolve path (js/process.cwd) (or configured "./resources/policies/runtime/00-manifest.edn"))))

(defn- authorize-policy?
  "Does the CLJS policy contract let `policy` serve `input` ({ownerSubject providerKind requestedModel
  requestKind requiredShareMode})? Anything but an affirmative answer is a no."
  [manifest-path policy input]
  (let [^js result (policy/authorize-tenant-provider-policy-js
                    manifest-path (js/Object.assign #js {"policy" policy} input))]
    (and (= "ok" (.-status result)) (true? (.-allowed result)))))

(defn- ^:async tenant-policy
  "What the tenant-provider policy says about using `provider-id`: ::no-policy when none applies
  (no subject DID or no store), ::refused when there is none on record or the contract refuses,
  else the policy record."
  [^js store subject-did provider-id authorized?]
  (if (or (nil? subject-did) (nil? store))
    ::no-policy
    (let [policy (await (.getPolicy store subject-did provider-id))]
      (cond (not policy) ::refused
            (authorized? policy) policy
            :else ::refused))))

;; ---------------------------------------------------------------------------
;; Bridged routing: send the request to a connected bridge agent
;; ---------------------------------------------------------------------------

(defn- apply-effect!
  "Interpret one reply-plan effect on the Fastify reply `reply`; the raw response, once
  hijacked, lives in the `raw` atom. Chunks are buffered into `buffered`."
  [^js reply raw buffered {:keys [op] :as effect}]
  (case op
    :set-headers (doseq [[name value] (:pairs effect)] (.header reply name value))
    :remove-header (.removeHeader reply (:name effect))
    :status (.code reply (:code effect))
    :hijack (do (.hijack reply)
                (let [^js res (.-raw reply)
                      headers (.getHeaders reply)]
                  (reset! raw res)
                  (aset res "statusCode" (:status effect))
                  (doseq [name (js/Object.keys headers)]
                    (let [value (aget headers name)]
                      (when-not (undefined? value) (.setHeader res name value))))
                  (.flushHeaders res)))
    :write (.write ^js @raw (js/Buffer.from (:chunk effect) (if (= "base64" (:encoding effect)) "base64" "utf8")))
    :buffer (swap! buffered conj (js/Buffer.from (:chunk effect) (if (= "base64" (:encoding effect)) "base64" "utf8")))))

(defn- ^:async relay-through-session
  "Stream the request through one session and shape the reply. Resolves true when the reply is
  (or is being) served, false when the next session should be tried. Reply effects are applied
  as events arrive; `started?` records that the client has seen a reply."
  [^js bridge-relay ^js app ^js reply ^js session request-input started?]
  (let [{:keys [session-id owner-subject tenant-id requested-model body-text request-headers upstream-path timeout-ms]} request-input
        raw (atom nil)
        buffered (atom [])
        state (atom reply-plan/initial)
        ctx {:owner-subject owner-subject
             :peer-label (routing/routed-peer-label (.-clusterId session) (.-agentId session))}
        apply! (fn [effect] (apply-effect! reply raw buffered effect))]
    (try
      (let [events (.requestStream bridge-relay session-id
                                   (clj->js (cond-> {:method "POST" :path upstream-path :timeoutMs timeout-ms
                                                     :headers {"accept" (let [a (get request-headers "accept")]
                                                                          (if (string? a) a "application/json"))
                                                               "content-type" "application/json"}
                                                     :body body-text
                                                     :requestContext {:tenantId tenant-id}}
                                              requested-model (assoc :routingIntent {:model requested-model}))))]
        (await (fed/consume-async-iterable
                events
                (fn [event]
                  (let [[state' effects] (reply-plan/step @state (fed/js->wire event) ctx)]
                    (when (seq effects) (reset! started? true))
                    (reset! state state')
                    (run! apply! effects)
                    nil))))
        (let [end (reply-plan/finish @state)]
          (case (:op end)
            :end-stream (do (when-not (.-writableEnded ^js @raw) (.end ^js @raw)) true)
            :send (let [body (.toString (js/Buffer.concat (to-array @buffered)) "utf8")
                        parsed (if (:json? end) (http/parse-json-if-possible-js body) js/undefined)]
                    (.send reply (if (undefined? parsed) body parsed))
                    true))))
      (catch :default error
        (when (and @raw (not (.-writableEnded ^js @raw))) (.end ^js @raw))
        (.warn (.-log app) #js {:error (error-message error) :sessionId session-id :upstreamPath upstream-path}
               "bridged request attempt failed")
        (boolean @started?)))))

(defn ^:async execute-bridge-request-routing
  "Serve the request through a connected bridge agent that advertises the path, model and a
  permitted tenant policy. Resolves true when the reply was served by a bridge, false when the
  caller should route locally."
  [^js deps ^js input]
  (let [^js bridge-relay (.-bridgeRelay deps)
        ^js app (.-app deps)
        ^js config (.-config deps)
        ^js store (.-sqlTenantProviderPolicyStore deps)
        ^js request-headers (.-requestHeaders input)
        ^js request-body (.-requestBody input)
        ^js reply (.-reply input)
        upstream-path (.-upstreamPath input)
        hop-count (fed/resolve-federation-hop-count-js request-headers)]
    (cond
      (nil? bridge-relay) false

      (routing/hop-limit-exceeded? hop-count)
      (do (.warn (.-log app) #js {:hopCount hop-count :upstreamPath upstream-path}
                 "bridge request rejected: hop limit exceeded")
          false)

      :else
      (let [request-auth (fed/js->wire (.-requestAuth input))
            owner-subject (fed/resolve-federation-owner-subject-js
                           #js {:headers request-headers :requestAuth (.-requestAuth input) :hopCount hop-count}
                           (aget js/process.env "FEDERATION_DEFAULT_OWNER_SUBJECT"))
            tenant-id (routing/bridge-tenant-id request-auth)]
        (if (or (not (seq owner-subject)) (not (seq tenant-id)))
          false
          (let [requested-model (http/normalize-requested-model-js (.-model request-body))
                subject-did (routing/subject-did request-auth)
                manifest (or (.-cljsPolicyManifestPath config) default-manifest)
                capability-manifest (env-manifest-path)
                request-kind (.-requestKind input)
                resolve-policy (fn [provider-id]
                                 (tenant-policy store subject-did provider-id
                                                #(authorize-policy? manifest %
                                                                    #js {:ownerSubject owner-subject :providerKind "peer_proxx"
                                                                         :requestedModel requested-model :requestKind request-kind
                                                                         :requiredShareMode "relay"})))
                normalized-path (routing/normalized-path upstream-path)
                allowed (routing/allowed-provider-ids (array-seq (or (.-allowedProviderIds input) #js [])))
                eligible (filterv #(routing/session-eligible? (fed/js->wire %) owner-subject tenant-id)
                                  (array-seq (.listSessions bridge-relay)))
                serving (->> (await (js/Promise.all
                                     (to-array
                                      (map (fn ^:async serves [^js session]
                                             (loop [caps (array-seq (.-capabilities session))]
                                               (when-let [^js capability (first caps)]
                                                 (if (and (routing/capability-admissible? (fed/js->wire capability) allowed)
                                                          (rt-routing/bridge-capability-supports-path-js capability-manifest capability normalized-path)
                                                          (rt-routing/bridge-capability-supports-model-js capability requested-model)
                                                          (not= ::refused (await (resolve-policy (.-providerId capability)))))
                                                   session
                                                   (recur (rest caps))))))
                                           eligible))))
                             (filterv some?))]
            (if (empty? serving)
              false
              (let [body-text (js/JSON.stringify request-body)
                    started? (atom false)]
                (loop [sessions serving]
                  (if-let [^js session (first sessions)]
                    (if (await (relay-through-session
                                bridge-relay app reply session
                                {:session-id (.-sessionId session) :owner-subject owner-subject :tenant-id tenant-id
                                 :requested-model requested-model :body-text body-text :request-headers (fed/js->wire request-headers)
                                 :upstream-path upstream-path :timeout-ms (.-timeoutMs input)}
                                started?))
                      true
                      (recur (rest sessions)))
                    false)))))))))) 

;; ---------------------------------------------------------------------------
;; Serving a request that arrived over the bridge
;; ---------------------------------------------------------------------------

(defn- async-iterable
  "An AsyncIterable over what `pull!` yields. `pull!` is an async fn returning a vector of
  items (possibly empty) or nil once the source is exhausted; items are handed out in order."
  [pull!]
  (let [queue (atom [])
        done? (atom false)
        iterator (js-obj)]
    (aset iterator "next"
          (fn ^:async next []
            (loop []
              (cond
                (seq @queue) (let [item (first @queue)]
                               (swap! queue subvec 1)
                               #js {:value (clj->js item) :done false})
                @done? #js {:value js/undefined :done true}
                :else (let [items (await (pull!))]
                        (if (nil? items) (reset! done? true) (swap! queue into items))
                        (recur))))))
    (aset iterator "return" (fn [] (reset! done? true) (reset! queue []) (js/Promise.resolve #js {:value js/undefined :done true})))
    (let [iterable (js-obj)]
      (aset iterable js/Symbol.asyncIterator (fn [] iterator))
      iterable)))

(defn- self-env
  "The federation self-identity variables as a map (process.env is not a plain object, so it
  is read by key)."
  []
  (into {} (keep (fn [k] (when-let [v (aget js/process.env k)] [k v])))
        ["FEDERATION_SELF_CLUSTER_ID" "FEDERATION_SELF_GROUP_ID" "FEDERATION_SELF_NODE_ID"]))

(defn- response-events-source
  "The `pull!` of the response events for an in-process fetch `response`: head, then each
  chunk (UTF-8 text for textual content types, base64 otherwise), then end."
  [^js response env]
  (let [headers (js-obj)
        _ (.forEach (.-headers response) (fn [value name] (aset headers name value)))
        provenance (reply-plan/provenance env (aget headers "x-open-hax-upstream-provider"))
        decoder (when (and (.-body response)
                           (routing/utf8-chunk-encoding? (or (.get (.-headers response) "content-type") "")))
                  (js/TextDecoder. "utf8"))
        reader (atom nil)
        phase (atom :head)
        chunk-events (fn [^js value]
                       (if decoder
                         (let [text (.decode decoder value #js {:stream true})]
                           (if (pos? (count text)) [(reply-plan/chunk-event provenance text "utf8")] []))
                         [(reply-plan/chunk-event provenance (.toString (js/Buffer.from value) "base64") "base64")]))]
    (fn ^:async pull []
      (case @phase
        :head (do (reset! phase (if (.-body response) :body :end))
                  [(reply-plan/head-event provenance (.-status response) (fed/js->wire headers))])
        :body (do (when-not @reader (reset! reader (.getReader (.-body response))))
                  (let [^js r (await (.read ^js @reader))]
                    (cond
                      (.-done r) (do (reset! phase :end)
                                     (let [tail (when decoder (.decode decoder))]
                                       (if (and tail (pos? (count tail)))
                                         [(reply-plan/chunk-event provenance tail "utf8")]
                                         [])))
                      (or (nil? (.-value r)) (zero? (.-length ^js (.-value r)))) []
                      :else (chunk-events (.-value r)))))
        :end (do (reset! phase :done) [(reply-plan/end-event provenance)])
        nil))))

(defn- served-by-self [env]
  (reply-plan/provenance env nil))

(defn- buffered-response
  "The buffered bridge response for an in-process `injected` reply."
  [^js injected env]
  (let [headers (js-obj)]
    (doseq [name (js/Object.keys (.-headers injected))]
      (let [value (aget (.-headers injected) name)]
        (when (string? value) (aset headers name value))))
    (let [out (js-obj "status" (.-statusCode injected) "headers" headers "body" (.-body injected) "encoding" "utf8")]
      (doseq [[k v] (reply-plan/provenance env (aget headers "x-open-hax-upstream-provider"))]
        (aset out k v))
      out)))

(defn ^:async handle-bridge-request
  "Serve a request that arrived over the bridge through the local application: refused
  unless the path is an allowed API path, otherwise a streaming response (an async iterable of
  events) when the app listens on a port, else a buffered one."
  [^js deps ^js input]
  (let [^js app (.-app deps)
        method (.-method input)
        req-path (.-path input)
        owner-subject (.-ownerSubject input)
        env (self-env)]
    (if-not (routing/bridge-path-allowed? req-path)
      (do (.warn (.-log app) #js {:path req-path :ownerSubject owner-subject}
                 "bridge request rejected: path not in allowed list")
          (let [out #js {:status 403
                         :headers #js {"content-type" "application/json"}
                         :body (js/JSON.stringify (clj->js routing/bridge-forbidden-body))}]
            (doseq [[k v] (served-by-self env)] (aset out k v))
            out))
      (let [^js in-headers (.-headers input)
            headers (clj->js (routing/bridge-request-headers
                              {:accept (aget in-headers "accept") :content-type (aget in-headers "content-type")
                               :owner-subject owner-subject :tenant-id (.-tenantId input)}))
            body-text (.-bodyText input)
            payload (if (pos? (count body-text)) body-text js/undefined)
            address (.address (.-server app))]
        (if (and address (not (string? address)))
          (let [^js response (await (js/fetch (str "http://127.0.0.1:" (.-port address) req-path)
                                              #js {:method method :headers headers :body payload}))]
            (async-iterable (response-events-source response env)))
          (let [^js injected (await (.inject app #js {:method method :url req-path :headers headers :payload payload}))]
            (buffered-response injected env)))))))

(defn ^:async inject-native-bridge
  "Re-inject a native Ollama call as an in-process POST to `url` under the proxy's own auth."
  [^js deps url payload ^js request-headers]
  (let [^js app (.-app deps)
        ^js config (.-config deps)
        headers (reply-plan/native-injection-headers (.-proxyAuthToken config) (some-> request-headers (aget "authorization")))]
    (await (.inject app #js {:method "POST" :url url :headers (clj->js headers) :payload payload}))))

;; ---------------------------------------------------------------------------
;; Federation JSON fetch
;; ---------------------------------------------------------------------------

(defn ^:async fetch-federation-json
  "GET/POST JSON to a peer ({url credential timeoutMs method body}); the parsed payload, or an
  Error carrying the peer's own failure message."
  [^js input]
  (let [^js response (await (http/fetch-with-response-timeout-js
                             (.-url input)
                             #js {:method (or (.-method input) "GET")
                                  :headers (fed/federation-json-request-headers-js (.-credential input))
                                  :body (if-let [body (.-body input)] (js/JSON.stringify body) js/undefined)}
                             (.-timeoutMs input)))
        text (await (.text response))
        parsed (if (pos? (count text)) (js/JSON.parse text) #js {})]
    (when-not (.-ok response)
      (throw (js/Error. (fed/federation-failure-message-js parsed (.-status response)))))
    parsed))

;; ---------------------------------------------------------------------------
;; Federated routing: forward the request to a peer holding a projected account
;; ---------------------------------------------------------------------------

(defn- account-key [^js account]
  #js {:sourcePeerId (.-sourcePeerId account) :providerId (.-providerId account) :accountId (.-accountId account)})

(defn- ^:async fetch-export
  "The peer's credential export, from the v1 path, falling back to the legacy UI path."
  [^js peer credential export-body timeout-ms]
  (let [[export-url legacy-url] (routing/export-urls (fed/js->wire peer))
        fetch (fn [url] (fetch-federation-json #js {:url url :credential credential :timeoutMs timeout-ms
                                                    :method "POST" :body export-body}))]
    (try (await (fetch export-url))
         (catch :default _ (await (fetch legacy-url))))))

(defn- ^:async store-exported-account!
  [^js credential-store ^js key-pool ^js account]
  (let [{:keys [store args]} (federated/credential-write (fed/js->wire account))
        method (if (= :oauth store) "upsertOAuthAccount" "upsertApiKeyAccount")]
    (await (.apply (aget credential-store method) credential-store (to-array args)))
    (await (.catch (.warmup key-pool) (fn [_] js/undefined)))))

(defn- ^:async import-under-lock
  "Inside the import lock: re-read the account and, if it still needs it, fetch the peer's
  credential, store it locally and mark the account imported. Resolves
  {:imported? :account}, or nil when the account vanished."
  [^js deps ^js tx timeout-ms ^js projected]
  (let [^js store (.-sqlFederationStore deps)
        ^js app (.-app deps)
        ^js latest (await (.getProjectedAccount store (account-key projected) tx))]
    (if-let [settled (federated/settled-before-import (fed/js->wire latest))]
      (when (= :already-imported settled) {:imported? false :account latest})
      (let [^js peer (await (.getPeer store (.-sourcePeerId latest) tx))
            credential (when peer (helpers/extract-peer-credential (fed/js->wire (.-auth peer))))]
        (if-not (federated/importable? peer credential)
          {:imported? false :account latest}
          (try
            (let [^js remote (await (fetch-export peer credential
                                                  #js {:providerId (.-providerId latest) :accountId (.-accountId latest)}
                                                  timeout-ms))]
              (await (store-exported-account! (.-runtimeCredentialStore deps) (.-keyPool deps) (.-account remote)))
              (let [imported (await (.markProjectedAccountImported store (account-key latest) tx))]
                {:imported? true :account (or imported latest)}))
            (catch :default error
              (.warn (.-log app) #js {:error (error-message error) :sourcePeerId (.-sourcePeerId latest)
                                      :providerId (.-providerId latest) :accountId (.-accountId latest)}
                     "failed warm federation credential import during request routing")
              {:imported? false :account latest})))))))

(defn- warm-import-threshold
  "The policy's own threshold, else the environment's (FEDERATION_WARM_IMPORT_REQUEST_THRESHOLD)."
  [^js policy]
  (let [own (when policy (.-warmImportThreshold policy))]
    (if (or (nil? policy) (undefined? own))
      (store-rules/warm-import-threshold (aget js/process.env "FEDERATION_WARM_IMPORT_REQUEST_THRESHOLD"))
      own)))

(defn- ^:async note-routed!
  "Record that a projected account served a request and, when policy allows and the account has
  been used enough, warm-import its credential. Resolves {:imported? :account}."
  [^js deps {:keys [^js projected-account timeout-ms request-kind ^js policy]}]
  (let [^js store (.-sqlFederationStore deps)
        manifest (or (.-cljsPolicyManifestPath deps) default-manifest)
        noted (await (.noteProjectedAccountRouted store (account-key projected-account)))
        ^js account (or noted projected-account)
        allowed? (routing/warm-import-allowed?
                  (some? policy)
                  (and (some? policy)
                       (authorize-policy? manifest policy
                                          #js {:ownerSubject (.-ownerSubject policy) :providerKind (.-providerKind policy)
                                               :requestKind request-kind :requiredShareMode "warm_import"})))
        result (if (and allowed? (store-rules/should-warm-import? (.-warmRequestCount account) (warm-import-threshold policy)))
                 (let [outcome (atom nil)
                       locked (await (.withProjectedAccountImportLock
                                      store (account-key account)
                                      (fn ^:async under-lock [tx]
                                        (reset! outcome (await (import-under-lock deps tx timeout-ms account)))
                                        (if @outcome #js {} js/undefined))))]
                   (if (some? locked)
                     @outcome
                     (let [^js latest (await (.getProjectedAccount store (account-key account)))]
                       (if latest
                         {:imported? (= "imported" (.-availabilityState latest)) :account latest}
                         {:imported? false :account account}))))
                 {:imported? false :account account})]
    (await (.appendDiffEvent store (clj->js (routing/routed-diff-event (fed/js->wire (:account result)) (:imported? result)))))
    result))

(defn- ^:async projected-candidates
  "Projected accounts, ordered by the policy contract, that a configured and permitted peer can serve."
  [^js deps ^js peers-by-id owner-subject credential-of resolve-policy order]
  (let [^js store (.-sqlFederationStore deps)
        accounts (order (await (.getProjectedAccountsForOwner store owner-subject)))
        candidates (await (js/Promise.all
                           (to-array
                            (map (fn ^:async candidate [^js account]
                                   (let [peer (.get peers-by-id (.-sourcePeerId account))
                                         credential (when peer (credential-of peer))]
                                     (when (federated/importable? peer credential)
                                       (let [policy (await (resolve-policy (.-providerId account)))]
                                         (when-not (= ::refused policy)
                                           {:peer peer :credential credential :account account
                                            :policy (when-not (= ::no-policy policy) policy)})))))
                                 accounts))))]
    (filterv some? candidates)))

(defn- ^:async stream-to-reply
  "Send a peer's successful `response` to the client under the routing headers."
  [^js reply ^js response owner-subject peer-id projected imported?]
  (let [pairs (let [acc (array)] (.forEach (.-headers response) (fn [v n] (.push acc #js [n v]))) (mapv vec (array-seq acc)))
        content-type (or (.get (.-headers response) "content-type") "")]
    (doseq [[name value] (federated/reply-header-pairs pairs owner-subject peer-id (fed/js->wire projected) imported?)]
      (.header reply name value))
    (.code reply (.-status response))
    (case (federated/reply-mode (some? (.-body response)) content-type)
      :text (.send reply (await (.text response)))
      :stream (do (.removeHeader reply "content-length")
                  (.send reply (.fromWeb node-stream/Readable (.-body response))))
      :buffer (.send reply (js/Buffer.from (await (.arrayBuffer response)))))
    true))

(defn ^:async execute-federated-request-routing
  "Forward the request to a peer that holds a projected account for one of the local providers,
  trying candidates in policy order. Resolves true when a peer's reply was served, false when
  the caller should route locally. `collaborators` supplies {resolveFederationRoutePath}."
  [^js deps ^js input ^js collaborators]
  (let [^js store (.-sqlFederationStore deps)
        ^js app (.-app deps)
        ^js request-headers (.-requestHeaders input)
        ^js request-body (.-requestBody input)
        ^js reply (.-reply input)
        upstream-path (.-upstreamPath input)
        hop-count (fed/resolve-federation-hop-count-js request-headers)
        request-auth (fed/js->wire (.-requestAuth input))
        owner-subject (when (and store (not (routing/hop-limit-exceeded? hop-count)))
                        (fed/resolve-federation-owner-subject-js
                         #js {:headers request-headers :requestAuth (.-requestAuth input) :hopCount hop-count}
                         (aget js/process.env "FEDERATION_DEFAULT_OWNER_SUBJECT")))
        local-provider-ids (routing/local-provider-ids (mapv #(.-providerId ^js %) (array-seq (.-providerRoutes input))))]
    (if (or (not (seq owner-subject)) (empty? local-provider-ids))
      false
      (let [^js policy-store (.-sqlTenantProviderPolicyStore deps)
            manifest (or (.-cljsPolicyManifestPath deps) default-manifest)
            request-kind (.-requestKind input)
            timeout-ms (.-timeoutMs input)
            requested-model (http/normalize-requested-model-js (.-model request-body))
            subject-did (routing/subject-did request-auth)
            resolve-policy (fn [provider-id]
                             (tenant-policy policy-store subject-did provider-id
                                            #(authorize-policy? manifest %
                                                                #js {:ownerSubject owner-subject :providerKind "local_upstream"
                                                                     :requestedModel requested-model :requestKind request-kind
                                                                     :requiredShareMode "relay"})))
            peers (await (.listPeers store owner-subject))
            peers-by-id (let [m (js/Map.)]
                          (doseq [^js peer (array-seq peers)
                                  :when (routing/active-peer? (fed/js->wire peer))]
                            (.set m (.-id peer) peer))
                          m)
            local-account-keys (into #{}
                                     (mapcat (fn [^js provider]
                                               (map (fn [^js account] (routing/local-account-key (.-id provider) (.-id account)))
                                                    (array-seq (.-accounts provider)))))
                                     (array-seq (await (.catch (.listProviders ^js (.-runtimeCredentialStore deps) false)
                                                               (fn [_] #js [])))))
            now (js/Date.now)
            order (fn [accounts]
                    (let [^js result (policy/resolve-federation-route-candidates-js
                                      manifest
                                      #js {:requestKind request-kind :providerIds (to-array local-provider-ids)
                                           :projectedAccounts accounts :localProviderAccountKeys (to-array local-account-keys)
                                           :nowMs now})]
                      (if (and (= "ok" (.-status result)) (array? (.-candidates result)))
                        (array-seq (.-candidates result))
                        [])))
            credential-of #(helpers/extract-peer-credential (fed/js->wire (.-auth ^js %)))
            ensure-fresh! (fn []
                            (.catch (projections/ensure-projected-accounts-fresh-js
                                     #js {:logger (.-log app) :sqlFederationStore store :ownerSubject owner-subject
                                          :timeoutMs (min timeout-ms 10000)}
                                     #js {:fetchFederationJson fetch-federation-json
                                          :resolveFederationRoutePath (.-resolveFederationRoutePath collaborators)})
                                    (fn [_] js/undefined)))
            build! #(projected-candidates deps peers-by-id owner-subject credential-of resolve-policy order)
            _ (await (ensure-fresh!))
            candidates (let [first-pass (await (build!))]
                         (if (seq first-pass)
                           first-pass
                           (do (await (ensure-fresh!)) (await (build!)))))]
        (if (empty? candidates)
          false
          (let [body-text (js/JSON.stringify request-body)]
            (loop [remaining candidates]
              (if-let [{:keys [^js peer credential ^js account policy]} (first remaining)]
                (let [headers (js/Headers. (proxy/forward-headers-js request-headers))
                      _ (doseq [[name value] (routing/forwarded-request-overrides credential hop-count owner-subject (fed/js->wire account))]
                          (.set headers name value))
                      response (try
                                 (await (http/fetch-with-response-timeout-js
                                         (str (.-baseUrl peer) upstream-path)
                                         #js {:method "POST" :headers headers :body body-text :signal (.-signal input)}
                                         timeout-ms))
                                 (catch :default error
                                   (.warn (.-log app) #js {:error (error-message error) :peerId (.-id peer) :upstreamPath upstream-path
                                                           :providerId (.-providerId account) :accountId (.-accountId account)}
                                          "federated request attempt failed before response")
                                   nil))]
                  (cond
                    (nil? response) (recur (rest remaining))

                    (not (.-ok ^js response))
                    (do (try (await (.arrayBuffer ^js response)) (catch :default _ nil))
                        (.warn (.-log app) #js {:peerId (.-id peer) :status (.-status ^js response)
                                                :providerId (.-providerId account) :accountId (.-accountId account)}
                               "federated request attempt returned non-success response")
                        (recur (rest remaining)))

                    :else
                    (let [routed (await (note-routed! deps {:projected-account account :timeout-ms timeout-ms
                                                            :request-kind request-kind :policy policy}))]
                      (await (stream-to-reply reply response owner-subject (.-id peer) account (:imported? routed))))))
                false))))))))
