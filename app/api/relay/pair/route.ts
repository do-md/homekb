import { nanoid } from "nanoid";
import { relayDb } from "@/lib/relay/db";
import {
  authHome,
  jsonError,
  randomPairCode,
  randomToken,
  sha256hex,
} from "@/lib/relay/auth";

export const runtime = "nodejs";

const PAIR_TTL_MS = 10 * 60 * 1000;

/**
 * 配对：
 * - {action:"new"}（家设备认证）→ 生成配对码
 * - {action:"claim", code, label?}（公开）→ 换长期 clientToken
 */
export async function POST(req: Request) {
  let body: { action?: string; code?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }
  const db = relayDb();
  db.prepare("DELETE FROM pair_codes WHERE expires_at < ?").run(Date.now());

  if (body.action === "new") {
    const home = authHome(req);
    if (!home) return jsonError(401, "unauthorized");
    const code = randomPairCode();
    const expiresAt = Date.now() + PAIR_TTL_MS;
    db.prepare(
      "INSERT INTO pair_codes (code, home_id, expires_at) VALUES (?, ?, ?)",
    ).run(code, home.id, expiresAt);
    return Response.json({ ok: true, code, expiresAt });
  }

  if (body.action === "claim") {
    const code = String(body.code || "").toUpperCase().replace(/\s/g, "");
    if (!code) return jsonError(400, "missing_code");
    const row = db
      .prepare(
        "SELECT code, home_id FROM pair_codes WHERE code = ? AND used = 0 AND expires_at >= ?",
      )
      .get(code, Date.now()) as { code: string; home_id: string } | undefined;
    if (!row) return jsonError(400, "invalid_or_expired_code");
    db.prepare("UPDATE pair_codes SET used = 1 WHERE code = ?").run(row.code);

    const token = randomToken("hkt_");
    const label = typeof body.label === "string" ? body.label.slice(0, 64) : "";
    db.prepare(
      "INSERT INTO grants (id, home_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("gr_" + nanoid(10), row.home_id, sha256hex(token), label, Date.now());

    const home = db
      .prepare("SELECT name FROM homes WHERE id = ?")
      .get(row.home_id) as { name: string } | undefined;
    return Response.json({
      ok: true,
      token,
      homeId: row.home_id,
      homeName: home?.name ?? "",
    });
  }

  return jsonError(400, "unknown_action");
}
