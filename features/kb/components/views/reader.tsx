"use client";

/**
 * Reader: read-only DOMD rendering with an in-place WYSIWYG edit mode.
 * The read view remounts on (path, readerVersion) so saves re-render fresh markdown.
 */

import { useRef } from "react";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";
import { KbEditor, type KbEditorHandle, KbMarkdown } from "../domd";
import { IconChevronLeft, Spinner } from "../icons";

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

  const save = () => {
    const md = editorRef.current?.getMarkdown();
    if (md != null) void api.saveEdit(md);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-3 pb-[max(env(safe-area-inset-bottom),32px)]">
        <div className="flex items-center justify-between gap-2">
          <button
            className="-ml-2 flex items-center gap-0.5 rounded-lg p-1.5 pr-2.5 text-[13.5px] font-medium text-hk-text-2 transition-colors hover:text-hk-text"
            onClick={() => api.go("recall")}
          >
            <IconChevronLeft size={16} /> Back
          </button>
          {!editMode ? (
            <button
              className="rounded-xl border border-hk-border px-3.5 py-1.5 text-[13px] font-semibold text-hk-text-2 transition-colors hover:bg-hk-card"
              onClick={() => api.startEdit()}
              disabled={loading || !!error}
            >
              Edit
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                className="rounded-xl px-3.5 py-1.5 text-[13px] font-semibold text-hk-weak transition-colors hover:text-hk-text-2"
                onClick={() => api.cancelEdit()}
              >
                Cancel
              </button>
              <button
                className="flex items-center gap-1.5 rounded-xl bg-hk-coral px-3.5 py-1.5 text-[13px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-60"
                onClick={save}
                disabled={saveBusy}
              >
                {saveBusy && <Spinner size={12} />}
                Save
              </button>
            </div>
          )}
        </div>

        <div className="mt-1 truncate font-mono text-[11px] text-hk-faint">{path}</div>

        {loading && (
          <div className="flex justify-center py-16 text-hk-coral-text">
            <Spinner size={22} />
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-xl border border-hk-border bg-hk-card px-4 py-3 text-[13.5px] text-hk-orange-text">
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
          <div className="mt-4 rounded-2xl border border-hk-input-border bg-hk-card-soft p-4 focus-within:border-hk-input-focus">
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
    </div>
  );
}
