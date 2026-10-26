(ns proxx.runtime.federation-projections
  "Edge of on-demand federation pulls: store reads/writes and fetches, in order.

  Decisions (enabled? fresh? which rows?) are proxx.federation.projections.
  The store is the TypeScript SqlFederationStore; fetching federation JSON and
  building federation route paths stay TypeScript, so they arrive as `deps`:

    fetchFederationJson   ({url, credential, timeoutMs}) => Promise<payload>
    resolveFederationRoutePath (suffix, options?) => string
    env                   environment object (default process.env)"
  (:require [proxx.federation.helpers :as helpers]
            [proxx.federation.projections :as projections]
            [proxx.runtime.federation :as fed]))

(defn- error-message [e] (if (instance? js/Error e) (.-message e) (str e)))

(defonce ^:private in-flight (js/Map.))

(defn- sequentially
  "Run `f` (returning a promise or a value) over `items` one after another."
  [items f]
  (reduce (fn [p x] (.then p (fn [_] (f x)))) (js/Promise.resolve nil) items))

(defn resolve-on-demand-pull-ttl-ms-js [raw] (projections/pull-ttl-ms raw))

(defn- fetch-remote-accounts [^js deps {:keys [control-base-url owner-subject credential timeout-ms]}]
  (let [query (str "?ownerSubject=" (js/encodeURIComponent owner-subject))
        fetch (fn [url] ((.-fetchFederationJson deps) #js {:url url :credential credential :timeoutMs timeout-ms}))
        route (fn [options] ((.-resolveFederationRoutePath deps) "/federation/accounts" options))]
    (.catch (fetch (str control-base-url (route #js {:prefix "/api/v1"}) query))
            (fn [_] (fetch (str control-base-url (route js/undefined) query))))))

(defn- pull-peer [^js deps ^js store ^js logger ^js peer owner-subject timeout-ms]
  (let [peer-id (.-id peer)
        credential (helpers/extract-peer-credential (fed/js->wire (.-auth peer)))]
    (if-not credential
      (.upsertSyncState store #js {:peerId peer-id :lastError "peer auth credential missing"})
      (let [control-base-url (or (.-controlBaseUrl peer) (.-baseUrl peer))]
        (-> (fetch-remote-accounts deps {:control-base-url control-base-url :owner-subject owner-subject
                                         :credential credential :timeout-ms timeout-ms})
            (.then (fn [remote]
                     (sequentially (projections/projection-upserts peer-id owner-subject (fed/js->wire remote))
                                   (fn [row] (.upsertProjectedAccount store (clj->js row))))))
            (.then (fn [_] (.upsertSyncState store #js {:peerId peer-id :lastPullAt true :lastError nil})))
            (.catch (fn [error]
                      (let [detail (error-message error)]
                        (when logger
                          (.warn logger #js {:peerId peer-id :ownerSubject owner-subject :error detail}
                                 "federation on-demand pull failed"))
                        (.upsertSyncState store #js {:peerId peer-id :lastError detail})))))))))

(defn- pull-if-stale
  "Pull one peer unless it is fresh; join a pull already running for it instead of starting another."
  [^js deps ^js store ^js input ^js peer now ttl-ms pulled]
  (let [peer-id (.-id peer)]
    (.then (.getSyncState store peer-id)
           (fn [sync-state]
             (cond
               (projections/fresh? (when sync-state (.-lastPullAt ^js sync-state)) now ttl-ms) nil

               (.get in-flight peer-id)
               (.catch (.get in-flight peer-id) (fn [_] nil))

               :else
               (let [promise (pull-peer deps store (.-logger input) peer (.-ownerSubject input) (.-timeoutMs input))]
                 (.set in-flight peer-id promise)
                 (-> promise
                     (.then (fn [_] (swap! pulled conj peer-id)))
                     (.finally (fn [] (.delete in-flight peer-id))))))))))

(defn ensure-projected-accounts-fresh-js
  "Pull each active peer whose last pull is stale, once at a time per peer.
  Resolves {pulledPeerIds}, or undefined when on-demand pulls are disabled."
  [^js input ^js deps]
  (let [env (or (.-env deps) js/process.env)]
    (if-not (projections/pull-enabled? (aget env "FEDERATION_ON_DEMAND_PULL_ENABLED"))
      (js/Promise.resolve js/undefined)
      (let [ttl-ms (projections/pull-ttl-ms (aget env "FEDERATION_ON_DEMAND_PULL_TTL_MS"))
            now (js/Date.now)
            ^js store (.-sqlFederationStore input)
            pulled (atom [])]
        (.then (.listPeers store (.-ownerSubject input))
               (fn [peers]
                 (let [active (filterv #(projections/active-peer? (fed/js->wire %)) (array-seq peers))]
                   (if (empty? active)
                     #js {:pulledPeerIds #js []}
                     (.then (sequentially active #(pull-if-stale deps store input % now ttl-ms pulled))
                            (fn [_] #js {:pulledPeerIds (to-array @pulled)}))))))))))
