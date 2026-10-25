(ns proxx.runtime.ring
  "Ring-style HTTP on Fastify.

  A route is data: {:method :get :path \"/x\" :handler f}. A handler is
  `(fn [request] response)` — it may return a Promise (or be `^:async`), and
  request/response are plain maps:

    request   {:method :get :url :path :query :params :headers :body :ip :auth :raw}
              (`:auth` is the identity resolved by the host's auth hook, or nil)
              (`:raw` is the Fastify request, for handlers that must stream)
    response  {:status 200 :headers {\"x\" \"y\"} :body <map|vector|string|nil>}

  Maps and vectors are sent as JSON, strings as given. The only code that
  touches Fastify's request/reply objects is in this namespace.

  A handler that throws `(ex-info msg {:http/status n ...})` becomes a JSON
  `{\"error\": {\"message\": msg}}` response with that status; any other throw
  propagates to the application's Fastify error handler unchanged."
  (:require [clojure.string :as str]))

(defn- headers-of [^js req] (js->clj (.-headers req)))

(defn request->map
  "Plain-data view of a Fastify request."
  [^js req]
  {:method (keyword (str/lower-case (.-method req)))
   :url (.-url req)
   :path (first (str/split (.-url req) #"\?" 2))
   :query (js->clj (.-query req))
   :params (js->clj (.-params req))
   :headers (headers-of req)
   :body (js->clj (.-body req))
   :ip (.-ip req)
   :auth (let [auth (.-openHaxAuth req)] (when (some? auth) (js->clj auth)))
   :raw req})

(defn- send-response!
  [^js reply {:keys [status headers body]}]
  (.code reply (or status 200))
  (doseq [[k v] headers] (.header reply (name k) v))
  (.send reply (cond (nil? body) js/undefined
                     (string? body) body
                     :else (clj->js body)))
  reply)

(defn- http-error-response [e]
  (let [{:http/keys [status headers]} (ex-data e)]
    {:status status
     :headers headers
     :body {"error" {"message" (ex-message e)}}}))

(defn- http-error? [e] (some? (:http/status (ex-data e))))

(defn- adapt [handler]
  (fn ^:async fastify-handler [^js req ^js reply]
    (let [response (try (await (handler (request->map req)))
                        (catch :default e
                          (if (http-error? e) (http-error-response e) (throw e))))]
      (send-response! reply response))))

(defn register!
  "Register `routes` (a seq of route maps) on a Fastify instance."
  [^js app routes]
  (doseq [{:keys [method path handler]} routes]
    (.route app #js {:method (str/upper-case (name method))
                     :url path
                     :handler (adapt handler)})))
