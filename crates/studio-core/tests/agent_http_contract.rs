use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;
use studio_core::{
    is_studio_server, resolve_agent_port, start_agent_server, DevProfile, Project,
    ServiceManager, WorkspaceStore, DEFAULT_STUDIO_AGENT_PORT,
};

static PORT_COUNTER: AtomicU16 = AtomicU16::new(19200);

fn next_port() -> u16 {
    PORT_COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn http_request(port: u16, method: &str, path: &str, body: Option<&str>, host: Option<&str>, origin: Option<&str>) -> (u16, Value) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect to agent server");
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();

    let default_host = format!("127.0.0.1:{port}");
    let host_header = host.unwrap_or(&default_host);
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n");
    if let Some(orig) = origin {
        req.push_str(&format!("Origin: {orig}\r\n"));
    }
    if let Some(b) = body {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{b}", b.len()));
    } else {
        req.push_str("\r\n");
    }

    stream.write_all(req.as_bytes()).unwrap();

    let mut resp_bytes = Vec::new();
    stream.read_to_end(&mut resp_bytes).unwrap();

    let resp_str = String::from_utf8_lossy(&resp_bytes);
    let mut parts = resp_str.splitn(2, "\r\n\r\n");
    let header_part = parts.next().unwrap_or("");
    let body_part = parts.next().unwrap_or("");

    let status_code = header_part
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);

    let json_val = serde_json::from_str::<Value>(body_part).unwrap_or(Value::Null);
    (status_code, json_val)
}

struct TestContext {
    _dir: tempfile::TempDir,
    store: Arc<WorkspaceStore>,
    services: Arc<ServiceManager>,
    port: u16,
    server: studio_core::ServerHandle,
}

impl TestContext {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("workspace.json");
        let store = Arc::new(WorkspaceStore::new(store_path));
        let services = Arc::new(ServiceManager::new());
        let port = next_port();
        let server = start_agent_server(Arc::clone(&store), Arc::clone(&services), port).expect("start server");
        Self {
            _dir: dir,
            store,
            services,
            port: server.port(),
            server,
        }
    }

    fn add_dummy_project(&self, name: &str, dev: Option<DevProfile>) -> Project {
        let proj_dir = self._dir.path().join(name);
        fs::create_dir_all(&proj_dir).unwrap();
        let _ = self.store.add(&proj_dir.to_string_lossy()).unwrap();
        let mut workspace = self.store.load().unwrap();
        let proj = workspace.projects.iter_mut().find(|p| p.name == name).unwrap();
        proj.dev = dev;
        let p_clone = proj.clone();
        // save updated workspace
        let parent = self._dir.path();
        let file_path = parent.join("workspace.json");
        let data = serde_json::to_string_pretty(&workspace).unwrap();
        fs::write(&file_path, data).unwrap();
        p_clone
    }
}

impl Drop for TestContext {
    fn drop(&mut self) {
        self.server.stop();
        let _ = self.services.shutdown();
    }
}

#[test]
fn test_agent_http_startup_probe_and_stop() {
    let ctx = TestContext::new();
    assert!(is_studio_server(ctx.port));

    let (status, body) = http_request(ctx.port, "GET", "/", None, None, None);
    assert_eq!(status, 200);
    assert_eq!(body["service"], "tongyun-studio");
    assert_eq!(body["status"], "ok");
}

#[test]
fn test_agent_http_projects_listing_and_detail() {
    let ctx = TestContext::new();

    let dev_profile = DevProfile {
        command: "echo backend-running".into(),
        port: Some(8080),
        health_url: None,
        kind: "node".into(),
        label: "Node".into(),
        group: Some("backend".into()),
        confidence: Some("high".into()),
        depends_on: vec![],
        ready_timeout_secs: None,
        ..Default::default()
    };

    let p1 = ctx.add_dummy_project("api-service", Some(dev_profile));
    let p2 = ctx.add_dummy_project("docs-site", None);

    // 1. GET /api/projects
    let (status, list) = http_request(ctx.port, "GET", "/api/projects", None, None, None);
    assert_eq!(status, 200);
    assert!(list.is_array());
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 2);

    let item1 = arr.iter().find(|x| x["id"] == p1.id).unwrap();
    assert_eq!(item1["name"], "api-service");
    assert_eq!(item1["state"], "stopped");
    assert_eq!(item1["running"], false);
    assert_eq!(item1["configured"], true);
    assert_eq!(item1["port"], 8080);
    assert_eq!(item1["group"], "backend");
    assert_eq!(item1["start_command"], "echo backend-running");

    let item2 = arr.iter().find(|x| x["id"] == p2.id).unwrap();
    assert_eq!(item2["name"], "docs-site");
    assert_eq!(item2["configured"], false);
    assert_eq!(item2["port"], 0);

    // 2. GET /api/projects/:id (by ID)
    let (status, detail1) = http_request(ctx.port, "GET", &format!("/api/projects/{}", p1.id), None, None, None);
    assert_eq!(status, 200);
    assert_eq!(detail1["ok"], true);
    assert_eq!(detail1["project"]["name"], "api-service");

    // 3. GET /api/projects/:id (by name)
    let (status, detail_by_name) = http_request(ctx.port, "GET", "/api/projects/api-service", None, None, None);
    assert_eq!(status, 200);
    assert_eq!(detail_by_name["ok"], true);
    assert_eq!(detail_by_name["project"]["id"], p1.id);

    // 4. GET /api/projects/:id (not found)
    let (status, not_found) = http_request(ctx.port, "GET", "/api/projects/non-existent-id", None, None, None);
    assert_eq!(status, 404);
    assert_eq!(not_found["ok"], false);

    // 5. GET /api/groups
    let (status, groups_resp) = http_request(ctx.port, "GET", "/api/groups", None, None, None);
    assert_eq!(status, 200);
    assert_eq!(groups_resp["ok"], true);
    let groups = groups_resp["groups"].as_array().unwrap();
    assert!(groups.iter().any(|g| g["key"] == "backend"));
}

