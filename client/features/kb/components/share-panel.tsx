"use client";

/**
 * Share panel: create a public share link for the note open in the Reader.
 * Bottom sheet on phones, centered card on wider screens; in-app only (no OS
 * dialogs). The engine owns every policy decision (password, expiry,
 * revocation — docs/ARCHITECTURE.md "Note sharing"); this panel is a thin
 * front over `kb.shareCreate` plus a list of this note's existing links.
 *
 * Honest state over optimism: creating requires an active connection-service
 * registration and a reachable home — failures render inline with the engine's
 * actionable message instead of a vague toast.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CreatedShare } from "../type";
import { useKbStore, useKbStoreApi } from "../store/kb-store";
import { IconCopy, IconX, Spinner } from "./icons";

const EXPIRY_CHOICES: { days: number | null }[] = [
  { days: null },
  { days: 1 },
  { days: 7 },
  { days: 30 },
];

function CopyLinkButton({ url }: { url: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; the URL stays visible for manual copy.
    }
  };
  return (
    <button
      className="flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90"
      onClick={copy}
    >
      <IconCopy size={12} /> {copied ? t("common.copied") : t("common.copyLink")}
    </button>
  );
}

export function SharePanel({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useKbStoreApi();
  const shares = useKbStore((s) => s.state.shares);

  const [password, setPassword] = useState("");
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedShare | null>(null);

  // Existing links for this note — created from any surface (CLI, MCP,
  // another client), so refresh the mirror when the panel opens.
  useEffect(() => {
    void api.loadShares({ silent: true });
  }, [api]);
  const existing = shares.filter((s) => s.path === path);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const days = EXPIRY_CHOICES[expiryIdx].days;
      const res = await api.createShare(path, {
        password: password.trim() || undefined,
        expiresDays: days ?? undefined,
      });
      setCreated(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("share.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Backdrop click closes — same dismissal contract as the system back gesture. */}
      <button className="absolute inset-0 bg-black/30" aria-label={t("common.close")} onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-3xl border border-base-300 bg-base-100 p-5 pb-[max(env(safe-area-inset-bottom),20px)] sm:rounded-3xl sm:pb-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-bold tracking-tight text-base-content">
              {t("share.title")}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-base-content/35">{path}</p>
          </div>
          <button
            className="rounded-lg p-1 text-base-content/35 transition-colors hover:text-base-content/60"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <IconX size={16} />
          </button>
        </div>

        {created ? (
          <div className="mt-4">
            <div className="rounded-xl border border-base-300 bg-base-200 p-4">
              <div className="hk-label">{t("share.anyoneWithLink")}</div>
              <div className="mt-2 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-base-content">
                  {created.url}
                </span>
                <CopyLinkButton url={created.url} />
              </div>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-base-content/45">
              {t("share.createdNote")}
            </p>
            <button
              className="mt-4 w-full rounded-xl border border-base-300 px-3.5 py-2 text-[13.5px] font-semibold text-base-content/60 transition-colors hover:bg-base-200"
              onClick={onClose}
            >
              {t("share.done")}
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <label className="hk-label block">{t("share.passwordLabel")}</label>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("share.passwordPlaceholder")}
              autoComplete="off"
              className="mt-1.5 w-full rounded-xl border border-base-300 bg-base-200 px-3 py-2 text-[13.5px] text-base-content placeholder:text-base-content/35 focus:outline-none focus:ring-2 focus:ring-primary/40"
            />

            <div className="mt-3.5 hk-label">{t("share.expiresLabel")}</div>
            <div className="mt-1.5 flex items-center gap-1.5">
              {EXPIRY_CHOICES.map((c, i) => (
                <button
                  key={c.days ?? "never"}
                  onClick={() => setExpiryIdx(i)}
                  className={`rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                    i === expiryIdx
                      ? "bg-primary text-primary-content"
                      : "bg-base-300 text-base-content/60 hover:text-base-content"
                  }`}
                >
                  {c.days === null
                    ? t("share.expiryNever")
                    : t("share.expiryDays", { count: c.days })}
                </button>
              ))}
            </div>

            {error && (
              <div className="mt-3.5 rounded-xl border border-base-300 bg-base-200 px-3 py-2.5 text-[12.5px] text-hk-orange-text">
                {error}
              </div>
            )}

            <button
              className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-3.5 py-2.5 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-60"
              onClick={() => void create()}
              disabled={busy}
            >
              {busy && <Spinner size={13} />}
              {t("share.createButton")}
            </button>

            {existing.length > 0 && (
              <div className="mt-4 border-t border-base-200 pt-3.5">
                <div className="hk-label">{t("share.existingLinks")}</div>
                <div className="mt-2 flex flex-col gap-2">
                  {existing.map((s) => (
                    <div key={s.shareId} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-base-content/45">
                        {s.url ?? s.shareId}
                      </span>
                      {s.hasPassword && (
                        <span className="shrink-0 rounded-full bg-base-300 px-1.5 py-0.5 text-[10.5px] font-semibold text-base-content/60">
                          {t("share.passwordBadge")}
                        </span>
                      )}
                      {s.url && <CopyLinkButton url={s.url} />}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11.5px] text-base-content/35">
                  {t("share.manageHint")}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
