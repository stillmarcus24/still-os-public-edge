#!/usr/bin/env bash
# tests/run-all.sh — syntax + contract tests. Never calls real x402 settlement,
# never spends real funds, never requires a live-running server or real secrets.
set -e
cd "$(dirname "$0")/.."

echo "== syntax check =="
for f in core/*.cjs deploy/*.sh; do
  case "$f" in
    *.cjs) node -c "$f" && echo "  OK  $f" ;;
    *.sh)  bash -n "$f" && echo "  OK  $f" ;;
  esac
done

echo ""
echo "== OpenAPI schema is valid JSON =="
node -e "JSON.parse(require('fs').readFileSync('site/openapi.json','utf8')); console.log('  OK  site/openapi.json parses')"

echo ""
echo "== free/paid boundary contract tests =="
node tests/notary/free-paid-boundary.test.cjs

echo ""
echo "== attribution classification fixtures =="
node tests/attribution/classification.test.cjs

echo ""
echo "All tests passed."
