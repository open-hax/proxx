(ns proxx.runtime
  (:require [proxx.policy :as policy]
            [proxx.policy.router :as router]
            [proxx.processor :as processor]
            [proxx.schema :as schema]
            [proxx.strategies.anthropic :as anthropic]
            [proxx.strategies.openai :as openai]))

(defn normalize-keys-js
  "Normalize JS object keys through the CLJS data-layer processor."
  [value]
  (clj->js (processor/normalize-keys (js->clj value :keywordize-keys true))))

(defn validate-entity-js
  "Validate a JS object against the CLJS/Malli entity registry.
   Object keys are normalized before validation. Returns a JS object
   shaped as {status, record|errors}."
  [entity-type value]
  (let [[status result] (schema/validate (keyword entity-type)
                                         (processor/normalize-keys
                                          (js->clj value :keywordize-keys true)))]
    (clj->js (if (= :ok status)
              {:status "ok" :record result}
              {:status "error" :errors result}))))

(defn- normalize-event-outcome [event]
  (update event :outcome #(if (string? %) (keyword %) %)))

(defn project-pheromone-js
  "Project and clamp pheromone score from JS event objects."
  [events opts]
  (processor/project-pheromone (mapv normalize-event-outcome
                                     (js->clj events :keywordize-keys true))
                               (js->clj (or opts #js {}) :keywordize-keys true)))

(defn route-policy-js [policies ctx]
  (policy/register-strategy! 'proxx.strategies.openai/chat-completions-passthrough
                             openai/chat-completions-passthrough)
  (policy/register-strategy! 'proxx.strategies.anthropic/messages-passthrough
                             anthropic/messages-passthrough)
  (let [trace (atom [])]
    (try
      (let [result (router/route-request! (js->clj policies :keywordize-keys true)
                                          (js->clj ctx :keywordize-keys true)
                                          trace)]
        (clj->js {:status "ok" :result result :trace @trace}))
      (catch :default e
        (clj->js {:status "error"
                  :error (.-message e)
                  :data (ex-data e)
                  :trace @trace})))))

(def exports
  #js {:normalizeKeys normalize-keys-js
       :validateEntity validate-entity-js
       :projectPheromone project-pheromone-js
       :routePolicy route-policy-js})
