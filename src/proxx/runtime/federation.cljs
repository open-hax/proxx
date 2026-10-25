(ns proxx.runtime.federation
  "JS edge for the federation kernels (src/lib/federation/*.ts).

  Conversion rule: JS objects become string-keyed wire maps with `undefined`
  properties dropped (absent) and `null` kept as nil (present), and results go
  back with `clj->js`, so the pure namespaces never see JS and never need to
  tell `undefined` from a missing key. Domain failures are ex-info; this edge
  rethrows them as plain `js/Error` with the same message so HTTP layers and
  peers see exactly what they saw before."
  (:require ["node:crypto" :as crypto]
            [proxx.federation.owner :as owner]
            [proxx.federation.protocol :as protocol]))

(defn js->wire
  "JS value to wire data: plain objects to string-keyed maps (undefined props
  dropped, null kept as nil), arrays to vectors, everything else unchanged."
  [x]
  (cond
    (nil? x) nil
    (array? x) (mapv js->wire x)
    (and (object? x) (identical? (type x) js/Object))
    (reduce (fn [acc k]
              (let [v (aget x k)]
                (if (undefined? v) acc (assoc acc k (js->wire v)))))
            {} (js-keys x))
    :else x))

(defn rethrow-as-error
  "Rethrow an ex-info as a plain Error carrying its message; pass anything else through."
  [e]
  (if (ex-data e) (throw (js/Error. (ex-message e))) (throw e)))

(defn- guarded [f] (try (f) (catch :default e (rethrow-as-error e))))

;; ---------------------------------------------------------------------------
;; bridge-protocol.ts
;; ---------------------------------------------------------------------------

(def bridge-protocol-version protocol/protocol-version)

(defn parse-bridge-message-js [value]
  (guarded #(clj->js (protocol/parse-message (js->wire value)))))

(defn parse-bridge-message-json-js [text]
  (guarded #(clj->js (protocol/parse-message-json text))))

(defn- or-undefined [x] (if (nil? x) js/undefined x))

;; ---------------------------------------------------------------------------
;; owner-credential.ts
;; ---------------------------------------------------------------------------

(defn- sha256-hex [^string s]
  (.digest (.update ^js (.createHash ^js crypto "sha256") s) "hex"))

(defn is-at-did-js [value] (owner/at-did? value))

(defn normalize-at-did-js [value] (guarded #(owner/normalize-at-did value)))

(defn fingerprint-admin-key-js [value] (owner/fingerprint-admin-key sha256-hex value))

(defn parse-federation-owner-credential-js [raw]
  (or-undefined (some-> (owner/parse-owner-credential sha256-hex raw) clj->js)))
