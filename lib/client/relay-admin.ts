"use client";

/**
 * Home-side relay administration (desktop only): the paired-devices list and
 * unpair actions, against the homeSecret-authenticated grants API
 * (docs/ARCHITECTURE.md "Relay HTTP API"). The secret comes from the Tauri
 * `relay_credentials` command and only ever travels to this home's own relay.
 */

import { normalizeBaseUrl } from "./connection";

/** One paired device / MCP grant, as the relay reports it (labels + timestamps only). */
export interface RelayGrant {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

async function relayFetch(
  relayUrl: string,
  homeSecret: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${normalizeBaseUrl(relayUrl)}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${homeSecret}`, ...init?.headers },
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

export async function listGrants(relayUrl: string, homeSecret: string): Promise<RelayGrant[]> {
  const res = await relayFetch(relayUrl, homeSecret, "/api/relay/grants");
  const data = (await res.json()) as { grants?: RelayGrant[] };
  return data.grants ?? [];
}

export async function revokeGrant(
  relayUrl: string,
  homeSecret: string,
  grantId: string,
): Promise<void> {
  await relayFetch(relayUrl, homeSecret, `/api/relay/grants/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
  });
}