#[test]
fn test_agent_http_start_stop_restart_and_logs() {
    let ctx = TestContext::new();

    let dev_profile = DevProfile {
        command: "echo test-run".into(),
        port: None,
        health_url: None,
        kind: "node".into(),
        label: "Node".into(),
        group: None,
        confidence: None,
        depends_on: vec![],
        ready_timeout_secs: None,
        ..Default::default()
    };
    let p = ctx.add_dummy_project("worker-app", Some(dev_profile));

    // 1. Logs before running
    let (status, logs_empty) = http_request(ctx.port, "GET", &format!("/api/projects/{}/logs", p.id), None, None, None);
    assert_eq!(status, 200);
    assert_eq!(logs_empty["ok"], true);
    assert_eq!(logs_empty["missing"], true);

    // 2. POST /api/projects/:id/start
    let (status, start_resp) = http_request(ctx.port, "POST", &format!("/api/projects/{}/start", p.id), Some("{}"), None, None);
    assert_eq!(status, 200);
    #[cfg(unix)]
    {
        assert_eq!(start_resp["ok"], true);

        // 3. Read logs after start
        std::thread::sleep(Duration::from_millis(100));
        let (status, logs_resp) = http_request(ctx.port, "GET", &format!("/api/projects/{}/logs", p.id), None, None, None);
        assert_eq!(status, 200);
        assert_eq!(logs_resp["ok"], true);
        assert_eq!(logs_resp["missing"], false);

        // 4. POST /api/projects/:id/stop
        let (status, stop_resp) = http_request(ctx.port, "POST", &format!("/api/projects/{}/stop", p.id), None, None, None);
        assert_eq!(status, 200);
        assert_eq!(stop_resp["ok"], true);
        assert_eq!(stop_resp["status"]["running"], false);

        // 5. POST /api/projects/:id/restart
        let (status, restart_resp) = http_request(ctx.port, "POST", &format!("/api/projects/{}/restart", p.id), None, None, None);
        assert_eq!(status, 200);
        assert_eq!(restart_resp["ok"], true);
    }
    #[cfg(not(unix))]
    {
        // ServiceManager process groups are Unix-only as documented in architecture.md
        assert_eq!(start_resp["ok"], false);
        assert!(start_resp["error"].as_str().unwrap().contains("macOS / Unix"));
    }
}

#[test]
fn test_agent_http_security_dns_rebinding_and_csrf() {
    let ctx = TestContext::new();
    let p = ctx.add_dummy_project("sec-proj", None);

    // 1. Reject foreign Host (DNS rebinding)
    let (status, _) = http_request(ctx.port, "GET", "/api/projects", None, Some("evil.example.com"), None);
    assert_eq!(status, 403);

    // 2. Reject foreign Origin on state-changing POST (CSRF)
    let (status, _) = http_request(
        ctx.port,
        "POST",
        &format!("/api/projects/{}/start", p.id),
        Some("{}"),
        None,
        Some("http://evil.example.com"),
    );
    assert_eq!(status, 403);

    // 3. Accept local Origin
    let local_origin = format!("http://127.0.0.1:{}", ctx.port);
    let (status, _) = http_request(
        ctx.port,
        "POST",
        &format!("/api/projects/{}/stop", p.id),
        None,
        None,
        Some(&local_origin),
    );
    assert_eq!(status, 200);
}

#[test]
fn test_port_configuration() {
    // Default port is 9100, which does NOT conflict with tongyun-dev's 9099
    assert_eq!(DEFAULT_STUDIO_AGENT_PORT, 9100);
    assert_ne!(DEFAULT_STUDIO_AGENT_PORT, 9099);

    // When environment variable is set
    std::env::set_var("TONGYUN_STUDIO_AGENT_PORT", "19555");
    assert_eq!(resolve_agent_port(), 19555);
    std::env::remove_var("TONGYUN_STUDIO_AGENT_PORT");

    assert_eq!(resolve_agent_port(), 9100);
}
