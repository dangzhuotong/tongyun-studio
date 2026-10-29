use std::fs;
use std::sync::Arc;
use studio_core::{
    agent_http::start_agent_server, default_log_dir, read_tail_with_backup,
    safe_project_filename, DevProfile, Project, RollingLogWriter, ServiceManager,
    Workspace,
};
use tempfile::tempdir;

#[test]
fn test_default_log_dir_and_safe_filename() {
    let safe = safe_project_filename("proj-123/abc:test!@#$");
    assert_eq!(safe, "proj-123_abc_test____");

    let empty = safe_project_filename("   ");
    assert_eq!(empty, "project");

    let dir = tempdir().unwrap();
    std::env::set_var("TONGYUN_STUDIO_LOG_DIR", dir.path().to_str().unwrap());
    assert_eq!(default_log_dir(), dir.path());
    std::env::remove_var("TONGYUN_STUDIO_LOG_DIR");
}

#[test]
fn test_rolling_log_writer_basic_append_and_rotation() {
    let dir = tempdir().unwrap();
    let log_path = dir.path().join("test_app.log");
    let rolled_path = dir.path().join("test_app.log.1");

    // Max bytes set to 80 bytes for testing rotation
    let writer = RollingLogWriter::new(log_path.clone(), rolled_path.clone(), 80);

    // 1. Initial write
    writer.append(b"Line 1: first output\n");
    assert!(log_path.is_file());
    assert!(!rolled_path.exists());
    let content = fs::read_to_string(&log_path).unwrap();
    assert_eq!(content, "Line 1: first output\n");

    // 2. Second write (still below 80 bytes)
    writer.append(b"Line 2: second output\n");
    assert!(!rolled_path.exists());
    let content = fs::read_to_string(&log_path).unwrap();
    assert_eq!(content, "Line 1: first output\nLine 2: second output\n");

    // 3. Third write pushes over 80 bytes, triggering rolling
    writer.append(b"Line 3: third output that will exceed the eighty bytes limit\n");
    assert!(rolled_path.is_file(), "backup file .log.1 must exist after rolling");
    let rolled_content = fs::read_to_string(&rolled_path).unwrap();
    assert_eq!(rolled_content, "Line 1: first output\nLine 2: second output\n");

    let active_content = fs::read_to_string(&log_path).unwrap();
    assert_eq!(
        active_content,
        "Line 3: third output that will exceed the eighty bytes limit\n"
    );

    // 4. Fourth write pushes over 80 bytes again, rolling replaces .log.1
    writer.append(b"Line 4: fourth output that pushes over limit again\n");
    let new_rolled = fs::read_to_string(&rolled_path).unwrap();
    assert_eq!(
        new_rolled,
        "Line 3: third output that will exceed the eighty bytes limit\n"
    );
    let new_active = fs::read_to_string(&log_path).unwrap();
    assert_eq!(
        new_active,
        "Line 4: fourth output that pushes over limit again\n"
    );
}

#[test]
fn test_read_tail_with_backup_combines_lines() {
    let dir = tempdir().unwrap();
    let log_path = dir.path().join("combined.log");
    let rolled_path = dir.path().join("combined.log.1");

    // Write backup file
    fs::write(&rolled_path, "backup line 1\nbackup line 2\nbackup line 3\n").unwrap();
    // Write primary active file
    fs::write(&log_path, "active line 4\nactive line 5\n").unwrap();

    // Requesting 2 lines should only come from primary active file
    let tail_2 = read_tail_with_backup(&log_path, Some(&rolled_path), 2).unwrap();
    assert_eq!(tail_2, "active line 4\nactive line 5\n");

    // Requesting 4 lines should combine 2 lines from backup and 2 from primary
    let tail_4 = read_tail_with_backup(&log_path, Some(&rolled_path), 4).unwrap();
    assert_eq!(
        tail_4,
        "backup line 2\nbackup line 3\nactive line 4\nactive line 5\n"
    );

    // Requesting more lines than available returns all lines in order
    let tail_all = read_tail_with_backup(&log_path, Some(&rolled_path), 10).unwrap();
    assert_eq!(
        tail_all,
        "backup line 1\nbackup line 2\nbackup line 3\nactive line 4\nactive line 5\n"
    );
}

