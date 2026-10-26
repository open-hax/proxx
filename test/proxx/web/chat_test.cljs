(ns proxx.web.chat-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.web.pages.chat :as chat]
            [proxx.web.storage :as storage]
            [proxx.web.update :as u]))

(defn- boot [& [stored]] (u/init-db {:stored (or stored {}) :token "t" :path "/chat"}))
(defn- slice [db] (get-in db [:pages :chat]))
(defn- http-paths [fx*] (keep #(when (= :http (first %)) (:path (second %))) fx*))
(defn- first-http [fx*] (second (first (filter #(= :http (first %)) fx*))))

(deftest content-extraction
  (is (= "hi" (chat/first-text-content "hi")))
  (is (= "ab" (chat/first-text-content ["a" {"type" "text" "text" "b"} {"type" "reasoning" "text" "no"} {"x" 1} 5 nil])))
  (is (= "" (chat/first-text-content nil)))
  (is (= "" (chat/first-text-content {"text" "x"}))))

(deftest reasoning-extraction
  (is (= "d" (chat/first-reasoning-content {"reasoning_content" "d" "reasoning" "r"})))
  (is (= "r" (chat/first-reasoning-content {"reasoning" "r"})))
  (is (= "ab" (chat/first-reasoning-content {"content" [{"type" "thinking" "text" "a"} {"type" "text" "text" "no"} {"type" "summary_text" "text" "b"}]})))
  (is (= "" (chat/first-reasoning-content nil)))
  (is (= "" (chat/first-reasoning-content {"content" "plain"}))))

(deftest completion-parsing
  (is (= {:content "Hello" :reasoning "why"}
         (chat/parse-completion {"choices" [{"message" {"content" "Hello" "reasoning_content" "why"}}]})))
  (is (= {:content "(Reasoning trace only)" :reasoning "why"}
         (chat/parse-completion {"choices" [{"message" {"content" "" "reasoning" "why"}}]})))
  (is (= {:content "(No text returned)" :reasoning nil} (chat/parse-completion {})))
  (is (= {:content "(No text returned)" :reasoning nil} (chat/parse-completion {"choices" []})))
  (is (= {:content "(No text returned)" :reasoning nil} (chat/parse-completion {"choices" [nil]}))))

(deftest request-and-widget-shaping
  (is (= {:model "m" :stream false :prompt_cache_key "k"
          :messages [{:role "user" :content "a"} {:role "assistant" :content "b"}]}
         (chat/completion-request-body "m" "k" [{:role "user" :content "a"} {:role "tool" :content "t"} {:role "assistant" :content "b"}])))
  (is (= "&lt;b&gt; &amp; &quot;x&quot; &#39;y&#39;" (chat/escape-html "<b> & \"x\" 'y'")))
  (is (= "m\n\n[Reasoning trace]\nr" (chat/copy-text {:content "m" :reasoningContent "r"})))
  (is (= "m" (chat/copy-text {:content "m" :reasoningContent "  "})))
  (is (= [{:id "1" :role "user" :content "&lt;" :actions ["Copy" "Fork here"] :timestamp-ms 5 :metadata {:model "m"}}
          {:id "2" :role "assistant" :content "x" :actions ["Copied" "Fork here"] :reasoningContent "&amp;"}]
         (chat/ui-messages [{:id "1" :role "user" :content "<" :createdAt 5 :model "m"}
                            {:id "0" :role "tool" :content "skip"}
                            {:id "2" :role "assistant" :content "x" :reasoningContent "&"}]
                           "2"))))

(deftest initial-load-picks-stored-or-first-session
  (let [sessions [{:id "a" :title "A"} {:id "b" :title "B"}]]
    (let [[_ fx*] (u/handle (boot {storage/ls-chat-active-session "b"}) [:route/changed "/chat"])]
      (is (= ["/api/v1/sessions" "/v1/models"] (http-paths fx*))))
    (let [db (first (u/handle (boot {storage/ls-chat-active-session "b"}) [:route/changed "/chat"]))
          [_ fx*] (u/handle db [:chat/sessions-loaded :initial sessions])]
      (is (= ["/api/v1/sessions/b"] (http-paths fx*))))
    (let [[_ fx*] (u/handle (boot {storage/ls-chat-active-session "gone"}) [:chat/sessions-loaded :initial sessions])]
      (is (= ["/api/v1/sessions/a"] (http-paths fx*))))
    (let [[db fx*] (u/handle (boot) [:chat/session-loaded {:id "a" :title "A" :messages []}])]
      (is (= "a" (:id (:active (slice db)))))
      (is (= [storage/ls-chat-active-session "a"] (rest (first fx*)))))
    (let [db (first (u/handle (boot) [:chat/session-loaded {:id "a" :messages []}]))
          [_ fx*] (u/handle db [:chat/sessions-loaded :refresh sessions])]
      (is (empty? fx*) "no auto-select when a session is active"))))

(deftest models
  (let [[db] (u/handle (boot) [:chat/models-loaded []])]
    (is (= chat/default-models (:model-options (slice db)))))
  (let [[db] (u/handle (boot {storage/ls-chat-model "custom"}) [:chat/models-loaded ["x" "y"]])
        vm (chat/view-model db)]
    (is (= ["custom" "x" "y"] (:models vm)) "current model stays selectable"))
  (let [[db fx*] (u/handle (boot {storage/ls-chat-model "  "}) [:chat/models-loaded ["x" "y"]])]
    (is (= "x" (chat/model db)))
    (is (= [[:storage/write storage/ls-chat-model "x"]] fx*))))

(deftest send-pipeline
  (let [active {:id "s1" :title "T" :messages []}
        db (first (u/handle (boot {storage/ls-chat-model "m"}) [:chat/session-loaded active]))]
    (testing "blank or busy sends are ignored"
      (is (= [db []] (u/handle db [:chat/send "  "]))))
    (let [[db1 fx1] (u/handle db [:chat/send " hello "])
          ctx {:text "hello" :model "m" :session-id "s1"}]
      (is (true? (:sending? (slice db1))))
      (is (= {:method :post :path "/api/v1/sessions/s1/messages" :body {:role "user" :content "hello" :model "m"}}
             (dissoc (first-http fx1) :decode)))
      (is (= [db1 []] (u/handle db1 [:chat/send "again"])) "no concurrent sends")
      (let [[_ fx2] (u/handle db1 [:chat/send-user-added ctx {}])]
        (is (= ["/api/v1/sessions/s1"] (http-paths fx2))))
      (let [latest {:id "s1" :messages [{:role "user" :content "hello"}]}
            [_ fx3] (u/handle db1 [:chat/send-got-latest ctx latest])]
        (is (= ["/api/v1/sessions/s1/cache-key"] (http-paths fx3)))
        (let [[_ fx4] (u/handle db1 [:chat/send-got-key ctx latest "ck"])]
          (is (= {:model "m" :stream false :prompt_cache_key "ck" :messages [{:role "user" :content "hello"}]}
                 (:body (first-http fx4)))))
        (let [[_ fx5] (u/handle db1 [:chat/send-completed ctx {"choices" [{"message" {"content" "yo" "reasoning_content" "r"}}]}])]
          (is (= {:role "assistant" :content "yo" :reasoningContent "r" :model "m"} (:body (first-http fx5))))))
      (let [[db6 fx6] (u/handle db1 [:chat/send-updated {:id "s1" :messages [{:id "m1"}]}])]
        (is (= 1 (count (:messages (:active (slice db6))))))
        (is (= ["/api/v1/sessions"] (http-paths fx6)))
        (is (true? (:sending? (slice db6))) "still sending until the list refreshes")
        (let [[db7] (u/handle db6 [:chat/sessions-loaded :after-send [{:id "s1"}]])]
          (is (false? (:sending? (slice db7))))))
      (let [[db8] (u/handle db1 [:chat/send-failed "boom"])]
        (is (= "boom" (:error (slice db8))))
        (is (false? (:sending? (slice db8))))))
    (testing "without an active session one is created first"
      (let [db0 (boot {storage/ls-chat-model "m"})
            [_ fx] (u/handle db0 [:chat/send "hi"])]
        (is (= {:method :post :path "/api/v1/sessions" :body {:title "New chat"}} (dissoc (first-http fx) :decode)))
        (let [[_ fx2] (u/handle db0 [:chat/send-session-created {:text "hi" :model "m"} {:id "n1"}])]
          (is (= [:storage/write storage/ls-chat-active-session "n1"] (first fx2)))
          (is (= ["/api/v1/sessions/n1/messages"] (http-paths fx2))))))))

(deftest search-copy-fork
  (let [[db fx*] (u/handle (boot) [:chat/search])]
    (is (empty? fx*))
    (is (= "none" (:search-source (slice db)))))
  (let [db (first (u/handle (boot) [:chat/search-query "  cats "]))
        [_ fx*] (u/handle db [:chat/search])]
    (is (= {:query "cats" :limit 10} (:body (first-http fx*)))))
  (let [[db] (u/handle (boot) [:chat/search-loaded {:source "fts" :results [{:sessionId "a" :messageId "m" :sessionTitle "T" :content "c"}]}])]
    (is (= [{:key "a:m" :session-id "a" :title "T" :content "c"}] (get-in (chat/view-model db) [:search :results]))))
  (let [db (first (u/handle (boot) [:chat/session-loaded {:id "s" :title "T" :forkedFromSessionId "p"
                                                          :messages [{:id "m1" :role "user" :content "c" :reasoningContent "r"}]}]))]
    (is (= "Forked from p" (:description (chat/view-model db))))
    (let [[_ fx*] (u/handle db [:chat/message-action "Copy" "m1"])]
      (is (= [:clipboard/write "c\n\n[Reasoning trace]\nr" [:chat/copied "m1"] [:chat/failed]] (first fx*))))
    (let [[db2 fx2] (u/handle db [:chat/copied "m1"])]
      (is (= [[:dispatch-later 1200 [:chat/clear-copied "m1"]]] fx2))
      (is (= "Copied" (-> (chat/view-model db2) :messages first :actions first)))
      (is (nil? (:copied-id (slice (first (u/handle db2 [:chat/clear-copied "m1"]))))))
      (is (= "m1" (:copied-id (slice (first (u/handle db2 [:chat/clear-copied "other"])))))))
    (let [[_ fx*] (u/handle db [:chat/message-action "Fork here" "m1"])]
      (is (= {:messageId "m1"} (:body (first-http fx*))))
      (is (= "/api/v1/sessions/s/fork" (:path (first-http fx*)))))
    (is (empty? (second (u/handle (boot) [:chat/fork nil]))) "no active session, no fork")))

(deftest empty-states
  (is (= "No session selected" (:empty-title (chat/view-model (boot)))))
  (is (= "No messages yet" (:empty-title (chat/view-model (first (u/handle (boot) [:chat/session-loaded {:id "s" :messages []}]))))))
  (is (= "No messages yet" (-> (chat/view-model (first (u/handle (boot) [:chat/sessions-loaded :refresh [{:id "a" :title "A" :lastMessagePreview ""}]])))
                               :sessions first :preview))))
