(ns proxx.routing.pipeline
  "Decisions of the model routing pipeline (the pure half of
  src/lib/model-routing-pipeline.ts): reject unusable requests, pick how candidate
  models are produced, and turn the candidates into the routing result.")

(defn- error [status message code]
  {:status status :message message :type "invalid_request_error" :code code})

(defn check-requested-model
  "{:error ...} for a request without a usable model, else {:model requested-model}."
  [request-body]
  (let [model (get request-body "model")]
    (if (and (string? model) (seq model))
      {:model model}
      {:error (error 400 "Missing required field: model" "missing_model")})))

(defn tenant-denies-model?
  "Did the policy preview deny the model for this tenant? `preview` is the runtime's
  {\"status\" \"decision\"} result."
  [preview]
  (let [decision (get preview "decision")]
    (and (= "ok" (get preview "status"))
         (map? decision)
         (= "denied" (get decision "status"))
         (= "tenant-model-not-allowed" (get decision "reason")))))

(defn tenant-denied-error [model]
  (error 403 (str "Model is disabled for this tenant: " model) "model_not_allowed"))

(defn candidate-source
  "How candidates for a routed model are produced; the specialised families outrank auto:*."
  [{:keys [cephalon? vision? auto?]}]
  (cond cephalon? :cephalon vision? :vision auto? :auto :else :plain))

(def ^:private header-candidate-limit 12)

(defn finish
  "The routing result for the produced candidates: {:error ...} when there are none, else
  {:candidates :auto? :candidates-header} (the header only for generated candidates)."
  [requested source candidates]
  (if (empty? candidates)
    {:error (error 404 (str "Model not found: " requested) "model_not_found")}
    (let [generated? (not= :plain source)]
      (cond-> {:candidates (vec candidates) :auto? generated?}
        generated? (assoc :candidates-header (apply str (interpose "," (take header-candidate-limit candidates))))))))
