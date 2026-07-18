"use client";

/**
 * Search / ask views (design 2a entry, 3c list, 4a empty states) with progressive
 * delivery (docs/ARCHITECTURE.md "First-paint batch"): the note list is ALWAYS the
 * top surface and paints as soon as the vector search lands (the early `hits`
 * frame — no LLM in that path); a three-stage strip (search → analyze → answer)
 * tracks the pipeline; when the engine decides to answer, the answer streams into
 * a compact fixed-height dock above the composer (no auto-scroll) with an expand
 * control that opens the full answer as a `#answer=1` hash overlay (system back
 * closes it). "Answer with AI instead" on list/empty results is the misroute
 * escape hatch.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { type AiStatus, isDesktop } from "@/lib/client/desktop";
import { closeHashOverlay, pushHash, useHashParam } from "@/lib/client/hash-route";
import {
  useDesktopStore,
  useDesktopStoreApi,
} from "@/features/desktop/store/desktop-store";
import type { KbHit } from "../../type";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";
import { Composer } from "../composer";
import { KbStreamingAnswer } from "../domd";
import {
  IconArrowRight,
  IconCheck,
  IconChevronRight,
  IconDoc,
  IconDocPlus,
  IconExpand,
  IconRefresh,
  IconSearch,
  IconSliders,
  IconSpark,
  IconX,
  Spinner,
  StatusDot,
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
    <span className="mt-0.5 flex h-[34px] w-[34px] shrink-0 flex-col justify-center gap-[3px] rounded-[9px] bg-base-200 px-2">
      <span className="h-[2px] rounded-full bg-base-content/40" />
      <span className="h-[2px] w-2/3 rounded-full bg-base-content/30" />
      <span className="h-[2px] w-5/6 rounded-full bg-base-content/30" />
    </span>
  );
}

/** Whole-note result card (design NoteItem): title-forward, document-level. */
function NoteItem({ hit, maxScore }: { hit: KbHit; maxScore: number }) {
  const pct = maxScore > 0 ? Math.round((hit.score / maxScore) * 100) : 0;
  return (
    <button
      onClick={() => pushHash("doc", hit.path)}
      className="flex w-full flex-col gap-2.5 rounded-2xl border border-base-300 bg-base-200 p-4 text-left transition-colors hover:bg-base-300"
    >
      <div className="flex items-start gap-3">
        <DocGlyph />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] leading-tight font-semibold tracking-tight text-base-content">
            {hit.title || hit.path}
          </span>
          <span className="mt-0.5 block truncate text-xs text-base-content/45">{hit.path}</span>
        </span>
        <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[11.5px] font-semibold text-primary tabular-nums">
          {pct}%
        </span>
      </div>
      <p className="line-clamp-2 text-[13.5px] leading-relaxed text-base-content/60">{hit.content}</p>
      <div className="flex items-center gap-2 text-xs text-base-content/35">
        {hit.docType && (
          <span className="rounded-[7px] border border-base-200 bg-base-300 px-2 py-0.5 font-medium text-base-content/60">
            {hit.docType}
          </span>
        )}
        <span>{dateLabel(hit.mtime)}</span>
        {(hit.matches ?? 0) > 1 && (
          <>
            <span className="h-[3px] w-[3px] rounded-full bg-base-content/30" />
            <span>{hit.matches} matching sections</span>
          </>
        )}
        <span className="ml-auto flex items-center gap-1 font-medium text-base-content/45">
          Open <IconArrowRight size={13} />
        </span>
      </div>
    </button>
  );
}

/** Note-card shimmers while the first-paint batch is still in flight. */
function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="hk-shimmer block h-24 rounded-2xl bg-base-200"
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </div>
  );
}

const STAGES = [
  ["searching", "Search"],
  ["thinking", "Analyze"],
  ["answering", "Answer"],
] as const;

/** Progressive-pipeline indicator (docs "First-paint batch"): which stage the
 *  submit is in — vector search → query analysis (LLM router) → answer
 *  synthesis. Hidden once the terminal frame lands (results speak). */
