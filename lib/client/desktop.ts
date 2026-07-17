"use client";

/**
 * Desktop mode (Tauri webview) detection and command bridge.
 *
 * Runtime detection via window.__TAURI_INTERNALS__ — no build-time env split needed:
 * the same next dev (port 3000) serves both the browser (Web mode) and the Tauri
 * webview (desktop mode). See docs/ARCHITECTURE.md "Desktop Client".
 */

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Return type of Tauri `engine_status`: engine install/init/serve liveness + config summary. */
export interface EngineStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  bundledVersion: string | null;
  initialized: boolean;
  serveRunning: boolean;
  configPath: string;
  root: string;
  notesDir: string;
  ai: AiStatus;
  relay: { url: string; homeId: string; name: string } | null;
}

/** Config sections of the engine's AI endpoints (docs "AI provider presets"). */
export type AiSection = "embedding" | "summary" | "ask";

/** One AI endpoint as summarized by `engine_status`. */
export interface AiEndpointStatus {
  provider: string;
  model: string;
  keyPresent: boolean;
  /** Whether the section exists in config.toml ([ask]: false = summary fallback). */
  configured: boolean;
}

export interface AiStatus {
  embedding: AiEndpointStatus;
  summary: AiEndpointStatus;
  ask: AiEndpointStatus;
}

/** Return type of Tauri `index_stats`: snapshot counts + the model it was built with. */
export interface IndexStats {
  available: boolean;
  docs: number;
  chunks: number;
  /** Model/provider the *snapshot* was built with (may differ from current config). */
  embeddingModel: string;
  embeddingProvider: string;
}

/** Return type of Tauri `pair_new` (parsed output of `homekb pair --json`). */
export interface PairInfo {
  code: string;
  expiresAt: number; // epoch milliseconds
  relayUrl: string;
  homeName: string;
}

/** Launchd daemon status (tunnel_status / compile_status). */
export interface DaemonStatus {
  running: boolean;
  managed: boolean; // registered with launchd (plist installed)
}

/** Return type of Tauri `local_relay_status` (the this-machine connection service). */
export interface LocalRelayStatus {
  running: boolean;
  installed: boolean; // service script present on this machine
}

/** Return type of Tauri `relay_credentials` (config.toml [relay]). */
export interface RelayCredentials {
  url: string;
  homeSecret: string;
}

/** invoke wrapper: dynamic import so this chunk is never loaded in the Web bundle. */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

// ---------- App self-update (docs/ARCHITECTURE.md "App self-update") ----------
// Lazy plugin loaders: dynamic import keeps these chunks out of the Web bundle
// entirely (same pattern as invoke above; import() caches per module natively).

export async function tauriUpdater() {
  return import("@tauri-apps/plugin-updater");
}

export async function tauriProcess() {
  return import("@tauri-apps/plugin-process");
}

/** Current app (shell) version from the Tauri runtime, for the Settings card. */
export async function appVersion(): Promise<string> {
  const app = await import("@tauri-apps/api/app");
  return app.getVersion();
}

/** Tauri command Err(String) arrives in JS as a bare string; normalise to a readable message. */
export function invokeErrorMessage(e: unknown, fallback: string): string {
  if (typeof e === "string" && e.trim()) return e;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
