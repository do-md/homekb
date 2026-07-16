"use client";
import { createMemo, createReactStore, ZenithStore } from "@do-md/zenith";
import type { EditorStore } from "@do-md/core-react";
import { claimPairCode } from "@/lib/client/relay-client";
import {
  clearConnection,
  connectionLabel,
  getConnection,
} from "@/lib/client/connection";
import { isDesktop } from "@/lib/client/desktop";
import { checkHealth, RelayError, rpc, rpcAskStream } from "@/lib/client/rpc";
import type {
  ConnState,
  DocMeta,
  Draft,
  KbAnswer,
  KbHit,
  KbStatusData,
  KbSuggestion,
  RecallMode,
  RecallPhase,
} from "../type";

/**
 * Drafts themselves now live on the home device (`~/.homekb/drafts/`, shared by
 * every paired client) — see docs/ARCHITECTURE.md "kb.draftList/Save/Delete".
 * This key holds only a per-device *crash-safety autosave of the active compose
 * buffer* (not the shared drafts list): the text you're currently typing, so a
 * reload / view-switch — even while offline — never loses in-progress work. It's
 * cleared once the buffer is saved to the home or sent to the library.
 */
const COMPOSE_KEY = "homekb.compose.v1";
const LAST_CONNECTED_KEY = "homekb.lastConnectedAt.v1";
const OPENED_KEY = "homekb.recentOpened.v1";
const OPENED_MAX = 8;

/**
 * Delay before the single silent auto-reconnect probe (see refreshHealth).
 * Deliberately short — it only exists to swallow a transient "Home is offline"
 * blip (a health probe that raced a tunnel reconnect), not to ride out a real
 * outage. One retry, not an escalating backoff.
 */
const RECONNECT_RETRY_MS = 1500;

/** "Recently opened" is genuinely open history (design 2a), kept per device. */
export interface OpenedDoc {
  path: string;
  title: string;
  at: number; // epoch ms
}

function loadOpenedDocs(): OpenedDoc[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(OPENED_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as OpenedDoc[];
    return Array.isArray(list) ? list.slice(0, OPENED_MAX) : [];
  } catch {
    return [];
  }
}

function persistOpenedDocs(docs: OpenedDoc[]) {
  try {
    window.localStorage.setItem(OPENED_KEY, JSON.stringify(docs));
  } catch {
    // Best-effort only.
  }
}

/** The active compose buffer: what the user is currently typing, plus the id of
 *  the home-side draft it maps to (null = a brand-new note not yet saved). */
interface ComposeBuffer {
  text: string;
  editingDraftId: string | null;
}

function loadCompose(): ComposeBuffer {
  const empty: ComposeBuffer = { text: "", editingDraftId: null };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(COMPOSE_KEY);
    if (!raw) return empty;
    const buf = JSON.parse(raw) as ComposeBuffer;
    return typeof buf?.text === "string"
      ? { text: buf.text, editingDraftId: buf.editingDraftId ?? null }
      : empty;
  } catch {
    return empty;
  }
}

function persistCompose(buf: ComposeBuffer | null) {
  try {
    if (!buf || !buf.text.trim()) {
      window.localStorage.removeItem(COMPOSE_KEY);
    } else {
      window.localStorage.setItem(COMPOSE_KEY, JSON.stringify(buf));
    }
  } catch {
    // Quota/private-mode failures: the buffer simply isn't crash-persisted.
  }
}

