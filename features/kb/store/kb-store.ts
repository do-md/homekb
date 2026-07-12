"use client";
import { createMemo, createReactStore, ZenithStore } from "@do-md/zenith";
import {
  claimPairCode,
  clearPairing,
  getPairedHome,
  getToken,
} from "@/lib/client/relay-client";
import { isDesktop } from "@/lib/client/desktop";
import { checkHealth, RelayError, rpc } from "@/lib/client/rpc";
import type {
  DocMeta,
  KbAnswer,
  KbHit,
  KbStatusData,
  KbView,
  RecallMode,
  RecallPhase,
} from "../type";

interface KbState {
  // 桌面模式（Tauri webview）：不走配对，直连本机 serve
  desktop: boolean;

  // 配对
  paired: boolean;
  homeName: string;
  online: boolean | null; // null = 未探测
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
    super({
      desktop,
      paired: desktop || (typeof window !== "undefined" && !!getToken()),
      homeName: desktop ? "本机" : (getPairedHome()?.homeName ?? ""),
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
    if (!this.state.paired) return { text: "未配对", cls: "badge-ghost" };
    if (this.state.online === null) return { text: "探测中", cls: "badge-ghost" };
    if (this.state.desktop) {
      return this.state.online
        ? { text: "引擎在线", cls: "badge-success" }
        : { text: "引擎离线", cls: "badge-error" };
    }
    return this.state.online
      ? { text: "家中在线", cls: "badge-success" }
      : { text: "家中离线", cls: "badge-error" };
  }

  // ---------- 配对 ----------
  public async pair(code: string) {
    this.produce((d) => {
      d.pairBusy = true;
      d.pairError = null;
    });
    try {
      const label = typeof navigator !== "undefined" ? navigator.platform || "web" : "web";
      const home = await claimPairCode(code, `web:${label}`);
      this.produce((d) => {
        d.paired = true;
        d.homeName = home.homeName;
        d.pairBusy = false;
      });
      void this.refreshHealth();
      void this.loadRecent();
    } catch (e) {
      this.produce((d) => {
        d.pairBusy = false;
        d.pairError = e instanceof Error ? e.message : "配对失败";
      });
    }
  }

  public unpair() {
    if (this.state.desktop) return; // 桌面模式无配对概念
    clearPairing();
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

  // ---------- 导航 ----------
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

  // ---------- 召回 ----------
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
        const res = await rpc<{ results: KbHit[] }>("kb.query", { query: q, limit: 20 });
        this.produce((d) => {
          d.hits = res.results ?? [];
          d.phase = "done";
        });
      }
    } catch (e) {
      if (e instanceof RelayError && e.code === "unauthorized") return this.unpair();
      this.produce((d) => {
        d.phase = "done";
        d.searchError = e instanceof Error ? e.message : "搜索失败";
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
      // 首页最近列表失败不打扰
    }
  }

  // ---------- 阅读/编辑 ----------
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
        d.readerError = e instanceof Error ? e.message : "读取失败";
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
      this.flash("已保存");
    } catch (e) {
      this.produce((d) => {
        d.saveBusy = false;
      });
      this.flash(e instanceof Error ? e.message : "保存失败");
    }
  }

  // ---------- 新建 ----------
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
        d.newError = e instanceof Error ? e.message : "入库失败";
      });
    }
  }

  // ---------- 状态 ----------
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
      this.flash(e instanceof Error ? e.message : "获取状态失败");
    }
    void this.refreshHealth();
  }

  public async reindex() {
    try {
      await rpc("kb.reindex", {});
      this.flash("已触发编译");
    } catch (e) {
      this.flash(e instanceof Error ? e.message : "触发失败");
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
