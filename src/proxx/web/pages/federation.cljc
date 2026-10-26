(ns proxx.web.pages.federation
  "Federation page: loading, live request-log stream, peer sync and creation."
  (:require [clojure.string :as str]
            [proxx.web.api :as api]
            [proxx.web.format :as fmt]
            [proxx.web.fx :as fx]
            [proxx.web.state :as st]))

(def default-owner-subject "did:web:proxx.promethean.rest:brethren")
(def poll-ms 30000)
(def max-tracked-logs 200)
(def shown-routed-logs 12)
(def empty-form {:ownerCredential "" :label "" :baseUrl "" :controlBaseUrl "" :peerDid "" :authCredential ""})

(defn init []
  {:owner default-owner-subject :self nil :accounts nil :peers [] :bridges [] :logs []
   :loading? true :error nil :request-id 0 :sync-status {} :last-sync nil
   :submitting? false :form empty-form})

(defn- slice [db] (st/page-slice db :federation))

(defn- load-fx [db]
  (let [{:keys [owner request-id]} (slice db)
        id (inc request-id)]
    [(st/update-page db :federation assoc :request-id id :loading? true :error nil)
     [(fx/http-all [(api/get-federation-self) (api/list-federation-peers owner) (api/get-federation-accounts owner)
                    (api/list-federation-bridges) (api/list-request-logs {:limit 100})]
                   [:federation/loaded id] [:federation/failed id])]]))

(defn- stream-fx [db]
  [(fx/ws-open :federation (api/federation-observability-path (:owner (slice db))) [:federation/ws-message])])

(defn enter [db]
  (let [[db' fx*] (load-fx db)]
    [db' (into [(fx/interval-start :federation poll-ms [:federation/load])] (concat fx* (stream-fx db')))]))

(defn leave [_] [(fx/interval-stop :federation) (fx/ws-close :federation)])

(defn- loaded [db [_ id [self peers accounts bridges logs]]]
  (if (= id (:request-id (slice db)))
    [(st/update-page db :federation assoc :loading? false :self self :peers peers :accounts accounts :bridges bridges :logs logs) []]
    [db []]))

(defn- failed [db [_ id message]]
  (if (= id (:request-id (slice db)))
    [(st/update-page db :federation assoc :loading? false :error message) []]
    [db []]))

(defn- poll [db _] (load-fx db))

(defn- owner-changed
  "Changing the owner reloads, restarts the poll and reopens the live stream."
  [db [_ v]]
  (let [[db' fx*] (load-fx (st/assoc-page db :federation :owner v))]
    [db' (into [(fx/interval-start :federation poll-ms [:federation/load])] (concat fx* (stream-fx db')))]))

(defn- reset-owner [db _] (owner-changed db [:federation/owner default-owner-subject]))

(defn apply-log-record
  "Insert or replace (by id) a streamed request-log entry, newest first, capped."
  [logs entry]
  (let [idx (first (keep-indexed (fn [i l] (when (= (:id l) (:id entry)) i)) logs))]
    (if idx
      (assoc (vec logs) idx entry)
      (vec (take max-tracked-logs (cons entry logs))))))

(defn- ws-message [db [_ message]]
  (let [entry (when (map? message) (get message "entry"))]
    (if (and (map? message)
             (#{"request_log_record" "request_log_update"} (get message "type"))
             (map? entry) (string? (get entry "id")))
      [(st/update-page db :federation update :logs apply-log-record (api/keywordize entry)) []]
      [db []])))

(defn- sync-peer [db [_ peer-id]]
  [(st/update-page db :federation assoc-in [:sync-status peer-id] "Syncing…")
   [(fx/http (api/sync-federation-peer {:peerId peer-id :ownerSubject (:owner (slice db)) :pullUsage false})
             [:federation/synced peer-id] [:federation/sync-failed peer-id])]])

(defn- synced [db [_ peer-id result]]
  (let [db (st/update-page db :federation assoc :last-sync result)
        db (st/update-page db :federation assoc-in [:sync-status peer-id]
                           (str "Projected " (:importedProjectedAccountsCount result)
                                ", usage " (:importedUsageCount result)
                                ", diff " (:remoteDiffCount result)))]
    (load-fx db)))

(defn- sync-failed [db [_ peer-id message]]
  [(st/update-page db :federation assoc-in [:sync-status peer-id] message) []])

(defn- form-changed [db [_ k v]] [(st/update-page db :federation assoc-in [:form k] v) []])

(defn peer-request-input [form]
  (let [t (fn [k] (str/trim (get form k "")))
        opt (fn [k] (let [v (t k)] (when (seq v) v)))]
    {:ownerCredential (t :ownerCredential) :label (t :label) :baseUrl (t :baseUrl)
     :controlBaseUrl (opt :controlBaseUrl) :peerDid (opt :peerDid)
     :auth (when-let [c (opt :authCredential)] {:credential c})}))

(defn- submit-peer [db _]
  [(st/update-page db :federation assoc :submitting? true :error nil)
   [(fx/http (api/add-federation-peer (peer-request-input (:form (slice db)))) [:federation/peer-added] [:federation/peer-failed])]])

(defn- peer-added [db _]
  (let [db (st/update-page db :federation
                           (fn [s] (assoc s :submitting? false :form (assoc empty-form :ownerCredential (get-in s [:form :ownerCredential])))))]
    (load-fx db)))

(defn- peer-failed [db [_ message]] [(st/update-page db :federation assoc :submitting? false :error message) []])

(def page
  {:init init :enter enter :leave leave
   :handlers {:federation/load poll :federation/loaded loaded :federation/failed failed
              :federation/owner owner-changed :federation/reset-owner reset-owner
              :federation/ws-message ws-message
              :federation/sync sync-peer :federation/synced synced :federation/sync-failed sync-failed
              :federation/form form-changed :federation/submit submit-peer
              :federation/peer-added peer-added :federation/peer-failed peer-failed}})

;; ---------------------------------------------------------------------------
;; View-model

(defn summarize-providers
  "`[{:providerId :count}]`, most accounts first, then by id."
  [accounts]
  (->> (frequencies (map :providerId accounts))
       (map (fn [[p n]] {:providerId p :count n}))
       (sort-by (juxt (comp - :count) :providerId))
       vec))

(defn bridge-label [{:keys [sessionId peerDid agentId]} index]
  (or (not-empty sessionId) (not-empty peerDid) (not-empty agentId) (str "bridge-" (inc index))))

(defn routed-request-label [{:keys [routeKind routedPeerLabel routedPeerId]}]
  (str routeKind " → " (or routedPeerLabel routedPeerId "unknown-peer")))

(defn routed-logs [logs owner]
  (filterv #(and (not= "local" (:routeKind %))
                 (or (nil? (:federationOwnerSubject %)) (= owner (:federationOwnerSubject %))))
           logs))

