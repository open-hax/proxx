#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${DEPLOY_HOST:?DEPLOY_HOST is required}"
: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"

DEPLOY_ENABLE_TLS="${DEPLOY_ENABLE_TLS:-false}"
DEPLOY_HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-180}"
DEPLOY_SYNC_RUNTIME_FROM_SOURCE="${DEPLOY_SYNC_RUNTIME_FROM_SOURCE:-false}"
DEPLOY_SYNC_DB_FROM_SOURCE="${DEPLOY_SYNC_DB_FROM_SOURCE:-false}"
DEPLOY_COMPOSE_PROJECT_NAME="${DEPLOY_COMPOSE_PROJECT_NAME:-}"
DEPLOY_COMPOSE_FILES="${DEPLOY_COMPOSE_FILES:-}"
DEPLOY_CADDY_TEMPLATE="${DEPLOY_CADDY_TEMPLATE:-deploy/Caddyfile.template}"
DEPLOY_HEALTH_SERVICE="${DEPLOY_HEALTH_SERVICE:-open-hax-openai-proxy}"
DEPLOY_RESTART_SERVICES="${DEPLOY_RESTART_SERVICES:-open-hax-openai-proxy}"
DEPLOY_ENV_APPEND="${DEPLOY_ENV_APPEND:-}"
DEPLOY_SOURCE_HOST="${DEPLOY_SOURCE_HOST:-}"
DEPLOY_SOURCE_USER="${DEPLOY_SOURCE_USER:-$DEPLOY_USER}"
DEPLOY_SOURCE_PATH="${DEPLOY_SOURCE_PATH:-}"
DEPLOY_SOURCE_COMPOSE_PROJECT_NAME="${DEPLOY_SOURCE_COMPOSE_PROJECT_NAME:-}"
DEPLOY_SOURCE_COMPOSE_FILES="${DEPLOY_SOURCE_COMPOSE_FILES:-}"

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
SOURCE_REMOTE="${DEPLOY_SOURCE_USER}@${DEPLOY_SOURCE_HOST}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
EMPTY_COMPOSE_PROJECT_NAME="__EMPTY_COMPOSE_PROJECT_NAME__"
EMPTY_COMPOSE_FILES="__EMPTY_COMPOSE_FILES__"
REMOTE_COMPOSE_PROJECT_NAME="${DEPLOY_COMPOSE_PROJECT_NAME:-$EMPTY_COMPOSE_PROJECT_NAME}"
SOURCE_COMPOSE_PROJECT_NAME="${DEPLOY_SOURCE_COMPOSE_PROJECT_NAME:-$EMPTY_COMPOSE_PROJECT_NAME}"
REMOTE_COMPOSE_FILES="${DEPLOY_COMPOSE_FILES:-$EMPTY_COMPOSE_FILES}"
SOURCE_COMPOSE_FILES="${DEPLOY_SOURCE_COMPOSE_FILES:-$EMPTY_COMPOSE_FILES}"

fetch_remote_file() {
  local remote="$1" remote_path="$2" local_path="$3"
  ssh "${SSH_OPTS[@]}" "$remote" bash -s -- "$remote_path" <<'EOF' > "$local_path"
set -euo pipefail
cat "$1"
EOF
}

fetch_remote_file_if_exists() {
  local remote="$1" remote_path="$2" local_path="$3"
  if ssh "${SSH_OPTS[@]}" "$remote" test -f "$remote_path"; then
    fetch_remote_file "$remote" "$remote_path" "$local_path"
    return 0
  fi
  return 1
}

render_caddyfile() {
  local template_path="$1" output_path="$2" public_host="$3"
  python3 - "$template_path" "$output_path" "$public_host" <<'PY'
from pathlib import Path
import sys

template_path, output_path, public_host = sys.argv[1:4]
text = Path(template_path).read_text(encoding='utf-8')

replacements = {
    '__PUBLIC_HOST__': public_host,
    '__CLUSTER_PUBLIC_HOST__': public_host,
    '__GROUP_A_PUBLIC_HOST__': f'group-a.{public_host}',
    '__GROUP_B_PUBLIC_HOST__': f'group-b.{public_host}',
    '__A1_PUBLIC_HOST__': f'a1.{public_host}',
    '__A2_PUBLIC_HOST__': f'a2.{public_host}',
    '__B1_PUBLIC_HOST__': f'b1.{public_host}',
    '__B2_PUBLIC_HOST__': f'b2.{public_host}',
}

for needle, value in replacements.items():
    text = text.replace(needle, value)

Path(output_path).write_text(text, encoding='utf-8')
PY
}

