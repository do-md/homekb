"use client";

/**
 * Settings (design 7a, desktop only): engine, data directory, OpenAI key,
 * appearance. Remote access lives in its own Remote tab (7b), not here.
 * Card sections with monospace values; green dots only for "running/configured".
 */

import { useEffect } from "react";
import { Spinner, StatusDot } from "@/features/kb/components/icons";
import { useDesktopStore, useDesktopStoreApi } from "../store/desktop-store";
import { DesktopNotice } from "./notice";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-hk-border bg-hk-card p-4">
      <div className="hk-label">{title}</div>
      <div className="mt-3 flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[13.5px]">
      <span className="shrink-0 text-hk-weak">{label}</span>
      <span className="truncate text-right font-mono text-[12px] text-hk-text-2">{value}</span>
    </div>
  );
}

/** Desktop-only Settings view: engine + directories + key + appearance. */
export function SettingsView() {
  const api = useDesktopStoreApi();
  const engine = useDesktopStore((s) => s.state.engine);
  const keyDraft = useDesktopStore((s) => s.state.keyDraft);
  const keyBusy = useDesktopStore((s) => s.state.keyBusy);

  useEffect(() => {
    void api.refreshEngine();
  }, [api]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-5 pb-[max(env(safe-area-inset-bottom),24px)]">
        <h1 className="text-[21px] font-bold tracking-tight text-hk-heading">Settings</h1>

        <Section title="Engine">
          <Row label="Version" value={engine?.version ?? "Unknown"} />
          <Row label="Binary" value={engine?.path ?? "Not installed"} />
          <Row
            label="Local service"
            value={
              engine?.serveRunning ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-hk-green">
                    <StatusDot className="h-1.5! w-1.5!" />
                  </span>
                  Running · 127.0.0.1:8765
                </span>
              ) : (
                "Not running"
              )
            }
          />
        </Section>

        <Section title="Data directory — your data stays on this machine">
          <Row label="Notes" value={engine?.notesDir ?? "–"} />
          <Row label="Data root" value={engine?.root ?? "–"} />
          <Row label="Config" value={engine?.configPath ?? "–"} />
        </Section>

        <Section title="OpenAI key — stored locally in config.toml, used for indexing and Q&A">
          <Row
            label="Current"
            value={
              engine?.openaiKeyPresent ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-hk-green">
                    <StatusDot className="h-1.5! w-1.5!" />
                  </span>
                  Configured
                </span>
              ) : (
                "Not configured"
              )
            }
          />
          <div className="mt-1.5 flex gap-2">
            <input
              type="password"
              className="min-w-0 flex-1 rounded-xl border border-hk-input-border bg-transparent px-3 py-2 font-mono text-[13px] text-hk-text outline-none placeholder:text-hk-weak focus:border-hk-input-focus"
              placeholder="sk-…"
              value={keyDraft}
              onChange={(e) => api.setKeyDraft(e.target.value)}
              autoComplete="off"
            />
            <button
              className="flex items-center gap-1.5 rounded-xl bg-hk-coral px-4 py-2 text-[13.5px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-50"
              disabled={keyBusy || !keyDraft.trim()}
              onClick={() => void api.saveOpenaiKey()}
            >
              {keyBusy && <Spinner size={13} />}
              Save
            </button>
          </div>
        </Section>

        <Section title="Appearance">
          <Row label="Theme" value="Follows your system" />
          <p className="text-xs leading-relaxed text-hk-faint">
            Light and dark switch automatically with the OS — there is no manual toggle.
          </p>
        </Section>
      </div>
      <DesktopNotice />
    </div>
  );
}
