(ns proxx.runtime.federation-routing
  "Federated and bridged request routing (formerly src/lib/federation/bridge-routing.ts
  and federated-routing.ts): the edge that sequences relay sessions, peers, the SQL
  federation store and the Fastify reply around the pure decisions in
  proxx.federation.routing / .helpers / .projections and the tenant-provider policy in
  proxx.policy.

  Collaborators arrive as plain JS objects (the host stores). Decisions stay pure; this
  namespace owns the streams, the reply and the awaits."
  (:require ["node:stream" :as node-stream]
            [proxx.credentials.federation :as sql-fed]
            [proxx.federation.helpers :as helpers]
            [proxx.federation.routing :as routing]
            [proxx.runtime :as runtime]
            [proxx.runtime.federation :as fed]
            [proxx.runtime.federation-projections :as projections]
            [proxx.runtime.http :as http]
            [proxx.runtime.manifest :as manifest]
            [proxx.runtime.proxy :as proxy]
            [proxx.runtime.routing :as rt-routing]
            [proxx.http.route-path :as route-path]))

(defn- error-message [e] (if (instance? js/Error e) (.-message e) (js/String e)))

(defn- env-trim
  "`process.env[name]?.trim()`: undefined when unset."
  [name]
  (let [v (aget js/process.env name)] (if (nil? v) js/undefined (.trim v))))

(defn- truthy? [x] (js* "!!~{}" x))

(defn- or-undef [x] (if (nil? x) js/undefined x))

(def ^:private default-manifest "resources/policies/runtime/00-manifest.edn")

