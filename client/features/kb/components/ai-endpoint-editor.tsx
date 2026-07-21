"use client";

/**
 * Shared AI endpoint editor + Settings card primitives — one visual
 * implementation for both Settings surfaces (docs "Settings over RPC"):
 * the desktop binds it to the DesktopStore (Tauri `config_set_ai_endpoint`),
 * the web binds it to the KbStore (`kb.configGet` / `kb.configSetAi` RPC).
 * Purely presentational: state and persistence come in via props.
 */

import { useTranslation } from "react-i18next";
import { Spinner, StatusDot } from "./icons";
import type { AiSection } from "@/lib/client/desktop";

// Mirrors the engine preset table (docs "AI provider presets"). deepseek is
// chat-only (no embeddings API); qwen = Alibaba DashScope compatible mode.
export const EMBEDDING_PROVIDERS = ["openai", "gemini", "voyage", "cohere", "qwen", "custom"] as const;
export const CHAT_PROVIDERS = ["openai", "gemini", "deepseek", "qwen", "custom"] as const;

export const settingsInputCls =
  "min-w-0 flex-1 rounded-xl border border-base-300 bg-transparent px-3 py-2 font-mono text-[13px] text-base-content outline-none placeholder:text-base-content/45 focus:border-base-content/30";

/** One endpoint as summarized by `engine_status` / `kb.configGet` (masked — never a key). */
export interface AiEndpointInfo {
  provider: string;
  model: string;
  keyPresent: boolean;
  /** Whether the section exists in config.toml ([ask]: false = summary fallback). */
  configured: boolean;
}

/** In-flight edits of one section before save. All strings (form state). */
export interface AiEndpointDraft {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  dim: string;
}

export const emptyAiEndpointDraft = (): AiEndpointDraft => ({
  provider: "",
  apiKey: "",
  model: "",
  baseUrl: "",
  dim: "",
});

export function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-base-300 bg-base-200 p-4">
      <div className="hk-label">{title}</div>
      <div className="mt-3 flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

export function SettingsRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[13.5px]">
      <span className="shrink-0 text-base-content/45">{label}</span>
      <span className="truncate text-right font-mono text-[12px] text-base-content/60">{value}</span>
    </div>
  );
}

/** One [embedding]/[summary]/[ask] editor: provider select + key/model (+ custom fields). */
export function AiEndpointEditor({
  section,
  title,
  note,
  current,
  draft,
  busy,
  keyPlaceholder,
  onDraft,
  onSave,
  onResetAsk,
}: {
  section: AiSection;
  title: string;
  note?: string;
  current: AiEndpointInfo | null;
  draft: AiEndpointDraft;
  busy: boolean;
  /** Override for the API key placeholder (surface-specific storage wording). */
  keyPlaceholder?: string;
  onDraft: (patch: Partial<AiEndpointDraft>) => void;
  onSave: () => void;
  /** Delete [ask] — back to the summary fallback (ask section only). */
  onResetAsk?: () => void;
}) {
  const { t } = useTranslation();
  const isAsk = section === "ask";
  const providers = section === "embedding" ? EMBEDDING_PROVIDERS : CHAT_PROVIDERS;
  // Unconfigured means unconfigured (docs): an unconfigured section starts
  // with NO provider selected — the engine's effective default (openai) is a
  // fill-in, never an active choice, and must not be presented as one.
  // "" on ask = summary fallback (deletes the section on save).
  const provider = draft.provider || (current?.configured ? (current?.provider ?? "openai") : "");
  const fallbackActive = isAsk && provider === "";
  const unchosen = !isAsk && provider === "";
  const dirty =
    draft.apiKey.trim() !== "" ||
    draft.model.trim() !== "" ||
    draft.baseUrl.trim() !== "" ||
    draft.dim.trim() !== "" ||
    (draft.provider !== "" &&
      (!current?.configured || draft.provider !== (current?.provider ?? "openai")));

  return (
    <SettingsSection title={title}>
      <SettingsRow
        label={t("aiEndpoint.current")}
        value={
          fallbackActive ? (
            t("aiEndpoint.usesSummary")
          ) : !current?.configured ? (
            t("aiEndpoint.notConfigured")
          ) : current?.keyPresent ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-success">
                <StatusDot className="h-1.5! w-1.5!" />
              </span>
              {current.provider} · {current.model}
            </span>
          ) : (
            t("aiEndpoint.keyMissing", { provider: current?.provider ?? "openai" })
          )
        }
      />
      <div className="mt-1.5 flex flex-col gap-2">
        <select
          className={settingsInputCls}
          value={provider}
          onChange={(e) => onDraft({ provider: e.target.value })}
        >
          {isAsk && <option value="">{t("aiEndpoint.sameAsSummary")}</option>}
          {!isAsk && !current?.configured && (
            <option value="" disabled>
              {t("aiEndpoint.chooseProvider")}
            </option>
          )}
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {!fallbackActive && !unchosen && (
          <>
            <input
              type="password"
              className={settingsInputCls}
              placeholder={
                current?.configured && draft.provider === ""
                  ? t("aiEndpoint.keyKeepPlaceholder")
                  : (keyPlaceholder ?? t("aiEndpoint.keyDefaultPlaceholder"))
              }
              value={draft.apiKey}
              onChange={(e) => onDraft({ apiKey: e.target.value })}
              autoComplete="off"
            />
            <input
              type="text"
              className={settingsInputCls}
              placeholder={
                provider === "custom"
                  ? t("aiEndpoint.modelPlaceholderCustom")
                  : t("aiEndpoint.modelPlaceholderDefault")
              }
              value={draft.model}
              onChange={(e) => onDraft({ model: e.target.value })}
              autoComplete="off"
            />
            {provider === "custom" && (
              <input
                type="text"
                className={settingsInputCls}
                placeholder={t("aiEndpoint.baseUrlPlaceholder")}
                value={draft.baseUrl}
                onChange={(e) => onDraft({ baseUrl: e.target.value })}
                autoComplete="off"
              />
            )}
            {provider === "custom" && section === "embedding" && (
              <input
                type="text"
                inputMode="numeric"
                className={settingsInputCls}
                placeholder={t("aiEndpoint.dimPlaceholder")}
                value={draft.dim}
                onChange={(e) => onDraft({ dim: e.target.value })}
                autoComplete="off"
              />
            )}
          </>
        )}
        <div className="flex items-center justify-between gap-2">
          {note ? <p className="text-xs leading-relaxed text-base-content/35">{note}</p> : <span />}
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-50"
            disabled={busy || unchosen || (fallbackActive ? !current?.configured : !dirty)}
            onClick={() => void (fallbackActive ? onResetAsk?.() : onSave())}
          >
            {busy && <Spinner size={13} />}
            {t("aiEndpoint.save")}
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}
