"use client";
import { createReactStore, ZenithStore } from "@do-md/zenith";
import {
  type DaemonStatus,
  type EngineStatus,
  invoke,
  invokeErrorMessage,
  type PairInfo,
  type RelayCredentials,
} from "@/lib/client/desktop";
import { listGrants, type RelayGrant, revokeGrant } from "@/lib/client/relay-admin";

/** Boot phase: detect engine → (if missing) install/init → launch serve → ready. */
export type BootPhase = "checking" | "installing" | "starting" | "ready" | "error";

interface DesktopState {
  phase: BootPhase;
  bootError: string | null;

  engine: EngineStatus | null;

  // Settings: OpenAI key
  keyDraft: string;
  keyBusy: boolean;

  // Settings: relay registration
  registerDraft: string;
  registerBusy: boolean;
  registerError: string | null;

  // Settings: pairing code
  pair: PairInfo | null;
  pairBusy: boolean;
  pairError: string | null;

  // Settings: persistent tunnel
  tunnelRunning: boolean;
  tunnelManaged: boolean;
  tunnelBusy: boolean;

  // Status: compile scheduler (com.homekb.compile LaunchAgent)
  schedulerRunning: boolean;
  schedulerManaged: boolean;
  schedulerBusy: boolean;

  // Remote: paired devices (relay grants)
  grants: RelayGrant[];
  grantsLoaded: boolean;
  grantsError: string | null;
  revokingGrantId: string | null;

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
      schedulerRunning: false,
      schedulerManaged: false,
      schedulerBusy: false,
      grants: [],
      grantsLoaded: false,
      grantsError: null,
      revokingGrantId: null,
      notice: null,
    });
  }

  // ---------- Boot sequence (no system dialogs: install to ~/.local/bin, connect directly to serve) ----------
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
      const [tunnel, scheduler] = await Promise.all([
        invoke<DaemonStatus>("tunnel_status"),
        invoke<DaemonStatus>("compile_status"),
      ]);
      this.produce((d) => {
        d.engine = engine;
        d.tunnelRunning = tunnel.running;
        d.tunnelManaged = tunnel.managed;
        d.schedulerRunning = scheduler.running;
        d.schedulerManaged = scheduler.managed;
        d.phase = "ready";
      });
    } catch (e) {
      this.produce((d) => {
        d.phase = "error";
        d.bootError = invokeErrorMessage(e, "Startup failed");
      });
    }
  }

  public async refreshEngine() {
    try {
      const engine = await invoke<EngineStatus>("engine_status");
      const [tunnel, scheduler] = await Promise.all([
        invoke<DaemonStatus>("tunnel_status"),
        invoke<DaemonStatus>("compile_status"),
      ]);
      this.produce((d) => {
        d.engine = engine;
        d.tunnelRunning = tunnel.running;
        d.tunnelManaged = tunnel.managed;
        d.schedulerRunning = scheduler.running;
        d.schedulerManaged = scheduler.managed;
      });
    } catch (e) {
      this.flash(invokeErrorMessage(e, "Refresh failed"));
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
      this.flash("OpenAI key saved to config.toml");
      void this.refreshEngine();
    } catch (e) {
      this.produce((d) => {
        d.keyBusy = false;
      });
      this.flash(invokeErrorMessage(e, "Save failed"));
    }
  }

  // ---------- Relay registration ----------
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
      this.flash("Registered with relay");
      void this.refreshEngine();
    } catch (e) {
      this.produce((d) => {
        d.registerBusy = false;
        d.registerError = invokeErrorMessage(e, "Registration failed");
      });
    }
  }

  // ---------- Pairing code ----------
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
        d.pairError = invokeErrorMessage(e, "Failed to generate pairing code");
      });
    }
  }

  // ---------- Tunnel ----------
  public async toggleTunnel() {
    if (this.state.tunnelBusy) return;
    this.produce((d) => {
      d.tunnelBusy = true;
    });
    try {
      await invoke(this.state.tunnelRunning ? "tunnel_stop" : "tunnel_start");
      const tunnel = await invoke<DaemonStatus>("tunnel_status");
      this.produce((d) => {
        d.tunnelBusy = false;
        d.tunnelRunning = tunnel.running;
        d.tunnelManaged = tunnel.managed;
      });
    } catch (e) {
      this.produce((d) => {
        d.tunnelBusy = false;
      });
      this.flash(invokeErrorMessage(e, "Tunnel operation failed"));
      void this.refreshEngine();
    }
  }

  // ---------- Compile scheduler (Status card, design 6a/6b) ----------
  public async refreshScheduler() {
    try {
      const scheduler = await invoke<DaemonStatus>("compile_status");
      this.produce((d) => {
        d.schedulerRunning = scheduler.running;
        d.schedulerManaged = scheduler.managed;
      });
    } catch {
      // Non-fatal: the card simply keeps its last known state.
    }
  }

  public async toggleScheduler() {
    if (this.state.schedulerBusy) return;
    this.produce((d) => {
      d.schedulerBusy = true;
    });
    try {
      await invoke(this.state.schedulerManaged ? "compile_stop" : "compile_start");
      const scheduler = await invoke<DaemonStatus>("compile_status");
      this.produce((d) => {
        d.schedulerBusy = false;
        d.schedulerRunning = scheduler.running;
        d.schedulerManaged = scheduler.managed;
      });
    } catch (e) {
      this.produce((d) => {
        d.schedulerBusy = false;
      });
      this.flash(invokeErrorMessage(e, "Scheduler operation failed"));
      void this.refreshScheduler();
    }
  }

  // ---------- Paired devices (relay grants, design 7b) ----------
  public async loadGrants() {
    if (!this.state.engine?.relay) return;
    this.produce((d) => {
      d.grantsError = null;
    });
    try {
      const creds = await invoke<RelayCredentials>("relay_credentials");
      const grants = await listGrants(creds.url, creds.homeSecret);
      this.produce((d) => {
        d.grants = grants;
        d.grantsLoaded = true;
      });
    } catch (e) {
      this.produce((d) => {
        d.grantsLoaded = true;
        d.grantsError = invokeErrorMessage(e, "Failed to load paired devices");
      });
    }
  }

  /** Unpair one device: revoke its grant at the relay (its token stops working immediately). */
  public async revokeDevice(grantId: string) {
    if (this.state.revokingGrantId) return;
    this.produce((d) => {
      d.revokingGrantId = grantId;
    });
    try {
      const creds = await invoke<RelayCredentials>("relay_credentials");
      await revokeGrant(creds.url, creds.homeSecret, grantId);
      this.produce((d) => {
        d.grants = d.grants.filter((g) => g.id !== grantId);
        d.revokingGrantId = null;
      });
      this.flash("Device unpaired");
    } catch (e) {
      this.produce((d) => {
        d.revokingGrantId = null;
      });
      this.flash(invokeErrorMessage(e, "Failed to unpair device"));
    }
  }

  // ---------- Desktop affordances ----------
  /** Reveal the notes directory in the OS file manager (design 4a). */
  public async openNotesDir() {
    try {
      await invoke("open_notes_dir");
    } catch (e) {
      this.flash(invokeErrorMessage(e, "Failed to open folder"));
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
