//! Studio Agent HTTP server aligned with tongyun-dev's Agent HTTP contract.
//!
//! Exposes HTTP endpoints on 127.0.0.1 for local agents and tools to list projects,
//! start/stop/restart dev services, inspect status, and read log tails.
//! Binds 127.0.0.1:9199 by default (configurable via TONGYUN_STUDIO_AGENT_PORT).

use crate::dev_runtime;
use crate::processes::ServiceManager;
use crate::{Project, WorkspaceStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub const DEFAULT_STUDIO_AGENT_PORT: u16 = 9100;
pub const DEFAULT_AGENT_PORT: u16 = DEFAULT_STUDIO_AGENT_PORT;
const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
const DEFAULT_LOG_LINES: usize = 120;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AgentHttpInfo {
    pub running: bool,
    pub port: Option<u16>,
    pub url: Option<String>,
}

/// Resolves the initial port to bind for the Agent HTTP server.
/// Uses environment variable TONGYUN_STUDIO_AGENT_PORT (or STUDIO_AGENT_PORT / TONGYUN_STUDIO_PORT)
/// if specified, otherwise defaults to 9199.
pub fn resolve_agent_port() -> u16 {
    if let Ok(val) = std::env::var("TONGYUN_STUDIO_AGENT_PORT")
        .or_else(|_| std::env::var("STUDIO_AGENT_PORT"))
        .or_else(|_| std::env::var("TONGYUN_STUDIO_PORT"))
    {
        if let Ok(p) = val.trim().parse::<u16>() {
            if p > 0 {
                return p;
            }
        }
    }
    DEFAULT_STUDIO_AGENT_PORT
}

/// Binds 127.0.0.1 starting from `initial_port`, trying up to +20 ports if busy.
pub fn bind_from(initial_port: u16) -> Result<(TcpListener, u16), String> {
    let last = initial_port.saturating_add(20);
    let mut port = initial_port;
    loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => {
                let actual = l.local_addr().map_err(|e| e.to_string())?.port();
                return Ok((l, actual));
            }
            Err(_e) if port < last => {
                port += 1;
            }
            Err(e) => {
                return Err(format!(
                    "无法在 127.0.0.1:{initial_port}..={last} 绑定 Agent HTTP 服务: {e}"
                ));
            }
        }
    }
}

