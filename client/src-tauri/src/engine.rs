//! Engine-side helpers: binary detection, acquisition (GitHub release download),
//! config.toml summary, serve health check, CLI invocation.
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

/// One AI endpoint section as rendered by Settings (docs/ARCHITECTURE.md
/// "AI provider presets"): resolved provider/model for display, whether a
/// key is reachable, and whether the section exists in config.toml at all
/// (for [ask], absent = summary fallback).
#[derive(Clone)]
pub struct AiEndpointInfo {
    pub provider: String,
    pub model: String,
    pub key_present: bool,
    pub configured: bool,
}

pub struct ConfigSummary {
    pub root: PathBuf,
    pub notes_dir: PathBuf,
    pub embedding: AiEndpointInfo,
    pub summary: AiEndpointInfo,
    pub ask: AiEndpointInfo,
    pub relay: Option<RelayInfo>,
}

/// Display default model per provider (mirrors the engine's preset table —
/// the shell renders config, it does not implement engine logic).
fn preset_default_model(provider: &str, chat: bool) -> &'static str {
    match (provider, chat) {
        ("openai", false) => "text-embedding-3-small",
        ("gemini", false) => "gemini-embedding-001",
        ("voyage", false) => "voyage-4",
        ("cohere", false) => "embed-v4.0",
        ("qwen", false) => "text-embedding-v4",
        ("openai", true) => "gpt-4o-mini",
        ("gemini", true) => "gemini-flash-lite-latest",
        ("deepseek", true) => "deepseek-chat",
        ("qwen", true) => "qwen-flash",
        _ => "",
    }
}

/// Read-only summary (for rendering); writes go only through
/// [`set_ai_endpoint`] or the engine CLI.
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

    // Per-section endpoint summaries. A key counts as reachable when the
    // section has one, when the provider is openai and a legacy key exists
    // (top-level openai_api_key or ~/.config/openai/api_key), or when the
    // provider is custom (keyless gateways are legal). Env vars are
    // typically absent in GUI processes and are not counted.
    let legacy_openai_key = str_of("openai_api_key").is_some() || {
        let xdg = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"));
        fs::read_to_string(xdg.join("openai").join("api_key"))
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    };
    let ai_section = |name: &str, chat: bool, legacy_model: Option<&str>| {
        let sec = tbl.get(name).and_then(|v| v.as_table());
        let sec_str = |k: &str| {
            sec.and_then(|t| t.get(k))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        let provider = sec_str("provider").unwrap_or("openai").to_string();
        let model = sec_str("model")
            .map(str::to_string)
            .or_else(|| legacy_model.map(str::to_string))
            .unwrap_or_else(|| preset_default_model(&provider, chat).to_string());
        let key_present = sec_str("api_key").is_some()
            || provider == "custom"
            || (provider == "openai" && legacy_openai_key);
        AiEndpointInfo {
            provider,
            model,
            key_present,
            configured: sec.is_some(),
        }
    };
    let embedding = ai_section("embedding", false, str_of("embedding_model"));
    let summary = ai_section("summary", true, str_of("summarizer_model"));
    let ask = ai_section("ask", true, None);

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
        embedding,
        summary,
        ask,
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

/// Write one `[embedding]`/`[summary]`/`[ask]` section (docs/ARCHITECTURE.md
/// desktop command list, `config_set_ai_endpoint`). Read-modify-write the
/// whole table (unknown fields preserved; comments are not — config is
/// machine-written by init/register).
///
/// Semantics: an omitted/empty `api_key` keeps the stored key when the
/// provider is unchanged (switching provider clears section fields first);
/// an omitted/empty `model` resets to the provider default; an empty
/// `provider` on `ask` deletes the section (back to the summary fallback).
/// Writes land at the `~/.homekb/config.toml` anchor and migrate a legacy
/// `~/.config/homekb/config.toml` (renamed to `config.toml.migrated`),
/// mirroring the engine's own save semantics.
pub fn set_ai_endpoint(
    section: &str,
    provider: &str,
    api_key: Option<&str>,
    model: Option<&str>,
    base_url: Option<&str>,
    dim: Option<u32>,
) -> Result<(), String> {
    let chat = match section {
        "embedding" => false,
        "summary" | "ask" => true,
        other => return Err(format!("unknown config section \"{other}\"")),
    };
    let read_path = config_path();
    let mut tbl: toml::Table = fs::read_to_string(&read_path)
        .ok()
        .and_then(|raw| toml::from_str(&raw).ok())
        .unwrap_or_default();

    // Drop the legacy top-level model keys — they are superseded by the
    // `[embedding]`/`[summary]` sections and, if left behind, an openai-shaped
    // `embedding_model`/`summarizer_model` can bleed into a gemini/… section
    // (wrong model name → provider 404). Once the user edits any section via
    // the UI, retire them for good.
    tbl.remove("embedding_model");
    tbl.remove("embedding_dim");
    tbl.remove("summarizer_model");

    let provider = provider.trim();
    if section == "ask" && provider.is_empty() {
        tbl.remove("ask");
        return write_config_migrating(&tbl);
    }
    let allowed: &[&str] = if chat {
        &["openai", "gemini", "deepseek", "qwen", "custom"]
    } else {
        &["openai", "gemini", "voyage", "cohere", "qwen", "custom"]
    };
    if !allowed.contains(&provider) {
        return Err(format!(
            "unknown provider \"{provider}\" for [{section}] (known: {})",
            allowed.join(" | ")
        ));
    }
    let base_url = base_url.map(str::trim).filter(|s| !s.is_empty());
    if provider == "custom" && base_url.is_none() {
        return Err(format!("[{section}] provider \"custom\" requires a base URL"));
    }

    let mut sec = tbl
        .get(section)
        .and_then(|v| v.as_table())
        .cloned()
        .unwrap_or_default();
    let prev_provider = sec
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("openai")
        .to_string();
    if prev_provider != provider {
        // Provider switch: stored key/model/dim/base_url belong to the old one.
        sec.remove("api_key");
        sec.remove("model");
        sec.remove("dim");
        sec.remove("base_url");
    }
    sec.insert("provider".into(), toml::Value::String(provider.to_string()));
    if let Some(k) = api_key.map(str::trim).filter(|s| !s.is_empty()) {
        sec.insert("api_key".into(), toml::Value::String(k.to_string()));
    }
    match model.map(str::trim) {
        Some("") => {
            sec.remove("model");
        }
        Some(m) => {
            sec.insert("model".into(), toml::Value::String(m.to_string()));
        }
        None => {}
    }
    if let Some(u) = base_url {
        sec.insert("base_url".into(), toml::Value::String(u.to_string()));
    }
    if section == "embedding" {
        if let Some(d) = dim {
            if d > 0 {
                sec.insert("dim".into(), toml::Value::Integer(d as i64));
            } else {
                sec.remove("dim");
            }
        }
    }
    tbl.insert(section.into(), toml::Value::Table(sec));
    write_config_migrating(&tbl)
}

/// Persist a config table: `$HOMEKB_CONFIG` or the `~/.homekb/config.toml`
/// anchor; a legacy `~/.config/homekb/config.toml` is renamed to
/// `config.toml.migrated` after a successful write (engine save semantics).
fn write_config_migrating(tbl: &toml::Table) -> Result<(), String> {
    let env_override = std::env::var("HOMEKB_CONFIG").ok().filter(|p| !p.is_empty());
    let path = env_override
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".homekb").join("config.toml"));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let body = toml::to_string_pretty(tbl).map_err(|e| format!("failed to serialize config: {e}"))?;
    fs::write(&path, format!("# homekb configuration — see docs/ARCHITECTURE.md\n{body}"))
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    if env_override.is_none() {
        let xdg = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"));
        let legacy = xdg.join("homekb").join("config.toml");
        if legacy.is_file() && legacy != path {
            let _ = fs::rename(&legacy, legacy.with_extension("toml.migrated"));
        }
    }
    Ok(())
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

