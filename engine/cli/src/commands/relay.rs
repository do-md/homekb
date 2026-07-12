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
        "尚未接入中继：先运行 `homekb register --relay <中继地址>` 注册这台电脑",
    )
}

/// `homekb register --relay URL [--name NAME]`
pub fn run_register(relay: Option<String>, name: Option<String>) -> Result<()> {
    let relay = relay.context("需要 --relay <中继地址>，例如 --relay https://kb.example.com")?;
    let url = normalize_url(&relay);
    let name = name.unwrap_or_else(|| {
        hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_else(|| "我的电脑".to_string())
    });

    let mut config = Config::load()?;
    let rt = super::runtime()?;
    let body: Value = rt.block_on(async {
        let res = reqwest::Client::new()
            .post(format!("{url}/api/relay/register"))
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await
            .context("无法连接中继服务器")?;
        anyhow::ensure!(res.status().is_success(), "注册失败：HTTP {}", res.status());
        Ok::<Value, anyhow::Error>(res.json().await?)
    })?;

    let home_id = body["homeId"].as_str().context("响应缺 homeId")?.to_string();
    let home_secret = body["homeSecret"].as_str().context("响应缺 homeSecret")?.to_string();

    config.relay = Some(RelayConfig {
        url: url.clone(),
        home_id: home_id.clone(),
        home_secret,
        name: name.clone(),
    });
    let path = config.save()?;

    println!("✅ 已注册家设备「{name}」（{home_id}）→ {url}");
    println!("凭据已写入 {}", path.display());
    println!("\n下一步：");
    println!("  homekb tunnel   # 常驻连接中继（手机/远程 MCP 才能访问到这台电脑）");
    println!("  homekb pair     # 生成配对码给手机或 Claude 手机端");
    Ok(())
}

/// `homekb pair`
pub fn run_pair() -> Result<()> {
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
            .context("无法连接中继服务器")?;
        anyhow::ensure!(res.status().is_success(), "生成配对码失败：HTTP {}", res.status());
        Ok::<Value, anyhow::Error>(res.json().await?)
    })?;

    let code = body["code"].as_str().context("响应缺 code")?;
    println!("配对码（10 分钟内有效，单次使用）：\n");
    println!("    {code}\n");
    println!("用法：");
    println!("  · 手机浏览器打开 {} ，输入配对码", relay.url);
    println!("  · Claude 手机端添加连接器 {}/api/mcp ，授权页输入配对码", relay.url);
    Ok(())
}
