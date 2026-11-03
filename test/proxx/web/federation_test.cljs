(ns proxx.web.federation-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.web.api :as api]
            [proxx.web.pages.federation :as fed]
            [proxx.web.update :as u]))

(defn- boot [] (u/init-db {:stored {} :token "t" :path "/federation"}))
(defn- slice [db] (get-in db [:pages :federation]))
(defn- entered [] (u/handle (boot) [:route/changed "/federation"]))

(deftest enter-loads-streams-and-polls
  (let [[_ fx*] (entered)
        [_stop _close start load ws] fx*]
    (is (= [:interval/start :federation 30000 [:federation/load]] start))
    (is (= :http-all (first load)))
    (is (= ["/api/v1/federation/self"
            "/api/v1/federation/peers?ownerSubject=did%3Aweb%3Aproxx.promethean.rest%3Abrethren"
            "/api/v1/federation/accounts?ownerSubject=did%3Aweb%3Aproxx.promethean.rest%3Abrethren"
            "/api/v1/federation/bridges"
            "/api/v1/request-logs?limit=100"]
           (mapv :path (second load))))
    (is (= [:ws/open :federation "/api/v1/federation/observability/ws?ownerSubject=did%3Aweb%3Aproxx.promethean.rest%3Abrethren&routeKind=routed" [:federation/ws-message]]
           ws))))

(deftest ws-origin-and-path
  (is (= "wss://h" (api/ws-origin "https://h")))
  (is (= "ws://h:1" (api/ws-origin "http://h:1")))
  (is (= "x" (api/ws-origin "x")))
  (is (= "/api/v1/federation/observability/ws?ownerSubject=a+b&routeKind=routed" (api/federation-observability-path " a b "))))

