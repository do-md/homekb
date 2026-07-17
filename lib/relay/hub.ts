import { nanoid } from "nanoid";

/**
 * Tunnel Hub: home device SSE connection registry + RPC request/response correlation.
 * globalThis singleton (prevents duplicate initialization under dev HMR).
 *
 * Downstream: home opens GET /api/relay/tunnel (SSE); hub pushes rpc/asset events via send.
 * Upstream: home POSTs /api/relay/tunnel/result (RPC) or /api/relay/tunnel/asset/<id>
 * (binary asset channel); hub resolves the pending promise by requestId.
 */

export interface RpcError {
  code: string;
  message: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: RpcHubError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcHubError extends Error {
  constructor(public code: "home_offline" | "timeout" | "tunnel_closed" | "rpc_error", message: string, public detail?: RpcError) {
    super(message);
  }
}

/**
 * Duck-typing check to replace instanceof.
 * Under dev HMR the globalThis singleton hub holds the old module's class,
 * so instanceof always returns false in the new module — use code-based check instead.
 */
const HUB_ERROR_CODES = new Set(["home_offline", "timeout", "tunnel_closed", "rpc_error"]);
export function asRpcHubError(e: unknown): RpcHubError | null {
  if (e instanceof Error && HUB_ERROR_CODES.has((e as RpcHubError).code)) {
    return e as RpcHubError;
  }
  return null;
}

interface HomeConn {
  homeId: string;
  connectedAt: number;
  send: (event: string, data: string) => void;
  close: () => void;
  pending: Map<string, Pending>;
}

/**
 * What the home device delivered on the asset channel. `stream` is a node Readable
 * (typed loosely so this module has no node type dependency); `done()` lets the
 * consumer ACK the home's upload once fully piped.
 */
export interface AssetDelivery {
  error?: string;
  contentType?: string;
  contentLength?: string;
  stream?: unknown;
  done?: () => void;
}

/** Share context attached to a share-scoped asset request (validated by the home). */
export interface ShareContext {
  shareId: string;
  password?: string;
}

const DEFAULT_TIMEOUT = 30_000;
/** Streaming ask: the home connects back near-instantly, but retrieval + first token can lag. */
const ASK_STREAM_TIMEOUT = 60_000;

export class TunnelHub {
  private conns = new Map<string, HomeConn>();

  register(homeId: string, send: HomeConn["send"], close: HomeConn["close"]): HomeConn {
    const old = this.conns.get(homeId);
    if (old) {
      this.failAll(old, new RpcHubError("tunnel_closed", "tunnel reconnected"));
      try {
        old.close();
      } catch {}
    }
    const conn: HomeConn = { homeId, connectedAt: Date.now(), send, close, pending: new Map() };
    this.conns.set(homeId, conn);
    return conn;
  }

  /** Only evict if the currently registered connection is still this one (prevents a stale abort from killing the new connection). */
  unregister(homeId: string, conn: HomeConn) {
    const cur = this.conns.get(homeId);
    if (cur === conn) {
      this.conns.delete(homeId);
      this.failAll(conn, new RpcHubError("tunnel_closed", "tunnel closed"));
    }
  }

  online(homeId: string): boolean {
    return this.conns.has(homeId);
  }

  call(homeId: string, method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT): Promise<unknown> {
    return this.request(homeId, "rpc", (id) => JSON.stringify({ id, method, params: params ?? {} }), `rpc ${method}`, timeoutMs);
  }

  /**
   * Binary asset channel: push an `asset` event to the home device and wait for it to
   * stream the bytes back via POST /api/relay/tunnel/asset/<id>. The delivery object is
   * produced by that route (hub itself stays transport-agnostic).
   */
  requestAsset(
    homeId: string,
    path: string,
    share?: ShareContext,
    timeoutMs = DEFAULT_TIMEOUT,
  ): Promise<AssetDelivery> {
    return this.request(
      homeId,
      "asset",
      // Share-scoped requests carry the share context; the home validates it
      // (valid share + asset referenced by the shared note) before streaming.
      (id) => JSON.stringify({ id, path, ...(share ? { share } : {}) }),
      `asset ${path}`,
      timeoutMs,
    ) as Promise<AssetDelivery>;
  }

  /**
   * Streaming answer channel (docs/ARCHITECTURE.md): push an `rpc` event flagged
   * `stream:true` and wait for the home to open POST /api/relay/tunnel/ask/<id>. Same
   * correlation + delivery shape as assets — the delivered `stream` is the home's SSE
   * frame body, piped verbatim to the client. The timeout only bounds the home's
   * connect-back (first byte); the stream itself may then run as long as synthesis takes.
   */
  requestAskStream(homeId: string, params: unknown, timeoutMs = ASK_STREAM_TIMEOUT): Promise<AssetDelivery> {
    return this.request(
      homeId,
      "rpc",
      (id) => JSON.stringify({ id, method: "kb.ask", params: params ?? {}, stream: true }),
      "ask-stream",
      timeoutMs,
    ) as Promise<AssetDelivery>;
  }

  private request(
    homeId: string,
    event: string,
    payload: (id: string) => string,
    label: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const conn = this.conns.get(homeId);
    if (!conn) return Promise.reject(new RpcHubError("home_offline", "home device is not connected"));
    const id = nanoid(12);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new RpcHubError("timeout", `${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.send(event, payload(id));
      } catch (e) {
        // send threw = connection is dead (client disconnected but abort not yet fired): evict immediately and report as offline
        clearTimeout(timer);
        conn.pending.delete(id);
        this.unregister(homeId, conn);
        reject(
          new RpcHubError(
            "home_offline",
            `home connection is dead: ${e instanceof Error ? e.message : e}`,
          ),
        );
      }
    });
  }

  /** Returns false when the request is no longer pending (timed out / reconnected) so the caller can NACK. */
  resolveResult(homeId: string, id: string, ok: boolean, result: unknown, error?: RpcError): boolean {
    const conn = this.conns.get(homeId);
    const p = conn?.pending.get(id);
    if (!conn || !p) return false; // late result (already timed out or reconnected) — discard
    conn.pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(result);
    else p.reject(new RpcHubError("rpc_error", error?.message || "home execution failed", error));
    return true;
  }

  private failAll(conn: HomeConn, err: RpcHubError) {
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    conn.pending.clear();
  }
}

export function hub(): TunnelHub {
  const g = globalThis as unknown as { __homekbTunnelHub?: TunnelHub };
  if (!g.__homekbTunnelHub) g.__homekbTunnelHub = new TunnelHub();
  return g.__homekbTunnelHub;
}

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
  "kb.shareCreate",
  "kb.shareGet",
  "kb.shareList",
  "kb.shareRevoke",
]);
