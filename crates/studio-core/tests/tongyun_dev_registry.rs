//! Studio must be able to register the projects a person already configured in tongyun-dev,
//! and one unusable row must not poison the whole import.
use std::fs;
use std::path::{Path, PathBuf};

use studio_core::dev_runtime::{prepare_import, ExistingProject};
use studio_core::tongyun_dev::{parse_registry, resolve_config_source};

fn dir_text(dir: &Path) -> String {
    fs::canonicalize(dir)
        .unwrap_or_else(|_| dir.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn project_row(root: &Path, extra: &str) -> String {
    format!(
        "[projects.demo]\nroot = '{}'\nstart = [\"pnpm\", \"dev\"]\nport = 1430\n{extra}\n",
        dir_text(root)
    )
}

fn parse(text: &str, existing: &[ExistingProject]) -> studio_core::TongyunDevSyncReport {
    parse_registry(text, "/synthetic/projects.toml", "user_default", existing)
        .unwrap_or_else(|error| panic!("解析失败：{error}"))
}

#[test]
fn registered_project_becomes_a_high_confidence_candidate() {
    let root = tempfile::tempdir().unwrap();
    let report = parse(
        &project_row(
            root.path(),
            "name = \"示例应用\"\ngroup = \"web\"\nhealth_url = \"http://127.0.0.1:1430/health\"\nenv = { CI = \"1\" }\nauto_install = false\ndepends_on = [\"demo_db\"]\n",
        ),
        &[],
    );
    assert_eq!(report.candidates.len(), 1);
    assert!(report.skipped.is_empty());
    let candidate = &report.candidates[0];
    assert_eq!(candidate.name, "示例应用");
    assert_eq!(candidate.kind, "tongyun-dev");
    assert_eq!(candidate.confidence, "high");
    assert_eq!(candidate.command, "pnpm dev");
    assert_eq!(candidate.port, Some(1430));
    assert_eq!(candidate.group.as_deref(), Some("web"));
    assert_eq!(candidate.health_url.as_deref(), Some("http://127.0.0.1:1430/health"));
    assert_eq!(candidate.env.get("CI").map(String::as_str), Some("1"));
    assert_eq!(candidate.auto_install, Some(false));
    assert_eq!(candidate.depends_on, vec!["demo_db".to_string()]);
    assert!(!candidate.already_registered);
    assert!(!report.truncated);
}

#[test]
fn loopback_probe_prefers_login_url_and_falls_back_to_health_url() {
    let root = tempfile::tempdir().unwrap();
    let both = parse(
        &project_row(
            root.path(),
            "health_url = \"http://127.0.0.1:1430/actuator/health\"\nlogin_url = \"http://127.0.0.1:1430/\"\n",
        ),
        &[],
    );
    assert_eq!(
        both.candidates[0].health_url.as_deref(),
        Some("http://127.0.0.1:1430/")
    );
    let only_health = parse(
        &project_row(root.path(), "health_url = \"http://127.0.0.1:1430/\"\n"),
        &[],
    );
    assert_eq!(
        only_health.candidates[0].health_url.as_deref(),
        Some("http://127.0.0.1:1430/")
    );
}

#[test]
fn quoted_argument_keeps_the_shell_line_together() {
    let root = tempfile::tempdir().unwrap();
    let text = format!(
        "[projects.demo]\nroot = '{}'\nstart = [\"cmd\", \"/C\", \"pnpm dev\"]\n",
        dir_text(root.path())
    );
    let report = parse(&text, &[]);
    assert_eq!(report.candidates[0].command, "cmd /C \"pnpm dev\"");
    assert_eq!(report.candidates[0].name, "demo", "缺 name 时用配置里的项目标识");
}

#[test]
fn profiles_and_default_profile_carry_over() {
    let root = tempfile::tempdir().unwrap();
    let text = format!(
        "[projects.demo]\nroot = '{}'\nstart = [\"pnpm\", \"dev\"]\ndefault_profile = \"dev\"\n\n[projects.demo.profiles.dev]\nlabel = \"本地开发\"\nstart = \"pnpm dev\"\nport = 3000\nenv = {{ NODE_ENV = \"development\" }}\n",
        dir_text(root.path())
    );
    let report = parse(&text, &[]);
    let candidate = &report.candidates[0];
    assert_eq!(candidate.default_profile.as_deref(), Some("dev"));
    let preset = candidate.profiles.get("dev").expect("缺少环境预设");
    assert_eq!(preset.label, "本地开发");
    assert_eq!(preset.command.as_deref(), Some("pnpm dev"));
    assert_eq!(preset.port, Some(3000));
    assert_eq!(preset.env.get("NODE_ENV").map(String::as_str), Some("development"));
}

#[test]
fn unknown_default_profile_is_dropped_instead_of_failing_the_row() {
    let root = tempfile::tempdir().unwrap();
    let text = project_row(root.path(), "default_profile = \"missing\"\n");
    assert_eq!(parse(&text, &[]).candidates[0].default_profile, None);
}

#[test]
fn disabled_row_is_skipped_with_its_reason() {
    let root = tempfile::tempdir().unwrap();
    let text = project_row(root.path(), "enabled = false\nreason = \"等数据库先起来\"\n");
    let report = parse(&text, &[]);
    assert!(report.candidates.is_empty());
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].name, "demo");
    assert_eq!(report.skipped[0].reason, "等数据库先起来");
}

