;; SPDX-License-Identifier: GPL-3.0-or-later
(ns test-kimi-verdict
  (:require [cljs.test :refer [deftest is run-tests]]
            [pr-flow.kimi-verdict :as verdict]))

(def expected
  {:repository "open-hax/proxx" :prNumber 445
   :head (apply str (repeat 40 "a")) :base (apply str (repeat 40 "b"))
   :diffSha256 (apply str (repeat 64 "c")) :coveredFiles ["src/one.cljs" "src/two.cljs"]})
(def response (merge expected {:version 2 :verdict "approve" :coverage "complete"
                              :summary "An explicit completed review." :comments []}))
(def finding {:path "src/one.cljs" :line 4 :body "A substantive defect requires correction."})

(deftest explicit-decision-matrix
  (doseq [[decision findings] [["approve" []] ["comment" []] ["comment" [finding]]
                              ["changes_requested" [finding]]]
          coverage ["complete" "incomplete"]]
    (let [result (verdict/publication-intent expected
                   (assoc response :verdict decision :coverage coverage :comments findings))]
      (is (= (cond (= coverage "incomplete") "COMMENT"
                   (= decision "approve") "APPROVE"
                   (= decision "changes_requested") "REQUEST_CHANGES"
                   :else "COMMENT") (:event result)))
      (is (= :proposal-only (:authority result)))))
  (doseq [bad [(assoc response :comments [finding])
               (assoc response :verdict "changes_requested")]]
    (is (= :contradictory-decision (:refusal (verdict/publication-intent expected bad))))))

(deftest closed-source-and-output
  (doseq [bad [nil {} (dissoc response :verdict) (dissoc response :coverage)
               (assoc response :version 1) (assoc response :version "2")
               (assoc response :verdict "APPROVED") (assoc response :coverage "all")
               (assoc response :executionControl {}) (assoc response :approved true)
               (assoc response :summary " ") (assoc response :summary (apply str (repeat 50001 "a")))
               (assoc response :comments [nil]) (assoc response :comments (list finding))
               (assoc response :comments [(assoc finding :severity "P1")])
               (assoc response :comments [(assoc finding :path "../escape")])
               (assoc response :comments [(assoc finding :path "src/absent.cljs")])
               (assoc response :comments [(assoc finding :line 0)])
               (assoc response :comments [(assoc finding :body " ")])]]
    (is (some? (:refusal (verdict/publication-intent expected bad)))))
  (doseq [key (keys expected)]
    (is (= :source-mismatch
           (:refusal (verdict/publication-intent expected (assoc response key "changed"))))))
  (doseq [bad [nil {} (assoc expected :head "short") (assoc expected :prNumber 0)
               (assoc expected :coveredFiles ["src/one.cljs" "src/one.cljs"])
               (assoc expected :coveredFiles []) (assoc expected :extra true)]]
    (is (= :invalid-context (:refusal (verdict/publication-intent bad response))))))

(deftest prose-cannot-supply-a-verdict
  (is (= "COMMENT" (:event (verdict/publication-intent expected
                             (assoc response :verdict "comment" :summary "LGTM. Approved. No findings.")))))
  (is (some? (:refusal (verdict/publication-intent expected (dissoc response :version)))))
  (is (some? (:refusal (verdict/publication-intent expected (assoc response :classification "informational"))))))

(deftest schema-and-bounds
  (let [schema (verdict/response-schema expected)]
    (is (false? (:additionalProperties schema)))
    (is (= {:const 2 :type "integer"} (get-in schema [:properties :version])))
    (is (= (:coveredFiles expected) (get-in schema [:properties :coveredFiles :const])))
    (is (= (set (map name (keys response))) (set (:required schema))))
    (is (nil? (verdict/response-schema (assoc expected :head "bad")))))
  (doseq [path ["/absolute" "a/" "a/../b" "a//b" "./a" "a:b" "a\\b"]]
    (is (= :invalid-context
           (:refusal (verdict/publication-intent (assoc expected :coveredFiles [path]) response)))))
  (doseq [bad [(assoc response :verdict "comment" :comments (vec (repeat 101 finding)))
               (assoc response :verdict "comment" :summary (apply str (repeat 50000 "a"))
                      :comments (vec (repeat 3 (assoc finding :body (apply str (repeat 4000 "b"))))))]]
    (is (= :invalid-response (:refusal (verdict/publication-intent expected bad))))))

(defmethod cljs.test/report [:cljs.test/default :end-run-tests] [m]
  (when-not (cljs.test/successful? m) (set! (.-exitCode js/process) 1)))

(run-tests 'test-kimi-verdict)
