(ns proxx.runtime.federation
  "JS edge for the federation kernels (src/lib/federation/*.ts).

  Conversion rule: JS objects become string-keyed wire maps with `undefined`
  properties dropped (absent) and `null` kept as nil (present), and results go
  back with `clj->js`, so the pure namespaces never see JS and never need to
  tell `undefined` from a missing key. Domain failures are ex-info; this edge
  rethrows them as plain `js/Error` with the same message so HTTP layers and
  peers see exactly what they saw before."
  (:require ["node:crypto" :as crypto]
            [proxx.federation.bridge-request :as bridge-request]
            [proxx.federation.helpers :as helpers]
            [proxx.federation.lease :as lease]
            [proxx.federation.owner :as owner]
            [proxx.federation.protocol :as protocol]
            [proxx.federation.routing :as routing]
            [proxx.federation.sse-channel :as sse]))

(defn js->wire
  "JS value to wire data: plain objects to string-keyed maps (undefined props
  dropped, null kept as nil), arrays to vectors, everything else unchanged."
  [x]
  (cond
    (nil? x) nil
    (array? x) (mapv js->wire x)
    (and (object? x) (identical? (type x) js/Object))
    (reduce (fn [acc k]
              (let [v (aget x k)]
                (if (undefined? v) acc (assoc acc k (js->wire v)))))
            {} (js-keys x))
    :else x))

(defn rethrow-as-error
  "Rethrow an ex-info as a plain Error carrying its message; pass anything else through."
  [e]
  (if (ex-data e) (throw (js/Error. (ex-message e))) (throw e)))

(defn- guarded [f] (try (f) (catch :default e (rethrow-as-error e))))

;; ---------------------------------------------------------------------------
;; bridge-protocol.ts
;; ---------------------------------------------------------------------------

(def bridge-protocol-version protocol/protocol-version)

