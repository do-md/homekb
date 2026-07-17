# HomeKB Architecture and Protocol Contract

> This document is the **protocol contract** between the engine (Rust), the relay (standalone Node service), and the clients (Web UI / desktop / MCP). If any side needs to change an interface, change this document first.

## Design principle: engine-first

**The core engine is a self-contained CLI, independent of the desktop client.**

- Power users: install only the engine (single binary `homekb`) and get the full feature set — compile, retrieval, integration with various Agents (`homekb mcp`), and mobile pairing (`homekb register/pair/tunnel`). No client required.
- Regular users: download the desktop client (Tauri). The client is a **pure renderer**: on startup it detects the local engine; if not installed → auto-install (the engine binary is bundled inside the app and installed to `~/.local/bin`); if already installed → connect directly (spawn `homekb serve` over local HTTP RPC).
- Because the client shares the engine's environment, it handles what remote clients cannot: installing the engine, assisting in establishing connections (generating pairing codes / QR codes), editing configuration (AI provider keys), and managing the tunnel daemon.
- **The same RPC protocol is reused everywhere**: local HTTP (`homekb serve`) and connection-service tunnel forwarding. The UI is written once; only the base URL and authentication method change.

## Overview

Three independently deployed pieces, with two paths from a remote client to the home device:

- **Web UI** — Next.js app in this repo's root, deployed on Vercel as a **pure frontend**. It carries zero relay logic and zero knowledge-base data; the browser talks to the connection service. Knowledge-base bytes (documents, images) never pass through Vercel.
- **Relay** — a **standalone, multi-tenant Node service** (`relay/` directory). Operated by the product as shared infrastructure (one or more official instances) so that regular users need zero server knowledge; because it is a single small service, self-hosting it remains possible for power users. It does exactly one job: move requests from remote clients (phone Web / Claude mobile MCP / any Agent) to the home device over the tunnel and stream results (including binary assets) back — Agents can also write back through it (`kb.write`/`kb.create`). Zero knowledge-base data at rest.
- **Engine** (`engine/`, Rust) — everything on the user's computer.

```
┌─ User's computer (home) ─────────────────────────────────────┐
│  ~/.homekb/            Data root (md/assets/index snapshot)   │
│  homekb CLI (engine)   Compile + retrieval + MCP(stdio) + pairing + tunnel│
│  homekb serve          HTTP RPC + /assets                     │
│    · loopback bind (default): no auth — desktop data source   │
│    · public bind (optional): Bearer serveToken (hkd_) — power-user/API access│
│  Tauri App (src-tauri) Pure renderer: detect/install engine → connect to serve│
└──────┬───────────────────────────────────────────────────────┘
       │ Outbound SSE tunnel (works without a public IP)
┌──────┴──────────────────────────────┐
│ Connection service ("relay",        │  Runs anywhere — official hosted,
│ standalone Node service,            │  a user's server, or the home
│ multi-tenant, zero KB data)         │  machine itself (public HTTPS
│  /api/relay/*  RPC + asset piping   │  required — ex-"direct mode")
│  /api/mcp  remote MCP (OAuth =      │
│            enter pairing code)      │
│  relay.db: homes/grants/pair_codes  │
│            (hashes only)            │
└──────┬──────────────────────────────┘
       │ Bearer hkt_
       │
   Web UI (Vercel, pure static frontend) · Claude mobile app · any MCP client
```

**One remote concept: the connection service (relay).** A remote client always connects the same way — pair with an 8-char code at a connection service, which forwards traffic to the home over the tunnel. There is **no separate client-visible "direct mode"**. The desktop app is the only other mode, and it is implicit (local serve, auto-detected). Where the service runs is a *home-side* choice, invisible to the connecting phone:

1. **Official hosted service** (default; later: several instances, auto-pick the nearest — none deployed yet, so this slot is currently empty).
2. **Self-hosted on any server** the user controls (fill in its URL when registering).
3. **Self-hosted on the home machine itself** — this *is* what used to be "direct mode": the phone talks straight to the home computer, zero middlemen, same protocol and same port as any other relay. Requires the machine to be publicly reachable over **HTTPS** (domain + cert, or a Cloudflare/Tailscale-style tunnel) — that part is the user's responsibility; the app only starts the service and states the requirement.

### Desktop service picker (how the home chooses its service)

The desktop Remote tab manages a **service list** and registers the home with one entry:

- **Entries**: built-in services baked at build time (`NEXT_PUBLIC_BUILTIN_SERVICES`, comma-separated URLs — currently empty) + user-added URLs (their own deployment, a shared third-party one, or this machine's own service). One unified "Add service" entry point that **enforces `https://`** for *new* entries (`isAllowedServiceUrl`) — a service URL gets advertised inside pairing QRs and a real phone can only reach an https one. But a non-https *existing* registration (e.g. a `http://localhost` used for local dev testing) is **not blocked and never hides the QR** — the pairing card always renders once registered; the Connection card shows an inline warning that it won't work for a phone on another network, plus a "Disconnect" action (`relay_clear`) and "Change service…".
- **Reachability + auto-select**: every entry is probed via `GET /api/relay/ping` (reachable? latency?). Auto-select picks, among reachable entries: a **"this machine" entry first** (the user marked it as running on this computer), else the lowest latency. Selecting an entry (manually or via auto-select) runs `homekb register --relay <url>` — registration in `config.toml [relay]` stays the single source of truth. **Registering mints a new home identity (home_id/home_secret), so `homekb register` itself (a) retires the previous registration at its service — best-effort `DELETE /api/relay/home` with the old credentials, so devices paired to the old identity get 401 and auto-unpair instead of rotting as forever-offline zombies — and (b) restarts an installed launchd tunnel** onto the new credentials (engine-level fixes — CLI re-registrations are covered too). The desktop additionally installs + starts the tunnel when none exists yet (first-time setup — pairing is the point of registering).
- **The list is desktop UI state** (localStorage `homekb.services.v1`), not engine config: CLI users simply `homekb register --relay <url>` directly.
- **Local service** (separate control, decoupled from the connection card; **default off**): a toggle that starts/stops the bundled relay on this machine (port 8787). Turning it on prompts the requirement — a public HTTPS domain pointing at this machine — and guides the user to add that domain to the service list (marked "this machine", so auto-select prefers it). Lifecycle v1: the desktop spawns `node ~/.homekb-relay/server.mjs` (script installed there together with `node_modules/{better-sqlite3,bindings,file-uri-to-path}` — the esbuild bundle keeps the native module external; env `HOMEKB_RELAY_DIST` overrides the script path; pid in `~/.homekb-relay/relay.pid`; the process outlives the app — it is a service phones depend on). launchd management + bundling the relay runtime = follow-up.

> Why HTTPS is non-negotiable (and why LAN-direct died): the Web UI is served over HTTPS, and a browser **silently blocks** an HTTPS page from `fetch()`-ing a plain-HTTP origin (mixed content). A raw LAN address (`http://192.168.x.x`) cannot get a normal TLS cert, so same-LAN plain-HTTP connections can never work in a browser. Same-network users simply use the connection service like everyone else.

The client pairing screen never mentions "relay": the user scans a QR or types a pairing code. **Scan path: nothing else is exposed** — the QR carries the service URL and the code. **Manual path: the service address field is visible** (prefilled with the official default, `NEXT_PUBLIC_RELAY_URL`) — without scanning, the client has no way to know which service the home registered with, so the user must be able to see and edit it. Which service a QR advertises is decided by the home's registration (`config.toml [relay] url`) — the desktop configuration is the single source of truth.

## User-side directory layout

| Path | Contents |
|------|----------|
| `~/.homekb/notes/` | Markdown knowledge body (the engine's only scan target, recursive) |
| `~/.homekb/drafts/` | Unpublished drafts (`<id>.md`, one file per draft; **not a scan target** — never indexed). Lives on the home device so every paired client shares the same drafts; publishing a draft moves it into `notes/` via `kb.create` and deletes the draft file. **Attachments are not separated**: drafts reference the *same* shared `assets/` (see below), so publishing never has to move or rewrite an asset |
| `~/.homekb/assets/images/` | Image assets (processing pipeline reserved) |
| `~/.homekb/assets/attachments/` | Other attachments |
| `~/.homekb/shares.json` | Share records (public share links): id, note path, optional salted password hash, optional expiry. **Engine-owned truth** — the relay stores only a shareId → home routing record. Low write volume; written by atomic rename, re-read per request (serve and tunnel processes both answer share RPCs) |
| `~/.homekb/index/index.db` | Index snapshot (sqlite-vec, single-file export, safe for cloud-drive sync) |
| `~/Library/Application Support/homekb/live.db` | Compile working DB (WAL, **kept out of the data root**) |
| `~/.homekb/config.toml` | Configuration (AI provider keys, path overrides, relay credentials). **Fixed anchor**: the file always lives at `~/.homekb/config.toml` even when `root`/`notes_dir` redirect the data elsewhere (the config defines those paths, so it cannot move with them). ⚠️ Because the config holds API keys, syncing the *whole* `~/.homekb/` folder to a cloud drive uploads the keys too — documented trade-off of the self-contained layout; exclude `config.toml` from sync if that matters. Legacy location `~/.config/homekb/config.toml` is still **read** when the new path does not exist; any config write migrates to the new path (the legacy file is renamed to `config.toml.migrated`). `$HOMEKB_CONFIG` overrides everything (test isolation) |

### Image references in notes (rendering contract)

Notes reference images with **standard relative Markdown paths from the note file**, assuming the default layout where `notes/` and `assets/` are siblings under the data root: a note `notes/foo.md` writes `![alt](../assets/images/bar.png)`; a note `notes/sub/foo.md` writes `![alt](../../assets/images/bar.png)`. This keeps notes portable — the same reference renders in Obsidian / VS Code / GitHub without HomeKB.

**Drafts and notes share one asset store — there is no draft/published split.** A draft `drafts/<id>.md` references attachments through the *same* `assets/` tree with the *same* relative form (`../assets/images/bar.png`). Because `drafts/` and `notes/` are both exactly one level under the data root, that reference resolves to the identical asset from either location, so a draft's images/attachments stay valid the instant it is published (`drafts/` → `notes/`) with zero asset moves or rewrites. Any future attachment-upload flow **must** write into the shared `assets/` (`images/` or `attachments/`), never a draft-scoped copy. When resolving a draft's refs, treat it as sitting one level under the root (like a top-level note) so the `..` math is identical.

Renderer resolution rule (identical in every renderer — Web, desktop, anything future):

1. `http(s):`, `data:`, `blob:` srcs pass through untouched.
2. Any other src is resolved against the note's own location under a **virtual data root** (`notes/<notePath>` joined with the src, `.`/`..` normalized, never escaping the root).
3. If the resolved path lands under `assets/` → the remainder is the asset path, fetched through the asset service (`GET /assets/<path>` on serve, `GET /api/relay/asset/<path>` through the relay — see "Binary asset channel"). `relay` mode fetches with the `Authorization` header and renders blob URLs; `desktop` embeds plain serve URLs.
4. Anything else (escapes the root, points inside `notes/`, unresolvable) renders as a broken-image placeholder — never fetched.

The rule is defined against the virtual root, so it keeps resolving correctly even when `notes_dir` is overridden to a custom directory (on-disk editor portability is then the user's trade-off, not the renderer's problem).

## config.toml

Location: `$HOMEKB_CONFIG` > `~/.homekb/config.toml` (new-home anchor) > `~/.config/homekb/config.toml` (legacy, read-only fallback; migrated on first write).

```toml
# Path fields are optional; the commented values are the defaults.
# root = "~/.homekb"
# notes_dir = "<root>/notes"     # Can point to any existing md directory
# drafts_dir = "<root>/drafts"   # Unpublished drafts; stays under root even if notes_dir is overridden
# snapshot_path = "<root>/index/index.db"
# live_db = "<platform data dir>/homekb/live.db"
# chunk_target_tokens = 800
# chunk_hard_max = 2000
# summary_diff_threshold = 0.15
# embed_concurrency = 8
# embed_batch_size = 100
# share_web_base = "http://localhost:3000"  # Web UI origin used to compose share URLs (<base>/s/<id>?r=<relay>);
                                            # set to the official Web origin once deployed

[embedding]                      # REQUIRED for compile & retrieval (product-side: "Embedding" setting)
provider = "openai"              # openai | gemini | voyage | cohere | custom — see provider preset table
api_key = ""                     # Resolution: this field > provider env var (see table). provider=openai keeps
                                 # the legacy last-resort fallback ~/.config/openai/api_key for existing installs.
# model = ""                     # Defaults per provider (see table)
# dim = 0                        # Expected vector dimension; defaults per provider's default model.
                                 # Validation only — the request never sends a dimensions param (change model → rebuild).
# base_url = ""                  # Required only for provider = "custom": any OpenAI-compatible /v1/embeddings endpoint

[summary]                        # REQUIRED for compile (doc summaries + doc_type + suggested question).
provider = "openai"              # openai | gemini | custom — OpenAI-compatible /v1/chat/completions
api_key = ""
# model = ""                     # Defaults per provider (see table)
# base_url = ""                  # provider = "custom" only

[ask]                            # OPTIONAL — the ask pipeline's LLM (route + synthesize). When the whole
# provider = ""                  # section is absent, ask falls back to the [summary] endpoint, so `homekb ask`
# api_key = ""                   # works out of the box. Product rationale: retrieval-only integrations (other
# model = ""                     # Agents via MCP/RPC bring their own LLM) never need to fill this in; power
# base_url = ""                  # users set it to answer with a stronger model than the summarizer.

[relay]                          # Written by homekb register
url = "https://relay.homekb.app" # The relay this home is registered to (official or self-hosted)
home_id = "hm_xxx"
home_secret = "hks_xxx"          # Plaintext stored only on the local machine
name = "MacBook"

[serve]                          # All optional; defaults shown
# host = "127.0.0.1"             # Non-loopback (e.g. "0.0.0.0") = authenticated public bind (power-user/API access), requires token
# port = 8765
# token = "hkd_xxx"              # serveToken; auto-generated + persisted on first public bind
```

**Legacy keys** (still parsed, deprecated): top-level `openai_api_key`, `embedding_model`, `summarizer_model` map onto `[embedding]`/`[summary]` with `provider = "openai"` when those sections are absent, so pre-provider configs keep working unchanged.

### AI provider presets

One OpenAI-protocol client serves every built-in provider — a preset is just a base URL + defaults + an env-var fallback for the key. Vendors with OpenAI-compatible APIs need no dedicated SDK; anything else compatible plugs in via `provider = "custom"` + `base_url`.

| Provider | Base URL | Default embedding model (dim) | Default chat model | Key env fallback |
|---|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | `text-embedding-3-small` (1536) | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-embedding-001` (3072) | `gemini-flash-lite-latest` | `GEMINI_API_KEY` |
| `voyage` | `https://api.voyageai.com/v1` | `voyage-4` (1024) | — (embedding only) | `VOYAGE_API_KEY` |
| `cohere` | `https://api.cohere.ai/compatibility/v1` | `embed-v4.0` (1536) | — (embedding only) | `COHERE_API_KEY` |
| `custom` | from `base_url` | `model` + `dim` required | `model` required | — |

The index snapshot records `embedding_provider` (+ `embedding_base_url` for `custom`) alongside `embedding_model`/`embedding_dim` in `index_meta`, so the query side always embeds in the same vector space regardless of the current config — switching `[embedding]` provider/model requires `rebuild --force` + `reindex`, exactly like a model change. Old snapshots without the key are treated as `openai`.

**Rebuild is non-destructive to a working index.** `rebuild --force` resets the *live db* to the new embedding config (drops + recreates the vec0 tables at the new dimension, re-seeds the meta) but **leaves the exported snapshot in place**. Two guards make the switch safe: (a) `import_if_newer` refuses to re-adopt a snapshot whose vector space (provider/model/dim) differs from the live db — so the reset live db is not silently overwritten by the old snapshot; (b) `reindex` **skips the snapshot export when a run embedded zero vectors** (every document failed — bad key, disabled billing, wrong model) — so a failed switch keeps the last good snapshot queryable instead of leaving an empty knowledge base. A genuinely empty corpus (no errors, no vectors) still exports. Each provider has its own default model (see the preset table); legacy top-level keys (`embedding_model`/`summarizer_model`) only seed an **openai** section and never leak a model name into another provider.

## CLI (homekb) — a complete product in itself

**Positioned like Git**: a plain subcommand-based CLI, no interactive REPL. Without installing any client, the CLI carries all core capabilities — ask/retrieval, saving documents, exposing to other Agents (MCP), and mobile pairing. The client is merely a usability wrapper.

```
homekb                       # No subcommand = print help (like git)
homekb ask [--json] <QUESTION>   # Ask: retrieval + LLM-synthesized answer (with citations)
homekb query [--json] [--limit N] [--type T] [--full] [--group] [--max-distance D] [--enumerate] [--route] QUERY
homekb query --list-types [--json]  # List the doc_type vocabulary (name + count, for category routing before search)
homekb new [--title T] [FILE]    # Add a new note (reads stdin when FILE is omitted)
homekb init [--root PATH] [--notes PATH] [--openai-key KEY]  # Create the directory tree + write config
homekb reindex [--quiet] [--reclassify]  # One incremental compile; --reclassify resets ALL doc_type labels first so the taxonomy re-emerges (repair for a collapsed vocabulary)
homekb watch [--interval SECS=300]                           # Foreground compile loop (launchd target)
homekb watch --install [--interval N] / --uninstall / --status [--json]  # Manage the launchd compile service (macOS only)
homekb status [--json]
homekb rebuild --force
homekb mcp                   # Expose to other Agents: local MCP server (stdio)
homekb serve [--host H] [--port 8765]  # HTTP RPC + /assets (loopback = desktop data source; public bind = authenticated power-user access)
homekb register --relay URL [--name NAME]                    # Register with a connection service → write [relay]; retires the previous registration (best-effort), re-registers active share routes at the new service (best-effort), and restarts an installed tunnel
homekb unregister            # Retire the current registration at the service (best-effort), remove [relay], uninstall the launchd tunnel
homekb pair [--json]         # Generate a pairing code (call the registered connection service); --json for the desktop client to parse
homekb share PATH [--password PW] [--expires-days N] [--json]  # Create a public share link for one note (requires an active [relay] registration)
homekb share --list [--json] / --revoke SHARE_ID               # List active shares / revoke one (revocation kills the link instantly)
homekb tunnel [--interval SECS=300]                          # Foreground daemon: tunnel + built-in scheduled compile (launchd target)
homekb tunnel --install [--interval N] / --uninstall / --status [--json]  # Manage the launchd background service (macOS only)
```

Integrate the local MCP into Claude Code: `claude mcp add homekb -- homekb mcp`.

**The ask pipeline (core::answer, completed end-to-end inside the engine)**: LLM routing (infer the doc_type filter + whether the full document is needed + **whether the question is a category enumeration** — "what recipes do I have" wants coverage of a category, not a KNN top-K) is **dispatched in parallel with query vectorization** (the vector depends only on the question string, not on the routing result) → retrieval: normally dual-pool local KNN with the ready-made vectors; **when the router says `enumerate` with a valid docType, retrieval switches to the category summary sweep** (every doc of the category, content = compiled summary, ranked by summary-vector distance, no distance cutoff — the synthesizer then judges over the whole category's summaries, which beats vector recall for enumeration/recommendation intents; `needs_full` is ignored in this mode) → assemble the context block (**numbered per source document** — one `[n]` per doc with its snippets listed under it) → LLM-synthesized answer (based solely on the retrieved snippets, citing sources, following the question's language). The user-facing `hits`/`citations` are source-level (see the `kb.ask` row in the RPC table). Three external requests total: route(chat) ∥ embed(embeddings) → synthesize(chat), reusing shared per-endpoint OpenAI-protocol clients in-process (connection-pool keep-alive). Route + synthesize use the `[ask]` endpoint (falling back to `[summary]`); embed uses the `[embedding]` endpoint pinned by the snapshot meta. Ported from claude-os kb.service's kbInferRoute/kbSynthesize. The engine exposes both a one-shot `ask()` (blocking synthesize) and an `ask_stream()` (synthesize via OpenAI `create_stream`, emitting `AskStreamEvent::Delta` chunks then a terminal `AskStreamEvent::Done{citations,hits}`) — both share the identical route/embed/retrieve path; only the synthesize call differs.

### HTTP RPC (homekb serve)

`POST /rpc` `{method, params}` → `{ok, result}` | `{ok:false, error, message}`. The method set is identical to the tunnel RPC (see the table below). Used by the desktop client, local scripts, and — over an authenticated public bind — power users' own tooling.

- `POST /rpc/stream` `{method, params}` → `text/event-stream` — the **streaming variant, `kb.ask` only** (the UI's Answer mode). Frames: `event: delta` `data: {"text":"<chunk>"}` (incremental answer text, many), then exactly one `event: done` `data: {"citations":[{path,title}],"hits":[Hit]}` (final source metadata); on failure a single `event: error` `data: {"code","message"}` arrives instead of `done`. A non-streamable method → one `error` frame `{code:"not_streamable"}`. Same auth + CORS as `/rpc`. The one-shot `POST /rpc` `kb.ask` stays for MCP / CLI / power tooling (no streaming there).
- `GET /health` → `{ok:true}` (liveness probe, always unauthenticated: the desktop client uses it to tell whether serve is already running).
- `GET /assets/<path>` → streams a file under `~/.homekb/assets/` (e.g. `/assets/images/foo.png` → `~/.homekb/assets/images/foo.png`). Path-traversal-safe (resolved path must stay inside the assets root), `Content-Type` guessed from the extension, `Cache-Control: private, max-age=3600`. Missing file → 404 `{ok:false, error:"not_found"}`.
- **Bind address**: default `127.0.0.1` (config `[serve] host` or `--host` to override). Binding a non-loopback address enables the **authenticated public bind** (a power-user/API capability — the client UI has no direct mode; remote clients go through a connection service).
- **Authentication**: requests from **non-loopback peers** must send `Authorization: Bearer <serveToken>` (`hkd_`) on `/rpc` and `/assets/*`; **loopback peers are exempt** (the desktop webview keeps working unchanged even when serve is publicly bound). On the first non-loopback bind with no token configured, serve generates one, persists it to `config.toml [serve] token`, and prints it once.
- **CORS** — two policies keyed on the bind address:
  - Loopback bind (default): fixed allowlist, never `*` (prevents arbitrary browser pages from driving local retrieval): `tauri://localhost`, `http://tauri.localhost`, `http://localhost:3000`, `http://127.0.0.1:3000` (the latter two are `next dev` debugging origins).
  - Non-loopback bind: any origin, `Authorization` header allowed — data is gated by the Bearer token, not by origin.

### `homekb pair --json`

For the desktop client to parse: prints a single line of JSON to stdout, `{"code","expiresAt","relayUrl","homeName"}` (expiresAt is epoch milliseconds; comes from the connection service's `POST /api/relay/pair`). Without `--json` it keeps the human-readable output.

## Client connection model (Web UI + desktop, one codebase)

The UI (`features/kb`) is written once; the transport layer (`lib/client`) routes by **connection mode**:

| Mode | How chosen | Base URL | Auth |
|------|-----------|----------|------|
| `desktop` | Auto: `window.__TAURI_INTERNALS__` present | `http://127.0.0.1:8765` (serve) | None (loopback) |
| `relay` | The only remote mode: scan a QR or enter a pairing code on the connect screen | `<relayUrl>/api/relay` | Bearer clientToken (`hkt_`) |

- **The connect screen exposes no mode choice and never says "relay"**: the user scans the QR from their home computer (nothing else shown), or types the pairing code + the service address (visible field, prefilled from `NEXT_PUBLIC_RELAY_URL`, **empty when unset — never a localhost fallback**; the client cannot know the home's service without scanning).
- The Web UI stores the whole connection object in localStorage under `homekb.connection.v1`: `{mode:"relay", relayUrl, token, home:{homeId,homeName}}`.
- **Recovery paths**: **two consecutive** 401s on any calls (health poll included) auto-unpair back to the connect screen — a single transient 401 (e.g. a relay deploy-window auth blip) must not destroy the pairing (see "Tunnel liveness & deploy safety"); any success resets the counter. The offline screen additionally offers an explicit "Disconnect & pair again" escape hatch so a user is never stuck staring at "Home is offline" with no way to re-scan.
- Asset rendering: `relay` mode fetches `…/asset/<path>` with the `Authorization` header and renders via blob URLs; `desktop` embeds plain serve URLs. How image srcs inside note Markdown map to asset paths is defined once in "Image references in notes" (`lib/client/asset-ref.ts` implements it).
- Answer streaming: Answer mode calls the streaming endpoint (`${base}/rpc/stream` on serve, `${relayUrl}/api/relay/rpc/stream` on relay — the `rpcUrl` sibling) and consumes the `delta`/`done`/`error` SSE frames, feeding each `delta` into the DOMD editor incrementally. List mode keeps using the one-shot `rpc()` (`kb.query`).

### UI routes

Each tab is a real Next.js route; dynamic overlays live in the URL hash (static-export friendly — no SSR of dynamic params — and a pushed hash entry makes the system back gesture close the overlay instead of leaving the app):

| URL | Surface |
|-----|---------|
| `/` | Redirects to `/search`, carrying query + hash (keeps the pairing link below intact) |
| `/search` | Search entry + results; `#doc=<encoded path>` overlays the reader |
| `/new` | Composer (active compose buffer); `#draft=<id>` resumes a home-side draft |
| `/new/drafts` | Drafts collection (focused mode, under the New note tab) |
| `/status` | Knowledge-base health dashboard |
| `/remote` | Device-connection hub |
| `/settings` | Desktop-only engine/AI config; the web build redirects to `/search` |
| `/s` | **Public share viewer** (`?id=<shareId>&r=<service url>`) — read-only render of a shared note via the relay's public share endpoints; requires no pairing and lives **outside** the app shell (no providers/gates, no connect screen). The Web deployment rewrites `/s/<id>` → `/s?id=<id>` (`next.config` rewrites, web build only) for pretty links; the static-export (desktop) build ships the page but nothing links to it |

The providers/gates shell mounts once in a shared layout (`app/(app)/layout.tsx`, loaded `ssr:false`) so client state persists across tab navigation; the unpaired connect screen renders on any route until paired.

### Pairing link (QR payload)

The desktop Remote tab renders a QR code next to the pairing code so a phone can connect without typing:

```
<webBase>/?relay=<serviceUrl>&code=<pairingCode>
```

- `serviceUrl` = the connection service this home is registered with (`config.toml [relay] url`) — the desktop configuration is the single source of truth; the client never asks the user for it on the QR path.
- `webBase` is **fixed, never user-configured**: the Web UI lives at one official origin (`NEXT_PUBLIC_WEB_URL` baked at build time; dev fallback `http://localhost:3000`). **The primary scan path is the Web UI's built-in camera scanner (8b), which reads only the query params — the origin is irrelevant there.** Encoding a full URL anyway is a freebie: the same QR also opens via a native camera app once the official domain serves the Web UI.
- The landing screen reads the params on load, prefills the form, auto-submits the claim, and immediately strips the params from the address bar (`history.replaceState`) so codes never linger in browser history. Putting the *pairing code* in a URL is acceptable — it is single-use with a 10-minute expiry; **the QR never carries a long-lived token** (it is exchanged at the service for the `hkt_` clientToken).

## Desktop client (Tauri, src-tauri/)

**Pure renderer**: the UI is the same `features/kb` as the Web version, running in `desktop` connection mode (local serve, no auth). Saving/creating is still a button-click controlled flow (`kb.write`/`kb.create` land directly in `~/.homekb/notes`), and **the desktop never triggers any system dialog** (no dialog plugin introduced).

- **Mode detection (runtime)**: the presence of `window.__TAURI_INTERNALS__` = desktop mode. No build-time env distinction is used; the same `next dev`(3000) serves both the browser (Web mode) and the `tauri dev` webview (desktop mode).
- **Build**: desktop = static export (`npm run build:tauri` → `BUILD_TARGET=tauri next build`, `output:"export"` → `out/`). Since the relay moved out to `relay/`, the Next.js app has no server routes left; the Web deployment (Vercel) builds the same app with `next build`.
- **Engine acquisition**: the `homekb` binary is bundled in the app resources (copied from `engine/target/release/homekb` at build time). Startup detection order: env `HOMEKB_BIN` > `~/.local/bin/homekb` > `$PATH`; if none → auto-install the bundled binary to `~/.local/bin/homekb` (no dialog).
- **serve lifecycle**: on startup, probe with `GET /health` first; if already running → attach directly (external process, not taken over); if not running → spawn a `homekb serve` child process, reclaimed when the app exits.
- **compile lifecycle**: background scheduled compilation is kept resident by the `com.homekb.compile` LaunchAgent (**single source of truth**); the desktop does not self-spawn it. `compile_start/compile_stop/compile_status` are thin wrappers around `homekb watch --install/--uninstall/--status --json`. The Settings engine toggle drives these — turning it off pauses compilation while serve and the tunnel keep running.
- **tunnel lifecycle**: kept resident by the `com.homekb.tunnel` LaunchAgent (**single source of truth**); the desktop **does not self-spawn and does not pkill**. `tunnel_start/tunnel_stop/tunnel_status` are thin wrappers around `homekb tunnel --install/--uninstall/--status --json`. The desktop installs the tunnel with `--interval 0` (compilation is owned by the compile agent). On app exit only serve is reclaimed; the compile and tunnel agents are kept alive by launchd.
- **Tauri command surface** (invoke, used only by the desktop UI, not part of the RPC protocol):
  `engine_status` (install/version/serve liveness/config summary — includes a per-section AI endpoint summary `ai.{embedding,summary,ask}` with `{provider, model, keyPresent, configured}`), `engine_install`, `engine_init`, `serve_ensure`, `config_set_ai_endpoint` (writes one `[embedding]`/`[summary]`/`[ask]` section of config.toml directly, a same-machine responsibility: `{section, provider, apiKey?, model?, baseUrl?}`; omitted `apiKey` keeps the stored key when the provider is unchanged; empty `provider` on `ask` deletes the section — back to the summary fallback; any write lands at the `~/.homekb/config.toml` anchor and migrates a legacy file), `index_stats` (runs `homekb status --json` → `{docs, chunks, available, embeddingModel, embeddingProvider}` — for the Settings rebuild card's cost estimate and config↔index drift detection), `engine_rebuild_reindex` (`homekb rebuild --force` → `homekb reindex`, then **restarts the shell-owned serve child** so it reloads the new config + snapshot — serve caches config at startup, so an embedding-provider switch needs a restart; a full re-embed is mandatory after changing the embedding model/provider because vectors are model-specific and the dimension often changes; long-running, minutes; returns the reindex summary line), `relay_register` (wraps `homekb register`), `relay_clear` (wipe `[relay]` from config.toml — disconnect from the current service, back to the picker; the store also stops the tunnel since it cannot run without a service), `pair_new` (wraps `homekb pair --json`), `relay_credentials` (returns `{url, homeSecret}` from config.toml `[relay]` so the desktop UI can call the homeSecret-authenticated relay endpoints — grants list/revoke; the secret never leaves the machine except toward its own relay), `compile_start` / `compile_stop` / `compile_status` (wrap `homekb watch --install` / `--uninstall` / `--status --json`), `tunnel_start` / `tunnel_stop` / `tunnel_status` (wrap `homekb tunnel --install --interval 0` / `--uninstall` / `--status --json`), `local_relay_status` / `local_relay_start` / `local_relay_stop` (the this-machine connection service, port 8787 — see "Desktop service picker"; start spawns `node ~/.homekb-relay/server.mjs` detached with the pid recorded in `~/.homekb-relay/relay.pid`, stop kills only a pid the app recorded, status = TCP probe), `open_notes_dir` (reveal the notes directory in the OS file manager — an allowed desktop affordance; still no system *dialogs*). All daemons launchd-managed, not self-spawned.
- The desktop has one extra "Settings" view: engine/directory info, the auto-compile (engine) toggle, AI provider keys (embedding / summary / optional ask), relay registration, pairing-code generation, and the tunnel toggle. The Web version does not render this view.

## Token formats

| Type | Prefix | Description |
|------|--------|-------------|
| homeSecret | `hks_` + 48hex | Home device credential for the relay, returned once by register, relay stores only the sha256 |
| clientToken | `hkt_` + 48hex | Remote access credential for the relay path, obtained by claiming a pairing code, relay stores only the sha256 |
| serveToken | `hkd_` + 48hex | Credential for an authenticated public `homekb serve` bind (power-user/API use); lives only in `config.toml [serve] token` on the home machine (never touches any relay) |
| Pairing code | 8 chars A-Z/2-9 | TTL 10 minutes, single use |
| shareId | 32 hex (128-bit random) | Public share link identifier — capability-style: unguessable, public by design once shared. Not a bearer token: it grants access to exactly one note, subject to password/expiry/revocation enforced by the home |

All authentication uniformly uses `Authorization: Bearer <token>`.

## Relay service (standalone, multi-tenant)

The relay has **two deployment targets sharing one protocol contract** (this API, byte-identical — clients and the engine cannot tell them apart):

1. **Cloudflare Workers** (`relay-cf/`) — **the primary target**, in two flavors: the product's official instance on `*.workers.dev` (default story for regular users), and **one-click self-deploy** into a user's own Cloudflare account (Deploy-to-Cloudflare button once the repo is public; auto-provisions D1 + DO, and the Worker **self-initializes its schema** on first request so no manual database step exists). Self-deploying makes the user the operator — the strongest trust posture that still gets platform auditability.
2. **Node self-host** (`relay/`) — a standalone Node HTTP service, **not** part of the Next.js app. One process, one SQLite file, no framework. Retained for power users who want the pipe on their own box (must sit behind public HTTPS on **port 443** — AI-client connectors only egress on 443).

Either way, users register their home against whichever relay they chose (`homekb register --relay <url>` / the desktop service picker) — the "add your own service" flow is the same picker that handles the official instance.

Shared invariants (both targets):

- **Multi-tenant by design**: one relay instance serves many homes/users (`homes`/`grants`/`pair_codes` are all keyed by home). Regular users need zero server knowledge.
- **Pure pipe**: knowledge-base data and asset bytes only stream through request/response bodies; nothing is written to disk. The relay DB stores pairing relationships and token hashes only.
- **CORS**: `*` on all API routes (the Web UI is on another origin — Vercel; auth is Bearer-token-based, not origin-based).
- The relay also serves the OAuth **authorize page** itself (`GET /oauth/authorize`, server-rendered HTML form) since the Next.js app no longer hosts server routes.

### Node target (`relay/`)

- Run: `npm run relay:dev` (port **8787**) during development; `npm run relay:build` bundles to `relay/dist/server.mjs` (esbuild, `better-sqlite3` kept external), deploy = copy + `node relay/dist/server.mjs` on any box with Node ≥ 20. Port via `--port`/`PORT` (default 8787), DB via `HOMEKB_RELAY_DB` (default `~/.homekb-relay/relay.db`).

### Cloudflare Workers target (`relay-cf/`)

- **Topology**: a stateless Worker handles all HTTP routes; **one Durable Object per home** (`HomeTunnelDO`, `idFromName(home_id)`) is the tunnel hub — it holds the home's open SSE downstream, correlates rpc/result by request id, and body-pipes the asset/ask channels between the home's upstream POST and the pending client response. **D1** stores the same schema as relay.db (verbatim SQL, async API); the Worker **self-initializes the schema** (idempotent `CREATE TABLE IF NOT EXISTS`, once per isolate) so a freshly provisioned empty database works with zero manual steps (`schema.sql` stays as the human-readable reference).
- **Tunnel protocol unchanged**: the home still speaks `GET /api/relay/tunnel` SSE with 25s pings — existing engine binaries connect without modification. (A WebSocket + DO Hibernation transport is a planned cost optimization — an SSE stream keeps the DO active while connected — and will be spec'd here before implementation.)
- **Why workers.dev and not a custom domain**: the GFW-blocked state of `*.workers.dev` is *predictable* — it is included in mainstream proxy rule sets, so "this service needs a proxy" is common knowledge requiring zero per-user configuration. A custom domain reachable today could be blocked tomorrow, and no user's routing rules would know about it. Corollary: **both sides need a proxy in mainland China** — the remote client *and* the home machine running `homekb tunnel`.
- **Auditability**: the Worker code in this repo is exactly what runs — the platform offers no shell, no sidecar processes, no place to bolt on out-of-band traffic capture, unlike an operator-run box. The residual trust is in Cloudflare itself: transit plaintext is visible to the platform (same operator trust model as any relay; see the trust-boundary note below).
- **Limits**: Workers' egress/runtime fits the pipe exactly — streaming responses have no wall-clock cap while the client stays connected; request bodies stream through without buffering; the DO pins in memory while its home is connected.

### Relay trust boundary

- **At rest: zero.** No knowledge-base data is ever persisted; long-lived credentials (`hks_`/`hkt_`, 24 random bytes) are stored as sha256 hashes only — a stolen relay DB yields no usable token. The only plaintext secrets at rest are short-lived and single-use: pairing codes (10 min) and OAuth authorization codes (5 min).
- **Tenant isolation is structural.** A clientToken is bound to exactly one `home_id` at pairing time; every forward routes by the server-side `grant.home_id` lookup. Requests carry no client-controllable target-home parameter, so cross-tenant access is inexpressible, not merely rejected.
- **In transit: the operator is trusted.** TLS terminates at the relay; content passes through relay memory in plaintext. The relay never logs bodies, but that is policy, not cryptography. Self-hosting the Node target removes this trust point entirely; the Workers target narrows it to the platform (auditable code, no operator side-channels). End-to-end encryption could remove it for HomeKB's own clients, but the Claude connector speaks standard MCP and cannot participate — that path inherently trusts the relay operator.

## Relay HTTP API

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET  /api/relay/ping` | None | → `{ok:true, service:"homekb-relay"}` — liveness/identity probe. The desktop service picker uses it for reachability checks and latency ranking (auto-select); anyone may call it, it leaks nothing |
| `POST /api/relay/register` `{name}` | None | → `{homeId, homeSecret}` |
| `POST /api/relay/pair` `{action:"new"}` | homeSecret | → `{code, expiresAt}` |
| `POST /api/relay/pair` `{action:"claim", code, label?}` | None | → `{token, homeId, homeName}` |
| `GET  /api/relay/tunnel` | homeSecret | SSE downstream: `event: hello` (first; carries `connId`) / `event: rpc` / `event: asset` / `event: ping`(25s) |
| `GET  /api/relay/tunnel/health` | homeSecret | → `{ok, online, connId}` — the relay's **current** view of this home's tunnel (answered by the current hub/DO instance, never by a draining old one). The engine polls it to detect zombie connections; see "Tunnel liveness & deploy safety" |
| `POST /api/relay/tunnel/result` `{id, ok, result?, error?}` | homeSecret | Home device returns the RPC execution result → 204 |
| `POST /api/relay/tunnel/asset/<id>` | homeSecret | Home device streams the requested asset back: raw bytes body + `Content-Type`; on failure empty body + `X-Asset-Error: <code>` header → 204 |
| `POST /api/relay/rpc` `{method, params}` | clientToken | Forward to the home device, 30s timeout; offline → 502 `{error:"home_offline"}` |
| `POST /api/relay/rpc/stream` `{method, params}` | clientToken | Streaming forward — **`kb.ask` only** (see "Streaming answer channel"): → `text/event-stream` piped verbatim from the home (`sources` → `delta`* → `done`, or `error`). Home offline → 502; no first byte within 60s → 504 |
| `POST /api/relay/tunnel/ask/<id>` | homeSecret | Home device streams the answer back: request body is the SSE frame stream (`delta`/`done`/`error`); the relay pipes it straight into the pending client response → 204 once fully piped |
| `GET  /api/relay/asset/<path>` | clientToken | Binary asset fetch through the tunnel (see below); streams the home's bytes to the client without buffering |
| `GET  /api/relay/health` | clientToken | → `{online}` whether the home device is online |
| `DELETE /api/relay/home` | homeSecret | Retire this home identity: deletes the home + all its grants / pair codes / OAuth codes / share routing records. Every client paired to it stops authenticating (401) and **auto-unpairs on its next health poll**, landing back on the connect screen — no zombie "forever offline" pairings. Called best-effort by `homekb register` (retiring the identity it replaces) and by `homekb unregister` |
| `GET  /api/relay/grants` | homeSecret | → `{grants: [{id, label, createdAt, lastUsedAt}]}` — every paired device / MCP grant of this home, newest first. Feeds the desktop "Paired devices" list. The relay knows only labels + hashes, so per-grant liveness is not reported (only the home itself has an online state); clients show `lastUsedAt` instead |
| `DELETE /api/relay/grants/:id` | homeSecret | Revoke one grant (unpair a device): its clientToken stops authenticating immediately → `{ok:true}`; unknown id → 404. Only the owning home can revoke its grants |
| `POST /api/relay/share` `{shareId}` | homeSecret | Register a share routing record (shareId → this home) → `{ok:true}`. **Idempotent upsert** (re-posting the same shareId is safe). Called by the engine when a share is created — registration must succeed before the engine persists the share locally — and again for every active share after `homekb register` moves the home to a new service (routing follows the registration) |
| `DELETE /api/relay/share/:shareId` | homeSecret | Drop the routing record (share revoked) → `{ok:true}` (idempotent). Best-effort from the engine; a stale record is harmless — the home answers `share_not_found` |
| `POST /api/relay/share/:shareId` `{password?}` | None (public) | Public share view: look up the routing record, forward **`kb.shareGet`** over the tunnel (the relay constructs the method itself — the visitor controls nothing but the password) → `{ok:true, result}`. Engine errors map to HTTP: `share_not_found`→404, `share_password_required`→401, `share_password_wrong`→403, `share_expired`→410; home offline→502 |
| `GET  /api/relay/share/:shareId/asset/<path>` | None (public; `X-Share-Password` header when the share is password-protected) | Share-scoped binary asset fetch: forwarded on the asset channel with share context; the home streams the bytes only if the share is valid **and the shared note references that asset** |

SSE `rpc` event data: `{"id":"<reqId>","method":"kb.query","params":{...}}`. An optional `"stream":true` field (only for `kb.ask`, set when the client used `/api/relay/rpc/stream`) tells the home to stream the answer over the ask channel (`POST /api/relay/tunnel/ask/<id>`) instead of posting a single result to `/api/relay/tunnel/result`.
SSE `hello` event data: `{"homeId","name","connId"}` — `connId` is a random id minted by the hub **for this registered connection**; the engine stores it and uses it for out-of-band liveness verification (see "Tunnel liveness & deploy safety" below).
SSE `asset` event data: `{"id":"<reqId>","path":"images/foo.png"}`. Share-scoped asset requests add `"share":{"shareId":"...","password":"..."?}` — the home then validates the share (exists, unexpired, password matches, **asset referenced by the shared note**) before streaming; a failed validation returns the usual empty body + `X-Asset-Error` (`share_denied`).

### Binary asset channel

Assets (images/attachments) are **never base64-encoded into the SSE stream** (a text channel shared with small JSON control messages — +33% size and head-of-line blocking). Instead they get a dedicated binary path:

1. Client → relay: `GET /api/relay/asset/images/foo.png` (Bearer clientToken).
2. Relay → home (SSE): `event: asset` `{"id","path"}`; the relay registers a pending asset request (30s timeout → 504).
3. Home → relay: reads `~/.homekb/assets/<path>` (same traversal guard as serve `/assets`) and `POST /api/relay/tunnel/asset/<id>` with the raw bytes (`Content-Type` guessed). Failure → empty body + `X-Asset-Error: not_found|read_error`.
4. Relay pipes the home's request body **directly into the client's pending response** (no buffering, no disk); `X-Asset-Error` maps to 404/500.

Clients never put tokens in asset URLs: the Web UI fetches with an `Authorization` header and renders via blob URLs. (Desktop mode needs no auth: plain `http://127.0.0.1:8765/assets/<path>`.)

### Streaming answer channel

`kb.ask` in Answer mode streams the LLM answer token-by-token. Like assets, it uses a **dedicated body-piped channel** rather than many small SSE control frames on the shared tunnel — the answer flows as one HTTP body the relay pipes verbatim, so it never head-of-line-blocks the tunnel's control SSE and the relay stays a pure pipe (zero buffering, zero re-framing).

1. Client → relay: `POST /api/relay/rpc/stream {method:"kb.ask", params:{query}}` (Bearer clientToken); the relay holds this response open as `text/event-stream`.
2. Relay → home (SSE): `event: rpc` `{id, method, params, stream:true}`; the relay registers a pending stream (60s to first byte → 504, home offline → 502).
3. Home → relay: runs the ask pipeline (route ∥ embed → retrieve → **synthesize with chat-completions streaming**) and immediately opens `POST /api/relay/tunnel/ask/<id>`, writing SSE frames into the request body: `event: sources {"citations","hits"}` (**emitted right after retrieval, before the first token** — the sources are fully known then, so clients render the citation list immediately instead of waiting out the synthesize latency) → `event: delta {"text"}`* → `event: done {"citations","hits"}` (or a single `event: error {"code","message"}`).
4. Relay pipes the home's request body straight into the client's open response. Client went away → the relay aborts the home upload; home fully piped → 204 to the home.

Desktop mode skips the relay entirely: the webview hits `POST http://127.0.0.1:8765/rpc/stream` and consumes the same frame protocol directly from serve.

The answer's `[n]` markers and `citations` follow the same source-numbering contract as the one-shot `kb.ask` (see the RPC table). `citations`/`hits` arrive **twice**: early in the `sources` frame (render-first UX) and again in the terminal `done` frame (kept for backward compatibility — older clients that only read `done` keep working; the payloads are identical).

## Tunnel liveness & deploy safety (zombie-connection self-healing)

**The failure mode** (observed 2026-07-17 after a Workers deploy): any relay deploy/restart severs every home's tunnel SSE. The engine reconnects within seconds — but during the deploy propagation window that reconnect can land on a **draining old instance** (Workers keeps an old isolate alive while its in-flight requests finish, and an SSE request never finishes). The old instance registers the connection and keeps pinging it, so to the engine everything looks healthy; meanwhile the **current** instance answers `/online` with `conn = null`, and every remote client sees the home as offline — indefinitely. The lesson generalizes: **in-band traffic (pings included) can never prove the connection is registered with the current instance; only an out-of-band request — which always routes to the current deployment — can.**

The self-healing contract (all three parts are mandatory; together they make relay deploys/restarts zero-coordination — nobody restarts anything by hand):

1. **Connection identity**: the hub/DO mints a random `connId` when a tunnel registers and sends it in the `hello` event. `GET /api/relay/tunnel/health` (homeSecret) reports the current instance's view: `{online, connId}`.
2. **Engine verification loop**: while a tunnel is connected, the engine verifies out-of-band — **once ~10 s after connect** (catches the deploy-window zombie almost immediately), then **every ~60 s** (bounds any other silent divergence). A verification is *negative* when the response is definitive and contradicts the engine's state: `online:false`, or `connId` ≠ the one from `hello`. On a negative the engine drops the connection and reconnects (normal backoff). Network errors / non-200s are *inconclusive* and never kill a working tunnel (a flaky proxy must not cause reconnect storms).
3. **Client tolerance**: remote clients auto-unpair on 401 only after **two consecutive** 401 responses — a single transient 401 (deploy-window auth blip) must not destroy a pairing. Health-poll "offline" states never unpair (only 401s do).

Deploy runbook consequence: `wrangler deploy` needs no tunnel coordination — every home self-heals within ~10 s (deploy-window zombies) / ~60 s (worst case). The old `launchctl kickstart` workaround is obsolete.

## Note sharing (public share links)

A single note can be shared with anyone via a link, without pairing. The share is served **live from the home machine** through the relay — nothing is cached or persisted anywhere else. If the home is offline, the share page honestly says so (this is the direct corollary of "data never leaves home"; there is deliberately **no relay-side caching** in v1 — an opt-in edge cache would be a contract change spec'd here first). Standard controls: optional password, optional expiry, revocation.

- **The engine owns every policy decision.** Share records live in `~/.homekb/shares.json`. Password verification (per-share random 16-byte salt, sha256(salt‖password), throttled per share — 10 failures / 10 min lockout), expiry, and revocation are all enforced by the home when answering `kb.shareGet`. The relay stores exactly one routing fact per share (`shares` table: shareId → home_id) and cannot even tell whether a password guess was right — it merely forwards. Revoking deletes the engine record: the link dies instantly even if the relay row lingers (a stale routing row resolves to `share_not_found`).
- **Capability-style id**: shareId = 128-bit random hex; possessing the link is the capability. The password (when set) travels in the POST body / `X-Share-Password` header — never in the URL.
- **Share URL**: `<share_web_base>/s/<shareId>?r=<relay url>` — composed by the engine (`share_web_base` config, default `http://localhost:3000` until an official Web origin exists). The `?r=` parameter tells the viewer which relay to query (same precedent as the pairing QR's `relay=` param); the viewer falls back to `NEXT_PUBLIC_RELAY_URL` when absent.
- **View flow**: visitor opens `<web>/s/<id>` (Next.js viewer, pure frontend, no pairing) → viewer POSTs `{password?}` to `<relay>/api/relay/share/<id>` → relay forwards `kb.shareGet` over the tunnel → engine validates and returns the note → viewer renders the Markdown read-only; images resolve through `GET /api/relay/share/<id>/asset/<path>` (share-scoped asset channel: the home streams an asset only if the shared note references it — resolved with the same virtual-root rule as every renderer).
- **Creation surfaces**: `homekb share` (CLI), `kb_share` (MCP — share from inside any AI conversation), `kb.shareCreate` (RPC — paired clients/desktop). Creating a share requires an active `[relay]` registration; the routing record is registered at the relay **before** the share is persisted locally (no orphan shares).
- **Trust boundary unchanged**: the relay still stores zero knowledge data at rest; shared content passes through relay memory in transit exactly like every other RPC. Anonymous view/password attempts are throttled at the engine (per-share); a relay-side anonymous rate limiter is a follow-up, noted here so it isn't mistaken for implemented.
- **Switching connection services**: share records survive a relay switch because they live on the home, but their *routing* must move. After a successful `homekb register` against a new service, the engine **re-registers every active (non-expired) share's routing record** at the new relay (best-effort per share, `POST /api/relay/share` — an idempotent upsert on the relay side), so each share stays reachable under the same shareId via a fresh link. **Previously distributed links still die**: they embed the old service in `?r=` (and retiring the old identity deletes its routing rows) — this is inherent to the zero-state viewer, not a bug. Clients surface the fresh link through `kb.shareList`'s `url`.

## RPC methods (tunnel protocol, executed by the home device)

| method | params | result |
|--------|--------|--------|
| `kb.query` | `{query, limit?, docType?, full?, group?, maxDistance?, enumerate?, route?}` | `{query, results: Hit[], route?: {docType?, enumerate}}` |
| `kb.ask` | `{query}` | `{answer, citations: [{path,title}], hits: Hit[]}` (LLM-synthesized answer, home-device key. **No chunk granularity at the user layer**: `hits` is aggregated per source document — kind `doc`\|`doc_full`, best snippet, `matches` = merged hit count; the answer's inline `[n]` markers number *sources*, and `citations` aligns 1:1 with that numbering, listing only sources that made it into the context) |
| `kb.read` | `{path}` | `{path, content, mtime}` |
| `kb.write` | `{path, content}` | `{path}` (only `.md` within notes, to prevent path traversal) |
| `kb.create` | `{content, title?}` | `{path, title}` (slug filename + duplicate-name avoidance) |
| `kb.draftList` | `{}` | `{drafts: [{id, text, editedAt}]}` — every unpublished draft (`~/.homekb/drafts/<id>.md`), `editedAt` epoch **ms**, newest first. Drafts live on the home device, so all paired clients see the same list (no per-device local storage) |
| `kb.draftSave` | `{id?, text}` | `{id, editedAt}` — upsert a draft. `id` omitted → the home generates one and returns it; `id` present → overwrite that draft (`id` charset `[A-Za-z0-9_-]{1,64}`). Empty/whitespace `text` is rejected |
| `kb.draftDelete` | `{id}` | `{id}` — delete a draft (idempotent; deleting a missing id still returns ok). Used both for the drafts list's delete action and after a draft is published to `notes/` |
| `kb.list` | `{limit?}` | `{docs: [{path,title,docType,mtime,sizeBytes}]}` mtime descending |
| `kb.status` | `{}` | `{generation, docs, chunks, chunksWithVectors, pending, failures, lastCompileAt, lastCompileHost, embeddingModel, embeddingProvider}` |
| `kb.listTypes` | `{}` | `{types: [{docType, count}]}` |
| `kb.suggestions` | `{limit?}` | `{suggestions: [{question, path, title, mtime}]}` — one auto-generated question per recently updated document, newest first; docs without a generated question yet are skipped. Feeds the home-screen "Try asking" list |
| `kb.reindex` | `{}` | `{started: true}` (executed asynchronously inside the tunnel process) |
| `kb.shareCreate` | `{path, password?, expiresDays?}` | `{shareId, url, expiresAt?}` — create a share for one note (path must be an existing `.md` under notes). Registers the routing record at the relay first; on relay failure nothing is persisted. `url` = `<share_web_base>/s/<shareId>?r=<relay url>` |
| `kb.shareGet` | `{shareId, password?}` | `{path, title, content, mtime, docType?}` — the public share read; the only method the relay forwards **unauthenticated**, and only from its own public share endpoint (method constructed server-side). Errors: `share_not_found` (unknown or revoked), `share_password_required`, `share_password_wrong` (throttled per share), `share_expired` |
| `kb.shareList` | `{}` | `{shares: [{shareId, path, title, createdAt, expiresAt?, hasPassword, url?}]}` newest first. `url` is composed against the **current** `[relay]` registration and `share_web_base` (same shape as `kb.shareCreate`'s), so clients always copy a link pointing at the service currently serving the share; absent when the home has no active registration |
| `kb.shareRevoke` | `{shareId}` | `{shareId}` — delete the share record (idempotent) + best-effort drop of the relay routing record |

`Hit = {kind: "chunk"|"doc"|"doc_full", path, title, headingPath?, content, score, mtime, docType?, matches?}`

The `kb.ask` row above is the **one-shot** form (single JSON response), used by the local MCP, `homekb ask`, power-user tooling, and any non-streaming caller. The **UI's Answer mode uses real token streaming** instead — a separate transport (`/rpc/stream` on serve, `/api/relay/rpc/stream` through the relay) that emits `delta`* → `done` SSE frames; see "HTTP RPC", "Streaming answer channel", and the engine's streaming synthesize. Both share the same retrieval + source-numbering; only the delivery differs. The Web UI feeds `delta` chunks straight into the DOMD editor via `insertText` (no client-side typewriter simulation).

`group: true` = source-aggregation mode (used by the UI "hit list"): internally amplifies retrieval (the fusion pool takes `limit*5`), and after narrowing by `maxDistance` **merges the same path into a single entry** (kind is always `doc`; content/headingPath take that document's top-ranked hit; `matches` = the number of merged hit segments). The source order = the position of each document's first hit in the fusion ranking, and `limit` applies to the merged document count. When both `full` and `group` are given, `full` takes precedence. There is still only one embedding request and zero LLM calls.

**Category enumeration** (`enumerate: true`, requires `docType`): coverage-first retrieval for "what do I have in X" intent, where KNN cutoffs are exactly wrong — the question's vector is far from every individual document, so top-K + `maxDistance` truncate the category arbitrarily. Enumeration returns **every** doc of the category as `kind:"doc"` hits (content = the doc's compiled summary), **ranked by summary-vector distance to the query** so a hybrid question ("recipes that use shrimp") floats matches to the top while the rest of the category stays visible. `limit`/`maxDistance`/`full`/`group` are ignored (hard cap 500 docs, truncation logged — no silent caps). Still one embedding request, zero LLM calls.

`route: true` = **routed search** (used by the UI List mode, whose caller has no LLM of its own): the engine first runs the same router as `kb.ask` (`{docType?, enumerate}` — the `[ask]`/`[summary]` chat endpoint; router failure degrades to plain unrouted search) and applies the inferred filter/enumeration; the applied route is echoed back in the result's `route` field so clients can label the result set (e.g. "recipe · 17"). Explicit `docType`/`enumerate` params take precedence over inferred ones. Agent-facing callers (MCP, CLI, the knowledge-base skill) normally keep routing themselves and pass explicit params instead.

path is always relative to notes_dir. Error result: `{ok:false, error:{code, message}}`; on success the relay wraps a `{ok:true, result}` layer and returns it to the client.

## MCP tools (local stdio and remote /api/mcp are identical)

| tool | Parameters | Behavior |
|------|------------|----------|
| `kb_search` | `{query, limit?, doc_type?, full?, enumerate?}` | Semantic retrieval, returns hits JSON. `enumerate: true` (requires `doc_type`) = whole-category summary sweep ranked by relevance — use for "list everything in X" intents |
| `kb_read` | `{path}` | Read a whole md file |
| `kb_create` | `{content, title?}` | Create a new note |
| `kb_update` | `{path, content}` | Overwrite an existing note |
| `kb_list` | `{limit?}` | Recent document list |
| `kb_status` | `{}` | Index status |
| `kb_share` | `{path, password?, expires_in_days?}` | Create a **public share link** for one note (anyone with the link — and the password, if set — can read it). Returns `{url, shareId, expiresAt?}`. Requires the home to be registered with a relay |

Local: `homekb mcp` calls the engine core directly. Remote: `/api/mcp` (served by the relay) is stateless Streamable HTTP (POST JSON-RPC → JSON response), where tool calls are translated into RPC and forwarded over the tunnel.

Real-client compatibility (verified 2026-07 against the Workers relay): **claude.ai / Claude mobile** (Settings → Connectors, account-level) and **ChatGPT web** (individual plans: Settings → Security and login → Developer mode, then create the app at `chatgpt.com/plugins` → `+` — NOT the Connectors page; apps land in Drafts and are enabled per-conversation via `+` → Developer mode). Both complete the pairing-code OAuth (dynamic registration + PKCE) and accept the stateless JSON response mode. ChatGPT Deep Research additionally requires dedicated `search`/`fetch` tools (not implemented; would wrap `kb.query`/`kb.read`).

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
shares(id TEXT PK, home_id TEXT, created_at INTEGER);
-- Share routing only: which home answers this shareId. Password hash / expiry / revocation all live on the home (shares.json) — the relay cannot evaluate share policy

```

## Engine core (forked from kb-compile / kb-query)

- Compile: scan → mtime/size + SHA256 change detection → H2/H3/paragraph chunking → embedding via the configured provider (OpenAI-protocol client; batching + retries + concurrency limit) → sqlite-vec write → atomic snapshot export. Summarization (the `[summary]` LLM) + automatic doc_type classification + one **suggested question** per document (`docs.suggested_question`, schema v3): generated in the *same* summarizer chat call (JSON `{summary, question}`, zero extra LLM requests), written atomically with the summary so `summary_src_hash` governs both; docs where it is still NULL (pre-v3 index, or a parse fallback) are backfilled incrementally like the doc_type backfill. Served by `kb.suggestions`.
  - **doc_type taxonomy = built-in seeds + emergent growth.** The categorizer is always offered a built-in seed vocabulary (`SEED_CATEGORIES`: recipe, restaurant_log, tech_note, code_snippet, how_to, product_note, reference, book_note, travel_log, diary, health, finance — English anchors; any user-facing localization is a display-layer mapping, never a key change) merged with the categories already in use, so a fresh KB lands on stable labels from doc #1; documents that fit nothing may still grow new labels (organization emerges at compile time — no manual tagging). Reuse is cross-language (a Chinese cooking note belongs in `recipe`; same-meaning duplicates in another language are forbidden); an invented label follows the document's own primary language so its owner recognizes it.
  - **doc_type key space is language-open**: Unicode letters/digits/underscores in any script — NFC-normalized, lowercase-folded (no-op for caseless scripts), whitespace/dashes → underscores, punctuation/emoji stripped, ≤32 chars. `菜谱` is as valid a key as `recipe`; a future user-defined-categories feature inherits this same key space and normalization. Sanitization is *normalization + validation*, never a language gate: a response with nothing valid left is a **retryable failure** (one corrective retry, then fall back to `other` with a warning), never silently coerced (the historical ASCII-only sanitizer silently laundered every CJK label into `other` and collapsed the whole taxonomy). The `other` bucket is excluded from the reuse-preference vocabulary shown to the categorizer — it is a last-resort fallback, not an attractor (a frequent `other` otherwise snowballs via the "prefer existing categories" rule until the taxonomy is useless and the ask router can no longer filter).
  - **Collapse tripwire + repair**: every reindex run checks the aggregate (≥10 classified docs and >50% `other` → warning in the compile log), and `homekb status` prints the doc-type distribution with the same warning — this failure mode is silent per-call, so it must be visible in aggregate. `homekb reindex --reclassify` repairs an already-collapsed index: it NULLs every doc_type under the compile lock and lets the sequential backfill re-grow the taxonomy (summaries/embeddings untouched).
- Retrieval: query embedding → dual-pool KNN (vec_docs summary pool + vec_chunks content pool) → RRF(k=60) fusion + parent-document boost.
- Compile scheduling: **launchd is not used to schedule compilation** (the old kb-compile pattern of running reindex via `StartInterval` is deprecated); scheduled reindex is built into the in-process loop of `homekb watch` (and, when a non-zero interval is given, `homekb tunnel --interval`).
- Process residency — **two independent LaunchAgents with cleanly separated responsibilities** (so the desktop can pause compilation without touching remote access, and the two never contend on `live.db`'s `compile.lock`):
  - **`com.homekb.compile`** (`homekb watch --interval N`) — the **sole scheduled-compile source**; managed by the Settings engine/auto-compile toggle. Turning it off pauses background compilation while leaving serve (the data plane) and the tunnel (remote access) untouched.
  - **`com.homekb.tunnel`** (`homekb tunnel --interval 0`) — the **pure relay tunnel** (remote access only); it does **not** compile (`--interval 0`). (A pure-CLI power user who does not run the compile agent may still install the tunnel with a non-zero interval to get built-in compilation.)
  - Both agents: `KeepAlive`-only (not `StartInterval`), `RunAtLoad`, `ProcessType=Background`; ProgramArguments hardcodes `~/.local/bin/homekb …` (after an update overwrites the binary, a KeepAlive restart adopts it automatically); logs at `~/Library/Logs/HomeKB/{compile,tunnel}.log`; status via `launchctl print gui/$UID/<label>` (exit code 0 = loaded; output containing `pid`/`state = running` = running); management always uses the modern `launchctl bootstrap/bootout/enable/kickstart`, not the deprecated `load/unload`. Installed/removed/queried via `homekb watch|tunnel --install/--uninstall/--status [--json]`. **Single source of truth**: the desktop only invokes these CLI commands, never self-spawns.
- AI provider keys are used only on the home device; remote Agents do not need to bring their own key when retrieving via MCP/RPC.
