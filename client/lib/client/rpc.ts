"use client";

/**
 * Unified RPC transport layer: same method set (see docs/ARCHITECTURE.md "RPC Methods").
 * Routing by connection mode (docs/ARCHITECTURE.md "Client connection model"):
 * - desktop (Tauri webview)  → local homekb serve (127.0.0.1:8765, no auth)
 * - relay                    → <relayUrl>/api/relay/rpc (Bearer clientToken hkt_)
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

/**
 * Transient-401 debounce (docs/ARCHITECTURE.md "Tunnel liveness & deploy
 * safety" §3): a single 401 — e.g. a relay deploy-window auth blip — must not
 * destroy the pairing. Only **two consecutive** 401s across any calls surface
 * as `unauthorized` (which auto-unpairs); the first one surfaces as
 * `unauthorized_transient`, which the store treats like a connectivity blip.
 * Any non-401 *response* resets the streak (network errors don't — they are
 * no evidence either way).
 */
let consecutive401 = 0;

function unauthorized(): RelayError {
  consecutive401 += 1;
  if (consecutive401 >= 2) {
    return new RelayError("unauthorized", "Not authorized — please pair again");
  }
  return new RelayError("unauthorized_transient", "Authorization hiccup — retrying");
}

function resetAuthStreak(): void {
  consecutive401 = 0;
}

interface Endpoint {
  rpcUrl: string;
  /** Streaming RPC (kb.ask only) — the `rpcUrl` sibling; emits delta/done/error SSE frames. */
  streamUrl: string;
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
      streamUrl: `${SERVE_BASE}/rpc/stream`,
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
  return {
    rpcUrl: `${conn.relayUrl}/api/relay/rpc`,
    streamUrl: `${conn.relayUrl}/api/relay/rpc/stream`,
    healthUrl: `${conn.relayUrl}/api/relay/health`,
    assetBase: `${conn.relayUrl}/api/relay/asset/`,
    headers: { Authorization: `Bearer ${conn.token}` },
    healthKind: "relay",
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
    throw unauthorized();
  }
  resetAuthStreak();
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

/** Source metadata of a streaming answer (the `sources` and `done` frames). */
export interface AskStreamResult {
  citations: { path: string; title: string }[];
  hits?: unknown[];
}

/**
 * Terminal outcome of a streaming ask (docs/ARCHITECTURE.md "Auto mode"):
 * either a completed answer (`done` frame) or — with `auto: true` and a router
 * "no answer wanted" decision — the routed note list (`results` frame).
 */
export type AskStreamOutcome =
  | ({ kind: "answer" } & AskStreamResult)
  | {
      kind: "list";
      hits: unknown[];
      route?: { docType?: string; enumerate: boolean };
    };

function parseSseFrame(raw: string): { event: string; data: string } {
  let event = "";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: dataLines.join("\n") };
}

/**
 * Streaming kb.ask (docs/ARCHITECTURE.md "Streaming answer channel"): POSTs to the
 * `/rpc/stream` endpoint and consumes `sources`/`delta`/`done`/`results`/`error` SSE
 * frames. `onSources` fires once right after retrieval (before the first token) with the
 * citation metadata so the UI can render the source list immediately; `onDelta` fires per
 * answer-text chunk; resolves with the terminal outcome — the `done` metadata, or the
 * `results` note list when `auto: true` and the engine's router judged that no synthesized
 * answer is wanted (an engine predating `auto` ignores it and always answers).
 * Any `error` frame — or an early close — rejects with a RelayError.
 */
