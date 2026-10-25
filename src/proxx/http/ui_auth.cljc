(ns proxx.http.ui-auth
  "Authorization decisions and request-value parsers for the UI/API routes.

  `auth` is the resolved request identity (string-keyed, as produced by the auth
  hook): {\"kind\" \"legacy_admin\"|\"tenant_api_key\"|\"ui_session\"|\"unauthenticated\",
  \"tenantId\" \"role\" \"memberships\" [{\"tenantId\" \"role\" \"tenantName\" \"tenantStatus\"}]}
  or nil. Every decision is a pure predicate over it; nil means no identity and
  is always denied."
  (:refer-clojure :exclude [parse-boolean])
  (:require [clojure.string :as str]))

;; ---------------------------------------------------------------------------
;; Parsers
;; ---------------------------------------------------------------------------

(def ^:private truthy #{"1" "true" "yes" "on"})
(def ^:private null-words #{"" "null" "none" "off"})

(defn- finite? [x]
  (and (number? x) #?(:cljs (js/Number.isFinite x) :clj (not (or (Double/isNaN (double x)) (Double/isInfinite (double x)))))))

(defn- parse-int
  "Leading base-10 integer of a string (like parseInt), or nil."
  [s]
  (when-let [[_ digits] (re-find #"^\s*([+-]?\d+)" s)]
    #?(:cljs (js/parseInt digits 10) :clj (Long/parseLong (str/replace digits #"^\+" "")))))

(defn parse-boolean
  "True for true, and for \"1\" / \"true\" / \"yes\" / \"on\" in any case; false otherwise."
  [value]
  (cond (boolean? value) value
        (string? value) (contains? truthy (str/lower-case (str/trim value)))
        :else false))

(defn parse-optional-requests-per-minute
  "`::absent` (not provided) → ::absent; nil (null), \"\"/none/off/null or a
  non-positive number → nil (no limit); a positive number or numeric string →
  that whole number; anything else → ::absent."
  [value]
  (cond
    (= ::absent value) ::absent
    (nil? value) nil
    (finite? value) (if (pos? value) (long (Math/floor value)) nil)
    (string? value) (let [normalized (str/lower-case (str/trim value))]
                      (if (contains? null-words normalized)
                        nil
                        (let [n (parse-int normalized)]
                          (if (and n (pos? n)) n ::absent))))
    :else ::absent))

(defn- parse-optional-id-list [value]
  (cond
    (= ::absent value) ::absent
    (nil? value) nil
    (not (sequential? value)) ::absent
    :else (let [ids (->> value (filter string?) (map (comp str/lower-case str/trim)) (remove empty?) distinct vec)]
            (if (seq ids) ids nil))))

(defn parse-optional-provider-ids
  "A de-duplicated, lower-cased id list; nil (null) stays nil, as does an empty
  list; ::absent (or a non-list) is ::absent."
  [value] (parse-optional-id-list value))

(defn parse-optional-model-ids [value] (parse-optional-id-list value))

(defn parse-optional-positive-integer
  "A whole positive number from a number or numeric string, else nil."
  [value]
  (cond
    (or (nil? value) (= "" value)) nil
    (finite? value) (when (pos? value) (long (Math/floor value)))
    (string? value) (let [n (parse-int (str/trim value))] (when (and n (pos? n)) n))
    :else nil))

;; ---------------------------------------------------------------------------
;; Authorization
;; ---------------------------------------------------------------------------

(defn normalize-tenant-id [value]
  (let [normalized (str/lower-case (str/trim value))]
    (when (empty? normalized)
      (throw (ex-info "tenant id must not be empty" {:error/type :tenant/empty-id})))
    normalized))

(defn- legacy-admin? [auth] (= "legacy_admin" (get auth "kind")))
(defn- admin-role? [role] (contains? #{"owner" "admin"} role))

(defn- membership-for [auth tenant-id]
  (let [wanted (normalize-tenant-id tenant-id)]
    (some #(when (= wanted (get % "tenantId")) %) (get auth "memberships"))))

(defn can-view-tenant? [auth tenant-id]
  (boolean
   (when auth
     (or (legacy-admin? auth)
         (membership-for auth tenant-id)
         (= (get auth "tenantId") (normalize-tenant-id tenant-id))))))

(defn can-manage-tenant-keys? [auth tenant-id]
  (boolean
   (when auth
     (or (legacy-admin? auth)
         (admin-role? (get (membership-for auth tenant-id) "role"))))))

(defn can-manage-federation? [auth]
  (boolean
   (when auth
     (or (legacy-admin? auth)
         (and (= "ui_session" (get auth "kind")) (admin-role? (get auth "role")))))))

(defn visible-tenants
  "The tenants `auth` may see: everything for the legacy admin, otherwise its
  memberships (name falls back to the id, status to \"active\")."
  [auth fallback-tenants]
  (if (legacy-admin? auth)
    (vec fallback-tenants)
    (mapv (fn [m] {"id" (get m "tenantId")
                   "name" (or (get m "tenantName") (get m "tenantId"))
                   "status" (or (get m "tenantStatus") "active")})
          (get auth "memberships"))))
