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

/**
 * Rough embedding price per 1M input tokens (USD) by model, for the rebuild
 * estimate. Order-of-magnitude only — actual token counts vary by content.
 */
const EMBEDDING_RATE_PER_M: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "gemini-embedding-001": 0.15,
  "voyage-4": 0.06,
  "voyage-4-lite": 0.02,
  "voyage-4-large": 0.12,
  "embed-v4.0": 0.1,
};

/** Estimate the embedding cost of a full reindex from chunk/doc counts. */
function estimateReindexCost(chunks: number, docs: number, model: string): string {
  // Heuristic: chunk pool (~600 tok/chunk) + doc-summary pool (~130 tok/doc).
  const tokens = chunks * 600 + docs * 130;
  const rate = EMBEDDING_RATE_PER_M[model] ?? 0.1;
  const usd = (tokens / 1_000_000) * rate;
  if (usd < 0.01) return "<$0.01";
  return `≈ $${usd.toFixed(2)}`;
}

/** Rebuild card: drift warning + cost estimate + one-click rebuild → reindex. */
function RebuildIndexCard() {
  const api = useDesktopStoreApi();
  const embedding = useDesktopStore((s) => s.state.engine?.ai?.embedding ?? null);
  const stats = useDesktopStore((s) => s.state.indexStats);
  const rebuilding = useDesktopStore((s) => s.state.rebuilding);

  if (!embedding) return null;

  const built = stats?.available
    ? `${stats.embeddingProvider || "openai"} · ${stats.embeddingModel || "?"}`
    : null;
  const drift =
    stats?.available &&
    (stats.embeddingProvider !== embedding.provider || stats.embeddingModel !== embedding.model);
  const cost =
    stats?.available && stats.chunks > 0
      ? estimateReindexCost(stats.chunks, stats.docs, embedding.model)
      : null;

  return (
    <Section title="Index — rebuild after changing the embedding model">
      <Row label="Built with" value={built ?? "No index yet — run compile first"} />
      {stats?.available && (
        <Row label="Size" value={`${stats.docs} docs · ${stats.chunks} chunks`} />
      )}
      {drift && (
        <p className="mt-1 rounded-lg bg-hk-coral/10 px-3 py-2 text-xs leading-relaxed text-hk-coral">
          Config now uses{" "}
          <b>
            {embedding.provider} · {embedding.model}
          </b>
          , but the index was built with <b>{built}</b>. Rebuild to apply the new model.
        </p>
      )}
      <p className="mt-1 text-xs leading-relaxed text-hk-faint">
        Embedding vectors are model-specific and can’t be reused — changing the model requires
        re-embedding every note. Your Markdown files are untouched.
        {cost && (
          <>
            {" "}
            Estimated embedding cost: <b>{cost}</b> ({stats!.chunks} chunks with {embedding.model}).
            Summaries are regenerated too, billed at the Summary provider’s rate.
          </>
        )}
      </p>
      <div className="mt-2 flex justify-end">
        <button
          className="flex items-center gap-1.5 rounded-xl bg-hk-coral px-4 py-2 text-[13.5px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-50"
          disabled={rebuilding}
          onClick={() => void api.rebuildReindex()}
        >
          {rebuilding && <Spinner size={13} />}
          {rebuilding ? "Reindexing… (a few minutes)" : "Rebuild & reindex"}
        </button>
      </div>
    </Section>
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
        <RebuildIndexCard />
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
