use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use studio_core::agent_http::start_agent_server;
use studio_core::{DevProfile, ServiceManager, WorkspaceStore};

fn free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.local_addr().unwrap().port()
}

fn http_req(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    host: Option<&str>,
) -> (u16, Value) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let default_host = format!("127.0.0.1:{port}");
    let host_header = host.unwrap_or(&default_host);
    let body_bytes = body.unwrap_or("").as_bytes();
    let req = format!(
        "{method} {path} HTTP/1.1\r\n\
         Host: {host_header}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{}",
        body_bytes.len(),
        body.unwrap_or("")
    );
    stream.write_all(req.as_bytes()).unwrap();

    let mut resp = Vec::new();
    stream.read_to_end(&mut resp).unwrap();
    let text = String::from_utf8_lossy(&resp);

    let status_code: u16 = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);

    let body_str = if let Some(idx) = text.find("\r\n\r\n") {
        &text[idx + 4..]
    } else {
        ""
    };

    let json_val = serde_json::from_str::<Value>(body_str).unwrap_or(Value::Null);
    (status_code, json_val)
}

fn setup_workspace(dir: &std::path::Path) -> (Arc<WorkspaceStore>, Arc<ServiceManager>) {
    let ws_path = dir.join("workspace.json");
    let store = Arc::new(WorkspaceStore::new(ws_path));

    let p1_dir = dir.join("web_app");
    fs::create_dir_all(&p1_dir).unwrap();
    let ws = store.add(p1_dir.to_str().unwrap()).unwrap();
    let p1_id = ws.projects[0].id.clone();

    // Attach dev profile
    let mut loaded = store.load().unwrap();
    for p in &mut loaded.projects {
        if p.id == p1_id {
            p.dev = Some(DevProfile {
                #[cfg(windows)]
                command: "cmd /C echo server ready".into(),
                #[cfg(not(windows))]
                command: "echo server ready".into(),
                port: Some(3001),
                health_url: None,
                kind: "node".into(),
                label: "Node".into(),
                group: Some("frontend".into()),
                confidence: Some("high".into()),
                depends_on: vec![],
                ready_timeout_secs: None,
                ..Default::default()
            });
        }
    }
    fs::write(
        dir.join("workspace.json"),
        serde_json::to_vec(&loaded).unwrap(),
    )
    .unwrap();

    let services = Arc::new(ServiceManager::new());
    (store, services)
}

#[test]
fn test_agent_http_full_contract() {
    let temp = tempfile::tempdir().unwrap();
    let (store, services) = setup_workspace(temp.path());

    let port = free_port();
    let mut handle = start_agent_server(Arc::clone(&store), Arc::clone(&services), port).unwrap();
    assert_eq!(handle.port(), port);
    assert_eq!(handle.url(), format!("http://127.0.0.1:{port}"));

    // 1. Root / health
    let (status, val) = http_req(port, "GET", "/", None, None);
    assert_eq!(status, 200);
    assert_eq!(val["service"], "tongyun-studio");
    assert_eq!(val["status"], "ok");

    // 2. GET /api/projects
    let (status, list) = http_req(port, "GET", "/api/projects", None, None);
    assert_eq!(status, 200);
    let arr = list.as_array().expect("projects array");
    assert_eq!(arr.len(), 1);
    let p = &arr[0];
    let project_id = p["id"].as_str().unwrap().to_string();
    assert_eq!(p["name"], "web_app");
    assert_eq!(p["running"], false);
    assert_eq!(p["state"], "stopped");
    assert_eq!(p["group"], "frontend");

    // 3. GET /api/projects/:id
    let (status, detail) = http_req(
        port,
        "GET",
        &format!("/api/projects/{project_id}"),
        None,
        None,
    );
    assert_eq!(status, 200);
    assert_eq!(detail["ok"], true);
    assert_eq!(detail["project"]["id"], project_id);

    // 4. GET /api/groups
    let (status, groups) = http_req(port, "GET", "/api/groups", None, None);
    assert_eq!(status, 200);
    assert_eq!(groups["ok"], true);
    let grps = groups["groups"].as_array().unwrap();
    assert!(grps.iter().any(|g| g["key"] == "frontend"));

    // 5. POST /api/projects/:id/start
    let (status, start_res) = http_req(
        port,
        "POST",
        &format!("/api/projects/{project_id}/start"),
        None,
        None,
    );
    assert_eq!(status, 200);
    #[cfg(unix)]
    assert_eq!(start_res["ok"], true);
    #[cfg(not(unix))]
    {
        assert_eq!(start_res["ok"], false);
        assert!(start_res["error"]
            .as_str()
            .unwrap()
            .contains("macOS / Unix"));
    }

    // Give process a moment to execute
    thread::sleep(Duration::from_millis(200));

    // 6. GET /api/projects/:id/logs
    let (status, logs_res) = http_req(
        port,
        "GET",
        &format!("/api/projects/{project_id}/logs?lines=10"),
        None,
        None,
    );
    assert_eq!(status, 200);
    assert_eq!(logs_res["ok"], true);

    // 7. POST /api/projects/:id/stop
    let (status, stop_res) = http_req(
        port,
        "POST",
        &format!("/api/projects/{project_id}/stop"),
        None,
        None,
    );
    assert_eq!(status, 200);
    assert_eq!(stop_res["ok"], true);
    assert_eq!(stop_res["status"]["running"], false);

    // 8. DNS rebinding protection (untrusted Host)
    let (status, _err) = http_req(port, "GET", "/api/projects", None, Some("evil.hacker.com"));
    assert_eq!(status, 403);

    // 9. Stop server handle and verify port is released
    handle.stop();
    thread::sleep(Duration::from_millis(50));
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
}
