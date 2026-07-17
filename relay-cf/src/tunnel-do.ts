import { randomId } from "./util";

/**
 * HomeTunnelDO — one Durable Object per home (idFromName(home_id)); the Workers
 * equivalent of the Node target's in-process TunnelHub (lib/relay/hub.ts) plus the
 * native streaming handlers in relay/src/server.ts.
 *
 * The DO holds: the home's open SSE downstream, the pending-request correlation map,
 * and the body-piped asset/ask channels. It touches no database — auth happens in the
 * Worker before anything is forwarded here. While the SSE stream is open the DO stays
 * pinned in memory; if the home is disconnected the DO idles out and pending state is
 * moot (the engine reconnects with jittered backoff and requests time out client-side).
 *
 * Internal protocol (Worker → DO), never exposed publicly:
 *   GET  /tunnel                 headers x-home-id/x-home-name → SSE downstream
 *   POST /rpc                    {method, params} → {ok,result} | 555 {code,message,detail}
 *   POST /asset-request          {path} → 200 stream | 555 hub error | 556 {error}
 *   POST /ask-request            {params} → 200 SSE stream | 555 | 556
 *   POST /result                 {id, ok, result?, error?} → 204 (late results discarded)
 *   POST /upstream/<id>          home's asset/ask body → piped into the pending client stream → 204 | 409
 *   GET  /online                 → {online}
 */

const PING_INTERVAL_MS = 25_000;
const DEFAULT_TIMEOUT = 30_000;
/** Streaming ask: the home connects back near-instantly, but retrieval + first token can lag. */
const ASK_STREAM_TIMEOUT = 60_000;

export interface RpcError {
  code: string;
  message: string;
}

type HubCode = "home_offline" | "timeout" | "tunnel_closed" | "rpc_error";

class HubError extends Error {
  constructor(
    public code: HubCode,
    message: string,
    public detail?: RpcError,
  ) {
    super(message);
  }
}

/** What the home delivered on an upstream channel (asset or ask stream). */
interface Delivery {
  error?: string;
  contentType?: string;
  contentLength?: string;
  readable?: ReadableStream<Uint8Array>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: HubError) => void;
  timer: number;
}

interface Conn {
  /** Random id minted at registration; sent in `hello`, reported by /online —
   *  the engine's out-of-band liveness verification compares against it
   *  (docs/ARCHITECTURE.md "Tunnel liveness & deploy safety"). */
  id: string;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  pending: Map<string, Pending>;
  pingTimer: number;
}

/** Internal statuses for the Worker↔DO wrapper protocol (never sent to clients). */
export const DO_STATUS_HUB_ERROR = 555;
export const DO_STATUS_DELIVERY_ERROR = 556;

const enc = new TextEncoder();

