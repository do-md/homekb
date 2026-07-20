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
  /** Random id minted at registration; sent in `hello`, reported by connInfo —
   *  the engine's out-of-band liveness verification compares against it
   *  (docs/ARCHITECTURE.md "Tunnel liveness & deploy safety"). */
  connId: string;
  connectedAt: number;
  send: (event: string, data: string) => void;
  close: () => void;
  pending: Map<string, Pending>;
  /** Client upload bodies waiting for the home to claim them (upload direction
   *  of the binary asset channel); keyed by the same request id as `pending`. */
  uploads: Map<string, UploadSource>;
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

/**
 * A client's pending upload body (upload direction of the binary asset
 * channel): the home claims it with GET /api/relay/tunnel/upload/<id> and the
 * relay pipes `stream` into that response. `stream` is a node Readable, typed
 * loosely so this module keeps zero node type dependencies.
 */
export interface UploadSource {
  contentType?: string;
  contentLength?: string;
  stream: unknown;
}

const DEFAULT_TIMEOUT = 30_000;
/** Streaming ask: the home connects back near-instantly, but retrieval + first token can lag. */
const ASK_STREAM_TIMEOUT = 60_000;
/** Uploads move client → home and can be several MB on a slow uplink: claim + write + result. */
const UPLOAD_TIMEOUT = 120_000;

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
    const conn: HomeConn = {
      homeId,
      connId: nanoid(12),
      connectedAt: Date.now(),
      send,
      close,
      pending: new Map(),
      uploads: new Map(),
    };
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

  /** The current hub's view of a home's tunnel (home-side liveness verification). */
  connInfo(homeId: string): { online: boolean; connId: string | null } {
    const conn = this.conns.get(homeId);
    return { online: !!conn, connId: conn?.connId ?? null };
  }

  call(homeId: string, method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT): Promise<unknown> {
    return this.request(homeId, "rpc", (id) => JSON.stringify({ id, method, params: params ?? {} }), `rpc ${method}`, timeoutMs);
  }

  /**
   * Binary asset channel: push an `asset` event to the home device and wait for it to
   * stream the bytes back via POST /api/relay/tunnel/asset/<id>. The delivery object is
   * produced by that route (hub itself stays transport-agnostic).
   *
   * `query`/`accept` forward the client's image-variant request (query string +
   * Accept header — docs/ARCHITECTURE.md "Image variant service"); older engines
   * ignore both fields.
   */
  requestAsset(
    homeId: string,
    path: string,
    opts: { share?: ShareContext; query?: string; accept?: string; timeoutMs?: number } = {},
  ): Promise<AssetDelivery> {
    const { share, query, accept } = opts;
    return this.request(
      homeId,
      "asset",
      // Share-scoped requests carry the share context; the home validates it
      // (valid share + asset referenced by the shared note) before streaming.
      (id) =>
        JSON.stringify({
          id,
          path,
          ...(query ? { query } : {}),
          ...(accept ? { accept } : {}),
          ...(share ? { share } : {}),
        }),
      `asset ${path}`,
      opts.timeoutMs ?? DEFAULT_TIMEOUT,
    ) as Promise<AssetDelivery>;
  }

  /**
   * Binary asset channel, upload direction (docs/ARCHITECTURE.md): stash the
   * client's body as an UploadSource, push an `assetUpload` event, and wait
   * for the home to (1) claim the body via GET /api/relay/tunnel/upload/<id>
   * and (2) report the final path via POST /api/relay/tunnel/result with the
   * same id. Resolves with the home's result (`{path}`); the upload source is
   * cleaned up however the request settles (result / timeout / tunnel close).
   */
  requestAssetUpload(
    homeId: string,
    path: string,
    source: UploadSource,
    opts: { timeoutMs?: number; onId?: (id: string) => void } = {},
  ): Promise<unknown> {
    const conn = this.conns.get(homeId);
    if (!conn) return Promise.reject(new RpcHubError("home_offline", "home device is not connected"));
    let requestId = "";
    const result = this.request(
      homeId,
      "assetUpload",
      (id) => {
        requestId = id;
        opts.onId?.(id);
        conn.uploads.set(id, source);
        return JSON.stringify({
          id,
          path,
          ...(source.contentType ? { contentType: source.contentType } : {}),
        });
      },
      `asset upload ${path}`,
      opts.timeoutMs ?? UPLOAD_TIMEOUT,
    );
    return result.finally(() => {
      if (requestId) conn.uploads.delete(requestId);
    });
  }

  /** One-shot claim of a pending upload body (home side). */
  claimUpload(homeId: string, id: string): UploadSource | null {
    const conn = this.conns.get(homeId);
    const source = conn?.uploads.get(id);
    if (!conn || !source) return null;
    conn.uploads.delete(id);
    return source;
  }

  /** Client gave up on an upload (disconnect): drop the body and fail the pending request. */
  cancelUpload(homeId: string, id: string) {
    const conn = this.conns.get(homeId);
    if (!conn) return;
    conn.uploads.delete(id);
    const p = conn.pending.get(id);
    if (p) {
      conn.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new RpcHubError("tunnel_closed", "client aborted the upload"));
    }
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
    conn.uploads.clear();
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
  "kb.configGet",
  "kb.configSetAi",
  "kb.shareCreate",
  "kb.shareGet",
  "kb.shareList",
  "kb.shareRevoke",
]);
