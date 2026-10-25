(ns proxx.compat.wire-profile
  "Interpretation of `:provider-wire-profile` contracts (75-provider-wire-profiles.edn):
  the declared, ordered model -> upstream routes that several providers share."
  (:require [clojure.string :as str]))

(defn- matches? [pattern value] (boolean (re-find (re-pattern pattern) value)))

(defn profile
  "The `:provider-wire-profile` contract for `provider-id` in a compiled policy."
  [compiled provider-id]
  (or (some (fn [c] (when (and (= :provider-wire-profile (:contract/kind c))
                               (= provider-id (:wire/provider-id c)))
                      c))
            (get-in compiled [:index :contracts]))
      (throw (ex-info "Missing provider wire profile"
                      {:error/type :policy/missing-wire-profile :provider-id provider-id}))))

(defn route
  "First model route whose pattern matches `model` (profiles end in a catch-all)."
  [profile model]
  (let [model (str model)]
    (some #(when (matches? (:match/model-pattern %) model) %) (:wire/model-routes profile))))

(defn api-provider [profile model] (:wire/api-provider (route profile model)))

(defn normalized-api-provider
  "`api-provider` for a model id normalized the way callers compare ids: trimmed, lower-cased."
  [profile model]
  (api-provider profile (str/lower-case (str/trim (str model)))))
