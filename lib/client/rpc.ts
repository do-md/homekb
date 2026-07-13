"use client";

/**
 * Unified RPC transport layer: same method set (see docs/ARCHITECTURE.md "RPC Methods").
 * Desktop (Tauri webview) → local homekb serve (127.0.0.1:8765, no auth).
 * Web → relay forward (/api/relay/rpc, Bearer clientToken).
 * UI is written once; only the base URL and auth method differ (engine-first principle).
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
    throw new RelayError("serve_unreachable", "Local engine is not responding (homekb serve)");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new RelayError(
      data.error ?? `http_${res.status}`,
      data.message ?? "Request failed",
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
