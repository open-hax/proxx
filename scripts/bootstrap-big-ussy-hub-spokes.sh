#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

read_env_value() {
  local key="$1"
  local fallback="${2:-}"
  python3 - "$ROOT_DIR/.env" "$key" "$fallback" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
key = sys.argv[2]
fallback = sys.argv[3]

if env_path.exists():
    resolved = None
    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        current_key, value = line.split('=', 1)
        if current_key.strip() == key:
            resolved = value.strip()
    if resolved is not None:
        print(resolved)
        raise SystemExit(0)

print(fallback)
PY
}

env_or_file() {
  local key="$1"
  local fallback="${2:-}"
  local current="${!key:-}"
  if [[ -n "$current" ]]; then
    printf '%s\n' "$current"
    return 0
  fi
  read_env_value "$key" "$fallback"
}

OWNER_SUBJECT="$(env_or_file FEDERATION_DEFAULT_OWNER_SUBJECT 'did:web:big.ussy.promethean.rest')"
CORE_PUBLIC_BASE_URL="$(env_or_file FEDERATION_SELF_PUBLIC_BASE_URL 'https://federation.big.ussy.promethean.rest')"
CORE_PEER_DID="$(env_or_file BIG_USSY_CORE_PEER_DID 'did:web:federation.big.ussy.promethean.rest')"
FEDERATION_PEER_DID="$(env_or_file BIG_USSY_FEDERATION_PEER_DID 'did:web:big.ussy.promethean.rest:spokes:federation')"
BLONGS_PEER_DID="$(env_or_file BIG_USSY_BLONGS_PEER_DID 'did:web:big.ussy.promethean.rest:spokes:blongs')"
CEPHALON_PEER_DID="$(env_or_file BIG_USSY_CEPHALON_PEER_DID 'did:web:big.ussy.promethean.rest:spokes:cephalon')"

CORE_URL="http://127.0.0.1:${PROXY_PORT:-8789}"
FEDERATION_URL="http://127.0.0.1:${FEDERATION_PROXY_PORT:-18792}"
BLONGS_URL="http://127.0.0.1:${BLONGS_PROXY_PORT:-5277}"
CEPHALON_URL="http://127.0.0.1:${CEPHALON_PROXX_PORT:-18779}"

CORE_TOKEN="$(env_or_file PROXY_AUTH_TOKEN '')"
FEDERATION_TOKEN="$(env_or_file FEDERATION_PROXY_AUTH_TOKEN 'big-ussy-federation-spoke-token')"
BLONGS_TOKEN="$(env_or_file BLONGS_PROXY_AUTH_TOKEN 'big-ussy-blongs-spoke-token')"
CEPHALON_TOKEN="$(env_or_file PROXX_PROXY_AUTH_TOKEN 'big-ussy-cephalon-spoke-token')"

if [[ -z "$CORE_TOKEN" ]]; then
  echo "PROXY_AUTH_TOKEN is required" >&2
  exit 1
fi

wait_for_health() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-45}"
  local attempt=1
  while (( attempt <= max_attempts )); do
    if curl -fsS "$url/health" >/dev/null 2>&1; then
      echo "healthy: $name -> $url" >&2
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  echo "health timeout: $name -> $url" >&2
  return 1
}

upsert_peer() {
  local target_url="$1"
  local target_token="$2"
  local peer_id="$3"
  local label="$4"
  local peer_did="$5"
  local base_url="$6"
  local control_base_url="$7"
  python3 - "$OWNER_SUBJECT" "$peer_id" "$label" "$peer_did" "$base_url" "$control_base_url" <<'PY' \
    | curl -fsS -X POST "$target_url/api/ui/federation/peers" \
        -H "Authorization: Bearer $target_token" \
        -H 'Content-Type: application/json' \
        --data-binary @- >/dev/null
import json
import sys
owner_subject, peer_id, label, peer_did, base_url, control_base_url = sys.argv[1:7]
print(json.dumps({
    'id': peer_id,
    'ownerCredential': owner_subject,
    'peerDid': peer_did,
    'label': label,
    'baseUrl': base_url,
    'controlBaseUrl': control_base_url,
    'auth': {'credential': 'set-by-caller'},
    'capabilities': {'accounts': True, 'usage': True, 'audit': True},
    'status': 'active',
}))
PY
}

