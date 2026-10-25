(ns proxx.routing.outcome
  "What to tell the client when every provider attempt failed (the decision half of
  src/lib/routing-outcome-handler.ts): classify the execution summary, then derive
  the error response, retry hint and log line for that class."
  (:require [clojure.string :as str]))

(defn classify
  "The outcome class of an execution: :keys-missing, :all-disabled, :all-rate-limited
  (no candidate was tried), then by what the attempts saw, in precedence order:
  :invalid-request, :rate-limited, :server-error, :model-not-found,
  :model-not-supported, else :unavailable."
  [{:keys [candidate-count summary]} availability]
  (cond
    (zero? candidate-count)
    (cond (not (:saw-configured-provider availability)) :keys-missing
          (:saw-only-disabled-providers availability) :all-disabled
          :else :all-rate-limited)
    (:saw-upstream-invalid-request summary) :invalid-request
    (:saw-rate-limit summary) :rate-limited
    (:saw-upstream-server-error summary) :server-error
    (and (:saw-model-not-found summary) (not (:saw-request-error summary))) :model-not-found
    (:saw-model-not-supported-for-account summary) :model-not-supported
    :else :unavailable))

(defn needs-retry-hint?
  "Does the response carry a retry-after hint derived from the providers' key cooldowns?"
  [outcome]
  (contains? #{:keys-missing :all-disabled :all-rate-limited :rate-limited} outcome))

(defn- js-text [x] (if (nil? x) "undefined" (str x)))

(defn- upstream-detail [{:keys [provider-id status body] :as last-error}]
  (if last-error
    (str " Last upstream error (" (if (nil? provider-id) "unknown" provider-id) ", HTTP " (js-text status) "): " (js-text body))
    ""))

(defn response
  "{:status :message :type :code :retry-after-seconds? :log?} for an outcome class.
  `retry-in-ms` is the soonest key-ready delay (0 = unknown). `log` is {:level :message}."
  [outcome {:keys [routed-model last-upstream-error log-prefix saw-request-error]} retry-in-ms]
  (let [prefix (if (seq log-prefix) (str log-prefix ": ") "")
        retry (when (and (needs-retry-hint? outcome) (pos? retry-in-ms))
                (Math/ceil (/ retry-in-ms 1000)))
        error (fn [status message type code] {:status status :message message :type type :code code})
        logged (fn [resp level message] (assoc resp :log {:level level :message (str prefix message)}))]
    (cond-> (case outcome
              :keys-missing (error 500 "Proxy is missing upstream account configuration" "server_error" "keys_unavailable")
              :all-disabled (error 503 "Proxy has upstream accounts but all are disabled" "server_error" "keys_unavailable")
              :all-rate-limited (error 429 "All upstream accounts are currently rate-limited. Retry after the cooldown window."
                                       "rate_limit_error" "all_keys_rate_limited")
              :invalid-request
              (logged (error 400 (str "No upstream account accepted the request payload. Check model availability and request parameters."
                                      (upstream-detail last-upstream-error))
                             "invalid_request_error" "upstream_rejected_request")
                      :warn "all attempts exhausted due to upstream invalid-request responses")
              :rate-limited
              (logged (error 429 "No upstream account succeeded. Accounts may be rate-limited, quota-exhausted, or have outstanding balances."
                             "rate_limit_error" "no_available_key")
                      :warn "all attempts exhausted due to upstream rate limits")
              :server-error
              (logged (error 502 "Upstream returned transient server errors across all available accounts." "server_error" "upstream_server_error")
                      :warn "all attempts exhausted due to upstream server errors")
              :model-not-found
              (logged (error 404 (str "Model not found across available upstream providers: " routed-model)
                             "invalid_request_error" "model_not_found")
                      :warn "all attempts exhausted due to model-not-found responses")
              :model-not-supported
              (logged (error 403 (str "Available upstream accounts are not allowed to use model: " routed-model)
                             "invalid_request_error" "model_not_supported_for_account")
                      :warn "all attempts exhausted due to model access restrictions")
              :unavailable
              (assoc (logged (error 502 (if saw-request-error
                            "All upstream attempts failed due to network/transport errors."
                            "Upstream rejected the request with no successful routing.")
                          "server_error" "upstream_unavailable")
                             :error "all upstream attempts exhausted")
                     :with-request-error? true))
      retry (assoc :retry-after-seconds retry))))
