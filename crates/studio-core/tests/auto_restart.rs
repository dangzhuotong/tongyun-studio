use std::collections::BTreeMap;
use studio_core::dev_runtime::{DevProfile, EnvPreset};
use studio_core::{Project, WorkspaceStore};

#[test]
fn test_dev_profile_auto_restart_serde() {
    // 1. Default serialization has no auto_restart fields
    let profile = DevProfile {
        command: "npm run dev".into(),
        kind: "node".into(),
        label: "Node".into(),
        ..Default::default()
    };
    assert_eq!(profile.auto_restart, None);
    assert_eq!(profile.max_restarts, None);
    assert_eq!(profile.restart_interval_secs, None);

    let json_str = serde_json::to_string(&profile).unwrap();
    assert!(!json_str.contains("autoRestart"));
    assert!(!json_str.contains("auto_restart"));

    // 2. camelCase deserialization
    let json_camel = r#"{
        "command": "npm run dev",
        "kind": "node",
        "label": "Node",
        "autoRestart": true,
        "maxRestarts": 5,
        "restartIntervalSecs": 15
    }"#;
    let parsed_camel: DevProfile = serde_json::from_str(json_camel).unwrap();
    assert_eq!(parsed_camel.auto_restart, Some(true));
    assert_eq!(parsed_camel.max_restarts, Some(5));
    assert_eq!(parsed_camel.restart_interval_secs, Some(15));

    // 3. snake_case alias deserialization
    let json_snake = r#"{
        "command": "cargo run",
        "kind": "rust",
        "label": "Rust",
        "auto_restart": true,
        "max_restarts": 4,
        "restart_interval_secs": 30
    }"#;
    let parsed_snake: DevProfile = serde_json::from_str(json_snake).unwrap();
    assert_eq!(parsed_snake.auto_restart, Some(true));
    assert_eq!(parsed_snake.max_restarts, Some(4));
    assert_eq!(parsed_snake.restart_interval_secs, Some(30));
}

#[test]
fn test_workspace_store_update_project_auto_restart() {
    let temp = tempfile::tempdir().unwrap();
    let store_path = temp.path().join("workspace.json");
    let store = WorkspaceStore::new(store_path);

    // Create a mock project directory
    let proj_dir = temp.path().join("my-project");
    std::fs::create_dir_all(&proj_dir).unwrap();

    let ws = store.add(proj_dir.to_str().unwrap()).unwrap();
    let project_id = ws.projects[0].id.clone();

    // Updating a project without dev profile fails gracefully
    let err = store.update_project_auto_restart(&project_id, true, Some(3), Some(60));
    assert!(err.is_err());

    // Import a dev profile
    let candidate = studio_core::DevCandidate {
        name: "my-project".into(),
        path: proj_dir.to_str().unwrap().into(),
        kind: "node".into(),
        label: "Node".into(),
        confidence: "high".into(),
        command: "npm start".into(),
        port: Some(3000),
        port_guessed: false,
        health_url: None,
        why: vec![],
        already_registered: true,
        existing_project_id: Some(project_id.clone()),
        existing_has_dev: false,
        group: None,
        depends_on: vec![],
        java: None,
        java_home: None,
        node: None,
        node_home: None,
        catalina_home: None,
        env: BTreeMap::new(),
        default_profile: None,
        selected_profile: None,
        profiles: BTreeMap::new(),
        auto_install: None,
        pull_deps_first: None,
        auto_restart: None,
        max_restarts: None,
        restart_interval_secs: None,
    };
    store.import_dev_candidates(&[candidate]).unwrap();

    // Default auto_restart is None
    let p = store.project(&project_id).unwrap();
    assert_eq!(p.dev.as_ref().unwrap().auto_restart, None);

    // Enable auto_restart
    let updated = store
        .update_project_auto_restart(&project_id, true, Some(5), Some(45))
        .unwrap();
    let dev = updated.dev.unwrap();
    assert_eq!(dev.auto_restart, Some(true));
    assert_eq!(dev.max_restarts, Some(5));
    assert_eq!(dev.restart_interval_secs, Some(45));

    // Reload from disk to verify persistence
    let reloaded = store.project(&project_id).unwrap();
    let reloaded_dev = reloaded.dev.unwrap();
    assert_eq!(reloaded_dev.auto_restart, Some(true));
    assert_eq!(reloaded_dev.max_restarts, Some(5));
    assert_eq!(reloaded_dev.restart_interval_secs, Some(45));

    // Disable auto_restart
    let disabled = store
        .update_project_auto_restart(&project_id, false, None, None)
        .unwrap();
    assert_eq!(disabled.dev.unwrap().auto_restart, Some(false));
}

