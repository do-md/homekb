"use client";

/**
 * Client connection model (docs/ARCHITECTURE.md "Client connection model").
 *
 * Three modes:
 * - desktop: Tauri webview → local serve, auto-detected, never persisted here.
 * - relay:   through a relay service (default, lowest barrier; official instance or self-hosted).
 * - direct:  straight to a publicly bound `homekb serve` (user has a public IP/domain).
 *
 * The whole connection object lives in localStorage — the Web UI is a pure static
 * frontend (Vercel); which backend it talks to is entirely client-side state.
 */

export interface PairedHome {
  homeId: string;
  homeName: string;
}

export type Connection =
  | { mode: "relay"; relayUrl: string; token: string; home: PairedHome }
  | { mode: "direct"; baseUrl: string; token: string };

const CONN_KEY = "homekb.connection.v1";

/** Official relay by default; dev fallback is the local standalone relay. */
export function defaultRelayUrl(): string {
  return process.env.NEXT_PUBLIC_RELAY_URL || "http://localhost:8787";
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
    if (conn.mode !== "relay" && conn.mode !== "direct") return null;
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

/**
 * Parse a pairing-link payload (docs/ARCHITECTURE.md "Pairing link (QR payload)"):
 * `<webBase>/?relay=<relayUrl>&code=<pairingCode>`. Used both by the landing-page
 * auto-claim and by the camera QR scanner (8b) — any web origin is accepted, the
 * relay URL + single-use code are what matter. Returns null for anything else.
 */
export function parsePairingLink(text: string): { relayUrl: string; code: string } | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const relay = url.searchParams.get("relay");
  const code = url.searchParams.get("code");
  if (!relay || !code) return null;
  try {
    new URL(relay); // relay must itself be a URL
  } catch {
    return null;
  }
  return { relayUrl: normalizeBaseUrl(relay), code: code.toUpperCase() };
}

/** Human-readable label for the connected target (header/status display). */
export function connectionLabel(conn: Connection): string {
  if (conn.mode === "relay") return conn.home.homeName || "Home";
  try {
    return new URL(conn.baseUrl).host;
  } catch {
    return conn.baseUrl;
  }
}