(defn- authorized?
  "Does the tenant-provider `policy` authorize this use? (proxx.policy, via the runtime kernel)"
  [manifest-path policy input]
  (let [^js result (runtime/authorize-tenant-provider-policy-js
                    manifest-path (js/Object.assign #js {"policy" policy} input))]
    (and (= "ok" (.-status result)) (true? (.-allowed result)))))

(defn- header-obj [m] (clj->js m))

;; ---------------------------------------------------------------------------
;; Bridged requests (a connected relay session serves the request)
;; ---------------------------------------------------------------------------

(defn- append-response-headers!
  "Copy bridge response headers onto the reply, never content-length."
  [^js reply ^js headers]
  (doseq [[name value] (array-seq (js/Object.entries headers))]
    (when-not (= "content-length" (.toLowerCase name))
      (.header reply name value))))

(defn- decode-chunk
  "A response_chunk's bytes."
  [^js event]
  (if (= "base64" (.-encoding event))
    (js/Buffer.from (.-chunk event) "base64")
    (js/Buffer.from (.-chunk event) "utf8")))

(defn- hijack! [^js reply status]
  (.hijack reply)
  (let [^js raw (.-raw reply)]
    (aset raw "statusCode" status)
    (doseq [[name value] (array-seq (js/Object.entries (.getHeaders reply)))]
      (when-not (undefined? value) (.setHeader raw name value)))
    (.flushHeaders raw)
    raw))

(defn- ^:async attempt-session
  "Ask one session to serve the request and answer the reply from its events.
  Resolves true when the reply is (being) answered, false to try the next session."
  [^js relay ^js app ^js session {:keys [^js reply owner-subject tenant-id requested-model body-text upstream-path
                                         timeout-ms ^js request-headers]}]
  (let [response-started (atom false)
        raw-response (atom nil)
        saw-head (atom false)
        streaming (atom false)
        response-headers (atom #js {})
        buffered (array)
        peer-label (routing/routed-peer-label (.-clusterId session) (.-agentId session))
        stamp! (fn []
                 (.header reply helpers/owner-subject-header owner-subject)
                 (.header reply helpers/routed-peer-header peer-label))]
    (try
      (let [events (.requestStream relay (.-sessionId session)
                                   #js {"method" "POST" "path" upstream-path "timeoutMs" timeout-ms
                                        "headers" #js {"accept" (let [a (aget request-headers "accept")]
                                                                  (if (string? a) a "application/json"))
                                                       "content-type" "application/json"}
                                        "body" body-text
                                        "requestContext" #js {"tenantId" tenant-id}
                                        "routingIntent" (if (truthy? requested-model)
                                                          #js {"model" requested-model}
                                                          js/undefined)})]
        (await (fed/consume-async-iterable
                events
                (fn [^js event]
                  (case (.-type event)
                    "response_head"
                    (do (reset! saw-head true)
                        (reset! response-started true)
                        (reset! response-headers (.-headers event))
                        (append-response-headers! reply (.-headers event))
                        (stamp!)
                        (.code reply (.-status event))
                        (reset! streaming (routing/event-stream-content-type?
                                           (routing/response-content-type (fed/js->wire (.-headers event)))))
                        (when @streaming
                          (.removeHeader reply "content-length")
                          (.header reply "cache-control" "no-cache")
                          (.header reply "x-accel-buffering" "no")
                          (.header reply "content-type" "text/event-stream; charset=utf-8")
                          (reset! raw-response (hijack! reply (.-status event)))))
                    "response_chunk"
                    (do (when-not @saw-head
                          (reset! saw-head true)
                          (reset! response-started true)
                          (stamp!)
                          (.code reply 200))
                        (let [chunk (decode-chunk event)]
                          (if (and @streaming @raw-response)
                            (.write ^js @raw-response chunk)
                            (.push buffered chunk))))
                    nil)
                  nil)))
        (if (and @streaming @raw-response)
          (do (when-not (.-writableEnded ^js @raw-response) (.end ^js @raw-response))
              true)
          (let [body (.toString (js/Buffer.concat buffered) "utf8")
                parsed (if (routing/json-content-type? (routing/response-content-type (fed/js->wire @response-headers)))
                         (http/parse-json-if-possible-js body)
                         js/undefined)]
            (.send reply (if (undefined? parsed) body parsed))
            true)))
      (catch :default error
        (when-let [^js raw @raw-response]
          (when-not (.-writableEnded raw) (.end raw)))
        (.warn (.-log app) #js {"error" (error-message error) "sessionId" (.-sessionId session) "upstreamPath" upstream-path}
               "bridged request attempt failed")
        (boolean @response-started)))))

(defn- ^:async eligible-sessions
  "Connected sessions of the owner/tenant advertising a capability that admits this request."
  [^js relay ^js sql-policy-store manifest-path
   {:keys [owner-subject tenant-id subject-did requested-model request-kind allowed-ids normalized-path]}]
  (let [resolve-policy (fn ^:async resolve-policy [provider-id]
                         (if (or (not subject-did) (not sql-policy-store))
                           ::unrestricted
                           (let [policy (await (.getPolicy sql-policy-store subject-did provider-id))]
                             (cond
                               (not (truthy? policy)) ::denied
                               (not (authorized? manifest-path policy
                                                 #js {"ownerSubject" owner-subject "providerKind" "peer_proxx"
                                                      "requestedModel" (or-undef requested-model)
                                                      "requestKind" (or-undef request-kind)
                                                      "requiredShareMode" "relay"}))
                               ::denied
                               :else policy))))
        per-session (fn ^:async per-session [^js session]
                      (loop [capabilities (array-seq (.-capabilities session))]
                        (if-let [^js capability (first capabilities)]
                          (if (or (not (routing/capability-admissible? (fed/js->wire capability) allowed-ids))
                                  (not (rt-routing/bridge-capability-supports-path-js (manifest/policy-manifest-path) capability normalized-path))
                                  (not (rt-routing/bridge-capability-supports-model-js capability (or-undef requested-model))))
                            (recur (rest capabilities))
                            (if (= ::denied (await (resolve-policy (.-providerId capability))))
                              (recur (rest capabilities))
                              session))
                          js/undefined)))
        sessions (filterv #(routing/session-eligible? (fed/js->wire %) owner-subject tenant-id)
                          (array-seq (.listSessions relay)))
        results (await (js/Promise.all (to-array (map per-session sessions))))]
    (filterv some? (array-seq results))))

