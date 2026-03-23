#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_RUNTIME_DIR="/tmp/proxx-federation-e2e-$(date +%s)-$$"
RUNTIME_DIR="${FEDERATION_E2E_RUNTIME_DIR:-${DEFAULT_RUNTIME_DIR}}"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.federation-e2e.yml"
COMPOSE_PROJECT="${FEDERATION_E2E_COMPOSE_PROJECT:-proxx-federation-e2e}"
ADMIN_TOKEN="${FEDERATION_E2E_ADMIN_TOKEN:-federation-e2e-admin-token}"
SESSION_SECRET="${FEDERATION_E2E_SESSION_SECRET:-federation-e2e-session-secret}"
OWNER_DID="${FEDERATION_E2E_OWNER_DID:-did:web:cluster.federation.test}"
SOURCE_DB_URL="${FEDERATION_E2E_GROUP_A_SOURCE_DATABASE_URL:-}"
GROUP_B_SOURCE_DB_URL="${FEDERATION_E2E_GROUP_B_SOURCE_DATABASE_URL:-}"
KEEP_ENV="${FEDERATION_E2E_KEEP:-0}"
NGINX_BASE_URL="http://127.0.0.1:18080"
MOCK_OPENAI_ORIGIN="${FEDERATION_E2E_MOCK_OPENAI_ORIGIN:-http://127.0.0.1:19090}"
PASS=0
FAIL=0

NODE_HOST_a1="a1.federation.test"
NODE_HOST_a2="a2.federation.test"
NODE_HOST_b1="b1.federation.test"
NODE_HOST_b2="b2.federation.test"
GROUP_HOST_a="group-a.federation.test"
GROUP_HOST_b="group-b.federation.test"
CLUSTER_HOST="cluster.federation.test"

green()  { printf "\033[32m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

pass() { PASS=$((PASS + 1)); green "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); red   "  FAIL: $1 — $2"; }
info() { yellow "  INFO: $1"; }

compose() {
  FEDERATION_E2E_RUNTIME_DIR="${RUNTIME_DIR}" \
  FEDERATION_E2E_ADMIN_TOKEN="${ADMIN_TOKEN}" \
  FEDERATION_E2E_SESSION_SECRET="${SESSION_SECRET}" \
  docker compose -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" "$@"
}

cleanup() {
  if [[ "${KEEP_ENV}" == "1" ]]; then
    info "Keeping federation e2e environment at ${RUNTIME_DIR}"
    return
  fi

  ensure_safe_runtime_dir
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${RUNTIME_DIR}"
}

trap cleanup EXIT

ensure_safe_runtime_dir() {
  if [[ -z "${RUNTIME_DIR}" || "${RUNTIME_DIR}" == "/" || "${RUNTIME_DIR}" == "${ROOT_DIR}" || "${RUNTIME_DIR}" == "/tmp" ]]; then
    echo "Refusing to operate on unsafe RUNTIME_DIR='${RUNTIME_DIR}'" >&2
    exit 1
  fi

  case "${RUNTIME_DIR}" in
    /tmp/proxx-federation-e2e-*|"${ROOT_DIR}"/.tmp/federation-e2e*)
      ;;
    *)
      echo "Refusing to operate on unexpected RUNTIME_DIR='${RUNTIME_DIR}'" >&2
      exit 1
      ;;
  esac
}

write_empty_keys() {
  local path="$1"
  python3 - <<'PY' "$path"
from pathlib import Path
import json
Path(__import__('sys').argv[1]).write_text(json.dumps({"providers": {}}, indent=2) + "\n", encoding="utf-8")
PY
}

copy_models_file() {
  local dest="$1"
  if [[ -f "${ROOT_DIR}/models.example.json" ]]; then
    cp "${ROOT_DIR}/models.example.json" "$dest"
  else
    printf '{}\n' > "$dest"
  fi
}

