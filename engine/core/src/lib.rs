//! homekb-core — compile + retrieval engine for the personal markdown KB.
//!
//! Fork-merge of `kb-compile` (scanner / chunker / reconciler / pipeline /
//! ai / db) and `kb-query` (two-pool KNN + RRF search), re-plumbed onto the
//! homekb directory layout (`~/.homekb`, see docs/ARCHITECTURE.md) and
//! exposed as a library for the CLI, MCP server and relay tunnel.
//!
//! All public result types serialize as camelCase and match the
//! ARCHITECTURE.md "RPC methods" table.

mod ai;
mod api;
mod ask;
mod chunker;
mod config;
mod db;
mod drafts;
mod hasher;
mod notes;
mod pipeline;
mod reconciler;
mod rpc;
mod scanner;
mod search;
mod shares;
mod types;

pub use api::{
    AppliedRoute, Hit, ReindexReport, SearchOptions, SearchOutput, StatusReport, TypeCount,
    ensure_dirs, list_types, rebuild, reindex, reindex_opts, search, status,
};
pub use ask::{AskOutput, AskStreamEvent, Citation, ask, ask_stream, search_routed};
pub use config::{
    ChatEndpoint, Config, ConfigOverrides, EmbeddingEndpoint, RelayConfig, ServeConfig,
    config_path,
};
pub use drafts::{DraftMeta, SavedDraft, delete_draft, list_drafts, save_draft};
pub use notes::{
    CreatedNote, DocMeta, NoteContent, create_note, list_notes, read_note, write_note,
};
pub use rpc::{RPC_METHODS, RpcFailure, dispatch};
pub use shares::{
    CreatedShare, ShareError, ShareMeta, SharedNote, create_share, get_share, list_shares,
    revoke_share, share_allows_asset,
};
