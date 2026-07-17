"use client";

/**
 * The pinned bottom ask composer (design 2a/3a): one ask input, two modes.
 * - "entry": segmented Answer | List toggle inside the composer + circular coral send.
 * - "followup": a simple "Ask a follow-up…" bar (the mode toggle rides with the query at top).
 * Always rendered inside the app shell's bottom scrim; pads its own safe area.
 */

import { useKbStore, useKbStoreApi } from "../store/kb-store";
import { IconArrowUp } from "./icons";

export function ModeToggle({ compact = false }: { compact?: boolean }) {
  const api = useKbStoreApi();
  const mode = useKbStore((s) => s.state.mode);
  const items: ["answer" | "list", string][] = [
    ["answer", "Answer"],
    ["list", "List"],
  ];
  return (
    <div
      role="tablist"
      className={`flex items-center gap-0.5 rounded-full border border-hk-hairline bg-hk-card-soft p-0.5 ${compact ? "" : "shrink-0"}`}
    >
      {items.map(([m, label]) => (
        <button
          key={m}
          role="tab"
          aria-selected={mode === m}
          onClick={() => api.setMode(m)}
          className={`rounded-full px-3 py-1 text-[12.5px] font-semibold transition-colors ${
            mode === m ? "bg-hk-pill text-hk-heading" : "text-hk-weak hover:text-hk-text-2"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function SendButton({ disabled }: { disabled: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label="Send"
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
        disabled
          ? "bg-hk-pill text-hk-weak"
          : "bg-hk-coral text-hk-on-coral hover:bg-hk-coral-hover"
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
      ? "Ask your knowledge base, e.g. 'how do I ease lower-back pain from sitting?'"
      : "Ask a follow-up…";

  return (
    <div className="hk-scrim px-4 pt-8 pb-[max(env(safe-area-inset-bottom),12px)]">
      <form
        className={`mx-auto flex w-full max-w-2xl flex-col gap-2 rounded-2xl border border-hk-hairline bg-hk-composer p-2.5 backdrop-blur-md ${
          muted ? "opacity-60" : ""
        }`}
        style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.25)" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled) void api.search();
        }}
      >
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => api.setQuery(e.target.value)}
            placeholder={placeholder}
            disabled={muted}
            enterKeyHint="send"
            className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[15px] text-hk-text outline-none placeholder:text-hk-weak"
          />
          {variant === "followup" && <SendButton disabled={disabled || !query.trim()} />}
        </div>
        {variant === "entry" && (
          <div className="flex items-center justify-between">
            <ModeToggle />
            <SendButton disabled={disabled || !query.trim()} />
          </div>
        )}
      </form>
    </div>
  );
}
