//! HomeKB desktop client (Tauri 2, macOS first).
//!
//! Pure renderer (docs/ARCHITECTURE.md "desktop client"): shares the same UI as the
//! web version; data plane connects directly to the local `homekb serve`.
//! This shell is responsible only for on-machine duties — engine detection/installation,
//! serve/tunnel lifecycle, config.toml read/write, and pairing code generation.
//! Convention: no dialog plugin; no system popups anywhere; saves go through engine RPC
//! directly to the data directory.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;
use tauri::async_runtime::spawn_blocking;
use tauri::path::BaseDirectory;

struct Procs {
    serve: Option<Child>,
    // tunnel is no longer spawned by the App: it is kept alive by the engine's
    // launchd LaunchAgent (single source of truth). The desktop shell only manages
    // it via `homekb tunnel --install/--uninstall/--status` — see tunnel_* commands below.
}

/// Process registry. Stored as a static rather than tauri State because spawn_blocking closures require 'static.
static PROCS: Mutex<Procs> = Mutex::new(Procs { serve: None });

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineStatus {
    installed: bool,
    path: Option<String>,
    version: Option<String>,
    bundled_version: Option<String>,
    initialized: bool,
    serve_running: bool,
    config_path: String,
    root: String,
    notes_dir: String,
    ai: AiStatus,
    relay: Option<RelayStatus>,
}

/// Per-section AI endpoint summary for Settings (docs/ARCHITECTURE.md
/// desktop command list, `engine_status`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiEndpointStatus {
    provider: String,
    model: String,
    key_present: bool,
    configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStatus {
    embedding: AiEndpointStatus,
    summary: AiEndpointStatus,
    ask: AiEndpointStatus,
}

