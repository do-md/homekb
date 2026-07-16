//! `homekb register` / `homekb pair` — relay enrolment & pairing codes.

use anyhow::{Context, Result};
use homekb_core::{Config, RelayConfig};
use serde_json::Value;

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

/// `homekb register --relay URL [--name NAME]`
pub fn run_register(relay: Option<String>, name: Option<String>) -> Result<()> {
    let relay = relay.context("--relay <URL> is required, e.g. --relay https://kb.example.com")?;
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

    println!("registered home device \"{}\" ({}) -> {}", name, home_id, url);
    println!("credentials written to {}", path.display());

    // Registering minted a NEW home identity. A tunnel that is already running still
    // holds the previous credentials — to the relay, the new home is offline even
    // though everything looks green locally. Restart it so it reloads config.
    #[cfg(target_os = "macos")]
    {
        use super::launchd;
        match launchd::restart_if_loaded(launchd::TUNNEL_LABEL) {
            Ok(true) => {
                println!("tunnel restarted with the new credentials");
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
    println!("\nNext steps:");
    println!("  homekb tunnel   # resident relay connection (required for phone / remote MCP access)");
    println!("  homekb pair     # generate a pairing code for a phone or Claude mobile client");
    Ok(())
}

/// `homekb pair [--json]`
///
/// `--json`: stdout single-line `{"code","expiresAt","relayUrl","homeName"}`
/// (epoch milliseconds), parsed by the desktop client (docs/ARCHITECTURE.md).
pub fn run_pair(json: bool) -> Result<()> {
    let config = Config::load()?;
    let relay = relay_config(&config)?;
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
    println!("Usage:");
    println!("  - Open {} in your phone browser and enter the pairing code", relay.url);
    println!("  - Add connector {}/api/mcp in Claude mobile and enter the pairing code on the auth page", relay.url);
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
