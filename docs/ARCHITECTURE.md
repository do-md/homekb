# HomeKB Architecture and Protocol Contract

> This document is the **protocol contract** between the engine (Rust), the relay (standalone Node service), and the clients (Web UI / desktop / MCP). If any side needs to change an interface, change this document first.

## Design principle: engine-first

**The core engine is a self-contained CLI, independent of the desktop client.**

- Power users: install only the engine (single binary `homekb`) and get the full feature set — compile, retrieval, integration with various Agents (`homekb mcp`), and mobile pairing (`homekb register/pair/tunnel`). No client required.
- Regular users: download the desktop client (Tauri). The client is a **pure renderer**: on startup it detects the local engine; if not installed → auto-install (the engine binary is bundled inside the app and installed to `~/.local/bin`); if already installed → connect directly (spawn `homekb serve` over local HTTP RPC).
- Because the client shares the engine's environment, it handles what remote clients cannot: installing the engine, assisting in establishing connections (generating pairing codes / QR codes), editing configuration (OpenAI key), and managing the tunnel daemon.
- **The same RPC protocol is reused in three places**: local HTTP (`homekb serve`), relay tunnel forwarding, and (later) direct public-network connection. The UI is written once; only the base URL and authentication method change.

## Overview

Three independently deployed pieces, with two paths from a remote client to the home device:

- **Web UI** — Next.js app in this repo's root, deployed on Vercel as a **pure frontend**. It carries zero relay logic and zero knowledge-base data; the browser talks to a relay or to the home device directly. Knowledge-base bytes (documents, images) never pass through Vercel.
- **Relay** — a **standalone, multi-tenant Node service** (`relay/` directory). Operated by the product as shared infrastructure (one or more official instances) so that regular users need zero server knowledge; because it is a single small service, self-hosting it remains possible for power users. It does exactly one job: move requests from remote clients (phone Web / Claude mobile MCP / any Agent) to the home device over the tunnel and stream results (including binary assets) back — Agents can also write back through it (`kb.write`/`kb.create`). Zero knowledge-base data at rest.
- **Engine** (`engine/`, Rust) — everything on the user's computer.

```
┌─ User's computer (home) ─────────────────────────────────────┐
│  ~/.homekb/            Data root (md/assets/index snapshot)   │
│  homekb CLI (engine)   Compile + retrieval + MCP(stdio) + pairing + tunnel│
│  homekb serve          HTTP RPC + /assets                     │
│    · loopback bind (default): no auth — desktop data source   │
│    · public bind: direct mode — Bearer serveToken (hkd_)      │
│  Tauri App (src-tauri) Pure renderer: detect/install engine → connect to serve│
└──────┬───────────────────────────────────────┬───────────────┘
       │ Outbound SSE tunnel                   │ Direct mode (user has public IP/domain)
       │ (works without a public IP)           │ Bearer hkd_
┌──────┴──────────────────────────────┐        │
│ Relay (standalone Node service,     │        │
│ multi-tenant, zero KB data)         │        │
│  /api/relay/*  RPC + asset piping   │        │
│  /api/mcp  remote MCP (OAuth =      │        │
│            enter pairing code)      │        │
│  relay.db: homes/grants/pair_codes  │        │
│            (hashes only)            │        │
└──────┬──────────────────────────────┘        │
       │ Bearer hkt_                           │
       └───────────────┬───────────────────────┘
                       │
   Web UI (Vercel, pure static frontend) · Claude mobile app · any MCP client
```

