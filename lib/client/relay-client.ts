"use client";

/**
 * Pairing actions — establish (and store) a connection.
 * - Relay mode: claim an 8-char pairing code at the chosen relay → clientToken.
 * - Direct mode: verify a publicly bound serve (URL + serveToken) → store as-is.
 */

import {
  normalizeBaseUrl,
  storeConnection,
  type Connection,
  type PairedHome,
} from "./connection";
import { RelayError, rpcWith } from "./rpc";

/** Claim a pairing code at a relay; on success the relay connection is stored. */
export async function claimPairCode(
  relayUrl: string,
  code: string,
  label: string,
): Promise<PairedHome> {
  const base = normalizeBaseUrl(relayUrl);
  let res: Response;
  try {
    res = await fetch(`${base}/api/relay/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "claim", code, label }),
    });
  } catch {
    throw new RelayError("unreachable", "Relay is not reachable — check the relay URL");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new RelayError(data.error ?? "claim_failed", "Pairing code is invalid or has expired");
  }
  const home: PairedHome = { homeId: data.homeId, homeName: data.homeName };
  storeConnection({ mode: "relay", relayUrl: base, token: data.token, home });
  return home;
}

/** Verify a direct connection (health + a cheap authenticated RPC), then store it. */
export async function connectDirect(baseUrl: string, token: string): Promise<void> {
  const conn: Connection = {
    mode: "direct",
    baseUrl: normalizeBaseUrl(baseUrl),
    token: token.trim(),
  };
  let health: Response;
  try {
    health = await fetch(`${conn.baseUrl}/health`);
  } catch {
    throw new RelayError("unreachable", "Server is not reachable — check the URL");
  }
  if (!health.ok) throw new RelayError("unreachable", "Server is not healthy");
  // A real RPC exercises authentication (health is deliberately open).
  await rpcWith(conn, "kb.status", {});
  storeConnection(conn);
}
