"use client";

/**
 * Desktop service-list model (docs/ARCHITECTURE.md "Desktop service picker").
 *
 * The home machine picks ONE connection service to register with. Candidates:
 * - built-ins baked at build time (`NEXT_PUBLIC_BUILTIN_SERVICES`, comma-separated
 *   URLs — currently empty until official services ship),
 * - user-added URLs (their own deployment, a shared one, or this machine's own
 *   service — flagged `thisMachine`, which auto-select prefers).
 *
 * The list is desktop UI state (localStorage), NOT engine config: what the engine
 * cares about is only the final `homekb register --relay <url>` result.
 */

import { normalizeBaseUrl } from "./connection";

export interface ServiceEntry {
  url: string;
  /** Baked into this build (not removable). */
  builtin?: boolean;
  /** Runs on this machine (its public HTTPS domain) — auto-select prefers it. */
  thisMachine?: boolean;
}

/** Probe result for one service URL. */
export interface ServiceProbe {
  ok: boolean;
  /** Round-trip latency in ms (reachable entries only). */
  ms: number | null;
}

const SERVICES_KEY = "homekb.services.v1";

/**
 * A service URL a phone can actually reach: public **https** only, **no exceptions**.
 * A phone's HTTPS Web UI can never reach a plain-http or localhost/LAN address
 * (mixed content + unreachable host), so those are never valid — not even in dev.
 * This is also what guards the Connection card against a stale localhost registration.
 */
export function isAllowedServiceUrl(url: string): boolean {
  try {
    return new URL(url.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

/** Official services baked at build time (comma-separated URLs; currently empty). */
export function builtinServices(): ServiceEntry[] {
  const raw = process.env.NEXT_PUBLIC_BUILTIN_SERVICES || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => ({ url: normalizeBaseUrl(url), builtin: true }));
}

export function loadUserServices(): ServiceEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SERVICES_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as ServiceEntry[];
    return Array.isArray(list) ? list.filter((e) => typeof e.url === "string") : [];
  } catch {
    return [];
  }
}

export function persistUserServices(list: ServiceEntry[]): void {
  try {
    window.localStorage.setItem(SERVICES_KEY, JSON.stringify(list));
  } catch {
    // Best-effort only.
  }
}

/** Built-ins first, then user-added; deduped by URL (user flags win). */
export function allServices(userAdded: ServiceEntry[]): ServiceEntry[] {
  const map = new Map<string, ServiceEntry>();
  for (const e of builtinServices()) map.set(e.url, e);
  for (const e of userAdded) map.set(e.url, { ...map.get(e.url), ...e });
  return [...map.values()];
}

/**
 * Reachability + latency probe: `GET <url>/api/relay/ping` (unauthenticated by
 * contract). A service may simply be down — that's a normal state to display.
 */
export async function pingService(url: string, timeoutMs = 4000): Promise<ServiceProbe> {
  const started = Date.now();
  try {
    const res = await fetch(`${normalizeBaseUrl(url)}/api/relay/ping`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { ok: false, ms: null };
    return { ok: true, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: null };
  }
}

/**
 * Auto-select among probed entries: a reachable "this machine" entry wins
 * outright (zero middlemen); otherwise the lowest-latency reachable one.
 * Returns null when nothing is reachable.
 */
export function pickAutoService(
  entries: ServiceEntry[],
  probes: Record<string, ServiceProbe>,
): ServiceEntry | null {
  const reachable = entries.filter((e) => probes[e.url]?.ok);
  if (reachable.length === 0) return null;
  const local = reachable.find((e) => e.thisMachine);
  if (local) return local;
  return reachable.reduce((best, e) =>
    (probes[e.url].ms ?? Infinity) < (probes[best.url].ms ?? Infinity) ? e : best,
  );
}
