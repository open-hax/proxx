(ns proxx.db.schema-test
  (:require ["node:crypto" :as crypto]
            [cljs.test :refer [deftest is testing]]
            [proxx.db.schema :as schema]
            [proxx.runtime.db-schema :as edge]))

(defn- sha256 [text] (-> (.createHash crypto "sha256") (.update text) (.digest "hex")))

;; The SQL texts are a persisted contract (they run against deployed databases).
;; These digests were taken from the original src/lib/db/schema.ts; a change to a
;; statement must be a deliberate migration, never an edit.
(def ^:private statement-digests
  {
   "CREATE_ACCOUNT_HEALTH_TABLE" "4e18467fc12bc55f1edb0358348c937e2e7cc34ab771e7f3dbb6404a40edb706"
   "CREATE_ACCOUNT_HEALTH_INDEX" "7f38648008e32c8664bb5bdf9ebcfe5cd1fec4f8dfafed35f8322ca31143c2c8"
   "CREATE_TENANTS_TABLE" "32aac4e5f4ee9f637c7b08157babc829df998540698193adb6b7564af9df2af2"
   "CREATE_USERS_TABLE" "b84e34020abe6d144662ca9d1a0c84983006bafa777567a4d6ff0156b56fdced"
   "CREATE_TENANT_MEMBERSHIPS_TABLE" "ea10b9fa35f3befce0c307e6f601314e1d1052ac12e0238bd87b6b394c96b728"
   "CREATE_TENANT_API_KEYS_TABLE" "88198809be1308e861b13a6bfa88f4eaefff639fe8dbc9841795119b535fa7c2"
   "CREATE_TENANT_API_KEYS_TENANT_INDEX" "49d4c8b4f41935874158127bc7d815caddd4467b4aa203df9430e9ba1883a35b"
   "CREATE_TENANT_API_KEYS_HASH_INDEX" "3d71de711a8f74f1613e32a7f9df57a9d3142f1cb450f472f1d788f7e85aab45"
   "CREATE_TENANT_PROVIDER_POLICIES_TABLE" "94500907e83279e5b4c8fc52dd8aa1a83a96e8a8c203330844d72be23a29586f"
   "CREATE_TENANT_PROVIDER_POLICIES_OWNER_INDEX" "0de4a9d055457f963e450144eb384de805b06e1b88b4cf886b95ad6bf74990de"
   "CREATE_PROVIDERS_TABLE" "e3753597b5a95a6daf89d73e471b32c3bdf10ffff8357b9bd67b130e0f6ae354"
   "CREATE_ACCOUNTS_TABLE" "771ccb6eaadfa9cec966c889b5d7cba9508a9c7af596000a728074431cbcae52"
   "CREATE_ACCOUNTS_INDEX" "c4dcc9749a3f75e552948c34b6635404550cd6a3adb2c1be2aff55bb815e2d6d"
   "CREATE_COOLDOWN_TABLE" "3d1182a9c0f6fe85df8bd21758457e1ac7338411a2569bc6dde29cca9cb7d26c"
   "CREATE_PROMPT_AFFINITY_TABLE" "e72625e56d4206f60593a8ac7ab0b66e927d073664af32551143af8ccc245de0"
   "CREATE_SESSIONS_TABLE" "6b5e788f9673126e8b78f61e5c77635ef8267089aa9aa07bfd651406298b14bd"
   "CREATE_ACCESS_TOKENS_TABLE" "a9bb139ad61de4a71e062497b79a8fbd4c501091bec1b1cd341422d8573041de"
   "CREATE_REFRESH_TOKENS_TABLE" "1c2b23594927d05960cdd4df29dbe5aeee6943f53ad448cdac6764a5dbed840c"
   "CREATE_GITHUB_ALLOWLIST_TABLE" "c8bce5f8e32419a5d034a12a6d66ae6865477c7daa74160d2df5fd446edc262c"
   "CREATE_CLIENTS_TABLE" "2032eb8d30e1d21a2fd9b0166f365bc74499a43e705072b05fbe14ee9e3eefa7"
   "CREATE_VERSION_TABLE" "38b9ad56866c0d6e3751d8014dd4460e13ff16e0baabbb2bcc2a693436cb4150"
   "INSERT_VERSION" "31ade37e7e63253ecb6896588fe536a761e8f18ff0065ca4a6c1d454107b59bd"
   "CHECK_VERSION_EXISTS" "09674696f38b85a1cbf552ce1c1bc7d4a1cd451ff25ce48e93d2de1fe6e470de"
   "CREATE_MODELS_TABLE" "9795ce0b057feec78d3323d7e11a14addbb5afa3d7f1b5cd02e964faa5e25d25"
   "CREATE_CONFIG_TABLE" "18c88e992de9e718501886a38b6eb9dbd78e558dddd2d27e5fc5c9a22961edd6"
   "UPSERT_TENANT" "1206682f5c68e235918feccdb368241226de9042cc28a7529b1d9ab2ff541e0a"
   "SELECT_ALL_TENANTS" "008dab18ec07e19a9e26f9904df0277af064e7a5a1250bc5a6584e5d983dea20"
   "UPSERT_USER" "4abd04101ddfd6f1926e63ba0c4c8eb5d27f0d6b8f82ff216cd40d428c6edc33"
   "SELECT_USER_BY_SUBJECT" "63d373e62380d9fa4c9d64f042e5d46bb23a0cb230d697835883be8bfb424ae9"
   "UPSERT_TENANT_MEMBERSHIP" "163b2671caf91aee6909e3df8ff26aa0599465f2bbd9198472bfdf8df9fcf5d2"
   "SELECT_TENANT_MEMBERSHIPS_BY_USER" "99a17ef75fe2e61803dcf8e6d9042a7c3aa2639365f33a1b70a9da7bd785617a"
   "COUNT_TENANT_MEMBERSHIPS_FOR_TENANT" "4997d48fc5a1cf7ce1fbd685a3b2cca7d0e5c95d394210f5be8a962a1e6b728e"
   "SELECT_ACTIVE_TENANT_API_KEY_BY_HASH" "81d1b29b0aeed57d64e80e5a4540ad274914987703a06aacc0cb44f5929eacd1"
   "INSERT_TENANT_API_KEY" "f4cc8e2a3d1aa7f68996b7afc861b0cfe0928aa6b517e00fa6660f9217e75bdd"
   "SELECT_TENANT_API_KEYS_BY_TENANT" "faab3787bab963bb5de35db48babee3973b7d30da8d6b55b74ffdb9057108386"
   "REVOKE_TENANT_API_KEY" "5ed3ae662b5494a883eebe8042baed58620342f4b816253be2245ba7f9320390"
   "TOUCH_TENANT_API_KEY_LAST_USED" "fefbebeebb8118a2295df13b6b85f74ead6e1643dee767c22ec9dc394b79632e"
   "UPSERT_TENANT_PROVIDER_POLICY" "0adb22d0835211fff8333e64680208a788fb251059e0534fcdf8f0b8ae60f1e9"
   "SELECT_TENANT_PROVIDER_POLICY" "829190db72db79e7022c2a5cd2bd374670a8f50bba504968f93974768ae51bd0"
   "SELECT_TENANT_PROVIDER_POLICIES" "d2091342636b3f2f14cd3ec1aa1452414142401478832991671f6fda011ce0de"
   "UPSERT_PROVIDER" "57b0265d4d4add5e189339c100bb9d829d76240f14f3a8e7d6a39cec3d035c77"
   "UPSERT_PROVIDER_WITH_BASE_URL" "85cb03f87cf9b0daea096a13ff495a9a7d8d84e4ac75162c3e5334d6ec037300"
   "SELECT_PROVIDER_BY_ID" "6831f48f3620e362b54ac1f23eee34a393de74a504afe25954c67aa511d0aa58"
   "INSERT_ACCOUNT" "5a660ef41881a3a2543619264fb80d38349f9f94fac327c56f35ce155f5c9dfb"
   "SELECT_ALL_PROVIDERS" "9a3ae33b1ff6150f61e2df6a8dea4187c8f4310e52d3c1ed3ef2b76e31385cd9"
   "SELECT_ACCOUNTS_BY_PROVIDER" "405f6606d51ef52851b0d2413b5f16e668e70d226ca62503ac29eee17d0cff01"
   "SELECT_ALL_ACCOUNTS" "fb0e8db7e509c68b82559836bbcca3d5e88c972a5d425b7a535910fb99c052be"
   "DELETE_ACCOUNT" "7b18dcdf8f53a980dc13ae88e549daf98703bdbeee1da33960d3fa1f5e4fdf04"
   "SET_ACCOUNT_DISABLED" "e7325efcb5a606acb3bdd21f246f5444923e1a858df631db3dc932f9388bc4b0"
   "SELECT_ALL_DISABLED_ACCOUNTS" "815534417d5038289f0e03277c1df66e55ceceb7b4b9f55cd5be63af8b16fa19"
   "SET_COOLDOWN" "6306a125c062444af57e79a297aa3a203a2e8598f58b8bdb2f9dbdd5b016498a"
   "GET_COOLDOWN" "5e0ac5c60ded3fdf23b25075a2c9702de418366502f8d1faff071f338c5f184f"
   "CLEAR_EXPIRED_COOLDOWNS" "6742892f1b4674958ec278ce38437eb075632a93aab2d90c8656b0a893e6baef"
   "SELECT_ALL_ACTIVE_COOLDOWNS" "4b4f7b32deb26f9ff4b23dc386b7117d09387ce761cd15155dcf785a6ca78dad"
   "UPSERT_GITHUB_USER" "cb461c5003b8a6994ca55babc3d293b4bd2ec0b4381bd6fcf4c4cf8b4174460d"
   "DELETE_GITHUB_USER" "9aa3695bf6eaa7fd11b74ec4ae0d94234c43d64cf8ab19c9160a2aa776f29c2d"
   "SELECT_GITHUB_ALLOWLIST" "061303fb7f5c2abcda4fbfe9bdf167c00393aadbe36995e0e0d0a5035c4b0598"
   "IS_GITHUB_USER_ALLOWED" "5a5bd87ae6665e1fc0e457a1e7be632ea6d5290df8cd3c27f8250e1bc1fb6da7"
   "SELECT_ALL_ACCOUNT_HEALTH" "f09286efb1db8d8bd8838c790cdfeba41419a17230d0c2fa11946139ad893523"
   "SELECT_ACCOUNT_HEALTH" "dc8d1268b2d74d1ffc501d5f2513e1d4b1c978f40d0ada0c690690f8fc979433"
   "UPSERT_ACCOUNT_HEALTH_SUCCESS" "65fca86613d4910c70f565f3a0b4a1970c56dab6d7d49a0aebaa7daefce022d6"
   "UPSERT_ACCOUNT_HEALTH_FAILURE" "bdfa881421c7917b235379419a1f6dd9a74d7c8d4f4bc30e973356d6e3ad3fe2"
   "SELECT_ACCOUNT_HEALTH_SCORES" "aaf08562fb735bcaa394396da2cd70257e5129db108ed32f31caf648dc1e79b6"
   "SELECT_PROMPT_AFFINITY" "91c7cd9a11c25114cd05fd68e7b32c79e6e760f46ce0c608e2092c4843e2786e"
   "SELECT_ALL_PROMPT_AFFINITY" "a713ac29a2b8590f4e684fba9f6703cbba4e0eb88cc940c25cbce2e5bcd78200"
   "UPSERT_PROMPT_AFFINITY" "79f9f13f15914dea76a20c243d289e6884ac8cdfb3c3d1b0dd579f6cf2e579f9"
   "DELETE_PROMPT_AFFINITY" "3eeb83a0484ada3bdc2c93a2f3b276ea28dc95dd39eb2f7813c3aecd2d03c080"
   "UPSERT_PROMPT_AFFINITY_PROVISIONAL" "218aaa184af85f68b62d1423ca04cedd567fbc0471d62993123a6c2f11c38e50"
   "UPSERT_PROMPT_AFFINITY_PROMOTE_PROVISIONAL" "90ddbed84000708f1ff09c5583642e5699058af3cf79adea924bdca168eeed98"})

