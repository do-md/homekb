//! `homekb watch` — foreground compile loop. Also the target of the `com.homekb.compile`
//! LaunchAgent: `--install/--uninstall/--status` manage that background service (macOS).

use anyhow::Result;
use homekb_core::Config;
use std::time::Duration;

#[cfg(target_os = "macos")]
use serde_json::json;

// ---- launchd compile service management (macOS only) ----
// Thin CLI shell over the shared schedule implementation in homekb-core
// (`schedule_enable`/`schedule_disable`/`schedule_status`), which also backs
// the `kb.scheduleGet`/`kb.scheduleSet` RPC methods — one implementation.

#[cfg(target_os = "macos")]
pub fn run_install(interval: u64) -> Result<()> {
    use super::launchd;
    let st = homekb_core::schedule_enable(Some(interval))?;
    let effective = st.interval_secs.unwrap_or(interval);
    println!("compile service installed and started (reindex every {effective}s, auto-restart on crash)");
    println!("   label : {}", launchd::COMPILE_LABEL);
    println!("   log   : {}", launchd::log_path("compile")?);
    println!("   status: homekb watch --status");
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn run_uninstall() -> Result<()> {
    homekb_core::schedule_disable()?;
    println!("compile service stopped and removed (background compilation paused)");
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn run_status(json_out: bool) -> Result<()> {
    use super::launchd;
    let st = launchd::status(launchd::COMPILE_LABEL)?;
    let schedule = homekb_core::schedule_status()?;
    if json_out {
        println!(
            "{}",
            json!({
                "installed": st.installed,
                "loaded": st.loaded,
                "running": st.running,
                "pid": st.pid,
                "intervalSecs": schedule.interval_secs,
            })
        );
    } else {
        println!("installed : {}", st.installed);
        println!("running   : {}", st.running);
        if let Some(pid) = st.pid {
            println!("pid       : {pid}");
        }
        if let Some(secs) = schedule.interval_secs {
            println!("interval  : {secs}s");
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn run_install(_interval: u64) -> Result<()> {
    anyhow::bail!("compile service install is currently macOS-only (Linux systemd --user support planned)")
}

#[cfg(not(target_os = "macos"))]
pub fn run_uninstall() -> Result<()> {
    anyhow::bail!("compile service uninstall is currently macOS-only")
}

#[cfg(not(target_os = "macos"))]
pub fn run_status(json_out: bool) -> Result<()> {
    if json_out {
        println!(
            "{}",
            serde_json::json!({ "installed": false, "loaded": false, "running": false, "pid": null, "intervalSecs": null })
        );
    } else {
        println!("compile service management is currently macOS-only");
    }
    Ok(())
}

pub fn run(interval: u64) -> Result<()> {
    let interval = interval.max(1);
    let rt = super::runtime()?;
    tracing::info!("watching: reindex every {interval}s (ctrl-c to stop)");
    loop {
        // Reload config each round so edits take effect without a restart.
        match Config::load() {
            Ok(cfg) => match rt.block_on(homekb_core::reindex(&cfg, false)) {
                Ok(r) => {
                    if r.created + r.updated + r.deleted + r.renamed + r.recovered > 0 {
                        tracing::info!(
                            "reindexed: +{} ~{} -{} (gen {}, {} ms)",
                            r.created,
                            r.updated,
                            r.deleted,
                            r.generation,
                            r.duration_ms
                        );
                    }
                }
                Err(e) => tracing::error!("reindex failed: {e:#}"),
            },
            Err(e) => tracing::error!("config load failed: {e:#}"),
        }
        std::thread::sleep(Duration::from_secs(interval));
    }
}
