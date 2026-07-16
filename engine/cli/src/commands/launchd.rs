//! macOS launchd (LaunchAgent) wrapper: plist generation + bootstrap/bootout/enable/kickstart.
//!
//! macOS-only (callers guard with `#[cfg(target_os = "macos")]`). Design notes:
//!   - Uses the modern `launchctl` domain-target syntax (`bootstrap`/`bootout`/`enable`/`kickstart`),
//!     not the deprecated `load`/`unload`.
//!   - `install` is idempotent: `bootout` clears the old service first (also picks up interval changes),
//!     then writes the plist, bootstraps, and kickstarts with -k.
//!   - LaunchAgent is inherently per-user (`~/Library/LaunchAgents` + `gui/$UID` domain): no sudo, no TCC prompt.

use anyhow::{Context, Result, bail};
use std::path::PathBuf;
use std::process::Command;

/// launchd Label for the tunnel daemon service (product-level, no username).
pub const TUNNEL_LABEL: &str = "com.homekb.tunnel";

/// launchd Label for the background compile service (scheduled reindex).
pub const COMPILE_LABEL: &str = "com.homekb.compile";

/// Service state as reported by launchd.
pub struct ServiceState {
    /// Whether the plist file exists on disk.
    pub installed: bool,
    /// Whether launchd has bootstrapped the service (`launchctl print` exits 0).
    pub loaded: bool,
    /// Whether there is a live PID / `state = running`.
    pub running: bool,
    pub pid: Option<i64>,
}

fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().context("cannot determine home directory")
}

/// `~/Library/LaunchAgents/<label>.plist`
pub fn plist_path(label: &str) -> Result<PathBuf> {
    Ok(home_dir()?.join("Library/LaunchAgents").join(format!("{label}.plist")))
}

/// Current user uid via `/usr/bin/id -u` (avoids a libc dependency).
fn uid() -> Result<u32> {
    let out = Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .context("run /usr/bin/id -u")?;
    anyhow::ensure!(out.status.success(), "id -u failed");
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim().parse::<u32>().context("parse uid")
}

/// `gui/<uid>` — per-user GUI domain (login session).
fn gui_domain() -> Result<String> {
    Ok(format!("gui/{}", uid()?))
}

/// `gui/<uid>/<label>` — service target.
fn service_target(label: &str) -> Result<String> {
    Ok(format!("{}/{label}", gui_domain()?))
}

fn launchctl(args: &[&str]) -> Result<std::process::Output> {
    Command::new("/bin/launchctl")
        .args(args)
        .output()
        .with_context(|| format!("failed to run launchctl {}", args.join(" ")))
}

/// bootout: if the service is not loaded launchctl returns non-zero ("No such process" / "Could not find"),
/// which is treated as an idempotent success.
fn bootout(label: &str) -> Result<()> {
    let target = service_target(label)?;
    let out = launchctl(&["bootout", &target])?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("No such process")
        || stderr.contains("Could not find")
        || stderr.contains("not find")
    {
        return Ok(()); // not loaded → idempotent OK
    }
    bail!("launchctl bootout failed: {}", stderr.trim());
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Generates the plist text for a KeepAlive-only LaunchAgent. `program_args` is the full argv
/// (starting with the binary path). Used for both the tunnel and the compile agents.
pub fn daemon_plist(label: &str, program_args: &[&str], log_path: &str) -> String {
    let log = xml_escape(log_path);
    let args_xml: String = program_args
        .iter()
        .map(|a| format!("    <string>{}</string>\n", xml_escape(a)))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{args_xml}  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
"#
    )
}

/// Absolute path to `~/.local/bin/homekb` (stable plist anchor); validates existence.
pub fn home_bin_path() -> Result<String> {
    let p = home_dir()?.join(".local/bin/homekb");
    anyhow::ensure!(
        p.is_file(),
        "engine binary not found at {}; install the engine there before running --install",
        p.display()
    );
    Ok(p.to_string_lossy().into_owned())
}

/// Log file path `~/Library/Logs/HomeKB/<name>.log`; creates the directory on demand
/// (launchd silently refuses to start when the log directory is missing).
pub fn log_path(name: &str) -> Result<String> {
    let dir = home_dir()?.join("Library/Logs/HomeKB");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create log directory {}", dir.display()))?;
    Ok(dir.join(format!("{name}.log")).to_string_lossy().into_owned())
}

/// Idempotent install and start: bootout old → write plist → bootstrap → enable → kickstart -k.
pub fn install(label: &str, plist_body: &str) -> Result<()> {
    let path = plist_path(label)?;
    // 1. Clear old service (picks up interval changes; no-op if not installed)
    bootout(label)?;
    // 2. Write plist
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
    }
    std::fs::write(&path, plist_body)
        .with_context(|| format!("write {}", path.display()))?;
    // 3. Bootstrap into the gui domain (domain-target + plist path)
    let domain = gui_domain()?;
    let out = launchctl(&["bootstrap", &domain, &path.to_string_lossy()])?;
    if !out.status.success() {
        bail!(
            "launchctl bootstrap failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    // 4. enable (clears any historical disable flag) — non-fatal
    let _ = launchctl(&["enable", &service_target(label)?]);
    // 5. kickstart -k: start immediately (-k = kill if running, then restart, ensures new plist is used)
    let out = launchctl(&["kickstart", "-k", &service_target(label)?])?;
    if !out.status.success() {
        tracing::warn!(
            "kickstart failed (RunAtLoad should have started it): {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// Stop and uninstall: bootout → delete plist.
pub fn uninstall(label: &str) -> Result<()> {
    bootout(label)?;
    let path = plist_path(label)?;
    if path.exists() {
        std::fs::remove_file(&path)
            .with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}

/// Restart a service if (and only if) it is currently loaded: `kickstart -k`
/// (kill + start, forcing a fresh config read). Returns whether a restart happened.
/// Used by `homekb register`: registering mints a new home identity, so a running
/// tunnel must reload its credentials or the new home looks offline to phones.
pub fn restart_if_loaded(label: &str) -> Result<bool> {
    if !status(label)?.loaded {
        return Ok(false);
    }
    let out = launchctl(&["kickstart", "-k", &service_target(label)?])?;
    if !out.status.success() {
        bail!(
            "launchctl kickstart failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(true)
}

/// Query status: uses `launchctl print` (more reliably distinguishes loaded vs running than `list`).
pub fn status(label: &str) -> Result<ServiceState> {
    let installed = plist_path(label)?.exists();
    let out = launchctl(&["print", &service_target(label)?])?;
    if !out.status.success() {
        // print returns non-zero for services that are not loaded
        return Ok(ServiceState { installed, loaded: false, running: false, pid: None });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let pid = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("pid = "))
        .and_then(|v| v.trim().parse::<i64>().ok());
    let running = pid.is_some() || text.lines().any(|l| l.trim() == "state = running");
    Ok(ServiceState { installed, loaded: true, running, pid })
}
