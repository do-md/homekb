"use client";

/**
 * Search / ask views (design 2a entry, 3c list, 4a empty states) with progressive
 * delivery (docs/ARCHITECTURE.md "First-paint batch"), laid out feed-style: one
 * AI slot sits at the TOP and the note list paints right below it as soon as the
 * vector search lands (the early `hits` frame — no LLM in that path). The slot
 * narrates the pipeline as plain text ("Searching your notes…" →
 * "Analyzing your question…"); when the engine decides to answer, the streamed
 * Markdown replaces the status text in place, growing with the content up to a
 * clamp — beyond that a "Show more" fade opens the full answer as a `#answer=1`
 * hash overlay (system back closes it). When the engine routes to a plain list,
 * the slot resolves to a "no AI answer needed" line carrying the "Answer anyway"
 * misroute escape hatch.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trans, useTranslation } from "react-i18next";
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
  IconGear,
  IconRefresh,
  IconSearch,
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
  const { t } = useTranslation();
  const pct = maxScore > 0 ? Math.round((hit.score / maxScore) * 100) : 0;
  return (
    <button
      onClick={() => pushHash("doc", hit.path)}
      className="flex w-full flex-col gap-2.5 rounded-xl border border-base-300 bg-base-200 p-4 text-left transition-colors hover:bg-base-300"
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
            <span>{t("recall.note.matchingSections", { count: hit.matches })}</span>
          </>
        )}
        <span className="ml-auto flex items-center gap-1 font-medium text-base-content/45">
          {t("common.open")} <IconArrowRight size={13} />
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
          className="hk-shimmer block h-24 rounded-xl bg-base-200"
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </div>
  );
}

/** Plain-text pipeline narration inside the AI slot (docs "First-paint batch"):
 *  the stage a submit is in, told as one quiet line rather than a widget. The
 *  streamed answer overwrites it in place; a list verdict resolves it to the
 *  no-answer line. Maps stage → i18n key; resolved with t() at render time. */
const STAGE_KEYS: Record<string, string> = {
  searching: "recall.stage.searching",
  thinking: "recall.stage.thinking",
  answering: "recall.stage.answering",
};

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

/** True while `ref`'s content is taller than its clamp. A ResizeObserver on the
 *  clamp container AND its content keeps this live during streaming: the
 *  container stops resizing once it hits max-height, but the DOMD content
 *  inside keeps growing below the fold. */
function useOverflowing(ref: React.RefObject<HTMLDivElement | null>) {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [ref]);
  return overflowing;
}

/**
 * Inline answer card at the top of the results feed: the answer streams here as
 * real Markdown (store → DOMD insertText), growing the card line by line up to a
 * clamp (feed-style — the list below never waits for it). Past the clamp the
 * text keeps accumulating below the fold behind a fade with a "Show more" pill;
 * that and the header expand control open the full answer as a `#answer=1` hash
 * overlay. Inline [n] chips (post-stream) open the cited note directly.
 */
