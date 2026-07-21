//! Machine-driven config editing + the masked config summary — the shared
//! implementation behind `kb.configGet` / `kb.configSetAi`
//! (docs/ARCHITECTURE.md "Settings over RPC"). The desktop
//! `config_set_ai_endpoint` Tauri command implements the same write contract
//! on its side of the fence; the two must not drift.
//!
//! Security rules (the reason this file exists as a *contract*, not a helper):
//! 1. **Masked reads** — no read path returns an API key, only `keyPresent`.
//! 2. **Key ↔ endpoint binding** — the stored key is bound to its
//!    `(provider, baseUrl)` identity: a write that changes either drops the
//!    stored key unless the same write supplies a new one. Without this,
//!    "keep the stored key on same-provider writes" + "explicit base_url
//!    overrides the preset for any provider" compose into a key-exfiltration
//!    primitive (repoint the section at an attacker URL, key rides along).
//!
//! Writes are raw-table read-modify-write (unknown fields preserved, comments
//! are not — the file is machine-written by init/register anyway) and land at
//! the `~/.homekb/config.toml` anchor, migrating a legacy file.

use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

use crate::config::{
    config_path, legacy_config_path, preset_base_url, preset_chat_model, preset_embedding_model,
    resolve_provider_key, write_config_path,
};

/// One `[embedding]`/`[summary]`/`[ask]` section, masked for display.
/// `key_present` is resolved the way the engine itself would resolve the key
/// (config value > provider env var > openai legacy file; `custom` counts as
/// present — keyless gateways are legal). The key value itself never appears.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpointSummary {
    pub provider: String,
    pub model: String,
    pub key_present: bool,
    /// Whether the section exists in the file at all (an absent section still
    /// summarizes as its defaults; `ask` absent = summary fallback active).
    pub configured: bool,
    /// Echoed only when explicitly configured (never the preset default).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Embedding only, echoed only when explicitly configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dim: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSummary {
    pub embedding: AiEndpointSummary,
    pub summary: AiEndpointSummary,
    pub ask: AiEndpointSummary,
}

/// `kb.configGet` result (docs/ARCHITECTURE.md "RPC methods"). Path fields
/// are display strings describing the home machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSummary {
    pub root: String,
    pub notes_dir: String,
    pub config_path: String,
    pub ai: AiSummary,
}

fn read_table() -> toml::Table {
    config_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| toml::from_str(&raw).ok())
        .unwrap_or_default()
}

fn tbl_str<'a>(tbl: &'a toml::Table, key: &str) -> Option<&'a str> {
    tbl.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn home_dir_path() -> PathBuf {
    dirs::home_dir()
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("~"))
}

fn expand(p: &str) -> PathBuf {
    let home = home_dir_path();
    if p == "~" {
        home
    } else if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(p)
    }
}

