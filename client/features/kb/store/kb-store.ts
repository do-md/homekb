"use client";
import { createMemo, createReactStore, ZenithStore } from "@do-md/zenith";
import type { EditorStoreApi } from "@do-md/core-react";
import { claimPairCode } from "@/lib/client/relay-client";
import {
  clearConnection,
  connectionLabel,
  getConnection,
} from "@/lib/client/connection";
import { stripHash } from "@/lib/client/hash-route";
import { isDesktop, type AiSection } from "@/lib/client/desktop";
import {
  listGrants,
  mintPairCode,
  revokeGrant,
  type RelayGrant,
} from "@/lib/client/relay-admin";
import { checkHealth, RelayError, rpc, rpcAskStream } from "@/lib/client/rpc";
import {
  emptyAiEndpointDraft,
  type AiEndpointDraft,
} from "../components/ai-endpoint-editor";
import type {
  AskStage,
  ConnState,
  CreatedShare,
  DocMeta,
  Draft,
  KbAnswer,
  KbConfigData,
  KbHit,
  KbScheduleData,
  KbStatusData,
  KbSuggestion,
  RecallPhase,
  ResultKind,
  ShareMeta,
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

/** The active compose buffer: what the user is currently typing, plus what it
 *  maps to — a home-side draft id, a library note path being edited (the
 *  composer doubles as the note editor — `/new#note=<path>`), or neither
 *  (a brand-new note not yet saved). */
interface ComposeBuffer {
  text: string;
  editingDraftId: string | null;
  editingNotePath: string | null;
}

function loadCompose(): ComposeBuffer {
  const empty: ComposeBuffer = { text: "", editingDraftId: null, editingNotePath: null };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(COMPOSE_KEY);
    if (!raw) return empty;
    const buf = JSON.parse(raw) as ComposeBuffer;
    return typeof buf?.text === "string"
      ? {
          text: buf.text,
          editingDraftId: buf.editingDraftId ?? null,
          editingNotePath: buf.editingNotePath ?? null,
        }
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

/** "5 min" / "90 s" / "2 h" — human label for a compile interval in seconds. */
export function formatInterval(secs: number): string {
  if (secs % 3600 === 0) return `${secs / 3600} h`;
  if (secs % 60 === 0) return `${secs / 60} min`;
  return `${secs} s`;
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

  // recall — one ask entry; the engine decides answer-vs-list per query
  // (docs/ARCHITECTURE.md "Auto mode"). resultKind reflects that decision;
  // stage tracks the progressive delivery (vector → analysis → answer).
  resultKind: ResultKind | null;
  stage: AskStage | null;
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

  // reader (read-only — editing happens on the compose surface, see editNote)
  readerPath: string | null;
  readerContent: string;
  /** Bumped on every load/save so the read-only DOMD remounts with fresh initMd. */
  readerVersion: number;
  readerLoading: boolean;
  readerError: string | null;

  // compose (new note / edit note) + drafts (drafts live on the home; see loadDrafts)
  drafts: Draft[];
  /** Home-side drafts loaded at least once (self-healing backfill flag). */
  draftsLoaded: boolean;
  editingDraftId: string | null;
  /** Library note the composer is editing (`/new#note=<path>`); null = new note.
   *  "Save to library" updates this note (kb.write) instead of creating one. */
  editingNotePath: string | null;
  editorSeed: string;
  /** Bumped to remount the editor with a new seed. */
  editorSession: number;
  newBusy: boolean;
  newSavedPath: string | null;
  newError: string | null;

  // shares (public share links; records live on the home — see kb.share* RPCs)
  shares: ShareMeta[];
  /** Loaded at least once — separates "empty" from "not fetched yet". */
  sharesLoaded: boolean;
  sharesLoading: boolean;
  sharesError: string | null;

  // status
  status: KbStatusData | null;
  statusLoading: boolean;
  actionNotice: string | null;

  // background compile schedule (Status page card, all platforms —
  // docs "RPC methods": kb.scheduleGet / kb.scheduleSet)
  schedule: KbScheduleData | null;
  scheduleBusy: boolean;

  // full rebuild + reindex (web Settings rebuild card — kb.rebuild)
  rebuildBusy: boolean;

  // settings (web Settings surface over RPC — docs "Settings over RPC";
  // the desktop Settings uses Tauri commands + DesktopStore instead)
  config: KbConfigData | null;
  configLoading: boolean;
  configError: string | null;
  aiDrafts: Record<AiSection, AiEndpointDraft>;
  aiBusy: AiSection | null;

  // web Remote — invite + manage devices (docs "Paired-device equivalence";
  // the desktop Remote drives the same relay endpoints via the DesktopStore)
  mintedPair: { code: string; expiresAt: number } | null;
  mintBusy: boolean;
  mintError: string | null;
  grants: RelayGrant[];
  grantsLoaded: boolean;
  grantsError: string | null;
  revokingGrantId: string | null;
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
  private liveEditor: EditorStoreApi | null = null;
  /** Deltas accumulated since the last rAF flush. */
  private pendingDelta = "";
  private rafId: number | null = null;
  /** Full answer text so far — backfills a late-mounting editor and seeds state.answer at done. */
  private liveText = "";
  /** True once the single auto-reconnect for the current offline episode is spent (reset on going online). */
  private autoRetryUsed = false;
  /** Last content saved to the library — suppresses the auto-stash that fires on editor remount. */
  private lastLibrarySaved: string | null = null;
  /** Last content explicitly saved as a draft — same auto-stash suppression:
   *  "Save draft" clears the workspace, and the remount must not resurrect the
   *  just-saved text as a second draft. */
  private lastDraftSaved: string | null = null;

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
      resultKind: null,
      stage: null,
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
      drafts: [],
      draftsLoaded: false,
      editingDraftId: compose.editingDraftId,
      editingNotePath: compose.editingNotePath,
      editorSeed: compose.text,
      editorSession: 0,
      newBusy: false,
      newSavedPath: null,
      newError: null,
      shares: [],
      sharesLoaded: false,
      sharesLoading: false,
      sharesError: null,
      status: null,
      statusLoading: false,
      actionNotice: null,
      schedule: null,
      scheduleBusy: false,
      rebuildBusy: false,
      config: null,
      configLoading: false,
      configError: null,
      aiDrafts: {
        embedding: emptyAiEndpointDraft(),
        summary: emptyAiEndpointDraft(),
        ask: emptyAiEndpointDraft(),
      },
      aiBusy: null,
      mintedPair: null,
      mintBusy: false,
      mintError: null,
      grants: [],
      grantsLoaded: false,
      grantsError: null,
      revokingGrantId: null,
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
      // Settings + device list are home-scoped too (docs "Settings over RPC" /
      // "Paired-device equivalence") — never leak into the next pairing.
      d.config = null;
      d.configLoading = false;
      d.configError = null;
      d.mintedPair = null;
      d.mintBusy = false;
      d.mintError = null;
      d.grants = [];
      d.grantsLoaded = false;
      d.grantsError = null;
      d.revokingGrantId = null;
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

  /** Offline screen's primary Retry button: back to amber "connecting", then re-probe. */
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

  /** Escape hatch for an auto misroute (the engine listed notes but the user
   *  wanted an answer): re-run the submitted query forcing the answer path. */
  public answerInstead() {
    const q = this.state.submittedQuery;
    if (q) void this.runSearch(q, { forceAnswer: true });
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
      d.resultKind = null;
      d.stage = null;
    });
  }

  // ---------- Search / Recall ----------
  public async search() {
    const q = this.state.query.trim();
    if (!q) return;
    await this.runSearch(q);
  }

  private async runSearch(q: string, opts: { forceAnswer?: boolean } = {}) {
    const startedAt = Date.now();
    this.produce((d) => {
      d.submittedQuery = q;
      d.query = "";
      d.phase = "searching";
      d.searchError = null;
      d.answer = null;
      d.answerMs = null;
      d.typeFilter = null;
      d.resultKind = null;
      d.stage = "searching";
      // The list renders as soon as hits exist now — clear the previous
      // query's batch so it can't flash under the new heading.
      d.hits = [];
    });
    try {
      // One ask entry with progressive delivery (docs/ARCHITECTURE.md "Auto
      // mode" + "First-paint batch"): every submit goes to the streaming kb.ask
      // with `auto: true`. The early `hits` frame paints the note list as soon
      // as the vector search lands (no LLM in that path); the engine's router
      // then refines it — a `results` frame finalizes the list, while sources →
      // delta* → done replace the list with the answer's sources and stream the
      // answer into the dock (deltas feed the live DOMD editor via insertText).
      // Stage tracks frame arrivals: searching → thinking → answering.
      // `forceAnswer` is the misroute escape hatch: auto off → always answer.
      // An old engine sends no `hits` frame and always answers — graceful.
      this.resetLive();
      const outcome = await rpcAskStream(q, {
        auto: !opts.forceAnswer,
        // First-paint batch: unrouted grouped KNN — render immediately, the
        // route decision is still cooking.
        onHits: (hits) => {
          this.produce((d) => {
            d.hits = (hits as KbHit[]) ?? [];
            d.stage = "thinking";
          });
        },
        // Sources arrive before the first token (docs "Streaming answer
        // channel"): mount the answer dock (its citation chips render from
        // d.answer) while tokens cook. The note list itself is NOT touched —
        // it stays the first-paint vector batch. Only the vector search
        // (`hits`) and the router's list refinement (`results`) ever drive
        // the list; the answer path never reshuffles it.
        onSources: (sources) => {
          this.produce((d) => {
            d.resultKind = "answer";
            d.stage = "answering";
            d.answer = {
              answer: "",
              citations: sources.citations ?? [],
              hits: (sources.hits as KbHit[] | undefined) ?? [],
            };
            d.phase = "streaming";
          });
        },
        onDelta: (t) => this.appendAnswerDelta(t),
      });
      if (outcome.kind === "list") {
        // Auto list path: the router's refinement IS the list — apply it.
        this.produce((d) => {
          d.resultKind = "list";
          d.stage = null;
          d.hits = (outcome.hits as KbHit[]) ?? [];
          d.phase = "done";
        });
        return;
      }
      this.flushDelta();
      // Answer path terminal: finalize the dock only — the list keeps the
      // first-paint vector batch (see onSources).
      this.produce((d) => {
        d.resultKind = "answer";
        d.stage = null;
        d.answer = {
          answer: this.liveText,
          citations: outcome.citations ?? [],
          hits: (outcome.hits as KbHit[] | undefined) ?? [],
        };
        d.answerMs = Date.now() - startedAt;
        d.phase = "done";
      });
    } catch (e) {
      if (e instanceof RelayError && e.code === "unauthorized") return this.unpair();
      this.produce((d) => {
        d.phase = "done";
        d.stage = null;
        d.searchError = e instanceof Error ? e.message : "Search failed";
      });
    }
  }

  // ---- streaming answer: live DOMD editor feed (insertText, frame-batched) ----

  /** StreamingAnswer mounts → hand its DOMD editor to the store; backfill anything
   *  already accumulated before the editor existed (single insertText, never resetMD). */
  public attachLiveEditor(ed: EditorStoreApi) {
    this.liveEditor = ed;
    this.pendingDelta = "";
    if (this.liveText) ed.insertText(this.liveText);
  }

  public detachLiveEditor(ed: EditorStoreApi) {
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

  /** Click-through from a home-screen suggestion: these are generated
   *  *questions*, so skip the router judgment and force the answer path. */
  public askSuggestion(question: string) {
    void this.runSearch(question, { forceAnswer: true });
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

  /**
   * Enter Edit note mode: seed the composer with a library note (`/new#note=
   * <path>`). Editing rides the exact same surface as writing a new note —
   * same Drafts entry, same "Save draft" / "Save to library" actions — so
   * create/edit/update stay one form; "Save to library" then updates this
   * note in place (kb.write) instead of creating one.
   */
  public async editNote(path: string) {
    // The common path — Edit tapped in the reader: the content is already loaded.
    if (this.state.readerPath === path && !this.state.readerLoading && !this.state.readerError) {
      this.seedNoteEdit(path, this.state.readerContent);
      return;
    }
    // Deep link / reload: fetch the note first.
    this.produce((d) => {
      d.newError = null;
    });
    try {
      const res = await rpc<{ content: string }>("kb.read", { path });
      this.seedNoteEdit(path, res.content);
    } catch (e) {
      this.produce((d) => {
        d.newError = e instanceof Error ? e.message : "Failed to load note";
      });
    }
  }

  private seedNoteEdit(path: string, content: string) {
    this.produce((d) => {
      d.editingDraftId = null;
      d.editingNotePath = path;
      d.editorSeed = content;
      d.editorSession += 1;
      d.newSavedPath = null;
      d.newError = null;
    });
    persistCompose({ text: content, editingDraftId: null, editingNotePath: path });
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
      d.editingNotePath = null;
      d.editorSeed = "";
      d.editorSession += 1;
      d.newSavedPath = null;
      d.newError = null;
    });
    persistCompose(null);
  }

  /** Return to an in-progress compose *keeping* the current buffer — only for
   *  "Back" out of the Drafts list (the user peeked at drafts, not abandoned
   *  their note). The header "New note" (+) entry uses composeNew() instead:
   *  New note is always blank (see shell.tsx goCompose). */
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
      d.editingNotePath = null;
      d.editorSeed = draft.text;
      d.editorSession += 1;
      d.newSavedPath = null;
      d.newError = null;
    });
    persistCompose({ text: draft.text, editingDraftId: draft.id, editingNotePath: null });
    return true;
  }

  /**
   * Explicit "Save draft". Persists the text to the home so every device sees
   * it. The compose buffer is written first (instant, offline-safe crash net);
   * the shared save then requires the home to be online. On success the
   * workspace clears — the draft lives in the Drafts list now, and the composer
   * is ready for the next note (same contract as "Save to library"). On
   * failure the text stays in the editor (nothing is lost, nothing hidden).
   */
  /** Returns true when the workspace cleared (the caller strips a consumed
   *  #draft hash); false on failure or in an edit-note checkpoint. */
  public async saveDraft(markdown: string): Promise<boolean> {
    if (!markdown.trim()) return false;
    // Crash-safety first: never lose the text, connected or not.
    this.produce((d) => {
      d.editorSeed = markdown;
    });
    persistCompose({
      text: markdown,
      editingDraftId: this.state.editingDraftId,
      editingNotePath: this.state.editingNotePath,
    });
    try {
      await this.pushDraft(markdown);
      if (this.state.editingNotePath) {
        // Edit-note session: the draft is a checkpoint of an in-progress note
        // edit. Keep the session open — clearing would orphan the note
        // association (drafts don't carry a target path), so a later "Save to
        // library" would create a duplicate instead of updating the note.
        this.flash("Draft saved");
        return false;
      }
      // Clear the workspace. The remount auto-stash must not resurrect the
      // just-saved text as another draft — mark it saved first.
      this.lastDraftSaved = markdown;
      this.produce((d) => {
        d.editingDraftId = null;
        d.editorSeed = "";
        d.editorSession += 1;
        d.newSavedPath = null;
        d.newError = null;
      });
      persistCompose(null);
      // Same reasoning as saveToLibrary: a surviving #draft hash would make
      // the /new page effect instantly re-resume the just-saved draft.
      stripHash();
      this.flash("Draft saved");
      return true;
    } catch {
      this.flash("Home offline — draft kept here until you reconnect");
      return false;
    }
  }

  /**
   * Silent stash when a compose session ends with unsaved content — never lose
   * work. `bound` pins the identity of the session the text came from (captured
   * when that session's editor mounted): a stash that fires *after* the store
   * has already re-seeded a new session (resumed draft / note edit) must
   * neither hijack the fresh buffer nor upsert under the new session's draft id.
   */
  public stashDraft(
    markdown: string,
    bound: { draftId: string | null; notePath: string | null; seed: string; baseline: string | null },
  ) {
    if (!markdown.trim()) return;
    // Just saved to the library: don't resurrect it as a draft.
    if (this.lastLibrarySaved !== null && markdown.trim() === this.lastLibrarySaved.trim()) return;
    // Just saved as a draft (workspace cleared): same suppression.
    if (this.lastDraftSaved !== null && markdown.trim() === this.lastDraftSaved.trim()) return;
    // Nothing typed this session: the text still equals the serializer's echo
    // of the seed (`baseline` — raw-seed comparison would false-negative on
    // round-trip normalization). A note-edit or resumed-draft session has
    // nothing new to back up then; a plain compose session still promotes —
    // its crash-restored buffer may never have reached the home.
    if (bound.baseline !== null && markdown === bound.baseline && (bound.notePath || bound.draftId))
      return;
    // Note-edit session with nothing typed (exact raw match): same skip.
    if (bound.notePath && markdown === bound.seed) return;
    // Skip when identical to the draft the session was editing (nothing typed).
    if (bound.draftId) {
      const existing = this.state.drafts.find((x) => x.id === bound.draftId);
      if (existing && existing.text === markdown) return;
    }
    // Only touch the compose buffer if the store is still on this session.
    const sessionCurrent =
      this.state.editorSeed === bound.seed &&
      this.state.editingDraftId === bound.draftId &&
      this.state.editingNotePath === bound.notePath;
    if (sessionCurrent) {
      // Keep the crash-safety buffer regardless of connectivity.
      this.produce((d) => {
        d.editorSeed = markdown;
      });
      persistCompose({
        text: markdown,
        editingDraftId: bound.draftId,
        editingNotePath: bound.notePath,
      });
    }
    // Best-effort promote to a shared draft; silent when the home is offline.
    void this.pushDraft(markdown, bound.draftId).catch(() => {});
  }

  /**
   * Upsert compose text as a home-side draft and mirror the result locally.
   * Throws when the home is unreachable (callers decide whether to surface it).
   * `draftId` defaults to the active session's id; a stale stash passes its own
   * bound id explicitly. Guards against a late resolution clobbering a fresh
   * compose.
   */
  private async pushDraft(markdown: string, draftId?: string | null) {
    const id = draftId !== undefined ? draftId : this.state.editingDraftId;
    const res = await rpc<{ id: string; editedAt: number }>("kb.draftSave", {
      id: id ?? undefined,
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
    if (stillCurrent) {
      persistCompose({
        text: markdown,
        editingDraftId: res.id,
        editingNotePath: this.state.editingNotePath,
      });
    }
  }

  public async deleteDraft(id: string) {
    // Optimistic removal for a snappy list; restore by reloading if the home rejects it.
    const clearingCurrent = this.state.editingDraftId === id;
    this.produce((d) => {
      d.drafts = d.drafts.filter((x) => x.id !== id);
      if (clearingCurrent) {
        d.editingDraftId = null;
        d.editingNotePath = null;
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

  /**
   * "Save to library" — writes to home (needs home online). Title = first line.
   * In an Edit note session (editingNotePath set) this *updates* the note in
   * place via kb.write; otherwise it creates a new note via kb.create.
   * Returns true on success so the view can strip a consumed #note/#draft hash.
   */
  public async saveToLibrary(markdown: string, title: string): Promise<boolean> {
    const content = markdown.trim();
    if (!content) return false;
    const target = this.state.editingNotePath;
    this.produce((d) => {
      d.newBusy = true;
      d.newError = null;
      d.newSavedPath = null;
    });
    try {
      let savedPath: string;
      if (target) {
        await rpc("kb.write", { path: target, content });
        savedPath = target;
      } else {
        const res = await rpc<{ path: string }>("kb.create", {
          content,
          title: title || undefined,
        });
        savedPath = res.path;
      }
      this.lastLibrarySaved = content;
      const publishedDraftId = this.state.editingDraftId;
      this.produce((d) => {
        if (publishedDraftId) {
          d.drafts = d.drafts.filter((x) => x.id !== publishedDraftId);
        }
        d.editingDraftId = null;
        d.editingNotePath = null;
        d.editorSeed = "";
        d.editorSession += 1;
        d.newBusy = false;
        d.newSavedPath = savedPath;
        // Keep an open reader on this note fresh — back returns to it.
        if (target && d.readerPath === target) {
          d.readerContent = content;
          d.readerVersion += 1;
        }
      });
      persistCompose(null);
      // The save consumed the session — drop a #note/#draft hash *synchronously
      // with the state clear*: if it outlived the clear until React's effects
      // ran, the /new page effect would re-enter the just-saved edit session.
      stripHash();
      // The draft has become a real note (or was consumed as an edit
      // checkpoint): remove it from the shared store too.
      if (publishedDraftId) {
        void rpc("kb.draftDelete", { id: publishedDraftId }).catch(() => {});
      }
      void this.loadRecent();
      return true;
    } catch (e) {
      this.produce((d) => {
        d.newBusy = false;
        d.newError = e instanceof Error ? e.message : "Failed to save note";
      });
      return false;
    }
  }

  // ---------- Shares (public share links) ----------
  // Records are engine-owned truth on the home (docs/ARCHITECTURE.md "Note
  // sharing"); this slice is a plain mirror refreshed on demand.

  public async loadShares(opts: { silent?: boolean } = {}) {
    if (!opts.silent) {
      this.produce((d) => {
        d.sharesLoading = true;
        d.sharesError = null;
      });
    }
    try {
      const res = await rpc<{ shares: ShareMeta[] }>("kb.shareList", {});
      this.produce((d) => {
        d.shares = res.shares;
        d.sharesLoaded = true;
        d.sharesLoading = false;
        d.sharesError = null;
      });
    } catch (e) {
      this.produce((d) => {
        d.sharesLoading = false;
        if (!opts.silent) {
          d.sharesError = e instanceof Error ? e.message : "Failed to load shares";
        }
      });
    }
  }

  /**
   * Create a public share link for one note. Throws on failure so the calling
   * surface (the share panel) renders the error inline — e.g. "not registered
   * with a connection service" is an actionable message, not a toast.
   */
  public async createShare(
    path: string,
    opts: { password?: string; expiresDays?: number } = {},
  ): Promise<CreatedShare> {
    const res = await rpc<CreatedShare>("kb.shareCreate", {
      path,
      password: opts.password || undefined,
      expiresDays: opts.expiresDays ?? undefined,
    });
    // Mirror the fresh record so the management tab and the panel's
    // "existing shares" list agree without waiting for a tab visit.
    void this.loadShares({ silent: true });
    return res;
  }

  public async revokeShare(shareId: string) {
    // Optimistic removal (the engine delete is idempotent); resync on failure.
    this.produce((d) => {
      d.shares = d.shares.filter((s) => s.shareId !== shareId);
    });
    try {
      await rpc("kb.shareRevoke", { shareId });
      this.flash("Share revoked — the link is dead");
    } catch {
      this.flash("Home offline — couldn't revoke the share");
      void this.loadShares({ silent: true });
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

  // ---------- Background compile schedule (Status card, all platforms) ----------
  /** State of the home's compile agent (`kb.scheduleGet`). Silent on failure —
   *  the card keeps its last known state (same posture as the health poll). */
  public async loadSchedule() {
    try {
      const res = await rpc<KbScheduleData>("kb.scheduleGet", {});
      this.produce((d) => {
        d.schedule = res;
      });
    } catch {
      // Non-fatal: an old engine (pre-schedule RPC) answers unknown_method.
    }
  }

  /**
   * Enable/disable the background compile agent, or change its interval
   * (`kb.scheduleSet`). `intervalSecs` omitted on enable = keep the installed
   * interval (engine falls back to its default).
   */
  public async setSchedule(enabled: boolean, intervalSecs?: number) {
    if (this.state.scheduleBusy) return;
    this.produce((d) => {
      d.scheduleBusy = true;
    });
    try {
      const res = await rpc<KbScheduleData>("kb.scheduleSet", {
        enabled,
        ...(intervalSecs != null ? { intervalSecs } : {}),
      });
      this.produce((d) => {
        d.schedule = res;
        d.scheduleBusy = false;
      });
      this.flash(
        enabled
          ? `Background compilation on — every ${formatInterval(res.intervalSecs ?? 300)}`
          : "Background compilation paused",
      );
    } catch (e) {
      this.produce((d) => {
        d.scheduleBusy = false;
      });
      this.flash(e instanceof Error ? e.message : "Schedule update failed");
      void this.loadSchedule();
    }
  }

  /**
   * Full rebuild + reindex on the home (`kb.rebuild`) — required after an
   * embedding provider/model switch. Fire-and-forget engine-side; progress
   * shows up in `kb.status` (chunksWithVectors climbing), so the Status page
   * reflects it. Busy clears after the trigger, not after completion.
   */
  public async rebuildIndex() {
    if (this.state.rebuildBusy) return;
    this.produce((d) => {
      d.rebuildBusy = true;
    });
    try {
      await rpc("kb.rebuild", {});
      this.flash("Rebuild started on your home computer — progress on the Status page");
      setTimeout(() => {
        void this.loadStatus({ silent: true });
        this.produce((d) => {
          d.rebuildBusy = false;
        });
      }, 3000);
    } catch (e) {
      this.produce((d) => {
        d.rebuildBusy = false;
      });
      this.flash(e instanceof Error ? e.message : "Rebuild failed to start");
    }
  }

  // ---------- Settings (web surface over RPC — docs "Settings over RPC") ----------
  /** Masked config summary from the home (`kb.configGet`) — never contains a key. */
  public async loadConfig() {
    this.produce((d) => {
      d.configLoading = true;
      d.configError = null;
    });
    try {
      const res = await rpc<KbConfigData>("kb.configGet", {});
      this.produce((d) => {
        d.config = res;
        d.configLoading = false;
      });
    } catch (e) {
      this.produce((d) => {
        d.configLoading = false;
        d.configError = e instanceof Error ? e.message : "Failed to load settings";
      });
    }
  }

  public setAiDraft(section: AiSection, patch: Partial<AiEndpointDraft>) {
    this.produce((d) => {
      d.aiDrafts[section] = { ...d.aiDrafts[section], ...patch };
    });
  }

  /**
   * Persist one config section on the home via `kb.configSetAi`. Empty draft
   * fields are omitted so the engine keeps the stored key / provider default
   * model — subject to the key ↔ endpoint binding rule (a changed provider or
   * base URL drops the stored key engine-side; see docs "Settings over RPC").
   */
  public async saveAiEndpoint(section: AiSection) {
    const draft = this.state.aiDrafts[section];
    const current = this.state.config?.ai?.[section];
    const provider = (draft.provider || current?.provider || "openai").trim();
    const dim = draft.dim.trim() ? Number.parseInt(draft.dim, 10) : null;
    this.produce((d) => {
      d.aiBusy = section;
    });
    try {
      const res = await rpc<{ ai: KbConfigData["ai"] }>("kb.configSetAi", {
        section,
        provider,
        apiKey: draft.apiKey.trim() || undefined,
        model: draft.model.trim() || undefined,
        baseUrl: draft.baseUrl.trim() || undefined,
        dim: dim && Number.isFinite(dim) ? dim : undefined,
      });
      this.produce((d) => {
        d.aiBusy = null;
        d.aiDrafts[section] = emptyAiEndpointDraft();
        if (d.config) d.config.ai = res.ai;
      });
      this.flash(`[${section}] saved on ${this.state.homeName || "your home computer"}`);
    } catch (e) {
      this.produce((d) => {
        d.aiBusy = null;
      });
      this.flash(e instanceof Error ? e.message : "Save failed");
    }
  }

  /** Delete [ask] — back to answering with the [summary] endpoint. */
  public async resetAsk() {
    this.produce((d) => {
      d.aiBusy = "ask";
    });
    try {
      const res = await rpc<{ ai: KbConfigData["ai"] }>("kb.configSetAi", {
        section: "ask",
        provider: "",
      });
      this.produce((d) => {
        d.aiBusy = null;
        d.aiDrafts.ask = emptyAiEndpointDraft();
        if (d.config) d.config.ai = res.ai;
      });
      this.flash("Ask now uses the Summary endpoint");
    } catch (e) {
      this.produce((d) => {
        d.aiBusy = null;
      });
      this.flash(e instanceof Error ? e.message : "Reset failed");
    }
  }

  // ---------- Web Remote: invite + manage devices (docs "Paired-device equivalence") ----------
  /** Mint a pairing code for this home with our own clientToken — any paired device can invite. */
  public async newPairCode() {
    const conn = getConnection();
    if (!conn) return;
    this.produce((d) => {
      d.mintBusy = true;
      d.mintError = null;
    });
    try {
      const pair = await mintPairCode(conn.relayUrl, conn.token);
      this.produce((d) => {
        d.mintedPair = pair;
        d.mintBusy = false;
      });
    } catch (e) {
      this.produce((d) => {
        d.mintBusy = false;
        d.mintError = e instanceof Error ? e.message : "Failed to generate a pairing code";
      });
    }
  }

  /** Paired devices of this home (clientToken-authed; `self` marks this device). */
  public async loadGrants() {
    const conn = getConnection();
    if (!conn) return;
    try {
      const grants = await listGrants(conn.relayUrl, conn.token);
      this.produce((d) => {
        d.grants = grants;
        d.grantsLoaded = true;
        d.grantsError = null;
      });
    } catch (e) {
      this.produce((d) => {
        d.grantsLoaded = true;
        d.grantsError = e instanceof Error ? e.message : "Failed to load devices";
      });
    }
  }

  /** Unpair a device. Revoking our own grant (self) = disconnect this device. */
  public async revokeDevice(grantId: string) {
    const conn = getConnection();
    if (!conn) return;
    const isSelf = this.state.grants.find((g) => g.id === grantId)?.self === true;
    this.produce((d) => {
      d.revokingGrantId = grantId;
    });
    try {
      await revokeGrant(conn.relayUrl, conn.token, grantId);
      if (isSelf) {
        // Our own token just died — leave cleanly instead of waiting for 401s.
        this.unpair();
        return;
      }
      this.produce((d) => {
        d.grants = d.grants.filter((g) => g.id !== grantId);
        d.revokingGrantId = null;
      });
      this.flash("Device unpaired");
    } catch (e) {
      this.produce((d) => {
        d.revokingGrantId = null;
      });
      this.flash(e instanceof Error ? e.message : "Failed to unpair");
    }
  }

  /** Transient notice from UI-side helpers (e.g. editor image upload failures). */
  public notify(text: string) {
    this.flash(text);
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
