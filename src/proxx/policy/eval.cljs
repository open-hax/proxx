(ns proxx.policy.eval
  (:require [clojure.string :as str]))

(defn- resolve-symbol [sym ctx _injected-fns]
  (case sym
    ctx ctx
    it (:it ctx)
    nil))

(declare eval-form*)

(defn- eval-args [args ctx injected-fns]
  (mapv #(eval-form* % ctx injected-fns) args))

(defn- eval-core-form [op args ctx injected-fns]
  (case op
    = (apply = (eval-args args ctx injected-fns))
    not (not (eval-form* (first args) ctx injected-fns))
    and (reduce (fn [_ arg]
                  (let [result (eval-form* arg ctx injected-fns)]
                    (if result result (reduced nil))))
                true
                args)
    or (some #(eval-form* % ctx injected-fns) args)
    get (let [[m k not-found] (eval-args args ctx injected-fns)]
          (get m k not-found))
    get-in (let [[m ks not-found] (eval-args args ctx injected-fns)]
             (get-in m ks not-found))
    first (first (eval-form* (first args) ctx injected-fns))
    second (second (eval-form* (first args) ctx injected-fns))
    keyword (keyword (eval-form* (first args) ctx injected-fns))
    str (apply str (eval-args args ctx injected-fns))
    some? (some? (eval-form* (first args) ctx injected-fns))
    nil? (nil? (eval-form* (first args) ctx injected-fns))
    clojure.string/includes? (let [[s substr] (eval-args args ctx injected-fns)]
                               (str/includes? s substr))
    clojure.string/split (let [[s re] (eval-args args ctx injected-fns)]
                           (str/split s re))
    clojure.string/starts-with? (let [[s prefix] (eval-args args ctx injected-fns)]
                                  (str/starts-with? s prefix))
    ::unknown))

(defn- eval-form* [form ctx injected-fns]
  (cond
    (symbol? form) (resolve-symbol form ctx injected-fns)
    (seq? form) (let [[op & args] form]
                  (if (= op 'contract/apply)
                    (let [[fn-key value] (eval-args args ctx injected-fns)]
                      (when-let [f (get injected-fns fn-key)]
                        (f value)))
                    (let [result (eval-core-form op args ctx injected-fns)]
                      (when-not (= ::unknown result) result))))
    :else form))

(defn eval-form
  ([form ctx trace] (eval-form form ctx trace {}))
  ([form ctx _trace injected-fns]
   (try
     (let [result (eval-form* form ctx injected-fns)]
       (when result result))
     (catch :default _ nil))))
