(ns proxx.compat.response-citations
  "Reading text and URL citations out of an OpenAI Responses payload, and
  Markdown links out of plain text (the pure half of src/lib/response-utils.ts).
  Payloads are string-keyed wire data; anything malformed is skipped, never fatal."
  (:require [clojure.string :as str]))

(defn- non-blank-trimmed [x]
  (when (string? x)
    (let [t (str/trim x)] (when-not (str/blank? t) t))))

(defn- distinct-by-url
  "First citation per url, in encounter order."
  [citations]
  (:out (reduce (fn [{:keys [seen] :as acc} {:keys [url] :as c}]
                  (if (contains? seen url)
                    acc
                    (-> acc (update :seen conj url) (update :out conj c))))
                {:seen #{} :out []}
                citations)))

(defn- sequence-of [x] (if (sequential? x) x []))

(defn- assistant-message? [item]
  (and (map? item)
       (= "message" (get item "type"))
       (let [role (get item "role")] (or (not (string? role)) (= "assistant" role)))))

(defn- output-text-parts [payload]
  (->> (sequence-of (get payload "output"))
       (filter assistant-message?)
       (mapcat #(sequence-of (get % "content")))
       (filter #(and (map? %) (= "output_text" (get % "type"))))))

(defn- url-citation [ann]
  (when (and (map? ann) (= "url_citation" (get ann "type")))
    (let [url (get ann "url")]
      (when (and (string? url) (seq url))
        (if-let [title (non-blank-trimmed (get ann "title"))]
          {:url url :title title}
          {:url url})))))

(defn extract-text-and-url-citations
  "{:text :citations :response-id} for a Responses payload. Text is the assistant
  output_text parts joined by a blank line and trimmed; citations are the
  url_citation annotations, de-duplicated by url (first title wins)."
  [payload]
  (if-not (map? payload)
    {:text "" :citations []}
    (let [parts (output-text-parts payload)
          texts (into [] (comp (map #(get % "text")) (filter #(and (string? %) (seq %)))) parts)]
      (cond-> {:text (str/trim (str/join "\n\n" texts))
               :citations (->> parts
                               (mapcat #(sequence-of (get % "annotations")))
                               (keep url-citation)
                               distinct-by-url)}
        (string? (get payload "id")) (assoc :response-id (get payload "id"))))))

(defn extract-markdown-links
  "[{:url :title?}] for each distinct `[title](http(s)://url)` in `text`."
  [text]
  (->> (re-seq #"\[([^\]]+)\]\((https?://[^)\s]+)\)" text)
       (keep (fn [[_ title url]]
               (let [url (str/trim url) title (str/trim title)]
                 (when (seq url)
                   (cond-> {:url url} (seq title) (assoc :title title))))))
       distinct-by-url))
