import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { relayDb } from "../../lib/relay/db";
import {
  authGrant,
  authHome,
  jsonError,
  randomPairCode,
  randomToken,
  sha256hex,
} from "../../lib/relay/auth";
import { asRpcHubError, hub, RPC_METHODS, type RpcError } from "../../lib/relay/hub";
import { CORS_HEADERS, requestOrigin } from "../../lib/relay/origin";
import { handleMcpMessage } from "../../lib/mcp/handler";

/**
 * Relay route handlers, written against the web fetch API (Request/Response).
 * Ported from the former Next.js route handlers — the relay is now a standalone service.
 * Streaming routes (tunnel SSE, asset channel) live in server.ts, not here.
 */

const PAIR_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

// ---- /api/relay/* ----

/** Home device registration: → {homeId, homeSecret} (homeSecret is returned in plaintext only once) */
export async function relayRegister(req: Request): Promise<Response> {
  let name = "";
  try {
    const body = await req.json();
    if (typeof body?.name === "string") name = body.name.slice(0, 64);
  } catch {
    // empty body is also allowed
  }
  const homeId = "hm_" + nanoid(10);
  const homeSecret = randomToken("hks_");
  relayDb()
    .prepare("INSERT INTO homes (id, name, secret_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(homeId, name, sha256hex(homeSecret), Date.now());
  return Response.json({ ok: true, homeId, homeSecret });
}

/**
 * Pairing:
 * - {action:"new"} (home device authenticated) → generate pairing code
 * - {action:"claim", code, label?} (public) → exchange for long-lived clientToken
 */
export async function relayPair(req: Request): Promise<Response> {
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

/**
 * Unauthenticated liveness/identity probe (docs/ARCHITECTURE.md "Relay HTTP API").
 * The desktop service picker uses it for reachability checks + latency ranking
 * (auto-select). Leaks nothing — just "a homekb relay lives here".
 */
export async function relayPing(): Promise<Response> {
  return Response.json({ ok: true, service: "homekb-relay" });
}

/**
 * Retire a home identity (docs/ARCHITECTURE.md "Relay HTTP API"): deletes the home
 * plus all of its grants / pair codes / OAuth codes. Every client paired to it gets
 * 401 from then on and auto-unpairs on its next health poll — this is what prevents
 * "zombie" pairings after the home re-registers (new home_id) or leaves the service.
 */
export async function relayHomeDelete(req: Request): Promise<Response> {
  const home = authHome(req);
  if (!home) return jsonError(401, "unauthorized");
  const db = relayDb();
  db.prepare("DELETE FROM grants WHERE home_id = ?").run(home.id);
  db.prepare("DELETE FROM pair_codes WHERE home_id = ?").run(home.id);
  db.prepare("DELETE FROM oauth_codes WHERE home_id = ?").run(home.id);
  db.prepare("DELETE FROM shares WHERE home_id = ?").run(home.id);
  db.prepare("DELETE FROM homes WHERE id = ?").run(home.id);
  return Response.json({ ok: true });
}

// ---- Note sharing (docs/ARCHITECTURE.md "Note sharing") ----

/** shareId format: 128-bit random hex minted by the engine. */
export const SHARE_ID_RE = /^[0-9a-f]{32}$/;

/** Engine share errors → client-facing HTTP statuses. */
export function shareErrorStatus(code: string): number {
  switch (code) {
    case "share_not_found":
      return 404;
    case "share_password_required":
      return 401;
    case "share_password_wrong":
      return 403;
    case "share_expired":
      return 410;
    default:
      return 500;
  }
}

/**
 * Register a share routing record (home device authenticated). The engine calls
 * this BEFORE persisting the share locally — a rejected registration must leave
 * no working share anywhere.
 */
export async function relayShareRegister(req: Request): Promise<Response> {
  const home = authHome(req);
  if (!home) return jsonError(401, "unauthorized");
  let body: { shareId?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }
  const shareId = typeof body.shareId === "string" ? body.shareId : "";
  if (!SHARE_ID_RE.test(shareId)) return jsonError(400, "bad_share_id");
  relayDb()
    .prepare("INSERT OR REPLACE INTO shares (id, home_id, created_at) VALUES (?, ?, ?)")
    .run(shareId, home.id, Date.now());
  return Response.json({ ok: true });
}

/** Drop a share routing record (idempotent; scoped to the authenticated home). */
export async function relayShareDelete(req: Request, shareId: string): Promise<Response> {
  const home = authHome(req);
  if (!home) return jsonError(401, "unauthorized");
  relayDb().prepare("DELETE FROM shares WHERE id = ? AND home_id = ?").run(shareId, home.id);
  return Response.json({ ok: true });
}

/**
 * Public share view: look up the routing record and forward `kb.shareGet` over
 * the tunnel. The relay constructs the method itself — the anonymous visitor
 * controls nothing but the password; the home enforces every policy decision.
 */
export async function relaySharePublicView(req: Request, shareId: string): Promise<Response> {
  if (!SHARE_ID_RE.test(shareId)) return jsonError(404, "share_not_found");
  let password: string | undefined;
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body?.password === "string" && body.password) password = body.password;
  } catch {
    // empty body = no password supplied
  }
  const row = relayDb()
    .prepare("SELECT home_id FROM shares WHERE id = ?")
    .get(shareId) as { home_id: string } | undefined;
  if (!row) return jsonError(404, "share_not_found");

  try {
    const result = await hub().call(row.home_id, "kb.shareGet", {
      shareId,
      ...(password ? { password } : {}),
    });
    return Response.json({ ok: true, result });
  } catch (e) {
    const hubErr = asRpcHubError(e);
    if (hubErr) {
      // Engine-level share errors travel as rpc_error with a detail code.
      if (hubErr.code === "rpc_error" && hubErr.detail?.code?.startsWith("share_")) {
        return Response.json(
          { ok: false, error: hubErr.detail.code, message: hubErr.detail.message },
          { status: shareErrorStatus(hubErr.detail.code) },
        );
      }
      const status =
        hubErr.code === "home_offline" ? 502 : hubErr.code === "timeout" ? 504 : 500;
      return Response.json({ ok: false, error: hubErr.code, message: hubErr.message }, { status });
    }
    return jsonError(500, "internal_error");
  }
}

