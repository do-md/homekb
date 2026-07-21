//! `homekb uninstall` — remove the engine from THIS machine, never touching the
//! knowledge base (docs/ARCHITECTURE.md "CLI"). `~/.homekb/` (notes / assets /
//! index / drafts / config.toml) is sacrosanct: this command has no code path
//! that deletes under the data root. It only retires the machine-local runtime —
//! the connection-service registration, the launchd services, the regenerable
//! working DB + logs, and the binary itself. For a reversible pause that keeps
//! everything installed, see `homekb stop` (commands/stop.rs).

use anyhow::Result;
use homekb_core::Config;
use std::path::{Path, PathBuf};

/// Detect whether the running binary is managed by a package manager. Homebrew /
/// Scoop installs must be removed through the package manager (which owns the
/// receipt), never `rm`-d out from under it, so uninstall leaves them in place
/// with a hint instead.
fn package_manager_of(exe: &Path) -> Option<&'static str> {
    let s = exe.to_string_lossy().to_lowercase();
    if s.contains("/cellar/") || s.contains("/homebrew/") || s.contains("/.linuxbrew/") {
        Some("brew")
    } else if s.contains("/scoop/") {
        Some("scoop")
    } else {
        None
    }
}

/// `homekb uninstall [--yes]`.
///
/// Without `--yes` this prints the plan (and the exact paths it would remove)
/// and aborts — a built-in dry run.
pub fn run(yes: bool) -> Result<()> {
    // Resolve every path up front so the plan and the execution agree.
    let config = Config::load().ok();
    let registered = config
        .as_ref()
        .and_then(|c| c.relay.as_ref())
        .is_some_and(|r| !r.url.is_empty() && !r.home_secret.is_empty());

    // Working-DB siblings (live.db + -wal/-shm) and the compile lock: regenerable,
    // and deliberately OUTSIDE the data root (platform data dir) — safe to delete.
    let mut working_files: Vec<PathBuf> = Vec::new();
    if let Some(c) = &config {
        for suffix in ["", "-wal", "-shm"] {
            let p = if suffix.is_empty() {
                c.live_db.clone()
            } else {
                PathBuf::from(format!("{}{}", c.live_db.display(), suffix))
            };
            if p.exists() {
                working_files.push(p);
            }
        }
        let lock = c.lock_path();
        if lock.exists() {
            working_files.push(lock);
        }
    }

    // Logs directory (~/Library/Logs/HomeKB on macOS) — also outside the data root.
    let logs_dir = dirs::home_dir()
        .map(|h| h.join("Library/Logs/HomeKB"))
        .filter(|p| p.exists());

    let exe = std::env::current_exe().ok();
    let pkg = exe.as_deref().and_then(package_manager_of);

    let root_label = config
        .as_ref()
        .map(|c| c.root.display().to_string())
        .unwrap_or_else(|| "~/.homekb".to_string());

    // ---------------- Plan ----------------
    println!("homekb uninstall — this machine only. Your knowledge base is never touched:");
    println!("  KEEP  {root_label}  (notes / assets / index / drafts / config.toml)");
    println!();
    println!("Will:");
    if registered {
        println!("  - unregister from the connection service (retire + clear [relay]; AI keys kept)");
    }
    if cfg!(target_os = "macos") {
        println!("  - stop + remove launchd services (com.homekb.tunnel, com.homekb.compile)");
    }
    for f in &working_files {
        println!("  - delete {}", f.display());
    }
    if let Some(l) = &logs_dir {
        println!("  - delete {}", l.display());
    }
    match (&exe, pkg) {
        (Some(e), Some(pm)) => {
            println!("  - keep the binary {} (managed by {pm}; run `{pm} uninstall homekb`)", e.display())
        }
        (Some(e), None) => println!("  - delete the binary {}", e.display()),
        (None, _) => {}
    }

    if !yes {
        println!();
        println!("Nothing was changed. Re-run with --yes to proceed:  homekb uninstall --yes");
        println!("(To just pause the engine and keep everything installed, use `homekb stop`.)");
        return Ok(());
    }

    // ---------------- Execute ----------------
    println!();
    if registered {
        // Retires at the service, clears [relay], and (macOS) removes the tunnel
        // launchd service. Never fatal — the service may already be gone.
        if let Err(e) = super::relay::run_unregister() {
            eprintln!("note: unregister step failed ({e}); continuing");
        }
    } else {
        // Not registered, but a stale tunnel service may still be installed.
        remove_service_if_present(Service::Tunnel);
    }

    // Compile service is independent of registration — remove it either way.
    remove_service_if_present(Service::Compile);

    for f in &working_files {
        remove_file_reporting(f);
    }
    if let Some(l) = &logs_dir {
        match std::fs::remove_dir_all(l) {
            Ok(()) => println!("deleted {}", l.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("note: could not delete {} ({e})", l.display()),
        }
    }

    match (&exe, pkg) {
        (Some(e), None) => match std::fs::remove_file(e) {
            // Unlinking the running binary is fine on unix (the inode lives until
            // this process exits); on Windows it fails while running.
            Ok(()) => println!("deleted binary {}", e.display()),
            Err(err) => eprintln!(
                "note: could not delete the binary {} ({err}) — remove it manually",
                e.display()
            ),
        },
        (Some(e), Some(pm)) => {
            println!("kept the binary {} — remove it with `{pm} uninstall homekb`", e.display())
        }
        (None, _) => {}
    }

    println!();
    println!(
        "Done. Your knowledge base is intact at {root_label}. Reinstall the engine and run `homekb reindex` to pick up right where you left off."
    );
    Ok(())
}

fn remove_file_reporting(f: &Path) {
    match std::fs::remove_file(f) {
        Ok(()) => println!("deleted {}", f.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("note: could not delete {} ({e})", f.display()),
    }
}

#[derive(Clone, Copy)]
enum Service {
    Tunnel,
    Compile,
}

/// Stop + remove a launchd service if installed (macOS); no-op elsewhere.
#[cfg(target_os = "macos")]
fn remove_service_if_present(which: Service) {
    use super::launchd;
    let (label, human) = match which {
        Service::Tunnel => (launchd::TUNNEL_LABEL, "tunnel"),
        Service::Compile => (launchd::COMPILE_LABEL, "compile"),
    };
    if launchd::status(label).map(|s| s.installed).unwrap_or(false) {
        match launchd::uninstall(label) {
            Ok(()) => println!("{human} background service stopped and removed"),
            Err(e) => eprintln!("note: could not remove the {human} service ({e})"),
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn remove_service_if_present(_which: Service) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_package_manager_installs() {
        // Homebrew (macOS Cellar + Linuxbrew) and Scoop must be left for the
        // package manager; plain install locations get rm-d.
        assert_eq!(
            package_manager_of(Path::new("/opt/homebrew/Cellar/homekb/0.2.0/bin/homekb")),
            Some("brew")
        );
        assert_eq!(
            package_manager_of(Path::new("/home/linuxbrew/.linuxbrew/bin/homekb")),
            Some("brew")
        );
        assert_eq!(
            package_manager_of(Path::new("/Users/x/scoop/apps/homekb/current/homekb.exe")),
            Some("scoop")
        );
        assert_eq!(package_manager_of(Path::new("/Users/x/.local/bin/homekb")), None);
        assert_eq!(package_manager_of(Path::new("/usr/local/bin/homekb")), None);
    }
}
