//! Dev-panel runtime aligned with tongyun-dev's scan and lifecycle contract.
//!
//! This is a Studio-owned subset. It does not embed the tongyun-dev CLI, the
//! :9099 console, or profile graphs.
//! Directory guesses are heuristics: one candidate per directory, text checks
//! instead of a full Maven/Gradle/package model.

use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

use crate::Result;

pub const DEFAULT_SCAN_DEPTH: usize = 3;
pub const MAX_SCAN_DEPTH: usize = 8;
pub const READY_TIMEOUT_SECS: u64 = 180;
pub const START_EXIT_GRACE_SECS: u64 = 3;
pub const LOG_TAIL_LINES: usize = 200;

const MAX_DIRS: usize = 4_000;
const MAX_CANDIDATES: usize = 100;
const MAX_TEXT: u64 = 1024 * 1024;

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "out",
    "bin",
    "obj",
    "__pycache__",
    "venv",
    "env",
    "site-packages",
    "coverage",
    "tmp",
    "logs",
];

const SOURCE_DIRS: &[&str] = &[
    "src",
    "public",
    "static",
    "assets",
    "resources",
    "test",
    "tests",
    "docs",
    "doc",
    "scripts",
    "config",
    "lib",
    "mock",
    "mocks",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifeState {
    Stopped,
    Starting,
    Installing,
    PortOpen,
    Ready,
    Failed,
    /// One-shot command exited 0. tongyun-dev has no equivalent; servers use Failed.
    Exited,
}

impl LifeState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Installing => "installing",
            Self::PortOpen => "port_open",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Exited => "exited",
        }
    }

    /// True only when the port is open or the probe is satisfied.
    /// A live process by itself is not reachable.
    pub fn reachable(self) -> bool {
        matches!(self, Self::Ready | Self::PortOpen)
    }
}

/// Inputs for the tongyun-dev readiness table.
#[derive(Debug, Clone, Default)]
pub struct StateInput {
    pub process_alive: bool,
    pub port_open: bool,
    pub port_conflict: bool,
    pub has_probe: bool,
    pub probe_ok: bool,
    pub started_at: Option<u64>,
    pub now: u64,
    pub timeout_secs: u64,
    pub start_error: Option<String>,
    pub installing: bool,
}

pub fn derive_state(input: StateInput) -> (LifeState, Option<String>) {
    if let Some(err) = input.start_error {
        return (LifeState::Failed, Some(err));
    }
    if input.installing {
        return (LifeState::Installing, None);
    }
    let effective_port_open = input.port_open && !input.port_conflict;
    if effective_port_open && (!input.has_probe || input.probe_ok) {
        return (LifeState::Ready, None);
    }
    if let Some(started_at) = input.started_at {
        let elapsed = input.now.saturating_sub(started_at);
        if !input.process_alive && elapsed >= START_EXIT_GRACE_SECS {
            return (LifeState::Failed, Some("进程已退出".into()));
        }
        if elapsed >= input.timeout_secs {
            return (
                LifeState::Failed,
                Some(format!("超过 {} 秒仍未就绪", input.timeout_secs)),
            );
        }
        if effective_port_open {
            return (LifeState::PortOpen, None);
        }
        return (LifeState::Starting, None);
    }
    if effective_port_open && input.has_probe && !input.probe_ok {
        return (LifeState::PortOpen, None);
    }
    if input.process_alive && !effective_port_open {
        return (LifeState::Starting, None);
    }
    (LifeState::Stopped, None)
}

pub const DEPS_MISSING_MSG: &str = "依赖未安装（缺 node_modules）";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageManager {
    Pnpm,
    Yarn,
    Npm,
}

impl PackageManager {
    pub fn install_command(self) -> &'static str {
        match self {
            Self::Pnpm => "pnpm install",
            Self::Yarn => "yarn install",
            Self::Npm => "npm install",
        }
    }
}

pub fn detect_package_manager(root: &Path) -> Option<PackageManager> {
    if !root.join("package.json").is_file() {
        return None;
    }
    if root.join("pnpm-lock.yaml").is_file() {
        Some(PackageManager::Pnpm)
    } else if root.join("yarn.lock").is_file() {
        Some(PackageManager::Yarn)
    } else {
        Some(PackageManager::Npm)
    }
}

pub fn node_deps_missing(root: &Path) -> bool {
    root.join("package.json").is_file() && !root.join("node_modules").is_dir()
}

pub fn deps_missing(root: &Path) -> bool {
    node_deps_missing(root)
}

pub fn maven_install_command(root: &Path) -> String {
    if root.join("mvnw").is_file() {
        "./mvnw dependency:resolve".to_string()
    } else {
        "mvn dependency:resolve".to_string()
    }
}

pub fn gradle_install_command(root: &Path) -> String {
    if root.join("gradlew").is_file() {
        "./gradlew dependencies".to_string()
    } else {
        "gradle dependencies".to_string()
    }
}

pub fn detect_install_command(root: &Path, _dev: Option<&DevProfile>) -> Option<String> {
    if root.join("package.json").is_file() {
        return detect_package_manager(root).map(|pm| pm.install_command().to_string());
    }
    if root.join("pom.xml").is_file() {
        return Some(maven_install_command(root));
    }
    if root.join("build.gradle").is_file() || root.join("build.gradle.kts").is_file() {
        return Some(gradle_install_command(root));
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnvPreset {
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_url: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub env: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DevProfile {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_url: Option<String>,
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    #[serde(default, alias = "depends_on", skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    #[serde(
        default,
        alias = "ready_timeout_secs",
        skip_serializing_if = "Option::is_none"
    )]
    pub ready_timeout_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub java: Option<String>,
    #[serde(default, alias = "java_home", skip_serializing_if = "Option::is_none")]
    pub java_home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(default, alias = "node_home", skip_serializing_if = "Option::is_none")]
    pub node_home: Option<String>,
    #[serde(default, alias = "catalina_home", alias = "tomcat", skip_serializing_if = "Option::is_none")]
    pub catalina_home: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(
        default,
        alias = "default_profile",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_profile: Option<String>,
    #[serde(
        default,
        alias = "selected_profile",
        skip_serializing_if = "Option::is_none"
    )]
    pub selected_profile: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub profiles: std::collections::BTreeMap<String, EnvPreset>,
    #[serde(
        default,
        alias = "auto_install",
        skip_serializing_if = "Option::is_none"
    )]
    pub auto_install: Option<bool>,
    #[serde(
        default,
        alias = "pull_deps_first",
        skip_serializing_if = "Option::is_none"
    )]
    pub pull_deps_first: Option<bool>,
    #[serde(
        default,
        alias = "deps_installed",
        skip_serializing_if = "Option::is_none"
    )]
    pub deps_installed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevCandidate {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub label: String,
    pub confidence: String,
    pub command: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub port_guessed: bool,
    #[serde(default)]
    pub health_url: Option<String>,
    #[serde(default)]
    pub why: Vec<String>,
    #[serde(default)]
    pub already_registered: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing_project_id: Option<String>,
    #[serde(default)]
    pub existing_has_dev: bool,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default, alias = "depends_on", skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub java: Option<String>,
    #[serde(default, alias = "java_home", skip_serializing_if = "Option::is_none")]
    pub java_home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(default, alias = "node_home", skip_serializing_if = "Option::is_none")]
    pub node_home: Option<String>,
    #[serde(default, alias = "catalina_home", alias = "tomcat", skip_serializing_if = "Option::is_none")]
    pub catalina_home: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(
        default,
        alias = "default_profile",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_profile: Option<String>,
    #[serde(
        default,
        alias = "selected_profile",
        skip_serializing_if = "Option::is_none"
    )]
    pub selected_profile: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub profiles: std::collections::BTreeMap<String, EnvPreset>,
    #[serde(
        default,
        alias = "auto_install",
        skip_serializing_if = "Option::is_none"
    )]
    pub auto_install: Option<bool>,
    #[serde(
        default,
        alias = "pull_deps_first",
        skip_serializing_if = "Option::is_none"
    )]
    pub pull_deps_first: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevScanReport {
    pub root: String,
    pub depth: usize,
    pub dirs_visited: usize,
    pub truncated: bool,
    pub candidates: Vec<DevCandidate>,
}

