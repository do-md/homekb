//! Integration tests for the notes file operations (no CLI surface yet —
//! these back the kb.read / kb.write / kb.create / kb.list RPC methods).

use homekb_core::{Config, create_note, list_notes, read_note, write_note};
use std::path::{Path, PathBuf};

fn sandbox(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("homekb-core-tests")
        .join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn test_cfg(root: &Path) -> Config {
    Config {
        root: root.to_path_buf(),
        notes_dir: root.join("notes"),
        snapshot_path: root.join("index").join("index.db"),
        live_db: root.join("live").join("live.db"),
        openai_api_key: None,
        embedding_model: "text-embedding-3-small".into(),
        embedding_dim: 1536,
        summarizer_model: "gpt-4o-mini".into(),
        chunk_target_tokens: 800,
        chunk_hard_max: 2000,
        summary_diff_threshold: 0.15,
        embed_concurrency: 8,
        embed_batch_size: 100,
        relay: None,
    }
}

#[test]
fn write_read_roundtrip_and_subdirs() {
    let root = sandbox("roundtrip");
    let cfg = test_cfg(&root);

    write_note(&cfg, "a.md", "# Hello\n\nworld\n").unwrap();
    let note = read_note(&cfg, "a.md").unwrap();
    assert_eq!(note.path, "a.md");
    assert!(note.content.contains("world"));
    assert!(note.mtime > 0);

    // Parent dirs are created automatically, path stays relative.
    write_note(&cfg, "sub/dir/b.md", "nested").unwrap();
    assert_eq!(read_note(&cfg, "sub/dir/b.md").unwrap().content, "nested");
}

#[test]
fn traversal_and_extension_rejected() {
    let root = sandbox("traversal");
    let cfg = test_cfg(&root);
    write_note(&cfg, "ok.md", "x").unwrap();

    assert!(write_note(&cfg, "../escape.md", "x").is_err());
    assert!(write_note(&cfg, "a/../../escape.md", "x").is_err());
    assert!(write_note(&cfg, "/abs.md", "x").is_err());
    assert!(write_note(&cfg, "note.txt", "x").is_err());
    assert!(read_note(&cfg, "../ok.md").is_err());
    assert!(read_note(&cfg, "missing.md").is_err());

    // Nothing escaped the sandbox.
    assert!(!root.parent().unwrap().join("escape.md").exists());
}

#[test]
fn create_note_titles_slugs_collisions() {
    let root = sandbox("create");
    let cfg = test_cfg(&root);

    // Explicit title wins; spaces become '-'.
    let c1 = create_note(&cfg, "content", Some("Braised Pork Belly".into())).unwrap();
    assert_eq!(c1.title, "Braised Pork Belly");
    assert_eq!(c1.path, "Braised-Pork-Belly.md");

    // Collision appends -2.
    let c2 = create_note(&cfg, "more content", Some("Braised Pork Belly".into())).unwrap();
    assert_eq!(c2.path, "Braised-Pork-Belly-2.md");

    // H1 fallback.
    let c3 = create_note(&cfg, "# From Heading\n\nbody", None).unwrap();
    assert_eq!(c3.title, "From Heading");
    assert_eq!(c3.path, "From-Heading.md");

    // First-line fallback (truncated, no markdown markers).
    let c4 = create_note(&cfg, "just a plain first line\nmore", None).unwrap();
    assert_eq!(c4.title, "just a plain first line");

    // Unsafe-only titles fall back to "untitled".
    let c5 = create_note(&cfg, "x", Some("///???".into())).unwrap();
    assert_eq!(c5.path, "untitled.md");
}

#[test]
fn list_notes_fs_fallback_sorted_desc() {
    let root = sandbox("list");
    let cfg = test_cfg(&root);

    write_note(&cfg, "old.md", "old").unwrap();
    let old_path = cfg.notes_dir.join("old.md");
    // Push "old" into the past so mtime ordering is deterministic.
    let past = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    let f = std::fs::OpenOptions::new().write(true).open(&old_path).unwrap();
    f.set_modified(past).unwrap();

    write_note(&cfg, "new.md", "new").unwrap();

    // No snapshot exists → filesystem fallback.
    let docs = list_notes(&cfg, 10).unwrap();
    assert_eq!(docs.len(), 2);
    assert_eq!(docs[0].path, "new.md");
    assert_eq!(docs[1].path, "old.md");
    assert_eq!(docs[0].title.as_deref(), Some("new"));
    assert!(docs[0].size_bytes > 0);

    let capped = list_notes(&cfg, 1).unwrap();
    assert_eq!(capped.len(), 1);
}
