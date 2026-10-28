(ns proxx.runtime.request-log-hubs
  "The request-log hubs (formerly RequestLogSseHub / RequestLogWsHub): each owns
  its sockets in one atom keyed by the client ids it registers with the fan-out
  state (proxx.runtime.observability), which decides who receives each entry.
  A hub subscribes to the request log store on construction."
  (:require ["ws" :as ws]
            [proxx.runtime.observability :as observability]))

(defn- hello-sse [subscription]
  (str "event: hello\ndata: " (js/JSON.stringify #js {"type" "hello" "protocol" "request-log-sse-v0"
                                                      "now" (.toISOString (js/Date.)) "subscription" subscription})
       "\n\n"))

(defn create-request-log-sse-hub-js
  "`{addClient(res, identity, subscription) => remove, close()}` over `store`."
  [^js store]
  (let [clients (atom {})
        next-id (atom 0)
        ^js fanout (observability/create-request-log-fanout-js)
        drop! (fn [client-id] (swap! clients dissoc client-id) (.unsubscribe fanout client-id))
        broadcast!
        (fn [^js event]
          (when (seq @clients)
            (doseq [[client-id ^js res] @clients]
              (when (.-writableEnded res) (drop! client-id)))
            (let [text (js/JSON.stringify #js {"type" (.eventType fanout (.-type event)) "entry" (.-entry event)})]
              (doseq [client-id (array-seq (.recipients fanout (.-entry event)))]
                (when-let [^js res (get @clients client-id)]
                  (try (.write res (str "event: request_log\ndata: " text "\n\n"))
                       (catch :default _ (drop! client-id))))))))
        unsubscribe (.subscribe store broadcast!)]
    #js {:addClient (fn [^js res identity subscription]
                      (let [client-id (str "sse-" (let [n @next-id] (swap! next-id inc) n))
                            remove! (fn [] (drop! client-id) js/undefined)]
                        (swap! clients assoc client-id res)
                        (.subscribe fanout client-id identity subscription)
                        (.write res (hello-sse subscription))
                        (.on res "close" remove!)
                        remove!))
         :close (fn ^:async close []
                  (unsubscribe)
                  (doseq [[_ ^js res] @clients]
                    (try (.end res) (catch :default _ nil)))
                  (reset! clients {})
                  (.clear fanout)
                  js/undefined)}))

(defn- write-upgrade-response! [^js socket status-code status-text payload]
  (let [body (js/JSON.stringify payload)]
    (.write socket (str "HTTP/1.1 " status-code " " status-text "\r\n"
                        "Connection: close\r\n"
                        "Content-Type: application/json; charset=utf-8\r\n"
                        "Content-Length: " (js/Buffer.byteLength body) "\r\n"
                        "\r\n"
                        body))
    (.destroy socket)))

(defn- wire-entry
  "The entry with `decodeTps` (= tps) appended, as a fresh object."
  [^js entry]
  (let [o (js/Object.assign #js {} entry)]
    (aset o "decodeTps" (.-tps entry))
    o))

(defn create-request-log-ws-hub-js
  "`{rejectUpgrade, handleAuthorizedUpgrade, close}` over `store`."
  [^js store]
  (let [^js server (new (aget ws "WebSocketServer") #js {"noServer" true})
        open-state (.-OPEN ^js (aget ws "WebSocket"))
        clients (atom {})
        next-id (atom 0)
        ^js fanout (observability/create-request-log-fanout-js)
        drop! (fn [client-id] (swap! clients dissoc client-id) (.unsubscribe fanout client-id))
        broadcast!
        (fn [^js event]
          (when (seq @clients)
            (let [payload (js/JSON.stringify #js {"type" (.eventType fanout (.-type event)) "entry" (wire-entry (.-entry event))})]
              (doseq [client-id (array-seq (.recipients fanout (.-entry event)))]
                (let [^js client (get @clients client-id)]
                  (when (and client (= open-state (.-readyState client)))
                    (try (.send client payload)
                         (catch :default _
                           (try (.terminate client) (catch :default _ nil))
                           (drop! client-id)))))))))
        unsubscribe (.subscribe store broadcast!)]
    #js {:rejectUpgrade (fn [socket status-code payload]
                          (write-upgrade-response! socket status-code
                                                   (case status-code 401 "Unauthorized" 403 "Forbidden" "Not Found")
                                                   payload))
         :handleAuthorizedUpgrade
         (fn [request socket head identity subscription]
           (.handleUpgrade server request socket head
                           (fn [^js web-socket]
                             (let [client-id (str "ws-" (let [n @next-id] (swap! next-id inc) n))
                                   remove! (fn [] (drop! client-id))]
                               (swap! clients assoc client-id web-socket)
                               (.subscribe fanout client-id identity subscription)
                               (.on web-socket "close" remove!)
                               (.on web-socket "error" remove!)
                               (.send web-socket (js/JSON.stringify #js {"type" "hello" "protocol" "request-log-ws-v0"
                                                                         "now" (.toISOString (js/Date.)) "subscription" subscription})))))
           js/undefined)
         :close (fn ^:async close []
                  (unsubscribe)
                  (doseq [^js client (array-seq (js/Array.from (.-clients server)))] (.close client))
                  (await (js/Promise. (fn [resolve _] (.close server (fn [] (resolve js/undefined))))))
                  (reset! clients {})
                  (.clear fanout)
                  js/undefined)}))
