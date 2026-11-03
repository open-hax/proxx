(ns proxx.session.store-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.session.store :as s]))

(defn- env []
  (let [t (atom 1000) u (atom 0)]
    {:now (fn [] (swap! t inc)) :uuid (fn [] (str "u" (swap! u inc)))}))

(deftest summarize-and-titles
  (is (= "a b c" (s/summarize-message "  a \n\t b   c ")))
  (is (= (str (apply str (repeat 117 "x")) "...") (s/summarize-message (apply str (repeat 130 "x")))))
  (is (= (apply str (repeat 120 "x")) (s/summarize-message (apply str (repeat 120 "x")))))
  (is (= "New chat" (s/normalize-title "   ")))
  (is (= "New chat" (s/normalize-title nil)))
  (is (= "Hi" (s/normalize-title " Hi "))))

(deftest hydrate-tolerates-junk
  (let [db (s/hydrate {"sessions" ["x" nil 5
                                   {"id" "s1" "title" " T " "createdAt" 10 "prompt_cache_key" " k "
                                    "messages" [nil {"id" "" "role" "bogus" "content" 5} {"content" "zz"}]
                                    "forkedFromMessageId" 5}]}
                      (env))
        [session] (:sessions db)]
    (is (= 1 (count (:sessions db))))
    (is (= {:id "s1" :title "T" :created-at 10 :updated-at 10 :prompt-cache-key "k"} (select-keys session [:id :title :created-at :updated-at :prompt-cache-key])))
    (is (not (contains? session :forked-from-message-id)) "non-string fork pointers are dropped")
    (is (= [["u1" "user" ""] ["u2" "user" "zz"]] (mapv (juxt :id :role :content) (:messages session))))
    (is (= s/empty-db (s/hydrate {"sessions" "x"} (env))))
    (is (= s/empty-db (s/hydrate [1] (env))))))

(deftest intentional-divergence-arrays-are-not-records
  ;; The TypeScript store accepted `[]` as a record (isRecord([]) is true) and
  ;; minted a blank session / blank message from it. A persisted array is
  ;; corruption, not a session: it is dropped.
  (let [db (s/hydrate {"sessions" [[] {"id" "s" "messages" [[] {"id" "m" "content" "c"}]}]} (env))]
    (is (= ["s"] (mapv :id (:sessions db))))
    (is (= ["m"] (mapv :id (:messages (first (:sessions db))))))))

(deftest lifecycle
  (let [e (env)
        [a db] (s/create-session s/empty-db "  " e)
        [{:keys [session message]} db] (s/append-message db (:id a) {:role "user" :content "  hello   world "} e)
        [_ db] (s/append-message db (:id a) {:role "assistant" :content "hi" :model "m"} e)
        [fork db] (s/fork-session db (:id a) {} e)]
    (is (= "New chat" (:title a)))
    (is (= "hello world" (:title session)) "the first user message titles an untitled session")
    (is (= (:created-at message) (:updated-at session)))
    (is (= "Fork of hello world" (:title fork)))
    (is (= 2 (count (:messages fork))))
    (is (not= (map :id (:messages fork)) (map :id (:messages (s/find-session db (:id a))))) "forks mint fresh ids")
    (is (= (:id a) (:forked-from-session-id fork)))
    (testing "fork up to a message"
      (let [mid (:id message)
            [f1 _] (s/fork-session db (:id a) {:message-id mid} e)]
        (is (= 1 (count (:messages f1))))
        (is (= mid (:forked-from-message-id f1)))))
    (testing "failures are domain errors with the TS messages"
      (is (thrown-with-msg? js/Error #"Session not found: nope" (s/append-message db "nope" {:role "user" :content "x"} e)))
      (is (thrown-with-msg? js/Error #"Message not found in session: zz" (s/fork-session db (:id a) {:message-id "zz"} e)))
      (is (thrown-with-msg? js/Error #"Message not found in session: null" (s/fork-session db (:id a) {:message-id nil} e))))))

(deftest append-only-touches-the-first-duplicate-id
  (let [e (env)
        db {:sessions [{:id "d" :title "A" :created-at 1 :updated-at 1 :prompt-cache-key "k" :messages []}
                       {:id "d" :title "B" :created-at 1 :updated-at 1 :prompt-cache-key "k" :messages []}]}
        [_ db'] (s/append-message db "d" {:role "tool" :content "x"} e)]
    (is (= [1 0] (mapv (comp count :messages) (:sessions db'))))))

(deftest search
  (let [e (env)
        db {:sessions [{:id "s" :title "Alpha" :created-at 1 :updated-at 1 :prompt-cache-key "k"
                        :messages [{:id "m1" :role "user" :content "beta here" :created-at 5}
                                   {:id "m2" :role "user" :content "   " :created-at 6}
                                   {:id "m3" :role "user" :content "xx beta" :created-at 9}
                                   {:id "m4" :role "user" :content "beta again" :created-at 8}]}]}]
    (is (= ["m4" "m1" "m3"] (mapv :message-id (s/search-lexical db " BETA " 10)))
        "earlier hit first; ties newest first")
    (is (= ["m4" "m1"] (mapv :message-id (s/search-lexical db "beta" 2))))
    (is (= ["m4" "m1"] (mapv :message-id (s/search-lexical db "beta" 2.5))) "fractional limits truncate like slice")
    (is (= [] (s/search-lexical db "beta" js/NaN)))
    (is (= 1 (count (s/search-lexical db "beta" -3))) "limit is clamped to at least 1")
    (is (= [] (s/search-lexical db "   " 5)))
    (is (= 3 (count (s/search-documents db))) "blank messages are not documents")
    (is (some? e))))
