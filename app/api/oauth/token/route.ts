import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { relayDb } from "@/lib/relay/db";
import { randomToken, sha256hex } from "@/lib/relay/auth";
import { CORS_HEADERS, corsPreflight } from "@/lib/relay/origin";

export const runtime = "nodejs";

function oauthError(error: string, description?: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    { status, headers: CORS_HEADERS },
  );
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** OAuth token exchange: authorization_code + PKCE(S256) → long-lived access_token (clientToken) */
export async function POST(req: Request) {
  let p: Record<string, string> = {};
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      p = (await req.json()) as Record<string, string>;
    } else {
      const form = await req.formData();
      for (const [k, v] of form.entries()) p[k] = String(v);
    }
  } catch {
    return oauthError("invalid_request", "unparseable body");
  }

  if (p.grant_type !== "authorization_code") {
    return oauthError("unsupported_grant_type");
  }
  const db = relayDb();
  db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(Date.now());
  const row = db
    .prepare(
      "SELECT code, client_id, home_id, code_challenge, redirect_uri FROM oauth_codes WHERE code = ? AND used = 0 AND expires_at >= ?",
    )
    .get(String(p.code ?? ""), Date.now()) as
    | { code: string; client_id: string; home_id: string; code_challenge: string; redirect_uri: string }
    | undefined;
  if (!row) return oauthError("invalid_grant", "code invalid or expired");
  if (p.client_id && p.client_id !== row.client_id) {
    return oauthError("invalid_grant", "client_id mismatch");
  }
  if (p.redirect_uri && p.redirect_uri !== row.redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri mismatch");
  }
  if (row.code_challenge) {
    const verifier = String(p.code_verifier ?? "");
    if (!verifier) return oauthError("invalid_grant", "code_verifier required");
    const derived = b64url(crypto.createHash("sha256").update(verifier).digest());
    if (derived !== row.code_challenge) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
  }
  db.prepare("UPDATE oauth_codes SET used = 1 WHERE code = ?").run(row.code);

  const client = db
    .prepare("SELECT name FROM oauth_clients WHERE client_id = ?")
    .get(row.client_id) as { name: string } | undefined;
  const token = randomToken("hkt_");
  db.prepare(
    "INSERT INTO grants (id, home_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    "gr_" + nanoid(10),
    row.home_id,
    sha256hex(token),
    `oauth:${client?.name || row.client_id}`,
    Date.now(),
  );

  // No expires_in / refresh_token: token is long-lived; clients re-authorize naturally when it becomes invalid
  return Response.json(
    { access_token: token, token_type: "bearer", scope: "kb" },
    { headers: CORS_HEADERS },
  );
}

export function OPTIONS() {
  return corsPreflight();
}
