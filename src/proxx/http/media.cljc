(ns proxx.http.media
  "Media generation routes (src/routes/media-generations.ts): /v1/music/generations,
  /v1/videos/generations, /v1/video/generations, /v1/audio/speech. The verdicts on
  provider payloads (logical failures behind a 2xx), the MiniMax and MusicGen
  request/response shapes, the audio-stripped event payloads and the final error
  are pure; HTTP to the providers, files and events are the edge's."
  (:require [clojure.string :as str]
            [proxx.jsval :as jv]))

(def routes
  [{:local-path "/v1/music/generations" :upstream-path "/music/generations" :label "music"}
   {:local-path "/v1/videos/generations" :upstream-path "/videos/generations" :label "video"}
   {:local-path "/v1/video/generations" :upstream-path "/videos/generations" :label "video"}
   {:local-path "/v1/audio/speech" :upstream-path "/audio/speech" :label "tts"}])

(def saved-dir "/app/data/blaze_generated")

(defn trim-trailing-slashes [s] (str/replace s #"/+$" ""))

(defn base-url [configured default] (trim-trailing-slashes (or configured default)))

(def blaze-default-base "https://blazeai.boxu.dev/api")
(def minimax-default-base "https://api.minimax.io")
(def musicgen-default-base "http://musicgen:8080")

(defn- parse [parse-json text]
  (try {:value (parse-json text)} (catch #?(:clj Exception :cljs :default) _ nil)))

(defn- record [x] (when (map? x) x))

(defn blaze-logical-failure
  "A reason when a 2xx BlazeAPI payload reports failure in its body, else nil."
  [parse-json text]
  (when-let [{:keys [value]} (parse parse-json text)]
    (when-let [p (record value)]
      (let [status (let [s (get p "status")] (if (string? s) (str/lower-case s) ""))
            error (when (string? (get p "error")) (get p "error"))
            message (when (string? (get p "message")) (get p "message"))]
        (when (contains? #{"failed" "error" "terminated" "canceled" "cancelled"} status)
          (let [parts (filter #(and (string? %) (seq %)) [(when (seq status) (str "status=" status))
                                                          (if (some? error) error message)])
                joined (str/join "; " parts)]
            (if (seq joined) joined "status=failed")))))))

(defn minimax-logical-failure [parse-json text]
  (when-let [{:keys [value]} (parse parse-json text)]
    (when-let [p (record value)]
      (let [base (record (get p "base_resp"))
            code (when base (let [c (get base "status_code")] (when (number? c) c)))
            msg (when base (let [m (get base "status_msg")] (when (string? m) m)))
            data (record (get p "data"))
            generation (when data (let [s (get data "status")] (when (number? s) s)))]
        (cond
          (and (some? code) (not= 0 code)) (str "MiniMax error " code ": " (or msg "unknown error"))
          (and (some? generation) (not= 2 generation)) (str "MiniMax generation incomplete (status=" generation ")"))))))

(defn valid-media-output?
  "Does a 2xx payload carry the media its route promises?"
  [parse-json text label]
  (boolean
   (when-let [{:keys [value]} (parse parse-json text)]
     (when-let [data (jv/rec (when-let [p (record value)] (get p "data")))]
       (let [nes (fn [k] (jv/nes (get data k)))]
         (case label
           "music" (some? (nes "audio"))
           "video" (some? (nes "video"))
           "image" (or (some? (nes "url")) (some? (nes "image_url")))
           true))))))

(defn minimax-body
  "The MiniMax music_generation request for an OpenAI-shaped body."
  [body]
  (let [model (let [m (get body "model")] (if (string? m) m ""))
        minimax-model (-> model
                          (str/replace #"(?i)^MiniMax-music-" "music-")
                          (str/replace #"(?i)-highspeed$" ""))]
    (apply array-map
           (concat ["model" minimax-model "output_format" "hex"]
                   (when (string? (get body "prompt")) ["prompt" (get body "prompt")])
                   (when (string? (get body "lyrics")) ["lyrics" (get body "lyrics")])
                   ["audio_setting" (array-map "sample_rate" (let [v (get body "sample_rate")] (if (number? v) v 44100))
                                               "bitrate" (let [v (get body "bitrate")] (if (number? v) v 256000))
                                               "format" (let [v (get body "audio_format")] (if (string? v) v "mp3")))]
                   (when (boolean? (get body "lyrics_optimizer")) ["lyrics_optimizer" (get body "lyrics_optimizer")])
                   (when (boolean? (get body "is_instrumental")) ["is_instrumental" (get body "is_instrumental")])))))

(defn musicgen-body [prompt body]
  (array-map "prompt" prompt "duration" (let [d (get body "duration")] (if (number? d) d 30))))

(defn entry-id [tool-call-id label model now-ms]
  (or tool-call-id (str label ":" model ":" now-ms)))

(defn looks-hex? [s] (and (some? (re-matches #"[0-9a-fA-F]+" s)) (even? (count s))))

(defn saved-file-path [entry-id ext]
  (str saved-dir "/" (str/replace entry-id #"[:/]" "-") "." ext))

(defn audio-string
  "The non-empty audio string in a payload's data field, else nil."
  [parsed]
  (let [data (record (when (record parsed) (get parsed "data")))]
    (jv/nes (when data (get data "audio")))))

(defn stripped-event-payload
  "The payload recorded in the event store: the parsed answer with the audio
  replaced by a note of where its bytes were saved."
  [parsed file-path n-bytes encoding]
  (let [data (get parsed "data")]
    (assoc (into (array-map) parsed)
           "data" (assoc (into (array-map) data) "audio"
                         (str "[STRIPPED: " n-bytes " bytes saved to " file-path
                              (when encoding (str " (" encoding ")")) "]"))
           "_savedPath" file-path
           "_savedBytes" n-bytes)))

(defn musicgen-answer [raw-audio data duration file-path n-bytes]
  (array-map "status" "success"
             "data" (array-map "audio" raw-audio "format" "wav"
                               "duration" (jv/first-non-nil (get data "duration") duration)
                               "sample_rate" (jv/first-non-nil (get data "sample_rate") 32000))
             "_savedPath" file-path "_savedBytes" n-bytes))

(defn upstream-attempt-status
  "[status error-text] after an upstream attempt: a logical failure turns a 2xx
  into a 502 with `failure-prefix`'d text."
  [status text logical-failure failure-prefix]
  (if logical-failure
    [502 (str failure-prefix logical-failure)]
    [status text]))

(defn blaze-final-error [last-status last-error label]
  {:status (if (pos? last-status) last-status 502)
   :message (str "BlazeAPI " label " generation failed: " last-error)})

(defn blaze-respond?
  "Reply with this attempt's answer rather than trying the next account?"
  [logical-failure status n-accounts]
  (and (not logical-failure) (or (< status 400) (= 1 n-accounts))))

(defn preview [text] (subs text 0 (min 500 (count text))))
