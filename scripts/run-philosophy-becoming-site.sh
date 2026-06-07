#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$HOME/.openclaw/openclaw.json" ]; then
  export OPENROUTER_API_KEY="$(
    node -e 'const fs=require("fs"); const path=process.env.HOME + "/.openclaw/openclaw.json"; const data=JSON.parse(fs.readFileSync(path,"utf8")); process.stdout.write(data?.env?.OPENROUTER_API_KEY ?? "");'
  )"
fi

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "Missing OPENROUTER_API_KEY. Export it first or store it in ~/.openclaw/openclaw.json." >&2
  exit 1
fi

WORKER="${PHILOSOPHY_WORKER:-qwen-coder-hybrid-opencode}"
POLICY="${PHILOSOPHY_POLICY:-repair_focus_loop}"
BUDGET="${PHILOSOPHY_BUDGET:-60}"
MAX_CYCLES="${PHILOSOPHY_MAX_CYCLES:-8}"

npm run dev -- loop \
  --brief-file examples/briefs/philosophy-becoming-site.md \
  --worker "$WORKER" \
  --policy "$POLICY" \
  --budget "$BUDGET" \
  --max-cycles "$MAX_CYCLES" \
  --disable-plateau \
  --continue-after-success