prepare_runtime() {
  ensure_safe_runtime_dir
  rm -rf "${RUNTIME_DIR}"
  mkdir -p "${RUNTIME_DIR}/db-a-init" "${RUNTIME_DIR}/db-b-init" "${RUNTIME_DIR}/backups"

  for node in a1 a2 b1 b2; do
    mkdir -p "${RUNTIME_DIR}/${node}/data"
    write_empty_keys "${RUNTIME_DIR}/${node}/keys.json"
    copy_models_file "${RUNTIME_DIR}/${node}/models.json"
  done

  if [[ -n "${SOURCE_DB_URL}" ]] && command -v pg_dump >/dev/null 2>&1; then
    info "Backing up and seeding Group A from source database"
    pg_dump --no-owner --no-privileges --clean --if-exists "${SOURCE_DB_URL}" > "${RUNTIME_DIR}/backups/group-a-source.sql"
    cp "${RUNTIME_DIR}/backups/group-a-source.sql" "${RUNTIME_DIR}/db-a-init/001-source.sql"
  else
    info "No source database dump available for Group A; using empty init"
    printf -- '-- no source db bootstrap\n' > "${RUNTIME_DIR}/db-a-init/000-empty.sql"
  fi

  if [[ -n "${GROUP_B_SOURCE_DB_URL}" ]] && command -v pg_dump >/dev/null 2>&1; then
    info "Backing up and seeding Group B from source database"
    pg_dump --no-owner --no-privileges --clean --if-exists "${GROUP_B_SOURCE_DB_URL}" > "${RUNTIME_DIR}/backups/group-b-source.sql"
    cp "${RUNTIME_DIR}/backups/group-b-source.sql" "${RUNTIME_DIR}/db-b-init/001-source.sql"
  else
    printf -- '-- fresh Group B database\n' > "${RUNTIME_DIR}/db-b-init/000-empty.sql"
  fi
}

api_json_host() {
  local host="$1"
  local method="$2"
  local path="$3"
  local body="${4:-}"
  local args=(
    -fsS --max-time 30
    -H "Host: ${host}"
    -H "Authorization: Bearer ${ADMIN_TOKEN}"
    -H "Content-Type: application/json"
    -X "${method}"
  )
  if [[ -n "${body}" ]]; then
    args+=(-d "${body}")
  fi
  curl "${args[@]}" "${NGINX_BASE_URL}${path}"
}

wait_for_host() {
  local host="$1"
  local label="$2"
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 5 -H "Host: ${host}" -H "Authorization: Bearer ${ADMIN_TOKEN}" "${NGINX_BASE_URL}/health" >/dev/null 2>&1; then
      pass "${label} reachable"
      return 0
    fi
    sleep 2
  done
  fail "${label} reachable" "timed out waiting for ${host}"
  return 1
}

json_value() {
  local path="$1"
  python3 -c '
import json, sys
path = sys.argv[1]
data = json.load(sys.stdin)
value = data
for key in path.split("."):
    if key == "":
        continue
    if isinstance(value, list):
        value = value[int(key)]
    else:
        value = value[key]
if isinstance(value, (dict, list)):
    print(json.dumps(value))
elif value is None:
    print("")
else:
    print(value)
' "$path"
}

json_len() {
  local path="$1"
  python3 -c '
import json, sys
path = sys.argv[1]
data = json.load(sys.stdin)
value = data
for key in path.split("."):
    if key == "":
        continue
    if isinstance(value, list):
        value = value[int(key)]
    else:
        value = value[key]
print(len(value) if isinstance(value, (list, dict)) else 0)
' "$path"
}

register_peer() {
  local target_host="$1"
  local peer_id="$2"
  local peer_host="$3"
  local group_id="$4"
  local body
  body=$(python3 - <<'PY' "$peer_id" "$peer_host" "$group_id" "$OWNER_DID" "$ADMIN_TOKEN"
import json, sys
peer_id, peer_host, group_id, owner_did, admin_token = sys.argv[1:6]
print(json.dumps({
  "id": peer_id,
  "ownerCredential": owner_did,
  "peerDid": f"did:web:{peer_host}",
  "label": f"{peer_id} ({group_id})",
  "baseUrl": f"http://federation-proxx-{peer_id}:8789",
  "controlBaseUrl": f"http://federation-proxx-{peer_id}:8789",
  "auth": {"credential": admin_token},
  "capabilities": {
    "accounts": True,
    "usage": True,
    "audit": True,
  },
  "status": "active",
}))
PY
)
  api_json_host "$target_host" POST "/api/ui/federation/peers" "$body" >/dev/null
}

