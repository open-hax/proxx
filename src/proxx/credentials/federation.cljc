(ns proxx.credentials.federation
  "Row -> record mapping and small decisions of the SQL federation store.
  Rows are string-keyed (snake_case columns); records leave as string-keyed
  camelCase data. SQL NULL maps to an omitted key. JSON columns may arrive as
  text or as already-parsed objects; anything that is not a JSON object
  becomes {}. Statement texts stay in TypeScript."
  (:require [clojure.string :as str]
            [proxx.oauth.flow :as flow]))

(def max-diff-page-size 500)
(def default-warm-import-threshold 3)

(defn- number [x] #?(:cljs (js/Number x) :clj (double x)))

(defn- assoc-some [m k v] (if (some? v) (assoc m k v) m))

(defn parse-json-object
  "`raw` is a JSON text, an object, or nil. `parse` turns text into data (nil
  on malformed input). Non-objects (arrays, scalars) yield {}."
  [raw parse]
  (cond
    (or (nil? raw) (= raw "") (false? raw)) {}
    (string? raw) (let [parsed (parse raw)] (if (map? parsed) parsed {}))
    :else raw))

(defn warm-import-threshold
  "From FEDERATION_WARM_IMPORT_REQUEST_THRESHOLD: a non-negative integer, else 3."
  [raw]
  (let [trimmed (when (string? raw) (str/trim raw))]
    (if (empty? trimmed)
      default-warm-import-threshold
      (let [parsed (flow/parse-int trimmed)]
        (if (and (flow/finite-number? parsed) (>= parsed 0)) parsed default-warm-import-threshold)))))

(defn should-warm-import? [warm-request-count threshold]
  (and (flow/finite-number? warm-request-count) (>= warm-request-count threshold)))

(defn sanitize-limit
  "A page size in 1..500; `fallback` for anything else."
  [limit fallback]
  (if-not (flow/finite-number? limit)
    fallback
    (let [n (Math/floor limit)]
      (if (<= n 0) fallback (min n max-diff-page-size)))))

(defn peer-base-url-input
  "The trimmed base URL; an empty one is an error. URL parsing happens at the edge."
  [value]
  (let [t (str/trim value)]
    (when (empty? t)
      (throw (ex-info "federation peer baseUrl must not be empty" {:error/type :federation/empty-base-url})))
    t))

(defn base-url-conflict?
  "A unique-violation on the peer base URL, from error facts {:code :constraint :message}."
  [{:keys [code constraint message]}]
  (let [code (if (string? code) code "")
        constraint (if (string? constraint) constraint "")
        message (if (string? message) message "")]
    (and (= code "23505")
         (or (= constraint "federation_peers_base_url_key")
             (str/includes? message "federation_peers_base_url_key")
             (str/includes? message "base_url")))))

(defn peer-record [row parse]
  (-> {"id" (get row "id") "ownerSubject" (get row "owner_subject") "label" (get row "label")
       "baseUrl" (get row "base_url") "authMode" (get row "auth_mode")
       "auth" (parse-json-object (get row "auth_json") parse) "status" (get row "status")
       "capabilities" (parse-json-object (get row "capabilities") parse)
       "createdAt" (get row "created_at") "updatedAt" (get row "updated_at")}
      (assoc-some "peerDid" (get row "peer_did"))
      (assoc-some "controlBaseUrl" (get row "control_base_url"))
      (assoc-some "lastSeenAt" (get row "last_seen_at"))))

(defn diff-event-record [row parse]
  {"seq" (number (get row "seq")) "ownerSubject" (get row "owner_subject") "entityType" (get row "entity_type")
   "entityKey" (get row "entity_key") "op" (get row "op") "payload" (parse-json-object (get row "payload") parse)
   "createdAt" (get row "created_at")})

(defn projected-account-record [row parse]
  (-> {"sourcePeerId" (get row "source_peer_id") "ownerSubject" (get row "owner_subject")
       "providerId" (get row "provider_id") "accountId" (get row "account_id")
       "availabilityState" (get row "availability_state")
       "warmRequestCount" (number (get row "warm_request_count"))
       "metadata" (parse-json-object (get row "metadata") parse)
       "createdAt" (get row "created_at") "updatedAt" (get row "updated_at")}
      (assoc-some "accountSubject" (get row "account_subject"))
      (assoc-some "chatgptAccountId" (get row "chatgpt_account_id"))
      (assoc-some "email" (get row "email"))
      (assoc-some "planType" (get row "plan_type"))
      (assoc-some "lastRoutedAt" (get row "last_routed_at"))
      (assoc-some "importedAt" (get row "imported_at"))))

(defn sync-state-record [row]
  (-> {"peerId" (get row "peer_id") "lastPulledSeq" (number (get row "last_pulled_seq"))
       "lastPushedSeq" (number (get row "last_pushed_seq")) "updatedAt" (get row "updated_at")}
      (assoc-some "lastPullAt" (get row "last_pull_at"))
      (assoc-some "lastPushAt" (get row "last_push_at"))
      (assoc-some "lastError" (get row "last_error"))))
