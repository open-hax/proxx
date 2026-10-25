(ns proxx.routing.bridge-test
  (:require [cljs.test :refer [deftest is]]
            [proxx.policy.contracts :as contracts]
            [proxx.policy.loader :as loader]
            [proxx.routing.bridge :as b]
            [proxx.routing.surface :as s]
            [proxx.runtime.routing :as edge]))

(def manifest "resources/policies/runtime/00-manifest.edn")
(def f (-> (loader/load-policy-contracts! manifest) contracts/compile-contracts s/facts))

(deftest advertised-routes-win
  (is (b/supports-path? f {:paths ["/v2"] :supports-responses true} "/v2/x"))
  (is (not (b/supports-path? f {:paths ["/v2"] :supports-responses true} "/v1/responses"))
      "advertised routes replace the structured hints")
  (is (b/supports-path? f {:routes ["  /r  " "" 5 nil]} "/r/1") "entries are trimmed, junk dropped")
  (is (not (b/supports-path? f {:paths ["" " "]} "/v1/chat/completions"))
      "blank advertised routes advertise nothing, so the structured hint (absent) decides")
  (is (b/supports-path? f {:paths ["" " "]} "/v1/embeddings") "...and with no hints the legacy set applies"))

(deftest structured-hints
  (is (b/supports-path? f {:supports-models-list true} "/v1/models"))
  (is (not (b/supports-path? f {:supports-models-list false} "/v1/models")))
  (is (not (b/supports-path? f {:supports-models-list nil} "/v1/models")) "only an explicit true counts")
  (is (not (b/supports-path? f {} "/v1/models/x")) "no hint for /v1/models: not served, even in the legacy set")
  (is (b/supports-path? f {:supports-responses true} "/v1/responses/abc"))
  (is (not (b/supports-path? f {:supports-chat-completions true} "/v1/embeddings"))
      "any structured hint disables the legacy set for other paths"))

(deftest legacy-paths-only-without-hints
  (is (b/supports-path? f {} "/v1/embeddings"))
  (is (b/supports-path? f {} "/v1/images/generations"))
  (is (not (b/supports-path? f {} "/v2/embeddings")))
  (is (not (b/supports-path? f {:supports-models-list nil} "/v1/embeddings"))
      "an explicit null is still a hint (null !== undefined)"))

(deftest model-support
  (is (b/supports-model? {} nil))
  (is (b/supports-model? {} "   "))
  (is (b/supports-model? {:models [" gpt-5 "]} "gpt-5"))
  (is (b/supports-model? {:model-prefixes ["claude-"]} "claude-3"))
  (is (not (b/supports-model? {:models ["gpt-5"]} "gpt-4")))
  (is (not (b/supports-model? {} "gpt-5")) "an unadvertising capability serves no named model")
  (is (not (b/supports-model? {:model-prefixes [""]} "gpt-5"))
      "a blank prefix is dropped, not a wildcard"))

(deftest intentional-divergence-non-array-advertisements
  ;; TS spreads a string into characters (so {paths: "/v2"} advertised "/", "v", "2")
  ;; and throws TypeError on a non-array models list. Both are accidents of
  ;; JavaScript; a non-sequence advertises nothing.
  (is (not (b/supports-path? f {:paths "/v2"} "/v2")))
  (is (not (b/supports-model? {:models "gpt-5"} "gpt-5")))
  (is (not (b/supports-model? {:model-prefixes "gp"} "gpt-5"))))

(deftest edge-treats-undefined-as-absent-and-null-as-hint
  (let [cap (fn [o] o)]
    (is (true? (edge/bridge-capability-supports-path-js manifest (cap #js {}) "/v1/embeddings")))
    (is (false? (edge/bridge-capability-supports-path-js manifest (cap #js {:supportsResponses js/undefined}) "/v1/models")))
    (is (true? (edge/bridge-capability-supports-path-js manifest (cap #js {:supportsResponses js/undefined}) "/v1/embeddings")))
    (is (false? (edge/bridge-capability-supports-path-js manifest (cap #js {:supportsResponses nil}) "/v1/embeddings")))
    (is (true? (edge/bridge-capability-supports-model-js #js {:models #js ["a"]} "a")))))
