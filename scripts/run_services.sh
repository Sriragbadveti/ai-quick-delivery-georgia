#!/usr/bin/env bash
# Starts the promise engine (:4002), allocation service (:4003) and OR-Tools solver (:5001).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
(cd solver && python3 -m uvicorn app:app --port 5001 --log-level warning > ../logs/solver.log 2>&1 &)
npx tsx packages/promise/src/server.ts > logs/promise.log 2>&1 &
npx tsx packages/allocation/src/server.ts > logs/allocation.log 2>&1 &
for url in http://127.0.0.1:5001/health http://127.0.0.1:4002/health http://127.0.0.1:4003/health; do
  for i in $(seq 1 40); do curl -sf "$url" > /dev/null && break; sleep 0.5; done
  curl -sf "$url" && echo
done
