import { kernels } from "../cljs-kernels.js";

/*
 * The SQL contract of the Proxx database is data: resources/db/schema.edn,
 * read by proxx.db.schema / proxx.runtime.db-schema. These are the stable
 * TypeScript names the SQL stores import; every statement is byte-for-byte the
 * original text (pinned by test/proxx/db/schema_test.cljs and
 * src/tests/schema-migration.test.ts).
 */
const statement = (id: string): string => kernels.sqlStatement(id);

export const CREATE_ACCOUNT_HEALTH_TABLE = statement("CREATE_ACCOUNT_HEALTH_TABLE");
export const CREATE_ACCOUNT_HEALTH_INDEX = statement("CREATE_ACCOUNT_HEALTH_INDEX");
export const CREATE_TENANTS_TABLE = statement("CREATE_TENANTS_TABLE");
export const CREATE_USERS_TABLE = statement("CREATE_USERS_TABLE");
export const CREATE_TENANT_MEMBERSHIPS_TABLE = statement("CREATE_TENANT_MEMBERSHIPS_TABLE");
export const CREATE_TENANT_API_KEYS_TABLE = statement("CREATE_TENANT_API_KEYS_TABLE");
export const CREATE_TENANT_API_KEYS_TENANT_INDEX = statement("CREATE_TENANT_API_KEYS_TENANT_INDEX");
export const CREATE_TENANT_API_KEYS_HASH_INDEX = statement("CREATE_TENANT_API_KEYS_HASH_INDEX");
export const CREATE_TENANT_PROVIDER_POLICIES_TABLE = statement("CREATE_TENANT_PROVIDER_POLICIES_TABLE");
export const CREATE_TENANT_PROVIDER_POLICIES_OWNER_INDEX = statement("CREATE_TENANT_PROVIDER_POLICIES_OWNER_INDEX");
export const CREATE_PROVIDERS_TABLE = statement("CREATE_PROVIDERS_TABLE");
export const CREATE_ACCOUNTS_TABLE = statement("CREATE_ACCOUNTS_TABLE");
export const CREATE_ACCOUNTS_INDEX = statement("CREATE_ACCOUNTS_INDEX");
export const CREATE_COOLDOWN_TABLE = statement("CREATE_COOLDOWN_TABLE");
export const CREATE_PROMPT_AFFINITY_TABLE = statement("CREATE_PROMPT_AFFINITY_TABLE");
export const CREATE_SESSIONS_TABLE = statement("CREATE_SESSIONS_TABLE");
export const CREATE_ACCESS_TOKENS_TABLE = statement("CREATE_ACCESS_TOKENS_TABLE");
export const CREATE_REFRESH_TOKENS_TABLE = statement("CREATE_REFRESH_TOKENS_TABLE");
export const CREATE_GITHUB_ALLOWLIST_TABLE = statement("CREATE_GITHUB_ALLOWLIST_TABLE");
export const CREATE_CLIENTS_TABLE = statement("CREATE_CLIENTS_TABLE");
export const CREATE_VERSION_TABLE = statement("CREATE_VERSION_TABLE");
export const INSERT_VERSION = statement("INSERT_VERSION");
export const CHECK_VERSION_EXISTS = statement("CHECK_VERSION_EXISTS");
export const CREATE_MODELS_TABLE = statement("CREATE_MODELS_TABLE");
export const CREATE_CONFIG_TABLE = statement("CREATE_CONFIG_TABLE");
export const UPSERT_TENANT = statement("UPSERT_TENANT");
export const SELECT_ALL_TENANTS = statement("SELECT_ALL_TENANTS");
export const UPSERT_USER = statement("UPSERT_USER");
export const SELECT_USER_BY_SUBJECT = statement("SELECT_USER_BY_SUBJECT");
export const UPSERT_TENANT_MEMBERSHIP = statement("UPSERT_TENANT_MEMBERSHIP");
export const SELECT_TENANT_MEMBERSHIPS_BY_USER = statement("SELECT_TENANT_MEMBERSHIPS_BY_USER");
export const COUNT_TENANT_MEMBERSHIPS_FOR_TENANT = statement("COUNT_TENANT_MEMBERSHIPS_FOR_TENANT");
export const SELECT_ACTIVE_TENANT_API_KEY_BY_HASH = statement("SELECT_ACTIVE_TENANT_API_KEY_BY_HASH");
export const INSERT_TENANT_API_KEY = statement("INSERT_TENANT_API_KEY");
export const SELECT_TENANT_API_KEYS_BY_TENANT = statement("SELECT_TENANT_API_KEYS_BY_TENANT");
export const REVOKE_TENANT_API_KEY = statement("REVOKE_TENANT_API_KEY");
export const TOUCH_TENANT_API_KEY_LAST_USED = statement("TOUCH_TENANT_API_KEY_LAST_USED");
export const UPSERT_TENANT_PROVIDER_POLICY = statement("UPSERT_TENANT_PROVIDER_POLICY");
export const SELECT_TENANT_PROVIDER_POLICY = statement("SELECT_TENANT_PROVIDER_POLICY");
export const SELECT_TENANT_PROVIDER_POLICIES = statement("SELECT_TENANT_PROVIDER_POLICIES");
export const UPSERT_PROVIDER = statement("UPSERT_PROVIDER");
export const UPSERT_PROVIDER_WITH_BASE_URL = statement("UPSERT_PROVIDER_WITH_BASE_URL");
export const SELECT_PROVIDER_BY_ID = statement("SELECT_PROVIDER_BY_ID");
export const INSERT_ACCOUNT = statement("INSERT_ACCOUNT");
export const SELECT_ALL_PROVIDERS = statement("SELECT_ALL_PROVIDERS");
export const SELECT_ACCOUNTS_BY_PROVIDER = statement("SELECT_ACCOUNTS_BY_PROVIDER");
export const SELECT_ALL_ACCOUNTS = statement("SELECT_ALL_ACCOUNTS");
export const DELETE_ACCOUNT = statement("DELETE_ACCOUNT");
export const SET_ACCOUNT_DISABLED = statement("SET_ACCOUNT_DISABLED");
export const SELECT_ALL_DISABLED_ACCOUNTS = statement("SELECT_ALL_DISABLED_ACCOUNTS");
export const SET_COOLDOWN = statement("SET_COOLDOWN");
export const GET_COOLDOWN = statement("GET_COOLDOWN");
export const CLEAR_EXPIRED_COOLDOWNS = statement("CLEAR_EXPIRED_COOLDOWNS");
export const SELECT_ALL_ACTIVE_COOLDOWNS = statement("SELECT_ALL_ACTIVE_COOLDOWNS");
export const UPSERT_GITHUB_USER = statement("UPSERT_GITHUB_USER");
export const DELETE_GITHUB_USER = statement("DELETE_GITHUB_USER");
export const SELECT_GITHUB_ALLOWLIST = statement("SELECT_GITHUB_ALLOWLIST");
export const IS_GITHUB_USER_ALLOWED = statement("IS_GITHUB_USER_ALLOWED");
export const SELECT_ALL_ACCOUNT_HEALTH = statement("SELECT_ALL_ACCOUNT_HEALTH");
export const SELECT_ACCOUNT_HEALTH = statement("SELECT_ACCOUNT_HEALTH");
export const UPSERT_ACCOUNT_HEALTH_SUCCESS = statement("UPSERT_ACCOUNT_HEALTH_SUCCESS");
export const UPSERT_ACCOUNT_HEALTH_FAILURE = statement("UPSERT_ACCOUNT_HEALTH_FAILURE");
export const SELECT_ACCOUNT_HEALTH_SCORES = statement("SELECT_ACCOUNT_HEALTH_SCORES");
export const SELECT_PROMPT_AFFINITY = statement("SELECT_PROMPT_AFFINITY");
export const SELECT_ALL_PROMPT_AFFINITY = statement("SELECT_ALL_PROMPT_AFFINITY");
export const UPSERT_PROMPT_AFFINITY = statement("UPSERT_PROMPT_AFFINITY");
export const DELETE_PROMPT_AFFINITY = statement("DELETE_PROMPT_AFFINITY");
export const UPSERT_PROMPT_AFFINITY_PROVISIONAL = statement("UPSERT_PROMPT_AFFINITY_PROVISIONAL");
export const UPSERT_PROMPT_AFFINITY_PROMOTE_PROVISIONAL = statement("UPSERT_PROMPT_AFFINITY_PROMOTE_PROVISIONAL");

export const SCHEMA_VERSION: number = kernels.schemaVersion();

export const ALL_MIGRATIONS: ReadonlyArray<{ readonly version: number; readonly sql: string }> = kernels.allMigrations();
