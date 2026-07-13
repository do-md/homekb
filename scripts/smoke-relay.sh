#!/bin/bash
# Relay link smoke test: register → tunnel(SSE) → pair → rpc → result relay-back → asset channel
# Uses curl to simulate the home device and mobile client.
# Prerequisites: standalone relay running (npm run relay:dev, port 8787). Override with BASE env.
set -e
BASE="${BASE:-http://localhost:8787}"
TMP=$(mktemp -d)
trap '[ -n "$SSE_PID" ] && kill $SSE_PID 2>/dev/null; rm -rf "$TMP"; true' EXIT

echo "== 1. Home device registration =="
REG=$(curl -s -X POST "$BASE/api/relay/register" -H 'Content-Type: application/json' -d '{"name":"SmokeTestMac"}')
echo "$REG"
SECRET=$(echo "$REG" | python3 -c 'import sys,json;print(json.load(sys.stdin)["homeSecret"])')

echo "== 2. Open tunnel SSE (background) =="
curl -sN "$BASE/api/relay/tunnel" -H "Authorization: Bearer $SECRET" > "$TMP/sse.log" &
SSE_PID=$!
sleep 1
grep -q hello "$TMP/sse.log" && echo "hello event OK"

echo "== 3. Generate pairing code & claim =="
CODE=$(curl -s -X POST "$BASE/api/relay/pair" -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' -d '{"action":"new"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])')
echo "pairing code: $CODE"
CLAIM=$(curl -s -X POST "$BASE/api/relay/pair" -H 'Content-Type: application/json' -d "{\"action\":\"claim\",\"code\":\"$CODE\",\"label\":\"smoke-phone\"}")
echo "$CLAIM"
TOKEN=$(echo "$CLAIM" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

echo "== 4. Duplicate claim must fail =="
curl -s -X POST "$BASE/api/relay/pair" -H 'Content-Type: application/json' -d "{\"action\":\"claim\",\"code\":\"$CODE\"}" | grep -q invalid_or_expired && echo "single-use OK"

echo "== 5. health =="
curl -s "$BASE/api/relay/health" -H "Authorization: Bearer $TOKEN"
echo

echo "== 6. RPC forwarding (initiated in background, home manually replies) =="
curl -s -X POST "$BASE/api/relay/rpc" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"method":"kb.status","params":{}}' > "$TMP/rpc.out" &
RPC_PID=$!
sleep 2
REQID=$(grep -o '"id":"[^"]*"' "$TMP/sse.log" | tail -1 | cut -d'"' -f4)
echo "home received rpc id: $REQID"
curl -s -X POST "$BASE/api/relay/tunnel/result" -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
  -d "{\"id\":\"$REQID\",\"ok\":true,\"result\":{\"docs\":42,\"generation\":7}}" -o /dev/null -w "result relay-back HTTP %{http_code}\n"
wait $RPC_PID
echo "client received: $(cat "$TMP/rpc.out")"

echo "== 6.5 Binary asset channel (SSE asset event → home posts bytes → client receives) =="
curl -s -D "$TMP/asset.hdr" "$BASE/api/relay/asset/images/pixel.png" -H "Authorization: Bearer $TOKEN" -o "$TMP/asset.out" &
ASSET_PID=$!
sleep 2
ASSET_ID=$(grep -A1 "event: asset" "$TMP/sse.log" | grep -o '"id":"[^"]*"' | tail -1 | cut -d'"' -f4)
echo "home received asset id: $ASSET_ID (path should be images/pixel.png)"
printf 'FAKEPNGBYTES' > "$TMP/pixel.png"
curl -s -X POST "$BASE/api/relay/tunnel/asset/$ASSET_ID" -H "Authorization: Bearer $SECRET" -H 'Content-Type: image/png' \
  --data-binary "@$TMP/pixel.png" -o /dev/null -w "asset upload HTTP %{http_code}\n"
wait $ASSET_PID
grep -qi "content-type: image/png" "$TMP/asset.hdr" && cmp -s "$TMP/asset.out" "$TMP/pixel.png" && echo "asset bytes + content-type OK" || { echo "asset channel failed"; exit 1; }
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/relay/asset/images/pixel.png")" = "401" && echo "asset 401 without token OK"

echo "== 6.8 Grants list + revoke (paired devices) =="
GRANTS=$(curl -s "$BASE/api/relay/grants" -H "Authorization: Bearer $SECRET")
echo "$GRANTS" | grep -q 'smoke-phone' && echo "grants list OK"
GRANT_ID=$(echo "$GRANTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["grants"][0]["id"])')
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/relay/grants" -H "Authorization: Bearer $TOKEN")" = "401" && echo "grants 401 with clientToken OK"
curl -s -X DELETE "$BASE/api/relay/grants/$GRANT_ID" -H "Authorization: Bearer $SECRET" | grep -q '"ok":true' && echo "revoke OK"
test "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/relay/grants/$GRANT_ID" -H "Authorization: Bearer $SECRET")" = "404" && echo "revoke 404 on unknown id OK"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/relay/health" -H "Authorization: Bearer $TOKEN")" = "401" && echo "revoked token rejected OK"
# Re-pair so the later steps still have a working client token
CODE2=$(curl -s -X POST "$BASE/api/relay/pair" -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' -d '{"action":"new"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])')
TOKEN=$(curl -s -X POST "$BASE/api/relay/pair" -H 'Content-Type: application/json' -d "{\"action\":\"claim\",\"code\":\"$CODE2\",\"label\":\"smoke-phone-2\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

echo "== 7. Unauthenticated access must return 401 =="
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/relay/rpc" -d '{}')" = "401" && echo "401 OK"

echo "== 8. After tunnel disconnect, rpc should return home_offline(502) =="
kill $SSE_PID 2>/dev/null; SSE_PID=""
sleep 1
OUT=$(curl -s -w '|%{http_code}' -X POST "$BASE/api/relay/rpc" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"method":"kb.status","params":{}}')
echo "$OUT" | grep -q 'home_offline' && echo "$OUT" | grep -q '|502' && echo "offline OK" || { echo "offline result unexpected: $OUT"; exit 1; }

echo "✅ Smoke test passed"