first_local_account_triplet() {
  python3 -c '
import json, sys
payload = json.load(sys.stdin)
accounts = payload.get("localAccounts", [])
if not accounts:
    print("\t\t")
    raise SystemExit(0)
acct = accounts[0]
print("{}\t{}\t{}".format(acct.get("providerId", ""), acct.get("accountId", ""), acct.get("displayName", "")))
'
}

known_account_state() {
  local provider_id="$1"
  local account_id="$2"
  python3 -c '
import json, sys
provider_id, account_id = sys.argv[1:3]
payload = json.load(sys.stdin)
for acct in payload.get("knownAccounts", []):
    if acct.get("providerId") == provider_id and acct.get("accountId") == account_id:
        print(json.dumps(acct))
        break
else:
    print("")
' "$provider_id" "$account_id"
}

count_unique_node_ids() {
  python3 -c '
import sys
values = [line.strip() for line in sys.stdin if line.strip()]
print(len(set(values)))
'
}

local_account_pairs_for_provider() {
  local provider_id="$1"
  python3 -c '
import json, sys
provider_id = sys.argv[1]
payload = json.load(sys.stdin)
for acct in payload.get("localAccounts", []):
    if acct.get("providerId") == provider_id:
        print("{}\t{}\t{}".format(acct.get("providerId", ""), acct.get("accountId", ""), acct.get("chatgptAccountId", "")))
' "$provider_id"
}

local_account_count_for_provider() {
  local provider_id="$1"
  python3 -c '
import json, sys
provider_id = sys.argv[1]
payload = json.load(sys.stdin)
print(sum(1 for acct in payload.get("localAccounts", []) if acct.get("providerId") == provider_id))
' "$provider_id"
}

has_local_chatgpt_account_id() {
  local chatgpt_account_id="$1"
  python3 -c '
import json, sys
target = sys.argv[1]
payload = json.load(sys.stdin)
print(any(acct.get("chatgptAccountId") == target for acct in payload.get("localAccounts", [])))
' "$chatgpt_account_id"
}

host_slug() {
  python3 -c 'import re, sys; print(re.sub(r"[^a-z0-9]+", "-", sys.argv[1].lower()).strip("-") or "unknown")' "$1"
}

rewrite_mock_authorize_url() {
  python3 -c '
from urllib.parse import urlsplit, urlunsplit
import sys
target_origin, authorize_url = sys.argv[1:3]
origin = urlsplit(target_origin)
url = urlsplit(authorize_url)
print(urlunsplit((origin.scheme, origin.netloc, url.path, url.query, url.fragment)))
' "$MOCK_OPENAI_ORIGIN" "$1"
}

redirect_location() {
  curl -fsS --max-time 30 -D - -o /dev/null "$1" | tr -d '\r' | awk 'BEGIN{IGNORECASE=1} /^location: /{print substr($0, 11)}' | tail -1
}

callback_path_from_url() {
  python3 -c '
from urllib.parse import urlsplit
import sys
url = urlsplit(sys.argv[1])
print(url.path + (("?" + url.query) if url.query else ""))
' "$1"
}

callback_host_from_url() {
  python3 -c 'from urllib.parse import urlsplit; import sys; print(urlsplit(sys.argv[1]).hostname or "")' "$1"
}

host_request() {
  local host="$1"
  local method="$2"
  local path="$3"
  local body="${4:-}"
  local with_auth="${5:-1}"
  local args=(
    -fsS --max-time 30
    -H "Host: ${host}"
    -X "${method}"
  )
  if [[ "$with_auth" == "1" ]]; then
    args+=( -H "Authorization: Bearer ${ADMIN_TOKEN}" )
  fi
  if [[ -n "$body" ]]; then
    args+=( -H "Content-Type: application/json" -d "$body" )
  fi
  curl "${args[@]}" "${NGINX_BASE_URL}${path}"
}

