(ns proxx.runtime.github-allowlist-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.runtime.github-allowlist :as allowlist]))

(defn- fake-sql [calls rows]
  #js {"unsafe" (fn [text params]
                  (swap! calls conj [text (some-> params vec)])
                  (js/Promise.resolve rows))})

(deftest ^:async logins-are-trimmed-and-lowercased
  (let [calls (atom [])
        ^js list (allowlist/create-github-allowlist-js (fake-sql calls #js [#js {"login" "a"}]))
        results (await (js/Promise.all #js [(.allowsUser list "  OctoCat ") (.addAllowedUser list "Bob ") (.removeAllowedUser list " BOB") (.getAllowedUsers list)]))]
    (is (true? (aget results 0)))
    (is (= ["a"] (vec (aget results 3))))
    (is (= [["SELECT 1 FROM github_allowlist WHERE login = $1" ["octocat"]]
            ["INSERT INTO github_allowlist (login) VALUES ($1) ON CONFLICT (login) DO NOTHING" ["bob"]]
            ["DELETE FROM github_allowlist WHERE login = $1" ["bob"]]
            ["SELECT login FROM github_allowlist ORDER BY login" nil]]
           @calls))))
