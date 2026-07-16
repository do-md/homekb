"use client";

/**
 * Settings (design 7a, desktop only): engine, data directory, AI providers
 * ([embedding]/[summary]/[ask] — docs "AI provider presets"), appearance.
 * Remote access lives in its own Remote tab (7b), not here.
 * Card sections with monospace values; green dots only for "running/configured".
 */

import { useEffect } from "react";
import { Spinner, StatusDot } from "@/features/kb/components/icons";
import type { AiSection } from "@/lib/client/desktop";
import { useDesktopStore, useDesktopStoreApi } from "../store/desktop-store";
import { DesktopNotice } from "./notice";

const EMBEDDING_PROVIDERS = ["openai", "gemini", "voyage", "cohere", "custom"] as const;
const CHAT_PROVIDERS = ["openai", "gemini", "custom"] as const;

const inputCls =
  "min-w-0 flex-1 rounded-xl border border-hk-input-border bg-transparent px-3 py-2 font-mono text-[13px] text-hk-text outline-none placeholder:text-hk-weak focus:border-hk-input-focus";

/** One [embedding]/[summary]/[ask] editor: provider select + key/model (+ custom fields). */
function AiEndpointEditor({ section, title, note }: { section: AiSection; title: string; note?: string }) {
  const api = useDesktopStoreApi();
  const current = useDesktopStore((s) => s.state.engine?.ai?.[section] ?? null);
  const draft = useDesktopStore((s) => s.state.aiDrafts[section]);
  const busy = useDesktopStore((s) => s.state.aiBusy === section);

  const isAsk = section === "ask";
  const providers = section === "embedding" ? EMBEDDING_PROVIDERS : CHAT_PROVIDERS;
  // "" on ask = summary fallback (deletes the section on save)
  const provider = draft.provider || (isAsk && !current?.configured ? "" : (current?.provider ?? "openai"));
  const fallbackActive = isAsk && provider === "";
  const dirty =
    draft.apiKey.trim() !== "" ||
    draft.model.trim() !== "" ||
    draft.baseUrl.trim() !== "" ||
    draft.dim.trim() !== "" ||
    (draft.provider !== "" && draft.provider !== (current?.provider ?? "openai"));

  return (
    <Section title={title}>
      <Row
        label="Current"
        value={
          fallbackActive ? (
            "Uses the Summary endpoint"
          ) : current?.keyPresent ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-hk-green">
                <StatusDot className="h-1.5! w-1.5!" />
              </span>
              {current.provider} · {current.model}
            </span>
          ) : (
            `${current?.provider ?? "openai"} · key missing`
          )
        }
      />
      <div className="mt-1.5 flex flex-col gap-2">
        <select
          className={inputCls}
          value={provider}
          onChange={(e) => api.setAiDraft(section, { provider: e.target.value })}
        >
          {isAsk && <option value="">Same as Summary (default)</option>}
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {!fallbackActive && (
          <>
            <input
              type="password"
              className={inputCls}
              placeholder={current?.configured && draft.provider === "" ? "API key — blank keeps the stored key" : "API key — stored locally in config.toml"}
              value={draft.apiKey}
              onChange={(e) => api.setAiDraft(section, { apiKey: e.target.value })}
              autoComplete="off"
            />
            <input
              type="text"
              className={inputCls}
              placeholder={`Model — blank = ${provider === "custom" ? "required" : "provider default"}`}
              value={draft.model}
              onChange={(e) => api.setAiDraft(section, { model: e.target.value })}
              autoComplete="off"
            />
            {provider === "custom" && (
              <input
                type="text"
                className={inputCls}
                placeholder="Base URL — any OpenAI-compatible endpoint"
                value={draft.baseUrl}
                onChange={(e) => api.setAiDraft(section, { baseUrl: e.target.value })}
                autoComplete="off"
              />
            )}
            {provider === "custom" && section === "embedding" && (
              <input
                type="text"
                inputMode="numeric"
                className={inputCls}
                placeholder="Vector dimension (e.g. 1024)"
                value={draft.dim}
                onChange={(e) => api.setAiDraft(section, { dim: e.target.value })}
                autoComplete="off"
              />
            )}
          </>
        )}
        <div className="flex items-center justify-between gap-2">
          {note ? <p className="text-xs leading-relaxed text-hk-faint">{note}</p> : <span />}
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-hk-coral px-4 py-2 text-[13.5px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-50"
            disabled={busy || (fallbackActive ? !current?.configured : !dirty)}
            onClick={() => void (fallbackActive ? api.resetAsk() : api.saveAiEndpoint(section))}
          >
            {busy && <Spinner size={13} />}
            Save
          </button>
        </div>
      </div>
    </Section>
  );
}

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

/** Desktop-only Settings view: engine + directories + AI providers + appearance. */
export function SettingsView() {
  const api = useDesktopStoreApi();
  const engine = useDesktopStore((s) => s.state.engine);

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

        <AiEndpointEditor
          section="embedding"
          title="Embedding — turns notes into search vectors (required)"
          note="Switching provider or model changes the vector space — a full reindex (rebuild) is required afterwards."
        />
        <AiEndpointEditor
          section="summary"
          title="Summary — compile-time summaries and categories (required)"
        />
        <AiEndpointEditor
          section="ask"
          title="Ask — answers questions over your notes (optional)"
          note="Agents connected over MCP bring their own model; this only powers the built-in Q&A."
        />

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