(defn ^:async execute-bridge-request-routing
  "Serve the request through a connected bridge session when one qualifies. Resolves
  true when the reply was answered (or began to be), false to fall through.
  `deps`: {bridgeRelay app config runtimeCredentialStore keyPool sqlTenantProviderPolicyStore};
  `input`: {requestHeaders requestBody requestAuth requestKind allowedProviderIds upstreamPath reply timeoutMs}."
  [^js deps ^js input]
  (let [^js relay (.-bridgeRelay deps)
        ^js app (.-app deps)]
    (if-not relay
      false
      (let [request-headers (.-requestHeaders input)
            upstream-path (.-upstreamPath input)
            hop-count (fed/resolve-federation-hop-count-js request-headers)]
        (if (routing/hop-limit-exceeded? hop-count)
          (do (.warn (.-log app) #js {"hopCount" hop-count "upstreamPath" upstream-path}
                     "bridge request rejected: hop limit exceeded")
              false)
          (let [request-auth (.-requestAuth input)
                owner-subject (fed/resolve-federation-owner-subject-js
                               #js {"headers" request-headers "requestAuth" request-auth "hopCount" hop-count}
                               (aget js/process.env "FEDERATION_DEFAULT_OWNER_SUBJECT"))]
            (if-not (truthy? owner-subject)
              false
              (let [tenant-id (routing/bridge-tenant-id (fed/js->wire request-auth))]
                (if-not (truthy? tenant-id)
                  false
                  (let [body (.-requestBody input)
                        requested-model (let [m (http/normalize-requested-model-js (.-model body))] (when-not (undefined? m) m))
                        manifest-path (or (.-cljsPolicyManifestPath ^js (.-config deps)) default-manifest)
                        sessions (await (eligible-sessions
                                         relay (.-sqlTenantProviderPolicyStore deps) manifest-path
                                         {:owner-subject owner-subject :tenant-id tenant-id
                                          :subject-did (routing/subject-did (fed/js->wire request-auth))
                                          :requested-model requested-model
                                          :request-kind (.-requestKind input)
                                          :allowed-ids (routing/allowed-provider-ids (array-seq (or (.-allowedProviderIds input) #js [])))
                                          :normalized-path (routing/normalized-path upstream-path)}))]
                    (if (empty? sessions)
                      false
                      (let [body-text (js/JSON.stringify body)
                            ctx {:reply (.-reply input) :owner-subject owner-subject :tenant-id tenant-id
                                 :requested-model requested-model :body-text body-text :upstream-path upstream-path
                                 :timeout-ms (.-timeoutMs input) :request-headers request-headers}]
                        (loop [remaining sessions]
                          (if-let [session (first remaining)]
                            (if (await (attempt-session relay app session ctx))
                              true
                              (recur (rest remaining)))
                            false))))))))))))))

;; ---------------------------------------------------------------------------
;; Serving a request that arrived over the bridge
;; ---------------------------------------------------------------------------

(defn- provenance []
  #js {"servedByClusterId" (env-trim "FEDERATION_SELF_CLUSTER_ID")
       "servedByGroupId" (env-trim "FEDERATION_SELF_GROUP_ID")
       "servedByNodeId" (env-trim "FEDERATION_SELF_NODE_ID")})

(defn- event [type provenance-obj provider-id extra]
  (let [o (js/Object.assign #js {"type" type} extra provenance-obj)]
    (aset o "providerId" provider-id)
    o))

(defn- async-iterable
  "An AsyncIterable over `next!` (() -> Promise<{value done}>); return() ends it."
  [next!]
  (let [done? (atom false)
        it (js-obj)]
    (aset it js/Symbol.asyncIterator
          (fn []
            #js {"next" (fn [] (if @done? (js/Promise.resolve #js {"value" js/undefined "done" true}) (next!)))
                 "return" (fn [v] (reset! done? true) (js/Promise.resolve #js {"value" v "done" true}))}))
    it))

(defn- response-events
  "The bridge events (head, chunks, end) of a fetch Response, UTF-8 text for text-like
  content types and base64 otherwise. Lazy: bytes are read as the consumer pulls."
  [^js response]
  (let [response-headers (let [o #js {}]
                           (.forEach (.-headers response) (fn [v k] (aset o k v)))
                           o)
        provenance* (provenance)
        provider-id (aget response-headers "x-open-hax-upstream-provider")
        queue (array)
        phase (atom :head)
        utf8? (routing/utf8-chunk-encoding? (or (.get (.-headers response) "content-type") ""))
        decoder (when utf8? (js/TextDecoder. "utf8"))
        reader (atom nil)
        push! (fn [type extra] (.push queue (event type provenance* provider-id extra)))
        advance! (fn ^:async advance []
                   (case @phase
                     :head (do (push! "response_head" #js {"status" (.-status response) "headers" response-headers})
                               (if-not (.-body response)
                                 (do (push! "response_end" #js {}) (reset! phase :done))
                                 (do (reset! reader (.getReader (.-body response))) (reset! phase :body))))
                     :body (let [^js r (await (.read ^js @reader))
                                 value (.-value r)]
                             (cond
                               (.-done r)
                               (do (when decoder
                                     (let [tail (.decode decoder)]
                                       (when (pos? (.-length tail))
                                         (push! "response_chunk" #js {"chunk" tail "encoding" "utf8"}))))
                                   (push! "response_end" #js {})
                                   (reset! phase :done))
                               (or (not value) (zero? (.-length value))) nil
                               decoder (let [chunk (.decode decoder value #js {"stream" true})]
                                         (when (pos? (.-length chunk))
                                           (push! "response_chunk" #js {"chunk" chunk "encoding" "utf8"})))
                               :else (push! "response_chunk" #js {"chunk" (.toString (js/Buffer.from value) "base64")
                                                                  "encoding" "base64"})))
                     :done nil))]
    (async-iterable
     (fn ^:async next-event []
       (loop []
         (cond
           (pos? (.-length queue)) #js {"value" (.shift queue) "done" false}
           (= :done @phase) #js {"value" js/undefined "done" true}
           :else (do (await (advance!)) (recur))))))))

(defn ^:async handle-bridge-request
  "Serve a request that arrived over the bridge by replaying it against this application.
  Only model API paths are allowed, so the bridge is never a privileged proxy.
  `input`: {method path headers bodyText ownerSubject tenantId}."
  [^js deps ^js input]
  (let [^js app (.-app deps)
        path (.-path input)]
    (if-not (routing/bridge-path-allowed? path)
      (do (.warn (.-log app) #js {"path" path "ownerSubject" (.-ownerSubject input)}
                 "bridge request rejected: path not in allowed list")
          (js/Object.assign #js {"status" 403 "headers" #js {"content-type" "application/json"}
                                 "body" (js/JSON.stringify (clj->js routing/bridge-forbidden-body))}
                            (provenance)))
      (let [^js input-headers (.-headers input)
            headers (header-obj (routing/bridge-request-headers
                                 {:accept (aget input-headers "accept") :content-type (aget input-headers "content-type")
                                  :owner-subject (.-ownerSubject input) :tenant-id (.-tenantId input)}))
            body-text (.-bodyText input)
            body (if (pos? (.-length body-text)) body-text js/undefined)
            address (.address (.-server app))]
        (if (and address (not (string? address)))
          (response-events (await (js/fetch (str "http://127.0.0.1:" (.-port ^js address) path)
                                            #js {"method" (.-method input) "headers" headers "body" body})))
          (let [^js injected (await (.inject app #js {"method" (.-method input) "url" path "headers" headers "payload" body}))
                response-headers (let [o #js {}]
                                   (doseq [[k v] (array-seq (js/Object.entries (.-headers injected)))]
                                     (when (string? v) (aset o k v)))
                                   o)
                result (js/Object.assign #js {"status" (.-statusCode injected) "headers" response-headers
                                              "body" (.-body injected) "encoding" "utf8"}
                                         (provenance))]
            (aset result "providerId" (aget response-headers "x-open-hax-upstream-provider"))
            result))))))

(defn- native-ollama-headers
  "Headers for an in-process native-Ollama call: the proxy token, the caller's own bearer when it matches."
  [^js request-headers ^js config]
  (let [token (.-proxyAuthToken config)
        base {"content-type" "application/json"}]
    (if (truthy? token)
      (let [authorization (aget request-headers "authorization")]
        (assoc base "authorization"
               (if (and (http/has-bearer-token-js authorization token) (string? authorization))
                 authorization
                 (str "Bearer " token))))
      base)))

(defn inject-native-bridge
  "POST `payload` to `url` inside this application with the native-Ollama auth headers."
  [^js deps url payload request-headers]
  (.inject ^js (.-app deps)
           #js {"method" "POST" "url" url
                "headers" (header-obj (native-ollama-headers request-headers (.-config deps)))
                "payload" payload}))

;; ---------------------------------------------------------------------------
;; Federated requests (a peer Proxx serves the request)
;; ---------------------------------------------------------------------------

(def ^:private default-warm-import-threshold
  (sql-fed/warm-import-threshold (aget js/process.env "FEDERATION_WARM_IMPORT_REQUEST_THRESHOLD")))

(defn fetch-federation-json
  "A JSON call to a peer: bearer when a credential is given; a non-2xx reply throws the peer's own message."
  [^js input]
  (let [^js init #js {"method" (or (.-method input) "GET")
                      "headers" (js/Headers. (clj->js (helpers/json-request-headers (.-credential input))))
                      "body" (if (.-body input) (js/JSON.stringify (.-body input)) js/undefined)}]
    (-> (http/fetch-with-response-timeout-js (.-url input) init (.-timeoutMs input))
        (.then (fn [^js response]
                 (.then (.text response)
                        (fn [text]
                          (let [parsed (if (pos? (.-length text)) (js/JSON.parse text) #js {})]
                            (if-not (.-ok response)
                              (throw (js/Error. (fed/federation-failure-message-js parsed (.-status response))))
                              parsed)))))))))

(defn- ^:async note-routed
  "Record that a projected account served a request; warm-import its credential when the
  tenant policy and the request count allow it. Resolves {importedCredential projectedAccount}."
  [^js deps {:keys [^js projected-account timeout-ms request-kind ^js policy]}]
  (let [^js store (.-sqlFederationStore deps)
        ^js runtime-credential-store (.-runtimeCredentialStore deps)
        ^js key-pool (.-keyPool deps)
        ^js app (.-app deps)
        key-of (fn [^js a] #js {"sourcePeerId" (.-sourcePeerId a) "providerId" (.-providerId a) "accountId" (.-accountId a)})]
    (if-not store
      #js {"importedCredential" false "projectedAccount" projected-account}
      (let [noted (await (.noteProjectedAccountRouted store (key-of projected-account)))
            projected (atom (or noted projected-account))
            imported (atom false)
            manifest-path (or (.-cljsPolicyManifestPath deps) default-manifest)
            warm-allowed (routing/warm-import-allowed?
                          (some? policy)
                          (and (some? policy)
                               (authorized? manifest-path policy
                                            #js {"ownerSubject" (.-ownerSubject policy) "providerKind" (.-providerKind policy)
                                                 "requestKind" (or-undef request-kind) "requiredShareMode" "warm_import"})))
            threshold (let [t (if policy (.-warmImportThreshold policy) js/undefined)] (if (undefined? t) default-warm-import-threshold t))]
        (when (and warm-allowed (sql-fed/should-warm-import? (.-warmRequestCount ^js @projected) threshold))
          (let [^js result
                (await
                 (.withProjectedAccountImportLock
                  store (key-of @projected)
                  (fn ^:async locked [tx]
                    (let [^js latest (await (.getProjectedAccount store (key-of @projected) tx))]
                      (cond
                        (not latest) js/undefined
                        (= "imported" (.-availabilityState latest)) #js {"importedCredential" false "projectedAccount" latest}
                        :else
                        (let [^js peer (await (.getPeer store (.-sourcePeerId latest) tx))
                              credential (when peer (helpers/extract-peer-credential (fed/js->wire (.-auth peer))))]
                          (if (or (not peer) (not credential))
                            #js {"importedCredential" false "projectedAccount" latest}
                            (try
                              (let [export-body #js {"providerId" (.-providerId latest) "accountId" (.-accountId latest)}
                                    [export-url legacy-url] (routing/export-urls (fed/js->wire peer))
                                    fetch-export (fn [url] (fetch-federation-json
                                                            #js {"url" url "credential" credential "timeoutMs" timeout-ms
                                                                 "method" "POST" "body" export-body}))
                                    ^js remote (try (await (fetch-export export-url))
                                                    (catch :default _ (await (fetch-export legacy-url))))
                                    ^js account (.-account remote)]
                                (if (= "oauth_bearer" (.-authType account))
                                  (await (.upsertOAuthAccount runtime-credential-store
                                                              (.-providerId account) (.-accountId account) (.-secret account)
                                                              (.-refreshToken account) (.-expiresAt account) (.-chatgptAccountId account)
                                                              (.-email account) (.-subject account) (.-planType account)))
                                  (await (.upsertApiKeyAccount runtime-credential-store
                                                               (.-providerId account) (.-accountId account) (.-secret account))))
                                (await (.catch (.warmup key-pool) (fn [_] js/undefined)))
                                (let [marked (await (.markProjectedAccountImported store (key-of latest) tx))]
                                  #js {"importedCredential" true "projectedAccount" (or marked latest)}))
                              (catch :default error
                                (.warn (.-log app) #js {"error" (error-message error) "sourcePeerId" (.-sourcePeerId latest)
                                                        "providerId" (.-providerId latest) "accountId" (.-accountId latest)}
                                       "failed warm federation credential import during request routing")
                                #js {"importedCredential" false "projectedAccount" latest})))))))))]
            (if result
              (do (reset! projected (.-projectedAccount result))
                  (reset! imported (.-importedCredential result)))
              (let [^js latest (await (.getProjectedAccount store (key-of @projected)))]
                (when latest
                  (reset! projected latest)
                  (reset! imported (= "imported" (.-availabilityState latest))))))))
        (await (.appendDiffEvent store (clj->js (routing/routed-diff-event (fed/js->wire @projected) @imported))))
        #js {"importedCredential" @imported "projectedAccount" @projected}))))

(defn- ^:async projected-candidates
  [^js deps ^js store owner-subject peers-by-id local-keys local-provider-ids now request-kind resolve-policy]
  (let [manifest-path (or (.-cljsPolicyManifestPath deps) default-manifest)
        ^js result (runtime/resolve-federation-route-candidates-js
                    manifest-path
                    #js {"requestKind" request-kind "providerIds" (to-array local-provider-ids)
                         "projectedAccounts" (await (.getProjectedAccountsForOwner store owner-subject))
                         "localProviderAccountKeys" (to-array local-keys) "nowMs" now})
        ordered (if (and (= "ok" (.-status result)) (array? (.-candidates result)))
                  (array-seq (.-candidates result))
                  [])
        candidates (await (js/Promise.all
                           (to-array
                            (map (fn ^:async candidate [^js account]
                                   (let [peer (get peers-by-id (.-sourcePeerId account))
                                         credential (when peer (helpers/extract-peer-credential (fed/js->wire (.-auth ^js peer))))]
                                     (if (or (not peer) (not credential))
                                       js/undefined
                                       (let [policy (await (resolve-policy (.-providerId account)))]
                                         (if (= ::denied policy)
                                           js/undefined
                                           #js {"peer" peer "credential" credential "projectedAccount" account
                                                "policy" (if (= ::unrestricted policy) js/undefined policy)})))))
                                 ordered))))]
    (filterv some? (array-seq candidates))))

(defn ^:async execute-federated-request-routing
  "Serve the request through a peer Proxx holding a projected account for it. Resolves true
  when the reply was answered, false to fall through.
  `deps`: {app cljsPolicyManifestPath sqlFederationStore runtimeCredentialStore keyPool sqlTenantProviderPolicyStore};
  `input`: {requestHeaders requestBody requestAuth requestKind providerRoutes upstreamPath reply timeoutMs signal}."
  [^js deps ^js input]
  (let [^js app (.-app deps)
        ^js store (.-sqlFederationStore deps)
        ^js runtime-credential-store (.-runtimeCredentialStore deps)
        ^js policy-store (.-sqlTenantProviderPolicyStore deps)]
    (if-not store
      false
      (let [request-headers (.-requestHeaders input)
            hop-count (fed/resolve-federation-hop-count-js request-headers)]
        (if (routing/hop-limit-exceeded? hop-count)
          false
          (let [request-auth (.-requestAuth input)
                owner-subject (fed/resolve-federation-owner-subject-js
                               #js {"headers" request-headers "requestAuth" request-auth "hopCount" hop-count}
                               (aget js/process.env "FEDERATION_DEFAULT_OWNER_SUBJECT"))]
            (if-not (truthy? owner-subject)
              false
              (let [local-provider-ids (vec (distinct (map #(.toLowerCase (.trim (.-providerId ^js %))) (array-seq (.-providerRoutes input)))))]
                (if (empty? local-provider-ids)
                  false
                  (let [body (.-requestBody input)
                        requested-model (let [m (http/normalize-requested-model-js (.-model body))] (when-not (undefined? m) m))
                        request-kind (.-requestKind input)
                        subject-did (routing/subject-did (fed/js->wire request-auth))
                        manifest-path (or (.-cljsPolicyManifestPath deps) default-manifest)
                        resolve-policy (fn ^:async resolve-relay-policy [provider-id]
                                         (if (or (not subject-did) (not policy-store))
                                           ::unrestricted
                                           (let [policy (await (.getPolicy policy-store subject-did provider-id))]
                                             (cond
                                               (not (truthy? policy)) ::denied
                                               (not (authorized? manifest-path policy
                                                                 #js {"ownerSubject" owner-subject "providerKind" "local_upstream"
                                                                      "requestedModel" (or-undef requested-model)
                                                                      "requestKind" request-kind "requiredShareMode" "relay"}))
                                               ::denied
                                               :else policy))))
                        peers (await (.listPeers store owner-subject))
                        peers-by-id (into {} (comp (filter #(routing/active-peer? (fed/js->wire %))) (map (fn [^js p] [(.-id p) p])))
                                          (array-seq peers))
                        local-keys (into []
                                         (comp (mapcat (fn [^js provider]
                                                   (map (fn [^js account] (routing/local-account-key (.-id provider) (.-id account)))
                                                        (array-seq (.-accounts provider))))) (distinct))
                                         (array-seq (await (.catch (.listProviders runtime-credential-store false) (fn [_] #js [])))))
                        now (js/Date.now)
                        pull! (fn [] (.catch (projections/ensure-projected-accounts-fresh-js
                                              #js {"logger" (.-log app) "sqlFederationStore" store "ownerSubject" owner-subject
                                                   "timeoutMs" (js/Math.min (.-timeoutMs input) 10000)}
                                              #js {"fetchFederationJson" fetch-federation-json
                                                   "resolveFederationRoutePath" (fn [suffix ^js options]
                                                                                  (route-path/join (or (some-> options .-prefix) "/api/ui") suffix))})
                                             (fn [_] js/undefined)))
                        build! (fn [] (projected-candidates deps store owner-subject peers-by-id local-keys local-provider-ids now
                                                            request-kind resolve-policy))
                        _ (await (pull!))
                        first-try (await (build!))
                        candidates (if (empty? first-try)
                                     (do (await (pull!)) (await (build!)))
                                     first-try)]
                    (if (empty? candidates)
                      false
                      (let [body-text (js/JSON.stringify body)
                            ^js reply (.-reply input)]
                        (loop [remaining candidates]
                          (if-let [^js candidate (first remaining)]
                            (let [^js peer (.-peer candidate)
                                  ^js projected-account (.-projectedAccount candidate)
                                  headers (js/Headers. (proxy/forward-headers-js request-headers))
                                  _ (doseq [[k v] (routing/forwarded-request-overrides
                                                   (.-credential candidate) hop-count owner-subject (fed/js->wire projected-account))]
                                      (.set headers k v))
                                  remote (try (await (http/fetch-with-response-timeout-js
                                                      (str (.-baseUrl peer) (.-upstreamPath input))
                                                      #js {"method" "POST" "headers" headers "body" body-text "signal" (.-signal input)}
                                                      (.-timeoutMs input)))
                                              (catch :default error
                                                (.warn (.-log app) #js {"error" (error-message error) "peerId" (.-id peer)
                                                                        "upstreamPath" (.-upstreamPath input)
                                                                        "providerId" (.-providerId projected-account)
                                                                        "accountId" (.-accountId projected-account)}
                                                       "federated request attempt failed before response")
                                                ::failed))]
                              (cond
                                (= ::failed remote) (recur (rest remaining))
                                (not (.-ok ^js remote))
                                (do (try (await (.arrayBuffer ^js remote)) (catch :default _ nil))
                                    (.warn (.-log app) #js {"peerId" (.-id peer) "status" (.-status ^js remote)
                                                            "providerId" (.-providerId projected-account)
                                                            "accountId" (.-accountId projected-account)}
                                           "federated request attempt returned non-success response")
                                    (recur (rest remaining)))
                                :else
                                (let [^js remote remote
                                      ^js routed (await (note-routed deps {:projected-account projected-account :timeout-ms (.-timeoutMs input)
                                                                           :request-kind request-kind :policy (.-policy candidate)}))]
                                  (doseq [[name value] (array-seq (js/Array.from (.entries (.-headers remote))))]
                                    (when (routing/copyable-response-header? name) (.header reply name value)))
                                  (doseq [[k v] (routing/routed-response-headers owner-subject (.-id peer)
                                                                                 (fed/js->wire projected-account)
                                                                                 (.-importedCredential routed))]
                                    (.header reply k v))
                                  (.code reply (.-status remote))
                                  (let [content-type (or (.get (.-headers remote) "content-type") "")
                                        event-stream? (routing/event-stream-content-type? content-type)]
                                    (cond
                                      (not (.-body remote)) (do (.send reply (await (.text remote))) true)
                                      event-stream? (do (.removeHeader reply "content-length")
                                                        (.send reply (.fromWeb ^js (.-Readable ^js node-stream) (.-body remote)))
                                                        true)
                                      :else (do (.send reply (js/Buffer.from (await (.arrayBuffer remote)))) true))))))
                            false))))))))))))))
