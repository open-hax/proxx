(ns proxx.credentials.affinity
  "Prompt-affinity persistence decisions: which statement to send and what the
  cache then holds, for each outcome. The record transition is the same one
  `proxx.processor/apply-affinity-event` describes (a different account must
  succeed `promotion-threshold` times in a row before it replaces the pinned
  one); this namespace additionally names the SQL operation and its parameters,
  which that function does not expose. `now-ms` is an argument.

  A record is {:prompt-cache-key :provider-id :account-id :updated-at
  and optionally :provisional-provider-id :provisional-account-id
  :provisional-success-count}."
  (:require [clojure.string :as str]))

(def promotion-success-count 2)

(defn row->record
  "A record from a `prompt_affinity` row (string-keyed)."
  [row]
  (let [count (get row "provisional_success_count")]
    (cond-> {:prompt-cache-key (get row "prompt_cache_key") :provider-id (get row "provider_id")
             :account-id (get row "account_id") :updated-at (get row "updated_at")}
      (some? (get row "provisional_provider_id")) (assoc :provisional-provider-id (get row "provisional_provider_id"))
      (some? (get row "provisional_account_id")) (assoc :provisional-account-id (get row "provisional_account_id"))
      (and (number? count) (pos? count)) (assoc :provisional-success-count count))))

(defn- pinned [key provider-id account-id now-ms]
  {:prompt-cache-key key :provider-id provider-id :account-id account-id :updated-at now-ms})

(defn upsert-plan
  "A plain pin of `account-id` for the key; nil when the key is blank. The
  stored provider/account are trimmed."
  [prompt-cache-key provider-id account-id now-ms]
  (let [key (str/trim prompt-cache-key)]
    (when (seq key)
      (let [provider (str/trim provider-id) account (str/trim account-id)]
        {:op :upsert :params [key provider account nil nil 0 now-ms]
         :record (pinned key provider account now-ms)}))))

(defn note-success-plan
  "What to do when `account-id` served a request for the key. nil when any
  input is blank. `:op` is :upsert (params for UPSERT_PROMPT_AFFINITY) or
  :promote (params for the promote-provisional statement)."
  [existing prompt-cache-key provider-id account-id now-ms]
  (let [key (str/trim prompt-cache-key) provider (str/trim provider-id) account (str/trim account-id)]
    (when (and (seq key) (seq provider) (seq account))
      (cond
        (or (nil? existing)
            (and (= (:provider-id existing) provider) (= (:account-id existing) account)))
        {:op :upsert :params [key provider account nil nil 0 now-ms] :key key
         :record (pinned key provider account now-ms)}

        :else
        (let [same? (and (= (:provisional-provider-id existing) provider)
                         (= (:provisional-account-id existing) account))
              n (if same? (inc (or (:provisional-success-count existing) 1)) 1)]
          (if (>= n promotion-success-count)
            {:op :promote :params [key provider account now-ms] :key key
             :record (pinned key provider account now-ms)}
            {:op :upsert :key key
             :params [key (:provider-id existing) (:account-id existing) provider account n now-ms]
             :record (assoc existing :provisional-provider-id provider :provisional-account-id account
                                     :provisional-success-count n :updated-at now-ms)}))))))
