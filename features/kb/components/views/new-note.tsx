"use client";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";

export function NewNoteView() {
  const api = useKbStoreApi();
  const title = useKbStore((s) => s.state.newTitle);
  const text = useKbStore((s) => s.state.newText);
  const busy = useKbStore((s) => s.state.newBusy);
  const savedPath = useKbStore((s) => s.state.newSavedPath);
  const error = useKbStore((s) => s.state.newError);

  return (
    <div className="flex flex-col gap-3">
      <input
        value={title}
        onChange={(e) => api.setNewTitle(e.target.value)}
        placeholder="标题（可选，决定文件名）"
        className="input input-bordered w-full"
      />
      <textarea
        value={text}
        onChange={(e) => api.setNewText(e.target.value)}
        placeholder="Markdown 内容…"
        className="textarea textarea-bordered min-h-[50dvh] w-full font-mono text-sm"
      />
      {error && <div className="alert alert-error text-sm">{error}</div>}
      {savedPath && (
        <div className="alert alert-success text-sm">
          已入库：<code>{savedPath}</code>
        </div>
      )}
      <button
        className="btn btn-primary"
        disabled={busy || !text.trim()}
        onClick={() => void api.createNote()}
      >
        {busy ? <span className="loading loading-spinner loading-sm" /> : "入库"}
      </button>
    </div>
  );
}