upsert_peer_with_auth() {
  local target_url="$1"
  local target_token="$2"
  local peer_id="$3"
  local label="$4"
  local peer_did="$5"
  local base_url="$6"
  local control_base_url="$7"
  local auth_credential="$8"
  python3 - "$OWNER_SUBJECT" "$peer_id" "$label" "$peer_did" "$base_url" "$control_base_url" "$auth_credential" <<'PY' \
    | curl -fsS -X POST "$target_url/api/ui/federation/peers" \
        -H "Authorization: Bearer $target_token" \
        -H 'Content-Type: application/json' \
        --data-binary @- >/dev/null
import json
import sys
owner_subject, peer_id, label, peer_did, base_url, control_base_url, auth_credential = sys.argv[1:8]
print(json.dumps({
    'id': peer_id,
    'ownerCredential': owner_subject,
    'peerDid': peer_did,
    'label': label,
    'baseUrl': base_url,
    'controlBaseUrl': control_base_url,
    'auth': {'credential': auth_credential},
    'capabilities': {'accounts': True, 'usage': True, 'audit': True},
    'status': 'active',
}))
PY
}

sync_once() {
  local base_url="$1"
  local auth_token="$2"
  local peer_id="$3"
  python3 - "$peer_id" "$OWNER_SUBJECT" <<'PY' \
    | curl -fsS -X POST "$base_url/api/ui/federation/sync/pull" \
        -H "Authorization: Bearer $auth_token" \
        -H 'Content-Type: application/json' \
        --data-binary @- >/dev/null
import json
import sys
peer_id, owner_subject = sys.argv[1:3]
print(json.dumps({
    'peerId': peer_id,
    'ownerSubject': owner_subject,
    'pullUsage': False,
}))
PY
}

show_peer_summary() {
  local name="$1"
  local url="$2"
  local token="$3"
  local json
  json="$(curl -fsS "$url/api/ui/federation/peers" -H "Authorization: Bearer $token")"
  python3 -c 'import json,sys
name = sys.argv[1]
payload = json.load(sys.stdin)
peers = payload.get("peers", [])
print(f"{name}: {len(peers)} peers")
for peer in peers:
    print("  - {} -> {} ({})".format(peer.get("id"), peer.get("baseUrl"), peer.get("label")))' "$name" <<< "$json"
}

wait_for_health "core" "$CORE_URL"
wait_for_health "federation-spoke" "$FEDERATION_URL"
wait_for_health "blongs-spoke" "$BLONGS_URL"
wait_for_health "cephalon-spoke" "$CEPHALON_URL"

upsert_peer_with_auth "$CORE_URL" "$CORE_TOKEN" "spoke-federation" "Big Ussy Federation Spoke" "$FEDERATION_PEER_DID" "http://proxx-federation-peer:8789" "http://proxx-federation-peer:8789" "$FEDERATION_TOKEN"
upsert_peer_with_auth "$CORE_URL" "$CORE_TOKEN" "spoke-blongs" "Big Ussy Blongs Spoke" "$BLONGS_PEER_DID" "http://proxx-blongs:8789" "http://proxx-blongs:8789" "$BLONGS_TOKEN"
upsert_peer_with_auth "$CORE_URL" "$CORE_TOKEN" "spoke-cephalon" "Big Ussy Cephalon Spoke" "$CEPHALON_PEER_DID" "http://cephalon-hive-proxx:8789" "http://cephalon-hive-proxx:8789" "$CEPHALON_TOKEN"

upsert_peer_with_auth "$FEDERATION_URL" "$FEDERATION_TOKEN" "canonical-core" "Big Ussy Canonical Core" "$CORE_PEER_DID" "http://proxx:8789" "http://proxx:8789" "$CORE_TOKEN"
upsert_peer_with_auth "$BLONGS_URL" "$BLONGS_TOKEN" "canonical-core" "Big Ussy Canonical Core" "$CORE_PEER_DID" "http://proxx:8789" "http://proxx:8789" "$CORE_TOKEN"
upsert_peer_with_auth "$CEPHALON_URL" "$CEPHALON_TOKEN" "canonical-core" "Big Ussy Canonical Core" "$CORE_PEER_DID" "http://proxx:8789" "http://proxx:8789" "$CORE_TOKEN"

sync_once "$CORE_URL" "$CORE_TOKEN" "spoke-federation"
sync_once "$CORE_URL" "$CORE_TOKEN" "spoke-blongs"
sync_once "$CORE_URL" "$CORE_TOKEN" "spoke-cephalon"
sync_once "$FEDERATION_URL" "$FEDERATION_TOKEN" "canonical-core"
sync_once "$BLONGS_URL" "$BLONGS_TOKEN" "canonical-core"
sync_once "$CEPHALON_URL" "$CEPHALON_TOKEN" "canonical-core"

show_peer_summary "core" "$CORE_URL" "$CORE_TOKEN"
show_peer_summary "federation-spoke" "$FEDERATION_URL" "$FEDERATION_TOKEN"
show_peer_summary "blongs-spoke" "$BLONGS_URL" "$BLONGS_TOKEN"
show_peer_summary "cephalon-spoke" "$CEPHALON_URL" "$CEPHALON_TOKEN"

echo "canonical public base URL: $CORE_PUBLIC_BASE_URL" >&2
