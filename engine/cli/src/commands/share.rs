//! `homekb share` — public share links for single notes
//! (docs/ARCHITECTURE.md "Note sharing").

use anyhow::Result;
use homekb_core::Config;
use serde_json::json;

/// `homekb share PATH [--password PW] [--expires-days N] [--json]`
pub fn run_create(
    path: String,
    password: Option<String>,
    expires_days: Option<u32>,
    json: bool,
) -> Result<()> {
    let config = Config::load()?;
    let rt = super::runtime()?;
    let created = rt.block_on(homekb_core::create_share(
        &config,
        &path,
        password.as_deref(),
        expires_days,
    ))?;
    if json {
        println!("{}", serde_json::to_string(&created)?);
        return Ok(());
    }
    println!("share link created:\n\n    {}\n", created.url);
    if password.is_some() {
        println!("  password : required (set by you — the link alone is not enough)");
    }
    match created.expires_at {
        Some(ms) => println!("  expires  : {}", human_time(ms)),
        None => println!("  expires  : never (revoke with `homekb share --revoke {}`)", created.share_id),
    }
    println!("  share id : {}", created.share_id);
    println!("\nThe note is served live from this machine — the link works while the tunnel is running.");
    Ok(())
}

/// `homekb share --list [--json]`
pub fn run_list(json: bool) -> Result<()> {
    let config = Config::load()?;
    let shares = homekb_core::list_shares(&config)?;
    if json {
        println!("{}", json!({ "shares": shares }));
        return Ok(());
    }
    if shares.is_empty() {
        println!("no active shares");
        return Ok(());
    }
    for s in shares {
        let title = s.title.unwrap_or_else(|| "(missing note)".into());
        let pw = if s.has_password { " [password]" } else { "" };
        let exp = match s.expires_at {
            Some(ms) => format!(" expires {}", human_time(ms)),
            None => String::new(),
        };
        println!("{}  {} — {}{}{}", s.share_id, s.path, title, pw, exp);
        if let Some(url) = &s.url {
            println!("    {url}");
        }
    }
    Ok(())
}

/// `homekb share --revoke SHARE_ID`
pub fn run_revoke(share_id: String) -> Result<()> {
    let config = Config::load()?;
    let rt = super::runtime()?;
    rt.block_on(homekb_core::revoke_share(&config, &share_id))?;
    println!("share revoked: {share_id} (the link is dead immediately)");
    Ok(())
}

/// Epoch ms → local-ish human string without pulling a chrono dependency:
/// render as UTC date + time (good enough for expiry display).
fn human_time(ms: i64) -> String {
    let secs = ms / 1000;
    // Days since epoch → civil date (Howard Hinnant's algorithm, integer-only).
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m) = (rem / 3600, (rem % 3600) / 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02} UTC")
}
