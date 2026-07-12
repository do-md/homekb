# HomeKB 架构与协议契约

> 本文档是引擎（Rust）与中继（Next.js）两侧的**协议契约**。任何一侧要改接口，先改这里。

## 总览

```
┌─ 用户电脑（家） ────────────────────────────┐
│  ~/.homekb/            数据根（md/图片/附件/索引快照）│
│  homekb CLI            编译 + 召回 + 本地 MCP(stdio)  │
│  homekb tunnel         常驻：SSE 连中继，执行 RPC      │
│  Tauri App(后续)       UI + 嵌入引擎                  │
└──────────────┬─────────────────────────────┘
               │ 出站 SSE 长连（家里无公网 IP 也通）
┌─ 中继服务器（自托管 Next.js，无用户数据） ──┴──┐
│  Web UI（手机/桌面浏览器） /api/relay/rpc        │
│  远程 MCP /api/mcp（OAuth=输入配对码）           │
│  relay.db：homes / grants / pair_codes（仅哈希） │
└─────────────────────────────────────────────┘
               ↑ Bearer token
      手机 Web / Claude 手机端 / 任意 MCP 客户端
```

直连模式（用户有公网 IP/域名）：`homekb tunnel --listen` 后续版本直接暴露本地 HTTP，Web/MCP 客户端跳过中继直打家端。v1 先做中继路径。

## 用户侧目录布局

| 路径 | 内容 |
|------|------|
| `~/.homekb/notes/` | Markdown 知识正文（引擎唯一扫描对象，递归） |
| `~/.homekb/assets/images/` | 图片资源（预留处理管线） |
| `~/.homekb/assets/attachments/` | 其他附件 |
| `~/.homekb/index/index.db` | 索引快照（sqlite-vec，单文件导出，网盘同步安全） |
| `~/Library/Application Support/homekb/live.db` | 编译工作库（WAL，**不放数据根**） |
| `~/.config/homekb/config.toml` | 配置（OpenAI key、路径覆盖、relay 凭据） |

## config.toml

```toml
# 全部可省略，注释处为默认值
# root = "~/.homekb"
# notes_dir = "<root>/notes"     # 可指向任意已有 md 目录
# snapshot_path = "<root>/index/index.db"
# live_db = "<平台数据目录>/homekb/live.db"
# openai_api_key = ""            # 解析顺序：env OPENAI_API_KEY > 此字段 > ~/.config/openai/api_key
# embedding_model = "text-embedding-3-small"   # 1536 维
# summarizer_model = "gpt-4o-mini"
# chunk_target_tokens = 800
# chunk_hard_max = 2000
# summary_diff_threshold = 0.15
# embed_concurrency = 8
# embed_batch_size = 100

[relay]                          # homekb register 写入
url = "https://kb.example.com"
home_id = "hm_xxx"
home_secret = "hks_xxx"          # 明文只存本机
name = "MacBook"
```

## CLI（homekb）

```
homekb init [--root PATH] [--notes PATH] [--openai-key KEY]  # 建目录树+写配置
homekb reindex [--quiet]                                     # 增量编译一次
homekb watch [--interval SECS=300]                           # 前台循环编译
homekb query [--json] [--limit N] [--type T] [--full] [--max-distance D] QUERY
homekb status [--json]
homekb rebuild --force
homekb mcp                                                   # 本地 MCP server（stdio）
homekb register --relay URL [--name NAME]                    # 注册家设备 → 写 [relay]
homekb pair                                                  # 生成配对码（打给中继）
homekb tunnel [--interval SECS=300]                          # 常驻：隧道 + 内置定时编译
```

Claude Code 接入本地 MCP：`claude mcp add homekb -- homekb mcp`。

## Token 格式

| 类型 | 前缀 | 说明 |
|------|------|------|
| homeSecret | `hks_` + 48hex | 家设备凭据，register 返回一次，服务端只存 sha256 |
| clientToken | `hkt_` + 48hex | 远端访问凭据，配对码 claim 换取，服务端只存 sha256 |
| 配对码 | 8 位 A-Z/2-9 | TTL 10 分钟，单次使用 |

所有认证统一 `Authorization: Bearer <token>`。

## 中继 HTTP API

| 端点 | 认证 | 说明 |
|------|------|------|
| `POST /api/relay/register` `{name}` | 无 | → `{homeId, homeSecret}` |
| `POST /api/relay/pair` `{action:"new"}` | homeSecret | → `{code, expiresAt}` |
| `POST /api/relay/pair` `{action:"claim", code, label?}` | 无 | → `{token, homeId, homeName}` |
| `GET  /api/relay/tunnel` | homeSecret | SSE 下行：`event: rpc` / `event: ping`(25s) |
| `POST /api/relay/tunnel/result` `{id, ok, result?, error?}` | homeSecret | 家端回传执行结果 → 204 |
| `POST /api/relay/rpc` `{method, params}` | clientToken | 转发到家端，30s 超时；离线→ 502 `{error:"home_offline"}` |
| `GET  /api/relay/health` | clientToken | → `{online}` 家设备是否在线 |

