"use client";

/**
 * Shares management tab: every public share link this home is serving.
 * Records are engine-owned truth on the home machine (`~/.homekb/shares.json`,
 * docs/ARCHITECTURE.md "Note sharing") — the relay only routes, so this list is
 * a live mirror fetched via `kb.shareList`. Each row's copy action uses the
 * engine-composed `url`, which always points at the *current* connection
 * service (fresh links keep working after a service switch; links distributed
 * before the switch embed the old service and die — that is inherent, and the
 * fix is copying the fresh link from here).
 *
 * Revoke asks for confirmation in-app (never an OS dialog) and kills the link
 * instantly — the engine record is the source of truth.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { hashHref } from "@/lib/client/hash-route";
import type { ShareMeta } from "../../type";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";
import { IconCopy, IconShare, IconX, Spinner } from "../icons";

function agoLabel(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function expiryLabel(expiresAt: number): { text: string; expired: boolean } {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return { text: "expired", expired: true };
  const days = Math.ceil(ms / 86_400_000);
  return { text: days === 1 ? "expires in 1 day" : `expires in ${days} days`, expired: false };
}

function ShareItem({ share }: { share: ShareMeta }) {
  const api = useKbStoreApi();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  const title = share.title || share.path;
  const expiry = share.expiresAt ? expiryLabel(share.expiresAt) : null;

  const copy = async () => {
    if (!share.url) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; the URL is still visible in the row.
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-2xl bg-base-200 p-4">
      <span className="mt-0.5 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-base-200 text-primary">
        <IconShare size={15} strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <button
          className="block w-full truncate text-left text-[15px] font-semibold tracking-tight text-base-content"
          onClick={() => router.push(`/search${hashHref("doc", share.path)}`)}
        >
          {title}
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-base-content/35">
          <span>created {agoLabel(share.createdAt)}</span>
          {share.hasPassword && (
            <>
              <span className="h-[3px] w-[3px] rounded-full bg-base-content/30" />
              <span>password</span>
            </>
          )}
          {expiry && (
            <>
              <span className="h-[3px] w-[3px] rounded-full bg-base-content/30" />
              <span className={expiry.expired ? "font-semibold text-warning" : ""}>
                {expiry.text}
              </span>
            </>
          )}
        </div>
        {share.url ? (
          <div className="mt-2 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-base-content/45">
              {share.url}
            </span>
            <button
              className="btn btn-soft btn-xs rounded-md"
              onClick={copy}
            >
              <IconCopy size={11} /> {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        ) : (
          <div className="mt-2 text-[11.5px] text-base-content/45">
            No link — the home isn&apos;t registered with a connection service.
          </div>
        )}
      </div>
      {confirming ? (
        <button
          className="shrink-0 rounded-lg bg-primary px-2.5 py-1 text-[12px] font-semibold text-primary-content"
          onClick={() => void api.revokeShare(share.shareId)}
          onBlur={() => setConfirming(false)}
        >
          Revoke?
        </button>
      ) : (
        <button
          className="btn btn-ghost btn-xs rounded-full"
          onClick={() => setConfirming(true)}
          aria-label="Revoke share"
        >
          <IconX size={14} />
        </button>
      )}
    </div>
  );
}

export function SharesView() {
  const shares = useKbStore((s) => s.state.shares);
  const loaded = useKbStore((s) => s.state.sharesLoaded);
  const loading = useKbStore((s) => s.state.sharesLoading);
  const error = useKbStore((s) => s.state.sharesError);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-5 pb-[max(env(safe-area-inset-bottom),24px)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-[21px] font-bold tracking-tight text-base-content">Shared notes</h1>
            <p className="mt-1 text-[12.5px] text-base-content/45">
              Served live from your home machine — nothing is stored anywhere else.
            </p>
          </div>
          {shares.length > 0 && (
            <span className="mt-1 rounded-full bg-base-300 px-2 py-0.5 text-[11.5px] font-semibold text-base-content/60 tabular-nums">
              {shares.length}
            </span>
          )}
        </div>

        {loading && !loaded ? (
          <div className="flex justify-center py-16 text-primary">
            <Spinner size={22} />
          </div>
        ) : error ? (
          <div className="mt-4 rounded-xl border border-base-300 bg-base-200 px-4 py-3 text-[13.5px] text-hk-orange-text">
            {error}
          </div>
        ) : shares.length === 0 ? (
          <div className="mt-10 flex flex-col items-center gap-2 py-8 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-base-200 text-primary">
              <IconShare size={19} strokeWidth={1.5} />
            </span>
            <p className="text-[14.5px] font-semibold text-base-content">No active shares</p>
            <p className="max-w-[300px] text-[12.5px] leading-relaxed text-base-content/45">
              Open a note and tap Share to create a public link — with an optional password and
              expiry.
            </p>
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-3">
            {shares.map((s) => (
              <ShareItem key={s.shareId} share={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
