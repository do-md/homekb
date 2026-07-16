//! Engine-side helpers: binary detection, config.toml summary, serve health check, CLI invocation.
//!
//! The desktop client is a pure renderer (docs/ARCHITECTURE.md "desktop client"):
//! this module only locates/invokes the `homekb` CLI and reads/writes the local
//! config.toml — it does not implement any engine logic.
//! Path defaults (root=~/.homekb, notes=<root>/notes) are governed by the
//! directory layout table in the architecture doc.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Engine binary detection order: env HOMEKB_BIN > ~/.local/bin/homekb > common install locations.
/// (GUI process PATH is minimal; cannot rely on `which`.)
pub fn engine_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HOMEKB_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let home = home_dir();
    let candidates = [
        home.join(".local/bin/homekb"),
        PathBuf::from("/usr/local/bin/homekb"),
        PathBuf::from("/opt/homebrew/bin/homekb"),
        home.join(".cargo/bin/homekb"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Install target: ~/.local/bin/homekb (per docs contract).
pub fn install_target() -> PathBuf {
    home_dir().join(".local/bin/homekb")
}

pub fn engine_version(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Some(s.trim().trim_start_matches("homekb").trim().to_string())
}

/// config.toml path: $HOMEKB_CONFIG > ~/.homekb/config.toml (new anchor,
/// when it exists) > $XDG_CONFIG_HOME/homekb/config.toml (legacy fallback)
/// > ~/.homekb/config.toml (same lookup order as engine config.rs).
pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("HOMEKB_CONFIG") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let anchored = home_dir().join(".homekb").join("config.toml");
    if anchored.is_file() {
        return anchored;
    }
    let xdg = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config"));
    let legacy = xdg.join("homekb").join("config.toml");
    if legacy.is_file() {
        return legacy;
    }
    anchored
}

fn expand_tilde(p: &str) -> PathBuf {
    let home = home_dir();
    if p == "~" {
        home
    } else if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(p)
    }
}

pub struct RelayInfo {
    pub url: String,
    pub home_id: String,
    pub name: String,
}

pub struct ConfigSummary {
    pub root: PathBuf,
    pub notes_dir: PathBuf,
    pub openai_key_present: bool,
    pub relay: Option<RelayInfo>,
}

/// Read-only summary (for rendering); writes go only through [`set_openai_key`] or the engine CLI.
pub fn read_config() -> ConfigSummary {
    let tbl: toml::Table = fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| toml::from_str(&raw).ok())
        .unwrap_or_default();

    let str_of = |k: &str| tbl.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty());

    let root = str_of("root")
        .map(expand_tilde)
        .unwrap_or_else(|| home_dir().join(".homekb"));
    let notes_dir = str_of("notes_dir")
        .map(expand_tilde)
        .unwrap_or_else(|| root.join("notes"));

    // Whether a key is reachable by the engine: [embedding]/[summary] api_key,
    // the legacy top-level openai_api_key, or the ~/.config/openai/api_key
    // fallback. (Env vars are typically absent in GUI processes; not counted.)
    let section_key = |name: &str| {
        tbl.get(name)
            .and_then(|v| v.as_table())
            .and_then(|t| t.get("api_key"))
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    };
    let key_in_config =
        str_of("openai_api_key").is_some() || section_key("embedding") || section_key("summary");
    let key_in_fallback = {
        let xdg = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"));
        fs::read_to_string(xdg.join("openai").join("api_key"))
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    };

    let relay = tbl.get("relay").and_then(|v| v.as_table()).and_then(|r| {
        let url = r.get("url")?.as_str().filter(|s| !s.is_empty())?.to_string();
        Some(RelayInfo {
            url,
            home_id: r.get("home_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            name: r.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        })
    });

    ConfigSummary {
        root,
        notes_dir,
        openai_key_present: key_in_config || key_in_fallback,
        relay,
    }
}

/// Relay credentials for the homeSecret-authenticated relay endpoints (grants
/// list/revoke). Read directly from config.toml `[relay]`; the secret stays on
/// this machine and only ever travels to the relay this home registered with.
pub fn relay_credentials() -> Option<(String, String)> {
    let tbl: toml::Table = fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| toml::from_str(&raw).ok())?;
    let r = tbl.get("relay")?.as_table()?;
    let url = r.get("url")?.as_str().filter(|s| !s.is_empty())?.to_string();
    let secret = r
        .get("home_secret")?
        .as_str()
        .filter(|s| !s.is_empty())?
        .to_string();
    Some((url, secret))
}

/// Write openai_api_key: read-modify-write the whole table (toml::Table preserves
/// unknown fields; comments are not preserved — config is machine-written by init/register).
pub fn set_openai_key(key: &str) -> Result<(), String> {
    let path = config_path();
    let mut tbl: toml::Table = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| toml::from_str(&raw).ok())
        .unwrap_or_default();
    tbl.insert("openai_api_key".into(), toml::Value::String(key.to_string()));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let body = toml::to_string_pretty(&tbl).map_err(|e| format!("failed to serialize config: {e}"))?;
    fs::write(&path, format!("# homekb configuration — see docs/ARCHITECTURE.md\n{body}"))
        .map_err(|e| format!("write {}: {e}", path.display()))
}

