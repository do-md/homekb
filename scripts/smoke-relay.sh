#!/bin/bash
# 中继链路冒烟测试：register → tunnel(SSE) → pair → rpc → result 回传
# 用 curl 模拟家设备与手机客户端。前提：dev server 已在 23333。
set -e
BASE="http://localhost:23333"
TMP=$(mktemp -d)
trap '[ -n "$SSE_PID" ] && kill $SSE_PID 2>/dev/null; rm -rf "$TMP"; true' EXIT

echo "== 1. 家设备注册 =="
REG=$(curl -s -X POST "$BASE/api/relay/register" -H 'Content-Type: application/json' -d '{"name":"SmokeTestMac"}')
echo "$REG"
SECRET=$(echo "$REG" | python3 -c 'import sys,json;print(json.load(sys.stdin)["homeSecret"])')

echo "== 2. 打开隧道 SSE（后台） =="
curl -sN "$BASE/api/relay/tunnel" -H "Authorization: Bearer $SECRET" > "$TMP/sse.log" &
SSE_PID=$!
sleep 1
grep -q hello "$TMP/sse.log" && echo "hello 事件 OK"

echo "== 3. 生成配对码 & claim =="
CODE=$(curl -s -X POST "$BASE/api/relay/pair" -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' -d '{"action":"new"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])')
echo "配对码: $CODE"
CLAIM=$(curl -s -X POST "$BASE/api/relay/pair" -H 'Content-Type: application/json' -d "{\"action\":\"claim\",\"code\":\"$CODE\",\"label\":\"smoke-phone\"}")
echo "$CLAIM"
TOKEN=$(echo "$CLAIM" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

echo "== 4. 重复 claim 必须失败 =="
curl -s -X POST "$BASE/api/relay/pair" -H 'Content-Type: application/json' -d "{\"action\":\"claim\",\"code\":\"$CODE\"}" | grep -q invalid_or_expired && echo "单次使用 OK"

echo "== 5. health =="
curl -s "$BASE/api/relay/health" -H "Authorization: Bearer $TOKEN"
echo

echo "== 6. RPC 转发（后台发起，家端手动回结果） =="
curl -s -X POST "$BASE/api/relay/rpc" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"method":"kb.status","params":{}}' > "$TMP/rpc.out" &
RPC_PID=$!
sleep 2
REQID=$(grep -o '"id":"[^"]*"' "$TMP/sse.log" | tail -1 | cut -d'"' -f4)
echo "家端收到 rpc id: $REQID"
curl -s -X POST "$BASE/api/relay/tunnel/result" -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
  -d "{\"id\":\"$REQID\",\"ok\":true,\"result\":{\"docs\":42,\"generation\":7}}" -o /dev/null -w "result 回传 HTTP %{http_code}\n"
wait $RPC_PID
echo "客户端拿到: $(cat "$TMP/rpc.out")"

echo "== 7. 未认证访问必须 401 =="
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/relay/rpc" -d '{}')" = "401" && echo "401 OK"

echo "== 8. 断开隧道后 rpc 应 home_offline(502) =="
kill $SSE_PID 2>/dev/null; SSE_PID=""
sleep 1
OUT=$(curl -s -w '|%{http_code}' -X POST "$BASE/api/relay/rpc" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"method":"kb.status","params":{}}')
echo "$OUT" | grep -q 'home_offline' && echo "$OUT" | grep -q '|502' && echo "offline OK" || { echo "offline 结果异常: $OUT"; exit 1; }

echo "✅ 冒烟测试全部通过"
