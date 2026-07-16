import type { Env } from "./env";
import { authGrant, authHome } from "./auth";
import { HubClientError, hubErrorStatus, requestAsset, requestAskStream, tunnelStub } from "./do-client";
import { CORS_HEADERS } from "./origin";
import { renderAuthorizePage } from "./pages";
import {
  mcpPost,
  oauthAuthorizePost,
  oauthRegister,
  oauthToken,
  relayGrantRevoke,
  relayGrantsList,
  relayHealth,
  relayHomeDelete,
  relayPair,
  relayPing,
  relayRegister,
  relayRpc,
  tunnelResult,
  wellKnownAuthServer,
  wellKnownProtectedResource,
} from "./routes";
import { ensureSchema } from "./schema";
import { HomeTunnelDO } from "./tunnel-do";

export { HomeTunnelDO };

/**
 * HomeKB relay — Cloudflare Workers target (docs/ARCHITECTURE.md "Relay service").
 * Same HTTP API + tunnel SSE protocol as the Node target (relay/); auth in the Worker
 * against D1, tunnel state in one Durable Object per home. Pure pipe: zero
 * knowledge-base data at rest, bodies stream through without buffering.
 */

type Handler = (req: Request, env: Env) => Response | Promise<Response>;

const ROUTES: Record<string, Handler> = {
  "GET /api/relay/ping": relayPing,
  "DELETE /api/relay/home": relayHomeDelete,
  "POST /api/relay/register": relayRegister,
  "POST /api/relay/pair": relayPair,
  "GET /api/relay/health": relayHealth,
  "GET /api/relay/grants": relayGrantsList,
  "POST /api/relay/rpc": relayRpc,
  "POST /api/relay/tunnel/result": tunnelResult,
  "POST /api/oauth/token": oauthToken,
  "POST /api/oauth/register": oauthRegister,
  "POST /api/oauth/authorize": oauthAuthorizePost,
  "GET /oauth/authorize": (req, env) => renderAuthorizePage(new URL(req.url).searchParams, env),
  "GET /.well-known/oauth-authorization-server": (req) => wellKnownAuthServer(req),
  "GET /.well-known/oauth-protected-resource": (req) => wellKnownProtectedResource(req),
  "POST /api/mcp": mcpPost,
  "GET /api/mcp": () => new Response(null, { status: 405 }), // server-initiated streaming unsupported
  "DELETE /api/mcp": () => new Response(null, { status: 405 }),
  "GET /": () => Response.json({ ok: true, service: "homekb-relay", version: "0.1.0" }),
};

/** Asset paths are relative to ~/.homekb/assets/ — reject traversal before it even reaches the home device. */
function isSafeAssetPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

function jsonError(status: number, error: string, message?: string): Response {
  return Response.json({ ok: false, error, ...(message ? { message } : {}) }, { status });
}

function hubClientErrorResponse(e: HubClientError, fallback: string): Response {
  return Response.json(
    { ok: false, error: e.code, message: e.message || fallback },
    { status: hubErrorStatus(e.code) },
  );
}

// ---- streaming handlers (DO-backed) ----

/** Home device tunnel downstream: long-lived SSE connection, pushes rpc/asset instructions. */
async function handleTunnelSse(req: Request, env: Env): Promise<Response> {
  const home = await authHome(req, env);
  if (!home) return jsonError(401, "unauthorized");

  const doRes = await tunnelStub(env, home.id).fetch("https://do/tunnel", {
    headers: { "x-home-id": home.id, "x-home-name": home.name },
    signal: req.signal,
  });
  return new Response(doRes.body, {
    status: doRes.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

/** Home device upstream for the asset/ask channels: body piped into the pending client response via the DO. */
async function handleTunnelUpstream(req: Request, env: Env, id: string): Promise<Response> {
  const home = await authHome(req, env);
  if (!home) return jsonError(401, "unauthorized");

  const headers = new Headers();
  for (const h of ["content-type", "content-length", "x-asset-error"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  return tunnelStub(env, home.id).fetch(`https://do/upstream/${encodeURIComponent(id)}`, {
    method: "POST",
    headers,
    body: req.body,
  });
}

/** Client-side binary asset fetch: forwarded to the home device, streamed back without buffering. */
async function handleRelayAssetGet(req: Request, env: Env, assetPath: string): Promise<Response> {
  const grant = await authGrant(req, env);
  if (!grant) return jsonError(401, "unauthorized");
  if (!isSafeAssetPath(assetPath)) return jsonError(400, "bad_path");

  try {
    const d = await requestAsset(env, grant.home_id, assetPath);
    if (d.error) {
      return jsonError(d.error === "not_found" ? 404 : 500, d.error);
    }
    const headers: Record<string, string> = {
      "Content-Type": d.contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    };
    if (d.contentLength) headers["Content-Length"] = d.contentLength;
    return new Response(d.body, { status: 200, headers });
  } catch (e) {
    if (e instanceof HubClientError) return hubClientErrorResponse(e, "asset fetch failed");
    return jsonError(500, "internal_error");
  }
}

/**
 * Client-side streaming ask: forwarded to the home over the tunnel, its SSE frames
 * piped back verbatim (kb.ask only — the relay never inspects the frames).
 */
async function handleRelayRpcStream(req: Request, env: Env): Promise<Response> {
  const grant = await authGrant(req, env);
  if (!grant) return jsonError(401, "unauthorized");

  let body: { method?: string; params?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "invalid_json");
  }
  if (body.method !== "kb.ask") return jsonError(400, "not_streamable");

  try {
    const d = await requestAskStream(env, grant.home_id, body.params ?? {});
    if (d.error) return jsonError(500, d.error);
    return new Response(d.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (e) {
    if (e instanceof HubClientError) return hubClientErrorResponse(e, "ask stream failed");
    return jsonError(500, "internal_error");
  }
}

// ---- dispatch (mirrors relay/src/server.ts) ----

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") return new Response(null, { status: 204 });

  if (method === "GET" && path === "/api/relay/tunnel") return handleTunnelSse(req, env);
  if (method === "POST" && path === "/api/relay/rpc/stream") return handleRelayRpcStream(req, env);

  const TUNNEL_ASSET = "/api/relay/tunnel/asset/";
  if (method === "POST" && path.startsWith(TUNNEL_ASSET)) {
    return handleTunnelUpstream(req, env, path.slice(TUNNEL_ASSET.length));
  }
  const TUNNEL_ASK = "/api/relay/tunnel/ask/";
  if (method === "POST" && path.startsWith(TUNNEL_ASK)) {
    return handleTunnelUpstream(req, env, path.slice(TUNNEL_ASK.length));
  }
  const RELAY_ASSET = "/api/relay/asset/";
  if (method === "GET" && path.startsWith(RELAY_ASSET)) {
    return handleRelayAssetGet(req, env, decodeURIComponent(path.slice(RELAY_ASSET.length)));
  }
  const RELAY_GRANT = "/api/relay/grants/";
  if (method === "DELETE" && path.startsWith(RELAY_GRANT)) {
    return relayGrantRevoke(req, env, decodeURIComponent(path.slice(RELAY_GRANT.length)));
  }

  const handler = ROUTES[`${method} ${path}`];
  if (!handler) return jsonError(404, "not_found");
  return handler(req, env);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      // Self-initializing schema: one-click deploys start from an empty D1.
      await ensureSchema(env);
      return withCors(await handle(req, env));
    } catch (e) {
      console.error("[relay] unhandled error:", e);
      return withCors(jsonError(500, "internal_error"));
    }
  },
} satisfies ExportedHandler<Env>;
