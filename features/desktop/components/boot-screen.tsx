"use client";
import { useDesktopStore, useDesktopStoreApi } from "../store/desktop-store";

const PHASE_TEXT: Record<string, string> = {
  checking: "正在检测本机引擎…",
  installing: "首次使用：正在安装引擎到 ~/.local/bin …",
  starting: "正在启动本机服务（homekb serve）…",
};

/** 桌面首启引导屏：检测/安装引擎 → 拉起 serve。全程无系统弹框。 */
export function BootScreen() {
  const api = useDesktopStoreApi();
  const phase = useDesktopStore((s) => s.state.phase);
  const bootError = useDesktopStore((s) => s.state.bootError);

  return (
    <main className="flex min-h-dvh items-center justify-center px-8">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="text-2xl font-bold">HomeKB</div>
        {phase === "error" ? (
          <>
            <div className="alert alert-error text-sm">{bootError}</div>
            <button className="btn btn-sm" onClick={() => void api.bootstrap()}>
              重试
            </button>
          </>
        ) : (
          <>
            <span className="loading loading-spinner" />
            <p className="text-sm opacity-60">{PHASE_TEXT[phase] ?? "启动中…"}</p>
          </>
        )}
      </div>
    </main>
  );
}