#[derive(Debug, Clone)]
pub struct ExistingProject {
    pub id: String,
    pub path: String,
    pub has_dev: bool,
}

#[derive(Debug, Clone)]
pub struct PreparedImport {
    pub path: String,
    pub name: String,
    pub profile: DevProfile,
}

pub fn valid_group_key(value: &str) -> bool {
    let len = value.chars().count();
    (1..=40).contains(&len)
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

pub fn scan_dev_directory(
    root: &Path,
    depth: usize,
    existing: &[ExistingProject],
) -> Result<DevScanReport> {
    let root = fs::canonicalize(root).map_err(|e| format!("无法访问目录：{e}"))?;
    if !root.is_dir() {
        return Err("请选择一个目录".into());
    }
    let root_text = path_text(&root)?;
    let depth = depth.min(MAX_SCAN_DEPTH);
    let known = existing
        .iter()
        .filter_map(|item| {
            let canonical = fs::canonicalize(&item.path).ok()?;
            Some((canonical, item.id.clone(), item.has_dev))
        })
        .collect::<Vec<_>>();

    let mut candidates = Vec::new();
    let mut truncated = false;
    let mut visited = 0usize;
    let mut seen = HashSet::new();
    let mut stack = vec![(root.clone(), 0usize, false)];
    while let Some((dir, level, inside_project)) = stack.pop() {
        if visited >= MAX_DIRS || candidates.len() >= MAX_CANDIDATES {
            truncated = true;
            break;
        }
        let seen_key = fs::canonicalize(&dir).unwrap_or(dir.clone());
        if !seen.insert(seen_key) {
            continue;
        }
        visited += 1;
        let hit = inspect_dir(&dir);
        let is_project = hit.candidate.is_some();
        if let Some(mut candidate) = hit.candidate {
            if let Some(canonical) = fs::canonicalize(&dir)
                .ok()
                .and_then(|path| path_text(&path).ok())
            {
                candidate.path = canonical.clone();
                if let Some((_, id, has_dev)) = known
                    .iter()
                    .find(|(path, _, _)| path.to_string_lossy().as_ref() == canonical)
                {
                    candidate.already_registered = true;
                    candidate.existing_project_id = Some(id.clone());
                    candidate.existing_has_dev = *has_dev;
                }
                candidate.group = group_key(&root, Path::new(&canonical));
                candidates.push(candidate);
            }
        }
        if level >= depth {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut children = Vec::new();
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') || SKIP_DIRS.contains(&name) {
                continue;
            }
            if (is_project || inside_project) && !hit.container && SOURCE_DIRS.contains(&name) {
                continue;
            }
            children.push(entry.path());
        }
        children.sort();
        for child in children.into_iter().rev() {
            stack.push((child, level + 1, is_project || inside_project));
        }
    }
    candidates.sort_by(|a, b| a.path.cmp(&b.path).then(a.kind.cmp(&b.kind)));
    Ok(DevScanReport {
        root: root_text,
        depth,
        dirs_visited: visited,
        truncated,
        candidates,
    })
}

pub fn prepare_import(candidate: &DevCandidate) -> Result<PreparedImport> {
    let path = fs::canonicalize(candidate.path.trim()).map_err(|e| format!("无法访问目录：{e}"))?;
    if !path.is_dir() {
        return Err("请选择一个目录".into());
    }
    let path = path_text(&path)?;
    let name = sanitize_name(if candidate.name.trim().is_empty() {
        Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".into())
    } else {
        candidate.name.trim().to_owned()
    })?;
    let command = candidate.command.trim().to_owned();
    if command.len() > 8192 || command.contains('\0') {
        return Err("启动命令过长或包含无效字符。".into());
    }
    let port = match candidate.port {
        Some(0) | None => None,
        Some(port) => Some(port),
    };
    let health_url = match candidate
        .health_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some(url) => {
            if parse_loopback_http(url).is_none() {
                return Err("健康检查只接受 http://127.0.0.1 或 http://localhost。".into());
            }
            Some(url.to_owned())
        }
    };
    let kind = bounded_token(&candidate.kind, "类型")?;
    let label = bounded_token(&candidate.label, "类型名称")?;
    let group = match candidate
        .group
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some(group) if valid_group_key(group) => Some(group.to_owned()),
        Some(_) => {
            return Err("分组标识只能用小写字母、数字、下划线和短横线，最长 40 个字符。".into())
        }
    };
    let confidence = match candidate.confidence.trim() {
        "" => None,
        value @ ("high" | "medium" | "low") => Some(value.to_owned()),
        _ => return Err("把握只能是 high、medium 或 low。".into()),
    };
    Ok(PreparedImport {
        path,
        name,
        profile: DevProfile {
            command,
            port,
            health_url,
            kind,
            label,
            group,
            confidence,
            depends_on: candidate.depends_on.clone(),
            ready_timeout_secs: None,
            java: candidate.java.clone(),
            java_home: candidate.java_home.clone(),
            node: candidate.node.clone(),
            node_home: candidate.node_home.clone(),
            catalina_home: candidate.catalina_home.clone(),
            env: candidate.env.clone(),
            default_profile: candidate.default_profile.clone(),
            selected_profile: candidate.selected_profile.clone(),
            profiles: candidate.profiles.clone(),
            auto_install: candidate.auto_install,
            pull_deps_first: candidate.pull_deps_first,
            deps_installed: None,
        },
    })
}

