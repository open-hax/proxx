(ns proxx.web.hosts-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.web.pages.hosts :as hosts]
            [proxx.web.update :as u]))

(def overview
  {:generatedAt "2026-04-03T00:00:00Z" :selfTargetId "a"
   :hosts [{:id "a" :label "Host A" :reachable true :baseUrl "http://a" :errors [] :notes "n"
            :containers [{:id "c" :name "proxx" :image "proxx:latest" :state "running" :status "Up" :ports ["8789/tcp"]}
                         {:id "d" :name "x" :image "i" :status "s" :ports []}]
            :routes [{:host "h" :matchPaths ["/api" "/v1"] :upstreams ["u1" "u2"]} {:host "g" :matcher "m" :matchPaths [] :upstreams []} {:host "z" :matchPaths [] :upstreams ["u"]}]
            :summary {:containerCount 2 :runningCount 1 :healthyCount 1 :routeCount 3}}
           {:id "b" :label "B" :reachable false :errors ["e1" "e2"] :containers [] :routes []
            :summary {:containerCount 0 :runningCount 0 :healthyCount 0 :routeCount 0}}
           {:id "c" :label "C" :reachable true :errors ["w"] :publicHost "pub" :containers [] :routes []
            :summary {:containerCount 4 :runningCount 4 :healthyCount 4 :routeCount 1}}]})

(defn- boot [] (u/init-db {:stored {} :token "t" :path "/hosts"}))

(declare testing-stale)

(deftest polling-lifecycle
  (let [[db fx*] (u/handle (boot) [:route/changed "/hosts"])]
    (is (= [:interval/start :hosts 30000 [:hosts/load]] (second fx*)))
    (is (= "/api/v1/hosts/overview" (:path (second (nth fx* 2)))))
    (is (= [db []] (u/handle db [:hosts/load])) "no overlapping fetches")
    (let [[db2] (u/handle db [:hosts/loaded 1 overview])]
      (is (some? (get-in db2 [:pages :hosts :overview])))
      (is (false? (:loading? (get-in db2 [:pages :hosts]))))
      (let [[db3 fx3] (u/handle db2 [:hosts/load])]
        (is (= 2 (get-in db3 [:pages :hosts :request-id])))
        (is (some? fx3))
        (testing-stale db3)))
    (let [[_ fx*] (u/handle db [:route/changed "/tools"])]
      (is (= [:interval/stop :hosts] (first fx*))))))

(defn- testing-stale [db3]
  (let [[db4] (u/handle db3 [:hosts/failed 1 "old"])]
    (is (nil? (get-in db4 [:pages :hosts :error])) "stale failure ignored")
    (is (false? (get-in db4 [:pages :hosts :fetching?])))))

(deftest view-model
  (let [db (assoc-in (boot) [:pages :hosts :overview] overview)
        vm (hosts/view-model db)
        [a b c] (:hosts vm)]
    (is (= "2/3" (get-in vm [:hero-stats 0 :value]) ) "reachable hosts")
    (is (= 6 (get-in vm [:hero-stats 1 :value])))
    (is (= 4 (get-in vm [:hero-stats 2 :value])))
    (is (true? (:self? a)))
    (is (= {:variant "success" :text "Live"} (:pill a)))
    (is (= {:variant "error" :text "Unreachable"} (:pill b)))
    (is (= {:variant "warning" :text "Partial"} (:pill c)))
    (is (= "e2" (:last-error b)))
    (is (= "http://a · n" (:subtitle a)))
    (is (= "pub" (:subtitle c)))
    (is (= ["/api /v1" "m" "default"] (mapv :match (:routes a))))
    (is (= "u1, u2" (:upstream (first (:routes a)))))
    (is (= ["8789/tcp" "—"] (mapv :ports (:containers a))))
    (is (= "2 containers" (:containers-meta a)))
    (is (= "1/2" (get-in a [:stats :running])))))

(deftest empty-states
  (let [vm (hosts/view-model (boot))]
    (is (true? (:loading? vm)))
    (is (= "Waiting for first sample…" (get-in vm [:hero-stats 3 :value])))
    (is (= "0/0" (get-in vm [:hero-stats 0 :value])))))