function AnswerPanel() {
  const { t } = useTranslation();
  const answer = useKbStore((s) => s.state.answer);
  const answerMs = useKbStore((s) => s.state.answerMs);
  const phase = useKbStore((s) => s.state.phase);
  const bodyRef = useRef<HTMLDivElement>(null);
  const writing = phase === "streaming";
  const citationCount = answer?.citations?.length ?? 0;
  useCitationChips(bodyRef, writing, citationCount);
  const overflowing = useOverflowing(bodyRef);

  const openCited = (target: EventTarget | null) => {
    const n = citationChipOf(target);
    const cited = n != null ? answer?.citations?.[n - 1] : undefined;
    if (cited) pushHash("doc", cited.path);
  };

  const secs = answerMs != null ? `${(answerMs / 1000).toFixed(1)}s` : null;

  return (
    <div className="shadow-sm rounded-xl border border-base-300 bg-base-200">
      <div className="flex items-center gap-1.5 px-4 pt-3 text-[12px] font-semibold tracking-wide text-primary uppercase">
        {writing ? (
          <>
            <Spinner size={12} />
            {t("recall.answer.writing")}
          </>
        ) : (
          <>
            <IconSpark size={13} strokeWidth={1.5} />
            {t("recall.answer.title")}
          </>
        )}
        {!writing && secs && (
          <span className="ml-1 font-normal tracking-normal text-base-content/35 normal-case">
            {t("recall.answer.fromNotes", { count: citationCount })} · {secs}
          </span>
        )}
        <button
          onClick={() => pushHash("answer", "1")}
          aria-label={t("recall.answer.expand")}
          className="btn btn-ghost btn-xs ml-auto -mr-2 text-base-content/45 hover:text-base-content"
        >
          <IconExpand size={14} />
        </button>
      </div>
      <div className="relative">
        <div
          ref={bodyRef}
          className="hk-answer max-h-44 overflow-hidden px-4 pb-3"
          onClick={(e) => openCited(e.target)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") openCited(e.target);
          }}
        >
          <KbStreamingAnswer className="mt-1.5" />
        </div>
        {overflowing && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center rounded-b-2xl bg-gradient-to-t from-base-200 via-base-200/85 to-transparent pt-9 pb-2">
            <button
              onClick={() => pushHash("answer", "1")}
              className="btn btn-xs pointer-events-auto rounded-full border-base-300 bg-base-100 font-medium text-base-content/70 shadow-sm"
            >
              {t("recall.answer.showMore")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The AI slot at the top of the results feed — one card that morphs in place:
 * pipeline status text while the engine works, then either the streaming answer
 * (AnswerPanel) or a "no AI answer needed" verdict carrying the "Answer anyway"
 * misroute escape hatch. Renders nothing on error (the error box speaks) and on
 * a zero-hit list (NoResults owns that screen, escape hatch included).
 */
function AskPanel() {
  const { t } = useTranslation();
  const api = useKbStoreApi();
  const stage = useKbStore((s) => s.state.stage);
  const phase = useKbStore((s) => s.state.phase);
  const resultKind = useKbStore((s) => s.state.resultKind);
  const answer = useKbStore((s) => s.state.answer);
  const hasHits = useKbStore((s) => s.state.hits.length > 0);

  if (resultKind === "answer" && answer != null) return <AnswerPanel />;

  const stageKey = stage ? STAGE_KEYS[stage] : null;
  if (stageKey) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-base-300 bg-base-200 px-4 py-3 text-[13px] text-base-content/60">
        <Spinner size={13} />
        {t(stageKey)}
      </div>
    );
  }

  if (resultKind === "list" && phase === "done" && hasHits) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-base-300 bg-base-200 px-4 py-2.5 text-[13px] text-base-content/60">
        <IconSpark size={13} strokeWidth={1.5} className="shrink-0 text-base-content/35" />
        <span className="min-w-0 flex-1">{t("recall.answer.noAnswerNeeded")}</span>
        <button
          onClick={() => api.answerInstead()}
          className="btn btn-ghost btn-xs -mr-2 shrink-0 font-semibold text-primary"
        >
          {t("recall.answer.answerAnyway")}
        </button>
      </div>
    );
  }

  return null;
}

/**
 * Full-screen answer detail (`#answer=1` hash overlay — system back closes it).
 * Rendered INSTEAD of the dock while open (one live DOMD editor at a time; a
 * mid-stream expand remounts it and the store backfills the text so far).
 * Inline [n] chips jump to the citation rows; rows open the cited note.
 */
