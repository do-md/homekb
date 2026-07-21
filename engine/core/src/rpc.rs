//! Shared RPC dispatcher — the single implementation behind all three
//! transports: local MCP (stdio), `homekb serve` (localhost HTTP) and
//! `homekb tunnel` (relay SSE). Method set = ARCHITECTURE.md "RPC methods".

use serde::Serialize;
use serde_json::{Value, json};

use crate::api::{SearchOptions, list_types, reindex, search, status, suggestions};
use crate::ask::{ask, search_routed};
use crate::config::Config;
use crate::drafts::{delete_draft, list_drafts, save_draft};
use crate::notes::{create_note, list_notes, read_note, write_note};
use crate::shares::{ShareError, create_share, get_share, list_shares, revoke_share};

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
    "kb.rebuild",
    "kb.scheduleGet",
    "kb.scheduleSet",
    "kb.configGet",
    "kb.configSetAi",
    "kb.shareCreate",
    "kb.shareGet",
    "kb.shareList",
    "kb.shareRevoke",
];

fn share_failure(e: ShareError) -> RpcFailure {
    RpcFailure {
        code: e.code().to_string(),
        message: e.message(),
    }
}

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
                enumerate: params
                    .get("enumerate")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            };
            // route: true → the engine runs the ask router first and applies
            // the inferred docType/enumeration (docs/ARCHITECTURE.md
            // "routed search"). Explicit params take precedence.
            let routed = params.get("route").and_then(|v| v.as_bool()).unwrap_or(false);
            let out = if routed {
                search_routed(config, &opts)
                    .await
                    .map_err(|e| RpcFailure::new("search_failed", format!("{e:#}")))?
            } else {
                search(config, &opts)
                    .await
                    .map_err(|e| RpcFailure::new("search_failed", format!("{e:#}")))?
            };
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
            // App-layer write = exact compile trigger point: kick an immediate
            // incremental compile instead of waiting for the fallback scan
            // (docs "Compile trigger model"). Coalesced + fire-and-forget.
            crate::compile_queue::request_compile(config);
            Ok(json!({ "path": path }))
        }
        "kb.create" => {
            let content = required(params, "content")?;
            let created = create_note(config, &content, s(params, "title"))
                .map_err(|e| RpcFailure::new("create_failed", format!("{e:#}")))?;
            crate::compile_queue::request_compile(config);
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
        "kb.rebuild" => {
            // Full rebuild + reindex after an embedding provider/model switch
            // (docs "RPC methods"): fire-and-forget like kb.reindex — rebuild
            // resets the live db to the current embedding config, then a full
            // reindex re-embeds everything. The compile lock serializes against
            // a concurrent scheduled compile; the existing rebuild guards keep
            // the last good snapshot if the new endpoint turns out broken.
            let cfg = config.clone();
            tokio::spawn(async move {
                let reset = {
                    let cfg = cfg.clone();
                    tokio::task::spawn_blocking(move || crate::api::rebuild(&cfg)).await
                };
                match reset {
                    Ok(Ok(())) => match reindex(&cfg, true).await {
                        Ok(r) => tracing::info!(
                            "rpc-triggered rebuild+reindex done, generation={}",
                            r.generation
                        ),
                        Err(e) => tracing::warn!("rpc-triggered rebuild: reindex failed: {e:#}"),
                    },
                    Ok(Err(e)) => tracing::warn!("rpc-triggered rebuild failed: {e:#}"),
                    Err(e) => tracing::warn!("rpc-triggered rebuild panicked: {e}"),
                }
            });
            Ok(json!({ "started": true }))
        }
        "kb.scheduleGet" => {
            let st = crate::schedule::schedule_status()
                .map_err(|e| RpcFailure::new("schedule_failed", format!("{e:#}")))?;
            to_value(&st)
        }
        "kb.scheduleSet" => {
            if !cfg!(target_os = "macos") {
                return Err(RpcFailure::new(
                    "unsupported_platform",
                    "background compile scheduling is currently macOS-only (launchd); run `homekb watch` on the home machine instead",
                ));
            }
            let enabled = params
                .get("enabled")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| RpcFailure::new("invalid_params", "missing param: enabled"))?;
            let interval = params.get("intervalSecs").and_then(|v| v.as_u64());
            let st = if enabled {
                crate::schedule::schedule_enable(interval)
            } else {
                crate::schedule::schedule_disable()
            }
            .map_err(|e| RpcFailure::new("schedule_failed", format!("{e:#}")))?;
            to_value(&st)
        }
        "kb.configGet" => {
            // Masked config summary (docs "Settings over RPC") — built from the
            // raw file, independent of the `config` snapshot passed in, so the
            // Settings surface always reflects the latest write.
            let summary = crate::config_edit::config_summary()
                .map_err(|e| RpcFailure::new("config_get_failed", format!("{e:#}")))?;
            to_value(&summary)
        }
        "kb.configSetAi" => {
            let section = required(params, "section")?;
            let provider = s(params, "provider").unwrap_or_default();
            let dim = params
                .get("dim")
                .and_then(|v| v.as_u64())
                .and_then(|v| u32::try_from(v).ok());
            crate::config_edit::set_ai_endpoint(
                &section,
                &provider,
                s(params, "apiKey").as_deref(),
                s(params, "model").as_deref(),
                s(params, "baseUrl").as_deref(),
                dim,
            )
            .map_err(|e| RpcFailure::new("config_set_failed", format!("{e:#}")))?;
            // Echo the fresh masked summary; the write itself takes effect on
            // the next request via the transports' ConfigCell hot reload.
            let summary = crate::config_edit::config_summary()
                .map_err(|e| RpcFailure::new("config_get_failed", format!("{e:#}")))?;
            Ok(json!({ "ai": summary.ai }))
        }
        "kb.shareCreate" => {
            let path = required(params, "path")?;
            let password = s(params, "password");
            let expires_days = params
                .get("expiresDays")
                .and_then(|v| v.as_u64())
                .map(|v| v.min(3650) as u32);
            let out = create_share(config, &path, password.as_deref(), expires_days)
                .await
                .map_err(|e| RpcFailure::new("share_create_failed", format!("{e:#}")))?;
            to_value(&out)
        }
        "kb.shareGet" => {
            let share_id = required(params, "shareId")?;
            let password = s(params, "password");
            let note =
                get_share(config, &share_id, password.as_deref()).map_err(share_failure)?;
            to_value(&note)
        }
        "kb.shareList" => {
            let shares = list_shares(config)
                .map_err(|e| RpcFailure::new("share_list_failed", format!("{e:#}")))?;
            Ok(json!({ "shares": shares }))
        }
        "kb.shareRevoke" => {
            let share_id = required(params, "shareId")?;
            revoke_share(config, &share_id)
                .await
                .map_err(|e| RpcFailure::new("share_revoke_failed", format!("{e:#}")))?;
            Ok(json!({ "shareId": share_id }))
        }
        _ => Err(RpcFailure::new(
            "unknown_method",
            format!("unknown method: {method}"),
        )),
    }
}
