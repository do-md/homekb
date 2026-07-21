"use client";
import { useTranslation } from "react-i18next";
import { useDesktopStore, useDesktopStoreApi } from "../store/desktop-store";

/**
 * In-app "Restart to update" banner (docs "App self-update"). By the time this
 * renders, the new version is already downloaded + installed — restarting just
 * swaps it in. This is the only surface for update readiness: no system
 * dialogs, ever (the HomeKB divergence from DoMD's updater UX).
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const api = useDesktopStoreApi();
  const version = useDesktopStore((s) => s.state.updateReady);
  if (!version) return null;
  return (
    <div
      className="fixed right-4 bottom-8 z-40 flex items-center gap-3 rounded-xl border border-base-200 bg-hk-composer px-4 py-2.5 backdrop-blur-md"
      style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.25)" }}
    >
      <span className="text-[13px] text-base-content">
        {t("desktop.updater.bannerReady", { version })}
      </span>
      <button
        className="rounded-xl bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-content transition-colors hover:bg-primary/90"
        onClick={() => void api.restartToUpdate()}
      >
        {t("desktop.updater.restart")}
      </button>
    </div>
  );
}
