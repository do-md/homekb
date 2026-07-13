"use client";

/**
 * Status dashboard (design 6a, compiling state 6b): knowledge-base health +
 * index pipeline. Big tabular-num stats; green dots only for "all good";
 * the index.db box in the data flow is coral — the read-only snapshot is the
 * "your data stays local" story.
 */

import { useKbStore, useKbStoreApi } from "../../store/kb-store";
import { IconCheck, IconRefresh, Spinner, StatusDot } from "../icons";

function StatCard({
  label,
  value,
  dot,
  sub,
}: {
  label: string;
  value: string | number;
  dot?: "green" | "amber" | "orange" | null;
  sub?: string;
}) {
  const dotCls =
    dot === "green" ? "text-hk-green" : dot === "amber" ? "text-hk-amber" : "text-hk-orange";
  return (
    <div className="rounded-2xl border border-hk-border bg-hk-card p-4">
      <div className="hk-label flex items-center gap-1.5">
        {label}
        {dot && (
          <span className={dotCls}>
            <StatusDot className="h-1.5! w-1.5!" />
          </span>
        )}
      </div>
      <div className="mt-1.5 text-[27px] leading-none font-bold text-hk-heading tabular-nums">
        {value}
      </div>
      {sub && <div className="mt-1.5 text-xs text-hk-faint">{sub}</div>}
    </div>
  );
}

function FlowBox({ label, highlight = false }: { label: string; highlight?: boolean }) {
  return (
    <span
      className={`rounded-lg border px-2.5 py-1.5 font-mono text-[11.5px] whitespace-nowrap ${
        highlight
          ? "border-hk-coral-chip-border bg-hk-coral-chip font-semibold text-hk-coral-text"
          : "border-hk-hairline bg-hk-card-soft text-hk-text-2"
      }`}
    >
      {label}
    </span>
  );
}

export function StatusView() {
  const api = useKbStoreApi();
  const status = useKbStore((s) => s.state.status);
  const loading = useKbStore((s) => s.state.statusLoading);
  const homeName = useKbStore((s) => s.state.homeName);

  const chunks = status?.chunks ?? 0;
  const vectorized = status?.chunksWithVectors ?? 0;
  const pending = status?.pending ?? 0;
  const failures = status?.failures ?? 0;
  const allVectorized = chunks > 0 && vectorized >= chunks;
  const compiling = pending > 0 || (chunks > 0 && vectorized < chunks);
  const pct = chunks > 0 ? Math.min(100, Math.round((vectorized / chunks) * 100)) : 0;

  const metaBits = [
    status?.generation != null ? `Generation ${status.generation}` : null,
    status?.lastCompileAt
      ? `last indexed ${new Date(status.lastCompileAt * 1000).toLocaleString()}`
      : null,
    status?.lastCompileHost ?? homeName ?? null,
  ].filter(Boolean);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-5 pb-[max(env(safe-area-inset-bottom),24px)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-[21px] font-bold tracking-tight text-hk-heading">Index status</h1>
            {metaBits.length > 0 && (
              <p className="mt-1 text-[12.5px] text-hk-weak">{metaBits.join(" · ")}</p>
            )}
          </div>
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-hk-border px-3.5 py-2 text-[13px] font-semibold text-hk-text-2 transition-colors hover:bg-hk-card"
            onClick={() => void api.reindex()}
          >
            <IconRefresh size={13} /> Reindex now
          </button>
        </div>

        {loading && !status ? (
          <div className="flex justify-center py-16 text-hk-coral-text">
            <Spinner size={22} />
          </div>
        ) : status ? (
          <div className="mt-5 flex flex-col gap-4">
            {/* Compiling state (6b) */}
            {compiling && (
              <div className="rounded-2xl border border-hk-border bg-hk-card p-4">
                <div className="flex items-center gap-2 text-[14px] font-semibold text-hk-text">
                  <span className="text-hk-coral-text">
                    <Spinner size={14} />
                  </span>
                  Vectorizing chunks…
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-hk-pill">
                  <div
                    className="h-full rounded-full bg-hk-coral transition-[width] duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-hk-faint">
                  <span className="tabular-nums">
                    {vectorized}/{chunks} · ~{Math.max(chunks - vectorized, pending)} left
                  </span>
                  <span>Search and answers keep working while it compiles.</span>
                </div>
              </div>
            )}

            {/* Hero CHUNKS card */}
            <div className="rounded-2xl border border-hk-border bg-hk-card p-4">
              <div className="hk-label flex items-center gap-1.5">
                Chunks
                {allVectorized && (
                  <span className="text-hk-green">
                    <StatusDot className="h-1.5! w-1.5!" />
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="text-[33px] leading-none font-bold text-hk-heading tabular-nums">
                  {vectorized}
                </span>
                <span className="text-[15px] text-hk-weak tabular-nums">/ {chunks} vectorized</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-hk-pill">
                <div
                  className="h-full rounded-full bg-hk-coral"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Docs" value={status.docs ?? "–"} />
              <StatCard
                label="Pending"
                value={pending}
                dot={pending === 0 ? "green" : "amber"}
              />
              <StatCard
                label="Failures"
                value={failures}
                dot={failures === 0 ? "green" : "orange"}
              />
              <StatCard
                label="Generation"
                value={status.generation ?? "–"}
                sub={status.embeddingModel ?? undefined}
              />
            </div>

            {/* Data flow: the coral index.db box = read-only snapshot, data stays local */}
            <div className="rounded-2xl border border-hk-border bg-hk-card-soft p-4">
              <div className="hk-label">Data flow</div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <FlowBox label="*.md" />
                <span className="text-hk-faint">→</span>
                <FlowBox label="live.db" />
                <span className="text-hk-faint">→</span>
                <FlowBox label="index.db" highlight />
                <span className="text-hk-faint">→</span>
                <FlowBox label="query" />
              </div>
              <p className="mt-2.5 text-xs leading-relaxed text-hk-faint">
                Notes compile into a read-only snapshot on your computer — search runs
                against it locally; nothing is uploaded.
              </p>
            </div>

            {/* Failures section */}
            <div className="flex items-center gap-2 rounded-2xl border border-hk-border bg-hk-card-soft px-4 py-3 text-[13px] text-hk-text-2">
              {failures === 0 ? (
                <>
                  <span className="text-hk-green">
                    <IconCheck size={14} strokeWidth={2} />
                  </span>
                  No failures · every chunk vectorized
                </>
              ) : (
                <>
                  <span className="text-hk-orange">
                    <StatusDot />
                  </span>
                  {failures} {failures === 1 ? "chunk" : "chunks"} failed to vectorize — a
                  reindex usually clears this.
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="py-14 text-center text-[13.5px] text-hk-weak">
            No status data available
          </p>
        )}
      </div>
    </div>
  );
}
