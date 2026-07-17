# homekb

@../../AGENTS.md

> The line above inherits the workspace root AGENTS.md (package-management rules, zenith conventions, tech stack). Below are the HomeKB-specific additions.

## Language & commit rules (must follow)

- **English-only codebase.** Everything committed to this repo — code, comments, string literals, UI copy, scripts, docs, README, config, and these instruction files — must be in English. Do NOT introduce Chinese (or any CJK) characters into any file that is version-controlled and pushed to GitHub. The GitHub version of this project is English.
- **English commit messages.** Write clear, semantic English commit messages (e.g. `feat(cli): ...`, `fix(relay): ...`). No Chinese in commit messages.
- **No AI attribution in commits.** Do NOT add any `Co-Authored-By: Codex`/`Anthropic` trailer or any "Generated with Codex" line to commits or PR bodies. Commits are authored solely under the user's git identity.
- The project graph (project-nexus, stored outside this repo) may stay in Chinese — it is cross-session state, not part of the shipped repo.

## Session start: load the project graph (once per new session)

This project has its **own project-nexus graph** (project name `homekb`, not Codex-web-ui). The first thing in a new session is to load it to get the Goal / principles / in-progress tasks / design-doc index:

```bash
node ~/.agents/skills/project-nexus/scripts/nexus.js load-project "homekb"
```

When continuing a session, don't reload if already loaded; expand a Task with `layer2 "homekb" <task_id>`, read design docs / historical detail with `load-content "homekb" <node_id>`, and find history with `recall "homekb" "<description>"`.

**Sync the graph right after finishing something** (newly completed work / new decision / new design doc → `add-node`/`add-edge`/`update-node`; finish with `embed "homekb"` + `sync-reset "homekb"`). The single source of truth for the protocol contract is `docs/ARCHITECTURE.md` — **change RPC/API/token/layout there first**.

> ⚠️ Run nexus write operations one at a time with **full paths, no variables, no pipes, no `$()` capture** (this sandbox silently swallows constructs like `VAR=$(node …)` and `node … | grep` — the command neither runs nor errors).

## What this is

HomeKB — a consumer-facing personal knowledge base whose core selling point is: **your data always stays on your own computer**.
Top-level layout: `engine/` + `client/` + `relay/` (+ `docs/`). Three pieces:

1. **engine/** (Rust): the `homekb` CLI — knowledge compilation (md → chunking → OpenAI embedding → sqlite-vec index) + semantic retrieval (dual-pool KNN + RRF) + ask (Q&A) + local MCP (stdio, for Claude Code / Codex) + serve (HTTP RPC + `/assets`; loopback for the desktop, public bind = direct mode with Bearer auth) + tunnel (the home-side resident process that connects to a relay). Forked from kb-compile / kb-query and evolving independently.

   **Engine-first principle**: the CLI is a self-contained, complete product (Git-style subcommands, no REPL) and does not depend on any client; the desktop client is just a pure renderer (detect/install engine → connect to `homekb serve`) that handles machine-local duties such as installing the engine, assisting pairing, and editing config.
2. **relay/**: a **standalone multi-tenant relay service** — the pipe between remote clients and home devices. Two deployment targets sharing one protocol contract: `relay/cf/` (Cloudflare Workers, the primary target) and `relay/node/` (self-host Node, one process + one SQLite file). Stores only "pairing relationships + token hashes", **no knowledge-base data whatsoever**; the home side receives commands over an SSE tunnel, executes locally, and returns results; binary assets stream through a dedicated channel (never base64 in SSE). Includes remote MCP (Streamable HTTP + pairing-code OAuth, for mobile AI clients).
3. **client/**: the clients — **one codebase, two surfaces**. The Next.js Web UI (a **pure frontend deployed on Vercel**; no server routes, no data flows through it; clients pick relay mode or direct mode on the pairing screen) and `client/src-tauri/`, the desktop app (DoMD-style: static export + Rust invoke, pure renderer over local serve).

The protocol contract (RPC methods, API, directory layout, token format) lives in `docs/ARCHITECTURE.md` — **change the doc before changing the protocol**.

## Ports & running

- Web UI dev: `cd client && npm run dev` (port **3000**); production build deploys to Vercel (project root = `client/`).
- Node relay: `cd client && npm run relay:dev` (port **8787**); production: `npm run relay:build` → `node relay/node/dist/server.mjs`. Workers relay: `cd relay/cf && npx wrangler deploy`.
- Engine build: `cd engine && cargo build --release`; binary at `engine/target/release/homekb`.
- Relay server DB: `relay.db` (better-sqlite3), path via env `HOMEKB_RELAY_DB`, defaults to `~/.homekb-relay/relay.db`.

## Data directories (user side)

- Data root `~/.homekb/`: `notes/` (md content, the only thing the engine scans), `assets/images/`, `assets/attachments/`, `index/index.db` (index snapshot — single file, safe for cloud-drive sync).
- live.db (the compile working DB) lives in `~/Library/Application Support/homekb/`, **deliberately not under the data root** — to avoid corrupt WAL write paths from cloud-drive sync (a pitfall the predecessor project hit).
- Config `~/.config/homekb/config.toml` (contains the OpenAI key, kept out of the data root so it can't leak via cloud sync); `notes_dir` can be overridden to point at any existing directory.

## Conventions

- State management with zenith (`npx i @do-md/zenith`); store style follows the root AGENTS.md.
- No `data-theme` — follow the system theme purely; light/dark styling always via `@media (prefers-color-scheme)`.
- Server-side singletons (the tunnel hub) must hang off `globalThis` to avoid duplicate initialization under dev HMR.
- This is a standalone git repo (`git init` under apps/homekb); semantic English commits straight to main.