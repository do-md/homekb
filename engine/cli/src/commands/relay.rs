//! `homekb register` / `homekb pair` — relay enrolment & pairing codes.

use anyhow::{Context, Result};
use homekb_core::{Config, RelayConfig};
use serde_json::Value;

/// Official hosted connection service baked into the engine (docs/ARCHITECTURE.md
/// "Desktop service picker"). `homekb register` with no `--relay` enrols against
/// this — the zero-friction default so a fresh install just works.
const DEFAULT_RELAY_URL: &str = "https://homekb-relay.wangjintaoapp.workers.dev";

fn normalize_url(url: &str) -> String {
    let mut u = url.trim().trim_end_matches('/').to_string();
    if !u.starts_with("http://") && !u.starts_with("https://") {
        u = format!("https://{u}");
    }
    u
}

pub fn relay_config(config: &Config) -> Result<RelayConfig> {
    config.relay.clone().filter(|r| !r.url.is_empty() && !r.home_secret.is_empty()).context(
        "not connected to a relay: run `homekb register --relay <relay URL>` to register this machine first",
    )
}

/// Best-effort retirement of a previous registration (`DELETE /api/relay/home`):
/// its paired devices then get 401 and auto-unpair instead of rotting as
/// forever-offline zombies (docs/ARCHITECTURE.md "Relay HTTP API"). Never fatal —
/// the old service may simply be gone.
async fn retire_registration(old: &RelayConfig) {
    let res = reqwest::Client::new()
        .delete(format!("{}/api/relay/home", old.url))
        .bearer_auth(&old.home_secret)
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => {
            println!("previous registration retired ({} @ {})", old.home_id, old.url);
        }
        _ => {
            eprintln!(
                "note: could not retire the previous registration at {} — devices paired to it will keep seeing the home as offline",
                old.url
            );
        }
    }
}

/// `homekb register [--relay URL] [--name NAME]` — `--relay` defaults to the
/// official hosted relay (`DEFAULT_RELAY_URL`).
pub fn run_register(relay: Option<String>, name: Option<String>) -> Result<()> {
    register_at(relay, name, true, false)
}

/// Register with a connection service. `print_next_steps` gates the trailing
/// "Next steps" guidance — `homekb pair`'s first-run bootstrap registers as a
/// sub-step and handles the follow-up itself, so the guidance would mislead.
/// `quiet` routes all human-readable progress to **stderr** instead of stdout —
/// used when this runs as a bootstrap sub-step of `homekb pair --json`, whose
/// stdout must stay a single machine-readable JSON line.
fn register_at(
    relay: Option<String>,
    name: Option<String>,
    print_next_steps: bool,
    quiet: bool,
) -> Result<()> {
    // stdout normally, but stderr in quiet (JSON-bootstrap) mode so the caller's
    // stdout carries only the final JSON result.
    macro_rules! say {
        ($($a:tt)*) => { if quiet { eprintln!($($a)*) } else { println!($($a)*) } };
    }
    let relay = relay.unwrap_or_else(|| DEFAULT_RELAY_URL.to_string());
    let url = normalize_url(&relay);
    let name = name.unwrap_or_else(|| {
        hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_else(|| "my-machine".to_string())
    });

    let mut config = Config::load()?;
    // Capture the identity being replaced; retire it only AFTER the new
    // registration succeeds (a failed register must leave the old one working).
    let previous = config
        .relay
        .clone()
        .filter(|r| !r.url.is_empty() && !r.home_secret.is_empty());
    let rt = super::runtime()?;
    let body: Value = rt.block_on(async {
        let res = reqwest::Client::new()
            .post(format!("{url}/api/relay/register"))
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await
            .context("cannot connect to relay server")?;
        anyhow::ensure!(res.status().is_success(), "registration failed: HTTP {}", res.status());
        Ok::<Value, anyhow::Error>(res.json().await?)
    })?;
    if let Some(old) = &previous {
        rt.block_on(retire_registration(old));
    }

    let home_id = body["homeId"].as_str().context("response missing homeId")?.to_string();
    let home_secret = body["homeSecret"].as_str().context("response missing homeSecret")?.to_string();

    config.relay = Some(RelayConfig {
        url: url.clone(),
        home_id: home_id.clone(),
        home_secret,
        name: name.clone(),
    });
    let path = config.save()?;

    say!("registered home device \"{}\" ({}) -> {}", name, home_id, url);
    say!("credentials written to {}", path.display());

    // Routing follows the registration (docs/ARCHITECTURE.md "Switching
    // connection services"): existing shares live in shares.json on this
    // machine, but the new service has never heard of their shareIds.
    // Re-register every active share route so those shares stay reachable
    // through the new service. Best-effort — links distributed earlier embed
    // the old service in `?r=` and cannot be saved either way.
    match rt.block_on(homekb_core::reregister_routes(&config)) {
        Ok((0, 0)) => {}
        Ok((registered, 0)) => {
            say!("re-registered {registered} share route(s) at the new service");
        }
        Ok((registered, failed)) => eprintln!(
            "warning: re-registered {registered} share route(s), {failed} failed — those shares stay unreachable until the next `homekb register`"
        ),
        Err(e) => eprintln!("warning: could not re-register share routes: {e:#}"),
    }

    // Registering minted a NEW home identity. A tunnel that is already running still
    // holds the previous credentials — to the relay, the new home is offline even
    // though everything looks green locally. Restart it so it reloads config.
    #[cfg(target_os = "macos")]
    {
        use super::launchd;
        match launchd::restart_if_loaded(launchd::TUNNEL_LABEL) {
            Ok(true) => {
                say!("tunnel restarted with the new credentials");
                return Ok(());
            }
            Ok(false) => {} // not installed — fall through to the guidance below
            Err(e) => {
                eprintln!(
                    "warning: could not restart the tunnel ({e}); restart it manually: homekb tunnel --install"
                );
                return Ok(());
            }
        }
    }
    if print_next_steps {
        println!("\nNext steps:");
        println!("  homekb tunnel   # resident relay connection (required for phone / remote MCP access)");
        println!("  homekb pair     # generate a pairing code for a phone or Claude mobile client");
    }
    Ok(())
}

