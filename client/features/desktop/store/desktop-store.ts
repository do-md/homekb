"use client";
import { createMemo, createReactStore, ZenithStore } from "@do-md/zenith";
import i18n from "@/lib/i18n";
import {
  type AiSection,
  appVersion,
  type DaemonStatus,
  type EngineStatus,
  type IndexStats,
  invoke,
  invokeErrorMessage,
  type LocalRelayStatus,
  type PairInfo,
  type RelayCredentials,
  tauriProcess,
  tauriUpdater,
} from "@/lib/client/desktop";
import { listGrants, type RelayGrant, revokeGrant } from "@/lib/client/relay-admin";
import {
  allServices,
  isAllowedServiceUrl,
  loadUserServices,
  persistUserServices,
  pickAutoService,
  pingService,
  type ServiceEntry,
  type ServiceProbe,
} from "@/lib/client/services";
import { normalizeBaseUrl } from "@/lib/client/connection";

/** Boot phase: detect engine → (if missing) install/init → launch serve → ready. */
export type BootPhase = "checking" | "installing" | "starting" | "ready" | "error";

/** Draft edits for one AI endpoint section; empty string = keep/derive. */
export interface AiDraft {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  dim: string;
}

const emptyAiDraft = (): AiDraft => ({ provider: "", apiKey: "", model: "", baseUrl: "", dim: "" });

/** Silent auto-check rate limit (launch + window focus) — docs "App self-update". */
const UPDATE_CHECK_KEY = "homekb:updater:last-check";
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function shouldAutoCheck(): boolean {
  try {
    const last = Number.parseInt(localStorage.getItem(UPDATE_CHECK_KEY) ?? "0", 10);
    return Date.now() - last > UPDATE_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

/** Dotted-numeric version compare: true when `a` is strictly newer than `b`. */
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function markUpdateChecked(): void {
  try {
    localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()));
  } catch {
    // localStorage unavailable — we'll simply check again on the next focus.
  }
}

const memo = createMemo<DesktopStore>();

interface DesktopState {
  phase: BootPhase;
  bootError: string | null;

  engine: EngineStatus | null;

  // Settings: AI endpoints ([embedding]/[summary]/[ask], docs "AI provider presets")
  aiDrafts: Record<AiSection, AiDraft>;
  aiBusy: AiSection | null;
  // Settings: index stats (for the rebuild card's estimate + drift warning)
  indexStats: IndexStats | null;
  rebuilding: boolean;

  // Remote: service picker (docs "Desktop service picker")
  userServices: ServiceEntry[];
  serviceProbes: Record<string, ServiceProbe>;
  probing: boolean;
  registerBusy: boolean;
  registerError: string | null;

  // Remote: this machine's connection service (decoupled from the picker; default off)
  localRelay: LocalRelayStatus | null;
  localRelayBusy: boolean;

  // Settings: pairing code
  pair: PairInfo | null;
  pairBusy: boolean;
  pairError: string | null;

  // Settings: persistent tunnel
  tunnelRunning: boolean;
  tunnelManaged: boolean;
  tunnelBusy: boolean;

  // Remote: paired devices (relay grants)
  grants: RelayGrant[];
  grantsLoaded: boolean;
  grantsError: string | null;
  revokingGrantId: string | null;

  // App self-update (docs "App self-update"): silent background flow, no dialogs
  appVersion: string | null;
  updateReady: string | null; // version already downloaded + installed, waiting for relaunch
  updateBusy: boolean;

  // Engine update (docs "Engine acquisition": the download flow doubles as the upgrade path)
  engineLatest: string | null; // newer version available on GitHub (null = none known)
  engineUpdateBusy: boolean;

  notice: string | null;
}

