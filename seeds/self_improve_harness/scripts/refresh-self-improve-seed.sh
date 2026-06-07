#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SEED_DIR="$ROOT_DIR/seeds/self_improve_harness"

mkdir -p "$SEED_DIR"

rsync -a --delete \
  --exclude '.git/' \
  --exclude '.bench/' \
  --exclude 'dist/' \
  --exclude 'node_modules/' \
  --exclude 'coverage/' \
  --exclude '.DS_Store' \
  --exclude 'seeds/self_improve_harness/' \
  "$ROOT_DIR/" "$SEED_DIR/"

rm -rf "$SEED_DIR/.git" "$SEED_DIR/.bench" "$SEED_DIR/dist" "$SEED_DIR/node_modules"
