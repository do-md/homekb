//! `homekb tunnel` — resident home-side client: keeps an SSE connection to
//! the relay, executes forwarded RPCs locally, posts results back, and runs
//! the built-in periodic reindex. Reconnects with exponential backoff.

use anyhow::{Context, Result, anyhow};
use homekb_core::Config;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

/// 超过这个时间没有任何字节（含 25s 间隔的 ping）判定连接已死。
const READ_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_BACKOFF_SECS: u64 = 60;

pub fn run(interval: u64) -> Result<()> {
    let config = Arc::new(Config::load()?);
    let relay = super::relay::relay_config(&config)?;
    let rt = super::runtime()?;
    rt.block_on(async move {
        // 内置定时编译（interval=0 关闭）
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
        anyhow::bail!("中继拒绝凭据（401）：请重新 `homekb register`");
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
            return Ok(()); // 服务端正常关闭
        };
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = buf.find("\n\n") {
            let raw: String = buf.drain(..idx + 2).collect();
            if let Some((event, data)) = parse_sse(&raw)
                && event == "rpc"
            {
                handle_rpc(&data, client, config, relay);
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

/// 每条 RPC 独立 task 执行并回传，慢查询不阻塞隧道读循环。
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
