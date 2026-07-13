import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import {
  asRpcHubError,
  hub,
  type AssetDelivery,
} from "../../lib/relay/hub";
import { authGrant, authHome } from "../../lib/relay/auth";
import { CORS_HEADERS } from "../../lib/relay/origin";
import { sendWebResponse, toWebRequest } from "./adapter";
import { renderAuthorizePage } from "./pages";
import {
  mcpPost,
  oauthAuthorizePost,
  oauthRegister,
  oauthToken,
  relayHealth,
  relayPair,
  relayRegister,
  relayRpc,
  tunnelResult,
  wellKnownAuthServer,
  wellKnownProtectedResource,
} from "./routes";

/**
 * HomeKB relay — standalone multi-tenant Node service (see docs/ARCHITECTURE.md "Relay service").
 * One job: pipe requests from remote clients (Web UI on Vercel / Claude mobile MCP / any Agent)
 * to home devices over the SSE tunnel and stream results back. Zero knowledge-base data at rest.
 *
 * Run: node relay/dist/server.mjs [--port 8787]   (DB path via HOMEKB_RELAY_DB)
 */

const PING_INTERVAL_MS = 25_000;

type Handler = (req: Request) => Response | Promise<Response>;

const ROUTES: Record<string, Handler> = {
  "POST /api/relay/register": relayRegister,
  "POST /api/relay/pair": relayPair,
  "GET /api/relay/health": relayHealth,
  "POST /api/relay/rpc": relayRpc,
  "POST /api/relay/tunnel/result": tunnelResult,
  "POST /api/oauth/token": oauthToken,
  "POST /api/oauth/register": oauthRegister,
  "POST /api/oauth/authorize": oauthAuthorizePost,
  "GET /oauth/authorize": (req) => renderAuthorizePage(new URL(req.url).searchParams),
  "GET /.well-known/oauth-authorization-server": wellKnownAuthServer,
  "GET /.well-known/oauth-protected-resource": wellKnownProtectedResource,
  "POST /api/mcp": mcpPost,
  "GET /api/mcp": () => new Response(null, { status: 405 }), // server-initiated streaming unsupported
  "DELETE /api/mcp": () => new Response(null, { status: 405 }),
  "GET /": () =>
    Response.json({ ok: true, service: "homekb-relay", version: "0.1.0" }),
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

/** Asset paths are relative to ~/.homekb/assets/ — reject traversal before it even reaches the home device. */
function isSafeAssetPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// ---- native streaming handlers (need raw node req/res; the web adapter would buffer) ----

/** Home device tunnel downstream: long-lived SSE connection, pushes rpc/asset instructions. */
function handleTunnelSse(nodeReq: IncomingMessage, nodeRes: ServerResponse): void {
  const home = authHome(toWebRequest(nodeReq));
  if (!home) return sendJson(nodeRes, 401, { ok: false, error: "unauthorized" });

  nodeRes.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...CORS_HEADERS,
  });
  nodeRes.flushHeaders();
  nodeRes.on("error", () => {}); // socket errors surface via 'close'

  let closed = false;
  const send = (event: string, data: string) => {
    if (closed || nodeRes.destroyed || nodeRes.writableEnded) {
      throw new Error("stream closed");
    }
    nodeRes.write(`event: ${event}\ndata: ${data}\n\n`);
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    try {
      nodeRes.end();
    } catch {}
  };
  const conn = hub().register(home.id, send, cleanup);
  const ping = setInterval(() => {
    try {
      send("ping", String(Date.now()));
    } catch {
      cleanup();
      hub().unregister(home.id, conn);
    }
  }, PING_INTERVAL_MS);

  nodeReq.on("close", () => {
    hub().unregister(home.id, conn);
    cleanup();
  });

  send("hello", JSON.stringify({ homeId: home.id, name: home.name }));
}

/**
 * Home device upstream for the binary asset channel: raw bytes body.
 * The 204 to the home is deferred until the bytes are fully piped to the client (delivery.done).
 */
