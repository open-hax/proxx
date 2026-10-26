(ns proxx.web.runtime
  "The edge: one app-db atom, a dispatch loop, and the interpreters for effect
  descriptions (fetch, localStorage, cookies, timers, history, clipboard).
  Everything decided here is data-in/data-out against `proxx.web.update`."
  (:require [clojure.string :as str]
            [proxx.json :as json]
            [proxx.web.api :as api]
            [proxx.web.storage :as storage]
            [proxx.web.update :as upd]
            [reagent.core :as r]))

(goog-define API_BASE_URL "")

(defonce db (r/atom nil))
(defonce ^:private intervals (atom {}))
(defonce ^:private sockets (atom {}))

(declare dispatch!)

;; ---------------------------------------------------------------------------
;; localStorage / cookies

(defn- ls-get [k] (try (.getItem js/localStorage k) (catch :default _ nil)))
(defn- ls-set! [k v] (try (.setItem js/localStorage k v) (catch :default _ nil)))
(defn- ls-remove! [k] (try (.removeItem js/localStorage k) (catch :default _ nil)))

(defn read-stored
  "Mirror of the persisted preferences: JSON values parsed, raw keys verbatim."
  []
  (into {}
        (keep (fn [k]
                (when-let [raw (ls-get k)]
                  (if (storage/raw-keys k)
                    [k raw]
                    (try [k (json/parse raw)] (catch :default _ nil))))))
        storage/all-keys))

(defn- read-cookie [name]
  (let [prefix (str name "=")
        m (->> (str/split (or (.-cookie js/document) "") #";")
               (map str/trim)
               (some #(when (str/starts-with? % prefix) %)))]
    (if m
      (let [v (subs m (count prefix))]
        (try (js/decodeURIComponent v) (catch :default _ v)))
      "")))

(defn- write-cookie! [name value]
  (set! (.-cookie js/document)
        (if (empty? value)
          (str name "=; Max-Age=0; Path=/; SameSite=Lax")
          (str name "=" (js/encodeURIComponent value) "; Max-Age=" (* 60 60 24 30) "; Path=/; SameSite=Lax"))))

(defn read-auth-token
  "Token from localStorage, else the cookie (which is then copied to storage)."
  []
  (let [from-ls (str/trim (or (ls-get api/auth-token-key) ""))]
    (if (seq from-ls)
      from-ls
      (let [c (str/trim (read-cookie api/auth-token-cookie))]
        (when (seq c) (ls-set! api/auth-token-key c))
        c))))

(defn save-auth-token! [token]
  (if (seq token) (ls-set! api/auth-token-key token) (ls-remove! api/auth-token-key))
  (write-cookie! api/auth-token-cookie token))

(defn api-base []
  (let [loc (.-location js/window)]
    (api/base-url {:explicit API_BASE_URL
                   :protocol (.-protocol loc) :hostname (.-hostname loc) :port (.-port loc)})))

(defn api-origin []
  (let [b (api-base)] (if (seq b) b (.-origin (.-location js/window)))))

;; ---------------------------------------------------------------------------
;; fetch

(defn ^:async perform-request
  "Run a request description; resolves to the decoded data or rejects with an Error."
  [{:keys [method path body decode]}]
  (let [headers (api/request-headers (read-auth-token) (some? body))
        init (cond-> #js {:method (str/upper-case (name method))
                          :headers (clj->js headers)}
               (some? body) (doto (aset "body" (js/JSON.stringify (clj->js body)))))
        response (await (js/fetch (api/absolute-url (api-base) path) init))
        text (await (.text response))
        result (api/interpret-response {:status (.-status response) :text text})]
    (if-let [msg (:error result)]
      (throw (js/Error. msg))
      (if decode (decode (:ok result)) (:ok result)))))

(defn- error-text [e] (if (instance? js/Error e) (.-message e) (str e)))

(defn- run-http [request on-ok on-err]
  (-> (perform-request request)
      (.then (fn [data] (dispatch! (conj on-ok data)))
             (fn [e] (dispatch! (conj on-err (error-text e)))))))

(defn- run-http-all [requests on-ok on-err]
  (-> (js/Promise.all (clj->js (mapv perform-request requests)))
      (.then (fn [results] (dispatch! (conj on-ok (vec results))))
             (fn [e] (dispatch! (conj on-err (error-text e)))))))

;; ---------------------------------------------------------------------------
;; effects

(defn- run-fx! [[kind & args]]
  (case kind
    :http (let [[request on-ok on-err] args] (run-http request on-ok on-err))
    :http-all (let [[requests on-ok on-err] args] (run-http-all requests on-ok on-err))
    :storage/write (let [[k v] args] (ls-set! k (js/JSON.stringify (clj->js v))))
    :storage/write-raw (let [[k v] args] (ls-set! k v))
    :token/save (save-auth-token! (first args))
    :dispatch-later (let [[ms event] args] (js/setTimeout #(dispatch! event) ms))
    :interval/start (let [[id ms event] args]
                      (some-> (get @intervals id) js/clearInterval)
                      (swap! intervals assoc id (js/setInterval #(dispatch! event) ms)))
    :interval/stop (let [id (first args)]
                     (some-> (get @intervals id) js/clearInterval)
                     (swap! intervals dissoc id))
    :nav/push (.pushState js/history nil "" (first args))
    :clipboard/write (let [[text on-ok on-err] args]
                       (-> (.writeText (.-clipboard js/navigator) text)
                           (.then (fn [_] (dispatch! on-ok))
                                  (fn [e] (dispatch! (conj on-err (error-text e)))))))
    nil))

(defn dispatch!
  "Apply the pure handler to the current db, then interpret its effects."
  [event]
  (let [[db' effects] (upd/handle @db event)]
    (reset! db db')
    (doseq [e effects] (run-fx! e))
    (r/flush)))

(defn init-db! []
  (reset! db (upd/init-db {:stored (read-stored)
                           :token (read-auth-token)
                           :path (.-pathname (.-location js/window))})))

(defn listen-popstate! []
  (.addEventListener js/window "popstate"
                     (fn [_] (dispatch! [:route/changed (.-pathname (.-location js/window))]))))
