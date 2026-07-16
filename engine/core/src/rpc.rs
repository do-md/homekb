//! Shared RPC dispatcher — the single implementation behind all three
//! transports: local MCP (stdio), `homekb serve` (localhost HTTP) and
//! `homekb tunnel` (relay SSE). Method set = ARCHITECTURE.md "RPC methods".

use serde::Serialize;
use serde_json::{Value, json};

use crate::api::{SearchOptions, list_types, reindex, search, status, suggestions};
use crate::ask::ask;
use crate::config::Config;
use crate::drafts::{delete_draft, list_drafts, save_draft};
use crate::notes::{create_note, list_notes, read_note, write_note};

#[derive(Debug, Clone, Serialize)]
pub struct RpcFailure {
    pub code: String,
    pub message: String,
}

impl RpcFailure {
    fn new(code: &str, message: impl std::fmt::Display) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
        }
    }
}

pub const RPC_METHODS: &[&str] = &[
    "kb.query",
    "kb.ask",
    "kb.read",
    "kb.write",
    "kb.create",
    "kb.draftList",
    "kb.draftSave",
    "kb.draftDelete",
    "kb.list",
    "kb.status",
    "kb.listTypes",
    "kb.suggestions",
    "kb.reindex",
];

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

fn required(v: &Value, key: &str) -> Result<String, RpcFailure> {
    s(v, key).ok_or_else(|| RpcFailure::new("invalid_params", format!("missing param: {key}")))
}

fn to_value<T: Serialize>(t: &T) -> Result<Value, RpcFailure> {
    serde_json::to_value(t).map_err(|e| RpcFailure::new("internal", e))
}

/// Execute one RPC. Errors carry a machine `code` + human `message` and are
/// transported as `{ok:false, error:{code,message}}` by every transport.
pub async fn dispatch(config: &Config, method: &str, params: &Value) -> Result<Value, RpcFailure> {
    match method {
        "kb.query" => {
            let opts = SearchOptions {
                query: required(params, "query")?,
                limit: params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|v| v.clamp(1, 100) as usize)
                    .unwrap_or(10),
                doc_type: s(params, "docType"),
                full: params.get("full").and_then(|v| v.as_bool()).unwrap_or(false),
                group: params.get("group").and_then(|v| v.as_bool()).unwrap_or(false),
                max_distance: params
                    .get("maxDistance")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
            };
            let out = search(config, &opts)
                .await
                .map_err(|e| RpcFailure::new("search_failed", format!("{e:#}")))?;
            to_value(&out)
        }
        "kb.ask" => {
            let question = required(params, "query")?;
            let out = ask(config, &question)
                .await
                .map_err(|e| RpcFailure::new("ask_failed", format!("{e:#}")))?;
            to_value(&out)
        }
        "kb.read" => {
            let path = required(params, "path")?;
            let note =
                read_note(config, &path).map_err(|e| RpcFailure::new("read_failed", format!("{e:#}")))?;
            to_value(&note)
        }
        "kb.write" => {
            let path = required(params, "path")?;
            let content = required(params, "content")?;
            write_note(config, &path, &content)
                .map_err(|e| RpcFailure::new("write_failed", format!("{e:#}")))?;
            Ok(json!({ "path": path }))
        }
        "kb.create" => {
            let content = required(params, "content")?;
            let created = create_note(config, &content, s(params, "title"))
                .map_err(|e| RpcFailure::new("create_failed", format!("{e:#}")))?;
            to_value(&created)
        }
        "kb.draftList" => {
            let drafts = list_drafts(config)
                .map_err(|e| RpcFailure::new("draft_list_failed", format!("{e:#}")))?;
            Ok(json!({ "drafts": drafts }))
        }
        "kb.draftSave" => {
            let text = required(params, "text")?;
            let saved = save_draft(config, s(params, "id"), &text)
                .map_err(|e| RpcFailure::new("draft_save_failed", format!("{e:#}")))?;
            to_value(&saved)
        }
        "kb.draftDelete" => {
            let id = required(params, "id")?;
            delete_draft(config, &id)
                .map_err(|e| RpcFailure::new("draft_delete_failed", format!("{e:#}")))?;
            Ok(json!({ "id": id }))
        }
        "kb.list" => {
            let limit = params
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v.clamp(1, 200) as usize)
                .unwrap_or(20);
            let docs = list_notes(config, limit)
                .map_err(|e| RpcFailure::new("list_failed", format!("{e:#}")))?;
            Ok(json!({ "docs": docs }))
        }
        "kb.status" => {
            let st =
                status(config).map_err(|e| RpcFailure::new("status_failed", format!("{e:#}")))?;
            to_value(&st)
        }
        "kb.listTypes" => {
            let types = list_types(config)
                .map_err(|e| RpcFailure::new("list_types_failed", format!("{e:#}")))?;
            Ok(json!({ "types": types }))
        }
        "kb.suggestions" => {
            let limit = params
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v.clamp(1, 50) as usize)
                .unwrap_or(6);
            let out = suggestions(config, limit)
                .map_err(|e| RpcFailure::new("suggestions_failed", format!("{e:#}")))?;
            Ok(json!({ "suggestions": out }))
        }
        "kb.reindex" => {
            // Fire-and-forget: return immediately; the compile lock prevents concurrent re-entry.
            let cfg = config.clone();
            tokio::spawn(async move {
                match reindex(&cfg, true).await {
                    Ok(r) => tracing::info!("rpc-triggered reindex done, generation={}", r.generation),
                    Err(e) => tracing::warn!("rpc-triggered reindex failed: {e:#}"),
                }
            });
            Ok(json!({ "started": true }))
        }
        _ => Err(RpcFailure::new(
            "unknown_method",
            format!("unknown method: {method}"),
        )),
    }
}
