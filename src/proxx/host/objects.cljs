(ns proxx.host.objects
  "The few host objects that are not a facade over a kernel (formerly the real logic of
  src/lib/provider-utils.ts, openai-oauth.ts, db/event-labelers.ts and the observability
  hubs): typed errors, event labelers, the request-log SSE/WebSocket hubs and the
  chroma embedding function.

  Everything here is a plain JS value with string-keyed properties (Closure advanced
  must not rename what the route code and third-party packages read), built by a
  function. No class is needed:
  * `OpenAiHttpError` / `OpenAiOAuthRefreshError` were only ever tested with
    `instanceof` by our own code, so an Error carrying a private Symbol marker is
    the same check without a subclass.
  * chromadb looks its embedding function up by name and calls `buildFromConfig` on
    it, so the registered value is a plain object with that one function."
  (:require ["chromadb" :as chroma]
            ["ws" :as ws]
            [proxx.runtime.chroma :as chroma-edge]
            [proxx.runtime.events :as events]
            [proxx.runtime.oauth :as oauth]
            [proxx.runtime.observability :as observability]))

(defn- marked-error
  "An Error `message` whose own enumerable properties are `props` ({string value}),
  tagged with `marker` (a Symbol) so `marked?` can recognise it."
  [marker name message cause props]
  (let [error (js/Error. message #js {"cause" cause})]
    (aset error "name" name)
    (doseq [[k v] props] (aset error k v))
    (aset error marker true)
    error))

(defn- marked? [marker x]
  (and (instance? js/Error x) (true? (aget x marker))))

;; ---------------------------------------------------------------------------
;; Typed errors
;; ---------------------------------------------------------------------------

(def ^:private http-error-marker (js/Symbol.for "proxx.OpenAiHttpError"))

(defn make-open-ai-http-error
  "`{message, statusCode, type, code?, meta?, cause?}` -> an Error the application's error
  handler renders as an OpenAI-shaped error."
  [^js input]
  (marked-error http-error-marker "OpenAiHttpError" (.-message input) (.-cause input)
                [["statusCode" (.-statusCode input)] ["type" (.-type input)]
                 ["code" (.-code input)] ["meta" (.-meta input)]]))

(defn open-ai-http-error? [error] (marked? http-error-marker error))

(def ^:private refresh-error-marker (js/Symbol.for "proxx.OpenAiOAuthRefreshError"))

(defn make-open-ai-oauth-refresh-error
  "(status, message, {code?, type?, responseBody?}) -> the Error the OAuth manager raises when
  OpenAI refuses a refresh."
  [status message ^js details]
  (marked-error refresh-error-marker "OpenAiOAuthRefreshError" message js/undefined
                [["status" status] ["code" (some-> details .-code)] ["type" (some-> details .-type)]
                 ["responseBody" (some-> details .-responseBody)]]))

(defn terminal-open-ai-refresh-error?
  "A refresh refusal that retrying cannot fix (the facts are judged by the OAuth kernel)."
  [error]
  (and (marked? refresh-error-marker error)
       (boolean (oauth/is-terminal-openai-refresh-error-facts-js
                 #js {"status" (aget error "status") "code" (aget error "code") "type" (aget error "type")
                      "message" (.-message ^js error) "responseBody" (aget error "responseBody")}))))

;; ---------------------------------------------------------------------------
;; OAuth managers
;; ---------------------------------------------------------------------------

(def ^:private openai-callback-port
  (delay (oauth/resolve-openai-callback-port-js (aget js/process.env "OPENAI_OAUTH_CALLBACK_PORT"))))

(defn create-openai-oauth-manager
  "The OpenAI OAuth manager for `options` ({oauthScopes, clientId, issuer, clientSecret, fetchFn?, now?, ...})."
  [^js options]
  (oauth/create-openai-oauth-manager-js
   options
   #js {"fetchFn" (or (.-fetchFn options) js/fetch)
        "now" (or (.-now options) (fn [] (js/Date.now)))
        "callbackPort" @openai-callback-port
        "randomBytes" (fn [length] (js/crypto.getRandomValues (js/Uint8Array. length)))
        "makeRefreshError" make-open-ai-oauth-refresh-error}))

