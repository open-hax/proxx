(ns proxx.http.hosts
  "Decisions for the host-dashboard routes (/api/v1/hosts/*): who may see the
  dashboard, the request's own base URL, the remote timeout and the overview
  envelope. Facts (headers, env, snapshots) arrive as data; nothing here reads
  the environment or the clock."
  (:require [proxx.http.guard :as guard]
            [proxx.http.params :as params]
            [proxx.http.ui-auth :as ui-auth]))

(def ^:private default-timeout-ms 5000)
(def ^:private max-timeout-ms 60000)

(defn timeout-ms
  "HOST_DASHBOARD_REQUEST_TIMEOUT_MS: unset/blank/non-numeric -> 5000, otherwise
  clamped to [5000, 60000]."
  [raw]
  (if (seq raw)
    (let [n (params/parse-int raw)]
      (if (params/nan? n)
        default-timeout-ms
        (max default-timeout-ms (min n max-timeout-ms))))
    default-timeout-ms))

(defn base-url
  "scheme://host for the request: Host (else X-Forwarded-Host), with
  X-Forwarded-Proto when it is a string, else the connection's `protocol`.
  nil when there is no usable host. Both host and proto keep TS semantics: a
  string Host that is empty does not fall back to X-Forwarded-Host."
  [headers protocol]
  (let [fwd-host (get headers "x-forwarded-host")
        host (get headers "host")
        host (cond (string? host) host (string? fwd-host) fwd-host)]
    (when (seq host)
      (let [fwd-proto (get headers "x-forwarded-proto")
            proto (if (string? fwd-proto) fwd-proto protocol)]
        (str proto "://" host)))))

(defn authorize
  "nil when the dashboard may be shown to `auth`, else the 401/403 response."
  [auth]
  (cond (nil? auth) (guard/error 401 "unauthorized")
        (not (ui-auth/can-manage-federation? auth)) (guard/error 403 "forbidden")))

(defn select-self
  "The target named by `self-id`, else the first target, else nil."
  [targets self-id]
  (or (some #(when (= self-id (:id %)) %) targets) (first targets)))

(defn no-targets [] (guard/error 500 "host_dashboard_targets_not_configured"))

(defn overview
  "The /hosts/overview envelope."
  [generated-at self-id hosts]
  {"generatedAt" generated-at "selfTargetId" self-id "hosts" hosts})
