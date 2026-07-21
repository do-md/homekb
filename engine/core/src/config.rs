//! homekb configuration.
//!
//! Config file location: `$HOMEKB_CONFIG` > `~/.homekb/config.toml` (the
//! product's own home — HomeKB is self-contained under one folder) >
//! `~/.config/homekb/config.toml` (legacy location, read-only fallback;
//! migrated to the new path on the first write). Every field is optional —
//! a missing file resolves to all defaults, so `Config::load()` never fails
//! just because the user hasn't run `homekb init` yet.
//!
//! The config file is a **fixed anchor**: it always lives at
//! `~/.homekb/config.toml` even when `root`/`notes_dir` redirect the data
//! elsewhere (the config defines those paths, so it cannot move with them).
//!
//! AI endpoints (docs/ARCHITECTURE.md "AI provider presets"): one
//! OpenAI-protocol client serves every built-in provider — a preset is just
//! a base URL + default model + an env-var fallback for the key.
//!   [embedding]  required for compile & retrieval
//!   [summary]    required for compile (summaries / doc_type / question)
//!   [ask]        optional; falls back to [summary]
//!
//! Path defaults:
//!   root          = ~/.homekb
//!   notes_dir     = <root>/notes
//!   snapshot_path = <root>/index/index.db
//!   live_db       = <platform data dir>/homekb/live.db   (NOT inside root:
//!                   root may live on a synced drive; the WAL working db must not)

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// AI provider presets
// ---------------------------------------------------------------------------

/// Preset base URL per built-in provider (identical for embeddings and chat —
/// all of them speak the OpenAI protocol, natively or via a compat layer).
pub fn preset_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com/v1"),
        "gemini" => Some("https://generativelanguage.googleapis.com/v1beta/openai"),
        "voyage" => Some("https://api.voyageai.com/v1"),
        "cohere" => Some("https://api.cohere.ai/compatibility/v1"),
        "deepseek" => Some("https://api.deepseek.com/v1"),
        // Alibaba Cloud DashScope, OpenAI-compatible mode (mainland endpoint;
        // the Singapore region dashscope-intl.* plugs in via provider=custom).
        "qwen" => Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        _ => None,
    }
}

/// Env var consulted when a section has no `api_key`.
pub fn preset_key_env(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("OPENAI_API_KEY"),
        "gemini" => Some("GEMINI_API_KEY"),
        "voyage" => Some("VOYAGE_API_KEY"),
        "cohere" => Some("COHERE_API_KEY"),
        "deepseek" => Some("DEEPSEEK_API_KEY"),
        "qwen" => Some("DASHSCOPE_API_KEY"),
        _ => None,
    }
}

/// Default embedding model + native output dimension per provider.
/// DeepSeek has no embeddings API — chat-only preset.
pub(crate) fn preset_embedding_model(provider: &str) -> Option<(&'static str, usize)> {
    match provider {
        "openai" => Some(("text-embedding-3-small", 1536)),
        "gemini" => Some(("gemini-embedding-001", 3072)),
        "voyage" => Some(("voyage-4", 1024)),
        "cohere" => Some(("embed-v4.0", 1536)),
        "qwen" => Some(("text-embedding-v4", 1024)),
        _ => None,
    }
}

/// Default chat model per provider. Voyage/Cohere are embedding-only presets.
pub(crate) fn preset_chat_model(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("gpt-4o-mini"),
        "gemini" => Some("gemini-flash-lite-latest"),
        "deepseek" => Some("deepseek-chat"),
        "qwen" => Some("qwen-flash"),
        _ => None,
    }
}

/// Per-request input cap of a provider's `/v1/embeddings` endpoint (docs
/// "AI provider presets"). Some providers hard-reject large batches — a 4xx
/// on the whole request, not a throughput knob — so the engine clamps the
/// effective batch to `min(embed_batch_size, cap)`. `None` = no known cap.
pub fn preset_embedding_batch_cap(provider: &str) -> Option<usize> {
    match provider {
        "qwen" => Some(10),   // DashScope: max 10 inputs per request
        "cohere" => Some(96), // Cohere compat layer: max 96 texts
        _ => None,
    }
}

