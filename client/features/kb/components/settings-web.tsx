"use client";

/**
 * Web Settings (design 7a "(all platforms)", remote subset — docs "Settings
 * over RPC"): the AI endpoint editors + home paths rendered from
 * `kb.configGet`, saves via `kb.configSetAi`, and the rebuild card via
 * `kb.rebuild` + `kb.status` (so an embedding switch made here isn't stranded
 * without its mandatory re-embed). Reads are masked (key presence only) and
 * the stored key is bound to its (provider, baseUrl) endpoint identity
 * engine-side, so this surface carries the same security posture as the
 * desktop Settings. Trust-anchor cards (engine install/updates, tunnel,
 * registration) stay desktop-only. The background-compile schedule lives on
 * the Status page (shared card, all platforms).
 */

import { useEffect } from "react";
import type { AiSection } from "@/lib/client/desktop";
import { useKbStore, useKbStoreApi } from "../store/kb-store";
import {
  AiEndpointEditor,
  SettingsRow as Row,
  SettingsSection as Section,
} from "./ai-endpoint-editor";
import { estimateReindexCost } from "./rebuild-estimate";
import { Spinner } from "./icons";

/** Web binding of the shared editor: KbStore state + `kb.configSetAi` save. */
function WebAiEndpointEditor({ section, title, note }: { section: AiSection; title: string; note?: string }) {
  const api = useKbStoreApi();
  const current = useKbStore((s) => s.state.config?.ai?.[section] ?? null);
  const draft = useKbStore((s) => s.state.aiDrafts[section]);
  const busy = useKbStore((s) => s.state.aiBusy === section);

  return (
    <AiEndpointEditor
      section={section}
      title={title}
      note={note}
      current={current}
      draft={draft}
      busy={busy}
      keyPlaceholder="API key — stored in config.toml on your home computer"
      onDraft={(patch) => api.setAiDraft(section, patch)}
      onSave={() => void api.saveAiEndpoint(section)}
      onResetAsk={() => void api.resetAsk()}
    />
  );
}

/**
 * Web rebuild card: same drift warning + cost estimate as the desktop card,
 * fed by `kb.status` (docs/chunks/embedding identity) instead of the Tauri
 * `index_stats` command; the action fires `kb.rebuild` on the home.
 */
function WebRebuildCard() {
  const api = useKbStoreApi();
  const embedding = useKbStore((s) => s.state.config?.ai?.embedding ?? null);
  const status = useKbStore((s) => s.state.status);
  const busy = useKbStore((s) => s.state.rebuildBusy);

  if (!embedding) return null;

  const available = !!status?.available;
  const built = available
    ? `${status?.embeddingProvider || "openai"} · ${status?.embeddingModel || "?"}`
    : null;
  const drift =
    available &&
    (status?.embeddingProvider !== embedding.provider || status?.embeddingModel !== embedding.model);
  const chunks = status?.chunks ?? 0;
  const docs = status?.docs ?? 0;
  const cost = available && chunks > 0 ? estimateReindexCost(chunks, docs, embedding.model) : null;

  return (
    <Section title="Index — rebuild after changing the embedding model">
      <Row label="Built with" value={built ?? "No index yet — run compile first"} />
      {available && <Row label="Size" value={`${docs} docs · ${chunks} chunks`} />}
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
        Runs on your home computer; embedding vectors are model-specific and can’t be reused, so
        changing the model requires re-embedding every note. Your Markdown files are untouched.
        {cost && (
          <>
            {" "}
            Estimated embedding cost: <b>{cost}</b> ({chunks} chunks with {embedding.model}).
            Summaries are regenerated too, billed at the Summary provider’s rate.
          </>
        )}{" "}
        Progress shows on the Status page.
      </p>
      <div className="mt-2 flex justify-end">
        <button
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void api.rebuildIndex()}
        >
          {busy && <Spinner size={13} />}
          {busy ? "Starting…" : "Rebuild & reindex"}
        </button>
      </div>
    </Section>
  );
}

export function WebSettingsView() {
  const api = useKbStoreApi();
  const config = useKbStore((s) => s.state.config);
  const loading = useKbStore((s) => s.state.configLoading);
  const error = useKbStore((s) => s.state.configError);
  const homeName = useKbStore((s) => s.state.homeName);

  useEffect(() => {
    void api.loadConfig();
    // The rebuild card's drift/cost figures come from kb.status.
    void api.loadStatus({ silent: true });
  }, [api]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-5 pb-[max(env(safe-area-inset-bottom),24px)]">
        <h1 className="text-[21px] font-bold tracking-tight text-base-content">Settings</h1>

        {!config && loading && (
          <div className="flex items-center gap-2 rounded-xl border border-base-300 bg-base-200 p-4 text-[13.5px] text-base-content/60">
            <Spinner size={14} />
            Loading settings from {homeName || "your home computer"}…
          </div>
        )}
        {!config && !loading && error && (
          <div className="rounded-xl border border-base-300 bg-base-200 p-4">
            <p className="text-[13.5px] text-base-content/60">
              Couldn’t reach your home computer: {error}
            </p>
            <div className="mt-2 flex justify-end">
              <button
                className="rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90"
                onClick={() => void api.loadConfig()}
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {config && (
          <>
            <Section title="Home computer — your data stays there">
              <Row label="Home" value={homeName || "–"} />
              <Row label="Notes" value={config.notesDir} />
              <Row label="Data root" value={config.root} />
              <Row label="Config" value={config.configPath} />
              <p className="mt-1 text-xs leading-relaxed text-base-content/35">
                These settings live in config.toml on your home computer. Edits made here are
                applied there — keys are write-only and are never sent back to this device.
              </p>
            </Section>

            <WebAiEndpointEditor
              section="embedding"
              title="Embedding — turns notes into search vectors (required)"
              note="Switching provider or model changes the vector space — run “Rebuild & reindex” below afterwards."
            />
            <WebRebuildCard />
            <WebAiEndpointEditor
              section="summary"
              title="Summary — compile-time summaries and categories (required)"
            />
            <WebAiEndpointEditor
              section="ask"
              title="Ask — answers questions over your notes (optional)"
              note="Agents connected over MCP bring their own model; this only powers the built-in Q&A."
            />
          </>
        )}

        <Section title="Appearance">
          <Row label="Theme" value="Follows your system" />
          <p className="text-xs leading-relaxed text-base-content/35">
            Light and dark switch automatically with the OS — there is no manual toggle.
          </p>
        </Section>
      </div>
    </div>
  );
}
