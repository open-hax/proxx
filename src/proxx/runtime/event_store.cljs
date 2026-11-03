(ns proxx.runtime.event-store
  "Edge of the event store (`src/lib/db/event-store.ts`): one atom for the write
  buffer, a flush timer, and the statements run over a postgres.js client.
  Decisions (tag merging, chunking, statement text and parameters, row mapping)
  are `proxx.events.store`; payloads stay host objects end to end."
  (:require ["node:crypto" :as crypto]
            [proxx.events.store :as store]
            [proxx.runtime.events :as events]
            [proxx.runtime.sql-util :as u]))

(defn- copy-array [a] (js/Array.from (or a #js [])))
(defn- copy-object [o] (js/Object.assign #js {} (or o #js {})))

(defn- event-fields
  "Shallow string-keyed view of a buffered event with its JSON columns copied."
  [^js ev]
  {"kind" (.-kind ev) "entryId" (.-entryId ev) "providerId" (.-providerId ev) "accountId" (.-accountId ev)
   "model" (.-model ev) "status" (.-status ev)
   "tags" (copy-array (.-tags ev)) "meta" (copy-object (.-meta ev))
   "payload" (when (u/truthy? (.-payload ev)) (copy-object (.-payload ev)))})

(defn- payload-bytes [^js ev]
  (when (u/truthy? (.-payload ev))
    (js/Buffer.byteLength (js/JSON.stringify (.-payload ev)) "utf8")))

(defn create-event-store-js
  "The facade `EventStore` forwards to."
  ([sql] (create-event-store-js sql 3000 200))
  ([^js sql flush-interval-ms max-buffer-size]
   (let [buffer (atom [])
         labelers (atom [])
         timer (atom nil)
         flushing (atom false)
         write-chunk!
         (fn ^:async write-chunk [chunk]
           (doseq [ev chunk]
             (let [values (store/insert-event-values (event-fields ev) #(.json sql %) (payload-bytes ev))]
               (await (u/template-call sql {"strings" store/insert-event-strings "values" values})))))
         write-batch!
         (fn ^:async write-batch [batch]
           (doseq [chunk (store/chunks batch)]
             ;; Log but never throw: event storage must not block the proxy.
             (try (await (write-chunk! chunk))
                  (catch :default err (js/console.error "EventStore: failed to write batch" err)))))
         flush!
         (fn ^:async flush []
           (when (and (not @flushing) (seq @buffer))
             (reset! flushing true)
             (try
               (let [batch @buffer]
                 (reset! buffer [])
                 (await (write-batch! batch)))
               (finally (reset! flushing false))))
           js/undefined)
         emit!
         (fn [^js event]
           (let [id (.randomUUID crypto)
                 auto-tags (into [] (mapcat (fn [^js l] (when (.applies l event) (array-seq (.label l event))))) @labelers)
                 merged (if-let [tags (store/merged-tags (array-seq (or (.-tags event) #js [])) auto-tags)]
                          (js/Object.assign #js {} event #js {"tags" (to-array tags)})
                          event)]
             (swap! buffer conj merged)
             (when (store/full? (count @buffer) max-buffer-size)
               (.catch (flush!) (fn [_] nil)))
             id))
         emit-kind!
         (fn [kind entry-id provider-id account-id model status payload meta]
           (emit! #js {"kind" kind "entryId" entry-id "providerId" provider-id "accountId" account-id
                       "model" model "status" status "tags" #js [] "meta" (or meta #js {})
                       "payload" payload}))
         sanitize (fn [payload] (events/event-sanitize-payload-js payload))
         parse-rows (fn [rows] (.map rows (fn [row] (events/event-parse-row-js row))))]
     #js {"init" (fn ^:async init []
                   (doseq [statement (events/event-ddl-js)] (await (.unsafe sql statement)))
                   (when-not @timer
                     (reset! timer (js/setInterval (fn [] (.catch (flush!) (fn [_] nil))) flush-interval-ms)))
                   js/undefined)

          "registerLabeler" (fn [labeler] (swap! labelers conj labeler) js/undefined)

          "emit" emit!

          "emitRequest" (fn [entry-id provider-id account-id model upstream-payload meta]
                          (emit-kind! "request" entry-id provider-id account-id model js/undefined
                                      (sanitize upstream-payload) meta)
                          js/undefined)

          "emitResponse" (fn [entry-id provider-id account-id model status response-payload meta]
                           (emit-kind! "response" entry-id provider-id account-id model status
                                       (if (u/truthy? response-payload) (sanitize response-payload) nil) meta)
                           js/undefined)

          "emitError" (fn [entry-id provider-id account-id model status error-payload meta]
                        (emit-kind! "error" entry-id provider-id account-id model status
                                    (sanitize error-payload) meta)
                        js/undefined)

          "query" (fn ^:async query [filters]
                    (let [^js q (events/event-build-query-js filters)]
                      (parse-rows (await (.unsafe sql (.-text q) (.-values q))))))

          "count" (fn ^:async count-events [filters]
                    (let [^js q (events/event-build-count-js filters)
                          rows (await (.unsafe sql (.-text q) (.-values q)))
                          ^js first-row (aget rows 0)]
                      (if first-row (js/Number.parseInt (.-count first-row) 10) 0)))

          "getById" (fn ^:async get-by-id [event-id]
                      (let [rows (await (.unsafe sql store/get-by-id-text #js [event-id]))
                            row (aget rows 0)]
                        (if row (events/event-parse-row-js row) nil)))

          "addTag" (fn ^:async add-tag [event-id tag]
                     (await (u/template-call sql (store/add-tag-statement event-id (js/JSON.stringify #js [tag]) tag)))
                     js/undefined)

          "removeTag" (fn ^:async remove-tag [event-id tag]
                        (await (u/template-call sql (store/remove-tag-statement event-id tag)))
                        js/undefined)

          "countByTag" (fn ^:async count-by-tag [since]
                         (let [^js q (events/event-count-by-tag-query-js since)
                               rows (await (.unsafe sql (.-text q) (.-values q)))
                               result #js {}]
                           (doseq [^js row (array-seq rows)]
                             (aset result (.-tag row) (js/parseInt (.-count row) 10)))
                           result))

          "flush" flush!

          "close" (fn ^:async close []
                    (when-let [t @timer] (js/clearInterval t) (reset! timer nil))
                    (await (flush!))
                    js/undefined)})))
