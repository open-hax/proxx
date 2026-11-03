(ns proxx.http.route-path
  "Joining a route prefix and a route suffix (src/routes/types.ts joinRoutePath).")

(defn join
  "`prefix` without one trailing slash, then `suffix` with exactly one leading slash."
  [prefix suffix]
  (let [prefix (if (and (seq prefix) (= \/ (last prefix))) (subs prefix 0 (dec (count prefix))) prefix)
        suffix (if (and (seq suffix) (= \/ (first suffix))) suffix (str "/" suffix))]
    (str prefix suffix)))