// ---------- Engine acquisition (docs/ARCHITECTURE.md "Engine acquisition") ----------
//
// The app does not bundle the engine: when none is detected (or the user asks
// for an upgrade), the latest `engine-v*` GitHub release artifact is downloaded
// and installed to ~/.local/bin/homekb. Artifact names are the Distribution
// name contract shared with install.sh / Homebrew / Scoop.

/// GitHub repository hosting `engine-v*` releases.
const ENGINE_REPO: &str = "do-md/homekb";
/// Engine release tag prefix — desktop `v*` tags share the repo, so "latest
/// engine" must filter by this prefix and never use `releases/latest`.
const ENGINE_TAG_PREFIX: &str = "engine-v";

/// Platform artifact name (Distribution name contract, docs/ARCHITECTURE.md).
fn engine_artifact_name() -> Result<&'static str, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Ok("homekb-macos-arm64.tar.gz");
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return Ok("homekb-macos-x64.tar.gz");
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return Ok("homekb-linux-x64.tar.gz");
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Ok("homekb-windows-x64.zip");
    #[allow(unreachable_code)]
    Err("no prebuilt engine binary for this platform (see docs/ARCHITECTURE.md \"Distribution\")".to_string())
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(concat!("homekb-desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))
}

pub struct EngineRelease {
    pub tag: String,
    pub version: String,
}

/// Resolve the latest published engine release: list releases (newest first)
/// and take the first non-draft, non-prerelease `engine-v*` tag.
pub fn latest_engine_release() -> Result<EngineRelease, String> {
    let url = format!("https://api.github.com/repos/{ENGINE_REPO}/releases?per_page=30");
    let resp = http_client()?
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|e| format!("cannot reach GitHub to look up the engine release: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("engine release lookup failed (GitHub returned {})", resp.status()));
    }
    let body = resp
        .text()
        .map_err(|e| format!("failed to read GitHub release list: {e}"))?;
    let releases: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("unexpected GitHub release list response: {e}"))?;
    let rel = releases
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| {
            r["tag_name"]
                .as_str()
                .is_some_and(|t| t.starts_with(ENGINE_TAG_PREFIX))
                && !r["draft"].as_bool().unwrap_or(false)
                && !r["prerelease"].as_bool().unwrap_or(false)
        })
        .ok_or_else(|| format!("no {ENGINE_TAG_PREFIX}* release found in {ENGINE_REPO}"))?;
    let tag = rel["tag_name"].as_str().unwrap_or_default().to_string();
    let version = tag.trim_start_matches(ENGINE_TAG_PREFIX).to_string();
    Ok(EngineRelease { tag, version })
}