fn summarize_section(tbl: &toml::Table, name: &str, chat: bool) -> AiEndpointSummary {
    let sec = tbl.get(name).and_then(|v| v.as_table());
    let sec_str = |k: &str| -> Option<String> {
        sec.and_then(|t| t.get(k))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let provider = sec_str("provider").unwrap_or_else(|| "openai".to_string());
    // Legacy top-level model keys seed an *openai* section only (same rule as
    // Config::load — a leaked openai model name 404s on other providers).
    let legacy_model = if provider == "openai" {
        tbl_str(tbl, if chat { "summarizer_model" } else { "embedding_model" })
            .filter(|_| name != "ask")
            .map(str::to_string)
    } else {
        None
    };
    let preset_model = if chat {
        preset_chat_model(&provider).map(str::to_string)
    } else {
        preset_embedding_model(&provider).map(|(m, _)| m.to_string())
    };
    let model = sec_str("model")
        .or(legacy_model)
        .or(preset_model)
        .unwrap_or_default();
    let key_present = provider == "custom"
        || resolve_provider_key(&provider, sec_str("api_key").as_deref(), name)
            .map(|k| !k.is_empty())
            .unwrap_or(false);
    AiEndpointSummary {
        provider,
        model,
        key_present,
        configured: sec.is_some(),
        base_url: sec_str("base_url"),
        dim: if chat {
            None
        } else {
            sec.and_then(|t| t.get("dim"))
                .and_then(|v| v.as_integer())
                .and_then(|d| u32::try_from(d).ok())
        },
    }
}

/// Build the masked config summary from the raw file. Deliberately does NOT
/// go through `Config::load()`: the Settings surface must render (and let the
/// user fix things) even when the config is currently invalid — e.g. a
/// `custom` section missing its `base_url`.
pub fn config_summary() -> Result<ConfigSummary> {
    let tbl = read_table();
    let root = tbl_str(&tbl, "root")
        .map(expand)
        .unwrap_or_else(|| home_dir_path().join(".homekb"));
    let notes_dir = tbl_str(&tbl, "notes_dir")
        .map(expand)
        .unwrap_or_else(|| root.join("notes"));
    Ok(ConfigSummary {
        root: root.display().to_string(),
        notes_dir: notes_dir.display().to_string(),
        config_path: config_path()?.display().to_string(),
        ai: AiSummary {
            embedding: summarize_section(&tbl, "embedding", false),
            summary: summarize_section(&tbl, "summary", true),
            ask: summarize_section(&tbl, "ask", true),
        },
    })
}

/// Write one `[embedding]`/`[summary]`/`[ask]` section (docs/ARCHITECTURE.md
/// `kb.configSetAi` — same contract as the desktop `config_set_ai_endpoint`).
///
/// Semantics:
/// - omitted/empty `api_key` keeps the stored key **only when neither the
///   provider nor the effective base URL changed** (key ↔ endpoint binding);
/// - switching provider clears the section's stored fields first;
/// - omitted/empty `model` resets to the provider default;
/// - empty `provider` on `ask` deletes the section (summary fallback);
/// - writes land at the `~/.homekb/config.toml` anchor and migrate a legacy
///   `~/.config/homekb/config.toml` (renamed to `config.toml.migrated`).
pub fn set_ai_endpoint(
    section: &str,
    provider: &str,
    api_key: Option<&str>,
    model: Option<&str>,
    base_url: Option<&str>,
    dim: Option<u32>,
) -> Result<()> {
    let chat = match section {
        "embedding" => false,
        "summary" | "ask" => true,
        other => bail!("unknown config section \"{other}\""),
    };
    let mut tbl = read_table();

    // Retire the legacy top-level model keys on first edit (they are
    // openai-shaped and bleed wrong model names into other providers).
    tbl.remove("embedding_model");
    tbl.remove("embedding_dim");
    tbl.remove("summarizer_model");

    let provider = provider.trim();
    if section == "ask" && provider.is_empty() {
        tbl.remove("ask");
        return write_table_migrating(&tbl);
    }
    let allowed: &[&str] = if chat {
        &["openai", "gemini", "deepseek", "qwen", "custom"]
    } else {
        &["openai", "gemini", "voyage", "cohere", "qwen", "custom"]
    };
    if !allowed.contains(&provider) {
        bail!(
            "unknown provider \"{provider}\" for [{section}] (known: {})",
            allowed.join(" | ")
        );
    }
    let base_url = base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string());
    if provider == "custom" && base_url.is_none() {
        bail!("[{section}] provider \"custom\" requires a base URL");
    }

    let mut sec = tbl
        .get(section)
        .and_then(|v| v.as_table())
        .cloned()
        .unwrap_or_default();
    let prev_provider = sec
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("openai")
        .to_string();
    let prev_explicit_base = sec
        .get("base_url")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end_matches('/').to_string());
    if prev_provider != provider {
        // Provider switch: stored key/model/dim/base_url belong to the old one.
        sec.remove("api_key");
        sec.remove("model");
        sec.remove("dim");
        sec.remove("base_url");
    } else if let Some(requested) = &base_url {
        // Key ↔ endpoint binding (docs "Settings over RPC"): a changed
        // effective base URL drops the stored key unless this write brings a
        // new one. Compare against what the section actually resolves to —
        // explicit value or the provider preset.
        let effective_prev = prev_explicit_base
            .clone()
            .or_else(|| preset_base_url(&prev_provider).map(str::to_string));
        if effective_prev.as_deref() != Some(requested.as_str()) {
            sec.remove("api_key");
        }
    }
    sec.insert("provider".into(), toml::Value::String(provider.to_string()));
    if let Some(k) = api_key.map(str::trim).filter(|s| !s.is_empty()) {
        sec.insert("api_key".into(), toml::Value::String(k.to_string()));
    }
    match model.map(str::trim) {
        Some("") => {
            sec.remove("model");
        }
        Some(m) => {
            sec.insert("model".into(), toml::Value::String(m.to_string()));
        }
        None => {}
    }
    if let Some(u) = base_url {
        sec.insert("base_url".into(), toml::Value::String(u));
    }
    if section == "embedding" {
        if let Some(d) = dim {
            if d > 0 {
                sec.insert("dim".into(), toml::Value::Integer(d as i64));
            } else {
                sec.remove("dim");
            }
        }
    }
    tbl.insert(section.into(), toml::Value::Table(sec));
    write_table_migrating(&tbl)
}

