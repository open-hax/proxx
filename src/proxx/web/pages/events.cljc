(ns proxx.web.pages.events
  "Events page: filter/pagination state, selection and tag editing (pure)."
  (:require [clojure.string :as str]
            [proxx.web.api :as api]
            [proxx.web.format :as fmt]
            [proxx.web.fx :as fx]
            [proxx.web.state :as st]))

(def empty-filters {:kind "" :providerId "" :model "" :tag "" :since ""})
(def default-limit 50)
(def max-limit 500)
(def tag-summary-size 16)

(defn init []
  {:filters empty-filters :offset 0 :limit default-limit
   :events [] :total-count nil :loading? false :error nil :request-id 0
   :selected-id nil :selected-event nil :selected-loading? false :tag-input ""
   :tag-summary nil :tag-summary-since nil})

(defn since->iso
  "ISO-8601 for a user-typed date, nil when blank or unparsable (typing
  \"2026-\" must not crash the page)."
  [s]
  (let [s (str/trim (or s ""))]
    (when (seq s)
      #?(:cljs (let [d (js/Date. s)] (when-not (js/isNaN (.getTime d)) (.toISOString d)))
         :clj s))))

(defn- present [s] (let [t (str/trim (or s ""))] (when (seq t) t)))

(defn query-filters [{:keys [filters limit offset]}]
  {:kind (present (:kind filters))
   :providerId (present (:providerId filters))
   :model (present (:model filters))
   :tag (present (:tag filters))
   :since (since->iso (:since filters))
   :limit limit :offset offset
   :includePayload false :includeCount true})

(defn- refresh [db]
  (let [slice (st/page-slice db :events)
        id (inc (:request-id slice))]
    [(st/update-page db :events assoc :request-id id :loading? true :error nil)
     [(fx/http (api/list-events (query-filters slice)) [:events/loaded id] [:events/failed id])]]))