(defn create-factory-oauth-manager [^js options]
  (oauth/create-factory-oauth-manager-js
   options
   #js {"fetchFn" (or (.-fetchFn options) js/fetch)
        "now" (or (.-now options) (fn [] (js/Date.now)))
        "randomUUID" (fn [] (js/crypto.randomUUID))}))

;; ---------------------------------------------------------------------------
;; Event labelers
;; ---------------------------------------------------------------------------

(defn create-default-labelers
  "The default event labelers, as `{id, applies(event), label(event)}` objects."
  []
  (to-array
   (map (fn [id] #js {"id" id
                      "applies" (fn [event] (events/event-labeler-applies-js id event))
                      "label" (fn [event] (events/event-labeler-label-js id event))})
        ["error_classifier" "tool_use" "content_pattern" "response_quality" "cost_tier"])))

;; ---------------------------------------------------------------------------
;; Request-log hubs
;; ---------------------------------------------------------------------------

(defn create-request-log-sse-hub
  "Server-sent-event fan-out of request-log events to the clients added with `addClient`;
  who receives an entry is the fan-out kernel's decision."
  [^js store]
  (let [clients (js/Map.)
        ^js fanout (observability/create-request-log-fanout-js)
        next-id (volatile! -1)
        drop! (fn [id] (.delete clients id) (.unsubscribe fanout id))
        broadcast! (fn [^js event]
                     (when (pos? (.-size clients))
                       (doseq [[id ^js res] (js/Array.from (.entries clients))]
                         (when (.-writableEnded res) (drop! id)))
                       (let [entry (.-entry event)
                             payload (js/JSON.stringify #js {"type" (.eventType fanout (.-type event)) "entry" entry})]
                         (doseq [id (array-seq (.recipients fanout entry))]
                           (when-let [^js res (.get clients id)]
                             (try (.write res (str "event: request_log\ndata: " payload "\n\n"))
                                  (catch :default _ (drop! id))))))))
        unsubscribe (.subscribe store broadcast!)]
    #js {"addClient"
         (fn [^js res identity subscription]
           (let [id (str "sse-" (vswap! next-id inc))
                 remove! (fn [] (drop! id))]
             (.set clients id res)
             (.subscribe fanout id identity subscription)
             (.write res (str "event: hello\ndata: "
                              (js/JSON.stringify #js {"type" "hello" "protocol" "request-log-sse-v0"
                                                      "now" (.toISOString (js/Date.)) "subscription" subscription})
                              "\n\n"))
             (.on res "close" remove!)
             remove!))
         "close"
         (fn ^:async close []
           (unsubscribe)
           (doseq [^js res (array-seq (js/Array.from (.values clients)))]
             (try (.end res) (catch :default _ nil)))
           (.clear clients)
           (.clear fanout))}))

(defn- write-upgrade-response! [^js socket status status-text payload]
  (let [body (js/JSON.stringify payload)]
    (.write socket (str "HTTP/1.1 " status " " status-text "\r\n"
                        "Connection: close\r\n"
                        "Content-Type: application/json; charset=utf-8\r\n"
                        "Content-Length: " (js/Buffer.byteLength body) "\r\n\r\n"
                        body))
    (.destroy socket)))

