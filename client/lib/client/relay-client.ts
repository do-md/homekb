"use client";

/**
 * Pairing action — establish (and store) a connection: claim an 8-char pairing
 * code at the connection service → clientToken.
 */

import i18n from "../i18n";
import { normalizeBaseUrl, storeConnection, type PairedHome } from "./connection";
import { RelayError } from "./rpc";

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
    throw new RelayError("unreachable", i18n.t("net.serviceUnreachableCheckAddress"));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new RelayError(data.error ?? "claim_failed", i18n.t("net.pairCodeInvalid"));
  }
  const home: PairedHome = { homeId: data.homeId, homeName: data.homeName };
  storeConnection({ mode: "relay", relayUrl: base, token: data.token, home });
  return home;
}
