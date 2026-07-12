"use client";

/**
 * 统一 RPC 传输层：同一套方法集（docs/ARCHITECTURE.md「RPC 方法」），
 * 桌面（Tauri webview）→ 本机 homekb serve（127.0.0.1:8765，无认证）；
 * Web → 中继转发（/api/relay/rpc，Bearer clientToken）。
 * UI 只写一份，换 base URL + 认证方式即可（引擎优先原则）。
 */

import {
  checkHealth as relayHealth,
  RelayError,
  rpc as relayRpc,
} from "./relay-client";
import { isDesktop } from "./desktop";

export const SERVE_BASE = "http://127.0.0.1:8765";

export { RelayError };

export async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!isDesktop()) return relayRpc<T>(method, params);

  let res: Response;
  try {
    res = await fetch(`${SERVE_BASE}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
  } catch {
    throw new RelayError("serve_unreachable", "本机引擎未响应（homekb serve）");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new RelayError(
      data.error ?? `http_${res.status}`,
      data.message ?? "请求失败",
    );
  }
  return data.result as T;
}

export async function checkHealth(): Promise<boolean> {
  if (!isDesktop()) return relayHealth();
  try {
    const res = await fetch(`${SERVE_BASE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
