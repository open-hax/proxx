(ns proxx.runtime.github-allowlist
  "The GitHub login allowlist (src/lib/auth/github-allowlist.ts): a table of
  lowercase logins. Statements are the persisted contract of `proxx.db.schema`;
  login normalisation is the only decision, and it is trim + lowercase."
  (:require [proxx.runtime.db-schema :as db-schema]))

(defn- normalize [login] (.toLowerCase (.trim (str login))))

(defn create-github-allowlist-js
  "An allowlist over `sql` (a postgres.js client)."
  [^js sql]
  #js {"init" (fn ^:async init []
                (await (.unsafe sql (db-schema/sql-statement-js "CREATE_GITHUB_ALLOWLIST_TABLE")))
                js/undefined)
       "allowsUser" (fn ^:async allows-user [login]
                      (let [rows (await (.unsafe sql "SELECT 1 FROM github_allowlist WHERE login = $1" #js [(normalize login)]))]
                        (pos? (.-length rows))))
       "addAllowedUser" (fn ^:async add-allowed-user [login]
                          (await (.unsafe sql "INSERT INTO github_allowlist (login) VALUES ($1) ON CONFLICT (login) DO NOTHING" #js [(normalize login)]))
                          js/undefined)
       "removeAllowedUser" (fn ^:async remove-allowed-user [login]
                             (await (.unsafe sql "DELETE FROM github_allowlist WHERE login = $1" #js [(normalize login)]))
                             js/undefined)
       "getAllowedUsers" (fn ^:async get-allowed-users []
                           (let [rows (await (.unsafe sql "SELECT login FROM github_allowlist ORDER BY login"))]
                             (.map rows (fn [^js row] (.-login row)))))})
