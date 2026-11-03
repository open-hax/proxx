(ns proxx.runtime.federation-store
  "Edge of the federation tables (`src/lib/db/sql-federation-store.ts`): peers,
  the diff-event log, projected accounts and sync state. Statement texts and the
  decisions that build parameters (merging with the existing record, trimming,
  validation) are `proxx.credentials.federation-sql`; rows become records through
  `proxx.runtime.sql`. This namespace runs them over a postgres.js client or, for
  the calls that take one, a transaction executor."
  (:require ["node:crypto" :as crypto]
            [proxx.credentials.federation :as fed]
            [proxx.credentials.federation-sql :as fsql]
            [proxx.runtime.federation :as federation]
            [proxx.runtime.sql :as views]
            [proxx.runtime.sql-util :as u]))

(defn- normalize-url [value]
  (let [url (js/URL. (fed/peer-base-url-input value))]
    (.replace (.toString url) (js/RegExp. "/+$") "")))

(defn- write-json [x] (js/JSON.stringify (clj->js x)))

(defn- guarded
  "Run `f`, turning domain failures into plain Errors."
  [f]
  (try (f) (catch :default e (u/rethrow-as-error e))))

(defn create-sql-federation-store-js
  "The facade `SqlFederationStore` forwards to."
  [^js sql]
  (let [run (fn [^js executor text values] (.unsafe executor text (to-array values)))
        optional (fn [view rows] (let [row (aget rows 0)] (if row (view row) js/undefined)))
        peer (fn [rows] (optional views/federation-peer-record-js rows))
        account (fn [rows] (optional views/federation-projected-account-record-js rows))
        get-peer (fn ^:async get-peer [id executor]
                   (peer (await (run (or executor sql) fsql/get-peer-text [(.trim id)]))))
        get-projected-account (fn ^:async get-projected-account [input executor]
                                (account (await (run (or executor sql) fsql/get-projected-account-text
                                                     (fsql/projected-account-key (u/shallow input))))))]
    #js {"init" (fn ^:async init []
                  (doseq [statement fsql/ddl] (await (.unsafe sql statement)))
                  js/undefined)

         "upsertPeer"
         (fn ^:async upsert-peer [^js input]
           (let [credential (federation/parse-federation-owner-credential-js (.-ownerCredential input))
                 _ (when (undefined? credential) (throw (js/Error. "owner credential must not be empty")))
                 shallow-input (u/shallow input)
                 requested-id (fsql/peer-id shallow-input)
                 id (or requested-id (.randomUUID crypto))
                 existing (when requested-id (let [r (await (get-peer id nil))] (when-not (undefined? r) (u/shallow r))))
                 params (guarded #(fsql/peer-upsert-params
                                   shallow-input {:value (.-value ^js credential) :owner-subject (.-ownerSubject ^js credential)
                                                  :kind (.-kind ^js credential)}
                                   id existing write-json normalize-url))
                 base-url (nth params 4)]
             (try
               (peer (await (run sql fsql/upsert-peer-text params)))
               (catch :default error
                 (if (views/federation-base-url-conflict-js error)
                   (throw (js/Error. (str "federation peer base_url already in use: " base-url)))
                   (throw error))))))

         "listPeers" (fn ^:async list-peers [owner-subject]
                       (let [{:strs [text values]} (fsql/list-peers-statement owner-subject)]
                         (.map (await (run sql text values)) (fn [row] (views/federation-peer-record-js row)))))

         "getPeer" get-peer

         "appendDiffEvent"
         (fn ^:async append-diff-event [input]
           (let [params (guarded #(fsql/diff-event-params (u/shallow input) write-json))]
             (views/federation-diff-event-record-js (aget (await (run sql fsql/insert-diff-event-text params)) 0))))

         "listDiffEvents"
         (fn ^:async list-diff-events [input]
           (let [params (guarded #(fsql/list-diff-events-params (u/shallow input)))]
             (.map (await (run sql fsql/list-diff-events-text params))
                   (fn [row] (views/federation-diff-event-record-js row)))))

         "upsertProjectedAccount"
         (fn ^:async upsert-projected-account [input]
           (let [shallow-input (u/shallow input)
                 existing (let [r (await (get-projected-account input nil))] (when-not (undefined? r) (u/shallow r)))
                 values (fsql/projected-account-upsert-values shallow-input existing #(.json sql (clj->js %)))]
             (account (await (u/template-call sql {"strings" fsql/upsert-projected-account-strings "values" values})))))

         "getProjectedAccount" get-projected-account

         "withProjectedAccountImportLock"
         (fn [input f]
           (let [lock-key (fsql/import-lock-key (u/shallow input))]
             (.begin sql (fn ^:async locked [tx]
                           (let [rows (await (run tx fsql/advisory-lock-text [lock-key]))
                                 ^js row (aget rows 0)]
                             (if (and row (.-locked row)) (await (f tx)) js/undefined))))))

         "noteProjectedAccountRouted"
         (fn ^:async note-routed [input]
           (account (await (run sql fsql/note-routed-text (fsql/projected-account-key (u/shallow input))))))

         "markProjectedAccountImported"
         (fn ^:async mark-imported [input executor]
           (account (await (run (or executor sql) fsql/mark-imported-text (fsql/projected-account-key (u/shallow input))))))

         "getProjectedAccountsForOwner"
         (fn ^:async projected-for-owner [owner-subject]
           (.map (await (run sql fsql/projected-for-owner-text [(.trim owner-subject)]))
                 (fn [row] (views/federation-projected-account-record-js row))))

         "listProjectedAccounts"
         (fn ^:async list-projected-accounts [owner-subject]
           (let [{:strs [text values]} (fsql/projected-accounts-statement owner-subject)]
             (.map (await (run sql text values)) (fn [row] (views/federation-projected-account-record-js row)))))

         "getSyncState"
         (fn ^:async get-sync-state [peer-id]
           (optional views/federation-sync-state-record-js (await (run sql fsql/get-sync-state-text [(.trim peer-id)]))))

         "upsertSyncState"
         (fn ^:async upsert-sync-state [input]
           (views/federation-sync-state-record-js
            (aget (await (run sql fsql/upsert-sync-state-text (fsql/sync-state-params (u/shallow input)))) 0)))}))
