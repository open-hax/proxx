;; SPDX-License-Identifier: GPL-3.0-or-later
(ns watch-model-catalogs
  (:require [proxx.policy.catalog-watch :as watch]
            [promesa.core :as p]))

(defn- parse-options [args]
  (loop [args args opts {}]
                (if-let [arg (first args)]
                  (case arg
                    "--allow-loopback" (recur (next args) (assoc opts :allow-loopback? true))
                    "--observations" (if (second args)
                                       (recur (nnext args) (assoc opts :observations-file (second args)))
                                       (throw (ex-info "Missing observation file" {})))
                    "--now-ms" (if (second args)
                                 (recur (nnext args) (assoc opts :now-ms (js/Number (second args))))
                                 (throw (ex-info "Missing observation clock" {})))
                    (throw (ex-info "Unsupported watcher argument" {})))
                  opts)))

(let [[config-file & args] *command-line-args*]
  (if-not config-file
    (do (println "Usage: nbb -cp src scripts/watch_model_catalogs.cljs PUBLIC-CONFIG.edn [--observations FILE] [--now-ms MS]")
        (.exit js/process 2))
    (-> (p/let [_ (p/resolved nil)
                options (parse-options args)
                result (watch/poll-once! (watch/read-edn config-file) options)] (println (pr-str result)))
        (p/catch (fn [_error]
                   ;; Errors may include URLs or reflected credentials. Never print them.
                   (println "Catalog watcher failed; no exception detail emitted.")
                   (.exit js/process 2))))))
