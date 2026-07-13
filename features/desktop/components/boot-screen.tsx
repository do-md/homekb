"use client";
import { useDesktopStore, useDesktopStoreApi } from "../store/desktop-store";

const PHASE_TEXT: Record<string, string> = {
  checking: "Detecting local engine…",
  installing: "First run: installing engine to ~/.local/bin …",
  starting: "Starting local service (homekb serve)…",
};

/** Desktop startup screen: detect/install engine then launch serve. No system dialogs. */
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
              Retry
            </button>
          </>
        ) : (
          <>
            <span className="loading loading-spinner" />
            <p className="text-sm opacity-60">{PHASE_TEXT[phase] ?? "Starting…"}</p>
          </>
        )}
      </div>
    </main>
  );
}
