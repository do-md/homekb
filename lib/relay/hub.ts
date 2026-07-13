import { nanoid } from "nanoid";

/**
 * Tunnel Hub: home device SSE connection registry + RPC request/response correlation.
 * globalThis singleton (prevents duplicate initialization under dev HMR).
 *
 * Downstream: home opens GET /api/relay/tunnel (SSE); hub pushes rpc events via send.
 * Upstream: home POSTs /api/relay/tunnel/result; hub resolves the pending promise by requestId.
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

const DEFAULT_TIMEOUT = 30_000;

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
    const conn = this.conns.get(homeId);
    if (!conn) return Promise.reject(new RpcHubError("home_offline", "home device is not connected"));
    const id = nanoid(12);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new RpcHubError("timeout", `rpc ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.send("rpc", JSON.stringify({ id, method, params: params ?? {} }));
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

  resolveResult(homeId: string, id: string, ok: boolean, result: unknown, error?: RpcError) {
    const conn = this.conns.get(homeId);
    const p = conn?.pending.get(id);
    if (!conn || !p) return; // late result (already timed out or reconnected) — silently discard
    conn.pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(result);
    else p.reject(new RpcHubError("rpc_error", error?.message || "home execution failed", error));
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
  "kb.list",
  "kb.status",
  "kb.listTypes",
  "kb.suggestions",
  "kb.reindex",
]);
