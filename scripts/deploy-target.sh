#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_NAME="${1:-}"
if [[ -z "$TARGET_NAME" ]]; then
  echo "usage: $0 <target-name>" >&2
  exit 1
fi
shift || true

TARGET_FILE="$ROOT_DIR/deploy/targets/${TARGET_NAME}.env"
if [[ ! -f "$TARGET_FILE" ]]; then
  echo "target file not found: $TARGET_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$TARGET_FILE"

: "${DEPLOY_HOST:?DEPLOY_HOST is required in target file}"
: "${DEPLOY_USER:?DEPLOY_USER is required in target file}"
: "${DEPLOY_PATH:?DEPLOY_PATH is required in target file}"
: "${SOURCE_RUNTIME_DIR:?SOURCE_RUNTIME_DIR is required in target file}"

append_env_line_if_set() {
  local key="$1"
  local value="${!key:-}"
  if [[ -n "$value" ]]; then
    DEPLOY_ENV_APPEND+="${key}=${value}"$'\n'
  fi
}

for required in .env models.json; do
  if [[ ! -f "$SOURCE_RUNTIME_DIR/$required" ]]; then
    echo "missing required runtime file: $SOURCE_RUNTIME_DIR/$required" >&2
    exit 1
  fi
done

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)

if [[ -n "${PRE_DEPLOY_DOWN_COMPOSE_PROJECT_NAME:-}" || -n "${PRE_DEPLOY_DOWN_COMPOSE_FILES:-}" ]]; then
  PRE_DEPLOY_DOWN_COMPOSE_DIR="${PRE_DEPLOY_DOWN_COMPOSE_DIR:-$DEPLOY_PATH}"
  echo "Tearing down pre-existing compose project on ${REMOTE}: ${PRE_DEPLOY_DOWN_COMPOSE_PROJECT_NAME:-<default>}" >&2
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$PRE_DEPLOY_DOWN_COMPOSE_DIR" "${PRE_DEPLOY_DOWN_COMPOSE_PROJECT_NAME:-}" "${PRE_DEPLOY_DOWN_COMPOSE_FILES:-}" <<'EOF'
set -euo pipefail
COMPOSE_DIR="$1"
PROJECT_NAME="$2"
COMPOSE_FILES="$3"
if [[ ! -d "$COMPOSE_DIR" ]]; then
  echo "compose dir missing, skipping pre-down: $COMPOSE_DIR" >&2
  exit 0
fi
cd "$COMPOSE_DIR"
compose_args=()
if [[ -f .env ]]; then
  compose_args+=(--env-file .env)
fi
if [[ -n "$PROJECT_NAME" ]]; then
  compose_args+=(--project-name "$PROJECT_NAME")
fi
IFS=',' read -r -a compose_files <<< "$COMPOSE_FILES"
for file in "${compose_files[@]}"; do
  [[ -n "$file" ]] && compose_args+=(-f "$file")
done
docker compose "${compose_args[@]}" down --remove-orphans || true
EOF
fi

if [[ -n "${PRE_DEPLOY_STOP_COMPOSE_DIR:-}" && -n "${PRE_DEPLOY_STOP_SERVICES:-}" ]]; then
  echo "Stopping pre-existing services on ${REMOTE}: ${PRE_DEPLOY_STOP_SERVICES}" >&2
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$PRE_DEPLOY_STOP_COMPOSE_DIR" "$PRE_DEPLOY_STOP_SERVICES" <<'EOF'
set -euo pipefail
COMPOSE_DIR="$1"
SERVICES="$2"
if [[ ! -d "$COMPOSE_DIR" ]]; then
  echo "compose dir missing, skipping pre-stop: $COMPOSE_DIR" >&2
  exit 0
fi
cd "$COMPOSE_DIR"
read -r -a service_args <<< "${SERVICES//,/ }"
docker compose stop "${service_args[@]}" || true
EOF
fi

