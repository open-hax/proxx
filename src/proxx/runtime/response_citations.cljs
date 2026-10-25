(ns proxx.runtime.response-citations
  "JS edge for src/lib/response-utils.ts: JS payloads in, plain JS objects out."
  (:require [proxx.compat.response-citations :as rc]))

(defn- citation->js [{:keys [url title]}]
  (let [o #js {:url url}]
    (when title (aset o "title" title))
    o))

(defn extract-response-text-and-url-citations-js [payload]
  (let [{:keys [text citations response-id]} (rc/extract-text-and-url-citations (js->clj payload))
        o #js {:text text :citations (to-array (map citation->js citations))}]
    (when response-id (aset o "responseId" response-id))
    o))

(defn extract-markdown-links-js [text]
  (to-array (map citation->js (rc/extract-markdown-links text))))