pub fn tail_lines(stdout: &str, stderr: &str, max_lines: usize) -> String {
    let max_lines = max_lines.max(1);
    let mut lines = Vec::new();
    lines.extend(stdout.lines());
    if !stderr.is_empty() {
        if !lines.is_empty() {
            lines.push("--- stderr ---");
        }
        lines.extend(stderr.lines());
    }
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

pub fn parse_loopback_http(url: &str) -> Option<(u16, String)> {
    let rest = url.trim().strip_prefix("http://")?;
    if rest.contains('@') || rest.contains('\\') {
        return None;
    }
    let (hostport, path) = match rest.split_once('/') {
        Some((hostport, path)) => (hostport, format!("/{path}")),
        None => (rest, "/".into()),
    };
    let path = path.split('#').next().unwrap_or("/").to_owned();
    if path.is_empty()
        || !path.starts_with('/')
        || path.chars().any(|c| c.is_ascii_control() || c == ' ')
    {
        return None;
    }
    let (host, port) = hostport.rsplit_once(':')?;
    if host != "127.0.0.1" && host != "localhost" {
        return None;
    }
    let port = port.parse::<u16>().ok()?;
    if port == 0 {
        return None;
    }
    Some((port, path))
}

pub fn tcp_open(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok()
}

pub fn probe_loopback(url: &str) -> bool {
    let Some((port, path)) = parse_loopback_http(url) else {
        return false;
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(200)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    let request = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    let Ok(size) = stream.read(&mut buf) else {
        return false;
    };
    if size == 0 {
        return false;
    }
    let text = String::from_utf8_lossy(&buf[..size]);
    let mut parts = text.split_whitespace();
    let version = parts.next().unwrap_or("");
    let code = parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    version.starts_with("HTTP/") && (200..300).contains(&code)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortOccupant {
    pub pid: u32,
    pub name: String,
}

#[cfg(windows)]
pub fn listener_pids(port: u16) -> Vec<u32> {
    if port == 0 {
        return Vec::new();
    }
    let mut pids = Vec::new();
    if let Ok(out) = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let port_suffix = format!(":{port}");
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 5
                    && parts[0].eq_ignore_ascii_case("TCP")
                    && parts[3].eq_ignore_ascii_case("LISTENING")
                {
                    let local_addr = parts[1];
                    if local_addr.ends_with(&port_suffix) {
                        let local_port_str = local_addr.rsplit(':').next().unwrap_or("");
                        if let Ok(p) = local_port_str.parse::<u16>() {
                            if p == port {
                                if let Ok(pid) = parts[4].parse::<u32>() {
                                    if pid > 0 && !pids.contains(&pid) {
                                        pids.push(pid);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // Fallback: powershell Get-NetTCPConnection
    if pids.is_empty() {
        if let Ok(out) = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    if let Ok(pid) = line.trim().parse::<u32>() {
                        if pid > 0 && !pids.contains(&pid) {
                            pids.push(pid);
                        }
                    }
                }
            }
        }
    }
    pids.sort_unstable();
    pids
}

#[cfg(windows)]
pub fn process_name_of(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    if let Ok(out) = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(first) = text.lines().next() {
                let trimmed = first.trim();
                if trimmed.starts_with('"') {
                    let name = trimmed.split(',').next().unwrap_or("").trim_matches('"').trim();
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }
    // Fallback: powershell Get-Process
    if let Ok(out) = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("(Get-Process -Id {pid} -ErrorAction SilentlyContinue).ProcessName"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        if out.status.success() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

#[cfg(not(windows))]
pub fn listener_pids(port: u16) -> Vec<u32> {
    if port == 0 {
        return Vec::new();
    }
    for bin in &["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"] {
        if let Ok(out) = Command::new(bin)
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                let mut pids = Vec::new();
                for line in text.lines() {
                    if let Ok(pid) = line.trim().parse::<u32>() {
                        if pid > 0 && !pids.contains(&pid) {
                            pids.push(pid);
                        }
                    }
                }
                if !pids.is_empty() {
                    pids.sort_unstable();
                    return pids;
                }
            }
        }
    }
    // Fallback to ss on Linux if lsof is absent or empty
    if let Ok(out_ss) = Command::new("ss")
        .args(["-H", "-t", "-l", "-n", "-p", &format!("sport = :{port}")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        if out_ss.status.success() {
            let text = String::from_utf8_lossy(&out_ss.stdout);
            let mut pids = Vec::new();
            for line in text.lines() {
                let mut rest = line;
                while let Some(idx) = rest.find("pid=") {
                    rest = &rest[idx + 4..];
                    let pid_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        if pid > 0 && !pids.contains(&pid) {
                            pids.push(pid);
                        }
                    }
                }
            }
            if !pids.is_empty() {
                pids.sort_unstable();
                return pids;
            }
        }
    }
    Vec::new()
}

#[cfg(not(windows))]
pub fn process_name_of(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
            let trimmed = comm.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    if let Ok(out) = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let comm = text.trim();
            if !comm.is_empty() {
                let short = comm.rsplit('/').next().unwrap_or(comm).trim();
                if !short.is_empty() {
                    return Some(short.to_string());
                }
            }
        }
    }
    None
}

pub fn port_occupants(port: u16) -> Vec<PortOccupant> {
    if port == 0 {
        return Vec::new();
    }
    let pids = listener_pids(port);
    let mut occupants = Vec::new();
    for pid in pids {
        let name = process_name_of(pid).unwrap_or_default();
        occupants.push(PortOccupant { pid, name });
    }
    occupants
}

pub fn format_port_occupied_error(port: u16, occupants: &[PortOccupant]) -> String {
    if occupants.is_empty() {
        format!("端口 {port} 已有进程监听，未启动。")
    } else {
        let details = occupants
            .iter()
            .map(|o| {
                if o.name.is_empty() {
                    format!("PID {}", o.pid)
                } else {
                    format!("{} (PID {})", o.name, o.pid)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("端口 {port} 已有进程监听（{details}），未启动。")
    }
}

pub fn port_occupied_error(port: u16) -> String {
    let occupants = port_occupants(port);
    format_port_occupied_error(port, &occupants)
}


struct DirHit {
    container: bool,
    candidate: Option<DevCandidate>,
}

fn inspect_dir(dir: &Path) -> DirHit {
    let mut hit = DirHit {
        container: false,
        candidate: None,
    };
    if let Some(maven) = inspect_maven(dir) {
        hit.container |= maven.container;
        hit.candidate = maven.candidate;
    }
    if hit.candidate.is_none() {
        if let Some(gradle) = inspect_gradle(dir) {
            hit.container |= gradle.container;
            hit.candidate = gradle.candidate;
        }
    }
    if hit.candidate.is_none() {
        if let Some(node) = inspect_node(dir) {
            hit.container |= node.container;
            hit.candidate = node.candidate;
        }
    }
    if hit.candidate.is_none() && !hit.container {
        if let Some(candidate) = inspect_python(dir) {
            hit.candidate = Some(candidate);
        }
    }
    hit
}

fn inspect_maven(dir: &Path) -> Option<DirHit> {
    let pom = read_limited(&dir.join("pom.xml"), MAX_TEXT)?;
    let modules = pom.contains("<modules>");
    let spring = pom.contains("spring-boot");
    let packaging = xml_packaging(&pom);
    if modules && !spring {
        return Some(DirHit {
            container: true,
            candidate: None,
        });
    }
    if spring {
        let wrapper = dir.join("mvnw").is_file();
        let command = if wrapper {
            "./mvnw spring-boot:run"
        } else {
            "mvn spring-boot:run"
        };
        let (port, guessed) = spring_port(dir)
            .map(|port| (port, false))
            .unwrap_or((8080, true));
        let mut why = vec!["pom.xml 含有 spring-boot".into()];
        if wrapper {
            why.push("启动命令使用 mvnw。".into());
        }
        if guessed {
            why.push("没有读到 server.port，暂用 8080。".into());
        } else {
            why.push(format!("端口来自 application 配置：{port}。"));
        }
        let mut cand = candidate(
            dir,
            "spring-boot-maven",
            "Spring Boot（Maven）",
            "high",
            command,
            Some(port),
            guessed,
            why,
        );
        let profiles = suggest_spring_profiles(dir);
        if !profiles.is_empty() {
            if profiles.contains_key("dev") {
                cand.default_profile = Some("dev".into());
                cand.why.push("检测到 Spring 环境预设：默认 dev。".into());
            } else if let Some(first) = profiles.keys().next() {
                cand.default_profile = Some(first.clone());
                cand.why.push("检测到 Spring 环境预设。".into());
            }
            cand.profiles = profiles;
        }
        if let Some(jv) = pom_java_version(&pom) {
            cand.why.push(format!("Java 版本要求：{jv}。"));
            cand.java = Some(jv);
        }
        cand.auto_install = Some(true);
        cand.pull_deps_first = Some(false);
        return Some(DirHit {
            container: modules,
            candidate: Some(cand),
        });
    }
    if packaging.as_deref() == Some("war") {
        let wrapper = dir.join("mvnw").is_file();
        let mvn = if wrapper { "./mvnw" } else { "mvn" };
        let war_name = xml_artifact_id(&pom).unwrap_or_else(|| {
            dir.file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "app".into())
        });
        let command = format!(
            "{mvn} -q -DskipTests package && cp target/*.war \"$CATALINA_HOME/webapps/{war_name}.war\" && exec \"$CATALINA_HOME/bin/catalina.sh\" run"
        );
        let mut why = vec![
            "pom.xml packaging 是 war。".into(),
            "可配置 CATALINA_HOME，按 catalina run 启停并部署 WAR。".into(),
        ];
        if wrapper {
            why.push("启动命令使用 mvnw。".into());
        }
        let mut cand = candidate(
            dir,
            "tomcat-war",
            "Tomcat WAR",
            "medium",
            &command,
            Some(8080),
            true,
            why,
        );
        if let Ok(ch) = std::env::var("CATALINA_HOME") {
            if !ch.trim().is_empty() {
                cand.catalina_home = Some(ch);
                cand.confidence = "high".into();
                cand.why.push("检测到环境变量 CATALINA_HOME。".into());
            }
        }
        if let Some(jv) = pom_java_version(&pom) {
            cand.why.push(format!("Java 版本要求：{jv}。"));
            cand.java = Some(jv);
        }
        return Some(DirHit {
            container: false,
            candidate: Some(cand),
        });
    }
    None
}

fn inspect_gradle(dir: &Path) -> Option<DirHit> {
    let build = read_limited(&dir.join("build.gradle"), MAX_TEXT)
        .or_else(|| read_limited(&dir.join("build.gradle.kts"), MAX_TEXT));
    let settings = read_limited(&dir.join("settings.gradle"), 256 * 1024)
        .or_else(|| read_limited(&dir.join("settings.gradle.kts"), 256 * 1024));
    let spring = build.as_ref().is_some_and(|text| {
        text.contains("org.springframework.boot") || text.contains("spring-boot")
    });
    let multi = settings.as_ref().is_some_and(|text| {
        text.lines().any(|line| {
            let trimmed = line.trim();
            trimmed.starts_with("include ") || trimmed.starts_with("include(")
        })
    });
    if multi && !spring {
        return Some(DirHit {
            container: true,
            candidate: None,
        });
    }
    if spring {
        let wrapper = dir.join("gradlew").is_file();
        let command = if wrapper {
            "./gradlew bootRun"
        } else {
            "gradle bootRun"
        };
        let (port, guessed) = spring_port(dir)
            .map(|port| (port, false))
            .unwrap_or((8080, true));
        let mut why = vec!["Gradle 构建使用了 Spring Boot 插件。".into()];
        if guessed {
            why.push("没有读到 server.port，暂用 8080。".into());
        } else {
            why.push(format!("端口来自 application 配置：{port}。"));
        }
        let mut cand = candidate(
            dir,
            "spring-boot-gradle",
            "Spring Boot（Gradle）",
            "high",
            command,
            Some(port),
            guessed,
            why,
        );
        let profiles = suggest_spring_profiles(dir);
        if !profiles.is_empty() {
            if profiles.contains_key("dev") {
                cand.default_profile = Some("dev".into());
                cand.why.push("检测到 Spring 环境预设：默认 dev。".into());
            } else if let Some(first) = profiles.keys().next() {
                cand.default_profile = Some(first.clone());
                cand.why.push("检测到 Spring 环境预设。".into());
            }
            cand.profiles = profiles;
        }
        cand.auto_install = Some(true);
        cand.pull_deps_first = Some(false);
        return Some(DirHit {
            container: multi,
            candidate: Some(cand),
        });
    }
    None
}

fn inspect_node(dir: &Path) -> Option<DirHit> {
    let text = read_limited(&dir.join("package.json"), MAX_TEXT)?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    if is_workspace_root(&value) {
        return Some(DirHit {
            container: true,
            candidate: None,
        });
    }
    let deps = dependency_names(&value);
    let scripts = value.get("scripts").and_then(|item| item.as_object());
    let mut picked: Option<(&str, &str, &str, &str)> = None;
    for (dep, kind, label, script) in [
        ("next", "next", "Next.js", "dev"),
        ("nuxt", "nuxt", "Nuxt", "dev"),
        ("vite", "vite", "Vite", "dev"),
        ("@vue/cli-service", "vue-cli", "Vue CLI", "serve"),
        ("react-scripts", "cra", "React（CRA）", "start"),
    ] {
        if deps.iter().any(|name| name == dep) {
            picked = Some((kind, label, script, "high"));
            break;
        }
    }
    let (kind, label, script, mut confidence) = if let Some(picked) = picked {
        picked
    } else if scripts.is_some_and(|map| map.contains_key("dev")) {
        ("node", "Node", "dev", "low")
    } else if scripts.is_some_and(|map| map.contains_key("start")) {
        ("node", "Node", "start", "low")
    } else {
        return None;
    };
    if kind == "cra" {
        confidence = "medium";
    }
    let script_body = scripts
        .and_then(|map| map.get(script))
        .and_then(|item| item.as_str())
        .unwrap_or("");
    if script_body.is_empty() && confidence == "high" {
        confidence = "medium";
    }
    let command = script_command(dir, &value, script);
    let mut why = vec![format!("package.json 识别为 {label}。")];
    why.push(format!(
        "启动命令按锁文件或 packageManager 选用 {command}。"
    ));
    let (port, guessed) = if let Some(port) = port_flag(script_body) {
        why.push(format!("端口来自脚本参数 {port}。"));
        (Some(port), false)
    } else if let Some(port) = node_config_port(dir, kind) {
        why.push(format!("端口来自配置文件 {port}。"));
        (Some(port), false)
    } else if let Some(port) = default_node_port(kind) {
        why.push(format!("没有写明端口，暂用框架默认 {port}。"));
        (Some(port), true)
    } else {
        why.push("没有写明端口，启动后不会把进程存活当成就绪。".into());
        (None, false)
    };
    let mut cand = candidate(dir, kind, label, confidence, &command, port, guessed, why);
    cand.auto_install = Some(true);
    if node_deps_missing(dir) {
        cand.why
            .push("缺少 node_modules，启动前将自动检测并安装依赖。".into());
    }
    if let Some(nv) = node_version_from_package(&value) {
        cand.why.push(format!("Node 版本要求：{nv}。"));
        cand.node = Some(nv);
    }
    Some(DirHit {
        container: false,
        candidate: Some(cand),
    })
}

fn inspect_python(dir: &Path) -> Option<DevCandidate> {
    let python = if dir.join(".venv/bin/python").is_file() {
        "./.venv/bin/python"
    } else {
        "python3"
    };
    if dir.join("manage.py").is_file() {
        return Some(candidate(
            dir,
            "django",
            "Django",
            "high",
            &format!("{python} manage.py runserver 127.0.0.1:8000"),
            Some(8000),
            true,
            vec!["发现 manage.py。端口暂用 Django 默认 8000。".into()],
        ));
    }
    let deps = read_limited(&dir.join("requirements.txt"), 256 * 1024)
        .or_else(|| read_limited(&dir.join("pyproject.toml"), MAX_TEXT))
        .unwrap_or_default();
    let lower = deps.to_ascii_lowercase();
    if lower.contains("fastapi") {
        let module = if dir.join("main.py").is_file() {
            "main:app"
        } else if dir.join("app.py").is_file() {
            "app:app"
        } else {
            ""
        };
        if module.is_empty() {
            return Some(candidate(
                dir,
                "fastapi",
                "FastAPI",
                "low",
                "",
                Some(8000),
                true,
                vec!["依赖里有 fastapi，但没有 main.py 或 app.py，需要自己写启动命令。".into()],
            ));
        }
        return Some(candidate(
            dir,
            "fastapi",
            "FastAPI",
            "medium",
            &format!("{python} -m uvicorn {module} --host 127.0.0.1 --port 8000"),
            Some(8000),
            true,
            vec![format!(
                "依赖里有 fastapi，应用模块按 {module} 猜测，端口暂用 8000。"
            )],
        ));
    }
    if dep_word(&lower, "flask") {
        return Some(candidate(
            dir,
            "flask",
            "Flask",
            "medium",
            &format!("{python} -m flask --app app run --host 127.0.0.1 --port 5000"),
            Some(5000),
            true,
            vec!["依赖里有 flask。应用名按 app 猜测，端口暂用 5000。".into()],
        ));
    }
    None
}

fn candidate(
    dir: &Path,
    kind: &str,
    label: &str,
    confidence: &str,
    command: &str,
    port: Option<u16>,
    port_guessed: bool,
    why: Vec<String>,
) -> DevCandidate {
    DevCandidate {
        name: dir
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".into()),
        path: dir.to_string_lossy().into_owned(),
        kind: kind.into(),
        label: label.into(),
        confidence: confidence.into(),
        command: command.into(),
        port,
        port_guessed,
        health_url: None,
        why,
        already_registered: false,
        existing_project_id: None,
        existing_has_dev: false,
        group: None,
        depends_on: Vec::new(),
        java: None,
        java_home: None,
        node: None,
        node_home: None,
        catalina_home: None,
        env: BTreeMap::new(),
        default_profile: None,
        selected_profile: None,
        profiles: BTreeMap::new(),
        auto_install: Some(true),
        pull_deps_first: Some(false),
    }
}

fn dependency_names(value: &serde_json::Value) -> Vec<String> {
    ["dependencies", "devDependencies"]
        .into_iter()
        .flat_map(|key| {
            value
                .get(key)
                .and_then(|item| item.as_object())
                .map(|map| map.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        })
        .collect()
}

fn is_workspace_root(value: &serde_json::Value) -> bool {
    match value.get("workspaces") {
        Some(serde_json::Value::Array(items)) => !items.is_empty(),
        Some(serde_json::Value::Object(map)) => map
            .get("packages")
            .and_then(|item| item.as_array())
            .is_some_and(|items| !items.is_empty()),
        _ => false,
    }
}

fn script_command(dir: &Path, package: &serde_json::Value, script: &str) -> String {
    let manager = package_manager(dir, package);
    match (manager, script) {
        ("pnpm", script) => format!("pnpm {script}"),
        ("yarn", script) => format!("yarn {script}"),
        ("npm", "start") => "npm start".into(),
        ("npm", script) => format!("npm run {script}"),
        _ => format!("npm run {script}"),
    }
}

fn package_manager(dir: &Path, package: &serde_json::Value) -> &'static str {
    if let Some(spec) = package.get("packageManager").and_then(|item| item.as_str()) {
        if spec.starts_with("pnpm") {
            return "pnpm";
        }
        if spec.starts_with("yarn") {
            return "yarn";
        }
        if spec.starts_with("npm") {
            return "npm";
        }
    }
    if dir.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if dir.join("yarn.lock").is_file() {
        "yarn"
    } else {
        "npm"
    }
}

fn default_node_port(kind: &str) -> Option<u16> {
    match kind {
        "vite" => Some(5173),
        "vue-cli" => Some(8080),
        "next" | "nuxt" => Some(3000),
        _ => None,
    }
}

fn node_config_port(dir: &Path, kind: &str) -> Option<u16> {
    let files: &[&str] = match kind {
        "vite" => &[
            "vite.config.ts",
            "vite.config.js",
            "vite.config.mjs",
            "vite.config.cjs",
            "vite.config.mts",
        ],
        "vue-cli" => &["vue.config.js", "vue.config.ts"],
        "nuxt" => &["nuxt.config.ts", "nuxt.config.js"],
        _ => &[],
    };
    for name in files {
        if let Some(text) = read_limited(&dir.join(name), 128 * 1024) {
            if let Some(port) = config_port(&text) {
                return Some(port);
            }
        }
    }
    None
}

fn config_port(text: &str) -> Option<u16> {
    for line in text.lines() {
        let trimmed = line.trim().trim_start_matches("//").trim();
        let rest = trimmed
            .strip_prefix("port")
            .or_else(|| trimmed.strip_prefix("\"port\""));
        let Some(rest) = rest else { continue };
        let rest = rest
            .trim()
            .trim_start_matches(':')
            .trim()
            .trim_matches(|c| c == ',' || c == '"' || c == '\'');
        if let Some(port) = parse_port(
            rest.split(|c: char| !c.is_ascii_digit())
                .next()
                .unwrap_or(""),
        ) {
            return Some(port);
        }
    }
    None
}

fn port_flag(script: &str) -> Option<u16> {
    let parts: Vec<&str> = script.split_whitespace().collect();
    for (index, part) in parts.iter().enumerate() {
        if let Some(value) = part.strip_prefix("--port=") {
            return parse_port(value);
        }
        if *part == "--port" || *part == "-p" {
            return parts.get(index + 1).copied().and_then(parse_port);
        }
    }
    None
}

fn spring_port(dir: &Path) -> Option<u16> {
    let resources = dir.join("src/main/resources");
    for name in [
        "application.properties",
        "application.yml",
        "application.yaml",
    ] {
        if let Some(text) = read_limited(&resources.join(name), 256 * 1024) {
            if let Some(port) = server_port(&text) {
                return Some(port);
            }
        }
    }
    None
}

fn server_port(text: &str) -> Option<u16> {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.starts_with('!') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("server.port") {
            let rest = rest.trim().trim_start_matches(['=', ':']).trim();
            if let Some(port) = parse_port(
                rest.split(|c: char| !c.is_ascii_digit())
                    .next()
                    .unwrap_or(""),
            ) {
                return Some(port);
            }
        }
    }
    let mut in_server = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            in_server = trimmed == "server:" || trimmed.starts_with("server:");
            continue;
        }
        if in_server {
            if let Some(rest) = trimmed.strip_prefix("port:") {
                if let Some(port) = parse_port(rest.trim().trim_matches(['"', '\''])) {
                    return Some(port);
                }
            }
        }
    }
    None
}


fn xml_tag<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    let val = text[start..end].trim();
    if val.is_empty() || val.contains('$') {
        None
    } else {
        Some(val)
    }
}

fn pom_own_section(pom: &str) -> String {
    let mut s = pom.to_string();
    for tag in [
        "parent",
        "dependencies",
        "dependencyManagement",
        "build",
        "profiles",
    ] {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        while let (Some(a), Some(b)) = (s.find(&open), s.find(&close)) {
            if b > a {
                s.replace_range(a..b + close.len(), "");
            } else {
                break;
            }
        }
    }
    s
}

fn xml_artifact_id(pom: &str) -> Option<String> {
    let own = pom_own_section(pom);
    xml_tag(&own, "artifactId").map(|s| s.to_string())
}

fn xml_packaging(pom: &str) -> Option<String> {
    let start = pom.find("<packaging>")?;
    let rest = &pom[start + "<packaging>".len()..];
    let end = rest.find("</packaging>")?;
    let value = rest[..end].trim().to_ascii_lowercase();
    if value.is_empty() || value.len() > 40 {
        None
    } else {
        Some(value)
    }
}

fn dep_word(text: &str, word: &str) -> bool {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|part| part == word)
}

fn parse_port(value: &str) -> Option<u16> {
    let port = value.trim().parse::<u16>().ok()?;
    if port == 0 {
        None
    } else {
        Some(port)
    }
}

fn group_key(root: &Path, candidate: &Path) -> Option<String> {
    let parent = candidate.parent()?;
    if parent == root {
        return None;
    }
    let name = parent.file_name()?.to_str()?;
    let slug = slug(name);
    if valid_group_key(&slug) {
        Some(slug)
    } else {
        None
    }
}

fn slug(value: &str) -> String {
    let mut out = String::new();
    let mut underscore = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            underscore = false;
        } else if !underscore && !out.is_empty() {
            out.push('_');
            underscore = true;
        }
        if out.len() >= 40 {
            break;
        }
    }
    out.trim_matches('_').to_owned()
}