/// `homekb pair [--json]`
///
/// `--json`: the pairing result `{"code","expiresAt","relayUrl","homeName"}`
/// (epoch milliseconds) is the **final** stdout line, parsed by the desktop
/// client (docs/ARCHITECTURE.md); any bootstrap progress is emitted to stderr.
///
/// **Bootstraps on first run** (docs/ARCHITECTURE.md "CLI") — for BOTH human and
/// `--json` mode, because the engine owns the official-relay default and the
/// desktop is only a thin shell: with no registration it first enrols against
/// the official hosted relay, and on that fresh-registration path also installs
/// the tunnel (`--interval 0`) + compile (default interval) agents on macOS — so
/// "install the engine → `homekb pair` (or the desktop's Generate) → enter the
/// code on the web" is the complete minimal path, client optional. Already
/// registered → mints a code only, never (re)installs agents. In `--json` mode
/// the enrolment runs quietly (stderr), keeping the JSON result on stdout.
pub fn run_pair(json: bool) -> Result<()> {
    let mut config = Config::load()?;
    let mut fresh_registration = false;
    let has_registration = config
        .relay
        .as_ref()
        .map(|r| !r.url.is_empty() && !r.home_secret.is_empty())
        .unwrap_or(false);
    if !has_registration {
        if json {
            eprintln!("not connected to a connection service yet — setting up the default service");
        } else {
            println!("not connected to a connection service yet — setting this machine up first\n");
        }
        register_at(None, None, false, json)?;
        config = Config::load()?;
        fresh_registration = true;
        if !json {
            println!();
        }
    }
    let relay = relay_config(&config)?;

    // First-run bootstrap: pairing is pointless without the resident tunnel
    // (the code claims fine, but the home would look offline forever), and a
    // usable library needs scheduled compilation. Only the fresh-registration
    // path installs anything — an existing setup is never touched (a
    // deliberately uninstalled agent must not come back on the next `pair`).
    // Runs for `--json` too: the desktop shell relies on the engine to set this
    // up (install chatter lands on stdout but never as the final JSON line).
    #[cfg(target_os = "macos")]
    {
        use super::launchd;
        if fresh_registration {
            if !launchd::status(launchd::TUNNEL_LABEL)?.installed {
                super::tunnel::run_install(0)?;
                if !json {
                    println!();
                }
            }
            if !launchd::status(launchd::COMPILE_LABEL)?.installed {
                super::watch::run_install(homekb_core::DEFAULT_COMPILE_INTERVAL_SECS)?;
                if !json {
                    println!();
                }
            }
        } else if !json && !launchd::status(launchd::TUNNEL_LABEL)?.running {
            eprintln!(
                "note: the tunnel is not running — the code below can be claimed, but this machine will look offline until it is (install: homekb tunnel --install, or run `homekb tunnel` in the foreground)\n"
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    if !json && fresh_registration {
        println!(
            "note: keep `homekb tunnel` running (another terminal or a system service) — it is the connection your other devices reach this machine through\n"
        );
    }

    let rt = super::runtime()?;
    let body: Value = rt.block_on(async {
        let res = reqwest::Client::new()
            .post(format!("{}/api/relay/pair", relay.url))
            .bearer_auth(&relay.home_secret)
            .json(&serde_json::json!({ "action": "new" }))
            .send()
            .await
            .context("cannot connect to relay server")?;
        anyhow::ensure!(res.status().is_success(), "failed to generate pairing code: HTTP {}", res.status());
        Ok::<Value, anyhow::Error>(res.json().await?)
    })?;

    let code = body["code"].as_str().context("response missing code")?;
    if json {
        println!(
            "{}",
            serde_json::json!({
                "code": code,
                "expiresAt": body["expiresAt"],
                "relayUrl": relay.url,
                "homeName": relay.name,
            })
        );
        return Ok(());
    }
    println!("pairing code (valid for 10 minutes, single use):\n");
    println!("    {code}\n");
    println!("Use it from another device:");
    println!("  - HomeKB web app: enter the pairing code (keep the prefilled service address: {})", relay.url);
    println!("  - Claude / ChatGPT connector: add {}/api/mcp and enter the pairing code on the authorization page", relay.url);
    Ok(())
}

/// `homekb unregister` — leave the connection service: retire the registration
/// there (best-effort), remove `[relay]` from config, uninstall the launchd tunnel
/// (it cannot run without a registration and would fail-loop under KeepAlive).
pub fn run_unregister() -> Result<()> {
    let mut config = Config::load()?;
    let Some(old) = config
        .relay
        .clone()
        .filter(|r| !r.url.is_empty() && !r.home_secret.is_empty())
    else {
        println!("not registered with any connection service — nothing to do");
        return Ok(());
    };
    let rt = super::runtime()?;
    rt.block_on(retire_registration(&old));
    config.relay = None;
    let path = config.save()?;
    println!("registration removed from {}", path.display());
    #[cfg(target_os = "macos")]
    {
        use super::launchd;
        if launchd::status(launchd::TUNNEL_LABEL)?.installed {
            launchd::uninstall(launchd::TUNNEL_LABEL)?;
            println!("tunnel background service stopped and removed");
        }
    }
    Ok(())
}
