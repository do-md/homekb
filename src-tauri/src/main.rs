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
    openai_key_present: bool,
    relay: Option<RelayStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayStatus {
    url: String,
    home_id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelStatus {
    running: bool,
    managed: bool,
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
        openai_key_present: cfg.openai_key_present,
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

/// Already running (external process) → attach; not running → spawn child and wait for healthy.
#[tauri::command]
async fn serve_ensure() -> Result<String, String> {
    blocking(|| {
        if engine::serve_health() {
            return Ok("external".to_string());
        }
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
    })
    .await
}

// ---------- config ----------

#[tauri::command]
async fn config_set_openai_key(key: String) -> Result<(), String> {
    blocking(move || engine::set_openai_key(key.trim())).await
}

// ---------- relay ----------

#[tauri::command]
async fn relay_register(url: String) -> Result<(), String> {
    blocking(move || {
        let bin = require_engine()?;
        engine::run_cli(&bin, &["register", "--relay", url.trim()])?;
        Ok(())
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
async fn tunnel_status() -> Result<TunnelStatus, String> {
    blocking(|| {
        let bin = require_engine()?;
        let out = engine::run_cli(&bin, &["tunnel", "--status", "--json"])?;
        let line = out
            .lines()
            .rev()
            .find(|l| l.trim_start().starts_with('{'))
            .ok_or("no JSON in tunnel --status output")?;
        let v: serde_json::Value =
            serde_json::from_str(line).map_err(|e| format!("failed to parse tunnel status: {e}"))?;
        Ok(TunnelStatus {
            running: v["running"].as_bool().unwrap_or(false),
            managed: v["installed"].as_bool().unwrap_or(false),
        })
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
            config_set_openai_key,
            relay_register,
            pair_new,
            tunnel_status,
            tunnel_start,
            tunnel_stop,
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