function AnswerOverlay() {
  const { t } = useTranslation();
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
            {writing ? t("recall.answer.writing") : t("recall.answer.title")}
          </div>
          <h1 className="mt-1 truncate text-[17px] leading-snug font-bold tracking-tight text-base-content">
            {submittedQuery}
          </h1>
        </div>
        <button
          onClick={() => closeHashOverlay()}
          aria-label={t("common.close")}
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
              {t("recall.answer.fromYourNotes", { count: citationCount })}
              {secs ? ` · ${secs}` : ""}
            </div>
          )}
          {answer && citationCount > 0 && (
            <div className="mt-5 pb-6">
              <div className="hk-label">{t("recall.answer.basedOnYourNotes")}</div>
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

/** The note list (design 3c): docType chips + count + document cards — paints
 *  right below the AI slot from the first-paint batch and is refined by the
 *  routed outcome (replaced wholesale; cards key by path so unchanged notes
 *  don't re-render). The answer-instead escape hatch lives in the AI slot's
 *  no-answer line (AskPanel), not here. */
function ListResult() {
  const { t } = useTranslation();
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
          {[null, ...types].map((dt) => {
            const active = typeFilter === dt;
            return (
              <button
                key={dt ?? "__all"}
                onClick={() => api.setTypeFilter(dt)}
                className={`rounded-full px-3 py-1 text-[12.5px] font-medium transition-colors ${
                  active
                    ? "bg-base-300 font-semibold text-base-content"
                    : "border border-base-200 text-base-content/45 hover:text-base-content/60"
                }`}
              >
                {dt ?? t("recall.list.all")}
              </button>
            );
          })}
        </div>
      )}
      <div className="text-xs text-base-content/35">
        {t("recall.list.countByRelevance", { count: filtered.length })}
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
  const { t } = useTranslation();
  const api = useKbStoreApi();
  const q = useKbStore((s) => s.state.submittedQuery);
  const resultKind = useKbStore((s) => s.state.resultKind);
  return (
    <div className="flex flex-col items-center py-14 text-center">
      <IconSearch size={26} className="text-base-content/35" />
      <div className="mt-3 text-[16px] font-semibold text-base-content">
        {t("recall.noResults.title")}
      </div>
      <p className="mt-1.5 max-w-xs text-[13.5px] leading-relaxed text-base-content/60">
        {resultKind === "list"
          ? t("recall.noResults.bodyWithAsk", { query: q })
          : t("recall.noResults.body", { query: q })}
      </p>
      {resultKind === "list" && (
        <button
          onClick={() => api.answerInstead()}
          className="btn btn-ghost btn-sm mt-4 gap-1.5 font-semibold text-primary"
        >
          <IconSpark size={14} strokeWidth={1.5} /> {t("recall.noResults.answerWithAi")}
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
  const { t } = useTranslation();
  const api = useDesktopStoreApi();
  return (
    <button
      onClick={() => void api.openNotesDir()}
      className="mt-2.5 w-full rounded-xl border border-base-300 px-4 py-3 text-[15px] font-semibold text-base-content/60 transition-colors hover:bg-base-200"
    >
      {t("recall.empty.openFolder")}
    </button>
  );
}

/** Empty knowledge base / new user (design 4a top). */
function EmptyLibrary() {
  const { t } = useTranslation();
  const api = useKbStoreApi();
  const router = useRouter();
  const desktop = isDesktop();
  const paths: [string, React.ReactNode][] = [
    [
      t("recall.empty.addFiles.title"),
      <Trans
        key="addFiles"
        i18nKey="recall.empty.addFiles.desc"
        components={{
          md: <code className="font-mono text-[12px]" />,
          dir: desktop ? (
            <DesktopNotesDir />
          ) : (
            <code className="font-mono text-[12px]">~/.homekb/notes</code>
          ),
        }}
      />,
    ],
    [t("recall.empty.writeHere.title"), t("recall.empty.writeHere.desc")],
    [t("recall.empty.letClaude.title"), t("recall.empty.letClaude.desc")],
  ];
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-2 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-xl border border-base-300 bg-base-200 text-base-content/45">
        <IconDocPlus size={24} strokeWidth={1.4} />
      </span>
      <h1 className="mt-5 text-[22px] font-bold tracking-tight text-base-content">
        {t("recall.empty.title")}
      </h1>
      <p className="mt-2 text-[14.5px] text-base-content/60">{t("recall.empty.subtitle")}</p>
      <div className="mt-5 w-full rounded-xl border border-base-300 bg-base-200 p-4 text-left">
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
        {t("recall.empty.newNote")}
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
  const { t } = useTranslation();
  const router = useRouter();
  const items: { title: string; desc: string; ok: boolean }[] = [
    {
      title: t("recall.aiSetup.embeddingKey.title"),
      desc: t("recall.aiSetup.embeddingKey.desc"),
      ok: ai.embedding.keyPresent,
    },
    {
      title: t("recall.aiSetup.summaryKey.title"),
      desc: t("recall.aiSetup.summaryKey.desc"),
      ok: ai.summary.keyPresent,
    },
  ];
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-2 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-xl border border-base-300 bg-base-200 text-primary">
        <IconSpark size={24} strokeWidth={1.5} />
      </span>
      <h1 className="mt-5 text-[22px] font-bold tracking-tight text-base-content">
        {t("recall.aiSetup.title")}
      </h1>
      <p className="mt-2 text-[14.5px] text-base-content/60">{t("recall.aiSetup.subtitle")}</p>
      <div className="mt-5 w-full rounded-xl border border-base-300 bg-base-200 p-4 text-left">
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
                    {ok ? t("recall.aiSetup.configured") : t("recall.aiSetup.required")}
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
        <Trans
          i18nKey="recall.aiSetup.keysNote"
          components={{ code: <code className="font-mono text-[12px]" /> }}
        />
      </p>
      <button
        onClick={() => router.push("/settings")}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-[15px] font-semibold text-primary-content transition-colors hover:bg-primary/90"
      >
        <IconGear size={16} strokeWidth={1.8} /> {t("recall.aiSetup.setUpInSettings")}
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
  const { t } = useTranslation();
  const api = useKbStoreApi();
  const status = useKbStore((s) => s.state.status);
  if (!status || !status.docs) return null;
  const chunks = status.chunks ?? 0;
  const vectorized = status.chunksWithVectors ?? 0;
  const pct = chunks > 0 ? Math.round((vectorized / chunks) * 100) : 0;
  return (
    <div className="flex items-center gap-4 rounded-xl bg-base-200 px-4 py-3">
      <span className="text-[13px] text-base-content/60">
        <Trans
          i18nKey="recall.health.docs"
          count={status.docs}
          components={{ b: <span className="font-semibold text-base-content tabular-nums" /> }}
        />
      </span>
      <span className="text-[13px] text-base-content/60">
        <Trans
          i18nKey="recall.health.chunksVectorized"
          count={chunks}
          values={{ pct }}
          components={{
            b: <span className="font-semibold text-base-content tabular-nums" />,
            pct: <span className="tabular-nums" />,
          }}
        />
      </span>
      {status.lastCompileAt ? (
        <span className="hidden text-[13px] text-base-content/35 sm:inline">
          {t("recall.health.indexed", { date: dateLabel(status.lastCompileAt) })}
        </span>
      ) : null}
      <button
        onClick={() => void api.reindex()}
        className="ml-auto flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-base-content/45 transition-colors hover:text-base-content/60"
      >
        <IconRefresh size={12} /> {t("recall.health.reindex")}
      </button>
    </div>
  );
}

/** Entry screen body (design 2a): Try asking + health + Recently opened. */
function EntryBody() {
  const { t } = useTranslation();
  const api = useKbStoreApi();
  const suggestions = useKbStore((s) => s.state.suggestions);
  const recentDocs = useKbStore((s) => s.state.recentDocs);
  const openedDocs = useKbStore((s) => s.state.openedDocs);

  return (
    <div className="flex flex-col gap-6">
      {suggestions.length > 0 && (
        <div>
          <div className="hk-label">{t("recall.entry.tryAsking")}</div>
          <div className="mt-2 flex flex-col gap-2">
            {suggestions.map((s) => (
              <button
                key={s.path}
                onClick={() => api.askSuggestion(s.question)}
                className="flex items-center gap-3 rounded-xl bg-base-200 px-4 py-3 text-left transition-colors hover:bg-base-300"
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
            {openedDocs.length > 0
              ? t("recall.entry.recentlyOpened")
              : t("recall.entry.recentlyUpdated")}
          </div>
          <ul className="mt-2 list rounded-xl bg-base-200">
            {(openedDocs.length > 0
              ? openedDocs.map((d) => ({
                  path: d.path,
                  title: d.title,
                  mtimeSec: Math.round(d.at / 1000),
                }))
              : recentDocs.map((d) => ({ path: d.path, title: d.title, mtimeSec: d.mtime }))
            ).map((doc) => (
              <li key={doc.path}>
                <button
                  onClick={() => pushHash("doc", doc.path)}
                  className="list-row w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-base-300"
                >
                  <IconDoc size={15} className="shrink-0 text-base-content/45" strokeWidth={1.5} />
                  <span className="min-w-0 truncate text-[14px] text-base-content">
                    {doc.title || doc.path}
                  </span>
                  <span className="shrink-0 text-xs text-base-content/35">
                    {dateLabel(doc.mtimeSec)}
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

export function RecallView() {
  const { t } = useTranslation();
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
          mutedPlaceholder={t("recall.composer.offlinePlaceholder")}
        />
      </>
    );
  }

  const emptyLibrary = phase === "idle" && status != null && (status.docs ?? 0) === 0;
  const hasResults =
    phase === "done" && (resultKind === "answer" ? answer != null : hits.length > 0);
  const noResults =
    phase === "done" && !searchError && !hasResults && submittedQuery.length > 0;
  // The answer lives in the top AI slot (AskPanel), or full-screen when expanded —
  // exactly one of the two mounts (a single live DOMD editor at a time; a
  // mid-stream expand remounts it and the store backfills the text so far).
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
                  {t("recall.clear")}
                </button>
              </div>

              {/* The AI slot: status narration → streaming answer OR the
                  no-answer verdict, morphing in place at the top of the feed.
                  Unmounted while the full-screen overlay owns the live DOMD. */}
              {!answerExpanded && <AskPanel />}

              {searchError && (
                <div className="rounded-xl border border-base-300 bg-base-200 px-4 py-3 text-[13.5px] text-hk-orange-text">
                  {searchError}
                </div>
              )}

              {/* The note list paints below the AI slot: first paint from the
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
      {answerVisible && answerExpanded && <AnswerOverlay />}
      <Composer
        variant={submittedQuery ? "followup" : "entry"}
        muted={emptyLibrary}
        mutedPlaceholder={t("recall.composer.emptyPlaceholder")}
      />
    </>
  );
}