build_runtime_payloads() {
  mkdir -p "$TMP_DIR"

  if [[ "$DEPLOY_SYNC_RUNTIME_FROM_SOURCE" == "true" ]]; then
    : "${DEPLOY_SOURCE_HOST:?DEPLOY_SOURCE_HOST is required when DEPLOY_SYNC_RUNTIME_FROM_SOURCE=true}"
    : "${DEPLOY_SOURCE_PATH:?DEPLOY_SOURCE_PATH is required when DEPLOY_SYNC_RUNTIME_FROM_SOURCE=true}"
    fetch_remote_file "$SOURCE_REMOTE" "$DEPLOY_SOURCE_PATH/.env" "$TMP_DIR/.env"
    fetch_remote_file "$SOURCE_REMOTE" "$DEPLOY_SOURCE_PATH/keys.json" "$TMP_DIR/keys.json"
    fetch_remote_file "$SOURCE_REMOTE" "$DEPLOY_SOURCE_PATH/models.json" "$TMP_DIR/models.json"
  fi

  if [[ -n "$DEPLOY_ENV_APPEND" && ! -f "$TMP_DIR/.env" ]]; then
    fetch_remote_file_if_exists "$REMOTE" "$DEPLOY_PATH/.env" "$TMP_DIR/.env" || true
  fi

  if [[ -n "${DEPLOY_ENV_FILE:-}" ]]; then
    printf '%s' "$DEPLOY_ENV_FILE" > "$TMP_DIR/.env"
  fi
  if [[ -n "${DEPLOY_KEYS_JSON:-}" ]]; then
    printf '%s' "$DEPLOY_KEYS_JSON" > "$TMP_DIR/keys.json"
  fi
  if [[ -n "${DEPLOY_MODELS_JSON:-}" ]]; then
    printf '%s' "$DEPLOY_MODELS_JSON" > "$TMP_DIR/models.json"
  fi

  if [[ -n "$DEPLOY_ENV_APPEND" ]]; then
    touch "$TMP_DIR/.env"
    printf '\n%s\n' "$DEPLOY_ENV_APPEND" >> "$TMP_DIR/.env"
  fi

  if [[ "$DEPLOY_ENABLE_TLS" == "true" ]]; then
    : "${DEPLOY_PUBLIC_HOST:?DEPLOY_PUBLIC_HOST is required when DEPLOY_ENABLE_TLS=true}"
    render_caddyfile "$DEPLOY_CADDY_TEMPLATE" "$TMP_DIR/Caddyfile" "$DEPLOY_PUBLIC_HOST"
  fi
}

sync_repo_tree() {
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$DEPLOY_PATH' '$DEPLOY_PATH/data' '$DEPLOY_PATH/db-backups' '$DEPLOY_PATH/deploy'"

  rsync -az --delete \
    --exclude '/.git/' \
    --exclude '/node_modules/' \
    --exclude '/dist/' \
    --exclude '/.env' \
    --exclude '/keys.json' \
    --exclude '/models.json' \
    --exclude '/data/' \
    --exclude '/db-backups/' \
    "$ROOT_DIR/" "$REMOTE:$DEPLOY_PATH/"

  if [[ -f "$TMP_DIR/.env" ]]; then
    rsync -az "$TMP_DIR/.env" "$REMOTE:$DEPLOY_PATH/.env"
  fi
  if [[ -f "$TMP_DIR/keys.json" ]]; then
    rsync -az "$TMP_DIR/keys.json" "$REMOTE:$DEPLOY_PATH/keys.json"
  fi
  if [[ -f "$TMP_DIR/models.json" ]]; then
    rsync -az "$TMP_DIR/models.json" "$REMOTE:$DEPLOY_PATH/models.json"
  fi

  if [[ "$DEPLOY_ENABLE_TLS" == "true" ]]; then
    rsync -az "$ROOT_DIR/deploy/docker-compose.ssl.yml" "$REMOTE:$DEPLOY_PATH/deploy/docker-compose.ssl.yml"
    rsync -az "$TMP_DIR/Caddyfile" "$REMOTE:$DEPLOY_PATH/Caddyfile"
  fi
}

