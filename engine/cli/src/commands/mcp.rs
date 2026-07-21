//! `homekb mcp` — local MCP server over stdio (newline-delimited JSON-RPC).
//!
//! Tool set is identical to the remote MCP on the relay (see
//! docs/ARCHITECTURE.md "MCP tools"); every tool maps onto the shared
//! [`homekb_core::dispatch`] RPC dispatcher.
//!
//! Wire in with one command: `homekb mcp --install` (registers this binary by
//! ABSOLUTE path in `claude` / `codex` — agent MCP launchers don't necessarily
//! share the shell's PATH, so a bare `homekb` registration fails with an opaque
//! "Failed to connect"). See docs/ARCHITECTURE.md "CLI".

use anyhow::{Context, Result, bail};
use homekb_core::Config;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL: &str = "2025-03-26";

/// Target for `homekb mcp --install/--uninstall`.
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpAgent {
    /// Every supported agent CLI found on PATH (the bare-flag default).
    #[value(hide = true)]
    Auto,
    /// Claude Code (`claude mcp add`, user scope).
    Claude,
    /// Codex CLI (`codex mcp add`).
    Codex,
}

/// `homekb mcp --install [AGENT]` — register this binary as an MCP server.
///
/// Always registers the engine's ABSOLUTE path (`current_exe`, kept as launched
/// so a Homebrew symlink stays stable across upgrades), never the bare command:
/// the agent's MCP launcher does not necessarily share the shell's PATH (e.g.
/// `~/.local/bin` is missing from a GUI-launched agent), and a bare-command
/// registration then fails with an opaque "Failed to connect".
pub fn run_install(agent: McpAgent) -> Result<()> {
    let exe = current_exe_str()?;
    let mut installed = 0;
    for target in resolve_targets(agent)? {
        match target {
            McpAgent::Claude => {
                let cli = require_cli("claude", agent, &manual_claude(&exe))?;
                let Some(cli) = cli else { continue };
                // Best-effort remove first so a re-run is idempotent (a stale
                // path from a previous install location would otherwise stick).
                let _ = run_cli(&cli, &["mcp", "remove", "homekb", "-s", "user"]);
                run_cli_checked(
                    &cli,
                    &["mcp", "add", "homekb", "-s", "user", "--", &exe, "mcp"],
                )?;
                println!("Claude Code: registered `homekb` (user scope) -> {exe} mcp");
                println!("  New Claude Code sessions pick it up automatically.");
                installed += 1;
            }
            McpAgent::Codex => {
                let cli = require_cli("codex", agent, &manual_codex(&exe))?;
                let Some(cli) = cli else { continue };
                let _ = run_cli(&cli, &["mcp", "remove", "homekb"]);
                run_cli_checked(&cli, &["mcp", "add", "homekb", "--", &exe, "mcp"])?;
                println!("Codex: registered `homekb` -> {exe} mcp");
                installed += 1;
            }
            McpAgent::Auto => unreachable!("resolve_targets never yields Auto"),
        }
    }
    if installed == 0 {
        bail!(
            "no supported agent CLI (claude, codex) found on PATH. Register manually:\n  {}\n  {}",
            manual_claude(&exe),
            manual_codex(&exe)
        );
    }
    Ok(())
}

/// `homekb mcp --uninstall [AGENT]` — remove the registration again.
pub fn run_uninstall(agent: McpAgent) -> Result<()> {
    let mut removed = 0;
    for target in resolve_targets(agent)? {
        let (name, args): (&str, &[&str]) = match target {
            McpAgent::Claude => ("claude", &["mcp", "remove", "homekb", "-s", "user"]),
            McpAgent::Codex => ("codex", &["mcp", "remove", "homekb"]),
            McpAgent::Auto => unreachable!("resolve_targets never yields Auto"),
        };
        let manual = format!("{name} mcp remove homekb");
        let Some(cli) = require_cli(name, agent, &manual)? else { continue };
        // "not registered" is a fine outcome for an uninstall — stay quiet on failure.
        match run_cli(&cli, args) {
            Ok(out) if out.status.success() => {
                println!("{}: removed the `homekb` MCP registration", agent_label(target));
                removed += 1;
            }
            _ => println!("{}: no `homekb` MCP registration found", agent_label(target)),
        }
    }
    if removed == 0 {
        println!("Nothing removed.");
    }
    Ok(())
}

/// Best-effort removal from every agent CLI on PATH — used by `homekb uninstall`
/// so no dangling dead MCP server outlives the binary. Never fails.
pub fn deregister_all_quiet() {
    for (name, args) in [
        ("claude", ["mcp", "remove", "homekb", "-s", "user"].as_slice()),
        ("codex", ["mcp", "remove", "homekb"].as_slice()),
    ] {
        if let Some(cli) = find_on_path(name) {
            let _ = run_cli(&cli, args);
        }
    }
}

/// True when at least one supported agent CLI is on PATH (for uninstall's plan).
pub fn any_agent_cli_on_path() -> bool {
    find_on_path("claude").is_some() || find_on_path("codex").is_some()
}