(defn enter [db]
  (let [[db' fx*] (refresh db)]
    [db' (conj fx* (fx/http (api/list-event-tags) [:events/tags-loaded] [:events/tags-failed]))]))

(defn- loaded [db [_ id payload]]
  (if (= id (:request-id (st/page-slice db :events)))
    [(st/update-page db :events assoc :loading? false :events (:events payload)
                     :total-count (let [t (:totalCount payload)] (when (number? t) t))) []]
    [db []]))

(defn- failed [db [_ id message]]
  (if (= id (:request-id (st/page-slice db :events)))
    [(st/update-page db :events assoc :loading? false :error message) []]
    [db []]))

(defn- tags-loaded [db [_ payload]]
  [(st/update-page db :events assoc :tag-summary (:tags payload) :tag-summary-since (:since payload)) []])
(defn- tags-failed [db _] [(st/update-page db :events assoc :tag-summary nil :tag-summary-since nil) []])

(defn- set-filter [db [_ k v]]
  (refresh (st/update-page db :events assoc-in [:filters k] v)))

(defn- apply-filters [db _] (refresh (st/assoc-page db :events :offset 0)))
(defn- clear-filters [db _] (refresh (st/update-page db :events assoc :filters empty-filters :offset 0)))

(defn parse-limit [s]
  (let [n #?(:cljs (js/parseInt s 10) :clj (try (Long/parseLong (str s)) (catch Exception _ nil)))]
    (if (and (number? n) (pos? n) #?(:cljs (not (js/isNaN n)) :clj true)) (min n max-limit) default-limit)))

(defn- set-limit [db [_ s]] (refresh (st/assoc-page db :events :limit (parse-limit s))))

(defn- page-prev [db _]
  (let [{:keys [offset limit]} (st/page-slice db :events)]
    (refresh (st/assoc-page db :events :offset (max 0 (- offset limit))))))
(defn- page-next [db _]
  (let [{:keys [offset limit]} (st/page-slice db :events)]
    (refresh (st/assoc-page db :events :offset (+ offset limit)))))

(defn- pick-tag [db [_ t]] (refresh (st/update-page db :events assoc :offset 0 :filters (assoc (:filters (st/page-slice db :events)) :tag t))))

(defn- select [db [_ id]]
  [(st/assoc-page db :events :selected-id id :selected-loading? true :selected-event nil)
   [(fx/http (api/get-event-by-id id) [:events/selected-loaded id] [:events/selected-failed id])]])

(defn- selected-loaded [db [_ id ev]]
  (if (= id (:selected-id (st/page-slice db :events)))
    [(st/assoc-page db :events :selected-event ev :selected-loading? false) []]
    [db []]))
(defn- selected-failed [db [_ id message]]
  (if (= id (:selected-id (st/page-slice db :events)))
    [(st/assoc-page db :events :selected-event nil :selected-loading? false :error message) []]
    [db []]))

(defn- set-tag-input [db [_ v]] [(st/assoc-page db :events :tag-input v) []])

(defn- add-tag [db _]
  (let [{:keys [selected-event tag-input]} (st/page-slice db :events)
        t (str/trim tag-input)]
    (if (or (nil? selected-event) (str/blank? t))
      [db []]
      [db [(fx/http (api/add-event-tag (:id selected-event) t) [:events/tag-changed (:id selected-event) true] [:events/tag-failed])]])))

(defn- remove-tag [db [_ t]]
  (let [{:keys [selected-event]} (st/page-slice db :events)]
    (if selected-event
      [db [(fx/http (api/remove-event-tag (:id selected-event) t) [:events/tag-changed (:id selected-event) false] [:events/tag-failed])]]
      [db []])))

(defn- tag-changed [db [_ id clear-input? _]]
  [(cond-> db clear-input? (st/assoc-page :events :tag-input ""))
   [(fx/http (api/get-event-by-id id) [:events/selected-loaded id] [:events/selected-failed id])]])

(defn- tag-failed [db [_ message]] [(st/assoc-page db :events :error message) []])

(def page
  {:init init :enter enter
   :handlers {:events/loaded loaded :events/failed failed
              :events/tags-loaded tags-loaded :events/tags-failed tags-failed
              :events/set-filter set-filter :events/apply apply-filters :events/clear clear-filters
              :events/set-limit set-limit :events/prev page-prev :events/next page-next
              :events/pick-tag pick-tag :events/select select
              :events/selected-loaded selected-loaded :events/selected-failed selected-failed
              :events/tag-input set-tag-input :events/add-tag add-tag :events/remove-tag remove-tag
              :events/tag-changed tag-changed :events/tag-failed tag-failed}})

(defn badge-variant [kind] (case kind "error" "error" "response" "success" "default"))

(defn event-row-view [selected-id {:keys [id ts kind providerId accountId model status tags payloadBytes]}]
  {:id id :selected? (= selected-id id)
   :ts (fmt/format-datetime ts) :kind kind :badge (badge-variant kind)
   :provider-account (str (fmt/format-maybe providerId) "/" (fmt/format-maybe accountId))
   :model (fmt/format-maybe model) :status (fmt/format-maybe-number status)
   :tags (vec (take 3 tags)) :more-tags (when (> (count tags) 3) (str "+" (- (count tags) 3)))
   :payload (fmt/format-bytes payloadBytes)})

(defn detail-view [{:keys [id ts kind entryId providerId accountId model status payloadBytes tags payload meta]}]
  {:id id :header-meta (str (fmt/format-datetime ts) " · " kind)
   :rows [["entry" entryId] ["provider" (fmt/format-maybe providerId)] ["account" (fmt/format-maybe accountId)]
          ["model" (fmt/format-maybe model)] ["status" (fmt/format-maybe-number status)]
          ["payload" (fmt/format-bytes payloadBytes)]]
   :tags tags
   :payload-json (fmt/compact-json payload)
   :meta-json (fmt/compact-json meta)})

(defn view-model [db]
  (let [{:keys [filters offset limit events total-count loading? error selected-id selected-event
                selected-loading? tag-input tag-summary tag-summary-since]} (st/page-slice db :events)]
    {:filters filters :offset offset :limit limit :loading? loading? :error error
     :can-prev? (pos? offset)
     :can-next? (and (= (count events) limit) (or (nil? total-count) (< (+ offset limit) total-count)))
     :meta (str "offset " offset " · limit " limit (when total-count (str " · total " total-count)))
     :tag-summary (when tag-summary
                    {:since (when tag-summary-since (str "since " (fmt/format-datetime tag-summary-since)))
                     :pills (mapv (fn [[t n]] {:tag t :count n}) (take tag-summary-size tag-summary))})
     :rows (mapv #(event-row-view selected-id %) events)
     :selected-id selected-id :selected-loading? selected-loading? :tag-input tag-input
     :detail (when selected-event (detail-view selected-event))}))
