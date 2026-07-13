//! `homekb tunnel` — resident home-side client: keeps an SSE connection to
//! the relay, executes forwarded RPCs locally, posts results back, and runs
//! the built-in periodic reindex. Reconnects with exponential backoff.

use anyhow::{Context, Result, anyhow};
use homekb_core::Config;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

// ---- launchd daemon management (macOS only) ----

#[cfg(target_os = "macos")]
pub fn run_install(interval: u64) -> Result<()> {
    use super::launchd;
    let bin = launchd::home_bin_path()?;
    let log = launchd::log_path("tunnel")?;
    let interval_s = interval.to_string();
    let body = launchd::daemon_plist(
        launchd::TUNNEL_LABEL,
        &[&bin, "tunnel", "--interval", &interval_s],
        &log,
    );
    launchd::install(launchd::TUNNEL_LABEL, &body)?;
    let compile_note = if interval == 0 {
        "relay tunnel only (compilation owned by the compile service)".to_string()
    } else {
        format!("with built-in reindex every {interval}s")
    };
    println!("tunnel installed and started as a background service ({compile_note}, auto-restart on crash)");
    println!("   label : {}", launchd::TUNNEL_LABEL);
    println!("   log   : {log}");
    println!("   status: homekb tunnel --status");
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn run_uninstall() -> Result<()> {
    use super::launchd;
    launchd::uninstall(launchd::TUNNEL_LABEL)?;
    println!("tunnel background service stopped and removed");
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn run_status(json_out: bool) -> Result<()> {
    use super::launchd;
    let st = launchd::status(launchd::TUNNEL_LABEL)?;
    if json_out {
        println!(
            "{}",
            json!({
                "installed": st.installed,
                "loaded": st.loaded,
                "running": st.running,
                "pid": st.pid,
            })
        );
    } else {
        println!("installed : {}", st.installed);
        println!("running   : {}", st.running);
        if let Some(pid) = st.pid {
            println!("pid       : {pid}");
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn run_install(_interval: u64) -> Result<()> {
    anyhow::bail!("tunnel daemon install is currently macOS-only (Linux systemd --user support planned)")
}

#[cfg(not(target_os = "macos"))]
pub fn run_uninstall() -> Result<()> {
    anyhow::bail!("tunnel daemon uninstall is currently macOS-only")
}

#[cfg(not(target_os = "macos"))]
pub fn run_status(json_out: bool) -> Result<()> {
    if json_out {
        println!(
            "{}",
            json!({ "installed": false, "loaded": false, "running": false, "pid": null })
        );
    } else {
        println!("tunnel daemon management is currently macOS-only");
    }
    Ok(())
}

/// Connection is considered dead if no bytes arrive within this window (includes the 25 s ping).
const READ_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_BACKOFF_SECS: u64 = 60;

pub fn run(interval: u64) -> Result<()> {
    let config = Arc::new(Config::load()?);
    let relay = super::relay::relay_config(&config)?;
    let rt = super::runtime()?;
    rt.block_on(async move {
        // Built-in periodic reindex (interval=0 disables it)
        if interval > 0 {
            let cfg = config.clone();
            tokio::spawn(async move {
                loop {
                    match homekb_core::reindex(&cfg, true).await {
                        Ok(r) => tracing::info!("periodic reindex done (generation {})", r.generation),
                        Err(e) => tracing::warn!("periodic reindex failed: {e:#}"),
                    }
                    tokio::time::sleep(Duration::from_secs(interval)).await;
                }
            });
        }

        let client = reqwest::Client::new();
        let mut backoff = 1u64;
        loop {
            match connect(&client, &relay).await {
                Ok(res) => {
                    tracing::info!("tunnel connected → {}", relay.url);
                    backoff = 1;
                    match pump(res, &client, &config, &relay).await {
                        Ok(()) => tracing::info!("tunnel closed by server; reconnecting"),
                        Err(e) => tracing::warn!("tunnel dropped: {e:#}; reconnecting"),
                    }
                }
                Err(e) => {
                    tracing::warn!("tunnel connect failed: {e:#}; retrying in {backoff}s");
                }
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
        }
    })
}

async fn connect(
    client: &reqwest::Client,
    relay: &homekb_core::RelayConfig,
) -> Result<reqwest::Response> {
    let res = client
        .get(format!("{}/api/relay/tunnel", relay.url))
        .bearer_auth(&relay.home_secret)
        .header("accept", "text/event-stream")
        .send()
        .await
        .context("connect")?;
    if res.status().as_u16() == 401 {
        anyhow::bail!("relay rejected credentials (401): run `homekb register` again");
    }
    anyhow::ensure!(res.status().is_success(), "HTTP {}", res.status());
    Ok(res)
}

async fn pump(
    mut res: reqwest::Response,
    client: &reqwest::Client,
    config: &Arc<Config>,
    relay: &homekb_core::RelayConfig,
) -> Result<()> {
    let mut buf = String::new();
    loop {
        let chunk = tokio::time::timeout(READ_TIMEOUT, res.chunk())
            .await
            .map_err(|_| anyhow!("no data for {}s (missed pings)", READ_TIMEOUT.as_secs()))??;
        let Some(bytes) = chunk else {
            return Ok(()); // server closed cleanly
        };
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = buf.find("\n\n") {
            let raw: String = buf.drain(..idx + 2).collect();
            if let Some((event, data)) = parse_sse(&raw) {
                match event.as_str() {
                    "rpc" => handle_rpc(&data, client, config, relay),
                    "asset" => handle_asset(&data, client, config, relay),
                    _ => {}
                }
            }
        }
    }
}

fn parse_sse(raw: &str) -> Option<(String, String)> {
    let mut event = None;
    let mut data = Vec::new();
    for line in raw.lines() {
        if let Some(v) = line.strip_prefix("event: ") {
            event = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("data: ") {
            data.push(v.to_string());
        }
    }
    Some((event?, data.join("\n")))
}

/// Binary asset channel (docs/ARCHITECTURE.md "Binary asset channel"): the relay asks
/// for `{id, path}` over SSE; we read the file under <root>/assets/ and POST the raw
/// bytes back to /api/relay/tunnel/asset/<id> (empty body + X-Asset-Error on failure).
/// Runs in its own task so large files do not block the tunnel read loop.
fn handle_asset(
    data: &str,
    client: &reqwest::Client,
    config: &Arc<Config>,
    relay: &homekb_core::RelayConfig,
) {
    let Ok(msg) = serde_json::from_str::<Value>(data) else {
        tracing::warn!("bad asset event payload: {data}");
        return;
    };
    let Some(id) = msg.get("id").and_then(|v| v.as_str()).map(str::to_string) else {
        return;
    };
    let path = msg
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let client = client.clone();
    let config = config.clone();
    let upload_url = format!("{}/api/relay/tunnel/asset/{}", relay.url, id);
    let secret = relay.home_secret.clone();

    tokio::spawn(async move {
        tracing::info!("asset {path}");
        let resolved = super::assets::resolve_asset_path(&config, &path);
        let req = match resolved {
            Some(full) => match tokio::fs::read(&full).await {
                Ok(bytes) => client
                    .post(&upload_url)
                    .bearer_auth(&secret)
                    .header("Content-Type", super::assets::guess_mime(&full))
                    .body(bytes),
                Err(_) => client
                    .post(&upload_url)
                    .bearer_auth(&secret)
                    .header("X-Asset-Error", "not_found"),
            },
            None => client
                .post(&upload_url)
                .bearer_auth(&secret)
                .header("X-Asset-Error", "not_found"),
        };
        match req.send().await {
            Ok(res) if !res.status().is_success() => {
                tracing::warn!("asset upload rejected: HTTP {}", res.status());
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("failed to post asset: {e}"),
        }
    });
}

/// Each RPC is executed in its own task and the result posted back, so slow queries do not block the tunnel read loop.
fn handle_rpc(
    data: &str,
    client: &reqwest::Client,
    config: &Arc<Config>,
    relay: &homekb_core::RelayConfig,
) {
    let Ok(msg) = serde_json::from_str::<Value>(data) else {
        tracing::warn!("bad rpc event payload: {data}");
        return;
    };
    let Some(id) = msg.get("id").and_then(|v| v.as_str()).map(str::to_string) else {
        return;
    };
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    let client = client.clone();
    let config = config.clone();
    let result_url = format!("{}/api/relay/tunnel/result", relay.url);
    let secret = relay.home_secret.clone();

    tokio::spawn(async move {
        tracing::info!("rpc {method}");
        let body = match homekb_core::dispatch(&config, &method, &params).await {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(e) => json!({ "id": id, "ok": false, "error": { "code": e.code, "message": e.message } }),
        };
        if let Err(e) = client
            .post(&result_url)
            .bearer_auth(&secret)
            .json(&body)
            .send()
            .await
        {
            tracing::warn!("failed to post rpc result: {e}");
        }
    });
}
