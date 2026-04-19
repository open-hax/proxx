(ns proxx.e2e.fake-upstream
  (:require [clojure.string :as str]
            [proxx.e2e.fixtures :as fx]))

;; ── JSON serialisation ────────────────────────────────────────────────────────

(defn ->json [x]
  (if (string? x)
    x
    (js/JSON.stringify (clj->js x))))

;; ── Response sequence ─────────────────────────────────────────────────────────
;; A server can be given a *sequence* of scenario keys; it serves them in order,
;; repeating the last one once exhausted.  This models transient failures followed
;; by recovery without restarting the server.

(defn make-server
  "Creates and starts an HTTP server that serves a sequence of fixture scenarios.

   `scenario-seq` - vector of scenario keys from fixtures/scenarios, e.g.
                    [:rate-limited :rate-limited :success]

   Returns a map:
     :server   - the raw node http.Server
     :port     - the port it is listening on
     :requests - atom containing a vec of {:method :path :body :headers} seen
     :close!   - zero-arg fn that stops the server"
  [scenario-seq]
  (let [http      (js/require "http")
        requests  (atom [])
        idx       (atom 0)
        get-scene (fn []
                    (let [i   @idx
                          seq (mapv #(get fx/scenarios % (get fx/scenarios :success))
                                    scenario-seq)
                          scene (nth seq (min i (dec (count seq))))]
                      (swap! idx inc)
                      scene))
        handler   (fn [req res]
                    (let [chunks (atom [])]
                      (.on req "data" #(swap! chunks conj %))
                      (.on req "end"
                           (fn []
                             (let [body-str  (.join (into-array @chunks) "")
                                   scene     (get-scene)
                                   status    (:status scene 200)
                                   headers   (:headers scene {})
                                   body-out  (->json (:body scene ""))
                                   delay-ms  (:body-delay scene 0)]
                               (swap! requests conj
                                      {:method  (.-method req)
                                       :path    (.-url req)
                                       :body    body-str
                                       :headers (js->clj (.-headers req))})
                               (js/setTimeout
                                (fn []
                                  (.writeHead res status (clj->js headers))
                                  (.end res body-out))
                                delay-ms))))))
        server    (.createServer http handler)
        port-p    (js/Promise.
                   (fn [resolve _]
                     (.listen server 0 "127.0.0.1"
                              (fn []
                                (resolve (.-port (.address server)))))))]
    {:server   server
     :port-p   port-p
     :requests requests
     :close!   (fn [] (.close server))}))

(defn with-server
  "Async helper: starts a server for `scenario-seq`, calls `(f port requests)`,
   then closes the server.  Returns a Promise."
  [scenario-seq f]
  (let [{:keys [server port-p requests close!]} (make-server scenario-seq)]
    (.then port-p
           (fn [port]
             (-> (js/Promise.resolve (f port requests))
                 (.finally close!))))))
