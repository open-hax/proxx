;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.policy.catalog-watch
  "Read-only catalog transport and local observation persistence for NBB."
  (:require [cljs.reader :as reader]
            [clojure.string :as str]
            [promesa.core :as p]
            [proxx.policy.evidence :as evidence]
            [proxx.policy.model-availability :as availability]
            ["node:fs" :as fs]
            ["node:path" :as path]
            ["node:crypto" :as crypto]))

(def official-endpoints
  #{"https://opencode.ai/zen/v1/models" "https://opencode.ai/zen/go/v1/models"
    "https://api.kimi.com/coding/v1/models" "https://api.kimi.ai/coding/v1/models"})

(defn- loopback? [endpoint]
  (boolean (re-matches #"http://(?:127\.0\.0\.1|localhost):[0-9]+/models" endpoint)))

(defn read-edn [filename]
  (reader/read-string (fs/readFileSync filename "utf8")))

(defn- positive-integer? [n] (and (integer? n) (pos? n)))
(defn- text? [s] (and (string? s) (not (str/blank? s))))
(defn- timestamp? [n] (and (integer? n) (<= 0 n 8640000000000000)))

(defn validate-config! [config allow-loopback?]
  (when-not (and (map? config)
                 (every? #{:providers :max-age-ms :timeout-ms :baseline-path :report-dir
                           :registration-file} (keys config))
                 (vector? (:providers config)) (seq (:providers config))
                 (positive-integer? (:max-age-ms config))
                 (positive-integer? (:timeout-ms config)) (<= (:timeout-ms config) 30000)
                 (every? text? (map config [:baseline-path :report-dir]))
                 (or (nil? (:registration-file config)) (text? (:registration-file config)))
                 (every? (fn [provider]
                           (and (every? #{:provider-id :scope :endpoint :credential-env :watch-models}
                                        (keys provider))
                                (every? text? (map provider [:provider-id :scope :endpoint]))
                                (string? (:credential-env provider))
                                (re-matches #"[A-Z][A-Z0-9_]*" (:credential-env provider))
                                (or (official-endpoints (:endpoint provider))
                                    (and allow-loopback? (loopback? (:endpoint provider))))
                                (vector? (:watch-models provider))
                                (every? text? (:watch-models provider))))
                         (:providers config))
                 (= (count (:providers config))
                    (count (distinct (map #(select-keys % [:provider-id :endpoint :scope])
                                          (:providers config))))))
    (throw (ex-info "Invalid public watcher configuration" {})))
  config)

(defn- credential-values [config]
  (keep #(let [value (aget (.-env js/process) (:credential-env %))]
           (when (text? value) value)) (:providers config)))

(defn- reflected? [text config]
  (boolean (some #(str/includes? text %) (credential-values config))))

(defn- read-public-edn [filename config]
  (let [raw (fs/readFileSync filename "utf8")]
    (when (reflected? raw config) (throw (ex-info "Nonpublic input rejected" {})))
    (reader/read-string raw)))

(defn- identity-of [snapshot]
  (select-keys snapshot [:provider-id :endpoint :scope :source-kind :collection-mode]))

(defn- envelope
  ([provider now-ms] (envelope provider now-ms :authenticated-get))
  ([provider now-ms collection-mode]
  (merge (select-keys provider [:provider-id :endpoint :scope])
         {:source-kind :provider-catalog :observed-at-ms now-ms
          :observed-at (.toISOString (js/Date. now-ms)) :authoritative? true
          :collection-mode collection-mode :credential-env (:credential-env provider)})))

(defn- id? [value]
  (and (string? value) (<= 1 (count value) 512)
       (boolean (re-matches #"[A-Za-z0-9][A-Za-z0-9._:/+@ -]*" value))))

(defn- tokens [values]
  (when (and (or (vector? values) (set? values)) (every? id? values)) (set values)))

(defn- capabilities [model]
  (let [scalars (into {} (filter (fn [[key value]]
                                  (case key
                                    (:context_length :context_window :max_input_tokens :max_output_tokens)
                                    (positive-integer? value)
                                    (:supports_reasoning :supports_tools) (boolean? value)
                                    (:model_version :version :name :owned_by) (id? value)
                                    false))
                                (select-keys model [:context_length :context_window :max_input_tokens
                                                    :max_output_tokens :supports_reasoning :supports_tools
                                                    ;; Zen/Go :created equals response time; it is not model identity.
                                                    :model_version :version :name :owned_by])))
        raw (:reasoning model)
        effort (:effort raw)
        reasoning (cond
                    (boolean? raw) raw
                    (map? raw) (cond-> {}
                                 (id? (:type raw)) (assoc :type (:type raw))
                                 (or (id? (:default effort)) (tokens (:valid effort)))
                                 (assoc :effort (cond-> {}
                                                  (id? (:default effort)) (assoc :default (:default effort))
                                                  (tokens (:valid effort)) (assoc :valid (tokens (:valid effort)))))))
        modalities (into {} (keep (fn [key]
                                    (when-let [values (tokens (get (:modalities model) key))]
                                      [key values])) [:input :output]))]
    (cond-> scalars
      (some? reasoning) (assoc :reasoning reasoning)
      (seq modalities) (assoc :modalities modalities))))

(defn shape-catalog
  "Pure projection of public catalog fields; no I/O or baseline mutation."
  [payload]
  (let [items (if (vector? payload) payload (or (:data payload) (:models payload)))
        ids (evidence/model-ids-from-v1-models-payload payload)
        complete? (not (some #(and (some? %) (not= false %) (not= "" %))
                             [(:has_more payload) (:next payload) (:next_page payload)
                              (:next_cursor payload) (get-in payload [:links :next])
                              (get-in payload [:meta :has_next_page])
                              (when (number? (:total payload)) (> (:total payload) (count items)))]))]
    (when-not (and (vector? items) (= (count items) (count ids))
                   (every? id? ids) (= (count ids) (count (distinct ids))))
      (throw (ex-info "Invalid catalog shape" {})))
    {:complete? complete?
     :models (into {} (map (fn [id model]
                            (let [caps (capabilities model)
                                  target (or (when (id? (:target_id model)) (:target_id model))
                                             (when (id? (:canonical_id model)) (:canonical_id model)))]
                              [id (cond-> {}
                                    target (assoc :target-id target)
                                    (seq caps) (assoc :capabilities caps))])) ids items))}))

(defn ^:async fetch-observation! [provider {:keys [now-ms timeout-ms]}]
  (let [key (aget (.-env js/process) (:credential-env provider))
        base (envelope provider now-ms)
        failed (fn [status] (assoc base :status status :complete? false :models {}))]
    (if-not (text? key)
      (p/resolved (failed :credential-unavailable))
      (let [controller (js/AbortController.)
            timer (js/setTimeout #(.abort controller) timeout-ms)]
        (-> (p/let [response (js/fetch (:endpoint provider)
                                      #js {:method "GET" :redirect "error" :signal (.-signal controller)
                                           :headers #js {"Authorization" (str "Bearer " key)
                                                         "User-Agent" "proxx-catalog-watch/1.0"}})]
              (if-not (= 200 (.-status response))
                (assoc (failed :http-error) :http-status (.-status response))
                (p/let [body (.text response)]
                  (if (or (> (count body) 2097152) (str/includes? body key))
                    (assoc (failed :invalid-response) :http-status 200)
                    (try
                      (merge base {:status :ok :http-status 200}
                             (shape-catalog (js->clj (js/JSON.parse body) :keywordize-keys true)))
                      (catch :default _ (assoc (failed :invalid-response) :http-status 200)))))))
            (p/catch (fn [_] (failed (if (.-aborted (.-signal controller)) :timeout :transport-error))))
            (p/finally #(js/clearTimeout timer)))))))

(defn- public-snapshot [snapshot]
  ;; Supplied observations/baselines are public data, never a transport envelope.
  ;; Keep only the fields the pure contract needs, even if callers supply headers.
  (when-not (and (map? snapshot) (timestamp? (:observed-at-ms snapshot))
                 (= :provider-catalog (:source-kind snapshot))
                 (every? text? (map snapshot [:provider-id :endpoint :scope]))
                 (contains? #{:ok :http-error :timeout :transport-error :invalid-response
                              :credential-unavailable} (:status snapshot))
                 (boolean? (:authoritative? snapshot)) (boolean? (:complete? snapshot))
                 (or (nil? (:http-status snapshot)) (and (integer? (:http-status snapshot))
                                                       (<= 100 (:http-status snapshot) 599)))
                 (or (nil? (:stale? snapshot)) (boolean? (:stale? snapshot)))
                 (or (nil? (:collection-mode snapshot))
                     (contains? #{:authenticated-get :supplied} (:collection-mode snapshot)))
                 (map? (:models snapshot))
                 (every? (fn [[id descriptor]] (and (id? id) (map? descriptor))) (:models snapshot)))
    (throw (ex-info "Invalid public observation" {})))
  (assoc (select-keys snapshot [:provider-id :endpoint :scope :source-kind :status
                                :observed-at-ms :http-status :complete? :authoritative? :stale? :collection-mode])
         :observed-at (.toISOString (js/Date. (:observed-at-ms snapshot)))
         :models (into {} (map (fn [[id descriptor]]
                                (let [caps (capabilities (:capabilities descriptor))]
                                  [id (cond-> {}
                                        (id? (:target-id descriptor)) (assoc :target-id (:target-id descriptor))
                                        (seq caps) (assoc :capabilities caps))])) (:models snapshot)))))

(defn- snapshot-index [snapshots]
  (when-not (and (vector? snapshots)
                 (= (count snapshots) (count (distinct (map identity-of snapshots)))))
    (throw (ex-info "Invalid or duplicate catalog scopes" {})))
  (into {} (map #(vector (identity-of %) %) (mapv public-snapshot snapshots))))

(defn- write-edn! [filename value exclusive?]
  (fs/mkdirSync (path/dirname filename) #js {:recursive true})
  (fs/writeFileSync filename (str (pr-str value) "\n")
                    #js {:encoding "utf8" :mode 384 :flag (if exclusive? "wx" "w")}))

(defn- registration [data provider-id model-id options]
  (let [age (when (integer? (:observed-at-ms data))
              (- (:now-ms options) (:observed-at-ms data)))
        fresh? (and age (<= 0 age (:max-age-ms options)))
        ids (get (:models data) provider-id)]
    {:status (cond (nil? data) :unknown fresh? :fresh :else :stale)
     :source :supplied-runtime-registration
     :registered? (when (and fresh? (set? ids)) (contains? ids model-id))
     :observed-at-ms (:observed-at-ms data)}))

(defn ^:async poll-once!
  [config {:keys [now-ms allow-loopback? observations-file]}]
  (validate-config! config allow-loopback?)
  (let [now-ms (or now-ms (.now js/Date))
        collection-mode (if observations-file :supplied :authenticated-get)
        authenticated? (= :authenticated-get collection-mode)
        _ (when-not (timestamp? now-ms) (throw (ex-info "Invalid observation clock" {})))
        _ (when (reflected? (pr-str config) config) (throw (ex-info "Nonpublic configuration" {})))
        options {:now-ms now-ms :max-age-ms (:max-age-ms config)}
        baseline (if (and authenticated? (fs/existsSync (:baseline-path config)))
                   (read-public-edn (:baseline-path config) config) {:snapshots []})
        registrations (when (:registration-file config) (read-public-edn (:registration-file config) config))
        ;; Untagged legacy snapshots cannot prove authenticated collection.
        ;; Supplied replay neither reads nor compares against the live baseline.
        before (into {} (filter (fn [[_ snapshot]] (= :authenticated-get (:collection-mode snapshot)))
                                (snapshot-index (:snapshots baseline))))]
    (p/let [observations (if observations-file
                          (:snapshots (read-public-edn observations-file config))
                          (p/all (map #(fetch-observation! % {:now-ms now-ms :timeout-ms (:timeout-ms config)})
                                      (:providers config))))]
      (let [_ (when-not (vector? observations) (throw (ex-info "Invalid observation vector" {})))
            ;; The invocation, not an assertion in the input file, owns provenance.
            selected (snapshot-index (mapv #(assoc % :collection-mode collection-mode) observations))
            observations (mapv #(get selected (identity-of (envelope % now-ms collection-mode))) (:providers config))
            _ (when-not (= (set (keys selected))
                           (set (map #(identity-of (envelope % now-ms collection-mode)) (:providers config))))
                (throw (ex-info "Observation scopes do not match public configuration" {})))
            assessments (vec (mapcat
                              (fn [provider]
                                (let [id (identity-of (envelope provider now-ms collection-mode))
                                      old (get before id) current (get selected id)
                                      models (sort (distinct (concat (:watch-models provider)
                                                                     (keys (:models old)) (keys (:models current)))))]
                                  (map #(assoc (availability/assess-model old current % options)
                                               :runtime-registration (registration registrations (:provider-id provider) % options))
                                       models)))
                              (:providers config)))
            next-baseline (reduce (fn [state current]
                                    (let [id (identity-of current)
                                          good (availability/advance-baseline (get state id) current options)]
                                      (if good (assoc state id good) state)))
                                  before observations)
            baseline-updated? (and authenticated? (not= before next-baseline))
            report {:schema :proxx/catalog-watch-v1 :observed-at-ms now-ms
                    :collection-mode collection-mode :baseline-updated? baseline-updated?
                    :max-age-ms (:max-age-ms config) :assurance :catalog-only
                    :observations observations :assessments assessments}
            report-file (path/join (:report-dir config)
                                   (str now-ms "-" (crypto/randomUUID) ".edn"))
            temporary (str (:baseline-path config) "." (crypto/randomUUID) ".tmp")]
        (when (reflected? (pr-str report) config) (throw (ex-info "Nonpublic report rejected" {})))
        (write-edn! report-file report true)
        (when baseline-updated?
          (write-edn! temporary {:snapshots (vec (sort-by (comp pr-str identity-of) (vals next-baseline)))} true)
          (fs/renameSync temporary (:baseline-path config)))
        {:report-file report-file :baseline-path (:baseline-path config)
         :collection-mode collection-mode :baseline-updated? baseline-updated?
         :observed-at-ms now-ms
         :availability-counts (frequencies (map :availability assessments))
         :drift-count (count (filter #(seq (:drift %)) assessments))}))))
