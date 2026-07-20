import type { Env } from "./env";
import { authGrant, authHome } from "./auth";
import {
  callHome,
  homeConnInfo,
  homeOnline,
  HubClientError,
  hubErrorStatus,
  tunnelStub,
} from "./do-client";
import { handleMcpMessage } from "./mcp-handler";
import { requestOrigin } from "./origin";
import { b64url, jsonError, randomId, randomPairCode, randomToken, sha256hex } from "./util";

/**
 * Relay route handlers — async D1 port of relay/src/routes.ts. The HTTP API is the
 * protocol contract (docs/ARCHITECTURE.md "Relay HTTP API") and must stay identical
 * to the Node target. Streaming routes (tunnel SSE, asset/ask channels) live in
 * index.ts + tunnel-do.ts, not here.
 */

const PAIR_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

/** Allowlist of RPC methods permitted by the tunnel protocol. */
export const RPC_METHODS = new Set([
  "kb.query",
  "kb.ask",
  "kb.read",
  "kb.write",
  "kb.create",
  "kb.draftList",
  "kb.draftSave",
  "kb.draftDelete",
  "kb.list",
  "kb.status",
  "kb.listTypes",
  "kb.suggestions",
  "kb.reindex",
  "kb.configGet",
  "kb.configSetAi",
  "kb.shareCreate",
  "kb.shareGet",
  "kb.shareList",
  "kb.shareRevoke",
]);

/** shareId format: 128-bit random hex minted by the engine. */
export const SHARE_ID_RE = /^[0-9a-f]{32}$/;

/** Engine share errors → client-facing HTTP statuses (docs/ARCHITECTURE.md "Note sharing"). */
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

// ---- /api/relay/* ----

