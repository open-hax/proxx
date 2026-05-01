(ns proxx.policy.loader
  (:require [cljs.reader :as reader]
            [clojure.string :as str]
            [proxx.schema :as schema]))

(def ^:private fs (js/require "fs"))
(def ^:private path (js/require "path"))

(defn- read-file [file-path]
  (.readFileSync fs file-path "utf8"))

(defn- read-edn-file [file-path]
  (reader/read-string (read-file file-path)))

(defn- vectorize [value]
  (if (vector? value) value [value]))

(defn- validate-policy! [policy]
  (try
    (schema/assert! :proxx/policy policy)
    (catch :default e
      (throw (ex-info "Invalid policy EDN"
                      {:policy policy
                       :cause (ex-data e)})))))

(defn- validate-policy-contract! [file-path contract]
  (try
    (schema/assert! :proxx/policy-contract contract)
    (catch :default e
      (throw (ex-info "Invalid policy contract EDN"
                      {:file file-path
                       :contract contract
                       :cause (ex-data e)})))))

(defn- validate-manifest! [manifest-path manifest]
  (try
    (schema/assert! :proxx/policy-manifest manifest)
    (catch :default e
      (throw (ex-info "Invalid policy manifest EDN"
                      {:file manifest-path
                       :manifest manifest
                       :cause (ex-data e)})))))

(defn- resolve-policy-path [manifest-dir entry]
  (if (.isAbsolute path entry)
    entry
    (.join path manifest-dir entry)))

(defn load-policies!
  "Load the first vertical-slice executable policy tree.

  This keeps the current runtime-compatible tree schema used by
  resources/policies/model-router.edn. Use load-policy-contracts! for the
  broader declarative policy contract manifest."
  [path-or-resource-root]
  (let [raw (read-edn-file path-or-resource-root)
        policies (vectorize raw)]
    (doseq [policy policies]
      (validate-policy! policy))
    policies))

(defn load-policy-manifest!
  "Load and validate a policy contract manifest EDN file."
  [manifest-path]
  (let [manifest (read-edn-file manifest-path)]
    (validate-manifest! manifest-path manifest)
    manifest))

(defn load-policy-contracts!
  "Load a declarative policy contract manifest and concatenate ordered files.

  Returns a vector of contracts in runtime order. The manifest itself is not
  included in the returned program; it is the loader contract for locating the
  program files."
  [manifest-path]
  (let [manifest (load-policy-manifest! manifest-path)
        manifest-dir (.dirname path manifest-path)
        entries (:policy.loader/order manifest)]
    (->> entries
         (mapcat (fn [entry]
                   (when (str/blank? entry)
                     (throw (ex-info "Blank policy manifest entry" {:manifest manifest-path})))
                   (let [file-path (resolve-policy-path manifest-dir entry)
                         contracts (vectorize (read-edn-file file-path))]
                     (doseq [contract contracts]
                       (validate-policy-contract! file-path contract))
                     contracts)))
         vec)))
