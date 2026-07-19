"use client";

/**
 * Offline action screen (design 4b): offline is not just a color change — it
 * escalates to an explanation + a "How to wake it up" checklist + a primary Retry.
 * Note: the retry/primary action is primary, never green; offline accent is orange.
 */

import { useState } from "react";
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

/** Deeper checklist behind the "Connection help" link (design 4b). */
function ConnectionHelp() {
  return (
    <div className="mt-4 w-full rounded-xl border border-base-300 bg-base-200 p-4 text-left">
      <div className="hk-label">Connection help</div>
      <ul className="mt-3 flex flex-col gap-2.5 text-[13px] leading-relaxed text-base-content/60">
        <li>
          On your home computer, run{" "}
          <code className="font-mono text-[12px]">homekb tunnel --status</code> — it
          should say <span className="font-medium">running</span>. If not,{" "}
          <code className="font-mono text-[12px]">homekb tunnel --install</code>{" "}
          (or turn on “Keep tunnel alive” in the HomeKB app’s Remote tab).
        </li>
        <li>
          The tunnel reconnects on its own after sleep or a network change — give it a
          minute after the computer wakes.
        </li>
        <li>
          Still stuck? Disconnect on the Remote tab and pair again with a fresh code from
          your home computer.
        </li>
      </ul>
    </div>
  );
}

export function OfflineScreen() {
  const api = useKbStoreApi();
  const connState = useKbStore((s) => s.connState);
  const lastConnectedAt = useKbStore((s) => s.state.lastConnectedAt);
  const [helpOpen, setHelpOpen] = useState(false);
  const retrying = connState === "connecting";
  const ago = agoLabel(lastConnectedAt);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full border border-base-300 bg-base-200 text-hk-orange">
        <StatusDot className="h-3.5! w-3.5!" />
      </span>
      <h1 className="mt-5 text-[22px] font-bold tracking-tight text-base-content">
        Home is offline
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-base-content/60">
        Your home computer isn&apos;t reachable right now. Your notes are safe on it —
        they just can&apos;t be searched from here until it comes back.
      </p>

      <div className="mt-6 w-full rounded-xl border border-base-300 bg-base-200 p-4 text-left">
        <div className="hk-label">How to wake it up</div>
        <ol className="mt-3 flex flex-col gap-2.5">
          {WAKE_STEPS.map((step, i) => (
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
        {retrying ? "Retrying…" : "Retry connection"}
      </button>

      <button
        onClick={() => setHelpOpen((v) => !v)}
        className="mt-4 text-[13.5px] font-semibold text-primary transition-colors hover:text-primary"
      >
        Connection help
      </button>
      {helpOpen && <ConnectionHelp />}

      {/* Escape hatch: never leave the user stuck offline with no way to re-pair —
          e.g. after the home switched services, this pairing can never recover. */}
      <button
        onClick={() => api.unpair()}
        className="mt-5 text-[13px] font-medium text-base-content/45 transition-colors hover:text-base-content/60"
      >
        Disconnect &amp; pair again with a new code
      </button>

      {ago && <p className="mt-4 text-xs text-base-content/35">Last connected · {ago}</p>}
    </div>
  );
}