function handleTunnelAssetPost(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  id: string,
): void {
  const home = authHome(toWebRequest(nodeReq));
  if (!home) return sendJson(nodeRes, 401, { ok: false, error: "unauthorized" });

  const errorCode = nodeReq.headers["x-asset-error"];
  const delivery: AssetDelivery = {
    error: typeof errorCode === "string" && errorCode ? errorCode : undefined,
    contentType: typeof nodeReq.headers["content-type"] === "string" ? nodeReq.headers["content-type"] : undefined,
    contentLength: typeof nodeReq.headers["content-length"] === "string" ? nodeReq.headers["content-length"] : undefined,
    stream: nodeReq,
    done: () => {
      // ACK the home's upload once the bytes are fully piped to the client
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(204, CORS_HEADERS);
        nodeRes.end();
      }
    },
  };

  const delivered = hub().resolveResult(home.id, id, true, delivery);
  if (!delivered) {
    // No pending request (timed out or duplicate) — drain and NACK so the home side can log it.
    nodeReq.resume();
    sendJson(nodeRes, 409, { ok: false, error: "no_pending" });
  }
}

/** Client-side binary asset fetch: forwarded to the home device, streamed back without buffering. */
async function handleRelayAssetGet(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  assetPath: string,
): Promise<void> {
  const grant = authGrant(toWebRequest(nodeReq));
  if (!grant) return sendJson(nodeRes, 401, { ok: false, error: "unauthorized" });
  if (!isSafeAssetPath(assetPath)) {
    return sendJson(nodeRes, 400, { ok: false, error: "bad_path" });
  }

  let delivery: AssetDelivery;
  try {
    delivery = await hub().requestAsset(grant.home_id, assetPath);
  } catch (e) {
    const hubErr = asRpcHubError(e);
    const status =
      hubErr?.code === "home_offline" ? 502 : hubErr?.code === "timeout" ? 504 : 500;
    return sendJson(nodeRes, status, {
      ok: false,
      error: hubErr?.code ?? "internal_error",
      message: hubErr?.message ?? "asset fetch failed",
    });
  }

  const stream = delivery.stream as Readable;
  if (delivery.error) {
    stream?.resume(); // drain the (empty) body
    delivery.done?.();
    const status = delivery.error === "not_found" ? 404 : 500;
    return sendJson(nodeRes, status, { ok: false, error: delivery.error });
  }

  const headers: Record<string, string> = {
    "Content-Type": delivery.contentType || "application/octet-stream",
    "Cache-Control": "private, max-age=3600",
    ...CORS_HEADERS,
  };
  if (delivery.contentLength) headers["Content-Length"] = delivery.contentLength;
  nodeRes.writeHead(200, headers);

  stream.pipe(nodeRes);
  stream.on("end", () => delivery.done?.());
  stream.on("error", () => {
    delivery.done?.();
    nodeRes.destroy();
  });
  // Client went away mid-transfer → abort the home upload too.
  nodeRes.on("close", () => stream.destroy());
}

// ---- dispatch ----

async function handle(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const url = new URL(nodeReq.url ?? "/", "http://relay");
  const path = url.pathname;
  const method = nodeReq.method ?? "GET";

  if (method === "OPTIONS") {
    nodeRes.writeHead(204, CORS_HEADERS);
    nodeRes.end();
    return;
  }

  // Streaming routes handled natively
  if (method === "GET" && path === "/api/relay/tunnel") {
    return handleTunnelSse(nodeReq, nodeRes);
  }
  const TUNNEL_ASSET = "/api/relay/tunnel/asset/";
  if (method === "POST" && path.startsWith(TUNNEL_ASSET)) {
    return handleTunnelAssetPost(nodeReq, nodeRes, path.slice(TUNNEL_ASSET.length));
  }
  const RELAY_ASSET = "/api/relay/asset/";
  if (method === "GET" && path.startsWith(RELAY_ASSET)) {
    return handleRelayAssetGet(
      nodeReq,
      nodeRes,
      decodeURIComponent(path.slice(RELAY_ASSET.length)),
    );
  }

  const handler = ROUTES[`${method} ${path}`];
  if (!handler) return sendJson(nodeRes, 404, { ok: false, error: "not_found" });

  const webRes = await handler(toWebRequest(nodeReq));
  await sendWebResponse(webRes, nodeRes, CORS_HEADERS);
}

// ---- main ----

function parsePort(): number {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  if (process.env.PORT) return Number(process.env.PORT);
  return 8787;
}

const port = parsePort();
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[relay] unhandled error:", e);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "internal_error" });
    } else {
      res.destroy();
    }
  });
});

server.listen(port, () => {
  const db = process.env.HOMEKB_RELAY_DB || "~/.homekb-relay/relay.db";
  console.log(`homekb-relay listening on http://0.0.0.0:${port}  (db: ${db})`);
});