/// Download the release artifact for this platform and install (or upgrade) it
/// to ~/.local/bin/homekb. Staged write → verify (`--version`) → remove the old
/// binary → rename into place. Never an in-place overwrite: rewriting through
/// the same inode invalidates the macOS kernel signature cache and every
/// subsequent exec is SIGKILLed. Returns the installed engine version.
pub fn download_and_install_engine(tag: &str) -> Result<String, String> {
    download_and_install_engine_to(tag, &install_target())
}

fn download_and_install_engine_to(tag: &str, dst: &Path) -> Result<String, String> {
    let artifact = engine_artifact_name()?;
    let url = format!("https://github.com/{ENGINE_REPO}/releases/download/{tag}/{artifact}");
    let resp = http_client()?
        .get(&url)
        .send()
        .map_err(|e| format!("engine download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("engine download failed (GitHub returned {} for {artifact})", resp.status()));
    }
    let bytes = resp
        .bytes()
        .map_err(|e| format!("engine download interrupted: {e}"))?;

    let dir = dst
        .parent()
        .ok_or_else(|| "install target has no parent directory".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    // Staged in the same directory so the final rename is atomic (same filesystem).
    let staged = dir.join(".homekb.download");
    extract_engine_archive(artifact, &bytes, &staged)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("set executable permission failed: {e}"))?;
    }
    let Some(version) = engine_version(&staged) else {
        let _ = fs::remove_file(&staged);
        return Err("downloaded engine binary failed to run (--version)".to_string());
    };
    if dst.exists() {
        fs::remove_file(&dst).map_err(|e| format!("remove old engine binary: {e}"))?;
    }
    fs::rename(&staged, &dst).map_err(|e| format!("engine install failed: {e}"))?;
    Ok(version)
}

/// Extract the single `homekb` binary out of a release archive into `staged`.
fn extract_engine_archive(artifact: &str, bytes: &[u8], staged: &Path) -> Result<(), String> {
    if !artifact.ends_with(".tar.gz") {
        // homekb-windows-x64.zip — the desktop shell does not ship on Windows yet;
        // when it does, add zip extraction here.
        return Err(format!(
            "auto-install cannot unpack {artifact} on this platform — install the engine via a package manager instead"
        ));
    }
    let gz = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(gz);
    for entry in archive.entries().map_err(|e| format!("read engine archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("read engine archive entry: {e}"))?;
        let is_engine = entry
            .path()
            .ok()
            .and_then(|p| p.file_name().map(|n| n == "homekb"))
            .unwrap_or(false);
        if entry.header().entry_type().is_file() && is_engine {
            let mut out = fs::File::create(staged)
                .map_err(|e| format!("stage {}: {e}", staged.display()))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract engine binary: {e}"))?;
            return Ok(());
        }
    }
    Err(format!("no homekb binary found inside {artifact}"))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Live end-to-end acquisition test against the real GitHub release —
    /// network-dependent, so ignored by default:
    ///   cargo test -- --ignored engine_acquisition_live
    #[test]
    #[ignore = "live network: resolves + downloads the real engine-v* release"]
    fn engine_acquisition_live() {
        let rel = latest_engine_release().expect("resolve latest engine release");
        assert!(rel.tag.starts_with(ENGINE_TAG_PREFIX), "tag {} lacks prefix", rel.tag);
        assert!(!rel.version.is_empty());

        let dir = std::env::temp_dir().join(format!("homekb-engine-install-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let dst = dir.join("homekb");
        // Fresh install, then a second run over the existing binary (the
        // upgrade path: remove-then-rename, never an in-place overwrite).
        let v1 = download_and_install_engine_to(&rel.tag, &dst).expect("fresh install");
        assert_eq!(v1, rel.version);
        let v2 = download_and_install_engine_to(&rel.tag, &dst).expect("reinstall over existing");
        assert_eq!(v2, rel.version);
        assert_eq!(engine_version(&dst).as_deref(), Some(rel.version.as_str()));
        let _ = fs::remove_dir_all(&dir);
    }
}