/// Clear the `[relay]` registration (disconnect from the connection service).
/// Read-modify-write, preserving every other field; a no-op if none exists.
pub fn clear_relay() -> Result<(), String> {
    let path = config_path();
    let mut tbl: toml::Table = match fs::read_to_string(&path).ok().and_then(|raw| toml::from_str(&raw).ok()) {
        Some(t) => t,
        None => return Ok(()),
    };
    if tbl.remove("relay").is_none() {
        return Ok(());
    }
    let body = toml::to_string_pretty(&tbl).map_err(|e| format!("failed to serialize config: {e}"))?;
    fs::write(&path, format!("# homekb configuration — see docs/ARCHITECTURE.md\n{body}"))
        .map_err(|e| format!("write {}: {e}", path.display()))
}

/// Node binary detection (GUI PATH is minimal; cannot rely on `which`).
pub fn node_path() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
        home_dir().join(".volta/bin/node"),
        home_dir().join(".nvm/current/bin/node"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// The local connection-service script: env HOMEKB_RELAY_DIST > ~/.homekb-relay/server.mjs
/// (docs/ARCHITECTURE.md "Desktop service picker").
pub fn local_relay_script() -> PathBuf {
    if let Ok(p) = std::env::var("HOMEKB_RELAY_DIST") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    home_dir().join(".homekb-relay").join("server.mjs")
}

pub fn local_relay_pid_file() -> PathBuf {
    home_dir().join(".homekb-relay").join("relay.pid")
}

/// Local connection-service liveness: TCP probe of the relay port (8787).
pub fn local_relay_running() -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 8787));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Serve health check: GET /health via raw HTTP/1.1 with 300ms connection timeout (avoids an http client dependency).
pub fn serve_health() -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 8765));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 64];
    let Ok(n) = stream.read(&mut buf) else { return false };
    String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200")
}

/// Run an engine CLI subcommand; returns stdout on success or the last few stderr lines on failure.
pub fn run_cli(bin: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("cannot run {}: {e}", bin.display()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.trim().lines().rev().take(3).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        Err(if tail.is_empty() {
            format!("homekb {} failed ({})", args.join(" "), out.status)
        } else {
            tail.join("\n")
        })
    }
}

/// Child process log file: ~/Library/Logs/HomeKB/<name>.log (macOS first).
pub fn log_file(name: &str) -> Result<fs::File, String> {
    let dir = home_dir().join("Library/Logs/HomeKB");
    fs::create_dir_all(&dir).map_err(|e| format!("create log directory: {e}"))?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{name}.log")))
        .map_err(|e| format!("open log file: {e}"))
}
