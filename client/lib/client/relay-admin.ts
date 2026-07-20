"use client";

/**
 * Relay administration: pairing-code minting, the paired-devices list and
 * unpair actions (docs/ARCHITECTURE.md "Relay HTTP API" + "Paired-device
 * equivalence"). The endpoints accept homeSecret **or** clientToken — the
 * desktop calls them with the homeSecret from the Tauri `relay_credentials`
 * command, the web with its own connection token; either bearer only ever
 * travels to the home's own relay.
 */

import { normalizeBaseUrl } from "./connection";

/** One paired device / MCP grant, as the relay reports it (labels + timestamps only). */
export interface RelayGrant {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** True on the caller's own grant when clientToken-authed ("this device"). */
  self?: boolean;
}

async function relayFetch(
  relayUrl: string,
  bearer: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${normalizeBaseUrl(relayUrl)}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${bearer}`, ...init?.headers },
    });
  } catch {
    throw new Error("Relay is not reachable");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(data.error ?? `Relay request failed (${res.status})`);
  }
  return res;
}

export async function listGrants(relayUrl: string, bearer: string): Promise<RelayGrant[]> {
  const res = await relayFetch(relayUrl, bearer, "/api/relay/grants");
  const data = (await res.json()) as { grants?: RelayGrant[] };
  return data.grants ?? [];
}

export async function revokeGrant(
  relayUrl: string,
  bearer: string,
  grantId: string,
): Promise<void> {
  await relayFetch(relayUrl, bearer, `/api/relay/grants/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
  });
}

/**
 * Mint a pairing code for the caller's home (`{action:"new"}`) — any paired
 * device can invite another (docs "Paired-device equivalence").
 */
export async function mintPairCode(
  relayUrl: string,
  bearer: string,
): Promise<{ code: string; expiresAt: number }> {
  const res = await relayFetch(relayUrl, bearer, "/api/relay/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "new" }),
  });
  const data = (await res.json()) as { code?: string; expiresAt?: number };
  if (!data.code || !data.expiresAt) throw new Error("Malformed relay response");
  return { code: data.code, expiresAt: data.expiresAt };
}
