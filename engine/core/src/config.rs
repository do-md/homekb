//! homekb configuration.
//!
//! Config file location: `$HOMEKB_CONFIG` > `~/.config/homekb/config.toml`
//! (honoring `$XDG_CONFIG_HOME`). Every field is optional — a missing file
//! resolves to all defaults, so `Config::load()` never fails just because
//! the user hasn't run `homekb init` yet.
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

/// `[relay]` section — credentials written by `homekb register`.
/// Parsed and persisted only; the network side lands in a later iteration.
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

/// `[serve]` section — HTTP RPC bind address + direct-mode credential
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

/// On-disk shape of config.toml: everything optional.
/// NOTE: the table sections (`serve`, `relay`) must stay the last fields —
/// TOML requires tables after plain values when serializing.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ConfigFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    live_db: Option<String>,
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
    pub snapshot_path: PathBuf,
    pub live_db: PathBuf,
    /// Key from the config file only. Use [`Config::openai_api_key`] to
    /// resolve with the full env > file > ~/.config/openai/api_key order.
    pub openai_api_key: Option<String>,

    pub embedding_model: String,
    pub embedding_dim: usize,
    pub summarizer_model: String,
    pub chunk_target_tokens: u32,
    pub chunk_hard_max: u32,
    pub summary_diff_threshold: f32,
    pub embed_concurrency: usize,
    pub embed_batch_size: usize,

    pub serve: Option<ServeConfig>,
    pub relay: Option<RelayConfig>,
}

/// CLI-level overrides applied on top of the config file (used by `init`).
#[derive(Debug, Default, Clone)]
pub struct ConfigOverrides {
    pub root: Option<PathBuf>,
    pub notes_dir: Option<PathBuf>,
    pub openai_api_key: Option<String>,
}

impl Config {
    /// Load from `$HOMEKB_CONFIG` / `~/.config/homekb/config.toml`.
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

        Ok(Self {
            root,
            notes_dir,
            snapshot_path,
            live_db,
            openai_api_key: ov.openai_api_key.or(file.openai_api_key),
            embedding_model: file
                .embedding_model
                .unwrap_or_else(|| "text-embedding-3-small".into()),
            embedding_dim: file.embedding_dim.unwrap_or(1536),
            summarizer_model: file.summarizer_model.unwrap_or_else(|| "gpt-4o-mini".into()),
            chunk_target_tokens: file.chunk_target_tokens.unwrap_or(800),
            chunk_hard_max: file.chunk_hard_max.unwrap_or(2000),
            summary_diff_threshold: file.summary_diff_threshold.unwrap_or(0.15),
            embed_concurrency: file.embed_concurrency.unwrap_or(8),
            embed_batch_size: file.embed_batch_size.unwrap_or(100),
            serve: file.serve,
            relay: file.relay,
        })
    }

    /// Write the current configuration back to config.toml
    /// (`$HOMEKB_CONFIG` or `~/.config/homekb/config.toml`).
    /// Used by `init` and, later, `register`. Returns the path written.
    pub fn save(&self) -> Result<PathBuf> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let file = ConfigFile {
            root: Some(self.root.display().to_string()),
            notes_dir: Some(self.notes_dir.display().to_string()),
            snapshot_path: Some(self.snapshot_path.display().to_string()),
            live_db: Some(self.live_db.display().to_string()),
            openai_api_key: self.openai_api_key.clone(),
            embedding_model: Some(self.embedding_model.clone()),
            embedding_dim: Some(self.embedding_dim),
            summarizer_model: Some(self.summarizer_model.clone()),
            chunk_target_tokens: Some(self.chunk_target_tokens),
            chunk_hard_max: Some(self.chunk_hard_max),
            summary_diff_threshold: Some(self.summary_diff_threshold),
            embed_concurrency: Some(self.embed_concurrency),
            embed_batch_size: Some(self.embed_batch_size),
            serve: self.serve.clone(),
            relay: self.relay.clone(),
        };
        let body = toml::to_string_pretty(&file).context("serialize config")?;
        let content = format!("# homekb configuration — see docs/ARCHITECTURE.md\n{body}");
        std::fs::write(&path, content).with_context(|| format!("write {}", path.display()))?;
        Ok(path)
    }

    /// Resolve the OpenAI API key.
    ///
    /// Lookup order:
    ///   1. `$OPENAI_API_KEY`
    ///   2. `openai_api_key` in config.toml
    ///   3. `~/.config/openai/api_key` (honoring `$XDG_CONFIG_HOME`)
    pub fn openai_api_key(&self) -> Result<String> {
        if let Ok(k) = std::env::var("OPENAI_API_KEY") {
            let trimmed = k.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
        if let Some(k) = &self.openai_api_key {
            let trimmed = k.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
        let path = xdg_config_home()?.join("openai").join("api_key");
        if path.is_file() {
            let raw = std::fs::read_to_string(&path)
                .with_context(|| format!("read {}", path.display()))?;
            let key = raw.trim().to_string();
            if !key.is_empty() {
                return Ok(key);
            }
        }
        bail!(
            "no OpenAI API key found. Set $OPENAI_API_KEY, put `openai_api_key` in config.toml, \
             or write the key to {}",
            path.display()
        );
    }

    /// Compile lock file, colocated with the live db (local disk, never synced).
    pub fn lock_path(&self) -> PathBuf {
        match self.live_db.parent() {
            Some(p) => p.join("compile.lock"),
            None => PathBuf::from("compile.lock"),
        }
    }
}

/// Path of the config file: `$HOMEKB_CONFIG` if set, else
/// `$XDG_CONFIG_HOME/homekb/config.toml` (default `~/.config/homekb/config.toml`).
/// The file does not have to exist.
pub fn config_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("HOMEKB_CONFIG") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    Ok(xdg_config_home()?.join("homekb").join("config.toml"))
}

/// XDG-style config home: `$XDG_CONFIG_HOME` if set, else `$HOME/.config`.
/// Used on every platform so config lives in the same place regardless of OS.
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