(defn routed-summary [routed]
  (let [peer-counts (frequencies (keep #(or (:routedPeerLabel %) (:routedPeerId %)) routed))]
    {:federated (count (filter #(= "federated" (:routeKind %)) routed))
     :bridge (count (filter #(= "bridge" (:routeKind %)) routed))
     :topPeer (->> peer-counts (sort-by (juxt (comp - val) key)) ffirst)}))

(defn peer-badge [status]
  (case (str/lower-case (str status)) "healthy" "success" "warning" "warning" "default"))

(defn routed-entry-view [entry]
  (let [origin (fmt/format-request-origin entry)
        origin-part (if (and (not= origin "unknown") (not= origin "local")) (str " · from " origin) "")]
    {:id (:id entry)
     :title (str (routed-request-label entry) " · " (:model entry))
     :detail (str (:providerId entry) "/" (:accountId entry) " · " (if (= 0 (:status entry)) "ERR" (:status entry))
                  " · " (fmt/round-half-up (:latencyMs entry)) " ms" origin-part)
     :meta (str (fmt/format-datetime (:timestamp entry)) " · owner " (or (:federationOwnerSubject entry) "—"))}))

(defn view-model [db]
  (let [{:keys [owner self accounts peers bridges logs loading? error sync-status last-sync submitting? form]} (slice db)
        routed (routed-logs logs owner)
        dash (fn [v] (or v "—"))]
    {:owner owner :loading? loading? :error error :submitting? submitting? :form form
     :hero-stats [{:label "this node" :value (dash (:nodeId self)) :tone "info"}
                  {:label "known peers" :value (or (:peerCount self) 0) :tone "info"}
                  {:label "projected accounts" :value (count (:projectedAccounts accounts)) :tone "warning"}
                  {:label "recent routed reqs" :value (count routed)}]
     :self-rows [["Node" (dash (:nodeId self))] ["Group" (dash (:groupId self))] ["Cluster" (dash (:clusterId self))]
                 ["Peer DID" (dash (:peerDid self))] ["Public URL" (dash (:publicBaseUrl self))]]
     :bridges (vec (map-indexed (fn [i s] {:key (str (bridge-label s i) "-" i) :label (bridge-label s i)
                                           :state (or (:state s) "unknown")
                                           :detail (or (:clusterId s) (:groupId s) (:peerDid s) "—")})
                                bridges))
     :routing-rows (let [s (routed-summary routed)]
                     [["Recent federated" (:federated s)] ["Recent bridge" (:bridge s)]
                      ["Top peer" (dash (:topPeer s))] ["Tracked logs" (count logs)]])
     :knowledge-tabs (mapv (fn [[id label k variant]]
                             (let [rows (get accounts k)]
                               {:id id :label label :badge (str (count rows)) :count-text (str (count rows) " accounts")
                                :variant variant :providers (summarize-providers rows)}))
                           [["local" "Local" :localAccounts "info"]
                            ["projected" "Projected" :projectedAccounts "warning"]
                            ["known" "Known" :knownAccounts "success"]])
     :last-sync (when last-sync
                  (str "Last sync: " (get-in last-sync [:peer :label]) " · projected " (:importedProjectedAccountsCount last-sync)
                       " · diff " (:remoteDiffCount last-sync)))
     :routed (mapv routed-entry-view (take shown-routed-logs routed))
     :peers (mapv (fn [p] {:id (:id p) :label (:label p) :status (:status p) :badge (peer-badge (:status p))
                           :rows [["Owner" (:ownerSubject p)] ["Base" (:baseUrl p)] ["Control" (dash (:controlBaseUrl p))]
                                  ["Auth" (:authMode p)] ["DID" (dash (:peerDid p))]
                                  ["Updated" (if (:updatedAt p) (fmt/format-datetime (:updatedAt p)) "—")]]
                           :sync-text (get sync-status (:id p) "Idle")})
                  peers)}))
