//! Background compile schedule — the `com.homekb.compile` LaunchAgent
//! (`homekb watch --interval N`) as a shared capability.
//!
//! One implementation behind two callers (docs/ARCHITECTURE.md "RPC methods"):
//! the CLI (`homekb watch --install/--uninstall/--status`) and the RPC methods
//! `kb.scheduleGet`/`kb.scheduleSet`, so remote clients (web Status page) can
//! enable background compilation and set the interval without shell access.
//! macOS/launchd only for now; other platforms report `supported: false`
//! (systemd user units planned).

use anyhow::Result;
use serde::Serialize;

/// Default seconds between scheduled compile runs (`homekb watch` default).
pub const DEFAULT_COMPILE_INTERVAL_SECS: u64 = 300;
/// Interval clamp for the *scheduled* agent (foreground `homekb watch` is not
/// clamped): below 60s a compile loop is pure churn, above a day it is off.
pub const MIN_INTERVAL_SECS: u64 = 60;
pub const MAX_INTERVAL_SECS: u64 = 86_400;

/// State of the background compile schedule, serialized for `kb.scheduleGet`
/// / `kb.scheduleSet` and `homekb watch --status --json`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleState {
    /// Whether this platform can manage a background schedule at all.
    pub supported: bool,
    /// Whether the LaunchAgent plist is installed.
    pub installed: bool,
    /// Whether launchd reports the agent as running.
    pub running: bool,
    /// The installed `--interval` in seconds (None when not installed).
    pub interval_secs: Option<u64>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn clamp_interval(interval: u64) -> u64 {
    interval.clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS)
}

/// Parse `--interval N` out of a LaunchAgent plist body (ProgramArguments are
/// `<string>` elements; the value follows the flag). Pure so it is testable on
/// every platform.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_interval_from_plist(body: &str) -> Option<u64> {
    let after = body.split("<string>--interval</string>").nth(1)?;
    let value = after.split("<string>").nth(1)?.split("</string>").next()?;
    value.trim().parse::<u64>().ok()
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::launchd;

    /// Read the installed compile agent's `--interval N` back out of the
    /// plist ProgramArguments (the plist is the single source of truth for the
    /// schedule — there is no config.toml field to drift from it).
    fn installed_interval() -> Option<u64> {
        let path = launchd::plist_path(launchd::COMPILE_LABEL).ok()?;
        let body = std::fs::read_to_string(path).ok()?;
        super::parse_interval_from_plist(&body)
    }

    pub fn schedule_status() -> Result<ScheduleState> {
        let st = launchd::status(launchd::COMPILE_LABEL)?;
        Ok(ScheduleState {
            supported: true,
            installed: st.installed,
            running: st.running,
            interval_secs: if st.installed { installed_interval() } else { None },
        })
    }

    /// Install (or re-install — idempotent, picks up interval changes) and
    /// start the compile agent. `interval_secs: None` keeps the currently
    /// installed interval, falling back to the default.
    pub fn schedule_enable(interval_secs: Option<u64>) -> Result<ScheduleState> {
        let interval = clamp_interval(
            interval_secs
                .or_else(installed_interval)
                .unwrap_or(DEFAULT_COMPILE_INTERVAL_SECS),
        );
        let bin = launchd::home_bin_path()?;
        let log = launchd::log_path("compile")?;
        let interval_s = interval.to_string();
        let body = launchd::daemon_plist(
            launchd::COMPILE_LABEL,
            &[&bin, "watch", "--interval", &interval_s],
            &log,
            // Batch compile work: deliberately yield to the user's foreground apps.
            launchd::ProcessType::Background,
        );
        launchd::install(launchd::COMPILE_LABEL, &body)?;
        schedule_status()
    }

    /// Stop and remove the compile agent (pauses background compilation;
    /// serve and the tunnel are untouched).
    pub fn schedule_disable() -> Result<ScheduleState> {
        launchd::uninstall(launchd::COMPILE_LABEL)?;
        schedule_status()
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn schedule_status() -> Result<ScheduleState> {
        Ok(ScheduleState { supported: false, installed: false, running: false, interval_secs: None })
    }

    pub fn schedule_enable(_interval_secs: Option<u64>) -> Result<ScheduleState> {
        anyhow::bail!(
            "background compile scheduling is currently macOS-only (launchd); run `homekb watch` in the foreground instead"
        )
    }

    pub fn schedule_disable() -> Result<ScheduleState> {
        anyhow::bail!("background compile scheduling is currently macOS-only")
    }
}

pub use imp::{schedule_disable, schedule_enable, schedule_status};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_interval_to_schedule_bounds() {
        assert_eq!(clamp_interval(1), MIN_INTERVAL_SECS);
        assert_eq!(clamp_interval(300), 300);
        assert_eq!(clamp_interval(1_000_000), MAX_INTERVAL_SECS);
    }

    #[test]
    fn parses_interval_from_plist_program_arguments() {
        let body = r#"<array>
    <string>/Users/x/.local/bin/homekb</string>
    <string>watch</string>
    <string>--interval</string>
    <string>600</string>
  </array>"#;
        assert_eq!(parse_interval_from_plist(body), Some(600));
        assert_eq!(parse_interval_from_plist("<string>watch</string>"), None);
        assert_eq!(
            parse_interval_from_plist("<string>--interval</string><string>abc</string>"),
            None
        );
    }
}