export class DesktopStore extends ZenithStore<DesktopState> {
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super({
      phase: "checking",
      bootError: null,
      engine: null,
      aiDrafts: { embedding: emptyAiDraft(), summary: emptyAiDraft(), ask: emptyAiDraft() },
      aiBusy: null,
      indexStats: null,
      rebuilding: false,
      userServices: loadUserServices(),
      serviceProbes: {},
      probing: false,
      registerBusy: false,
      registerError: null,
      localRelay: null,
      localRelayBusy: false,
      pair: null,
      pairBusy: false,
      pairError: null,
      tunnelRunning: false,
      tunnelManaged: false,
      tunnelBusy: false,
      grants: [],
      grantsLoaded: false,
      grantsError: null,
      revokingGrantId: null,
      appVersion: null,
      updateReady: null,
      updateBusy: false,
      engineLatest: null,
      engineUpdateBusy: false,
      notice: null,
    });
  }

  // ---------- Boot sequence (no system dialogs: install to ~/.local/bin, connect directly to serve) ----------
  public async bootstrap() {
    this.produce((d) => {
      d.phase = "checking";
      d.bootError = null;
    });
    // Shell version for the Settings "App updates" card — fire-and-forget.
    void appVersion()
      .then((v) => {
        this.produce((d) => {
          d.appVersion = v;
        });
      })
      .catch(() => {});
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
      const tunnel = await invoke<DaemonStatus>("tunnel_status");
      this.produce((d) => {
        d.engine = engine;
        d.tunnelRunning = tunnel.running;
        d.tunnelManaged = tunnel.managed;
        d.phase = "ready";
      });
    } catch (e) {
      this.produce((d) => {
        d.phase = "error";
        d.bootError = invokeErrorMessage(e, i18n.t("desktop.messages.startupFailed"));
      });
    }
  }

  public async refreshEngine() {
    try {
      const engine = await invoke<EngineStatus>("engine_status");
      const [tunnel, indexStats] = await Promise.all([
        invoke<DaemonStatus>("tunnel_status"),
        invoke<IndexStats>("index_stats").catch(() => null),
      ]);
      this.produce((d) => {
        d.engine = engine;
        d.tunnelRunning = tunnel.running;
        d.tunnelManaged = tunnel.managed;
        d.indexStats = indexStats;
      });
    } catch (e) {
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.refreshFailed")));
    }
  }

  // ---------- AI endpoints (Settings) ----------
  public setAiDraft(section: AiSection, patch: Partial<AiDraft>) {
    this.produce((d) => {
      d.aiDrafts[section] = { ...d.aiDrafts[section], ...patch };
    });
  }

  /**
   * Persist one config section via `config_set_ai_endpoint`. Empty draft
   * fields are omitted so the shell keeps the stored key / provider default
   * model (switching provider clears the old section's fields shell-side).
   */
  public async saveAiEndpoint(section: AiSection) {
    const draft = this.state.aiDrafts[section];
    const current = this.state.engine?.ai?.[section];
    const provider = (draft.provider || current?.provider || "openai").trim();
    const dim = draft.dim.trim() ? Number.parseInt(draft.dim, 10) : null;
    this.produce((d) => {
      d.aiBusy = section;
    });
    try {
      await invoke("config_set_ai_endpoint", {
        section,
        provider,
        apiKey: draft.apiKey.trim() || null,
        model: draft.model.trim() || null,
        baseUrl: draft.baseUrl.trim() || null,
        dim: dim && Number.isFinite(dim) ? dim : null,
      });
      this.produce((d) => {
        d.aiBusy = null;
        d.aiDrafts[section] = emptyAiDraft();
      });
      this.flash(i18n.t("desktop.messages.sectionSaved", { section }));
      void this.refreshEngine();
    } catch (e) {
      this.produce((d) => {
        d.aiBusy = null;
      });
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.saveFailed")));
    }
  }

  /** Delete [ask] — back to answering with the [summary] endpoint. */
  public async resetAsk() {
    this.produce((d) => {
      d.aiBusy = "ask";
    });
    try {
      await invoke("config_set_ai_endpoint", {
        section: "ask",
        provider: "",
        apiKey: null,
        model: null,
        baseUrl: null,
        dim: null,
      });
      this.produce((d) => {
        d.aiBusy = null;
        d.aiDrafts.ask = emptyAiDraft();
      });
      this.flash(i18n.t("desktop.messages.askUsesSummary"));
      void this.refreshEngine();
    } catch (e) {
      this.produce((d) => {
        d.aiBusy = null;
      });
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.resetFailed")));
    }
  }

  /**
   * Full re-embed after an embedding switch: rebuild --force → reindex, then
   * the shell restarts serve. Long-running (minutes); the button shows a
   * spinner. Existing vectors can't be reused across models, so this is the
   * required step to make a new embedding model take effect.
   */
  public async rebuildReindex() {
    if (this.state.rebuilding) return;
    this.produce((d) => {
      d.rebuilding = true;
    });
    try {
      const report = await invoke<string>("engine_rebuild_reindex");
      this.produce((d) => {
        d.rebuilding = false;
      });
      this.flash(report || i18n.t("desktop.messages.reindexComplete"));
      void this.refreshEngine();
    } catch (e) {
      this.produce((d) => {
        d.rebuilding = false;
      });
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.rebuildFailed")));
    }
  }

  // ---------- Service picker (docs "Desktop service picker") ----------
  /**
   * Built-ins + user-added, deduped. Memoized (zenith @memo): selectors read this
   * via useSyncExternalStore, whose getSnapshot must return a cached reference —
   * a plain getter re-creating the array every call loops the render forever.
   */
  @memo((s: DesktopStore) => [s.state.userServices])
  public get services(): ServiceEntry[] {
    return allServices(this.state.userServices);
  }

  /**
   * First-run onboarding signal: the engine can neither compile nor retrieve
   * until both REQUIRED AI endpoints ([embedding] + [summary]) carry a key (see
   * docs "AI provider presets"). Drives the "Add your AI keys" guide on the
   * Search empty state and the Settings-tab attention badge. Stays false while
   * the engine status is still unknown (engine === null), so nothing flashes
   * before boot resolves.
   */
  @memo((s: DesktopStore) => [s.state.engine])
  public get aiSetupNeeded(): boolean {
    const ai = this.state.engine?.ai;
    if (!ai) return false;
    return !ai.embedding.keyPresent || !ai.summary.keyPresent;
  }

  public addService(url: string, thisMachine = false) {
    const clean = normalizeBaseUrl(url);
    if (!clean) return;
    if (!isAllowedServiceUrl(clean)) {
      this.flash(i18n.t("desktop.messages.serviceUrlInvalid"));
      return;
    }
    this.produce((d) => {
      if (!d.userServices.some((e) => e.url === clean)) {
        d.userServices.push({ url: clean, thisMachine: thisMachine || undefined });
      } else if (thisMachine) {
        d.userServices = d.userServices.map((e) =>
          e.url === clean ? { ...e, thisMachine: true } : e,
        );
      }
    });
    persistUserServices(this.state.userServices);
    void this.probeServices();
  }

  public removeService(url: string) {
    this.produce((d) => {
      d.userServices = d.userServices.filter((e) => e.url !== url);
    });
    persistUserServices(this.state.userServices);
  }

  /** Ping every candidate (reachability + latency) — a service may simply be down. */
  public async probeServices() {
    const entries = this.services;
    if (entries.length === 0) return;
    this.produce((d) => {
      d.probing = true;
    });
    const results = await Promise.all(
      entries.map(async (e) => [e.url, await pingService(e.url)] as const),
    );
    this.produce((d) => {
      for (const [url, probe] of results) d.serviceProbes[url] = probe;
      d.probing = false;
    });
  }

  /** Auto-select: reachable this-machine entry first, else lowest latency; then register. */
  public async autoSelectService() {
    await this.probeServices();
    const pick = pickAutoService(this.services, this.state.serviceProbes);
    if (!pick) {
      this.produce((d) => {
        d.registerError = i18n.t("desktop.messages.noServiceReachable");
      });
      return;
    }
    await this.registerWith(pick.url);
  }

  /**
   * Register this home with a service (`homekb register`) — the single source of truth.
   * Registration mints a NEW home identity (home_id/home_secret); the ENGINE restarts
   * an already-installed tunnel onto the fresh credentials (the "phone paired fine but
   * saw Home is offline" bug lives at the engine level, so it is fixed there — CLI
   * users get it too). The desktop only covers first-time setup: if no tunnel service
   * is installed yet, install + start it — pairing is the whole point of registering.
   */
  public async registerWith(url: string) {
    const clean = normalizeBaseUrl(url);
    if (!clean) return;
    this.produce((d) => {
      d.registerBusy = true;
      d.registerError = null;
    });
    try {
      await invoke("relay_register", { url: clean });
      // Fresh status (never the cached store flag): the engine restarted an installed
      // tunnel already; a missing one must be installed or the first pairing is dead.
      const tunnel = await invoke<DaemonStatus>("tunnel_status").catch(() => null);
      if (tunnel && !tunnel.managed) {
        await invoke("tunnel_start").catch(() => {});
      }
      this.produce((d) => {
        d.registerBusy = false;
      });
      this.flash(i18n.t("desktop.messages.connectedToService"));
      void this.refreshEngine();
    } catch (e) {
      this.produce((d) => {
        d.registerBusy = false;
        d.registerError = invokeErrorMessage(e, i18n.t("desktop.messages.connectFailed"));
      });
    }
  }

  /**
   * Disconnect from the current service (wipe [relay]) → back to the picker.
   * Also stops the tunnel: without a `[relay]` it cannot run, and a launchd-kept
   * tunnel would otherwise fail-loop.
   */
  public async disconnectService() {
    if (this.state.registerBusy) return;
    this.produce((d) => {
      d.registerBusy = true;
      d.registerError = null;
    });
    try {
      if (this.state.tunnelManaged) {
        await invoke("tunnel_stop").catch(() => {}); // best-effort; disconnect still proceeds
      }
      await invoke("relay_clear");
      this.flash(i18n.t("desktop.messages.disconnected"));
      await this.refreshEngine();
    } catch (e) {
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.disconnectFailed")));
    }
    this.produce((d) => {
      d.registerBusy = false;
    });
  }

  // ---------- This machine's service (default off, decoupled from the picker) ----------
  public async refreshLocalRelay() {
    try {
      const localRelay = await invoke<LocalRelayStatus>("local_relay_status");
      this.produce((d) => {
        d.localRelay = localRelay;
      });
    } catch {
      // Non-fatal: the card keeps its last known state.
    }
  }

  public async toggleLocalRelay() {
    if (this.state.localRelayBusy) return;
    const running = this.state.localRelay?.running ?? false;
    this.produce((d) => {
      d.localRelayBusy = true;
    });
    try {
      await invoke(running ? "local_relay_stop" : "local_relay_start");
      this.flash(
        running
          ? i18n.t("desktop.messages.localServiceStopped")
          : i18n.t("desktop.messages.localServiceStarted"),
      );
    } catch (e) {
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.serviceOperationFailed")));
    }
    await this.refreshLocalRelay();
    this.produce((d) => {
      d.localRelayBusy = false;
    });
  }

  // ---------- Pairing code ----------
  /**
   * Generate a pairing code. The engine owns first-run setup: `homekb pair --json`
   * bootstraps — enrols with the built-in official default + installs the tunnel/
   * compile agents when this machine isn't registered yet (docs "Desktop service
   * picker"). So a fresh machine can pair straight from this call with no explicit
   * register step. Refresh engine state afterwards so a bootstrap registration
   * surfaces the connection + paired-devices cards.
   */
  public async newPairCode() {
    const wasRegistered = !!this.state.engine?.relay;
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
      // First pairing on a fresh machine just bootstrapped a registration + tunnel
      // in the engine — reflect it (Connection card, tunnel toggle, devices).
      if (!wasRegistered) void this.refreshEngine();
    } catch (e) {
      this.produce((d) => {
        d.pairBusy = false;
        d.pairError = invokeErrorMessage(e, i18n.t("desktop.messages.pairCodeFailed"));
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
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.tunnelOperationFailed")));
      void this.refreshEngine();
    }
  }

  // The compile scheduler is no longer managed here: the Status page's shared
  // ScheduleCard drives it over RPC (`kb.scheduleGet`/`kb.scheduleSet` against
  // local serve) on every platform — docs "RPC methods".

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
        d.grantsError = invokeErrorMessage(e, i18n.t("desktop.messages.loadGrantsFailed"));
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
      this.flash(i18n.t("desktop.messages.deviceUnpaired"));
    } catch (e) {
      this.produce((d) => {
        d.revokingGrantId = null;
      });
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.unpairFailed")));
    }
  }

  // ---------- App self-update (docs/ARCHITECTURE.md "App self-update") ----------
  /**
   * Check for a shell update and install it in the background. Honors the
   * no-dialog rule: readiness surfaces only through `updateReady` (the in-app
   * "Restart to update" banner + the Settings card). Auto mode (launch/window
   * focus) is production-only and rate-limited to once per hour; manual mode
   * (Settings button) always checks and reports inline via the notice pill.
   */
  public async checkForUpdate(manual = false) {
    if (this.state.updateBusy || this.state.updateReady) return;
    if (!manual) {
      if (process.env.NODE_ENV !== "production") return;
      if (!shouldAutoCheck()) return;
    }
    this.produce((d) => {
      d.updateBusy = true;
    });
    try {
      const { check } = await tauriUpdater();
      const update = await check();
      markUpdateChecked();
      if (!update) {
        if (manual) this.flash(i18n.t("desktop.messages.latestVersion"));
        return;
      }
      if (manual) this.flash(i18n.t("desktop.messages.downloadingVersion", { version: update.version }));
      await update.downloadAndInstall();
      this.produce((d) => {
        d.updateReady = update.version;
      });
    } catch (e) {
      if (manual) this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.updateCheckFailed")));
      else console.warn("[updater] check/install failed", e);
    } finally {
      this.produce((d) => {
        d.updateBusy = false;
      });
    }
  }

  /** Relaunch into the freshly installed version (banner / Settings button). */
  public async restartToUpdate() {
    try {
      const { relaunch } = await tauriProcess();
      await relaunch();
    } catch (e) {
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.restartFailed")));
    }
  }

  // ---------- Engine update (docs/ARCHITECTURE.md "Engine acquisition") ----------
  /**
   * Check GitHub for a newer `engine-v*` release. `engineLatest` is only set
   * when it is strictly newer than the installed version (or the installed
   * version is unknown) — the Settings button flips to "Update" off it.
   */
  public async checkEngineUpdate() {
    if (this.state.engineUpdateBusy) return;
    this.produce((d) => {
      d.engineUpdateBusy = true;
    });
    try {
      const latest = await invoke<string>("engine_latest_version");
      const current = this.state.engine?.version;
      const newer = !current || isNewerVersion(latest, current);
      this.produce((d) => {
        d.engineLatest = newer ? latest : null;
      });
      if (!newer) this.flash(i18n.t("desktop.messages.engineUpToDate", { version: current }));
    } catch (e) {
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.engineUpdateCheckFailed")));
    } finally {
      this.produce((d) => {
        d.engineUpdateBusy = false;
      });
    }
  }

  /**
   * Download + install the latest engine release. Same Tauri command as the
   * first-run install (`engine_install`); the shell restarts its owned serve
   * child afterwards so the new binary serves immediately.
   */
  public async updateEngine() {
    if (this.state.engineUpdateBusy) return;
    this.produce((d) => {
      d.engineUpdateBusy = true;
    });
    try {
      const version = await invoke<string>("engine_install");
      this.produce((d) => {
        d.engineLatest = null;
      });
      this.flash(i18n.t("desktop.messages.engineUpdated", { version }));
      await this.refreshEngine();
    } catch (e) {
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.engineUpdateFailed")));
    } finally {
      this.produce((d) => {
        d.engineUpdateBusy = false;
      });
    }
  }

  // ---------- Desktop affordances ----------
  /** Reveal the notes directory in the OS file manager (design 4a). */
  public async openNotesDir() {
    try {
      await invoke("open_notes_dir");
    } catch (e) {
      this.flash(invokeErrorMessage(e, i18n.t("desktop.messages.openFolderFailed")));
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