/// Persist a raw config table: `$HOMEKB_CONFIG` or the `~/.homekb/config.toml`
/// anchor; a legacy file is renamed to `config.toml.migrated` after a
/// successful write (same semantics as `Config::save`).
fn write_table_migrating(tbl: &toml::Table) -> Result<()> {
    let path = write_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let body = toml::to_string_pretty(tbl).context("serialize config")?;
    fs::write(
        &path,
        format!("# homekb configuration — see docs/ARCHITECTURE.md\n{body}"),
    )
    .with_context(|| format!("write {}", path.display()))?;
    let env_override = std::env::var("HOMEKB_CONFIG")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !env_override {
        if let Ok(legacy) = legacy_config_path() {
            if legacy.is_file() && legacy != path {
                let _ = fs::rename(&legacy, legacy.with_extension("toml.migrated"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};
    use std::sync::atomic::{AtomicU32, Ordering};

    // Serialize env-mutating tests (HOMEKB_CONFIG is process-global). Nothing
    // else in this test binary reads HOMEKB_CONFIG (config.rs unit tests and
    // the integration tests construct Config structs directly).
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    static SEQ: AtomicU32 = AtomicU32::new(0);

    struct TestDir(PathBuf);
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn with_temp_config(initial: &str) -> (MutexGuard<'static, ()>, TestDir) {
        let guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "homekb-config-edit-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test dir");
        let path = dir.join("config.toml");
        std::fs::write(&path, initial).expect("seed config");
        // SAFETY: guarded by ENV_LOCK — no concurrent env access in this binary.
        unsafe { std::env::set_var("HOMEKB_CONFIG", &path) };
        (guard, TestDir(dir))
    }

    fn stored(section: &str, key: &str) -> Option<String> {
        let raw = std::fs::read_to_string(std::env::var("HOMEKB_CONFIG").unwrap()).unwrap();
        let tbl: toml::Table = toml::from_str(&raw).unwrap();
        tbl.get(section)?
            .as_table()?
            .get(key)?
            .as_str()
            .map(str::to_string)
    }

    // Unconfigured means unconfigured (docs): `Config::save()` must NOT
    // materialize the default openai fill-ins into [embedding]/[summary] —
    // `register`/`init` save config long before the user picks a provider,
    // and a phantom section would flip `*_configured` to true on the next
    // load (the fresh-setup trap: the resident compile then stamps/embeds
    // with a credentials-less default).
    #[test]
    fn save_does_not_materialize_unconfigured_ai_sections() {
        let (_g, _dir) = with_temp_config("");

        let cfg = crate::config::Config::load().unwrap();
        assert!(!cfg.embedding_configured);
        assert!(!cfg.summary_configured);
        cfg.save().unwrap();

        let raw =
            std::fs::read_to_string(std::env::var("HOMEKB_CONFIG").unwrap()).unwrap();
        assert!(
            !raw.contains("[embedding]") && !raw.contains("[summary]"),
            "unconfigured AI sections must not be written, got:\n{raw}"
        );

        // Round-trip: still unconfigured after the save.
        let cfg2 = crate::config::Config::load().unwrap();
        assert!(!cfg2.embedding_configured);
        assert!(!cfg2.summary_configured);
    }

    #[test]
    fn same_endpoint_write_keeps_stored_key() {
        let (_g, _dir) = with_temp_config(
            "[embedding]\nprovider = \"openai\"\napi_key = \"sk-keep\"\n",
        );
        set_ai_endpoint("embedding", "openai", None, Some("text-embedding-3-large"), None, None)
            .expect("write");
        assert_eq!(stored("embedding", "api_key").as_deref(), Some("sk-keep"));
        assert_eq!(
            stored("embedding", "model").as_deref(),
            Some("text-embedding-3-large")
        );
    }

    #[test]
    fn provider_switch_drops_stored_key() {
        let (_g, _dir) = with_temp_config(
            "[embedding]\nprovider = \"openai\"\napi_key = \"sk-old\"\nmodel = \"text-embedding-3-small\"\n",
        );
        set_ai_endpoint("embedding", "gemini", None, None, None, None).expect("write");
        assert_eq!(stored("embedding", "api_key"), None);
        assert_eq!(stored("embedding", "model"), None);
    }

    // The exfiltration primitive this module exists to close: same provider,
    // redirected base URL, no new key → the stored key must NOT ride along.
    #[test]
    fn base_url_change_drops_stored_key() {
        let (_g, _dir) = with_temp_config(
            "[embedding]\nprovider = \"openai\"\napi_key = \"sk-secret\"\n",
        );
        set_ai_endpoint(
            "embedding",
            "openai",
            None,
            None,
            Some("https://evil.example.com/v1"),
            None,
        )
        .expect("write");
        assert_eq!(stored("embedding", "api_key"), None);
        assert_eq!(
            stored("embedding", "base_url").as_deref(),
            Some("https://evil.example.com/v1")
        );
    }

    #[test]
    fn base_url_change_with_new_key_keeps_new_key() {
        let (_g, _dir) = with_temp_config(
            "[summary]\nprovider = \"custom\"\napi_key = \"gw-old\"\nbase_url = \"https://a.example/v1\"\nmodel = \"m\"\n",
        );
        set_ai_endpoint(
            "summary",
            "custom",
            Some("gw-new"),
            Some("m"),
            Some("https://b.example/v1"),
            None,
        )
        .expect("write");
        assert_eq!(stored("summary", "api_key").as_deref(), Some("gw-new"));
    }

    // Writing the preset URL explicitly is the same effective endpoint — not a
    // redirect; the stored key survives.
    #[test]
    fn explicit_preset_base_url_is_not_a_change() {
        let (_g, _dir) = with_temp_config(
            "[embedding]\nprovider = \"openai\"\napi_key = \"sk-keep\"\n",
        );
        set_ai_endpoint(
            "embedding",
            "openai",
            None,
            None,
            Some("https://api.openai.com/v1"),
            None,
        )
        .expect("write");
        assert_eq!(stored("embedding", "api_key").as_deref(), Some("sk-keep"));
    }

    #[test]
    fn empty_ask_provider_deletes_section() {
        let (_g, _dir) = with_temp_config(
            "[ask]\nprovider = \"deepseek\"\napi_key = \"dk\"\n",
        );
        set_ai_endpoint("ask", "", None, None, None, None).expect("write");
        assert_eq!(stored("ask", "provider"), None);
        let summary = config_summary().expect("summary");
        assert!(!summary.ai.ask.configured);
    }

    #[test]
    fn summary_masks_keys_everywhere() {
        let (_g, _dir) = with_temp_config(
            "[embedding]\nprovider = \"openai\"\napi_key = \"sk-secret-abc\"\n[summary]\nprovider = \"gemini\"\napi_key = \"gm-secret\"\n",
        );
        let summary = config_summary().expect("summary");
        assert!(summary.ai.embedding.key_present);
        assert!(summary.ai.summary.key_present);
        let json = serde_json::to_string(&summary).expect("json");
        assert!(!json.contains("sk-secret-abc"), "key leaked: {json}");
        assert!(!json.contains("gm-secret"), "key leaked: {json}");
    }
}
