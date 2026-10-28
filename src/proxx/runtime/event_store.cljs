(ns proxx.runtime.event-store
  "The Postgres event store: an atom holding the pending buffer and registered
  labelers, the flush timer, and the SQL. Query building, row parsing, DDL and
  payload sanitising are proxx.events.store (via proxx.runtime.events).

  Persisted behaviour kept from the TypeScript store: `emit` returns a fresh
  uuid but the stored row gets `gen_random_uuid()`; a failed chunk is logged to
  stderr and dropped, never thrown at the proxy."
  (:require ["node:crypto" :as crypto]
            [proxx.runtime.events :as events]
            [proxx.runtime.sql-tag :as tag]))

(def ^:private flush-batch-size 50)

(def ^:private insert-pieces
  ["
        INSERT INTO events (id, ts, kind, entry_id, provider_id, account_id, model, status, tags, meta, payload, payload_bytes)
        VALUES (
          gen_random_uuid(), NOW(),
          " ",
          " ",
          " ",
          " ",
          " ",
          " ",
          " ",
          " ",
          " ",
          " ",
          "
        )
      "])

(defn- nullish [x] (if (nil? x) nil x))

(defn- obj-or-empty [x] (if (some? x) (js/Object.assign #js {} x) #js {}))

(defn- write-event! [^js sql ^js ev]
  (let [payload (.-payload ev)
        payload-bytes (when payload (js/Buffer.byteLength (js/JSON.stringify payload) "utf8"))
        tags (.slice (or (.-tags ev) #js []))
        meta (obj-or-empty (.-meta ev))
        payload (when payload (js/Object.assign #js {} payload))]
    (tag/exec sql insert-pieces
              (.-kind ev) (.-entryId ev)
              (nullish (.-providerId ev)) (nullish (.-accountId ev)) (nullish (.-model ev)) (nullish (.-status ev))
              (.json sql tags) (.json sql meta)
              (if payload (.json sql payload) nil)
              payload-bytes)))

(defn- ->sanitized [payload] (events/event-sanitize-payload-js payload))

(defn create-event-store-js
  "A store over the postgres.js handle `sql`. Flush every `flush-interval-ms`
  (default 3000) or when `max-buffer-size` (default 200) events are pending."
  [^js sql flush-interval-ms max-buffer-size]
  (let [flush-ms (if (nil? flush-interval-ms) 3000 flush-interval-ms)
        max-buffer (if (nil? max-buffer-size) 200 max-buffer-size)
        state (atom {:buffer [] :labelers [] :flushing? false})
        timer (atom nil)
        parse-row events/event-parse-row-js
        write-batch!
        (fn ^:async write-batch [batch]
          (doseq [chunk (partition-all flush-batch-size batch)]
            (try
              (doseq [ev chunk] (await (write-event! sql ev)))
              (catch :default err
                (js/console.error "EventStore: failed to write batch" err)))))
        flush!
        (fn ^:async flush []
          (let [{:keys [buffer flushing?]} @state]
            (when-not (or flushing? (empty? buffer))
              (swap! state assoc :flushing? true :buffer [])
              (try (await (write-batch! buffer))
                   (finally (swap! state assoc :flushing? false))))
            js/undefined))
        emit!
        (fn [^js event]
          (let [id (.randomUUID crypto)
                auto-tags (into [] (mapcat (fn [^js l] (when (.applies l event) (array-seq (.label l event)))))
                                (:labelers @state))
                merged (if (seq auto-tags)
                         (let [o (js/Object.assign #js {} event)]
                           (aset o "tags" (.concat (or (.-tags event) #js []) (to-array auto-tags)))
                           o)
                         event)]
            (swap! state update :buffer conj merged)
            (when (>= (count (:buffer @state)) max-buffer)
              (.catch (flush!) (fn [_] nil)))
            id))
        emit-kind!
        (fn [kind entry-id provider-id account-id model status payload meta]
          (emit! #js {"kind" kind "entryId" entry-id "providerId" provider-id "accountId" account-id "model" model
                      "status" status "tags" #js [] "meta" (if (some? meta) meta #js {})
                      "payload" payload}))]
    #js {:init (fn ^:async init []
                 (doseq [statement (array-seq (events/event-ddl-js))]
                   (await (.unsafe sql statement)))
                 (when-not @timer
                   (reset! timer (js/setInterval (fn [] (.catch (flush!) (fn [_] nil))) flush-ms)))
                 js/undefined)
         :registerLabeler (fn [labeler] (swap! state update :labelers conj labeler) js/undefined)
         :emit emit!
         :emitRequest (fn [entry-id provider-id account-id model upstream-payload meta]
                        (emit-kind! "request" entry-id provider-id account-id model js/undefined
                                    (->sanitized upstream-payload) meta)
                        js/undefined)
         :emitResponse (fn [entry-id provider-id account-id model status response-payload meta]
                         (emit-kind! "response" entry-id provider-id account-id model status
                                     (if response-payload (->sanitized response-payload) nil) meta)
                         js/undefined)
         :emitError (fn [entry-id provider-id account-id model status error-payload meta]
                      (emit-kind! "error" entry-id provider-id account-id model status
                                  (->sanitized error-payload) meta)
                      js/undefined)
         :query (fn ^:async query [filters]
                  (let [^js q (events/event-build-query-js filters)
                        rows (await (.unsafe sql (.-text q) (.-values q)))]
                    (.map rows (fn [row] (parse-row row)))))
         :count (fn ^:async count* [filters]
                  (let [^js q (events/event-build-count-js filters)
                        rows (await (.unsafe sql (.-text q) (.-values q)))
                        first-row (aget rows 0)]
                    (if first-row (js/Number.parseInt (.-count ^js first-row) 10) 0)))
         :getById (fn ^:async get-by-id [event-id]
                    (let [rows (await (.unsafe sql "SELECT * FROM events WHERE id = $1::uuid LIMIT 1" #js [event-id]))
                          row (aget rows 0)]
                      (if row (parse-row row) nil)))
         :addTag (fn ^:async add-tag [event-id tag-name]
                   (await (tag/exec sql ["UPDATE events SET tags = tags || " "::jsonb WHERE id = " "::uuid AND NOT tags ? " ""]
                                    (js/JSON.stringify #js [tag-name]) event-id tag-name))
                   js/undefined)
         :removeTag (fn ^:async remove-tag [event-id tag-name]
                      (await (tag/exec sql ["UPDATE events SET tags = tags - " " WHERE id = " "::uuid"] tag-name event-id))
                      js/undefined)
         :countByTag (fn ^:async count-by-tag [since]
                       (let [^js q (events/event-count-by-tag-query-js since)
                             rows (await (.unsafe sql (.-text q) (.-values q)))
                             result #js {}]
                         (doseq [^js row (array-seq rows)]
                           (aset result (.-tag row) (js/parseInt (.-count row) 10)))
                         result))
         :flush (fn [] (flush!))
         :close (fn ^:async close []
                  (when-let [t @timer] (js/clearInterval t) (reset! timer nil))
                  (await (flush!))
                  js/undefined)}))

(defn create-default-labelers-js
  "The labelers every event store registers, in order: handles on the rules of
  proxx.events.labelers, with the {id, applies, label} shape the store expects."
  []
  (to-array
   (map (fn [id] #js {"id" id
                      "applies" (fn [event] (events/event-labeler-applies-js id event))
                      "label" (fn [event] (events/event-labeler-label-js id event))})
        ["error_classifier" "tool_use" "content_pattern" "response_quality" "cost_tier"])))