/// Handle for a running background Agent HTTP server.
pub struct ServerHandle {
    port: u16,
    shutdown: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ServerHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn stop(&mut self) {
        if !self.shutdown.swap(true, Ordering::SeqCst) {
            let _ = TcpStream::connect(("127.0.0.1", self.port));
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start background Agent HTTP server with workspace store and service manager.
pub fn start_agent_server(
    store: Arc<WorkspaceStore>,
    services: Arc<ServiceManager>,
    initial_port: u16,
) -> Result<ServerHandle, String> {
    let (listener, port) = bind_from(initial_port)?;
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_clone = Arc::clone(&shutdown);
    let thread = thread::spawn(move || {
        serve(listener, store, services, port, shutdown_clone);
    });
    Ok(ServerHandle {
        port,
        shutdown,
        thread: Some(thread),
    })
}

/// Serve incoming connections on the listener until `shutdown` is signalled.
fn serve(
    listener: TcpListener,
    store: Arc<WorkspaceStore>,
    services: Arc<ServiceManager>,
    port: u16,
    shutdown: Arc<AtomicBool>,
) {
    for stream in listener.incoming() {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        match stream {
            Ok(mut stream) => {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let store = Arc::clone(&store);
                let services = Arc::clone(&services);
                thread::spawn(move || {
                    let _ = handle_connection(&mut stream, &store, &services, port);
                });
            }
            Err(_) => {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
            }
        }
    }
}

struct Request {
    method: String,
    path: String,
    host: String,
    origin: Option<String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<Option<Request>, String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEADER {
            return Err("header too large".into());
        }
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.lines();
    let mut parts = lines.next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut host = String::new();
    let mut origin = None;
    let mut len = 0usize;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim();
        match k.trim().to_ascii_lowercase().as_str() {
            "host" => host = v.to_string(),
            "origin" => origin = Some(v.to_string()),
            "content-length" => len = v.parse().unwrap_or(0),
            _ => {}
        }
    }
    if len > MAX_BODY {
        return Err("body too large".into());
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    Ok(Some(Request {
        method,
        path,
        host,
        origin,
        body,
    }))
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Security validation:
/// - Host header must match loopback (protects against DNS rebinding).
/// - Origin header (if present on state-changing requests) must be local.
fn trusted(req: &Request, port: u16) -> bool {
    let allowed = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        "127.0.0.1".to_string(),
        "localhost".to_string(),
    ];
    let host_ok = allowed.iter().any(|a| req.host.eq_ignore_ascii_case(a));
    if !host_ok {
        return false;
    }
    if req.method == "GET" || req.method == "HEAD" || req.method == "OPTIONS" {
        return true;
    }
    match &req.origin {
        None => true, // direct agent or CLI calls have no Origin header
        Some(o) => {
            let o_lower = o.to_ascii_lowercase();
            allowed.iter().any(|a| o_lower == format!("http://{a}"))
                || o_lower == "tauri://localhost"
                || o_lower == "http://tauri.localhost"
        }
    }
}

fn handle_connection(
    stream: &mut TcpStream,
    store: &WorkspaceStore,
    services: &ServiceManager,
    port: u16,
) -> Result<(), String> {
    let Some(req) = read_request(stream)? else {
        return Ok(());
    };
    if !trusted(&req, port) {
        return send_json(
            stream,
            403,
            &json!({"ok": false, "error": "forbidden origin or host"}),
        );
    }
    let (code, body) = route(&req, store, services);
    send_json(stream, code, &body)
}

fn send_json(stream: &mut TcpStream, code: u16, val: &Value) -> Result<(), String> {
    let body = val.to_string();
    let status_line = match code {
        200 => "200 OK",
        400 => "400 Bad Request",
        403 => "403 Forbidden",
        404 => "404 Not Found",
        409 => "409 Conflict",
        500 => "500 Internal Server Error",
        _ => "200 OK",
    };
    let response = format!(
        "HTTP/1.1 {status_line}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|e| format!("发送响应失败: {e}"))
}

fn project_route<'a>(path: &'a str, action: &str) -> Option<&'a str> {
    let rest = path.strip_prefix("/api/projects/")?;
    let id = if action.is_empty() {
        rest
    } else {
        rest.strip_suffix(action)?.strip_suffix('/')?
    };
    if !id.is_empty() && !id.contains('/') {
        Some(id)
    } else {
        None
    }
}

fn group_route<'a>(path: &'a str, action: &str) -> Option<&'a str> {
    let rest = path.strip_prefix("/api/groups/")?;
    let key = if action.is_empty() {
        rest
    } else {
        rest.strip_suffix(action)?.strip_suffix('/')?
    };
    if !key.is_empty() && !key.contains('/') {
        Some(key)
    } else {
        None
    }
}

fn url_decode(s: &str) -> String {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn parse_lines_param(path_and_query: &str) -> Option<usize> {
    let query = path_and_query.split_once('?')?;
    for pair in query.1.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == "lines" {
                return v.parse::<usize>().ok().map(|l| l.clamp(1, 500));
            }
        }
    }
    None
}

