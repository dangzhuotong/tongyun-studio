//! Read the project registry tongyun-dev maintains so Studio can register those projects
//! without asking the same person to configure them a second time.
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::dev_runtime::{
    parse_loopback_http, valid_group_key, DevCandidate, EnvPreset, ExistingProject,
};
use crate::Result;

/// `WorkspaceStore::import_dev_candidates` rejects larger batches, so the registry view stops here.
const MAX_CANDIDATES: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TongyunDevSkipped {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TongyunDevSyncReport {
    pub config_path: String,
    pub config_source: String,
    pub candidates: Vec<DevCandidate>,
    pub skipped: Vec<TongyunDevSkipped>,
    pub truncated: bool,
}

fn config_dir(home: &Path) -> PathBuf {
    home.join(".config").join("tongyun-dev")
}

fn current_home() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn expand_home(value: &str, home: Option<&Path>) -> PathBuf {
    let trimmed = value.trim();
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        if let Some(dir) = home {
            return dir.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

fn remembered_path(home: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(config_dir(home).join("settings.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let path = value.get("config_path")?.as_str()?.trim();
    if path.is_empty() {
        return None;
    }
    Some(expand_home(path, Some(home)))
}

fn repo_config(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start.to_path_buf());
    while let Some(current) = dir {
        let candidate = current.join("config").join("projects.toml");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = current.parent().map(Path::to_path_buf);
    }
    None
}

/// Same lookup order as the tongyun-dev CLI, minus its `--config` argument.
pub fn resolve_config_source(
    env_value: Option<&str>,
    home: Option<&Path>,
    cwd: Option<&Path>,
) -> std::result::Result<(PathBuf, &'static str), String> {
    if let Some(value) = env_value.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok((expand_home(value, home), "env"));
    }
    if let Some(dir) = home {
        if let Some(remembered) = remembered_path(dir) {
            return Ok((remembered, "remembered"));
        }
        let default = config_dir(dir).join("projects.toml");
        if default.is_file() {
            return Ok((default, "user_default"));
        }
    }
    if let Some(dir) = cwd {
        if let Some(repo) = repo_config(dir) {
            return Ok((repo, "repo"));
        }
    }
    let default_hint = home
        .map(|dir| config_dir(dir).join("projects.toml"))
        .unwrap_or_else(|| PathBuf::from("projects.toml"))
        .to_string_lossy()
        .into_owned();
    Err(format!(
        "没有找到 tongyun-dev 的配置文件。已查找 $TONGYUN_DEV_CONFIG、{default_hint} 以及当前目录及以上的 config/projects.toml。请先在 tongyun-dev 里登记项目，或用 TONGYUN_DEV_CONFIG 指向配置文件。"
    ))
}

fn text_of(table: &toml::Table, key: &str) -> Option<String> {
    table
        .get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn bool_of(table: &toml::Table, key: &str) -> Option<bool> {
    table.get(key).and_then(|value| value.as_bool())
}

fn port_of(table: &toml::Table, key: &str) -> Option<u16> {
    table
        .get(key)
        .and_then(|value| value.as_integer())
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn words_of(table: &toml::Table, key: &str) -> Vec<String> {
    table
        .get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn env_of(table: &toml::Table, key: &str) -> BTreeMap<String, String> {
    table
        .get(key)
        .and_then(|value| value.as_table())
        .map(|items| {
            items
                .iter()
                .filter_map(|(name, value)| {
                    let text = match value {
                        toml::Value::String(text) => text.clone(),
                        other => other.to_string(),
                    };
                    (!name.trim().is_empty()).then(|| (name.clone(), text))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// tongyun-dev stores the start line as an argument array; Studio keeps one shell line per profile.
fn command_of(table: &toml::Table) -> Option<String> {
    let words = words_of(table, "start");
    if !words.is_empty() {
        let line = words
            .iter()
            .map(|word| {
                if word.contains(' ') || word.contains('\t') {
                    format!("\"{word}\"")
                } else {
                    word.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        return Some(line);
    }
    text_of(table, "start")
        .or_else(|| text_of(table, "start_command"))
        .filter(|line| line.chars().count() <= 8192 && !line.contains('\0'))
}

fn bounded_token(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 80
        || trimmed.chars().any(|c| c.is_control())
    {
        return fallback.to_owned();
    }
    trimmed.to_owned()
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Parse the registry text without touching the filesystem, so the mapping stays testable.
/// A row that Studio cannot register is reported in `skipped` instead of failing the whole import.
pub fn parse_registry(
    text: &str,
    config_path: &str,
    config_source: &str,
    existing: &[ExistingProject],
) -> Result<TongyunDevSyncReport> {
    let root: toml::Value =
        text.parse().map_err(|e| format!("配置文件解析失败，已保留原文件：{e}"))?;
    let projects = match root.get("projects") {
        None => return Ok(TongyunDevSyncReport {
            config_path: config_path.to_owned(),
            config_source: config_source.to_owned(),
            candidates: vec![],
            skipped: vec![],
            truncated: false,
        }),
        Some(toml::Value::Table(projects)) => projects,
        Some(_) => return Err("配置文件里的 [projects] 不是项目表，无法导入。".into()),
    };
    let known = existing
        .iter()
        .filter_map(|item| {
            let canonical = std::fs::canonicalize(&item.path).ok()?;
            Some((canonical, item.id.clone(), item.has_dev))
        })
        .collect::<Vec<_>>();

    let mut candidates = Vec::new();
    let mut skipped = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut truncated = false;
    for (key, row) in projects {
        let Some(table) = row.as_table() else {
            skipped.push(TongyunDevSkipped {
                name: bounded_token(key, "未命名项目"),
                reason: "这一条不是项目表，已跳过。".into(),
            });
            continue;
        };
        let name = bounded_token(&text_of(table, "name").unwrap_or_else(|| key.clone()), "未命名项目");
        if bool_of(table, "enabled") == Some(false) {
            let reason = text_of(table, "reason").unwrap_or_else(|| "已停用".into());
            skipped.push(TongyunDevSkipped { name, reason });
            continue;
        }
        let Some(root_text) = text_of(table, "root") else {
            skipped.push(TongyunDevSkipped {
                name,
                reason: "没有配置项目目录 root。".into(),
            });
            continue;
        };
        let root_dir = Path::new(&root_text);
        let canonical = std::fs::canonicalize(root_dir).unwrap_or_else(|_| root_dir.to_path_buf());
        if !canonical.is_dir() {
            skipped.push(TongyunDevSkipped {
                name,
                reason: format!("项目目录不存在：{root_text}"),
            });
            continue;
        }
        // Two rows on one directory would make the whole batch fail the duplicate guard.
        if !seen_paths.insert(canonical.clone()) {
            skipped.push(TongyunDevSkipped {
                name,
                reason: "与前面某条指向同一目录，已跳过。".into(),
            });
            continue;
        }
        let Some(command) = command_of(table) else {
            skipped.push(TongyunDevSkipped {
                name,
                reason: "没有配置启动命令 start。".into(),
            });
            continue;
        };
        if command.chars().count() > 8192 || command.contains('\0') {
            skipped.push(TongyunDevSkipped {
                name,
                reason: "启动命令过长或包含无效字符。".into(),
            });
            continue;
        }

        let mut why = vec![
            "来自 tongyun-dev 的全局登记。".into(),
            "命令与端口按配置文件原样继承。".into(),
        ];
        // tongyun-dev treats login_url as the readiness probe and health_url as its fallback.
        let health_url = text_of(table, "login_url").or_else(|| text_of(table, "health_url"));
        let health_url = match health_url {
            None => None,
            Some(url) if parse_loopback_http(&url).is_some() => Some(url),
            Some(_) => {
                why.push("健康检查只支持本机地址，已忽略。".into());
                None
            }
        };
        let group = match text_of(table, "group") {
            Some(group) if valid_group_key(&group) => Some(group),
            Some(_) => {
                why.push("分组标识不符合规则，已忽略。".into());
                None
            }
            None => None,
        };
        let profiles: BTreeMap<String, EnvPreset> = table
            .get("profiles")
            .and_then(|value| value.as_table())
            .map(|items| {
                items
                    .iter()
                    .map(|(key, preset)| {
                        let missing = toml::Table::new();
                        let row = preset.as_table().unwrap_or(&missing);
                        let name = bounded_token(key, "preset");
                        (
                            name.clone(),
                            EnvPreset {
                                label: text_of(row, "label").unwrap_or_else(|| {
                                    bounded_token(key, "环境预设")
                                }),
                                command: command_of(row),
                                port: port_of(row, "port"),
                                health_url: text_of(row, "health_url")
                                    .filter(|url| parse_loopback_http(url).is_some()),
                                env: env_of(row, "env"),
                                ..EnvPreset::default()
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let default_profile = text_of(table, "default_profile")
            .filter(|value| profiles.contains_key(value.as_str()));

        let matched = known.iter().find(|(path, _, _)| path == &canonical);
        candidates.push(DevCandidate {
            name,
            path: display_path(&canonical),
            kind: "tongyun-dev".into(),
            label: "tongyun-dev 已登记".into(),
            confidence: "high".into(),
            command,
            port: port_of(table, "port"),
            port_guessed: false,
            health_url,
            why,
            already_registered: matched.is_some(),
            existing_project_id: matched.map(|(_, id, _)| id.clone()),
            existing_has_dev: matched.map(|(_, _, has_dev)| *has_dev).unwrap_or(false),
            group,
            depends_on: words_of(table, "depends_on"),
            java: text_of(table, "java"),
            java_home: text_of(table, "java_home"),
            node: text_of(table, "node"),
            node_home: text_of(table, "node_home"),
            catalina_home: text_of(table, "catalina_home"),
            env: env_of(table, "env"),
            default_profile,
            selected_profile: None,
            profiles,
            auto_install: bool_of(table, "auto_install"),
            pull_deps_first: None,
            auto_restart: None,
            max_restarts: None,
            restart_interval_secs: None,
        });
        if candidates.len() == MAX_CANDIDATES && projects.len() > MAX_CANDIDATES {
            truncated = true;
            break;
        }
    }
    Ok(TongyunDevSyncReport {
        config_path: config_path.to_owned(),
        config_source: config_source.to_owned(),
        candidates,
        skipped,
        truncated,
    })
}

/// Read the registry from the location tongyun-dev itself would use.
pub fn read_registry(existing: &[ExistingProject]) -> Result<TongyunDevSyncReport> {
    let (path, source) = resolve_config_source(
        std::env::var("TONGYUN_DEV_CONFIG").ok().as_deref(),
        current_home().as_deref(),
        std::env::current_dir().ok().as_deref(),
    )?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("无法读取 {}：{e}", display_path(&path)))?;
    parse_registry(&text, &display_path(&path), source, existing)
}
