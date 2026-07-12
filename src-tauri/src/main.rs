//! HomeKB 桌面客户端（Tauri 2，macOS 先行）。
//!
//! 纯渲染器（docs/ARCHITECTURE.md「桌面客户端」）：UI 与 Web 版同一份，
//! 数据面直连本机 `homekb serve`；本壳只承担同机专属职责——检测/安装引擎、
//! serve/tunnel 生命周期、config.toml 读写、配对码生成。
//! 约定：不引入 dialog 插件，全流程无系统弹框；保存走引擎 RPC 直落数据目录。

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
    tunnel: Option<Child>,
}

/// 子进程台账。挂 static 而非 tauri State：spawn_blocking 闭包要 'static。
static PROCS: Mutex<Procs> = Mutex::new(Procs { serve: None, tunnel: None });

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
    engine::engine_path().ok_or_else(|| "引擎未安装".to_string())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------- 引擎 ----------

#[tauri::command]
async fn engine_status(app: tauri::AppHandle) -> Result<EngineStatus, String> {
    blocking(move || Ok(build_status(&app))).await
}

/// 首启安装：捆绑资源二进制 → ~/.local/bin/homekb（无弹框，文档契约）。
#[tauri::command]
async fn engine_install(app: tauri::AppHandle) -> Result<String, String> {
    blocking(move || {
        let src = bundled_engine(&app).ok_or("App 内未捆绑引擎二进制")?;
        let dst = engine::install_target();
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建 {}: {e}", parent.display()))?;
        }
        std::fs::copy(&src, &dst).map_err(|e| format!("安装引擎失败: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("设置可执行权限失败: {e}"))?;
        }
        Ok(dst.display().to_string())
    })
    .await
}

/// `homekb init`：建目录树 + 写配置（幂等）。
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

// ---------- serve 生命周期 ----------

/// 已在跑（外部进程）→ 附着；没在跑 → spawn 子进程并等健康。
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
            .map_err(|e| format!("启动 homekb serve 失败: {e}"))?;
        PROCS.lock().unwrap().serve = Some(child);
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if engine::serve_health() {
                return Ok("spawned".to_string());
            }
        }
        Err("homekb serve 未在 5 秒内就绪（详见 ~/Library/Logs/HomeKB/serve.log）".to_string())
    })
    .await
}

// ---------- 配置 ----------

#[tauri::command]
async fn config_set_openai_key(key: String) -> Result<(), String> {
    blocking(move || engine::set_openai_key(key.trim())).await
}

// ---------- 中继 ----------

#[tauri::command]
async fn relay_register(url: String) -> Result<(), String> {
    blocking(move || {
        let bin = require_engine()?;
        engine::run_cli(&bin, &["register", "--relay", url.trim()])?;
        Ok(())
    })
    .await
}

/// `homekb pair --json` → {code, expiresAt, relayUrl, homeName} 原样透传。
#[tauri::command]
async fn pair_new() -> Result<serde_json::Value, String> {
    blocking(|| {
        let bin = require_engine()?;
        let out = engine::run_cli(&bin, &["pair", "--json"])?;
        let line = out.lines().rev().find(|l| l.trim_start().starts_with('{'))
            .ok_or("pair 输出里没有 JSON")?;
        serde_json::from_str(line).map_err(|e| format!("解析配对码输出失败: {e}"))
    })
    .await
}

// ---------- tunnel 生命周期 ----------

fn tunnel_managed_alive() -> bool {
    let mut procs = PROCS.lock().unwrap();
    match procs.tunnel.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            _ => {
                procs.tunnel = None;
                false
            }
        },
        None => false,
    }
}

fn tunnel_external_alive() -> bool {
    Command::new("/usr/bin/pgrep")
        .args(["-f", "homekb tunnel"])
        .stdout(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tauri::command]
async fn tunnel_status() -> Result<TunnelStatus, String> {
    blocking(|| {
        let managed = tunnel_managed_alive();
        Ok(TunnelStatus { running: managed || tunnel_external_alive(), managed })
    })
    .await
}

#[tauri::command]
async fn tunnel_start() -> Result<(), String> {
    blocking(|| {
        if tunnel_managed_alive() || tunnel_external_alive() {
            return Ok(());
        }
        let bin = require_engine()?;
        let log = engine::log_file("tunnel")?;
        let log2 = log.try_clone().map_err(|e| e.to_string())?;
        let child = Command::new(&bin)
            .arg("tunnel")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log2))
            .spawn()
            .map_err(|e| format!("启动 homekb tunnel 失败: {e}"))?;
        PROCS.lock().unwrap().tunnel = Some(child);
        Ok(())
    })
    .await
}

/// 优先杀自己 spawn 的子进程；外部起的用 pkill 兜底（文档契约）。
#[tauri::command]
async fn tunnel_stop() -> Result<(), String> {
    blocking(|| {
        let managed = {
            let mut procs = PROCS.lock().unwrap();
            procs.tunnel.take()
        };
        if let Some(mut child) = managed {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        let _ = Command::new("/usr/bin/pkill").args(["-f", "homekb tunnel"]).status();
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
                // serve 随 App 回收；tunnel 是「常驻」语义，故意留活
                // （用户可在设置里关，或 CLI/pkill）。
                let mut procs = PROCS.lock().unwrap();
                if let Some(mut c) = procs.serve.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        });
}