(defn- wire-entry
  "The entry as the WebSocket protocol sends it: `decodeTps` mirrors `tps`."
  [^js entry]
  (let [out (js/Object.assign #js {} entry)]
    (aset out "decodeTps" (.-tps entry))
    out))

(defn create-request-log-ws-hub
  "WebSocket fan-out of request-log events: `handleAuthorizedUpgrade` adopts an upgrade
  the route has already authorised, `rejectUpgrade` answers one it has not."
  [^js store]
  (let [^js ws-server (js/Reflect.construct (.-WebSocketServer ^js ws) #js [#js {"noServer" true}])
        open-state (.-OPEN ^js (.-WebSocket ^js ws))
        clients (js/Map.)
        ^js fanout (observability/create-request-log-fanout-js)
        next-id (volatile! -1)
        drop! (fn [id] (.delete clients id) (.unsubscribe fanout id))
        broadcast! (fn [^js event]
                     (when (pos? (.-size clients))
                       (let [payload (js/JSON.stringify #js {"type" (.eventType fanout (.-type event))
                                                             "entry" (wire-entry (.-entry event))})]
                         (doseq [id (array-seq (.recipients fanout (.-entry event)))]
                           (let [^js client (.get clients id)]
                             (when (and client (= open-state (.-readyState client)))
                               (try (.send client payload)
                                    (catch :default _
                                      (try (.terminate client) (catch :default _ nil))
                                      (drop! id)))))))))
        unsubscribe (.subscribe store broadcast!)]
    #js {"rejectUpgrade"
         (fn [socket status payload]
           (write-upgrade-response! socket status (case status 401 "Unauthorized" 403 "Forbidden" "Not Found") payload))
         "handleAuthorizedUpgrade"
         (fn [request socket head identity subscription]
           (.handleUpgrade ws-server request socket head
                           (fn [^js web-socket]
                             (let [id (str "ws-" (vswap! next-id inc))
                                   remove! (fn [] (drop! id))]
                               (.set clients id web-socket)
                               (.subscribe fanout id identity subscription)
                               (.on web-socket "close" remove!)
                               (.on web-socket "error" remove!)
                               (.send web-socket (js/JSON.stringify
                                                  #js {"type" "hello" "protocol" "request-log-ws-v0"
                                                       "now" (.toISOString (js/Date.)) "subscription" subscription}))))))
         "close"
         (fn ^:async close []
           (unsubscribe)
           (doseq [^js client (array-seq (js/Array.from (.-clients ws-server)))] (.close client))
           (await (js/Promise. (fn [resolve _] (.close ws-server (fn [] (resolve nil))))))
           (.clear clients)
           (.clear fanout))}))

;; ---------------------------------------------------------------------------
;; chroma embedding function
;; ---------------------------------------------------------------------------

(declare ollama-embedding-registration)

(defn make-ollama-embedding-function
  "(url, model) -> an embedding function for a chroma collection (chromadb's embedding-function
  interface; the vectors come from `proxx.runtime.chroma`). chromadb reads
  `ef.constructor.buildFromConfig` to decide whether a function can be stored by name, so
  `constructor` is the registration object."
  [url model]
  (let [generate (fn [texts] (chroma-edge/ollama-generate-js url model texts))]
    #js {"name" "ollama"
         "generate" generate
         "generateForQueries" generate
         "defaultSpace" (fn [] "cosine")
         "supportedSpaces" (fn [] #js ["cosine" "l2" "ip"])
         "getConfig" (fn [] #js {"url" url "model_name" model})
         "validateConfig" (fn [config] (chroma-edge/ollama-validate-config-js config))
         "validateConfigUpdate" (fn [_] nil)
         "constructor" ollama-embedding-registration}))

(def ^:private ollama-embedding-registration
  "What chromadb stores under the name `ollama`: it only ever calls `buildFromConfig` on it."
  #js {"buildFromConfig" (fn [config]
                           (let [^js built (chroma-edge/ollama-build-config-js config)]
                             (make-ollama-embedding-function (.-url built) (.-model built))))})

(defn register-ollama-embedding-function!
  "Make chromadb able to rebuild the `ollama` embedding function from a collection's stored config."
  []
  (when-not (.has ^js (.-knownEmbeddingFunctions ^js chroma) "ollama")
    ((.-registerEmbeddingFunction ^js chroma) "ollama" ollama-embedding-registration)))

(defn chroma-client-class [] (.-ChromaClient ^js chroma))
(defn chroma-include-enum [] (.-IncludeEnum ^js chroma))