/// Resolve the API key for a provider: explicit config value > provider env
/// var > (openai only) the legacy `~/.config/openai/api_key` file kept for
/// pre-provider installs. `custom` endpoints may legitimately have no key
/// (self-hosted gateways) — they resolve to an empty string instead of
/// erroring.
pub fn resolve_provider_key(
    provider: &str,
    configured: Option<&str>,
    section: &str,
) -> Result<String> {
    if let Some(k) = configured {
        let trimmed = k.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    if let Some(env) = preset_key_env(provider) {
        if let Ok(k) = std::env::var(env) {
            let trimmed = k.trim().to_string();
            if !trimmed.is_empty() {
                return Ok(trimmed);
            }
        }
    }
    if provider == "openai" {
        // Legacy fallback (kb-compile era); kept so existing installs survive.
        if let Ok(cfg_home) = xdg_config_home() {
            let path = cfg_home.join("openai").join("api_key");
            if path.is_file() {
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    let key = raw.trim().to_string();
                    if !key.is_empty() {
                        return Ok(key);
                    }
                }
            }
        }
    }
    if provider == "custom" {
        return Ok(String::new());
    }
    let env_hint = preset_key_env(provider)
        .map(|e| format!(" or ${e}"))
        .unwrap_or_default();
    bail!(
        "no API key for [{section}] (provider \"{provider}\"). \
         Set `api_key` under [{section}] in config.toml{env_hint}."
    )
}

/// Resolved `[embedding]` endpoint — everything the engine needs to embed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingEndpoint {
    pub provider: String,
    pub base_url: String,
    /// Key from the config file only; use [`EmbeddingEndpoint::resolve_key`].
    pub api_key: Option<String>,
    pub model: String,
    /// Expected vector dimension (validation only — no dimensions param is
    /// ever sent; switching model/provider requires `rebuild --force`).
    pub dim: usize,
}

impl EmbeddingEndpoint {
    pub fn resolve_key(&self) -> Result<String> {
        resolve_provider_key(&self.provider, self.api_key.as_deref(), "embedding")
    }
}

/// Resolved chat endpoint (`[summary]`, or `[ask]` with summary fallback).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatEndpoint {
    pub provider: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    /// Which config section this endpoint came from (error messages).
    pub section: &'static str,
}

impl ChatEndpoint {
    pub fn resolve_key(&self) -> Result<String> {
        resolve_provider_key(&self.provider, self.api_key.as_deref(), self.section)
    }
}

// ---------------------------------------------------------------------------
// On-disk shapes
// ---------------------------------------------------------------------------

/// `[relay]` section — credentials written by `homekb register`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub home_id: String,
    #[serde(default)]
    pub home_secret: String,
    #[serde(default)]
    pub name: String,
}

/// `[serve]` section — HTTP RPC bind address + public-bind credential
/// (docs/ARCHITECTURE.md "HTTP RPC (homekb serve)"). All optional:
/// host defaults to 127.0.0.1, port to 8765; token (`hkd_…`) is required
/// only for non-loopback binds and is auto-generated on first public bind.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// On-disk shape of one AI endpoint section ([embedding]/[summary]/[ask]).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct AiSectionFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dim: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
}

/// On-disk shape of config.toml: everything optional.
/// NOTE: the table sections must stay the last fields — TOML requires
/// tables after plain values when serializing.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ConfigFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    drafts_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    live_db: Option<String>,
    // Legacy top-level keys (pre-provider configs). Parsed and mapped onto
    // [embedding]/[summary] with provider = "openai"; never written back.
    #[serde(skip_serializing_if = "Option::is_none")]
    openai_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    embedding_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    embedding_dim: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summarizer_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chunk_target_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chunk_hard_max: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary_diff_threshold: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    embed_concurrency: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    embed_batch_size: Option<usize>,
    /// Web UI origin used to compose share URLs (`<base>/s/<id>?r=<relay>`).
    #[serde(skip_serializing_if = "Option::is_none")]
    share_web_base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    embedding: Option<AiSectionFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<AiSectionFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ask: Option<AiSectionFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    serve: Option<ServeConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relay: Option<RelayConfig>,
}

