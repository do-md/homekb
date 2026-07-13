"use client";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";

export function ReaderView() {
  const api = useKbStoreApi();
  const path = useKbStore((s) => s.state.readerPath);
  const content = useKbStore((s) => s.state.readerContent);
  const loading = useKbStore((s) => s.state.readerLoading);
  const error = useKbStore((s) => s.state.readerError);
  const editMode = useKbStore((s) => s.state.editMode);
  const editText = useKbStore((s) => s.state.editText);
  const saveBusy = useKbStore((s) => s.state.saveBusy);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <button className="btn btn-ghost btn-sm" onClick={() => api.go("recall")}>
          ← Back
        </button>
        {!editMode ? (
          <button className="btn btn-sm" onClick={() => api.startEdit()} disabled={loading || !!error}>
            Edit
          </button>
        ) : (
          <div className="flex gap-2">
            <button className="btn btn-ghost btn-sm" onClick={() => api.cancelEdit()}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void api.saveEdit()}
              disabled={saveBusy}
            >
              {saveBusy ? <span className="loading loading-spinner loading-xs" /> : "Save"}
            </button>
          </div>
        )}
      </div>

      <div className="truncate font-mono text-xs opacity-40">{path}</div>

      {loading && (
        <div className="py-12 text-center">
          <span className="loading loading-spinner" />
        </div>
      )}
      {error && <div className="alert alert-error text-sm">{error}</div>}

      {!loading && !error && !editMode && (
        <article className="bg-base-200 rounded-lg p-4 text-sm leading-relaxed whitespace-pre-wrap">
          {content}
        </article>
      )}
      {editMode && (
        <textarea
          value={editText}
          onChange={(e) => api.setEditText(e.target.value)}
          className="textarea textarea-bordered min-h-[60dvh] w-full font-mono text-sm"
        />
      )}
    </div>
  );
}
