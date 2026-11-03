(ns proxx.federation.bridge-reply
  "What the client-facing reply does while a bridged response arrives, as data.

  The relay yields response events (`response_head`, `response_chunk`,
  `response_end`, wire maps). `step` folds one event into the reply state and
  returns the effects to apply to the reply, in order; `finish` says how the
  reply ends. The edge (proxx.runtime.federation-routing) owns the Fastify
  reply and the raw socket and only interprets these effects.

  Effects:
    {:op :set-headers :pairs [[name value] ...]}   reply.header, in order
    {:op :remove-header :name n}
    {:op :status :code n}
    {:op :hijack :status n}      take over the raw response: status, headers so far, flush
    {:op :write :chunk s :encoding \"utf8\"|\"base64\"}   to the raw response
    {:op :buffer :chunk s :encoding e}                   held back for a single reply
    {:op :end-stream} | {:op :send :json? bool}          how the reply ends (`finish`)"
  (:require [clojure.string :as str]
            [proxx.federation.helpers :as helpers]
            [proxx.http.request :as request]
            [proxx.federation.routing :as routing]))

(def initial {:head? false :streaming? false :content-type ""})

(def ^:private sse-headers
  [["cache-control" "no-cache"]
   ["x-accel-buffering" "no"]
   ["content-type" "text/event-stream; charset=utf-8"]])

(defn- attribution-pairs [owner-subject peer-label]
  [[helpers/owner-subject-header owner-subject]
   [helpers/routed-peer-header peer-label]])

(defn- relayed-header-pairs
  "The upstream's headers minus content-length, which the reply recomputes."
  [headers]
  (into [] (remove (fn [[k _]] (= "content-length" (str/lower-case k)))) headers))

(defn- on-head [state event owner-subject peer-label]
  (let [status (get event "status")
        headers (get event "headers")
        content-type (routing/response-content-type headers)
        streaming? (routing/event-stream-content-type? content-type)]
    [(assoc state :head? true :streaming? streaming? :content-type content-type)
     (cond-> [{:op :set-headers :pairs (into (relayed-header-pairs headers) (attribution-pairs owner-subject peer-label))}
              {:op :status :code status}]
       streaming? (into [{:op :remove-header :name "content-length"}
                         {:op :set-headers :pairs sse-headers}
                         {:op :hijack :status status}]))]))

(defn- on-chunk [state event owner-subject peer-label]
  (let [implicit-head? (not (:head? state))
        chunk {:op (if (:streaming? state) :write :buffer)
               :chunk (get event "chunk") :encoding (get event "encoding")}]
    [(assoc state :head? true)
     (cond-> []
       implicit-head? (into [{:op :set-headers :pairs (attribution-pairs owner-subject peer-label)}
                             {:op :status :code 200}])
       true (conj chunk))]))

(defn step
  "[state' effects] after one relay response event. `response_end` (and anything
  unknown) changes nothing: the reply ends in `finish`, when the stream does."
  [state event {:keys [owner-subject peer-label]}]
  (case (get event "type")
    "response_head" (on-head state event owner-subject peer-label)
    "response_chunk" (on-chunk state event owner-subject peer-label)
    [state []]))

(defn finish
  "How the reply ends once the event stream is exhausted: a hijacked stream is
  ended; otherwise the buffered body is sent, parsed as JSON only when the head said so."
  [{:keys [streaming? content-type]}]
  (if streaming?
    {:op :end-stream}
    {:op :send :json? (routing/json-content-type? content-type)}))

;; ---------------------------------------------------------------------------
;; Serving a request that arrived over the bridge
;; ---------------------------------------------------------------------------

(defn provenance
  "Who served a bridged response: the self identity from the environment (trimmed; unset stays absent)
  and the upstream provider the response named."
  [env provider-id]
  (let [t (fn [k] (when-let [v (get env k)] (str/trim v)))]
    (cond-> {}
      (t "FEDERATION_SELF_CLUSTER_ID") (assoc "servedByClusterId" (t "FEDERATION_SELF_CLUSTER_ID"))
      (t "FEDERATION_SELF_GROUP_ID") (assoc "servedByGroupId" (t "FEDERATION_SELF_GROUP_ID"))
      (t "FEDERATION_SELF_NODE_ID") (assoc "servedByNodeId" (t "FEDERATION_SELF_NODE_ID"))
      (some? provider-id) (assoc "providerId" provider-id))))

(defn head-event [provenance status headers]
  (merge {"type" "response_head" "status" status "headers" headers} provenance))

(defn chunk-event [provenance chunk encoding]
  (merge {"type" "response_chunk" "chunk" chunk "encoding" encoding} provenance))

(defn end-event [provenance]
  (merge {"type" "response_end"} provenance))

(defn native-injection-headers
  "Headers of the in-process request a native Ollama call is re-injected as. With a proxy token
  configured, a client that already presented it keeps its own Authorization; anyone else is
  given the token (the call is in-process and already admitted)."
  [proxy-auth-token client-authorization]
  (cond-> {"content-type" "application/json"}
    (seq proxy-auth-token)
    (assoc "authorization"
           (if (and (string? client-authorization) (request/bearer-token? client-authorization proxy-auth-token))
             client-authorization
             (str "Bearer " proxy-auth-token)))))