/** Home device registration: → {homeId, homeSecret} (homeSecret is returned in plaintext only once) */
export async function relayRegister(req: Request, env: Env): Promise<Response> {
  let name = "";
  try {
    const body = (await req.json()) as { name?: unknown };
    if (typeof body?.name === "string") name = body.name.slice(0, 64);
  } catch {
    // empty body is also allowed
  }
  const homeId = "hm_" + randomId(10);
  const homeSecret = randomToken("hks_");
  await env.DB.prepare("INSERT INTO homes (id, name, secret_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(homeId, name, await sha256hex(homeSecret), Date.now())
    .run();
  return Response.json({ ok: true, homeId, homeSecret });
}

/**
 * Pairing:
 * - {action:"new"} (homeSecret or clientToken — any paired device can invite
 *   another; docs "Paired-device equivalence") → generate pairing code
 * - {action:"claim", code, label?} (public) → exchange for long-lived clientToken
 */

/**
 * Home scope of the caller (docs/ARCHITECTURE.md "Paired-device equivalence"):
 * homeSecret resolves to the home itself, a clientToken to the home its grant
 * is bound to. `grantId` identifies the calling device when clientToken-authed
 * (used for the grants list's `self` marker).
 */
async function authHomeScope(
  req: Request,
  env: Env,
): Promise<{ homeId: string; grantId?: string } | null> {
  const home = await authHome(req, env);
  if (home) return { homeId: home.id };
  const grant = await authGrant(req, env);
  if (grant) return { homeId: grant.home_id, grantId: grant.id };
  return null;
}

export async function relayPair(req: Request, env: Env): Promise<Response> {
  let body: { action?: string; code?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "invalid_json");
  }
  await env.DB.prepare("DELETE FROM pair_codes WHERE expires_at < ?").bind(Date.now()).run();

  if (body.action === "new") {
    const scope = await authHomeScope(req, env);
    if (!scope) return jsonError(401, "unauthorized");
    const code = randomPairCode();
    const expiresAt = Date.now() + PAIR_TTL_MS;
    await env.DB.prepare("INSERT INTO pair_codes (code, home_id, expires_at) VALUES (?, ?, ?)")
      .bind(code, scope.homeId, expiresAt)
      .run();
    return Response.json({ ok: true, code, expiresAt });
  }

  if (body.action === "claim") {
    const code = String(body.code || "").toUpperCase().replace(/\s/g, "");
    if (!code) return jsonError(400, "missing_code");
    const row = await env.DB.prepare(
      "SELECT code, home_id FROM pair_codes WHERE code = ? AND used = 0 AND expires_at >= ?",
    )
      .bind(code, Date.now())
      .first<{ code: string; home_id: string }>();
    if (!row) return jsonError(400, "invalid_or_expired_code");
    await env.DB.prepare("UPDATE pair_codes SET used = 1 WHERE code = ?").bind(row.code).run();

    const token = randomToken("hkt_");
    const label = typeof body.label === "string" ? body.label.slice(0, 64) : "";
    await env.DB.prepare(
      "INSERT INTO grants (id, home_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("gr_" + randomId(10), row.home_id, await sha256hex(token), label, Date.now())
      .run();

    const home = await env.DB.prepare("SELECT name FROM homes WHERE id = ?")
      .bind(row.home_id)
      .first<{ name: string }>();
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
 * Retire a home identity: deletes the home plus all of its grants / pair codes /
 * OAuth codes. Every client paired to it gets 401 from then on and auto-unpairs on
 * its next health poll — no zombie "forever offline" pairings.
 */
export async function relayHomeDelete(req: Request, env: Env): Promise<Response> {
  const home = await authHome(req, env);
  if (!home) return jsonError(401, "unauthorized");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM grants WHERE home_id = ?").bind(home.id),
    env.DB.prepare("DELETE FROM pair_codes WHERE home_id = ?").bind(home.id),
    env.DB.prepare("DELETE FROM oauth_codes WHERE home_id = ?").bind(home.id),
    env.DB.prepare("DELETE FROM shares WHERE home_id = ?").bind(home.id),
    env.DB.prepare("DELETE FROM homes WHERE id = ?").bind(home.id),
  ]);
  return Response.json({ ok: true });
}

// ---- Note sharing (docs/ARCHITECTURE.md "Note sharing") ----

/**
 * Register a share routing record (home device authenticated). The engine calls
 * this BEFORE persisting the share locally — a rejected registration must leave
 * no working share anywhere.
 */
export async function relayShareRegister(req: Request, env: Env): Promise<Response> {
  const home = await authHome(req, env);
  if (!home) return jsonError(401, "unauthorized");
  let body: { shareId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "invalid_json");
  }
  const shareId = typeof body.shareId === "string" ? body.shareId : "";
  if (!SHARE_ID_RE.test(shareId)) return jsonError(400, "bad_share_id");
  await env.DB.prepare(
    "INSERT OR REPLACE INTO shares (id, home_id, created_at) VALUES (?, ?, ?)",
  )
    .bind(shareId, home.id, Date.now())
    .run();
  return Response.json({ ok: true });
}

/** Drop a share routing record (idempotent; scoped to the authenticated home). */
export async function relayShareDelete(req: Request, env: Env, shareId: string): Promise<Response> {
  const home = await authHome(req, env);
  if (!home) return jsonError(401, "unauthorized");
  await env.DB.prepare("DELETE FROM shares WHERE id = ? AND home_id = ?")
    .bind(shareId, home.id)
    .run();
  return Response.json({ ok: true });
}

/**
 * Public share view: look up the routing record and forward `kb.shareGet` over
 * the tunnel. The relay constructs the method itself — the anonymous visitor
 * controls nothing but the password, and the home enforces every policy
 * decision (the relay cannot even tell whether the password was right).
 */
export async function relaySharePublicView(
  req: Request,
  env: Env,
  shareId: string,
): Promise<Response> {
  if (!SHARE_ID_RE.test(shareId)) return jsonError(404, "share_not_found");
  let password: string | undefined;
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body?.password === "string" && body.password) password = body.password;
  } catch {
    // empty body = no password supplied
  }
  const row = await env.DB.prepare("SELECT home_id FROM shares WHERE id = ?")
    .bind(shareId)
    .first<{ home_id: string }>();
  if (!row) return jsonError(404, "share_not_found");

  try {
    const result = await callHome(env, row.home_id, "kb.shareGet", {
      shareId,
      ...(password ? { password } : {}),
    });
    return Response.json({ ok: true, result });
  } catch (e) {
    if (e instanceof HubClientError) {
      // Engine-level share errors travel as rpc_error with a detail code.
      if (e.code === "rpc_error" && e.detail?.code?.startsWith("share_")) {
        return Response.json(
          { ok: false, error: e.detail.code, message: e.detail.message },
          { status: shareErrorStatus(e.detail.code) },
        );
      }
      return Response.json(
        { ok: false, error: e.code, message: e.message },
        { status: hubErrorStatus(e.code) },
      );
    }
    return jsonError(500, "internal_error");
  }
}

