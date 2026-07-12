//! `homekb mcp` — local MCP server over stdio (newline-delimited JSON-RPC).
//!
//! Tool set is identical to the remote MCP on the relay (see
//! docs/ARCHITECTURE.md "MCP 工具"); every tool maps onto the shared
//! [`homekb_core::dispatch`] RPC dispatcher.
//!
//! Wire in Claude Code: `claude mcp add homekb -- homekb mcp`

use anyhow::Result;
use homekb_core::Config;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL: &str = "2025-03-26";

pub fn run() -> Result<()> {
    let config = Config::load()?;
    let rt = super::runtime()?;
    rt.block_on(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        let mut stdout = tokio::io::stdout();
        while let Some(line) = lines.next_line().await? {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => {
                    write_out(&mut stdout, &rpc_error(Value::Null, -32700, "Parse error")).await?;
                    continue;
                }
            };
            if let Some(resp) = handle(&config, &msg).await {
                write_out(&mut stdout, &resp).await?;
            }
        }
        Ok(())
    })
}

async fn write_out(stdout: &mut tokio::io::Stdout, v: &Value) -> Result<()> {
    let mut s = serde_json::to_string(v)?;
    s.push('\n');
    stdout.write_all(s.as_bytes()).await?;
    stdout.flush().await?;
    Ok(())
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_text(payload: &Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(payload).unwrap_or_default();
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// None = notification（不响应）。
async fn handle(config: &Config, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    let is_notification = id.is_none() || id == Some(Value::Null);

    match method {
        "initialize" => {
            let requested = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let version = if PROTOCOL_VERSIONS.contains(&requested) {
                requested
            } else {
                DEFAULT_PROTOCOL
            };
            Some(rpc_result(
                id?,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "homekb", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "HomeKB is the user's personal knowledge base on this machine. Search before creating; prefer kb_search → kb_read for recall, kb_create for new knowledge.",
                }),
            ))
        }
        "ping" => Some(rpc_result(id?, json!({}))),
        "tools/list" => Some(rpc_result(id?, json!({ "tools": tool_defs() }))),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let Some((rpc_method, rpc_params)) = map_tool(name, &args) else {
                return Some(rpc_error(id?, -32602, &format!("Unknown tool: {name}")));
            };
            let result = match homekb_core::dispatch(config, rpc_method, &rpc_params).await {
                Ok(v) => tool_text(&v, false),
                Err(e) => tool_text(
                    &json!({ "error": e.code, "message": e.message }),
                    true,
                ),
            };
            Some(rpc_result(id?, result))
        }
        _ => {
            if is_notification || method.starts_with("notifications/") {
                None
            } else {
                Some(rpc_error(id?, -32601, &format!("Method not found: {method}")))
            }
        }
    }
}

/// tool 名 + 入参 → 隧道 RPC（method, params）。与远程 lib/mcp/tools.ts 对齐。
fn map_tool(name: &str, a: &Value) -> Option<(&'static str, Value)> {
    let g = |k: &str| a.get(k).cloned().unwrap_or(Value::Null);
    match name {
        "kb_search" => Some((
            "kb.query",
            json!({ "query": g("query"), "limit": g("limit"), "docType": g("doc_type"), "full": g("full") }),
        )),
        "kb_read" => Some(("kb.read", json!({ "path": g("path") }))),
        "kb_create" => Some(("kb.create", json!({ "content": g("content"), "title": g("title") }))),
        "kb_update" => Some(("kb.write", json!({ "path": g("path"), "content": g("content") }))),
        "kb_list" => Some(("kb.list", json!({ "limit": g("limit") }))),
        "kb_status" => Some(("kb.status", json!({}))),
        _ => None,
    }
}

fn tool_defs() -> Value {
    json!([
        {
            "name": "kb_search",
            "description": "Semantic search over the user's personal knowledge base (Markdown notes on this machine). Returns the most relevant chunks/documents with path, title, content and score. Use this first to find existing knowledge.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language search query" },
                    "limit": { "type": "number", "description": "Max results (default 10)" },
                    "doc_type": { "type": "string", "description": "Optional document type filter" },
                    "full": { "type": "boolean", "description": "Return whole documents instead of chunks" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "kb_read",
            "description": "Read the full Markdown content of a note by its relative path (as returned by kb_search / kb_list).",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Relative path of the note, e.g. 'foo.md'" } },
                "required": ["path"]
            }
        },
        {
            "name": "kb_create",
            "description": "Create a new Markdown note in the knowledge base. The filename is derived from the title (or first heading). Returns the created path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "Full Markdown content of the note" },
                    "title": { "type": "string", "description": "Optional title (used for the filename)" }
                },
                "required": ["content"]
            }
        },
        {
            "name": "kb_update",
            "description": "Overwrite an existing note (full Markdown replacement). Read it first with kb_read to avoid losing content.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path of the note to overwrite" },
                    "content": { "type": "string", "description": "New full Markdown content" }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "kb_list",
            "description": "List recent notes in the knowledge base (path, title, type, modified time), newest first.",
            "inputSchema": {
                "type": "object",
                "properties": { "limit": { "type": "number", "description": "Max entries (default 20)" } }
            }
        },
        {
            "name": "kb_status",
            "description": "Knowledge base index status: document/chunk counts, pending embeddings, last compile time.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}
