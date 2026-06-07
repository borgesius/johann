#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

CHAIN_LABEL="${HFT_BENCH_CHAIN_LABEL:-hft-dream}"

npm run dev -- watch --chain-latest --label "$CHAIN_LABEL"