/// Fully resolved runtime configuration. All paths are absolute.
#[derive(Debug, Clone)]
pub struct Config {
    pub root: PathBuf,
    pub notes_dir: PathBuf,
    /// Unpublished drafts store (`<root>/drafts` by default). Never a scan
    /// target; kept under the data root even when `notes_dir` is overridden.
    pub drafts_dir: PathBuf,
    pub snapshot_path: PathBuf,
    pub live_db: PathBuf,

    /// `[embedding]` — required for compile & retrieval.
    pub embedding: EmbeddingEndpoint,
    /// Whether the user actually configured an embedding endpoint (an
    /// `[embedding]` section, or the legacy top-level openai key). `false` =
    /// `embedding` holds unconfigured *defaults*: the compile pipeline must
    /// no-op instead of stamping/embedding with them, `save()` must not
    /// materialize the section into the file, and status surfaces report
    /// "not configured" (docs "Unconfigured means unconfigured").
    pub embedding_configured: bool,
    /// `[summary]` — required for compile (summaries, doc_type, question).
    pub summary: ChatEndpoint,
    /// Same contract as `embedding_configured`, for `[summary]`.
    pub summary_configured: bool,
    /// `[ask]` — optional override; `ask_endpoint()` falls back to summary.
    pub ask: Option<ChatEndpoint>,

    pub chunk_target_tokens: u32,
    pub chunk_hard_max: u32,
    pub summary_diff_threshold: f32,
    pub embed_concurrency: usize,
    pub embed_batch_size: usize,
    /// Web UI origin used to compose share URLs (`<base>/s/<id>?r=<relay>`).
    /// Default stays on localhost until an official Web origin exists.
    pub share_web_base: String,

    pub serve: Option<ServeConfig>,
    pub relay: Option<RelayConfig>,
}

/// CLI-level overrides applied on top of the config file (used by `init`).
#[derive(Debug, Default, Clone)]
pub struct ConfigOverrides {
    pub root: Option<PathBuf>,
    pub notes_dir: Option<PathBuf>,
    /// Legacy convenience: `init --openai-key` — applies to the openai
    /// provider's [embedding]/[summary] sections.
    pub openai_api_key: Option<String>,
}

impl Config {
    /// Load from `$HOMEKB_CONFIG` / `~/.homekb/config.toml` (legacy
    /// `~/.config/homekb/config.toml` as read fallback).
    /// A missing file yields the all-default config (never an error).
    pub fn load() -> Result<Self> {
        Self::load_with(ConfigOverrides::default())
    }

    /// Same as [`Config::load`], with explicit overrides taking precedence
    /// over file values (and defaults re-derived from an overridden root).
    pub fn load_with(overrides: ConfigOverrides) -> Result<Self> {
        let path = config_path()?;
        let file: ConfigFile = if path.is_file() {
            let raw = std::fs::read_to_string(&path)
                .with_context(|| format!("read {}", path.display()))?;
            toml::from_str(&raw).with_context(|| format!("parse {}", path.display()))?
        } else {
            ConfigFile::default()
        };
        Self::resolve(file, overrides)
    }

