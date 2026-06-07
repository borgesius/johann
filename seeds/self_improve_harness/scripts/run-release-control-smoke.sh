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

CHAIN_LABEL="${RELEASE_CONTROL_SMOKE_LABEL:-release-control-smoke}"
WORKER="${RELEASE_CONTROL_SMOKE_WORKER:-qwen-coder-hybrid}"
POLICY="${RELEASE_CONTROL_SMOKE_POLICY:-repair_focus_loop}"
BUDGET="${RELEASE_CONTROL_SMOKE_BUDGET:-15}"
MAX_CYCLES="${RELEASE_CONTROL_SMOKE_MAX_CYCLES:-1}"
BENCHMARKS="${RELEASE_CONTROL_SMOKE_BENCHMARK_CHAIN:-release_orch_stage1_foundation,release_orch_stage2_policy_engine,release_orch_stage3_runtime_ledger}"

npm run dev -- chain \
  --chain-label "$CHAIN_LABEL" \
  --benchmarks "$BENCHMARKS" \
  --worker "$WORKER" \
  --policy "$POLICY" \
  --budget "$BUDGET" \
  --max-cycles "$MAX_CYCLES" \
  --disable-plateau
