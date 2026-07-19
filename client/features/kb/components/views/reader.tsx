"use client";

/**
 * Reader: read-only DOMD rendering. The read view remounts on
 * (path, readerVersion) so external saves re-render fresh markdown.
 * Editing is NOT done here — Edit hands off to the compose surface
 * (`/new#note=<path>`, see store.editNote): create/edit/update are one form.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { closeHashOverlay, hashHref } from "@/lib/client/hash-route";
import { useKbStore } from "../../store/kb-store";
import { KbMarkdown } from "../domd";
import { IconChevronLeft, IconPencil, IconShare, Spinner } from "../icons";
import { SharePanel } from "../share-panel";

export function ReaderView() {
  const router = useRouter();
  const path = useKbStore((s) => s.state.readerPath);
  const content = useKbStore((s) => s.state.readerContent);
  const version = useKbStore((s) => s.state.readerVersion);
  const loading = useKbStore((s) => s.state.readerLoading);
  const error = useKbStore((s) => s.state.readerError);
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-3 pb-[max(env(safe-area-inset-bottom),32px)]">
        <div className="flex items-center justify-between gap-2">
          <button
            className="-ml-2 flex items-center gap-0.5 rounded-lg p-1.5 pr-2.5 text-[13.5px] font-medium text-base-content/60 transition-colors hover:text-base-content"
            onClick={() => closeHashOverlay()}
          >
            <IconChevronLeft size={16} /> Back
          </button>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-sm rounded-xl btn-soft"
              onClick={() => setShareOpen(true)}
              disabled={loading || !!error}
            >
              <IconShare size={13} /> Share
            </button>
            <button
              className="btn btn-sm rounded-xl btn-soft"
              onClick={() => path && router.push(`/new${hashHref("note", path)}`)}
              disabled={loading || !!error}
            >
              <IconPencil size={13} /> Edit
            </button>
          </div>
        </div>

        <div className="mt-1 truncate font-mono text-[11px] text-base-content/35">{path}</div>

        {loading && (
          <div className="flex justify-center py-16 text-primary">
            <Spinner size={22} />
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-xl border border-base-300 bg-base-200 px-4 py-3 text-[13.5px] text-hk-orange-text">
            {error}
          </div>
        )}

        {!loading && !error && (
          <article className="mt-4">
            <KbMarkdown
              key={`read:${path}#${version}`}
              content={content}
              notePath={path ?? ""}
            />
          </article>
        )}
      </div>

      {shareOpen && path && <SharePanel path={path} onClose={() => setShareOpen(false)} />}
    </div>
  );
}
