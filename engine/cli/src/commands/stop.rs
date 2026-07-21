//! `homekb stop` — pause the engine's background services on this machine
//! (docs/ARCHITECTURE.md "CLI"). The reversible counterpart to `homekb start`
//! (and the gentle sibling of `homekb uninstall`): it stops + removes the
//! `com.homekb.tunnel` and `com.homekb.compile` launchd services and nothing
//! else. The binary, `config.toml` (including `[relay]`), the `live.db` working
//! DB, and the connection-service registration all stay, so remote devices just
//! see the home go offline while the tunnel is down. Resume with `homekb start`.

use anyhow::Result;

#[cfg(target_os = "macos")]
pub fn run() -> Result<()> {
    use super::launchd;
    let mut stopped = 0;
    // Reuse the authoritative per-service teardown (bootout + delete plist);
    // guard on `installed` so the summary is accurate.
    if launchd::status(launchd::TUNNEL_LABEL)?.installed {
        super::tunnel::run_uninstall()?;
        stopped += 1;
    }
    if launchd::status(launchd::COMPILE_LABEL)?.installed {
        super::watch::run_uninstall()?;
        stopped += 1;
    }
    if stopped == 0 {
        println!("no background services were installed — nothing to stop");
        return Ok(());
    }
    println!();
    println!(
        "The engine is stopped but still installed — binary, config, data, and pairing are all kept."
    );
    println!("Resume with:  homekb start   (or `homekb pair` if not connected yet)");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn run() -> Result<()> {
    anyhow::bail!(
        "`homekb stop` manages launchd services and is macOS-only for now; stop your foreground `homekb tunnel` / `homekb watch` process under your process manager instead"
    )
}
