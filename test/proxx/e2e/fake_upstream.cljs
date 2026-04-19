(ns proxx.e2e.fake-upstream
  (:require [proxx.e2e.fixtures :as fx]))

(defn ->json [x]
  (if (string? x)
    x
    (js/JSON.stringify (clj->js x))))

(defn make-server
  [scenario-seq]
  (let [http       (js/require "http")
        requests   (atom [])
        call-count (atom 0)
        scenes     (mapv #(get fx/scenarios % (get fx/scenarios :success)) scenario-seq)
        get-scene  (fn []
                     (let [i (min @call-count (dec (count scenes)))]
                       (swap! call-count inc)
                       (nth scenes i)))
        handler    (fn [req res]
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
                                 delay-ms)))))
        srv        (.createServer http handler)
        port-p     (js/Promise.
                    (fn [done _]
                      (.listen srv 0 "127.0.0.1"
                               (fn [] (done (.-port (.address srv)))))))]
    {:srv      srv
     :port-p   port-p
     :requests requests
     :close!   (fn [] (.close srv))}))

(defn with-server
  [scenario-seq f]
  (let [{:keys [port-p requests close!]} (make-server scenario-seq)]
    (.then port-p
           (fn [port]
             (-> (js/Promise.resolve (f port requests))
                 (.finally close!))))))
