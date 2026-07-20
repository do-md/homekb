"use client";

/**
 * Background compile schedule card (Status page, all platforms — docs
 * "RPC methods": `kb.scheduleGet` / `kb.scheduleSet`). One implementation for
 * desktop (local serve) and web/remote (through the relay): on/off toggle +
 * compile interval for the home machine's `com.homekb.compile` agent.
 *
 * Degrades gracefully: an engine predating the schedule RPC never answers
 * `kb.scheduleGet`, so the card simply doesn't render; a non-macOS home
 * reports `supported: false` and gets an explanatory note instead of controls.
 */

import { useEffect, useState } from "react";
import { formatInterval, useKbStore, useKbStoreApi } from "../store/kb-store";
import { Spinner, StatusDot } from "./icons";

/** Interval choices offered by the select (seconds). */
const INTERVAL_CHOICES = [60, 300, 900, 1800, 3600];

export function ScheduleCard() {
  const api = useKbStoreApi();
  const schedule = useKbStore((s) => s.state.schedule);
  const busy = useKbStore((s) => s.state.scheduleBusy);
  // Interval picked before enabling (or while paused); synced from the home
  // state whenever it reports an installed interval.
  const [pendingInterval, setPendingInterval] = useState(300);

  useEffect(() => {
    void api.loadSchedule();
  }, [api]);

  const installedInterval = schedule?.intervalSecs ?? null;
  useEffect(() => {
    if (installedInterval != null) setPendingInterval(installedInterval);
  }, [installedInterval]);

  // Old engine (no schedule RPC) → nothing to manage remotely; stay quiet.
  if (!schedule) return null;

  if (!schedule.supported) {
    return (
      <div className="rounded-xl border border-base-300 bg-base-200 p-4">
        <div className="text-[14px] font-semibold text-base-content">Scheduled compilation</div>
        <p className="mt-2 text-xs leading-relaxed text-base-content/35">
          Your home computer&rsquo;s platform can&rsquo;t manage a background schedule remotely yet
          (macOS only for now) — run <code className="font-mono">homekb watch</code> there instead.
        </p>
      </div>
    );
  }

  const active = schedule.installed && schedule.running;
  const stalled = schedule.installed && !schedule.running;
  const choices = INTERVAL_CHOICES.includes(pendingInterval)
    ? INTERVAL_CHOICES
    : [...INTERVAL_CHOICES, pendingInterval].sort((a, b) => a - b);

  return (
    <div className="rounded-xl border border-base-300 bg-base-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[14px] font-semibold text-base-content">
          <span className={active ? "text-success" : "text-warning"}>
            <StatusDot />
          </span>
          {active
            ? `Compiling every ${formatInterval(schedule.intervalSecs ?? pendingInterval)}`
            : stalled
              ? "Schedule installed, not running"
              : "Scheduled compilation off"}
        </span>
        <span className="flex items-center gap-2">
          {busy && <Spinner size={13} />}
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm"
            checked={schedule.installed}
            disabled={busy}
            aria-label="Background compilation"
            onChange={(e) =>
              void api.setSchedule(e.target.checked, e.target.checked ? pendingInterval : undefined)
            }
          />
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[13px] text-base-content/60">Recompile notes every</span>
        <select
          className="select select-sm w-auto"
          value={pendingInterval}
          disabled={busy}
          aria-label="Compile interval"
          onChange={(e) => {
            const v = Number(e.target.value);
            setPendingInterval(v);
            // Applied immediately while the schedule runs; otherwise it takes
            // effect the next time the toggle turns it on.
            if (schedule.installed) void api.setSchedule(true, v);
          }}
        >
          {choices.map((secs) => (
            <option key={secs} value={secs}>
              {formatInterval(secs)}
            </option>
          ))}
        </select>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-base-content/35">
        <code className="font-mono">com.homekb.compile</code> on your home computer — indexes new
        and edited notes on a schedule so search stays fresh. Off = notes still save, but they
        aren&rsquo;t searchable until the next compile.
      </p>
    </div>
  );
}
