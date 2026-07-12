//! Human and JSON output formatters (human style carried over from kb-query).

use anyhow::Result;
use homekb_core::SearchOutput;
use std::io::Write;

pub fn write_json(out: &mut impl Write, resp: &SearchOutput) -> Result<()> {
    serde_json::to_writer_pretty(&mut *out, resp)?;
    writeln!(out)?;
    Ok(())
}

pub fn write_human(out: &mut impl Write, resp: &SearchOutput) -> Result<()> {
    if resp.results.is_empty() {
        writeln!(out, "no matches for: {}", resp.query)?;
        return Ok(());
    }
    writeln!(out, "query : {}", resp.query)?;
    writeln!(out, "hits  : {}", resp.results.len())?;
    writeln!(out)?;

    for (i, hit) in resp.results.iter().enumerate() {
        let n = i + 1;
        let type_str = hit
            .doc_type
            .as_deref()
            .map(|t| format!("  [{t}]"))
            .unwrap_or_default();
        let date = format_unix_date(hit.mtime);

        match hit.kind.as_str() {
            "doc" => {
                writeln!(
                    out,
                    "[{n}] doc      {path}   {date}{type_str}   score={score:.4}",
                    path = hit.path,
                    score = hit.score,
                )?;
                if let Some(t) = &hit.title {
                    writeln!(out, "    title  : {t}")?;
                }
                let summary = truncate(&collapse_ws(&hit.content), 280);
                if !summary.is_empty() {
                    writeln!(out, "    summary: {summary}")?;
                }
            }
            "doc_full" => {
                writeln!(
                    out,
                    "[{n}] doc_full {path}   {date}{type_str}   ({size} chars)   score={score:.4}",
                    path = hit.path,
                    size = hit.content.len(),
                    score = hit.score,
                )?;
                if let Some(t) = &hit.title {
                    writeln!(out, "    title  : {t}")?;
                }
                let preview = truncate(&collapse_ws(&hit.content), 400);
                writeln!(out, "    head   : {preview}")?;
            }
            _ => {
                // "chunk"
                writeln!(
                    out,
                    "[{n}] chunk    {path}   {date}{type_str}   score={score:.4}",
                    path = hit.path,
                    score = hit.score,
                )?;
                if let Some(h) = &hit.heading_path {
                    writeln!(out, "    at   : {h}")?;
                }
                let preview = truncate(&collapse_ws(&hit.content), 600);
                writeln!(out, "    text : {preview}")?;
            }
        }
        writeln!(out)?;
    }
    Ok(())
}

/// Format Unix seconds as a local `YYYY-MM-DD` string without pulling in
/// `chrono` / `time` just for one helper.
pub fn format_unix_date(secs: i64) -> String {
    if secs <= 0 {
        return "-".to_string();
    }
    let local_secs = secs + local_tz_offset_secs();
    let days = local_secs.div_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// `YYYY-MM-DD HH:MM` local time.
pub fn format_unix_date_time(secs: i64) -> String {
    if secs <= 0 {
        return "-".to_string();
    }
    let local_secs = secs + local_tz_offset_secs();
    let days = local_secs.div_euclid(86400);
    let rem = local_secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", rem / 3600, (rem % 3600) / 60)
}

/// Howard Hinnant's civil-from-days. Computes (year, month, day) from a
/// signed days-since-1970-01-01 count. Valid for years roughly 1 .. 9999.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (year, m, d)
}

/// Read local timezone offset from `date +%z` once per process.
/// Not perfectly accurate around DST boundaries but good enough for
/// displaying a date.
fn local_tz_offset_secs() -> i64 {
    use std::sync::OnceLock;
    static CACHED: OnceLock<i64> = OnceLock::new();
    *CACHED.get_or_init(|| {
        let out = std::process::Command::new("date").arg("+%z").output().ok();
        let s = out
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "+0000".to_string());
        // Format like "+0800" or "-0500".
        if s.len() < 5 {
            return 0;
        }
        let sign = if s.starts_with('-') { -1 } else { 1 };
        let hh: i64 = s.get(1..3).and_then(|x| x.parse().ok()).unwrap_or(0);
        let mm: i64 = s.get(3..5).and_then(|x| x.parse().ok()).unwrap_or(0);
        sign * (hh * 3600 + mm * 60)
    })
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out.trim().to_string()
}

fn truncate(s: &str, max_chars: usize) -> String {
    let mut count = 0;
    let mut end = s.len();
    for (i, _) in s.char_indices() {
        if count >= max_chars {
            end = i;
            break;
        }
        count += 1;
    }
    if end < s.len() {
        format!("{}…", &s[..end])
    } else {
        s.to_string()
    }
}
