//! 引擎侧助手：二进制定位、config.toml 概要、serve 探活、CLI 调用。
//!
//! 桌面客户端是纯渲染器（docs/ARCHITECTURE.md「桌面客户端」）：这里只
//! 定位/调用 `homekb` CLI 和读写同机 config.toml，不实现任何引擎逻辑。
//! 路径默认值（root=~/.homekb、notes=<root>/notes）以文档的目录布局表为契约。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// 引擎二进制检测顺序：env HOMEKB_BIN > ~/.local/bin/homekb > 常见安装位。
/// （GUI 进程的 PATH 极简，不能依赖 `which`。）
pub fn engine_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HOMEKB_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let home = home_dir();
    let candidates = [
        home.join(".local/bin/homekb"),
        PathBuf::from("/usr/local/bin/homekb"),
        PathBuf::from("/opt/homebrew/bin/homekb"),
        home.join(".cargo/bin/homekb"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// 安装目标：~/.local/bin/homekb（文档契约）。
pub fn install_target() -> PathBuf {
    home_dir().join(".local/bin/homekb")
}

pub fn engine_version(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Some(s.trim().trim_start_matches("homekb").trim().to_string())
}

/// config.toml 路径：$HOMEKB_CONFIG > $XDG_CONFIG_HOME/homekb/config.toml
/// > ~/.config/homekb/config.toml（与引擎 config.rs 同序）。
pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("HOMEKB_CONFIG") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let xdg = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config"));
    xdg.join("homekb").join("config.toml")
}

fn expand_tilde(p: &str) -> PathBuf {
    let home = home_dir();
    if p == "~" {
        home
    } else if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(p)
    }
}

pub struct RelayInfo {
    pub url: String,
    pub home_id: String,
    pub name: String,
}

pub struct ConfigSummary {
    pub root: PathBuf,
    pub notes_dir: PathBuf,
    pub openai_key_present: bool,
    pub relay: Option<RelayInfo>,
}

/// 只读概要（渲染用）；写入只经 [`set_openai_key`] 或引擎 CLI。
pub fn read_config() -> ConfigSummary {
    let tbl: toml::Table = fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| toml::from_str(&raw).ok())
        .unwrap_or_default();

    let str_of = |k: &str| tbl.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty());

    let root = str_of("root")
        .map(expand_tilde)
        .unwrap_or_else(|| home_dir().join(".homekb"));
    let notes_dir = str_of("notes_dir")
        .map(expand_tilde)
        .unwrap_or_else(|| root.join("notes"));

    // key 是否可被引擎解析到：config 字段 或 ~/.config/openai/api_key 兜底
    // （env OPENAI_API_KEY 在 GUI 进程里通常不存在，不算）。
    let key_in_config = str_of("openai_api_key").is_some();
    let key_in_fallback = {
        let xdg = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"));
        fs::read_to_string(xdg.join("openai").join("api_key"))
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    };

    let relay = tbl.get("relay").and_then(|v| v.as_table()).and_then(|r| {
        let url = r.get("url")?.as_str().filter(|s| !s.is_empty())?.to_string();
        Some(RelayInfo {
            url,
            home_id: r.get("home_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            name: r.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        })
    });

    ConfigSummary {
        root,
        notes_dir,
        openai_key_present: key_in_config || key_in_fallback,
        relay,
    }
}

/// 写 openai_api_key：整表读改写（toml::Table 保留未知字段；注释不保留，
/// config 本就由 init/register 机器改写）。
pub fn set_openai_key(key: &str) -> Result<(), String> {
    let path = config_path();
    let mut tbl: toml::Table = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| toml::from_str(&raw).ok())
        .unwrap_or_default();
    tbl.insert("openai_api_key".into(), toml::Value::String(key.to_string()));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 {}: {e}", parent.display()))?;
    }
    let body = toml::to_string_pretty(&tbl).map_err(|e| format!("序列化配置失败: {e}"))?;
    fs::write(&path, format!("# homekb configuration — see docs/ARCHITECTURE.md\n{body}"))
        .map_err(|e| format!("写入 {}: {e}", path.display()))
}

/// serve 探活：GET /health，300ms 连接超时的裸 HTTP/1.1（省一个 http 客户端依赖）。
pub fn serve_health() -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 8765));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 64];
    let Ok(n) = stream.read(&mut buf) else { return false };
    String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200")
}

/// 跑一条引擎 CLI 子命令，成功返回 stdout；失败带 stderr 尾巴。
pub fn run_cli(bin: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("无法运行 {}: {e}", bin.display()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.trim().lines().rev().take(3).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        Err(if tail.is_empty() {
            format!("homekb {} 失败（{}）", args.join(" "), out.status)
        } else {
            tail.join("\n")
        })
    }
}

/// 子进程日志文件：~/Library/Logs/HomeKB/<name>.log（macOS 先行）。
pub fn log_file(name: &str) -> Result<fs::File, String> {
    let dir = home_dir().join("Library/Logs/HomeKB");
    fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录: {e}"))?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{name}.log")))
        .map_err(|e| format!("打开日志文件: {e}"))
}
