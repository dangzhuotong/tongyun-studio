use std::fs;
use std::net::TcpListener;
use std::sync::Arc;
use studio_core::agent_http::start_agent_server;
use studio_core::dev_runtime::{
    detect_install_command, detect_package_manager, gradle_install_command, maven_install_command,
    node_deps_missing, DevProfile, PackageManager, DEPS_MISSING_MSG,
};
use studio_core::{Project, ServiceManager, WorkspaceStore};

#[test]
fn test_package_manager_and_lockfile_detection() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    // Not a node project (no package.json)
    assert_eq!(detect_package_manager(root), None);
    assert!(!node_deps_missing(root));

    // Has package.json but no lockfile -> default npm
    fs::write(root.join("package.json"), "{}").unwrap();
    assert_eq!(detect_package_manager(root), Some(PackageManager::Npm));
    assert_eq!(PackageManager::Npm.install_command(), "npm install");
    assert!(node_deps_missing(root));

    // Has package-lock.json -> npm
    fs::write(root.join("package-lock.json"), "{}").unwrap();
    assert_eq!(detect_package_manager(root), Some(PackageManager::Npm));

    // Has yarn.lock -> yarn
    fs::write(root.join("yarn.lock"), "").unwrap();
    assert_eq!(detect_package_manager(root), Some(PackageManager::Yarn));
    assert_eq!(PackageManager::Yarn.install_command(), "yarn install");

    // Has pnpm-lock.yaml -> pnpm (pnpm takes priority)
    fs::write(root.join("pnpm-lock.yaml"), "").unwrap();
    assert_eq!(detect_package_manager(root), Some(PackageManager::Pnpm));
    assert_eq!(PackageManager::Pnpm.install_command(), "pnpm install");

    // Create node_modules -> no longer missing
    fs::create_dir(root.join("node_modules")).unwrap();
    assert!(!node_deps_missing(root));
}

#[test]
fn test_maven_and_gradle_install_commands() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    // Maven without mvnw
    fs::write(root.join("pom.xml"), "<project></project>").unwrap();
    assert_eq!(maven_install_command(root), "mvn dependency:resolve");
    assert_eq!(
        detect_install_command(root, None).as_deref(),
        Some("mvn dependency:resolve")
    );

    // Maven with mvnw
    fs::write(root.join("mvnw"), "#!/bin/sh").unwrap();
    assert_eq!(maven_install_command(root), "./mvnw dependency:resolve");
    assert_eq!(
        detect_install_command(root, None).as_deref(),
        Some("./mvnw dependency:resolve")
    );

    let tmp_gradle = tempfile::tempdir().unwrap();
    let g_root = tmp_gradle.path();

    // Gradle without gradlew
    fs::write(g_root.join("build.gradle"), "// gradle").unwrap();
    assert_eq!(gradle_install_command(g_root), "gradle dependencies");
    assert_eq!(
        detect_install_command(g_root, None).as_deref(),
        Some("gradle dependencies")
    );

    // Gradle with gradlew
    fs::write(g_root.join("gradlew"), "#!/bin/sh").unwrap();
    assert_eq!(gradle_install_command(g_root), "./gradlew dependencies");
    assert_eq!(
        detect_install_command(g_root, None).as_deref(),
        Some("./gradlew dependencies")
    );
}

#[test]
fn test_auto_install_turned_off_refuses_to_start_missing_node_deps() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::write(root.join("package.json"), "{}").unwrap();

    let services = ServiceManager::new();
    let project = Project {
        id: "proj-auto-install-off".into(),
        name: "Test Proj".into(),
        path: root.to_str().unwrap().into(),
        created_at: "2026-10-29T00:00:00Z".into(),
        dev: Some(DevProfile {
            command: "npm run dev".into(),
            auto_install: Some(false), // Turned off in settings
            ..Default::default()
        }),
    };

    let err = services
        .start(&project, "npm run dev")
        .expect_err("start must fail when auto_install is off and node_modules is missing");

    assert_eq!(err, DEPS_MISSING_MSG);
}

#[test]
fn test_workspace_store_updates_project_dev_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let ws_path = tmp.path().join("workspace.json");
    let store = WorkspaceStore::new(ws_path);

    let p_dir = tmp.path().join("my-project");
    fs::create_dir_all(&p_dir).unwrap();
    fs::write(p_dir.join("package.json"), "{}").unwrap();

    let ws = store.add(p_dir.to_str().unwrap()).unwrap();
    let p_id = ws.projects[0].id.clone();

    // Update settings: turn off autoInstall, enable pullDepsFirst
    let profile = DevProfile {
        command: "npm start".into(),
        auto_install: Some(false),
        pull_deps_first: Some(true),
        kind: "node".into(),
        label: "Node".into(),
        ..Default::default()
    };
    let updated_ws = store.update_project_dev(&p_id, Some(profile)).unwrap();
    let proj = updated_ws
        .projects
        .iter()
        .find(|p| p.id == p_id)
        .expect("project found");
    let dev = proj.dev.as_ref().expect("dev profile attached");
    assert_eq!(dev.auto_install, Some(false));
    assert_eq!(dev.pull_deps_first, Some(true));

    // Reload from disk to verify persistence
    let reloaded = store.load().unwrap();
    let r_proj = reloaded
        .projects
        .iter()
        .find(|p| p.id == p_id)
        .expect("reloaded project");
    let r_dev = r_proj.dev.as_ref().expect("reloaded dev profile");
    assert_eq!(r_dev.auto_install, Some(false));
    assert_eq!(r_dev.pull_deps_first, Some(true));
}

