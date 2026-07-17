import crypto from "node:crypto";
import { relayDb } from "./db";

export function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** Generate a token: prefix + 48 hex characters (24 random bytes). */
export function randomToken(prefix: "hks_" | "hkt_"): string {
  return prefix + crypto.randomBytes(24).toString("hex");
}

/** Pairing code: 8 characters, ambiguous characters excluded (no I/O/0/1). */
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function randomPairCode(): string {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  return out;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export interface HomeRow {
  id: string;
  name: string;
}

/** Authenticate a home device (homeSecret); on success also updates last_seen_at. */
export function authHome(req: Request): HomeRow | null {
  const token = bearerToken(req);
  if (!token || !token.startsWith("hks_")) return null;
  const db = relayDb();
  const row = db
    .prepare("SELECT id, name FROM homes WHERE secret_hash = ?")
    .get(sha256hex(token)) as HomeRow | undefined;
  if (!row) return null;
  db.prepare("UPDATE homes SET last_seen_at = ? WHERE id = ?").run(Date.now(), row.id);
  return row;
}

export interface GrantRow {
  id: string;
  home_id: string;
  label: string;
}

/** Authenticate a remote client (clientToken / OAuth access token — same thing). */
export function authGrant(req: Request): GrantRow | null {
  const token = bearerToken(req);
  if (!token || !token.startsWith("hkt_")) return null;
  const db = relayDb();
  const row = db
    .prepare("SELECT id, home_id, label FROM grants WHERE token_hash = ?")
    .get(sha256hex(token)) as GrantRow | undefined;
  if (!row) return null;
  db.prepare("UPDATE grants SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return row;
}

export function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}
