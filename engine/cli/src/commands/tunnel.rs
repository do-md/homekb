//! `homekb tunnel` — resident home-side client: keeps an SSE connection to
//! the relay, executes forwarded RPCs locally, posts results back, and runs
//! the built-in periodic reindex. Reconnects with exponential backoff plus
//! full jitter, so a relay restart doesn't make every home stampede back in
//! lockstep (thundering herd on a weak-CPU relay).

use anyhow::{Context, Result, anyhow};
use futures::StreamExt;
use homekb_core::{AskStreamEvent, Config};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;

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
/// Never reconnect faster than this, so a persistently-failing connect can't hot-loop.
const MIN_BACKOFF_MS: u64 = 100;
/// Out-of-band liveness verification (docs/ARCHITECTURE.md "Tunnel liveness &
/// deploy safety"): in-band pings can come from a draining OLD relay instance
/// after a deploy, so the engine must ask the CURRENT instance whether this
/// connection is the registered one. First check soon after connect (catches
/// the deploy-window zombie almost immediately), then periodically.
const VERIFY_FIRST_DELAY: Duration = Duration::from_secs(10);
const VERIFY_INTERVAL: Duration = Duration::from_secs(60);

/// "Full jitter" backoff: a uniformly random delay in `[MIN_BACKOFF_MS, ceil]`.
///
/// The exponential `ceil` bounds the worst case; the randomness de-synchronizes
/// mass reconnects. Without it, a relay restart drops every home at the same
/// instant and they all retry on the identical 1→2→4…s schedule, stampeding the
/// relay in waves. With full jitter each home picks an independent point in the
/// window, spreading the TLS-handshake + auth load smoothly over time.
fn jittered_backoff(ceil_secs: u64) -> Duration {
    let ceil_ms = ceil_secs.saturating_mul(1000).max(MIN_BACKOFF_MS);
    let mut buf = [0u8; 8];
    // If the OS RNG ever fails, fall back to the un-jittered ceiling — correct, just not spread out.
    let Ok(()) = getrandom::fill(&mut buf) else {
        return Duration::from_millis(ceil_ms);
    };
    let span = u64::from_le_bytes(buf) % ceil_ms; // [0, ceil_ms)
    Duration::from_millis(span.max(MIN_BACKOFF_MS))
}

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
                    tracing::warn!("tunnel connect failed: {e:#}; retrying (backoff ceil {backoff}s)");
                }
            }
            let delay = jittered_backoff(backoff);
            tracing::debug!("reconnect in {:?} (backoff ceil {backoff}s)", delay);
            tokio::time::sleep(delay).await;
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
    // connId arrives in the `hello` event; the verifier compares it against the
    // CURRENT relay instance's view (out-of-band). An old relay that sends no
    // connId leaves this None and the verifier stays dormant (compatible).
    let conn_id: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
    let (zombie_tx, mut zombie_rx) = tokio::sync::oneshot::channel::<String>();
    let verifier = tokio::spawn(verify_loop(
        client.clone(),
        relay.clone(),
        conn_id.clone(),
        zombie_tx,
    ));

    let out = async {
        let mut buf = String::new();
        loop {
            let chunk = tokio::select! {
                r = tokio::time::timeout(READ_TIMEOUT, res.chunk()) => {
                    r.map_err(|_| anyhow!("no data for {}s (missed pings)", READ_TIMEOUT.as_secs()))??
                }
                reason = &mut zombie_rx => {
                    let reason = reason.unwrap_or_else(|_| "verifier stopped".into());
                    return Err(anyhow!(
                        "liveness verification failed ({reason}) — the relay's current instance does not see this connection (stale after a relay deploy?)"
                    ));
                }
            };
            let Some(bytes) = chunk else {
                return Ok(()); // server closed cleanly
            };
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(idx) = buf.find("\n\n") {
                let raw: String = buf.drain(..idx + 2).collect();
                if let Some((event, data)) = parse_sse(&raw) {
                    match event.as_str() {
                        "hello" => {
                            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                                if let Some(id) = v.get("connId").and_then(|x| x.as_str()) {
                                    tracing::debug!("tunnel registered as connId {id}");
                                    *conn_id.lock().unwrap_or_else(|p| p.into_inner()) =
                                        Some(id.to_string());
                                }
                            }
                        }
                        "rpc" => handle_rpc(&data, client, config, relay),
                        "asset" => handle_asset(&data, client, config, relay),
                        _ => {}
                    }
                }
            }
        }
    }
    .await;
    verifier.abort();
    out
}

