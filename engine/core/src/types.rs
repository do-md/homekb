//! Core domain types shared across modules.

use std::path::PathBuf;

pub type DocId = i64;
pub type ChunkId = i64;

/// State machine for a document's indexing lifecycle.
/// Anything not in `Ok` is picked up by reconciliation on the next run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexState {
    Ok,
    PendingEmbed,
    Failed,
}

impl IndexState {
    pub fn from_str(s: &str) -> Self {
        match s {
            "ok" => IndexState::Ok,
            "pending_embed" => IndexState::PendingEmbed,
            _ => IndexState::Failed,
        }
    }
}

/// A row from the docs table loaded into memory.
#[derive(Debug, Clone)]
pub struct DocRow {
    pub id: DocId,
    pub path: PathBuf,
    pub content_hash: String,
    pub mtime: i64,
    pub size_bytes: i64,
    pub index_state: IndexState,
}

/// A chunk row loaded into memory.
#[derive(Debug, Clone)]
pub struct ChunkRow {
    pub id: ChunkId,
    pub content_hash: String,
    pub chunk_index: i64,
}

/// The output of the chunker.
#[derive(Debug, Clone)]
pub struct NewChunk {
    pub heading_path: Option<String>,
    pub content: String,
    pub content_hash: String,
    pub start_line: u32,
    pub end_line: u32,
    pub token_count: u32,
}

/// What the reconciler decided for each file.
#[derive(Debug, Default)]
pub struct ChangeSet {
    pub created: Vec<PathBuf>,
    pub updated: Vec<PathBuf>,
    pub deleted: Vec<PathBuf>,
    pub renamed: Vec<(PathBuf, PathBuf)>,
    pub recovery: Vec<PathBuf>,
}

impl ChangeSet {
    pub fn is_empty(&self) -> bool {
        self.created.is_empty()
            && self.updated.is_empty()
            && self.deleted.is_empty()
            && self.renamed.is_empty()
            && self.recovery.is_empty()
    }
}
