(ns proxx.http.reply
  "The client-visible shape of a provider reply, as a sequence of frames.

  A strategy decides what the client sees (which headers, which status, whether
  the body is buffered or relayed as it arrives); this namespace spells that out
  as data and `proxx.runtime.reply` interprets it against the Fastify reply.
  Nothing here touches a reply, a stream or a clock.

  Frames:
    [:header name value]   set a response header
    [:remove-header name]  drop a header already set
    [:code status]         set the status
    [:send body]           send `body` and finish (buffered reply)
    [:hijack status]       take over the raw response: status, every header set
                           so far, flush the head (the body is then streamed)
    [:write chunk]         write to the hijacked response
    [:end]                 end the hijacked response unless already ended

  The order of header frames is the order the headers reach the wire."
  (:require [proxx.http.proxy :as proxy]))

(def sse-translated-headers
  "Head of an SSE reply the proxy itself produced (a translated stream)."
  [["content-type" "text/event-stream; charset=utf-8"]
   ["cache-control" "no-cache"]
   ["x-accel-buffering" "no"]])

(def sse-relayed-headers
  "Head of an SSE reply relayed from upstream (content-type last, after the upstream copy)."
  [["cache-control" "no-cache"]
   ["x-accel-buffering" "no"]
   ["content-type" "text/event-stream; charset=utf-8"]])

(def provider-header "x-open-hax-upstream-provider")

(defn headers
  "Header frames for `[name value]` pairs."
  [pairs]
  (mapv (fn [[k v]] [:header k v]) pairs))

(defn provider-frames [provider-id]
  [[:header provider-header provider-id]])

(defn identity-frames
  "Who served the reply. Only legacy admin callers learn the account identity:
  tenant traffic must not see internal account ids, while trusted federation
  nodes keep their observability."
  [{:keys [provider-id auth-kind account-id auth-type]}]
  (cond-> (provider-frames provider-id)
    (= "legacy_admin" auth-kind)
    (conj [:header "x-open-hax-upstream-account" account-id]
          [:header "x-open-hax-upstream-auth-type" auth-type])))

(defn copy-upstream-frames
  "Upstream response headers worth relaying (hop-by-hop ones dropped)."
  [header-pairs]
  (headers (proxy/forwardable-response-headers header-pairs)))

(defn json-frames
  "A buffered JSON reply."
  [status body]
  [[:code status]
   [:header "content-type" "application/json"]
   [:send body]])

(defn sse-head-frames
  "The head of a buffered SSE reply (status and headers, no body yet)."
  []
  (into [[:code 200]] (headers sse-translated-headers)))

(defn sse-text-frames
  "A buffered SSE reply of text the proxy produced."
  [text]
  (conj (sse-head-frames) [:send text]))

(defn translated-stream-head
  "The head of a hijacked SSE reply the proxy produces chunk by chunk.
  `before`/`after` are frames set around the SSE headers (the provider header
  position differs between strategies, and so does the wire order)."
  [{:keys [before after] :or {before [] after []}}]
  (-> (vec before)
      (conj [:code 200])
      (into (headers sse-translated-headers))
      (into after)
      (conj [:hijack 200])))

(defn relay-prefix
  "The frames before an upstream response is relayed at `status`: the leading
  frames (identity), the status, the upstream's own headers."
  [{:keys [status lead upstream-headers]}]
  (-> (vec lead)
      (conj [:code status])
      (into (copy-upstream-frames upstream-headers))))

(defn relay-tail
  "The frames that turn a relayed reply into a hijacked SSE stream."
  [status]
  (-> [[:remove-header "content-length"]]
      (into (headers sse-relayed-headers))
      (conj [:hijack status])))

(defn relayed-stream-head
  "The head of a hijacked SSE reply relayed from upstream (see relay-prefix)."
  [{:keys [status] :as facts}]
  (into (relay-prefix facts) (relay-tail status)))

(defn error-frames
  "The reply for an upstream stream that carried an error payload."
  [provider-id error-payload]
  (-> (provider-frames provider-id)
      (into (json-frames 400 {"error" error-payload}))))
