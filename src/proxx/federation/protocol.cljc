(ns proxx.federation.protocol
  "bridge-ws-v0 frames: parse, validate and serialize, as pure functions over
  string-keyed wire data.

  Inbound text/objects go through `parse-message`, a normalizing parser: it
  trims strings, drops absent optionals, and rejects with the exact messages
  peers already see in `bridge_message_invalid` / `bridge_message_decode_failed`
  error frames. Outbound frames go through `encode-frame`, which checks the
  frame against the Malli `Frame` schema before serializing, so a bug in the
  sender cannot put an unparseable frame on the wire.

  Absent vs null: wire maps keep a JSON `null` as a present key with a nil
  value (`contains?`), and an absent key as no key. The distinction matters
  because 'present but not an object' is an error while 'absent' is fine; the
  JS edge drops `undefined` properties before converting so that an object that
  never had the key and an object whose key is `undefined` behave the same."
  (:require [clojure.string :as str]
            [malli.core :as m]
            [proxx.json :as json]))

(def protocol-version "bridge-ws-v0")

(def auth-modes ["admin_key" "at_did" "did_signed_challenge"])
(def account-auth-types ["api_key" "oauth_bearer" "local" "none"])
(def credential-mobilities ["local_only" "descriptor_only" "importable" "non_exportable" "access_token_only"])
(def chunk-encodings ["utf8" "base64"])
(def execution-policies ["cluster_default" "group_affinity" "node_affinity"])

;; ---------------------------------------------------------------------------
;; Field readers. Every reader takes the record and a field name and either
;; returns the normalized value (nil when an optional is absent) or throws the
;; message a peer would see.
;; ---------------------------------------------------------------------------

(defn- invalid [message]
  (throw (ex-info message {:error/type :federation/bridge-message-invalid})))

(defn- wire-object? [x] (map? x))

(defn- trimmed-string [x] (when (string? x) (str/trim x)))

(defn- absent? [m k] (not (contains? m k)))

(defn- required-string [m k]
  (let [v (trimmed-string (get m k))]
    (if (seq v) v (invalid (str "bridge message " k " must be a non-empty string")))))

(defn- required-raw-string [m k]
  (let [v (get m k)]
    (if (and (string? v) (seq v)) v (invalid (str "bridge message " k " must be a non-empty string")))))

(defn- optional-string [m k]
  (let [v (trimmed-string (get m k))]
    (when (seq v) v)))

(defn- required-boolean [m k]
  (let [v (get m k)]
    (if (boolean? v) v (invalid (str "bridge message " k " must be a boolean")))))

(defn- non-negative-integer? [v]
  (and (number? v)
       #?(:cljs (js/Number.isFinite v)
          :clj (not (or (Double/isNaN (double v)) (Double/isInfinite (double v)))))
       (== v (Math/floor v))
       (>= v 0)))

(defn- required-non-negative-integer [m k]
  (let [v (get m k)]
    (if (non-negative-integer? v)
      v
      (invalid (str "bridge message " k " must be a non-negative integer")))))

(defn- optional-non-negative-integer [m k]
  (when-not (absent? m k)
    (let [v (get m k)]
      (if (non-negative-integer? v)
        v
        (invalid (str "bridge message " k " must be a non-negative integer when present"))))))

(defn- timestamp-parses? [s]
  #?(:cljs (js/Number.isFinite (js/Date.parse s))
     :clj (try (java.time.Instant/parse s) true (catch Exception _ false))))

(defn- optional-iso-timestamp [m k]
  (when-let [v (optional-string m k)]
    (if (timestamp-parses? v) v (invalid (str "bridge message " k " must be an ISO timestamp")))))

(defn- required-iso-timestamp [m k]
  (let [v (required-string m k)]
    (if (timestamp-parses? v) v (invalid (str "bridge message " k " must be an ISO timestamp")))))

