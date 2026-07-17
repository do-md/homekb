"use client";

/**
 * Drafts collection (design 5b): in-progress notes kept on the home device
 * (`~/.homekb/drafts/`) until saved to the library — shared across every paired
 * device, not stored per-browser. Focused mode (no pill nav); centered single
 * column. Deleting asks for confirmation in-app (never an OS dialog).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { hashHref } from "@/lib/client/hash-route";
import type { Draft } from "../../type";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";
import { titleFromMarkdown } from "../domd";
import { IconChevronLeft, IconChevronRight, IconPencil, IconPlus, IconX } from "../icons";

function agoLabel(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function wordCount(text: string): number {
  const cjk = text.match(/[一-鿿぀-ヿ]/g)?.length ?? 0;
  const words = text
    .replace(/[一-鿿぀-ヿ]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + words;
}

/** Body preview: the draft minus its title line. */
function previewText(text: string): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim().length > 0);
  return lines
    .slice(i + 1)
    .join(" ")
    .replace(/[#>*`_\-[\]()!]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function DraftItem({ draft }: { draft: Draft }) {
  const api = useKbStoreApi();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const title = titleFromMarkdown(draft.text) || "Untitled";
  const preview = previewText(draft.text);

  return (
    <div className="flex items-start gap-3 rounded-2xl border border-hk-border bg-hk-card p-4">
      <span className="mt-0.5 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-hk-glyph text-hk-coral-text">
        <IconPencil size={15} strokeWidth={1.5} />
      </span>
      <button
        className="min-w-0 flex-1 text-left"
        onClick={() => router.push(`/new${hashHref("draft", draft.id)}`)}
      >
        <span className="block truncate text-[15px] font-semibold tracking-tight text-hk-text">
          {title}
        </span>
        {preview && (
          <span className="mt-1 line-clamp-2 block text-[13px] leading-relaxed text-hk-text-2">
            {preview}
          </span>
        )}
        <span className="mt-1.5 flex items-center gap-2 text-xs text-hk-faint">
          <span>edited {agoLabel(draft.editedAt)}</span>
          <span className="h-[3px] w-[3px] rounded-full bg-hk-faint" />
          <span>{wordCount(draft.text)} words</span>
          <span className="ml-auto flex items-center gap-0.5 font-semibold text-hk-coral-text">
            Resume <IconChevronRight size={13} />
          </span>
        </span>
      </button>
      {confirming ? (
        <button
          className="shrink-0 rounded-lg bg-hk-coral px-2.5 py-1 text-[12px] font-semibold text-hk-on-coral"
          onClick={() => api.deleteDraft(draft.id)}
          onBlur={() => setConfirming(false)}
        >
          Delete?
        </button>
      ) : (
        <button
          className="shrink-0 rounded-lg p-1 text-hk-faint transition-colors hover:text-hk-text-2"
          onClick={() => setConfirming(true)}
          aria-label="Delete draft"
        >
          <IconX size={14} />
        </button>
      )}
    </div>
  );
}

export function DraftsView() {
  const api = useKbStoreApi();
  const router = useRouter();
  const drafts = useKbStore((s) => s.state.drafts);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="bg-hk-bg pt-safe-top border-b border-hk-hairline">
        <div className="mx-auto flex h-12 max-w-3xl items-center gap-2 px-3">
          <button
            className="-ml-1 flex items-center rounded-lg p-1.5 text-hk-text-2 transition-colors hover:text-hk-text"
            onClick={() => {
              api.composeResume();
              router.push("/new");
            }}
            aria-label="Back"
          >
            <IconChevronLeft size={18} />
          </button>
          <span className="text-[15px] font-semibold text-hk-heading">Drafts</span>
          {drafts.length > 0 && (
            <span className="rounded-full bg-hk-pill px-2 py-0.5 text-[11.5px] font-semibold text-hk-text-2 tabular-nums">
              {drafts.length}
            </span>
          )}
          <button
            className="ml-auto flex items-center gap-1.5 rounded-xl bg-hk-coral px-3 py-1.5 text-[13px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover"
            onClick={() => {
              api.composeNew();
              router.push("/new");
            }}
          >
            <IconPlus size={13} strokeWidth={2} /> New note
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-4 py-4 pb-[max(env(safe-area-inset-bottom),24px)]">
          <p className="text-[12.5px] text-hk-weak">
            Kept on your computer and shared across your devices until you save
            them to your library.
          </p>
          {drafts.length === 0 ? (
            <div className="flex flex-col items-center py-14 text-center">
              <IconPencil size={22} className="text-hk-faint" />
              <p className="mt-3 text-[14px] text-hk-text-2">No drafts yet</p>
              <p className="mt-1 text-[12.5px] text-hk-faint">
                Anything you write but don&apos;t save shows up here.
              </p>
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-2.5">
              {drafts.map((d) => (
                <DraftItem key={d.id} draft={d} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
