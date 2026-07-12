import crypto from "node:crypto";
import { relayDb } from "./db";

export function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** 生成 token：前缀 + 48 hex（24 随机字节） */
export function randomToken(prefix: "hks_" | "hkt_"): string {
  return prefix + crypto.randomBytes(24).toString("hex");
}

/** 配对码：8 位，去易混淆字符（无 I/O/0/1） */
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

/** 家设备认证（homeSecret），成功则顺手更新 last_seen_at */
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

/** 远端客户端认证（clientToken / OAuth access token，同一种东西） */
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