(defn- optional-string-array
  "[] when absent; every entry must be a non-empty string (returned trimmed)."
  [m k]
  (if (absent? m k)
    []
    (let [v (get m k)]
      (when-not (sequential? v) (invalid (str "bridge message " k " must be an array when present")))
      (vec (map-indexed (fn [i entry]
                          (let [t (trimmed-string entry)]
                            (if (seq t) t (invalid (str "bridge message " k "[" i "] must be a non-empty string")))))
                        v)))))

(defn- required-string-record
  "Header-like map of non-blank keys to string values; keys are trimmed."
  [m k]
  (let [v (get m k)]
    (when-not (wire-object? v) (invalid (str "bridge message " k " must be an object")))
    (reduce-kv (fn [acc key raw]
                 (let [nk (str/trim (str key))]
                   (if (and (seq nk) (string? raw))
                     (assoc acc nk raw)
                     (invalid (str "bridge message " k "." key " must be a string header pair")))))
               {} v)))

(defn- read-enum [value field allowed]
  (when-not (string? value) (invalid (str "bridge message " field " must be a string enum")))
  (let [v (str/trim value)]
    (if (some #{v} allowed)
      v
      (invalid (str "bridge message " field " must be one of " (str/join ", " allowed))))))

(defn- compact
  "Drop nil values: an optional that was absent is an absent key, not a null."
  [m]
  (into {} (remove (comp nil? val)) m))

;; ---------------------------------------------------------------------------
;; Nested structures
;; ---------------------------------------------------------------------------

(defn- parse-topology-group [v context]
  (when-not (wire-object? v) (invalid (str context " must be an object")))
  (let [node-ids (if (sequential? (get v "nodeIds"))
                   (vec (map-indexed (fn [i entry]
                                       (let [t (trimmed-string entry)]
                                         (if (seq t)
                                           t
                                           (invalid (str context ".nodeIds[" i "] must be a non-empty string")))))
                                     (get v "nodeIds")))
                   [])]
    {"groupId" (required-string v "groupId") "nodeIds" node-ids}))

(defn- parse-topology-node [v context]
  (when-not (wire-object? v) (invalid (str context " must be an object")))
  {"groupId" (required-string v "groupId")
   "nodeId" (required-string v "nodeId")
   "labels" (optional-string-array v "labels")})

(defn- parse-execution-target [v context]
  (when-not (wire-object? v) (invalid (str context " must be an object")))
  {"groupId" (required-string v "groupId") "nodeId" (required-string v "nodeId")})

(defn- parse-topology-summary [m]
  (when-not (absent? m "topology")
    (let [v (get m "topology")]
      (when-not (wire-object? v) (invalid "bridge message topology must be an object when present"))
      (let [groups (if (sequential? (get v "groups"))
                     (vec (map-indexed (fn [i e] (parse-topology-group e (str "topology.groups[" i "]"))) (get v "groups")))
                     [])
            nodes (if (sequential? (get v "nodes"))
                    (vec (map-indexed (fn [i e] (parse-topology-node e (str "topology.nodes[" i "]"))) (get v "nodes")))
                    [])
            policy (when-not (absent? v "defaultExecutionPolicy")
                     (read-enum (get v "defaultExecutionPolicy") "topology.defaultExecutionPolicy" execution-policies))]
        (compact {"groups" groups "nodes" nodes "defaultExecutionPolicy" policy})))))

(defn- parse-capability [v context]
  (when-not (wire-object? v) (invalid (str context " must be an object")))
  (let [targets (get v "topologyTargets")]
    (when-not (sequential? targets) (invalid (str context ".topologyTargets must be an array")))
    (let [provider-id (required-string v "providerId")
          prefixes (optional-string-array v "modelPrefixes")
          models (optional-string-array v "models")
          paths (optional-string-array v "paths")
          routes (optional-string-array v "routes")
          auth-type (read-enum (get v "authType") (str context ".authType") account-auth-types)
          account-count (required-non-negative-integer v "accountCount")
          available (required-non-negative-integer v "availableAccountCount")
          models-list (required-boolean v "supportsModelsList")
          chat (required-boolean v "supportsChatCompletions")
          responses (required-boolean v "supportsResponses")
          streaming (required-boolean v "supportsStreaming")
          warm (required-boolean v "supportsWarmImport")
          mobility (read-enum (get v "credentialMobility") (str context ".credentialMobility") credential-mobilities)
          origin (required-string v "credentialOrigin")
          healthy (optional-iso-timestamp v "lastHealthyAt")
          failure-at (optional-iso-timestamp v "lastFailureAt")
          failure-class (optional-string v "failureClass")
          topology-targets (vec (map-indexed (fn [i e] (parse-execution-target e (str context ".topologyTargets[" i "]"))) targets))]
      (compact {"providerId" provider-id "modelPrefixes" prefixes "models" models "paths" paths "routes" routes
                "authType" auth-type "accountCount" account-count "availableAccountCount" available
                "supportsModelsList" models-list "supportsChatCompletions" chat "supportsResponses" responses
                "supportsStreaming" streaming "supportsWarmImport" warm "credentialMobility" mobility
                "credentialOrigin" origin "lastHealthyAt" healthy "lastFailureAt" failure-at
                "failureClass" failure-class "topologyTargets" topology-targets}))))

(defn- parse-node-health [v context]
  (when-not (wire-object? v) (invalid (str context " must be an object")))
  (compact {"groupId" (required-string v "groupId")
            "nodeId" (required-string v "nodeId")
            "reachable" (required-boolean v "reachable")
            "lastHealthyAt" (optional-iso-timestamp v "lastHealthyAt")
            "lastFailureAt" (optional-iso-timestamp v "lastFailureAt")
            "failureClass" (optional-string v "failureClass")}))

(defn- parse-health-report [v]
  (when-not (wire-object? v) (invalid "bridge message health must be an object"))
  (let [nodes (get v "nodes")]
    (when-not (sequential? nodes) (invalid "bridge message health.nodes must be an array"))
    (let [process-healthy (required-boolean v "processHealthy")
          upstream-healthy (required-boolean v "upstreamHealthy")
          available (required-non-negative-integer v "availableAccountCount")
          bootstrap (required-boolean v "localOauthBootstrapReady")
          queued (optional-non-negative-integer v "queuedRequests")]
      (compact {"processHealthy" process-healthy "upstreamHealthy" upstream-healthy
                "availableAccountCount" available "localOauthBootstrapReady" bootstrap
                "queuedRequests" queued
                "nodes" (vec (map-indexed (fn [i e] (parse-node-health e (str "health.nodes[" i "]"))) nodes))}))))

(defn- parse-optional-record
  "`field` when present must be an object; `read` turns it into the normalized map."
  [m field read]
  (when-not (absent? m field)
    (let [v (get m field)]
      (when-not (wire-object? v) (invalid (str "bridge message " field " must be an object when present")))
      (read v))))

(defn- parse-request-context [m]
  (parse-optional-record m "requestContext"
                         (fn [v] (compact {"tenantId" (optional-string v "tenantId")
                                           "issuer" (optional-string v "issuer")
                                           "keyId" (optional-string v "keyId")}))))

(defn- parse-routing-intent [m]
  (parse-optional-record m "routingIntent"
                         (fn [v] (compact {"providerId" (optional-string v "providerId")
                                           "model" (optional-string v "model")
                                           "accountId" (optional-string v "accountId")}))))

(defn- parse-usage [m]
  (parse-optional-record m "usage"
                         (fn [v] (compact {"requestCount" (optional-non-negative-integer v "requestCount")
                                           "promptTokens" (optional-non-negative-integer v "promptTokens")
                                           "completionTokens" (optional-non-negative-integer v "completionTokens")
                                           "totalTokens" (optional-non-negative-integer v "totalTokens")}))))

;; ---------------------------------------------------------------------------
;; Envelope and per-type bodies
;; ---------------------------------------------------------------------------

(defn- parse-base-envelope [m]
  (let [type (required-string m "type")
        version (read-enum (get m "protocolVersion") "protocolVersion" [protocol-version])
        session-id (optional-string m "sessionId")
        stream-id (optional-string m "streamId")
        sent-at (required-iso-timestamp m "sentAt")
        trace-id (required-string m "traceId")
        owner (required-string m "ownerSubject")
        cluster (required-string m "clusterId")
        agent (required-string m "agentId")]
    (compact {"type" type "protocolVersion" version "sessionId" session-id "streamId" stream-id
              "sentAt" sent-at "traceId" trace-id "ownerSubject" owner "clusterId" cluster "agentId" agent
              "groupId" (optional-string m "groupId") "nodeId" (optional-string m "nodeId")})))

(defn- provenance [m]
  {"servedByClusterId" (optional-string m "servedByClusterId")
   "servedByGroupId" (optional-string m "servedByGroupId")
   "servedByNodeId" (optional-string m "servedByNodeId")
   "providerId" (optional-string m "providerId")
   "accountId" (optional-string m "accountId")})

(defn- final-flag [m]
  (if (absent? m "final") false (required-boolean m "final")))

(defmulti ^:private parse-body (fn [type _m] type))

(defmethod parse-body "hello" [_ m]
  (let [peer-did (required-string m "peerDid")
        environment (required-string m "environment")
        version (required-string m "bridgeAgentVersion")
        auth-mode (read-enum (get m "authMode") "authMode" auth-modes)
        hash (optional-string m "capabilitiesHash")
        labels (optional-string-array m "labels")
        topology (parse-topology-summary m)]
    {"peerDid" peer-did "environment" environment "bridgeAgentVersion" version "authMode" auth-mode
     "capabilitiesHash" hash "labels" labels "topology" topology}))

(defmethod parse-body "hello_ack" [_ m]
  {"sessionId" (required-string m "sessionId")
   "heartbeatIntervalMs" (required-non-negative-integer m "heartbeatIntervalMs")
   "maxConcurrentStreams" (required-non-negative-integer m "maxConcurrentStreams")
   "maxFrameBytes" (required-non-negative-integer m "maxFrameBytes")
   "resumeToken" (optional-string m "resumeToken")})

(defmethod parse-body "heartbeat" [_ m]
  {"sequence" (required-non-negative-integer m "sequence")
   "activeStreams" (optional-non-negative-integer m "activeStreams")
   "queuedRequests" (optional-non-negative-integer m "queuedRequests")})

(defmethod parse-body "capabilities" [_ m]
  (let [caps (get m "capabilities")]
    (when-not (sequential? caps) (invalid "bridge message capabilities must be an array"))
    {"capabilities" (vec (map-indexed (fn [i e] (parse-capability e (str "capabilities[" i "]"))) caps))}))

(defmethod parse-body "health_report" [_ m]
  {"health" (parse-health-report (get m "health"))})

(defmethod parse-body "request_open" [_ m]
  (let [stream-id (required-string m "streamId")
        method (required-string m "method")
        path (required-string m "path")
        headers (required-string-record m "headers")
        context (parse-request-context m)
        intent (parse-routing-intent m)
        origin-cluster (optional-string m "originClusterId")
        origin-node (optional-string m "originNodeId")
        hop-count (required-non-negative-integer m "hopCount")]
    {"streamId" stream-id "method" method "path" path "headers" headers
     "requestContext" context "routingIntent" intent
     "originClusterId" origin-cluster "originNodeId" origin-node "hopCount" hop-count}))

(defmethod parse-body "request_chunk" [_ m]
  (let [stream-id (required-string m "streamId")
        chunk (required-raw-string m "chunk")
        encoding (read-enum (get m "encoding") "encoding" chunk-encodings)]
    {"streamId" stream-id "chunk" chunk "encoding" encoding "final" (final-flag m)}))

(defmethod parse-body "response_head" [_ m]
  (let [stream-id (required-string m "streamId")
        status (required-non-negative-integer m "status")
        headers (required-string-record m "headers")]
    (merge {"streamId" stream-id "status" status "headers" headers} (provenance m))))

(defmethod parse-body "response_chunk" [_ m]
  (let [stream-id (required-string m "streamId")
        chunk (required-raw-string m "chunk")
        encoding (read-enum (get m "encoding") "encoding" chunk-encodings)
        final (final-flag m)]
    (merge {"streamId" stream-id "chunk" chunk "encoding" encoding "final" final} (provenance m))))

(defmethod parse-body "response_end" [_ m]
  (let [stream-id (required-string m "streamId")
        usage (parse-usage m)]
    (merge {"streamId" stream-id "usage" usage} (provenance m))))

(defmethod parse-body "error" [_ m]
  {"streamId" (optional-string m "streamId")
   "code" (required-string m "code")
   "message" (required-string m "message")
   "retryable" (required-boolean m "retryable")})

(defmethod parse-body :default [type _m]
  (invalid (str "unsupported bridge message type: " type)))

(defn parse-message
  "Normalized frame (string-keyed) from wire data, or throw ex-info
  {:error/type :federation/bridge-message-invalid} carrying the peer-visible message."
  [m]
  (when-not (wire-object? m) (invalid "bridge message must be an object"))
  (let [base (parse-base-envelope m)]
    (compact (merge base (parse-body (get base "type") m)))))

(defn parse-message-json
  "`parse-message` over JSON text. Malformed JSON throws the platform's parse error."
  [text]
  (parse-message (json/parse text)))

;; ---------------------------------------------------------------------------
;; Malli: the shape of a well-formed frame (inbound result and outbound input)
;; ---------------------------------------------------------------------------

(def ^:private Headers [:map-of :string :string])
(def ^:private Encoding (into [:enum] chunk-encodings))

(def ^:private Envelope
  [["type" :string]
   ["protocolVersion" [:= protocol-version]]
   ["sentAt" :string]
   ["traceId" :string]
   ["ownerSubject" :string]
   ["clusterId" :string]
   ["agentId" :string]
   ["sessionId" {:optional true} :string]
   ["streamId" {:optional true} :string]
   ["groupId" {:optional true} :string]
   ["nodeId" {:optional true} :string]])

(def ^:private Provenance
  [["servedByClusterId" {:optional true} :string]
   ["servedByGroupId" {:optional true} :string]
   ["servedByNodeId" {:optional true} :string]
   ["providerId" {:optional true} :string]
   ["accountId" {:optional true} :string]])

(def ^:private NonNegInt [:and :int [:>= 0]])

(def Frame
  "Malli schema of every bridge frame, dispatched on \"type\"."
  [:multi {:dispatch #(get % "type")}
   ["hello" (into [:map ["type" [:= "hello"]]]
                  (concat (rest Envelope)
                          [["peerDid" :string] ["environment" :string] ["bridgeAgentVersion" :string]
                           ["authMode" (into [:enum] auth-modes)]
                           ["capabilitiesHash" {:optional true} :string]
                           ["labels" [:vector :string]]
                           ["topology" {:optional true}
                            [:map ["groups" [:vector [:map ["groupId" :string] ["nodeIds" [:vector :string]]]]]
                             ["nodes" [:vector [:map ["groupId" :string] ["nodeId" :string] ["labels" [:vector :string]]]]]
                             ["defaultExecutionPolicy" {:optional true} (into [:enum] execution-policies)]]]]))]
   ["hello_ack" (into [:map ["type" [:= "hello_ack"]]]
                      (concat (remove #(= "sessionId" (first %)) (rest Envelope))
                              [["sessionId" :string] ["heartbeatIntervalMs" NonNegInt] ["maxConcurrentStreams" NonNegInt]
                               ["maxFrameBytes" NonNegInt] ["resumeToken" {:optional true} :string]]))]
   ["heartbeat" (into [:map ["type" [:= "heartbeat"]]]
                      (concat (rest Envelope)
                              [["sequence" NonNegInt] ["activeStreams" {:optional true} NonNegInt]
                               ["queuedRequests" {:optional true} NonNegInt]]))]
   ["capabilities" (into [:map ["type" [:= "capabilities"]]]
                         (concat (rest Envelope)
                                 [["capabilities"
                                   [:vector
                                    [:map ["providerId" :string] ["modelPrefixes" [:vector :string]] ["models" [:vector :string]]
                                     ["paths" {:optional true} [:vector :string]] ["routes" {:optional true} [:vector :string]]
                                     ["authType" (into [:enum] account-auth-types)]
                                     ["accountCount" NonNegInt] ["availableAccountCount" NonNegInt]
                                     ["supportsModelsList" :boolean] ["supportsChatCompletions" :boolean]
                                     ["supportsResponses" :boolean] ["supportsStreaming" :boolean]
                                     ["supportsWarmImport" :boolean]
                                     ["credentialMobility" (into [:enum] credential-mobilities)]
                                     ["credentialOrigin" :string]
                                     ["lastHealthyAt" {:optional true} :string] ["lastFailureAt" {:optional true} :string]
                                     ["failureClass" {:optional true} :string]
                                     ["topologyTargets" [:vector [:map ["groupId" :string] ["nodeId" :string]]]]]]]]))]
   ["health_report" (into [:map ["type" [:= "health_report"]]]
                          (concat (rest Envelope)
                                  [["health" [:map ["processHealthy" :boolean] ["upstreamHealthy" :boolean]
                                              ["availableAccountCount" NonNegInt] ["localOauthBootstrapReady" :boolean]
                                              ["queuedRequests" {:optional true} NonNegInt]
                                              ["nodes" [:vector [:map ["groupId" :string] ["nodeId" :string] ["reachable" :boolean]
                                                                 ["lastHealthyAt" {:optional true} :string]
                                                                 ["lastFailureAt" {:optional true} :string]
                                                                 ["failureClass" {:optional true} :string]]]]]]]))]
   ["request_open" (into [:map ["type" [:= "request_open"]]]
                         (concat (remove #(= "streamId" (first %)) (rest Envelope))
                                 [["streamId" :string] ["method" :string] ["path" :string] ["headers" Headers]
                                  ["requestContext" {:optional true} [:map-of :string :string]]
                                  ["routingIntent" {:optional true} [:map-of :string :string]]
                                  ["originClusterId" {:optional true} :string] ["originNodeId" {:optional true} :string]
                                  ["hopCount" NonNegInt]]))]
   ["request_chunk" (into [:map ["type" [:= "request_chunk"]]]
                          (concat (remove #(= "streamId" (first %)) (rest Envelope))
                                  [["streamId" :string] ["chunk" :string] ["encoding" Encoding] ["final" :boolean]]))]
   ["response_head" (into [:map ["type" [:= "response_head"]]]
                          (concat (remove #(= "streamId" (first %)) (rest Envelope)) Provenance
                                  [["streamId" :string] ["status" NonNegInt] ["headers" Headers]]))]
   ["response_chunk" (into [:map ["type" [:= "response_chunk"]]]
                           (concat (remove #(= "streamId" (first %)) (rest Envelope)) Provenance
                                   [["streamId" :string] ["chunk" :string] ["encoding" Encoding] ["final" :boolean]]))]
   ["response_end" (into [:map ["type" [:= "response_end"]]]
                         (concat (remove #(= "streamId" (first %)) (rest Envelope)) Provenance
                                 [["streamId" :string]
                                  ["usage" {:optional true} [:map-of :string NonNegInt]]]))]
   ["error" (into [:map ["type" [:= "error"]]]
                  (concat (rest Envelope)
                          [["code" :string] ["message" :string] ["retryable" :boolean]]))]])

(def ^:private frame-validator (m/validator Frame))
(def ^:private frame-explainer (m/explainer Frame))

(defn valid-frame? [frame] (boolean (and (map? frame) (frame-validator frame))))

(defn encode-frame
  "JSON text for an outbound frame. Throws ex-info {:error/type :federation/bridge-frame-invalid}
  when the frame is not a well-formed bridge-ws-v0 frame, so a malformed frame is
  a sender-side error rather than something the peer has to reject."
  [frame]
  (if (valid-frame? frame)
    (json/write frame)
    (throw (ex-info (str "bridge frame is not well-formed: "
                         (str/join "." (some-> (frame-explainer frame) :errors first :path)))
                    {:error/type :federation/bridge-frame-invalid}))))
