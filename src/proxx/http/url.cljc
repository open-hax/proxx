(ns proxx.http.url
  "URL joining (src/lib/http/url-utils.ts)."
  (:require [clojure.string :as str]))

(defn join-url
  "`base-url` without trailing slashes, then `path` with one leading slash. A
  path starting at /v1 loses that segment when the base already ends in /v1."
  [base-url path]
  (let [base (str/replace base-url #"/+$" "")
        path (if (str/starts-with? path "/") path (str "/" path))
        lower-path (str/lower-case path)]
    (str base
         (if (and (or (= lower-path "/v1") (str/starts-with? lower-path "/v1/"))
                  (str/ends-with? (str/lower-case base) "/v1"))
           (subs path 3)
           path))))
