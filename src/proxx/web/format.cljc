(ns proxx.web.format
  "Display formatting shared by the console pages. Pure except for the two
  locale-dependent date/number helpers, which delegate to the host `Date`/`Number`."
  (:require [clojure.string :as str]))

(def ^:private auth-type-labels
  {"api_key" "API Key" ; pragma: allowlist secret
   "oauth_bearer" "OAuth"
   "local" "Local"
   "none" "None"
   "unknown" "Unknown"})

(defn format-auth-type
  "Friendly label for an auth type. Known values are mapped explicitly; others
  have separators replaced and words title-cased so snake_case never leaks."
  [auth-type]
  (let [normalized (str/lower-case (str/trim (str auth-type)))]
    (if (str/blank? normalized)
      (auth-type-labels "unknown")
      (or (auth-type-labels normalized)
          (->> (str/split normalized #"[_-]+")
               (remove empty?)
               (map str/capitalize)
               (str/join " "))))))

(defn- present [v] (when (and (string? v) (not (str/blank? v))) (str/trim v)))

(defn format-request-origin
  "`{:tenantId :issuer :keyId}` -> \"tenant t · key k · issuer i\" (issuer \"local\"
  is implied), falling back to the bare issuer, then \"unknown\"."
  [{:keys [tenantId issuer keyId]}]
  (let [issuer* (or (present issuer) "")
        parts (cond-> []
                (present tenantId) (conj (str "tenant " (present tenantId)))
                (present keyId) (conj (str "key " (present keyId)))
                (and (seq issuer*) (not= issuer* "local")) (conj (str "issuer " issuer*)))]
    (cond
      (seq parts) (str/join " · " parts)
      (seq issuer*) issuer*
      :else "unknown")))

(defn finite-number? [v]
  (and (number? v) #?(:cljs (js/isFinite v) :clj (not (or (Double/isNaN (double v)) (Double/isInfinite (double v)))))))

(defn fixed
  "`n.toFixed(digits)`."
  [n digits]
  #?(:cljs (.toFixed (js/Number n) digits)
     :clj (format (str "%." digits "f") (double n))))

(defn format-maybe [v] (if (present v) v "-"))
(defn format-maybe-number [v] (if (finite-number? v) (str v) "-"))

(defn format-bytes [bytes]
  (cond
    (or (not (finite-number? bytes)) (<= bytes 0)) "-"
    (>= bytes (* 1024 1024)) (str (fixed (/ bytes (* 1024 1024)) 1) " MB")
    (>= bytes 1024) (str (fixed (/ bytes 1024) 1) " kB")
    :else (str bytes " B")))

(defn format-datetime
  "Locale date-time of an ISO string / epoch ms; the input string when unparsable."
  [ts]
  #?(:cljs (let [d (js/Date. ts)]
             (if (js/isNaN (.getTime d)) (str ts) (.toLocaleString d)))
     :clj (str ts)))

(defn compact-json
  "Pretty JSON of `value`, truncated to `limit` chars plus a trailing ellipsis line."
  ([value] (compact-json value 400))
  ([value limit]
   (let [text #?(:cljs (or (js/JSON.stringify (clj->js value) nil 2) "undefined") :clj (pr-str value))]
     (if (<= (count text) limit) text (str (subs text 0 limit) "\n…")))))

;; ---------------------------------------------------------------------------
;; Numbers (en-US, as the console has always shown them)

(defn- intl [opts v]
  #?(:cljs (.format (js/Intl.NumberFormat. "en-US" (clj->js opts)) v)
     :clj (str v)))

(defn compact-number [v]
  (intl {:notation (if (>= v 1000) "compact" "standard")
         :maximumFractionDigits (if (>= v 1000) 1 0)}
        v))

(defn usd [v]
  (let [digits (if (>= v 1) 2 4)]
    (intl {:style "currency" :currency "USD" :minimumFractionDigits digits :maximumFractionDigits digits} v)))

(defn percent [v] (str (fixed v (if (>= v 10) 0 1)) "%"))

(defn water [ml]
  (cond
    (>= ml 1000) (str (fixed (/ ml 1000) 2) " L")
    (>= ml 1) (str (fixed ml 1) " mL")
    (>= ml 0.001) (str (fixed (* ml 1000) 1) " uL")
    :else (str (fixed ml 4) " mL")))

(defn round-half-up [v] #?(:cljs (js/Math.round v) :clj (long (Math/round (double v)))))

(defn maybe-ms [v] (if (finite-number? v) (str (round-half-up v) " ms") "-"))
(defn maybe-tps [v] (if (finite-number? v) (str (fixed v (if (>= v 10) 0 1)) " t/s") "-"))
(defn maybe-fraction-percent [v] (if (finite-number? v) (str (round-half-up (* v 100)) "%") "-"))
(defn format-date-or-dash [v] (if v (format-datetime v) "-"))

(defn format-time
  "Locale time of day of an epoch-ms / ISO value."
  [ts]
  #?(:cljs (let [d (js/Date. ts)] (if (js/isNaN (.getTime d)) (str ts) (.toLocaleTimeString d)))
     :clj (str ts)))
