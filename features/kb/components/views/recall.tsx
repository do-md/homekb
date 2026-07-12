"use client";
import type { KbHit } from "../../type";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";

function HitCard({ hit }: { hit: KbHit }) {
  const api = useKbStoreApi();
  return (
    <button
      onClick={() => void api.openDoc(hit.path)}
      className="card bg-base-200 hover:bg-base-300 w-full text-left transition-colors"
    >
      <div className="card-body gap-1 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-semibold">{hit.title || hit.path}</span>
          {hit.docType && <span className="badge badge-ghost badge-sm shrink-0">{hit.docType}</span>}
        </div>
        {hit.headingPath && (
          <div className="truncate text-xs opacity-50">{hit.headingPath}</div>
        )}
        <p className="line-clamp-3 text-sm opacity-70">{hit.content}</p>
      </div>
    </button>
  );
}

export function RecallView() {
  const api = useKbStoreApi();
  const query = useKbStore((s) => s.state.query);
  const mode = useKbStore((s) => s.state.mode);
  const phase = useKbStore((s) => s.state.phase);
  const hits = useKbStore((s) => s.state.hits);
  const answer = useKbStore((s) => s.state.answer);
  const searchError = useKbStore((s) => s.state.searchError);
  const recentDocs = useKbStore((s) => s.state.recentDocs);

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void api.search();
        }}
      >
        <input
          value={query}
          onChange={(e) => api.setQuery(e.target.value)}
          placeholder="问点什么，或搜索关键词…"
          className="input input-bordered w-full"
          enterKeyHint="search"
        />
        <button type="submit" className="btn btn-primary shrink-0" disabled={phase === "searching"}>
          {phase === "searching" ? <span className="loading loading-spinner loading-sm" /> : "搜索"}
        </button>
      </form>

      <div role="tablist" className="tabs tabs-box tabs-sm w-fit">
        <button
          role="tab"
          className={`tab ${mode === "list" ? "tab-active" : ""}`}
          onClick={() => api.setMode("list")}
        >
          命中列表
        </button>
        <button
          role="tab"
          className={`tab ${mode === "answer" ? "tab-active" : ""}`}
          onClick={() => api.setMode("answer")}
        >
          综合答案
        </button>
      </div>

      {searchError && <div className="alert alert-error text-sm">{searchError}</div>}

      {mode === "answer" && answer && (
        <div className="card bg-base-200">
          <div className="card-body p-4">
            <p className="text-sm whitespace-pre-wrap">{answer.answer}</p>
            {answer.citations?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {answer.citations.map((c) => (
                  <button
                    key={c.path}
                    className="badge badge-outline badge-sm"
                    onClick={() => void api.openDoc(c.path)}
                  >
                    {c.title || c.path}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {phase === "done" && hits.length === 0 && !searchError && (
        <p className="py-8 text-center text-sm opacity-50">没有找到相关内容</p>
      )}

      {hits.length > 0 && (
        <div className="flex flex-col gap-2">
          {hits.map((h, i) => (
            <HitCard key={`${h.path}-${i}`} hit={h} />
          ))}
        </div>
      )}

      {phase === "idle" && recentDocs.length > 0 && (
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase opacity-50">最近更新</h2>
          <ul className="menu bg-base-200 w-full rounded-lg">
            {recentDocs.map((doc) => (
              <li key={doc.path}>
                <button onClick={() => void api.openDoc(doc.path)} className="justify-between">
                  <span className="truncate">{doc.title || doc.path}</span>
                  <span className="text-xs opacity-40">
                    {new Date(doc.mtime * 1000).toLocaleDateString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
