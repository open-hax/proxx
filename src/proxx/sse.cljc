(ns proxx.sse
  "Pure Server-Sent Events reading.

  An SSE body becomes a sequence of events; every question we ask of a stream
  (is it an error, does it reason, is it empty) is a predicate over that
  sequence. JSON parsing is injected (`parse` returns data or throws) so this
  namespace stays free of any runtime."
  (:require [clojure.string :as str]))

(defn data-lines
  "Non-empty `data:` payloads of an SSE body, in order."
  [body]
  (->> (str/split-lines body)
       (map str/trim)
       (filter #(str/starts-with? % "data:"))
       (map #(str/trim (subs % 5)))
       (remove str/blank?)))

(defn strip-comment-lines
  "Drop SSE comment lines (those starting with `:`)."
  [body]
  (->> (str/split body #"\r?\n" -1)
       (remove #(str/starts-with? % ":"))
       (str/join "\n")))

(defn events
  "Lazy events of `body`, `[DONE]` sentinels removed. Each event is
  {:data raw-string :parsed data} or, when the fragment is not JSON,
  {:data raw-string :malformed? true}."
  [parse body]
  (->> (data-lines body)
       (remove #{"[DONE]"})
       (map (fn [data]
              (try {:data data :parsed (parse data)}
                   (catch #?(:clj Exception :cljs :default) _
                     {:data data :malformed? true}))))))

;; ---------------------------------------------------------------------------
;; Reasoning
;; ---------------------------------------------------------------------------

(def reasoning-delta-types
  #{"response.reasoning.delta"
    "response.reasoning_text.delta"
    "response.reasoning_summary.delta"
    "response.reasoning_summary_text.delta"
    "response.reasoning_summary_part.delta"})

(defn- present-string? [x] (and (string? x) (seq x)))

(defn- reasoning-text? [m]
  (and (map? m)
       (boolean (some #(present-string? (get m %)) ["reasoning_content" "reasoning"]))))

(defn chat-completion-has-reasoning?
  "Does a chat completion (or chunk) carry reasoning text at the top level or in
  any choice's `message` / `delta`?"
  [completion]
  (or (reasoning-text? completion)
      (boolean
       (some (fn [choice]
               (and (map? choice)
                    (or (reasoning-text? (get choice "message"))
                        (reasoning-text? (get choice "delta")))))
             (let [choices (get completion "choices")]
               (when (sequential? choices) choices))))))

(defn- reasoning-delta-with-text? [{:strs [type delta]}]
  (and (contains? reasoning-delta-types type)
       (or (present-string? delta)
           (and (map? delta) (present-string? (get delta "text"))))))

(defn- reasoning-item-added? [{:strs [type item]}]
  (and (= "response.output_item.added" type)
       (map? item)
       (= "reasoning" (get item "type"))))

(defn stream-has-reasoning-trace?
  "Does any well-formed event in `body` carry reasoning? Malformed fragments are
  ignored."
  [parse body]
  (boolean
   (some (fn [{:keys [parsed]}]
           (and (map? parsed)
                (or (chat-completion-has-reasoning? parsed)
                    (reasoning-delta-with-text? parsed)
                    (reasoning-item-added? parsed))))
         (events parse body))))

;; ---------------------------------------------------------------------------
;; Substance
;; ---------------------------------------------------------------------------

(defn- substantive-event?
  "Everything is substantive except a reasoning delta with no text: malformed
  fragments and non-object JSON count, since something real arrived."
  [{:keys [parsed malformed?]}]
  (or malformed?
      (not (map? parsed))
      (not (contains? reasoning-delta-types (get parsed "type")))
      (boolean (reasoning-delta-with-text? parsed))))

(defn stream-has-substantive-chunks?
  "True when the stream holds at least one event beyond empty reasoning deltas."
  [parse body]
  (boolean (some substantive-event? (events parse body))))
