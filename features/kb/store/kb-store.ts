"use client";
import { createMemo, createReactStore, ZenithStore } from "@do-md/zenith";
import { nanoid } from "nanoid";
import { claimPairCode, connectDirect } from "@/lib/client/relay-client";
import {
  clearConnection,
  connectionLabel,
  getConnection,
} from "@/lib/client/connection";
import { isDesktop } from "@/lib/client/desktop";
import { checkHealth, RelayError, rpc } from "@/lib/client/rpc";
import type {
  ConnState,
  DocMeta,
  Draft,
  KbAnswer,
  KbHit,
  KbStatusData,
  KbSuggestion,
  KbView,
  RecallMode,
  RecallPhase,
} from "../type";

const DRAFTS_KEY = "homekb.drafts.v1";
const LAST_CONNECTED_KEY = "homekb.lastConnectedAt.v1";
const OPENED_KEY = "homekb.recentOpened.v1";
const OPENED_MAX = 8;

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

function loadDrafts(): Draft[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Draft[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persistDrafts(drafts: Draft[]) {
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Quota/private-mode failures: drafts silently stay in-memory only.
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

  view: KbView;

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

  // reader
  readerPath: string | null;
  readerContent: string;
  /** Bumped on every load/save so the read-only DOMD remounts with fresh initMd. */
  readerVersion: number;
  readerLoading: boolean;
  readerError: string | null;
  editMode: boolean;
  saveBusy: boolean;

  // compose (new note) + drafts
  drafts: Draft[];
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
  /** Last content saved to the library — suppresses the auto-stash that fires on editor remount. */
  private lastLibrarySaved: string | null = null;

  constructor() {
    const desktop = isDesktop();
    const conn = typeof window !== "undefined" ? getConnection() : null;
    super({
      desktop,
      paired: desktop || !!conn,
      homeName: desktop ? "This machine" : conn ? connectionLabel(conn) : "",
      online: null,
      lastConnectedAt: loadLastConnectedAt(),
      pairBusy: false,
      pairError: null,
      view: "recall",
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
      readerPath: null,
      readerContent: "",
      readerVersion: 0,
      readerLoading: false,
      readerError: null,
      editMode: false,
      saveBusy: false,
      drafts: loadDrafts(),
      editingDraftId: null,
      editorSeed: "",
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
  /** Relay mode: claim a pairing code at the chosen relay (URL editable on the pairing screen). */
  public async pairRelay(relayUrl: string, code: string) {
    await this.runPairing(async () => {
      const label = typeof navigator !== "undefined" ? navigator.platform || "web" : "web";
      const home = await claimPairCode(relayUrl, code, `web:${label}`);
      return home.homeName || "Home";
    });
  }

  /** Direct mode: verify a publicly bound serve (URL + serveToken) and connect. */
  public async pairDirect(baseUrl: string, token: string) {
    await this.runPairing(async () => {
      await connectDirect(baseUrl, token);
      const conn = getConnection();
      return conn ? connectionLabel(conn) : "Direct";
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
  }

  public unpair() {
    if (this.state.desktop) return; // Desktop mode has no pairing concept
    clearConnection();
    this.produce((d) => {
      d.paired = false;
      d.homeName = "";
      d.online = null;
      d.hits = [];
      d.answer = null;
      d.view = "recall";
      // Open history belongs to the previous home — a future pairing may be a different one.
      d.openedDocs = [];
    });
    persistOpenedDocs([]);
  }

  public async refreshHealth() {
    if (!this.state.paired) return;
    try {
      const online = await checkHealth();
      this.produce((d) => {
        d.online = online;
        if (online) d.lastConnectedAt = Date.now();
      });
      if (online) {
        try {
          window.localStorage.setItem(LAST_CONNECTED_KEY, String(Date.now()));
        } catch {
          // best-effort persistence only
        }
      }
    } catch (e) {
      if (e instanceof RelayError && e.code === "unauthorized") this.unpair();
      else
        this.produce((d) => {
          d.online = false;
        });
    }
  }

  /** Offline screen's coral Retry button: back to amber "connecting", then re-probe. */
  public retryConnection() {
    this.produce((d) => {
      d.online = null;
    });
    void this.refreshHealth();
  }

  // ---------- Navigation ----------
  public go(view: KbView) {
    this.produce((d) => {
      d.view = view;
      if (view === "status") void this.loadStatus();
    });
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
      d.view = "recall";
    });
    try {
      if (mode === "answer") {
        const res = await rpc<KbAnswer>("kb.ask", { query: q });
        this.produce((d) => {
          d.answer = res;
          d.hits = res.hits ?? [];
          d.answerMs = Date.now() - startedAt;
          d.phase = "done";
        });
      } else {
        // List mode: whole notes, one per source; maxDistance drops irrelevant tails
        const res = await rpc<{ results: KbHit[] }>("kb.query", {
          query: q,
          limit: 20,
          group: true,
          maxDistance: 1.1,
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

  public async loadRecent() {
    try {
      const res = await rpc<{ docs: DocMeta[] }>("kb.list", { limit: 8 });
      this.produce((d) => {
        d.recentDocs = res.docs ?? [];
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
      });
    } catch {
      // No chip row without the type list — non-fatal.
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
  public async openDoc(path: string) {
    this.produce((d) => {
      d.view = "reader";
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
  /** Fresh editor (New note tab / "New note" from drafts). */
  public composeNew() {
    this.produce((d) => {
      d.view = "new";
      d.editingDraftId = null;
      d.editorSeed = "";
      d.editorSession += 1;
      d.newSavedPath = null;
      d.newError = null;
    });
  }

  /** Re-enter the compose tab keeping whatever session was in progress. */
  public composeResume() {
    this.produce((d) => {
      d.view = "new";
      d.newSavedPath = null;
      d.newError = null;
    });
  }

  public resumeDraft(id: string) {
    const draft = this.state.drafts.find((x) => x.id === id);
    if (!draft) return;
    this.produce((d) => {
      d.view = "new";
      d.editingDraftId = draft.id;
      d.editorSeed = draft.text;
      d.editorSession += 1;
      d.newSavedPath = null;
      d.newError = null;
    });
  }

  /** Explicit "Save draft" — local only, works offline. */
  public saveDraft(markdown: string) {
    if (!markdown.trim()) return;
    this.upsertDraft(markdown);
    this.flash("Draft saved on this device");
  }

  /** Silent stash when the editor unmounts with unsaved content — never lose work. */
  public stashDraft(markdown: string) {
    if (!markdown.trim()) return;
    // Just saved to the library: don't resurrect it as a draft.
    if (this.lastLibrarySaved !== null && markdown.trim() === this.lastLibrarySaved.trim()) return;
    // Skip when identical to the resumed seed (nothing typed).
    if (this.state.editingDraftId) {
      const existing = this.state.drafts.find((x) => x.id === this.state.editingDraftId);
      if (existing && existing.text === markdown) return;
    }
    this.upsertDraft(markdown);
  }

  private upsertDraft(markdown: string) {
    this.produce((d) => {
      const id = d.editingDraftId ?? nanoid(10);
      const at = Date.now();
      const existing = d.drafts.find((x) => x.id === id);
      if (existing) {
        existing.text = markdown;
        existing.editedAt = at;
      } else {
        d.drafts.unshift({ id, text: markdown, editedAt: at });
      }
      d.drafts.sort((a, b) => b.editedAt - a.editedAt);
      d.editingDraftId = id;
      d.editorSeed = markdown;
    });
    persistDrafts(this.state.drafts);
  }

  public deleteDraft(id: string) {
    this.produce((d) => {
      d.drafts = d.drafts.filter((x) => x.id !== id);
      if (d.editingDraftId === id) {
        d.editingDraftId = null;
        d.editorSeed = "";
        d.editorSession += 1;
      }
    });
    persistDrafts(this.state.drafts);
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
      this.produce((d) => {
        if (d.editingDraftId) {
          d.drafts = d.drafts.filter((x) => x.id !== d.editingDraftId);
        }
        d.editingDraftId = null;
        d.editorSeed = "";
        d.editorSession += 1;
        d.newBusy = false;
        d.newSavedPath = res.path;
      });
      persistDrafts(this.state.drafts);
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
    void this.refreshHealth();
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
