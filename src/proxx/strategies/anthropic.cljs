(ns proxx.strategies.anthropic
  (:require [shadow.cljs.modern :refer (js-await)]))

(defn messages-passthrough [ctx]
  (try
    (let [fetch-fn (:fetch ctx js/fetch)
          endpoint (:endpoint ctx)
          body (:body ctx)
          credential (or (:it ctx) (first (:credentials ctx)))]
      (when (and fetch-fn endpoint credential)
        (let [resp (js-await (fetch-fn endpoint
                                       (clj->js {:method "POST"
                                                 :headers {:x-api-key (or (:secret credential) (:token credential))
                                                           :anthropic-version "2023-06-01"
                                                           :content-type "application/json"}
                                                 :body (js/JSON.stringify (clj->js body))})))]
          (when (.-ok resp)
            resp))))
    (catch :default _ nil)))