DEPLOY_ENV_FILE="$(cat "$SOURCE_RUNTIME_DIR/.env")"
DEPLOY_MODELS_JSON="$(cat "$SOURCE_RUNTIME_DIR/models.json")"
DEPLOY_ENV_APPEND=$'\n'
DEPLOY_ENV_APPEND+=$'FEDERATION_CLUSTER_ID=big-ussy\n'
DEPLOY_ENV_APPEND+="FEDERATION_PUBLIC_HOST_SUFFIX=${BIG_USSY_PUBLIC_HOST_SUFFIX}"$'\n'
DEPLOY_ENV_APPEND+="FEDERATION_DEFAULT_OWNER_SUBJECT=${BIG_USSY_DEFAULT_OWNER_SUBJECT}"$'\n'
DEPLOY_ENV_APPEND+="VITE_ALLOWED_HOSTS=${BIG_USSY_ALLOWED_HOSTS}"$'\n'
DEPLOY_ENV_APPEND+="BIG_USSY_API_PORT=${BIG_USSY_API_PORT}"$'\n'
DEPLOY_ENV_APPEND+="BIG_USSY_WEB_PORT=${BIG_USSY_WEB_PORT}"$'\n'

if [[ -n "${DEPLOY_ENV_PASSTHROUGH_KEYS:-}" ]]; then
  read -r -a passthrough_keys <<< "${DEPLOY_ENV_PASSTHROUGH_KEYS//,/ }"
  for key in "${passthrough_keys[@]}"; do
    append_env_line_if_set "$key"
  done
fi

export DEPLOY_HOST DEPLOY_USER DEPLOY_PATH DEPLOY_COMPOSE_PROJECT_NAME DEPLOY_COMPOSE_FILES
export DEPLOY_HEALTH_SERVICE DEPLOY_RESTART_SERVICES DEPLOY_ENABLE_TLS
export DEPLOY_ENV_FILE DEPLOY_MODELS_JSON DEPLOY_ENV_APPEND
export BIG_USSY_API_PORT BIG_USSY_WEB_PORT

"$ROOT_DIR/scripts/deploy-remote.sh" "$@"

if [[ -n "${POST_DEPLOY_REMOTE_SCRIPT:-}" ]]; then
  echo "Running remote post-deploy script on ${REMOTE}: ${POST_DEPLOY_REMOTE_SCRIPT}" >&2
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$DEPLOY_PATH" "$POST_DEPLOY_REMOTE_SCRIPT" <<'EOF'
set -euo pipefail
DEPLOY_PATH="$1"
POST_DEPLOY_REMOTE_SCRIPT="$2"
cd "$DEPLOY_PATH"
bash "$POST_DEPLOY_REMOTE_SCRIPT"
EOF
fi

echo "Post-deploy local verification on ${REMOTE}" >&2
# shellcheck disable=SC2029
ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s -- "$DEPLOY_PATH" "$DEPLOY_COMPOSE_PROJECT_NAME" "$DEPLOY_COMPOSE_FILES" <<'EOF'
set -euo pipefail
DEPLOY_PATH="$1"
PROJECT_NAME="$2"
COMPOSE_FILES="$3"
cd "$DEPLOY_PATH"
compose_args=()
if [[ -f .env ]]; then
  compose_args+=(--env-file .env)
fi
if [[ -n "$PROJECT_NAME" ]]; then
  compose_args+=(--project-name "$PROJECT_NAME")
fi
IFS=',' read -r -a compose_files <<< "$COMPOSE_FILES"
for file in "${compose_files[@]}"; do
  [[ -n "$file" ]] && compose_args+=(-f "$file")
done

docker compose "${compose_args[@]}" ps
printf '\nAPI health via host port:\n'
curl -fsS http://127.0.0.1:${BIG_USSY_API_PORT:-8789}/health | sed -n '1,40p'
printf '\nWeb head via host port:\n'
curl -fsSI http://127.0.0.1:${BIG_USSY_WEB_PORT:-5174}/ | sed -n '1,20p'
EOF
