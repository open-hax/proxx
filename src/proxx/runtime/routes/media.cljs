(ns proxx.runtime.routes.media
  "Media generation routes. Sequences the provider call, the files and the event
  store around the verdicts in proxx.http.media. `c` is the collaborator bag from
  the TS shim: postMediaJson (node http POST), saveGeneratedAudio, buildCredentialHeaders,
  copyUpstreamHeaders, toErrorMessage, joinUrl, getActiveCljsRuntime."
  (:require [proxx.http.media :as media]
            [proxx.http.proxy :as proxy]
            [proxx.jsval :as jv]
            [proxx.runtime.interop :as interop]
            [proxx.runtime.ring :as ring]))

(defn- or-undef [x] (if (nil? x) js/undefined x))

(defn- js-record? [x] (and (some? x) (= "object" (js* "typeof ~{}" x))))

(defn- fields
  "A JS object of the non-nil values among k/v pairs (a pino log object)."
  [& kvs]
  (let [o #js {}]
    (doseq [[k v] (partition 2 kvs)] (when (some? v) (aset o k v)))
    o))

(defn- log! [^js deps level obj msg]
  (js-invoke ^js (.-log ^js (.-app deps)) level obj msg))

(defn- error-response
  ([status message type code]
   {:status status
    :headers (when code {"x-open-hax-error-code" code})
    :body (proxy/openai-error message type code)}))

(def ^:private invalid-body-response
  (error-response 400 "Request body must be a JSON object" "invalid_request_error" "invalid_body"))

(defn- parse-json [text] (interop/js->data (js/JSON.parse text)))

(defn- parse-or-raw
  "The parsed payload as data, or {\"raw\" text} when it is not JSON."
  [text]
  (try (parse-json text) (catch :default _ {"raw" text})))

(defn- base-url [^js deps provider default]
  (media/base-url (aget (.-upstreamProviderBaseUrls ^js (.-config deps)) provider) default))

(defn- emit! [^js deps method & args]
  (when-let [^js store (.-eventStore deps)]
    (.apply (aget store method) store (to-array args))))

(defn- tool-call-id [^js raw]
  (let [v (aget (.-headers raw) "x-open-hax-tool-call-id")] (when (string? v) v)))

(defn- send-upstream!
  "Reply with a provider's answer: its headers, the provider/mode/path markers,
  its status and text."
  [^js c ^js reply upstream provider label path status text]
  ((.-copyUpstreamHeaders c) reply (:headers upstream))
  (.header reply "x-open-hax-upstream-provider" provider)
  (.header reply "x-open-hax-upstream-mode" label)
  (.header reply "x-open-hax-upstream-path" path)
  {:status status :body text})

(defn- ^:async post [^js c url headers body-text timeout-ms]
  (let [^js res (await ((.-postMediaJson c) url headers body-text timeout-ms))]
    {:status (.-status res) :headers (.-headers res) :text (.-text res)}))

(defn- ^:async save-audio! [^js c raw-audio encoding file-path text]
  (await ((.-saveGeneratedAudio c) #js {:rawAudio raw-audio :encoding encoding :filePath file-path :text text})))

(defn- ^:async minimax
  [^js c ^js deps ^js raw ^js reply {:keys [label local-path]} body]
  (let [started (js/Date.now)
        tool-call (tool-call-id raw)
        model (let [m (get body "model")] (if (string? m) m ""))
        api-key (aget js/process.env "MINIMAX_API_KEY")]
    (if-not (jv/truthy? api-key)
      (error-response 503 "MINIMAX_API_KEY not configured" "invalid_request_error" "provider_not_configured")
      (let [_ (log! deps "info" (fields "toolCallId" tool-call "mode" label "localPath" local-path "model" model
                                        "provider" "minimax") "MiniMax music proxy request start")
            mm-body (media/minimax-body body)
            body-text (js/JSON.stringify (clj->js mm-body))
            upstream-url ((.-joinUrl c) (base-url deps "minimax" media/minimax-default-base) "/v1/music_generation")
            entry (media/entry-id tool-call label model started)
            headers (cond-> {"Authorization" (str "Bearer " api-key) "Content-Type" "application/json"}
                      tool-call (assoc "X-Open-Hax-Tool-Call-Id" tool-call))]
        (emit! deps "emitRequest" entry "minimax" "minimax-direct" model (clj->js mm-body)
               #js {:upstreamMode label :upstreamPath "/v1/music_generation" :upstreamUrl upstream-url})
        (try
          (let [upstream (await (post c upstream-url (clj->js headers) body-text (.-requestTimeoutMs ^js (.-config deps))))
                text (:text upstream)
                ok? (and (>= (:status upstream) 200) (< (:status upstream) 300))
                failure (when ok?
                          (or (media/minimax-logical-failure parse-json text)
                              (when-not (media/valid-media-output? parse-json text label)
                                (str "missing or empty " label " output"))))
                status (if failure 502 (:status upstream))
                elapsed (- (js/Date.now) started)]
            (log! deps "info" (fields "toolCallId" tool-call "mode" label "model" model "upstreamStatus" (:status upstream)
                                      "logicalFailure" failure "elapsedMs" elapsed
                                      "responseBytes" (js/Buffer.byteLength text))
                  "MiniMax music proxy upstream attempt complete")
            (if failure
              (do (log! deps "warn" (fields "toolCallId" tool-call "mode" label "model" model "logicalFailure" failure
                                            "elapsedMs" (- (js/Date.now) started))
                        "MiniMax music proxy logical failure payload")
                  (emit! deps "emitError" entry "minimax" "minimax-direct" model status
                         #js {:error (str "MiniMax " label " returned failed payload: " failure)
                              :logicalFailure failure :responsePreview (media/preview text)}
                         #js {:elapsedMs (- (js/Date.now) started)})
                  (error-response status (str "MiniMax music generation failed: " failure) "upstream_error" "provider_failed"))
              (let [parsed (parse-or-raw text)
                    audio (media/audio-string parsed)
                    event-payload (if audio
                                    (let [hex? (media/looks-hex? audio)
                                          path (media/saved-file-path entry "mp3")
                                          n (await (save-audio! c audio (if hex? "hex" "base64") path text))]
                                      (media/stripped-event-payload parsed path n (if hex? "hex" "base64")))
                                    (or parsed {}))]
                (emit! deps "emitResponse" entry "minimax" "minimax-direct" model (:status upstream) (clj->js event-payload)
                       #js {:elapsedMs (- (js/Date.now) started) :responseBytes (js/Buffer.byteLength text)})
                (send-upstream! c reply upstream "minimax" label "/v1/music_generation" (:status upstream) text))))
          (catch :default error
            (let [msg ((.-toErrorMessage c) error)]
              (log! deps "warn" (fields "toolCallId" tool-call "mode" label "model" model "error" msg
                                        "elapsedMs" (- (js/Date.now) started))
                    "MiniMax music proxy upstream attempt error")
              (emit! deps "emitError" entry "minimax" "minimax-direct" model 0 #js {:error msg}
                     #js {:elapsedMs (- (js/Date.now) started)})
              (error-response 502 (str "MiniMax music generation failed: " msg) "upstream_error" "provider_failed"))))))))

(defn- ^:async musicgen
  [^js c ^js deps ^js raw ^js reply {:keys [label local-path]} body]
  (let [started (js/Date.now)
        tool-call (tool-call-id raw)
        model (let [m (get body "model")] (if (string? m) m ""))
        prompt (let [p (get body "prompt")] (if (string? p) p ""))]
    (if (empty? prompt)
      (error-response 400 "Missing required field: prompt" "invalid_request_error" "missing_prompt")
      (let [_ (log! deps "info" (fields "toolCallId" tool-call "mode" label "localPath" local-path "model" model
                                        "provider" "musicgen") "MusicGen proxy request start")
            mg-body (media/musicgen-body prompt body)
            duration (get mg-body "duration")
            body-text (js/JSON.stringify (clj->js mg-body))
            upstream-url ((.-joinUrl c) (base-url deps "musicgen" media/musicgen-default-base) "/generate")
            entry (media/entry-id tool-call label model started)
            headers (cond-> {"Content-Type" "application/json"} tool-call (assoc "X-Open-Hax-Tool-Call-Id" tool-call))]
        (emit! deps "emitRequest" entry "musicgen" "musicgen-local" model (clj->js mg-body)
               #js {:upstreamMode label :upstreamPath "/generate" :upstreamUrl upstream-url})
        (try
          (let [upstream (await (post c upstream-url (clj->js headers) body-text (.-requestTimeoutMs ^js (.-config deps))))
                text (:text upstream)
                ok? (and (>= (:status upstream) 200) (< (:status upstream) 300))
                failure (when (and ok? (not (media/valid-media-output? parse-json text label)))
                          (str "missing or empty " label " output"))
                status (if failure 502 (:status upstream))]
            (log! deps "info" (fields "toolCallId" tool-call "mode" label "model" model "upstreamStatus" (:status upstream)
                                      "logicalFailure" failure "elapsedMs" (- (js/Date.now) started)
                                      "responseBytes" (js/Buffer.byteLength text))
                  "MusicGen proxy upstream attempt complete")
            (if failure
              (do (log! deps "warn" (fields "toolCallId" tool-call "mode" label "model" model "logicalFailure" failure
                                            "elapsedMs" (- (js/Date.now) started))
                        "MusicGen proxy logical failure payload")
                  (emit! deps "emitError" entry "musicgen" "musicgen-local" model status
                         #js {:error failure :responsePreview (media/preview text)}
                         #js {:elapsedMs (- (js/Date.now) started)})
                  (error-response status (str "MusicGen generation failed: " failure) "upstream_error" "provider_failed"))
              (let [parsed (parse-or-raw text)
                    data (when (map? parsed) (get parsed "data"))
                    answer
                    (if (and (map? data) (string? (get data "audio")))
                      (let [raw-audio (get data "audio")
                            path (media/saved-file-path entry "wav")
                            n (await (save-audio! c raw-audio "base64" path text))
                            answer (media/musicgen-answer raw-audio data duration path n)]
                        (emit! deps "emitResponse" entry "musicgen" "musicgen-local" model (:status upstream)
                               (clj->js (assoc (into (array-map) answer)
                                               "data" (assoc (into (array-map) data) "audio"
                                                             (str "[STRIPPED: " n " bytes saved to " path "]"))))
                               #js {:elapsedMs (- (js/Date.now) started) :responseBytes (js/Buffer.byteLength text)})
                        answer)
                      (let [answer (or parsed {})]
                        (emit! deps "emitResponse" entry "musicgen" "musicgen-local" model (:status upstream) (clj->js answer)
                               #js {:elapsedMs (- (js/Date.now) started) :responseBytes (js/Buffer.byteLength text)})
                        answer))]
                (send-upstream! c reply upstream "musicgen" label "/generate" 200 (js/JSON.stringify (clj->js answer))))))
          (catch :default error
            (let [msg ((.-toErrorMessage c) error)]
              (log! deps "warn" (fields "toolCallId" tool-call "mode" label "model" model "error" msg
                                        "elapsedMs" (- (js/Date.now) started))
                    "MusicGen proxy upstream attempt error")
              (emit! deps "emitError" entry "musicgen" "musicgen-local" model 0 #js {:error msg}
                     #js {:elapsedMs (- (js/Date.now) started)})
              (error-response 502 (str "MusicGen generation failed: " msg) "upstream_error" "provider_failed"))))))))

(defn- policy-provider
  "Provider the policy runtime assigns to this media request, else \"blaze\"."
  [^js c ^js deps {:keys [label]} model]
  (let [runtime ((.-getActiveCljsRuntime c))]
    (if-not runtime
      "blaze"
      (try
        (let [result (interop/js->data
                      ((.-previewPolicyDecision ^js runtime)
                       (or (.-cljsPolicyManifestPath ^js (.-config deps)) "resources/policies/runtime/00-manifest.edn")
                       #js {:modelId model :requestKind label :tenantSettings #js {}}))
              provider (get-in result ["decision" "provider-id"])]
          (if (and (= "ok" (get result "status")) (map? (get result "decision")) (string? provider) (seq provider))
            provider
            "blaze"))
        (catch :default error
          (log! deps "warn" (fields "model" model "requestKind" label "error" ((.-toErrorMessage c) error))
                "CLJS media policy preview failed")
          "blaze")))))

(defn- ^:async blaze
  [^js c ^js deps ^js raw ^js reply {:keys [label local-path upstream-path] :as route} body]
  (let [started (js/Date.now)
        tool-call (tool-call-id raw)
        model (let [m (get body "model")] (if (string? m) m ""))]
    (if (empty? model)
      (error-response 400 "Missing required field: model" "invalid_request_error" "missing_model")
      (let [provider (policy-provider c deps route model)]
        (cond
          (and (= "music" label) (= "minimax" provider)) (await (minimax c deps raw reply route body))
          (and (= "music" label) (= "musicgen" provider)) (await (musicgen c deps raw reply route body))
          :else
          (let [_ (log! deps "info" (fields "toolCallId" tool-call "mode" label "localPath" local-path
                                            "upstreamPath" upstream-path "model" model)
                        "Blaze media proxy request start")
                ^js key-pool (.-keyPool deps)
                accounts (try (await ((.-ensureFreshAccounts deps) provider))
                              (await (.getRequestOrder key-pool provider))
                              (catch :default error {::failed error}))]
            (cond
              (and (map? accounts) (::failed accounts))
              (error-response 503 (str "No " provider " account is available: " ((.-toErrorMessage c) (::failed accounts)))
                              "invalid_request_error" "provider_not_configured")

              (zero? (.-length accounts))
              (error-response 503 (str "No ready " provider " account is available.") "rate_limit_error" "provider_unavailable")

              :else
              (let [upstream-url ((.-joinUrl c) (base-url deps "blaze" media/blaze-default-base) upstream-path)
                    body-text (js/JSON.stringify (.-body raw))
                    entry (media/entry-id tool-call label model started)
                    n (.-length accounts)
                    timeout (.-requestTimeoutMs ^js (.-config deps))]
                (loop [i 0 last-status 0 last-error ""]
                  (if (>= i n)
                    (do (log! deps "error" (fields "toolCallId" tool-call "mode" label "model" model "lastStatus" last-status
                                                   "lastError" last-error "elapsedMs" (- (js/Date.now) started))
                              "Blaze media proxy exhausted accounts")
                        (let [{:keys [status message]} (media/blaze-final-error last-status last-error label)]
                          (error-response status message "upstream_error" "provider_failed")))
                    (let [^js account (aget accounts i)
                          release (.markInFlight key-pool account)
                          outcome
                          (try
                            (log! deps "info" (fields "toolCallId" tool-call "mode" label "model" model
                                                      "accountId" (.-accountId account) "upstreamPath" upstream-path)
                                  "Blaze media proxy upstream attempt start")
                            (emit! deps "emitRequest" entry provider (.-accountId account) model (.-body raw)
                                   #js {:upstreamMode label :upstreamPath upstream-path :upstreamUrl upstream-url})
                            (let [upstream (await (post c upstream-url ((.-buildCredentialHeaders c) (.-headers raw) account)
                                                        body-text timeout))
                                  text (:text upstream)
                                  ok? (and (>= (:status upstream) 200) (< (:status upstream) 300))
                                  failure (when ok?
                                            (or (media/blaze-logical-failure parse-json text)
                                                (when-not (media/valid-media-output? parse-json text label)
                                                  (str "missing or empty " label " output"))))]
                              (when (= 429 (:status upstream)) (.markRateLimited key-pool account))
                              (let [[status error] (media/upstream-attempt-status
                                                    (:status upstream) text failure (str "BlazeAPI " label " returned failed payload: "))]
                                (log! deps "info" (fields "toolCallId" tool-call "mode" label "model" model
                                                          "accountId" (.-accountId account) "upstreamStatus" (:status upstream)
                                                          "logicalFailure" failure "elapsedMs" (- (js/Date.now) started)
                                                          "responseBytes" (js/Buffer.byteLength text))
                                      "Blaze media proxy upstream attempt complete")
                                (if failure
                                  (do (log! deps "warn" (fields "toolCallId" tool-call "mode" label "model" model
                                                                "accountId" (.-accountId account) "logicalFailure" failure
                                                                "elapsedMs" (- (js/Date.now) started))
                                            "Blaze media proxy logical failure payload")
                                      (emit! deps "emitError" entry provider (.-accountId account) model status
                                             #js {:error error :logicalFailure failure :responsePreview (media/preview text)}
                                             #js {:elapsedMs (- (js/Date.now) started)}))
                                  (let [parsed (parse-or-raw text)
                                        audio (media/audio-string parsed)
                                        event-payload (if audio
                                                        (let [hex? (media/looks-hex? audio)
                                                              path (media/saved-file-path entry "mp3")
                                                              bytes (await (save-audio! c audio (if hex? "hex" "base64") path text))]
                                                          (media/stripped-event-payload parsed path bytes (if hex? "hex" "base64")))
                                                        (or parsed {}))]
                                    (emit! deps "emitResponse" entry provider (.-accountId account) model (:status upstream)
                                           (clj->js event-payload)
                                           #js {:elapsedMs (- (js/Date.now) started) :responseBytes (js/Buffer.byteLength text)})))
                                (if (media/blaze-respond? failure (:status upstream) n)
                                  {:respond (send-upstream! c reply upstream "blaze" label upstream-path (:status upstream) text)}
                                  {:last-status status :last-error error})))
                            (catch :default error
                              (let [msg ((.-toErrorMessage c) error)]
                                (log! deps "warn" (fields "toolCallId" tool-call "mode" label "model" model
                                                          "accountId" (.-accountId account) "error" msg
                                                          "elapsedMs" (- (js/Date.now) started))
                                      "Blaze media proxy upstream attempt error")
                                (emit! deps "emitError" entry "blaze" (.-accountId account) model 0 #js {:error msg}
                                       #js {:elapsedMs (- (js/Date.now) started)})
                                {:last-status 0 :last-error msg}))
                            (finally (release)))]
                      (if-let [response (:respond outcome)]
                        response
                        (recur (inc i) (:last-status outcome) (:last-error outcome))))))))))))))

(defn routes [^js c ^js deps]
  (mapv (fn [{:keys [local-path] :as route}]
          {:method :post :path local-path :opaque-body? true
           :handler (fn ^:async media-route [{:keys [^js raw ^js reply]}]
                      (let [body (.-body raw)]
                        (if-not (js-record? body)
                          invalid-body-response
                          (await (blaze c deps raw reply route (interop/js->data body))))))})
        media/routes))

(defn register-media-routes-js [app ^js deps ^js c]
  (ring/register! app (routes c deps)))
