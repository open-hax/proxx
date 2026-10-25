(ns proxx.json
  "Platform JSON at the edge of otherwise pure code.

  Wire payloads are string-keyed data end to end: provider fields we do not
  understand must survive translation untouched, so they are never keywordized.
  Only the ClojureScript runtime ships an implementation; the JVM branch fails
  loudly instead of silently diverging.")

(defn parse
  "Parse a JSON string to string-keyed data. Throws on malformed input."
  [s]
  #?(:cljs (js->clj (js/JSON.parse s))
     :clj (throw (UnsupportedOperationException. "proxx.json/parse requires the ClojureScript runtime"))))

(defn write
  "Serialize string-keyed data to a JSON string."
  [x]
  #?(:cljs (js/JSON.stringify (clj->js x))
     :clj (throw (UnsupportedOperationException. "proxx.json/write requires the ClojureScript runtime"))))
