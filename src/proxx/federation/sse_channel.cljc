(ns proxx.federation.sse-channel
  "Server-sent-event framing for the bridge's SSE transport (pure text).

  A bridge frame travels as one `data:` event; a deliberate close with an
  application code (>= 4000) is announced with a final `close` event so the
  peer can tell a policy close from a dropped connection.")

(def close-event-threshold 4000)

(defn data-frame [data] (str "data: " data "\n\n"))

(defn event-frame
  "A named event; `data-json` is already serialized."
  [event data-json]
  (str "event: " event "\ndata: " data-json "\n\n"))

(defn close-frame
  "The `close` event announcing `code` and `reason-json` (a serialized string),
  or nil when the close carries no application code."
  [code reason-json]
  (when (and (number? code) (not (zero? code)) (>= code close-event-threshold))
    (str "event: close\ndata: {\"code\":" code ",\"reason\":" reason-json "}\n\n")))
