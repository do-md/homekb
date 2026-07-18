import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import {
  asRpcHubError,
  hub,
  type AssetDelivery,
} from "./lib/relay/hub";
import { authGrant, authHome } from "./lib/relay/auth";
import { CORS_HEADERS } from "./lib/relay/origin";
import { sendWebResponse, toWebRequest, toWebRequestHeaders } from "./adapter";
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
import { relayDb } from "./lib/relay/db";

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
  const home = authHome(toWebRequestHeaders(nodeReq));
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

  send("hello", JSON.stringify({ homeId: home.id, name: home.name, connId: conn.connId }));
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
  const home = authHome(toWebRequestHeaders(nodeReq));
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

/**
 * Stream one asset delivery to the client (shared by the paired-client asset route
 * and the public share-scoped asset route — they differ only in authorization).
 */
function pipeAssetDelivery(nodeRes: ServerResponse, delivery: AssetDelivery): void {
  const stream = delivery.stream as Readable;
  if (delivery.error) {
    stream?.resume(); // drain the (empty) body
    delivery.done?.();
    const status =
      delivery.error === "share_denied" ? 403 : delivery.error === "not_found" ? 404 : 500;
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

function sendHubError(nodeRes: ServerResponse, e: unknown, fallback: string): void {
  const hubErr = asRpcHubError(e);
  const status = hubErr?.code === "home_offline" ? 502 : hubErr?.code === "timeout" ? 504 : 500;
  sendJson(nodeRes, status, {
    ok: false,
    error: hubErr?.code ?? "internal_error",
    message: hubErr?.message ?? fallback,
  });
}

/** Client-side binary asset fetch: forwarded to the home device, streamed back without buffering. */
async function handleRelayAssetGet(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  assetPath: string,
): Promise<void> {
  const grant = authGrant(toWebRequestHeaders(nodeReq));
  if (!grant) return sendJson(nodeRes, 401, { ok: false, error: "unauthorized" });
  if (!isSafeAssetPath(assetPath)) {
    return sendJson(nodeRes, 400, { ok: false, error: "bad_path" });
  }

  let delivery: AssetDelivery;
  try {
    delivery = await hub().requestAsset(grant.home_id, assetPath);
  } catch (e) {
    return sendHubError(nodeRes, e, "asset fetch failed");
  }
  pipeAssetDelivery(nodeRes, delivery);
}

/**
 * Client-side binary asset upload (docs/ARCHITECTURE.md "Binary asset channel",
 * upload direction): the client's raw-bytes POST is held open while the home
 * claims the body (GET /api/relay/tunnel/upload/<id>) and reports the final
 * asset path via POST /api/relay/tunnel/result. Zero buffering — the body
 * stream is handed to the hub as-is and piped straight into the home's claim.
 */
async function handleRelayAssetUpload(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  assetPath: string,
): Promise<void> {
  const grant = authGrant(toWebRequestHeaders(nodeReq));
  if (!grant) return sendJson(nodeRes, 401, { ok: false, error: "unauthorized" });
  if (!isSafeAssetPath(assetPath)) {
    return sendJson(nodeRes, 400, { ok: false, error: "bad_path" });
  }

  const contentType = nodeReq.headers["content-type"];
  const contentLength = nodeReq.headers["content-length"];
  let uploadId = "";
  const pending = hub().requestAssetUpload(
    grant.home_id,
    assetPath,
    {
      contentType: typeof contentType === "string" ? contentType : undefined,
      contentLength: typeof contentLength === "string" ? contentLength : undefined,
      stream: nodeReq,
    },
    { onId: (id) => (uploadId = id) },
  );
  nodeReq.on("error", () => {}); // abort surfaces via 'close'
  // Client went away before the body was fully received → abort the upload
  // (drops the stashed body and fails the pending request immediately).
  nodeReq.on("close", () => {
    if (!nodeReq.complete && uploadId) hub().cancelUpload(grant.home_id, uploadId);
  });

  let result: unknown;
  try {
    result = await pending;
  } catch (e) {
    const hubErr = asRpcHubError(e);
    if (hubErr?.code === "rpc_error") {
      // Engine-side failure (bad kind, disk error) — surface its code/message.
      return sendJson(nodeRes, 400, {
        ok: false,
        error: hubErr.detail?.code ?? "asset_write_failed",
        message: hubErr.detail?.message ?? hubErr.message,
      });
    }
    return sendHubError(nodeRes, e, "asset upload failed");
  }
  const path = (result as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || !path) {
    return sendJson(nodeRes, 500, { ok: false, error: "bad_home_result" });
  }
  sendJson(nodeRes, 200, { ok: true, path });
}

/**
 * Home device claim of a pending upload body: pipe the client's request body
 * straight into this response (one-shot; a second claim → 404). The home then
 * posts the outcome to /api/relay/tunnel/result with the same id.
 */
function handleTunnelUploadClaim(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  id: string,
): void {
  const home = authHome(toWebRequestHeaders(nodeReq));
  if (!home) return sendJson(nodeRes, 401, { ok: false, error: "unauthorized" });

  const source = hub().claimUpload(home.id, id);
  if (!source) return sendJson(nodeRes, 404, { ok: false, error: "no_pending" });

  const clientReq = source.stream as Readable;
  const headers: Record<string, string> = {
    "Content-Type": source.contentType || "application/octet-stream",
    ...CORS_HEADERS,
  };
  if (source.contentLength) headers["Content-Length"] = source.contentLength;
  nodeRes.writeHead(200, headers);

  clientReq.pipe(nodeRes);
  clientReq.on("error", () => {
    // Client aborted mid-body: kill the home's claim and fail the pending request.
    hub().cancelUpload(home.id, id);
    nodeRes.destroy();
  });
  // Home went away mid-claim → stop consuming the client body.
  nodeRes.on("close", () => clientReq.unpipe(nodeRes));
}

/**
 * Public share-scoped asset fetch (docs/ARCHITECTURE.md "Note sharing"): no client
 * token — the share context is forwarded to the home, which streams the bytes only
 * if the share is valid and the shared note references the asset.
 */
async function handleShareAssetGet(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  shareId: string,
  assetPath: string,
): Promise<void> {
  if (!SHARE_ID_RE.test(shareId)) {
    return sendJson(nodeRes, 404, { ok: false, error: "share_not_found" });
  }
  if (!isSafeAssetPath(assetPath)) {
    return sendJson(nodeRes, 400, { ok: false, error: "bad_path" });
  }
  const row = relayDb()
    .prepare("SELECT home_id FROM shares WHERE id = ?")
    .get(shareId) as { home_id: string } | undefined;
  if (!row) return sendJson(nodeRes, 404, { ok: false, error: "share_not_found" });

  const rawPw = nodeReq.headers["x-share-password"];
  const password = typeof rawPw === "string" && rawPw ? rawPw : undefined;
  let delivery: AssetDelivery;
  try {
    delivery = await hub().requestAsset(row.home_id, assetPath, { shareId, password });
  } catch (e) {
    return sendHubError(nodeRes, e, "asset fetch failed");
  }
  pipeAssetDelivery(nodeRes, delivery);
}

/**
 * In-flight chunked ask streams (docs/ARCHITECTURE.md "Streaming answer channel"),
 * keyed `<homeId>:<reqId>`. The home delivers the answer as ordered chunk POSTs
 * (X-Ask-Seq/X-Ask-Fin) — mandatory on the Workers target (its edge buffers request
 * bodies); the Node target implements the same contract for protocol parity.
 */
const askSessions = new Map<
  string,
  { pass: PassThrough; nextSeq: number; idleTimer: ReturnType<typeof setTimeout> }
>();
/** Inter-chunk idle timeout: GC an ask session whose home went silent mid-stream. */
const ASK_CHUNK_IDLE_TIMEOUT = 120_000;

/**
 * Home device upstream for the streaming answer channel. Two shapes:
 * - Chunked (X-Ask-Seq header): seq 0 resolves the pending client stream with a
 *   PassThrough; later chunks append; X-Ask-Fin (or the idle timer) ends it. Each
 *   chunk ACKs 204 as soon as its body is consumed.
 * - Legacy single streaming POST (engines predating the chunk contract): the whole
 *   request body is the SSE frame stream, piped verbatim; deferred 204 until fully
 *   piped (delivery.done). A synthesis failure arrives as a trailing `error` frame
 *   inside the body either way — there is no X-*-Error header on this channel.
 */
function handleTunnelAskPost(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  id: string,
): void {
  const home = authHome(toWebRequestHeaders(nodeReq));
  if (!home) return sendJson(nodeRes, 401, { ok: false, error: "unauthorized" });

  const rawSeq = nodeReq.headers["x-ask-seq"];
  if (typeof rawSeq === "string") {
    return handleTunnelAskChunk(nodeReq, nodeRes, home.id, id, Number(rawSeq));
  }

  const delivery: AssetDelivery = {
    contentType: "text/event-stream",
    stream: nodeReq,
    done: () => {
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(204, CORS_HEADERS);
        nodeRes.end();
      }
    },
  };

  const delivered = hub().resolveResult(home.id, id, true, delivery);
  if (!delivered) {
    // No pending stream (timed out or duplicate) — drain and NACK.
    nodeReq.resume();
    sendJson(nodeRes, 409, { ok: false, error: "no_pending" });
  }
}

/** One chunk of a chunked ask stream (X-Ask-Seq present). */
function handleTunnelAskChunk(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  homeId: string,
  id: string,
  seq: number,
): void {
  const key = `${homeId}:${id}`;
  const fin = nodeReq.headers["x-ask-fin"] === "1";

  const nack = (error: string) => {
    nodeReq.resume();
    sendJson(nodeRes, 409, { ok: false, error });
  };
  const endSession = (s: NonNullable<ReturnType<typeof askSessions.get>>, abort: boolean) => {
    clearTimeout(s.idleTimer);
    askSessions.delete(key);
    if (abort) s.pass.destroy();
    else s.pass.end();
  };
  const armIdle = (s: NonNullable<ReturnType<typeof askSessions.get>>) => {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (askSessions.get(key) === s) endSession(s, true);
    }, ASK_CHUNK_IDLE_TIMEOUT);
  };

  let session = askSessions.get(key);
  if (!session) {
    // First chunk: must be seq 0 against a still-pending client request.
    if (seq !== 0) return nack("bad_seq");
    const pass = new PassThrough();
    const delivered = hub().resolveResult(homeId, id, true, {
      contentType: "text/event-stream",
      stream: pass,
    } satisfies AssetDelivery);
    if (!delivered) {
      pass.destroy();
      return nack("no_pending");
    }
    session = { pass, nextSeq: 0, idleTimer: setTimeout(() => {}, 0) };
    askSessions.set(key, session);
  }
  const s = session;

  if (seq !== s.nextSeq) {
    // Out of order (lost ACK + replay, or a bug): kill the stream so the client
    // fails fast instead of hanging on a hole.
    endSession(s, true);
    return nack("bad_seq");
  }
  if (s.pass.destroyed || !s.pass.writable) {
    // Client went away — tell the home to abandon the remainder.
    endSession(s, true);
    return nack("no_pending");
  }
  s.nextSeq += 1;
  clearTimeout(s.idleTimer);

  nodeReq.on("data", (c: Buffer) => {
    if (!s.pass.destroyed && s.pass.writable) s.pass.write(c);
  });
  nodeReq.on("end", () => {
    if (fin) endSession(s, false);
    else armIdle(s);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(204, CORS_HEADERS);
      nodeRes.end();
    }
  });
  nodeReq.on("error", () => endSession(s, true));
}

