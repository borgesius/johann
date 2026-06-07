#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

WORKER="${PHILOSOPHY_WORKER:-qwen-coder-hybrid-opencode}"
POLICY="${PHILOSOPHY_POLICY:-repair_focus_loop}"

npm run dev -- watch --latest --benchmark brief-philosophy-becoming-site --worker "$WORKER" --policy "$POLICY"
