(ns proxx.http.events
  "Decisions for the /events routes: how query-string values become the event
  store's filter, and which tag a request body names. Values keep the
  JavaScript coercions the original route applied (see proxx.http.params)."
  (:require [proxx.http.guard :as guard]
            [proxx.http.params :as params]))

(defn unavailable
  "503 when the host has no event store. `detail` distinguishes the list route's
  longer message."
  ([] (unavailable "Event store not available"))
  ([message] (guard/error 503 message)))

(defn- present-int [q k]
  (when (params/truthy-string? (get q k))
    (params/parse-int (params/js-string (get q k)))))

(defn- present-time
  "The raw time string for the edge to turn into a Date (nil when absent)."
  [q k]
  (when (params/truthy-string? (get q k)) (params/js-string (get q k))))

(defn count-filter
  "The filter shared by query and count, as a map the edge turns into the
  store's argument. Absent filters are omitted. kind/entry/provider/model/tag
  pass through untouched (a repeated parameter stays a vector); status values
  parse like parseInt and may be NaN; since/until stay strings for the edge to
  convert."
  [q]
  (cond-> {}
    (some? (get q "kind")) (assoc :kind (get q "kind"))
    (some? (get q "entry_id")) (assoc :entryId (get q "entry_id"))
    (some? (get q "provider_id")) (assoc :providerId (get q "provider_id"))
    (some? (get q "model")) (assoc :model (get q "model"))
    (params/truthy-string? (get q "status")) (assoc :status (present-int q "status"))
    (params/truthy-string? (get q "status_gte")) (assoc :statusGte (present-int q "status_gte"))
    (params/truthy-string? (get q "status_lt")) (assoc :statusLt (present-int q "status_lt"))
    (some? (get q "tag")) (assoc :tag (get q "tag"))
    (params/truthy-string? (get q "since")) (assoc :since (present-time q "since"))
    (params/truthy-string? (get q "until")) (assoc :until (present-time q "until"))))

(defn query-filter
  "count-filter plus paging: limit defaults to 50, offset is optional."
  [q]
  (cond-> (assoc (count-filter q)
                 :limit (if (params/truthy-string? (get q "limit")) (present-int q "limit") 50)
                 :includePayload (= "true" (get q "include_payload")))
    (params/truthy-string? (get q "offset")) (assoc :offset (present-int q "offset"))))

(defn include-count? [q] (= "true" (get q "include_count")))

(defn list-body
  "{events, count, totalCount?}: totalCount is omitted unless counted."
  [events n total]
  (cond-> {"events" events "count" n}
    (some? total) (assoc "totalCount" total)))

(defn tag-of
  "The tag a body names: String(body.tag) when the body is an object that has a
  `tag` key (even null -> \"null\"), else nil. Callers reject a nil/empty tag."
  [body]
  (when (and (map? body) (contains? body "tag"))
    (params/js-string (get body "tag"))))

(defn tag-or-error
  "[tag nil] or [nil error-response]."
  [body]
  (let [tag (tag-of body)]
    (if (seq tag) [tag nil] [nil (guard/error 400 "Missing tag field")])))
