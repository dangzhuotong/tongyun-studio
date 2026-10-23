//! Local workspace persistence and bounded, read-only project inspection.
use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Mutex, time::{Duration, Instant}};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project { pub id: String, pub name: String, pub path: String, pub created_at: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace { pub version: u32, pub projects: Vec<Project>, pub active_project_id: Option<String> }

impl Default for Workspace { fn default() -> Self { Self { version: 1, projects: vec![], active_project_id: None } } }

/// All commands share this store. Reads and read/modify/write operations use one lock.
pub struct WorkspaceStore { path: PathBuf, lock: Mutex<()> }

impl WorkspaceStore {
    pub fn new(path: PathBuf) -> Self { Self { path, lock: Mutex::new(()) } }
    fn read(&self) -> Result<Workspace> {
        let file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Workspace::default()),
            Err(e) => return Err(format!("无法读取项目记录：{e}")),
        };
        let value: serde_json::Value = serde_json::from_reader(file).map_err(|e| format!("项目记录损坏，已保留原文件：{e}"))?;
        if value.get("version").and_then(|v| v.as_u64()) != Some(1) { return Err("项目记录版本不受支持，已保留原文件".into()); }
        let workspace: Workspace = serde_json::from_value(value).map_err(|e| format!("项目记录格式错误，已保留原文件：{e}"))?;
        let mut ids = std::collections::HashSet::new();
        let mut paths = std::collections::HashSet::new();
        for project in &workspace.projects {
            if project.id.is_empty() || !ids.insert(&project.id) || !Path::new(&project.path).is_absolute() || !paths.insert(&project.path) {
                return Err("项目记录存在无效或重复项目，已保留原文件".into());
            }
        }
        if workspace.active_project_id.as_ref().is_some_and(|id| !ids.contains(id)) { return Err("当前项目记录无效，已保留原文件".into()); }
        Ok(workspace)
    }
    fn write(&self, workspace: &Workspace) -> Result<()> {
        let parent = self.path.parent().ok_or("项目记录路径无效")?;
        fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录：{e}"))?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(file.as_file_mut(), workspace).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(&self.path).map_err(|e| format!("保存项目记录失败：{e}"))?;
        Ok(())
    }
    pub fn load(&self) -> Result<Workspace> { let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?; self.read() }
    pub fn add(&self, path: &str) -> Result<Workspace> {
        let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?;
        let mut workspace = self.read()?;
        let canonical = fs::canonicalize(path).map_err(|e| format!("无法访问目录：{e}"))?;
        if !canonical.is_dir() { return Err("请选择一个目录".into()); }
        let path = canonical.to_str().ok_or("目录路径不是有效的 Unicode")?.to_owned();
        if let Some(existing) = workspace.projects.iter().find(|p| p.path == path) {
            workspace.active_project_id = Some(existing.id.clone());
        } else {
            let project = Project { id: uuid::Uuid::new_v4().to_string(), name: canonical.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone()), path, created_at: chrono::Utc::now().to_rfc3339() };
            workspace.active_project_id = Some(project.id.clone());
            workspace.projects.push(project);
        }
        self.write(&workspace)?;
        Ok(workspace)
    }
    pub fn select(&self, id: &str) -> Result<Workspace> {
        let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?;
        let mut workspace = self.read()?;
        if !workspace.projects.iter().any(|p| p.id == id) { return Err("项目不存在".into()); }
        workspace.active_project_id = Some(id.to_owned()); self.write(&workspace)?; Ok(workspace)
    }
    pub fn remove(&self, id: &str) -> Result<Workspace> {
        let _guard = self.lock.lock().map_err(|_| "项目记录锁不可用")?;
        let mut workspace = self.read()?;
        if !workspace.projects.iter().any(|p| p.id == id) { return Err("项目不存在".into()); }
        workspace.projects.retain(|p| p.id != id);
        if workspace.active_project_id.as_deref() == Some(id) { workspace.active_project_id = workspace.projects.first().map(|p| p.id.clone()); }
        self.write(&workspace)?; Ok(workspace)
    }
    pub fn project(&self, id: &str) -> Result<Project> { self.load()?.projects.into_iter().find(|p| p.id == id).ok_or_else(|| "项目不存在".into()) }
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
}