/// Out-of-band liveness verifier (docs/ARCHITECTURE.md "Tunnel liveness &
/// deploy safety"). A plain HTTP request always routes to the relay's CURRENT
/// deployment, so its answer is authoritative in a way in-band pings are not.
/// Kills the tunnel ONLY on a definitive negative (2xx response saying
/// `online:false` or a different `connId`); network errors, 5xx, 404 (old
/// relay without the endpoint) are inconclusive and never cause a reconnect.
async fn verify_loop(
    client: reqwest::Client,
    relay: homekb_core::RelayConfig,
    conn_id: Arc<std::sync::Mutex<Option<String>>>,
    zombie_tx: tokio::sync::oneshot::Sender<String>,
) {
    let url = format!("{}/api/relay/tunnel/health", relay.url);
    tokio::time::sleep(VERIFY_FIRST_DELAY).await;
    loop {
        let ours = conn_id.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(ours) = ours {
            let res = client
                .get(&url)
                .bearer_auth(&relay.home_secret)
                .timeout(Duration::from_secs(10))
                .send()
                .await;
            if let Ok(res) = res {
                if res.status().is_success() {
                    if let Ok(v) = res.json::<Value>().await {
                        let online = v.get("online").and_then(|x| x.as_bool()).unwrap_or(true);
                        let current = v
                            .get("connId")
                            .and_then(|x| x.as_str())
                            .map(str::to_string);
                        if !online || current.as_deref() != Some(ours.as_str()) {
                            let reason = format!(
                                "relay reports online={online}, connId={current:?}, ours={ours}"
                            );
                            tracing::warn!("tunnel liveness check negative: {reason}");
                            let _ = zombie_tx.send(reason);
                            return;
                        }
                        tracing::debug!("tunnel liveness ok (connId {ours})");
                    }
                }
            }
        }
        tokio::time::sleep(VERIFY_INTERVAL).await;
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
    // Share-scoped asset request (docs/ARCHITECTURE.md "Note sharing"): the
    // relay adds a share context; the home validates the share (valid,
    // unexpired, password matches, asset referenced by the shared note).
    let share = msg.get("share").cloned();
    let client = client.clone();
    let config = config.clone();
    let upload_url = format!("{}/api/relay/tunnel/asset/{}", relay.url, id);
    let secret = relay.home_secret.clone();

    tokio::spawn(async move {
        tracing::info!("asset {path}");
        if let Some(share) = share {
            let share_id = share.get("shareId").and_then(|v| v.as_str()).unwrap_or("");
            let password = share.get("password").and_then(|v| v.as_str());
            if homekb_core::share_allows_asset(&config, share_id, password, &path).is_err() {
                let res = client
                    .post(&upload_url)
                    .bearer_auth(&secret)
                    .header("X-Asset-Error", "share_denied")
                    .send()
                    .await;
                if let Err(e) = res {
                    tracing::warn!("failed to post share-denied asset result: {e}");
                }
                return;
            }
        }
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

    // Streaming path (docs/ARCHITECTURE.md "Streaming answer channel"): only kb.ask,
    // marked by `stream:true` in the rpc event. Stream frames back over the ask channel
    // instead of posting a single JSON result.
    if method == "kb.ask" && msg.get("stream").and_then(|v| v.as_bool()).unwrap_or(false) {
        handle_ask_stream(id, params, client, config, relay);
        return;
    }

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

/// Encode one SSE frame the relay pipes verbatim to the client (single `data:` line —
/// compact JSON escapes newlines).
fn ask_frame(name: &str, value: &Value) -> String {
    format!(
        "event: {name}\ndata: {}\n\n",
        serde_json::to_string(value).unwrap_or_default()
    )
}

fn ask_event_frame(ev: AskStreamEvent) -> String {
    match ev {
        AskStreamEvent::Sources { citations, hits } => {
            ask_frame("sources", &json!({ "citations": citations, "hits": hits }))
        }
        AskStreamEvent::Delta(text) => ask_frame("delta", &json!({ "text": text })),
        AskStreamEvent::Done { citations, hits } => {
            ask_frame("done", &json!({ "citations": citations, "hits": hits }))
        }
    }
}

/// Streaming ask: run the pipeline and stream `delta`* → `done` (or a trailing `error`)
/// as the POST body to /api/relay/tunnel/ask/<id>, which the relay pipes to the client.
/// The body streams lazily from ask_stream's channel, so the relay (and client) start
/// receiving as soon as the first token is produced.
fn handle_ask_stream(
    id: String,
    params: Value,
    client: &reqwest::Client,
    config: &Arc<Config>,
    relay: &homekb_core::RelayConfig,
) {
    let query = params
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let client = client.clone();
    let config = config.clone();
    let ask_url = format!("{}/api/relay/tunnel/ask/{}", relay.url, id);
    let secret = relay.home_secret.clone();

    tokio::spawn(async move {
        tracing::info!("rpc kb.ask (stream)");
        let (tx, rx) = mpsc::unbounded_channel::<AskStreamEvent>();
        let (err_tx, err_rx) = tokio::sync::oneshot::channel::<Option<(String, String)>>();
        let cfg = config.clone();
        tokio::spawn(async move {
            let result = homekb_core::ask_stream(&cfg, &query, &tx).await;
            let _ = err_tx.send(result.err().map(|e| ("ask_failed".to_string(), format!("{e:#}"))));
        });

        // Frame stream: Delta/Done from the channel, then a trailing `error` frame if
        // synthesis failed. String frames satisfy reqwest's Into<Bytes> body bound.
        let events =
            UnboundedReceiverStream::new(rx).map(|ev| Ok::<String, std::io::Error>(ask_event_frame(ev)));
        let tail = futures::stream::once(async move {
            match err_rx.await {
                Ok(Some((code, message))) => Some(Ok::<String, std::io::Error>(ask_frame(
                    "error",
                    &json!({ "code": code, "message": message }),
                ))),
                _ => None,
            }
        })
        .filter_map(|opt| async move { opt });
        let body = reqwest::Body::wrap_stream(events.chain(tail));

        match client
            .post(&ask_url)
            .bearer_auth(&secret)
            .header("Content-Type", "text/event-stream")
            .body(body)
            .send()
            .await
        {
            Ok(res) if !res.status().is_success() => {
                tracing::warn!("ask stream upload rejected: HTTP {}", res.status());
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("failed to post ask stream: {e}"),
        }
    });
}
