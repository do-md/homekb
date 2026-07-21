//! `homekb start` — (re)install and start the engine's background services on
//! this machine (docs/ARCHITECTURE.md "CLI"). The reversible counterpart to
//! `homekb stop`: it starts the scheduled-compile service always, and the relay
//! tunnel when this machine is registered with a connection service (an
//! unregistered tunnel would fail-loop under KeepAlive). Idempotent — launchd
//! install reboots the services onto the current binary + interval.

use anyhow::Result;

#[cfg(target_os = "macos")]
pub fn run(interval: u64) -> Result<()> {
    use homekb_core::Config;
    // The compile service is local-only and never needs a relay — always start it.
    super::watch::run_install(interval)?;
    // The tunnel needs a registration or it fail-loops under KeepAlive.
    let registered = Config::load()
        .ok()
        .and_then(|c| c.relay)
        .is_some_and(|r| !r.url.is_empty() && !r.home_secret.is_empty());
    if registered {
        super::tunnel::run_install(0)?;
    } else {
        println!();
        println!("not connected to a connection service yet — the remote tunnel was not started.");
        println!("Run `homekb pair` to connect this machine and make it reachable from your phone.");
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn run(_interval: u64) -> Result<()> {
    anyhow::bail!(
        "`homekb start` manages launchd services and is macOS-only for now; run `homekb tunnel` / `homekb watch` in the foreground under your process manager instead"
    )
}
