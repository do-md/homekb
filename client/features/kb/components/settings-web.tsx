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
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
      keyPlaceholder={t("settingsWeb.aiKeyPlaceholder")}
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
  const { t } = useTranslation();
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
    <Section title={t("rebuild.title")}>
      <Row label={t("rebuild.builtWith")} value={built ?? t("rebuild.noIndexYet")} />
      {available && (
        <Row
          label={t("rebuild.size")}
          value={`${t("rebuild.docsCount", { count: docs })} · ${t("rebuild.chunksCount", { count: chunks })}`}
        />
      )}
      {drift && (
        <p className="mt-1 rounded-lg bg-primary/10 px-3 py-2 text-xs leading-relaxed text-primary">
          <Trans
            i18nKey="rebuild.driftWarning"
            values={{ next: `${embedding.provider} · ${embedding.model}`, built }}
            components={{ b: <b /> }}
          />
        </p>
      )}
      <p className="mt-1 text-xs leading-relaxed text-base-content/35">
        {t("rebuild.bodyWeb")}
        {cost && (
          <>
            {" "}
            <Trans
              i18nKey="rebuild.estimate"
              count={chunks}
              values={{ cost, model: embedding.model }}
              components={{ b: <b /> }}
            />
          </>
        )}{" "}
        {t("rebuild.progressNote")}
      </p>
      <div className="mt-2 flex justify-end">
        <button
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void api.rebuildIndex()}
        >
          {busy && <Spinner size={13} />}
          {busy ? t("rebuild.starting") : t("rebuild.action")}
        </button>
      </div>
    </Section>
  );
}

export function WebSettingsView() {
  const { t } = useTranslation();
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
        <h1 className="text-[21px] font-bold tracking-tight text-base-content">
          {t("common.settings")}
        </h1>

        {!config && loading && (
          <div className="flex items-center gap-2 rounded-xl border border-base-300 bg-base-200 p-4 text-[13.5px] text-base-content/60">
            <Spinner size={14} />
            {t("settingsWeb.loadingFrom", { home: homeName || t("settingsWeb.yourHomeComputer") })}
          </div>
        )}
        {!config && !loading && error && (
          <div className="rounded-xl border border-base-300 bg-base-200 p-4">
            <p className="text-[13.5px] text-base-content/60">
              {t("settingsWeb.unreachable", { error })}
            </p>
            <div className="mt-2 flex justify-end">
              <button
                className="rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90"
                onClick={() => void api.loadConfig()}
              >
                {t("common.retry")}
              </button>
            </div>
          </div>
        )}

        {config && (
          <>
            <Section title={t("settingsWeb.homeSection.title")}>
              <Row label={t("settingsWeb.homeSection.home")} value={homeName || "–"} />
              <Row label={t("settingsWeb.homeSection.notes")} value={config.notesDir} />
              <Row label={t("settingsWeb.homeSection.dataRoot")} value={config.root} />
              <Row label={t("settingsWeb.homeSection.config")} value={config.configPath} />
              <p className="mt-1 text-xs leading-relaxed text-base-content/35">
                {t("settingsWeb.homeSection.note")}
              </p>
            </Section>

            <WebAiEndpointEditor
              section="embedding"
              title={t("settingsWeb.embedding.title")}
              note={t("settingsWeb.embedding.note")}
            />
            <WebRebuildCard />
            <WebAiEndpointEditor section="summary" title={t("settingsWeb.summary.title")} />
            <WebAiEndpointEditor
              section="ask"
              title={t("settingsWeb.ask.title")}
              note={t("settingsWeb.ask.note")}
            />
          </>
        )}

        <Section title={t("settingsWeb.appearance.title")}>
          <Row
            label={t("settingsWeb.appearance.theme")}
            value={t("settingsWeb.appearance.followsSystem")}
          />
          <p className="text-xs leading-relaxed text-base-content/35">
            {t("settingsWeb.appearance.note")}
          </p>
        </Section>
      </div>
    </div>
  );
}