(defn parse-bridge-message-js [value]
  (guarded #(clj->js (protocol/parse-message (js->wire value)))))

(defn parse-bridge-message-json-js [text]
  (guarded #(clj->js (protocol/parse-message-json text))))

(defn- or-undefined [x] (if (nil? x) js/undefined x))

;; ---------------------------------------------------------------------------
;; owner-credential.ts
;; ---------------------------------------------------------------------------

(defn- sha256-hex [^string s]
  (.digest (.update ^js (.createHash ^js crypto "sha256") s) "hex"))

(defn is-at-did-js [value] (owner/at-did? value))

(defn normalize-at-did-js [value] (guarded #(owner/normalize-at-did value)))

(defn fingerprint-admin-key-js [value] (owner/fingerprint-admin-key sha256-hex value))

(defn parse-federation-owner-credential-js [raw]
  (or-undefined (some-> (owner/parse-owner-credential sha256-hex raw) clj->js)))

;; ---------------------------------------------------------------------------
;; federation-helpers.ts
;; ---------------------------------------------------------------------------

(def federation-headers
  (clj->js {:hop helpers/hop-header :ownerSubject helpers/owner-subject-header
            :bridgeTenant helpers/bridge-tenant-header :forcedProvider helpers/forced-provider-header
            :forcedAccountId helpers/forced-account-id-header :routedPeer helpers/routed-peer-header
            :routedProvider helpers/routed-provider-header :routedAccount helpers/routed-account-header
            :imported helpers/imported-header :blockedResponseHeaders (vec (sort helpers/blocked-response-headers))}))

(defn extract-peer-credential-js [auth]
  (or-undefined (helpers/extract-peer-credential (js->wire auth))))

(defn resolve-federation-hop-count-js [headers]
  (helpers/hop-count (js->clj (aget headers helpers/hop-header))))

(defn resolve-federation-owner-subject-js [^js input default-owner-subject]
  (let [headers (.-headers input)]
    (or-undefined
     (helpers/owner-subject {:header (js->clj (aget headers helpers/owner-subject-header))
                             :request-auth (js->wire (.-requestAuth input))
                             :hop-count (.-hopCount input)
                             :default-owner-subject default-owner-subject}))))

(defn federation-json-request-headers-js [credential]
  (clj->js (helpers/json-request-headers credential)))

(defn federation-failure-message-js [parsed status]
  (helpers/failure-message (when (and (some? parsed) (object? parsed)) (aget parsed "error")) status))

;; ---------------------------------------------------------------------------
;; bridge-request-helpers.ts
;; ---------------------------------------------------------------------------

(defn forwardable-bridge-response-headers-js
  "[name, value] entries of `headers` (a JS object, order preserved) that may be copied onto a reply."
  [headers hide-upstream-account?]
  (.filter (js/Object.entries headers)
           (fn [entry] (bridge-request/forwardable-header? (aget entry 0) hide-upstream-account?))))

;; ---------------------------------------------------------------------------
;; bridge-lease-parsers.ts
;; ---------------------------------------------------------------------------

(defn parse-bridge-lease-accounts-js [payload fallback-provider-id]
  (clj->js (lease/parse-accounts (js->wire payload) fallback-provider-id)))

(defn parse-bridge-lease-export-js [payload]
  (or-undefined (some-> (lease/parse-export (js->wire payload)) clj->js)))

;; ---------------------------------------------------------------------------
;; sse-bridge-channel.ts
;; ---------------------------------------------------------------------------

(defn create-sse-bridge-send-channel-js
  "A BridgeSendChannel over a server response: `send` writes data events,
  `close` writes the optional close event and ends the response, once."
  [^js res]
  (let [open? (atom true)
        live? (fn [] (and @open? (not (.-writableEnded res))))
        channel (js-obj)]
    (aset channel "send" (fn [data] (when (live?) (.write res (sse/data-frame data)))))
    (aset channel "close"
          (fn [code reason]
            (when @open?
              (reset! open? false)
              (when-let [frame (sse/close-frame code (js/JSON.stringify (if (nil? reason) "" reason)))]
                (.write res frame))
              (.end res))))
    (js/Object.defineProperty channel "isOpen" #js {:get live?})
    channel))

(defn format-sse-event-js [event data]
  (sse/event-frame event (js/String (js/JSON.stringify data))))

;; ---------------------------------------------------------------------------
;; Shared edge helpers for the bridge relay and agent
;; ---------------------------------------------------------------------------

(defn ws-text
  "Text of a websocket message payload of any shape `ws` may deliver."
  [data]
  (cond
    (string? data) data
    (js/Buffer.isBuffer data) (.toString ^js data "utf8")
    (array? data) (.toString (js/Buffer.concat (.map data (fn [e] (if (js/Buffer.isBuffer e) e (js/Buffer.from e))))) "utf8")
    (instance? js/ArrayBuffer data) (.toString (js/Buffer.from data) "utf8")
    :else (.toString (js/Buffer.from (str data)) "utf8")))

(defn consume-async-iterable
  "Promise resolved when `f` has seen every item of the async iterable (like
  for-await). `f` returning :stop ends iteration early, calling `return()` on
  the iterator; the promise then resolves to :stopped (else nil). A rejection
  from the iterable rejects the promise."
  [iterable f]
  (let [it (.call (aget iterable js/Symbol.asyncIterator) iterable)]
    (js/Promise.
     (fn [resolve reject]
       (letfn [(step []
                 (-> (.next it)
                     (.then (fn [r]
                              (if (.-done r)
                                (resolve nil)
                                (if (= :stop (f (.-value r)))
                                  (-> (if (fn? (.-return it)) (.return it) (js/Promise.resolve))
                                      (.then (fn [_] (resolve :stopped))))
                                  (step)))))
                     (.catch reject)))]
         (step))))))

;; ---------------------------------------------------------------------------
;; bridge-routing.ts / federated-routing.ts decisions
;; ---------------------------------------------------------------------------

(defn- result->js [r]
  (cond (nil? r) js/undefined
        (set? r) (to-array r)
        :else (clj->js r)))

(defn- wired
  "A JS-callable wrapper: arguments become wire data, the result goes back as JS."
  [f]
  (fn [& args] (result->js (apply f (map js->wire args)))))

(def federation-routing
  (let [o (js-obj)]
    (doseq [[k f] {"bridgeTenantId" routing/bridge-tenant-id
                   "subjectDid" routing/subject-did
                   "hopLimitExceeded" routing/hop-limit-exceeded?
                   "normalizedPath" routing/normalized-path
                   "allowedProviderIds" routing/allowed-provider-ids
                   "sessionEligible" routing/session-eligible?
                   "capabilityAdmissible" (fn [capability allowed] (routing/capability-admissible? capability (set allowed)))
                   "eventStreamContentType" routing/event-stream-content-type?
                   "jsonContentType" routing/json-content-type?
                   "responseContentType" routing/response-content-type
                   "routedPeerLabel" routing/routed-peer-label
                   "bridgePathAllowed" routing/bridge-path-allowed?
                   "bridgeForbiddenBody" (fn [] routing/bridge-forbidden-body)
                   "bridgeRequestHeaders" (fn [m] (routing/bridge-request-headers
                                                   {:accept (get m "accept") :content-type (get m "contentType")
                                                    :owner-subject (get m "ownerSubject") :tenant-id (get m "tenantId")}))
                   "utf8ChunkEncoding" routing/utf8-chunk-encoding?
                   "localProviderIds" routing/local-provider-ids
                   "localAccountKey" routing/local-account-key
                   "isActivePeer" routing/active-peer?
                   "forwardedRequestOverrides" routing/forwarded-request-overrides
                   "copyableResponseHeader" routing/copyable-response-header?
                   "routedResponseHeaders" routing/routed-response-headers
                   "warmImportAllowed" routing/warm-import-allowed?
                   "exportUrls" routing/export-urls
                   "routedDiffEvent" routing/routed-diff-event}]
      (aset o k (wired f)))
    o))
