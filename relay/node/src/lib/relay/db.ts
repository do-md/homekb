import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Relay server database: stores only pairing relationships and token hashes — zero knowledge-base data.
 * Path: env HOMEKB_RELAY_DB > ~/.homekb-relay/relay.db
 */

const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS shares (
  id         TEXT PRIMARY KEY,
  home_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_home ON shares(home_id);
`;

function openDb(): Database.Database {
  const file =
    process.env.HOMEKB_RELAY_DB ||
    path.join(os.homedir(), ".homekb-relay", "relay.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

/** globalThis singleton — prevents the database from being opened multiple times under dev HMR. */
export function relayDb(): Database.Database {
  const g = globalThis as unknown as { __homekbRelayDb?: Database.Database };
  if (!g.__homekbRelayDb) g.__homekbRelayDb = openDb();
  return g.__homekbRelayDb;
}