remote_compose_up() {
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$DEPLOY_PATH" "$DEPLOY_ENABLE_TLS" "$REMOTE_COMPOSE_PROJECT_NAME" "$REMOTE_COMPOSE_FILES" <<'EOF'
set -euo pipefail
DEPLOY_PATH="$1"
DEPLOY_ENABLE_TLS="$2"
DEPLOY_COMPOSE_PROJECT_NAME="$3"
DEPLOY_COMPOSE_FILES="$4"
if [[ "$DEPLOY_COMPOSE_PROJECT_NAME" == "__EMPTY_COMPOSE_PROJECT_NAME__" ]]; then
  DEPLOY_COMPOSE_PROJECT_NAME=""
fi
if [[ "$DEPLOY_COMPOSE_FILES" == "__EMPTY_COMPOSE_FILES__" ]]; then
  DEPLOY_COMPOSE_FILES=""
fi
cd "$DEPLOY_PATH"
docker network create ai-infra >/dev/null 2>&1 || true
compose_args=()
if [[ -n "$DEPLOY_COMPOSE_PROJECT_NAME" ]]; then
  compose_args+=(--project-name "$DEPLOY_COMPOSE_PROJECT_NAME")
fi
if [[ -n "$DEPLOY_COMPOSE_FILES" ]]; then
  IFS=',' read -r -a compose_files <<< "$DEPLOY_COMPOSE_FILES"
  for file in "${compose_files[@]}"; do
    [[ -n "$file" ]] && compose_args+=(-f "$file")
  done
elif [[ "$DEPLOY_ENABLE_TLS" == "true" ]]; then
  compose_args+=(-f docker-compose.yml -f deploy/docker-compose.ssl.yml)
else
  compose_args+=(-f docker-compose.yml)
fi
docker compose "${compose_args[@]}" up -d --build --remove-orphans
EOF
}

