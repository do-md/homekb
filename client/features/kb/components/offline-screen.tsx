"use client";

/**
 * Offline action screen (design 4b): offline is not just a color change — it
 * escalates to an explanation + a "How to wake it up" checklist + a primary Retry.
 * Note: the retry/primary action is primary, never green; offline accent is orange.
 */

import { useState } from "react";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { useKbStore, useKbStoreApi } from "../store/kb-store";
import { Spinner, StatusDot } from "./icons";

function agoLabel(t: TFunction, ts: number | null): string | null {
  if (!ts) return null;
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return t("offline.time.justNow");
  if (mins < 60) return t("offline.time.minutesAgo", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("offline.time.hoursAgo", { count: hours });
  return t("offline.time.daysAgo", { count: Math.round(hours / 24) });
}

/** Deeper checklist behind the "Connection help" link (design 4b). */
function ConnectionHelp() {
  const { t } = useTranslation();
  return (
    <div className="mt-4 w-full rounded-xl border border-base-300 bg-base-200 p-4 text-left">
      <div className="hk-label">{t("offline.help.title")}</div>
      <ul className="mt-3 flex flex-col gap-2.5 text-[13px] leading-relaxed text-base-content/60">
        <li>
          <Trans
            i18nKey="offline.help.checkTunnel"
            components={{
              code: <code className="font-mono text-[12px]" />,
              strong: <span className="font-medium" />,
            }}
          />
        </li>
        <li>{t("offline.help.reconnects")}</li>
        <li>{t("offline.help.repair")}</li>
      </ul>
    </div>
  );
}

export function OfflineScreen() {
  const { t } = useTranslation();
  const api = useKbStoreApi();
  const connState = useKbStore((s) => s.connState);
  const lastConnectedAt = useKbStore((s) => s.state.lastConnectedAt);
  const [helpOpen, setHelpOpen] = useState(false);
  const retrying = connState === "connecting";
  const ago = agoLabel(t, lastConnectedAt);
  const wakeSteps = [
    t("offline.steps.wake"),
    t("offline.steps.running"),
    t("offline.steps.retry"),
  ];

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full border border-base-300 bg-base-200 text-hk-orange">
        <StatusDot className="h-3.5! w-3.5!" />
      </span>
      <h1 className="mt-5 text-[22px] font-bold tracking-tight text-base-content">
        {t("offline.title")}
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-base-content/60">
        {t("offline.subtitle")}
      </p>

      <div className="mt-6 w-full rounded-xl border border-base-300 bg-base-200 p-4 text-left">
        <div className="hk-label">{t("offline.steps.title")}</div>
        <ol className="mt-3 flex flex-col gap-2.5">
          {wakeSteps.map((step, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {i + 1}
              </span>
              <span className="text-[13.5px] leading-relaxed text-base-content/60">{step}</span>
            </li>
          ))}
        </ol>
      </div>

      <button
        onClick={() => api.retryConnection()}
        disabled={retrying}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-[15px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-60"
      >
        {retrying && <Spinner size={15} />}
        {retrying ? t("offline.retrying") : t("offline.retryConnection")}
      </button>

      <button
        onClick={() => setHelpOpen((v) => !v)}
        className="mt-4 text-[13.5px] font-semibold text-primary transition-colors hover:text-primary"
      >
        {t("offline.help.title")}
      </button>
      {helpOpen && <ConnectionHelp />}

      {/* Escape hatch: never leave the user stuck offline with no way to re-pair —
          e.g. after the home switched services, this pairing can never recover. */}
      <button
        onClick={() => api.unpair()}
        className="mt-5 text-[13px] font-medium text-base-content/45 transition-colors hover:text-base-content/60"
      >
        {t("offline.disconnectAndRepair")}
      </button>

      {ago && (
        <p className="mt-4 text-xs text-base-content/35">
          {t("offline.lastConnected", { time: ago })}
        </p>
      )}
    </div>
  );
}
