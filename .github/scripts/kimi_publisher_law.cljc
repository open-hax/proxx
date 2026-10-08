;; SPDX-License-Identifier: GPL-3.0-or-later
(ns kimi-publisher-law
  "Owned Kimi authority and exact two-run source/input admission.
   This does not grant canonical reviewer enrollment, quorum or disposition credit."
  (:require [clojure.string :as str]))

(def repository "open-hax/proxx")
(def repository-id 1178288746)
(def producer-path ".github/workflows/opencode-code-review.yml")
(def publisher-path ".github/workflows/opencode-kimi-publish.yml")
(def runtime-sha "2810f4515424a146fe37390fb0baf532cca31236")
(def runtime-digest "0fa9d7838df3f0718d971beb972a48d2bf73fce6d90f09411a656e57ce3960d7")
(def auth-digest "fd4d5630c462f0f202ac20e39ec1433fba4dfa13e12a6f6ffd5c0ec035d2a7e1")
(def archive-digest "0f22479647226d1d2dd99595d20082ee7bda3870b62dc6a90b41efc1a71d7e9a")
(def model {:providerID "kimi-code-plan-global" :modelID "kimi-for-coding"})
(def control {:requested {:variant "low"}
              :advertisedNativeControl {:apiNpm "@ai-sdk/openai-compatible" :reasoningEffort "low"}
              :opencodeVersion "1.18.34" :observedAssistantVariant "low" :executedIdentity model
              :underlyingProviderModel nil
              :binding "Pinned OpenCode catalog low mapping and assistant variant; not a provider reasoning-budget attestation"})
(defn require! [ok] (when-not ok (throw (ex-info "Trusted Kimi publication binding refused" {}))))
(defn positive? [n] (and (integer? n) (< 0 n 9007199254740992)))
(defn sha? [n x] (and (string? x) (boolean (re-matches (re-pattern (str "[0-9a-f]{" n "}")) x))))
(defn repo? [r] (and (= repository (:full_name r)) (= repository-id (:id r))
                         (= "open-hax" (get-in r [:owner :login]))))
(def credential-source-paths
  [publisher-path ".github/scripts/kimi-publisher.cjs"
   ".github/scripts/kimi_publisher_law.cljc" ".github/scripts/kimi_publisher_bridge.cljs"
   ".github/scripts/proxx-kimi-app-auth.cjs" ".github/scripts/opencode-app-auth.cjs"
   ".github/scripts/kimi-review.cjs" ".github/scripts/kimi-publication-authority.cjs"
   ".github/scripts/kimi-publication-config.cjs" ".github/assessment-tools/package.json"
   ".github/assessment-tools/package-lock.json"])
