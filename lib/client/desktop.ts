"use client";

/**
 * 桌面模式（Tauri webview）检测与命令桥。
 *
 * 运行时检测 window.__TAURI_INTERNALS__ —— 不用构建期 env 区分，
 * 同一个 next dev(23333) 既服务浏览器（Web 模式）又服务 tauri dev 的
 * webview（桌面模式）。见 docs/ARCHITECTURE.md「桌面客户端」。
 */

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Tauri `engine_status` 返回：引擎安装/初始化/serve 探活 + config 概要。 */
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
  openaiKeyPresent: boolean;
  relay: { url: string; homeId: string; name: string } | null;
}

/** Tauri `pair_new` 返回（`homekb pair --json` 的解析结果）。 */
export interface PairInfo {
  code: string;
  expiresAt: number; // epoch 毫秒
  relayUrl: string;
  homeName: string;
}

export interface TunnelStatus {
  running: boolean;
  managed: boolean; // 是否是本 App spawn 的子进程
}

/** invoke 包装：动态 import，Web 包里该 chunk 永不加载。 */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

/** Tauri 命令的 Err(String) 落到 JS 是裸 string；统一转成可读消息。 */
export function invokeErrorMessage(e: unknown, fallback: string): string {
  if (typeof e === "string" && e.trim()) return e;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
