#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

bash ./scripts/refresh-self-improve-seed.sh

if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$HOME/.openclaw/openclaw.json" ]; then
  export OPENROUTER_API_KEY="$(
    node -e 'const fs=require("fs"); const path=process.env.HOME + "/.openclaw/openclaw.json"; const data=JSON.parse(fs.readFileSync(path,"utf8")); process.stdout.write(data?.env?.OPENROUTER_API_KEY ?? "");'
  )"
fi

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "Missing OPENROUTER_API_KEY. Export it first or store it in ~/.openclaw/openclaw.json." >&2
  exit 1
fi

WORKER="${SELF_IMPROVE_WORKER:-qwen-coder-hybrid}"
POLICY="${SELF_IMPROVE_POLICY:-repair_focus_loop}"
BUDGET="${SELF_IMPROVE_BUDGET:-240}"
MAX_CYCLES="${SELF_IMPROVE_MAX_CYCLES:-12}"
PLATEAU_WINDOW="${SELF_IMPROVE_PLATEAU_WINDOW:-6}"
PLATEAU_THRESHOLD="${SELF_IMPROVE_PLATEAU_THRESHOLD:-0.5}"

npm run dev -- loop \
  --benchmark self_improve_harness \
  --worker "$WORKER" \
  --policy "$POLICY" \
  --budget "$BUDGET" \
  --max-cycles "$MAX_CYCLES" \
  --plateau-window "$PLATEAU_WINDOW" \
  --plateau-threshold "$PLATEAU_THRESHOLD" \
  --continue-after-success
