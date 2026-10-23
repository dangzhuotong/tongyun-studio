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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
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
        let value: serde_json::Value =
            serde_json::from_reader(file).map_err(|e| format!("项目记录损坏，已保留原文件：{e}"))?;
        if value.get("version").and_then(|v| v.as_u64()) != Some(1) {
            return Err("项目记录版本不受支持，已保留原文件".into());
        }
        let workspace: Workspace =
            serde_json::from_value(value).map_err(|e| format!("项目记录格式错误，已保留原文件：{e}"))?;
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

    pub fn project(&self, id: &str) -> Result<Project> {
        self.load()?
            .projects
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| "项目不存在".into())
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
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
    pub elapsed_ms: u64,
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
        let mut entries = status.stdout.split(|b| *b == 0).filter(|entry| !entry.is_empty());
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
        let Ok(entries) = fs::read_dir(&path) else { continue };
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
            let Ok(kind) = entry.file_type() else { continue };
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
                        "node_modules" | "target" | "dist" | "build" | "vendor" | "coverage" | "__pycache__"
                    )
                {
                    pending.push((entry_path, depth + 1));
                }
            } else if kind.is_file() {
                if entry_path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("http") || e.eq_ignore_ascii_case("rest"))
                {
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
    }
}

// ==================== WORKBENCH OPERATIONS ====================

fn safe_project_path(project: &Project, relative: Option<&str>) -> Result<PathBuf> {
    let root = fs::canonicalize(&project.path)
        .map_err(|e| format!("无法访问项目根目录：{e}"))?;
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
        if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build" | ".venv") {
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

    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
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
    let path = Path::new(&project.path);
    let output = git(path, &["status", "--porcelain=v1"])?;
    if !output.success {
        return Err(output_string(&output.stderr));
    }
    let text = output_string(&output.stdout);
    let mut changes = Vec::new();
    for line in text.lines() {
        if line.len() >= 3 {
            let status = line[0..2].trim().to_owned();
            let file_path = line[3..].trim().to_owned();
            changes.push(GitFileChange {
                path: file_path,
                status,
            });
        }
    }
    Ok(changes)
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
    let add_out = git(path, &["add", "-A"])?;
    if !add_out.success {
        return Err(format!("git add 失败：{}", output_string(&add_out.stderr)));
    }
    let commit_out = git(path, &["commit", "-m", message.trim()])?;
    if !commit_out.success {
        return Err(format!("git commit 失败：{}", output_string(&commit_out.stderr)));
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
    Ok(text.lines().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect())
}

pub fn switch_git_branch(project: &Project, branch: &str) -> Result<String> {
    let path = Path::new(&project.path);
    let output = git(path, &["checkout", branch.trim()])?;
    if !output.success {
        return Err(output_string(&output.stderr));
    }
    Ok(format!("已切换至分支 {}", branch.trim()))
}

pub fn execute_project_script(project: &Project, command: &str) -> Result<ExecutionResult> {
    let start = Instant::now();
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(command).current_dir(&project.path);
    let output = run_bounded(&mut cmd, Duration::from_secs(30))?;
    let duration_ms = start.elapsed().as_millis() as u64;
    Ok(ExecutionResult {
        exit_code: output.exit_code.unwrap_or(if output.success { 0 } else { 1 }),
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
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-s", "-i", "-X", method, "--max-time", "15", url]);
    for (k, v) in headers {
        cmd.args(["-H", &format!("{k}: {v}")]);
    }
    let body_file = if let Some(b) = body {
        if !b.trim().is_empty() {
            let mut f = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
            f.write_all(b.as_bytes()).map_err(|e| e.to_string())?;
            cmd.arg("--data-binary").arg(format!("@{}", f.path().to_string_lossy()));
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

pub fn execute_sql_query(project: &Project, db_path: &str, sql: &str) -> Result<SqlQueryResult> {
    let start = Instant::now();
    let target = safe_project_path(project, Some(db_path))?;
    let mut cmd = Command::new("/usr/bin/sqlite3");
    cmd.arg(target.to_string_lossy().as_ref())
        .arg("-header")
        .arg("-json")
        .arg(sql);

    let output = run_bounded(&mut cmd, Duration::from_secs(10))?;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    if !output.success {
        return Ok(SqlQueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            elapsed_ms,
            error: Some(output_string(&output.stderr)),
        });
    }

    let stdout_str = output_string(&output.stdout);
    if stdout_str.is_empty() {
        return Ok(SqlQueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            elapsed_ms,
            error: None,
        });
    }

    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&stdout_str) {
        if let Some(arr) = val.as_array() {
            let mut columns = Vec::new();
            let mut rows = Vec::new();
            if let Some(first) = arr.first().and_then(|item| item.as_object()) {
                columns = first.keys().cloned().collect();
            }
            for item in arr {
                if let Some(obj) = item.as_object() {
                    let row: Vec<String> = columns
                        .iter()
                        .map(|col| match obj.get(col) {
                            Some(serde_json::Value::Null) => "NULL".into(),
                            Some(serde_json::Value::String(s)) => s.clone(),
                            Some(other) => other.to_string(),
                            None => "".into(),
                        })
                        .collect();
                    rows.push(row);
                }
            }
            let row_count = rows.len();
            return Ok(SqlQueryResult {
                columns,
                rows,
                row_count,
                elapsed_ms,
                error: None,
            });
        }
    }

    Ok(SqlQueryResult {
        columns: vec!["结果".into()],
        rows: vec![vec![stdout_str]],
        row_count: 1,
        elapsed_ms,
        error: None,
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
    let full = safe_project_path(project, Some(relative_path))?;
    #[cfg(target_os = "macos")]
    {
        let output = run_bounded(
            Command::new("/usr/bin/open").arg("--").arg(full.to_string_lossy().as_ref()),
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
        assert_eq!(db.add(project.join(".").to_str().unwrap()).unwrap().projects.len(), 1);
        db.add(other.to_str().unwrap()).unwrap();
        db.select(&id).unwrap();
        assert_eq!(store(dir.path()).load().unwrap().active_project_id, Some(id.clone()));
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
    fn git_handles_empty_repo_changes_and_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!inspect_git(dir.path()).is_repository);
        assert!(Command::new("git").args(["init", "-q"]).arg(dir.path()).status().unwrap().success());
        let empty = inspect_git(dir.path());
        assert!(empty.is_repository);
        assert!(empty.branch.is_some());
        assert!(empty.head.is_none());
        assert!(empty.error.is_none());
        fs::write(dir.path().join("hello.txt"), "hello").unwrap();
        assert_eq!(inspect_git(dir.path()).changed_files, 1);
        assert!(git(dir.path(), &["add", "hello.txt"]).unwrap().success);
        assert!(git(
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
        .success);
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
        };

        let tree = read_project_tree(&project, None).unwrap();
        assert!(tree.iter().any(|e| e.name == "src" && e.is_dir));
        assert!(tree.iter().any(|e| e.name == "test.http" && !e.is_dir));

        let content = read_project_file_content(&project, "src/main.rs").unwrap();
        assert_eq!(content, "fn main() {}");

        let script_res = execute_project_script(&project, "echo 'hello from script'").unwrap();
        assert_eq!(script_res.exit_code, 0);
        assert!(script_res.stdout.contains("hello from script"));
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_is_bounded() {
        let start = Instant::now();
        let result = run_bounded(Command::new("/bin/sleep").arg("2"), Duration::from_millis(40));
        assert!(result.unwrap_err().contains("超时"));
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
