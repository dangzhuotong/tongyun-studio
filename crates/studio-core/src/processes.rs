//! App-owned, non-detached command processes. Dropping the manager stops its process groups.
//! Service records survive tab/project navigation, but are intentionally not restored after App exit.
use crate::{Project, Result};
use serde::Serialize;
use std::{collections::BTreeMap, io::Read, path::Path, process::{Child, Command, Stdio}, sync::{Arc, Mutex}, thread, time::{Duration, Instant}};

const OUTPUT_LIMIT: usize = 64 * 1024;
const SERVICE_LIMIT: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedService {
    pub id: String,
    pub project_id: String,
    pub command: String,
    pub pid: Option<u32>,
    pub status: String,
    pub started_at: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub output_truncated: bool,
}

#[derive(Default)]
struct Output { bytes: Vec<u8>, truncated: bool }
impl Output {
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
    child: Child,
    pgid: u32,
    stdout: Arc<Mutex<Output>>,
    stderr: Arc<Mutex<Output>>,
    reaped: bool,
}
impl Entry {
    fn refresh(&mut self) -> Result<()> {
        if self.snapshot.status != "running" { return Ok(()); }
        if !self.reaped {
            if let Some(status) = self.child.try_wait().map_err(|e| format!("读取服务进程失败：{e}"))? {
                self.reaped = true;
                self.snapshot.exit_code = status.code();
            }
        }
        if self.reaped && !group_alive(self.pgid)? {
            self.snapshot.pid = None;
            self.snapshot.status = if self.snapshot.exit_code == Some(0) { "exited" } else { "failed" }.into();
        }
        Ok(())
    }
    fn snapshot(&self) -> ManagedService {
        let mut snapshot = self.snapshot.clone();
        if let Ok(output) = self.stdout.lock() { snapshot.stdout = String::from_utf8_lossy(&output.bytes).into_owned(); snapshot.output_truncated |= output.truncated; }
        if let Ok(output) = self.stderr.lock() { snapshot.stderr = String::from_utf8_lossy(&output.bytes).into_owned(); snapshot.output_truncated |= output.truncated; }
        snapshot
    }
    fn stop(&mut self) -> Result<()> {
        self.refresh()?;
        if self.snapshot.status != "running" { return Ok(()); }
        signal_group(self.pgid, terminate_signal())?;
        if !self.wait_stopped(Duration::from_millis(1000))? {
            signal_group(self.pgid, kill_signal())?;
            if !self.wait_stopped(Duration::from_secs(2))? { return Err("服务进程组仍存在，未确认停止；请重试。".into()); }
        }
        self.snapshot.pid = None;
        self.snapshot.status = "stopped".into();
        Ok(())
    }
    fn wait_stopped(&mut self, budget: Duration) -> Result<bool> {
        let start = Instant::now();
        loop {
            self.refresh()?;
            if self.snapshot.status != "running" { return Ok(true); }
            if start.elapsed() >= budget { return Ok(false); }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
#[derive(Default)]
struct Registry { entries: BTreeMap<String, Entry>, shutting_down: bool }
#[derive(Default)]
pub struct ServiceManager { registry: Mutex<Registry> }
impl ServiceManager {
    pub fn new() -> Self { Self::default() }
    pub fn start(&self, project: &Project, command: &str) -> Result<ManagedService> {
        let command = command.trim();
        if command.is_empty() || command.len() > 8192 || command.contains('\0') { return Err("命令为空、过长或包含无效字符。".into()); }
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        if registry.shutting_down { return Err("工作台正在退出，不能启动服务。".into()); }
        for entry in registry.entries.values_mut() {
            if entry.snapshot.project_id == project.id && entry.snapshot.command == command {
                entry.refresh()?;
                if entry.snapshot.status == "running" { return Ok(entry.snapshot()); }
            }
        }
        // Reuse the same service identity when the same project command is run again.
        let existing = registry.entries.values().find(|entry| entry.snapshot.project_id == project.id && entry.snapshot.command == command).map(|entry| entry.snapshot.id.clone());
        if existing.is_none() && registry.entries.len() >= SERVICE_LIMIT { return Err("本次工作台已记录 64 个命令。请停止服务并重启工作台后继续。".into()); }
        let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let entry = spawn_entry(id.clone(), &project.id, &project.path, command)?;
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
            if entry.snapshot.project_id == project_id { services.push(entry.snapshot()); }
        }
        services.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(services)
    }
    pub fn stop(&self, project_id: &str, service_id: &str) -> Result<ManagedService> {
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        let entry = registry.entries.get_mut(service_id).ok_or("服务记录不存在")?;
        if entry.snapshot.project_id != project_id { return Err("服务不属于当前项目".into()); }
        entry.stop()?;
        Ok(entry.snapshot())
    }
    pub fn restart(&self, project_id: &str, service_id: &str) -> Result<ManagedService> {
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        if registry.shutting_down { return Err("工作台正在退出，不能重启服务。".into()); }
        let old = registry.entries.get_mut(service_id).ok_or("服务记录不存在")?;
        if old.snapshot.project_id != project_id { return Err("服务不属于当前项目".into()); }
        old.stop()?; // Never start a replacement before stopping the entire old group.
        let entry = spawn_entry(service_id.to_owned(), project_id, &old.directory, &old.snapshot.command)?;
        let snapshot = entry.snapshot();
        registry.entries.insert(service_id.to_owned(), entry);
        Ok(snapshot)
    }
    pub fn shutdown(&self) -> Result<()> {
        let mut registry = self.registry.lock().map_err(|_| "服务记录锁不可用")?;
        registry.shutting_down = true;
        let mut errors = vec![];
        for entry in registry.entries.values_mut() {
            if let Err(error) = entry.stop() { errors.push(format!("{}: {error}", entry.snapshot.id)); }
        }
        if errors.is_empty() { Ok(()) } else { registry.shutting_down = false; Err(errors.join("\n")) }
    }
}
impl Drop for ServiceManager { fn drop(&mut self) { let _ = self.shutdown(); } }

fn read_output(reader: impl Read + Send + 'static, output: Arc<Mutex<Output>>) {
    thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = [0; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => if let Ok(mut output) = output.lock() { output.append(&chunk[..size]); } else { break; },
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
}
#[cfg(unix)]
fn spawn_entry(id: String, project_id: &str, directory: &str, command: &str) -> Result<Entry> {
    use std::os::unix::process::CommandExt;
    if !Path::new(directory).is_dir() { return Err("项目目录不存在或不可访问。".into()); }
    let mut child = Command::new("/bin/sh").args(["-c", command]).current_dir(directory)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .process_group(0).spawn().map_err(|e| format!("启动服务失败：{e}"))?;
    let pgid = child.id();
    let stdout = Arc::new(Mutex::new(Output::default()));
    let stderr = Arc::new(Mutex::new(Output::default()));
    read_output(child.stdout.take().expect("piped stdout"), stdout.clone());
    read_output(child.stderr.take().expect("piped stderr"), stderr.clone());
    Ok(Entry { snapshot: ManagedService { id, project_id: project_id.into(), command: command.into(), pid: Some(pgid), status: "running".into(), started_at: chrono::Utc::now().to_rfc3339(), exit_code: None, stdout: String::new(), stderr: String::new(), output_truncated: false }, directory: directory.into(), child, pgid, stdout, stderr, reaped: false })
}
#[cfg(not(unix))]
fn spawn_entry(_id: String, _project_id: &str, _directory: &str, _command: &str) -> Result<Entry> { Err("托管服务目前仅支持 macOS / Unix。".into()) }
#[cfg(unix)]
fn group_alive(pgid: u32) -> Result<bool> {
    // IDs originate only from our own child handles, never from caller input.
    if unsafe { libc::kill(-(pgid as i32), 0) } == 0 { return Ok(true); }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) { Ok(false) } else { Err(format!("无法核验服务进程组：{error}")) }
}
#[cfg(unix)]
fn signal_group(pgid: u32, signal: i32) -> Result<()> {
    if unsafe { libc::kill(-(pgid as i32), signal) } == 0 { return Ok(()); }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) { Ok(()) } else { Err(format!("停止服务失败：{error}")) }
}
#[cfg(unix)] fn terminate_signal() -> i32 { libc::SIGTERM }
#[cfg(unix)] fn kill_signal() -> i32 { libc::SIGKILL }
#[cfg(not(unix))] fn group_alive(_pgid: u32) -> Result<bool> { Err("当前平台不支持托管服务".into()) }
#[cfg(not(unix))] fn signal_group(_pgid: u32, _signal: i32) -> Result<()> { Err("当前平台不支持托管服务".into()) }
#[cfg(not(unix))] fn terminate_signal() -> i32 { 0 }
#[cfg(not(unix))] fn kill_signal() -> i32 { 0 }

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn project(directory: &Path) -> Project { Project { id: "synthetic-project".into(), name: "synthetic".into(), path: directory.to_str().unwrap().into(), created_at: String::new() } }
    fn wait_for(manager: &ServiceManager, id: &str, condition: impl Fn(&ManagedService) -> bool) -> ManagedService {
        let start = Instant::now();
        loop { let item = manager.list(id).unwrap().remove(0); if condition(&item) { return item; } assert!(start.elapsed() < Duration::from_secs(5), "service did not reach expected state: {item:?}"); thread::sleep(Duration::from_millis(20)); }
    }
    #[test]
    fn start_deduplicates_and_stop_terminates_descendants() {
        let temp = tempfile::tempdir().unwrap(); let project = project(temp.path()); let manager = ServiceManager::new();
        let command = "sleep 60 & echo child:$!; wait";
        let first = manager.start(&project, command).unwrap();
        let duplicate = manager.start(&project, command).unwrap();
        assert_eq!(first.id, duplicate.id); assert_eq!(first.pid, duplicate.pid);
        let active = wait_for(&manager, &project.id, |s| s.stdout.contains("child:"));
        let child_pid: i32 = active.stdout.trim().strip_prefix("child:").unwrap().parse().unwrap();
        let stopped = manager.stop(&project.id, &first.id).unwrap();
        assert_eq!(stopped.status, "stopped"); assert!(!group_alive(first.pid.unwrap()).unwrap());
        assert_ne!(unsafe { libc::kill(child_pid, 0) }, 0);
        let restarted = manager.restart(&project.id, &first.id).unwrap();
        assert_eq!(restarted.id, first.id); assert_ne!(restarted.pid, first.pid);
        manager.stop(&project.id, &first.id).unwrap();
    }
    #[test]
    fn failures_and_bounded_output_are_truthful() {
        let temp = tempfile::tempdir().unwrap(); let project = project(temp.path()); let manager = ServiceManager::new();
        manager.start(&project, "printf failure >&2; exit 7").unwrap();
        let failed = wait_for(&manager, &project.id, |s| s.status == "failed" && s.stderr.contains("failure"));
        assert_eq!(failed.exit_code, Some(7)); assert_eq!(failed.pid, None);
        manager.start(&project, "head -c 100000 /dev/zero").unwrap();
        let output = wait_for(&manager, &project.id, |s| s.status == "exited" && s.output_truncated);
        assert!(output.stdout.len() <= OUTPUT_LIMIT); assert_eq!(output.exit_code, Some(0));
    }
    #[test]
    fn registry_survives_navigation_and_enforces_project_ownership() {
        let temp = tempfile::tempdir().unwrap(); let project = project(temp.path()); let manager = ServiceManager::new();
        let started = manager.start(&project, "sleep 60").unwrap();
        assert!(manager.list("different-project").unwrap().is_empty());
        assert_eq!(manager.list(&project.id).unwrap()[0].id, started.id);
        assert!(manager.stop("different-project", &started.id).is_err());
        assert!(manager.restart("different-project", &started.id).is_err());
        manager.shutdown().unwrap();
        assert!(!group_alive(started.pid.unwrap()).unwrap());
        assert!(manager.start(&project, "sleep 60").is_err());
    }
    #[test]
    fn drop_cleans_up_and_stop_escalates_when_term_is_ignored() {
        let temp = tempfile::tempdir().unwrap(); let project = project(temp.path()); let manager = ServiceManager::new();
        let started = manager.start(&project, "trap '' TERM; echo ready; while :; do sleep 1; done").unwrap();
        wait_for(&manager, &project.id, |s| s.stdout.contains("ready"));
        drop(manager);
        assert!(!group_alive(started.pid.unwrap()).unwrap());
    }
}
