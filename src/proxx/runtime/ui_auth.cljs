(ns proxx.runtime.ui-auth
  "JS edge for src/routes/shared/ui-auth.ts (same names/signatures)."
  (:require [proxx.http.ui-auth :as ui-auth]))

;; js->clj cannot tell `undefined` from `null`; the pure parsers can, via ::absent.
(defn- in [v] (if (undefined? v) ::ui-auth/absent (js->clj v)))
(defn- out [x] (if (= ::ui-auth/absent x) js/undefined (clj->js x)))

(defn parse-boolean-js [value] (ui-auth/parse-boolean value))
(defn parse-optional-requests-per-minute-js [value] (out (ui-auth/parse-optional-requests-per-minute (in value))))
(defn parse-optional-provider-ids-js [value] (out (ui-auth/parse-optional-provider-ids (in value))))
(defn parse-optional-model-ids-js [value] (out (ui-auth/parse-optional-model-ids (in value))))
(defn parse-optional-positive-integer-js [value]
  (let [n (ui-auth/parse-optional-positive-integer (js->clj value))] (if (nil? n) js/undefined n)))
(defn auth-can-view-tenant-js [auth tenant-id] (ui-auth/can-view-tenant? (js->clj auth) tenant-id))
(defn auth-can-manage-tenant-keys-js [auth tenant-id] (ui-auth/can-manage-tenant-keys? (js->clj auth) tenant-id))
(defn auth-can-manage-federation-js [auth] (ui-auth/can-manage-federation? (js->clj auth)))
(defn to-visible-tenants-js [auth fallback-tenants]
  (clj->js (ui-auth/visible-tenants (js->clj auth) (js->clj (or fallback-tenants #js [])))))
