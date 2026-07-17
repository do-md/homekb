//! Public share links (docs/ARCHITECTURE.md "Note sharing").
//!
//! Share records are **engine-owned truth**, stored in `<root>/shares.json`:
//! id, note path, optional salted password hash, optional expiry. Every
//! policy decision (password / expiry / revocation) is enforced HERE when
//! answering `kb.shareGet`; the relay stores only a shareId → home routing
//! record and cannot even tell whether a password guess was right.
//!
//! The store is low-volume: written by atomic rename, re-read per request
//! (the serve and tunnel processes both answer share RPCs and must observe
//! each other's writes).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::notes::read_note;

/// Password throttle: after this many failures per share within [`THROTTLE_WINDOW`],
/// further attempts are rejected without checking (docs: "throttled per share").
const THROTTLE_MAX_FAILURES: usize = 10;
const THROTTLE_WINDOW: Duration = Duration::from_secs(600);

// ---------------------------------------------------------------------------
// On-disk shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareRecord {
    id: String,
    /// Note path relative to notes_dir.
    path: String,
    /// Epoch milliseconds.
    created_at: i64,
    /// Epoch milliseconds; absent = never expires.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
    /// Per-share random salt (hex) + sha256(salt ‖ password) (hex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password_salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password_hash: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ShareFile {
    #[serde(default)]
    shares: Vec<ShareRecord>,
}