(defn authority! [{:keys [authority publicationRuntime]}]
  (let [{:keys [state appID installationID principal repositoryID]} authority]
    (require! (and (= #{:state :appID :installationID :principal :repositoryID} (set (keys authority)))
                   (= "configured" state) (positive? appID) (positive? installationID)
                   (not= 94995373 installationID) (= repository-id repositoryID)
                   (= #{:login :id :type} (set (keys principal)))
                   (= "Bot" (:type principal)) (positive? (:id principal))
                   (not (contains? #{41898282 219766164 270021952} (:id principal)))
                   (string? (:login principal)) (boolean (re-matches #"[a-z0-9][a-z0-9-]*\[bot\]" (:login principal)))
                   (not (contains? #{"github-actions[bot]" "opencode-agent[bot]" "eta-mu-ai[bot]"} (:login principal)))
                   (= #{:sha :reviewSHA256 :authSHA256 :authoritySHA256} (set (keys publicationRuntime)))
                   (sha? 40 (:sha publicationRuntime)) (not= runtime-sha (:sha publicationRuntime))
                   (every? #(sha? 64 (get publicationRuntime %)) [:reviewSHA256 :authSHA256 :authoritySHA256])))
    authority))
(defn token! [{:keys [value now expires-seconds]}]
  (require! (and (= {:metadata "read" :pull_requests "write"} (:permissions value))
                 (= "selected" (:repository_selection value))
                 (= 1 (count (:repositories value))) (repo? (first (:repositories value)))
                 (number? now) (number? expires-seconds) (< now expires-seconds (+ now 3660))))
  true)
(defn trigger! [{:keys [event-name action event-repository event-run run-id run-attempt
                       source-sha workflow-sha workflow-ref authorization]}]
  (require! (and (= "workflow_run" event-name) (= "completed" action)
                 (repo? event-repository) (positive? (:id event-run))
                 (positive? (:run_attempt event-run)) (positive? run-id) (positive? run-attempt)
                 (not= run-id (:id event-run)) (sha? 40 source-sha) (= source-sha workflow-sha)
                 (string? workflow-ref) (= "owned-kimi-v1-qualified" authorization)))
  {:producer-id (:id event-run) :consumer-id run-id})
(defn successful-job? [job run attempt name steps]
  (and (positive? (:id job)) (= (:id run) (:run_id job)) (= attempt (:run_attempt job))
       (= (:head_sha run) (:head_sha job)) (= name (:name job))
       (= "completed" (:status job)) (= "success" (:conclusion job))
       (every? (fn [n] (= 1 (count (filter #(and (= n (:name %)) (= "completed" (:status %))
                                                (= "success" (:conclusion %))) (:steps job))))) steps)))
(defn native!
  [{:keys [input repo default-ref producer producer-workflow consumer consumer-workflow
           pr jobs artifacts sources]}]
  (trigger! input)
  (let [association (first (:pull_requests producer))
        head (:head_sha producer) base (get-in association [:base :sha]) number (:number association)
        attempt (:run_attempt producer)
        job (first (filter #(= "Produce exact-head Kimi review" (:name %)) jobs))
        expected-name (str "kimi-native-" (:id producer) "-" number "-" head "-" attempt)
        matching (filter #(= expected-name (:name %)) artifacts) artifact (first matching)
        producer-source (:producer-commit sources)]
    (require!
     (and (repo? repo) (= "main" (:default_branch repo))
          (= (:source-sha input) (get-in default-ref [:object :sha]))
          (= (str repository "/" publisher-path "@refs/heads/" (:default_branch repo)) (:workflow-ref input))
          (= (:id producer) (get-in input [:event-run :id]))
          (= attempt (get-in input [:event-run :run_attempt])) (positive? attempt)
          (= (select-keys producer [:workflow_id :event :head_sha :status :conclusion])
             (select-keys (:event-run input) [:workflow_id :event :head_sha :status :conclusion]))
          (= "completed" (:status producer)) (= "success" (:conclusion producer))
          (= "pull_request" (:event producer)) (= 285819940 (:workflow_id producer) (:id producer-workflow))
          (= producer-path (:path producer) (:path producer-workflow))
          (= "OpenCode Kimi PR Review" (:name producer-workflow)) (= "active" (:state producer-workflow))
          (repo? (:repository producer)) (repo? (:head_repository producer))
          (sha? 40 head) (sha? 40 base) (= 1 (count (:pull_requests producer))) (positive? number)
          (= head (get-in association [:head :sha]))
          (= number (:number pr)) (= "open" (:state pr)) (false? (:draft pr))
          (= head (get-in pr [:head :sha])) (= base (get-in pr [:base :sha]))
          (repo? (get-in pr [:head :repo])) (repo? (get-in pr [:base :repo]))
          (= (:id consumer) (:run-id input)) (= (:run_attempt consumer) (:run-attempt input))
          (= "workflow_run" (:event consumer)) (= publisher-path (:path consumer) (:path consumer-workflow))
          (= "in_progress" (:status consumer))
          (positive? (:id consumer-workflow)) (= (:id consumer-workflow) (:workflow_id consumer))
          (= "Trusted OpenCode Kimi PR Publication" (:name consumer-workflow))
          (= "active" (:state consumer-workflow)) (repo? (:repository consumer)) (repo? (:head_repository consumer))
          (= (:source-sha input) (:head_sha consumer) (:publisher-commit sources))
          (= (:merge_commit_sha pr) (:sha producer-source))
          (= 1 (count (filter #(= "Review runner regression tests" (:name %)) jobs)))
          (successful-job? (first (filter #(= "Review runner regression tests" (:name %)) jobs))
                           producer attempt "Review runner regression tests" [])
          (= 1 (count (filter #(= "Produce exact-head Kimi review" (:name %)) jobs)))
          (successful-job? job producer attempt "Produce exact-head Kimi review"
                           ["Run exact-head Kimi review without publication credentials"
                            "Record native execution provenance" "Preserve native submission and its execution provenance"])
          (= 1 (count matching)) (positive? (:id artifact)) (false? (:expired artifact))
          (positive? (:size_in_bytes artifact)) (<= (:size_in_bytes artifact) (* 2 1024 1024))
          (= (:id producer) (get-in artifact [:workflow_run :id]))
          (= head (get-in artifact [:workflow_run :head_sha]))
          (sha? 64 (:archive-sha256 sources))
          (= (str "sha256:" (:archive-sha256 sources)) (:digest artifact))
          (sha? 40 (:sha producer-source))
          (= [base head] (mapv :sha (:parents producer-source)))
          (sha? 64 (:trusted-producer-digest sources))
          (= (:trusted-producer-digest sources) (:producer-head-digest sources) (:producer-merge-digest sources))
          (= (:trusted-publisher-digest sources) (:publisher-native-digest sources))
          (sha? 64 (:trusted-publisher-digest sources))
          (= credential-source-paths (mapv :path (:credential-source-manifest sources)))
          (every? #(and (sha? 64 (:trusted %)) (= (:trusted %) (:native %))) (:credential-source-manifest sources))
          (true? (:publication-runtime-ancestor sources))))
    {:head head :base base :pr-number number :producer-id (:id producer) :producer-attempt attempt
     :producer-workflow-sha (:sha producer-source) :producer-job-id (:id job)
     :artifact-id (:id artifact) :artifact-name expected-name :artifact-digest (:digest artifact)
     :consumer-id (:id consumer) :consumer-attempt (:run_attempt consumer)
     :consumer-workflow-sha (:source-sha input) :consumer-workflow-ref (:workflow-ref input)
     :producer-source-digest (:trusted-producer-digest sources)
     :publisher-source-digest (:trusted-publisher-digest sources)
     :credential-source-manifest (:credential-source-manifest sources)}))
(defn safe-path? [x]
  (and (string? x) (not (str/blank? x)) (not (str/starts-with? x "/"))
       (not (some #{".."} (str/split x #"/")))))
(defn artifact! [{:keys [binding review provenance runtime auth review-digest coverage ancestor? request]}]
  (require!
   (and (= #{:head :diffSha256 :coveredFiles :summary :comments :executionControl} (set (keys review)))
        (= #{:origin :repository :prNumber :artifactName :head :base :runtimeSha :runtimeBlobSha256
             :runtimeBaseAncestorVerified :authBlobSha256 :reviewBlobSha256 :executionControl
             :requestedModel :executedModel :executedModelBinding :runID :runAttempt :runURL
             :workflowSha :workflowRef :opencodeVersion :archiveSha256 :diffSha256 :coveredFiles}
           (set (keys provenance)))
        (= (:head binding) (:head review) (:head provenance)) (= (:base binding) (:base provenance))
        (= repository (:repository provenance)) (= "github-actions-native-execution" (:origin provenance))
        (= (:pr-number binding) (:prNumber provenance))
        (= (str (:producer-id binding)) (:runID provenance))
        (= (:producer-attempt binding) (:runAttempt provenance))
        (= (:artifact-name binding) (:artifactName provenance))
        (= (str "https://github.com/" repository "/actions/runs/" (:producer-id binding)) (:runURL provenance))
        (= (:producer-workflow-sha binding) (:workflowSha provenance))
        (= (str repository "/" producer-path "@refs/pull/" (:pr-number binding) "/merge") (:workflowRef provenance))
        (= runtime-sha (:runtimeSha provenance)) (true? ancestor?) (true? (:runtimeBaseAncestorVerified provenance))
        (= runtime-digest runtime (:runtimeBlobSha256 provenance)) (= auth-digest auth (:authBlobSha256 provenance))
        (= review-digest (:reviewBlobSha256 provenance)) (sha? 64 review-digest)
        (= "1.18.34" (:opencodeVersion provenance)) (= archive-digest (:archiveSha256 provenance))
        (= model (:requestedModel provenance) (:executedModel provenance))
        (= "low" (:variant request)) (= model (:model request))
        (= "Successful immutable parseStructured requires assistant providerID/modelID to equal requested Kimi identities"
           (:executedModelBinding provenance))
        (= control (:executionControl provenance) (:executionControl review))
        (sha? 64 (:diffSha256 review))
        (= (:diffSha256 coverage) (:diffSha256 review) (:diffSha256 provenance))
        (vector? (:coveredFiles review)) (seq (:coveredFiles review))
        (= (:coveredFiles coverage) (:coveredFiles review) (:coveredFiles provenance))
        (= (count (:coveredFiles review)) (count (set (:coveredFiles review))))
        (every? safe-path? (:coveredFiles review)) (string? (:summary review)) (not (str/blank? (:summary review)))
        (vector? (:comments review)) (<= (count (:comments review)) 100)
        (every? #(and (= #{:path :line :body} (set (keys %))) (positive? (:line %))
                      (some #{(:path %)} (:coveredFiles review)) (string? (:body %)) (not (str/blank? (:body %))))
                (:comments review))))
  binding)
(def body-fields [:origin :repository :head :base :runtimeSha :runtimeBlobSha256 :authBlobSha256 :reviewBlobSha256
                  :runtimeBaseAncestorVerified :requestedModel :executedModel :runID :runAttempt :artifactName :prNumber
                  :workflowSha :opencodeVersion :archiveSha256 :diffSha256 :executionControl])
(defn body-provenance [binding p]
  (assoc (select-keys p body-fields) :coveredFileCount (count (:coveredFiles p))
         :publication {:origin "github-actions-native-publication" :runID (str (:consumer-id binding))
                       :runAttempt (:consumer-attempt binding) :workflowSha (:consumer-workflow-sha binding)
                       :workflowRef (:consumer-workflow-ref binding)
                       :producerRunID (str (:producer-id binding)) :producerRunAttempt (:producer-attempt binding)
                       :producerJobID (:producer-job-id binding) :artifactID (:artifact-id binding)
                       :artifactDigest (:artifact-digest binding) :callerSha256 (:publisher-source-digest binding)}))
