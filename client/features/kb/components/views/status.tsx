"use client";

/**
 * Status dashboard (design 6a, compiling state 6b): knowledge-base health +
 * index pipeline. Big tabular-num stats; green dots only for "all good";
 * the index.db box in the data flow is primary — the read-only snapshot is the
 * "your data stays local" story.
 */

import { useTranslation } from "react-i18next";
import { isDesktop } from "@/lib/client/desktop";
import { useDesktopStore } from "@/features/desktop/store/desktop-store";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";
import { ScheduleCard } from "../schedule-card";
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
    <div className="rounded-xl bg-base-200 p-4">
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

/** Paths table (design 6a: label · monospace path · tag) — desktop only. */
function PathsCard() {
  const { t } = useTranslation();
  const engine = useDesktopStore((s) => s.state.engine);
  if (!engine) return null;
  const rows: [string, string, string][] = [
    [t("status.paths.notes"), engine.notesDir, "md"],
    [t("status.paths.dataRoot"), engine.root, "data"],
    [t("status.paths.config"), engine.configPath, "toml"],
  ];
  return (
    <div className="rounded-xl border border-base-300 bg-base-200 p-4">
      <div className="hk-label">{t("status.paths.title")}</div>
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
  const { t } = useTranslation();
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
    status?.generation != null ? t("status.meta.generation", { n: status.generation }) : null,
    status?.lastCompileAt
      ? t("status.meta.lastIndexed", {
          time: new Date(status.lastCompileAt * 1000).toLocaleString(),
        })
      : null,
    status?.lastCompileHost ?? homeName ?? null,
  ].filter(Boolean);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-5 pb-[max(env(safe-area-inset-bottom),24px)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-[21px] font-bold tracking-tight text-base-content">
              {t("status.title")}
            </h1>
            {metaBits.length > 0 && (
              <p className="mt-1 text-[12.5px] text-base-content/45">{metaBits.join(" · ")}</p>
            )}
          </div>
          <button
            className="btn rounded-lg btn-md"
            onClick={() => void api.reindex()}
          >
            <IconRefresh size={13} /> {t("status.reindexNow")}
          </button>
        </div>

        {loading && !status ? (
          <div className="flex justify-center py-16 text-primary">
            <Spinner size={22} />
          </div>
        ) : status ? (
          <div className="mt-5 flex flex-col gap-4">
            {/* Compile schedule (6a/6b) — the home machine's launchd agent,
                managed over RPC on all platforms (docs "RPC methods") */}
            <ScheduleCard />

            {/* Compiling state (6b) */}
            {compiling && (
              <div className="rounded-xl border border-base-300 bg-base-200 p-4">
                <div className="flex items-center gap-2 text-[14px] font-semibold text-base-content">
                  <span className="text-primary">
                    <Spinner size={14} />
                  </span>
                  {t("status.compiling.title")}
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-base-300">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-base-content/35">
                  <span className="tabular-nums">
                    {t("status.compiling.progress", {
                      vectorized,
                      chunks,
                      left: Math.max(chunks - vectorized, pending),
                    })}
                  </span>
                  <span>{t("status.compiling.note")}</span>
                </div>
              </div>
            )}

            {/* Hero CHUNKS card */}
            <div className="rounded-xl bg-base-200 p-4">
              <div className="hk-label flex items-center gap-1.5">
                {t("status.chunks")}
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
                <span className="text-[15px] text-base-content/45 tabular-nums">
                  {t("status.vectorizedOf", { total: chunks })}
                </span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-base-300">
                <div
                  className="h-full rounded-full bg-primary/65"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <StatCard label={t("status.docs")} value={status.docs ?? "–"} />
              <StatCard
                label={t("status.pending")}
                value={pending}
                dot={pending === 0 ? "green" : "amber"}
              />
              <StatCard
                label={t("status.failuresLabel")}
                value={failures}
                dot={failures === 0 ? "green" : "orange"}
              />
              <StatCard
                label={t("status.generation")}
                value={status.generation ?? "–"}
                sub={status.embeddingModel ?? undefined}
              />
            </div>

            {/* Data flow: the primary index.db box = read-only snapshot, data stays local */}
            <div className="rounded-xl bg-base-200 p-4">
              <div className="hk-label">{t("status.dataFlow.title")}</div>
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
                {t("status.dataFlow.note")}
              </p>
            </div>

            {/* Paths (6a) — where everything lives on the home machine */}
            {isDesktop() && <PathsCard />}

            {/* Failures section */}
            <div className="flex items-center gap-2 rounded-xl bg-base-200 px-4 py-3 text-[13px] text-base-content/60">
              {failures === 0 ? (
                <>
                  <span className="text-success">
                    <IconCheck size={14} strokeWidth={2} />
                  </span>
                  {t("status.failures.none")}
                </>
              ) : (
                <>
                  <span className="text-hk-orange">
                    <StatusDot />
                  </span>
                  {t("status.failures.failed", { count: failures })}
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="py-14 text-center text-[13.5px] text-base-content/45">
            {t("status.noData")}
          </p>
        )}
      </div>
    </div>
  );
}