(def ^:private migration-digests
  [[1 "e3753597b5a95a6daf89d73e471b32c3bdf10ffff8357b9bd67b130e0f6ae354"] [1 "771ccb6eaadfa9cec966c889b5d7cba9508a9c7af596000a728074431cbcae52"] [1 "c4dcc9749a3f75e552948c34b6635404550cd6a3adb2c1be2aff55bb815e2d6d"] [1 "3d1182a9c0f6fe85df8bd21758457e1ac7338411a2569bc6dde29cca9cb7d26c"] [1 "6b5e788f9673126e8b78f61e5c77635ef8267089aa9aa07bfd651406298b14bd"] [1 "a9bb139ad61de4a71e062497b79a8fbd4c501091bec1b1cd341422d8573041de"] [1 "1c2b23594927d05960cdd4df29dbe5aeee6943f53ad448cdac6764a5dbed840c"] [1 "c8bce5f8e32419a5d034a12a6d66ae6865477c7daa74160d2df5fd446edc262c"] [1 "2032eb8d30e1d21a2fd9b0166f365bc74499a43e705072b05fbe14ee9e3eefa7"] [1 "38b9ad56866c0d6e3751d8014dd4460e13ff16e0baabbb2bcc2a693436cb4150"] [2 "4e18467fc12bc55f1edb0358348c937e2e7cc34ab771e7f3dbb6404a40edb706"] [2 "7f38648008e32c8664bb5bdf9ebcfe5cd1fec4f8dfafed35f8322ca31143c2c8"] [3 "9795ce0b057feec78d3323d7e11a14addbb5afa3d7f1b5cd02e964faa5e25d25"] [3 "18c88e992de9e718501886a38b6eb9dbd78e558dddd2d27e5fc5c9a22961edd6"] [4 "32aac4e5f4ee9f637c7b08157babc829df998540698193adb6b7564af9df2af2"] [4 "b84e34020abe6d144662ca9d1a0c84983006bafa777567a4d6ff0156b56fdced"] [4 "ea10b9fa35f3befce0c307e6f601314e1d1052ac12e0238bd87b6b394c96b728"] [4 "88198809be1308e861b13a6bfa88f4eaefff639fe8dbc9841795119b535fa7c2"] [4 "49d4c8b4f41935874158127bc7d815caddd4467b4aa203df9430e9ba1883a35b"] [4 "3d71de711a8f74f1613e32a7f9df57a9d3142f1cb450f472f1d788f7e85aab45"] [5 "94500907e83279e5b4c8fc52dd8aa1a83a96e8a8c203330844d72be23a29586f"] [5 "0de4a9d055457f963e450144eb384de805b06e1b88b4cf886b95ad6bf74990de"] [6 "d595cfb06f13abefd5eb168be38881899887174c31c9833b79a399d8f1d47f9a"] [7 "83f688590f35488f00c34cefb4db141bea261ea14f50fe70d63b6a6d30598603"] [8 "e72625e56d4206f60593a8ac7ab0b66e927d073664af32551143af8ccc245de0"]])