(deftest owner-change-reloads-and-reopens
  (let [[db fx*] (u/handle (first (entered)) [:federation/owner "did:x"])]
    (is (= "did:x" (:owner (slice db))))
    (is (some #(= :ws/open (first %)) fx*))
    (is (some #(= :http-all (first %)) fx*)))
  (let [[db] (u/handle (first (u/handle (first (entered)) [:federation/owner "did:x"])) [:federation/reset-owner])]
    (is (= fed/default-owner-subject (:owner (slice db))))))

(deftest load-results-are-latest-wins
  (let [db (first (entered))
        [db1] (u/handle db [:federation/loaded 1 [{:nodeId "n" :peerCount 2} [{:id "p"}] {:localAccounts []} [{:sessionId "b"}] [{:id "l"}]]])]
    (is (= "n" (get-in (slice db1) [:self :nodeId])))
    (is (false? (:loading? (slice db1))))
    (let [[db2] (u/handle db1 [:federation/load])
          [db3] (u/handle db2 [:federation/failed 1 "stale"])
          [db4] (u/handle db2 [:federation/failed 2 "fresh"])]
      (is (nil? (:error (slice db3))))
      (is (= "fresh" (:error (slice db4)))))))

(deftest streamed-log-records
  (is (= [{:id "a" :v 2} {:id "b"}] (fed/apply-log-record [{:id "a" :v 1} {:id "b"}] {:id "a" :v 2})))
  (is (= [{:id "n"} {:id "a"}] (fed/apply-log-record [{:id "a"}] {:id "n"})))
  (is (= 200 (count (fed/apply-log-record (mapv (fn [i] {:id (str i)}) (range 200)) {:id "new"}))))
  (let [db (first (entered))
        msg (fn [type entry] [:federation/ws-message {"type" type "entry" entry}])]
    (let [[db1] (u/handle db (msg "request_log_record" {"id" "x" "routeKind" "federated"}))]
      (is (= [{:id "x" :routeKind "federated"}] (:logs (slice db1))) "entries are keywordized")
      (let [[db2] (u/handle db1 (msg "request_log_update" {"id" "x" "routeKind" "bridge"}))]
        (is (= [{:id "x" :routeKind "bridge"}] (:logs (slice db2))))))
    (doseq [bad [(msg "other" {"id" "x"}) (msg "request_log_record" {"id" 5}) (msg "request_log_record" nil)
                 [:federation/ws-message "str"] [:federation/ws-message nil]]]
      (is (= [] (:logs (slice (first (u/handle db bad))))) (pr-str bad)))))

(deftest sync-flow
  (let [db (first (entered))
        [db1 fx1] (u/handle db [:federation/sync "p1"])]
    (is (= "Syncing…" (get-in (slice db1) [:sync-status "p1"])))
    (is (= {:peerId "p1" :ownerSubject fed/default-owner-subject :pullUsage false} (:body (second (first fx1)))))
    (let [[db2 fx2] (u/handle db1 [:federation/synced "p1" {:peer {:label "Peer A"} :importedProjectedAccountsCount 3 :importedUsageCount 0 :remoteDiffCount 1}])]
      (is (= "Projected 3, usage 0, diff 1" (get-in (slice db2) [:sync-status "p1"])))
      (is (= "Last sync: Peer A · projected 3 · diff 1" (:last-sync (fed/view-model db2))))
      (is (= :http-all (first (first fx2))) "reloads after sync"))
    (let [[db2] (u/handle db1 [:federation/sync-failed "p1" "nope"])]
      (is (= "nope" (get-in (slice db2) [:sync-status "p1"]))))))

(deftest add-peer-flow
  (let [db (first (entered))
        db (reduce (fn [d [k v]] (first (u/handle d [:federation/form k v])))
                   db {:ownerCredential " owner " :label " L " :baseUrl " http://b " :peerDid "  " :authCredential " cred "})
        [db1 fx1] (u/handle db [:federation/submit])]
    (is (true? (:submitting? (slice db1))))
    (is (= {:ownerCredential "owner" :label "L" :baseUrl "http://b" :auth {:credential "cred"}}
           (into {} (remove (comp nil? val)) (:body (second (first fx1))))))
    (let [[db2 fx2] (u/handle db1 [:federation/peer-added {}])]
      (is (false? (:submitting? (slice db2))))
      (is (= " owner " (get-in (slice db2) [:form :ownerCredential])) "owner credential kept")
      (is (= "" (get-in (slice db2) [:form :label])))
      (is (= :http-all (first (first fx2)))))
    (let [[db2] (u/handle db1 [:federation/peer-failed "bad"])]
      (is (= "bad" (:error (slice db2))))
      (is (false? (:submitting? (slice db2)))))))

(deftest derived-views
  (is (= [{:providerId "b" :count 2} {:providerId "a" :count 1} {:providerId "c" :count 1}]
         (fed/summarize-providers [{:providerId "c"} {:providerId "b"} {:providerId "a"} {:providerId "b"}])))
  (is (= "s" (fed/bridge-label {:sessionId "s" :peerDid "p"} 0)))
  (is (= "p" (fed/bridge-label {:sessionId "" :peerDid "p"} 0)))
  (is (= "bridge-3" (fed/bridge-label {} 2)))
  (is (= "federated → unknown-peer" (fed/routed-request-label {:routeKind "federated"})))
  (is (= "bridge → L" (fed/routed-request-label {:routeKind "bridge" :routedPeerLabel "L" :routedPeerId "i"})))
  (let [logs [{:id "1" :routeKind "local"} {:id "2" :routeKind "federated" :routedPeerLabel "A" :federationOwnerSubject "o"}
              {:id "3" :routeKind "bridge" :routedPeerId "B"} {:id "4" :routeKind "federated" :routedPeerLabel "A" :federationOwnerSubject "other"}
              {:id "5" :routeKind "federated" :routedPeerLabel "B"}]
        routed (fed/routed-logs logs "o")]
    (is (= ["2" "3" "5"] (mapv :id routed)))
    (is (= {:federated 2 :bridge 1 :topPeer "B"} (fed/routed-summary routed)) "tie broken alphabetically")
    (is (= {:federated 0 :bridge 0 :topPeer nil} (fed/routed-summary []))))
  (is (= "success" (fed/peer-badge "Healthy")))
  (is (= "warning" (fed/peer-badge "warning")))
  (is (= "default" (fed/peer-badge "down")))
  (let [v (fed/routed-entry-view {:id "1" :routeKind "federated" :routedPeerLabel "P" :model "m" :providerId "p" :accountId "a"
                                  :status 0 :latencyMs 420.6 :tenantId "t" :timestamp 0})]
    (is (= "federated → P · m" (:title v)))
    (is (= "p/a · ERR · 421 ms · from tenant t" (:detail v)))))

(deftest view-model-defaults
  (let [vm (fed/view-model (boot))]
    (is (= "—" (get-in vm [:hero-stats 0 :value])))
    (is (= 0 (get-in vm [:hero-stats 1 :value])))
    (is (= [["Recent federated" 0] ["Recent bridge" 0] ["Top peer" "—"] ["Tracked logs" 0]] (:routing-rows vm)))
    (is (= ["0" "0" "0"] (mapv :badge (:knowledge-tabs vm))))))