sync_operational_db_from_source() {
  : "${DEPLOY_SOURCE_HOST:?DEPLOY_SOURCE_HOST is required when DEPLOY_SYNC_DB_FROM_SOURCE=true}"
  : "${DEPLOY_SOURCE_PATH:?DEPLOY_SOURCE_PATH is required when DEPLOY_SYNC_DB_FROM_SOURCE=true}"
  local dump_file="$TMP_DIR/operational.sql"

  ssh "${SSH_OPTS[@]}" "$SOURCE_REMOTE" bash -s -- "$DEPLOY_SOURCE_PATH" "$SOURCE_COMPOSE_PROJECT_NAME" "$SOURCE_COMPOSE_FILES" > "$dump_file" <<'EOF'
set -euo pipefail
SOURCE_PATH="$1"
DEPLOY_SOURCE_COMPOSE_PROJECT_NAME="$2"
DEPLOY_SOURCE_COMPOSE_FILES="$3"
if [[ "$DEPLOY_SOURCE_COMPOSE_PROJECT_NAME" == "__EMPTY_COMPOSE_PROJECT_NAME__" ]]; then
  DEPLOY_SOURCE_COMPOSE_PROJECT_NAME=""
fi
if [[ "$DEPLOY_SOURCE_COMPOSE_FILES" == "__EMPTY_COMPOSE_FILES__" ]]; then
  DEPLOY_SOURCE_COMPOSE_FILES=""
fi
cd "$SOURCE_PATH"
compose_args=()
if [[ -n "$DEPLOY_SOURCE_COMPOSE_PROJECT_NAME" ]]; then
  compose_args+=(--project-name "$DEPLOY_SOURCE_COMPOSE_PROJECT_NAME")
fi
if [[ -n "$DEPLOY_SOURCE_COMPOSE_FILES" ]]; then
  IFS=',' read -r -a compose_files <<< "$DEPLOY_SOURCE_COMPOSE_FILES"
  for file in "${compose_files[@]}"; do
    [[ -n "$file" ]] && compose_args+=(-f "$file")
  done
else
  compose_args+=(-f docker-compose.yml)
fi
docker compose "${compose_args[@]}" exec -T open-hax-openai-proxy-db \
  pg_dump -U openai_proxy -d openai_proxy --data-only --column-inserts \
  --table=providers \
  --table=accounts \
  --table=account_health \
  --table=account_cooldown \
  --table=models \
  --table=config \
  --table=tenants \
  --table=users \
  --table=tenant_memberships \
  --table=tenant_api_keys \
  --table=access_tokens \
  --table=refresh_tokens \
  --table=sessions
EOF

  ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$DEPLOY_PATH" "$REMOTE_COMPOSE_PROJECT_NAME" "$REMOTE_COMPOSE_FILES" <<'EOF'
set -euo pipefail
DEPLOY_PATH="$1"
DEPLOY_COMPOSE_PROJECT_NAME="$2"
DEPLOY_COMPOSE_FILES="$3"
if [[ "$DEPLOY_COMPOSE_PROJECT_NAME" == "__EMPTY_COMPOSE_PROJECT_NAME__" ]]; then
  DEPLOY_COMPOSE_PROJECT_NAME=""
fi
if [[ "$DEPLOY_COMPOSE_FILES" == "__EMPTY_COMPOSE_FILES__" ]]; then
  DEPLOY_COMPOSE_FILES=""
fi
cd "$DEPLOY_PATH"
compose_args=()
if [[ -n "$DEPLOY_COMPOSE_PROJECT_NAME" ]]; then
  compose_args+=(--project-name "$DEPLOY_COMPOSE_PROJECT_NAME")
fi
if [[ -n "$DEPLOY_COMPOSE_FILES" ]]; then
  IFS=',' read -r -a compose_files <<< "$DEPLOY_COMPOSE_FILES"
  for file in "${compose_files[@]}"; do
    [[ -n "$file" ]] && compose_args+=(-f "$file")
  done
else
  compose_args+=(-f docker-compose.yml)
fi
docker compose "${compose_args[@]}" exec -T open-hax-openai-proxy-db \
  psql -U openai_proxy -d openai_proxy \
  -c "TRUNCATE TABLE sessions, refresh_tokens, access_tokens, tenant_api_keys, tenant_memberships, users, tenants, account_health, account_cooldown, accounts, providers, models, config CASCADE;" >/dev/null
EOF

  rsync -az "$dump_file" "$REMOTE:$DEPLOY_PATH/db-backups/operational-sync.sql"

  ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$DEPLOY_PATH" "$REMOTE_COMPOSE_PROJECT_NAME" "$REMOTE_COMPOSE_FILES" <<'EOF'
set -euo pipefail
DEPLOY_PATH="$1"
DEPLOY_COMPOSE_PROJECT_NAME="$2"
DEPLOY_COMPOSE_FILES="$3"
if [[ "$DEPLOY_COMPOSE_PROJECT_NAME" == "__EMPTY_COMPOSE_PROJECT_NAME__" ]]; then
  DEPLOY_COMPOSE_PROJECT_NAME=""
fi
if [[ "$DEPLOY_COMPOSE_FILES" == "__EMPTY_COMPOSE_FILES__" ]]; then
  DEPLOY_COMPOSE_FILES=""
fi
cd "$DEPLOY_PATH"
compose_args=()
if [[ -n "$DEPLOY_COMPOSE_PROJECT_NAME" ]]; then
  compose_args+=(--project-name "$DEPLOY_COMPOSE_PROJECT_NAME")
fi
if [[ -n "$DEPLOY_COMPOSE_FILES" ]]; then
  IFS=',' read -r -a compose_files <<< "$DEPLOY_COMPOSE_FILES"
  for file in "${compose_files[@]}"; do
    [[ -n "$file" ]] && compose_args+=(-f "$file")
  done
else
  compose_args+=(-f docker-compose.yml)
fi
docker compose "${compose_args[@]}" exec -T open-hax-openai-proxy-db psql -U openai_proxy -d openai_proxy < "$DEPLOY_PATH/db-backups/operational-sync.sql"
rm -f "$DEPLOY_PATH/db-backups/operational-sync.sql"
EOF

  ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$DEPLOY_PATH" "$DEPLOY_ENABLE_TLS" "$REMOTE_COMPOSE_PROJECT_NAME" "$REMOTE_COMPOSE_FILES" "$DEPLOY_RESTART_SERVICES" <<'EOF'
set -euo pipefail
DEPLOY_PATH="$1"
DEPLOY_ENABLE_TLS="$2"
DEPLOY_COMPOSE_PROJECT_NAME="$3"
DEPLOY_COMPOSE_FILES="$4"
DEPLOY_RESTART_SERVICES="$5"
if [[ "$DEPLOY_COMPOSE_PROJECT_NAME" == "__EMPTY_COMPOSE_PROJECT_NAME__" ]]; then
  DEPLOY_COMPOSE_PROJECT_NAME=""
fi
if [[ "$DEPLOY_COMPOSE_FILES" == "__EMPTY_COMPOSE_FILES__" ]]; then
  DEPLOY_COMPOSE_FILES=""
fi
cd "$DEPLOY_PATH"
compose_args=()
if [[ -n "$DEPLOY_COMPOSE_PROJECT_NAME" ]]; then
  compose_args+=(--project-name "$DEPLOY_COMPOSE_PROJECT_NAME")
fi
if [[ -n "$DEPLOY_COMPOSE_FILES" ]]; then
  IFS=',' read -r -a compose_files <<< "$DEPLOY_COMPOSE_FILES"
  for file in "${compose_files[@]}"; do
    [[ -n "$file" ]] && compose_args+=(-f "$file")
  done
elif [[ "$DEPLOY_ENABLE_TLS" == "true" ]]; then
  compose_args+=(-f docker-compose.yml -f deploy/docker-compose.ssl.yml)
else
  compose_args+=(-f docker-compose.yml)
fi
if [[ -n "$DEPLOY_RESTART_SERVICES" ]]; then
  IFS=',' read -r -a restart_services <<< "$DEPLOY_RESTART_SERVICES"
  docker compose "${compose_args[@]}" restart "${restart_services[@]}"
fi
EOF
}

