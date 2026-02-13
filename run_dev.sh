#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"

# Start root dev server
npm run dev &
ROOT_PID=$!

# Start backend dev server
cd "$ROOT_DIR/backend"
npm run dev &
BACKEND_PID=$!

cleanup() {
  # Kill both processes if still running
  kill "$ROOT_PID" "$BACKEND_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

wait "$ROOT_PID" "$BACKEND_PID"