/// Aligns with tongyun-dev's StatusJson / overview format.
fn project_overview(project: &Project, services: &ServiceManager) -> Value {
    let dev = project.dev.as_ref();
    let configured = dev.is_some();
    let port = dev.and_then(|d| d.port).unwrap_or(0);
    let group = dev.and_then(|d| d.group.clone());
    let start_command = dev.map(|d| d.command.clone()).unwrap_or_default();

    let service_list = services.list(&project.id).unwrap_or_default();
    let active = service_list
        .iter()
        .find(|s| s.status == "running")
        .or_else(|| service_list.first());

    let (running, state, elapsed_secs, timeout_secs, failure, pid, port_open, reachable, active_profile) =
        match active {
            Some(s) => (
                s.status == "running",
                s.lifecycle.clone(),
                s.elapsed_secs,
                s.ready_timeout_secs,
                s.failure.clone(),
                s.pid,
                s.port_open,
                s.reachable,
                s.active_profile.clone(),
            ),
            None => (
                false,
                "stopped".to_string(),
                None,
                180,
                None,
                None,
                false,
                false,
                None,
            ),
        };

    let (port_conflict, port_holder) = if port > 0 && !running && dev_runtime::tcp_open(port) {
        let occupants = dev_runtime::port_occupants(port);
        let holder = occupants
            .iter()
            .map(|o| {
                if o.name.is_empty() {
                    format!("PID {}", o.pid)
                } else {
                    format!("{} (PID {})", o.name, o.pid)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        (true, holder)
    } else {
        (false, String::new())
    };

    json!({
        "id": project.id,
        "name": project.name,
        "root": project.path,
        "running": running,
        "state": state,
        "elapsed_secs": elapsed_secs,
        "timeout_secs": timeout_secs,
        "failure": failure,
        "pid": pid,
        "port": port,
        "port_open": port_open,
        "reachable": reachable,
        "log_path": "",
        "pid_path": "",
        "enabled": true,
        "configured": configured,
        "group": group,
        "start_command": start_command,
        "active_profile": active_profile,
        "default_profile": dev.and_then(|d| d.default_profile.clone()),
        "profiles": dev.map(|d| d.profiles.clone()).unwrap_or_default(),
        "java": dev.and_then(|d| d.java.clone()),
        "java_home": dev.and_then(|d| d.java_home.clone()),
        "catalina_home": dev.and_then(|d| d.catalina_home.clone()),
        "node": dev.and_then(|d| d.node.clone()),
        "node_home": dev.and_then(|d| d.node_home.clone()),
        "created_at": project.created_at,
        "deps_missing": false,
        "install_command": "",
        "port_conflict": port_conflict,
        "port_holder": port_holder,
    })
}

fn route(req: &Request, store: &WorkspaceStore, services: &ServiceManager) -> (u16, Value) {
    let path = req.path.split('?').next().unwrap_or("");
    let method = req.method.as_str();

    if method == "GET" && path == "/" {
        return (
            200,
            json!({
                "service": "tongyun-studio",
                "version": "0.1.0",
                "status": "ok"
            }),
        );
    }

    if method == "GET" && path == "/api/projects" {
        let workspace = match store.load() {
            Ok(w) => w,
            Err(e) => return (500, json!({"ok": false, "error": e})),
        };
        let mut list = Vec::new();
        for project in &workspace.projects {
            list.push(project_overview(project, services));
        }
        return (200, Value::Array(list));
    }

    if method == "GET" && path == "/api/groups" {
        let workspace = match store.load() {
            Ok(w) => w,
            Err(e) => return (500, json!({"ok": false, "error": e})),
        };
        let mut groups = std::collections::BTreeSet::new();
        for p in &workspace.projects {
            if let Some(ref d) = p.dev {
                if let Some(ref g) = d.group {
                    if !g.trim().is_empty() {
                        groups.insert(g.clone());
                    }
                }
            }
        }
        let group_list: Vec<Value> = groups
            .into_iter()
            .map(|g| json!({"key": g, "label": g}))
            .collect();
        return (200, json!({"ok": true, "groups": group_list}));
    }

    if method == "GET" {
        if let Some(raw_id) = project_route(path, "logs") {
            let id = url_decode(raw_id);
            let workspace = match store.load() {
                Ok(w) => w,
                Err(e) => return (500, json!({"ok": false, "error": e})),
            };
            let Some(project) = workspace
                .projects
                .iter()
                .find(|p| p.id == id || p.name == id)
            else {
                return (404, json!({"ok": false, "error": format!("项目不存在：{id}")}));
            };
            let lines = parse_lines_param(&req.path).unwrap_or(DEFAULT_LOG_LINES);
            let s_list = services.list(&project.id).unwrap_or_default();
            let active = s_list
                .iter()
                .find(|s| s.status == "running")
                .or_else(|| s_list.first());
            return match active {
                Some(s) => match services.log_tail(&project.id, &s.id, lines) {
                    Ok(text) => (
                        200,
                        json!({
                            "ok": true,
                            "path": "",
                            "missing": false,
                            "lines": text.lines().map(|l| l.to_string()).collect::<Vec<_>>()
                        }),
                    ),
                    Err(e) => (200, json!({"ok": false, "error": e, "lines": []})),
                },
                None => (
                    200,
                    json!({
                        "ok": true,
                        "path": "",
                        "missing": true,
                        "lines": []
                    }),
                ),
            };
        }

        if let Some(raw_id) = project_route(path, "") {
            let id = url_decode(raw_id);
            let workspace = match store.load() {
                Ok(w) => w,
                Err(e) => return (500, json!({"ok": false, "error": e})),
            };
            let Some(project) = workspace
                .projects
                .iter()
                .find(|p| p.id == id || p.name == id)
            else {
                return (404, json!({"ok": false, "error": format!("项目不存在：{id}")}));
            };
            return (
                200,
                json!({"ok": true, "project": project_overview(project, services)}),
            );
        }

        return (404, json!({"ok": false, "error": "not found"}));
    }

    if method == "POST" {
        if let Some(raw_id) = project_route(path, "start") {
            let id = url_decode(raw_id);
            let workspace = match store.load() {
                Ok(w) => w,
                Err(e) => return (500, json!({"ok": false, "error": e})),
            };
            let Some(project) = workspace
                .projects
                .iter()
                .find(|p| p.id == id || p.name == id)
            else {
                return (404, json!({"ok": false, "error": format!("项目不存在：{id}")}));
            };
            let body_val: Option<Value> = serde_json::from_slice(&req.body).ok();
            let cmd_from_body = body_val
                .as_ref()
                .and_then(|v| v.get("command").and_then(|c| c.as_str()));
            let profile_from_body = body_val
                .as_ref()
                .and_then(|v| v.get("profile").and_then(|p| p.as_str()));
            let command = match cmd_from_body
                .or_else(|| project.dev.as_ref().map(|d| d.command.as_str()))
            {
                Some(c) if !c.trim().is_empty() => c,
                _ => "",
            };
            return match services.start_with_profile(project, command, profile_from_body) {
                Ok(_) => (
                    200,
                    json!({"ok": true, "status": project_overview(project, services)}),
                ),
                Err(e) => (
                    200,
                    json!({"ok": false, "error": e, "status": project_overview(project, services)}),
                ),
            };
        }

        if let Some(raw_id) = project_route(path, "stop") {
            let id = url_decode(raw_id);
            let workspace = match store.load() {
                Ok(w) => w,
                Err(e) => return (500, json!({"ok": false, "error": e})),
            };
            let Some(project) = workspace
                .projects
                .iter()
                .find(|p| p.id == id || p.name == id)
            else {
                return (404, json!({"ok": false, "error": format!("项目不存在：{id}")}));
            };
            let s_list = services.list(&project.id).unwrap_or_default();
            let running_ids: Vec<String> = s_list
                .into_iter()
                .filter(|s| s.status == "running")
                .map(|s| s.id)
                .collect();
            let mut stop_err = None;
            for sid in running_ids {
                if let Err(e) = services.stop(&project.id, &sid) {
                    stop_err = Some(e);
                }
            }
            if let Some(err) = stop_err {
                return (
                    200,
                    json!({"ok": false, "error": err, "status": project_overview(project, services)}),
                );
            }
            return (
                200,
                json!({"ok": true, "status": project_overview(project, services)}),
            );
        }

        if let Some(raw_id) = project_route(path, "restart") {
            let id = url_decode(raw_id);
            let workspace = match store.load() {
                Ok(w) => w,
                Err(e) => return (500, json!({"ok": false, "error": e})),
            };
            let Some(project) = workspace
                .projects
                .iter()
                .find(|p| p.id == id || p.name == id)
            else {
                return (404, json!({"ok": false, "error": format!("项目不存在：{id}")}));
            };
            let body_val: Option<Value> = serde_json::from_slice(&req.body).ok();
            let cmd_from_body = body_val
                .as_ref()
                .and_then(|v| v.get("command").and_then(|c| c.as_str()));
            let profile_from_body = body_val
                .as_ref()
                .and_then(|v| v.get("profile").and_then(|p| p.as_str()));

            let s_list = services.list(&project.id).unwrap_or_default();
            let running = s_list.into_iter().find(|s| s.status == "running");
            return match running {
                Some(svc) => {
                    if profile_from_body.is_some() || cmd_from_body.is_some() {
                        let _ = services.stop(&project.id, &svc.id);
                        let cmd = cmd_from_body.unwrap_or("");
                        match services.start_with_profile(project, cmd, profile_from_body) {
                            Ok(_) => (
                                200,
                                json!({"ok": true, "status": project_overview(project, services)}),
                            ),
                            Err(e) => (
                                200,
                                json!({"ok": false, "error": e, "status": project_overview(project, services)}),
                            ),
                        }
                    } else {
                        match services.restart(&project.id, &svc.id) {
                            Ok(_) => (
                                200,
                                json!({"ok": true, "status": project_overview(project, services)}),
                            ),
                            Err(e) => (
                                200,
                                json!({"ok": false, "error": e, "status": project_overview(project, services)}),
                            ),
                        }
                    }
                }
                None => {
                    let cmd = cmd_from_body.unwrap_or("");
                    match services.start_with_profile(project, cmd, profile_from_body) {
                        Ok(_) => (
                            200,
                            json!({"ok": true, "status": project_overview(project, services)}),
                        ),
                        Err(e) => (
                            200,
                            json!({"ok": false, "error": e, "status": project_overview(project, services)}),
                        ),
                    }
                }
            };
        }

        if let Some(raw_key) = group_route(path, "start") {
            let key = url_decode(raw_key);
            let workspace = match store.load() {
                Ok(w) => w,
                Err(e) => return (500, json!({"ok": false, "error": e})),
            };
            return match services.start_group(&workspace.projects, &key) {
                Ok(started) => (
                    200,
                    json!({"ok": true, "group": key, "started_count": started.len()}),
                ),
                Err(e) => (200, json!({"ok": false, "error": e, "group": key})),
            };
        }

        if let Some(raw_key) = group_route(path, "stop") {
            let key = url_decode(raw_key);
            let workspace = match store.load() {
                Ok(w) => w,
                Err(e) => return (500, json!({"ok": false, "error": e})),
            };
            return match services.stop_group(&workspace.projects, &key) {
                Ok(stopped) => (
                    200,
                    json!({"ok": true, "group": key, "stopped_count": stopped.len()}),
                ),
                Err(e) => (200, json!({"ok": false, "error": e, "group": key})),
            };
        }

        return (404, json!({"ok": false, "error": "not found"}));
    }

    (404, json!({"ok": false, "error": "not found"}))
}

/// Helper to probe whether 127.0.0.1:`port` is running an active Agent HTTP server.
pub fn is_studio_server(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let req = format!(
        "GET /api/projects HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    if stream.read_to_end(&mut buf).is_err() {
        return false;
    }
    let head = String::from_utf8_lossy(&buf);
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return false;
    }
    let Some(header_end) = find(&buf, b"\r\n\r\n") else {
        return false;
    };
    let body = &buf[header_end + 4..];
    serde_json::from_slice::<Value>(body)
        .map(|v| v.is_array())
        .unwrap_or(false)
}
