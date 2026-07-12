import { nanoid } from "nanoid";
import { relayDb } from "@/lib/relay/db";
import { requestOrigin } from "@/lib/relay/origin";

export const runtime = "nodejs";

const CODE_TTL_MS = 5 * 60 * 1000;

/** 授权页表单提交：校验配对码 → 发授权码 → 302 回客户端 */
export async function POST(req: Request) {
  const form = await req.formData();
  const get = (k: string) => String(form.get(k) ?? "");

  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const state = get("state");
  const codeChallenge = get("code_challenge");
  const pairCode = get("pair_code").toUpperCase().replace(/\s/g, "");

  const db = relayDb();
  const client = db
    .prepare("SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?")
    .get(clientId) as { client_id: string; redirect_uris: string } | undefined;
  if (!client || !(JSON.parse(client.redirect_uris) as string[]).includes(redirectUri)) {
    return new Response("invalid client or redirect_uri", { status: 400 });
  }
  if (get("code_challenge_method") && get("code_challenge_method") !== "S256") {
    return new Response("unsupported code_challenge_method", { status: 400 });
  }

  // 校验并消费配对码
  db.prepare("DELETE FROM pair_codes WHERE expires_at < ?").run(Date.now());
  const pc = db
    .prepare("SELECT code, home_id FROM pair_codes WHERE code = ? AND used = 0 AND expires_at >= ?")
    .get(pairCode, Date.now()) as { code: string; home_id: string } | undefined;
  if (!pc) {
    // 回授权页并带上错误标记（保留原参数）
    const back = new URL("/oauth/authorize", requestOrigin(req));
    for (const k of ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "response_type"]) {
      if (get(k)) back.searchParams.set(k, get(k));
    }
    back.searchParams.set("error", "bad_code");
    return Response.redirect(back.toString(), 302);
  }
  db.prepare("UPDATE pair_codes SET used = 1 WHERE code = ?").run(pc.code);

  const authCode = "ac_" + nanoid(32);
  db.prepare(
    "INSERT INTO oauth_codes (code, client_id, home_id, code_challenge, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(authCode, clientId, pc.home_id, codeChallenge, redirectUri, Date.now() + CODE_TTL_MS);

  const target = new URL(redirectUri);
  target.searchParams.set("code", authCode);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}
