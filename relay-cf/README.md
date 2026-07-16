# HomeKB Relay — Cloudflare Workers target

The recommended way to run your own HomeKB connection service. A single Worker +
one Durable Object per home + D1 for pairing state. Zero knowledge-base data at
rest; content only streams through (see `docs/ARCHITECTURE.md`, "Relay trust
boundary").

Why self-deploy on Cloudflare instead of your own box? The code that runs is
exactly what you see here — the platform offers no shell and no sidecar
processes, so there is no place for an operator (including us) to bolt on
traffic capture. Deploying it into *your own* Cloudflare account removes the
last trust point: you are the operator.

## One-click deploy

<!-- TODO(repo-publish): replace <REPO_URL> with the public GitHub URL once the
     repository is published, e.g.
     [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<REPO_URL>)
     The button forks the repo into the user's account, auto-provisions the D1
     database + Durable Object declared in wrangler.jsonc, and deploys. -->

*(Deploy button lands here once the repository is public.)*

No manual database setup is needed in any flow: the Worker creates its own
schema on first request (idempotent `CREATE TABLE IF NOT EXISTS`).

## Manual deploy (CLI)

```bash
cd relay-cf
npm install --include=dev
npx wrangler d1 create homekb-relay   # copy the database_id into wrangler.jsonc
npx wrangler deploy
```

Your relay is then live at `https://homekb-relay.<your-subdomain>.workers.dev`.

## Point your home at it

```bash
homekb register --relay https://homekb-relay.<your-subdomain>.workers.dev
homekb pair   # pairing code for phones / Claude / ChatGPT connectors
```

MCP connector URL for Claude / ChatGPT: `https://…workers.dev/api/mcp`.

## Prefer your own machine?

The Node target in `relay/` speaks the identical protocol and stores the same
state in a local SQLite file — `node relay/dist/server.mjs` on any box with
Node ≥ 20 and public HTTPS on **port 443** (AI-client connectors only egress on
443). See `docs/ARCHITECTURE.md` for the full contract.
