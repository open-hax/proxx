(ns proxx.http.guard
  "Guards: pure checks that either pass (nil) or yield the response to send.

  Compose them with `or` / `cond`, never by building a vector of results:
  guards must run in order and stop at the first failure, because a later
  guard may be invalid (or throw) exactly when an earlier one already failed.

    (or (guard/require-auth req)
        (guard/require-present (:store deps) 501 \"tenant_store_not_supported\")
        (handle req))"
  (:require [proxx.http.ui-auth :as ui-auth]))

(defn error
  "The {\"error\": code} response the UI routes use."
  [status code]
  {:status status :body {"error" code}})

(defn require-auth
  "401 unless the request carries a resolved identity."
  [{:keys [auth]}]
  (when-not auth (error 401 "unauthorized")))

(defn require-present
  "`status`/`code` unless `x` is present (a collaborator the host may not have)."
  [x status code]
  (when-not x (error status code)))

(defn forbid-unless
  "403 \"forbidden\" unless `allowed?`."
  [allowed?]
  (when-not allowed? (error 403 "forbidden")))

(defn require-tenant-key-manager [{:keys [auth]} tenant-id]
  (forbid-unless (ui-auth/can-manage-tenant-keys? auth tenant-id)))