/** Client health check: whether the home device is online */
export async function relayHealth(req: Request, env: Env): Promise<Response> {
  const grant = await authGrant(req, env);
  if (!grant) return jsonError(401, "unauthorized");
  return Response.json({ ok: true, online: await homeOnline(env, grant.home_id) });
}

/**
 * Home-side tunnel liveness (docs/ARCHITECTURE.md "Tunnel liveness & deploy safety"):
 * the CURRENT instance's view of this home's tunnel. The engine polls this
 * out-of-band and reconnects when `online:false` or `connId` differs from the
 * one it received in `hello` — the self-healing that makes relay deploys
 * zero-coordination.
 */
export async function relayTunnelHealth(req: Request, env: Env): Promise<Response> {
  const home = await authHome(req, env);
  if (!home) return jsonError(401, "unauthorized");
  const info = await homeConnInfo(env, home.id);
  return Response.json({ ok: true, online: info.online, connId: info.connId });
}

/**
 * Paired-devices list (homeSecret or clientToken — docs "Paired-device
 * equivalence"): every grant of this home, newest first. clientToken callers
 * get `self: true` on their own grant so the UI can mark "this device". The
 * relay stores only labels + token hashes, so there is no per-grant liveness —
 * clients render lastUsedAt instead.
 */
export async function relayGrantsList(req: Request, env: Env): Promise<Response> {
  const scope = await authHomeScope(req, env);
  if (!scope) return jsonError(401, "unauthorized");
  const rows = await env.DB.prepare(
    "SELECT id, label, created_at, last_used_at FROM grants WHERE home_id = ? ORDER BY created_at DESC",
  )
    .bind(scope.homeId)
    .all<{ id: string; label: string; created_at: number; last_used_at: number | null }>();
  return Response.json({
    ok: true,
    grants: rows.results.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      ...(r.id === scope.grantId ? { self: true } : {}),
    })),
  });
}

/**
 * Revoke one grant (unpair a device). Scoped to the caller's home — the owning
 * home or any of its paired devices (a device may revoke a sibling or itself).
 */
export async function relayGrantRevoke(
  req: Request,
  env: Env,
  grantId: string,
): Promise<Response> {
  const scope = await authHomeScope(req, env);
  if (!scope) return jsonError(401, "unauthorized");
  const res = await env.DB.prepare("DELETE FROM grants WHERE id = ? AND home_id = ?")
    .bind(grantId, scope.homeId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return jsonError(404, "not_found");
  return Response.json({ ok: true });
}

/** Remote client RPC: forwarded through the tunnel to the home device for execution */
export async function relayRpc(req: Request, env: Env): Promise<Response> {
  const grant = await authGrant(req, env);
  if (!grant) return jsonError(401, "unauthorized");

  let body: { method?: string; params?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "invalid_json");
  }
  const method = String(body.method || "");
  if (!RPC_METHODS.has(method)) return jsonError(400, "unknown_method");

  try {
    const result = await callHome(env, grant.home_id, method, body.params ?? {});
    return Response.json({ ok: true, result });
  } catch (e) {
    if (e instanceof HubClientError) {
      return Response.json(
        { ok: false, error: e.code, message: e.message, detail: e.detail ?? undefined },
        { status: hubErrorStatus(e.code) },
      );
    }
    return jsonError(500, "internal_error");
  }
}

/** Home device upstream: return RPC execution result (late results silently discarded) */
export async function tunnelResult(req: Request, env: Env): Promise<Response> {
  const home = await authHome(req, env);
  if (!home) return jsonError(401, "unauthorized");

  let body: { id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "invalid_json");
  }
  if (typeof body.id !== "string" || typeof body.ok !== "boolean") {
    return jsonError(400, "missing_fields");
  }
  await tunnelStub(env, home.id).fetch("https://do/result", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return new Response(null, { status: 204 });
}