fn read_limited(path: &Path, max: u64) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn path_text(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "目录路径不是有效的 Unicode".into())
}

fn sanitize_name(value: String) -> Result<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 120 || name.chars().any(|c| c.is_control()) {
        return Err("项目名称无效。".into());
    }
    Ok(name.to_owned())
}

fn bounded_token(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 || value.chars().any(|c| c.is_control()) {
        return Err(format!("{label}无效。"));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_port_occupied_error_handles_variants() {
        assert_eq!(
            format_port_occupied_error(8080, &[]),
            "端口 8080 已有进程监听，未启动。"
        );
        assert_eq!(
            format_port_occupied_error(8080, &[PortOccupant { pid: 1234, name: "node".into() }]),
            "端口 8080 已有进程监听（node (PID 1234)），未启动。"
        );
        assert_eq!(
            format_port_occupied_error(8080, &[PortOccupant { pid: 1234, name: String::new() }]),
            "端口 8080 已有进程监听（PID 1234），未启动。"
        );
        assert_eq!(
            format_port_occupied_error(
                8080,
                &[
                    PortOccupant { pid: 1234, name: "node".into() },
                    PortOccupant { pid: 5678, name: "java".into() },
                ]
            ),
            "端口 8080 已有进程监听（node (PID 1234), java (PID 5678)），未启动。"
        );
    }

    #[test]
    fn live_port_occupants_detects_tcp_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let occupants = port_occupants(port);
        let my_pid = std::process::id();
        assert!(
            occupants.iter().any(|o| o.pid == my_pid),
            "occupants for port {port} ({:?}) should contain current pid {my_pid}",
            occupants
        );
        let err = port_occupied_error(port);
        assert!(err.contains("已有进程监听"));
        assert!(err.contains(&port.to_string()));
        assert!(err.contains(&my_pid.to_string()));
        drop(listener);
    }


    fn input(overrides: StateInput) -> StateInput {
        overrides
    }

    fn base() -> StateInput {
        StateInput {
            process_alive: false,
            port_open: false,
            port_conflict: false,
            has_probe: false,
            probe_ok: false,
            started_at: None,
            now: 100,
            timeout_secs: 10,
            start_error: None,
            installing: false,
        }
    }

    #[test]
    fn lifecycle_table_matches_tongyun_dev_states() {
        let cases = [
            (
                StateInput {
                    installing: true,
                    ..base()
                },
                LifeState::Installing,
                None,
            ),
            (
                StateInput {
                    process_alive: true,
                    port_open: true,
                    has_probe: true,
                    probe_ok: true,
                    started_at: Some(100),
                    now: 105,
                    ..base()
                },
                LifeState::Ready,
                None,
            ),
            (
                StateInput {
                    process_alive: true,
                    port_open: true,
                    started_at: Some(100),
                    now: 105,
                    ..base()
                },
                LifeState::Ready,
                None,
            ),
            (
                StateInput {
                    process_alive: true,
                    port_open: true,
                    has_probe: true,
                    started_at: Some(100),
                    now: 105,
                    ..base()
                },
                LifeState::PortOpen,
                None,
            ),
            (
                StateInput {
                    process_alive: true,
                    started_at: Some(100),
                    now: 105,
                    ..base()
                },
                LifeState::Starting,
                None,
            ),
            (
                StateInput {
                    started_at: Some(100),
                    now: 105,
                    ..base()
                },
                LifeState::Failed,
                Some("进程已退出"),
            ),
            (
                StateInput {
                    process_alive: true,
                    started_at: Some(100),
                    now: 115,
                    ..base()
                },
                LifeState::Failed,
                Some("超过 10 秒仍未就绪"),
            ),
            (
                StateInput {
                    process_alive: true,
                    port_open: true,
                    port_conflict: true,
                    started_at: Some(100),
                    now: 105,
                    ..base()
                },
                LifeState::Starting,
                None,
            ),
            (
                StateInput {
                    started_at: Some(100),
                    now: 100,
                    start_error: Some("缺 Java 8".into()),
                    ..base()
                },
                LifeState::Failed,
                Some("缺 Java 8"),
            ),
            (base(), LifeState::Stopped, None),
            (
                StateInput {
                    port_open: true,
                    port_conflict: true,
                    ..base()
                },
                LifeState::Stopped,
                None,
            ),
            (
                StateInput {
                    process_alive: true,
                    port_open: true,
                    has_probe: true,
                    started_at: Some(100),
                    now: 115,
                    ..base()
                },
                LifeState::Failed,
                Some("超过 10 秒仍未就绪"),
            ),
            (
                StateInput {
                    process_alive: true,
                    ..base()
                },
                LifeState::Starting,
                None,
            ),
            (
                StateInput {
                    started_at: Some(100),
                    now: 100 + START_EXIT_GRACE_SECS - 1,
                    ..base()
                },
                LifeState::Starting,
                None,
            ),
            (
                StateInput {
                    started_at: Some(100),
                    now: 100 + START_EXIT_GRACE_SECS,
                    ..base()
                },
                LifeState::Failed,
                Some("进程已退出"),
            ),
        ];
        for (case, state, failure) in cases {
            let (got, why) = derive_state(input(case));
            assert_eq!(got, state);
            assert_eq!(why.as_deref(), failure);
            assert_eq!(
                got.reachable(),
                matches!(state, LifeState::Ready | LifeState::PortOpen)
            );
        }
    }

    #[test]
    fn tail_and_loopback_parser_are_bounded() {
        let stdout = (0..20)
            .map(|i| format!("out-{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let tail = tail_lines(&stdout, "err-1\nerr-2", 4);
        assert_eq!(tail, "out-19\n--- stderr ---\nerr-1\nerr-2");
        assert_eq!(
            parse_loopback_http("http://127.0.0.1:5173/health"),
            Some((5173, "/health".into()))
        );
        assert_eq!(
            parse_loopback_http("http://localhost:80"),
            Some((80, "/".into()))
        );
        assert!(parse_loopback_http("https://127.0.0.1:80/").is_none());
        assert!(parse_loopback_http("http://example.com:80/").is_none());
        assert!(parse_loopback_http("http://user:pass@127.0.0.1:80/").is_none());
    }

    #[test]
    fn scan_recognizes_tomcat_war_maven_project() {
        let root = tempfile::tempdir().unwrap();
        let war_dir = root.path().join("legacy-war");
        fs::create_dir_all(&war_dir).unwrap();
        fs::write(
            war_dir.join("pom.xml"),
            r#"<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>parent-framework</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>demo-portal</artifactId>
  <packaging>war</packaging>
  <properties>
    <java.version>1.8</java.version>
  </properties>
</project>"#,
        ).unwrap();

        let report = scan_dev_directory(root.path(), 2, &[]).unwrap();
        let cand = report.candidates.iter().find(|c| c.kind == "tomcat-war").expect("tomcat-war detected");
        assert_eq!(cand.label, "Tomcat WAR");
        assert_eq!(cand.port, Some(8080));
        assert!(cand.port_guessed);
        assert_eq!(cand.confidence, "medium");
        assert!(cand.command.contains("demo-portal.war"), "command should deploy demo-portal.war: {}", cand.command);
        assert!(cand.command.contains("catalina.sh") && cand.command.contains("run"));
        assert_eq!(cand.java.as_deref(), Some("8"));
    }

    #[test]
    fn scan_recognizes_projects_and_skips_existing_and_noise() {
        let root = tempfile::tempdir().unwrap();
        let web = root.path().join("shop/web");
        fs::create_dir_all(web.join("node_modules/nested")).unwrap();
        fs::write(
            web.join("package.json"),
            r#"{"devDependencies":{"vite":"5.0.0"},"scripts":{"dev":"vite --port 5174"}}"#,
        )
        .unwrap();
        fs::write(web.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();
        fs::write(
            web.join("node_modules/nested/package.json"),
            r#"{"dependencies":{"vite":"1"}}"#,
        )
        .unwrap();
        fs::write(
            web.join("vite.config.ts"),
            "export default { server: { port: 5999 } }\n",
        )
        .unwrap();

        let api = root.path().join("api");
        fs::create_dir_all(api.join("src/main/resources")).unwrap();
        fs::write(
            api.join("pom.xml"),
            "<project><dependencies>spring-boot</dependencies></project>",
        )
        .unwrap();
        fs::write(api.join("mvnw"), "#!/bin/sh\n").unwrap();
        fs::write(
            api.join("src/main/resources/application.yml"),
            "server:\n  port: 8088\n",
        )
        .unwrap();

        let parent = root.path().join("suite");
        fs::create_dir_all(parent.join("child")).unwrap();
        fs::write(
            parent.join("pom.xml"),
            "<project><modules><module>child</module></modules></project>",
        )
        .unwrap();
        fs::write(
            parent.join("child/pom.xml"),
            "<project>spring-boot</project>",
        )
        .unwrap();

        let app = root.path().join("pyapp");
        fs::create_dir_all(&app).unwrap();
        fs::write(app.join("manage.py"), "# django\n").unwrap();
        fs::write(
            root.path().join("package.json"),
            r#"{"workspaces":["shop/*"]}"#,
        )
        .unwrap();

        let existing_web = fs::canonicalize(&web).unwrap();
        let report = scan_dev_directory(
            root.path(),
            3,
            &[ExistingProject {
                id: "already".into(),
                path: existing_web.to_string_lossy().into(),
                has_dev: true,
            }],
        )
        .unwrap();

        assert!(report
            .candidates
            .iter()
            .all(|item| !item.path.contains("node_modules")));
        let web_hit = report
            .candidates
            .iter()
            .find(|item| item.kind == "vite")
            .unwrap();
        assert_eq!(web_hit.command, "pnpm dev");
        assert_eq!(web_hit.port, Some(5174));
        assert!(!web_hit.port_guessed);
        assert!(web_hit.already_registered);
        assert!(web_hit.existing_has_dev);
        assert_eq!(web_hit.group.as_deref(), Some("shop"));
        assert!(report
            .candidates
            .iter()
            .any(|item| item.kind == "spring-boot-maven"
                && item.port == Some(8088)
                && item.command.starts_with("./mvnw")));
        assert!(report
            .candidates
            .iter()
            .any(|item| item.kind == "django" && item.command.contains("runserver")));
        assert!(report
            .candidates
            .iter()
            .all(|item| item.path != fs::canonicalize(root.path()).unwrap().to_string_lossy()));
        assert!(report
            .candidates
            .iter()
            .any(|item| item.path.ends_with("/suite/child")
                || item.path.ends_with("\\suite\\child")
                || item.kind == "spring-boot-maven" && item.name == "child"));
    }
}

pub fn spring_profile_from_filename(name: &str) -> Option<String> {
    let rest = name.strip_prefix("application-")?;
    let stem = rest
        .strip_suffix(".yml")
        .or_else(|| rest.strip_suffix(".yaml"))
        .or_else(|| rest.strip_suffix(".properties"))?;
    if stem.is_empty()
        || stem.contains('.')
        || stem.contains('/')
        || stem.contains('\\')
        || !stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(stem.to_string())
}

pub fn suggest_spring_profiles(dir: &Path) -> BTreeMap<String, EnvPreset> {
    let res = dir.join("src/main/resources");
    let Ok(rd) = fs::read_dir(&res) else {
        return BTreeMap::new();
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut out = BTreeMap::new();
    for name in names {
        let Some(profile) = spring_profile_from_filename(&name) else {
            continue;
        };
        let text = read_limited(&res.join(&name), 256 * 1024).unwrap_or_default();
        let port = server_port(&text);
        let mut env = BTreeMap::new();
        env.insert("SPRING_PROFILES_ACTIVE".into(), profile.clone());
        let start = if dir.join("mvnw").is_file() {
            Some(format!(
                "./mvnw spring-boot:run -Dspring-boot.run.profiles={profile}"
            ))
        } else if dir.join("gradlew").is_file() {
            Some(format!(
                "./gradlew bootRun --args='--spring.profiles.active={profile}'"
            ))
        } else if dir.join("build.gradle").is_file() || dir.join("build.gradle.kts").is_file() {
            Some(format!(
                "gradle bootRun --args='--spring.profiles.active={profile}'"
            ))
        } else if dir.join("pom.xml").is_file() {
            Some(format!(
                "mvn spring-boot:run -Dspring-boot.run.profiles={profile}"
            ))
        } else {
            Some(format!(
                "mvn spring-boot:run -Dspring-boot.run.profiles={profile}"
            ))
        };
        out.insert(
            profile.clone(),
            EnvPreset {
                label: profile,
                command: start,
                port,
                health_url: None,
                env,
            },
        );
    }
    out
}

pub fn normalize_java_version(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() || t.starts_with('$') {
        return None;
    }
    if t == "1.8" || t == "8" {
        return Some("8".into());
    }
    let digits: String = t
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let first = digits.split('.').next().unwrap_or("");
    if let Ok(n) = first.parse::<u32>() {
        if (8..=30).contains(&n) {
            return Some(n.to_string());
        }
    }
    None
}

pub fn pom_java_version(pom: &str) -> Option<String> {
    for tag in [
        "java.version",
        "maven.compiler.source",
        "maven.compiler.target",
        "maven.compiler.release",
    ] {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        if let Some(start) = pom.find(&open) {
            let after = &pom[start + open.len()..];
            if let Some(end) = after.find(&close) {
                if let Some(norm) = normalize_java_version(&after[..end]) {
                    return Some(norm);
                }
            }
        }
    }
    None
}

pub fn node_version_from_package(value: &serde_json::Value) -> Option<String> {
    let engines = value.get("engines").and_then(|v| v.as_object())?;
    let node_val = engines.get("node").and_then(|v| v.as_str())?;
    for part in node_val.split(|c: char| !c.is_ascii_digit()) {
        if let Ok(n) = part.parse::<u32>() {
            if (12..=30).contains(&n) {
                return Some(n.to_string());
            }
        }
    }
    None
}