export class HomeTunnelDO {
  private conn: Conn | null = null;

  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/tunnel") return this.handleTunnel(request);
    if (request.method === "POST" && path === "/rpc") return this.handleRpc(request);
    if (request.method === "POST" && path === "/asset-request") return this.handleAssetRequest(request);
    if (request.method === "POST" && path === "/ask-request") return this.handleAskRequest(request);
    if (request.method === "POST" && path === "/result") return this.handleResult(request);
    if (request.method === "POST" && path.startsWith("/upstream/")) {
      return this.handleUpstream(request, path.slice("/upstream/".length));
    }
    if (request.method === "GET" && path === "/online") {
      // connId lets the home verify ITS connection is the registered one
      // (a zombie stream on a draining old instance has a different / no id here).
      return Response.json({ online: this.conn !== null, connId: this.conn?.id ?? null });
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // ---- downstream (home SSE) ----

  private handleTunnel(request: Request): Response {
    const homeId = request.headers.get("x-home-id") ?? "";
    const name = request.headers.get("x-home-name") ?? "";

    // Reconnect replaces the old connection (same semantics as TunnelHub.register).
    if (this.conn) this.dropConn(this.conn, new HubError("tunnel_closed", "tunnel reconnected"));

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const conn: Conn = { id: randomId(12), writer, pending: new Map(), pingTimer: 0 };
    this.conn = conn;

    // Ping keeps intermediaries from idling the stream out AND detects a dead home:
    // a write to a canceled stream rejects, which drops the connection (Node parity).
    conn.pingTimer = setInterval(() => {
      this.send(conn, "ping", String(Date.now())).catch(() => {
        this.dropConn(conn, new HubError("tunnel_closed", "tunnel closed"));
      });
    }, PING_INTERVAL_MS) as unknown as number;

    // Client disconnect propagates as stream cancellation; also honor the abort signal.
    request.signal?.addEventListener?.("abort", () => {
      this.dropConn(conn, new HubError("tunnel_closed", "tunnel closed"));
    });

    this.send(conn, "hello", JSON.stringify({ homeId, name, connId: conn.id })).catch(() => {});

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  private async send(conn: Conn, event: string, data: string): Promise<void> {
    if (this.conn !== conn) throw new Error("stream closed");
    await conn.writer.write(enc.encode(`event: ${event}\ndata: ${data}\n\n`));
  }

  /** Only evict if the currently registered connection is still this one. */
  private dropConn(conn: Conn, err: HubError): void {
    clearInterval(conn.pingTimer);
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    conn.pending.clear();
    conn.writer.abort().catch(() => {});
    if (this.conn === conn) this.conn = null;
  }

  // ---- request/response correlation (TunnelHub.request parity) ----

  private request(
    event: string,
    payload: (id: string) => string,
    label: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const conn = this.conn;
    if (!conn) return Promise.reject(new HubError("home_offline", "home device is not connected"));
    const id = randomId(12);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new HubError("timeout", `${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs) as unknown as number;
      conn.pending.set(id, { resolve, reject, timer });
      this.send(conn, event, payload(id)).catch((e) => {
        // send failed = connection is dead: evict immediately and report as offline
        clearTimeout(timer);
        conn.pending.delete(id);
        this.dropConn(conn, new HubError("tunnel_closed", "tunnel closed"));
        reject(
          new HubError("home_offline", `home connection is dead: ${e instanceof Error ? e.message : e}`),
        );
      });
    });
  }

  private hubErrorResponse(e: unknown): Response {
    const err =
      e instanceof HubError ? e : new HubError("rpc_error", e instanceof Error ? e.message : String(e));
    return Response.json(
      { code: err.code, message: err.message, detail: err.detail ?? null },
      { status: DO_STATUS_HUB_ERROR },
    );
  }

  // ---- plain RPC ----

  private async handleRpc(request: Request): Promise<Response> {
    const body = (await request.json()) as { method?: string; params?: unknown; timeoutMs?: number };
    try {
      const result = await this.request(
        "rpc",
        (id) => JSON.stringify({ id, method: body.method, params: body.params ?? {} }),
        `rpc ${body.method}`,
        body.timeoutMs ?? DEFAULT_TIMEOUT,
      );
      return Response.json({ ok: true, result });
    } catch (e) {
      return this.hubErrorResponse(e);
    }
  }

  private async handleResult(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      id?: string;
      ok?: boolean;
      result?: unknown;
      error?: RpcError;
    };
    const conn = this.conn;
    const p = conn && typeof body.id === "string" ? conn.pending.get(body.id) : undefined;
    if (!conn || !p) return new Response(null, { status: 204 }); // late result — discard
    conn.pending.delete(body.id as string);
    clearTimeout(p.timer);
    if (body.ok) p.resolve(body.result);
    else p.reject(new HubError("rpc_error", body.error?.message || "home execution failed", body.error));
    return new Response(null, { status: 204 });
  }

  // ---- body-piped channels (asset + streaming ask) ----

  private async handleAssetRequest(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      path?: string;
      share?: { shareId: string; password?: string };
    };
    try {
      const d = (await this.request(
        "asset",
        // Share-scoped requests carry the share context; the home validates it
        // (valid share + asset referenced by the shared note) before streaming.
        (id) => JSON.stringify({ id, path: body.path, ...(body.share ? { share: body.share } : {}) }),
        `asset ${body.path}`,
        DEFAULT_TIMEOUT,
      )) as Delivery;
      return this.deliveryResponse(d);
    } catch (e) {
      return this.hubErrorResponse(e);
    }
  }

  private async handleAskRequest(request: Request): Promise<Response> {
    const body = (await request.json()) as { params?: unknown };
    try {
      const d = (await this.request(
        "rpc",
        (id) => JSON.stringify({ id, method: "kb.ask", params: body.params ?? {}, stream: true }),
        "ask-stream",
        ASK_STREAM_TIMEOUT,
      )) as Delivery;
      return this.deliveryResponse(d);
    } catch (e) {
      return this.hubErrorResponse(e);
    }
  }

  private deliveryResponse(d: Delivery): Response {
    if (d.error) {
      return Response.json({ error: d.error }, { status: DO_STATUS_DELIVERY_ERROR });
    }
    const headers = new Headers();
    if (d.contentType) headers.set("Content-Type", d.contentType);
    if (d.contentLength) headers.set("Content-Length", d.contentLength);
    return new Response(d.readable ?? null, { status: 200, headers });
  }

  /**
   * Home's upstream POST for an asset/ask channel: resolve the pending client request
   * with a stream, pipe the body through, and ACK 204 only once fully piped
   * (server.ts handleTunnelAssetPost/handleTunnelAskPost parity).
   */
  private async handleUpstream(request: Request, id: string): Promise<Response> {
    const conn = this.conn;
    const p = conn?.pending.get(id);
    if (!conn || !p) {
      // No pending request (timed out or duplicate) — drain and NACK so the home can log it.
      await request.body?.cancel().catch(() => {});
      return Response.json({ ok: false, error: "no_pending" }, { status: 409 });
    }
    conn.pending.delete(id);
    clearTimeout(p.timer);

    const errorCode = request.headers.get("x-asset-error");
    if (errorCode) {
      await request.body?.cancel().catch(() => {});
      p.resolve({ error: errorCode } satisfies Delivery);
      return new Response(null, { status: 204 });
    }

    if (!request.body) {
      p.resolve({ readable: new ReadableStream<Uint8Array>({ start: (c) => c.close() }) });
      return new Response(null, { status: 204 });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    p.resolve({
      contentType: request.headers.get("content-type") ?? undefined,
      contentLength: request.headers.get("content-length") ?? undefined,
      readable,
    } satisfies Delivery);
    try {
      // Completes when the client has fully consumed the stream (backpressure-aware);
      // rejects if the client goes away mid-transfer — either way, ACK the home.
      await request.body.pipeTo(writable);
    } catch {
      await writable.abort().catch(() => {});
    }
    return new Response(null, { status: 204 });
  }
}