(def ^:private resource (edge/load-schema!))

(deftest statement-texts-are-byte-identical-to-the-original
  (is (= (set (keys statement-digests)) (set (keys (:statements resource)))))
  (doseq [[id digest] statement-digests]
    (is (= digest (sha256 (schema/statement resource id))) (str id " changed"))))

(deftest migrations-are-the-original-list
  (is (= migration-digests (mapv (fn [{:keys [version sql]}] [version (sha256 sql)]) (schema/migrations resource))))
  (is (= 8 (schema/schema-version resource)))
  (is (= [] (schema/problems resource))))

(deftest planning
  (testing "only newer migrations are pending, in order"
    (is (= (count (schema/migrations resource)) (count (schema/pending resource 0))))
    (is (= [6 7 8] (mapv :version (schema/pending resource 5))))
    (is (= [] (schema/pending resource 8))))
  (testing "startup re-runs every migration, then records the version"
    (let [{:keys [migrations version-check version-insert]} (schema/startup-plan resource)]
      (is (= (mapv :sql (schema/migrations resource)) migrations))
      (is (= [8] (:params version-check)))
      (is (= [8] (:params version-insert)))
      (is (= (schema/statement resource "CHECK_VERSION_EXISTS") (:sql version-check)))
      (is (= (schema/statement resource "INSERT_VERSION") (:sql version-insert))))
    (is (true? (schema/version-recorded? 1)))
    (is (false? (schema/version-recorded? 0)))))