#[test]
fn missing_directory_or_command_is_skipped() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("gone");
    let text = format!(
        "{}\n[projects.nocmd]\nroot = '{}'\n",
        project_row(missing.as_path(), ""),
        dir_text(root.path())
    );
    let report = parse(&text, &[]);
    assert!(report.candidates.is_empty());
    assert_eq!(report.skipped.len(), 2);
    let reasons = report
        .skipped
        .iter()
        .map(|item| item.reason.as_str())
        .collect::<Vec<_>>();
    assert!(reasons.iter().any(|reason| reason.contains("项目目录不存在")), "{reasons:?}");
    assert!(reasons.iter().any(|reason| reason.contains("启动命令")), "{reasons:?}");
}

#[test]
fn two_rows_on_the_same_directory_do_not_break_the_batch() {
    let root = tempfile::tempdir().unwrap();
    let text = format!(
        "{}\n[projects.copy]\nroot = '{}'\nstart = [\"pnpm\", \"dev\"]\n",
        project_row(root.path(), ""),
        dir_text(root.path())
    );
    let report = parse(&text, &[]);
    assert_eq!(report.candidates.len(), 1);
    // `[projects.*]` keys are read in sorted order, so the later duplicate is the one dropped.
    assert_eq!(report.candidates[0].name, "copy");
    assert_eq!(report.skipped[0].name, "demo");
    assert!(report.skipped[0].reason.contains("同一目录"), "{}", report.skipped[0].reason);
}

#[test]
fn unusable_values_are_downgraded_so_the_batch_stays_importable() {
    let root = tempfile::tempdir().unwrap();
    let text = project_row(
        root.path(),
        "group = \"Bad Group\"\nhealth_url = \"http://10.0.0.8:1430/health\"\n",
    );
    let report = parse(&text, &[]);
    let candidate = &report.candidates[0];
    assert_eq!(candidate.group, None);
    assert_eq!(candidate.health_url, None);
    assert!(candidate.why.iter().any(|note| note.contains("分组标识")), "{:?}", candidate.why);
    assert!(candidate.why.iter().any(|note| note.contains("健康检查")), "{:?}", candidate.why);
    // The point of downgrading instead of erroring: the row still imports.
    prepare_import(candidate).unwrap_or_else(|error| panic!("这条候选应当可登记：{error}"));
}

#[test]
fn parsed_candidates_pass_the_same_import_guards_as_a_scan() {
    let root = tempfile::tempdir().unwrap();
    let report = parse(&project_row(root.path(), ""), &[]);
    let prepared = prepare_import(&report.candidates[0]).unwrap();
    assert_eq!(prepared.name, "demo");
    assert_eq!(prepared.profile.kind, "tongyun-dev");
    assert_eq!(prepared.profile.command, "pnpm dev");
}

