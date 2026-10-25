(ns proxx.routing.bridge
  "What a federation bridge's advertised capability lets it serve (the decision
  half of src/lib/bridge-helpers.ts). A capability is a plain map; absent keys
  mean \"not advertised\", which is different from an explicit false."
  (:require [clojure.string :as str]
            [proxx.routing.surface :as surface]))

(defn- clean-strings
  "Trimmed, non-empty strings of a sequential value; anything else yields nothing."
  [xs]
  (if (sequential? xs)
    (into [] (comp (filter string?) (map str/trim) (remove str/blank?)) xs)
    []))

(defn supports-path?
  "May a bridge advertising `capability` serve `normalized-path`?
  Advertised :paths/:routes win; otherwise the structured :supports-* hints; a
  bridge with no hints at all is assumed to serve the legacy path set."
  [facts capability normalized-path]
  (let [advertised (into (clean-strings (:paths capability)) (clean-strings (:routes capability)))
        starts? #(str/starts-with? normalized-path %)
        hint-keys [:supports-models-list :supports-chat-completions :supports-responses]]
    (cond
      (seq advertised) (boolean (some starts? advertised))
      (starts? "/v1/models") (true? (:supports-models-list capability))
      (starts? "/v1/chat/completions") (true? (:supports-chat-completions capability))
      (starts? "/v1/responses") (true? (:supports-responses capability))
      :else (and (not-any? #(contains? capability %) hint-keys)
                 (surface/legacy-bridge-path? facts normalized-path)))))

(defn supports-model?
  "May a bridge serve `requested-model`? A missing or blank model is always servable;
  otherwise it must be advertised exactly or share an advertised prefix."
  [capability requested-model]
  (let [model (when (string? requested-model) (str/trim requested-model))]
    (or (str/blank? model)
        (boolean (or (some #{model} (clean-strings (:models capability)))
                     (some #(str/starts-with? model %) (clean-strings (:model-prefixes capability))))))))