wait_for_remote_health() {
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$DEPLOY_PATH" "$DEPLOY_ENABLE_TLS" "$DEPLOY_HEALTH_TIMEOUT_SECONDS" "$REMOTE_COMPOSE_PROJECT_NAME" "$REMOTE_COMPOSE_FILES" "$DEPLOY_HEALTH_SERVICE" <<'EOF'
set -euo pipefail
DEPLOY_PATH="$1"
DEPLOY_ENABLE_TLS="$2"
DEPLOY_HEALTH_TIMEOUT_SECONDS="$3"
DEPLOY_COMPOSE_PROJECT_NAME="$4"
DEPLOY_COMPOSE_FILES="$5"
DEPLOY_HEALTH_SERVICE="$6"
if [[ "$DEPLOY_COMPOSE_PROJECT_NAME" == "__EMPTY_COMPOSE_PROJECT_NAME__" ]]; then
  DEPLOY_COMPOSE_PROJECT_NAME=""
fi
if [[ "$DEPLOY_COMPOSE_FILES" == "__EMPTY_COMPOSE_FILES__" ]]; then
  DEPLOY_COMPOSE_FILES=""
fi
cd "$DEPLOY_PATH"
compose_args=()
if [[ -n "$DEPLOY_COMPOSE_PROJECT_NAME" ]]; then
  compose_args+=(--project-name "$DEPLOY_COMPOSE_PROJECT_NAME")
fi
if [[ -n "$DEPLOY_COMPOSE_FILES" ]]; then
  IFS=',' read -r -a compose_files <<< "$DEPLOY_COMPOSE_FILES"
  for file in "${compose_files[@]}"; do
    [[ -n "$file" ]] && compose_args+=(-f "$file")
  done
elif [[ "$DEPLOY_ENABLE_TLS" == "true" ]]; then
  compose_args+=(-f docker-compose.yml -f deploy/docker-compose.ssl.yml)
else
  compose_args+=(-f docker-compose.yml)
fi
deadline=$(( $(date +%s) + DEPLOY_HEALTH_TIMEOUT_SECONDS ))
while true; do
  container_id="$(docker compose "${compose_args[@]}" ps -q "$DEPLOY_HEALTH_SERVICE")"
  if [[ -n "$container_id" ]]; then
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    if [[ "$health" == "healthy" || "$health" == "running" ]]; then
      exit 0
    fi
  fi

  if (( $(date +%s) >= deadline )); then
    echo "remote deploy health check timed out" >&2
    docker compose "${compose_args[@]}" ps >&2 || true
    docker compose "${compose_args[@]}" logs --tail=200 >&2 || true
    exit 1
  fi

  sleep 5
done
EOF
}

build_runtime_payloads
sync_repo_tree
remote_compose_up
if [[ "$DEPLOY_SYNC_DB_FROM_SOURCE" == "true" ]]; then
  sync_operational_db_from_source
fi
wait_for_remote_health
