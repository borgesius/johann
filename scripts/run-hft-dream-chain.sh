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

CHAIN_LABEL="${HFT_BENCH_CHAIN_LABEL:-hft-dream}"
WORKER="${HFT_BENCH_WORKER:-qwen-coder-next}"
POLICY="${HFT_BENCH_POLICY:-repair_focus_loop}"
BUDGET="${HFT_BENCH_BUDGET:-120}"
MAX_CYCLES="${HFT_BENCH_MAX_CYCLES:-6}"
PLATEAU_WINDOW="${HFT_BENCH_PLATEAU_WINDOW:-5}"
PLATEAU_THRESHOLD="${HFT_BENCH_PLATEAU_THRESHOLD:-0.5}"
BENCHMARKS="${HFT_BENCHMARK_CHAIN:-hft_firm_stage1_foundation,hft_firm_stage2_people_projects,hft_firm_stage3_markets_engine,hft_firm_stage4_incidents_polish}"

npm run dev -- chain \
  --chain-label "$CHAIN_LABEL" \
  --benchmarks "$BENCHMARKS" \
  --worker "$WORKER" \
  --policy "$POLICY" \
  --budget "$BUDGET" \
  --max-cycles "$MAX_CYCLES" \
  --plateau-window "$PLATEAU_WINDOW" \
  --plateau-threshold "$PLATEAU_THRESHOLD"
