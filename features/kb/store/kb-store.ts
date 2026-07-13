"use client";
import { createMemo, createReactStore, ZenithStore } from "@do-md/zenith";
import { claimPairCode, connectDirect } from "@/lib/client/relay-client";
import {
  clearConnection,
  connectionLabel,
  getConnection,
} from "@/lib/client/connection";
import { isDesktop } from "@/lib/client/desktop";
import { checkHealth, RelayError, rpc } from "@/lib/client/rpc";
import type {
  DocMeta,
  KbAnswer,
  KbHit,
  KbStatusData,
  KbSuggestion,
  KbView,
  RecallMode,
  RecallPhase,
} from "../type";

interface KbState {
  // Desktop mode (Tauri webview): no pairing, connects directly to local serve
  desktop: boolean;

  // Pairing
  paired: boolean;
  homeName: string;
  online: boolean | null; // null = not yet probed
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
  searchError: string | null;
  recentDocs: DocMeta[];
  suggestions: KbSuggestion[];

  // reader
  readerPath: string | null;
  readerContent: string;
  readerLoading: boolean;
  readerError: string | null;
  editMode: boolean;
  editText: string;
  saveBusy: boolean;

  // new
  newTitle: string;
  newText: string;
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

  constructor() {
    const desktop = isDesktop();
    const conn = typeof window !== "undefined" ? getConnection() : null;
    super({
      desktop,
      paired: desktop || !!conn,
      homeName: desktop ? "This machine" : conn ? connectionLabel(conn) : "",
      online: null,
      pairBusy: false,
      pairError: null,
      view: "recall",
      mode: "list",
      query: "",
      submittedQuery: "",
      phase: "idle",
      hits: [],
      answer: null,
      searchError: null,
      recentDocs: [],
      suggestions: [],
      readerPath: null,
      readerContent: "",
      readerLoading: false,
      readerError: null,
      editMode: false,
      editText: "",
      saveBusy: false,
      newTitle: "",
      newText: "",
      newBusy: false,
      newSavedPath: null,
      newError: null,
      status: null,
      statusLoading: false,
      actionNotice: null,
    });
  }

  @memo((s: KbStore) => [s.state.online, s.state.paired, s.state.desktop])
  public get connBadge(): { text: string; cls: string } {
    if (!this.state.paired) return { text: "Not paired", cls: "badge-ghost" };
    if (this.state.online === null) return { text: "Checking…", cls: "badge-ghost" };
    if (this.state.desktop) {
      return this.state.online
        ? { text: "Engine online", cls: "badge-success" }
        : { text: "Engine offline", cls: "badge-error" };
    }
    return this.state.online
      ? { text: "Home online", cls: "badge-success" }
      : { text: "Home offline", cls: "badge-error" };
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
      void this.refreshHealth();
      void this.loadRecent();
      void this.loadSuggestions();
    } catch (e) {
      this.produce((d) => {
        d.pairBusy = false;
        d.pairError = e instanceof Error ? e.message : "Pairing failed";
      });
    }
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
    });
  }

  public async refreshHealth() {
    if (!this.state.paired) return;
    try {
      const online = await checkHealth();
      this.produce((d) => {
        d.online = online;
      });
    } catch (e) {
      if (e instanceof RelayError && e.code === "unauthorized") this.unpair();
      else
        this.produce((d) => {
          d.online = false;
        });
    }
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

  // ---------- Search / Recall ----------
  public async search() {
    const q = this.state.query.trim();
    if (!q) return;
    await this.runSearch(q);
  }

  private async runSearch(q: string) {
    const mode = this.state.mode;
    this.produce((d) => {
      d.submittedQuery = q;
      d.phase = "searching";
      d.searchError = null;
      d.answer = null;
    });
    try {
      if (mode === "answer") {
        const res = await rpc<KbAnswer>("kb.ask", { query: q });
        this.produce((d) => {
          d.answer = res;
          d.hits = res.hits ?? [];
          d.phase = "done";
        });
      } else {
        // List mode: group by source (each document appears only once); maxDistance filters out irrelevant results
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
      const res = await rpc<{ docs: DocMeta[] }>("kb.list", { limit: 10 });
      this.produce((d) => {
        d.recentDocs = res.docs ?? [];
      });
    } catch {
      // Don't bother the user if the homepage recent list fails
    }
  }

  public async loadSuggestions() {
    try {
      const res = await rpc<{ suggestions: KbSuggestion[] }>("kb.suggestions", { limit: 4 });
      this.produce((d) => {
        d.suggestions = res.suggestions ?? [];
      });
    } catch {
      // Silent: an old engine without kb.suggestions (or a fresh index)
      // simply renders no "Try asking" section.
    }
  }

  /** Click-through from a home-screen suggestion: ask it directly. */
  public askSuggestion(question: string) {
    this.produce((d) => {
      d.query = question;
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
        d.readerLoading = false;
      });
    } catch (e) {
      this.produce((d) => {
        d.readerLoading = false;
        d.readerError = e instanceof Error ? e.message : "Failed to load";
      });
    }
  }

  public startEdit() {
    this.produce((d) => {
      d.editMode = true;
      d.editText = d.readerContent;
    });
  }

  public setEditText(t: string) {
    this.produce((d) => {
      d.editText = t;
    });
  }

  public cancelEdit() {
    this.produce((d) => {
      d.editMode = false;
    });
  }

  public async saveEdit() {
    const path = this.state.readerPath;
    if (!path) return;
    this.produce((d) => {
      d.saveBusy = true;
    });
    try {
      await rpc("kb.write", { path, content: this.state.editText });
      this.produce((d) => {
        d.readerContent = d.editText;
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

  // ---------- New note ----------
  public setNewTitle(t: string) {
    this.produce((d) => {
      d.newTitle = t;
    });
  }

  public setNewText(t: string) {
    this.produce((d) => {
      d.newText = t;
    });
  }

  public async createNote() {
    const content = this.state.newText.trim();
    if (!content) return;
    this.produce((d) => {
      d.newBusy = true;
      d.newError = null;
      d.newSavedPath = null;
    });
    try {
      const res = await rpc<{ path: string }>("kb.create", {
        content,
        title: this.state.newTitle.trim() || undefined,
      });
      this.produce((d) => {
        d.newBusy = false;
        d.newSavedPath = res.path;
        d.newTitle = "";
        d.newText = "";
      });
    } catch (e) {
      this.produce((d) => {
        d.newBusy = false;
        d.newError = e instanceof Error ? e.message : "Failed to save note";
      });
    }
  }

  // ---------- Status ----------
  public async loadStatus() {
    this.produce((d) => {
      d.statusLoading = true;
    });
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
      this.flash(e instanceof Error ? e.message : "Failed to load status");
    }
    void this.refreshHealth();
  }

  public async reindex() {
    try {
      await rpc("kb.reindex", {});
      this.flash("Reindex triggered");
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
