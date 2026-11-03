(ns proxx.test-runner-guard-test
  "Makes the node test run honest about two things cljs.test lets slip.

  1. A thrown error or rejected promise inside an ^:async deftest. cljs.test
     starts the async body and drops its promise, and the shadow-cljs node runner
     calls process.exit right after the last `done`, so a rejection that lands one
     microtask later was lost: the test counted as passing with its assertions never
     reached. Unhandled rejections are recorded here and fail the run.
  2. A test that finishes without a single assertion. That is reported as a
     warning (some tests legitimately assert by not throwing)."
  (:require [cljs.test :as ct :refer [deftest is]]))

(defonce ^:private rejections (atom []))
(defonce ^:private starts (atom {}))
(defonce ^:private assertion-free (atom []))

(defonce ^:private installed
  (.on js/process "unhandledRejection"
       (fn [reason _promise] (swap! rejections conj reason))))

(defn- assertions-so-far []
  (let [{:keys [pass fail error]} (:report-counters (ct/get-current-env))]
    (+ (or pass 0) (or fail 0) (or error 0))))

(defn- end-run-tests [m]
  (js/setTimeout
   (fn []
     (let [seen @rejections
           none (sort @assertion-free)]
       (when (seq none)
         (js/console.warn (str "WARNING: " (count none) " test(s) finished without a single assertion:"))
         (doseq [t none] (js/console.warn "  " t)))
       (doseq [r seen]
         (js/console.error "ERROR in an async test (unhandled rejection):"
                           (or (some-> r .-stack) (str r))))
       (js/process.exit (if (and (ct/successful? m) (empty? seen)) 0 1))))
   50))

;; shadow-cljs only bundles namespaces that contain a deftest, so this one is also
;; the guard's reason to be loaded.
(deftest the-unhandled-rejection-hook-is-installed
  ;; Registered at test time, not load time: shadow.test.node defines its own
  ;; :end-run-tests method (an immediate process.exit) and load order would let it win.
  (defmethod ct/report [::ct/default :end-run-tests] [m] (end-run-tests m))
  (defmethod ct/report [::ct/default :begin-test-var] [m]
    (swap! starts assoc (str (:var m)) (assertions-so-far)))
  (defmethod ct/report [::ct/default :end-test-var] [m]
    (let [k (str (:var m))]
      (when (= (get @starts k) (assertions-so-far))
        (swap! assertion-free conj k))))
  (is (pos? (.listenerCount js/process "unhandledRejection"))))
