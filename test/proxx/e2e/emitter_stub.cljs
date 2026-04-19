(ns proxx.ledger.emitter)
;; ── STUB — intentionally unimplemented ───────────────────────────────────────
;; This namespace exists only to allow the test suite to compile and run.
;; Every call to route! will throw, keeping all e2e tests RED until the
;; real implementation is written.
;;
;; Implementation checklist (see docs/ledger-event-spec.md):
;;   [ ] Stamp event-id (uuid) + ts on every emitted event
;;   [ ] Validate each event against LedgerEvent schema before appending
;;   [ ] Detect 429 / Retry-After  → emit :account-cooldown-initiated
;;   [ ] Detect 200 + quota body   → emit :empty-provider-response
;;   [ ] Detect empty body         → emit :empty-provider-response
;;   [ ] Detect unrecognized JSON  → emit :unrecognized-response-schema
;;   [ ] Detect finish_reason=length → emit :context-overflow-detected
;;   [ ] Detect message-count drop  → emit :session-churn-detected
;;   [ ] Fallover across providers  → emit :session-account-changed
;;   [ ] First request per cache-key → emit :session-start
;;   [ ] derive-epoch-id via real hash (goog.crypt.Sha256)
;;   [ ] cache-recoverable? wired to epoch-unchanged?

(defn route!
  "NOT IMPLEMENTED. Returns a rejected Promise so all e2e tests fail fast."
  [_ctx _request]
  (js/Promise.reject
   (js/Error. "proxx.ledger.emitter/route! is not implemented yet")))
