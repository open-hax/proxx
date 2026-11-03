(ns proxx.runtime.prompt-affinity
  "Edge of the prompt-affinity store: an atom cache of records, optional
  database persistence (`sql` may be undefined: memory only), and the JS
  facade of `SqlPromptAffinityStore`. Statement texts come from db/schema.ts."
  (:require [clojure.string :as str]
            [proxx.credentials.affinity :as aff]))

(defn- record->js [{:keys [prompt-cache-key provider-id account-id updated-at
                           provisional-provider-id provisional-account-id provisional-success-count]}]
  (let [o #js {"promptCacheKey" prompt-cache-key "providerId" provider-id "accountId" account-id}]
    (when (some? provisional-provider-id) (aset o "provisionalProviderId" provisional-provider-id))
    (when (some? provisional-account-id) (aset o "provisionalAccountId" provisional-account-id))
    (when (some? provisional-success-count) (aset o "provisionalSuccessCount" provisional-success-count))
    (aset o "updatedAt" updated-at)
    o))

(defn create-prompt-affinity-store-js
  "`statements`: {selectAll, upsert, delete, promote} SQL texts."
  [^js sql ^js statements]
  (let [cache (atom {})
        initialized (atom false)
        select-all (.-selectAll statements) upsert (.-upsert statements)
        delete (.-delete statements) promote (.-promote statements)
        run! (fn ^:async run [text params]
               (when sql (await (.unsafe sql text (to-array params)))))]
    #js {"init"
         (fn ^:async init []
           (when-not @initialized
             (when sql
               (try
                 (doseq [row (array-seq (await (.unsafe sql select-all)))]
                   (let [r (aff/row->record (js->clj row))]
                     (swap! cache assoc (:prompt-cache-key r) r)))
                 (catch :default e
                   (when-not (and (some? e) (= "object" (goog/typeOf e)) (= "42P01" (.-code ^js e)))
                     (throw e)))))
             (reset! initialized true))
           js/undefined)

         "get"
         (fn ^:async get-record [prompt-cache-key]
           (let [key (str/trim prompt-cache-key)]
             (when (seq key) (some-> (get @cache key) record->js))))

         "upsert"
         (fn ^:async upsert-record [prompt-cache-key provider-id account-id]
           (when-let [{:keys [params record]} (aff/upsert-plan prompt-cache-key provider-id account-id (js/Date.now))]
             (await (run! upsert params))
             (swap! cache assoc (:prompt-cache-key record) record))
           js/undefined)

         "noteSuccess"
         (fn ^:async note-success [prompt-cache-key provider-id account-id]
           (let [key (str/trim prompt-cache-key)
                 plan (aff/note-success-plan (get @cache key) prompt-cache-key provider-id account-id (js/Date.now))]
             (when plan
               (await (run! (if (= :promote (:op plan)) promote upsert) (:params plan)))
               (swap! cache assoc (:key plan) (:record plan))))
           js/undefined)

         "close" (fn ^:async close [] js/undefined)

         "delete"
         (fn ^:async delete-record [prompt-cache-key]
           (let [key (str/trim prompt-cache-key)]
             (when (seq key)
               (await (run! delete [key]))
               (swap! cache dissoc key)))
           js/undefined)}))