    fn resolve(file: ConfigFile, ov: ConfigOverrides) -> Result<Self> {
        let home = home_dir()?;

        let root = ov
            .root
            .or_else(|| file.root.as_deref().map(|p| expand_tilde(p, &home)))
            .unwrap_or_else(|| home.join(".homekb"));

        let notes_dir = ov
            .notes_dir
            .or_else(|| file.notes_dir.as_deref().map(|p| expand_tilde(p, &home)))
            .unwrap_or_else(|| root.join("notes"));

        // Drafts live under the data root regardless of a custom notes_dir:
        // they are unpublished working files, not part of the scanned corpus.
        let drafts_dir = file
            .drafts_dir
            .as_deref()
            .map(|p| expand_tilde(p, &home))
            .unwrap_or_else(|| root.join("drafts"));

        let snapshot_path = file
            .snapshot_path
            .as_deref()
            .map(|p| expand_tilde(p, &home))
            .unwrap_or_else(|| root.join("index").join("index.db"));

        let live_db = file
            .live_db
            .as_deref()
            .map(|p| expand_tilde(p, &home))
            .unwrap_or_else(|| {
                dirs::data_dir()
                    .unwrap_or_else(|| home.clone())
                    .join("homekb")
                    .join("live.db")
            });

        let legacy_key = ov.openai_api_key.clone().or(file.openai_api_key.clone());

        // Explicitly configured = the file has the section (or the legacy
        // top-level openai key). Absent both, the resolved endpoint below is a
        // pure default fill-in and must never be treated as an active choice.
        let embedding_configured = file.embedding.is_some() || legacy_key.is_some();
        let summary_configured = file.summary.is_some() || legacy_key.is_some();

        let embedding = resolve_embedding_section(
            file.embedding.as_ref(),
            legacy_key.as_deref(),
            file.embedding_model.as_deref(),
            file.embedding_dim,
        )?;
        let summary = resolve_chat_section(
            file.summary.as_ref(),
            "summary",
            legacy_key.as_deref(),
            file.summarizer_model.as_deref(),
        )?
        .context("[summary] resolution produced no endpoint")?;
        let ask = match file.ask.as_ref() {
            None => None,
            Some(sec) => resolve_chat_section(Some(sec), "ask", None, None)?,
        };

        Ok(Self {
            root,
            notes_dir,
            drafts_dir,
            snapshot_path,
            live_db,
            embedding,
            embedding_configured,
            summary,
            summary_configured,
            ask,
            chunk_target_tokens: file.chunk_target_tokens.unwrap_or(800),
            chunk_hard_max: file.chunk_hard_max.unwrap_or(2000),
            summary_diff_threshold: file.summary_diff_threshold.unwrap_or(0.15),
            embed_concurrency: file.embed_concurrency.unwrap_or(8),
            embed_batch_size: file.embed_batch_size.unwrap_or(100),
            share_web_base: file
                .share_web_base
                .map(|s| s.trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "http://localhost:3000".to_string()),
            serve: file.serve,
            relay: file.relay,
        })
    }

    /// The chat endpoint the ask pipeline uses: `[ask]` when configured,
    /// else `[summary]` — so `homekb ask` works out of the box while
    /// retrieval-only integrations never have to fill [ask] in.
    pub fn ask_endpoint(&self) -> ChatEndpoint {
        self.ask.clone().unwrap_or_else(|| self.summary.clone())
    }

    /// Write the current configuration to `$HOMEKB_CONFIG` or
    /// `~/.homekb/config.toml` (always the new anchor — a legacy
    /// `~/.config/homekb/config.toml` is renamed to `config.toml.migrated`
    /// after a successful write). Returns the path written.
    pub fn save(&self) -> Result<PathBuf> {
        let path = write_config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let file = ConfigFile {
            root: Some(self.root.display().to_string()),
            notes_dir: Some(self.notes_dir.display().to_string()),
            drafts_dir: Some(self.drafts_dir.display().to_string()),
            snapshot_path: Some(self.snapshot_path.display().to_string()),
            live_db: Some(self.live_db.display().to_string()),
            openai_api_key: None,
            embedding_model: None,
            embedding_dim: None,
            summarizer_model: None,
            chunk_target_tokens: Some(self.chunk_target_tokens),
            chunk_hard_max: Some(self.chunk_hard_max),
            summary_diff_threshold: Some(self.summary_diff_threshold),
            embed_concurrency: Some(self.embed_concurrency),
            embed_batch_size: Some(self.embed_batch_size),
            share_web_base: Some(self.share_web_base.clone()),
            // Only materialize sections the user actually configured —
            // writing the default fill-ins would turn "unconfigured" into a
            // phantom openai configuration on the next load (docs
            // "Unconfigured means unconfigured"; `register`/`init` call this
            // long before the user has picked a provider).
            embedding: self.embedding_configured.then(|| AiSectionFile {
                provider: Some(self.embedding.provider.clone()),
                api_key: self.embedding.api_key.clone(),
                model: Some(self.embedding.model.clone()),
                dim: Some(self.embedding.dim),
                base_url: (self.embedding.provider == "custom")
                    .then(|| self.embedding.base_url.clone()),
            }),
            summary: self.summary_configured.then(|| AiSectionFile {
                provider: Some(self.summary.provider.clone()),
                api_key: self.summary.api_key.clone(),
                model: Some(self.summary.model.clone()),
                dim: None,
                base_url: (self.summary.provider == "custom")
                    .then(|| self.summary.base_url.clone()),
            }),
            ask: self.ask.as_ref().map(|a| AiSectionFile {
                provider: Some(a.provider.clone()),
                api_key: a.api_key.clone(),
                model: Some(a.model.clone()),
                dim: None,
                base_url: (a.provider == "custom").then(|| a.base_url.clone()),
            }),
            serve: self.serve.clone(),
            relay: self.relay.clone(),
        };
        let body = toml::to_string_pretty(&file).context("serialize config")?;
        let content = format!("# homekb configuration — see docs/ARCHITECTURE.md\n{body}");
        std::fs::write(&path, content).with_context(|| format!("write {}", path.display()))?;

        // One-way migration: once the new anchor exists, retire the legacy
        // file so no process reads stale state from it (best-effort).
        if std::env::var("HOMEKB_CONFIG").map(|v| !v.is_empty()).unwrap_or(false) == false {
            if let Ok(legacy) = legacy_config_path() {
                if legacy.is_file() && legacy != path {
                    let _ = std::fs::rename(&legacy, legacy.with_extension("toml.migrated"));
                }
            }
        }
        Ok(path)
    }

