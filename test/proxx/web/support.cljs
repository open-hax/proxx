(ns proxx.web.support
  "Browser-ish harness for view smoke tests: fetch stub, mount, wait."
  (:require [clojure.string :as str]
            [reagent.core :as r]
            [proxx.web.main :as main]
            [proxx.web.runtime :as rt]))

(def calls (atom []))

(defn- response [status body]
  #js {:status status
       :ok (<= 200 status 299)
       :text (fn [] (js/Promise.resolve (if (string? body) body (js/JSON.stringify (clj->js body)))))})

(defn stub-fetch!
  "Replace `fetch`. `routes` is a seq of `[matcher body-or-fn]`; matcher is a
  regex tested against `METHOD url` (a body fn receives the parsed request body
  as a clj map). Unmatched requests answer 404 `{}`. Calls are recorded in `calls`."
  [routes]
  (reset! calls [])
  (set! js/fetch
        (fn [url init]
          (let [method (str/upper-case (or (some-> init (aget "method")) "GET"))
                raw (some-> init (aget "body"))
                body (when raw (js->clj (js/JSON.parse raw)))
                k (str method " " url)]
            (swap! calls conj {:method method :url (str url) :body body :headers (some-> init (aget "headers") (js->clj))})
            (js/Promise.resolve
             (if-let [[_ out] (some (fn [[re _ :as route]] (when (re-find re k) route)) routes)]
               (let [out (if (fn? out) (out body) out)]
                 (if (and (map? out) (:status out)) (response (:status out) (:body out)) (response 200 out)))
               (response 404 {})))))))

(defn sleep [ms] (js/Promise. (fn [res _] (js/setTimeout res ms))))

(defn body-text [] (.-textContent (.-body js/document)))

(defn ^:async mount-app!
  "Fresh container + db at `path`; returns once initial effects settled."
  [path]
  (.replaceChildren (.-body js/document))
  (.clear js/localStorage)
  (.pushState js/history nil "" path)
  (let [container (.createElement js/document "div")]
    (.appendChild (.-body js/document) container)
    (rt/init-db!)
    (main/mount! container)
    (rt/dispatch! [:app/started])
    (await (sleep 80))
    container))

(defn ^:async settle [] (await (sleep 60)) (r/flush))