/** Client health check: whether the home device is online */
export async function relayHealth(req: Request): Promise<Response> {
  const grant = authGrant(req);
  if (!grant) return jsonError(401, "unauthorized");
  return Response.json({ ok: true, online: hub().online(grant.home_id) });
}

/**
 * Home-side tunnel liveness (docs/ARCHITECTURE.md "Tunnel liveness & deploy safety"):
 * the CURRENT hub's view of this home's tunnel. The engine polls it out-of-band
 * and reconnects when `online:false` or `connId` differs from its `hello`.
 */
export async function relayTunnelHealth(req: Request): Promise<Response> {
  const home = authHome(req);
  if (!home) return jsonError(401, "unauthorized");
  const info = hub().connInfo(home.id);
  return Response.json({ ok: true, online: info.online, connId: info.connId });
}

/**
 * Paired-devices list (home device authenticated): every grant of this home, newest
 * first. The relay stores only labels + token hashes, so there is no per-grant
 * liveness — clients render lastUsedAt instead (docs/ARCHITECTURE.md, grants API).
 */
export async function relayGrantsList(req: Request): Promise<Response> {
  const home = authHome(req);
  if (!home) return jsonError(401, "unauthorized");
  const rows = relayDb()
    .prepare(
      "SELECT id, label, created_at, last_used_at FROM grants WHERE home_id = ? ORDER BY created_at DESC",
    )
    .all(home.id) as { id: string; label: string; created_at: number; last_used_at: number | null }[];
  return Response.json({
    ok: true,
    grants: rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
  });
}

/** Revoke one grant (unpair a device). Scoped to the authenticated home — a home can only revoke its own grants. */
export async function relayGrantRevoke(req: Request, grantId: string): Promise<Response> {
  const home = authHome(req);
  if (!home) return jsonError(401, "unauthorized");
  const res = relayDb()
    .prepare("DELETE FROM grants WHERE id = ? AND home_id = ?")
    .run(grantId, home.id);
  if (res.changes === 0) return jsonError(404, "not_found");
  return Response.json({ ok: true });
}