#[test]
fn test_app_restart_preserves_disk_log_tail_with_empty_services() {
    let dir = tempdir().unwrap();
    let log_dir = dir.path().join("logs");

    // Session 1: App is running
    let manager1 = ServiceManager::with_log_dir(log_dir.clone());
    let proj_id = "sample-service";
    let writer = RollingLogWriter::for_project(&log_dir, proj_id);
    writer.append(b"2026-10-29 16:15:00 Booting server on port 8080\n");
    writer.append(b"2026-10-29 16:15:01 Server ready\n");

    let tail1 = manager1.project_log_tail(proj_id, 10).unwrap();
    assert!(tail1.is_some());
    assert!(tail1.unwrap().contains("Server ready"));

    // Simulate App Exit / Restart: manager1 is dropped
    drop(manager1);

    // Session 2: App starts up fresh
    let manager2 = ServiceManager::with_log_dir(log_dir);
    // 1. Process table is fresh and empty (we intentionally do not restore dead processes)
    let services = manager2.list(proj_id).unwrap();
    assert!(services.is_empty(), "services table must be empty after app restart");

    // 2. But project log tail is preserved on disk and readable!
    let tail2 = manager2.project_log_tail(proj_id, 10).unwrap();
    assert!(tail2.is_some(), "project log tail must be readable from disk after app restart");
    let tail_str = tail2.unwrap();
    assert!(tail_str.contains("Booting server on port 8080"));
    assert!(tail_str.contains("Server ready"));
}

#[test]
fn test_agent_http_logs_endpoint_returns_disk_logs_after_restart() {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let dir = tempdir().unwrap();
    let log_dir = dir.path().join("logs");
    let ws_path = dir.path().join("workspace.json");

    // Setup project in workspace
    let ws = Workspace {
        version: 1,
        active_project_id: Some("web-app".into()),
        projects: vec![Project {
            id: "web-app".into(),
            name: "web-app".into(),
            path: dir.path().to_str().unwrap().into(),
            created_at: "".into(),
            dev: Some(DevProfile {
                command: "echo test".into(),
                port: Some(8080),
                ..Default::default()
            }),
        }],
    };
    fs::write(&ws_path, serde_json::to_string(&ws).unwrap()).unwrap();
    let store = Arc::new(studio_core::WorkspaceStore::new(ws_path));

    let services = Arc::new(ServiceManager::with_log_dir(log_dir.clone()));
    let mut srv = start_agent_server(store, Arc::clone(&services), 0).unwrap();
    let port = srv.port();

    fn get_logs(port: u16, proj_id: &str) -> serde_json::Value {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .write_all(
                format!(
                    "GET /api/projects/{proj_id}/logs HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let body = response.split("\r\n\r\n").nth(1).unwrap();
        serde_json::from_str(body).unwrap()
    }

    // 1. Before any logs written: missing is true
    let resp1 = get_logs(port, "web-app");
    assert_eq!(resp1["ok"], true);
    assert_eq!(resp1["missing"], true);

    // 2. Logs written to disk (e.g. from previous run before restart)
    let writer = RollingLogWriter::for_project(&log_dir, "web-app");
    writer.append(b"2026-10-29 16:30:00 Started web-app\n2026-10-29 16:30:05 Error on route\n");

    // 3. After restart: no running process in manager, but logs exist on disk!
    let resp2 = get_logs(port, "web-app");
    assert_eq!(resp2["ok"], true);
    assert_eq!(resp2["missing"], false);
    let lines = resp2["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0], "2026-10-29 16:30:00 Started web-app");
    assert_eq!(lines[1], "2026-10-29 16:30:05 Error on route");
    assert!(
        resp2["path"].as_str().unwrap().contains("web-app.log"),
        "path should point to disk log file"
    );

    srv.stop();
}