    /// Compile lock file, colocated with the live db (local disk, never synced).
    pub fn lock_path(&self) -> PathBuf {
        match self.live_db.parent() {
            Some(p) => p.join("compile.lock"),
            None => PathBuf::from("compile.lock"),
        }
    }
}

/// Mtime-checked hot-reload handle for long-running transports
/// (docs/ARCHITECTURE.md "Settings over RPC", hot reload): `homekb serve` and
/// `homekb tunnel` resolve `Config` per request through this cell instead of
/// caching it at startup, so a `kb.configSetAi` write (or a desktop command /
/// hand edit) is picked up on the very next RPC with no process restart.
///
/// Cost per call = one `metadata()` stat. A load *error* keeps the last good
/// config and logs — a transient bad write must not take the transport down.
pub struct ConfigCell {
    inner: std::sync::Mutex<CellState>,
}

struct CellState {
    path: PathBuf,
    mtime: Option<std::time::SystemTime>,
    config: std::sync::Arc<Config>,
}

impl ConfigCell {
    pub fn new(config: Config) -> Self {
        let path = config_path().unwrap_or_default();
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        Self {
            inner: std::sync::Mutex::new(CellState {
                path,
                mtime,
                config: std::sync::Arc::new(config),
            }),
        }
    }

    /// The current config: re-loads when the config file's identity or mtime
    /// changed since the last call (the path is re-resolved every time — an
    /// anchor file appearing after startup switches over correctly).
    pub fn current(&self) -> std::sync::Arc<Config> {
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let path = config_path().unwrap_or_else(|_| state.path.clone());
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        if path != state.path || mtime != state.mtime {
            match Config::load() {
                Ok(fresh) => {
                    tracing::info!("config reloaded ({})", path.display());
                    state.config = std::sync::Arc::new(fresh);
                }
                Err(e) => {
                    tracing::warn!("config reload failed, keeping last good: {e:#}");
                }
            }
            state.path = path;
            state.mtime = mtime;
        }
        state.config.clone()
    }
}

fn resolve_embedding_section(
    sec: Option<&AiSectionFile>,
    legacy_key: Option<&str>,
    legacy_model: Option<&str>,
    legacy_dim: Option<usize>,
) -> Result<EmbeddingEndpoint> {
    let default = AiSectionFile::default();
    let sec = sec.unwrap_or(&default);
    let provider = sec.provider.clone().unwrap_or_else(|| "openai".into());

    let base_url = match sec.base_url.clone() {
        Some(u) => u.trim_end_matches('/').to_string(),
        None => preset_base_url(&provider)
            .with_context(|| bad_provider_msg("embedding", &provider, true))?
            .to_string(),
    };
    // Legacy top-level keys (`embedding_model`/`embedding_dim`/`openai_api_key`)
    // describe an *openai* index. They must only seed an openai section — never
    // leak into a gemini/voyage/... section, or the wrong model name is sent to
    // the wrong provider (e.g. `text-embedding-3-small` → Gemini → 404).
    let is_openai = provider == "openai";
    let legacy_model = legacy_model.filter(|_| is_openai);
    let legacy_dim = legacy_dim.filter(|_| is_openai);
    let (preset_model, preset_dim) = preset_embedding_model(&provider).unzip();
    let model = sec
        .model
        .clone()
        .or_else(|| legacy_model.map(str::to_string))
        .or_else(|| preset_model.map(str::to_string))
        .with_context(|| format!("[embedding] provider \"{provider}\" requires `model`"))?;
    // A custom dim only makes sense with a custom/legacy model; when the
    // model is the preset default, the preset dim is authoritative.
    let dim = sec
        .dim
        .or(legacy_dim)
        .or(preset_dim)
        .with_context(|| format!("[embedding] provider \"{provider}\" requires `dim`"))?;
    let api_key = sec
        .api_key
        .clone()
        .or_else(|| is_openai.then(|| legacy_key.map(str::to_string)).flatten());

    Ok(EmbeddingEndpoint {
        provider,
        base_url,
        api_key,
        model,
        dim,
    })
}

