(ns proxx.http.media-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.http.media :as m]))

(def parse #(js->clj (js/JSON.parse %)))

(deftest blaze-failures
  (is (= "status=failed; boom" (m/blaze-logical-failure parse "{\"status\":\"FAILED\",\"error\":\"boom\"}")))
  (is (= "status=error; msg" (m/blaze-logical-failure parse "{\"status\":\"error\",\"message\":\"msg\"}")))
  (is (= "status=canceled" (m/blaze-logical-failure parse "{\"status\":\"canceled\"}")))
  (is (nil? (m/blaze-logical-failure parse "{\"status\":\"ok\"}")))
  (is (nil? (m/blaze-logical-failure parse "not json")))
  (is (nil? (m/blaze-logical-failure parse "[1]"))))

(deftest minimax-failures
  (is (= "MiniMax error 1004: unknown error" (m/minimax-logical-failure parse "{\"base_resp\":{\"status_code\":1004}}")))
  (is (= "MiniMax error 7: nope" (m/minimax-logical-failure parse "{\"base_resp\":{\"status_code\":7,\"status_msg\":\"nope\"}}")))
  (is (= "MiniMax generation incomplete (status=1)" (m/minimax-logical-failure parse "{\"data\":{\"status\":1}}")))
  (is (nil? (m/minimax-logical-failure parse "{\"base_resp\":{\"status_code\":0},\"data\":{\"status\":2}}"))))

(deftest media-output
  (is (m/valid-media-output? parse "{\"data\":{\"audio\":\"x\"}}" "music"))
  (is (not (m/valid-media-output? parse "{\"data\":{\"audio\":\"\"}}" "music")))
  (is (m/valid-media-output? parse "{\"data\":{\"video\":\"v\"}}" "video"))
  (is (m/valid-media-output? parse "{\"data\":{}}" "tts") "other kinds only need a data object")
  (is (m/valid-media-output? parse "{\"data\":[]}" "tts") "an array counts as an object, as in the original")
  (is (not (m/valid-media-output? parse "{\"x\":1}" "tts")))
  (is (not (m/valid-media-output? parse "nope" "music"))))

(deftest minimax-request
  (let [b (m/minimax-body {"model" "MiniMax-music-2.0-highspeed" "prompt" "p" "lyrics" "l" "sample_rate" 48000
                           "audio_format" "wav" "is_instrumental" true})]
    (is (= ["model" "output_format" "prompt" "lyrics" "audio_setting" "is_instrumental"] (keys b)))
    (is (= "music-2.0" (get b "model")))
    (is (= {"sample_rate" 48000 "bitrate" 256000 "format" "wav"} (into {} (get b "audio_setting"))))))

(deftest files-and-events
  (is (= "/app/data/blaze_generated/music-m-1.mp3" (m/saved-file-path "music:m/1" "mp3")))
  (is (m/looks-hex? "494433"))
  (is (not (m/looks-hex? "49443")))
  (is (not (m/looks-hex? "zz")))
  (let [p (m/stripped-event-payload {"data" {"audio" "AAAA" "n" 1}} "/f.mp3" 3 "hex")]
    (is (= "[STRIPPED: 3 bytes saved to /f.mp3 (hex)]" (get-in p ["data" "audio"])))
    (is (= 1 (get-in p ["data" "n"])))
    (is (= 3 (get p "_savedBytes")))))

(deftest blaze-loop-decisions
  (is (= [502 "BlazeAPI music returned failed payload: x"] (m/upstream-attempt-status 200 "t" "x" "BlazeAPI music returned failed payload: ")))
  (is (= [429 "t"] (m/upstream-attempt-status 429 "t" nil "p")))
  (is (m/blaze-respond? nil 200 3))
  (is (not (m/blaze-respond? nil 500 3)))
  (is (m/blaze-respond? nil 500 1) "a lone account answers with whatever it got")
  (is (not (m/blaze-respond? "x" 200 1)))
  (is (= {:status 502 :message "BlazeAPI tts generation failed: e"} (m/blaze-final-error 0 "e" "tts")))
  (is (= 429 (:status (m/blaze-final-error 429 "e" "tts")))))
