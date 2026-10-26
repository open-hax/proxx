(ns proxx.web.fx
  "Effect descriptions. Event handlers return `[db' effects]`; the edge
  (`proxx.web.runtime`) interprets each effect. Effects are plain vectors so
  handlers stay pure and testable.

  `[:http request on-ok on-err]`   perform `request` (see `proxx.web.api`),
                                   then dispatch `(conj on-ok decoded)` or
                                   `(conj on-err message)`
  `[:http-all [request ...] on-ok on-err]`  all requests; `on-ok` gets a vector
  `[:storage/write key value]`     persist JSON to localStorage
  `[:storage/write-raw key string]`  persist a bare string
  `[:token/save token]`            persist the proxy token (storage + cookie)
  `[:dispatch-later ms event]`     dispatch `event` after `ms`
  `[:interval/start id ms event]`  dispatch `event` every `ms` (replaces `id`)
  `[:interval/stop id]`
  `[:nav/push path]`               history.pushState
  `[:clipboard/write text on-ok on-err]`
  `[:ws/open id path on-event]`    open a WebSocket to `path` on the API origin; each
                                   JSON message dispatches `(conj on-event data)`
  `[:ws/close id]`")

(defn http
  ([request on-ok] (http request on-ok [:app/ignore]))
  ([request on-ok on-err] [:http request on-ok on-err]))

(defn http-all [requests on-ok on-err] [:http-all requests on-ok on-err])

(defn ws-open [id path on-event] [:ws/open id path on-event])
(defn ws-close [id] [:ws/close id])

(defn storage-write [k v] [:storage/write k v])
(defn dispatch-later [ms event] [:dispatch-later ms event])
(defn interval-start [id ms event] [:interval/start id ms event])
(defn interval-stop [id] [:interval/stop id])
