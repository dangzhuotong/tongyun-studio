use studio_core::{
    dev_runtime::DevProfile,
    processes::sort_projects_by_dependencies,
    Project, ServiceManager,
};

fn make_project(id: &str, name: &str, group: &str, depends_on: &[&str]) -> Project {
    Project {
        id: id.into(),
        name: name.into(),
        path: "C:/fake/path".into(),
        created_at: "2026-10-28T00:00:00Z".into(),
        dev: Some(DevProfile {
            command: format!("npm run start-{}", name),
            port: Some(3000),
            health_url: None,
            kind: "node".into(),
            label: name.into(),
            group: Some(group.into()),
            confidence: Some("high".into()),
            depends_on: depends_on.iter().map(|s| s.to_string()).collect(),
            ready_timeout_secs: Some(5),
            ..Default::default()
        }),
    }
}

#[test]
fn test_topological_sort_orders_dependencies_before_dependents() {
    let p_db = make_project("db-id", "db", "backend", &[]);
    let p_api = make_project("api-id", "api", "backend", &["db"]);
    let p_web = make_project("web-id", "web", "backend", &["api-id"]);

    let projects = vec![&p_web, &p_api, &p_db];
    let sorted = sort_projects_by_dependencies(&projects).expect("should sort without cycle");

    let ids: Vec<&str> = sorted.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["db-id", "api-id", "web-id"]);
}

#[test]
fn test_cycle_detection_direct_cycle() {
    let p_a = make_project("a", "service-a", "test-group", &["service-b"]);
    let p_b = make_project("b", "service-b", "test-group", &["service-a"]);

    let projects = vec![&p_a, &p_b];
    let err = sort_projects_by_dependencies(&projects).unwrap_err();

    assert!(err.contains("检测到循环依赖："), "error was: {err}");
    assert!(err.contains("service-a") && err.contains("service-b"), "error was: {err}");
}

#[test]
fn test_cycle_detection_self_cycle() {
    let p_a = make_project("a", "service-a", "test-group", &["service-a"]);

    let projects = vec![&p_a];
    let err = sort_projects_by_dependencies(&projects).unwrap_err();

    assert!(err.contains("检测到循环依赖："), "error was: {err}");
    assert!(err.contains("service-a -> service-a"), "error was: {err}");
}

#[test]
fn test_cycle_detection_transitive_cycle() {
    let p_a = make_project("a", "service-a", "test-group", &["service-b"]);
    let p_b = make_project("b", "service-b", "test-group", &["service-c"]);
    let p_c = make_project("c", "service-c", "test-group", &["service-a"]);

    let projects = vec![&p_a, &p_b, &p_c];
    let err = sort_projects_by_dependencies(&projects).unwrap_err();

    assert!(err.contains("检测到循环依赖："), "error was: {err}");
    assert!(err.contains("service-a") && err.contains("service-b") && err.contains("service-c"), "error was: {err}");
}

#[test]
fn test_create_skipped_service_marks_failure_and_blocker() {
    let manager = ServiceManager::new();
    let p_api = make_project("api-id", "api", "backend", &["db"]);

    let reason = "被依赖服务 db 挡住，已跳过启动";
    let skipped = manager
        .create_skipped_service(&p_api, "npm run start-api", reason)
        .expect("should create skipped service");

    assert_eq!(skipped.status, "failed");
    assert_eq!(skipped.lifecycle, "failed");
    assert_eq!(skipped.pid, None);
    assert_eq!(skipped.failure.as_deref(), Some("被依赖服务 db 挡住，已跳过启动"));
    assert!(skipped.log_tail.contains("跳过启动"));
    assert!(skipped.log_tail.contains("被依赖服务 db 挡住"));

    // Verify it is listed under the project
    let list = manager.list(&p_api.id).expect("should list services");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, skipped.id);
    assert_eq!(list[0].lifecycle, "failed");
    assert_eq!(list[0].failure.as_deref(), Some("被依赖服务 db 挡住，已跳过启动"));
}

#[test]
fn test_project_dev_profile_serde_camel_and_snake() {
    let json_camel = r#"{
        "command": "cargo run",
        "port": 8080,
        "kind": "rust",
        "label": "API",
        "dependsOn": ["postgres", "redis"],
        "catalinaHome": "/opt/tomcat"
    }"#;

    let profile: DevProfile = serde_json::from_str(json_camel).unwrap();
    assert_eq!(profile.depends_on, vec!["postgres", "redis"]);
    assert_eq!(profile.catalina_home.as_deref(), Some("/opt/tomcat"));

    let json_snake = r#"{
        "command": "cargo run",
        "port": 8080,
        "kind": "rust",
        "label": "API",
        "depends_on": ["postgres"],
        "catalina_home": "/opt/tomcat"
    }"#;

    let profile_snake: DevProfile = serde_json::from_str(json_snake).unwrap();
    assert_eq!(profile_snake.depends_on, vec!["postgres"]);
    assert_eq!(profile_snake.catalina_home.as_deref(), Some("/opt/tomcat"));
}
