//! Local workspace persistence, full-featured workbench operations, and project inspection.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, String>;

pub mod agent_http;
pub mod dev_runtime;
pub mod diagnostics;
pub mod processes;
pub mod toolchain;
pub use agent_http::{
    bind_from, is_studio_server, resolve_agent_port, start_agent_server, AgentHttpInfo,
    ServerHandle, DEFAULT_AGENT_PORT, DEFAULT_STUDIO_AGENT_PORT,
};
pub use dev_runtime::{
    format_port_occupied_error, port_occupants, port_occupied_error, scan_dev_directory,
    DevCandidate, DevProfile, DevScanReport, EnvPreset, ExistingProject, LifeState, PortOccupant,
    PreparedImport,
};
pub use diagnostics::{
    default_diagnostics_filename, export_diagnostics_to_file, export_diagnostics_to_writer,
    is_sensitive_key, sanitize_dev_profile, sanitize_env_map, sanitize_project, sanitize_text,
    DiagnosticMetadata, DiagnosticReport,
};
pub use processes::{
    default_log_dir, project_log_path, project_log_path_rolled, read_tail, read_tail_with_backup,
    safe_project_filename, ManagedService, RollingLogWriter, ServiceManager, MAX_LOG_FILE_BYTES,
};
pub use toolchain::{check_catalina_home, resolve_catalina_home, toolchain_env, HostOs, ToolchainError, ToolchainRoots};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
    /// Optional run profile discovered or confirmed from a directory scan.
    /// Absent on records created before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev: Option<DevProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub version: u32,
    pub projects: Vec<Project>,
    pub active_project_id: Option<String>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            version: 1,
            projects: vec![],
            active_project_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevImportOutcome {
    pub workspace: Workspace,
    pub added: usize,
    pub attached: usize,
    pub unchanged: usize,
}

