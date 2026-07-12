#!/bin/bash
# 远程 MCP + OAuth 冒烟测试：动态注册 → 配对码授权 → PKCE token → MCP initialize/tools/list/tools/call
# 前提：dev server 在 23333，scripts/fake-home.mjs 会被本脚本自动拉起。
set -e
BASE="http://localhost:23333"
TMP=$(mktemp -d)
trap '[ -n "$HOME_PID" ] && kill $HOME_PID 2>/dev/null; rm -rf "$TMP"; true' EXIT

echo "== 0. 家设备注册 + 假家端上线 =="
REG=$(curl -s -X POST "$BASE/api/relay/register" -H 'Content-Type: application/json' -d '{"name":"McpTestMac"}')
SECRET=$(echo "$REG" | python3 -c 'import sys,json;print(json.load(sys.stdin)["homeSecret"])')
node "$(dirname "$0")/fake-home.mjs" "$BASE" "$SECRET" > "$TMP/home.log" 2>&1 &
HOME_PID=$!
sleep 1.5
grep -q "tunnel connected" "$TMP/home.log" && echo "假家端在线"

echo "== 1. 无 token 打 MCP 必须 401 + WWW-Authenticate =="
HDRS=$(curl -s -D - -o /dev/null -X POST "$BASE/api/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}')
echo "$HDRS" | grep -qi "^HTTP/.* 401" && echo "$HDRS" | grep -qi "www-authenticate: Bearer resource_metadata" && echo "401 挑战 OK"

echo "== 2. OAuth 元数据 =="
curl -s "$BASE/.well-known/oauth-authorization-server" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["code_challenge_methods_supported"]==["S256"];print("AS 元数据 OK:",d["authorization_endpoint"])'
curl -s "$BASE/.well-known/oauth-protected-resource" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("PR 元数据 OK:",d["authorization_servers"][0])'

echo "== 3. 动态客户端注册 =="
CLIENT=$(curl -s -X POST "$BASE/api/oauth/register" -H 'Content-Type: application/json' -d '{"client_name":"Claude","redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}')
echo "$CLIENT"
CLIENT_ID=$(echo "$CLIENT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["client_id"])')

echo "== 4. 生成配对码 =="
CODE=$(curl -s -X POST "$BASE/api/relay/pair" -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' -d '{"action":"new"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])')
echo "配对码: $CODE"

echo "== 5. PKCE 授权（模拟授权页表单提交） =="
VERIFIER=$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')
CHALLENGE=$(python3 -c "import hashlib,base64;print(base64.urlsafe_b64encode(hashlib.sha256('$VERIFIER'.encode()).digest()).rstrip(b'=').decode())")
# 先验证授权页可渲染
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/oauth/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=st123&code_challenge=$CHALLENGE&code_challenge_method=S256")" = "200" && echo "授权页 200 OK"
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$BASE/api/oauth/authorize" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=https://claude.ai/api/mcp/auth_callback" \
  --data-urlencode "state=st123" \
  --data-urlencode "code_challenge=$CHALLENGE" \
  --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "response_type=code" \
  --data-urlencode "pair_code=$CODE")
echo "302 → $LOC"
AUTH_CODE=$(python3 -c "from urllib.parse import urlparse,parse_qs;q=parse_qs(urlparse('$LOC').query);assert q['state']==['st123'];print(q['code'][0])")

echo "== 6. token 交换（PKCE） =="
# 错误 verifier 必须失败
curl -s -X POST "$BASE/api/oauth/token" -d "grant_type=authorization_code&code=$AUTH_CODE&client_id=$CLIENT_ID&code_verifier=wrong" | grep -q invalid_grant && echo "错误 verifier 被拒 OK"
TOKEN_RES=$(curl -s -X POST "$BASE/api/oauth/token" --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$AUTH_CODE" --data-urlencode "client_id=$CLIENT_ID" --data-urlencode "redirect_uri=https://claude.ai/api/mcp/auth_callback" --data-urlencode "code_verifier=$VERIFIER")
echo "$TOKEN_RES"
ACCESS=$(echo "$TOKEN_RES" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

echo "== 7. 授权码单次使用 =="
curl -s -X POST "$BASE/api/oauth/token" --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$AUTH_CODE" --data-urlencode "client_id=$CLIENT_ID" --data-urlencode "code_verifier=$VERIFIER" | grep -q invalid_grant && echo "复用被拒 OK"

mcp() { curl -s -X POST "$BASE/api/mcp" -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' -d "$1"; }

echo "== 8. MCP initialize / initialized / tools-list =="
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["result"]["serverInfo"]["name"]=="homekb";print("initialize OK:",d["result"]["protocolVersion"])'
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/mcp" -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"notifications/initialized"}')" = "202" && echo "notification 202 OK"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python3 -c 'import sys,json;d=json.load(sys.stdin);names=[t["name"] for t in d["result"]["tools"]];assert "kb_search" in names and "kb_create" in names;print("tools/list OK:",names)'

echo "== 9. MCP tools/call → 隧道 → 假家端 =="
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kb_search","arguments":{"query":"测试查询","limit":5}}}' | python3 -c '
import sys,json
d=json.load(sys.stdin)
text=d["result"]["content"][0]["text"]
payload=json.loads(text)
assert payload["echo"]["method"]=="kb.query", payload
assert payload["echo"]["params"]["query"]=="测试查询"
assert payload["results"][0]["title"]=="测试笔记"
print("tools/call 全链路 OK（MCP→隧道→家端→回传）")'

echo "== 10. 未知工具 =="
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nope"}}' | grep -q '"code":-32602' && echo "未知工具报错 OK"

echo "✅ 远程 MCP + OAuth 冒烟测试全部通过"
