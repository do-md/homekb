"use client";

/**
 * Settings (design 7a, desktop only): engine, data directory, AI providers
 * ([embedding]/[summary]/[ask] — docs "AI provider presets"), appearance.
 * Remote access lives in its own Remote tab (7b), not here.
 * Card sections with monospace values; green dots only for "running/configured".
 */

import { useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Spinner, StatusDot } from "@/features/kb/components/icons";
import {
  AiEndpointEditor,
  SettingsRow as Row,
  SettingsSection as Section,
} from "@/features/kb/components/ai-endpoint-editor";
import type { AiSection } from "@/lib/client/desktop";
import { estimateReindexCost } from "@/features/kb/components/rebuild-estimate";
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

/** Rebuild card: drift warning + cost estimate + one-click rebuild → reindex. */
function RebuildIndexCard() {
  const { t } = useTranslation();
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
    <Section title={t("desktop.settings.index.title")}>
      <Row label={t("desktop.settings.index.builtWith")} value={built ?? t("desktop.settings.index.noIndex")} />
      {stats?.available && (
        <Row
          label={t("desktop.settings.index.size")}
          value={`${t("desktop.settings.index.docsCount", { count: stats.docs })} · ${t("desktop.settings.index.chunksCount", { count: stats.chunks })}`}
        />
      )}
      {drift && (
        <p className="mt-1 rounded-lg bg-primary/10 px-3 py-2 text-xs leading-relaxed text-primary">
          <Trans
            i18nKey="desktop.settings.index.drift"
            values={{ config: `${embedding.provider} · ${embedding.model}`, built }}
            components={{ b: <b /> }}
          />
        </p>
      )}
      <p className="mt-1 text-xs leading-relaxed text-base-content/35">
        {t("desktop.settings.index.explain")}
        {cost && (
          <>
            {" "}
            <Trans
              i18nKey="desktop.settings.index.costNote"
              count={stats!.chunks}
              values={{ cost, model: embedding.model }}
              components={{ b: <b /> }}
            />
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
          {rebuilding ? t("desktop.settings.index.reindexing") : t("desktop.settings.index.rebuildButton")}
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
  const { t } = useTranslation();
  const api = useDesktopStoreApi();
  const appVersion = useDesktopStore((s) => s.state.appVersion);
  const updateReady = useDesktopStore((s) => s.state.updateReady);
  const busy = useDesktopStore((s) => s.state.updateBusy);

  return (
    <Section title={t("desktop.updater.title")}>
      <Row label={t("desktop.settings.version")} value={appVersion ?? "–"} />
      {updateReady && (
        <Row
          label={t("desktop.updater.ready")}
          value={t("desktop.updater.readyValue", { version: updateReady })}
        />
      )}
      <p className="mt-1 text-xs leading-relaxed text-base-content/35">
        {t("desktop.updater.note")}
      </p>
      <div className="mt-2 flex justify-end">
        <button
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void (updateReady ? api.restartToUpdate() : api.checkForUpdate(true))}
        >
          {busy && <Spinner size={13} />}
          {updateReady
            ? t("desktop.updater.restartToUpdate")
            : busy
              ? t("desktop.settings.checking")
              : t("desktop.updater.checkForUpdates")}
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
  const { t } = useTranslation();
  const api = useDesktopStoreApi();
  const engine = useDesktopStore((s) => s.state.engine);
  const engineLatest = useDesktopStore((s) => s.state.engineLatest);
  const busy = useDesktopStore((s) => s.state.engineUpdateBusy);

  return (
    <Section title={t("desktop.settings.engine.title")}>
      <Row label={t("desktop.settings.version")} value={engine?.version ?? t("desktop.settings.engine.unknown")} />
      <Row label={t("desktop.settings.engine.binary")} value={engine?.path ?? t("desktop.settings.engine.notInstalled")} />
      <Row
        label={t("desktop.settings.engine.localService")}
        value={
          engine?.serveRunning ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-success">
                <StatusDot className="h-1.5! w-1.5!" />
              </span>
              {t("desktop.settings.engine.running")}
            </span>
          ) : (
            t("desktop.settings.engine.notRunning")
          )
        }
      />
      {engineLatest && <Row label={t("desktop.settings.engine.available")} value={engineLatest} />}
      <div className="mt-2 flex justify-end">
        <button
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void (engineLatest ? api.updateEngine() : api.checkEngineUpdate())}
        >
          {busy && <Spinner size={13} />}
          {engineLatest
            ? busy
              ? t("desktop.settings.engine.updating")
              : t("desktop.settings.engine.updateTo", { version: engineLatest })
            : busy
              ? t("desktop.settings.checking")
              : t("desktop.settings.engine.checkUpdates")}
        </button>
      </div>
    </Section>
  );
}

/** Desktop-only Settings view: engine + directories + AI providers + appearance. */
export function SettingsView() {
  const { t } = useTranslation();
  const api = useDesktopStoreApi();
  const engine = useDesktopStore((s) => s.state.engine);

  useEffect(() => {
    void api.refreshEngine();
  }, [api]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-5 pb-[max(env(safe-area-inset-bottom),24px)]">
        <h1 className="text-[21px] font-bold tracking-tight text-base-content">{t("common.settings")}</h1>

        <EngineCard />

        <AppUpdatesCard />

        <Section title={t("desktop.settings.data.title")}>
          <Row label={t("desktop.settings.data.notes")} value={engine?.notesDir ?? "–"} />
          <Row label={t("desktop.settings.data.root")} value={engine?.root ?? "–"} />
          <Row label={t("desktop.settings.data.config")} value={engine?.configPath ?? "–"} />
        </Section>

        <DesktopAiEndpointEditor
          section="embedding"
          title={t("desktop.settings.ai.embeddingTitle")}
          note={t("desktop.settings.ai.embeddingNote")}
        />
        <RebuildIndexCard />
        <DesktopAiEndpointEditor
          section="summary"
          title={t("desktop.settings.ai.summaryTitle")}
        />
        <DesktopAiEndpointEditor
          section="ask"
          title={t("desktop.settings.ai.askTitle")}
          note={t("desktop.settings.ai.askNote")}
        />

        <Section title={t("desktop.settings.appearance.title")}>
          <Row label={t("desktop.settings.appearance.theme")} value={t("desktop.settings.appearance.followsSystem")} />
          <p className="text-xs leading-relaxed text-base-content/35">
            {t("desktop.settings.appearance.note")}
          </p>
        </Section>
      </div>
      <DesktopNotice />
    </div>
  );
}
