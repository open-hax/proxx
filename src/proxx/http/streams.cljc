(ns proxx.http.streams
  "Pure decisions for the control-plane streaming routes (request-log SSE and
  WebSocket, bridge SSE): the headers and frames a stream starts with, which
  subscription a query asks for, who may bind a bridge session and which
  WebSocket origins are accepted. The sockets and timers are the edge's."
  (:require [clojure.string :as str]
            [proxx.federation.sse-channel :as sse]
            [proxx.json :as json]))

(def sse-headers
  {"Content-Type" "text/event-stream"
   "Cache-Control" "no-cache"
   "Connection" "keep-alive"
   "X-Accel-Buffering" "no"})

(def keepalive-interval-ms 15000)
(def keepalive-frame ": keepalive\n\n")

(def bridge-sse-protocol-version "bridge-sse-v0")

(def ^:private route-kinds #{"local" "federated" "bridge" "routed" "any"})

(defn route-kind
  "The request-log route kind a query names (trimmed, lower-cased), or nil when
  it is not one of the known kinds."
  [value]
  (when (string? value)
    (let [normalized (str/lower-case (str/trim value))]
      (when (contains? route-kinds normalized) normalized))))

(defn- trimmed-nes [value]
  (when (string? value) (not-empty (str/trim value))))

(defn request-log-subscription
  "What an observability stream subscribes to: {:ownerSubject :routeKind}, absent
  filters omitted."
  [owner-subject route-kind-value]
  (cond-> {}
    (trimmed-nes owner-subject) (assoc :ownerSubject (trimmed-nes owner-subject))
    (route-kind route-kind-value) (assoc :routeKind (route-kind route-kind-value))))

(defn identity-of
  "The identity a hub/relay is told about: the legacy admin stays itself, every
  other federation manager is a ui_session. `with-subject?` adds the subject
  (bridge sessions are bound to it)."
  [auth with-subject?]
  (cond-> {:authKind (if (= "legacy_admin" (get auth "kind")) "legacy_admin" "ui_session")}
    (some? (get auth "tenantId")) (assoc :tenantId (get auth "tenantId"))
    (and with-subject? (some? (get auth "subject"))) (assoc :subject (get auth "subject"))))

(defn- trimmed-or-empty [s] (if (string? s) (str/trim s) ""))

(defn can-access-session?
  "May `identity` ({:authKind :subject :tenantId}) use bridge `session`
  ({:authSubject :tenantId})? The legacy admin always; anyone else only with the
  same non-empty subject and the same tenant."
  [identity session]
  (or (= "legacy_admin" (get identity :authKind))
      (let [id-subject (trimmed-or-empty (get identity :subject))
            session-subject (trimmed-or-empty (get session :authSubject))]
        (and (seq id-subject)
             (seq session-subject)
             (= id-subject session-subject)
             (= (trimmed-or-empty (get identity :tenantId)) (trimmed-or-empty (get session :tenantId)))))))

(defn origin-allowed?
  "CSRF check for WebSocket upgrades: no Origin header is accepted (not a
  browser); otherwise the origin must be localhost, 127.0.0.1 (any port for the
  http forms) or the forwarded/own host."
  [origin forwarded-host]
  (or (not (seq origin))
      (contains? #{"http://localhost" "http://127.0.0.1"
                   (str "http://" forwarded-host) (str "https://" forwarded-host)} origin)
      (str/starts-with? origin "http://localhost:")
      (str/starts-with? origin "http://127.0.0.1:")))

(defn sse-open-frame
  "The first frame of a bridge SSE stream: bound to a session when one was given."
  [session-id sent-at]
  (if session-id
    (sse/event-frame "session_bound" (json/write {"sessionId" session-id "sentAt" sent-at
                                       "message" "SSE channel bound to bridge session"}))
    (sse/event-frame "sse_open" (json/write {"protocolVersion" bridge-sse-protocol-version "sentAt" sent-at
                                              "message" "SSE connection established. POST hello first, then reconnect with sessionId."}))))