function StageStrip() {
  const stage = useKbStore((s) => s.state.stage);
  if (!stage) return null;
  const activeIdx = STAGES.findIndex(([key]) => key === stage);
  return (
    <div className="flex items-center gap-2 text-[12px]">
      {STAGES.map(([key, label], i) => {
        const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "pending";
        return (
          <span key={key} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-4 bg-base-300" />}
            <span
              className={`flex items-center gap-1.5 font-medium ${
                state === "active"
                  ? "text-primary"
                  : state === "done"
                    ? "text-base-content/60"
                    : "text-base-content/35"
              }`}
            >
              {state === "done" ? (
                <IconCheck size={11} strokeWidth={2.5} />
              ) : state === "active" ? (
                <Spinner size={11} />
              ) : (
                <span className="h-1 w-1 rounded-full bg-current" />
              )}
              {label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Wrap inline `[n]` citation markers (n within the citation count) in clickable
 * primary chips after DOMD has rendered. DOM post-processing: the read-only DOMD
 * renders once per mount (remounted per answer), so the mutation is stable.
 */
function decorateCitationRefs(root: HTMLElement, citationCount: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (/\[\d+\]/.test(t.data) && !t.parentElement?.closest("code, pre, .hk-cite-ref")) {
      targets.push(t);
    }
  }
  for (const t of targets) {
    const frag = document.createDocumentFragment();
    const re = /\[(\d+)\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = re.exec(t.data))) {
      const n = parseInt(m[1], 10);
      if (n < 1 || n > citationCount) continue;
      any = true;
      frag.appendChild(document.createTextNode(t.data.slice(last, m.index)));
      const chip = document.createElement("span");
      chip.className = "hk-cite-ref";
      chip.dataset.cite = String(n);
      chip.setAttribute("role", "button");
      chip.setAttribute("tabindex", "0");
      chip.textContent = String(n);
      frag.appendChild(chip);
      last = m.index + m[0].length;
    }
    if (!any) continue;
    frag.appendChild(document.createTextNode(t.data.slice(last)));
    t.replaceWith(frag);
  }
}

/** Decorate inline [n] markers once streaming completes (rAF lets DOMD commit
 *  the final insertText before we walk its DOM). Shared by dock + overlay. */
function useCitationChips(
  ref: React.RefObject<HTMLDivElement | null>,
  writing: boolean,
  citationCount: number,
) {
  useEffect(() => {
    if (writing || !ref.current || citationCount === 0) return;
    const raf = requestAnimationFrame(() => {
      if (ref.current) decorateCitationRefs(ref.current, citationCount);
    });
    return () => cancelAnimationFrame(raf);
  }, [ref, writing, citationCount]);
}

function citationChipOf(target: EventTarget | null): number | null {
  const chip = target instanceof Element ? target.closest<HTMLElement>(".hk-cite-ref") : null;
  const n = chip ? parseInt(chip.dataset.cite ?? "", 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Compact answer dock, pinned above the composer: the answer streams here as real
 * Markdown (store → DOMD insertText) inside a FIXED max height with no auto-scroll
 * — the text quietly grows below the fold; the user scrolls if they want to. The
 * top-right expand control opens the full answer as a `#answer=1` hash overlay.
 * Inline [n] chips (post-stream) open the cited note directly.
 */
function AnswerDock() {
  const answer = useKbStore((s) => s.state.answer);
  const answerMs = useKbStore((s) => s.state.answerMs);
  const phase = useKbStore((s) => s.state.phase);
  const bodyRef = useRef<HTMLDivElement>(null);
  const writing = phase === "streaming";
  const citationCount = answer?.citations?.length ?? 0;
  useCitationChips(bodyRef, writing, citationCount);

  const openCited = (target: EventTarget | null) => {
    const n = citationChipOf(target);
    const cited = n != null ? answer?.citations?.[n - 1] : undefined;
    if (cited) pushHash("doc", cited.path);
  };

  const secs = answerMs != null ? `${(answerMs / 1000).toFixed(1)}s` : null;

  return (
    <div className="px-4">
      <div className="shadow-sm mx-auto w-full max-w-2xl rounded-2xl border border-base-300 bg-base-200">
        <div className="flex items-center gap-1.5 px-4 pt-3 text-[12px] font-semibold tracking-wide text-primary uppercase">
          {writing ? (
            <>
              <Spinner size={12} />
              Writing…
            </>
          ) : (
            <>
              <IconSpark size={13} strokeWidth={1.5} />
              Answer
            </>
          )}
          {!writing && secs && (
            <span className="ml-1 font-normal tracking-normal text-base-content/35 normal-case">
              from {citationCount} {citationCount === 1 ? "note" : "notes"} · {secs}
            </span>
          )}
          <button
            onClick={() => pushHash("answer", "1")}
            aria-label="Expand answer"
            className="btn btn-ghost btn-xs ml-auto -mr-2 text-base-content/45 hover:text-base-content"
          >
            <IconExpand size={14} />
          </button>
        </div>
        <div
          ref={bodyRef}
          className="hk-answer max-h-44 overflow-y-auto px-4 pb-3"
          onClick={(e) => openCited(e.target)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") openCited(e.target);
          }}
        >
          <KbStreamingAnswer className="mt-1.5" />
        </div>
      </div>
    </div>
  );
}

/**
 * Full-screen answer detail (`#answer=1` hash overlay — system back closes it).
 * Rendered INSTEAD of the dock while open (one live DOMD editor at a time; a
 * mid-stream expand remounts it and the store backfills the text so far).
 * Inline [n] chips jump to the citation rows; rows open the cited note.
 */
function AnswerOverlay() {
  const answer = useKbStore((s) => s.state.answer);
  const answerMs = useKbStore((s) => s.state.answerMs);
  const phase = useKbStore((s) => s.state.phase);
  const submittedQuery = useKbStore((s) => s.state.submittedQuery);
  const bodyRef = useRef<HTMLDivElement>(null);
  const writing = phase === "streaming";
  const citationCount = answer?.citations?.length ?? 0;
  useCitationChips(bodyRef, writing, citationCount);

  const jumpToCitation = (target: EventTarget | null) => {
    const n = citationChipOf(target);
    if (n == null) return;
    const row = document.getElementById(`answer-cite-${n}`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.remove("hk-cite-flash");
    // Restart the flash animation even when re-clicking the same chip.
    void row.offsetWidth;
    row.classList.add("hk-cite-flash");
  };

  const secs = answerMs != null ? `${(answerMs / 1000).toFixed(1)}s` : null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-base-100">
      <div className="flex items-start gap-3 px-4 pt-[max(env(safe-area-inset-top),16px)] pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-primary uppercase">
            {writing ? <Spinner size={12} /> : <IconSpark size={13} strokeWidth={1.5} />}
            {writing ? "Writing…" : "Answer"}
          </div>
          <h1 className="mt-1 truncate text-[17px] leading-snug font-bold tracking-tight text-base-content">
            {submittedQuery}
          </h1>
        </div>
        <button
          onClick={() => closeHashOverlay()}
          aria-label="Close"
          className="btn btn-ghost btn-sm btn-circle text-base-content/60"
        >
          <IconX size={18} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(env(safe-area-inset-bottom),16px)]">
        <div className="mx-auto w-full max-w-2xl">
          <div
            ref={bodyRef}
            className="hk-answer"
            onClick={(e) => jumpToCitation(e.target)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") jumpToCitation(e.target);
            }}
          >
            <KbStreamingAnswer />
          </div>
          {!writing && (
            <div className="mt-3 border-t border-base-200 pt-2.5 text-xs text-base-content/35">
              from {citationCount} of your notes
              {secs ? ` · ${secs}` : ""}
            </div>
          )}
          {answer && citationCount > 0 && (
            <div className="mt-5 pb-6">
              <div className="hk-label">Based on your notes</div>
              <div className="mt-2 flex flex-col">
                {answer.citations.map((c, i) => (
                  <button
                    key={c.path}
                    id={`answer-cite-${i + 1}`}
                    onClick={() => pushHash("doc", c.path)}
                    className={`flex items-center gap-3 rounded-lg px-1 py-2.5 text-left transition-colors hover:bg-base-200 ${
                      i > 0 ? "border-t border-base-200" : ""
                    }`}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-base-content">
                        {c.title || c.path}
                      </span>
                      <span className="block truncate text-xs text-base-content/45">{c.path}</span>
                    </span>
                    <IconChevronRight size={14} className="shrink-0 text-base-content/45" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The note list (design 3c): docType chips + count + document cards — ALWAYS
 *  the top surface, painted from the first-paint batch and refined by the
 *  routed outcome (replaced wholesale; cards key by path so unchanged notes
 *  don't re-render). "Answer with AI" appears only on a terminal list — the
 *  escape hatch when the user actually wanted a synthesized answer. */
function ListResult() {
  const api = useKbStoreApi();
  const hits = useKbStore((s) => s.state.hits);
  const filtered = useKbStore((s) => s.filteredHits);
  const typeFilter = useKbStore((s) => s.state.typeFilter);
  const resultKind = useKbStore((s) => s.state.resultKind);
  const phase = useKbStore((s) => s.state.phase);
  const terminalList = resultKind === "list" && phase === "done";

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
                    ? "bg-base-300 font-semibold text-base-content"
                    : "border border-base-200 text-base-content/45 hover:text-base-content/60"
                }`}
              >
                {t ?? "All"}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-between text-xs text-base-content/35">
        <span>
          {filtered.length} {filtered.length === 1 ? "note" : "notes"} · By relevance
        </span>
        {terminalList && (
          <button
            onClick={() => api.answerInstead()}
            className="btn btn-ghost btn-xs gap-1 font-semibold text-primary"
          >
            <IconSpark size={12} strokeWidth={1.5} /> Answer with AI
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {filtered.map((h) => (
          <NoteItem key={h.path} hit={h} maxScore={maxScore} />
        ))}
      </div>
    </div>
  );
}

/** No search results (design 4a bottom). A list-kind empty offers the answer
 *  escape hatch — the AI reads more widely than the visible match list. */
function NoResults() {
  const api = useKbStoreApi();
  const q = useKbStore((s) => s.state.submittedQuery);
  const resultKind = useKbStore((s) => s.state.resultKind);
  return (
    <div className="flex flex-col items-center py-14 text-center">
      <IconSearch size={26} className="text-base-content/35" />
      <div className="mt-3 text-[16px] font-semibold text-base-content">No notes matched</div>
      <p className="mt-1.5 max-w-xs text-[13.5px] leading-relaxed text-base-content/60">
        Nothing in your library matches &ldquo;{q}&rdquo; — try different words
        {resultKind === "list" ? ", or ask the AI to answer." : "."}
      </p>
      {resultKind === "list" && (
        <button
          onClick={() => api.answerInstead()}
          className="btn btn-ghost btn-sm mt-4 gap-1.5 font-semibold text-primary"
        >
          <IconSpark size={14} strokeWidth={1.5} /> Answer with AI instead
        </button>
      )}
    </div>
  );
}

/** Desktop-only 4a extras: the real notes path + an "Open HomeKB folder" ghost action. */
function DesktopNotesDir() {
  const notesDir = useDesktopStore((s) => s.state.engine?.notesDir);
  return (
    <code className="font-mono text-[12px]">{notesDir || "~/.homekb/notes"}</code>
  );
}

function DesktopOpenFolder() {
  const api = useDesktopStoreApi();
  return (
    <button
      onClick={() => void api.openNotesDir()}
      className="mt-2.5 w-full rounded-xl border border-base-300 px-4 py-3 text-[15px] font-semibold text-base-content/60 transition-colors hover:bg-base-200"
    >
      Open HomeKB folder
    </button>
  );
}

/** Empty knowledge base / new user (design 4a top). */
function EmptyLibrary() {
  const api = useKbStoreApi();
  const router = useRouter();
  const desktop = isDesktop();
  const paths: [string, React.ReactNode][] = [
    [
      "Add Markdown files",
      <>
        Drop <code className="font-mono text-[12px]">.md</code> files into{" "}
        {desktop ? (
          <DesktopNotesDir />
        ) : (
          <code className="font-mono text-[12px]">~/.homekb/notes</code>
        )}{" "}
        on your home computer.
      </>,
    ],
    ["Write one here", "Start with the New note tab — the first line becomes the title."],
    ["Let Claude write", "Connect Claude over MCP and it can save what you learn together."],
  ];
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-2 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-base-300 bg-base-200 text-base-content/45">
        <IconDocPlus size={24} strokeWidth={1.4} />
      </span>
      <h1 className="mt-5 text-[22px] font-bold tracking-tight text-base-content">
        Your knowledge base is empty
      </h1>
      <p className="mt-2 text-[14.5px] text-base-content/60">Three ways to add your first notes:</p>
      <div className="mt-5 w-full rounded-2xl border border-base-300 bg-base-200 p-4 text-left">
        <div className="flex flex-col gap-3.5">
          {paths.map(([title, desc], i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {i + 1}
              </span>
              <span>
                <span className="block text-[14px] font-semibold text-base-content">{title}</span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-base-content/60">
                  {desc}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <button
        onClick={() => {
          api.composeNew();
          router.push("/new");
        }}
        className="mt-5 w-full rounded-xl bg-primary px-4 py-3 text-[15px] font-semibold text-primary-content transition-colors hover:bg-primary/90"
      >
        New note
      </button>
      {desktop && <DesktopOpenFolder />}
    </div>
  );
}

/**
 * First-run AI setup guide (desktop only). HomeKB can neither compile nor
 * retrieve until both REQUIRED endpoints — [embedding] and [summary] — carry a
 * key, so this supersedes the empty-library guide: adding notes before the keys
 * exist would only pile up un-indexable files. Keys are configured on this
 * machine (Settings → config.toml), so the guide points straight there.
 */
function AiSetupGuide({ ai }: { ai: AiStatus }) {
  const router = useRouter();
  const items: { title: string; desc: string; ok: boolean }[] = [
    {
      title: "Embedding key",
      desc: "Turns your notes into the search vectors every query runs against.",
      ok: ai.embedding.keyPresent,
    },
    {
      title: "Summary key",
      desc: "Writes each note's summary and category when the index is built.",
      ok: ai.summary.keyPresent,
    },
  ];
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-2 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-base-300 bg-base-200 text-primary">
        <IconSpark size={24} strokeWidth={1.5} />
      </span>
      <h1 className="mt-5 text-[22px] font-bold tracking-tight text-base-content">
        Add your AI keys to get started
      </h1>
      <p className="mt-2 text-[14.5px] text-base-content/60">
        HomeKB uses AI to make your notes searchable. It needs two keys before it can index
        anything — both stay on this computer.
      </p>
      <div className="mt-5 w-full rounded-2xl border border-base-300 bg-base-200 p-4 text-left">
        <div className="flex flex-col gap-3.5">
          {items.map(({ title, desc, ok }) => (
            <div key={title} className="flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                  ok ? "bg-success/15 text-success" : "bg-primary/10 text-primary"
                }`}
              >
                {ok ? <IconCheck size={12} strokeWidth={2.5} /> : <StatusDot className="h-1.5! w-1.5!" />}
              </span>
              <span>
                <span className="flex items-center gap-2 text-[14px] font-semibold text-base-content">
                  {title}
                  <span
                    className={`text-[11px] font-medium ${ok ? "text-success" : "text-base-content/45"}`}
                  >
                    {ok ? "Configured" : "Required"}
                  </span>
                </span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-base-content/60">
                  {desc}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-4 text-[12.5px] leading-relaxed text-base-content/35">
        Your keys live in <code className="font-mono text-[12px]">config.toml</code> on this
        machine. Nothing — keys or notes — ever leaves your computer.
      </p>
      <button
        onClick={() => router.push("/settings")}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-[15px] font-semibold text-primary-content transition-colors hover:bg-primary/90"
      >
        <IconSliders size={16} strokeWidth={1.8} /> Set up in Settings
      </button>
    </div>
  );
}

/**
 * Empty-state router. On desktop the AI-setup guide takes priority over the
 * empty-library guide (no keys → nothing can be indexed anyway); everywhere
 * else, and once both keys exist, it falls back to the add-your-first-notes
 * guide. The desktop branch is isolated in its own component so `useDesktopStore`
 * is only ever called when the desktop provider is mounted.
 */
function EmptyState() {
  return isDesktop() ? <DesktopEmptyState /> : <EmptyLibrary />;
}

function DesktopEmptyState() {
  const api = useDesktopStoreApi();
  const ai = useDesktopStore((s) => s.state.engine?.ai ?? null);
  // Re-read the engine on mount so keys added via Settings/CLI while the app was
  // open clear the guide the next time this screen is shown.
  useEffect(() => {
    void api.refreshEngine();
  }, [api]);
  if (ai && (!ai.embedding.keyPresent || !ai.summary.keyPresent)) return <AiSetupGuide ai={ai} />;
  return <EmptyLibrary />;
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
    <div className="flex items-center gap-4 rounded-2xl bg-base-200 px-4 py-3">
      <span className="text-[13px] text-base-content/60">
        <span className="font-semibold text-base-content tabular-nums">{status.docs}</span> docs
      </span>
      <span className="text-[13px] text-base-content/60">
        <span className="font-semibold text-base-content tabular-nums">{chunks}</span> chunks ·{" "}
        <span className="tabular-nums">{pct}%</span> vectorized
      </span>
      {status.lastCompileAt ? (
        <span className="hidden text-[13px] text-base-content/35 sm:inline">
          indexed {dateLabel(status.lastCompileAt)}
        </span>
      ) : null}
      <button
        onClick={() => void api.reindex()}
        className="ml-auto flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-base-content/45 transition-colors hover:text-base-content/60"
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
  const openedDocs = useKbStore((s) => s.state.openedDocs);

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
                className="flex items-center gap-3 rounded-2xl bg-base-200 px-4 py-3 text-left transition-colors hover:bg-base-300"
              >
                <span className="text-primary">
                  <IconSpark size={14} strokeWidth={1.5} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-base-content">{s.question}</span>
                  <span className="mt-0.5 block truncate text-xs text-base-content/45">
                    {s.title || s.path}
                  </span>
                </span>
                <IconChevronRight size={14} className="shrink-0 text-base-content/45" />
              </button>
            ))}
          </div>
        </div>
      )}

      <HealthStrip />

      {/* Genuine open history when it exists (design 2a "Recently opened");
          a fresh device falls back to the recently *updated* list from kb.list. */}
      {(openedDocs.length > 0 || recentDocs.length > 0) && (
        <div>
          <div className="hk-label">
            {openedDocs.length > 0 ? "Recently opened" : "Recently updated"}
          </div>
          <div className="mt-2 flex flex-col">
            {(openedDocs.length > 0
              ? openedDocs.map((d) => ({
                  path: d.path,
                  title: d.title,
                  mtimeSec: Math.round(d.at / 1000),
                }))
              : recentDocs.map((d) => ({ path: d.path, title: d.title, mtimeSec: d.mtime }))
            ).map((doc, i) => (
              <button
                key={doc.path}
                onClick={() => pushHash("doc", doc.path)}
                className={`flex items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-base-200 ${
                  i > 0 ? "border-t border-base-200" : ""
                }`}
              >
                <IconDoc size={15} className="shrink-0 text-base-content/45" strokeWidth={1.5} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-base-content">
                  {doc.title || doc.path}
                </span>
                <span className="shrink-0 text-xs text-base-content/35">
                  {dateLabel(doc.mtimeSec)}
                </span>
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
  const resultKind = useKbStore((s) => s.state.resultKind);
  const stage = useKbStore((s) => s.state.stage);
  const phase = useKbStore((s) => s.state.phase);
  const submittedQuery = useKbStore((s) => s.state.submittedQuery);
  const hits = useKbStore((s) => s.state.hits);
  const answer = useKbStore((s) => s.state.answer);
  const searchError = useKbStore((s) => s.state.searchError);
  const status = useKbStore((s) => s.state.status);
  const answerExpanded = useHashParam("answer") != null;

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
  const hasResults =
    phase === "done" && (resultKind === "answer" ? answer != null : hits.length > 0);
  const noResults =
    phase === "done" && !searchError && !hasResults && submittedQuery.length > 0;
  // The answer rides above the composer (dock), or full-screen when expanded —
  // exactly one of the two mounts (a single live DOMD editor at a time).
  const answerVisible = resultKind === "answer" && answer != null;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-4">
          {submittedQuery ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <h1 className="text-[21px] leading-snug font-bold tracking-tight text-base-content">
                  {submittedQuery}
                </h1>
                <button
                  onClick={() => api.clearSearch()}
                  className="mt-1 shrink-0 text-xs font-medium text-base-content/45 transition-colors hover:text-base-content/60"
                >
                  Clear
                </button>
              </div>

              <StageStrip />

              {searchError && (
                <div className="rounded-xl border border-base-300 bg-base-200 px-4 py-3 text-[13.5px] text-hk-orange-text">
                  {searchError}
                </div>
              )}

              {/* The note list is ALWAYS the top surface: first paint from the
                  early hits frame, refined in place by the routed outcome. */}
              {hits.length > 0 ? (
                <ListResult />
              ) : (
                stage === "searching" && <ListSkeleton />
              )}
              {noResults && <NoResults />}
            </div>
          ) : emptyLibrary ? (
            <EmptyState />
          ) : (
            <EntryBody />
          )}
        </div>
      </div>
      {answerVisible && (answerExpanded ? <AnswerOverlay /> : <AnswerDock />)}
      <Composer
        variant={submittedQuery ? "followup" : "entry"}
        muted={emptyLibrary}
        mutedPlaceholder="Add a few notes, then ask anything…"
      />
    </>
  );
}
