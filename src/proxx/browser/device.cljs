;; SPDX-License-Identifier: GPL-3.0-or-later
(ns proxx.browser.device
  "Browser presentation and same-origin polling. No OAuth codes or tokens are accepted here.")

(defn- element!
  "Create UI text without interpreting authority fields as markup."
  [tag text parent]
  (let [node (.createElement js/document tag)]
    (set! (.-textContent node) text)
    (.appendChild parent node)
    node))

(defn- ^:async request!
  "Call only a fixed same-origin backend operation; cookies are browser-managed."
  [operation]
  (let [response (await (js/fetch (str "/api/auth/axxium/device/" operation)
                         #js {:method "POST" :credentials "same-origin"
                              :headers #js {"accept" "application/json"}}))]
    (when-not (or (.-ok response) (= 429 (.-status response)))
      (throw (js/Error. "Device sign-in unavailable. Start again.")))
    (js->clj (await (.json response)) :keywordize-keys true)))

(defn- trusted-link!
  "Defend the display edge; the backend additionally pins the authority's exact origin."
  [value]
  (let [uri (js/URL. value)]
    (when-not (and (= "https:" (.-protocol uri)) (= "" (.-username uri))
                   (= "" (.-password uri)) (= "" (.-hash uri)))
      (throw (js/Error. "Device verification link refused.")))
    (.-href uri)))

(defn- current?
  "A cancelled or unmounted UI cannot consume late fetch results."
  [state generation]
  (and @(:alive state) (= generation @(:generation state))))

(defn- stop!
  "Fence callbacks before stopping the pending timer."
  [state]
  (swap! (:generation state) inc)
  (js/clearTimeout @(:timer state)))

(defn- fail!
  "Show a fixed public status without propagating internal protocol errors."
  [state generation message]
  (when (current? state generation)
    (stop! state)
    (set! (.-textContent (:display state)) message)
    (set! (.-disabled (:button state)) false)
    (set! (.-hidden (:cancel state)) true)))

(declare poll!)

(defn- schedule!
  "Respect the advertised interval/backoff with a five-second lower bound."
  [state generation interval]
  (reset! (:timer state)
    (js/setTimeout #(poll! state generation) (* 1000 (max 5 (min 600 interval))))))

(defn- ^:async poll!
  "Poll only the product transaction; token polling runs in the product backend."
  [state generation]
  (when (current? state generation)
    (try
      (let [result (await (request! "poll"))]
        (when (current? state generation)
          (case (:status result)
            "pending" (schedule! state generation (or (:interval result) 5))
            "complete" (do (stop! state)
                           (set! (.-textContent (:display state)) "Signed in.")
                           ((:on-complete state)))
            "denied" (fail! state generation "Device sign-in was denied. Start again.")
            "expired" (fail! state generation "Device code expired. Start again.")
            (fail! state generation "Device sign-in failed. Start again."))))
      (catch :default _ (fail! state generation "Device sign-in unavailable. Start again.")))))

(defn- ^:async cancel!
  "Cancel server admission and fence any pending browser response."
  [state]
  (stop! state)
  (set! (.-textContent (:display state)) "Device sign-in cancelled.")
  (set! (.-disabled (:button state)) false)
  (set! (.-hidden (:cancel state)) true)
  (try (await (request! "cancel")) (catch :default _ nil)))

(defn- show-code!
  "Render the code and a deliberate user-activated authority link."
  [state result]
  (let [display (:display state)
        uri (trusted-link! (or (:verification_uri_complete result) (:verification_uri result)))]
    (set! (.-textContent display) "")
    (element! "p" "On a device signed in to Axxium, open this link and approve the matching code:" display)
    (element! "strong" (:user_code result) display)
    (let [link (element! "a" "Open Axxium device approval" display)]
      (set! (.-href link) uri)
      (set! (.-target link) "_blank")
      (set! (.-rel link) "noopener noreferrer"))
    (element! "p" (str "Code expires in " (:expires_in result)
                      " seconds. Approval reuses your current root session; it does not authorize machine federation.") display)))

(defn- ^:async start!
  "Request a code and bind subsequent UI work to this attempt's generation."
  [state]
  (stop! state)
  (let [generation @(:generation state)]
    (set! (.-disabled (:button state)) true)
    (set! (.-hidden (:cancel state)) false)
    (set! (.-textContent (:display state)) "Requesting a device code…")
    (try
      (let [result (await (request! "start"))]
        (when (current? state generation)
          (show-code! state result)
          (schedule! state generation (or (:interval result) 5))))
      (catch :default _ (fail! state generation "Device sign-in unavailable. Start again.")))))

(defn mount!
  "Mount an optional control and return cleanup that fences every late result."
  [root on-complete]
  (let [state {:alive (atom true) :generation (atom 0) :timer (atom nil) :on-complete on-complete
               :button (element! "button" "Sign in using another device" root)
               :display (element! "div" "" root) :cancel (element! "button" "Cancel device sign-in" root)}
        begin #(start! state) cancel #(cancel! state)]
    (set! (.-hidden (:cancel state)) true)
    (doseq [button [(:button state) (:cancel state)]] (set! (.-type button) "button"))
    (.setAttribute (:display state) "role" "status")
    (.setAttribute (:display state) "aria-live" "polite")
    (.addEventListener (:button state) "click" begin)
    (.addEventListener (:cancel state) "click" cancel)
    (fn []
      (reset! (:alive state) false)
      (cancel! state)
      (.removeEventListener (:button state) "click" begin)
      (.removeEventListener (:cancel state) "click" cancel)
      (.replaceChildren root))))