fn resolve_chat_section(
    sec: Option<&AiSectionFile>,
    section: &'static str,
    legacy_key: Option<&str>,
    legacy_model: Option<&str>,
) -> Result<Option<ChatEndpoint>> {
    let default = AiSectionFile::default();
    let sec = sec.unwrap_or(&default);
    let provider = sec.provider.clone().unwrap_or_else(|| "openai".into());

    let base_url = match sec.base_url.clone() {
        Some(u) => u.trim_end_matches('/').to_string(),
        None => preset_base_url(&provider)
            .with_context(|| bad_provider_msg(section, &provider, false))?
            .to_string(),
    };
    // Same rule as embedding: legacy `summarizer_model`/`openai_api_key` are
    // openai-shaped and must not seed a non-openai section.
    let is_openai = provider == "openai";
    let legacy_model = legacy_model.filter(|_| is_openai);
    let model = sec
        .model
        .clone()
        .or_else(|| legacy_model.map(str::to_string))
        .or_else(|| preset_chat_model(&provider).map(str::to_string))
        .with_context(|| {
            format!("[{section}] provider \"{provider}\" has no default chat model — set `model`")
        })?;
    let api_key = sec
        .api_key
        .clone()
        .or_else(|| is_openai.then(|| legacy_key.map(str::to_string)).flatten());

    Ok(Some(ChatEndpoint {
        provider,
        base_url,
        api_key,
        model,
        section,
    }))
}

fn bad_provider_msg(section: &str, provider: &str, embedding: bool) -> String {
    let known = if embedding {
        "openai | gemini | voyage | cohere | qwen | custom"
    } else {
        "openai | gemini | deepseek | qwen | custom"
    };
    if provider == "custom" {
        format!("[{section}] provider \"custom\" requires `base_url`")
    } else {
        format!("[{section}] unknown provider \"{provider}\" (known: {known})")
    }
}

/// Read path of the config file: `$HOMEKB_CONFIG` if set, else the new
/// anchor `~/.homekb/config.toml` when it exists, else the legacy
/// `~/.config/homekb/config.toml` when it exists, else the new anchor.
pub fn config_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("HOMEKB_CONFIG") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let anchored = home_dir()?.join(".homekb").join("config.toml");
    if anchored.is_file() {
        return Ok(anchored);
    }
    let legacy = legacy_config_path()?;
    if legacy.is_file() {
        return Ok(legacy);
    }
    Ok(anchored)
}

/// Write path: `$HOMEKB_CONFIG` or always the new anchor (writes migrate).
pub(crate) fn write_config_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("HOMEKB_CONFIG") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    Ok(home_dir()?.join(".homekb").join("config.toml"))
}

pub(crate) fn legacy_config_path() -> Result<PathBuf> {
    Ok(xdg_config_home()?.join("homekb").join("config.toml"))
}

/// XDG-style config home: `$XDG_CONFIG_HOME` if set, else `$HOME/.config`.
/// Only used for legacy fallbacks now (old config location, openai key file).
pub fn xdg_config_home() -> Result<PathBuf> {
    if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
        if !x.is_empty() {
            return Ok(PathBuf::from(x));
        }
    }
    Ok(home_dir()?.join(".config"))
}

