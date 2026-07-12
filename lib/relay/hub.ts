import { nanoid } from "nanoid";

/**
 * 隧道 Hub：家设备 SSE 连接注册表 + RPC 请求/响应关联。
 * globalThis 单例（防 dev HMR 重复初始化）。
 *
 * 下行：home 打开 GET /api/relay/tunnel（SSE），hub 通过 send 推 rpc 事件。
 * 上行：home POST /api/relay/tunnel/result，hub 按 requestId 兑现 pending promise。
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
 * 鸭子类型判定，代替 instanceof。
 * dev HMR 下 globalThis 单例 hub 持有旧模块的类，新模块 instanceof 永远 false —— 按 code 判。
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

  /** 只在当前登记的连接还是这一条时才摘除（防新连接被旧连接的 abort 误杀） */
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
        // send 抛错 = 连接已死（客户端断开但 abort 尚未触发）：当场摘除，按离线报告
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
    if (!conn || !p) return; // 迟到的结果（已超时/已重连），静默丢弃
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

/** 隧道协议允许的 RPC 方法白名单 */
export const RPC_METHODS = new Set([
  "kb.query",
  "kb.ask",
  "kb.read",
  "kb.write",
  "kb.create",
  "kb.list",
  "kb.status",
  "kb.listTypes",
  "kb.reindex",
]);
