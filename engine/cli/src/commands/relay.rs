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
