(ns proxx.web.pages.dashboard
  "Dashboard page: overview/key-pool/request-log loading with two infinite
  lists, plus every derived figure the panels show (pure)."
  (:require [clojure.string :as str]
            [proxx.web.api :as api]
            [proxx.web.format :as fmt]
            [proxx.web.fx :as fx]
            [proxx.web.state :as st]
            [proxx.web.storage :as storage]))

(def all-providers "__all_providers__")
(def poll-ms 30000)
(def log-page-size 50)
(def health-page-size 50)
(def ls-window "open-hax-proxy.ui.dashboard.window")
(def ls-account-sort "open-hax-proxy.ui.dashboard.accountSort")
(def ls-account-provider "open-hax-proxy.ui.dashboard.accountProvider")

(def account-sorts [["health" "Health"] ["ttft" "TTFT"] ["tps" "Decode TPS"] ["e2e-tps" "End-to-end TPS"]
                    ["tokens" "Tokens"] ["requests" "Requests"]])

(defn validate-window [v] (#{"daily" "weekly" "monthly"} v))
(defn validate-account-sort [v]
  (when (string? v)
    (let [n (str/lower-case (str/trim v))] (when (some #(= n (first %)) account-sorts) n))))

(defn window [db] (st/stored db ls-window "weekly" validate-window))
(defn account-sort [db] (st/stored db ls-account-sort "health" validate-account-sort))
(defn provider-filter [db] (st/stored db ls-account-provider all-providers storage/validate-string))

(defn init []
  {:overview nil :statuses {} :logs [] :loading? true :error nil :request-id 0
   :loading-more? false :has-more? true :health-visible health-page-size})

(defn- slice [db] (st/page-slice db :dashboard))

(defn- load-fx [db]
  (let [id (inc (:request-id (slice db)))]
    [(st/update-page db :dashboard assoc :request-id id :loading? true :error nil)
     [(fx/http-all [(api/get-usage-overview (account-sort db) (window db))
                    (api/list-credentials false)
                    (api/list-request-logs {:limit log-page-size})]
                   [:dashboard/loaded id] [:dashboard/failed id])]]))

(defn- restart-poll [[db fx*]]
  (let [[db' f] (load-fx db)]
    [db' (into (conj fx* (fx/interval-start :dashboard poll-ms [:dashboard/load])) f)]))

(defn enter [db] (restart-poll [db []]))
(defn leave [_] [(fx/interval-stop :dashboard)])

(defn- provider-options [overview]
  (vec (sort (distinct (map :providerId (:accounts overview))))))

(defn- loaded [db [_ id [overview credentials logs]]]
  (if (not= id (:request-id (slice db)))
    [db []]
    (let [db (st/update-page db :dashboard assoc :loading? false :overview overview
                             :statuses (:keyPoolStatuses credentials) :logs logs
                             :has-more? (>= (count logs) log-page-size))
          f (provider-filter db)]
      ;; a provider filter that no longer exists in the data is dropped
      (if (and (not= f all-providers) (not (some #{f} (provider-options overview))))
        (st/set-stored db ls-account-provider all-providers)
        [db []]))))

(defn- failed [db [_ id message]]
  (if (= id (:request-id (slice db)))
    [(st/update-page db :dashboard assoc :loading? false :error message) []]
    [db []]))

(defn- poll [db _] (load-fx db))
(defn- set-window [db [_ v]] (restart-poll (st/set-stored db ls-window (or (validate-window v) "weekly"))))
(defn- set-sort [db [_ v]] (restart-poll (st/set-stored db ls-account-sort (or (validate-account-sort v) "health"))))
(defn- set-provider [db [_ v]]
  (let [[db' fx*] (st/set-stored db ls-account-provider v)]
    [(st/assoc-page db' :dashboard :health-visible health-page-size) fx*]))

(defn- load-more-logs [db _]
  (let [{:keys [loading-more? has-more? logs]} (slice db)
        last-id (:id (peek (vec logs)))]
    (if (or loading-more? (not has-more?) (empty? logs) (not last-id))
      [db []]
      [(st/assoc-page db :dashboard :loading-more? true)
       [(fx/http (api/list-request-logs {:limit log-page-size :before last-id})
                 [:dashboard/more-logs] [:dashboard/more-logs-failed])]])))

(defn- more-logs [db [_ older]]
  [(st/update-page db :dashboard #(assoc % :logs (into (vec (:logs %)) older) :loading-more? false
                                         :has-more? (>= (count older) log-page-size)))
   []])
;; pagination errors are deliberately silent
(defn- more-logs-failed [db _] [(st/assoc-page db :dashboard :loading-more? false) []])

(defn- more-health [db _]
  (let [{:keys [health-visible overview]} (slice db)
        n (count (filter #(let [f (provider-filter db)] (or (= f all-providers) (= f (:providerId %)))) (:accounts overview)))]
    [(st/assoc-page db :dashboard :health-visible (min (+ health-visible health-page-size) n)) []]))

(def page
  {:init init :enter enter :leave leave
   :handlers {:dashboard/load poll :dashboard/loaded loaded :dashboard/failed failed
              :dashboard/set-window set-window :dashboard/set-sort set-sort :dashboard/set-provider set-provider
              :dashboard/load-more-logs load-more-logs :dashboard/more-logs more-logs
              :dashboard/more-logs-failed more-logs-failed :dashboard/more-health more-health}})

;; ---------------------------------------------------------------------------
;; Derived figures

(defn window-label [w] (case w "monthly" "30d" "weekly" "7d" "24h"))

(defn tile-variant
  ([value] (tile-variant value false))
  ([value inverse?]
   (cond
     (<= value 0) "default"
     inverse? (cond (>= value 5) "error" (>= value 1) "warning" :else "success")
     :else (if (>= value 1) "success" "default"))))

(defn format-service-tier [{:keys [serviceTier serviceTierSource]}]
  (cond
    (str/blank? serviceTier) "Standard"
    (= serviceTierSource "fast_mode") "Fast mode"
    (= serviceTier "priority") "Priority"
    :else (str/replace serviceTier #"[_-]+" " ")))

(defn format-route-label [{:keys [routeKind routedPeerLabel routedPeerId]}]
  (if (= routeKind "local") "local" (str routeKind " → " (or routedPeerLabel routedPeerId "unknown-peer"))))

(defn format-provider-route-cell [entry]
  (let [route-part (if (= (:routeKind entry) "local") "" (str " · " (format-route-label entry)))
        origin (fmt/format-request-origin entry)
        origin-part (if (and (not= origin "unknown") (not= origin "local")) (str " · from " origin) "")]
    (str (:providerId entry) "/" (:accountId entry) route-part origin-part)))

(defn spark-bars
  "Heights (percent, min 8) for a trend series."
  [points]
  (let [mx (reduce max 0 (map :v points))]
    (mapv (fn [{:keys [t v]}] {:key t :height (if (pos? mx) (max (* (/ v mx) 100) 8) 8)}) points)))

(defn donut-segments
  "Ring segments for the top accounts by tokens; nil when there is no activity."
  [accounts]
  (let [total (reduce + 0 (map :totalTokens accounts))]
    (when (pos? total)
      (loop [[a & more] (take 6 accounts) offset 0 out []]
        (if-not a
          out
          (let [length (* (/ (:totalTokens a) total) 264)]
            (recur more (+ offset length)
                   (conj out {:key (str (:providerId a) "-" (:accountId a)) :index (count out)
                              :dasharray (str length " 264") :dashoffset (- offset)}))))))))

(defn tier-bars [{:keys [fastMode priority standard]}]
  (let [tiers [["Fast mode" fastMode "dashboard-tier-fast_mode"] ["Priority" priority "dashboard-tier-explicit"]
               ["Standard" standard "dashboard-tier-none"]]
        total (reduce + 0 (map second tiers))]
    (when (pos? total)
      (mapv (fn [[label v cls]]
              (let [pct (* (/ v total) 100)]
                {:label label :class cls
                 :text (str (fmt/compact-number v) " req · " (fmt/percent pct))
                 :width (str (max pct (if (pos? v) 6 0)) "%")}))
            tiers))))

(defn- tiles [{:keys [summary trends]} loading? wl]
  (let [s summary
        num (fn [k] (or (get s k) 0))
        routing (:routingRequests24h s)
        projected (+ (or (:federated routing) 0) (or (:bridge routing) 0))
        spark (fn [pts] (when pts (mapv (fn [p] {:value (:v p) :label (:t p)}) pts)))]
    [{:label (str "Requests / " wl) :value (fmt/compact-number (num :requests24h)) :sparkbar (spark (:requests trends))
      :variant (tile-variant (num :requests24h))}
     {:label (str "Tokens / " wl) :value (fmt/compact-number (num :tokens24h))
      :detail (str "In " (fmt/compact-number (num :promptTokens24h)) " / Out " (fmt/compact-number (num :completionTokens24h))
                   " · Cached " (fmt/compact-number (num :cachedPromptTokens24h))
                   " · Cache hit " (fmt/percent (num :cacheHitRate24h)))
      :variant (tile-variant (num :tokens24h))}
     {:label (str "Images / " wl) :value (fmt/compact-number (num :imageCount24h))
      :detail (str "Cost " (fmt/usd (num :imageCostUsd24h))) :variant (tile-variant (num :imageCount24h))}
     {:label "Error Rate" :value (fmt/percent (num :errorRate24h)) :sparkbar (spark (:errors trends))
      :variant (tile-variant (num :errorRate24h) true)}
     {:label "Active Accounts" :value (fmt/compact-number (num :activeAccounts))
      :detail (str "Top model " (or (:topModel s) "-") " · Top provider " (or (:topProvider s) "-"))
      :variant (tile-variant (num :activeAccounts))}
     {:label (str "Projected / " wl) :value (fmt/compact-number projected)
      :detail (str "Federated " (fmt/compact-number (or (:federated routing) 0))
                   " · Bridge " (fmt/compact-number (or (:bridge routing) 0))
                   " · Top peer " (or (:topPeer routing) "-"))
      :variant (tile-variant projected)}
     {:label (str "Est. Cost / " wl) :value (fmt/usd (num :costUsd24h))
      :detail (str (fmt/compact-number (/ (num :energyJoules24h) 1000)) " kJ energy") :variant (tile-variant (num :costUsd24h))}
     {:label (str "Water Evaporated / " wl) :value (fmt/water (num :waterEvaporatedMl24h))
      :detail "~1.8 L/kWh DC cooling avg" :variant (tile-variant (num :waterEvaporatedMl24h))}]))

(defn- dash-date [v] (if v (fmt/format-datetime v) "Never"))

(defn account-row-view [{:keys [providerId accountId displayName authType status healthScore avgTtftMs avgDecodeTps avgEndToEndTps
                                cacheKeyUseCount cacheHitCount cachedPromptTokens requestCount imageCount totalTokens imageCostUsd lastUsedAt]}]
  {:key (str providerId "-" accountId)
   :name displayName :auth (fmt/format-auth-type authType)
   :badge (case status "healthy" "success" "cooldown" "warning" "error") :status status
   :health (fmt/maybe-fraction-percent healthScore)
   :ttft (fmt/maybe-ms avgTtftMs) :decode (fmt/maybe-tps avgDecodeTps) :e2e (fmt/maybe-tps avgEndToEndTps)
   :cache (str (if (pos? (or cacheKeyUseCount 0))
                 (str (fmt/percent (* (/ cacheHitCount cacheKeyUseCount) 100)) " (" cacheHitCount "/" cacheKeyUseCount ")")
                 "-")
               (when (pos? (or cachedPromptTokens 0)) (str " · " (fmt/compact-number cachedPromptTokens) " cached")))
   :requests (str (fmt/compact-number requestCount) (when (pos? (or imageCount 0)) (str " · " (fmt/compact-number imageCount) " img")))
   :tokens (str (fmt/compact-number totalTokens) (when (pos? (or imageCostUsd 0)) (str " · " (fmt/usd imageCostUsd))))
   :last-seen (dash-date lastUsedAt)})

(defn log-row-view [{:keys [id timestamp model status upstreamErrorCode latencyMs serviceTierSource] :as entry}]
  {:id id :when (fmt/format-time timestamp) :route (format-provider-route-cell entry) :model model
   :tier (format-service-tier entry) :tier-badge (if (= serviceTierSource "fast_mode") "info" "default")
   :status-badge (cond (or (= status 0) (>= status 400)) "error" upstreamErrorCode "warning" :else "success")
   :status-text (str (if (= status 0) "ERR" status) (when upstreamErrorCode (str " " upstreamErrorCode)))
   :latency (str (fmt/round-half-up latencyMs) " ms")})

(defn provider-card-view [{:keys [providerId authType cooldownAccounts totalAccounts availableAccounts nextReadyInMs]}]
  {:id providerId :badge (if (pos? cooldownAccounts) "warning" "success") :auth (fmt/format-auth-type authType)
   :rows [["Total" (fmt/compact-number totalAccounts)] ["Available" (fmt/compact-number availableAccounts)]
          ["Cooling Down" (fmt/compact-number cooldownAccounts)]
          ["Ready In" (if (pos? nextReadyInMs) (str (long (Math/ceil (/ nextReadyInMs 1000))) "s") "now")]]})

(defn view-model [db]
  (let [{:keys [overview statuses logs loading? error loading-more? health-visible]} (slice db)
        w (window db) wl (window-label w)
        f (provider-filter db)
        accounts (vec (:accounts overview))
        filtered (if (= f all-providers) accounts (filterv #(= f (:providerId %)) accounts))
        top (take 6 (sort-by (comp - :totalTokens) accounts))
        coverage (:coverage overview)]
    {:window w :window-label wl :account-sort (account-sort db) :provider-filter f
     :loading? loading? :error error
     :coverage-note (when (and coverage (not (:hasFullWindowCoverage coverage)))
                      (if (:coverageStart coverage)
                        (str wl " window partially covered since " (fmt/format-datetime (:coverageStart coverage)) ".")
                        (str wl " window partially covered.")))
     :tiles (tiles overview loading? wl)
     :donut (donut-segments top)
     :legend (vec (map-indexed (fn [i a] {:key (str (:providerId a) "-" (:accountId a)) :index (mod i 6) :name (:displayName a)
                                          :tokens (str (fmt/compact-number (:totalTokens a)) " tokens")})
                               top))
     :tier-bars (when overview (tier-bars (:serviceTierRequests24h (:summary overview))))
     :overview? (some? overview)
     :trends (when overview {:requests (spark-bars (get-in overview [:trends :requests]))
                             :tokens (spark-bars (get-in overview [:trends :tokens]))})
     :providers (mapv provider-card-view (sort-by :providerId (vals statuses)))
     :logs (mapv log-row-view logs)
     :loading-more? loading-more?
     :log-version (str (count logs) loading-more?)
     :provider-options (provider-options overview)
     :accounts (mapv account-row-view (take health-visible filtered))
     :accounts-empty (if (empty? accounts) "No request log activity yet." (str "No accounts found for provider " f "."))
     :more-health? (< health-visible (count filtered))
     :has-filtered? (pos? (count filtered))
     :health-version (str health-visible (count filtered))}))
