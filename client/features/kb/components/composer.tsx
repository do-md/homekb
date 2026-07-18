"use client";

/**
 * The pinned bottom ask composer (design 2a/3a): ONE ask input, no mode toggle —
 * the engine's router decides answer-vs-list per query (docs/ARCHITECTURE.md
 * "Auto mode"), so both variants are a single input row + send:
 * - "entry": the home-screen composer with the long example placeholder.
 * - "followup": a simple "Ask a follow-up…" bar under results.
 * Always rendered inside the app shell's bottom scrim; pads its own safe area.
 */

import { useKbStore, useKbStoreApi } from "../store/kb-store";
import { IconArrowUp } from "./icons";

function SendButton({ disabled }: { disabled: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label="Send"
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
        disabled
          ? "bg-base-300 text-base-content/45"
          : "bg-primary text-primary-content hover:bg-primary/90"
      }`}
    >
      <IconArrowUp size={17} strokeWidth={2} />
    </button>
  );
}

export function Composer({
  variant,
  muted = false,
  mutedPlaceholder,
}: {
  variant: "entry" | "followup";
  /** Muted/disabled composer (empty library, offline) with a contextual placeholder. */
  muted?: boolean;
  mutedPlaceholder?: string;
}) {
  const api = useKbStoreApi();
  const query = useKbStore((s) => s.state.query);
  const phase = useKbStore((s) => s.state.phase);
  const busy = phase === "searching";
  const disabled = muted || busy;

  const placeholder = muted
    ? (mutedPlaceholder ?? "Not available right now")
    : variant === "entry"
      ? "Search notes or ask anything — 'trip notes', 'how do I ease back pain?'"
      : "Ask a follow-up…";

  return (
    <div className="hk-scrim px-4 pt-8 pb-[max(env(safe-area-inset-bottom),12px)]">
      <form
        className={`shadow-sm mx-auto flex w-full max-w-2xl items-center gap-2 rounded-2xl border border-base-200 bg-hk-composer p-2.5 backdrop-blur-md ${
          muted ? "opacity-60" : ""
        }`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled) void api.search();
        }}
      >
        <input
          value={query}
          onChange={(e) => api.setQuery(e.target.value)}
          placeholder={placeholder}
          disabled={muted}
          enterKeyHint="send"
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[15px] text-base-content outline-none placeholder:text-base-content/45"
        />
        <SendButton disabled={disabled || !query.trim()} />
      </form>
    </div>
  );
}
