(ns proxx.routing.models
  "Model lists and preferences as declared in models.json (the pure half of
  src/lib/models.ts). Input is the parsed JSON document as string-keyed data;
  alias tables are ordered (see proxx.routing.ordered), since their order decides
  catalog order downstream."
  (:require [clojure.string :as str]
            [proxx.routing.ordered :as om]))

(defn- fail [message] (throw (ex-info message {:error/type ::invalid-model-json})))

(defn- trimmed-strings
  "Distinct, trimmed, non-empty strings of a sequence, first occurrence first.
  Anything that is not a string is dropped."
  [xs]
  (->> xs (filter string?) (map str/trim) (remove str/blank?) distinct vec))

(defn- sequence-of [x] (if (sequential? x) x []))

(defn normalize-model-ids
  "Model ids from an array, {\"models\": [...]} or OpenAI-style {\"data\": [{\"id\"}]}.
  Anything else cannot be honoured and is rejected."
  [raw]
  (cond
    (sequential? raw) (trimmed-strings raw)
    (not (map? raw)) (fail "Invalid model JSON: expected an array or {\"models\": []}")
    (sequential? (get raw "models")) (trimmed-strings (get raw "models"))
    (sequential? (get raw "data")) (trimmed-strings (map #(when (map? %) (get % "id")) (get raw "data")))
    :else (fail "Invalid model JSON: expected an array, {\"models\": []}, or OpenAI-style {\"data\": []}")))

(defn normalize-declared-models
  "Declared models: like `normalize-model-ids` but a document with no list is simply empty."
  [raw]
  (cond
    (sequential? raw) (normalize-model-ids raw)
    (and (map? raw) (or (sequential? (get raw "models")) (sequential? (get raw "data")))) (normalize-model-ids raw)
    :else []))

(defn normalize-string-array [raw]
  (if (sequential? raw) (trimmed-strings raw) []))

(defn normalize-aliases
  "Ordered alias entries [[alias target] ...] from [key value] pairs: string values only,
  both sides trimmed and non-empty; a later duplicate overwrites in place."
  [entries]
  (->> entries
       (keep (fn [[k v]]
               (when (string? v)
                 (let [alias (str/trim k) target (str/trim v)]
                   (when-not (or (str/blank? alias) (str/blank? target)) [alias target])))))
       om/from-entries
       om/om-entries))

(defn- alias-entries-of [raw alias-entries]
  (cond
    (some? alias-entries) alias-entries
    (map? (get raw "aliases")) (vec (get raw "aliases"))
    :else []))

(defn normalize-preferences
  "{:preferred :disabled :aliases} from the document.
  A bare array is a preferred list; a document with any preference field is read
  as preferences; any other object is a model list, taken as the preferred set.
  `alias-entries` are the document's alias pairs in source order (the edge reads
  them from the JS object); without them a map-valued \"aliases\" is used as is."
  [raw fallback-preferred alias-entries]
  (cond
    (sequential? raw) {:preferred (normalize-model-ids raw) :disabled [] :aliases []}
    (not (map? raw)) {:preferred (vec fallback-preferred) :disabled [] :aliases []}
    (some #(contains? raw %) ["preferred" "disabled" "aliases"])
    {:preferred (normalize-string-array (get raw "preferred"))
     :disabled (normalize-string-array (get raw "disabled"))
     :aliases (normalize-aliases (alias-entries-of raw alias-entries))}
    :else {:preferred (normalize-model-ids raw) :disabled [] :aliases []}))

(defn load-models-result
  "Models to serve: the document's, or `fallback` when it lists none."
  [raw fallback]
  (let [models (normalize-model-ids raw)]
    (if (seq models) models (vec fallback))))

(defn openai-model
  "The /v1/models entry for a model id."
  [model-id now-ms]
  {"id" model-id "object" "model" "created" (Math/floor (/ now-ms 1000)) "owned_by" "open-hax"})
