//! Diagnostic export module: sanitizes project configurations and logs, and packs them into a zip archive.
use crate::processes::{safe_project_filename, ServiceManager};
use crate::{DevProfile, ManagedService, Project, Result, Workspace};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Seek, Write};
use std::path::Path;
use std::sync::OnceLock;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

pub const SENSITIVE_KEY_SUBSTRINGS: &[&str] = &[
    "key",
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "auth",
    "credential",
    "private",
    "sig",
    "signature",
    "cookie",
    "jwt",
    "bearer",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "client_secret",
];

pub fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    SENSITIVE_KEY_SUBSTRINGS
        .iter()
        .any(|&pattern| lower.contains(pattern))
}

pub fn sanitize_env_map(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .map(|(k, v)| {
            if is_sensitive_key(k) {
                (k.clone(), "[REDACTED]".to_string())
            } else {
                (k.clone(), v.clone())
            }
        })
        .collect()
}

static URL_CREDENTIAL_RE: OnceLock<Regex> = OnceLock::new();
static BEARER_TOKEN_RE: OnceLock<Regex> = OnceLock::new();
static BASIC_AUTH_RE: OnceLock<Regex> = OnceLock::new();
static BARE_JWT_RE: OnceLock<Regex> = OnceLock::new();
static CLI_SECRET_RE: OnceLock<Regex> = OnceLock::new();
static KEY_VALUE_SECRET_RE: OnceLock<Regex> = OnceLock::new();

/// Matches `scheme://user:password@` for any URL scheme, so database connection
/// strings (postgres, mysql, redis, mongodb, ...) are covered as well as http(s).
const URL_CREDENTIAL_PATTERN: &str = r"(?i)(\b[a-z][a-z0-9+.\-]{1,19}://[^:/\s@]*:)([^@\s/]+)(@)";
const BEARER_TOKEN_PATTERN: &str = r"(?i)(bearer\s+)[A-Za-z0-9\-._~+/]+=*";
const BASIC_AUTH_PATTERN: &str = r"(?i)(authorization\s*[=:]\s*basic\s+)[A-Za-z0-9\-._~+/]+=*";
const BARE_JWT_PATTERN: &str =
    r"(?i)\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{4,}";
const CLI_SECRET_PATTERN: &str = r#"(?i)(--(?:x-)?(?:api-?)?(?:key|secret|password|passwd|pwd|token)\s*=\s*)("[^"]*"|'[^']*'|[^\s,;"'&]+)"#;
const KEY_VALUE_SECRET_PATTERN: &str = r#"(?i)("?(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|credential)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;"'&]+)"#;

pub fn sanitize_text(text: &str) -> String {
    let url_re = URL_CREDENTIAL_RE.get_or_init(|| Regex::new(URL_CREDENTIAL_PATTERN).unwrap());
    let bearer_re = BEARER_TOKEN_RE.get_or_init(|| Regex::new(BEARER_TOKEN_PATTERN).unwrap());
    let basic_re = BASIC_AUTH_RE.get_or_init(|| Regex::new(BASIC_AUTH_PATTERN).unwrap());
    let jwt_re = BARE_JWT_RE.get_or_init(|| Regex::new(BARE_JWT_PATTERN).unwrap());
    let cli_re = CLI_SECRET_RE.get_or_init(|| Regex::new(CLI_SECRET_PATTERN).unwrap());
    let kv_re = KEY_VALUE_SECRET_RE.get_or_init(|| Regex::new(KEY_VALUE_SECRET_PATTERN).unwrap());

    let s1 = url_re.replace_all(text, "${1}[REDACTED]${3}");
    let s2 = bearer_re.replace_all(&s1, "${1}[REDACTED]");
    let s3 = basic_re.replace_all(&s2, "${1}[REDACTED]");
    let s4 = jwt_re.replace_all(&s3, "[REDACTED]");
    let s5 = cli_re.replace_all(&s4, "${1}[REDACTED]");
    let s6 = kv_re.replace_all(&s5, "${1}[REDACTED]");
    s6.into_owned()
}