fn home_dir() -> Result<PathBuf> {
    if let Some(h) = dirs::home_dir() {
        return Ok(h);
    }
    let home = std::env::var("HOME").context("cannot determine home directory")?;
    Ok(PathBuf::from(home))
}

fn expand_tilde(p: &str, home: &Path) -> PathBuf {
    if p == "~" {
        home.to_path_buf()
    } else if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(p)
    }
}

/// Compute a path relative to the notes root, with forward slashes.
pub fn relative_path(notes_root: &Path, full: &Path) -> String {
    full.strip_prefix(notes_root)
        .unwrap_or(full)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression: a non-openai section must NOT inherit the legacy top-level
    // openai model name (that leak sent `text-embedding-3-small` to Gemini → 404).
    #[test]
    fn gemini_section_ignores_legacy_openai_model() {
        let sec = AiSectionFile {
            provider: Some("gemini".into()),
            api_key: Some("k".into()),
            ..Default::default()
        };
        let ep = resolve_embedding_section(
            Some(&sec),
            Some("legacy-openai-key"),         // legacy openai_api_key
            Some("text-embedding-3-small"),    // legacy embedding_model
            Some(1536),                        // legacy embedding_dim
        )
        .unwrap();
        assert_eq!(ep.provider, "gemini");
        assert_eq!(ep.model, "gemini-embedding-001"); // preset default, not the legacy
        assert_eq!(ep.dim, 3072); // gemini preset dim, not the legacy 1536
        assert_eq!(ep.api_key.as_deref(), Some("k")); // its own key, not the openai legacy
    }

    // An openai section with no explicit model still honors the legacy keys.
    #[test]
    fn openai_section_keeps_legacy_fallback() {
        let ep = resolve_embedding_section(
            None,
            Some("legacy-openai-key"),
            Some("text-embedding-3-large"),
            Some(3072),
        )
        .unwrap();
        assert_eq!(ep.provider, "openai");
        assert_eq!(ep.model, "text-embedding-3-large");
        assert_eq!(ep.dim, 3072);
        assert_eq!(ep.api_key.as_deref(), Some("legacy-openai-key"));
    }

    // qwen (DashScope compatible mode) is a full preset: embedding + chat.
    #[test]
    fn qwen_preset_resolves_both_sections() {
        let sec = AiSectionFile {
            provider: Some("qwen".into()),
            api_key: Some("k".into()),
            ..Default::default()
        };
        let ep = resolve_embedding_section(Some(&sec), None, None, None).unwrap();
        assert_eq!(ep.model, "text-embedding-v4");
        assert_eq!(ep.dim, 1024);
        assert_eq!(ep.base_url, "https://dashscope.aliyuncs.com/compatible-mode/v1");

        let chat = resolve_chat_section(Some(&sec), "summary", None, None)
            .unwrap()
            .unwrap();
        assert_eq!(chat.model, "qwen-flash");
        assert_eq!(chat.base_url, "https://dashscope.aliyuncs.com/compatible-mode/v1");
    }

    // deepseek is chat-only: [summary]/[ask] resolve, [embedding] must error
    // (no embeddings API) with the known-provider hint.
    #[test]
    fn deepseek_is_chat_only() {
        let sec = AiSectionFile {
            provider: Some("deepseek".into()),
            api_key: Some("k".into()),
            ..Default::default()
        };
        let chat = resolve_chat_section(Some(&sec), "summary", None, None)
            .unwrap()
            .unwrap();
        assert_eq!(chat.model, "deepseek-chat");
        assert_eq!(chat.base_url, "https://api.deepseek.com/v1");

        let err = resolve_embedding_section(Some(&sec), None, None, None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("requires `model`"), "got: {err}");
    }

    // Providers with a hard per-request embeddings cap must clamp the
    // configured batch size (oversizing is a 4xx, not a throughput knob).
    #[test]
    fn embedding_batch_caps() {
        assert_eq!(preset_embedding_batch_cap("qwen"), Some(10));
        assert_eq!(preset_embedding_batch_cap("cohere"), Some(96));
        assert_eq!(preset_embedding_batch_cap("openai"), None);
    }

    // The save()-does-not-materialize-unconfigured-sections regression lives
    // in config_edit.rs tests (it needs the HOMEKB_CONFIG env lock there).
}
