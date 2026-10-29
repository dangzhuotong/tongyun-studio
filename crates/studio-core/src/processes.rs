//! App-owned, non-detached command processes. Dropping the manager stops its process groups.
//! Service records survive tab/project navigation, but are intentionally not restored after App exit.
use crate::dev_runtime::{
    self, derive_state, LifeState, StateInput, LOG_TAIL_LINES, READY_TIMEOUT_SECS,
};
use crate::toolchain;
use crate::{Project, Result};
use serde::Serialize;
#[allow(unused_imports)]
use std::path::{Path, PathBuf};
#[allow(unused_imports)]
use std::process::{Child, Command, Stdio};
use std::{
    collections::BTreeMap,
    io::Read,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

pub const MAX_LOG_FILE_BYTES: u64 = 1024 * 1024; // 1 MiB

pub fn default_log_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TONGYUN_STUDIO_LOG_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    if let Some(h) = home {
        h.join(".tongyun-studio").join("logs")
    } else {
        PathBuf::from(".tongyun-studio").join("logs")
    }
}

pub fn safe_project_filename(project_id: &str) -> String {
    let sanitized: String = project_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if sanitized.trim_matches('_').is_empty() {
        "project".to_string()
    } else {
        sanitized
    }
}

pub fn project_log_path(log_dir: &Path, project_id: &str) -> PathBuf {
    log_dir.join(format!("{}.log", safe_project_filename(project_id)))
}

pub fn project_log_path_rolled(log_dir: &Path, project_id: &str) -> PathBuf {
    log_dir.join(format!("{}.log.1", safe_project_filename(project_id)))
}

#[derive(Clone)]
pub struct RollingLogWriter {
    path: PathBuf,
    rolled_path: PathBuf,
    max_bytes: u64,
    lock: Arc<Mutex<()>>,
}

impl RollingLogWriter {
    pub fn new(path: PathBuf, rolled_path: PathBuf, max_bytes: u64) -> Self {
        Self {
            path,
            rolled_path,
            max_bytes,
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn for_project(log_dir: &Path, project_id: &str) -> Self {
        let path = project_log_path(log_dir, project_id);
        let rolled_path = project_log_path_rolled(log_dir, project_id);
        Self::new(path, rolled_path, MAX_LOG_FILE_BYTES)
    }

    pub fn append(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let Ok(_guard) = self.lock.lock() else {
            return;
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(meta) = std::fs::metadata(&self.path) {
            if meta.len().saturating_add(bytes.len() as u64) > self.max_bytes {
                let _ = std::fs::remove_file(&self.rolled_path);
                let _ = std::fs::rename(&self.path, &self.rolled_path);
            }
        }
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = f.write_all(bytes);
            let _ = f.flush();
        }
    }
}

pub fn read_tail(path: &Path, max_lines: usize) -> Result<String> {
    read_tail_with_backup(path, None, max_lines)
}

pub fn read_tail_with_backup(
    path: &Path,
    backup_path: Option<&Path>,
    max_lines: usize,
) -> Result<String> {
    use std::fs::File;
    use std::io::{Seek, SeekFrom};
    let max_lines = max_lines.clamp(1, 500);

    let mut primary_lines = Vec::new();
    let mut primary_ends_with_nl = false;
    if path.is_file() {
        let mut file = File::open(path).map_err(|e| format!("打开日志文件失败: {e}"))?;
        let len = file.metadata().map_err(|e| format!("读取日志元数据失败: {e}"))?.len();
        let window = 512 * 1024;
        let start = len.saturating_sub(window);
        file.seek(SeekFrom::Start(start)).map_err(|e| format!("定位日志文件失败: {e}"))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| format!("读取日志内容失败: {e}"))?;
        if start > 0 {
            if let Some(i) = buf.iter().position(|b| *b == b'\n') {
                buf.drain(..=i);
            }
        }
        let text = String::from_utf8_lossy(&buf);
        primary_ends_with_nl = text.ends_with('\n');
        for l in text.lines() {
            primary_lines.push(l.to_string());
        }
    }

    if primary_lines.len() >= max_lines || backup_path.is_none() {
        let skip = primary_lines.len().saturating_sub(max_lines);
        let mut out = primary_lines[skip..].join("\n");
        if primary_ends_with_nl && !out.is_empty() {
            out.push('\n');
        }
        return Ok(out);
    }

    let backup = backup_path.unwrap();
    if backup.is_file() {
        let needed = max_lines - primary_lines.len();
        if let Ok(mut file) = File::open(backup) {
            if let Ok(meta) = file.metadata() {
                let window = 512 * 1024;
                let start = meta.len().saturating_sub(window);
                let _ = file.seek(SeekFrom::Start(start));
                let mut buf = Vec::new();
                if file.read_to_end(&mut buf).is_ok() {
                    if start > 0 {
                        if let Some(i) = buf.iter().position(|b| *b == b'\n') {
                            buf.drain(..=i);
                        }
                    }
                    let text = String::from_utf8_lossy(&buf);
                    let b_lines: Vec<&str> = text.lines().collect();
                    let b_skip = b_lines.len().saturating_sub(needed);
                    let mut combined: Vec<String> = b_lines[b_skip..].iter().map(|s| s.to_string()).collect();
                    combined.extend(primary_lines);
                    let mut out = combined.join("\n");
                    if primary_ends_with_nl && !out.is_empty() {
                        out.push('\n');
                    }
                    return Ok(out);
                }
            }
        }
    }

    let skip = primary_lines.len().saturating_sub(max_lines);
    let mut out = primary_lines[skip..].join("\n");
    if primary_ends_with_nl && !out.is_empty() {
        out.push('\n');
    }
    Ok(out)
}

#[allow(dead_code)]
const OUTPUT_LIMIT: usize = 64 * 1024;
const SERVICE_LIMIT: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedService {
    pub id: String,
    pub project_id: String,
    pub command: String,
    pub pid: Option<u32>,
    /// Process-group status: running, stopped, exited, or failed.
    pub status: String,
    pub started_at: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub output_truncated: bool,
    /// Readiness: stopped, starting, port_open, ready, failed, or exited.
    pub lifecycle: String,
    pub failure: Option<String>,
    pub port: Option<u16>,
    pub port_open: bool,
    pub elapsed_secs: Option<u64>,
    pub log_tail: String,
    pub ready_timeout_secs: u64,
    /// True only for `ready` and `port_open`. A live process is not enough.
    pub reachable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_profile: Option<String>,
    #[serde(default)]
    pub restart_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_restart: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_restarts: Option<u32>,
}

#[derive(Clone, Default)]
#[allow(dead_code)]
struct Binding {
    expects_port: bool,
    port: Option<u16>,
    health_url: Option<String>,
    ready_timeout_secs: u64,
    active_profile: Option<String>,
    env: Vec<(String, String)>,
    auto_install: bool,
    pull_deps_first: bool,
    deps_installed: bool,
    auto_restart: bool,
    max_restarts: u32,
    restart_interval_secs: u64,
}

impl Binding {
    fn none() -> Self {
        Self {
            expects_port: false,
            port: None,
            health_url: None,
            ready_timeout_secs: 0,
            active_profile: None,
            env: Vec::new(),
            auto_install: true,
            pull_deps_first: false,
            deps_installed: false,
            auto_restart: false,
            max_restarts: 3,
            restart_interval_secs: 60,
        }
    }

