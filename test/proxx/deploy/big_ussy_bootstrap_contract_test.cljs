(ns proxx.deploy.big-ussy-bootstrap-contract-test
  "The big-ussy bootstrap script lives outside this repository (the infra checkout); when it
  is not present the contract cannot be checked, exactly as the TypeScript test skipped."
  (:require ["node:fs" :as fs]
            ["node:path" :as path]
            [cljs.test :refer [deftest is]]
            [clojure.string :as str]))

(defn- script-path []
  (let [override (some-> (aget (.-env js/process) "PROXX_BIG_USSY_BOOTSTRAP_SCRIPT") str str/trim)]
    (if (seq override)
      override
      (.resolve path (.cwd js/process) "../../../services/proxx/bin/project-complete-devel-stack-to-big-ussy.sh"))))

(defn- readable? [p]
  (try (.accessSync fs p (.-R_OK (.-constants fs))) true (catch :default _ false)))

(deftest big-ussy-bootstrap-script-keeps-repaired-local-core-relay-contract
  (let [p (script-path)]
    (if-not (readable? p)
      (println (str "SKIP bootstrap script not present at " p))
      (let [script (.readFileSync fs p "utf8")]
        (is (re-find #"REMOTE_RELAY_PORT=\"18790\"" script))
        (is (re-find #"'id': 'local-core'" script))
        (is (re-find #"'baseUrl': f'http://host\.docker\.internal:\$\{REMOTE_RELAY_PORT\}'" script))
        (is (re-find #"'controlBaseUrl': f'http://host\.docker\.internal:\$\{REMOTE_RELAY_PORT\}'" script))
        (is (not (re-find #"PROXX_CANON_SYNC_PEER_ID=local-canonical" script)))
        (is (re-find #"PROXX_CANON_SYNC_PEER_ID=local-core" script))
        (is (re-find #"start_new_session=True" script))
        (is (re-find #"stdin=subprocess\.DEVNULL" script))))))