#[test]
fn already_registered_rows_are_marked_like_a_directory_scan() {
    let root = tempfile::tempdir().unwrap();
    let path = dir_text(root.path());
    let existing = vec![ExistingProject {
        id: "project-1".into(),
        path: path.clone(),
        has_dev: true,
    }];
    let report = parse(&project_row(root.path(), ""), &existing);
    let candidate = &report.candidates[0];
    assert_eq!(candidate.path, path);
    assert!(candidate.already_registered);
    assert_eq!(candidate.existing_project_id.as_deref(), Some("project-1"));
    assert!(candidate.existing_has_dev, "已有运行配置的目录不能被覆盖");
}

#[test]
fn empty_or_missing_projects_table_is_not_an_error() {
    let report = parse("[projects]\n", &[]);
    assert!(report.candidates.is_empty() && report.skipped.is_empty());
    let error = parse_registry("projects = 1\n", "/synthetic", "env", &[]).unwrap_err();
    assert!(error.contains("[projects]"), "{error}");
}

#[test]
fn broken_toml_keeps_the_file_and_says_so() {
    let error = parse_registry("[projects.demo\nroot = ", "/synthetic", "env", &[]).unwrap_err();
    assert!(error.contains("解析失败"), "{error}");
}

#[test]
fn config_lookup_follows_tongyun_dev_order() {
    let home = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    let config_dir = home.path().join(".config").join("tongyun-dev");
    fs::create_dir_all(&config_dir).unwrap();
    let default = config_dir.join("projects.toml");

    let from_env = resolve_config_source(Some(" /elsewhere/projects.toml "), Some(home.path()), Some(cwd.path())).unwrap();
    assert_eq!(from_env.0, PathBuf::from("/elsewhere/projects.toml"));
    assert_eq!(from_env.1, "env");

    let no_file = resolve_config_source(None, Some(home.path()), Some(cwd.path()));
    assert!(no_file.is_err(), "没有配置文件时要说清查过哪里");
    assert!(no_file.unwrap_err().contains("TONGYUN_DEV_CONFIG"));

    fs::write(&default, "[projects]\n").unwrap();
    let user_default = resolve_config_source(None, Some(home.path()), Some(cwd.path())).unwrap();
    assert_eq!(user_default.0, default);
    assert_eq!(user_default.1, "user_default");

    let remembered = home.path().join("real.toml");
    fs::write(&remembered, "[projects]\n").unwrap();
    fs::write(
        config_dir.join("settings.json"),
        format!("{{\"config_path\": \"{}\"}}", remembered.to_string_lossy().replace('\\', "\\\\")),
    )
    .unwrap();
    let chosen = resolve_config_source(None, Some(home.path()), Some(cwd.path())).unwrap();
    assert_eq!(chosen.1, "remembered");
    assert_eq!(chosen.0, remembered);
}

#[test]
fn repository_config_is_the_last_candidate() {
    let home = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    fs::create_dir_all(cwd.path().join("config")).unwrap();
    let repo_config = cwd.path().join("config").join("projects.toml");
    fs::write(&repo_config, "[projects]\n").unwrap();
    let chosen = resolve_config_source(None, Some(home.path()), Some(cwd.path())).unwrap();
    assert_eq!(chosen.1, "repo");
    assert_eq!(chosen.0, repo_config);
}

#[test]
fn a_large_registry_is_capped_where_the_import_limit_sits() {
    let root = tempfile::tempdir().unwrap();
    let mut text = String::new();
    for index in 0..70 {
        let dir = root.path().join(format!("p{index:02}"));
        fs::create_dir_all(&dir).unwrap();
        text.push_str(&format!(
            "[projects.p{index:02}]\nroot = '{}'\nstart = [\"pnpm\", \"dev\"]\n\n",
            dir_text(&dir)
        ));
    }
    let report = parse(&text, &[]);
    assert_eq!(report.candidates.len(), 64);
    assert!(report.truncated);
}
