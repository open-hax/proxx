(ns proxx.runtime.config
  "Edge of proxy configuration: the process environment, path resolution, the
  policy facts file, and the JS object the TypeScript host consumes. The
  construction itself is proxx.config.proxy; the result is validated against the
  `:proxx/proxy-config` Malli schema before it leaves."
  (:require ["node:fs" :as fs]
            ["node:path" :as path]
            [cljs.reader :as reader]
            [proxx.config.proxy :as config]
            [proxx.schema :as schema]))

(defonce ^:private facts-cache (atom {}))

(defn- read-edn [file] (reader/read-string (.readFileSync fs file "utf8")))

(defn- facts-for
  "The configuration facts of a manifest, read once. Only the contracts this
  module needs are validated; the rest of the policy is not loaded."
  [manifest-path]
  (or (get @facts-cache manifest-path)
      (let [manifest (read-edn manifest-path)
            dir (.dirname path manifest-path)
            contracts (->> (:policy.loader/order manifest)
                           (mapcat (fn [entry]
                                     (let [parsed (read-edn (.join path dir entry))]
                                       (filter #(contains? #{:proxy-config-defaults :provider-base-url} (:contract/kind %))
                                               (if (vector? parsed) parsed [parsed])))))
                           vec)
            _ (doseq [c contracts] (schema/assert! :proxx/policy-contract c))
            facts (config/facts-from-contracts contracts)]
        (swap! facts-cache assoc manifest-path facts)
        facts)))

(defn- rethrow-as-error [e]
  (throw (if (ex-data e) (js/Error. (ex-message e)) e)))

(defn- undef [x] (if (nil? x) js/undefined x))

(defn- config->js
  "The ProxyConfig object; absent optional settings are present-but-undefined."
  [m]
  (let [o #js {}]
    (doseq [[k v] m]
      (aset o k (cond (nil? v) js/undefined
                      (map? v) (clj->js v)
                      (vector? v) (to-array v)
                      :else v)))
    o))

(defn load-config-js
  "ProxyConfig from `env` (an object like process.env), resolving relative paths against `cwd`."
  [^js env cwd manifest-path]
  (try
    (let [facts (facts-for manifest-path)
          result (config/build-config #(let [v (aget env %)] (when (some? v) v))
                                      (fn [base p] (.resolve path base p))
                                      cwd facts)]
      (schema/assert! :proxx/proxy-config result)
      (config->js result))
    (catch :default e (rethrow-as-error e))))

(defn default-models-js [manifest-path]
  (to-array (config/default-models (facts-for manifest-path))))
