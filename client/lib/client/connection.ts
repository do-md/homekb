"use client";

/**
 * Client connection model (docs/ARCHITECTURE.md "Client connection model").
 *
 * Two modes:
 * - desktop: Tauri webview → local serve, auto-detected, never persisted here.
 * - relay:   the only remote mode — through a connection service (official hosted,
 *   self-hosted on a server, or self-hosted on the home machine itself). The UI
 *   never says "relay"; users just scan a QR or enter a pairing code.
 *
 * The whole connection object lives in localStorage — the Web UI is a pure static
 * frontend (Vercel); which backend it talks to is entirely client-side state.
 */

import i18n from "../i18n";

export interface PairedHome {
  homeId: string;
  homeName: string;
}

export interface Connection {
  mode: "relay";
  relayUrl: string;
  token: string;
  home: PairedHome;
}

const CONN_KEY = "homekb.connection.v1";

/**
 * Official connection service. `NEXT_PUBLIC_RELAY_URL` overrides it (e.g. a
 * self-hosted deployment); otherwise the official hosted relay is baked in so
 * the pairing screen's Service address comes prefilled and a fresh client only
 * needs to type the pairing code. This is a public HTTPS endpoint a phone can
 * actually reach — the old "empty, never localhost" guard existed only because
 * no official instance was deployed yet.
 */
export const DEFAULT_RELAY_URL = "https://homekb-relay.wangjintaoapp.workers.dev";

export function defaultRelayUrl(): string {
  return process.env.NEXT_PUBLIC_RELAY_URL || DEFAULT_RELAY_URL;
}

/** Strip a trailing slash so URL concatenation stays predictable. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function getConnection(): Connection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CONN_KEY);
    if (!raw) return null;
    const conn = JSON.parse(raw) as Connection;
    if (conn.mode !== "relay") return null;
    return conn;
  } catch {
    return null;
  }
}

export function storeConnection(conn: Connection): void {
  window.localStorage.setItem(CONN_KEY, JSON.stringify(conn));
}

export function clearConnection(): void {
  window.localStorage.removeItem(CONN_KEY);
}

/** A decoded pairing link (docs/ARCHITECTURE.md "Pairing link (QR payload)"). */
export interface PairingLink {
  relayUrl: string;
  code: string;
}

/**
 * Parse a pairing-link payload (docs/ARCHITECTURE.md "Pairing link (QR payload)"):
 * `<webBase>/?relay=<serviceUrl>&code=<code>`. Used both by the landing-page
 * auto-claim and by the camera QR scanner (8b) — any web origin is accepted, the
 * service URL + single-use code are what matter (a long-lived token never rides
 * in a link). Returns null for anything else.
 */
export function parsePairingLink(text: string): PairingLink | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const code = url.searchParams.get("code");
  const relay = url.searchParams.get("relay");
  if (!code || !relay) return null;
  try {
    new URL(relay); // the service URL must itself be a URL
  } catch {
    return null;
  }
  return { relayUrl: normalizeBaseUrl(relay), code: code.toUpperCase() };
}

/** Human-readable label for the connected target (header/status display). */
export function connectionLabel(conn: Connection): string {
  return conn.home.homeName || i18n.t("kb.homeFallback");
}