export async function rpcAskStream(
  query: string,
  opts: {
    onDelta: (text: string) => void;
    onSources?: (sources: AskStreamResult) => void;
    /** First-paint batch (docs "First-paint batch"): unrouted grouped KNN hits,
     *  emitted right after embedding — before the route resolves. Engines that
     *  predate the frame never fire this; the terminal outcome still arrives. */
    onHits?: (hits: unknown[]) => void;
    /** Let the engine decide answer-vs-list (docs "Auto mode"). Off = always answer. */
    auto?: boolean;
    signal?: AbortSignal;
  },
): Promise<AskStreamOutcome> {
  const ep = endpoint();
  let res: Response;
  try {
    res = await fetch(ep.streamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ep.headers },
      body: JSON.stringify({
        method: "kb.ask",
        params: { query, ...(opts.auto ? { auto: true } : {}) },
      }),
      signal: opts.signal,
    });
  } catch {
    throw new RelayError("unreachable", "Server is not responding");
  }
  if (res.status === 401) {
    throw unauthorized();
  }
  resetAuthStreak();
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}) as Record<string, string>);
    const code = data.error ?? `http_${res.status}`;
    const msg =
      code === "home_offline"
        ? "Home computer is not online (run `homekb tunnel` on your computer)"
        : code === "timeout"
          ? "Home computer timed out"
          : (data.message ?? "Request failed");
    throw new RelayError(code, msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done: AskStreamOutcome | null = null;

  const handleFrame = (raw: string) => {
    const { event, data } = parseSseFrame(raw);
    if (!data) return;
    if (event === "delta") {
      const { text } = JSON.parse(data) as { text?: string };
      if (typeof text === "string" && text) opts.onDelta(text);
    } else if (event === "hits") {
      const { hits } = JSON.parse(data) as { hits?: unknown[] };
      opts.onHits?.(hits ?? []);
    } else if (event === "sources") {
      opts.onSources?.(JSON.parse(data) as AskStreamResult);
    } else if (event === "done") {
      done = { kind: "answer", ...(JSON.parse(data) as AskStreamResult) };
    } else if (event === "results") {
      // Auto list short-circuit: one terminal frame, no sources/delta/done.
      const parsed = JSON.parse(data) as {
        hits?: unknown[];
        route?: { docType?: string; enumerate: boolean };
      };
      done = { kind: "list", hits: parsed.hits ?? [], route: parsed.route };
    } else if (event === "error") {
      const { code, message } = JSON.parse(data) as { code?: string; message?: string };
      throw new RelayError(code ?? "ask_failed", message ?? "Answer failed");
    }
  };

  for (;;) {
    const { value, done: rdDone } = await reader.read();
    if (rdDone) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      handleFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handleFrame(buf);

  if (!done) throw new RelayError("stream_incomplete", "Answer stream ended early");
  return done;
}

export async function checkHealth(): Promise<boolean> {
  const ep = endpoint();
  let res: Response;
  try {
    res = await fetch(ep.healthUrl, { headers: ep.headers });
  } catch {
    return false;
  }
  if (res.status === 401) throw unauthorized();
  resetAuthStreak();
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
      // fetch() defaults Accept to */* (unlike <img>), which would opt the
      // image variant service out of webp — advertise it explicitly so the
      // negotiated default variant matches what <img> would get (docs/
      // ARCHITECTURE.md "Image variant service").
      headers: { Accept: "image/webp,image/*;q=0.8,*/*;q=0.5", ...ep.headers },
    });
  } catch {
    throw new RelayError("unreachable", "Server is not responding");
  }
  if (res.status === 401) throw unauthorized();
  resetAuthStreak();
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new RelayError(data.error ?? `http_${res.status}`, "Asset fetch failed");
  }
  return URL.createObjectURL(await res.blob());
}

/**
 * Upload a binary asset (editor image paste/drop) and return the FINAL asset
 * path relative to `~/.homekb/assets/` (the home owns naming — sanitizing +
 * collision suffixes; docs/ARCHITECTURE.md "Binary asset channel", upload
 * direction). `suggestedPath` is `images/<name>` or `attachments/<name>`.
 * Same endpoint shape in every mode: POST `${assetBase}<path>` with the raw
 * bytes (serve `/assets/…` on desktop, `/api/relay/asset/…` through a relay).
 */
export async function uploadAsset(suggestedPath: string, blob: Blob): Promise<string> {
  const ep = endpoint();
  let res: Response;
  try {
    res = await fetch(ep.assetBase + suggestedPath.split("/").map(encodeURIComponent).join("/"), {
      method: "POST",
      headers: {
        ...(blob.type ? { "Content-Type": blob.type } : {}),
        ...ep.headers,
      },
      body: blob,
    });
  } catch {
    throw new RelayError("unreachable", "Server is not responding");
  }
  if (res.status === 401) throw unauthorized();
  resetAuthStreak();
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok || typeof data.path !== "string") {
    const code = data.error ?? `http_${res.status}`;
    const msg =
      code === "home_offline"
        ? "Home computer is not online (run `homekb tunnel` on your computer)"
        : code === "timeout"
          ? "Home computer timed out"
          : (data.message ?? "Image upload failed");
    throw new RelayError(code, msg);
  }
  return data.path as string;
}