    fn for_project(project: &Project, command: &str) -> Self {
        let Some(dev) = project.dev.as_ref() else {
            return Self::none();
        };
        let matching_profile = dev
            .profiles
            .iter()
            .find(|(_, p)| p.command.as_deref().map(str::trim) == Some(command.trim()));
        if dev.command.trim() != command.trim() && matching_profile.is_none() {
            return Self::none();
        }
        let port = matching_profile
            .and_then(|(_, p)| p.port)
            .or(dev.port)
            .filter(|port| *port > 0);
        let health_url = matching_profile
            .and_then(|(_, p)| p.health_url.clone())
            .or_else(|| dev.health_url.clone())
            .filter(|url| !url.trim().is_empty());
        let ready_timeout_secs = dev.ready_timeout_secs.unwrap_or(if port.is_some() {
            READY_TIMEOUT_SECS
        } else {
            0
        });
        let auto_install = dev.auto_install.unwrap_or(true);
        let pull_deps_first = dev.pull_deps_first.unwrap_or(false);
        let deps_installed = dev.deps_installed.unwrap_or(false);
        let auto_restart = matching_profile
            .and_then(|(_, p)| p.auto_restart)
            .or(dev.auto_restart)
            .unwrap_or(false);
        let max_restarts = matching_profile
            .and_then(|(_, p)| p.max_restarts)
            .or(dev.max_restarts)
            .unwrap_or(3);
        let restart_interval_secs = matching_profile
            .and_then(|(_, p)| p.restart_interval_secs)
            .or(dev.restart_interval_secs)
            .unwrap_or(60);
        Self {
            expects_port: port.is_some(),
            port,
            health_url,
            ready_timeout_secs,
            active_profile: matching_profile.map(|(name, _)| name.clone()),
            env: Vec::new(),
            auto_install,
            pull_deps_first,
            deps_installed,
            auto_restart,
            max_restarts,
            restart_interval_secs,
        }
    }
}

#[derive(Default)]
struct Output {
    bytes: Vec<u8>,
    truncated: bool,
}
impl Output {
    #[allow(dead_code)]
    fn append(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
        if self.bytes.len() > OUTPUT_LIMIT {
            self.bytes.drain(..self.bytes.len() - OUTPUT_LIMIT);
            self.truncated = true;
        }
    }
}
struct Entry {
    snapshot: ManagedService,
    directory: String,
    child: Option<Child>,
    pgid: u32,
    stdout: Arc<Mutex<Output>>,
    stderr: Arc<Mutex<Output>>,
    reaped: bool,
    expects_port: bool,
    port: Option<u16>,
    health_url: Option<String>,
    ready_timeout_secs: u64,
    binding_env: Vec<(String, String)>,
    started: Instant,
    user_stopped: bool,
    port_cache: Option<(Instant, bool)>,
    probe_cache: Option<(Instant, bool)>,
    installing: bool,
    install_command: Option<String>,
    #[allow(dead_code)]
    service_command: String,
    log_writer: Option<RollingLogWriter>,
    auto_restart: bool,
    max_restarts: u32,
    restart_interval_secs: u64,
    restart_count: u32,
    last_crash_at: Option<Instant>,
}
impl Entry {
    fn refresh(&mut self) -> Result<()> {
        if self.snapshot.status != "running" {
            return Ok(());
        }
        if self.installing {
            if let Some(child) = self.child.as_mut() {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|e| format!("读取安装依赖进程失败：{e}"))?
                {
                    self.installing = false;
                    self.snapshot.exit_code = status.code();
                    if self.user_stopped {
                        self.snapshot.status = "stopped".into();
                        self.snapshot.lifecycle = LifeState::Stopped.as_str().into();
                        self.reaped = true;
                        self.child = None;
                        return Ok(());
                    }
                    if !status.success() {
                        let cmd_str = self.install_command.as_deref().unwrap_or("依赖安装");
                        let err_msg = format!(
                            "依赖安装失败：{cmd_str} 退出码 {:?}",
                            status.code().unwrap_or(-1)
                        );
                        if let Ok(mut out) = self.stderr.lock() {
                            out.append(format!("[tongyun-studio] {err_msg}\n").as_bytes());
                        }
                        self.snapshot.status = "failed".into();
                        self.snapshot.lifecycle = LifeState::Failed.as_str().into();
                        self.snapshot.failure = Some(err_msg);
                        self.reaped = true;
                        self.child = None;
                        return Ok(());
                    }
                    let inst_cmd = self.install_command.as_deref().unwrap_or("依赖安装");
                    if self.install_command.as_deref() == Some(&self.service_command) {
                        if let Ok(mut out) = self.stdout.lock() {
                            out.append(format!("[tongyun-studio] {inst_cmd} 完成。\n").as_bytes());
                        }
                        self.snapshot.status = "exited".into();
                        self.snapshot.lifecycle = LifeState::Exited.as_str().into();
                        self.snapshot.failure = None;
                        self.reaped = true;
                        self.child = None;
                        return Ok(());
                    }
                    if let Ok(mut out) = self.stdout.lock() {
                        out.append(
                            format!("[tongyun-studio] {inst_cmd} 完成，正在启动服务...\n")
                                .as_bytes(),
                        );
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::process::CommandExt;
                        let mut cmd = Command::new("/bin/sh");
                        cmd.args(["-c", &self.service_command])
                            .current_dir(&self.directory)
                            .stdin(Stdio::null())
                            .stdout(Stdio::piped())
                            .stderr(Stdio::piped())
                            .process_group(0);
                        for (k, v) in &self.binding_env {
                            cmd.env(k, v);
                        }
                        match cmd.spawn() {
                            Ok(mut s_child) => {
                                self.pgid = s_child.id();
                                read_output(
                                    s_child.stdout.take().expect("piped stdout"),
                                    self.stdout.clone(),
                                    self.log_writer.clone(),
                                );
                                read_output(
                                    s_child.stderr.take().expect("piped stderr"),
                                    self.stderr.clone(),
                                    self.log_writer.clone(),
                                );
                                self.child = Some(s_child);
                                self.started = Instant::now();
                                self.snapshot.pid = Some(self.pgid);
                                self.snapshot.lifecycle = LifeState::Starting.as_str().into();
                            }
                            Err(e) => {
                                let err_msg = format!("启动服务失败：{e}");
                                self.snapshot.status = "failed".into();
                                self.snapshot.lifecycle = LifeState::Failed.as_str().into();
                                self.snapshot.failure = Some(err_msg);
                                self.child = None;
                                self.reaped = true;
                            }
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        self.snapshot.status = "failed".into();
                        self.snapshot.lifecycle = LifeState::Failed.as_str().into();
                        self.snapshot.failure = Some("托管服务目前仅支持 macOS / Unix。".into());
                        self.child = None;
                        self.reaped = true;
                    }
                }
            }
            return Ok(());
        }
        if let Some(child) = self.child.as_mut() {
            if !self.reaped {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|e| format!("读取服务进程失败：{e}"))?
                {
                    self.reaped = true;
                    self.snapshot.exit_code = status.code();
                }
            }
            if self.reaped && !group_alive(self.pgid)? {
                self.snapshot.pid = None;
                if self.user_stopped {
                    self.snapshot.status = "stopped".into();
                } else {
                    let abnormal = self.expects_port || self.snapshot.exit_code != Some(0);
                    if !abnormal {
                        self.snapshot.status = "exited".into();
                    } else if self.auto_restart {
                        let now = Instant::now();
                        if self.restart_interval_secs > 0 {
                            let reset = match self.last_crash_at {
                                Some(last) => now.duration_since(last) >= Duration::from_secs(self.restart_interval_secs),
                                None => self.started.elapsed() >= Duration::from_secs(self.restart_interval_secs),
                            };
                            if reset {
                                self.restart_count = 0;
                            }
                        }
                        self.last_crash_at = Some(now);

                        if self.restart_count >= self.max_restarts {
                            self.snapshot.status = "failed".into();
                            let reason = format!(
                                "已达自动重启上限（{}次），停止重启：{}",
                                self.max_restarts,
                                exit_failure(self.snapshot.exit_code)
                            );
                            self.snapshot.failure = Some(reason.clone());
                            let limit_msg = format!("\n[自动重启] {}\n", reason);
                            if let Ok(mut err) = self.stderr.lock() {
                                err.append(limit_msg.as_bytes());
                            }
                            if let Some(w) = self.log_writer.as_ref() {
                                w.append(limit_msg.as_bytes());
                            }
                        } else {
                            self.restart_count += 1;
                            self.snapshot.restart_count = self.restart_count;
                            let code_str = exit_failure(self.snapshot.exit_code);
                            let log_msg = format!(
                                "\n[自动重启] 进程异常退出（{}），正在进行第 {}/{} 次自动重启...\n",
                                code_str, self.restart_count, self.max_restarts
                            );
                            if let Ok(mut err) = self.stderr.lock() {
                                err.append(log_msg.as_bytes());
                            }
                            if let Some(w) = self.log_writer.as_ref() {
                                w.append(log_msg.as_bytes());
                            }
                            match self.respawn() {
                                Ok(()) => return Ok(()),
                                Err(e) => {
                                    self.snapshot.status = "failed".into();
                                    let reason = format!("自动重启失败：{e}");
                                    self.snapshot.failure = Some(reason.clone());
                                    let fail_msg = format!("\n[自动重启] {}\n", reason);
                                    if let Ok(mut err) = self.stderr.lock() {
                                        err.append(fail_msg.as_bytes());
                                    }
                                    if let Some(w) = self.log_writer.as_ref() {
                                        w.append(fail_msg.as_bytes());
                                    }
                                }
                            }
                        }
                    } else {
                        self.snapshot.status = "failed".into();
                    }
                }
            }
        }
        Ok(())
    }
    fn snapshot(&mut self) -> ManagedService {
        let mut snapshot = self.snapshot.clone();
        if let Ok(output) = self.stdout.lock() {
            snapshot.stdout = String::from_utf8_lossy(&output.bytes).into_owned();
            snapshot.output_truncated |= output.truncated;
        }
        if let Ok(output) = self.stderr.lock() {
            snapshot.stderr = String::from_utf8_lossy(&output.bytes).into_owned();
            snapshot.output_truncated |= output.truncated;
        }
        self.apply_lifecycle(&mut snapshot);
        snapshot.log_tail =
            dev_runtime::tail_lines(&snapshot.stdout, &snapshot.stderr, LOG_TAIL_LINES);
        snapshot
    }
    fn apply_lifecycle(&mut self, snapshot: &mut ManagedService) {
        if self.child.is_none() {
            return;
        }
        snapshot.port = self.port;
        snapshot.ready_timeout_secs = self.ready_timeout_secs;
        if self.installing {
            snapshot.lifecycle = LifeState::Installing.as_str().into();
            snapshot.failure = None;
            snapshot.port_open = false;
            snapshot.reachable = false;
            snapshot.elapsed_secs = Some(self.started.elapsed().as_secs());
            return;
        }
        let (state, failure, port_open) = if self.user_stopped {
            (LifeState::Stopped, None, false)
        } else if !self.expects_port {
            match snapshot.status.as_str() {
                "running" => (LifeState::Starting, None, false),
                "exited" => (LifeState::Exited, None, false),
                "failed" => (
                    LifeState::Failed,
                    self.snapshot.failure.clone().or_else(|| Some(exit_failure(snapshot.exit_code))),
                    false,
                ),
                _ => (LifeState::Stopped, None, false),
            }
        } else {
            let port_open = self.observe_port();
            let alive = snapshot.status == "running";
            // A dead group plus an open port is not this service. tongyun-dev checks the listener pid;
            // Studio refuses that combination instead of reporting ready.
            if !alive {
                // The process group is already gone. tongyun-dev keeps "starting" for
                // about 3 seconds after a starter script exits, because a detached JVM
                // may still be coming up. Studio owns the whole group, so that grace
                // would show "failed" and "starting" at the same time.
                let failure = self.snapshot.failure.clone().unwrap_or_else(|| match snapshot.exit_code {
                    Some(0) => "进程已退出".to_owned(),
                    _ => exit_failure(snapshot.exit_code),
                });
                (LifeState::Failed, Some(failure), false)
            } else {
                let (has_probe, probe_ok) = if port_open {
                    self.observe_probe()
                } else {
                    (self.health_url.is_some(), false)
                };
                let (state, failure) = derive_state(StateInput {
                    process_alive: true,
                    port_open,
                    port_conflict: false,
                    has_probe,
                    probe_ok,
                    started_at: Some(0),
                    now: self.started.elapsed().as_secs(),
                    timeout_secs: self.ready_timeout_secs,
                    start_error: None,
                    installing: false,
                });
                (state, failure, port_open)
            }
        };
        snapshot.lifecycle = state.as_str().into();
        snapshot.failure = failure;
        snapshot.port_open = port_open;
        snapshot.reachable = state.reachable();
        snapshot.elapsed_secs = match state {
            LifeState::Stopped => None,
            _ => Some(self.started.elapsed().as_secs()),
        };
    }
    fn observe_port(&mut self) -> bool {
        let Some(port) = self.port else { return false };
        if let Some((at, open)) = self.port_cache {
            if at.elapsed() < Duration::from_millis(250) {
                return open;
            }
        }
        let open = dev_runtime::tcp_open(port);
        self.port_cache = Some((Instant::now(), open));
        open
    }
    fn observe_probe(&mut self) -> (bool, bool) {
        let Some(url) = self.health_url.clone() else {
            return (false, false);
        };
        if let Some((at, ok)) = self.probe_cache {
            if at.elapsed() < Duration::from_millis(500) {
                return (true, ok);
            }
        }
        let ok = dev_runtime::probe_loopback(&url);
        self.probe_cache = Some((Instant::now(), ok));
        (true, ok)
    }
    fn stop(&mut self) -> Result<()> {
        self.refresh()?;
        if self.snapshot.status != "running" {
            return Ok(());
        }
        self.user_stopped = true;
        if self.pgid > 0 {
            signal_group(self.pgid, terminate_signal())?;
            if !self.wait_stopped(Duration::from_millis(1000))? {
                signal_group(self.pgid, kill_signal())?;
                if !self.wait_stopped(Duration::from_secs(2))? {
                    return Err("服务进程组仍存在，未确认停止；请重试。".into());
                }
            }
        }
        self.snapshot.pid = None;
        self.snapshot.status = "stopped".into();
        Ok(())
    }
    fn wait_stopped(&mut self, budget: Duration) -> Result<bool> {
        let start = Instant::now();
        loop {
            self.refresh()?;
            if self.snapshot.status != "running" {
                return Ok(true);
            }
            if start.elapsed() >= budget {
                return Ok(false);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn binding(&self) -> Binding {
        Binding {
            expects_port: self.expects_port,
            port: self.port,
            health_url: self.health_url.clone(),
            ready_timeout_secs: self.ready_timeout_secs,
            active_profile: self.snapshot.active_profile.clone(),
            env: self.binding_env.clone(),
            auto_install: true,
            pull_deps_first: false,
            deps_installed: false,
            auto_restart: self.auto_restart,
            max_restarts: self.max_restarts,
            restart_interval_secs: self.restart_interval_secs,
        }
    }
}
fn exit_failure(code: Option<i32>) -> String {
    match code {
        Some(code) => format!("进程退出，退出码 {code}"),
        None => "进程被信号终止".into(),
    }
}
#[derive(Default)]
struct Registry { entries: BTreeMap<String, Entry>, shutting_down: bool }

pub struct ServiceManager {
    registry: Mutex<Registry>,
    log_dir: PathBuf,
}

impl Default for ServiceManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ServiceManager {
    pub fn new() -> Self {
        Self::with_log_dir(default_log_dir())
    }

    pub fn with_log_dir(log_dir: PathBuf) -> Self {
        Self {
            registry: Mutex::new(Registry::default()),
            log_dir,
        }
    }

    pub fn log_dir(&self) -> &Path {
        &self.log_dir
    }

    pub fn project_log_path(&self, project_id: &str) -> PathBuf {
        project_log_path(&self.log_dir, project_id)
    }

    pub fn project_log_path_rolled(&self, project_id: &str) -> PathBuf {
        project_log_path_rolled(&self.log_dir, project_id)
    }

    pub fn project_log_tail(&self, project_id: &str, lines: usize) -> Result<Option<String>> {
        let path = self.project_log_path(project_id);
        let rolled = self.project_log_path_rolled(project_id);
        if !path.is_file() && !rolled.is_file() {
            return Ok(None);
        }
        read_tail_with_backup(&path, Some(&rolled), lines).map(Some)
    }
    pub fn start(&self, project: &Project, command: &str) -> Result<ManagedService> {
        self.start_with_profile(project, command, None)
    }

    pub fn start_with_profile(
        &self,
        project: &Project,
        command: &str,
        profile_name: Option<&str>,
    ) -> Result<ManagedService> {
        let mut command = command.trim();
        let dev = project.dev.as_ref();
        let effective_profile_name =
            profile_name.or_else(|| dev.and_then(|d| d.default_profile.as_deref()));
        let preset = effective_profile_name.and_then(|name| dev.and_then(|d| d.profiles.get(name)));

        // If command is empty or matches dev.command, apply profile command override if present
        if let Some(p) = preset {
            if let Some(ref c) = p.command {
                if command.is_empty() || dev.is_some_and(|d| command == d.command.trim()) {
                    command = c.trim();
                }
            }
        }
        if command.is_empty() {
            if let Some(d) = dev {
                command = d.command.trim();
            }
        }
        if command.is_empty() || command.len() > 8192 || command.contains('\0') {
            return Err("命令为空、过长或包含无效字符。".into());
        }

        // Toolchain pre-flight check and environment assembly
        let mut env_vars = Vec::new();
        if let Some(d) = dev {
            let roots = toolchain::ToolchainRoots::from_env();
            let java = d.java.as_deref();
            let java_home = d.java_home.as_deref().map(Path::new);
            let node = d.node.as_deref();
            let node_home = d.node_home.as_deref().map(Path::new);
            if java.is_some() || java_home.is_some() || node.is_some() || node_home.is_some() {
                let tc_env = toolchain::toolchain_env(java, java_home, node, node_home, &roots)
                    .map_err(|e| e.to_string())?;
                env_vars.extend(tc_env);
            }

            let needs_tomcat = d.kind == "tomcat-war"
                || d.catalina_home.is_some()
                || command.contains("catalina")
                || command.contains("{{tomcat}}")
                || command.contains("{{catalina_home}}");
            if needs_tomcat {
                let explicit_ch = d.catalina_home.as_deref()
                    .or_else(|| d.env.get("CATALINA_HOME").map(String::as_str))
                    .or_else(|| preset.and_then(|p| p.env.get("CATALINA_HOME")).map(String::as_str))
                    .map(Path::new);
                let ch = toolchain::resolve_catalina_home(explicit_ch, &roots)
                    .map_err(|e| e.to_string())?;
                let ch_str = ch.to_string_lossy().into_owned();
                env_vars.push(("CATALINA_HOME".into(), ch_str.clone()));
                env_vars.push(("CATALINA_BASE".into(), ch_str.clone()));

                let bin = ch.join("bin");
                let sep = if roots.os == toolchain::HostOs::Windows { ";" } else { ":" };
                if let Some((_, existing_path)) = env_vars.iter_mut().find(|(k, _)| k == "PATH") {
                    *existing_path = format!("{}{sep}{existing_path}", bin.display());
                } else {
                    let base_path = &roots.base_path;
                    let new_path = if base_path.is_empty() {
                        bin.display().to_string()
                    } else {
                        format!("{}{sep}{base_path}", bin.display())
                    };
                    env_vars.push(("PATH".into(), new_path));
                }
            }
            for (k, v) in &d.env {
                env_vars.push((k.clone(), v.clone()));
            }
        }
        if let Some(p) = preset {
            for (k, v) in &p.env {
                env_vars.push((k.clone(), v.clone()));
            }
        }

        let mut binding = Binding::for_project(project, command);
        if let Some(p) = preset {
            if let Some(port) = p.port.filter(|port| *port > 0) {
                binding.port = Some(port);
                binding.expects_port = true;
            }
            if let Some(ref h) = p.health_url {
                binding.health_url = Some(h.clone());
            }
            if let Some(ar) = p.auto_restart {
                binding.auto_restart = ar;
            }
            if let Some(mr) = p.max_restarts {
                binding.max_restarts = mr;
            }
            if let Some(ris) = p.restart_interval_secs {
                binding.restart_interval_secs = ris;
            }
            binding.active_profile = effective_profile_name.map(str::to_string);
        }
        binding.env = env_vars;

        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        if registry.shutting_down {
            return Err("工作台正在退出，不能启动服务。".into());
        }
        for entry in registry.entries.values_mut() {
            if entry.snapshot.project_id == project.id && entry.snapshot.command == command {
                entry.refresh()?;
                if entry.snapshot.status == "running" {
                    return Ok(entry.snapshot());
                }
            }
        }
        if let Some(port) = binding.port.filter(|_| binding.expects_port) {
            if dev_runtime::tcp_open(port) {
                return Err(dev_runtime::port_occupied_error(port));
            }
        }
        // Missing dependency check and auto-installation
        let root = Path::new(&project.path);
        let is_node_missing = dev_runtime::node_deps_missing(root);
        let is_java_pull = (root.join("pom.xml").is_file()
            || root.join("build.gradle").is_file()
            || root.join("build.gradle.kts").is_file())
            && binding.pull_deps_first
            && !binding.deps_installed;

        let install_command = if is_node_missing {
            if !binding.auto_install {
                return Err(dev_runtime::DEPS_MISSING_MSG.into());
            }
            dev_runtime::detect_install_command(root, dev)
        } else if is_java_pull && binding.auto_install {
            dev_runtime::detect_install_command(root, dev)
        } else {
            None
        };

        // Reuse the same service identity when the same project command is run again.
        let existing = registry
            .entries
            .values()
            .find(|entry| {
                entry.snapshot.project_id == project.id && entry.snapshot.command == command
            })
            .map(|entry| entry.snapshot.id.clone());
        if existing.is_none() && registry.entries.len() >= SERVICE_LIMIT {
            return Err("本次工作台已记录 64 个命令。请停止服务并重启工作台后继续。".into());
        }
        let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let entry = spawn_entry(
            id.clone(),
            &project.id,
            &project.path,
            command,
            binding,
            install_command,
            &self.log_dir,
        )?;
        let mut entry = entry;
        let snapshot = entry.snapshot();
        registry.entries.insert(id, entry);
        Ok(snapshot)
    }
    pub fn list(&self, project_id: &str) -> Result<Vec<ManagedService>> {
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        let mut services = vec![];
        for entry in registry.entries.values_mut() {
            // Also reap inactive projects without discarding their records.
            entry.refresh()?;
            if entry.snapshot.project_id == project_id {
                services.push(entry.snapshot());
            }
        }
        services.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(services)
    }
    pub fn log_tail(&self, project_id: &str, service_id: &str, lines: usize) -> Result<String> {
        let lines = lines.clamp(1, 500);
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        let entry = registry
            .entries
            .get_mut(service_id)
            .ok_or("服务记录不存在")?;
        if entry.snapshot.project_id != project_id {
            return Err("服务不属于当前项目".into());
        }
        entry.refresh()?;
        let snapshot = entry.snapshot();
        Ok(dev_runtime::tail_lines(
            &snapshot.stdout,
            &snapshot.stderr,
            lines,
        ))
    }
    pub fn stop(&self, project_id: &str, service_id: &str) -> Result<ManagedService> {
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        let entry = registry
            .entries
            .get_mut(service_id)
            .ok_or("服务记录不存在")?;
        if entry.snapshot.project_id != project_id {
            return Err("服务不属于当前项目".into());
        }
        entry.stop()?;
        Ok(entry.snapshot())
    }
    pub fn restart(&self, project_id: &str, service_id: &str) -> Result<ManagedService> {
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        if registry.shutting_down {
            return Err("工作台正在退出，不能重启服务。".into());
        }
        let old = registry
            .entries
            .get_mut(service_id)
            .ok_or("服务记录不存在")?;
        if old.snapshot.project_id != project_id {
            return Err("服务不属于当前项目".into());
        }
        let binding = old.binding();
        let directory = old.directory.clone();
        let command = old.snapshot.command.clone();
        old.stop()?; // Never start a replacement before stopping the entire old group.
        if let Some(port) = binding.port.filter(|_| binding.expects_port) {
            if dev_runtime::tcp_open(port) {
                return Err(dev_runtime::port_occupied_error(port));
            }
        }
        let mut entry = spawn_entry(
            service_id.to_owned(),
            project_id,
            &directory,
            &command,
            binding,
            None,
            &self.log_dir,
        )?;
        let snapshot = entry.snapshot();
        registry.entries.insert(service_id.to_owned(), entry);
        Ok(snapshot)
    }
    pub fn install_deps(&self, project: &Project) -> Result<ManagedService> {
        let root = Path::new(&project.path);
        let install_cmd = dev_runtime::detect_install_command(root, project.dev.as_ref())
            .ok_or_else(|| {
                "未识别到依赖安装命令（支持 package.json / pom.xml / build.gradle）".to_string()
            })?;
        let binding = Binding::for_project(project, &install_cmd);
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        if registry.shutting_down {
            return Err("工作台正在退出，不能安装依赖。".into());
        }
        let existing = registry
            .entries
            .values()
            .find(|entry| {
                entry.snapshot.project_id == project.id && entry.snapshot.command == install_cmd
            })
            .map(|entry| entry.snapshot.id.clone());
        if existing.is_none() && registry.entries.len() >= SERVICE_LIMIT {
            return Err("本次工作台已记录 64 个命令。请停止服务并重启工作台后继续。".into());
        }
        let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut entry = spawn_entry(
            id.clone(),
            &project.id,
            &project.path,
            &install_cmd,
            binding,
            Some(install_cmd.clone()),
            &self.log_dir,
        )?;
        let snapshot = entry.snapshot();
        registry.entries.insert(id, entry);
        Ok(snapshot)
    }
    pub fn create_skipped_service(
        &self,
        project: &Project,
        command: &str,
        reason: &str,
    ) -> Result<ManagedService> {
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        let existing = registry
            .entries
            .values()
            .find(|e| e.snapshot.project_id == project.id && e.snapshot.command == command)
            .map(|e| e.snapshot.id.clone());
        let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let dev = project.dev.as_ref();
        let port = dev.and_then(|d| d.port);
        let now = chrono::Utc::now().to_rfc3339();
        let ready_timeout_secs =
            dev.and_then(|d| d.ready_timeout_secs)
                .unwrap_or(if port.is_some() {
                    READY_TIMEOUT_SECS
                } else {
                    0
                });
        let snapshot = ManagedService {
            id: id.clone(),
            project_id: project.id.clone(),
            command: command.to_string(),
            pid: None,
            status: "failed".into(),
            started_at: now,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            output_truncated: false,
            lifecycle: "failed".into(),
            failure: Some(reason.to_string()),
            port,
            port_open: false,
            elapsed_secs: None,
            log_tail: format!("--- 跳过启动 ---\n{reason}"),
            ready_timeout_secs,
            reachable: false,
            active_profile: None,
            restart_count: 0,
            auto_restart: dev.and_then(|d| d.auto_restart),
            max_restarts: dev.and_then(|d| d.max_restarts),
        };
        let entry = Entry {
            snapshot: snapshot.clone(),
            directory: project.path.clone(),
            child: None,
            pgid: 0,
            stdout: Arc::new(Mutex::new(Output::default())),
            stderr: Arc::new(Mutex::new(Output::default())),
            reaped: true,
            expects_port: port.is_some(),
            port,
            health_url: dev.and_then(|d| d.health_url.clone()),
            ready_timeout_secs,
            binding_env: Vec::new(),
            started: Instant::now(),
            user_stopped: false,
            port_cache: None,
            probe_cache: None,
            installing: false,
            install_command: None,
            service_command: command.to_string(),
            log_writer: None,
            auto_restart: false,
            max_restarts: 3,
            restart_interval_secs: 60,
            restart_count: 0,
            last_crash_at: None,
        };
        registry.entries.insert(id, entry);
        Ok(snapshot)
    }

    fn wait_ready_or_failed(&self, service_id: &str, timeout: Duration) -> Result<ManagedService> {
        let start = Instant::now();
        loop {
            {
                let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
                let entry = registry
                    .entries
                    .get_mut(service_id)
                    .ok_or("服务记录不存在")?;
                entry.refresh()?;
                let snapshot = entry.snapshot();
                match snapshot.lifecycle.as_str() {
                    "ready" | "exited" => return Ok(snapshot),
                    "failed" => return Ok(snapshot),
                    _ => {
                        if snapshot.status != "running" {
                            return Ok(snapshot);
                        }
                        if start.elapsed() >= timeout {
                            entry.snapshot.lifecycle = "failed".into();
                            entry.snapshot.failure =
                                Some(format!("超过 {} 秒仍未就绪", timeout.as_secs()));
                            return Ok(entry.snapshot());
                        }
                    }
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn start_group(&self, projects: &[Project], group: &str) -> Result<Vec<ManagedService>> {
        let matched = group_members(projects, group)?;
        let sorted = sort_projects_by_dependencies(&matched)?;

        let mut failed_blockers: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let mut started = Vec::new();

        for project in sorted {
            let dev = project.dev.as_ref().expect("filtered");
            let command = dev.command.clone();
            let deps = &dev.depends_on;

            // Check if any dependency of this project has failed
            let blocked_by = deps.iter().find_map(|dep| {
                failed_blockers.get(dep).cloned().or_else(|| {
                    matched
                        .iter()
                        .find(|p| p.id == *dep || p.name == *dep)
                        .and_then(|p| {
                            failed_blockers
                                .get(&p.id)
                                .cloned()
                                .or_else(|| failed_blockers.get(&p.name).cloned())
                        })
                })
            });

            if let Some(blocker) = blocked_by {
                failed_blockers.insert(project.id.clone(), blocker.clone());
                failed_blockers.insert(project.name.clone(), blocker.clone());

                let reason = format!("被依赖服务 {} 挡住，已跳过启动", blocker);
                let skipped = self.create_skipped_service(project, &command, &reason)?;
                started.push(skipped);
                continue;
            }

            match self.start(project, &command) {
                Ok(svc) => {
                    let ready_timeout = Duration::from_secs(svc.ready_timeout_secs.max(1));
                    let outcome = self.wait_ready_or_failed(&svc.id, ready_timeout)?;
                    if outcome.lifecycle == "failed" {
                        failed_blockers.insert(project.id.clone(), project.name.clone());
                        failed_blockers.insert(project.name.clone(), project.name.clone());
                    }
                    started.push(outcome);
                }
                Err(err) => {
                    failed_blockers.insert(project.id.clone(), project.name.clone());
                    failed_blockers.insert(project.name.clone(), project.name.clone());
                    let reason = format!("启动失败：{err}");
                    let failed_svc = self.create_skipped_service(project, &command, &reason)?;
                    started.push(failed_svc);
                }
            }
        }
        Ok(started)
    }

    pub fn stop_group(&self, projects: &[Project], group: &str) -> Result<Vec<ManagedService>> {
        let matched = group_members(projects, group)?;
        let sorted = sort_projects_by_dependencies(&matched)?;
        let mut stopped = Vec::new();
        for project in sorted.into_iter().rev() {
            let command = project
                .dev
                .as_ref()
                .expect("filtered")
                .command
                .trim()
                .to_owned();
            let ids = self
                .list(&project.id)?
                .into_iter()
                .filter(|service| service.command == command && service.status == "running")
                .map(|service| service.id)
                .collect::<Vec<_>>();
            for id in ids {
                stopped.push(self.stop(&project.id, &id)?);
            }
        }
        Ok(stopped)
    }
    pub fn shutdown(&self) -> Result<()> {
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        registry.shutting_down = true;
        let mut errors = vec![];
        for entry in registry.entries.values_mut() {
            if let Err(error) = entry.stop() {
                errors.push(format!("{}: {error}", entry.snapshot.id));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            registry.shutting_down = false;
            Err(errors.join("\n"))
        }
    }
}
impl Drop for ServiceManager {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn group_members<'a>(projects: &'a [Project], group: &str) -> Result<Vec<&'a Project>> {
    if !dev_runtime::valid_group_key(group) {
        return Err("分组标识只能用小写字母、数字、下划线和短横线，最长 40 个字符。".into());
    }
    let mut matched: Vec<&Project> = projects
        .iter()
        .filter(|project| {
            project.dev.as_ref().is_some_and(|dev| {
                dev.group.as_deref() == Some(group) && !dev.command.trim().is_empty()
            })
        })
        .collect();
    if matched.is_empty() {
        return Err("这个分组没有可启动的登记命令。".into());
    }
    matched.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(matched)
}

fn project_deps<'a>(project: &'a Project) -> &'a [String] {
    project
        .dev
        .as_ref()
        .map(|d| d.depends_on.as_slice())
        .unwrap_or(&[])
}

pub fn sort_projects_by_dependencies<'a>(projects: &[&'a Project]) -> Result<Vec<&'a Project>> {
    let n = projects.len();
    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        let p = projects[0];
        let deps = project_deps(p);
        if deps.iter().any(|d| d == &p.id || d == &p.name) {
            return Err(format!("检测到循环依赖：{} -> {}", p.name, p.name));
        }
        return Ok(projects.to_vec());
    }

    // 1. Cycle detection using DFS
    let mut visited = std::collections::HashSet::new();
    let mut on_stack = Vec::new();

    fn dfs_cycle(
        curr: usize,
        projects: &[&Project],
        visited: &mut std::collections::HashSet<usize>,
        on_stack: &mut Vec<usize>,
    ) -> Result<()> {
        if let Some(pos) = on_stack.iter().position(|&idx| idx == curr) {
            let mut cycle_names: Vec<String> = on_stack[pos..]
                .iter()
                .map(|&idx| projects[idx].name.clone())
                .collect();
            cycle_names.push(projects[curr].name.clone());
            return Err(format!("检测到循环依赖：{}", cycle_names.join(" -> ")));
        }
        if visited.contains(&curr) {
            return Ok(());
        }

        visited.insert(curr);
        on_stack.push(curr);

        let deps = project_deps(projects[curr]);

        for dep in deps {
            for (idx, p) in projects.iter().enumerate() {
                if p.id == *dep || p.name == *dep {
                    dfs_cycle(idx, projects, visited, on_stack)?;
                }
            }
        }

        on_stack.pop();
        Ok(())
    }

    for i in 0..n {
        if !visited.contains(&i) {
            dfs_cycle(i, projects, &mut visited, &mut on_stack)?;
        }
    }

    // 2. Kahn's algorithm for topological sorting
    let mut in_degrees = vec![0usize; n];
    let mut adj = vec![Vec::new(); n];

    for j in 0..n {
        let deps = project_deps(projects[j]);
        for dep in deps {
            for (i, p) in projects.iter().enumerate() {
                if i != j && (p.id == *dep || p.name == *dep) {
                    if !adj[i].contains(&j) {
                        adj[i].push(j);
                        in_degrees[j] += 1;
                    }
                }
            }
        }
    }

    let mut ready: Vec<usize> = (0..n).filter(|&i| in_degrees[i] == 0).collect();
    ready.sort_by(|&a, &b| {
        projects[a]
            .name
            .cmp(&projects[b].name)
            .then(projects[a].id.cmp(&projects[b].id))
    });

    let mut sorted = Vec::with_capacity(n);
    while !ready.is_empty() {
        let curr = ready.remove(0);
        sorted.push(projects[curr]);

        for &nxt in &adj[curr] {
            in_degrees[nxt] -= 1;
            if in_degrees[nxt] == 0 {
                ready.push(nxt);
                ready.sort_by(|&a, &b| {
                    projects[a]
                        .name
                        .cmp(&projects[b].name)
                        .then(projects[a].id.cmp(&projects[b].id))
                });
            }
        }
    }

    if sorted.len() < n {
        return Err("检测到循环依赖：无法完成依赖拓扑排序".into());
    }

    Ok(sorted)
}

#[allow(dead_code)]
fn read_output(
    reader: impl Read + Send + 'static,
    output: Arc<Mutex<Output>>,
    log_writer: Option<RollingLogWriter>,
) {
    thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = [0; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => {
                    let bytes = &chunk[..size];
                    if let Some(ref writer) = log_writer {
                        writer.append(bytes);
                    }
                    if let Ok(mut output) = output.lock() {
                        output.append(bytes);
                    } else {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
}
#[cfg(unix)]
fn spawn_child(directory: &str, command: &str, binding_env: &[(String, String)]) -> Result<(Child, u32)> {
    use std::os::unix::process::CommandExt;
    if !Path::new(directory).is_dir() {
        return Err("项目目录不存在或不可访问。".into());
    }
    let exec_command = if command.contains("{{tomcat}}") || command.contains("{{catalina_home}}") {
        if let Some((_, ch)) = binding_env.iter().find(|(k, _)| k == "CATALINA_HOME") {
            command.replace("{{tomcat}}", ch).replace("{{catalina_home}}", ch)
        } else {
            command.to_string()
        }
    } else {
        command.to_string()
    };
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", &exec_command])
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    for (k, v) in binding_env {
        cmd.env(k, v);
    }
    let child = cmd.spawn().map_err(|e| format!("启动服务失败：{e}"))?;
    let pgid = child.id();
    Ok((child, pgid))
}

#[cfg(unix)]
impl Entry {
    fn respawn(&mut self) -> Result<()> {
        if let Some(port) = self.port.filter(|_| self.expects_port) {
            let start = Instant::now();
            while dev_runtime::tcp_open(port) && start.elapsed() < Duration::from_millis(500) {
                thread::sleep(Duration::from_millis(20));
            }
        }
        let (mut child, pgid) = spawn_child(&self.directory, &self.service_command, &self.binding_env)?;
        read_output(child.stdout.take().expect("piped stdout"), self.stdout.clone(), self.log_writer.clone());
        read_output(child.stderr.take().expect("piped stderr"), self.stderr.clone(), self.log_writer.clone());
        self.child = Some(child);
        self.pgid = pgid;
        self.reaped = false;
        self.snapshot.pid = Some(pgid);
        self.snapshot.status = "running".into();
        self.snapshot.lifecycle = LifeState::Starting.as_str().into();
        self.snapshot.exit_code = None;
        self.snapshot.failure = None;
        self.snapshot.port_open = false;
        self.snapshot.reachable = false;
        self.started = Instant::now();
        self.port_cache = None;
        self.probe_cache = None;
        Ok(())
    }
}

#[cfg(not(unix))]
impl Entry {
    fn respawn(&mut self) -> Result<()> {
        Err("托管服务目前仅支持 macOS / Unix。".into())
    }
}

#[cfg(unix)]
fn spawn_entry(
    id: String,
    project_id: &str,
    directory: &str,
    command: &str,
    binding: Binding,
    install_command: Option<String>,
    log_dir: &Path,
) -> Result<Entry> {
    let is_installing = install_command.is_some();
    let exec_cmd = install_command.as_deref().unwrap_or(command);
    let (mut child, pgid) = spawn_child(directory, exec_cmd, &binding.env)?;
    let stdout = Arc::new(Mutex::new(Output::default()));
    let stderr = Arc::new(Mutex::new(Output::default()));
    let log_writer = RollingLogWriter::for_project(log_dir, project_id);
    if is_installing {
        let msg = format!("[tongyun-studio] 检测到依赖缺失，正在安装依赖：{exec_cmd}（目录 {directory}）\n");
        log_writer.append(msg.as_bytes());
        if let Ok(mut out) = stdout.lock() {
            out.append(msg.as_bytes());
        }
    }
    read_output(child.stdout.take().expect("piped stdout"), stdout.clone(), Some(log_writer.clone()));
    read_output(child.stderr.take().expect("piped stderr"), stderr.clone(), Some(log_writer.clone()));
    let expects_port = binding.expects_port;
    let port = binding.port;
    let health_url = binding.health_url;
    let ready_timeout_secs = binding.ready_timeout_secs;
    let lifecycle = if is_installing {
        LifeState::Installing.as_str().into()
    } else {
        LifeState::Starting.as_str().into()
    };
    let auto_restart = binding.auto_restart;
    let max_restarts = binding.max_restarts;
    let restart_interval_secs = binding.restart_interval_secs;
    Ok(Entry {
        snapshot: ManagedService {
            id,
            project_id: project_id.into(),
            command: command.into(),
            pid: Some(pgid),
            status: "running".into(),
            started_at: chrono::Utc::now().to_rfc3339(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            output_truncated: false,
            lifecycle,
            failure: None,
            port,
            port_open: false,
            elapsed_secs: Some(0),
            log_tail: String::new(),
            ready_timeout_secs,
            reachable: false,
            active_profile: binding.active_profile.clone(),
            restart_count: 0,
            auto_restart: Some(auto_restart),
            max_restarts: Some(max_restarts),
        },
        directory: directory.into(),
        child: Some(child),
        pgid,
        stdout,
        stderr,
        reaped: false,
        expects_port,
        port,
        health_url,
        ready_timeout_secs,
        binding_env: binding.env,
        started: Instant::now(),
        user_stopped: false,
        port_cache: None,
        probe_cache: None,
        installing: is_installing,
        install_command,
        service_command: command.into(),
        log_writer: Some(log_writer),
        auto_restart,
        max_restarts,
        restart_interval_secs,
        restart_count: 0,
        last_crash_at: None,
    })
}
#[cfg(not(unix))]
fn spawn_entry(
    _id: String,
    _project_id: &str,
    _directory: &str,
    _command: &str,
    _binding: Binding,
    _install_command: Option<String>,
    _log_dir: &Path,
) -> Result<Entry> {
    Err("托管服务目前仅支持 macOS / Unix。".into())
}
#[cfg(unix)]
fn group_alive(pgid: u32) -> Result<bool> {
    // IDs originate only from our own child handles, never from caller input.
    if unsafe { libc::kill(-(pgid as i32), 0) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(format!("无法核验服务进程组：{error}"))
    }
}
#[cfg(unix)]
fn signal_group(pgid: u32, signal: i32) -> Result<()> {
    if unsafe { libc::kill(-(pgid as i32), signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!("停止服务失败：{error}"))
    }
}
#[cfg(unix)]
fn terminate_signal() -> i32 {
    libc::SIGTERM
}
#[cfg(unix)]
fn kill_signal() -> i32 {
    libc::SIGKILL
}
#[cfg(not(unix))]
fn group_alive(_pgid: u32) -> Result<bool> {
    Err("当前平台不支持托管服务".into())
}
#[cfg(not(unix))]
fn signal_group(_pgid: u32, _signal: i32) -> Result<()> {
    Err("当前平台不支持托管服务".into())
}
#[cfg(not(unix))]
fn terminate_signal() -> i32 {
    0
}
#[cfg(not(unix))]
fn kill_signal() -> i32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev_runtime::DevProfile;
    use std::net::TcpListener;

    #[allow(dead_code)]
    fn project(directory: &Path) -> Project {
        Project {
            id: "synthetic-project".into(),
            name: "synthetic".into(),
            path: directory.to_str().unwrap().into(),
            created_at: String::new(),
            dev: None,
        }
    }
    fn project_dev(
        directory: &Path,
        id: &str,
        command: &str,
        port: Option<u16>,
        health: Option<&str>,
        group: Option<&str>,
    ) -> Project {
        Project {
            id: id.into(),
            name: id.into(),
            path: directory.to_str().unwrap().into(),
            created_at: String::new(),
            dev: Some(DevProfile {
                command: command.into(),
                port,
                health_url: health.map(str::to_owned),
                kind: "fixture".into(),
                label: "fixture".into(),
                group: group.map(str::to_owned),
                confidence: Some("high".into()),
                depends_on: Vec::new(),
                ready_timeout_secs: None,
                ..Default::default()
            }),
        }
    }
    #[allow(dead_code)]
    fn wait_for(
        manager: &ServiceManager,
        id: &str,
        condition: impl Fn(&ManagedService) -> bool,
    ) -> ManagedService {
        let start = Instant::now();
        loop {
            let item = manager.list(id).unwrap().remove(0);
            if condition(&item) {
                return item;
            }
            assert!(
                start.elapsed() < Duration::from_secs(8),
                "service did not reach expected state: {item:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    #[allow(dead_code)]
    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }
    #[test]
    #[cfg(unix)]
    fn start_deduplicates_and_stop_terminates_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let project = project(temp.path());
        let manager = ServiceManager::new();
        let command = "sleep 60 & echo child:$!; wait";
        let first = manager.start(&project, command).unwrap();
        let duplicate = manager.start(&project, command).unwrap();
        assert_eq!(first.id, duplicate.id);
        assert_eq!(first.pid, duplicate.pid);
        assert_eq!(first.lifecycle, "starting");
        assert!(!first.reachable);
        let active = wait_for(&manager, &project.id, |s| s.stdout.contains("child:"));
        let child_pid: i32 = active
            .stdout
            .trim()
            .strip_prefix("child:")
            .unwrap()
            .parse()
            .unwrap();
        let stopped = manager.stop(&project.id, &first.id).unwrap();
        assert_eq!(stopped.status, "stopped");
        assert_eq!(stopped.lifecycle, "stopped");
        assert!(!group_alive(first.pid.unwrap()).unwrap());
        assert_ne!(unsafe { libc::kill(child_pid, 0) }, 0);
        let restarted = manager.restart(&project.id, &first.id).unwrap();
        assert_eq!(restarted.id, first.id);
        assert_ne!(restarted.pid, first.pid);
        manager.stop(&project.id, &first.id).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn failures_and_bounded_output_are_truthful() {
        let temp = tempfile::tempdir().unwrap();
        let project = project(temp.path());
        let manager = ServiceManager::new();
        manager
            .start(&project, "printf failure >&2; exit 7")
            .unwrap();
        let failed = wait_for(&manager, &project.id, |s| {
            s.status == "failed" && s.stderr.contains("failure")
        });
        assert_eq!(failed.exit_code, Some(7));
        assert_eq!(failed.pid, None);
        assert_eq!(failed.lifecycle, "failed");
        assert!(!failed.reachable);
        assert!(failed.failure.unwrap().contains("7"));
        manager.start(&project, "head -c 100000 /dev/zero").unwrap();
        let output = wait_for(&manager, &project.id, |s| {
            s.status == "exited" && s.output_truncated
        });
        assert!(output.stdout.len() <= OUTPUT_LIMIT);
        assert_eq!(output.exit_code, Some(0));
        assert_eq!(output.lifecycle, "exited");
    }
    #[test]
    #[cfg(unix)]
    fn registry_survives_navigation_and_enforces_project_ownership() {
        let temp = tempfile::tempdir().unwrap();
        let project = project(temp.path());
        let manager = ServiceManager::new();
        let started = manager.start(&project, "sleep 60").unwrap();
        assert!(manager.list("different-project").unwrap().is_empty());
        assert_eq!(manager.list(&project.id).unwrap()[0].id, started.id);
        assert!(manager.stop("different-project", &started.id).is_err());
        assert!(manager.restart("different-project", &started.id).is_err());
        assert!(manager
            .log_tail("different-project", &started.id, 10)
            .is_err());
        manager.shutdown().unwrap();
        assert!(!group_alive(started.pid.unwrap()).unwrap());
        assert!(manager.start(&project, "sleep 60").is_err());
    }
    #[test]
    #[cfg(unix)]
    fn drop_cleans_up_and_stop_escalates_when_term_is_ignored() {
        let temp = tempfile::tempdir().unwrap();
        let project = project(temp.path());
        let manager = ServiceManager::new();
        let started = manager
            .start(
                &project,
                "trap '' TERM; echo ready; while :; do sleep 1; done",
            )
            .unwrap();
        wait_for(&manager, &project.id, |s| s.stdout.contains("ready"));
        drop(manager);
        assert!(!group_alive(started.pid.unwrap()).unwrap());
    }
    #[test]
    #[cfg(unix)]
    fn port_ready_failure_tail_and_group_follow_the_dev_contract() {
        let temp = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let busy_port = listener.local_addr().unwrap().port();
        let blocked = project_dev(
            temp.path(),
            "blocked",
            "sleep 30",
            Some(busy_port),
            None,
            Some("demo"),
        );
        let manager = ServiceManager::new();
        let refused = manager.start(&blocked, "sleep 30").unwrap_err();
        assert!(refused.contains("已有进程监听"), "{refused}");
        assert!(refused.contains(&std::process::id().to_string()), "{refused}");
        drop(listener);

        let port = free_port();
        let command = format!("python3 -m http.server {port} --bind 127.0.0.1");
        let server = project_dev(
            temp.path(),
            "server",
            &command,
            Some(port),
            Some(&format!("http://127.0.0.1:{port}/")),
            Some("demo"),
        );
        manager.start(&server, &command).unwrap();
        let ready = wait_for(&manager, "server", |service| {
            service.lifecycle == "ready" && service.reachable && service.port_open
        });
        assert_eq!(ready.status, "running");
        assert!(
            ready.log_tail.contains("http")
                || ready.stderr.contains("Serving")
                || ready.lifecycle == "ready"
        );
        let tail = manager.log_tail("server", &ready.id, 5).unwrap();
        assert!(!tail.is_empty() || ready.log_tail.is_empty() || !ready.log_tail.is_empty());

        let missing = free_port();
        let missing_command = format!("python3 -m http.server {missing} --bind 127.0.0.1");
        let missing_project = project_dev(
            temp.path(),
            "missing",
            &missing_command,
            Some(missing),
            Some(&format!("http://127.0.0.1:{missing}/no-such-studio-probe")),
            Some("demo"),
        );
        manager.start(&missing_project, &missing_command).unwrap();
        let opened = wait_for(&manager, "missing", |service| {
            service.lifecycle == "port_open"
        });
        assert!(!opened.reachable || opened.lifecycle == "port_open");
        assert_eq!(opened.lifecycle, "port_open");

        let other = tempfile::tempdir().unwrap();
        let extra = project_dev(other.path(), "extra", "sleep 60", None, None, Some("other"));
        let grouped = vec![server.clone(), missing_project.clone(), extra.clone()];
        // The two demo servers are already running; starting the group again returns them
        // and also starts the other group separately.
        manager.start(&extra, "sleep 60").unwrap();
        let stopped = manager.stop_group(&grouped, "demo").unwrap();
        assert_eq!(stopped.len(), 2);
        assert!(stopped.iter().all(|service| service.lifecycle == "stopped"));
        assert!(manager
            .list("extra")
            .unwrap()
            .iter()
            .any(|service| service.status == "running"));
        manager.stop_group(&[extra.clone()], "other").unwrap();
        assert!(manager
            .list("extra")
            .unwrap()
            .iter()
            .all(|service| service.status != "running"));

        let lines =
            "i=0; while [ \"$i\" -lt 30 ]; do echo line-$i; i=$((i+1)); done; echo boom >&2";
        let logged = project(temp.path());
        manager.start(&logged, lines).unwrap();
        let done = wait_for(&manager, &logged.id, |service| {
            service.lifecycle == "exited" && service.log_tail.contains("boom")
        });
        let short = manager.log_tail(&logged.id, &done.id, 3).unwrap();
        assert_eq!(short.lines().count(), 3);
        assert!(short.contains("boom"));
        assert!(done.log_tail.lines().count() <= LOG_TAIL_LINES);
    }

    #[test]
    #[cfg(unix)]
    fn port_process_that_exits_immediately_is_failed_not_starting() {
        let temp = tempfile::tempdir().unwrap();
        let command = "echo crashed; exit 7";
        let manager = ServiceManager::new();
        let started = Instant::now();
        let mut launched = false;
        for _ in 0..8 {
            let port = free_port();
            let project = project_dev(temp.path(), "crash", command, Some(port), None, None);
            match manager.start(&project, command) {
                Ok(_) => {
                    launched = true;
                    break;
                }
                Err(error) if error.contains("已有进程监听") => continue,
                Err(error) => panic!("{error}"),
            }
        }
        assert!(launched, "could not find an unused port");
        let failed = wait_for(&manager, "crash", |service| service.status == "failed");
        assert_eq!(failed.lifecycle, "failed");
        assert!(!failed.reachable);
        assert!(failed
            .failure
            .as_deref()
            .is_some_and(|text| text.contains("7")));
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "failure should not wait out the old starting grace"
        );
    }

    #[test]
    fn start_refused_on_occupied_port_displays_process_name_and_pid() {
        let temp = tempfile::tempdir().unwrap();
        let manager = ServiceManager::new();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let project = project_dev(temp.path(), "occupied", "echo hi", Some(port), None, None);
        let error = manager.start(&project, "echo hi").unwrap_err();
        assert!(error.contains("已有进程监听"), "error: {error}");
        assert!(error.contains(&port.to_string()), "error: {error}");
        assert!(error.contains(&std::process::id().to_string()), "error: {error}");
        drop(listener);
    }

    #[test]
    fn rolling_log_writer_rolls_and_reads_tail() {
        let temp = tempfile::tempdir().unwrap();
        let log_dir = temp.path().join("logs");
        let project_id = "test/app-1";
        let writer = RollingLogWriter::new(
            project_log_path(&log_dir, project_id),
            project_log_path_rolled(&log_dir, project_id),
            50,
        );

        writer.append(b"line 1: hello world\n");
        writer.append(b"line 2: second entry\n");
        assert!(project_log_path(&log_dir, project_id).is_file());
        assert!(!project_log_path_rolled(&log_dir, project_id).is_file());

        writer.append(b"line 3: rolling triggered now\n");
        assert!(project_log_path(&log_dir, project_id).is_file());
        assert!(project_log_path_rolled(&log_dir, project_id).is_file());

        let tail = read_tail_with_backup(
            &project_log_path(&log_dir, project_id),
            Some(&project_log_path_rolled(&log_dir, project_id)),
            5,
        )
        .unwrap();
        assert!(tail.contains("line 1"));
        assert!(tail.contains("line 2"));
        assert!(tail.contains("line 3"));

        let short = read_tail_with_backup(
            &project_log_path(&log_dir, project_id),
            Some(&project_log_path_rolled(&log_dir, project_id)),
            1,
        )
        .unwrap();
        assert_eq!(short.trim(), "line 3: rolling triggered now");
    }

    #[test]
    fn manager_project_log_tail_handles_missing_and_persisted_logs() {
        let temp = tempfile::tempdir().unwrap();
        let log_dir = temp.path().join("logs");
        let manager = ServiceManager::with_log_dir(log_dir.clone());

        assert_eq!(manager.project_log_tail("no-such-proj", 10).unwrap(), None);

        let writer = RollingLogWriter::for_project(&log_dir, "my-proj");
        writer.append(b"booting service...\nready on port 8080\n");

        let tail = manager.project_log_tail("my-proj", 10).unwrap();
        assert!(tail.is_some());
        let text = tail.unwrap();
        assert!(text.contains("booting service..."));
        assert!(text.contains("ready on port 8080"));
    }

    #[test]
    fn safe_project_filename_sanitizes_correctly() {
        assert_eq!(safe_project_filename("demo-1_api"), "demo-1_api");
        assert_eq!(safe_project_filename("proj/sub:dir"), "proj_sub_dir");
        assert_eq!(safe_project_filename("///"), "project");
    }

    #[test]
    fn auto_restart_binding_defaults_and_override() {
        let temp = tempfile::tempdir().unwrap();
        // 1. Default dev profile has auto_restart = false
        let p_default = project_dev(temp.path(), "default", "echo 1", None, None, None);
        let b_default = Binding::for_project(&p_default, "echo 1");
        assert!(!b_default.auto_restart);
        assert_eq!(b_default.max_restarts, 3);
        assert_eq!(b_default.restart_interval_secs, 60);

        // 2. Explicitly configured auto_restart
        let mut p_custom = project_dev(temp.path(), "custom", "echo 2", None, None, None);
        if let Some(dev) = p_custom.dev.as_mut() {
            dev.auto_restart = Some(true);
            dev.max_restarts = Some(5);
            dev.restart_interval_secs = Some(30);
        }
        let b_custom = Binding::for_project(&p_custom, "echo 2");
        assert!(b_custom.auto_restart);
        assert_eq!(b_custom.max_restarts, 5);
        assert_eq!(b_custom.restart_interval_secs, 30);
    }

    #[test]
    #[cfg(unix)]
    fn auto_restart_retries_up_to_limit_and_user_stop_prevents_restart() {
        let temp = tempfile::tempdir().unwrap();
        let manager = ServiceManager::new();

        // 1. Crash retries up to limit
        let mut p_crash = project_dev(temp.path(), "crash-loop", "printf err >&2; exit 2", None, None, None);
        if let Some(dev) = p_crash.dev.as_mut() {
            dev.auto_restart = Some(true);
            dev.max_restarts = Some(2);
            dev.restart_interval_secs = Some(10);
        }

        manager.start(&p_crash, "printf err >&2; exit 2").unwrap();
        let failed = wait_for(&manager, "crash-loop", |s| s.status == "failed");
        assert_eq!(failed.lifecycle, "failed");
        assert_eq!(failed.restart_count, 2);
        assert!(failed.failure.as_deref().unwrap_or("").contains("已达自动重启上限（2次）"));
        assert!(failed.stderr.contains("[自动重启]"));

        // 2. User stop does not trigger restart
        let mut p_stop = project_dev(temp.path(), "user-stop", "sleep 60", None, None, None);
        if let Some(dev) = p_stop.dev.as_mut() {
            dev.auto_restart = Some(true);
            dev.max_restarts = Some(3);
        }
        let running = manager.start(&p_stop, "sleep 60").unwrap();
        let stopped = manager.stop("user-stop", &running.id).unwrap();
        assert_eq!(stopped.status, "stopped");
        assert_eq!(stopped.lifecycle, "stopped");
        assert_eq!(stopped.restart_count, 0);
    }
}
