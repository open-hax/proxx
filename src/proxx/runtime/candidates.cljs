(ns proxx.runtime.candidates
  "JS edge for the candidate-builder facts (proxx.strategy.candidates)."
  (:require [proxx.runtime.interop :as interop]
            [proxx.strategy.candidates :as candidates]))

(defn- or-undef [x] (if (nil? x) js/undefined x))

(defn forced-credential-selection-js [auth-kind headers]
  (let [{:keys [provider-id account-id]} (candidates/forced-selection auth-kind (interop/js->data headers))
        o #js {}]
    (when provider-id (aset o "providerId" provider-id))
    (when account-id (aset o "accountId" account-id))
    o))

(defn no-auth-account-js [provider-id]
  (clj->js (candidates/no-auth-account provider-id)))

(defn affinities-from-record-js
  "{preferred?, provisional?} as {providerId, accountId} objects."
  [record]
  (let [{:keys [preferred provisional]} (candidates/affinities (interop/js->data record))
        ->js (fn [{:keys [provider-id account-id]}] #js {:providerId provider-id :accountId account-id})
        o #js {}]
    (when preferred (aset o "preferred" (->js preferred)))
    (when provisional (aset o "provisional" (->js provisional)))
    o))
