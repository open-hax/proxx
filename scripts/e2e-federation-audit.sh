#!/usr/bin/env bash
set -euo pipefail

HOST_SUFFIX="${FEDERATION_HOST_SUFFIX:?FEDERATION_HOST_SUFFIX is required}"
AUTH_TOKEN="${FEDERATION_AUTH_TOKEN:-${DEV_PROXY_AUTH_TOKEN:-}}"
SCHEME="${FEDERATION_SCHEME:-https}"
RESOLVE_ADDRESS="${FEDERATION_RESOLVE_ADDRESS:-}"
FEDERATION_ORIGIN="${FEDERATION_ORIGIN:-}"
OWNER_DID="${FEDERATION_OWNER_DID:-did:web:${HOST_SUFFIX}}"
PASS=0
FAIL=0

if [[ -z "${AUTH_TOKEN}" ]]; then
  echo "FEDERATION_AUTH_TOKEN or DEV_PROXY_AUTH_TOKEN is required" >&2
  exit 1
fi

green()  { printf "\033[32m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
pass() { PASS=$((PASS + 1)); green "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); red   "  FAIL: $1 — $2"; }
info() { yellow "  INFO: $1"; }

CLUSTER_HOST="${HOST_SUFFIX}"
GROUP_A_HOST="group-a.${HOST_SUFFIX}"
GROUP_B_HOST="group-b.${HOST_SUFFIX}"
A1_HOST="a1.${HOST_SUFFIX}"
A2_HOST="a2.${HOST_SUFFIX}"
B1_HOST="b1.${HOST_SUFFIX}"
B2_HOST="b2.${HOST_SUFFIX}"

resolve_port() {
  if [[ "${SCHEME}" == "http" ]]; then
    printf '80'
  else
    printf '443'
  fi
}

target_url() {
  local host="$1"
  local path="$2"
  if [[ -n "$FEDERATION_ORIGIN" ]]; then
    printf '%s%s' "$FEDERATION_ORIGIN" "$path"
  else
    printf '%s://%s%s' "$SCHEME" "$host" "$path"
  fi
}

curl_json_host() {
  local host="$1"
  local method="$2"
  local path="$3"
  local body="${4:-}"
  local args=(
    -fsS --max-time 30
    -H "Host: ${host}"
    -H "Authorization: Bearer ${AUTH_TOKEN}"
    -H "Content-Type: application/json"
    -X "${method}"
  )
  if [[ -z "$FEDERATION_ORIGIN" && -n "$RESOLVE_ADDRESS" ]]; then
    args+=(--resolve "${host}:$(resolve_port):${RESOLVE_ADDRESS}")
  fi
  if [[ -n "$body" ]]; then
    args+=(-d "$body")
  fi
  curl "${args[@]}" "$(target_url "$host" "$path")"
}

health_host() {
  local host="$1"
  local args=(-fsS --max-time 10 -H "Host: ${host}" -H "Authorization: Bearer ${AUTH_TOKEN}")
  if [[ -z "$FEDERATION_ORIGIN" && -n "$RESOLVE_ADDRESS" ]]; then
    args+=(--resolve "${host}:$(resolve_port):${RESOLVE_ADDRESS}")
  fi
  curl "${args[@]}" "$(target_url "$host" "/health")" >/dev/null
}

wait_for_host() {
  local host="$1" label="$2"
  for _ in $(seq 1 40); do
    if health_host "$host"; then
      pass "$label reachable"
      return 0
    fi
    sleep 5
  done
  fail "$label reachable" "timed out waiting for ${host}"
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

select_audit_account_triplet() {
  local b1_accounts_file="$1" b2_accounts_file="$2"
  python3 -c '
import json, sys

payload = json.load(sys.stdin)
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    b1_payload = json.load(handle)
with open(sys.argv[2], "r", encoding="utf-8") as handle:
    b2_payload = json.load(handle)

accounts = payload.get("localAccounts", [])
if not accounts:
    print("\t\t")
    raise SystemExit(0)

blocked = {
    (acct.get("providerId", ""), acct.get("accountId", ""))
    for host_payload in (b1_payload, b2_payload)
    for acct in host_payload.get("localAccounts", [])
}

acct = next(
    (
        candidate for candidate in accounts
        if (candidate.get("providerId", ""), candidate.get("accountId", "")) not in blocked
    ),
    None,
)
if acct is None:
    print("\t\t")
    raise SystemExit(0)

print("{}\t{}\t{}".format(acct.get("providerId", ""), acct.get("accountId", ""), acct.get("displayName", "")))
' "$b1_accounts_file" "$b2_accounts_file"
}

known_account_state() {
  local provider_id="$1" account_id="$2"
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
  python3 -c 'import sys; print(len(set(line.strip() for line in sys.stdin if line.strip())))'
}

register_peer() {
  local target_host="$1" peer_id="$2" peer_host="$3" group_id="$4"
  local body
  body=$(python3 - <<'PY' "$peer_id" "$peer_host" "$group_id" "$OWNER_DID" "$AUTH_TOKEN"
import json, sys
peer_id, peer_host, group_id, owner_did, auth_token = sys.argv[1:6]
print(json.dumps({
  "id": peer_id,
  "ownerCredential": owner_did,
  "peerDid": f"did:web:{peer_host}",
  "label": f"{peer_id} ({group_id})",
  "baseUrl": f"{sys.argv[6] if False else ''}",
}))
PY
)
  # Replace the empty baseUrl generated above with the live host URL without reintroducing shell escaping bugs.
  body=$(python3 - <<'PY' "$body" "$peer_id" "$peer_host" "$group_id" "$OWNER_DID" "$AUTH_TOKEN" "$SCHEME"
import json, sys
payload = json.loads(sys.argv[1])
peer_id, peer_host, group_id, owner_did, auth_token, scheme = sys.argv[2:8]
payload.update({
  "baseUrl": f"{scheme}://{peer_host}",
  "controlBaseUrl": f"{scheme}://{peer_host}",
  "auth": {"credential": auth_token},
  "capabilities": {"accounts": True, "usage": True, "audit": True},
  "status": "active",
})
print(json.dumps(payload))
PY
)
  curl_json_host "$target_host" POST "/api/ui/federation/peers" "$body" >/dev/null
}

bold "=== Deployed federation audit against ${HOST_SUFFIX} ==="

wait_for_host "$A1_HOST" "a1 node"
wait_for_host "$A2_HOST" "a2 node"
wait_for_host "$B1_HOST" "b1 node"
wait_for_host "$B2_HOST" "b2 node"
wait_for_host "$GROUP_A_HOST" "group-a"
wait_for_host "$GROUP_B_HOST" "group-b"
wait_for_host "$CLUSTER_HOST" "cluster"

bold "── 1. cluster/group/node routing ──"
A1_SELF=$(curl_json_host "$A1_HOST" GET "/api/ui/federation/self")
A2_SELF=$(curl_json_host "$A2_HOST" GET "/api/ui/federation/self")
B1_SELF=$(curl_json_host "$B1_HOST" GET "/api/ui/federation/self")
B2_SELF=$(curl_json_host "$B2_HOST" GET "/api/ui/federation/self")
if [[ "$(printf '%s' "$A1_SELF" | json_value 'nodeId')" == "a1" ]]; then
  pass "a1 node host routes to a1"
else
  fail "a1 node host" "wrong node"
fi
if [[ "$(printf '%s' "$A2_SELF" | json_value 'nodeId')" == "a2" ]]; then
  pass "a2 node host routes to a2"
else
  fail "a2 node host" "wrong node"
fi
if [[ "$(printf '%s' "$B1_SELF" | json_value 'nodeId')" == "b1" ]]; then
  pass "b1 node host routes to b1"
else
  fail "b1 node host" "wrong node"
fi
if [[ "$(printf '%s' "$B2_SELF" | json_value 'nodeId')" == "b2" ]]; then
  pass "b2 node host routes to b2"
else
  fail "b2 node host" "wrong node"
fi

GROUP_A_IDS=$(for _ in 1 2 3 4 5 6; do curl_json_host "$GROUP_A_HOST" GET "/api/ui/federation/self" | json_value 'nodeId'; done)
GROUP_B_IDS=$(for _ in 1 2 3 4 5 6; do curl_json_host "$GROUP_B_HOST" GET "/api/ui/federation/self" | json_value 'nodeId'; done)
CLUSTER_IDS=$(for _ in 1 2 3 4 5 6 7 8; do curl_json_host "$CLUSTER_HOST" GET "/api/ui/federation/self" | json_value 'nodeId'; done)
if printf '%s\n' "$GROUP_A_IDS" | grep -Ev '^(a1|a2)$' >/dev/null; then fail "group-a routing" "returned node outside group-a"; else pass "group-a routing stays within group-a"; fi
if printf '%s\n' "$GROUP_B_IDS" | grep -Ev '^(b1|b2)$' >/dev/null; then fail "group-b routing" "returned node outside group-b"; else pass "group-b routing stays within group-b"; fi
CLUSTER_UNIQUE=$(printf '%s\n' "$CLUSTER_IDS" | count_unique_node_ids)
if [[ "$CLUSTER_UNIQUE" -ge 2 ]]; then pass "cluster routing hits multiple nodes"; else fail "cluster routing hits multiple nodes" "observed only ${CLUSTER_UNIQUE} nodes"; fi

bold "── 2. peer registration and projected-state audit ──"
for peer in a2 b1 b2; do register_peer "$A1_HOST" "$peer" "${peer}.${HOST_SUFFIX}" "$( [[ "$peer" =~ ^a ]] && echo group-a || echo group-b )"; done
for peer in a1 a2 b2; do register_peer "$B1_HOST" "$peer" "${peer}.${HOST_SUFFIX}" "$( [[ "$peer" =~ ^a ]] && echo group-a || echo group-b )"; done

A1_ACCOUNTS=$(curl_json_host "$A1_HOST" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
A1_LOCAL_COUNT=$(printf '%s' "$A1_ACCOUNTS" | json_len 'localAccounts')
if [[ "$A1_LOCAL_COUNT" -eq 0 ]]; then
  info "No local credential on A1; seeding deterministic federation account"
  curl_json_host "$A1_HOST" POST "/api/ui/credentials/api-key" '{"providerId":"openai","accountId":"federation-seed-openai","credentialValue":"federation-seed-openai-token"}' >/dev/null
  A1_ACCOUNTS=$(curl_json_host "$A1_HOST" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
fi
B1_ACCOUNTS_FILE=$(mktemp)
B2_ACCOUNTS_FILE=$(mktemp)
curl_json_host "$B1_HOST" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}" > "$B1_ACCOUNTS_FILE"
curl_json_host "$B2_HOST" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}" > "$B2_ACCOUNTS_FILE"
IFS=$'\t' read -r FED_PROVIDER_ID FED_ACCOUNT_ID _ <<< "$(printf '%s' "$A1_ACCOUNTS" | select_audit_account_triplet "$B1_ACCOUNTS_FILE" "$B2_ACCOUNTS_FILE")"
rm -f "$B1_ACCOUNTS_FILE" "$B2_ACCOUNTS_FILE"
if [[ -z "$FED_PROVIDER_ID" || -z "$FED_ACCOUNT_ID" ]]; then
  AUDIT_WITNESS_ID="federation-audit-openai-$(date +%s)"
  info "No A1-only account candidate; seeding dedicated audit witness ${AUDIT_WITNESS_ID}"
  curl_json_host "$A1_HOST" POST "/api/ui/credentials/api-key" "$(python3 - <<'PY' "$AUDIT_WITNESS_ID"
import json, sys
account_id = sys.argv[1]
print(json.dumps({
  "providerId": "openai",
  "accountId": account_id,
  "credentialValue": f"{account_id}-token",
}))
PY
)" >/dev/null
  FED_PROVIDER_ID="openai"
  FED_ACCOUNT_ID="$AUDIT_WITNESS_ID"
fi
if [[ -n "$FED_PROVIDER_ID" && -n "$FED_ACCOUNT_ID" ]]; then
  pass "selected audit account ${FED_PROVIDER_ID}/${FED_ACCOUNT_ID}"
else
  fail "selected audit account" "missing provider/account id"
  exit 1
fi

SYNC_RESULT=$(curl_json_host "$B1_HOST" POST "/api/ui/federation/sync/pull" "$(python3 - <<'PY' "$OWNER_DID"
import json, sys
print(json.dumps({"peerId": "a1", "ownerSubject": sys.argv[1], "pullUsage": False}))
PY
)")
SYNC_COUNT=$(printf '%s' "$SYNC_RESULT" | json_value 'importedProjectedAccountsCount')
if [[ "${SYNC_COUNT}" -ge 1 ]]; then pass "projected account sync imported descriptors"; else fail "projected account sync" "count=${SYNC_COUNT}"; fi

for host in "$B1_HOST" "$B2_HOST"; do
  ACCOUNTS_JSON=$(curl_json_host "$host" GET "/api/ui/federation/accounts?ownerSubject=${OWNER_DID}")
  STATE_JSON=$(printf '%s' "$ACCOUNTS_JSON" | known_account_state "$FED_PROVIDER_ID" "$FED_ACCOUNT_ID")
  if [[ -z "$STATE_JSON" ]]; then
    fail "${host} projected account visibility" "missing projected account"
    continue
  fi
  HAS_CREDENTIALS=$(printf '%s' "$STATE_JSON" | json_value 'hasCredentials')
  if [[ "$HAS_CREDENTIALS" == "False" || "$HAS_CREDENTIALS" == "false" ]]; then
    pass "${host} sees projected descriptor without credentials"
  else
    fail "${host} descriptor state" "unexpected credential presence"
  fi
done

bold "── 3. warm transfer and usage propagation ──"
ROUTED_RESULT=''
for _ in 1 2 3; do
  ROUTED_RESULT=$(curl_json_host "$B1_HOST" POST "/api/ui/federation/projected-accounts/routed" "$(python3 - <<'PY' "$FED_PROVIDER_ID" "$FED_ACCOUNT_ID"
import json, sys
print(json.dumps({"sourcePeerId": "a1", "providerId": sys.argv[1], "accountId": sys.argv[2]}))
PY
)")
done
IMPORTED_CREDENTIAL=$(printf '%s' "$ROUTED_RESULT" | json_value 'importedCredential')
if [[ "$IMPORTED_CREDENTIAL" == "True" || "$IMPORTED_CREDENTIAL" == "true" ]]; then
  pass "warm routed account auto-imported credential"
else
  fail "warm routed account auto-imported credential" "import flag=${IMPORTED_CREDENTIAL}"
fi

SYNTHETIC_USAGE_ID="federation-usage-$(date +%s)"
SYNTHETIC_USAGE_TS=$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)
SYNTHETIC_PAYLOAD=$(python3 - <<'PY' "$SYNTHETIC_USAGE_ID" "$FED_PROVIDER_ID" "$FED_ACCOUNT_ID" "$SYNTHETIC_USAGE_TS"
import json, sys, time
entry_id, provider_id, account_id, timestamp_ms = sys.argv[1:5]
print(json.dumps({
  "entries": [{
    "id": entry_id,
    "timestamp": int(timestamp_ms),
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
curl_json_host "$A1_HOST" POST "/api/ui/federation/usage-import" "$SYNTHETIC_PAYLOAD" >/dev/null
pass "synthetic usage injected on A1"

USAGE_SYNC=$(curl_json_host "$B1_HOST" POST "/api/ui/federation/sync/pull" "$(python3 - <<'PY' "$OWNER_DID" "$SYNTHETIC_USAGE_TS"
import json, sys
owner_did, timestamp_ms = sys.argv[1:3]
print(json.dumps({"peerId": "a1", "ownerSubject": owner_did, "pullUsage": True, "sinceMs": max(0, int(timestamp_ms) - 1000)}))
PY
)")
IMPORTED_USAGE_COUNT=$(printf '%s' "$USAGE_SYNC" | json_value 'importedUsageCount')
if [[ "${IMPORTED_USAGE_COUNT}" -ge 1 ]]; then
  pass "usage sync imported rows into Group B"
else
  fail "usage sync imported rows into Group B" "count=${IMPORTED_USAGE_COUNT}"
fi

HAS_SYNTHETIC='False'
for _ in 1 2 3; do
  B2_LOGS=$(curl_json_host "$B2_HOST" GET "/api/ui/request-logs?limit=500")
  HAS_SYNTHETIC=$(printf '%s' "$B2_LOGS" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
target = sys.argv[1]
print(any(entry.get("id") == target for entry in payload.get("entries", [])))
' "$SYNTHETIC_USAGE_ID")
  if [[ "$HAS_SYNTHETIC" == "True" || "$HAS_SYNTHETIC" == "true" ]]; then
    break
  fi
  sleep 1
done
if [[ "$HAS_SYNTHETIC" == "True" || "$HAS_SYNTHETIC" == "true" ]]; then
  pass "Group B sibling sees synced usage"
else
  fail "Group B sibling sees synced usage" "missing usage id ${SYNTHETIC_USAGE_ID}"
fi

echo
bold "PASS: ${PASS}  FAIL: ${FAIL}"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