// ---- OAuth (pairing-code flow for the remote MCP) ----

function oauthError(error: string, description?: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status });
}

/** OAuth token exchange: authorization_code + PKCE(S256) → long-lived access_token (clientToken) */
export async function oauthToken(req: Request, env: Env): Promise<Response> {
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
  await env.DB.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(Date.now()).run();
  const row = await env.DB.prepare(
    "SELECT code, client_id, home_id, code_challenge, redirect_uri FROM oauth_codes WHERE code = ? AND used = 0 AND expires_at >= ?",
  )
    .bind(String(p.code ?? ""), Date.now())
    .first<{
      code: string;
      client_id: string;
      home_id: string;
      code_challenge: string;
      redirect_uri: string;
    }>();
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
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    if (b64url(digest) !== row.code_challenge) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
  }
  await env.DB.prepare("UPDATE oauth_codes SET used = 1 WHERE code = ?").bind(row.code).run();

  const client = await env.DB.prepare("SELECT name FROM oauth_clients WHERE client_id = ?")
    .bind(row.client_id)
    .first<{ name: string }>();
  const token = randomToken("hkt_");
  await env.DB.prepare(
    "INSERT INTO grants (id, home_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      "gr_" + randomId(10),
      row.home_id,
      await sha256hex(token),
      `oauth:${client?.name || row.client_id}`,
      Date.now(),
    )
    .run();

  // No expires_in / refresh_token: token is long-lived; clients re-authorize naturally when it becomes invalid
  return Response.json({ access_token: token, token_type: "bearer", scope: "kb" });
}

/** RFC 7591 dynamic client registration (public client, no secret) */
export async function oauthRegister(req: Request, env: Env): Promise<Response> {
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = (await req.json()) as typeof body;
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
  const clientId = "oc_" + randomId(16);
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 128) : "";
  await env.DB.prepare(
    "INSERT INTO oauth_clients (client_id, redirect_uris, name, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(clientId, JSON.stringify(redirectUris), name, Date.now())
    .run();

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
export async function oauthAuthorizePost(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const get = (k: string) => String(form.get(k) ?? "");

  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const state = get("state");
  const codeChallenge = get("code_challenge");
  const pairCode = get("pair_code").toUpperCase().replace(/\s/g, "");

  const client = await env.DB.prepare(
    "SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?",
  )
    .bind(clientId)
    .first<{ client_id: string; redirect_uris: string }>();
  if (!client || !(JSON.parse(client.redirect_uris) as string[]).includes(redirectUri)) {
    return new Response("invalid client or redirect_uri", { status: 400 });
  }
  if (get("code_challenge_method") && get("code_challenge_method") !== "S256") {
    return new Response("unsupported code_challenge_method", { status: 400 });
  }

  // Validate and consume the pairing code
  await env.DB.prepare("DELETE FROM pair_codes WHERE expires_at < ?").bind(Date.now()).run();
  const pc = await env.DB.prepare(
    "SELECT code, home_id FROM pair_codes WHERE code = ? AND used = 0 AND expires_at >= ?",
  )
    .bind(pairCode, Date.now())
    .first<{ code: string; home_id: string }>();
  if (!pc) {
    // Redirect back to the authorization page with an error flag (preserving original params)
    const back = new URL("/oauth/authorize", requestOrigin(req));
    for (const k of [
      "client_id",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
      "scope",
      "response_type",
    ]) {
      if (get(k)) back.searchParams.set(k, get(k));
    }
    back.searchParams.set("error", "bad_code");
    return Response.redirect(back.toString(), 302);
  }
  await env.DB.prepare("UPDATE pair_codes SET used = 1 WHERE code = ?").bind(pc.code).run();

  const authCode = "ac_" + randomId(32);
  await env.DB.prepare(
    "INSERT INTO oauth_codes (code, client_id, home_id, code_challenge, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(authCode, clientId, pc.home_id, codeChallenge, redirectUri, Date.now() + CODE_TTL_MS)
    .run();

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

export async function mcpPost(req: Request, env: Env): Promise<Response> {
  const grant = await authGrant(req, env);
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
    const res = await handleMcpMessage(msg, grant.home_id, env);
    if (res) responses.push(res);
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
