(ns proxx.web.pages.hosts
  "Hosts page: polling state machine and view-model."
  (:require [clojure.string :as str]
            [proxx.web.api :as api]
            [proxx.web.format :as fmt]
            [proxx.web.fx :as fx]
            [proxx.web.state :as st]))

(def poll-ms 30000)

(defn init [] {:overview nil :loading? true :error nil :fetching? false :request-id 0})

(defn- load-host [db _]
  (let [{:keys [fetching? request-id]} (st/page-slice db :hosts)]
    (if fetching?
      [db []]
      (let [id (inc request-id)]
        [(st/update-page db :hosts assoc :fetching? true :request-id id :loading? true :error nil)
         [(fx/http (api/get-hosts-overview) [:hosts/loaded id] [:hosts/failed id])]]))))

(defn- settle [slice id f]
  ;; Only the latest request may write results; `fetching?` always clears.
  (let [slice (assoc slice :fetching? false)]
    (if (= id (:request-id slice)) (f (assoc slice :loading? false)) slice)))

(defn- loaded [db [_ id overview]] [(st/update-page db :hosts settle id #(assoc % :overview overview)) []])
(defn- failed [db [_ id message]] [(st/update-page db :hosts settle id #(assoc % :error message)) []])

(defn enter [db]
  (let [[db' fx*] (load-host db [:hosts/load])]
    [db' (into [(fx/interval-start :hosts poll-ms [:hosts/load])] fx*)]))

(defn leave [_db] [(fx/interval-stop :hosts)])

(def page
  {:init init :enter enter :leave leave
   :handlers {:hosts/load load-host :hosts/loaded loaded :hosts/failed failed}})

(defn reachability
  "Badge variant + text for a host."
  [{:keys [reachable errors]}]
  (cond
    (not reachable) {:variant "error" :text "Unreachable"}
    (seq errors) {:variant "warning" :text "Partial"}
    :else {:variant "success" :text "Live"}))

(defn format-ports [ports] (if (empty? ports) "—" (str/join ", " ports)))

(defn host-view [self-id {:keys [id label baseUrl publicHost notes errors containers routes summary] :as host}]
  {:id id
   :label label
   :self? (= self-id id)
   :pill (reachability host)
   :subtitle (str (or baseUrl publicHost id) (when (seq notes) (str " · " notes)))
   :stats {:running (str (:runningCount summary) "/" (:containerCount summary))
           :healthy (:healthyCount summary)
           :routes (:routeCount summary)}
   :last-error (last errors)
   :routes-meta (str (count routes) " routes")
   :routes (vec (map-indexed (fn [i {:keys [host matchPaths matcher upstreams]}]
                               {:key (str host "-" (str/join "," upstreams) "-" i)
                                :host host
                                :match (if (seq matchPaths) (str/join " " matchPaths) (or matcher "default"))
                                :upstream (str/join ", " upstreams)})
                             routes))
   :containers-meta (str (count containers) " containers")
   :containers (mapv (fn [{:keys [id name image status ports]}]
                       {:key id :name name :image image :status status :ports (format-ports ports)})
                     containers)})

(defn view-model [db]
  (let [{:keys [overview loading? error]} (st/page-slice db :hosts)
        hosts (:hosts overview)]
    {:hero-stats [{:label "reachable hosts"
                   :value (str (count (filter :reachable hosts)) "/" (count hosts))
                   :tone "success"}
                  {:label "containers tracked" :value (reduce + 0 (map #(get-in % [:summary :containerCount] 0) hosts))}
                  {:label "subdomain routes parsed" :value (reduce + 0 (map #(get-in % [:summary :routeCount] 0) hosts))}
                  {:label "" :value (if overview
                                      (str "Updated " (fmt/format-datetime (:generatedAt overview)))
                                      "Waiting for first sample…")}]
     :loading? (and loading? (nil? overview))
     :error error
     :hosts (mapv #(host-view (:selfTargetId overview) %) hosts)}))
