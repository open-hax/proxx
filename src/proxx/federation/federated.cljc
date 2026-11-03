(ns proxx.federation.federated
  "Decisions of federated (peer-to-peer) request routing over facts the edge has
  already fetched. Companion of proxx.federation.routing; the edge is
  proxx.runtime.federation-routing. Inputs are wire maps."
  (:require [proxx.federation.routing :as routing]))

(defn settled-before-import
  "Is a warm import moot for the freshly re-read projected account (`latest`, nil when it
  vanished)? :vanished, :already-imported, or nil when the import should go on."
  [latest]
  (cond (nil? latest) :vanished
        (= "imported" (get latest "availabilityState")) :already-imported))

(defn importable?
  "Can the credential be fetched: the source peer is known and has a credential?"
  [peer credential]
  (boolean (and peer credential)))

(defn credential-write
  "How an exported account is stored locally: {:store :oauth|:api-key :args [...]} in the
  store method's argument order."
  [account]
  (let [{:strs [providerId accountId secret]} account]
    (if (= "oauth_bearer" (get account "authType"))
      {:store :oauth
       :args [providerId accountId secret (get account "refreshToken") (get account "expiresAt")
              (get account "chatgptAccountId") (get account "email") (get account "subject")
              (get account "planType")]}
      {:store :api-key :args [providerId accountId secret]})))

(defn reply-mode
  "How a peer's successful response reaches the client: no body at all is sent as text; an event
  stream is piped; anything else is buffered whole."
  [has-body? content-type]
  (cond (not has-body?) :text
        (routing/event-stream-content-type? content-type) :stream
        :else :buffer))

(defn reply-header-pairs
  "[name value] pairs set on the reply: the peer's copyable headers, then the routing headers
  (which win)."
  [response-pairs owner-subject peer-id projected-account imported?]
  (into (filterv (fn [[name _]] (routing/copyable-response-header? name)) response-pairs)
        (routing/routed-response-headers owner-subject peer-id projected-account imported?)))
