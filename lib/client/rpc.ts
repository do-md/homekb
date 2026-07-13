"use client";

/**
 * Unified RPC transport layer: same method set (see docs/ARCHITECTURE.md "RPC Methods").
 * Routing by connection mode (docs/ARCHITECTURE.md "Client connection model"):
 * - desktop (Tauri webview)  → local homekb serve (127.0.0.1:8765, no auth)
 * - relay                    → <relayUrl>/api/relay/rpc (Bearer clientToken hkt_)
 * - direct                   → <serveUrl>/rpc (Bearer serveToken hkd_)
 * UI is written once; only the base URL and auth method differ (engine-first principle).
 */

import { getConnection, type Connection } from "./connection";
import { isDesktop } from "./desktop";

export const SERVE_BASE = "http://127.0.0.1:8765";

export class RelayError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Endpoint {
  rpcUrl: string;
  healthUrl: string;
  /** URL prefix for binary assets; append the asset path (relative to ~/.homekb/assets/). */
  assetBase: string;
  headers: Record<string, string>;
  /** relay health returns {online}; serve health returns {ok} */
  healthKind: "relay" | "serve";
}

function endpoint(): Endpoint {
  if (isDesktop()) {
    return {
      rpcUrl: `${SERVE_BASE}/rpc`,
      healthUrl: `${SERVE_BASE}/health`,
      assetBase: `${SERVE_BASE}/assets/`,
      headers: {},
      healthKind: "serve",
    };
  }
  const conn = getConnection();
  if (!conn) throw new RelayError("unauthorized", "Not paired");
  return endpointFor(conn);
}

/** Build the endpoint for an explicit connection (used to verify before storing). */
export function endpointFor(conn: Connection): Endpoint {
  if (conn.mode === "relay") {
    return {
      rpcUrl: `${conn.relayUrl}/api/relay/rpc`,
      healthUrl: `${conn.relayUrl}/api/relay/health`,
      assetBase: `${conn.relayUrl}/api/relay/asset/`,
      headers: { Authorization: `Bearer ${conn.token}` },
      healthKind: "relay",
    };
  }
  return {
    rpcUrl: `${conn.baseUrl}/rpc`,
    healthUrl: `${conn.baseUrl}/health`,
    assetBase: `${conn.baseUrl}/assets/`,
    headers: { Authorization: `Bearer ${conn.token}` },
    healthKind: "serve",
  };
}

async function rpcAt<T>(
  ep: Endpoint,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ep.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ep.headers },
      body: JSON.stringify({ method, params }),
    });
  } catch {
    throw new RelayError("unreachable", "Server is not responding");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new RelayError("unauthorized", "Not authorized — please pair again");
  }
  if (!res.ok || !data.ok) {
    const code = data.error ?? `http_${res.status}`;
    const msg =
      code === "home_offline"
        ? "Home computer is not online (run `homekb tunnel` on your computer)"
        : code === "timeout"
          ? "Home computer timed out"
          : (data.message ?? data.detail?.message ?? "Request failed");
    throw new RelayError(code, msg);
  }
  return data.result as T;
}

export async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return rpcAt<T>(endpoint(), method, params);
}

/** RPC against an explicit, not-yet-stored connection (direct-mode verification). */
export async function rpcWith<T = unknown>(
  conn: Connection,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return rpcAt<T>(endpointFor(conn), method, params);
}

export async function checkHealth(): Promise<boolean> {
  const ep = endpoint();
  let res: Response;
  try {
    res = await fetch(ep.healthUrl, { headers: ep.headers });
  } catch {
    return false;
  }
  if (res.status === 401) throw new RelayError("unauthorized", "Pairing has expired");
  if (!res.ok) return false;
  if (ep.healthKind === "relay") {
    const data = await res.json().catch(() => ({}));
    return !!data.online;
  }
  return true;
}

/**
 * Fetch a binary asset (image/attachment) and return an object URL for rendering.
 * Tokens never go into URLs — auth rides in the Authorization header; the browser
 * renders via blob URLs (caller is responsible for URL.revokeObjectURL).
 * Desktop mode needs no auth, so plain `${SERVE_BASE}/assets/<path>` also works in <img> directly.
 */
export async function fetchAssetUrl(path: string): Promise<string> {
  const ep = endpoint();
  let res: Response;
  try {
    res = await fetch(ep.assetBase + path.split("/").map(encodeURIComponent).join("/"), {
      headers: ep.headers,
    });
  } catch {
    throw new RelayError("unreachable", "Server is not responding");
  }
  if (res.status === 401) throw new RelayError("unauthorized", "Not authorized");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new RelayError(data.error ?? `http_${res.status}`, "Asset fetch failed");
  }
  return URL.createObjectURL(await res.blob());
}
