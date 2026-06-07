#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

WORKER="${SELF_IMPROVE_WORKER:-qwen-coder-hybrid}"
POLICY="${SELF_IMPROVE_POLICY:-repair_focus_loop}"

npm run dev -- watch --latest --benchmark self_improve_harness --worker "$WORKER" --policy "$POLICY"