impl From<engine::AiEndpointInfo> for AiEndpointStatus {
    fn from(i: engine::AiEndpointInfo) -> Self {
        Self {
            provider: i.provider,
            model: i.model,
            key_present: i.key_present,
            configured: i.configured,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayStatus {
    url: String,
    home_id: String,
    name: String,
}

/// Launchd daemon status (shared by the tunnel and compile agents).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
    running: bool,
    managed: bool,
}

/// Parse `homekb <watch|tunnel> --status --json` output into a DaemonStatus.
fn parse_daemon_status(out: &str, what: &str) -> Result<DaemonStatus, String> {
    let line = out
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or_else(|| format!("no JSON in {what} --status output"))?;
    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("failed to parse {what} status: {e}"))?;
    Ok(DaemonStatus {
        running: v["running"].as_bool().unwrap_or(false),
        managed: v["installed"].as_bool().unwrap_or(false),
    })
}

fn bundled_engine(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve("engine/homekb", BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
}

fn build_status(app: &tauri::AppHandle) -> EngineStatus {
    let bin = engine::engine_path();
    let cfg = engine::read_config();
    let config_path = engine::config_path();
    let initialized = config_path.is_file() && cfg.notes_dir.is_dir();
    EngineStatus {
        installed: bin.is_some(),
        version: bin.as_deref().and_then(engine::engine_version),
        path: bin.map(|p| p.display().to_string()),
        bundled_version: bundled_engine(app)
            .as_deref()
            .and_then(engine::engine_version),
        initialized,
        serve_running: engine::serve_health(),
        config_path: config_path.display().to_string(),
        root: cfg.root.display().to_string(),
        notes_dir: cfg.notes_dir.display().to_string(),
        ai: AiStatus {
            embedding: cfg.embedding.into(),
            summary: cfg.summary.into(),
            ask: cfg.ask.into(),
        },
        relay: cfg.relay.map(|r| RelayStatus { url: r.url, home_id: r.home_id, name: r.name }),
    }
}

fn require_engine() -> Result<PathBuf, String> {
    engine::engine_path().ok_or_else(|| "engine not installed".to_string())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------- engine ----------

#[tauri::command]
async fn engine_status(app: tauri::AppHandle) -> Result<EngineStatus, String> {
    blocking(move || Ok(build_status(&app))).await
}

/// First-launch installation: bundled resource binary → ~/.local/bin/homekb (no popup, per docs contract).
#[tauri::command]
async fn engine_install(app: tauri::AppHandle) -> Result<String, String> {
    blocking(move || {
        let src = bundled_engine(&app).ok_or("no engine binary bundled in app")?;
        let dst = engine::install_target();
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        std::fs::copy(&src, &dst).map_err(|e| format!("engine install failed: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("set executable permission failed: {e}"))?;
        }
        Ok(dst.display().to_string())
    })
    .await
}

/// `homekb init`: create directory tree + write config (idempotent).
#[tauri::command]
async fn engine_init(openai_key: Option<String>) -> Result<(), String> {
    blocking(move || {
        let bin = require_engine()?;
        let mut args = vec!["init"];
        if let Some(k) = openai_key.as_deref().filter(|k| !k.trim().is_empty()) {
            args.push("--openai-key");
            args.push(k);
        }
        engine::run_cli(&bin, &args)?;
        Ok(())
    })
    .await
}

// ---------- serve lifecycle ----------

/// Spawn a `homekb serve` child (reads bind host from config.toml) and wait until healthy.
fn spawn_serve() -> Result<String, String> {
    let bin = require_engine()?;
    let log = engine::log_file("serve")?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(&bin)
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log2))
        .spawn()
        .map_err(|e| format!("failed to start homekb serve: {e}"))?;
    PROCS.lock().unwrap().serve = Some(child);
    for _ in 0..50 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if engine::serve_health() {
            return Ok("spawned".to_string());
        }
    }
    Err("homekb serve did not become ready within 5 seconds (see ~/Library/Logs/HomeKB/serve.log)".to_string())
}

/// Already running (external process) → attach; not running → spawn child and wait for healthy.
#[tauri::command]
async fn serve_ensure() -> Result<String, String> {
    blocking(|| {
        if engine::serve_health() {
            return Ok("external".to_string());
        }
        spawn_serve()
    })
    .await
}

/// Restart the serve child this app spawned so it reloads config + snapshot
/// (serve caches `Config` at startup). No-op when serve is an external process
/// we don't own — its config stays stale until the user restarts it.
fn restart_owned_serve() -> Result<(), String> {
    let owned = {
        let mut procs = PROCS.lock().unwrap();
        match procs.serve.take() {
            Some(mut c) => {
                let _ = c.kill();
                let _ = c.wait();
                true
            }
            None => false,
        }
    };
    if owned {
        // Give the OS a moment to release the loopback port before rebinding.
        std::thread::sleep(std::time::Duration::from_millis(300));
        spawn_serve()?;
    }
    Ok(())
}

// ---------- config ----------

#[tauri::command]
async fn config_set_ai_endpoint(
    section: String,
    provider: String,
    api_key: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    dim: Option<u32>,
) -> Result<(), String> {
    blocking(move || {
        engine::set_ai_endpoint(
            &section,
            &provider,
            api_key.as_deref(),
            model.as_deref(),
            base_url.as_deref(),
            dim,
        )
    })
    .await
}

// ---------- index ----------

/// Snapshot counts + the model/provider the index was actually built with
/// (docs/ARCHITECTURE.md `index_stats`). Drives the Settings rebuild card's
/// cost estimate and config↔index drift warning. Fields are zero/empty when
/// no snapshot exists yet.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexStats {
    available: bool,
    docs: i64,
    chunks: i64,
    embedding_model: String,
    embedding_provider: String,
}

#[tauri::command]
async fn index_stats() -> Result<IndexStats, String> {
    blocking(|| {
        let bin = require_engine()?;
        let out = engine::run_cli(&bin, &["status", "--json"])?;
        let v: serde_json::Value = serde_json::from_str(out.trim())
            .map_err(|e| format!("failed to parse status: {e}"))?;
        Ok(IndexStats {
            available: v["available"].as_bool().unwrap_or(false),
            docs: v["docs"].as_i64().unwrap_or(0),
            chunks: v["chunks"].as_i64().unwrap_or(0),
            embedding_model: v["embeddingModel"].as_str().unwrap_or("").to_string(),
            embedding_provider: v["embeddingProvider"].as_str().unwrap_or("").to_string(),
        })
    })
    .await
}

/// Full re-embed after an embedding-model/provider switch: `rebuild --force`
/// (drop all vectors) → `reindex` (re-embed every note with the current
/// config), then restart the owned serve child so it reloads config +
/// snapshot. Long-running (minutes); the UI shows a spinner. Returns the
/// reindex summary line.
#[tauri::command]
async fn engine_rebuild_reindex() -> Result<String, String> {
    blocking(|| {
        let bin = require_engine()?;
        engine::run_cli(&bin, &["rebuild", "--force"])?;
        let report = engine::run_cli(&bin, &["reindex"])?;
        restart_owned_serve()?;
        Ok(report
            .trim()
            .lines()
            .last()
            .unwrap_or("reindex done")
            .to_string())
    })
    .await
}