/** Remote client RPC: forwarded through the tunnel to the home device for execution */
export async function relayRpc(req: Request): Promise<Response> {
  const grant = authGrant(req);
  if (!grant) return jsonError(401, "unauthorized");

  let body: { method?: string; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }
  const method = String(body.method || "");
  if (!RPC_METHODS.has(method)) return jsonError(400, "unknown_method");

  try {
    const result = await hub().call(grant.home_id, method, body.params ?? {});
    return Response.json({ ok: true, result });
  } catch (e) {
    const hubErr = asRpcHubError(e);
    if (hubErr) {
      const status =
        hubErr.code === "home_offline" ? 502 : hubErr.code === "timeout" ? 504 : 500;
      return Response.json(
        { ok: false, error: hubErr.code, message: hubErr.message, detail: hubErr.detail },
        { status },
      );
    }
    return jsonError(500, "internal_error");
  }
}

/** Home device upstream: return RPC execution result */
export async function tunnelResult(req: Request): Promise<Response> {
  const home = authHome(req);
  if (!home) return jsonError(401, "unauthorized");

  let body: { id?: string; ok?: boolean; result?: unknown; error?: RpcError };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }
  if (typeof body.id !== "string" || typeof body.ok !== "boolean") {
    return jsonError(400, "missing_fields");
  }
  hub().resolveResult(home.id, body.id, body.ok, body.result, body.error);
  return new Response(null, { status: 204 });
}

// ---- OAuth (pairing-code flow for the remote MCP) ----

function oauthError(error: string, description?: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status });
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** OAuth token exchange: authorization_code + PKCE(S256) → long-lived access_token (clientToken) */
export async function oauthToken(req: Request): Promise<Response> {
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
  return Response.json({ access_token: token, token_type: "bearer", scope: "kb" });
}

/** RFC 7591 dynamic client registration (public client, no secret) */
export async function oauthRegister(req: Request): Promise<Response> {
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string").slice(0, 10)
    : [];
  if (redirectUris.length === 0) {
    return Response.json(
      { error: "invalid_redirect_uri", error_description: "redirect_uris required" },
      { status: 400 },
    );
  }
  const clientId = "oc_" + nanoid(16);
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 128) : "";
  relayDb()
    .prepare(
      "INSERT INTO oauth_clients (client_id, redirect_uris, name, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(clientId, JSON.stringify(redirectUris), name, Date.now());

  return Response.json(
    {
      client_id: clientId,
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    { status: 201 },
  );
}

/** Authorization page form submission: validate pairing code → issue auth code → 302 redirect to client */
export async function oauthAuthorizePost(req: Request): Promise<Response> {
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

  // Validate and consume the pairing code
  db.prepare("DELETE FROM pair_codes WHERE expires_at < ?").run(Date.now());
  const pc = db
    .prepare("SELECT code, home_id FROM pair_codes WHERE code = ? AND used = 0 AND expires_at >= ?")
    .get(pairCode, Date.now()) as { code: string; home_id: string } | undefined;
  if (!pc) {
    // Redirect back to the authorization page with an error flag (preserving original params)
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

// ---- .well-known ----

/** RFC 8414 authorization server metadata */
export function wellKnownAuthServer(req: Request): Response {
  const origin = requestOrigin(req);
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["kb"],
  });
}

/** RFC 9728 protected resource metadata */
export function wellKnownProtectedResource(req: Request): Response {
  const origin = requestOrigin(req);
  return Response.json({
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["kb"],
  });
}

// ---- Remote MCP (Streamable HTTP, stateless JSON response mode) ----

function mcpUnauthorized(req: Request): Response {
  const origin = requestOrigin(req);
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized" },
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

export async function mcpPost(req: Request): Promise<Response> {
  const grant = authGrant(req);
  if (!grant) return mcpUnauthorized(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  // Streamable HTTP spec: one message per request; handle arrays leniently (process each, return array)
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const res = await handleMcpMessage(msg, grant.home_id);
    if (res) responses.push(res);
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}

export { CORS_HEADERS };