// ---------------------------------------------------------------------------
// Public result types (camelCase, matching the RPC table)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedShare {
    pub share_id: String,
    /// `<share_web_base>/s/<shareId>?r=<relay url>`.
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedNote {
    pub path: String,
    pub title: String,
    pub content: String,
    /// Unix seconds (same convention as `kb.read`).
    pub mtime: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareMeta {
    pub share_id: String,
    pub path: String,
    pub title: Option<String>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub has_password: bool,
    /// Composed against the **current** `[relay]` registration (see the
    /// `kb.shareList` contract) — always the link that works right now, even
    /// after the home moved to a different connection service. Absent when
    /// the home has no active registration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Validation outcome of a public share read — maps 1:1 onto the RPC error
/// codes in the contract (`share_not_found` / `share_password_required` /
/// `share_password_wrong` / `share_expired`).
#[derive(Debug)]
pub enum ShareError {
    NotFound,
    PasswordRequired,
    PasswordWrong,
    Expired,
    Internal(anyhow::Error),
}

impl ShareError {
    pub fn code(&self) -> &'static str {
        match self {
            ShareError::NotFound => "share_not_found",
            ShareError::PasswordRequired => "share_password_required",
            ShareError::PasswordWrong => "share_password_wrong",
            ShareError::Expired => "share_expired",
            ShareError::Internal(_) => "share_failed",
        }
    }
    pub fn message(&self) -> String {
        match self {
            ShareError::NotFound => "share not found".into(),
            ShareError::PasswordRequired => "this share requires a password".into(),
            ShareError::PasswordWrong => "wrong password".into(),
            ShareError::Expired => "this share has expired".into(),
            ShareError::Internal(e) => format!("{e:#}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

fn shares_path(cfg: &Config) -> PathBuf {
    cfg.root.join("shares.json")
}

fn load(cfg: &Config) -> Result<Vec<ShareRecord>> {
    let path = shares_path(cfg);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let file: ShareFile =
        serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
    Ok(file.shares)
}

/// Atomic-rename write so a concurrent reader never sees a torn file.
fn store(cfg: &Config, shares: Vec<ShareRecord>) -> Result<()> {
    let path = shares_path(cfg);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&ShareFile { shares }).context("serialize shares")?;
    std::fs::write(&tmp, body).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hash_password(salt_hex: &str, password: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt_hex.as_bytes());
    h.update(password.as_bytes());
    hex::encode(h.finalize())
}

/// Percent-encode a query-string value (RFC 3986 unreserved set kept).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn relay_of(cfg: &Config) -> Result<crate::config::RelayConfig> {
    cfg.relay
        .clone()
        .filter(|r| !r.url.is_empty() && !r.home_secret.is_empty())
        .context("not registered with a connection service — run `homekb register --relay <url>` first (shares are served through the relay)")
}

/// `<share_web_base>/s/<shareId>?r=<relay url>` — the one canonical link shape
/// (docs/ARCHITECTURE.md "Share URL"), always composed against the relay the
/// home is registered with *now*.
fn compose_url(cfg: &Config, relay_url: &str, share_id: &str) -> String {
    format!(
        "{}/s/{}?r={}",
        cfg.share_web_base.trim_end_matches('/'),
        share_id,
        urlencode(relay_url)
    )
}

// ---------------------------------------------------------------------------
// Password throttle (in-memory, per process — both serve and tunnel keep
// their own window; the engine-level guarantee is per-process, which is
// sufficient because the public path always arrives via the tunnel process)
// ---------------------------------------------------------------------------

fn failures() -> &'static Mutex<HashMap<String, Vec<Instant>>> {
    static FAILURES: OnceLock<Mutex<HashMap<String, Vec<Instant>>>> = OnceLock::new();
    FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn throttle_locked(share_id: &str) -> bool {
    let mut map = failures().lock().unwrap_or_else(|p| p.into_inner());
    let now = Instant::now();
    let entry = map.entry(share_id.to_string()).or_default();
    entry.retain(|t| now.duration_since(*t) < THROTTLE_WINDOW);
    entry.len() >= THROTTLE_MAX_FAILURES
}

fn record_failure(share_id: &str) {
    let mut map = failures().lock().unwrap_or_else(|p| p.into_inner());
    map.entry(share_id.to_string()).or_default().push(Instant::now());
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// Create a share for one note. The relay routing record is registered
/// **before** the share is persisted locally — a relay failure leaves no
/// orphan share (docs: "no orphan shares").
pub async fn create_share(
    cfg: &Config,
    rel_path: &str,
    password: Option<&str>,
    expires_days: Option<u32>,
) -> Result<CreatedShare> {
    // Validate the note exists (and normalize the path) before anything else.
    let note = read_note(cfg, rel_path)?;
    let relay = relay_of(cfg)?;

    let mut id_bytes = [0u8; 16];
    getrandom::fill(&mut id_bytes).map_err(|e| anyhow::anyhow!("random source failed: {e}"))?;
    let share_id = hex::encode(id_bytes);

    let (password_salt, password_hash) = match password.map(str::trim).filter(|p| !p.is_empty()) {
        Some(pw) => {
            let mut salt = [0u8; 16];
            getrandom::fill(&mut salt)
                .map_err(|e| anyhow::anyhow!("random source failed: {e}"))?;
            let salt_hex = hex::encode(salt);
            let hash = hash_password(&salt_hex, pw);
            (Some(salt_hex), Some(hash))
        }
        None => (None, None),
    };

    let expires_at = expires_days.map(|d| now_ms() + (d as i64) * 24 * 60 * 60 * 1000);

    // Register the routing record at the relay first.
    let res = reqwest::Client::new()
        .post(format!("{}/api/relay/share", relay.url))
        .bearer_auth(&relay.home_secret)
        .json(&serde_json::json!({ "shareId": share_id }))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .context("cannot reach the connection service to register the share")?;
    anyhow::ensure!(
        res.status().is_success(),
        "share registration rejected by the connection service: HTTP {}",
        res.status()
    );

    let mut shares = load(cfg)?;
    shares.push(ShareRecord {
        id: share_id.clone(),
        path: note.path.clone(),
        created_at: now_ms(),
        expires_at,
        password_salt,
        password_hash,
    });
    store(cfg, shares)?;

    let url = compose_url(cfg, &relay.url, &share_id);
    Ok(CreatedShare { share_id, url, expires_at })
}

/// Validate a share id (+ password) and return its record.
fn validated_record(
    cfg: &Config,
    share_id: &str,
    password: Option<&str>,
) -> Result<ShareRecord, ShareError> {
    let shares = load(cfg).map_err(ShareError::Internal)?;
    let Some(rec) = shares.into_iter().find(|s| s.id == share_id) else {
        return Err(ShareError::NotFound);
    };
    if let Some(exp) = rec.expires_at {
        if now_ms() > exp {
            return Err(ShareError::Expired);
        }
    }
    if let (Some(salt), Some(hash)) = (&rec.password_salt, &rec.password_hash) {
        let Some(pw) = password.filter(|p| !p.is_empty()) else {
            return Err(ShareError::PasswordRequired);
        };
        if throttle_locked(share_id) {
            // Reject without checking — indistinguishable from a wrong
            // password on purpose (no oracle for whether the lockout hit).
            return Err(ShareError::PasswordWrong);
        }
        if hash_password(salt, pw) != *hash {
            record_failure(share_id);
            return Err(ShareError::PasswordWrong);
        }
    }
    Ok(rec)
}

/// The public share read (`kb.shareGet`).
pub fn get_share(
    cfg: &Config,
    share_id: &str,
    password: Option<&str>,
) -> Result<SharedNote, ShareError> {
    let rec = validated_record(cfg, share_id, password)?;
    let note = read_note(cfg, &rec.path).map_err(|_| ShareError::NotFound)?;
    let title = title_of(&note.content, &rec.path);
    Ok(SharedNote {
        path: note.path,
        title,
        content: note.content,
        mtime: note.mtime,
    })
}

/// Share-scoped asset gate (binary asset channel with share context): the
/// share must be valid AND the shared note must actually reference the asset
/// (resolved with the same virtual-root rule as every renderer).
pub fn share_allows_asset(
    cfg: &Config,
    share_id: &str,
    password: Option<&str>,
    asset_path: &str,
) -> Result<(), ShareError> {
    let rec = validated_record(cfg, share_id, password)?;
    let note = read_note(cfg, &rec.path).map_err(|_| ShareError::NotFound)?;
    let refs = referenced_assets(&rec.path, &note.content);
    if refs.iter().any(|r| r == asset_path) {
        Ok(())
    } else {
        Err(ShareError::NotFound)
    }
}

/// Active shares, newest first. Titles are best-effort (note may be gone).
pub fn list_shares(cfg: &Config) -> Result<Vec<ShareMeta>> {
    let relay = relay_of(cfg).ok();
    let mut shares = load(cfg)?;
    shares.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(shares
        .into_iter()
        .map(|rec| {
            let title = read_note(cfg, &rec.path)
                .ok()
                .map(|n| title_of(&n.content, &rec.path));
            let url = relay.as_ref().map(|r| compose_url(cfg, &r.url, &rec.id));
            ShareMeta {
                share_id: rec.id,
                path: rec.path,
                title,
                created_at: rec.created_at,
                expires_at: rec.expires_at,
                has_password: rec.password_hash.is_some(),
                url,
            }
        })
        .collect())
}

/// Re-register every active (non-expired) share's routing record at the
/// currently configured relay (docs/ARCHITECTURE.md "Switching connection
/// services"): shares live on this machine, but a freshly registered service
/// has never heard of their shareIds — routing must follow the registration.
/// Best-effort per share (the relay upsert is idempotent); returns
/// `(registered, failed)`.
pub async fn reregister_routes(cfg: &Config) -> Result<(usize, usize)> {
    let relay = relay_of(cfg)?;
    let now = now_ms();
    let client = reqwest::Client::new();
    let mut registered = 0usize;
    let mut failed = 0usize;
    for rec in load(cfg)?.iter().filter(|s| s.expires_at.map_or(true, |e| now <= e)) {
        let res = client
            .post(format!("{}/api/relay/share", relay.url))
            .bearer_auth(&relay.home_secret)
            .json(&serde_json::json!({ "shareId": rec.id }))
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => registered += 1,
            _ => failed += 1,
        }
    }
    Ok((registered, failed))
}

/// Delete a share record (idempotent) + best-effort removal of the relay
/// routing record. A stale relay row is harmless (`share_not_found`).
pub async fn revoke_share(cfg: &Config, share_id: &str) -> Result<()> {
    let mut shares = load(cfg)?;
    let before = shares.len();
    shares.retain(|s| s.id != share_id);
    let existed = shares.len() != before;
    if existed {
        store(cfg, shares)?;
    }
    if let Ok(relay) = relay_of(cfg) {
        let _ = reqwest::Client::new()
            .delete(format!("{}/api/relay/share/{}", relay.url, share_id))
            .bearer_auth(&relay.home_secret)
            .timeout(Duration::from_secs(6))
            .send()
            .await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn title_of(content: &str, rel_path: &str) -> String {
    crate::notes::extract_h1(content)
        .or_else(|| crate::notes::first_line_title(content))
        .unwrap_or_else(|| {
            std::path::Path::new(rel_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| rel_path.to_string())
        })
}

/// All asset paths a note references, resolved with the renderer's
/// virtual-root rule (docs/ARCHITECTURE.md "Image references in notes"):
/// the note sits at `notes/<rel>`, relative targets are joined and
/// normalized, and only results landing under `assets/` count.
fn referenced_assets(note_rel: &str, content: &str) -> Vec<String> {
    let mut out = Vec::new();
    for target in markdown_link_targets(content) {
        if let Some(asset) = resolve_asset_ref(note_rel, &target) {
            if !out.contains(&asset) {
                out.push(asset);
            }
        }
    }
    out
}

/// Extract `](target)` link/image destinations from markdown. Handles the
/// `<wrapped>` form and strips a trailing `"title"`. Deliberately simple —
/// over-matching is safe (a non-asset target resolves to None).
fn markdown_link_targets(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = content.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b']' && bytes[i + 1] == b'(' {
            let start = i + 2;
            if let Some(rel_end) = content[start..].find(')') {
                let raw = &content[start..start + rel_end];
                let target = raw
                    .trim()
                    .trim_start_matches('<')
                    .split(|c: char| c == '>' || c.is_whitespace())
                    .next()
                    .unwrap_or("")
                    .to_string();
                if !target.is_empty() {
                    out.push(target);
                }
                i = start + rel_end;
            }
        }
        i += 1;
    }
    out
}

/// Resolve one markdown target against the note's virtual location; return
/// the asset path (relative to the assets root) when it lands under `assets/`.
fn resolve_asset_ref(note_rel: &str, target: &str) -> Option<String> {
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with('#')
    {
        return None;
    }
    let target = target.split('#').next().unwrap_or(target);
    let target = target.split('?').next().unwrap_or(target);

    // Virtual location: notes/<note_rel>; resolve against its directory.
    let mut stack: Vec<&str> = Vec::new();
    stack.push("notes");
    let virtual_dir: Vec<&str> = note_rel.split('/').collect();
    for seg in &virtual_dir[..virtual_dir.len().saturating_sub(1)] {
        if !seg.is_empty() {
            stack.push(seg);
        }
    }
    for seg in target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if stack.pop().is_none() {
                    return None; // escapes the virtual root
                }
            }
            s => stack.push(s),
        }
    }
    if stack.first() == Some(&"assets") && stack.len() > 1 {
        Some(stack[1..].join("/"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{markdown_link_targets, resolve_asset_ref};

    #[test]
    fn asset_ref_resolution() {
        // Top-level note: ../assets/... resolves.
        assert_eq!(
            resolve_asset_ref("foo.md", "../assets/images/bar.png"),
            Some("images/bar.png".into())
        );
        // Nested note needs one more level.
        assert_eq!(
            resolve_asset_ref("sub/foo.md", "../../assets/images/bar.png"),
            Some("images/bar.png".into())
        );
        // Wrong depth lands inside notes/ → not an asset.
        assert_eq!(resolve_asset_ref("foo.md", "assets/images/bar.png"), None);
        // Escapes the virtual root entirely.
        assert_eq!(resolve_asset_ref("foo.md", "../../../etc/passwd"), None);
        // External URLs pass through untouched → never an asset.
        assert_eq!(resolve_asset_ref("foo.md", "https://x.com/a.png"), None);
        // Query/fragment are stripped before resolution.
        assert_eq!(
            resolve_asset_ref("foo.md", "../assets/images/bar.png#frag"),
            Some("images/bar.png".into())
        );
    }

    #[test]
    fn link_target_extraction() {
        let md = r#"# T
![a](../assets/images/x.png "cap")
[file](<../assets/attachments/y y.pdf>)
[ext](https://example.com)
"#;
        let t = markdown_link_targets(md);
        assert!(t.contains(&"../assets/images/x.png".to_string()));
        assert!(t.contains(&"../assets/attachments/y".to_string()) || t.iter().any(|s| s.starts_with("../assets/attachments/y")));
        assert!(t.contains(&"https://example.com".to_string()));
    }
}
