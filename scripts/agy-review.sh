#!/usr/bin/env bash
set -euo pipefail

# Local review runner using agy with Gemini 3.8 Flash
BASE_SHA="${1:-HEAD~1}"
HEAD_SHA="${2:-HEAD}"
SUBMODULE="proxx"

echo "==> Running agy Gemini 3.8 Flash review workflow for ${SUBMODULE} [${BASE_SHA}..${HEAD_SHA}]"

if command -v agy &>/dev/null; then
  agy --agent review-workflow --model gemini-3.8-flash-high --effort high -p \
    "Review commit range ${BASE_SHA}..${HEAD_SHA} in ${SUBMODULE} following .agents/agents/review-workflow.md." || \
  agy --model gemini-3.8-flash-high --effort high -p \
    "Review commit range ${BASE_SHA}..${HEAD_SHA} in ${SUBMODULE} following .agents/agents/review-workflow.md."
else
  echo "Error: agy CLI is not installed or not on PATH." >&2
  exit 1
fi