capture_proxy_request() {
  local host="$1"
  local path="$2"
  local body="$3"
  local header_file="$4"
  local body_file="$5"
  curl -fsS --max-time 30 \
    -D "$header_file" \
    -o "$body_file" \
    -H "Host: ${host}" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "X-Open-Hax-Federation-Owner-Subject: ${OWNER_DID}" \
    -H "Content-Type: application/json" \
    -X POST \
    -d "$body" \
    "${NGINX_BASE_URL}${path}"
}

response_header_value() {
  local header_file="$1"
  local header_name="$2"
  python3 -c '
import sys
target = sys.argv[2].lower()
value = ""
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    for line in handle:
        if ":" not in line:
            continue
        name, raw = line.split(":", 1)
        if name.strip().lower() == target:
            value = raw.strip()
print(value)
' "$header_file" "$header_name"
}

complete_browser_oauth_for_host() {
  local host="$1"
  local slug
  slug=$(host_slug "$host")
  local expected_chatgpt_account_id="chatgpt-${slug}"
  local start_json
  start_json=$(api_json_host "$host" POST "/api/ui/credentials/openai/oauth/browser/start" '{}')
  local redirect_uri authorize_url rewritten_authorize_url callback_location callback_host callback_path callback_html
  redirect_uri=$(printf '%s' "$start_json" | json_value 'redirectUri')
  authorize_url=$(printf '%s' "$start_json" | json_value 'authorizeUrl')

  if [[ "$redirect_uri" == "http://${host}/auth/callback" || "$redirect_uri" == "https://${host}/auth/callback" ]]; then
    pass "${host} browser OAuth redirectUri stays on host-routed callback"
  else
    fail "${host} browser OAuth redirectUri" "unexpected redirectUri ${redirect_uri}"
    return 1
  fi

  rewritten_authorize_url=$(rewrite_mock_authorize_url "$authorize_url")
  callback_location=$(redirect_location "$rewritten_authorize_url")
  callback_host=$(callback_host_from_url "$callback_location")
  callback_path=$(callback_path_from_url "$callback_location")

  if [[ "$callback_host" == "$host" ]]; then
    pass "${host} browser OAuth authorize step targets node callback host"
  else
    fail "${host} browser OAuth authorize step" "callback host ${callback_host}"
    return 1
  fi

  callback_html=$(host_request "$host" GET "$callback_path" '' 0)
  if printf '%s' "$callback_html" | grep -q 'Saved OpenAI OAuth account'; then
    pass "${host} browser OAuth callback saved account"
  else
    fail "${host} browser OAuth callback" "success page missing"
    return 1
  fi

  local accounts_json has_account_id
  accounts_json=$(api_json_host "$host" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
  has_account_id=$(printf '%s' "$accounts_json" | has_local_chatgpt_account_id "$expected_chatgpt_account_id")
  if [[ "$has_account_id" == "True" || "$has_account_id" == "true" ]]; then
    pass "${host} local store contains OAuth account ${expected_chatgpt_account_id}"
  else
    fail "${host} local OAuth account presence" "missing ${expected_chatgpt_account_id}"
    return 1
  fi
}

bold "=== Federation E2E cluster harness ==="
prepare_runtime
compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d --build

wait_for_host "$NODE_HOST_a1" "node a1"
wait_for_host "$NODE_HOST_a2" "node a2"
wait_for_host "$NODE_HOST_b1" "node b1"
wait_for_host "$NODE_HOST_b2" "node b2"
wait_for_host "$GROUP_HOST_a" "group-a nginx"
wait_for_host "$GROUP_HOST_b" "group-b nginx"
wait_for_host "$CLUSTER_HOST" "cluster nginx"

bold "── 1. nginx routing layers ──"
A1_SELF=$(api_json_host "$NODE_HOST_a1" GET "/api/ui/federation/self")
A2_SELF=$(api_json_host "$NODE_HOST_a2" GET "/api/ui/federation/self")
B1_SELF=$(api_json_host "$NODE_HOST_b1" GET "/api/ui/federation/self")
B2_SELF=$(api_json_host "$NODE_HOST_b2" GET "/api/ui/federation/self")

if [[ "$(printf '%s' "$A1_SELF" | json_value 'nodeId')" == "a1" ]]; then
  pass "a1 node subdomain routes to a1"
else
  fail "a1 node subdomain" "wrong node"
fi
if [[ "$(printf '%s' "$A2_SELF" | json_value 'nodeId')" == "a2" ]]; then
  pass "a2 node subdomain routes to a2"
else
  fail "a2 node subdomain" "wrong node"
fi
if [[ "$(printf '%s' "$B1_SELF" | json_value 'nodeId')" == "b1" ]]; then
  pass "b1 node subdomain routes to b1"
else
  fail "b1 node subdomain" "wrong node"
fi
if [[ "$(printf '%s' "$B2_SELF" | json_value 'nodeId')" == "b2" ]]; then
  pass "b2 node subdomain routes to b2"
else
  fail "b2 node subdomain" "wrong node"
fi

GROUP_A_IDS=$(for _ in 1 2 3 4 5 6; do api_json_host "$GROUP_HOST_a" GET "/api/ui/federation/self" | json_value 'nodeId'; done)
GROUP_B_IDS=$(for _ in 1 2 3 4 5 6; do api_json_host "$GROUP_HOST_b" GET "/api/ui/federation/self" | json_value 'nodeId'; done)
CLUSTER_IDS=$(for _ in 1 2 3 4 5 6 7 8; do api_json_host "$CLUSTER_HOST" GET "/api/ui/federation/self" | json_value 'nodeId'; done)

if printf '%s\n' "$GROUP_A_IDS" | grep -Ev '^(a1|a2)$' >/dev/null; then
  fail "group-a routing" "returned node outside group-a"
else
  pass "group-a routing stays within group-a"
fi

if printf '%s\n' "$GROUP_B_IDS" | grep -Ev '^(b1|b2)$' >/dev/null; then
  fail "group-b routing" "returned node outside group-b"
else
  pass "group-b routing stays within group-b"
fi

CLUSTER_UNIQUE=$(printf '%s\n' "$CLUSTER_IDS" | count_unique_node_ids)
if [[ "$CLUSTER_UNIQUE" -ge 2 ]]; then
  pass "cluster routing hits multiple nodes"
else
  fail "cluster routing hits multiple nodes" "observed only ${CLUSTER_UNIQUE} unique nodes"
fi

bold "── 2. browser OAuth works on all four nodes ──"
for host in "$NODE_HOST_a1" "$NODE_HOST_a2" "$NODE_HOST_b1" "$NODE_HOST_b2"; do
  complete_browser_oauth_for_host "$host"
done

bold "── 3. peer registration over API ──"
for peer in a2 b1 b2; do register_peer "$NODE_HOST_a1" "$peer" "${peer}.federation.test" "$( [[ "$peer" =~ ^a ]] && echo group-a || echo group-b )"; done
for peer in a1 a2 b2; do register_peer "$NODE_HOST_b1" "$peer" "${peer}.federation.test" "$( [[ "$peer" =~ ^a ]] && echo group-a || echo group-b )"; done

for host in "$NODE_HOST_a1" "$NODE_HOST_a2" "$NODE_HOST_b1" "$NODE_HOST_b2"; do
  PEERS_JSON=$(api_json_host "$host" GET "/api/ui/federation/peers?ownerSubject=${OWNER_DID}")
  PEER_COUNT=$(printf '%s' "$PEERS_JSON" | json_len 'peers')
  if [[ "$PEER_COUNT" -ge 3 ]]; then
    pass "${host} sees peer registry"
  else
    fail "${host} sees peer registry" "peer count ${PEER_COUNT}"
  fi
done

bold "── 4. mixed local account baseline for reroute scenario ──"
A1_ACCOUNTS=$(api_json_host "$NODE_HOST_a1" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
A1_OPENAI_LOCAL_COUNT=$(printf '%s' "$A1_ACCOUNTS" | local_account_count_for_provider "openai")
if [[ "$A1_OPENAI_LOCAL_COUNT" -ge 1 ]]; then
  pass "group A has OpenAI OAuth credentials after browser auth"
else
  fail "group A OpenAI OAuth baseline" "openai local account count=${A1_OPENAI_LOCAL_COUNT}"
fi

IFS=$'\t' read -r FED_PROVIDER_ID FED_ACCOUNT_ID _ <<< "$(printf '%s' "$A1_ACCOUNTS" | local_account_pairs_for_provider "openai" | head -1)"
if [[ -z "${FED_PROVIDER_ID}" || -z "${FED_ACCOUNT_ID}" ]]; then
  fail "select federation account" "missing provider/account id"
  exit 1
fi
pass "selected federation account ${FED_PROVIDER_ID}/${FED_ACCOUNT_ID}"

A2_ACCOUNTS=$(api_json_host "$NODE_HOST_a2" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
A2_ACCOUNT_STATE=$(printf '%s' "$A2_ACCOUNTS" | known_account_state "$FED_PROVIDER_ID" "$FED_ACCOUNT_ID")
if [[ -n "$A2_ACCOUNT_STATE" ]]; then
  pass "group A shared DB exposes selected OAuth account on sibling node"
else
  fail "group A shared DB" "a2 does not see selected account"
fi

B1_ACCOUNTS=$(api_json_host "$NODE_HOST_b1" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
B1_OPENAI_LOCAL_COUNT=$(printf '%s' "$B1_ACCOUNTS" | local_account_count_for_provider "openai")
if [[ "$B1_OPENAI_LOCAL_COUNT" -ge 1 ]]; then
  pass "group B also completed browser OAuth before reroute reseed"
else
  fail "group B browser OAuth baseline" "openai local account count=${B1_OPENAI_LOCAL_COUNT}"
fi

while IFS=$'\t' read -r provider_id account_id _chatgpt_account_id; do
  [[ -n "$provider_id" && -n "$account_id" ]] || continue
  api_json_host "$NODE_HOST_b1" DELETE "/api/ui/credentials/account" "$(python3 - <<'PY' "$provider_id" "$account_id"
import json, sys
print(json.dumps({"providerId": sys.argv[1], "accountId": sys.argv[2]}))
PY
)" >/dev/null
done <<< "$(printf '%s' "$B1_ACCOUNTS" | local_account_pairs_for_provider "openai")"

B1_ACCOUNTS=$(api_json_host "$NODE_HOST_b1" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
B2_ACCOUNTS=$(api_json_host "$NODE_HOST_b2" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
B1_OPENAI_AFTER_RESET=$(printf '%s' "$B1_ACCOUNTS" | local_account_count_for_provider "openai")
B2_OPENAI_AFTER_RESET=$(printf '%s' "$B2_ACCOUNTS" | local_account_count_for_provider "openai")
if [[ "$B1_OPENAI_AFTER_RESET" -eq 0 ]]; then
  pass "group B reseed removed local OpenAI accounts from b1"
else
  fail "group B reseed removed local OpenAI accounts from b1" "count=${B1_OPENAI_AFTER_RESET}"
fi
if [[ "$B2_OPENAI_AFTER_RESET" -eq 0 ]]; then
  pass "group B shared DB reset removed local OpenAI accounts from b2"
else
  fail "group B shared DB reset removed local OpenAI accounts from b2" "count=${B2_OPENAI_AFTER_RESET}"
fi

bold "── 5. projected descriptor sync into group B ──"
SYNC_RESULT=$(api_json_host "$NODE_HOST_b1" POST "/api/ui/federation/sync/pull" "$(python3 - <<'PY' "$OWNER_DID"
import json, sys
print(json.dumps({"peerId": "a1", "ownerSubject": sys.argv[1], "pullUsage": False}))
PY
)")
SYNC_PROJECTED_COUNT=$(printf '%s' "$SYNC_RESULT" | json_value 'importedProjectedAccountsCount')
if [[ "${SYNC_PROJECTED_COUNT}" -ge 1 ]]; then
  pass "sync pull imported projected descriptors into group B"
else
  fail "sync pull imported projected descriptors into group B" "count=${SYNC_PROJECTED_COUNT}"
fi

for host in "$NODE_HOST_b1" "$NODE_HOST_b2"; do
  ACCOUNTS_JSON=$(api_json_host "$host" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
  STATE_JSON=$(printf '%s' "$ACCOUNTS_JSON" | known_account_state "$FED_PROVIDER_ID" "$FED_ACCOUNT_ID")
  if [[ -z "$STATE_JSON" ]]; then
    fail "${host} projected account visibility" "missing projected account"
    continue
  fi
  HAS_CREDENTIALS=$(printf '%s' "$STATE_JSON" | json_value 'hasCredentials')
  if [[ "$HAS_CREDENTIALS" == "False" || "$HAS_CREDENTIALS" == "false" ]]; then
    pass "${host} knows remote account exists without credentials"
  else
    fail "${host} projected descriptor state" "expected no credentials yet"
  fi
done

bold "── 6. actual request reroute and warm import ──"
REROUTE_BODY='{"model":"gpt-5.3-codex","messages":[{"role":"user","content":"route this through federation"}],"stream":false}'
for attempt in 1 2 3; do
  HEADER_FILE="${RUNTIME_DIR}/reroute-${attempt}.headers"
  BODY_FILE="${RUNTIME_DIR}/reroute-${attempt}.json"
  capture_proxy_request "$NODE_HOST_b1" "/v1/chat/completions" "$REROUTE_BODY" "$HEADER_FILE" "$BODY_FILE"
  ROUTED_PEER=$(response_header_value "$HEADER_FILE" "x-open-hax-federation-routed-peer")
  ROUTED_PROVIDER=$(response_header_value "$HEADER_FILE" "x-open-hax-federation-routed-provider")
  ROUTED_ACCOUNT=$(response_header_value "$HEADER_FILE" "x-open-hax-federation-routed-account")
  IMPORTED_FLAG=$(response_header_value "$HEADER_FILE" "x-open-hax-federation-imported")
  RESPONSE_TEXT=$(python3 -c 'import json, sys; payload=json.load(open(sys.argv[1], "r", encoding="utf-8")); print(payload["choices"][0]["message"].get("content", ""))' "$BODY_FILE")

  if [[ "$ROUTED_PEER" == "a1" ]]; then
    pass "rerouted request ${attempt} traversed peer a1"
  else
    fail "rerouted request ${attempt}" "expected routed peer a1, got ${ROUTED_PEER}"
  fi
  if [[ "$ROUTED_PROVIDER" == "$FED_PROVIDER_ID" ]]; then
    pass "rerouted request ${attempt} preserved provider ${FED_PROVIDER_ID}"
  else
    fail "rerouted request ${attempt} provider" "expected ${FED_PROVIDER_ID}, got ${ROUTED_PROVIDER}"
  fi
  if [[ "$ROUTED_ACCOUNT" == "$FED_ACCOUNT_ID" ]]; then
    pass "rerouted request ${attempt} pinned projected account ${FED_ACCOUNT_ID}"
  else
    fail "rerouted request ${attempt} account" "expected ${FED_ACCOUNT_ID}, got ${ROUTED_ACCOUNT}"
  fi
  if [[ "$RESPONSE_TEXT" == *"mock federated response"* ]]; then
    pass "rerouted request ${attempt} returned upstream payload"
  else
    fail "rerouted request ${attempt} body" "unexpected response payload"
  fi
done

if [[ "$IMPORTED_FLAG" == "true" || "$IMPORTED_FLAG" == "True" ]]; then
  pass "third rerouted request triggered warm import"
else
  fail "third rerouted request triggered warm import" "import flag=${IMPORTED_FLAG}"
fi

for host in "$NODE_HOST_b1" "$NODE_HOST_b2"; do
  ACCOUNTS_JSON=$(api_json_host "$host" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
  STATE_JSON=$(printf '%s' "$ACCOUNTS_JSON" | known_account_state "$FED_PROVIDER_ID" "$FED_ACCOUNT_ID")
  if [[ -z "$STATE_JSON" ]]; then
    fail "${host} imported account visibility" "missing account after warm import"
    continue
  fi
  HAS_CREDENTIALS=$(printf '%s' "$STATE_JSON" | json_value 'hasCredentials')
  if [[ "$HAS_CREDENTIALS" == "True" || "$HAS_CREDENTIALS" == "true" ]]; then
    pass "${host} has imported credential after repeated routed requests"
  else
    fail "${host} imported credential after repeated routed requests" "still descriptor-only"
  fi
done

POST_IMPORT_HEADERS="${RUNTIME_DIR}/reroute-post-import.headers"
POST_IMPORT_BODY="${RUNTIME_DIR}/reroute-post-import.json"
capture_proxy_request "$NODE_HOST_b1" "/v1/chat/completions" "$REROUTE_BODY" "$POST_IMPORT_HEADERS" "$POST_IMPORT_BODY"
POST_IMPORT_ROUTED_PEER=$(response_header_value "$POST_IMPORT_HEADERS" "x-open-hax-federation-routed-peer")
if [[ -z "$POST_IMPORT_ROUTED_PEER" ]]; then
  pass "post-import request serves locally without an extra federation hop"
else
  fail "post-import request serves locally" "still routed via ${POST_IMPORT_ROUTED_PEER}"
fi

bold "── 7. usage propagation across groups ──"
USAGE_EXPORT=$(api_json_host "$NODE_HOST_a1" GET "/api/ui/federation/usage-export?sinceMs=0&limit=5")
USAGE_COUNT=$(printf '%s' "$USAGE_EXPORT" | json_len 'entries')
SYNTHETIC_USAGE_ID="federation-usage-$(date +%s)"
if [[ "$USAGE_COUNT" -eq 0 ]]; then
  info "No source usage entries found; injecting a deterministic usage row into group A"
  SYNTHETIC_PAYLOAD=$(python3 - <<'PY' "$SYNTHETIC_USAGE_ID" "$FED_PROVIDER_ID" "$FED_ACCOUNT_ID"
import json, sys, time
entry_id, provider_id, account_id = sys.argv[1:4]
print(json.dumps({
  "entries": [{
    "id": entry_id,
    "timestamp": int(time.time() * 1000),
    "providerId": provider_id,
    "accountId": account_id,
    "authType": "api_key",
    "model": "federation-test-model",
    "upstreamMode": "chat_completions",
    "upstreamPath": "/v1/chat/completions",
    "status": 200,
    "latencyMs": 42,
    "serviceTierSource": "none",
    "promptTokens": 3,
    "completionTokens": 5,
    "totalTokens": 8,
    "cacheHit": False,
    "promptCacheKeyUsed": False,
  }]
}))
PY
)
  api_json_host "$NODE_HOST_a1" POST "/api/ui/federation/usage-import" "$SYNTHETIC_PAYLOAD" >/dev/null
  pass "synthetic usage injected into group A"
else
  SYNTHETIC_USAGE_ID=$(printf '%s' "$USAGE_EXPORT" | json_value 'entries.0.id')
  pass "group A already has usage entries to propagate"
fi

SYNC_USAGE_RESULT=$(api_json_host "$NODE_HOST_b1" POST "/api/ui/federation/sync/pull" "$(python3 - <<'PY' "$OWNER_DID"
import json, sys
print(json.dumps({"peerId": "a1", "ownerSubject": sys.argv[1], "pullUsage": True, "sinceMs": 0}))
PY
)")
SYNC_USAGE_COUNT=$(printf '%s' "$SYNC_USAGE_RESULT" | json_value 'importedUsageCount')
if [[ "${SYNC_USAGE_COUNT}" -ge 1 ]]; then
  pass "usage sync imported rows into group B"
else
  fail "usage sync imported rows into group B" "count=${SYNC_USAGE_COUNT}"
fi

B2_LOGS=$(api_json_host "$NODE_HOST_b2" GET "/api/ui/request-logs?limit=200")
HAS_SYNTHETIC=$(printf '%s' "$B2_LOGS" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
target = sys.argv[1]
print(any(entry.get("id") == target for entry in payload.get("entries", [])))
' "$SYNTHETIC_USAGE_ID")
if [[ "$HAS_SYNTHETIC" == "True" || "$HAS_SYNTHETIC" == "true" ]]; then
  pass "group B shared DB exposes synced usage on sibling node"
else
  fail "group B shared DB exposes synced usage on sibling node" "missing usage id ${SYNTHETIC_USAGE_ID}"
fi

echo
bold "PASS: ${PASS}  FAIL: ${FAIL}"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