function loadLastConnectedAt(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(LAST_CONNECTED_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

interface KbState {
  // Desktop mode (Tauri webview): no pairing, connects directly to local serve
  desktop: boolean;

  // Pairing / connection
  paired: boolean;
  homeName: string;
  online: boolean | null; // null = probing
  lastConnectedAt: number | null;
  pairBusy: boolean;
  pairError: string | null;

  // Which surface is shown is owned by the URL (path routes + hash overlays,
  // see lib/client/hash-route.ts) — the store keeps only data.

  // recall
  mode: RecallMode;
  query: string;
  submittedQuery: string;
  phase: RecallPhase;
  hits: KbHit[];
  answer: KbAnswer | null;
  answerMs: number | null;
  searchError: string | null;
  recentDocs: DocMeta[];
  openedDocs: OpenedDoc[];
  suggestions: KbSuggestion[];
  docTypes: string[];
  typeFilter: string | null;
  // Per-slice "loaded at least once" flags: the home screen loads fire while the
  // tunnel may still be reconnecting; failures are silent by design, so the health
  // poll backfills whichever slice never succeeded (self-healing home screen).
  recentLoaded: boolean;
  suggestionsLoaded: boolean;
  typesLoaded: boolean;

  // reader
  readerPath: string | null;
  readerContent: string;
  /** Bumped on every load/save so the read-only DOMD remounts with fresh initMd. */
  readerVersion: number;
  readerLoading: boolean;
  readerError: string | null;
  editMode: boolean;
  saveBusy: boolean;

  // compose (new note) + drafts (drafts live on the home; see loadDrafts)
  drafts: Draft[];
  /** Home-side drafts loaded at least once (self-healing backfill flag). */
  draftsLoaded: boolean;
  editingDraftId: string | null;
  editorSeed: string;
  /** Bumped to remount the editor with a new seed. */
  editorSession: number;
  newBusy: boolean;
  newSavedPath: string | null;
  newError: string | null;

  // status
  status: KbStatusData | null;
  statusLoading: boolean;
  actionNotice: string | null;
}

const memo = createMemo<KbStore>();

export class KbStore extends ZenithStore<KbState> {
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** True while the one-shot silent auto-reconnect probe is scheduled/in-flight. */
  private reconnectPending = false;

  // ---- streaming answer: non-reactive insertText channel into the live DOMD editor ----
  // Kept off the reactive state (per-token setState would thrash); the answer text lives
  // in the DOMD editor, fed incrementally via insertText and frame-batched with rAF.
  /** The read-only DOMD editor currently rendering the streaming answer (null when unmounted). */
  private liveEditor: EditorStore | null = null;
  /** Deltas accumulated since the last rAF flush. */
  private pendingDelta = "";
  private rafId: number | null = null;
  /** Full answer text so far — backfills a late-mounting editor and seeds state.answer at done. */
  private liveText = "";
  /** True once the single auto-reconnect for the current offline episode is spent (reset on going online). */
  private autoRetryUsed = false;
  /** Last content saved to the library — suppresses the auto-stash that fires on editor remount. */
  private lastLibrarySaved: string | null = null;

  constructor() {
    const desktop = isDesktop();
    const conn = typeof window !== "undefined" ? getConnection() : null;
    // Restore the crash-safety compose buffer so in-progress text survives a reload.
    const compose = loadCompose();
    super({
      desktop,
      paired: desktop || !!conn,
      homeName: desktop ? "This machine" : conn ? connectionLabel(conn) : "",
      online: null,
      lastConnectedAt: loadLastConnectedAt(),
      pairBusy: false,
      pairError: null,
      mode: "answer",
      query: "",
      submittedQuery: "",
      phase: "idle",
      hits: [],
      answer: null,
      answerMs: null,
      searchError: null,
      recentDocs: [],
      openedDocs: loadOpenedDocs(),
      suggestions: [],
      docTypes: [],
      typeFilter: null,
      recentLoaded: false,
      suggestionsLoaded: false,
      typesLoaded: false,
      readerPath: null,
      readerContent: "",
      readerVersion: 0,
      readerLoading: false,
      readerError: null,
      editMode: false,
      saveBusy: false,
      drafts: [],
      draftsLoaded: false,
      editingDraftId: compose.editingDraftId,
      editorSeed: compose.text,
      editorSession: 0,
      newBusy: false,
      newSavedPath: null,
      newError: null,
      status: null,
      statusLoading: false,
      actionNotice: null,
    });
  }

  /** green online / amber connecting / orange offline — drives every header indicator. */
  @memo((s: KbStore) => [s.state.online, s.state.paired])
  public get connState(): ConnState {
    if (this.state.online === null) return "connecting";
    return this.state.online ? "online" : "offline";
  }

  /** List results after the docType chip filter. */
  @memo((s: KbStore) => [s.state.hits, s.state.typeFilter])
  public get filteredHits(): KbHit[] {
    const f = this.state.typeFilter;
    if (!f) return this.state.hits;
    return this.state.hits.filter((h) => (h.docType ?? "other") === f);
  }

  // ---------- Pairing ----------
  /** Claim a pairing code at the connection service (URL from the QR link or the default). */
  public async pairRelay(relayUrl: string, code: string) {
    await this.runPairing(async () => {
      const label = typeof navigator !== "undefined" ? navigator.platform || "web" : "web";
      const home = await claimPairCode(relayUrl, code, `web:${label}`);
      return home.homeName || "Home";
    });
  }

  private async runPairing(establish: () => Promise<string>) {
    this.produce((d) => {
      d.pairBusy = true;
      d.pairError = null;
    });
    try {
      const homeName = await establish();
      this.produce((d) => {
        d.paired = true;
        d.homeName = homeName;
        d.pairBusy = false;
      });
      void this.bootLoads();
    } catch (e) {
      this.produce((d) => {
        d.pairBusy = false;
        d.pairError = e instanceof Error ? e.message : "Pairing failed";
      });
    }
  }

  /** Everything the entry screen needs, fired after pairing / on mount. */
  public async bootLoads() {
    void this.refreshHealth();
    void this.loadRecent();
    void this.loadSuggestions();
    void this.loadStatus({ silent: true });
    void this.loadTypes();
    void this.loadDrafts();
  }

  public unpair() {
    if (this.state.desktop) return; // Desktop mode has no pairing concept
    clearTimeout(this.reconnectTimer);
    this.reconnectPending = false;
    this.autoRetryUsed = false;
    clearConnection();
    this.produce((d) => {
      d.paired = false;
      d.homeName = "";
      d.online = null;
      d.hits = [];
      d.answer = null;
      d.recentDocs = [];
      d.suggestions = [];
      d.docTypes = [];
      d.recentLoaded = false;
      d.suggestionsLoaded = false;
      d.typesLoaded = false;
      d.status = null;
      // Drafts belong to the previous home; a future pairing may be a different one.
      d.drafts = [];
      d.draftsLoaded = false;
      // Open history belongs to the previous home — a future pairing may be a different one.
      d.openedDocs = [];
    });
    persistOpenedDocs([]);
  }

  public async refreshHealth(opts: { backfill?: boolean } = {}) {
    if (!this.state.paired) return;
    // A silent auto-reconnect is already scheduled/in-flight — let it settle the
    // state so the 30s poll can't race it into a premature offline commit.
    if (this.reconnectPending) return;

    let online: boolean;
    try {
      online = await checkHealth();
    } catch (e) {
      if (e instanceof RelayError && e.code === "unauthorized") {
        this.unpair();
        return;
      }
      // Any other health error is treated as "not reachable right now".
      online = false;
    }

    if (online) {
      this.autoRetryUsed = false; // arm the one-shot retry again for the next episode
      this.produce((d) => {
        d.online = true;
        d.lastConnectedAt = Date.now();
      });
      try {
        window.localStorage.setItem(LAST_CONNECTED_KEY, String(Date.now()));
      } catch {
        // best-effort persistence only
      }
      // Home is reachable — recover whatever the home screen failed to load
      // earlier (e.g. boot raced a tunnel reconnect). The 30s health poll makes
      // this eventually consistent; loadStatus passes backfill:false to avoid
      // a retry loop through its own trailing health refresh.
      if (opts.backfill !== false) this.backfillHomeData();
      return;
    }

    // Offline reading. Already showing the offline screen: keep it as-is (a
    // committed offline state only clears when a probe comes back online) — no
    // re-arming, so the screen never flickers back to "Connecting…" every 30s.
    if (this.state.online === false) return;

    // First offline blip this episode: silently try to reconnect exactly once
    // before surfacing the offline screen. Most "Home is offline" flashes are
    // transient (a health probe that raced a tunnel reconnect) and recover on a
    // second probe, so we stay on the amber "Connecting…" look — the user never
    // sees the scary offline action screen for a blip. Only if this single silent
    // retry also fails do we commit to offline. (One retry, not a backoff.)
    if (!this.autoRetryUsed) {
      this.autoRetryUsed = true;
      this.reconnectPending = true;
      this.produce((d) => {
        d.online = null; // stay "connecting"; don't reveal the offline screen yet
      });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectPending = false;
        void this.refreshHealth(opts);
      }, RECONNECT_RETRY_MS);
      return;
    }

    // The one silent retry is spent and home is still unreachable → show the screen.
    this.produce((d) => {
      d.online = false;
    });
  }

  /** Re-fire only the home-screen loads that have never succeeded. */
  private backfillHomeData() {
    if (!this.state.recentLoaded) void this.loadRecent();
    if (!this.state.suggestionsLoaded) void this.loadSuggestions();
    if (!this.state.typesLoaded) void this.loadTypes();
    if (!this.state.status) void this.loadStatus({ silent: true });
    if (!this.state.draftsLoaded) void this.loadDrafts();
  }

  /** Offline screen's coral Retry button: back to amber "connecting", then re-probe. */
  public retryConnection() {
    // Re-arm the one-shot silent auto-reconnect so a manual tap also gets the
    // second-probe grace before falling back to the offline screen.
    clearTimeout(this.reconnectTimer);
    this.reconnectPending = false;
    this.autoRetryUsed = false;
    this.produce((d) => {
      d.online = null;
    });
    void this.refreshHealth();
  }

  public setQuery(q: string) {
    this.produce((d) => {
      d.query = q;
    });
  }

  public setMode(mode: RecallMode) {
    this.produce((d) => {
      d.mode = mode;
    });
    const q = this.state.submittedQuery;
    if (q) void this.runSearch(q);
  }

  public setTypeFilter(t: string | null) {
    this.produce((d) => {
      d.typeFilter = t;
    });
  }

  /** Back to the entry screen (clears the submitted query, keeps recents/suggestions). */
  public clearSearch() {
    this.produce((d) => {
      d.query = "";
      d.submittedQuery = "";
      d.phase = "idle";
      d.hits = [];
      d.answer = null;
      d.searchError = null;
      d.typeFilter = null;
    });
  }

  // ---------- Search / Recall ----------
  public async search() {
    const q = this.state.query.trim();
    if (!q) return;
    await this.runSearch(q);
  }

  private async runSearch(q: string) {
    const mode = this.state.mode;
    const startedAt = Date.now();
    this.produce((d) => {
      d.submittedQuery = q;
      d.query = "";
      d.phase = "searching";
      d.searchError = null;
      d.answer = null;
      d.answerMs = null;
      d.typeFilter = null;
    });
    try {
      if (mode === "answer") {
        // Real token streaming (docs/ARCHITECTURE.md "Streaming answer channel"):
        // deltas feed the live DOMD editor via insertText; phase flips to "streaming"
        // on the first token; the terminal `done` frame carries citations + hits.
        this.resetLive();
        const done = await rpcAskStream(q, {
          // Sources arrive before the first token (docs "Streaming answer
          // channel") — render the citation list right away and flip to the
          // streaming phase so the Answer card mounts while tokens cook.
          onSources: (sources) => {
            this.produce((d) => {
              d.answer = {
                answer: "",
                citations: sources.citations ?? [],
                hits: (sources.hits as KbHit[] | undefined) ?? [],
              };
              d.hits = (sources.hits as KbHit[] | undefined) ?? [];
              d.phase = "streaming";
            });
          },
          onDelta: (t) => this.appendAnswerDelta(t),
        });
        this.flushDelta();
        this.produce((d) => {
          d.answer = {
            answer: this.liveText,
            citations: done.citations ?? [],
            hits: (done.hits as KbHit[] | undefined) ?? [],
          };
          d.hits = (done.hits as KbHit[] | undefined) ?? [];
          d.answerMs = Date.now() - startedAt;
          d.phase = "done";
        });
      } else {
        // List mode: routed search (docs/ARCHITECTURE.md "routed search") —
        // the engine's router detects category-enumeration intent ("what
        // recipes do I have") and returns the WHOLE category (summaries,
        // relevance-ranked, no distance cutoff) instead of a truncated
        // KNN top-K. Non-enumeration queries keep the grouped KNN behavior
        // below (limit/maxDistance apply only in that fallback).
        const res = await rpc<{
          results: KbHit[];
          route?: { docType?: string; enumerate: boolean };
        }>("kb.query", {
          query: q,
          limit: 20,
          group: true,
          maxDistance: 1.1,
          route: true,
        });
        this.produce((d) => {
          d.hits = res.results ?? [];
          d.phase = "done";
        });
      }
    } catch (e) {
      if (e instanceof RelayError && e.code === "unauthorized") return this.unpair();
      this.produce((d) => {
        d.phase = "done";
        d.searchError = e instanceof Error ? e.message : "Search failed";
      });
    }
  }

  // ---- streaming answer: live DOMD editor feed (insertText, frame-batched) ----

  /** StreamingAnswer mounts → hand its DOMD editor to the store; backfill anything
   *  already accumulated before the editor existed (single insertText, never resetMD). */
  public attachLiveEditor(ed: EditorStore) {
    this.liveEditor = ed;
    this.pendingDelta = "";
    if (this.liveText) ed.insertText(this.liveText);
  }

  public detachLiveEditor(ed: EditorStore) {
    if (this.liveEditor === ed) {
      this.flushDelta();
      this.liveEditor = null;
    }
  }

  /** A new answer chunk: accumulate, flip to "streaming" on the first token, feed the editor. */
  public appendAnswerDelta(text: string) {
    this.liveText += text;
    if (this.state.phase !== "streaming") {
      this.produce((d) => {
        d.phase = "streaming";
      });
    }
    // Only queue insertText once the editor exists; otherwise attach() backfills liveText.
    if (this.liveEditor) {
      this.pendingDelta += text;
      this.scheduleFlush();
    }
  }

  private scheduleFlush() {
    if (this.rafId != null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      const text = this.pendingDelta;
      this.pendingDelta = "";
      if (text && this.liveEditor) this.liveEditor.insertText(text);
    });
  }

  private flushDelta() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.pendingDelta && this.liveEditor) {
      this.liveEditor.insertText(this.pendingDelta);
      this.pendingDelta = "";
    }
  }

  /** Start a fresh answer: cancel any pending flush and clear the accumulators + editor ref. */
  private resetLive() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingDelta = "";
    this.liveText = "";
    this.liveEditor = null;
  }

  public async loadRecent() {
    try {
      const res = await rpc<{ docs: DocMeta[] }>("kb.list", { limit: 8 });
      this.produce((d) => {
        d.recentDocs = res.docs ?? [];
        d.recentLoaded = true;
      });
    } catch {
      // Don't bother the user if the homepage recent list fails
    }
  }

  public async loadSuggestions() {
    try {
      const res = await rpc<{ suggestions: KbSuggestion[] }>("kb.suggestions", { limit: 3 });
      this.produce((d) => {
        d.suggestions = res.suggestions ?? [];
        d.suggestionsLoaded = true;
      });
    } catch {
      // Silent: an old engine without kb.suggestions (or a fresh index)
      // simply renders no "Try asking" section.
    }
  }

  public async loadTypes() {
    try {
      const res = await rpc<{ types: { docType: string; count: number }[] }>("kb.listTypes", {});
      this.produce((d) => {
        d.docTypes = (res.types ?? []).map((t) => t.docType);
        d.typesLoaded = true;
      });
    } catch {
      // No chip row without the type list — non-fatal.
    }
  }

  /** Load the shared drafts from the home (`~/.homekb/drafts/`). Silent on
   *  failure — the health poll backfills once the home is reachable again. */
  public async loadDrafts() {
    try {
      const res = await rpc<{ drafts: Draft[] }>("kb.draftList", {});
      const list = (res.drafts ?? []).slice().sort((a, b) => b.editedAt - a.editedAt);
      this.produce((d) => {
        d.drafts = list;
        d.draftsLoaded = true;
      });
    } catch {
      // Home unreachable: keep whatever we have; backfillHomeData retries.
    }
  }

  /** Click-through from a home-screen suggestion: ask it directly. */
  public askSuggestion(question: string) {
    this.produce((d) => {
      d.mode = "answer";
    });
    void this.runSearch(question);
  }

  // ---------- Reader / Editor ----------
  /** Load a document into the reader. Navigation happens via the URL
   *  (`/search#doc=<path>`); the /search page calls this when the hash changes. */
  public async openDoc(path: string) {
    this.produce((d) => {
      d.readerPath = path;
      d.readerContent = "";
      d.readerLoading = true;
      d.readerError = null;
      d.editMode = false;
    });
    try {
      const res = await rpc<{ content: string }>("kb.read", { path });
      this.produce((d) => {
        d.readerContent = res.content;
        d.readerVersion += 1;
        d.readerLoading = false;
      });
      this.recordOpened(path, res.content);
    } catch (e) {
      this.produce((d) => {
        d.readerLoading = false;
        d.readerError = e instanceof Error ? e.message : "Failed to load";
      });
    }
  }

  /** Open history for the entry screen's "Recently opened" (design 2a semantics). */
  private recordOpened(path: string, content: string) {
    const firstLine =
      content
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean) ?? "";
    const title = firstLine.replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "").trim();
    this.produce((d) => {
      d.openedDocs = [
        { path, title, at: Date.now() },
        ...d.openedDocs.filter((x) => x.path !== path),
      ].slice(0, OPENED_MAX);
    });
    persistOpenedDocs(this.state.openedDocs);
  }

  public startEdit() {
    this.produce((d) => {
      d.editMode = true;
    });
  }

  public cancelEdit() {
    this.produce((d) => {
      d.editMode = false;
    });
  }

  public async saveEdit(markdown: string) {
    const path = this.state.readerPath;
    if (!path) return;
    this.produce((d) => {
      d.saveBusy = true;
    });
    try {
      await rpc("kb.write", { path, content: markdown });
      this.produce((d) => {
        d.readerContent = markdown;
        d.readerVersion += 1;
        d.editMode = false;
        d.saveBusy = false;
      });
      this.flash("Saved");
    } catch (e) {
      this.produce((d) => {
        d.saveBusy = false;
      });
      this.flash(e instanceof Error ? e.message : "Save failed");
    }
  }

  // ---------- Compose (new note) + drafts ----------
  //
  // Drafts live on the home device (`~/.homekb/drafts/`), shared by every paired
  // client. The client keeps only a per-device crash-safety autosave of the
  // *active compose buffer* (COMPOSE_KEY) so in-progress text survives a
  // reload/navigation even while offline; the shared drafts list only changes
  // when the home is reachable (decision: require connection, no offline queue).

  /** Fresh editor (New note tab / "New note" from drafts). */
  public composeNew() {
    this.produce((d) => {
      d.editingDraftId = null;
      d.editorSeed = "";
      d.editorSession += 1;
      d.newSavedPath = null;
      d.newError = null;
    });
    persistCompose(null);
  }

  /** Re-enter the compose tab keeping whatever session was in progress. */
  public composeResume() {
    this.produce((d) => {
      d.newSavedPath = null;
      d.newError = null;
    });
  }

  /** Seed the composer with a home-side draft (`/new#draft=<id>`).
   *  Returns false when the id isn't in the loaded drafts (stale link). */
  public resumeDraft(id: string): boolean {
    const draft = this.state.drafts.find((x) => x.id === id);
    if (!draft) return false;
    this.produce((d) => {
      d.editingDraftId = draft.id;
      d.editorSeed = draft.text;
      d.editorSession += 1;
      d.newSavedPath = null;
      d.newError = null;
    });
    persistCompose({ text: draft.text, editingDraftId: draft.id });
    return true;
  }

  /**
   * Explicit "Save draft". Persists the text to the home so every device sees
   * it. The compose buffer is written first (instant, offline-safe crash net);
   * the shared save then requires the home to be online.
   */
  public async saveDraft(markdown: string) {
    if (!markdown.trim()) return;
    // Crash-safety first: never lose the text, connected or not.
    this.produce((d) => {
      d.editorSeed = markdown;
    });
    persistCompose({ text: markdown, editingDraftId: this.state.editingDraftId });
    try {
      await this.pushDraft(markdown);
      this.flash("Draft saved");
    } catch {
      this.flash("Home offline — draft kept here until you reconnect");
    }
  }

  /** Silent stash when the editor unmounts with unsaved content — never lose work. */
  public stashDraft(markdown: string) {
    if (!markdown.trim()) return;
    // Just saved to the library: don't resurrect it as a draft.
    if (this.lastLibrarySaved !== null && markdown.trim() === this.lastLibrarySaved.trim()) return;
    // Skip when identical to the draft we're editing (nothing typed).
    if (this.state.editingDraftId) {
      const existing = this.state.drafts.find((x) => x.id === this.state.editingDraftId);
      if (existing && existing.text === markdown) return;
    }
    // Keep the crash-safety buffer regardless of connectivity.
    this.produce((d) => {
      d.editorSeed = markdown;
    });
    persistCompose({ text: markdown, editingDraftId: this.state.editingDraftId });
    // Best-effort promote to a shared draft; silent when the home is offline.
    void this.pushDraft(markdown).catch(() => {});
  }

  /**
   * Upsert the current compose text as a home-side draft and mirror the result
   * locally. Throws when the home is unreachable (callers decide whether to
   * surface it). Guards against a late resolution clobbering a fresh compose.
   */
  private async pushDraft(markdown: string) {
    const res = await rpc<{ id: string; editedAt: number }>("kb.draftSave", {
      id: this.state.editingDraftId ?? undefined,
      text: markdown,
    });
    // If the editor moved on to different content, only record the draft in the
    // list — don't hijack editingDraftId / the buffer for the new work.
    const stillCurrent = this.state.editorSeed === markdown;
    this.produce((d) => {
      const existing = d.drafts.find((x) => x.id === res.id);
      if (existing) {
        existing.text = markdown;
        existing.editedAt = res.editedAt;
      } else {
        d.drafts.unshift({ id: res.id, text: markdown, editedAt: res.editedAt });
      }
      d.drafts.sort((a, b) => b.editedAt - a.editedAt);
      d.draftsLoaded = true;
      if (stillCurrent) d.editingDraftId = res.id;
    });
    if (stillCurrent) persistCompose({ text: markdown, editingDraftId: res.id });
  }

  public async deleteDraft(id: string) {
    // Optimistic removal for a snappy list; restore by reloading if the home rejects it.
    const clearingCurrent = this.state.editingDraftId === id;
    this.produce((d) => {
      d.drafts = d.drafts.filter((x) => x.id !== id);
      if (clearingCurrent) {
        d.editingDraftId = null;
        d.editorSeed = "";
        d.editorSession += 1;
      }
    });
    if (clearingCurrent) persistCompose(null);
    try {
      await rpc("kb.draftDelete", { id });
    } catch {
      this.flash("Home offline — couldn't delete draft");
      void this.loadDrafts(); // resync so the draft reappears if it wasn't removed
    }
  }

  /** "Save to library" — writes to home (needs home online). Title = first line. */
  public async saveToLibrary(markdown: string, title: string) {
    const content = markdown.trim();
    if (!content) return;
    this.produce((d) => {
      d.newBusy = true;
      d.newError = null;
      d.newSavedPath = null;
    });
    try {
      const res = await rpc<{ path: string }>("kb.create", {
        content,
        title: title || undefined,
      });
      this.lastLibrarySaved = content;
      const publishedDraftId = this.state.editingDraftId;
      this.produce((d) => {
        if (publishedDraftId) {
          d.drafts = d.drafts.filter((x) => x.id !== publishedDraftId);
        }
        d.editingDraftId = null;
        d.editorSeed = "";
        d.editorSession += 1;
        d.newBusy = false;
        d.newSavedPath = res.path;
      });
      persistCompose(null);
      // The draft has become a real note: remove it from the shared store too.
      if (publishedDraftId) {
        void rpc("kb.draftDelete", { id: publishedDraftId }).catch(() => {});
      }
      void this.loadRecent();
    } catch (e) {
      this.produce((d) => {
        d.newBusy = false;
        d.newError = e instanceof Error ? e.message : "Failed to save note";
      });
    }
  }

  // ---------- Status ----------
  public async loadStatus(opts: { silent?: boolean } = {}) {
    if (!opts.silent) {
      this.produce((d) => {
        d.statusLoading = true;
      });
    }
    try {
      const res = await rpc<KbStatusData>("kb.status", {});
      this.produce((d) => {
        d.status = res;
        d.statusLoading = false;
      });
    } catch (e) {
      this.produce((d) => {
        d.statusLoading = false;
      });
      if (!opts.silent) this.flash(e instanceof Error ? e.message : "Failed to load status");
    }
    void this.refreshHealth({ backfill: false });
  }

  public async reindex() {
    try {
      await rpc("kb.reindex", {});
      this.flash("Reindex started");
      // Reflect the compiling state (6b) shortly after the trigger.
      setTimeout(() => void this.loadStatus({ silent: true }), 1500);
    } catch (e) {
      this.flash(e instanceof Error ? e.message : "Failed to trigger reindex");
    }
  }

  private flash(text: string) {
    this.produce((d) => {
      d.actionNotice = text;
    });
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.produce((d) => {
        d.actionNotice = null;
      });
    }, 3000);
  }
}

export const {
  StoreProvider: KbStoreProvider,
  useStore: useKbStore,
  useStoreApi: useKbStoreApi,
} = createReactStore(KbStore);
