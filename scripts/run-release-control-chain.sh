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

CHAIN_LABEL="${RELEASE_CONTROL_CHAIN_LABEL:-release-control}"
WORKER="${RELEASE_CONTROL_WORKER:-qwen-coder-hybrid}"
POLICY="${RELEASE_CONTROL_POLICY:-repair_focus_loop}"
BUDGET="${RELEASE_CONTROL_BUDGET:-90}"
MAX_CYCLES="${RELEASE_CONTROL_MAX_CYCLES:-4}"
PLATEAU_WINDOW="${RELEASE_CONTROL_PLATEAU_WINDOW:-4}"
PLATEAU_THRESHOLD="${RELEASE_CONTROL_PLATEAU_THRESHOLD:-0.5}"
BENCHMARKS="${RELEASE_CONTROL_BENCHMARK_CHAIN:-release_orch_stage1_foundation,release_orch_stage2_policy_engine,release_orch_stage3_runtime_ledger,release_orch_stage4_operator_console,release_orch_stage5_incident_actions,release_orch_stage6_adapters_observability}"

npm run dev -- chain \
  --chain-label "$CHAIN_LABEL" \
  --benchmarks "$BENCHMARKS" \
  --worker "$WORKER" \
  --policy "$POLICY" \
  --budget "$BUDGET" \
  --max-cycles "$MAX_CYCLES" \
  --plateau-window "$PLATEAU_WINDOW" \
  --plateau-threshold "$PLATEAU_THRESHOLD"
