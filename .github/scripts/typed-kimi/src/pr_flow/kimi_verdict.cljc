;; SPDX-License-Identifier: LGPL-3.0-or-later
(ns pr-flow.kimi-verdict
  "Candidate v2 model-decision protocol. No native publication or admission."
  (:require [clojure.string :as str]))

(def context-fields [:repository :prNumber :base :head :diffSha256 :coveredFiles])
(def decision-fields [:version :verdict :coverage :summary :comments])
(def verdicts ["approve" "changes_requested" "comment"])
(def coverage-outcomes ["complete" "incomplete"])

(def schema-registry
  "Named JSON boundary shapes; immutable constants are supplied by response-schema."
  {::finding {:type "object" :additionalProperties false :required ["path" "line" "body"]
              :properties {:path {:type "string" :minLength 1 :maxLength 1024}
                           :line {:type "integer" :minimum 1 :maximum 9007199254740991}
                           :body {:type "string" :minLength 1 :maxLength 4000}}}
   ::decision {:version {:type "integer" :const 2}
               :verdict {:type "string" :enum verdicts}
               :coverage {:type "string" :enum coverage-outcomes}
               :summary {:type "string" :minLength 1 :maxLength 50000}
               :comments {:type "array" :maxItems 100 :items {:$ref "#/$defs/finding"}}}})

(defn- exact-keys? [value fields]
  (and (map? value) (= (set fields) (set (keys value)))))
(defn- text? [value limit]
  (and (string? value) (not (str/blank? value)) (<= (count value) limit)))
(defn- sha? [value size]
  (and (string? value) (boolean (re-matches (re-pattern (str "[0-9a-f]{" size "}")) value))))
(defn- positive-safe? [value]
  (and (integer? value) (pos? value) (<= value 9007199254740991)))
(defn- source-path? [value]
  (and (text? value 1024) (not (str/starts-with? value "/")) (not (str/ends-with? value "/"))
       (not (str/includes? value "\\")) (not (re-find #"[\x00-\x1f\x7f:]" value))
       (every? #(not (contains? #{"" "." ".."} %)) (str/split value #"/"))))
(defn- context? [value]
  (and (exact-keys? value context-fields)
       (string? (:repository value)) (re-matches #"[^/\s]+/[^/\s]+" (:repository value))
       (positive-safe? (:prNumber value)) (sha? (:base value) 40) (sha? (:head value) 40)
       (sha? (:diffSha256 value) 64) (vector? (:coveredFiles value))
       (seq (:coveredFiles value)) (= (count (:coveredFiles value)) (count (set (:coveredFiles value))))
       (every? source-path? (:coveredFiles value))))

(defn response-schema
  "Return a closed v2 model response schema for valid trusted source coordinates.
   A schema constrains syntax; accepted assistant identity/invocation is separate."
  [expected]
  (when (context? expected)
    {:type "object" :additionalProperties false
     :required (mapv name (concat context-fields decision-fields))
     :$defs {:finding (::finding schema-registry)}
     :properties (merge (::decision schema-registry)
                        (into {} (map (fn [field] [field {:const (get expected field)}]) context-fields)))}))

(defn- finding? [paths finding]
  (and (exact-keys? finding [:path :line :body]) (contains? paths (:path finding))
       (positive-safe? (:line finding)) (text? (:body finding) 4000)))
(defn- decision? [value expected]
  (and (exact-keys? value (concat context-fields decision-fields)) (= 2 (:version value))
       (contains? (set verdicts) (:verdict value))
       (contains? (set coverage-outcomes) (:coverage value))
       (text? (:summary value) 50000) (vector? (:comments value)) (<= (count (:comments value)) 100)
       (every? #(finding? (set (:coveredFiles expected)) %) (:comments value))
       (<= (+ (count (:summary value))
              (reduce + 0 (map #(+ (count (:path %)) (count (:body %))) (:comments value)))) 55000)))

(defn publication-intent
  "Validate the completed model decision against trusted immutable coordinates.
   The proposed event supplies no native identity, invocation or approval custody.
   The protected publisher must independently verify those before any mutation."
  [expected response]
  (cond
    (not (context? expected)) {:refusal :invalid-context}
    (and (map? response) (not= expected (select-keys response context-fields))) {:refusal :source-mismatch}
    (not (decision? response expected)) {:refusal :invalid-response}
    (or (and (= "approve" (:verdict response)) (seq (:comments response)))
        (and (= "changes_requested" (:verdict response)) (empty? (:comments response))))
    {:refusal :contradictory-decision}
    :else
    {:authority :proposal-only
     :event (cond (= "incomplete" (:coverage response)) "COMMENT"
                  (= "approve" (:verdict response)) "APPROVE"
                  (= "changes_requested" (:verdict response)) "REQUEST_CHANGES"
                  :else "COMMENT")}))
