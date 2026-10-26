(ns proxx.web.storage
  "localStorage keys and the validators for values read from them."
  (:require [clojure.string :as str]))

(def ls-theme "open-hax-proxy.ui.theme")
(def ls-onboarded "open-hax-proxy.ui.onboarded")
(def ls-tools-model "open-hax-proxy.ui.tools.model")
(def ls-images-model "open-hax-proxy.ui.images.model")
(def ls-images-prompt "open-hax-proxy.ui.images.prompt")
(def ls-chat-model "open-hax-proxy.ui.chat.model")
(def ls-chat-active-session "open-hax-proxy.ui.chat.activeSessionId")

(defn validate-string [v] (when (string? v) v))

(defn validate-theme [v]
  (when (string? v)
    (let [t (str/trim v)]
      (when (#{"monokai" "night-owl"} t) t))))

(defn stored-value
  "Validated stored value or `default` (mirrors `useStoredState`: an invalid
  stored value falls back to the default)."
  [stored k default validate]
  (let [v (validate (get stored k))]
    (if (nil? v) default v)))

(def all-keys
  [ls-theme ls-onboarded ls-tools-model ls-images-model ls-images-prompt ls-chat-model ls-chat-active-session])

(def raw-keys
  "Keys stored as bare strings rather than JSON."
  #{ls-onboarded})
