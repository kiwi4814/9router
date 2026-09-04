#!/usr/bin/env bash
# smoke-test.sh — end-to-end smoke test against the local 9router qoder
# deployment. Verifies: pretty public id chat, legacy internal id chat,
# fail-loud on unsupported context_length, and healthy /v1/models.
#
# Usage:
#   NINE_ROUTER_API_KEY=... scripts/qoder/smoke-test.sh [baseUrl]
#   baseUrl defaults to http://127.0.0.1:20127
#   If NINE_ROUTER_API_KEY is not set, attempts to read the active key from
#   the local $HOME/.9router/db/data.sqlite if present.
set -euo pipefail

BASE="${1:-http://127.0.0.1:20127}"
KEY="${NINE_ROUTER_API_KEY:-}"
if [ -z "$KEY" ] && [ -f "${HOME}/.9router/db/data.sqlite" ] && command -v sqlite3 >/dev/null 2>&1; then
  KEY=$(sqlite3 "${HOME}/.9router/db/data.sqlite" "SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1;" 2>/dev/null || true)
fi
KEY="${KEY:-sk-placeholder}"

AUTH="Authorization: Bearer ${KEY}"
CT="Content-Type: application/json"
URL="${BASE}/v1/chat/completions"

echo "== 1. pretty public id (qd/glm-5.3-flash) =="
RESP1=$(curl -sf -H "$AUTH" -H "$CT" "$URL" \
  -d '{"model":"qd/glm-5.3-flash","stream":false,"messages":[{"role":"user","content":"只回复：SMOKE_OK"}]}')
TXT1=$(echo "$RESP1" | jq -r '.choices[0].message.content')
echo "$TXT1"
if [[ "$TXT1" != *"SMOKE_OK"* ]]; then
  echo "FAIL: expected SMOKE_OK, got: $TXT1" >&2
  exit 1
fi

echo "== 2. legacy internal id (qd/gfmodel) =="
RESP2=$(curl -sf -H "$AUTH" -H "$CT" "$URL" \
  -d '{"model":"qd/gfmodel","stream":false,"messages":[{"role":"user","content":"只回复：SMOKE_LEGACY_OK"}]}' \
  | jq -r '.choices[0].message.content')
echo "$RESP2"
if [[ "$RESP2" != *"SMOKE_LEGACY_OK"* ]]; then
  echo "FAIL: expected SMOKE_LEGACY_OK, got: $RESP2" >&2
  exit 1
fi

echo "== 3. unsupported context_length must fail (error surfaced) =="
FAIL_OUT="/tmp/qoder-smoke-fail-$$.json"
CODE=$(curl -s -o "$FAIL_OUT" -w "%{http_code}" -H "$AUTH" -H "$CT" "$URL" \
  -d '{"model":"qd/glm-5.3-flash","stream":false,"messages":[{"role":"user","content":"hi"}],"context_length":500000}')
echo "http_code=${CODE}"
ERR_MSG=$(jq -r '.error.message // .' "$FAIL_OUT")
echo "$ERR_MSG" | head -c 300
echo ""
rm -f "$FAIL_OUT"

if [[ "$CODE" != "400" && "$CODE" != "503" ]]; then
  echo "FAIL: expected HTTP 400 or 503, got: $CODE" >&2
  exit 1
fi
if [[ "$ERR_MSG" != *"supported:"* ]]; then
  echo "FAIL: expected error message to contain 'supported:', got: $ERR_MSG" >&2
  exit 1
fi

echo "== 4. /v1/models advertises public ids =="
COUNT=$(curl -sf "${BASE}/v1/models" | jq -r '[.data[] | select(.id|startswith("qd/")) | .id] | length')
echo "qd/* rows: ${COUNT}"
if [[ "$COUNT" -ne 13 ]]; then
  echo "FAIL: expected 13 qd/* models, got: $COUNT" >&2
  exit 1
fi

echo "SMOKE TEST: ALL 4 CHECKS PASSED"