#[test]
fn test_agent_http_reflects_deps_missing_and_install_command() {
    let tmp = tempfile::tempdir().unwrap();
    let ws_path = tmp.path().join("workspace.json");
    let store = Arc::new(WorkspaceStore::new(ws_path));

    let p_dir = tmp.path().join("node-app");
    fs::create_dir_all(&p_dir).unwrap();
    fs::write(p_dir.join("package.json"), "{}").unwrap();
    fs::write(p_dir.join("pnpm-lock.yaml"), "").unwrap();

    let ws = store.add(p_dir.to_str().unwrap()).unwrap();
    let p_id = ws.projects[0].id.clone();

    store
        .update_project_dev(
            &p_id,
            Some(DevProfile {
                command: "pnpm dev".into(),
                auto_install: Some(true),
                kind: "vite".into(),
                label: "Vite".into(),
                ..Default::default()
            }),
        )
        .unwrap();

    let services = Arc::new(ServiceManager::new());
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let mut handle = start_agent_server(Arc::clone(&store), Arc::clone(&services), port).unwrap();

    // Query GET /api/projects/:id
    let client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut client = client;
    use std::io::{Read, Write};
    let req = format!(
        "GET /api/projects/{p_id} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    client.write_all(req.as_bytes()).unwrap();

    let mut resp = Vec::new();
    client.read_to_end(&mut resp).unwrap();
    let resp_str = String::from_utf8_lossy(&resp);
    let body = resp_str.split("\r\n\r\n").nth(1).unwrap();
    let val: serde_json::Value = serde_json::from_str(body).unwrap();

    assert_eq!(val["ok"], true);
    let project = &val["project"];
    assert_eq!(project["deps_missing"], true);
    assert_eq!(project["install_command"], "pnpm install");
    assert_eq!(project["auto_install"], true);
    assert_eq!(project["pull_deps_first"], false);

    // Test POST /api/projects/:id/install
    let client2 = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut client2 = client2;
    let post_req = format!("POST /api/projects/{p_id}/install HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    client2.write_all(post_req.as_bytes()).unwrap();

    let mut resp2 = Vec::new();
    client2.read_to_end(&mut resp2).unwrap();
    let resp2_str = String::from_utf8_lossy(&resp2);
    let body2 = resp2_str.split("\r\n\r\n").nth(1).unwrap();
    let val2: serde_json::Value = serde_json::from_str(body2).unwrap();
    #[cfg(unix)]
    {
        assert_eq!(val2["ok"], true);
        assert_eq!(val2["status"]["state"], "installing");
    }
    #[cfg(not(unix))]
    {
        assert_eq!(val2["ok"], false);
        assert!(val2["error"].as_str().unwrap().contains("macOS / Unix"));
    }

    handle.stop();
}

#[cfg(unix)]
mod unix_lifecycle_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn test_auto_install_success_then_starts_service() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("pnpm-lock.yaml"), "").unwrap();

        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let fake_pnpm = bin_dir.join("pnpm");
        fs::write(
            &fake_pnpm,
            "#!/bin/sh\necho 'installing pnpm deps...'\nmkdir -p node_modules\nexit 0\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&fake_pnpm, fs::Permissions::from_mode(0o755)).unwrap();

        let orig_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{}", bin_dir.display(), orig_path));

        let services = ServiceManager::new();
        let project = Project {
            id: "proj-auto-install-ok".into(),
            name: "Test OK".into(),
            path: root.to_str().unwrap().into(),
            created_at: "2026-10-29T00:00:00Z".into(),
            dev: Some(DevProfile {
                command: "echo server-ready; sleep 1".into(),
                auto_install: Some(true),
                kind: "node".into(),
                label: "Node".into(),
                ..Default::default()
            }),
        };

        let started = services
            .start(&project, "echo server-ready; sleep 1")
            .unwrap();
        assert_eq!(started.lifecycle, "installing");

        let mut finished = false;
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(100));
            let list = services.list(&project.id).unwrap();
            if let Some(s) = list.into_iter().next() {
                if s.lifecycle == "starting" || s.lifecycle == "ready" || s.lifecycle == "exited" {
                    finished = true;
                    assert!(
                        s.log_tail.contains("检测到依赖未安装")
                            || s.stdout.contains("installing pnpm deps")
                    );
                    break;
                }
            }
        }
        std::env::set_var("PATH", orig_path);
        assert!(finished, "service did not transition out of installing");
        assert!(root.join("node_modules").is_dir());
    }

    #[test]
    fn test_auto_install_failure_marks_failed_and_gives_reason() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("yarn.lock"), "").unwrap();

        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let fake_yarn = bin_dir.join("yarn");
        fs::write(
            &fake_yarn,
            "#!/bin/sh\necho 'network error while fetching'\nexit 1\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&fake_yarn, fs::Permissions::from_mode(0o755)).unwrap();

        let orig_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{}", bin_dir.display(), orig_path));

        let services = ServiceManager::new();
        let project = Project {
            id: "proj-auto-install-fail".into(),
            name: "Test Fail".into(),
            path: root.to_str().unwrap().into(),
            created_at: "2026-10-29T00:00:00Z".into(),
            dev: Some(DevProfile {
                command: "echo server-started".into(),
                auto_install: Some(true),
                kind: "node".into(),
                label: "Node".into(),
                ..Default::default()
            }),
        };

        let started = services.start(&project, "echo server-started").unwrap();
        assert_eq!(started.lifecycle, "installing");

        let mut failed = false;
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(100));
            let list = services.list(&project.id).unwrap();
            if let Some(s) = list.into_iter().next() {
                if s.lifecycle == "failed" {
                    failed = true;
                    assert!(s.failure.as_deref().unwrap_or("").contains("退出码"));
                    break;
                }
            }
        }
        std::env::set_var("PATH", orig_path);
        assert!(failed, "service did not fail on exit code 1");
        assert!(!root.join("node_modules").is_dir());
    }
}
