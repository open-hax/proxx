#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${FEDERATION_E2E_RUNTIME_DIR:-${ROOT_DIR}/.tmp/federation-e2e}"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.federation-e2e.yml"
COMPOSE_PROJECT="${FEDERATION_E2E_COMPOSE_PROJECT:-proxx-federation-e2e}"
ADMIN_TOKEN="${FEDERATION_E2E_ADMIN_TOKEN:-federation-e2e-admin-token}"
SESSION_SECRET="${FEDERATION_E2E_SESSION_SECRET:-federation-e2e-session-secret}"
OWNER_DID="${FEDERATION_E2E_OWNER_DID:-did:web:cluster.federation.test}"
SOURCE_DB_URL="${FEDERATION_E2E_GROUP_A_SOURCE_DATABASE_URL:-${DATABASE_URL:-}}"
KEEP_ENV="${FEDERATION_E2E_KEEP:-0}"
NGINX_BASE_URL="http://127.0.0.1:18080"
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

  compose down -v --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT

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
  rm -rf "${RUNTIME_DIR}"
  mkdir -p "${RUNTIME_DIR}/db-a-init" "${RUNTIME_DIR}/db-b-init"

  for node in a1 a2 b1 b2; do
    mkdir -p "${RUNTIME_DIR}/${node}/data"
    write_empty_keys "${RUNTIME_DIR}/${node}/keys.json"
    copy_models_file "${RUNTIME_DIR}/${node}/models.json"
  done

  if [[ -n "${SOURCE_DB_URL}" ]] && command -v pg_dump >/dev/null 2>&1; then
    info "Dumping source database into Group A init SQL"
    pg_dump --no-owner --no-privileges --clean --if-exists "${SOURCE_DB_URL}" > "${RUNTIME_DIR}/db-a-init/001-source.sql"
  else
    info "No source database dump available for Group A; using empty init"
    printf -- '-- no source db bootstrap\n' > "${RUNTIME_DIR}/db-a-init/000-empty.sql"
  fi

  printf -- '-- fresh Group B database\n' > "${RUNTIME_DIR}/db-b-init/000-empty.sql"
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

[[ "$(printf '%s' "$A1_SELF" | json_value 'nodeId')" == "a1" ]] && pass "a1 node subdomain routes to a1" || fail "a1 node subdomain" "wrong node"
[[ "$(printf '%s' "$A2_SELF" | json_value 'nodeId')" == "a2" ]] && pass "a2 node subdomain routes to a2" || fail "a2 node subdomain" "wrong node"
[[ "$(printf '%s' "$B1_SELF" | json_value 'nodeId')" == "b1" ]] && pass "b1 node subdomain routes to b1" || fail "b1 node subdomain" "wrong node"
[[ "$(printf '%s' "$B2_SELF" | json_value 'nodeId')" == "b2" ]] && pass "b2 node subdomain routes to b2" || fail "b2 node subdomain" "wrong node"

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

bold "── 2. peer registration over API ──"
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

bold "── 3. group A local credential baseline ──"
A1_ACCOUNTS=$(api_json_host "$NODE_HOST_a1" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
A1_LOCAL_COUNT=$(printf '%s' "$A1_ACCOUNTS" | json_len 'localAccounts')
if [[ "$A1_LOCAL_COUNT" -eq 0 ]]; then
  info "No inherited local account on Group A; creating deterministic seed account on a1"
  api_json_host "$NODE_HOST_a1" POST "/api/ui/credentials/api-key" '{"providerId":"openai","accountId":"federation-seed-openai","credentialValue":"federation-seed-openai-token"}' >/dev/null
  A1_ACCOUNTS=$(api_json_host "$NODE_HOST_a1" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
  A1_LOCAL_COUNT=$(printf '%s' "$A1_ACCOUNTS" | json_len 'localAccounts')
fi

if [[ "$A1_LOCAL_COUNT" -gt 0 ]]; then
  pass "group A has at least one local credential"
else
  fail "group A local credential baseline" "no local accounts available"
fi

IFS=$'\t' read -r FED_PROVIDER_ID FED_ACCOUNT_ID FED_ACCOUNT_LABEL <<< "$(printf '%s' "$A1_ACCOUNTS" | first_local_account_triplet)"
if [[ -z "${FED_PROVIDER_ID}" || -z "${FED_ACCOUNT_ID}" ]]; then
  fail "select federation account" "missing provider/account id"
  exit 1
fi
pass "selected federation account ${FED_PROVIDER_ID}/${FED_ACCOUNT_ID}"

A2_ACCOUNTS=$(api_json_host "$NODE_HOST_a2" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
A2_ACCOUNT_STATE=$(printf '%s' "$A2_ACCOUNTS" | known_account_state "$FED_PROVIDER_ID" "$FED_ACCOUNT_ID")
if [[ -n "$A2_ACCOUNT_STATE" ]]; then
  pass "group A shared DB projects local account to sibling node"
else
  fail "group A shared DB" "a2 does not see selected account"
fi

bold "── 4. projected descriptor sync into group B ──"
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

bold "── 5. warm routing triggers full transfer ──"
ROUTED_RESULT=''
for attempt in 1 2 3; do
  ROUTED_RESULT=$(api_json_host "$NODE_HOST_b1" POST "/api/ui/federation/projected-accounts/routed" "$(python3 - <<'PY' "$FED_PROVIDER_ID" "$FED_ACCOUNT_ID"
import json, sys
provider_id, account_id = sys.argv[1:3]
print(json.dumps({
  "sourcePeerId": "a1",
  "providerId": provider_id,
  "accountId": account_id,
}))
PY
)")
done
IMPORTED_CREDENTIAL=$(printf '%s' "$ROUTED_RESULT" | json_value 'importedCredential')
if [[ "$IMPORTED_CREDENTIAL" == "True" || "$IMPORTED_CREDENTIAL" == "true" ]]; then
  pass "warm routed projected account auto-imported credential"
else
  fail "warm routed projected account auto-imported credential" "import flag=${IMPORTED_CREDENTIAL}"
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
    pass "${host} has imported credential after warm transfer"
  else
    fail "${host} imported credential after warm transfer" "still descriptor-only"
  fi
done

bold "── 6. usage propagation across groups ──"
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
