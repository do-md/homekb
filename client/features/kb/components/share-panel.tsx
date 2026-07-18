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
import type { CreatedShare } from "../type";
import { useKbStore, useKbStoreApi } from "../store/kb-store";
import { IconCopy, IconX, Spinner } from "./icons";

const EXPIRY_CHOICES: { label: string; days: number | null }[] = [
  { label: "Never", days: null },
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

function CopyLinkButton({ url }: { url: string }) {
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
      <IconCopy size={12} /> {copied ? "Copied" : "Copy link"}
    </button>
  );
}

export function SharePanel({ path, onClose }: { path: string; onClose: () => void }) {
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
      setError(e instanceof Error ? e.message : "Failed to create the share link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Backdrop click closes — same dismissal contract as the system back gesture. */}
      <button className="absolute inset-0 bg-black/30" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-3xl border border-base-300 bg-base-100 p-5 pb-[max(env(safe-area-inset-bottom),20px)] sm:rounded-3xl sm:pb-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-bold tracking-tight text-base-content">
              Share this note
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-base-content/35">{path}</p>
          </div>
          <button
            className="rounded-lg p-1 text-base-content/35 transition-colors hover:text-base-content/60"
            onClick={onClose}
            aria-label="Close"
          >
            <IconX size={16} />
          </button>
        </div>

        {created ? (
          <div className="mt-4">
            <div className="rounded-2xl border border-base-300 bg-base-200 p-4">
              <div className="hk-label">Anyone with this link can read the note</div>
              <div className="mt-2 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-base-content">
                  {created.url}
                </span>
                <CopyLinkButton url={created.url} />
              </div>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-base-content/45">
              Served live from your home machine — the link works while it&apos;s online, and
              revoking it (Shares tab) kills it instantly.
            </p>
            <button
              className="mt-4 w-full rounded-xl border border-base-300 px-3.5 py-2 text-[13.5px] font-semibold text-base-content/60 transition-colors hover:bg-base-200"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <label className="hk-label block">Password (optional)</label>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave empty for link-only access"
              autoComplete="off"
              className="mt-1.5 w-full rounded-xl border border-base-300 bg-base-200 px-3 py-2 text-[13.5px] text-base-content placeholder:text-base-content/35 focus:outline-none focus:ring-2 focus:ring-primary/40"
            />

            <div className="mt-3.5 hk-label">Expires</div>
            <div className="mt-1.5 flex items-center gap-1.5">
              {EXPIRY_CHOICES.map((c, i) => (
                <button
                  key={c.label}
                  onClick={() => setExpiryIdx(i)}
                  className={`rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                    i === expiryIdx
                      ? "bg-primary text-primary-content"
                      : "bg-base-300 text-base-content/60 hover:text-base-content"
                  }`}
                >
                  {c.label}
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
              Create share link
            </button>

            {existing.length > 0 && (
              <div className="mt-4 border-t border-base-200 pt-3.5">
                <div className="hk-label">Existing links for this note</div>
                <div className="mt-2 flex flex-col gap-2">
                  {existing.map((s) => (
                    <div key={s.shareId} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-base-content/45">
                        {s.url ?? s.shareId}
                      </span>
                      {s.hasPassword && (
                        <span className="shrink-0 rounded-full bg-base-300 px-1.5 py-0.5 text-[10.5px] font-semibold text-base-content/60">
                          password
                        </span>
                      )}
                      {s.url && <CopyLinkButton url={s.url} />}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11.5px] text-base-content/35">
                  Manage or revoke them in the Shares tab.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
