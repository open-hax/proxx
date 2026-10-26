(ns proxx.web.update-test
  (:require [cljs.test :refer [deftest is testing]]
            [proxx.web.api :as api]
            [proxx.web.pages.tools :as tools]
            [proxx.web.shell :as shell]
            [proxx.web.storage :as storage]
            [proxx.web.update :as u]))

(defn- boot [& [{:keys [stored token path] :or {stored {} token "" path "/"}}]]
  (u/init-db {:stored stored :token token :path path}))

(defn- step [db event] (u/handle db event))

(deftest boot-and-onboarding
  (is (true? (get-in (boot) [:shell :show-onboarding?])))
  (is (false? (get-in (boot {:token "t"}) [:shell :show-onboarding?])))
  (is (false? (get-in (boot {:stored {storage/ls-onboarded "true"}}) [:shell :show-onboarding?])))
  (is (= "monokai" (shell/theme (boot {:stored {storage/ls-theme "bogus"}}))))
  (is (= "night-owl" (shell/theme (boot {:stored {storage/ls-theme "night-owl"}})))))

(deftest app-started-loads-settings-and-enters-page
  (let [[_ fx*] (step (boot {:path "/tools"}) [:app/started])]
    (is (= [:http (dissoc (api/get-proxy-ui-settings) :decode)]
           (let [[k req] (first fx*)] [k (dissoc req :decode)])))
    (is (= :http-all (first (second fx*))))))

(deftest token-save-flow
  (let [db (boot)
        [db] (step db [:shell/token-input "  abc "])
        [db fx*] (step db [:shell/save-token])]
    (is (= "abc" (get-in db [:shell :saved-token])))
    (is (true? (get-in db [:shell :show-saved?])))
    (is (= [[:token/save "abc"] [:dispatch-later 2000 [:shell/hide-saved]]] fx*))
    (is (= "Token saved in browser storage." (:hint (shell/view-model db))))
    (let [[db] (step db [:shell/hide-saved])]
      (is (= "Token is stored for this browser." (:hint (shell/view-model db)))))
    (let [[db] (step db [:shell/token-input "other"])]
      (is (= "Unsaved changes." (:hint (shell/view-model (assoc-in db [:shell :show-saved?] false))))))
    (is (= "No token set (works only if proxy allows unauthenticated access)."
           (:hint (shell/view-model (boot)))))))

(deftest fast-mode-optimistic-and-reverts
  (let [db (boot)
        [db fx*] (step db [:shell/fast-toggle true])]
    (is (true? (get-in db [:shell :fast-mode?])))
    (is (true? (get-in db [:shell :fast-saving?])))
    (is (= {:fastMode true} (:body (second (first fx*)))))
    (let [[ok] (step db [:shell/fast-saved {:fastMode true}])]
      (is (= "Fast mode enabled for the current tenant." (get-in ok [:shell :fast-message])))
      (is (false? (get-in ok [:shell :fast-saving?]))))
    (let [[bad] (step db [:shell/fast-failed true "nope"])]
      (is (false? (get-in bad [:shell :fast-mode?])) "reverted")
      (is (= "nope" (get-in bad [:shell :fast-message]))))))

(deftest onboarding-dismiss
  (let [[db fx*] (step (boot) [:shell/dismiss-onboarding])]
    (is (false? (get-in db [:shell :show-onboarding?])))
    (is (= [[:storage/write-raw storage/ls-onboarded "true"]] fx*))
    (is (= "Skip for now" (:onboarding-cta (shell/view-model (boot))))))
  (let [[db] (step (boot) [:shell/token-input " k "])
        [db fx*] (step db [:shell/dismiss-onboarding])]
    (is (= "Save & Continue" (:onboarding-cta (shell/view-model (assoc-in (boot) [:shell :token-input] "k")))))
    (is (= [:token/save "k"] (second fx*)))
    (is (= "k" (get-in db [:shell :saved-token])))))

(deftest navigation
  (let [db (boot)
        [db fx*] (step db [:route/navigate "/tools"])]
    (is (= :tools (get-in db [:route :page])))
    (is (= [:nav/push "/tools"] (first fx*)))
    (is (some #(= [:interval/stop :dashboard] %) fx*) "leaving the dashboard stops its poll")
    (is (some #(= :http-all (first %)) fx*)))
  (testing "popstate does not push"
    (let [[_ fx*] (step (boot) [:route/changed "/tools"])]
      (is (not-any? #(= :nav/push (first %)) fx*)))))

(deftest unknown-events-are-ignored
  (let [db (boot)] (is (= [db []] (step db [:nope/never])))))

(deftest tools-model-flow
  (let [db (boot {:path "/tools" :stored {storage/ls-tools-model "my-model"}})
        [db fx*] (step db [:route/changed "/tools"])]
    (is (= "my-model" (tools/model db)))
    (is (= "/api/v1/tools?model=my-model" (:path (first (second (first fx*)))))))
  (let [db (boot)
        [db fx*] (step db [:tools/model-changed "  "])]
    (is (= [storage/ls-tools-model "  "] (rest (first fx*))))
    (is (= "/api/v1/tools?model=gpt-5.3-codex" (:path (first (second (second fx*))))) "blank falls back")
    (testing "stale responses for another model are ignored"
      (let [[db1] (step db [:tools/loaded "other" [[{:id "x"}] []]])
            [db2] (step db [:tools/loaded "gpt-5.3-codex" [[{:id "x" :description "d" :enabled true}] []]])]
        (is (= [] (:tools (get-in db1 [:pages :tools]))))
        (is (= "enabled" (-> (tools/view-model db2) :tools first :badge-text)))))))

(deftest tools-view-model
  (let [db (-> (boot)
               (assoc-in [:pages :tools :tools] [{:id "a" :description "d" :enabled false}])
               (assoc-in [:pages :tools :servers] [{:id "s" :script "node x" :port 8799 :sourceFile "f" :running false}
                                                    {:id "t" :script "y" :running true}]))
        vm (tools/view-model db)]
    (is (= {:id "a" :description "d" :card-variant "outlined" :badge-variant "warning" :badge-text "disabled"}
           (first (:tools vm))))
    (is (= {:id "s" :badge-variant "default" :badge-text "seeded" :cwd-line "cwd: (none)"
            :script-line "script: node x" :port-line "port: 8799" :source-file "f"}
           (first (:servers vm))))
    (is (= "running" (:badge-text (second (:servers vm)))))
    (is (nil? (:port-line (second (:servers vm)))))))