// ---------- relay ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayCredentials {
    url: String,
    home_secret: String,
}

/// Relay URL + homeSecret from config.toml — lets the desktop UI call the
/// homeSecret-authenticated relay endpoints (grants list/revoke, docs contract).
#[tauri::command]
async fn relay_credentials() -> Result<RelayCredentials, String> {
    blocking(|| {
        let (url, home_secret) = engine::relay_credentials()
            .ok_or("not registered with a relay")?;
        Ok(RelayCredentials { url, home_secret })
    })
    .await
}

#[tauri::command]
async fn relay_register(url: String) -> Result<(), String> {
    blocking(move || {
        let bin = require_engine()?;
        engine::run_cli(&bin, &["register", "--relay", url.trim()])?;
        Ok(())
    })
    .await
}

/// Disconnect from the current connection service: wraps `homekb unregister`
/// (retire the registration at the service so paired devices auto-unpair via 401,
/// clear `[relay]`, remove the tunnel agent). Falls back to a plain config wipe
/// when the engine binary is missing.
#[tauri::command]
async fn relay_clear() -> Result<(), String> {
    blocking(|| {
        match engine::engine_path() {
            Some(bin) => engine::run_cli(&bin, &["unregister"]).map(|_| ()),
            None => engine::clear_relay(),
        }
    })
    .await
}

/// `homekb pair --json` → {code, expiresAt, relayUrl, homeName} passed through as-is.
#[tauri::command]
async fn pair_new() -> Result<serde_json::Value, String> {
    blocking(|| {
        let bin = require_engine()?;
        let out = engine::run_cli(&bin, &["pair", "--json"])?;
        let line = out.lines().rev().find(|l| l.trim_start().starts_with('{'))
            .ok_or("no JSON in pair output")?;
        serde_json::from_str(line).map_err(|e| format!("failed to parse pair output: {e}"))
    })
    .await
}

// ---------- tunnel lifecycle (launchd-managed, single source of truth) ----------
//
// The desktop shell no longer spawns/pkills tunnel directly. The daemon is
// managed by the engine's launchd LaunchAgent
// (`homekb tunnel --install/--uninstall/--status`). These three commands are
// thin wrappers to avoid conflicts with launchd KeepAlive and concurrent
// compile.lock contention from two tunnel processes.

/// Enable daemon: `homekb tunnel --install` (write LaunchAgent + start, idempotent).
#[tauri::command]
async fn tunnel_start() -> Result<(), String> {
    blocking(|| {
        let bin = require_engine()?;
        engine::run_cli(&bin, &["tunnel", "--install"])?;
        Ok(())
    })
    .await
}

/// Disable daemon: `homekb tunnel --uninstall` (bootout + remove plist, idempotent).
#[tauri::command]
async fn tunnel_stop() -> Result<(), String> {
    blocking(|| {
        let bin = require_engine()?;
        engine::run_cli(&bin, &["tunnel", "--uninstall"])?;
        Ok(())
    })
    .await
}

/// Query daemon status: parse `homekb tunnel --status --json`.
/// `managed` = registered with launchd (plist exists); `running` = launchd reports running.
#[tauri::command]
async fn tunnel_status() -> Result<DaemonStatus, String> {
    blocking(|| {
        let bin = require_engine()?;
        let out = engine::run_cli(&bin, &["tunnel", "--status", "--json"])?;
        parse_daemon_status(&out, "tunnel")
    })
    .await
}

// ---------- compile scheduler (launchd-managed, single source of truth) ----------
//
// Thin wrappers around `homekb watch --install/--uninstall/--status` — the
// com.homekb.compile LaunchAgent is the sole scheduled-compile source
// (docs/ARCHITECTURE.md "compile lifecycle"). Drives the Status scheduler card
// and the Settings engine toggle.

/// Enable the compile scheduler: `homekb watch --install`.
#[tauri::command]
async fn compile_start() -> Result<(), String> {
    blocking(|| {
        let bin = require_engine()?;
        engine::run_cli(&bin, &["watch", "--install"])?;
        Ok(())
    })
    .await
}

/// Disable the compile scheduler: `homekb watch --uninstall`.
#[tauri::command]
async fn compile_stop() -> Result<(), String> {
    blocking(|| {
        let bin = require_engine()?;
        engine::run_cli(&bin, &["watch", "--uninstall"])?;
        Ok(())
    })
    .await
}

