"use client";
import { Spinner } from "@/features/kb/components/icons";
import { useDesktopStore, useDesktopStoreApi } from "../store/desktop-store";

const PHASE_TEXT: Record<string, string> = {
  checking: "Detecting local engine…",
  installing: "First run: downloading the HomeKB engine (a few MB) …",
  starting: "Starting local service (homekb serve)…",
};

/** Desktop startup screen: detect/install engine then launch serve. No system dialogs. */
export function BootScreen() {
  const api = useDesktopStoreApi();
  const phase = useDesktopStore((s) => s.state.phase);
  const bootError = useDesktopStore((s) => s.state.bootError);

  return (
    <main className="fixed inset-0 flex items-center justify-center overflow-hidden px-8">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="text-2xl font-bold tracking-tight text-base-content">HomeKB</div>
        {phase === "error" ? (
          <>
            <div className="rounded-xl border border-base-300 bg-base-200 px-4 py-3 text-[13.5px] text-hk-orange-text">
              {bootError}
            </div>
            <button
              className="rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90"
              onClick={() => void api.bootstrap()}
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <span className="text-primary">
              <Spinner size={20} />
            </span>
            <p className="text-[13.5px] text-base-content/60">{PHASE_TEXT[phase] ?? "Starting…"}</p>
          </>
        )}
      </div>
    </main>
  );
}