(deftest invariants-catch-bad-schemas
  (let [base {:schema-version 2 :statements {"A" "CREATE TABLE IF NOT EXISTS a (x int);"}
              :migrations [{:version 1 :statement "A"} {:version 2 :sql "ALTER TABLE a ADD COLUMN IF NOT EXISTS y int;"}]}]
    (is (= [] (schema/problems base)))
    (is (= [:version-not-highest] (schema/problems (assoc base :schema-version 3))))
    (is (some #{:versions-decrease} (schema/problems (assoc base :migrations [{:version 2 :statement "A"} {:version 1 :statement "A"}]))))
    (is (some #{:not-idempotent} (schema/problems (assoc-in base [:statements "A"] "CREATE TABLE a (x int);"))))
    (is (some #{:empty-migration} (schema/problems (assoc-in base [:statements "A"] "  "))))
    (is (thrown? js/Error (schema/statement base "NOPE")))))

(deftest ^:async runner-executes-the-plan-on-the-client
  (let [calls (atom [])
        sql #js {"unsafe" (fn [text params]
                            (swap! calls conj [text (some-> params vec)])
                            (js/Promise.resolve #js []))}]
    (await (edge/run-migrations-js sql))
    (let [n (count (schema/migrations resource))]
      (is (= (+ n 2) (count @calls)))
      (is (= (mapv :sql (schema/migrations resource)) (mapv first (take n @calls))))
      (is (= [(schema/statement resource "INSERT_VERSION") [8]] (last @calls))))))