/// Compile scheduler status: parse `homekb watch --status --json`.
#[tauri::command]
async fn compile_status() -> Result<DaemonStatus, String> {
    blocking(|| {
        let bin = require_engine()?;
        let out = engine::run_cli(&bin, &["watch", "--status", "--json"])?;
        parse_daemon_status(&out, "watch")
    })
    .await
}

// ---------- local connection service (this machine, port 8787; default off) ----------
//
// Decoupled from the connection card (docs "Desktop service picker"). The spawned
// process deliberately outlives the app — phones depend on it — so it is NOT
// registered in PROCS; stop only kills a pid this app (or the user) recorded in
// ~/.homekb-relay/relay.pid. launchd management is the follow-up.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalRelayStatus {
    running: bool,
    /// The service script exists (this machine can start one).
    installed: bool,
}

#[tauri::command]
async fn local_relay_status() -> Result<LocalRelayStatus, String> {
    blocking(|| {
        Ok(LocalRelayStatus {
            running: engine::local_relay_running(),
            installed: engine::local_relay_script().is_file(),
        })
    })
    .await
}

#[tauri::command]
async fn local_relay_start() -> Result<(), String> {
    blocking(|| {
        if engine::local_relay_running() {
            return Ok(()); // already up (possibly started outside the app)
        }
        let script = engine::local_relay_script();
        if !script.is_file() {
            return Err(format!(
                "service files not installed ({} missing)",
                script.display()
            ));
        }
        let node = engine::node_path().ok_or("Node.js not found on this machine")?;
        let log = engine::log_file("relay")?;
        let log2 = log.try_clone().map_err(|e| e.to_string())?;
        let child = Command::new(&node)
            .arg(&script)
            .args(["--port", "8787"])
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log2))
            .spawn()
            .map_err(|e| format!("failed to start the service: {e}"))?;
        // Record the pid, then drop the handle — the process outlives the app.
        let pid_file = engine::local_relay_pid_file();
        if let Some(parent) = pid_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&pid_file, child.id().to_string())
            .map_err(|e| format!("write pid file: {e}"))?;
        drop(child);
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if engine::local_relay_running() {
                return Ok(());
            }
        }
        Err("the service did not become ready within 3 seconds (see ~/Library/Logs/HomeKB/relay.log)".to_string())
    })
    .await
}

#[tauri::command]
async fn local_relay_stop() -> Result<(), String> {
    blocking(|| {
        let pid_file = engine::local_relay_pid_file();
        let pid = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .ok_or("the service was not started by this app (no pid recorded)")?;
        // SIGTERM via /bin/kill — avoids a libc dependency for one syscall.
        let _ = Command::new("/bin/kill").arg(pid.to_string()).status();
        let _ = std::fs::remove_file(&pid_file);
        Ok(())
    })
    .await
}

// ---------- desktop affordances ----------

/// Reveal the notes directory in the OS file manager (design 4a "Open HomeKB folder").
/// An allowed desktop affordance — still no system *dialogs* anywhere.
#[tauri::command]
async fn open_notes_dir() -> Result<(), String> {
    blocking(|| {
        let dir = engine::read_config().notes_dir;
        if !dir.is_dir() {
            return Err(format!("notes directory does not exist: {}", dir.display()));
        }
        #[cfg(target_os = "macos")]
        let opener = "open";
        #[cfg(target_os = "windows")]
        let opener = "explorer";
        #[cfg(all(unix, not(target_os = "macos")))]
        let opener = "xdg-open";
        Command::new(opener)
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("failed to open folder: {e}"))?;
        Ok(())
    })
    .await
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            engine_status,
            engine_install,
            engine_init,
            serve_ensure,
            config_set_ai_endpoint,
            index_stats,
            engine_rebuild_reindex,
            relay_register,
            relay_clear,
            relay_credentials,
            pair_new,
            tunnel_status,
            tunnel_start,
            tunnel_stop,
            compile_status,
            compile_start,
            compile_stop,
            local_relay_status,
            local_relay_start,
            local_relay_stop,
            open_notes_dir,
        ])
        .build(tauri::generate_context!())
        .expect("build tauri app")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                // Only reclaim serve; tunnel is kept alive by launchd and continues after app exit.
                let mut procs = PROCS.lock().unwrap();
                if let Some(mut c) = procs.serve.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        });
}