fn agent_label(a: McpAgent) -> &'static str {
    match a {
        McpAgent::Claude => "Claude Code",
        McpAgent::Codex => "Codex",
        McpAgent::Auto => "auto",
    }
}

fn manual_claude(exe: &str) -> String {
    format!("claude mcp add homekb -s user -- {exe} mcp")
}

fn manual_codex(exe: &str) -> String {
    format!("codex mcp add homekb -- {exe} mcp")
}

fn current_exe_str() -> Result<String> {
    let exe = std::env::current_exe().context("cannot resolve the engine's own path")?;
    Ok(exe.to_string_lossy().into_owned())
}

/// Explicit agent -> just that one; Auto -> every agent whose CLI is on PATH.
fn resolve_targets(agent: McpAgent) -> Result<Vec<McpAgent>> {
    Ok(match agent {
        McpAgent::Claude => vec![McpAgent::Claude],
        McpAgent::Codex => vec![McpAgent::Codex],
        McpAgent::Auto => [McpAgent::Claude, McpAgent::Codex]
            .into_iter()
            .filter(|a| {
                let name = match a {
                    McpAgent::Claude => "claude",
                    _ => "codex",
                };
                find_on_path(name).is_some()
            })
            .collect(),
    })
}

/// Resolve the agent CLI. Explicit request + missing CLI = hard error with the
/// manual command; Auto mode skips silently (resolve_targets already filtered,
/// so a miss here is a race at worst).
fn require_cli(name: &str, requested: McpAgent, manual: &str) -> Result<Option<PathBuf>> {
    match find_on_path(name) {
        Some(p) => Ok(Some(p)),
        None if requested == McpAgent::Auto => Ok(None),
        None => bail!("`{name}` CLI not found on PATH. Register manually:\n  {manual}"),
    }
}

/// PATH lookup without executing anything (also honours Windows .exe/.cmd/.bat).
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidates: &[String] = if cfg!(windows) {
            &[
                format!("{name}.exe"),
                format!("{name}.cmd"),
                format!("{name}.bat"),
                name.to_string(),
            ]
        } else {
            &[name.to_string()]
        };
        for c in candidates {
            let p = dir.join(c);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn run_cli(cli: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    // Windows .cmd/.bat shims (npm installs) can't be spawned directly.
    let ext = cli.extension().and_then(|e| e.to_str()).unwrap_or("");
    if cfg!(windows) && matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat") {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(cli).args(args);
        cmd.output()
    } else {
        Command::new(cli).args(args).output()
    }
}

fn run_cli_checked(cli: &Path, args: &[&str]) -> Result<()> {
    let out = run_cli(cli, args)
        .with_context(|| format!("failed to run {}", cli.display()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let detail = if stderr.trim().is_empty() { stdout } else { stderr };
        bail!(
            "`{} {}` failed: {}",
            cli.display(),
            args.join(" "),
            detail.trim()
        );
    }
    Ok(())
}

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

/// Returns None for notifications (no response sent).
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

/// Maps a tool name + arguments to a tunnel RPC (method, params). Mirrors the remote lib/mcp/tools.ts.
fn map_tool(name: &str, a: &Value) -> Option<(&'static str, Value)> {
    let g = |k: &str| a.get(k).cloned().unwrap_or(Value::Null);
    match name {
        "kb_search" => Some((
            "kb.query",
            json!({ "query": g("query"), "limit": g("limit"), "docType": g("doc_type"), "full": g("full"), "enumerate": g("enumerate") }),
        )),
        "kb_read" => Some(("kb.read", json!({ "path": g("path") }))),
        "kb_create" => Some(("kb.create", json!({ "content": g("content"), "title": g("title") }))),
        "kb_update" => Some(("kb.write", json!({ "path": g("path"), "content": g("content") }))),
        "kb_list" => Some(("kb.list", json!({ "limit": g("limit") }))),
        "kb_status" => Some(("kb.status", json!({}))),
        "kb_share" => Some((
            "kb.shareCreate",
            json!({ "path": g("path"), "password": g("password"), "expiresDays": g("expires_in_days") }),
        )),
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
                    "full": { "type": "boolean", "description": "Return whole documents instead of chunks" },
                    "enumerate": { "type": "boolean", "description": "Whole-category sweep: return EVERY doc of doc_type (content = summary) ranked by relevance. Use for 'list everything in X' intents; requires doc_type; limit is ignored" }
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
        },
        {
            "name": "kb_share",
            "description": "Create a PUBLIC share link for one note — anyone with the link (and the password, if set) can read it. The note is served live from this machine; requires an active relay registration. Confirm with the user before sharing sensitive content.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path of the note to share" },
                    "password": { "type": "string", "description": "Optional password protecting the link" },
                    "expires_in_days": { "type": "number", "description": "Optional expiry in days (default: never)" }
                },
                "required": ["path"]
            }
        }
    ])
}