#[derive(Debug)]
struct CommandOutput { success: bool, stdout: Vec<u8>, stderr: Vec<u8> }

/// Temporary output files avoid pipe deadlocks. Both execution and output reading are bounded.
fn run_bounded(command: &mut Command, timeout: Duration) -> Result<CommandOutput> {
    let stdout = tempfile::tempfile().map_err(|e| e.to_string())?;
    let stderr = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut child = command.stdin(Stdio::null()).stdout(stdout.try_clone().map_err(|e| e.to_string())?).stderr(stderr.try_clone().map_err(|e| e.to_string())?).spawn().map_err(|e| format!("无法执行本机命令：{e}"))?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {},
            Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e.to_string()); }
        }
        if start.elapsed() >= timeout { let _ = child.kill(); let _ = child.wait(); return Err("检查超时，请稍后重试".into()); }
        std::thread::sleep(Duration::from_millis(15));
    };
    fn read_output(mut file: fs::File) -> Result<Vec<u8>> {
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new(); file.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 { return Err("检查结果过大，请在原工具中查看".into()); } Ok(bytes)
    }
    Ok(CommandOutput { success: status.success(), stdout: read_output(stdout)?, stderr: read_output(stderr)? })
}

fn git(path: &Path, args: &[&str]) -> Result<CommandOutput> {
    run_bounded(Command::new("git").arg("-C").arg(path).args(["-c", "core.fsmonitor=false"]).args(args).env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C"), Duration::from_secs(4))
}

fn output_string(output: &[u8]) -> String { String::from_utf8_lossy(output).trim().to_owned() }

fn inspect_git(path: &Path) -> GitSummary {
    let mut summary = GitSummary::default();
    let result = (|| -> Result<()> {
        let probe = git(path, &["rev-parse", "--is-inside-work-tree"])?;
        if !probe.success {
            let error = output_string(&probe.stderr);
            if error.contains("not a git repository") { return Ok(()); }
            return Err(error);
        }
        if output_string(&probe.stdout) != "true" { return Ok(()); }
        summary.is_repository = true;
        let branch = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        if branch.success { summary.branch = Some(output_string(&branch.stdout)); }
        let head = git(path, &["rev-parse", "--verify", "HEAD"])?;
        if head.success { summary.head = Some(output_string(&head.stdout)); }
        let status = git(path, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"])?;
        if !status.success { return Err(output_string(&status.stderr)); }
        let mut entries = status.stdout.split(|b| *b == 0).filter(|entry| !entry.is_empty());
        while let Some(entry) = entries.next() {
            summary.changed_files += 1;
            if entry.first().is_some_and(|b| *b == b'R' || *b == b'C') || entry.get(1).is_some_and(|b| *b == b'R' || *b == b'C') { entries.next(); }
        }
        // Read recent commits
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
    if let Err(error) = result { summary.error = Some(error); }
    summary
}

/// Bounded file scanning for .http files and database artifacts.
fn scan_project_files(root: &Path) -> (usize, Vec<String>, Vec<DbArtifact>) {
    let start = Instant::now();
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut visited = 0;
    let mut http_count = 0;
    let mut http_paths = Vec::new();
    let mut db_artifacts = Vec::new();

    while let Some((path, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&path) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 20_000 || start.elapsed() > Duration::from_millis(250) {
                return (http_count, http_paths, db_artifacts);
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') { continue; }
            let Ok(kind) = entry.file_type() else { continue };
            let entry_path = entry.path();
            let rel_path = entry_path.strip_prefix(root).unwrap_or(&entry_path).to_string_lossy().into_owned();

            if kind.is_dir() {
                if name_str == "migrations" && db_artifacts.len() < 10 {
                    db_artifacts.push(DbArtifact { name: "migrations".into(), path: rel_path.clone(), kind: "migration".into() });
                }
                if depth < 12 && !matches!(name_str.as_ref(), "node_modules" | "target" | "dist" | "build" | "vendor" | "coverage" | "__pycache__") {
                    pending.push((entry_path, depth + 1));
                }
            } else if kind.is_file() {
                if entry_path.extension().is_some_and(|e| e.eq_ignore_ascii_case("http") || e.eq_ignore_ascii_case("rest")) {
                    http_count += 1;
                    if http_paths.len() < 20 {
                        http_paths.push(rel_path.clone());
                    }
                }
                if (name_str.ends_with(".sql") || name_str.ends_with(".prisma") || name_str.starts_with("drizzle") || name_str.ends_with(".sqlite") || name_str.ends_with(".db")) && db_artifacts.len() < 10 {
                    let kind_str = if name_str.ends_with(".prisma") { "prisma" }
                        else if name_str.starts_with("drizzle") { "drizzle" }
                        else if name_str.ends_with(".sqlite") || name_str.ends_with(".db") { "sqlite" }
                        else { "sql" };
                    db_artifacts.push(DbArtifact { name: name_str.into_owned(), path: rel_path, kind: kind_str.into() });
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
                val.get(key).and_then(|d| d.as_object()).map(|obj| obj.keys().cloned().collect()).unwrap_or_default()
            };
            let all_deps: Vec<String> = [check_deps("dependencies"), check_deps("devDependencies")].concat();

            for dep in &all_deps {
                let dep_lower = dep.to_lowercase();
                if dep_lower.contains("react") && !stack.contains(&"React".to_string()) {
                    stack.push("React".into()); detected_framework = true;
                } else if dep_lower.contains("vue") && !stack.contains(&"Vue".to_string()) {
                    stack.push("Vue".into()); detected_framework = true;
                } else if dep_lower.contains("svelte") && !stack.contains(&"Svelte".to_string()) {
                    stack.push("Svelte".into()); detected_framework = true;
                } else if dep_lower.contains("next") && !stack.contains(&"Next.js".to_string()) {
                    stack.push("Next.js".into());
                } else if dep_lower.contains("vite") && !stack.contains(&"Vite".to_string()) {
                    stack.push("Vite".into());
                } else if dep_lower.contains("tailwind") && !stack.contains(&"Tailwind".to_string()) {
                    stack.push("Tailwind".into());
                }
            }
            if root.join("tsconfig.json").is_file() || all_deps.iter().any(|d| d.contains("typescript")) {
                stack.push("TypeScript".into());
            } else if !detected_framework {
                stack.push("Node.js".into());
            }

            if let Some(scripts_obj) = val.get("scripts").and_then(|s| s.as_object()) {
                for (k, v) in scripts_obj {
                    if let Some(cmd) = v.as_str() {
                        scripts.push(PackageScript { name: k.clone(), command: cmd.to_owned() });
                    }
                }
            }
        }
    }

    if root.join("Cargo.toml").is_file() {
        if !stack.contains(&"Rust".to_string()) { stack.push("Rust".into()); }
        if root.join("src-tauri").is_dir() && !stack.contains(&"Tauri".to_string()) {
            stack.push("Tauri".into());
        }
        if scripts.is_empty() {
            scripts.push(PackageScript { name: "test".into(), command: "cargo test".into() });
            scripts.push(PackageScript { name: "check".into(), command: "cargo check".into() });
            scripts.push(PackageScript { name: "run".into(), command: "cargo run".into() });
        }
    }

    if (root.join("pyproject.toml").is_file() || root.join("requirements.txt").is_file()) && !stack.contains(&"Python".to_string()) {
        stack.push("Python".into());
    }
    if root.join("go.mod").is_file() && !stack.contains(&"Go".to_string()) {
        stack.push("Go".into());
    }
    if (root.join("Dockerfile").is_file() || root.join("docker-compose.yml").is_file()) && !stack.contains(&"Docker".to_string()) {
        stack.push("Docker".into());
    }

    (stack, scripts)
}

pub fn inspect_project(project: &Project) -> ProjectInspection {
    let path = Path::new(&project.path);
    let exists = path.is_dir();
    let (http_files, http_file_paths, db_artifacts) = if exists { scan_project_files(path) } else { (0, vec![], vec![]) };
    let (tech_stack, scripts) = if exists { detect_tech_and_scripts(path) } else { (vec![], vec![]) };
    ProjectInspection {
        exists,
        git: if exists { inspect_git(path) } else { GitSummary::default() },
        http_files,
        http_file_paths,
        tech_stack,
        scripts,
        db_artifacts,
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolId { Dev, Api, Database, Git }

impl ToolId {
    fn info(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::Dev => ("Tongyun Dev", &["tongyun-dev.app"]),
            Self::Api => ("Tongyun API", &["tongyun-api.app"]),
            Self::Database => ("橦云数据库", &["橦云数据库.app", "tongyun-database.app"]),
            Self::Git => ("Tongyun Git", &["tongyun-git.app"]),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus { pub id: ToolId, pub name: String, pub available: bool, pub application_path: Option<String>, pub detail: String }

#[derive(Debug, Serialize)]
pub struct LaunchResult { pub message: String }

fn tool_status(id: ToolId) -> ToolStatus {
    let (name, _bundles) = id.info();
    #[cfg(target_os = "macos")]
    let application_path = {
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME") { roots.push(PathBuf::from(home).join("Applications")); }
        roots.iter().flat_map(|root| _bundles.iter().map(move |bundle| root.join(bundle))).find(|path| path.is_dir()).map(|p| p.to_string_lossy().into_owned())
    };
    #[cfg(not(target_os = "macos"))]
    let application_path: Option<String> = None;
    let available = application_path.is_some();
    let detail = if !cfg!(target_os = "macos") { "此平台的应用入口尚未接入" } else if available { "打开独立应用后，请在原工具内选择项目" } else { "未在应用程序目录找到此工具" }.to_owned();
    ToolStatus { id, name: name.into(), available, application_path, detail }
}

pub fn list_tools() -> Vec<ToolStatus> { [ToolId::Dev, ToolId::Api, ToolId::Database, ToolId::Git].into_iter().map(tool_status).collect() }

pub fn launch_tool(id: ToolId) -> Result<LaunchResult> {
    let status = tool_status(id);
    let path = status.application_path.ok_or(status.detail)?;
    #[cfg(target_os = "macos")]
    {
        let output = run_bounded(Command::new("/usr/bin/open").args(["-a", &path]), Duration::from_secs(5))?;
        if !output.success { return Err(format!("打开应用失败：{}", output_string(&output.stderr))); }
        Ok(LaunchResult { message: format!("已打开 {}，请在原工具内选择项目", status.name) })
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = path; Err("此平台的应用入口尚未接入".into()) }
}

pub fn open_project_directory(project: &Project) -> Result<()> {
    if !Path::new(&project.path).is_dir() { return Err("项目目录不存在，请恢复目录后重试".into()); }
    #[cfg(target_os = "macos")]
    {
        let output = run_bounded(Command::new("/usr/bin/open").arg("--").arg(&project.path), Duration::from_secs(5))?;
        if !output.success { return Err(format!("打开目录失败：{}", output_string(&output.stderr))); } Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { Err("此平台的文件管理器入口尚未接入".into()) }
}

pub fn open_in_terminal(project: &Project) -> Result<()> {
    if !Path::new(&project.path).is_dir() { return Err("项目目录不存在，请恢复目录后重试".into()); }
    #[cfg(target_os = "macos")]
    {
        let output = run_bounded(Command::new("/usr/bin/open").args(["-a", "Terminal", &project.path]), Duration::from_secs(5))?;
        if !output.success { return Err(format!("打开终端失败：{}", output_string(&output.stderr))); } Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { Err("此平台的终端入口尚未接入".into()) }
}

pub fn open_project_file(project: &Project, relative_path: &str) -> Result<()> {
    let full = Path::new(&project.path).join(relative_path);
    if !full.is_file() { return Err("指定的文件不存在".into()); }
    #[cfg(target_os = "macos")]
    {
        let output = run_bounded(Command::new("/usr/bin/open").arg("--").arg(full.to_string_lossy().as_ref()), Duration::from_secs(5))?;
        if !output.success { return Err(format!("打开文件失败：{}", output_string(&output.stderr))); } Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { Err("此平台的文件打开入口尚未接入".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store(root: &Path) -> WorkspaceStore { WorkspaceStore::new(root.join("config/workspace.json")) }
    #[test]
    fn persist_deduplicate_select_and_remove_without_deleting() {
        let dir = tempfile::tempdir().unwrap(); let project = dir.path().join("project"); fs::create_dir(&project).unwrap();
        let other = dir.path().join("other"); fs::create_dir(&other).unwrap();
        let db = store(dir.path());
        let first = db.add(project.to_str().unwrap()).unwrap(); let id = first.projects[0].id.clone();
        assert_eq!(db.add(project.join(".").to_str().unwrap()).unwrap().projects.len(), 1);
        db.add(other.to_str().unwrap()).unwrap();
        db.select(&id).unwrap(); assert_eq!(store(dir.path()).load().unwrap().active_project_id, Some(id.clone()));
        let remaining = db.remove(&id).unwrap(); assert_eq!(remaining.projects.len(), 1); assert!(project.exists());
        assert_eq!(remaining.active_project_id.as_deref(), Some(remaining.projects[0].id.as_str()));
    }
    #[test]
    fn damaged_or_future_records_are_never_overwritten() {
        let dir = tempfile::tempdir().unwrap(); let db = store(dir.path()); fs::create_dir_all(db.path.parent().unwrap()).unwrap();
        for bytes in [b"broken".as_slice(), br#"{"version":2,"projects":[],"activeProjectId":null}"#] {
            fs::write(&db.path, bytes).unwrap(); assert!(db.add(dir.path().to_str().unwrap()).is_err()); assert_eq!(fs::read(&db.path).unwrap(), bytes);
        }
    }
    #[test]
    fn git_handles_empty_repo_changes_and_non_repo() {
        let dir = tempfile::tempdir().unwrap(); assert!(!inspect_git(dir.path()).is_repository);
        assert!(Command::new("git").args(["init", "-q"]).arg(dir.path()).status().unwrap().success());
        let empty = inspect_git(dir.path()); assert!(empty.is_repository); assert!(empty.branch.is_some()); assert!(empty.head.is_none()); assert!(empty.error.is_none());
        fs::write(dir.path().join("hello.txt"), "hello").unwrap(); assert_eq!(inspect_git(dir.path()).changed_files, 1);
        assert!(git(dir.path(), &["add", "hello.txt"]).unwrap().success);
        assert!(git(dir.path(), &["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "test"]).unwrap().success);
        let committed = inspect_git(dir.path());
        assert!(committed.head.is_some());
        assert_eq!(committed.changed_files, 0);
        assert_eq!(committed.recent_commits.len(), 1);
        assert_eq!(committed.recent_commits[0].message, "test");
        fs::rename(dir.path().join("hello.txt"), dir.path().join("renamed.txt")).unwrap();
        assert!(git(dir.path(), &["add", "-A"]).unwrap().success); assert_eq!(inspect_git(dir.path()).changed_files, 1);
    }
    #[test]
    fn scans_skip_generated_files_and_missing_directory_recovers() {
        let dir = tempfile::tempdir().unwrap(); fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join("test.http"), "GET /").unwrap(); fs::write(dir.path().join("node_modules/ignored.http"), "GET /").unwrap();
        fs::write(dir.path().join("schema.sql"), "CREATE TABLE users (id int);").unwrap();
        let (count, paths, dbs) = scan_project_files(dir.path());
        assert_eq!(count, 1);
        assert_eq!(paths.len(), 1);
        assert_eq!(dbs.len(), 1);
        let path = dir.path().join("later"); let project = Project { id: "x".into(), name: "x".into(), path: path.to_string_lossy().into_owned(), created_at: "".into() };
        assert!(!inspect_project(&project).exists); fs::create_dir(path).unwrap(); assert!(inspect_project(&project).exists);
    }
    #[cfg(unix)]
    #[test]
    fn command_timeout_is_bounded() {
        let start = Instant::now(); let result = run_bounded(Command::new("/bin/sleep").arg("2"), Duration::from_millis(40));
        assert!(result.unwrap_err().contains("超时")); assert!(start.elapsed() < Duration::from_secs(1));
    }
}