**Connection modes (chosen on the client's pairing screen)**: a remote client connects either through a **relay** (default, lowest barrier — pair with an 8-char code) or **directly** to the home device (user has a public IP/domain; enter the serve URL + serveToken). The desktop app is a third, implicit mode (local serve, auto-detected). Multiple relay instances (pick one / auto-select) are a later iteration; v1 makes the relay URL configurable with an official default (`NEXT_PUBLIC_RELAY_URL`).

## User-side directory layout

| Path | Contents |
|------|----------|
| `~/.homekb/notes/` | Markdown knowledge body (the engine's only scan target, recursive) |
| `~/.homekb/assets/images/` | Image assets (processing pipeline reserved) |
| `~/.homekb/assets/attachments/` | Other attachments |
| `~/.homekb/index/index.db` | Index snapshot (sqlite-vec, single-file export, safe for cloud-drive sync) |
| `~/Library/Application Support/homekb/live.db` | Compile working DB (WAL, **kept out of the data root**) |
| `~/.config/homekb/config.toml` | Configuration (OpenAI key, path overrides, relay credentials) |

### Image references in notes (rendering contract)

Notes reference images with **standard relative Markdown paths from the note file**, assuming the default layout where `notes/` and `assets/` are siblings under the data root: a note `notes/foo.md` writes `![alt](../assets/images/bar.png)`; a note `notes/sub/foo.md` writes `![alt](../../assets/images/bar.png)`. This keeps notes portable — the same reference renders in Obsidian / VS Code / GitHub without HomeKB.

Renderer resolution rule (identical in every renderer — Web, desktop, anything future):

1. `http(s):`, `data:`, `blob:` srcs pass through untouched.
2. Any other src is resolved against the note's own location under a **virtual data root** (`notes/<notePath>` joined with the src, `.`/`..` normalized, never escaping the root).
3. If the resolved path lands under `assets/` → the remainder is the asset path, fetched through the asset service (`GET /assets/<path>` on serve, `GET /api/relay/asset/<path>` through the relay — see "Binary asset channel"). `relay`/`direct` modes fetch with the `Authorization` header and render blob URLs; `desktop` embeds plain serve URLs.
4. Anything else (escapes the root, points inside `notes/`, unresolvable) renders as a broken-image placeholder — never fetched.

The rule is defined against the virtual root, so it keeps resolving correctly even when `notes_dir` is overridden to a custom directory (on-disk editor portability is then the user's trade-off, not the renderer's problem).

## config.toml

```toml
# Everything is optional; the commented values are the defaults.
# root = "~/.homekb"
# notes_dir = "<root>/notes"     # Can point to any existing md directory
# snapshot_path = "<root>/index/index.db"
# live_db = "<platform data dir>/homekb/live.db"
# openai_api_key = ""            # Resolution order: env OPENAI_API_KEY > this field > ~/.config/openai/api_key
# embedding_model = "text-embedding-3-small"   # 1536 dimensions
# summarizer_model = "gpt-4o-mini"
# chunk_target_tokens = 800
# chunk_hard_max = 2000
# summary_diff_threshold = 0.15
# embed_concurrency = 8
# embed_batch_size = 100

[relay]                          # Written by homekb register
url = "https://relay.homekb.app" # The relay this home is registered to (official or self-hosted)
home_id = "hm_xxx"
home_secret = "hks_xxx"          # Plaintext stored only on the local machine
name = "MacBook"

[serve]                          # All optional; defaults shown
# host = "127.0.0.1"             # Non-loopback (e.g. "0.0.0.0") = direct mode, requires token
# port = 8765
# token = "hkd_xxx"              # serveToken; auto-generated + persisted on first public bind
```

## CLI (homekb) — a complete product in itself

**Positioned like Git**: a plain subcommand-based CLI, no interactive REPL. Without installing any client, the CLI carries all core capabilities — ask/retrieval, saving documents, exposing to other Agents (MCP), and mobile pairing. The client is merely a usability wrapper.

```
homekb                       # No subcommand = print help (like git)
homekb ask [--json] <QUESTION>   # Ask: retrieval + LLM-synthesized answer (with citations)
homekb query [--json] [--limit N] [--type T] [--full] [--group] [--max-distance D] QUERY
homekb query --list-types [--json]  # List the doc_type vocabulary (name + count, for category routing before search)
homekb new [--title T] [FILE]    # Add a new note (reads stdin when FILE is omitted)
homekb init [--root PATH] [--notes PATH] [--openai-key KEY]  # Create the directory tree + write config
homekb reindex [--quiet]     # Run one incremental compile
homekb watch [--interval SECS=300]                           # Foreground compile loop (launchd target)
homekb watch --install [--interval N] / --uninstall / --status [--json]  # Manage the launchd compile service (macOS only)
homekb status [--json]
homekb rebuild --force
homekb mcp                   # Expose to other Agents: local MCP server (stdio)
homekb serve [--host H] [--port 8765]  # HTTP RPC + /assets (loopback = desktop data source; public bind = direct mode)
homekb register --relay URL [--name NAME]                    # Register the home device → write [relay]
homekb pair [--json]         # Generate a pairing code (call the relay); --json for the desktop client to parse
homekb tunnel [--interval SECS=300]                          # Foreground daemon: tunnel + built-in scheduled compile (launchd target)
homekb tunnel --install [--interval N] / --uninstall / --status [--json]  # Manage the launchd background service (macOS only)
```

Integrate the local MCP into Claude Code: `claude mcp add homekb -- homekb mcp`.

**The ask pipeline (core::answer, completed end-to-end inside the engine)**: LLM routing (infer the doc_type filter + whether the full document is needed) is **dispatched in parallel with query vectorization** (the vector depends only on the question string, not on the routing result) → dual-pool retrieval (local KNN, using the ready-made vectors) → assemble the context block (**numbered per source document** — one `[n]` per doc with its snippets listed under it) → LLM-synthesized answer (based solely on the retrieved snippets, citing sources, following the question's language). The user-facing `hits`/`citations` are source-level (see the `kb.ask` row in the RPC table). Three external requests total: route(chat) ∥ embed(embeddings) → synthesize(chat), reusing the same OpenAI client in-process (connection-pool keep-alive). Ported from claude-os kb.service's kbInferRoute/kbSynthesize.

### HTTP RPC (homekb serve) — local and direct mode

`POST /rpc` `{method, params}` → `{ok, result}` | `{ok:false, error, message}`. The method set is identical to the tunnel RPC (see the table below). Used by the desktop client, local scripts, and — in direct mode — remote clients.

- `GET /health` → `{ok:true}` (liveness probe, always unauthenticated: the desktop client uses it to tell whether serve is already running; direct-mode clients use it to test connectivity).
- `GET /assets/<path>` → streams a file under `~/.homekb/assets/` (e.g. `/assets/images/foo.png` → `~/.homekb/assets/images/foo.png`). Path-traversal-safe (resolved path must stay inside the assets root), `Content-Type` guessed from the extension, `Cache-Control: private, max-age=3600`. Missing file → 404 `{ok:false, error:"not_found"}`.
- **Bind address**: default `127.0.0.1` (config `[serve] host` or `--host` to override). Binding a non-loopback address = **direct mode**.
- **Authentication**: requests from **non-loopback peers** must send `Authorization: Bearer <serveToken>` (`hkd_`) on `/rpc` and `/assets/*`; **loopback peers are exempt** (the desktop webview keeps working unchanged even when serve is publicly bound). On the first non-loopback bind with no token configured, serve generates one, persists it to `config.toml [serve] token`, and prints it once.
- **CORS** — two policies keyed on the bind address:
  - Loopback bind (default): fixed allowlist, never `*` (prevents arbitrary browser pages from driving local retrieval): `tauri://localhost`, `http://tauri.localhost`, `http://localhost:3000`, `http://127.0.0.1:3000` (the latter two are `next dev` debugging origins).
  - Non-loopback bind (direct mode): any origin, `Authorization` header allowed — data is gated by the Bearer token, not by origin (the Web UI may be served from Vercel or anywhere).

### `homekb pair --json`

For the desktop client to parse: prints a single line of JSON to stdout, `{"code","expiresAt","relayUrl","homeName"}` (expiresAt is epoch milliseconds; comes from the relay's `POST /api/relay/pair`). Without `--json` it keeps the human-readable output.

## Client connection model (Web UI + desktop, one codebase)

The UI (`features/kb`) is written once; the transport layer (`lib/client`) routes by **connection mode**:

| Mode | How chosen | Base URL | Auth |
|------|-----------|----------|------|
| `desktop` | Auto: `window.__TAURI_INTERNALS__` present | `http://127.0.0.1:8765` (serve) | None (loopback) |
| `relay` | Pairing screen → "Use a relay" (default, lowest barrier) | `<relayUrl>/api/relay` | Bearer clientToken (`hkt_`) |
| `direct` | Pairing screen → "Connect directly" (user has public IP/domain) | `<serveUrl>` (public serve) | Bearer serveToken (`hkd_`) |

- The Web UI stores the whole connection object in localStorage under `homekb.connection.v1`: `{mode:"relay", relayUrl, token, home:{homeId,homeName}}` or `{mode:"direct", baseUrl, token}`.
- The pairing screen's relay URL is prefilled from `NEXT_PUBLIC_RELAY_URL` (the official relay; dev fallback `http://localhost:8787`) and remains user-editable (self-hosted relays, multiple relays later).
- Direct-mode pairing = enter serve URL + serveToken; the client verifies with `GET /health` + a cheap `kb.status` before saving.
- Asset rendering: `relay`/`direct` modes fetch `…/asset(s)/<path>` with the `Authorization` header and render via blob URLs; `desktop` embeds plain serve URLs. How image srcs inside note Markdown map to asset paths is defined once in "Image references in notes" (`lib/client/asset-ref.ts` implements it).

## Desktop client (Tauri, src-tauri/)

**Pure renderer**: the UI is the same `features/kb` as the Web version, running in `desktop` connection mode (local serve, no auth). Saving/creating is still a button-click controlled flow (`kb.write`/`kb.create` land directly in `~/.homekb/notes`), and **the desktop never triggers any system dialog** (no dialog plugin introduced).

- **Mode detection (runtime)**: the presence of `window.__TAURI_INTERNALS__` = desktop mode. No build-time env distinction is used; the same `next dev`(3000) serves both the browser (Web mode) and the `tauri dev` webview (desktop mode).
- **Build**: desktop = static export (`npm run build:tauri` → `BUILD_TARGET=tauri next build`, `output:"export"` → `out/`). Since the relay moved out to `relay/`, the Next.js app has no server routes left; the Web deployment (Vercel) builds the same app with `next build`.
- **Engine acquisition**: the `homekb` binary is bundled in the app resources (copied from `engine/target/release/homekb` at build time). Startup detection order: env `HOMEKB_BIN` > `~/.local/bin/homekb` > `$PATH`; if none → auto-install the bundled binary to `~/.local/bin/homekb` (no dialog).
- **serve lifecycle**: on startup, probe with `GET /health` first; if already running → attach directly (external process, not taken over); if not running → spawn a `homekb serve` child process, reclaimed when the app exits.
- **compile lifecycle**: background scheduled compilation is kept resident by the `com.homekb.compile` LaunchAgent (**single source of truth**); the desktop does not self-spawn it. `compile_start/compile_stop/compile_status` are thin wrappers around `homekb watch --install/--uninstall/--status --json`. The Settings engine toggle drives these — turning it off pauses compilation while serve and the tunnel keep running.
- **tunnel lifecycle**: kept resident by the `com.homekb.tunnel` LaunchAgent (**single source of truth**); the desktop **does not self-spawn and does not pkill**. `tunnel_start/tunnel_stop/tunnel_status` are thin wrappers around `homekb tunnel --install/--uninstall/--status --json`. The desktop installs the tunnel with `--interval 0` (compilation is owned by the compile agent). On app exit only serve is reclaimed; the compile and tunnel agents are kept alive by launchd.
- **Tauri command surface** (invoke, used only by the desktop UI, not part of the RPC protocol):
  `engine_status` (install/version/serve liveness/config summary), `engine_install`, `engine_init`, `serve_ensure`, `config_get` / `config_set_openai_key` (read/write config.toml directly, a same-machine responsibility), `relay_register` (wraps `homekb register`), `pair_new` (wraps `homekb pair --json`), `compile_start` / `compile_stop` / `compile_status` (wrap `homekb watch --install` / `--uninstall` / `--status --json`), `tunnel_start` / `tunnel_stop` / `tunnel_status` (wrap `homekb tunnel --install --interval 0` / `--uninstall` / `--status --json`). All launchd-managed, not self-spawned.
- The desktop has one extra "Settings" view: engine/directory info, the auto-compile (engine) toggle, OpenAI key, relay registration, pairing-code generation, and the tunnel toggle. The Web version does not render this view.

## Token formats

| Type | Prefix | Description |
|------|--------|-------------|
| homeSecret | `hks_` + 48hex | Home device credential for the relay, returned once by register, relay stores only the sha256 |
| clientToken | `hkt_` + 48hex | Remote access credential for the relay path, obtained by claiming a pairing code, relay stores only the sha256 |
| serveToken | `hkd_` + 48hex | Direct-mode credential for a publicly bound `homekb serve`; lives only in `config.toml [serve] token` on the home machine (never touches any relay) |
| Pairing code | 8 chars A-Z/2-9 | TTL 10 minutes, single use |

All authentication uniformly uses `Authorization: Bearer <token>`.

## Relay service (standalone, multi-tenant)

The relay lives in `relay/` as a **standalone Node HTTP service** — it is **not** part of the Next.js app. One process, one SQLite file, no framework:

- Run: `npm run relay:dev` (tsx, port **8787**) during development; `npm run relay:build` bundles to `relay/dist/server.mjs` (esbuild, `better-sqlite3` kept external), deploy = copy + `node relay/dist/server.mjs` on any box with Node ≥ 20. Port via `--port`/`PORT` (default 8787), DB via `HOMEKB_RELAY_DB` (default `~/.homekb-relay/relay.db`).
- **Multi-tenant by design**: one relay instance serves many homes/users (`homes`/`grants`/`pair_codes` are all keyed by home). The product operates official instance(s) so regular users need zero server knowledge; self-hosting the same file is possible but not the default story.
- **Pure pipe**: knowledge-base data and asset bytes only stream through request/response bodies; nothing is written to disk. relay.db stores pairing relationships and token hashes only.
- **CORS**: `*` on all API routes (the Web UI is on another origin — Vercel; auth is Bearer-token-based, not origin-based).
- The relay also serves the OAuth **authorize page** itself (`GET /oauth/authorize`, server-rendered HTML form) since the Next.js app no longer hosts server routes.

## Relay HTTP API

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/relay/register` `{name}` | None | → `{homeId, homeSecret}` |
| `POST /api/relay/pair` `{action:"new"}` | homeSecret | → `{code, expiresAt}` |
| `POST /api/relay/pair` `{action:"claim", code, label?}` | None | → `{token, homeId, homeName}` |
| `GET  /api/relay/tunnel` | homeSecret | SSE downstream: `event: rpc` / `event: asset` / `event: ping`(25s) |
| `POST /api/relay/tunnel/result` `{id, ok, result?, error?}` | homeSecret | Home device returns the RPC execution result → 204 |
| `POST /api/relay/tunnel/asset/<id>` | homeSecret | Home device streams the requested asset back: raw bytes body + `Content-Type`; on failure empty body + `X-Asset-Error: <code>` header → 204 |
| `POST /api/relay/rpc` `{method, params}` | clientToken | Forward to the home device, 30s timeout; offline → 502 `{error:"home_offline"}` |
| `GET  /api/relay/asset/<path>` | clientToken | Binary asset fetch through the tunnel (see below); streams the home's bytes to the client without buffering |
| `GET  /api/relay/health` | clientToken | → `{online}` whether the home device is online |

SSE `rpc` event data: `{"id":"<reqId>","method":"kb.query","params":{...}}`.
SSE `asset` event data: `{"id":"<reqId>","path":"images/foo.png"}`.

### Binary asset channel

Assets (images/attachments) are **never base64-encoded into the SSE stream** (a text channel shared with small JSON control messages — +33% size and head-of-line blocking). Instead they get a dedicated binary path:

1. Client → relay: `GET /api/relay/asset/images/foo.png` (Bearer clientToken).
2. Relay → home (SSE): `event: asset` `{"id","path"}`; the relay registers a pending asset request (30s timeout → 504).
3. Home → relay: reads `~/.homekb/assets/<path>` (same traversal guard as serve `/assets`) and `POST /api/relay/tunnel/asset/<id>` with the raw bytes (`Content-Type` guessed). Failure → empty body + `X-Asset-Error: not_found|read_error`.
4. Relay pipes the home's request body **directly into the client's pending response** (no buffering, no disk); `X-Asset-Error` maps to 404/500.

Clients never put tokens in asset URLs: the Web UI fetches with an `Authorization` header and renders via blob URLs. (Desktop mode needs no auth: plain `http://127.0.0.1:8765/assets/<path>`.)

## RPC methods (tunnel protocol, executed by the home device)

| method | params | result |
|--------|--------|--------|
| `kb.query` | `{query, limit?, docType?, full?, group?, maxDistance?}` | `{query, results: Hit[]}` |
| `kb.ask` | `{query}` | `{answer, citations: [{path,title}], hits: Hit[]}` (LLM-synthesized answer, home-device key. **No chunk granularity at the user layer**: `hits` is aggregated per source document — kind `doc`\|`doc_full`, best snippet, `matches` = merged hit count; the answer's inline `[n]` markers number *sources*, and `citations` aligns 1:1 with that numbering, listing only sources that made it into the context) |
| `kb.read` | `{path}` | `{path, content, mtime}` |
| `kb.write` | `{path, content}` | `{path}` (only `.md` within notes, to prevent path traversal) |
| `kb.create` | `{content, title?}` | `{path, title}` (slug filename + duplicate-name avoidance) |
| `kb.list` | `{limit?}` | `{docs: [{path,title,docType,mtime,sizeBytes}]}` mtime descending |
| `kb.status` | `{}` | `{generation, docs, chunks, chunksWithVectors, pending, failures, lastCompileAt, lastCompileHost, embeddingModel}` |
| `kb.listTypes` | `{}` | `{types: [{docType, count}]}` |
| `kb.suggestions` | `{limit?}` | `{suggestions: [{question, path, title, mtime}]}` — one auto-generated question per recently updated document, newest first; docs without a generated question yet are skipped. Feeds the home-screen "Try asking" list |
| `kb.reindex` | `{}` | `{started: true}` (executed asynchronously inside the tunnel process) |

`Hit = {kind: "chunk"|"doc"|"doc_full", path, title, headingPath?, content, score, mtime, docType?, matches?}`

`group: true` = source-aggregation mode (used by the UI "hit list"): internally amplifies retrieval (the fusion pool takes `limit*5`), and after narrowing by `maxDistance` **merges the same path into a single entry** (kind is always `doc`; content/headingPath take that document's top-ranked hit; `matches` = the number of merged hit segments). The source order = the position of each document's first hit in the fusion ranking, and `limit` applies to the merged document count. When both `full` and `group` are given, `full` takes precedence. There is still only one embedding request and zero LLM calls.

path is always relative to notes_dir. Error result: `{ok:false, error:{code, message}}`; on success the relay wraps a `{ok:true, result}` layer and returns it to the client.

## MCP tools (local stdio and remote /api/mcp are identical)

| tool | Parameters | Behavior |
|------|------------|----------|
| `kb_search` | `{query, limit?, doc_type?, full?}` | Semantic retrieval, returns hits JSON |
| `kb_read` | `{path}` | Read a whole md file |
| `kb_create` | `{content, title?}` | Create a new note |
| `kb_update` | `{path, content}` | Overwrite an existing note |
| `kb_list` | `{limit?}` | Recent document list |
| `kb_status` | `{}` | Index status |

Local: `homekb mcp` calls the engine core directly. Remote: `/api/mcp` (served by the relay) is stateless Streamable HTTP (POST JSON-RPC → JSON response), where tool calls are translated into RPC and forwarded over the tunnel.

## OAuth for the remote MCP (account-free, pairing code)

- `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource`: RFC8414/9728 metadata.
- `POST /api/oauth/register`: dynamic client registration (RFC7591), public client.
- `GET /oauth/authorize?...`: the authorization page = **enter the pairing code** (in place of a login). After submission the server claims the pairing code → generates a grant + authorization code (TTL 5min, stores code_challenge) → 302 back to redirect_uri.
- `POST /api/oauth/token`: authorization_code + PKCE(S256) verification → access_token = clientToken (long-lived).
- `/api/mcp` without a token → 401 + `WWW-Authenticate: Bearer resource_metadata="..."`.
- Claude Code and the like can also skip OAuth and use `--header "Authorization: Bearer hkt_..."` directly.

## relay.db (server side, zero knowledge-base data)

```sql
homes(id TEXT PK, name TEXT, secret_hash TEXT, created_at INTEGER, last_seen_at INTEGER);
grants(id TEXT PK, home_id TEXT, token_hash TEXT UNIQUE, label TEXT, created_at INTEGER, last_used_at INTEGER);
pair_codes(code TEXT PK, home_id TEXT, expires_at INTEGER, used INTEGER DEFAULT 0);
oauth_clients(client_id TEXT PK, redirect_uris TEXT, name TEXT, created_at INTEGER);
oauth_codes(code TEXT PK, client_id TEXT, home_id TEXT, code_challenge TEXT, redirect_uri TEXT, expires_at INTEGER, used INTEGER DEFAULT 0);
-- The authorization code stores home_id (the result of claiming a pairing code); the grant/token is created only at token exchange, and the plaintext token is handled just once

```

## Engine core (forked from kb-compile / kb-query)

- Compile: scan → mtime/size + SHA256 change detection → H2/H3/paragraph chunking → OpenAI embedding (batching + retries + concurrency limit) → sqlite-vec write → atomic snapshot export. Summarization (gpt-4o-mini) + automatic doc_type classification + one **suggested question** per document (`docs.suggested_question`, schema v3): generated in the *same* summarizer chat call (JSON `{summary, question}`, zero extra LLM requests), written atomically with the summary so `summary_src_hash` governs both; docs where it is still NULL (pre-v3 index, or a parse fallback) are backfilled incrementally like the doc_type backfill. Served by `kb.suggestions`.
- Retrieval: query embedding → dual-pool KNN (vec_docs summary pool + vec_chunks content pool) → RRF(k=60) fusion + parent-document boost.
- Compile scheduling: **launchd is not used to schedule compilation** (the old kb-compile pattern of running reindex via `StartInterval` is deprecated); scheduled reindex is built into the in-process loop of `homekb watch` (and, when a non-zero interval is given, `homekb tunnel --interval`).
- Process residency — **two independent LaunchAgents with cleanly separated responsibilities** (so the desktop can pause compilation without touching remote access, and the two never contend on `live.db`'s `compile.lock`):
  - **`com.homekb.compile`** (`homekb watch --interval N`) — the **sole scheduled-compile source**; managed by the Settings engine/auto-compile toggle. Turning it off pauses background compilation while leaving serve (the data plane) and the tunnel (remote access) untouched.
  - **`com.homekb.tunnel`** (`homekb tunnel --interval 0`) — the **pure relay tunnel** (remote access only); it does **not** compile (`--interval 0`). (A pure-CLI power user who does not run the compile agent may still install the tunnel with a non-zero interval to get built-in compilation.)
  - Both agents: `KeepAlive`-only (not `StartInterval`), `RunAtLoad`, `ProcessType=Background`; ProgramArguments hardcodes `~/.local/bin/homekb …` (after an update overwrites the binary, a KeepAlive restart adopts it automatically); logs at `~/Library/Logs/HomeKB/{compile,tunnel}.log`; status via `launchctl print gui/$UID/<label>` (exit code 0 = loaded; output containing `pid`/`state = running` = running); management always uses the modern `launchctl bootstrap/bootout/enable/kickstart`, not the deprecated `load/unload`. Installed/removed/queried via `homekb watch|tunnel --install/--uninstall/--status [--json]`. **Single source of truth**: the desktop only invokes these CLI commands, never self-spawns.
- The OpenAI key is used only on the home device; remote Agents do not need to bring their own key when retrieving via MCP/RPC.
