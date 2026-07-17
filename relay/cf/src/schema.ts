import type { Env } from "./env";

/**
 * Self-initializing D1 schema — the enabler for one-click self-deploys
 * (Deploy-to-Cloudflare provisions an EMPTY database; nobody should have to run
 * `wrangler d1 execute` by hand). Statements mirror schema.sql (kept as the
 * human-readable reference); all idempotent (IF NOT EXISTS), executed once per
 * isolate. Same tables as the Node target's relay.db (../node/src/lib/relay/db.ts).
 */

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS homes (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    secret_hash  TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS grants (
    id           TEXT PRIMARY KEY,
    home_id      TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_grants_home ON grants(home_id)`,
  `CREATE TABLE IF NOT EXISTS pair_codes (
    code       TEXT PRIMARY KEY,
    home_id    TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id     TEXT PRIMARY KEY,
    redirect_uris TEXT NOT NULL DEFAULT '[]',
    name          TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (
    code           TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    home_id        TEXT NOT NULL,
    code_challenge TEXT NOT NULL DEFAULT '',
    redirect_uri   TEXT NOT NULL DEFAULT '',
    expires_at     INTEGER NOT NULL,
    used           INTEGER NOT NULL DEFAULT 0
  )`,
  // Share routing only: which home answers this shareId. Password hash /
  // expiry / revocation all live on the home (shares.json) — the relay
  // cannot evaluate share policy (docs/ARCHITECTURE.md "Note sharing").
  `CREATE TABLE IF NOT EXISTS shares (
    id         TEXT PRIMARY KEY,
    home_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shares_home ON shares(home_id)`,
];

let schemaReady: Promise<void> | null = null;

/** Ensure the schema exists (idempotent; runs at most once per isolate). */
export function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA_STATEMENTS.map((s) => env.DB.prepare(s))).then(() => {});
    // A failed attempt must not poison the isolate — retry on the next request.
    schemaReady.catch(() => {
      schemaReady = null;
    });
  }
  return schemaReady;
}
