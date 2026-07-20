import type { Env } from "./env";
import { authGrant, authHome } from "./auth";
import {
  HubClientError,
  claimUpload,
  hubErrorStatus,
  requestAsset,
  requestAssetUpload,
  requestAskStream,
  tunnelStub,
} from "./do-client";
import { CORS_HEADERS } from "./origin";
import { renderAuthorizePage } from "./pages";
import {
  SHARE_ID_RE,
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
  relayShareDelete,
  relaySharePublicView,
  relayShareRegister,
  relayTunnelHealth,
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
  "GET /api/relay/tunnel/health": relayTunnelHealth,
  "POST /api/relay/share": relayShareRegister,
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
  for (const h of ["content-type", "content-length", "x-asset-error", "x-ask-seq", "x-ask-fin"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  return tunnelStub(env, home.id).fetch(`https://do/upstream/${encodeURIComponent(id)}`, {
    method: "POST",
    headers,
    body: req.body,
  });
}

/** The client's image-variant request, forwarded verbatim on the SSE `asset`
 *  event (docs/ARCHITECTURE.md "Image variant service"). */
function assetVariant(req: Request): { query?: string; accept?: string } {
  const search = new URL(req.url).search;
  const accept = req.headers.get("accept");
  return {
    ...(search.length > 1 ? { query: search.slice(1) } : {}),
    ...(accept ? { accept } : {}),
  };
}

/** Client-side binary asset fetch: forwarded to the home device, streamed back without buffering. */
async function handleRelayAssetGet(req: Request, env: Env, assetPath: string): Promise<Response> {
  const grant = await authGrant(req, env);
  if (!grant) return jsonError(401, "unauthorized");
  if (!isSafeAssetPath(assetPath)) return jsonError(400, "bad_path");

  try {
    const d = await requestAsset(env, grant.home_id, assetPath, assetVariant(req));
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
 * Client-side binary asset upload (docs/ARCHITECTURE.md "Binary asset channel",
 * upload direction): the client's raw-bytes POST streams into the DO, the home
 * claims the body (GET /api/relay/tunnel/upload/<id>) and reports the final
 * asset path via POST /api/relay/tunnel/result. Node parity: relay/src/server.ts
 * handleRelayAssetUpload.
 */
async function handleRelayAssetUpload(req: Request, env: Env, assetPath: string): Promise<Response> {
  const grant = await authGrant(req, env);
  if (!grant) return jsonError(401, "unauthorized");
  if (!isSafeAssetPath(assetPath)) return jsonError(400, "bad_path");

  try {
    const result = await requestAssetUpload(env, grant.home_id, assetPath, {
      contentType: req.headers.get("content-type") ?? undefined,
      contentLength: req.headers.get("content-length") ?? undefined,
      body: req.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    });
    const path = (result as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || !path) return jsonError(500, "bad_home_result");
    return Response.json({ ok: true, path });
  } catch (e) {
    if (e instanceof HubClientError) {
      if (e.code === "rpc_error") {
        // Engine-side failure (bad kind, disk error) — surface its code/message.
        return jsonError(400, e.detail?.code ?? "asset_write_failed", e.detail?.message ?? e.message);
      }
      return hubClientErrorResponse(e, "asset upload failed");
    }
    return jsonError(500, "internal_error");
  }
}

/** Home device claim of a pending upload body: DO response passed through verbatim. */
async function handleTunnelUploadClaim(req: Request, env: Env, id: string): Promise<Response> {
  const home = await authHome(req, env);
  if (!home) return jsonError(401, "unauthorized");
  return claimUpload(env, home.id, id);
}

/**
 * Public share-scoped asset fetch (docs/ARCHITECTURE.md "Note sharing"): no client
 * token — the share context is forwarded to the home, which streams the bytes only
 * if the share is valid and the shared note references the asset.
 */
async function handleShareAssetGet(
  req: Request,
  env: Env,
  shareId: string,
  assetPath: string,
): Promise<Response> {
  if (!SHARE_ID_RE.test(shareId)) return jsonError(404, "share_not_found");
  if (!isSafeAssetPath(assetPath)) return jsonError(400, "bad_path");
  const row = await env.DB.prepare("SELECT home_id FROM shares WHERE id = ?")
    .bind(shareId)
    .first<{ home_id: string }>();
  if (!row) return jsonError(404, "share_not_found");

  const password = req.headers.get("x-share-password") ?? undefined;
  try {
    const d = await requestAsset(env, row.home_id, assetPath, {
      share: { shareId, password },
      ...assetVariant(req),
    });
    if (d.error) {
      const status = d.error === "share_denied" ? 403 : d.error === "not_found" ? 404 : 500;
      return jsonError(status, d.error);
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
  const TUNNEL_UPLOAD = "/api/relay/tunnel/upload/";
  if (method === "GET" && path.startsWith(TUNNEL_UPLOAD)) {
    return handleTunnelUploadClaim(req, env, path.slice(TUNNEL_UPLOAD.length));
  }
  const RELAY_ASSET = "/api/relay/asset/";
  if (method === "GET" && path.startsWith(RELAY_ASSET)) {
    return handleRelayAssetGet(req, env, decodeURIComponent(path.slice(RELAY_ASSET.length)));
  }
  if (method === "POST" && path.startsWith(RELAY_ASSET)) {
    return handleRelayAssetUpload(req, env, decodeURIComponent(path.slice(RELAY_ASSET.length)));
  }
  const RELAY_GRANT = "/api/relay/grants/";
  if (method === "DELETE" && path.startsWith(RELAY_GRANT)) {
    return relayGrantRevoke(req, env, decodeURIComponent(path.slice(RELAY_GRANT.length)));
  }
  const RELAY_SHARE = "/api/relay/share/";
  if (path.startsWith(RELAY_SHARE)) {
    const rest = path.slice(RELAY_SHARE.length);
    const assetIdx = rest.indexOf("/asset/");
    if (method === "GET" && assetIdx > 0) {
      const shareId = rest.slice(0, assetIdx);
      const assetPath = decodeURIComponent(rest.slice(assetIdx + "/asset/".length));
      return handleShareAssetGet(req, env, shareId, assetPath);
    }
    if (method === "POST" && !rest.includes("/")) {
      return relaySharePublicView(req, env, rest);
    }
    if (method === "DELETE" && !rest.includes("/")) {
      return relayShareDelete(req, env, rest);
    }
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
