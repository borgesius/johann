#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

CHAIN_LABEL="${RELEASE_CONTROL_CHAIN_LABEL:-release-control}"

npm run dev -- watch --chain-latest --label "$CHAIN_LABEL"