/**
 * Client-side streaming ask: forwarded to the home over the tunnel, its SSE frames piped
 * back to the client without buffering (docs/ARCHITECTURE.md "Streaming answer channel").
 * kb.ask only — the relay stays a pure pipe and never inspects the frames.
 */
async function handleRelayRpcStream(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
): Promise<void> {
  const webReq = toWebRequest(nodeReq);
  const grant = authGrant(webReq);
  if (!grant) return sendJson(nodeRes, 401, { ok: false, error: "unauthorized" });

  let body: { method?: string; params?: unknown };
  try {
    body = await webReq.json();
  } catch {
    return sendJson(nodeRes, 400, { ok: false, error: "invalid_json" });
  }
  if (body.method !== "kb.ask") {
    return sendJson(nodeRes, 400, { ok: false, error: "not_streamable" });
  }

  let delivery: AssetDelivery;
  try {
    delivery = await hub().requestAskStream(grant.home_id, body.params ?? {});
  } catch (e) {
    const hubErr = asRpcHubError(e);
    const status =
      hubErr?.code === "home_offline" ? 502 : hubErr?.code === "timeout" ? 504 : 500;
    return sendJson(nodeRes, status, {
      ok: false,
      error: hubErr?.code ?? "internal_error",
      message: hubErr?.message ?? "ask stream failed",
    });
  }

  const stream = delivery.stream as Readable;
  nodeRes.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...CORS_HEADERS,
  });

  stream.pipe(nodeRes);
  stream.on("end", () => delivery.done?.());
  // Client gone mid-stream: destroy the source so chunked ask appends fail fast
  // (the chunk handler NACKs 409 and the home abandons the remainder).
  nodeRes.on("close", () => {
    if (!stream.readableEnded) stream.destroy();
  });
  stream.on("error", () => {
    delivery.done?.();
    nodeRes.destroy();
  });
  // Client went away mid-stream → abort the home upload too.
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
  if (method === "POST" && path === "/api/relay/rpc/stream") {
    return handleRelayRpcStream(nodeReq, nodeRes);
  }
  const TUNNEL_ASSET = "/api/relay/tunnel/asset/";
  if (method === "POST" && path.startsWith(TUNNEL_ASSET)) {
    return handleTunnelAssetPost(nodeReq, nodeRes, path.slice(TUNNEL_ASSET.length));
  }
  const TUNNEL_ASK = "/api/relay/tunnel/ask/";
  if (method === "POST" && path.startsWith(TUNNEL_ASK)) {
    return handleTunnelAskPost(nodeReq, nodeRes, path.slice(TUNNEL_ASK.length));
  }
  const TUNNEL_UPLOAD = "/api/relay/tunnel/upload/";
  if (method === "GET" && path.startsWith(TUNNEL_UPLOAD)) {
    return handleTunnelUploadClaim(nodeReq, nodeRes, path.slice(TUNNEL_UPLOAD.length));
  }
  const RELAY_ASSET = "/api/relay/asset/";
  if (method === "GET" && path.startsWith(RELAY_ASSET)) {
    return handleRelayAssetGet(
      nodeReq,
      nodeRes,
      decodeURIComponent(path.slice(RELAY_ASSET.length)),
    );
  }
  if (method === "POST" && path.startsWith(RELAY_ASSET)) {
    return handleRelayAssetUpload(
      nodeReq,
      nodeRes,
      decodeURIComponent(path.slice(RELAY_ASSET.length)),
    );
  }
  const RELAY_GRANT = "/api/relay/grants/";
  if (method === "DELETE" && path.startsWith(RELAY_GRANT)) {
    const webRes = await relayGrantRevoke(
      toWebRequest(nodeReq),
      decodeURIComponent(path.slice(RELAY_GRANT.length)),
    );
    return sendWebResponse(webRes, nodeRes, CORS_HEADERS);
  }
  const RELAY_SHARE = "/api/relay/share/";
  if (path.startsWith(RELAY_SHARE)) {
    const rest = path.slice(RELAY_SHARE.length);
    const assetIdx = rest.indexOf("/asset/");
    if (method === "GET" && assetIdx > 0) {
      return handleShareAssetGet(
        nodeReq,
        nodeRes,
        rest.slice(0, assetIdx),
        decodeURIComponent(rest.slice(assetIdx + "/asset/".length)),
      );
    }
    if (method === "POST" && !rest.includes("/")) {
      const webRes = await relaySharePublicView(toWebRequest(nodeReq), rest);
      return sendWebResponse(webRes, nodeRes, CORS_HEADERS);
    }
    if (method === "DELETE" && !rest.includes("/")) {
      const webRes = await relayShareDelete(toWebRequest(nodeReq), rest);
      return sendWebResponse(webRes, nodeRes, CORS_HEADERS);
    }
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
