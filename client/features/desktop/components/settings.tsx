"use client";

/**
 * Settings (design 7a, desktop only): engine, data directory, AI providers
 * ([embedding]/[summary]/[ask] — docs "AI provider presets"), appearance.
 * Remote access lives in its own Remote tab (7b), not here.
 * Card sections with monospace values; green dots only for "running/configured".
 */

import { useEffect } from "react";
import { Spinner, StatusDot } from "@/features/kb/components/icons";
import {
  AiEndpointEditor,
  SettingsRow as Row,
  SettingsSection as Section,
} from "@/features/kb/components/ai-endpoint-editor";
import type { AiSection } from "@/lib/client/desktop";
import { useDesktopStore, useDesktopStoreApi } from "../store/desktop-store";
import { DesktopNotice } from "./notice";

/** Desktop binding of the shared editor: DesktopStore state + Tauri command save. */
function DesktopAiEndpointEditor({ section, title, note }: { section: AiSection; title: string; note?: string }) {
  const api = useDesktopStoreApi();
  const current = useDesktopStore((s) => s.state.engine?.ai?.[section] ?? null);
  const draft = useDesktopStore((s) => s.state.aiDrafts[section]);
  const busy = useDesktopStore((s) => s.state.aiBusy === section);

  return (
    <AiEndpointEditor
      section={section}
      title={title}
      note={note}
      current={current}
      draft={draft}
      busy={busy}
      onDraft={(patch) => api.setAiDraft(section, patch)}
      onSave={() => void api.saveAiEndpoint(section)}
      onResetAsk={() => void api.resetAsk()}
    />
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
  "text-embedding-v4": 0.07, // DashScope ~0.5 CNY per 1M tokens
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
        <p className="mt-1 rounded-lg bg-primary/10 px-3 py-2 text-xs leading-relaxed text-primary">
          Config now uses{" "}
          <b>
            {embedding.provider} · {embedding.model}
          </b>
          , but the index was built with <b>{built}</b>. Rebuild to apply the new model.
        </p>
      )}
      <p className="mt-1 text-xs leading-relaxed text-base-content/35">
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
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-50"
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

/**
 * App updates card (docs "App self-update"): shell version + manual check with
 * inline status. The check downloads + installs in the background; once ready,
 * the button flips to "Restart to update". Errors/up-to-date report via the
 * notice pill — never a system dialog.
 */
function AppUpdatesCard() {
  const api = useDesktopStoreApi();
  const appVersion = useDesktopStore((s) => s.state.appVersion);
  const updateReady = useDesktopStore((s) => s.state.updateReady);
  const busy = useDesktopStore((s) => s.state.updateBusy);

  return (
    <Section title="App updates">
      <Row label="Version" value={appVersion ?? "–"} />
      {updateReady && <Row label="Ready" value={`${updateReady} — restart to apply`} />}
      <p className="mt-1 text-xs leading-relaxed text-base-content/35">
        Updates download and install in the background; HomeKB switches to the new
        version the next time it starts.
      </p>
      <div className="mt-2 flex justify-end">
        <button
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void (updateReady ? api.restartToUpdate() : api.checkForUpdate(true))}
        >
          {busy && <Spinner size={13} />}
          {updateReady ? "Restart to update" : busy ? "Checking…" : "Check for updates"}
        </button>
      </div>
    </Section>
  );
}

/**
 * Engine card (docs "Engine acquisition"): installed version/binary/serve
 * liveness + a manual update check. The engine is downloaded from the
 * engine-v* GitHub release — the same `engine_install` command as first run.
 */
function EngineCard() {
  const api = useDesktopStoreApi();
  const engine = useDesktopStore((s) => s.state.engine);
  const engineLatest = useDesktopStore((s) => s.state.engineLatest);
  const busy = useDesktopStore((s) => s.state.engineUpdateBusy);

  return (
    <Section title="Engine">
      <Row label="Version" value={engine?.version ?? "Unknown"} />
      <Row label="Binary" value={engine?.path ?? "Not installed"} />
      <Row
        label="Local service"
        value={
          engine?.serveRunning ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-success">
                <StatusDot className="h-1.5! w-1.5!" />
              </span>
              Running · 127.0.0.1:8765
            </span>
          ) : (
            "Not running"
          )
        }
      />
      {engineLatest && <Row label="Available" value={engineLatest} />}
      <div className="mt-2 flex justify-end">
        <button
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void (engineLatest ? api.updateEngine() : api.checkEngineUpdate())}
        >
          {busy && <Spinner size={13} />}
          {engineLatest
            ? busy
              ? "Updating…"
              : `Update to ${engineLatest}`
            : busy
              ? "Checking…"
              : "Check for engine updates"}
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
        <h1 className="text-[21px] font-bold tracking-tight text-base-content">Settings</h1>

        <EngineCard />

        <AppUpdatesCard />

        <Section title="Data directory — your data stays on this machine">
          <Row label="Notes" value={engine?.notesDir ?? "–"} />
          <Row label="Data root" value={engine?.root ?? "–"} />
          <Row label="Config" value={engine?.configPath ?? "–"} />
        </Section>

        <DesktopAiEndpointEditor
          section="embedding"
          title="Embedding — turns notes into search vectors (required)"
          note="Switching provider or model changes the vector space — a full reindex (rebuild) is required afterwards."
        />
        <RebuildIndexCard />
        <DesktopAiEndpointEditor
          section="summary"
          title="Summary — compile-time summaries and categories (required)"
        />
        <DesktopAiEndpointEditor
          section="ask"
          title="Ask — answers questions over your notes (optional)"
          note="Agents connected over MCP bring their own model; this only powers the built-in Q&A."
        />

        <Section title="Appearance">
          <Row label="Theme" value="Follows your system" />
          <p className="text-xs leading-relaxed text-base-content/35">
            Light and dark switch automatically with the OS — there is no manual toggle.
          </p>
        </Section>
      </div>
      <DesktopNotice />
    </div>
  );
}