SSE `rpc` 事件 data：`{"id":"<reqId>","method":"kb.query","params":{...}}`。

## RPC 方法（隧道协议，家端执行）

| method | params | result |
|--------|--------|--------|
| `kb.query` | `{query, limit?, docType?, full?, maxDistance?}` | `{query, results: Hit[]}` |
| `kb.read` | `{path}` | `{path, content, mtime}` |
| `kb.write` | `{path, content}` | `{path}`（仅 notes 内 `.md`，防路径穿越） |
| `kb.create` | `{content, title?}` | `{path, title}`（slug 文件名 + 重名避让） |
| `kb.list` | `{limit?}` | `{docs: [{path,title,docType,mtime,sizeBytes}]}` mtime 倒序 |
| `kb.status` | `{}` | `{generation, docs, chunks, chunksWithVectors, pending, failures, lastCompileAt, lastCompileHost, embeddingModel}` |
| `kb.listTypes` | `{}` | `{types: [{docType, count}]}` |
| `kb.reindex` | `{}` | `{started: true}`（tunnel 进程内异步执行） |

`Hit = {kind: "chunk"|"doc"|"doc_full", path, title, headingPath?, content, score, mtime, docType?}`

path 一律相对 notes_dir。错误 result：`{ok:false, error:{code, message}}`；成功由中继包一层 `{ok:true, result}` 返给客户端。

## MCP 工具（本地 stdio 与远程 /api/mcp 完全一致）

| tool | 入参 | 行为 |
|------|------|------|
| `kb_search` | `{query, limit?, doc_type?, full?}` | 语义召回，返回 hits JSON |
| `kb_read` | `{path}` | 读整篇 md |
| `kb_create` | `{content, title?}` | 新建笔记入库 |
| `kb_update` | `{path, content}` | 覆盖已有笔记 |
| `kb_list` | `{limit?}` | 最近文档列表 |
| `kb_status` | `{}` | 索引状态 |

本地：`homekb mcp` 直接调 engine core。远程：`/api/mcp` 无状态 Streamable HTTP（POST JSON-RPC → JSON 响应），工具调用翻译成 RPC 经隧道转发。

## 远程 MCP 的 OAuth（无账号·配对码）

- `GET /.well-known/oauth-authorization-server`、`GET /.well-known/oauth-protected-resource`：RFC8414/9728 元数据。
- `POST /api/oauth/register`：动态客户端注册（RFC7591），公开客户端。
- `GET /oauth/authorize?...`：授权页 = **输入配对码**（代替登录）。提交后服务端 claim 配对码 → 生成 grant + 授权码（TTL 5min，存 code_challenge）→ 302 回 redirect_uri。
- `POST /api/oauth/token`：authorization_code + PKCE(S256) 校验 → access_token = clientToken（长期有效）。
- `/api/mcp` 未带 token → 401 + `WWW-Authenticate: Bearer resource_metadata="..."`。
- Claude Code 等也可跳过 OAuth 直接 `--header "Authorization: Bearer hkt_..."`。

## relay.db（服务端，零知识库数据）

```sql
homes(id TEXT PK, name TEXT, secret_hash TEXT, created_at INTEGER, last_seen_at INTEGER);
grants(id TEXT PK, home_id TEXT, token_hash TEXT UNIQUE, label TEXT, created_at INTEGER, last_used_at INTEGER);
pair_codes(code TEXT PK, home_id TEXT, expires_at INTEGER, used INTEGER DEFAULT 0);
oauth_clients(client_id TEXT PK, redirect_uris TEXT, name TEXT, created_at INTEGER);
oauth_codes(code TEXT PK, client_id TEXT, grant_id TEXT, code_challenge TEXT, redirect_uri TEXT, expires_at INTEGER, used INTEGER DEFAULT 0);
```

## 引擎内核（fork 自 kb-compile / kb-query）

- 编译：扫描 → mtime/size+SHA256 变更检测 → H2/H3/段落分块 → OpenAI embedding（批量+重试+并发限制）→ sqlite-vec 写入 → 快照原子导出。摘要（gpt-4o-mini）+ doc_type 自动分类。
- 召回：查询 embedding → 双池 KNN（vec_docs 摘要池 + vec_chunks 内容池）→ RRF(k=60) 融合 + 父文档加分。
- 调度：不再用 launchd；`homekb watch` / `homekb tunnel --interval` 内置循环。
- OpenAI key 只在家端使用；远端 Agent 经 MCP/RPC 召回时无需自带 key。
