#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$HOME/.openclaw/openclaw.json" ]; then
  export OPENROUTER_API_KEY="$(
    node -e 'const fs=require("fs"); const path=process.env.HOME + "/.openclaw/openclaw.json"; const data=JSON.parse(fs.readFileSync(path,"utf8")); process.stdout.write(data?.env?.OPENROUTER_API_KEY ?? "");'
  )"
fi

existing_latest="$(ls -1dt .bench/runs/* 2>/dev/null | head -n 1 || true)"

npm run dev -- loop "$@" &
RUN_PID=$!

cleanup() {
  if kill -0 "$RUN_PID" >/dev/null 2>&1; then
    kill "$RUN_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup INT TERM EXIT

for _ in $(seq 1 30); do
  latest="$(ls -1dt .bench/runs/* 2>/dev/null | head -n 1 || true)"
  if [ -n "$latest" ] && [ "$latest" != "$existing_latest" ]; then
    break
  fi
  sleep 1
done

echo "Started run in background (pid $RUN_PID). Watching latest run..."
npm run dev -- watch --latest
