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
mod assets;
mod chunker;
mod compile_queue;
mod config;
mod config_edit;
mod db;
mod drafts;
mod hasher;
#[cfg(target_os = "macos")]
pub mod launchd;
mod notes;
mod pipeline;
mod reconciler;
mod rpc;
mod scanner;
mod schedule;
mod search;
mod shares;
mod types;

pub use api::{
    AppliedRoute, CompileLockBusy, Hit, ReindexReport, SearchOptions, SearchOutput, StatusReport,
    TypeCount, ensure_dirs, list_types, rebuild, reindex, reindex_opts, search, status,
};
pub use compile_queue::request_compile;
pub use ask::{AskOutput, AskStreamEvent, Citation, ask, ask_stream, search_routed};
pub use assets::{SavedAsset, save_asset};
pub use config::{
    ChatEndpoint, Config, ConfigCell, ConfigOverrides, EmbeddingEndpoint, RelayConfig,
    ServeConfig, config_path,
};
pub use config_edit::{
    AiEndpointSummary, AiSummary, ConfigSummary, config_summary, set_ai_endpoint,
};
pub use drafts::{DraftMeta, SavedDraft, delete_draft, list_drafts, save_draft};
pub use notes::{
    CreatedNote, DocMeta, NoteContent, create_note, list_notes, read_note, write_note,
};
pub use rpc::{RPC_METHODS, RpcFailure, dispatch};
pub use schedule::{
    DEFAULT_COMPILE_INTERVAL_SECS, ScheduleState, schedule_disable, schedule_enable,
    schedule_status,
};
pub use shares::{
    CreatedShare, ShareError, ShareMeta, SharedNote, create_share, get_share, list_shares,
    reregister_routes, revoke_share, share_allows_asset,
};