pub struct WorkspaceStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl WorkspaceStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<Workspace> {
        let file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Workspace::default()),
            Err(e) => return Err(format!("无法读取项目记录：{e}")),
        };
        let value: serde_json::Value = serde_json::from_reader(file)
            .map_err(|e| format!("项目记录损坏，已保留原文件：{e}"))?;
        if value.get("version").and_then(|v| v.as_u64()) != Some(1) {
            return Err("项目记录版本不受支持，已保留原文件".into());
        }
        let workspace: Workspace = serde_json::from_value(value)
            .map_err(|e| format!("项目记录格式错误，已保留原文件：{e}"))?;
        let mut ids = std::collections::HashSet::new();
        let mut paths = std::collections::HashSet::new();
        for project in &workspace.projects {
            if project.id.is_empty()
                || !ids.insert(&project.id)
                || !Path::new(&project.path).is_absolute()
                || !paths.insert(&project.path)
            {
                return Err("项目记录存在无效或重复项目，已保留原文件".into());
            }
        }
        if workspace
            .active_project_id
            .as_ref()
            .is_some_and(|id| !ids.contains(id))
        {
            return Err("当前项目记录无效，已保留原文件".into());
        }
        Ok(workspace)
    }

    fn write(&self, workspace: &Workspace) -> Result<()> {
        let parent = self.path.parent().ok_or("项目记录路径无效")?;
        fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录：{e}"))?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(file.as_file_mut(), workspace).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(&self.path)
            .map_err(|e| format!("保存项目记录失败：{e}"))?;
        Ok(())
    }

    pub fn load(&self) -> Result<Workspace> {
        let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?;
        self.read()
    }

    pub fn add(&self, path: &str) -> Result<Workspace> {
        let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?;
        let mut workspace = self.read()?;
        let canonical = fs::canonicalize(path).map_err(|e| format!("无法访问目录：{e}"))?;
        if !canonical.is_dir() {
            return Err("请选择一个目录".into());
        }
        let path = canonical
            .to_str()
            .ok_or("目录路径不是有效的 Unicode")?
            .to_owned();
        if let Some(existing) = workspace.projects.iter().find(|p| p.path == path) {
            workspace.active_project_id = Some(existing.id.clone());
        } else {
            let project = Project {
                id: uuid::Uuid::new_v4().to_string(),
                name: canonical
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone()),
                path,
                created_at: chrono::Utc::now().to_rfc3339(),
                dev: None,
            };
            workspace.active_project_id = Some(project.id.clone());
            workspace.projects.push(project);
        }
        self.write(&workspace)?;
        Ok(workspace)
    }

    pub fn select(&self, id: &str) -> Result<Workspace> {
        let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?;
        let mut workspace = self.read()?;
        if !workspace.projects.iter().any(|p| p.id == id) {
            return Err("项目不存在".into());
        }
        workspace.active_project_id = Some(id.to_owned());
        self.write(&workspace)?;
        Ok(workspace)
    }

    pub fn remove(&self, id: &str) -> Result<Workspace> {
        let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?;
        let mut workspace = self.read()?;
        if !workspace.projects.iter().any(|p| p.id == id) {
            return Err("项目不存在".into());
        }
        workspace.projects.retain(|p| p.id != id);
        if workspace.active_project_id.as_deref() == Some(id) {
            workspace.active_project_id = workspace.projects.first().map(|p| p.id.clone());
        }
        self.write(&workspace)?;
        Ok(workspace)
    }

    /// Register scanned directories. Existing paths keep their id. A path that was
    /// registered without a run profile receives one; a path that already has a
    /// profile is left unchanged.
    pub fn import_dev_candidates(&self, candidates: &[DevCandidate]) -> Result<DevImportOutcome> {
        if candidates.len() > 64 {
            return Err("一次最多登记 64 个目录。".into());
        }
        let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?;
        let mut workspace = self.read()?;
        let prepared = candidates
            .iter()
            .map(dev_runtime::prepare_import)
            .collect::<Result<Vec<_>>>()?;
        let mut seen = std::collections::HashSet::new();
        for item in &prepared {
            if !seen.insert(item.path.clone()) {
                return Err("同一次登记里有重复目录。".into());
            }
        }
        let new_paths = prepared
            .iter()
            .filter(|item| {
                !workspace
                    .projects
                    .iter()
                    .any(|project| project.path == item.path)
            })
            .count();
        if workspace.projects.len() + new_paths > 200 {
            return Err("工作台最多登记 200 个项目。".into());
        }
        let mut added = 0usize;
        let mut attached = 0usize;
        let mut unchanged = 0usize;
        let mut activate = None;
        for item in prepared {
            if let Some(existing) = workspace
                .projects
                .iter_mut()
                .find(|project| project.path == item.path)
            {
                if existing.dev.is_some() {
                    unchanged += 1;
                } else {
                    existing.dev = Some(item.profile);
                    attached += 1;
                    activate = Some(existing.id.clone());
                }
            } else {
                let id = uuid::Uuid::new_v4().to_string();
                activate = Some(id.clone());
                workspace.projects.push(Project {
                    id,
                    name: item.name,
                    path: item.path,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    dev: Some(item.profile),
                });
                added += 1;
            }
        }
        if let Some(id) = activate {
            workspace.active_project_id = Some(id);
        }
        self.write(&workspace)?;
        Ok(DevImportOutcome {
            workspace,
            added,
            attached,
            unchanged,
        })
    }

    pub fn project(&self, id: &str) -> Result<Project> {
        self.load()?
            .projects
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| "项目不存在".into())
    }

    pub fn update_project_dev(&self, id: &str, dev: Option<DevProfile>) -> Result<Workspace> {
        let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?;
        let mut workspace = self.read()?;
        let project = workspace
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| "项目不存在".to_string())?;
        project.dev = dev;
        self.write(&workspace)?;
        Ok(workspace)
    }

    pub fn update_project_auto_restart(
        &self,
        id: &str,
        auto_restart: bool,
        max_restarts: Option<u32>,
        restart_interval_secs: Option<u64>,
    ) -> Result<Project> {
        let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?;
        let mut workspace = self.read()?;
        let project = workspace
            .projects
            .iter_mut()
            .find(|p| p.id == id || p.name == id)
            .ok_or_else(|| format!("项目不存在：{id}"))?;
        if let Some(dev) = project.dev.as_mut() {
            dev.auto_restart = Some(auto_restart);
            if let Some(mr) = max_restarts {
                dev.max_restarts = Some(mr);
            }
            if let Some(ris) = restart_interval_secs {
                dev.restart_interval_secs = Some(ris);
            }
        } else {
            return Err("项目尚未配置开发登记（dev profile）。".into());
        }
        let updated = project.clone();
        self.write(&workspace)?;
        Ok(updated)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub author: String,
    pub relative_time: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSummary {
    pub is_repository: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub changed_files: usize,
    pub recent_commits: Vec<GitCommit>,
    pub error: Option<String>,
}

impl Default for GitSummary {
    fn default() -> Self {
        Self {
            is_repository: false,
            branch: None,
            head: None,
            changed_files: 0,
            recent_commits: vec![],
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageScript {
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbArtifact {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInspection {
    pub exists: bool,
    pub git: GitSummary,
    pub http_files: usize,
    pub http_file_paths: Vec<String>,
    pub tech_stack: Vec<String>,
    pub scripts: Vec<PackageScript>,
    pub db_artifacts: Vec<DbArtifact>,
    #[serde(default)]
    pub deps_missing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRefBadge {
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitGraphEdge {
    pub from_col: usize,
    pub to_col: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogCommit {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub summary: String,
    pub refs: Vec<GitRefBadge>,
    pub col: usize,
    pub edges: Vec<GitGraphEdge>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryResult {
    pub commits: Vec<GitLogCommit>,
    pub total: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_timestamp: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub commit_timestamp: i64,
    pub message: String,
    pub files: Vec<GitCommitFileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashEntry {
    pub index: usize,
    pub reference: String,
    pub message: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTableInfo {
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbColumnInfo {
    pub cid: i64,
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    pub dflt_value: Option<String>,
    pub pk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub port: u16,
    pub process: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProjectContext {
    pub project_name: String,
    pub project_path: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub row_count: usize,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_bounded(command: &mut Command, timeout: Duration) -> Result<CommandOutput> {
    let stdout = tempfile::tempfile().map_err(|e| e.to_string())?;
    let stderr = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(stdout.try_clone().map_err(|e| e.to_string())?)
        .stderr(stderr.try_clone().map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| format!("无法执行命令：{e}"))?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("命令执行超时，已终止进程".into());
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    fn read_output(mut file: fs::File) -> Result<Vec<u8>> {
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("输出结果过大（>8MB）".into());
        }
        Ok(bytes)
    }
    Ok(CommandOutput {
        success: status.success(),
        exit_code: status.code(),
        stdout: read_output(stdout)?,
        stderr: read_output(stderr)?,
    })
}

fn git(path: &Path, args: &[&str]) -> Result<CommandOutput> {
    run_bounded(
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["-c", "core.fsmonitor=false"])
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C"),
        Duration::from_secs(6),
    )
}

fn output_string(output: &[u8]) -> String {
    String::from_utf8_lossy(output).trim().to_owned()
}

fn inspect_git(path: &Path) -> GitSummary {
    let mut summary = GitSummary::default();
    let result = (|| -> Result<()> {
        let probe = git(path, &["rev-parse", "--is-inside-work-tree"])?;
        if !probe.success {
            let error = output_string(&probe.stderr);
            if error.contains("not a git repository") {
                return Ok(());
            }
            return Err(error);
        }
        if output_string(&probe.stdout) != "true" {
            return Ok(());
        }
        summary.is_repository = true;
        let branch = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        if branch.success {
            summary.branch = Some(output_string(&branch.stdout));
        }
        let head = git(path, &["rev-parse", "--verify", "HEAD"])?;
        if head.success {
            summary.head = Some(output_string(&head.stdout));
        }
        let status = git(
            path,
            &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        )?;
        if !status.success {
            return Err(output_string(&status.stderr));
        }
        let mut entries = status
            .stdout
            .split(|b| *b == 0)
            .filter(|entry| !entry.is_empty());
        while let Some(entry) = entries.next() {
            summary.changed_files += 1;
            if entry.first().is_some_and(|b| *b == b'R' || *b == b'C')
                || entry.get(1).is_some_and(|b| *b == b'R' || *b == b'C')
            {
                entries.next();
            }
        }
        if let Ok(log) = git(path, &["log", "-n", "5", "--format=%h%x09%an%x09%ar%x09%s"]) {
            if log.success {
                let text = output_string(&log.stdout);
                for line in text.lines() {
                    let parts: Vec<&str> = line.split('\t').collect();
                    if parts.len() >= 4 {
                        summary.recent_commits.push(GitCommit {
                            hash: parts[0].to_owned(),
                            author: parts[1].to_owned(),
                            relative_time: parts[2].to_owned(),
                            message: parts[3].to_owned(),
                        });
                    }
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        summary.error = Some(error);
    }
    summary
}

fn scan_project_files(root: &Path) -> (usize, Vec<String>, Vec<DbArtifact>) {
    let start = Instant::now();
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut visited = 0;
    let mut http_count = 0;
    let mut http_paths = Vec::new();
    let mut db_artifacts = Vec::new();

    while let Some((path, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 20_000 || start.elapsed() > Duration::from_millis(250) {
                return (http_count, http_paths, db_artifacts);
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let entry_path = entry.path();
            let rel_path = entry_path
                .strip_prefix(root)
                .unwrap_or(&entry_path)
                .to_string_lossy()
                .into_owned();

            if kind.is_dir() {
                if name_str == "migrations" && db_artifacts.len() < 10 {
                    db_artifacts.push(DbArtifact {
                        name: "migrations".into(),
                        path: rel_path.clone(),
                        kind: "migration".into(),
                    });
                }
                if depth < 12
                    && !matches!(
                        name_str.as_ref(),
                        "node_modules"
                            | "target"
                            | "dist"
                            | "build"
                            | "vendor"
                            | "coverage"
                            | "__pycache__"
                    )
                {
                    pending.push((entry_path, depth + 1));
                }
            } else if kind.is_file() {
                if entry_path.extension().is_some_and(|e| {
                    e.eq_ignore_ascii_case("http") || e.eq_ignore_ascii_case("rest")
                }) {
                    http_count += 1;
                    if http_paths.len() < 20 {
                        http_paths.push(rel_path.clone());
                    }
                }
                if (name_str.ends_with(".sql")
                    || name_str.ends_with(".prisma")
                    || name_str.starts_with("drizzle")
                    || name_str.ends_with(".sqlite")
                    || name_str.ends_with(".db"))
                    && db_artifacts.len() < 10
                {
                    let kind_str = if name_str.ends_with(".prisma") {
                        "prisma"
                    } else if name_str.starts_with("drizzle") {
                        "drizzle"
                    } else if name_str.ends_with(".sqlite") || name_str.ends_with(".db") {
                        "sqlite"
                    } else {
                        "sql"
                    };
                    db_artifacts.push(DbArtifact {
                        name: name_str.into_owned(),
                        path: rel_path,
                        kind: kind_str.into(),
                    });
                }
            }
        }
    }
    (http_count, http_paths, db_artifacts)
}

fn detect_tech_and_scripts(root: &Path) -> (Vec<String>, Vec<PackageScript>) {
    let mut stack = Vec::new();
    let mut scripts = Vec::new();

    if let Ok(pkg_data) = fs::read_to_string(root.join("package.json")) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&pkg_data) {
            let mut detected_framework = false;
            let check_deps = |key: &str| -> Vec<String> {
                val.get(key)
                    .and_then(|d| d.as_object())
                    .map(|obj| obj.keys().cloned().collect())
                    .unwrap_or_default()
            };
            let all_deps: Vec<String> =
                [check_deps("dependencies"), check_deps("devDependencies")].concat();

            for dep in &all_deps {
                let dep_lower = dep.to_lowercase();
                if dep_lower.contains("react") && !stack.contains(&"React".to_string()) {
                    stack.push("React".into());
                    detected_framework = true;
                } else if dep_lower.contains("vue") && !stack.contains(&"Vue".to_string()) {
                    stack.push("Vue".into());
                    detected_framework = true;
                } else if dep_lower.contains("svelte") && !stack.contains(&"Svelte".to_string()) {
                    stack.push("Svelte".into());
                    detected_framework = true;
                } else if dep_lower.contains("next") && !stack.contains(&"Next.js".to_string()) {
                    stack.push("Next.js".into());
                } else if dep_lower.contains("vite") && !stack.contains(&"Vite".to_string()) {
                    stack.push("Vite".into());
                } else if dep_lower.contains("tailwind") && !stack.contains(&"Tailwind".to_string())
                {
                    stack.push("Tailwind".into());
                }
            }
            if root.join("tsconfig.json").is_file()
                || all_deps.iter().any(|d| d.contains("typescript"))
            {
                stack.push("TypeScript".into());
            } else if !detected_framework {
                stack.push("Node.js".into());
            }

            if let Some(scripts_obj) = val.get("scripts").and_then(|s| s.as_object()) {
                for (k, v) in scripts_obj {
                    if let Some(cmd) = v.as_str() {
                        scripts.push(PackageScript {
                            name: k.clone(),
                            command: cmd.to_owned(),
                        });
                    }
                }
            }
        }
    }

    if root.join("Cargo.toml").is_file() {
        if !stack.contains(&"Rust".to_string()) {
            stack.push("Rust".into());
        }
        if root.join("src-tauri").is_dir() && !stack.contains(&"Tauri".to_string()) {
            stack.push("Tauri".into());
        }
        if scripts.is_empty() {
            scripts.push(PackageScript {
                name: "test".into(),
                command: "cargo test".into(),
            });
            scripts.push(PackageScript {
                name: "check".into(),
                command: "cargo check".into(),
            });
            scripts.push(PackageScript {
                name: "run".into(),
                command: "cargo run".into(),
            });
        }
    }

    if (root.join("pyproject.toml").is_file() || root.join("requirements.txt").is_file())
        && !stack.contains(&"Python".to_string())
    {
        stack.push("Python".into());
    }
    if root.join("go.mod").is_file() && !stack.contains(&"Go".to_string()) {
        stack.push("Go".into());
    }
    if (root.join("Dockerfile").is_file() || root.join("docker-compose.yml").is_file())
        && !stack.contains(&"Docker".to_string())
    {
        stack.push("Docker".into());
    }

    (stack, scripts)
}

pub fn inspect_project(project: &Project) -> ProjectInspection {
    let path = Path::new(&project.path);
    let exists = path.is_dir();
    let (http_files, http_file_paths, db_artifacts) = if exists {
        scan_project_files(path)
    } else {
        (0, vec![], vec![])
    };
    let (tech_stack, scripts) = if exists {
        detect_tech_and_scripts(path)
    } else {
        (vec![], vec![])
    };
    let deps_missing = if exists {
        dev_runtime::node_deps_missing(path)
    } else {
        false
    };
    let install_command = if exists {
        dev_runtime::detect_install_command(path, project.dev.as_ref())
    } else {
        None
    };
    ProjectInspection {
        exists,
        git: if exists {
            inspect_git(path)
        } else {
            GitSummary::default()
        },
        http_files,
        http_file_paths,
        tech_stack,
        scripts,
        db_artifacts,
        deps_missing,
        install_command,
    }
}

// ==================== WORKBENCH OPERATIONS ====================

fn safe_project_path(project: &Project, relative: Option<&str>) -> Result<PathBuf> {
    let root = fs::canonicalize(&project.path).map_err(|e| format!("无法访问项目根目录：{e}"))?;
    if let Some(rel) = relative {
        let trimmed = rel.trim_start_matches('/');
        let target = root.join(trimmed);
        if !target.exists() {
            return Err("文件或目录不存在".into());
        }
        let canonical = fs::canonicalize(&target).map_err(|e| format!("路径解析失败：{e}"))?;
        if !canonical.starts_with(&root) {
            return Err("非法越界访问".into());
        }
        Ok(canonical)
    } else {
        Ok(root)
    }
}

pub fn read_project_tree(project: &Project, relative_dir: Option<&str>) -> Result<Vec<FileEntry>> {
    let target = safe_project_path(project, relative_dir)?;
    let root = fs::canonicalize(&project.path).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    let dir = fs::read_dir(&target).map_err(|e| format!("无法读取目录：{e}"))?;

    for item in dir.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || matches!(
                name.as_str(),
                "node_modules" | "target" | "dist" | "build" | ".venv"
            )
        {
            continue;
        }
        let Ok(meta) = item.metadata() else { continue };
        let is_dir = meta.is_dir();
        let rel = item
            .path()
            .strip_prefix(&root)
            .unwrap_or(&item.path())
            .to_string_lossy()
            .into_owned();
        entries.push(FileEntry {
            name,
            path: rel,
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

pub fn read_project_file_content(project: &Project, relative_path: &str) -> Result<String> {
    let target = safe_project_path(project, Some(relative_path))?;
    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("目标是目录而非文件".into());
    }
    if meta.len() > 512 * 1024 {
        return Err("文件过大（>512KB），请在专业编辑器中查看".into());
    }
    let content = fs::read(&target).map_err(|e| format!("无法读取文件：{e}"))?;
    String::from_utf8(content).map_err(|_| "二进制文件无法以纯文本预览".into())
}

pub fn get_git_changed_files(project: &Project) -> Result<Vec<GitFileChange>> {
    let output = git(
        Path::new(&project.path),
        &["status", "--porcelain=v1", "-z"],
    )?;
    if !output.success {
        return Err(output_string(&output.stderr));
    }
    // Status columns include significant leading spaces; -z also keeps paths literal.
    let mut records = output.stdout.split(|byte| *byte == 0);
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let (x, y) = (record[0], record[1]);
        let path =
            String::from_utf8(record[3..].to_vec()).map_err(|_| "Git 文件名不是有效 UTF-8")?;
        if x == b'R' || x == b'C' || y == b'R' || y == b'C' {
            records.next();
        }
        if x == b'?' && y == b'?' {
            changes.push(GitFileChange {
                path,
                status: "??".into(),
                staged: false,
            });
        } else {
            if x != b' ' {
                changes.push(GitFileChange {
                    path: path.clone(),
                    status: (x as char).to_string(),
                    staged: true,
                });
            }
            if y != b' ' {
                changes.push(GitFileChange {
                    path,
                    status: (y as char).to_string(),
                    staged: false,
                });
            }
        }
    }
    Ok(changes)
}

pub fn git_stage_file(project: &Project, file_path: &str) -> Result<String> {
    let path = Path::new(&project.path);
    let out = git(path, &["add", "--", file_path])?;
    if !out.success {
        return Err(output_string(&out.stderr));
    }
    Ok("已暂存".into())
}

pub fn git_unstage_file(project: &Project, file_path: &str) -> Result<String> {
    let path = Path::new(&project.path);
    let out = git(path, &["restore", "--staged", "--", file_path])?;
    if !out.success {
        let fb = git(path, &["reset", "HEAD", "--", file_path])?;
        if !fb.success {
            return Err(output_string(&fb.stderr));
        }
    }
    Ok("已取消暂存".into())
}

pub fn git_stage_all(project: &Project) -> Result<String> {
    let path = Path::new(&project.path);
    let out = git(path, &["add", "-A"])?;
    if !out.success {
        return Err(output_string(&out.stderr));
    }
    Ok("已全部暂存".into())
}

pub fn git_unstage_all(project: &Project) -> Result<String> {
    let path = Path::new(&project.path);
    let out = git(path, &["reset", "HEAD"])?;
    if !out.success {
        return Err(output_string(&out.stderr));
    }
    Ok("已取消全部暂存".into())
}

pub fn git_discard_file(project: &Project, file_path: &str) -> Result<String> {
    let path = Path::new(&project.path);
    let status_out = git(path, &["status", "--porcelain=v1", "--", file_path])?;
    let status_text = output_string(&status_out.stdout);
    if status_text.starts_with("??") {
        let full = path.join(file_path);
        if full.is_file() {
            fs::remove_file(full).map_err(|e| e.to_string())?;
        } else if full.is_dir() {
            fs::remove_dir_all(full).map_err(|e| e.to_string())?;
        }
        return Ok("已删除未跟踪文件".into());
    }
    let out = git(path, &["restore", "--", file_path])?;
    if !out.success {
        let fb = git(path, &["checkout", "--", file_path])?;
        if !fb.success {
            return Err(output_string(&fb.stderr));
        }
    }
    Ok("已丢弃修改".into())
}

pub fn git_create_branch(project: &Project, branch_name: &str) -> Result<String> {
    let trimmed = branch_name.trim();
    if trimmed.is_empty() {
        return Err("分支名称不能为空".into());
    }
    let path = Path::new(&project.path);
    let out = git(path, &["checkout", "-b", trimmed])?;
    if !out.success {
        return Err(output_string(&out.stderr));
    }
    Ok(format!("已新建并切换到分支 '{trimmed}'"))
}

pub fn git_remote_sync(project: &Project, action: &str) -> Result<String> {
    let path = Path::new(&project.path);
    match action {
        "fetch" => {
            let out = git(path, &["fetch"])?;
            if !out.success {
                return Err(output_string(&out.stderr));
            }
            Ok("Fetch 成功".into())
        }
        "pull" => {
            let out = git(path, &["pull"])?;
            if !out.success {
                return Err(output_string(&out.stderr));
            }
            let res = output_string(&out.stdout);
            Ok(if res.is_empty() {
                "Pull 完成".into()
            } else {
                res
            })
        }
        "push" => {
            let out = git(path, &["push"])?;
            if !out.success {
                return Err(output_string(&out.stderr));
            }
            let res = output_string(&out.stderr);
            Ok(if res.is_empty() {
                "Push 完成".into()
            } else {
                res
            })
        }
        other => Err(format!("未知的远程同步操作: {other}")),
    }
}

pub fn git_commit_amend(project: &Project, message: Option<&str>) -> Result<String> {
    let path = Path::new(&project.path);
    let mut args = vec!["commit", "--amend"];
    let msg_str;
    if let Some(m) = message {
        if !m.trim().is_empty() {
            msg_str = m.trim().to_string();
            args.push("-m");
            args.push(&msg_str);
        } else {
            args.push("--no-edit");
        }
    } else {
        args.push("--no-edit");
    }
    let out = git(path, &args)?;
    if !out.success {
        return Err(output_string(&out.stderr));
    }
    let rev_out = git(path, &["rev-parse", "--short", "HEAD"])?;
    Ok(output_string(&rev_out.stdout))
}

pub fn get_git_diff(project: &Project, file_path: Option<&str>) -> Result<String> {
    let path = Path::new(&project.path);
    let mut args = vec!["diff", "HEAD"];
    if let Some(f) = file_path {
        args.push("--");
        args.push(f);
    }
    let output = git(path, &args)?;
    let diff = output_string(&output.stdout);
    if !diff.is_empty() {
        return Ok(diff);
    }
    if let Some(f) = file_path {
        let unstaged = git(path, &["diff", "--", f])?;
        let text = output_string(&unstaged.stdout);
        if !text.is_empty() {
            return Ok(text);
        }
    }
    Ok("工作区该文件无差异或为全新未跟踪文件".into())
}

pub fn create_git_commit(project: &Project, message: &str) -> Result<String> {
    if message.trim().is_empty() {
        return Err("提交消息不能为空".into());
    }
    let path = Path::new(&project.path);
    // Preserve the index exactly as selected by the user, including partial staging.
    let commit_out = git(path, &["commit", "-m", message.trim()])?;
    if !commit_out.success {
        return Err(format!(
            "git commit 失败：{}",
            output_string(&commit_out.stderr)
        ));
    }
    let rev_out = git(path, &["rev-parse", "--short", "HEAD"])?;
    Ok(output_string(&rev_out.stdout))
}

pub fn get_git_branches(project: &Project) -> Result<Vec<String>> {
    let path = Path::new(&project.path);
    let output = git(path, &["branch", "--format=%(refname:short)"])?;
    if !output.success {
        return Err(output_string(&output.stderr));
    }
    let text = output_string(&output.stdout);
    Ok(text
        .lines()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect())
}

pub fn switch_git_branch(project: &Project, branch: &str) -> Result<String> {
    let path = Path::new(&project.path);
    let output = git(path, &["checkout", branch.trim()])?;
    if !output.success {
        return Err(output_string(&output.stderr));
    }
    Ok(format!("已切换至分支 {}", branch.trim()))
}

fn collect_ref_badges(path: &Path) -> std::collections::HashMap<String, Vec<GitRefBadge>> {
    let mut map: std::collections::HashMap<String, Vec<GitRefBadge>> =
        std::collections::HashMap::new();
    let mut insert = |oid: &str, badge: GitRefBadge| {
        if oid.is_empty() {
            return;
        }
        let entry = map.entry(oid.to_string()).or_default();
        if !entry.iter().any(|b| b.name == badge.name) {
            entry.push(badge);
        }
    };
    if let Ok(head_out) = git(path, &["rev-parse", "--verify", "HEAD"]) {
        if head_out.success {
            let head_oid = output_string(&head_out.stdout);
            let branch = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                .ok()
                .filter(|o| o.success)
                .map(|o| output_string(&o.stdout))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "HEAD".to_string());
            insert(
                &head_oid,
                GitRefBadge {
                    name: branch,
                    kind: "head".to_string(),
                },
            );
        }
    }
    for (namespace, kind) in [("refs/heads", "local"), ("refs/remotes", "remote")] {
        let format = "--format=%(refname:short)\t%(objectname)";
        if let Ok(out) = git(path, &["for-each-ref", format, namespace]) {
            if out.success {
                for line in output_string(&out.stdout).lines() {
                    let mut parts = line.split('\t');
                    let (Some(name), Some(oid)) = (parts.next(), parts.next()) else {
                        continue;
                    };
                    if kind == "remote" && name.ends_with("/HEAD") {
                        continue;
                    }
                    insert(
                        oid,
                        GitRefBadge {
                            name: name.to_string(),
                            kind: kind.to_string(),
                        },
                    );
                }
            }
        }
    }
    let tag_format = "--format=%(refname)\t%(objectname)\t%(objecttype)";
    if let Ok(out) = git(path, &["for-each-ref", tag_format, "refs/tags"]) {
        if out.success {
            for line in output_string(&out.stdout).lines() {
                let mut parts = line.split('\t');
                let (Some(full), Some(oid), Some(otype)) =
                    (parts.next(), parts.next(), parts.next())
                else {
                    continue;
                };
                let name = full
                    .strip_prefix("refs/tags/")
                    .unwrap_or(full)
                    .to_string();
                let target = if otype == "tag" {
                    match git(path, &["rev-list", "-n", "1", full]) {
                        Ok(peel) if peel.success => output_string(&peel.stdout),
                        _ => continue,
                    }
                } else {
                    oid.to_string()
                };
                insert(
                    &target,
                    GitRefBadge {
                        name,
                        kind: "tag".to_string(),
                    },
                );
            }
        }
    }
    for badges in map.values_mut() {
        badges.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.name.cmp(&b.name)));
    }
    map
}

fn git_log_records(output: &CommandOutput) -> Result<Vec<GitLogCommit>> {
    if !output.success {
        let stderr = output_string(&output.stderr);
        // A repository without commits yet must degrade to an empty history.
        if stderr.contains("does not have any commits yet")
            || stderr.contains("your current branch '")
        {
            return Ok(Vec::new());
        }
        return Err(stderr);
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut commits = Vec::new();
    for record in text.split('\u{1e}') {
        if record.trim().is_empty() {
            continue;
        }
        let mut fields = record.trim_start_matches('\n').split('\t');
        let oid = fields.next().unwrap_or_default().to_string();
        if oid.is_empty() {
            continue;
        }
        let short_oid = fields.next().unwrap_or_default().to_string();
        let author_name = fields.next().unwrap_or_default().to_string();
        let author_email = fields.next().unwrap_or_default().to_string();
        let timestamp = fields.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
        let parents: Vec<String> = fields
            .next()
            .unwrap_or_default()
            .split(' ')
            .filter(|p| !p.is_empty())
            .map(|p| p.to_string())
            .collect();
        let summary = fields.next().unwrap_or_default().to_string();
        commits.push(GitLogCommit {
            oid,
            short_oid,
            parents,
            author_name,
            author_email,
            timestamp,
            summary,
            refs: Vec::new(),
            col: 0,
            edges: Vec::new(),
        });
    }
    Ok(commits)
}

/// Assign graph lanes so the frontend can draw the commit topology, mirroring
/// the lane model of tongyun-git's log view.
fn assign_graph_lanes(commits: &mut [GitLogCommit]) {
    let mut active_lanes: Vec<Option<String>> = Vec::new();
    for commit in commits.iter_mut() {
        let mut col = 0usize;
        let mut found = false;
        for (idx, lane) in active_lanes.iter().enumerate() {
            if lane.as_deref() == Some(commit.oid.as_str()) {
                col = idx;
                found = true;
                break;
            }
        }
        if !found {
            match active_lanes.iter().position(|l| l.is_none()) {
                Some(free) => col = free,
                None => {
                    col = active_lanes.len();
                    active_lanes.push(None);
                }
            }
        }
        let mut edges = Vec::new();
        if commit.parents.is_empty() {
            if col < active_lanes.len() {
                active_lanes[col] = None;
            }
        } else {
            let p0 = commit.parents[0].clone();
            match active_lanes.iter().position(|l| l.as_deref() == Some(p0.as_str())) {
                Some(p0_col) => {
                    edges.push(GitGraphEdge {
                        from_col: col,
                        to_col: p0_col,
                    });
                    if p0_col != col {
                        active_lanes[col] = None;
                    }
                }
                None => {
                    active_lanes[col] = Some(p0);
                    edges.push(GitGraphEdge {
                        from_col: col,
                        to_col: col,
                    });
                }
            }
            for pk in commit.parents.iter().skip(1) {
                let pk = pk.clone();
                let pk_col = match active_lanes.iter().position(|l| l.as_deref() == Some(pk.as_str()))
                {
                    Some(existing) => existing,
                    None => match active_lanes.iter().position(|l| l.is_none()) {
                        Some(free) => {
                            active_lanes[free] = Some(pk);
                            free
                        }
                        None => {
                            active_lanes.push(Some(pk));
                            active_lanes.len() - 1
                        }
                    },
                };
                edges.push(GitGraphEdge {
                    from_col: col,
                    to_col: pk_col,
                });
            }
        }
        while active_lanes.last().map(|l| l.is_none()).unwrap_or(false) {
            active_lanes.pop();
        }
        commit.col = col;
        commit.edges = edges;
    }
}

pub fn get_git_history(
    project: &Project,
    skip: Option<usize>,
    limit: Option<usize>,
    all_branches: Option<bool>,
) -> Result<GitHistoryResult> {
    let path = Path::new(&project.path);
    let skip = skip.unwrap_or(0);
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let all = all_branches.unwrap_or(false);
    let limit_arg = (limit + 1).to_string();
    let skip_arg = skip.to_string();
    let mut args: Vec<&str> = vec![
        "log",
        "--topo-order",
        "--format=%H\t%h\t%an\t%ae\t%at\t%P\t%s\u{1e}",
    ];
    if all {
        args.push("--all");
    }
    args.extend(["--skip", &skip_arg, "-n", &limit_arg]);
    let output = git(path, &args)?;
    let mut commits = git_log_records(&output)?;
    let ref_map = collect_ref_badges(path);
    for commit in commits.iter_mut() {
        commit.refs = ref_map.get(&commit.oid).cloned().unwrap_or_default();
    }
    let has_more = commits.len() > limit;
    if has_more {
        commits.truncate(limit);
    }
    assign_graph_lanes(&mut commits);
    let mut total = skip + commits.len();
    if has_more {
        if let Ok(count_out) = git(path, &["rev-list", "--count", if all { "--all" } else { "HEAD" }])
        {
            if count_out.success {
                total = output_string(&count_out.stdout)
                    .parse::<usize>()
                    .unwrap_or(total);
            }
        }
    }
    Ok(GitHistoryResult {
        commits,
        total,
        has_more,
    })
}

fn validate_git_oid(oid: &str) -> Result<String> {
    let trimmed = oid.trim();
    if trimmed.len() < 4
        || trimmed.len() > 40
        || !trimmed.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("无效的提交哈希".into());
    }
    Ok(trimmed.to_ascii_lowercase())
}

pub fn get_git_commit_details(project: &Project, oid: &str) -> Result<GitCommitDetails> {
    let oid = validate_git_oid(oid)?;
    let path = Path::new(&project.path);
    let show = git(
        path,
        &[
            "show",
            "-s",
            "--format=%H\t%h\t%an\t%ae\t%at\t%cn\t%ce\t%ct\t%B\u{1e}",
            &oid,
        ],
    )?;
    if !show.success {
        return Err(output_string(&show.stderr));
    }
    let text = String::from_utf8_lossy(&show.stdout).into_owned();
    let record = text
        .split('\u{1e}')
        .find(|r| !r.trim().is_empty())
        .ok_or_else(|| format!("无法读取提交 {oid}"))?;
    let mut fields = record.split('\t');
    let full_oid = fields.next().unwrap_or_default().to_string();
    let short_oid = fields.next().unwrap_or_default().to_string();
    let author_name = fields.next().unwrap_or_default().to_string();
    let author_email = fields.next().unwrap_or_default().to_string();
    let author_timestamp = fields.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
    let committer_name = fields.next().unwrap_or_default().to_string();
    let committer_email = fields.next().unwrap_or_default().to_string();
    let commit_timestamp = fields.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
    let message = fields.next().unwrap_or_default().trim().to_string();

    let parents_out = git(path, &["rev-list", "--parents", "-n", "1", &full_oid])?;
    let parents: Vec<String> = output_string(&parents_out.stdout)
        .split(' ')
        .skip(1)
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect();

    let empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let base = parents
        .first()
        .cloned()
        .unwrap_or_else(|| empty_tree.to_string());
    let files_out = git(
        path,
        &["diff", "-r", "--name-status", "-z", &base, &full_oid],
    )?;
    let mut files: Vec<GitCommitFileChange> = Vec::new();
    if files_out.success {
        let raw = String::from_utf8_lossy(&files_out.stdout).into_owned();
        let tokens: Vec<&str> = raw.split('\0').filter(|t| !t.is_empty()).collect();
        let mut i = 0usize;
        while i < tokens.len() {
            let status = tokens[i].to_string();
            let letter = status.chars().next().unwrap_or('M');
            i += 1;
            if matches!(letter, 'R' | 'C') {
                let old_path = tokens.get(i).unwrap_or(&"").to_string();
                let new_path = tokens.get(i + 1).unwrap_or(&"").to_string();
                i += 2;
                files.push(GitCommitFileChange {
                    path: new_path,
                    old_path: Some(old_path),
                    status: letter.to_string(),
                });
            } else {
                let new_path = tokens.get(i).unwrap_or(&"").to_string();
                i += 1;
                files.push(GitCommitFileChange {
                    path: new_path,
                    old_path: None,
                    status: letter.to_string(),
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(GitCommitDetails {
        oid: full_oid,
        short_oid,
        parents,
        author_name,
        author_email,
        author_timestamp,
        committer_name,
        committer_email,
        commit_timestamp,
        message,
        files,
    })
}

pub fn get_git_commit_file_diff(
    project: &Project,
    oid: &str,
    file_path: &str,
    old_path: Option<&str>,
) -> Result<String> {
    let oid = validate_git_oid(oid)?;
    let path = Path::new(&project.path);
    if file_path.trim().is_empty() {
        return Err("文件路径不能为空".into());
    }
    let parents_out = git(path, &["rev-list", "--parents", "-n", "1", &oid])?;
    let parent_count = output_string(&parents_out.stdout)
        .split(' ')
        .skip(1)
        .filter(|p| !p.is_empty())
        .count();
    let mut pathspecs: Vec<&str> = vec![file_path];
    if let Some(old) = old_path.filter(|s| !s.trim().is_empty()) {
        pathspecs.push(old);
    }
    let output = if parent_count == 0 {
        let mut args: Vec<&str> = vec!["show", "--format=", "--no-color", &oid, "--"];
        args.extend(pathspecs.iter().copied());
        git(path, &args)?
    } else {
        let range = format!("{oid}^1");
        let mut args: Vec<&str> = vec!["diff", "--no-color", "-M", &range, &oid, "--"];
        args.extend(pathspecs.iter().copied());
        git(path, &args)?
    };
    if !output.success {
        return Err(output_string(&output.stderr));
    }
    let diff = output_string(&output.stdout);
    if diff.is_empty() {
        return Ok("(该提交未改动此文件的文本内容)".into());
    }
    Ok(diff)
}

/// Stash references are index-based, so they must be validated before reaching git.
fn stash_ref(path: &Path, index: usize) -> Result<String> {
    let list = git_stash_entries(path)?;
    if list.iter().any(|entry| entry.index == index) {
        return Ok(format!("stash@{{{index}}}"));
    }
    Err(format!("贮藏不存在：stash@{{{index}}}"))
}

fn stash_worktree_dirty(path: &Path) -> Result<bool> {
    Ok(!git(path, &["status", "--porcelain=v1"])?.stdout.is_empty())
}

pub fn git_stash_list(project: &Project) -> Result<Vec<GitStashEntry>> {
    git_stash_entries(Path::new(&project.path))
}

fn git_stash_entries(path: &Path) -> Result<Vec<GitStashEntry>> {
    let output = git(
        path,
        &["stash", "list", "--format=%gd|%ci|%gs"],
    )?;
    if !output.success {
        return Err(output_string(&output.stderr));
    }
    let text = output_string(&output.stdout);
    if text.is_empty() {
        return Ok(vec![]);
    }
    let mut entries = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let mut parts = line.splitn(3, '|');
        let (Some(reference), Some(date), Some(message)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        entries.push(GitStashEntry {
            index,
            reference: reference.to_owned(),
            message: message.to_owned(),
            date: date.to_owned(),
        });
    }
    Ok(entries)
}

pub fn git_stash_push(project: &Project, message: Option<&str>, include_untracked: bool) -> Result<String> {
    let path = Path::new(&project.path);
    let trimmed = message.map(str::trim).filter(|m| !m.is_empty());
    let default_message = "橦云工作台贮藏";
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    args.extend(["-m", trimmed.unwrap_or(default_message)]);
    let out = git(path, &args)?;
    if !out.success {
        return Err(output_string(&out.stderr));
    }
    let stdout = output_string(&out.stdout);
    if stdout.contains("No local changes") {
        return Ok("工作区没有改动，无需贮藏".into());
    }
    Ok(format!("已贮藏：{}", trimmed.unwrap_or(default_message)))
}

pub fn git_stash_apply(project: &Project, index: usize) -> Result<String> {
    let path = Path::new(&project.path);
    let reference = stash_ref(path, index)?;
    let out = git(path, &["stash", "apply", reference.as_str()])?;
    if !out.success {
        return Err(output_string(&out.stderr));
    }
    Ok(format!("已应用 {reference}（贮藏仍保留）"))
}

pub fn git_stash_pop(project: &Project, index: usize) -> Result<String> {
    let path = Path::new(&project.path);
    let reference = stash_ref(path, index)?;
    // A dirty worktree is the usual reason git aborts a pop; intercept it before touching history.
    if stash_worktree_dirty(path)? {
        return Err("工作区存在未提交改动，Pop 可能覆盖这些改动，已被拦截。请先提交或丢弃后重试，或改用 Apply。".into());
    }
    let out = git(path, &["stash", "pop", reference.as_str()])?;
    if !out.success {
        return Err(output_string(&out.stderr));
    }
    Ok(format!("已弹出 {reference} 并恢复改动"))
}

pub fn git_stash_drop(project: &Project, index: usize) -> Result<String> {
    let path = Path::new(&project.path);
    let reference = stash_ref(path, index)?;
    let out = git(path, &["stash", "drop", reference.as_str()])?;
    if !out.success {
        return Err(output_string(&out.stderr));
    }
    Ok(format!("已删除 {reference}"))
}

pub fn execute_project_script(project: &Project, command: &str) -> Result<ExecutionResult> {
    let start = Instant::now();
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(command);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg(command);
        c
    };
    cmd.current_dir(&project.path);
    let output = run_bounded(&mut cmd, Duration::from_secs(30))?;
    let duration_ms = start.elapsed().as_millis() as u64;
    Ok(ExecutionResult {
        exit_code: output
            .exit_code
            .unwrap_or(if output.success { 0 } else { 1 }),
        stdout: output_string(&output.stdout),
        stderr: output_string(&output.stderr),
        duration_ms,
    })
}

pub fn send_http_request(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Result<HttpResponse> {
    let start = Instant::now();
    #[cfg(windows)]
    let mut cmd = Command::new("curl");
    #[cfg(not(windows))]
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-s", "-i", "-X", method, "--max-time", "15", url]);
    for (k, v) in headers {
        cmd.args(["-H", &format!("{k}: {v}")]);
    }
    let body_file = if let Some(b) = body {
        if !b.trim().is_empty() {
            let mut f = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
            f.write_all(b.as_bytes()).map_err(|e| e.to_string())?;
            cmd.arg("--data-binary")
                .arg(format!("@{}", f.path().to_string_lossy()));
            Some(f)
        } else {
            None
        }
    } else {
        None
    };

    let output = run_bounded(&mut cmd, Duration::from_secs(16))?;
    drop(body_file);

    let raw = output.stdout;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    // Parse HTTP response header and body
    let mut split_idx = None;
    for i in 0..raw.len().saturating_sub(3) {
        if &raw[i..i + 4] == b"\r\n\r\n" {
            split_idx = Some((i, i + 4));
            break;
        } else if i < raw.len().saturating_sub(1) && &raw[i..i + 2] == b"\n\n" {
            split_idx = Some((i, i + 2));
            break;
        }
    }

    let (header_bytes, body_bytes) = match split_idx {
        Some((h_end, b_start)) => (&raw[..h_end], &raw[b_start..]),
        None => (raw.as_slice(), [].as_slice()),
    };

    let header_str = String::from_utf8_lossy(header_bytes);
    let mut lines = header_str.lines();
    let first_line = lines.next().unwrap_or("HTTP/1.1 0 Unknown");
    let mut status = 0u16;
    let mut status_text = "Unknown".to_string();

    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() >= 2 {
        if let Ok(code) = parts[1].parse::<u16>() {
            status = code;
        }
        if parts.len() >= 3 {
            status_text = parts[2..].join(" ");
        }
    }

    let mut parsed_headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            parsed_headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }

    let body_str = String::from_utf8_lossy(body_bytes).to_string();

    Ok(HttpResponse {
        status,
        status_text,
        headers: parsed_headers,
        body: body_str,
        elapsed_ms,
    })
}

const SQL_MAX_ROWS: usize = 1_000;
const SQL_MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;
const SQL_TIMEOUT: Duration = Duration::from_secs(2);

/// Read-only policy is enforced by SQLite itself, never by guessing an SQL prefix.
/// A fresh, non-URI connection also prevents user SQL from persisting connection state.
fn query_sqlite_readonly(target: &Path, sql: &str) -> Result<(Vec<String>, Vec<Vec<String>>)> {
    use rusqlite::{
        hooks::{AuthAction, AuthContext, Authorization},
        limits::Limit,
        types::ValueRef,
        Batch, Connection, OpenFlags,
    };
    if sql.len() > 64 * 1024 {
        return Err("SQL 超过 64 KiB，请缩小查询".into());
    }
    let started = Instant::now();
    let connection = Connection::open_with_flags(
        target,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("无法只读打开数据库：{e}"))?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|e| e.to_string())?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(|e| e.to_string())?;
    connection
        .pragma_update(None, "trusted_schema", false)
        .map_err(|e| e.to_string())?;
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, 1024 * 1024);
    connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 64 * 1024);
    connection.set_limit(Limit::SQLITE_LIMIT_COLUMN, 512);
    connection.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
    connection.progress_handler(500, Some(move || started.elapsed() >= SQL_TIMEOUT));
    connection.authorizer(Some(|context: AuthContext<'_>| match context.action {
        AuthAction::Read { .. } | AuthAction::Select | AuthAction::Recursive => {
            Authorization::Allow
        }
        AuthAction::Function { function_name }
            if ![
                "load_extension",
                "readfile",
                "writefile",
                "eval",
                "fts3_tokenizer",
            ]
            .iter()
            .any(|name| function_name.eq_ignore_ascii_case(name)) =>
        {
            Authorization::Allow
        }
        // This is the only pragma needed by the table inspector. Its argument is a
        // table name, not a setting; all connection/file-mutating pragmas are denied.
        AuthAction::Pragma { pragma_name, .. }
            if pragma_name.eq_ignore_ascii_case("table_info") =>
        {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }));

    // Batch uses SQLite's parser, so comments, quoted semicolons and CTEs cannot
    // bypass the single-statement rule. Prepare all input before stepping any row.
    let mut batch = Batch::new(&connection, sql);
    let mut statement = batch
        .next()
        .map_err(|e| e.to_string())?
        .ok_or("请输入一条只读 SQL 查询")?;
    if batch.next().map_err(|e| e.to_string())?.is_some() {
        return Err("每次仅允许一条只读 SQL 查询".into());
    }
    if !statement.readonly() || statement.column_count() == 0 {
        return Err("仅允许返回数据的只读查询".into());
    }
    let columns: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut result_bytes: usize = columns.iter().map(String::len).sum();
    let mut rows = Vec::new();
    let mut cursor = statement.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = cursor.next().map_err(|e| {
        if started.elapsed() >= SQL_TIMEOUT {
            "查询超过 2 秒，请缩小查询范围".into()
        } else {
            e.to_string()
        }
    })? {
        if started.elapsed() >= SQL_TIMEOUT {
            return Err("查询超过 2 秒，请缩小查询范围".into());
        }
        if rows.len() == SQL_MAX_ROWS {
            return Err("查询超过 1000 行，请使用 LIMIT 或分页".into());
        }
        let mut values = Vec::with_capacity(columns.len());
        for i in 0..columns.len() {
            let value = match row.get_ref(i).map_err(|e| e.to_string())? {
                ValueRef::Null => "NULL".to_owned(),
                ValueRef::Integer(v) => v.to_string(),
                ValueRef::Real(v) => v.to_string(),
                ValueRef::Text(v) => String::from_utf8_lossy(v).into_owned(),
                ValueRef::Blob(v) => {
                    use std::fmt::Write;
                    let mut encoded = String::with_capacity(v.len() * 2 + 3);
                    encoded.push_str("X'");
                    for byte in v {
                        write!(encoded, "{byte:02X}").expect("writing to String");
                    }
                    encoded.push('\'');
                    encoded
                }
            };
            result_bytes += value.len();
            if result_bytes > SQL_MAX_RESULT_BYTES {
                return Err("查询结果超过 4 MiB，请缩小查询范围".into());
            }
            values.push(value);
        }
        rows.push(values);
    }
    Ok((columns, rows))
}

pub fn execute_sql_query(project: &Project, db_path: &str, sql: &str) -> Result<SqlQueryResult> {
    let start = Instant::now();
    let target = safe_project_path(project, Some(db_path))?;
    if !target.is_file() {
        return Err("请选择已存在的 SQLite 数据库文件".into());
    }
    let outcome = query_sqlite_readonly(&target, sql);
    let duration_ms = start.elapsed().as_millis() as u64;
    match outcome {
        Ok((columns, rows)) => Ok(SqlQueryResult {
            row_count: rows.len(),
            columns,
            rows,
            duration_ms,
            error: None,
        }),
        Err(error) => Ok(SqlQueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            duration_ms,
            error: Some(format!("只读查询失败：{error}")),
        }),
    }
}

pub fn get_db_tables(project: &Project, db_path: &str) -> Result<Vec<DbTableInfo>> {
    let sql = "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name;";
    let res = execute_sql_query(project, db_path, sql)?;
    if let Some(err) = res.error {
        return Err(err);
    }
    let mut tables = Vec::new();
    for row in res.rows {
        if row.len() >= 2 {
            tables.push(DbTableInfo {
                name: row[0].clone(),
                kind: row[1].clone(),
            });
        }
    }
    Ok(tables)
}

pub fn get_table_columns(
    project: &Project,
    db_path: &str,
    table_name: &str,
) -> Result<Vec<DbColumnInfo>> {
    if !table_name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return Err("表名包含非法字符".into());
    }
    let sql = format!("PRAGMA table_info(\"{table_name}\");");
    let res = execute_sql_query(project, db_path, &sql)?;
    if let Some(err) = res.error {
        return Err(err);
    }
    let mut columns = Vec::new();
    for row in res.rows {
        if row.len() >= 6 {
            let cid = row[0].parse::<i64>().unwrap_or(0);
            let name = row[1].clone();
            let data_type = row[2].clone();
            let not_null = row[3] == "1";
            let dflt_value = if row[4] == "NULL" {
                None
            } else {
                Some(row[4].clone())
            };
            let pk = row[5] == "1";
            columns.push(DbColumnInfo {
                cid,
                name,
                data_type,
                not_null,
                dflt_value,
                pk,
            });
        }
    }
    Ok(columns)
}

pub fn get_table_data(
    project: &Project,
    db_path: &str,
    table_name: &str,
    page: usize,
    page_size: usize,
) -> Result<PaginatedData> {
    if !table_name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return Err("表名包含非法字符".into());
    }
    let page = page.max(1);
    let page_size = page_size.clamp(1, 200);
    let offset = (page - 1) * page_size;

    let count_sql = format!("SELECT count(*) FROM \"{table_name}\";");
    let count_res = execute_sql_query(project, db_path, &count_sql)?;
    if let Some(err) = count_res.error {
        return Err(err);
    }
    let total_rows = count_res
        .rows
        .first()
        .and_then(|r| r.first())
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);

    let data_sql = format!("SELECT * FROM \"{table_name}\" LIMIT {page_size} OFFSET {offset};");
    let data_res = execute_sql_query(project, db_path, &data_sql)?;
    if let Some(err) = data_res.error {
        return Err(err);
    }

    Ok(PaginatedData {
        columns: data_res.columns,
        rows: data_res.rows,
        total_rows,
        page,
        page_size,
    })
}

#[allow(dead_code)]
fn is_dev_port(port: u16, proc_name: &str) -> bool {
    if port < 80 || port >= 32768 {
        return false;
    }

    if !proc_name.is_ascii() {
        return false;
    }

    let lower = proc_name.to_lowercase();

    const EXCLUSIONS: &[&str] = &[
        "rapport",
        "controlce",
        "controlcenter",
        "launchd",
        "identityservices",
        "sharingd",
        "remoted",
        "wifi",
        "bluetooth",
        "mdns",
        "airplay",
        "cupsd",
        "wechat",
        "doubao",
        "feishu",
        "dingtalk",
        "slack",
        "telegram",
        "clash",
        "v2ray",
        "surge",
        "sing-box",
        "antigrav",
        "agy",
        "language_",
        "sandbox",
        "editor_",
        "electron",
    ];

    for excl in EXCLUSIONS {
        if lower.contains(excl) {
            return false;
        }
    }

    const DEV_SERVERS: &[&str] = &[
        "node", "vite", "next", "nuxt", "astro", "deno", "bun", "python", "uvicorn", "gunicorn",
        "flask", "django", "cargo", "rust", "go", "ruby", "rails", "puma", "php", "caddy", "nginx",
        "docker", "postgres", "mysqld", "redis", "java",
    ];

    DEV_SERVERS.iter().any(|s| lower.contains(s))
}

pub fn detect_listening_ports() -> Vec<ListeningPort> {
    #[allow(unused_mut)]
    let mut ports = Vec::new();
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("/usr/sbin/lsof")
            .args(["-iTCP", "-sTCP:LISTEN", "-n", "-P"])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines().skip(1) {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 9 {
                        let proc_name = parts[0].to_string();
                        let addr = parts[8];
                        if let Some(port_str) = addr.split(':').last() {
                            if let Ok(p) = port_str.parse::<u16>() {
                                if is_dev_port(p, &proc_name)
                                    && !ports.iter().any(|item: &ListeningPort| item.port == p)
                                {
                                    ports.push(ListeningPort {
                                        port: p,
                                        process: proc_name,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    ports
}

pub fn generate_ai_project_context(project: &Project) -> Result<AiProjectContext> {
    let inspection = inspect_project(project);
    let mut md = String::new();
    md.push_str(&format!("# 橦云 AI 上下文报告 · {}\n\n", project.name));
    md.push_str(&format!("- **物理路径**: `{}`\n", project.path));
    md.push_str(&format!(
        "- **技术栈运行时**: {}\n",
        if inspection.tech_stack.is_empty() {
            "未检测到特定运行时".into()
        } else {
            inspection.tech_stack.join(", ")
        }
    ));

    if inspection.git.is_repository {
        md.push_str(&format!(
            "- **Git 分支**: `{}` (HEAD: `{}`)\n",
            inspection.git.branch.as_deref().unwrap_or("未知"),
            inspection.git.head.as_deref().unwrap_or("空")
        ));
        md.push_str(&format!(
            "- **工作区未提交项**: {} 项\n",
            inspection.git.changed_files
        ));
    } else {
        md.push_str("- **Git 状态**: 非 Git 仓库\n");
    }

    let ports = detect_listening_ports();
    if !ports.is_empty() {
        let port_strings: Vec<String> = ports
            .iter()
            .map(|p| format!("http://localhost:{} ({})", p.port, p.process))
            .collect();
        md.push_str(&format!(
            "- **本机活跃服务监听**: {}\n",
            port_strings.join(", ")
        ));
    }

    if !inspection.scripts.is_empty() {
        md.push_str("\n## 可用项目启动命令\n");
        for s in &inspection.scripts {
            md.push_str(&format!("- `{}`: `{}`\n", s.name, s.command));
        }
    }

    if !inspection.db_artifacts.is_empty() {
        md.push_str("\n## 发现的数据库与模式产物\n");
        for d in &inspection.db_artifacts {
            md.push_str(&format!("- `{}` ({})\n", d.path, d.kind));
        }
    }

    if let Ok(changes) = get_git_changed_files(project) {
        if !changes.is_empty() {
            md.push_str("\n## 当前代码变更清单 (Git Status)\n");
            for c in changes.iter().take(20) {
                let badge = if c.staged { "暂存" } else { "工作区" };
                md.push_str(&format!("- [{}] [{}] `{}`\n", badge, c.status, c.path));
            }
        }
    }

    Ok(AiProjectContext {
        project_name: project.name.clone(),
        project_path: project.path.clone(),
        markdown: md,
    })
}

pub fn open_project_directory(project: &Project) -> Result<()> {
    if !Path::new(&project.path).is_dir() {
        return Err("项目目录不存在，请恢复目录后重试".into());
    }
    #[cfg(target_os = "macos")]
    {
        let output = run_bounded(
            Command::new("/usr/bin/open").arg("--").arg(&project.path),
            Duration::from_secs(5),
        )?;
        if !output.success {
            return Err(format!("打开目录失败：{}", output_string(&output.stderr)));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("此平台的文件管理器入口尚未接入".into())
    }
}

pub fn open_in_terminal(project: &Project) -> Result<()> {
    if !Path::new(&project.path).is_dir() {
        return Err("项目目录不存在，请恢复目录后重试".into());
    }
    #[cfg(target_os = "macos")]
    {
        let output = run_bounded(
            Command::new("/usr/bin/open").args(["-a", "Terminal", &project.path]),
            Duration::from_secs(5),
        )?;
        if !output.success {
            return Err(format!("打开终端失败：{}", output_string(&output.stderr)));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("此平台的终端入口尚未接入".into())
    }
}

pub fn open_project_file(project: &Project, relative_path: &str) -> Result<()> {
    let _full = safe_project_path(project, Some(relative_path))?;
    #[cfg(target_os = "macos")]
    {
        let output = run_bounded(
            Command::new("/usr/bin/open")
                .arg("--")
                .arg(_full.to_string_lossy().as_ref()),
            Duration::from_secs(5),
        )?;
        if !output.success {
            return Err(format!("打开文件失败：{}", output_string(&output.stderr)));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("此平台的文件打开入口尚未接入".into())
    }
}

pub fn open_url(url: &str) -> Result<()> {
    if !url.starts_with("http://localhost:")
        && !url.starts_with("http://127.0.0.1:")
        && !url.starts_with("https://")
        && !url.starts_with("http://")
    {
        return Err("仅支持合法的 HTTP/HTTPS 链接".into());
    }
    #[cfg(target_os = "macos")]
    {
        let output = run_bounded(
            Command::new("/usr/bin/open").arg("--").arg(url),
            Duration::from_secs(5),
        )?;
        if !output.success {
            return Err(format!("打开链接失败：{}", output_string(&output.stderr)));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("此平台的浏览器入口尚未接入".into())
    }
}

// Traverse relative to open directory descriptors, rejecting symlinks before creating
// any directory or opening the target. This also prevents parent-swap traversal races.
#[cfg(unix)]
fn open_project_output(project: &Project, relative_path: &str, append: bool) -> Result<fs::File> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::fs::MetadataExt,
        },
        path::Component,
    };
    let relative = Path::new(relative_path);
    let parts = relative
        .components()
        .map(|component| match component {
            Component::Normal(name) => {
                CString::new(name.as_encoded_bytes()).map_err(|_| "路径包含无效字符".to_string())
            }
            _ => Err("必须使用项目内的相对路径".into()),
        })
        .collect::<Result<Vec<_>>>()?;
    if parts.is_empty() {
        return Err("相对路径不能为空".into());
    }
    let root = fs::File::open(&project.path).map_err(|e| format!("无法打开项目目录：{e}"))?;
    let mut directory: OwnedFd = root.into();
    for part in &parts[..parts.len() - 1] {
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut fd = unsafe { libc::openat(directory.as_raw_fd(), part.as_ptr(), flags) };
        if fd < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            let created = unsafe { libc::mkdirat(directory.as_raw_fd(), part.as_ptr(), 0o700) };
            if created < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
                return Err(format!(
                    "无法创建项目目录：{}",
                    std::io::Error::last_os_error()
                ));
            }
            fd = unsafe { libc::openat(directory.as_raw_fd(), part.as_ptr(), flags) };
        }
        if fd < 0 {
            return Err(format!(
                "拒绝不可访问或链接目录：{}",
                std::io::Error::last_os_error()
            ));
        }
        directory = unsafe { OwnedFd::from_raw_fd(fd) };
    }
    let flags = libc::O_WRONLY
        | libc::O_CREAT
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if append { libc::O_APPEND } else { 0 };
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            parts.last().unwrap().as_ptr(),
            flags,
            0o600,
        )
    };
    if fd < 0 {
        return Err(format!(
            "无法安全打开项目文件：{}",
            std::io::Error::last_os_error()
        ));
    }
    let file = unsafe { fs::File::from_raw_fd(fd) };
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err("拒绝写入非普通文件或硬链接".into());
    }
    if !append {
        file.set_len(0).map_err(|e| e.to_string())?;
    }
    Ok(file)
}
#[cfg(not(unix))]
fn open_project_output(
    _project: &Project,
    _relative_path: &str,
    _append: bool,
) -> Result<fs::File> {
    Err("当前平台尚未实现安全项目文件写入".into())
}
pub fn write_project_file(project: &Project, relative_path: &str, content: &str) -> Result<()> {
    open_project_output(project, relative_path, false)?
        .write_all(content.as_bytes())
        .map_err(|e| format!("写入文件失败：{e}"))
}
pub fn append_project_file(project: &Project, relative_path: &str, content: &str) -> Result<()> {
    open_project_output(project, relative_path, true)?
        .write_all(content.as_bytes())
        .map_err(|e| format!("追加写入失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(root: &Path) -> WorkspaceStore {
        WorkspaceStore::new(root.join("config/workspace.json"))
    }

    #[test]
    fn persist_deduplicate_select_and_remove_without_deleting() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        fs::create_dir(&project).unwrap();
        let other = dir.path().join("other");
        fs::create_dir(&other).unwrap();
        let db = store(dir.path());
        let first = db.add(project.to_str().unwrap()).unwrap();
        let id = first.projects[0].id.clone();
        assert_eq!(
            db.add(project.join(".").to_str().unwrap())
                .unwrap()
                .projects
                .len(),
            1
        );
        db.add(other.to_str().unwrap()).unwrap();
        db.select(&id).unwrap();
        assert_eq!(
            store(dir.path()).load().unwrap().active_project_id,
            Some(id.clone())
        );
        let remaining = db.remove(&id).unwrap();
        assert_eq!(remaining.projects.len(), 1);
        assert!(project.exists());
        assert_eq!(
            remaining.active_project_id.as_deref(),
            Some(remaining.projects[0].id.as_str())
        );
    }

    #[test]
    fn damaged_or_future_records_are_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        fs::create_dir_all(db.path.parent().unwrap()).unwrap();
        for bytes in [
            b"broken".as_slice(),
            br#"{"version":2,"projects":[],"activeProjectId":null}"#,
        ] {
            fs::write(&db.path, bytes).unwrap();
            assert!(db.add(dir.path().to_str().unwrap()).is_err());
            assert_eq!(fs::read(&db.path).unwrap(), bytes);
        }
    }

    #[test]
    fn old_workspace_loads_and_scan_import_does_not_overwrite_or_delete() {
        let dir = tempfile::tempdir().unwrap();
        let db = store(dir.path());
        fs::create_dir_all(db.path.parent().unwrap()).unwrap();
        fs::write(
            &db.path,
            r#"{"version":1,"projects":[],"activeProjectId":null}"#,
        )
        .unwrap();
        assert!(db.load().unwrap().projects.is_empty());

        let web = dir.path().join("shop/web");
        fs::create_dir_all(&web).unwrap();
        fs::write(
            web.join("package.json"),
            r#"{"devDependencies":{"vite":"^5"},"scripts":{"dev":"vite"}}"#,
        )
        .unwrap();
        fs::write(web.join("KEEP"), "sentinel").unwrap();
        let manual = dir.path().join("manual");
        fs::create_dir(&manual).unwrap();
        db.add(manual.to_str().unwrap()).unwrap();

        let report = scan_dev_directory(
            dir.path(),
            3,
            &db.load()
                .unwrap()
                .projects
                .iter()
                .map(|project| ExistingProject {
                    id: project.id.clone(),
                    path: project.path.clone(),
                    has_dev: project.dev.is_some(),
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let candidate = report
            .candidates
            .iter()
            .find(|item| item.kind == "vite")
            .unwrap();
        assert!(!candidate.already_registered);
        let imported = db
            .import_dev_candidates(std::slice::from_ref(candidate))
            .unwrap();
        assert_eq!(imported.added, 1);
        assert!(web.join("KEEP").is_file());
        let again = db
            .import_dev_candidates(std::slice::from_ref(candidate))
            .unwrap();
        assert_eq!(again.added, 0);
        assert_eq!(again.unchanged, 1);
        assert_eq!(db.load().unwrap().projects.len(), 2);

        let bare = report
            .candidates
            .iter()
            .find(|item| item.path == fs::canonicalize(&manual).unwrap().to_string_lossy())
            .cloned();
        // The manual directory has no manifest, so it is not a candidate. Attach via a synthetic one.
        let _ = bare;
        let mut attached = candidate.clone();
        attached.path = fs::canonicalize(&manual)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        attached.name = "manual".into();
        attached.command = "npm run dev".into();
        // The stored manual project has no dev profile, so import fills only that field.
        let filled = db
            .import_dev_candidates(std::slice::from_ref(&attached))
            .unwrap();
        assert_eq!(filled.attached, 1);
        let loaded = db.load().unwrap();
        let manual_project = loaded
            .projects
            .iter()
            .find(|project| project.name == "manual")
            .unwrap();
        assert_eq!(manual_project.dev.as_ref().unwrap().command, "npm run dev");
        let removed = db
            .remove(
                &imported
                    .workspace
                    .projects
                    .iter()
                    .find(|project| project.path.ends_with("/web") || project.name == "web")
                    .unwrap()
                    .id,
            )
            .unwrap();
        assert!(web.join("KEEP").is_file());
        assert_eq!(removed.projects.len(), 1);
    }

    #[test]
    fn git_handles_empty_repo_changes_and_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = dir.path().parent().map(|p| {
            let prev = std::env::var("GIT_CEILING_DIRECTORIES").ok();
            std::env::set_var("GIT_CEILING_DIRECTORIES", p);
            prev
        });
        assert!(!inspect_git(dir.path()).is_repository);
        assert!(Command::new("git")
            .args(["init", "-q"])
            .arg(dir.path())
            .status()
            .unwrap()
            .success());
        let empty = inspect_git(dir.path());
        assert!(empty.is_repository);
        assert!(empty.branch.is_some());
        assert!(empty.head.is_none());
        assert!(empty.error.is_none());
        fs::write(dir.path().join("hello.txt"), "hello").unwrap();
        assert_eq!(inspect_git(dir.path()).changed_files, 1);
        assert!(git(dir.path(), &["add", "hello.txt"]).unwrap().success);
        assert!(
            git(
                dir.path(),
                &[
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-qm",
                    "test"
                ]
            )
            .unwrap()
            .success
        );
        let committed = inspect_git(dir.path());
        assert!(committed.head.is_some());
        assert_eq!(committed.changed_files, 0);
        assert_eq!(committed.recent_commits.len(), 1);
        assert_eq!(committed.recent_commits[0].message, "test");
        fs::rename(dir.path().join("hello.txt"), dir.path().join("renamed.txt")).unwrap();
        assert!(git(dir.path(), &["add", "-A"]).unwrap().success);
        assert_eq!(inspect_git(dir.path()).changed_files, 1);
    }

    #[test]
    fn scans_tree_and_reads_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(dir.path().join("test.http"), "GET http://localhost/").unwrap();

        let project = Project {
            id: "test".into(),
            name: "test".into(),
            path: dir.path().to_string_lossy().into_owned(),
            created_at: "".into(),
            dev: None,
        };

        let tree = read_project_tree(&project, None).unwrap();
        assert!(tree.iter().any(|e| e.name == "src" && e.is_dir));
        assert!(tree.iter().any(|e| e.name == "test.http" && !e.is_dir));

        let content = read_project_file_content(&project, "src/main.rs").unwrap();
        assert_eq!(content, "fn main() {}");

        let script_res = execute_project_script(&project, "echo hello from script").unwrap();
        assert_eq!(script_res.exit_code, 0);
        assert!(script_res.stdout.contains("hello from script"));
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_is_bounded() {
        let start = Instant::now();
        let result = run_bounded(
            Command::new("/bin/sleep").arg("2"),
            Duration::from_millis(40),
        );
        assert!(result.unwrap_err().contains("超时"));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[test]
    fn project_file_writing_and_appending_enforces_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let project = Project {
            id: "sandbox-test".into(),
            name: "sandbox-test".into(),
            path: dir.path().to_string_lossy().into_owned(),
            created_at: "".into(),
            dev: None,
        };

        // Write file inside nested directory
        write_project_file(
            &project,
            ".tongyun/agent-session.json",
            r#"{"agent":"agy"}"#,
        )
        .unwrap();
        let content = read_project_file_content(&project, ".tongyun/agent-session.json").unwrap();
        assert_eq!(content, r#"{"agent":"agy"}"#);

        // Append line
        append_project_file(&project, ".tongyun/agent-instructions.jsonl", "line 1\n").unwrap();
        append_project_file(&project, ".tongyun/agent-instructions.jsonl", "line 2\n").unwrap();
        let appended =
            read_project_file_content(&project, ".tongyun/agent-instructions.jsonl").unwrap();
        assert_eq!(appended, "line 1\nline 2\n");

        // Reject directory traversal attempts
        assert!(write_project_file(&project, "../outside.txt", "evil").is_err());
        assert!(append_project_file(&project, "../../outside.txt", "evil").is_err());
        assert!(open_url("ftp://example.com").is_err());
        assert!(open_url("javascript:alert(1)").is_err());
    }

    #[cfg(not(unix))]
    #[test]
    fn project_file_writing_and_appending_enforces_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let project = Project {
            id: "sandbox-test".into(),
            name: "sandbox-test".into(),
            path: dir.path().to_string_lossy().into_owned(),
            created_at: "".into(),
            dev: None,
        };
        assert!(write_project_file(&project, ".tongyun/agent-session.json", "{}").is_err());
        assert!(append_project_file(&project, ".tongyun/agent-session.json", "{}").is_err());
        assert!(open_url("ftp://example.com").is_err());
        assert!(open_url("javascript:alert(1)").is_err());
    }

    fn project_of(root: &Path) -> Project {
        Project {
            id: "stash-test".into(),
            name: "stash-test".into(),
            path: root.to_string_lossy().into_owned(),
            created_at: "".into(),
            dev: None,
        }
    }

    /// A committed seed file, because stash needs HEAD to record its base against.
    fn repo_with_commit(dir: &Path) -> Project {
        assert!(Command::new("git")
            .args(["init", "-q"])
            .arg(dir)
            .status()
            .unwrap()
            .success());
        fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        assert!(git(dir, &["add", "seed.txt"]).unwrap().success);
        assert!(git(
            dir,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "seed"
            ]
        )
        .unwrap()
        .success);
        project_of(dir)
    }

    /// Trailing whitespace varies with the machine's core.autocrlf, so compare content only.
    fn read_trimmed(path: &Path) -> String {
        fs::read_to_string(path).unwrap().trim_end().to_owned()
    }

    #[test]
    fn stash_push_list_apply_pop_drop_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let project = repo_with_commit(root);
        assert!(git_stash_list(&project).unwrap().is_empty());

        fs::write(root.join("seed.txt"), "seed modified\n").unwrap();
        assert!(git_stash_push(&project, Some("wip: 前端改造"), false)
            .unwrap()
            .contains("已贮藏"));
        assert_eq!(read_trimmed(&root.join("seed.txt")), "seed", "贮藏后应回到基线内容");

        let list = git_stash_list(&project).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].index, 0);
        assert_eq!(list[0].reference, "stash@{0}");
        assert!(list[0].message.contains("wip: 前端改造"), "{:?}", list[0].message);
        assert!(!list[0].date.is_empty());

        git_stash_apply(&project, 0).unwrap();
        assert_eq!(read_trimmed(&root.join("seed.txt")), "seed modified");
        assert_eq!(git_stash_list(&project).unwrap().len(), 1, "Apply 不消费贮藏");

        git_stash_drop(&project, 0).unwrap();
        assert!(git_stash_list(&project).unwrap().is_empty());

        fs::write(root.join("seed.txt"), "seed again\n").unwrap();
        assert!(git_stash_push(&project, None, false)
            .unwrap()
            .contains("橦云工作台贮藏"), "缺省备注应落进贮藏说明");
        assert!(git_stash_pop(&project, 0).unwrap().contains("已弹出"));
        assert_eq!(read_trimmed(&root.join("seed.txt")), "seed again");
        assert!(git_stash_list(&project).unwrap().is_empty(), "Pop 消费贮藏");
    }

    #[test]
    fn stash_includes_untracked_and_rejects_missing_reference() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let project = repo_with_commit(root);

        fs::write(root.join("draft.txt"), "draft\n").unwrap();
        assert!(git_stash_push(&project, Some("含未跟踪"), true)
            .unwrap()
            .contains("已贮藏"));
        assert!(!root.join("draft.txt").is_file(), "未跟踪文件应一并离开工作区");
        assert!(git_stash_apply(&project, 0).unwrap().contains("已应用"));
        assert_eq!(read_trimmed(&root.join("draft.txt")), "draft");

        assert!(git_stash_apply(&project, 7).is_err());
        assert!(git_stash_pop(&project, 7).is_err());
        assert!(git_stash_drop(&project, 7).is_err());
    }

    #[test]
    fn stash_pop_is_blocked_when_worktree_dirty() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let project = repo_with_commit(root);

        fs::write(root.join("seed.txt"), "stashed\n").unwrap();
        git_stash_push(&project, Some("first"), false).unwrap();

        fs::write(root.join("seed.txt"), "conflicting\n").unwrap();
        let blocked = git_stash_pop(&project, 0).unwrap_err();
        assert!(blocked.contains("已被拦截"), "{blocked}");
        assert_eq!(read_trimmed(&root.join("seed.txt")), "conflicting");
        assert_eq!(git_stash_list(&project).unwrap().len(), 1, "拦截后贮藏必须还在");
    }

    #[test]
    fn stash_push_on_clean_worktree_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let project = repo_with_commit(dir.path());
        assert!(git_stash_push(&project, Some("nothing"), false)
            .unwrap()
            .contains("无需贮藏"));
        assert!(git_stash_list(&project).unwrap().is_empty());
    }
}
