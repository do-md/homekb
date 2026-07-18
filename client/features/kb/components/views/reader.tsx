"use client";

/**
 * Reader: read-only DOMD rendering with an in-place WYSIWYG edit mode.
 * The read view remounts on (path, readerVersion) so saves re-render fresh markdown.
 */

import { useRef, useState } from "react";
import { closeHashOverlay } from "@/lib/client/hash-route";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";
import { KbEditor, type KbEditorHandle, KbMarkdown } from "../domd";
import { IconChevronLeft, IconShare, Spinner } from "../icons";
import { SharePanel } from "../share-panel";

export function ReaderView() {
  const api = useKbStoreApi();
  const path = useKbStore((s) => s.state.readerPath);
  const content = useKbStore((s) => s.state.readerContent);
  const version = useKbStore((s) => s.state.readerVersion);
  const loading = useKbStore((s) => s.state.readerLoading);
  const error = useKbStore((s) => s.state.readerError);
  const editMode = useKbStore((s) => s.state.editMode);
  const saveBusy = useKbStore((s) => s.state.saveBusy);
  const editorRef = useRef<KbEditorHandle | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const save = () => {
    const md = editorRef.current?.getMarkdown();
    if (md != null) void api.saveEdit(md);
  };

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
          {!editMode ? (
            <div className="flex items-center gap-2">
              <button
                className="flex items-center gap-1.5 rounded-xl border border-base-300 px-3.5 py-1.5 text-[13px] font-semibold text-base-content/60 transition-colors hover:bg-base-200"
                onClick={() => setShareOpen(true)}
                disabled={loading || !!error}
              >
                <IconShare size={13} /> Share
              </button>
              <button
                className="rounded-xl border border-base-300 px-3.5 py-1.5 text-[13px] font-semibold text-base-content/60 transition-colors hover:bg-base-200"
                onClick={() => api.startEdit()}
                disabled={loading || !!error}
              >
                Edit
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                className="rounded-xl px-3.5 py-1.5 text-[13px] font-semibold text-base-content/45 transition-colors hover:text-base-content/60"
                onClick={() => api.cancelEdit()}
              >
                Cancel
              </button>
              <button
                className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-60"
                onClick={save}
                disabled={saveBusy}
              >
                {saveBusy && <Spinner size={12} />}
                Save
              </button>
            </div>
          )}
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

        {!loading && !error && !editMode && (
          <article className="mt-4">
            <KbMarkdown
              key={`read:${path}#${version}`}
              content={content}
              notePath={path ?? ""}
            />
          </article>
        )}
        {!loading && !error && editMode && (
          <div className="mt-4 rounded-2xl border border-base-300 bg-base-200 p-4 focus-within:border-base-content/30">
            <KbEditor
              key={`edit:${path}#${version}`}
              seed={content}
              notePath={path ?? ""}
              handleRef={editorRef}
              autoFocus
            />
          </div>
        )}
      </div>

      {shareOpen && path && <SharePanel path={path} onClose={() => setShareOpen(false)} />}
    </div>
  );
}
