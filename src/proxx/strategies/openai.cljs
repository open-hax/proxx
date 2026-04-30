(ns proxx.strategies.openai
  (:require [shadow.cljs.modern :refer (js-await)]))

(defn chat-completions-passthrough [ctx]
  (try
    (let [fetch-fn (:fetch ctx js/fetch)
          endpoint (:endpoint ctx)
          body (:body ctx)
          credential (or (:it ctx) (first (:credentials ctx)))]
      (when (and fetch-fn endpoint credential)
        (let [resp (js-await (fetch-fn endpoint
                                       (clj->js {:method "POST"
                                                 :headers {:authorization (str "Bearer " (or (:secret credential) (:token credential)))
                                                           :content-type "application/json"}
                                                 :body (js/JSON.stringify (clj->js body))})))]
          (when (.-ok resp)
            resp))))
    (catch :default _ nil)))
