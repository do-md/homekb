"use client";

/**
 * Offline action screen (design 4b): offline is not just a color change — it
 * escalates to an explanation + a "How to wake it up" checklist + a coral Retry.
 * Note: the retry/primary action is coral, never green; offline accent is orange.
 */

import { useKbStore, useKbStoreApi } from "../store/kb-store";
import { Spinner, StatusDot } from "./icons";

function agoLabel(ts: number | null): string | null {
  if (!ts) return null;
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const WAKE_STEPS = [
  "Make sure your home computer is awake and connected to the internet.",
  "Check that HomeKB (or `homekb tunnel`) is running on it.",
  "Then retry the connection here.",
];

export function OfflineScreen() {
  const api = useKbStoreApi();
  const connState = useKbStore((s) => s.connState);
  const lastConnectedAt = useKbStore((s) => s.state.lastConnectedAt);
  const retrying = connState === "connecting";
  const ago = agoLabel(lastConnectedAt);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full border border-hk-border bg-hk-card text-hk-orange">
        <StatusDot className="h-3.5! w-3.5!" />
      </span>
      <h1 className="mt-5 text-[22px] font-bold tracking-tight text-hk-heading">
        Home is offline
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-hk-text-2">
        Your home computer isn&apos;t reachable right now. Your notes are safe on it —
        they just can&apos;t be searched from here until it comes back.
      </p>

      <div className="mt-6 w-full rounded-2xl border border-hk-border bg-hk-card p-4 text-left">
        <div className="hk-label">How to wake it up</div>
        <ol className="mt-3 flex flex-col gap-2.5">
          {WAKE_STEPS.map((step, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-hk-coral-chip text-[11px] font-semibold text-hk-coral-text">
                {i + 1}
              </span>
              <span className="text-[13.5px] leading-relaxed text-hk-text-2">{step}</span>
            </li>
          ))}
        </ol>
      </div>

      <button
        onClick={() => api.retryConnection()}
        disabled={retrying}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-hk-coral px-4 py-3 text-[15px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-60"
      >
        {retrying && <Spinner size={15} />}
        {retrying ? "Retrying…" : "Retry connection"}
      </button>

      {ago && <p className="mt-4 text-xs text-hk-faint">Last connected · {ago}</p>}
    </div>
  );
}
