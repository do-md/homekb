"use client";

/**
 * Status dashboard (design 6a, compiling state 6b): knowledge-base health +
 * index pipeline. Big tabular-num stats; green dots only for "all good";
 * the index.db box in the data flow is primary — the read-only snapshot is the
 * "your data stays local" story.
 */

import { useEffect } from "react";
import { isDesktop } from "@/lib/client/desktop";
import {
  useDesktopStore,
  useDesktopStoreApi,
} from "@/features/desktop/store/desktop-store";
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
    dot === "green" ? "text-success" : dot === "amber" ? "text-warning" : "text-hk-orange";
  return (
    <div className="rounded-2xl bg-base-200 p-4">
      <div className="hk-label flex items-center gap-1.5">
        {label}
        {dot && (
          <span className={dotCls}>
            <StatusDot className="h-1.5! w-1.5!" />
          </span>
        )}
      </div>
      <div className="mt-1.5 text-[27px] leading-none font-bold text-base-content tabular-nums">
        {value}
      </div>
      {sub && <div className="mt-1.5 text-xs text-base-content/35">{sub}</div>}
    </div>
  );
}

/**
 * Compile scheduler card (design 6a/6b) — desktop only: drives the
 * com.homekb.compile LaunchAgent through the compile_* Tauri commands.
 * Web/remote modes have no scheduler visibility (kb.status carries no such field).
 */
function SchedulerCard() {
  const api = useDesktopStoreApi();
  const running = useDesktopStore((s) => s.state.schedulerRunning);
  const managed = useDesktopStore((s) => s.state.schedulerManaged);
  const busy = useDesktopStore((s) => s.state.schedulerBusy);

  useEffect(() => {
    void api.refreshScheduler();
  }, [api]);

  const active = managed && running;
  return (
    <div className="rounded-2xl border border-base-300 bg-base-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[14px] font-semibold text-base-content">
          <span className={active ? "text-success" : "text-warning"}>
            <StatusDot />
          </span>
          {active ? "Scheduler running" : "Scheduler stopped"}
        </span>
        <button
          onClick={() => void api.toggleScheduler()}
          disabled={busy}
          className={
            active
              ? "flex items-center gap-1.5 rounded-xl border border-base-300 px-3.5 py-2 text-[13px] font-semibold text-base-content/60 transition-colors hover:bg-base-200 disabled:opacity-60"
              : "flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-60"
          }
        >
          {busy && <Spinner size={12} />}
          {active ? "Stop scheduler" : "Start scheduler"}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-base-content/35">
        <code className="font-mono">com.homekb.compile</code> · launchd — recompiles your
        notes on a schedule while it runs.
      </p>
    </div>
  );
}

/** Paths table (design 6a: label · monospace path · tag) — desktop only. */
function PathsCard() {
  const engine = useDesktopStore((s) => s.state.engine);
  if (!engine) return null;
  const rows: [string, string, string][] = [
    ["Notes", engine.notesDir, "md"],
    ["Data root", engine.root, "data"],
    ["Config", engine.configPath, "toml"],
  ];
  return (
    <div className="rounded-2xl border border-base-300 bg-base-200 p-4">
      <div className="hk-label">Paths</div>
      <div className="mt-2 flex flex-col">
        {rows.map(([label, path, tag], i) => (
          <div
            key={label}
            className={`flex items-center gap-3 py-2 text-[13px] ${
              i > 0 ? "border-t border-base-200" : ""
            }`}
          >
            <span className="w-20 shrink-0 text-base-content/45">{label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-base-content/60">
              {path}
            </span>
            <span className="shrink-0 rounded-[7px] border border-base-200 bg-base-300 px-2 py-0.5 text-[11px] font-medium text-base-content/45">
              {tag}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowBox({ label, highlight = false }: { label: string; highlight?: boolean }) {
  return (
    <span
      className={`rounded-lg border px-2.5 py-1.5 font-mono text-[11.5px] whitespace-nowrap ${
        highlight
          ? "border-primary/20 bg-primary/10 font-semibold text-primary"
          : "border-base-200 bg-base-200 text-base-content/60"
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
            <h1 className="text-[21px] font-bold tracking-tight text-base-content">Index status</h1>
            {metaBits.length > 0 && (
              <p className="mt-1 text-[12.5px] text-base-content/45">{metaBits.join(" · ")}</p>
            )}
          </div>
          <button
            className="btn rounded-lg btn-md"
            onClick={() => void api.reindex()}
          >
            <IconRefresh size={13} /> Reindex now
          </button>
        </div>

        {loading && !status ? (
          <div className="flex justify-center py-16 text-primary">
            <Spinner size={22} />
          </div>
        ) : status ? (
          <div className="mt-5 flex flex-col gap-4">
            {/* Compile scheduler (6a/6b) — the home machine's launchd agent */}
            {isDesktop() && <SchedulerCard />}

            {/* Compiling state (6b) */}
            {compiling && (
              <div className="rounded-2xl border border-base-300 bg-base-200 p-4">
                <div className="flex items-center gap-2 text-[14px] font-semibold text-base-content">
                  <span className="text-primary">
                    <Spinner size={14} />
                  </span>
                  Vectorizing chunks…
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-base-300">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-base-content/35">
                  <span className="tabular-nums">
                    {vectorized}/{chunks} · ~{Math.max(chunks - vectorized, pending)} left
                  </span>
                  <span>Search and answers keep working while it compiles.</span>
                </div>
              </div>
            )}

            {/* Hero CHUNKS card */}
            <div className="rounded-2xl bg-base-200 p-4">
              <div className="hk-label flex items-center gap-1.5">
                Chunks
                {allVectorized && (
                  <span className="text-success">
                    <StatusDot className="h-1.5! w-1.5!" />
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="text-[33px] leading-none font-bold text-base-content tabular-nums">
                  {vectorized}
                </span>
                <span className="text-[15px] text-base-content/45 tabular-nums">/ {chunks} vectorized</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-base-300">
                <div
                  className="h-full rounded-full bg-primary/65"
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

            {/* Data flow: the primary index.db box = read-only snapshot, data stays local */}
            <div className="rounded-2xl bg-base-200 p-4">
              <div className="hk-label">Data flow</div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <FlowBox label="*.md" />
                <span className="text-base-content/35">→</span>
                <FlowBox label="live.db" />
                <span className="text-base-content/35">→</span>
                <FlowBox label="index.db" highlight />
                <span className="text-base-content/35">→</span>
                <FlowBox label="homekb query" />
              </div>
              <p className="mt-2.5 text-xs leading-relaxed text-base-content/35">
                Notes compile into a read-only snapshot on your computer — search runs
                against it locally; nothing is uploaded.
              </p>
            </div>

            {/* Paths (6a) — where everything lives on the home machine */}
            {isDesktop() && <PathsCard />}

            {/* Failures section */}
            <div className="flex items-center gap-2 rounded-2xl bg-base-200 px-4 py-3 text-[13px] text-base-content/60">
              {failures === 0 ? (
                <>
                  <span className="text-success">
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
          <p className="py-14 text-center text-[13.5px] text-base-content/45">
            No status data available
          </p>
        )}
      </div>
    </div>
  );
}
