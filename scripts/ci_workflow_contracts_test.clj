(ns ci-workflow-contracts-test
  "Check the actual workflow inputs against independently observed service contracts."
  (:require [clj-yaml.core :as yaml]
            [clojure.edn :as edn]
            [clojure.string :as str]
            [clojure.test :as test]))

(def capabilities
  (edn/read-string (slurp "docs/notes/evidence/workflow-capabilities.edn")))

(defn workflow [filename]
  (yaml/parse-string (slurp (str ".github/workflows/" filename))))

(defn model-supported? [model]
  (let [[provider model-id extra] (str/split model #"/")]
    (and (nil? extra)
         (contains? (get-in capabilities [:providers provider :available-models]) model-id))))

(test/deftest opencode-actions-select-an-available-authorized-model
  (doseq [filename ["opencode-code-review.yml" "opencode-issue-agent.yml"]]
    (let [steps (for [[_ job] (:jobs (workflow filename))
                      step (:steps job)
                      :when (str/starts-with? (or (:uses step) "") "anomalyco/opencode/github@")]
                  step)]
      (test/is (seq steps) (str filename " must retain its model-backed actions"))
      (doseq [step steps]
        (test/is (model-supported? (get-in step [:with :model]))
                 (str filename ": " (:name step) " selects " (get-in step [:with :model])))))))

(test/deftest auto-merge-selects-a-repository-permitted-method
  (let [method (get-in (workflow "auto-merge.yml") [:jobs :auto-merge :with :merge-method])
        setting (get {"MERGE" :allow_merge_commit
                      "SQUASH" :allow_squash_merge
                      "REBASE" :allow_rebase_merge} method)]
    (test/is (true? (get-in capabilities [:repository setting]))
             (str "The repository rejects auto-merge method " method))))

(let [{:keys [fail error]} (test/run-tests 'ci-workflow-contracts-test)]
  (System/exit (if (zero? (+ fail error)) 0 1)))
