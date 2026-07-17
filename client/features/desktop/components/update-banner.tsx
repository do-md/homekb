"use client";
import { useDesktopStore, useDesktopStoreApi } from "../store/desktop-store";

/**
 * In-app "Restart to update" banner (docs "App self-update"). By the time this
 * renders, the new version is already downloaded + installed — restarting just
 * swaps it in. This is the only surface for update readiness: no system
 * dialogs, ever (the HomeKB divergence from DoMD's updater UX).
 */
export function UpdateBanner() {
  const api = useDesktopStoreApi();
  const version = useDesktopStore((s) => s.state.updateReady);
  if (!version) return null;
  return (
    <div
      className="fixed right-4 bottom-8 z-40 flex items-center gap-3 rounded-2xl border border-hk-hairline bg-hk-composer px-4 py-2.5 backdrop-blur-md"
      style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.25)" }}
    >
      <span className="text-[13px] text-hk-text">
        HomeKB {version} is ready
      </span>
      <button
        className="rounded-xl bg-hk-coral px-3 py-1.5 text-[13px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover"
        onClick={() => void api.restartToUpdate()}
      >
        Restart
      </button>
    </div>
  );
}
