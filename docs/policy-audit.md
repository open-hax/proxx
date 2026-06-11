# Proxx Policy CLJS Audit

## 1. Interop Scan
The following JS interop mentions were found:
- `proxx.policy`: Uses `(.now js/Date)` for timestamping.
- `proxx.policy.loader`: Uses `js/require "fs"` and `(.readFileSync fs path "utf8")` for file I/O.

## 2. 'Sillyshit' Factor Analysis
The "sillyshit" factor is high, primarily due to a recurring pattern of "confident but incorrect" error handling.

### Critical Failure: The `:default` Catch
Across `proxx.policy`, `proxx.policy.eval`, and `proxx.policy.loader`, the following pattern is used:
```clojure
(catch :default e
  ...)
```
**Analysis:** In ClojureScript, catching via a keyword like `:default` does not function as a catch-all for JavaScript exceptions. This is a failure of fundamental interop understanding. It likely results in exceptions bypassing these blocks entirely.
**Risk:** High. Errors in policy evaluation or loading will propagate uncaught.

### Performance Sillyshit: Inline Requires
In `proxx.policy.loader`, `js/require "fs"` is called inside the `read-file` function.
**Analysis:** Every single file read triggers a fresh requirement of the `fs` module. While Node.js caches modules, calling `require` in a hot path is suboptimal and messy.

### Logic Sillyshit: Atom Assumption
In `proxx.policy.router`, the code uses `@trace`.
**Analysis:** `trace` is passed as an argument. If the caller passes a plain map instead of an atom, the router will crash.

## 3. Recommended Fixes

### Fix 1: Exception Handling
Replace `(catch :default e ...)` with:
```clojure
(catch js/Error e ...)
;; or
(catch Throwable e ...)
```

### Fix 2: Module Loading
Move the `fs` requirement to the top level:
```clojure
(def fs (js/require "fs"))
```

### Fix 3: Trace Robustness
Either ensure `trace` is always an atom or use a helper to dereference safely:
```clojure
(defn- deref-trace [t]
  (if (atom? t) @t t))
```