pub fn sanitize_dev_profile(dev: &DevProfile) -> DevProfile {
    let mut sanitized = dev.clone();
    sanitized.command = sanitize_text(&sanitized.command);
    if let Some(ref url) = sanitized.health_url {
        sanitized.health_url = Some(sanitize_text(url));
    }
    sanitized.env = sanitize_env_map(&sanitized.env);

    let mut sanitized_profiles = BTreeMap::new();
    for (k, preset) in &sanitized.profiles {
        let mut p = preset.clone();
        if let Some(ref cmd) = p.command {
            p.command = Some(sanitize_text(cmd));
        }
        if let Some(ref url) = p.health_url {
            p.health_url = Some(sanitize_text(url));
        }
        p.env = sanitize_env_map(&p.env);
        sanitized_profiles.insert(k.clone(), p);
    }
    sanitized.profiles = sanitized_profiles;
    sanitized
}

pub fn sanitize_project(project: &Project) -> Project {
    let mut p = project.clone();
    if let Some(ref dev) = p.dev {
        p.dev = Some(sanitize_dev_profile(dev));
    }
    p
}

pub fn default_diagnostics_filename() -> String {
    format!(
        "tongyun-studio-diagnostics-{}.zip",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub file_path: String,
    pub file_size: u64,
    pub project_count: usize,
    pub log_count: usize,
    pub exported_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedServiceMetadata {
    pub id: String,
    pub project_id: String,
    pub command: String,
    pub pid: Option<u32>,
    pub status: String,
    pub lifecycle: String,
    pub port: Option<u16>,
    pub port_open: bool,
    pub started_at: String,
    pub exit_code: Option<i32>,
    pub restart_count: u32,
    pub failure: Option<String>,
}

impl From<&ManagedService> for SanitizedServiceMetadata {
    fn from(s: &ManagedService) -> Self {
        Self {
            id: s.id.clone(),
            project_id: s.project_id.clone(),
            command: sanitize_text(&s.command),
            pid: s.pid,
            status: s.status.clone(),
            lifecycle: s.lifecycle.clone(),
            port: s.port,
            port_open: s.port_open,
            started_at: s.started_at.clone(),
            exit_code: s.exit_code,
            restart_count: s.restart_count,
            failure: s.failure.as_deref().map(sanitize_text),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticMetadata {
    pub exported_at: String,
    pub studio_version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    pub active_project_id: Option<String>,
    pub projects: Vec<Project>,
    pub services: Vec<SanitizedServiceMetadata>,
}

pub fn export_diagnostics_to_writer<W: Write + Seek>(
    workspace: &Workspace,
    services: &ServiceManager,
    writer: W,
) -> Result<(usize, usize)> {
    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let sanitized_projects: Vec<Project> = workspace.projects.iter().map(sanitize_project).collect();

    let mut running_services: Vec<SanitizedServiceMetadata> = Vec::new();
    for p in &workspace.projects {
        if let Ok(list) = services.list(&p.id) {
            for s in list {
                running_services.push(SanitizedServiceMetadata::from(&s));
            }
        }
    }

    let metadata = DiagnosticMetadata {
        exported_at: chrono::Utc::now().to_rfc3339(),
        studio_version: "0.1.0",
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        active_project_id: workspace.active_project_id.clone(),
        projects: sanitized_projects.clone(),
        services: running_services,
    };

    let metadata_json = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("序列化诊断元数据失败: {e}"))?;

    zip.start_file("metadata.json", options)
        .map_err(|e| format!("创建 metadata.json 失败: {e}"))?;
    zip.write_all(metadata_json.as_bytes())
        .map_err(|e| format!("写入 metadata.json 失败: {e}"))?;

    let mut log_count = 0;
    for p in &workspace.projects {
        let log_content = services
            .project_log_tail(&p.id, 500)
            .ok()
            .flatten()
            .or_else(|| {
                // Check if active services have output
                if let Ok(svc_list) = services.list(&p.id) {
                    let parts: Vec<String> = svc_list
                        .into_iter()
                        .map(|s| {
                            let tail = if !s.log_tail.is_empty() {
                                s.log_tail
                            } else {
                                [s.stdout, s.stderr]
                                    .into_iter()
                                    .filter(|str| !str.is_empty())
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            };
                            format!("=== 进程 [{}] {} ===\n{}", s.id, s.command, tail)
                        })
                        .filter(|str| !str.is_empty())
                        .collect();
                    if !parts.is_empty() {
                        Some(parts.join("\n\n"))
                    } else {
                        None
                    }
                } else {
                    None
                }
            });

        if let Some(raw_log) = log_content {
            if !raw_log.trim().is_empty() {
                let sanitized_log = sanitize_text(&raw_log);
                let filename = format!("logs/{}.log", safe_project_filename(&p.id));
                zip.start_file(&filename, options)
                    .map_err(|e| format!("创建日志文件 '{filename}' 失败: {e}"))?;
                zip.write_all(sanitized_log.as_bytes())
                    .map_err(|e| format!("写入日志文件 '{filename}' 失败: {e}"))?;
                log_count += 1;
            }
        }
    }

    let readme = format!(
        "橦云工作台 (Tongyun Studio) 诊断报告包\n\
        ========================================\n\
        导出时间: {}\n\
        项目数量: {}\n\
        日志文件数: {}\n\n\
        目录说明：\n\
        - metadata.json: 包含已脱敏的项目配置（命令、端口、路径、依赖预设等，不含密码和密钥）与服务状态\n\
        - logs/: 各项目最近运行的滚动日志尾部（包含启动、安装及退出日志，敏感认证信息已自动屏蔽）\n\n\
        脱敏保证：\n\
        所有 Key、Token、Secret、Password、Auth、Cookie、JWT 及 URL 凭据字段均已自动脱敏替换为 [REDACTED] 或剔除。\n",
        metadata.exported_at,
        sanitized_projects.len(),
        log_count
    );

    zip.start_file("diagnostics.txt", options)
        .map_err(|e| format!("创建 diagnostics.txt 失败: {e}"))?;
    zip.write_all(readme.as_bytes())
        .map_err(|e| format!("写入 diagnostics.txt 失败: {e}"))?;

    zip.finish()
        .map_err(|e| format!("完成诊断 zip 归档失败: {e}"))?;

    Ok((sanitized_projects.len(), log_count))
}

pub fn export_diagnostics_to_file(
    workspace: &Workspace,
    services: &ServiceManager,
    target_path: &Path,
) -> Result<DiagnosticReport> {
    if let Some(parent) = target_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                if err.kind() == std::io::ErrorKind::PermissionDenied {
                    return Err(format!(
                        "导出诊断包失败：目标目录 '{}' 无创建或写入权限（Permission denied）。请选择有写入权限的目录后重试。",
                        parent.display()
                    ));
                } else {
                    return Err(format!(
                        "导出诊断包失败：无法创建目标目录 '{}'（{}）",
                        parent.display(),
                        err
                    ));
                }
            }
        }
    }

    let file = match File::create(target_path) {
        Ok(f) => f,
        Err(err) => {
            if err.kind() == std::io::ErrorKind::PermissionDenied {
                return Err(format!(
                    "导出诊断包失败：目标路径 '{}' 写入权限不足（Permission denied）。请选择有写入权限的目录后重试。",
                    target_path.display()
                ));
            } else if err.kind() == std::io::ErrorKind::NotFound {
                return Err(format!(
                    "导出诊断包失败：目标路径 '{}' 所在目录不存在。",
                    target_path.display()
                ));
            } else {
                return Err(format!(
                    "导出诊断包失败：无法创建文件 '{}'（{}）",
                    target_path.display(),
                    err
                ));
            }
        }
    };

    let exported_at = chrono::Utc::now().to_rfc3339();
    let (project_count, log_count) = export_diagnostics_to_writer(workspace, services, file)?;

    let file_size = match std::fs::metadata(target_path) {
        Ok(m) => m.len(),
        Err(_) => 0,
    };

    Ok(DiagnosticReport {
        file_path: target_path.to_string_lossy().to_string(),
        file_size,
        project_count,
        log_count,
        exported_at,
    })
}
