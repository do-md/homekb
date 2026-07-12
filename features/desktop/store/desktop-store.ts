"use client";
import { createReactStore, ZenithStore } from "@do-md/zenith";
import {
  type EngineStatus,
  invoke,
  invokeErrorMessage,
  type PairInfo,
  type TunnelStatus,
} from "@/lib/client/desktop";

/** 首启引导阶段：检测引擎 → （缺则）安装/初始化 → 拉起 serve → 就绪。 */
export type BootPhase = "checking" | "installing" | "starting" | "ready" | "error";

interface DesktopState {
  phase: BootPhase;
  bootError: string | null;

  engine: EngineStatus | null;

  // 设置：OpenAI key
  keyDraft: string;
  keyBusy: boolean;

  // 设置：中继注册
  registerDraft: string;
  registerBusy: boolean;
  registerError: string | null;

  // 设置：配对码
  pair: PairInfo | null;
  pairBusy: boolean;
  pairError: string | null;

  // 设置：tunnel 常驻
  tunnelRunning: boolean;
  tunnelManaged: boolean;
  tunnelBusy: boolean;

  notice: string | null;
}

export class DesktopStore extends ZenithStore<DesktopState> {
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super({
      phase: "checking",
      bootError: null,
      engine: null,
      keyDraft: "",
      keyBusy: false,
      registerDraft: "",
      registerBusy: false,
      registerError: null,
      pair: null,
      pairBusy: false,
      pairError: null,
      tunnelRunning: false,
      tunnelManaged: false,
      tunnelBusy: false,
      notice: null,
    });
  }

  // ---------- 首启引导（无任何系统弹框：直接装到 ~/.local/bin、直连 serve） ----------
  public async bootstrap() {
    this.produce((d) => {
      d.phase = "checking";
      d.bootError = null;
    });
    try {
      let engine = await invoke<EngineStatus>("engine_status");
      if (!engine.installed) {
        this.produce((d) => {
          d.phase = "installing";
        });
        await invoke("engine_install");
      }
      if (!engine.initialized) {
        await invoke("engine_init", {});
      }
      this.produce((d) => {
        d.phase = "starting";
      });
      await invoke<string>("serve_ensure");
      engine = await invoke<EngineStatus>("engine_status");
      const tunnel = await invoke<TunnelStatus>("tunnel_status");
      this.produce((d) => {
        d.engine = engine;
        d.tunnelRunning = tunnel.running;
        d.tunnelManaged = tunnel.managed;
        d.phase = "ready";
      });
    } catch (e) {
      this.produce((d) => {
        d.phase = "error";
        d.bootError = invokeErrorMessage(e, "启动失败");
      });
    }
  }

  public async refreshEngine() {
    try {
      const engine = await invoke<EngineStatus>("engine_status");
      const tunnel = await invoke<TunnelStatus>("tunnel_status");
      this.produce((d) => {
        d.engine = engine;
        d.tunnelRunning = tunnel.running;
        d.tunnelManaged = tunnel.managed;
      });
    } catch (e) {
      this.flash(invokeErrorMessage(e, "刷新失败"));
    }
  }

  // ---------- OpenAI key ----------
  public setKeyDraft(v: string) {
    this.produce((d) => {
      d.keyDraft = v;
    });
  }

  public async saveOpenaiKey() {
    const key = this.state.keyDraft.trim();
    if (!key) return;
    this.produce((d) => {
      d.keyBusy = true;
    });
    try {
      await invoke("config_set_openai_key", { key });
      this.produce((d) => {
        d.keyBusy = false;
        d.keyDraft = "";
      });
      this.flash("OpenAI key 已写入 config.toml");
      void this.refreshEngine();
    } catch (e) {
      this.produce((d) => {
        d.keyBusy = false;
      });
      this.flash(invokeErrorMessage(e, "保存失败"));
    }
  }

  // ---------- 中继注册 ----------
  public setRegisterDraft(v: string) {
    this.produce((d) => {
      d.registerDraft = v;
    });
  }

  public async register() {
    const url = this.state.registerDraft.trim();
    if (!url) return;
    this.produce((d) => {
      d.registerBusy = true;
      d.registerError = null;
    });
    try {
      await invoke("relay_register", { url });
      this.produce((d) => {
        d.registerBusy = false;
        d.registerDraft = "";
      });
      this.flash("已注册到中继");
      void this.refreshEngine();
    } catch (e) {
      this.produce((d) => {
        d.registerBusy = false;
        d.registerError = invokeErrorMessage(e, "注册失败");
      });
    }
  }

  // ---------- 配对码 ----------
  public async newPairCode() {
    this.produce((d) => {
      d.pairBusy = true;
      d.pairError = null;
      d.pair = null;
    });
    try {
      const pair = await invoke<PairInfo>("pair_new");
      this.produce((d) => {
        d.pairBusy = false;
        d.pair = pair;
      });
    } catch (e) {
      this.produce((d) => {
        d.pairBusy = false;
        d.pairError = invokeErrorMessage(e, "生成配对码失败");
      });
    }
  }

  // ---------- tunnel ----------
  public async toggleTunnel() {
    if (this.state.tunnelBusy) return;
    this.produce((d) => {
      d.tunnelBusy = true;
    });
    try {
      await invoke(this.state.tunnelRunning ? "tunnel_stop" : "tunnel_start");
      const tunnel = await invoke<TunnelStatus>("tunnel_status");
      this.produce((d) => {
        d.tunnelBusy = false;
        d.tunnelRunning = tunnel.running;
        d.tunnelManaged = tunnel.managed;
      });
    } catch (e) {
      this.produce((d) => {
        d.tunnelBusy = false;
      });
      this.flash(invokeErrorMessage(e, "tunnel 操作失败"));
      void this.refreshEngine();
    }
  }

  private flash(text: string) {
    this.produce((d) => {
      d.notice = text;
    });
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.produce((d) => {
        d.notice = null;
      });
    }, 3000);
  }
}

export const {
  StoreProvider: DesktopStoreProvider,
  useStore: useDesktopStore,
  useStoreApi: useDesktopStoreApi,
} = createReactStore(DesktopStore);
