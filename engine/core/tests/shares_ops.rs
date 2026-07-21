//! Integration tests for public share links (kb.shareGet policy enforcement
//! + the share-scoped asset gate). The shares.json format is part of the
//! contract (docs/ARCHITECTURE.md "Note sharing"), so tests write it directly
//! — `create_share` itself needs a live relay and is exercised by the smoke
//! scripts instead.

use homekb_core::{
    ChatEndpoint, Config, EmbeddingEndpoint, ShareError, get_share, list_shares, revoke_share,
    share_allows_asset, write_note,
};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn sandbox(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("homekb-share-tests")
        .join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn test_cfg(root: &Path) -> Config {
    Config {
        root: root.to_path_buf(),
        notes_dir: root.join("notes"),
        drafts_dir: root.join("drafts"),
        snapshot_path: root.join("index").join("index.db"),
        live_db: root.join("live").join("live.db"),
        embedding_configured: true,
        embedding: EmbeddingEndpoint {
            provider: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key: None,
            model: "text-embedding-3-small".into(),
            dim: 1536,
        },
        summary_configured: true,
        summary: ChatEndpoint {
            provider: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key: None,
            model: "gpt-4o-mini".into(),
            section: "summary",
        },
        ask: None,
        chunk_target_tokens: 800,
        chunk_hard_max: 2000,
        summary_diff_threshold: 0.15,
        embed_concurrency: 8,
        embed_batch_size: 100,
        share_web_base: "http://localhost:3000".into(),
        serve: None,
        relay: None,
    }
}

fn hash_password(salt_hex: &str, password: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt_hex.as_bytes());
    h.update(password.as_bytes());
    hex::encode(h.finalize())
}

fn write_shares(root: &Path, records: &[serde_json::Value]) {
    let body = serde_json::json!({ "shares": records });
    std::fs::write(root.join("shares.json"), serde_json::to_string_pretty(&body).unwrap())
        .unwrap();
}

fn far_future_ms() -> i64 {
    4_102_444_800_000 // 2100-01-01
}

#[test]
fn share_policy_enforcement() {
    let root = sandbox("policy");
    let cfg = test_cfg(&root);
    write_note(&cfg, "shared.md", "# Public Note\n\nhello\n").unwrap();

    let salt = "aa".repeat(16);
    let hash = hash_password(&salt, "s3cret");
    write_shares(
        &root,
        &[
            serde_json::json!({ "id": "open00000000000000000000000000ok", "path": "shared.md", "createdAt": 1 }),
            serde_json::json!({
                "id": "pw000000000000000000000000000000", "path": "shared.md", "createdAt": 1,
                "passwordSalt": salt, "passwordHash": hash
            }),
            serde_json::json!({
                "id": "exp00000000000000000000000000000", "path": "shared.md", "createdAt": 1,
                "expiresAt": 1000
            }),
            serde_json::json!({
                "id": "fut00000000000000000000000000000", "path": "shared.md", "createdAt": 1,
                "expiresAt": far_future_ms()
            }),
        ],
    );

    // Open share: readable without a password, returns content + title.
    let note = get_share(&cfg, "open00000000000000000000000000ok", None).unwrap();
    assert_eq!(note.path, "shared.md");
    assert_eq!(note.title, "Public Note");
    assert!(note.content.contains("hello"));

    // Password share: missing → required; wrong → wrong; right → ok.
    match get_share(&cfg, "pw000000000000000000000000000000", None) {
        Err(ShareError::PasswordRequired) => {}
        other => panic!("expected PasswordRequired, got {other:?}"),
    }
    match get_share(&cfg, "pw000000000000000000000000000000", Some("nope")) {
        Err(ShareError::PasswordWrong) => {}
        other => panic!("expected PasswordWrong, got {other:?}"),
    }
    assert!(get_share(&cfg, "pw000000000000000000000000000000", Some("s3cret")).is_ok());

    // Expired vs still-valid expiry.
    match get_share(&cfg, "exp00000000000000000000000000000", None) {
        Err(ShareError::Expired) => {}
        other => panic!("expected Expired, got {other:?}"),
    }
    assert!(get_share(&cfg, "fut00000000000000000000000000000", None).is_ok());

    // Unknown id.
    match get_share(&cfg, "nope0000000000000000000000000000", None) {
        Err(ShareError::NotFound) => {}
        other => panic!("expected NotFound, got {other:?}"),
    }

    // list surfaces hasPassword / expiresAt.
    let listed = list_shares(&cfg).unwrap();
    assert_eq!(listed.len(), 4);
    let pw_meta = listed.iter().find(|s| s.share_id.starts_with("pw")).unwrap();
    assert!(pw_meta.has_password);
    assert_eq!(pw_meta.title.as_deref(), Some("Public Note"));
}

#[test]
fn share_asset_gate() {
    let root = sandbox("assets");
    let cfg = test_cfg(&root);
    write_note(
        &cfg,
        "with-image.md",
        "# Pic\n\n![shot](../assets/images/shot.png)\n[doc](../assets/attachments/spec.pdf)\n",
    )
    .unwrap();
    write_shares(
        &root,
        &[serde_json::json!({ "id": "img00000000000000000000000000000", "path": "with-image.md", "createdAt": 1 })],
    );

    // Referenced assets pass; anything else is denied.
    assert!(share_allows_asset(&cfg, "img00000000000000000000000000000", None, "images/shot.png").is_ok());
    assert!(
        share_allows_asset(&cfg, "img00000000000000000000000000000", None, "attachments/spec.pdf")
            .is_ok()
    );
    assert!(
        share_allows_asset(&cfg, "img00000000000000000000000000000", None, "images/other.png")
            .is_err()
    );
    assert!(share_allows_asset(&cfg, "unknown0000000000000000000000000", None, "images/shot.png").is_err());
}

#[test]
fn revoke_is_idempotent_and_kills_the_share() {
    let root = sandbox("revoke");
    let cfg = test_cfg(&root);
    write_note(&cfg, "r.md", "# R\n").unwrap();
    write_shares(
        &root,
        &[serde_json::json!({ "id": "rev00000000000000000000000000000", "path": "r.md", "createdAt": 1 })],
    );

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    // No [relay] in cfg → the relay-side delete is skipped (best-effort);
    // the local record removal is the kill switch.
    rt.block_on(revoke_share(&cfg, "rev00000000000000000000000000000")).unwrap();
    match get_share(&cfg, "rev00000000000000000000000000000", None) {
        Err(ShareError::NotFound) => {}
        other => panic!("expected NotFound after revoke, got {other:?}"),
    }
    // Idempotent.
    rt.block_on(revoke_share(&cfg, "rev00000000000000000000000000000")).unwrap();
}
