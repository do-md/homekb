-- HomeKB relay D1 schema — verbatim copy of the Node target's relay.db schema
-- (lib/relay/db.ts). Stores only pairing relationships and token hashes; zero
-- knowledge-base data. Apply with:
--   npx wrangler d1 execute homekb-relay --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS homes (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  secret_hash  TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS grants (
  id           TEXT PRIMARY KEY,
  home_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_grants_home ON grants(home_id);

CREATE TABLE IF NOT EXISTS pair_codes (
  code       TEXT PRIMARY KEY,
  home_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  name          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  home_id        TEXT NOT NULL,
  code_challenge TEXT NOT NULL DEFAULT '',
  redirect_uri   TEXT NOT NULL DEFAULT '',
  expires_at     INTEGER NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0
);