#[test]
fn test_env_preset_auto_restart_inheritance() {
    let mut profiles = BTreeMap::new();
    profiles.insert(
        "resilient".into(),
        EnvPreset {
            label: "Resilient".into(),
            command: Some("npm run dev:resilient".into()),
            port: Some(8080),
            health_url: None,
            env: BTreeMap::new(),
            auto_restart: Some(true),
            max_restarts: Some(10),
            restart_interval_secs: Some(15),
        },
    );

    let profile = DevProfile {
        command: "npm run dev".into(),
        kind: "node".into(),
        label: "Node".into(),
        auto_restart: Some(false),
        max_restarts: Some(2),
        profiles,
        ..Default::default()
    };

    assert_eq!(profile.auto_restart, Some(false));
    let preset = profile.profiles.get("resilient").unwrap();
    assert_eq!(preset.auto_restart, Some(true));
    assert_eq!(preset.max_restarts, Some(10));
    assert_eq!(preset.restart_interval_secs, Some(15));
}

#[cfg(unix)]
#[test]
fn test_unix_auto_restart_lifecycle_and_user_stop() {
    use std::thread;
    use std::time::{Duration, Instant};
    use studio_core::ServiceManager;

    let temp = tempfile::tempdir().unwrap();
    let manager = ServiceManager::new();

    // 1. Abnormal exit restarts up to max_restarts then marks failed with reason
    let project = Project {
        id: "proj-restart-crash".into(),
        name: "Crash Test".into(),
        path: temp.path().to_str().unwrap().into(),
        created_at: String::new(),
        dev: Some(DevProfile {
            command: "printf crash_output >&2; exit 3".into(),
            kind: "test".into(),
            label: "Test".into(),
            auto_restart: Some(true),
            max_restarts: Some(2),
            restart_interval_secs: Some(10),
            ..Default::default()
        }),
    };

    let started = manager.start(&project, "printf crash_output >&2; exit 3").unwrap();
    assert_eq!(started.restart_count, 0);

    // Wait until it reaches the limit and marks failed
    let start_wait = Instant::now();
    loop {
        let list = manager.list(&project.id).unwrap();
        let svc = &list[0];
        if svc.status == "failed" {
            assert_eq!(svc.lifecycle, "failed");
            assert_eq!(svc.restart_count, 2);
            assert!(
                svc.failure
                    .as_deref()
                    .unwrap_or("")
                    .contains("已达自动重启上限（2次）"),
                "expected failure reason, got: {:?}",
                svc.failure
            );
            assert!(
                svc.stderr.contains("[自动重启]"),
                "expected stderr log tail, got: {}",
                svc.stderr
            );
            break;
        }
        assert!(
            start_wait.elapsed() < Duration::from_secs(10),
            "timed out waiting for auto-restart limit"
        );
        thread::sleep(Duration::from_millis(50));
    }

    // 2. User stop does NOT trigger auto restart
    let stop_proj = Project {
        id: "proj-stop-no-restart".into(),
        name: "Stop Test".into(),
        path: temp.path().to_str().unwrap().into(),
        created_at: String::new(),
        dev: Some(DevProfile {
            command: "sleep 60".into(),
            kind: "test".into(),
            label: "Test".into(),
            auto_restart: Some(true),
            max_restarts: Some(3),
            ..Default::default()
        }),
    };

    let started_sleep = manager.start(&stop_proj, "sleep 60").unwrap();
    assert_eq!(started_sleep.status, "running");

    let stopped = manager.stop(&stop_proj.id, &started_sleep.id).unwrap();
    assert_eq!(stopped.status, "stopped");
    assert_eq!(stopped.lifecycle, "stopped");
    assert_eq!(stopped.restart_count, 0);

    // Refresh again, must remain stopped
    thread::sleep(Duration::from_millis(100));
    let rechecked = manager.list(&stop_proj.id).unwrap();
    assert_eq!(rechecked[0].status, "stopped");
    assert_eq!(rechecked[0].lifecycle, "stopped");
    assert_eq!(rechecked[0].restart_count, 0);
}
