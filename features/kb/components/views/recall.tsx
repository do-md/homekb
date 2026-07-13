"use client";

/**
 * Search / ask views (design 2a entry, 3a answer, 3b skeleton, 3c list, 4a empty states).
 * One ask input, two modes: Answer (default, AI-synthesized + cited notes) and
 * List (whole notes, document-level cards — never fragment chunks).
 */

import type { KbHit } from "../../type";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";
import { Composer, ModeToggle } from "../composer";
import { KbMarkdown } from "../domd";
import {
  IconArrowRight,
  IconChevronRight,
  IconDoc,
  IconDocPlus,
  IconRefresh,
  IconSearch,
  IconSpark,
  Spinner,
} from "../icons";
import { OfflineScreen } from "../offline-screen";

function dateLabel(mtimeSec: number): string {
  return new Date(mtimeSec * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function DocGlyph() {
  return (
    <span className="mt-0.5 flex h-[34px] w-[34px] shrink-0 flex-col justify-center gap-[3px] rounded-[9px] bg-hk-glyph px-2">
      <span className="h-[2px] rounded-full bg-hk-weak" />
      <span className="h-[2px] w-2/3 rounded-full bg-hk-faint" />
      <span className="h-[2px] w-5/6 rounded-full bg-hk-faint" />
    </span>
  );
}

/** Whole-note result card (design NoteItem): title-forward, document-level. */
function NoteItem({ hit, maxScore }: { hit: KbHit; maxScore: number }) {
  const api = useKbStoreApi();
  const pct = maxScore > 0 ? Math.round((hit.score / maxScore) * 100) : 0;
  return (
    <button
      onClick={() => void api.openDoc(hit.path)}
      className="flex w-full flex-col gap-2.5 rounded-2xl border border-hk-border bg-hk-card p-4 text-left transition-colors hover:bg-hk-card-strong"
    >
      <div className="flex items-start gap-3">
        <DocGlyph />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] leading-tight font-semibold tracking-tight text-hk-text">
            {hit.title || hit.path}
          </span>
          <span className="mt-0.5 block truncate text-xs text-hk-weak">{hit.path}</span>
        </span>
        <span className="shrink-0 rounded-full border border-hk-coral-chip-border bg-hk-coral-chip px-2 py-0.5 text-[11.5px] font-semibold text-hk-coral-text tabular-nums">
          {pct}%
        </span>
      </div>
      <p className="line-clamp-2 text-[13.5px] leading-relaxed text-hk-text-2">{hit.content}</p>
      <div className="flex items-center gap-2 text-xs text-hk-faint">
        {hit.docType && (
          <span className="rounded-[7px] border border-hk-hairline bg-hk-card-strong px-2 py-0.5 font-medium text-hk-text-2">
            {hit.docType}
          </span>
        )}
        <span>{dateLabel(hit.mtime)}</span>
        {(hit.matches ?? 0) > 1 && (
          <>
            <span className="h-[3px] w-[3px] rounded-full bg-hk-faint" />
            <span>{hit.matches} matching sections</span>
          </>
        )}
        <span className="ml-auto flex items-center gap-1 font-medium text-hk-weak">
          Open <IconArrowRight size={13} />
        </span>
      </div>
    </button>
  );
}

/** Answer skeleton while retrieving (design 3b) — shimmer bars, quiet motion. */
function AnswerSkeleton() {
  return (
    <div>
      <div className="flex items-center gap-2 text-[13px] text-hk-text-2">
        <span className="text-hk-coral-text">
          <Spinner size={14} />
        </span>
        Reading your notes to write your answer…
      </div>
      <div className="mt-3 rounded-2xl border border-hk-border bg-hk-card p-4">
        <div className="flex flex-col gap-2.5">
          {[100, 92, 96, 60].map((w, i) => (
            <span
              key={i}
              className="hk-shimmer block h-3 rounded bg-hk-pill"
              style={{ width: `${w}%`, animationDelay: `${i * 0.12}s` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Answer result (design 3a): flat neutral card; coral only on the label + chips. */
function AnswerResult() {
  const api = useKbStoreApi();
  const answer = useKbStore((s) => s.state.answer);
  const answerMs = useKbStore((s) => s.state.answerMs);
  if (!answer) return null;
  const secs = answerMs != null ? `${(answerMs / 1000).toFixed(1)}s` : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-hk-border bg-hk-card p-4">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-hk-coral-text uppercase">
          <IconSpark size={13} strokeWidth={1.5} />
          Answer
        </div>
        <KbMarkdown content={answer.answer} notePath="" className="mt-2" />
        <div className="mt-3 border-t border-hk-hairline pt-2.5 text-xs text-hk-faint">
          from {answer.citations?.length ?? 0} of your notes
          {secs ? ` · ${secs}` : ""}
        </div>
      </div>

      {(answer.citations?.length ?? 0) > 0 && (
        <div>
          <div className="hk-label">Based on your notes</div>
          <div className="mt-2 flex flex-col">
            {answer.citations.map((c, i) => (
              <button
                key={c.path}
                onClick={() => void api.openDoc(c.path)}
                className={`flex items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-hk-card-soft ${
                  i > 0 ? "border-t border-hk-hairline" : ""
                }`}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-hk-coral-chip text-[11px] font-semibold text-hk-coral-text">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-hk-text">
                    {c.title || c.path}
                  </span>
                  <span className="block truncate text-xs text-hk-weak">{c.path}</span>
                </span>
                <IconChevronRight size={14} className="shrink-0 text-hk-weak" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** List result (design 3c): docType chips + count + document cards. */
function ListResult() {
  const api = useKbStoreApi();
  const hits = useKbStore((s) => s.state.hits);
  const filtered = useKbStore((s) => s.filteredHits);
  const typeFilter = useKbStore((s) => s.state.typeFilter);

  const types = Array.from(new Set(hits.map((h) => h.docType ?? "other")));
  const maxScore = hits.reduce((m, h) => Math.max(m, h.score), 0);

  return (
    <div className="flex flex-col gap-3">
      {types.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {[null, ...types].map((t) => {
            const active = typeFilter === t;
            return (
              <button
                key={t ?? "__all"}
                onClick={() => api.setTypeFilter(t)}
                className={`rounded-full px-3 py-1 text-[12.5px] font-medium transition-colors ${
                  active
                    ? "bg-hk-pill font-semibold text-hk-heading"
                    : "border border-hk-hairline text-hk-weak hover:text-hk-text-2"
                }`}
              >
                {t ?? "All"}
              </button>
            );
          })}
        </div>
      )}
      <div className="text-xs text-hk-faint">
        {filtered.length} {filtered.length === 1 ? "note" : "notes"} · By relevance
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {filtered.map((h, i) => (
          <NoteItem key={`${h.path}-${i}`} hit={h} maxScore={maxScore} />
        ))}
      </div>
    </div>
  );
}

/** No search results (design 4a bottom). */
function NoResults() {
  const api = useKbStoreApi();
  const q = useKbStore((s) => s.state.submittedQuery);
  const mode = useKbStore((s) => s.state.mode);
  return (
    <div className="flex flex-col items-center py-14 text-center">
      <IconSearch size={26} className="text-hk-faint" />
      <div className="mt-3 text-[16px] font-semibold text-hk-heading">No notes matched</div>
      <p className="mt-1.5 max-w-xs text-[13.5px] leading-relaxed text-hk-text-2">
        Nothing in your library matches &ldquo;{q}&rdquo; — try different words
        {mode === "list" ? ", or ask it as a question." : "."}
      </p>
      {mode === "list" && (
        <button
          onClick={() => api.setMode("answer")}
          className="mt-4 text-[14px] font-semibold text-hk-coral-text hover:text-hk-coral-hover"
        >
          Ask as a question instead
        </button>
      )}
    </div>
  );
}

/** Empty knowledge base / new user (design 4a top). */
function EmptyLibrary() {
  const api = useKbStoreApi();
  const paths: [string, React.ReactNode][] = [
    [
      "Add Markdown files",
      <>
        Drop <code className="font-mono text-[12px]">.md</code> files into{" "}
        <code className="font-mono text-[12px]">~/.homekb/notes</code> on your home computer.
      </>,
    ],
    ["Write one here", "Start with the New note tab — the first line becomes the title."],
    ["Let Claude write", "Connect Claude over MCP and it can save what you learn together."],
  ];
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-2 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-hk-border bg-hk-card text-hk-weak">
        <IconDocPlus size={24} strokeWidth={1.4} />
      </span>
      <h1 className="mt-5 text-[22px] font-bold tracking-tight text-hk-heading">
        Your knowledge base is empty
      </h1>
      <p className="mt-2 text-[14.5px] text-hk-text-2">Three ways to add your first notes:</p>
      <div className="mt-5 w-full rounded-2xl border border-hk-border bg-hk-card p-4 text-left">
        <div className="flex flex-col gap-3.5">
          {paths.map(([title, desc], i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-hk-coral-chip text-[11px] font-semibold text-hk-coral-text">
                {i + 1}
              </span>
              <span>
                <span className="block text-[14px] font-semibold text-hk-text">{title}</span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-hk-text-2">
                  {desc}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <button
        onClick={() => api.composeNew()}
        className="mt-5 w-full rounded-xl bg-hk-coral px-4 py-3 text-[15px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover"
      >
        New note
      </button>
    </div>
  );
}

/** Library-health strip on the entry screen (design 2a). */
function HealthStrip() {
  const api = useKbStoreApi();
  const status = useKbStore((s) => s.state.status);
  if (!status || !status.docs) return null;
  const chunks = status.chunks ?? 0;
  const vectorized = status.chunksWithVectors ?? 0;
  const pct = chunks > 0 ? Math.round((vectorized / chunks) * 100) : 0;
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-hk-border bg-hk-card-soft px-4 py-3">
      <span className="text-[13px] text-hk-text-2">
        <span className="font-semibold text-hk-text tabular-nums">{status.docs}</span> docs
      </span>
      <span className="text-[13px] text-hk-text-2">
        <span className="font-semibold text-hk-text tabular-nums">{chunks}</span> chunks ·{" "}
        <span className="tabular-nums">{pct}%</span> vectorized
      </span>
      {status.lastCompileAt ? (
        <span className="hidden text-[13px] text-hk-faint sm:inline">
          indexed {dateLabel(status.lastCompileAt)}
        </span>
      ) : null}
      <button
        onClick={() => void api.reindex()}
        className="ml-auto flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-hk-weak transition-colors hover:text-hk-text-2"
      >
        <IconRefresh size={12} /> Reindex
      </button>
    </div>
  );
}

/** Entry screen body (design 2a): Try asking + health + Recently opened. */
function EntryBody() {
  const api = useKbStoreApi();
  const suggestions = useKbStore((s) => s.state.suggestions);
  const recentDocs = useKbStore((s) => s.state.recentDocs);

  return (
    <div className="flex flex-col gap-6">
      {suggestions.length > 0 && (
        <div>
          <div className="hk-label">Try asking</div>
          <div className="mt-2 flex flex-col gap-2">
            {suggestions.map((s) => (
              <button
                key={s.path}
                onClick={() => api.askSuggestion(s.question)}
                className="flex items-center gap-3 rounded-2xl border border-hk-border bg-hk-card px-4 py-3 text-left transition-colors hover:bg-hk-card-strong"
              >
                <span className="text-hk-coral-text">
                  <IconSpark size={14} strokeWidth={1.5} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-hk-text">{s.question}</span>
                  <span className="mt-0.5 block truncate text-xs text-hk-weak">
                    {s.title || s.path}
                  </span>
                </span>
                <IconChevronRight size={14} className="shrink-0 text-hk-weak" />
              </button>
            ))}
          </div>
        </div>
      )}

      <HealthStrip />

      {recentDocs.length > 0 && (
        <div>
          <div className="hk-label">Recently opened</div>
          <div className="mt-2 flex flex-col">
            {recentDocs.map((doc, i) => (
              <button
                key={doc.path}
                onClick={() => void api.openDoc(doc.path)}
                className={`flex items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-hk-card-soft ${
                  i > 0 ? "border-t border-hk-hairline" : ""
                }`}
              >
                <IconDoc size={15} className="shrink-0 text-hk-weak" strokeWidth={1.5} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-hk-text">
                  {doc.title || doc.path}
                </span>
                <span className="shrink-0 text-xs text-hk-faint">{dateLabel(doc.mtime)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function RecallView() {
  const api = useKbStoreApi();
  const connState = useKbStore((s) => s.connState);
  const mode = useKbStore((s) => s.state.mode);
  const phase = useKbStore((s) => s.state.phase);
  const submittedQuery = useKbStore((s) => s.state.submittedQuery);
  const hits = useKbStore((s) => s.state.hits);
  const answer = useKbStore((s) => s.state.answer);
  const searchError = useKbStore((s) => s.state.searchError);
  const status = useKbStore((s) => s.state.status);

  // Offline escalates to a full action screen (design 4b); composer goes muted.
  if (connState === "offline") {
    return (
      <>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <OfflineScreen />
        </div>
        <Composer
          variant="entry"
          muted
          mutedPlaceholder="Home is offline — reconnect to ask"
        />
      </>
    );
  }

  const emptyLibrary = phase === "idle" && status != null && (status.docs ?? 0) === 0;
  const hasResults = phase === "done" && (mode === "answer" ? answer != null : hits.length > 0);
  const noResults =
    phase === "done" && !searchError && !hasResults && submittedQuery.length > 0;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-4">
          {submittedQuery ? (
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex items-start justify-between gap-3">
                  <h1 className="text-[21px] leading-snug font-bold tracking-tight text-hk-heading">
                    {submittedQuery}
                  </h1>
                  <button
                    onClick={() => api.clearSearch()}
                    className="mt-1 shrink-0 text-xs font-medium text-hk-weak transition-colors hover:text-hk-text-2"
                  >
                    Clear
                  </button>
                </div>
                <div className="mt-2.5">
                  <ModeToggle />
                </div>
              </div>

              {searchError && (
                <div className="rounded-xl border border-hk-border bg-hk-card px-4 py-3 text-[13.5px] text-hk-orange-text">
                  {searchError}
                </div>
              )}

              {phase === "searching" &&
                (mode === "answer" ? (
                  <AnswerSkeleton />
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="hk-shimmer block h-24 rounded-2xl bg-hk-card"
                        style={{ animationDelay: `${i * 0.12}s` }}
                      />
                    ))}
                  </div>
                ))}

              {phase === "done" && mode === "answer" && answer && <AnswerResult />}
              {phase === "done" && mode === "list" && hits.length > 0 && <ListResult />}
              {noResults && <NoResults />}
            </div>
          ) : emptyLibrary ? (
            <EmptyLibrary />
          ) : (
            <EntryBody />
          )}
        </div>
      </div>
      <Composer
        variant={submittedQuery ? "followup" : "entry"}
        muted={emptyLibrary}
        mutedPlaceholder="Add a few notes, then ask anything…"
      />
    </>
  );
}
