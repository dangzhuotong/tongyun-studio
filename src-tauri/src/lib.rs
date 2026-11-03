use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use studio_core::agent_http::ServerHandle;
use studio_core::{
    AiProjectContext, DbColumnInfo, DbTableInfo, DevCandidate, DevImportOutcome, ExecutionResult,
    ExistingProject, FileEntry, GitCommitDetails, GitFileChange, GitHistoryResult, HttpResponse,
    ListeningPort, ManagedService,
    PaginatedData, Project, ProjectInspection, ServiceManager, SqlQueryResult, Workspace, WorkspaceStore,
};
use tauri::Manager;

static SERVER_HANDLE: Mutex<Option<ServerHandle>> = Mutex::new(None);
static AGENT_PORT: AtomicU16 = AtomicU16::new(0);
static AGENT_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentHttpInfo {
    pub running: bool,
    pub port: Option<u16>,
    pub url: Option<String>,
}

#[tauri::command]
fn agent_http_info() -> AgentHttpInfo {
    if AGENT_RUNNING.load(Ordering::Relaxed) {
        let port = AGENT_PORT.load(Ordering::Relaxed);
        AgentHttpInfo {
            running: true,
            port: Some(port),
            url: Some(format!("http://127.0.0.1:{port}")),
        }
    } else {
        AgentHttpInfo {
            running: false,
            port: None,
            url: None,
        }
    }
}

pub struct AppState {
    pub store: Arc<WorkspaceStore>,
    pub services: Arc<ServiceManager>,
}

#[tauri::command]
fn load_workspace(state: tauri::State<'_, AppState>) -> Result<Workspace, String> {
    state.store.load()
}

#[tauri::command]
fn add_project(state: tauri::State<'_, AppState>, path: String) -> Result<Workspace, String> {
    state.store.add(&path)
}

#[tauri::command]
fn select_project(state: tauri::State<'_, AppState>, id: String) -> Result<Workspace, String> {
    state.store.select(&id)
}

#[tauri::command]
fn remove_project(state: tauri::State<'_, AppState>, id: String) -> Result<Workspace, String> {
    state.store.remove(&id)
}

#[tauri::command]
fn update_project_dev(
    state: tauri::State<'_, AppState>,
    id: String,
    dev: Option<studio_core::DevProfile>,
) -> Result<Workspace, String> {
    state.store.update_project_dev(&id, dev)
}

#[tauri::command]
fn update_project_auto_install(
    state: tauri::State<'_, AppState>,
    id: String,
    auto_install: bool,
) -> Result<Workspace, String> {
    let workspace = state.store.load()?;
    let project = workspace
        .projects
        .iter()
        .find(|p| p.id == id)
        .ok_or("项目不存在")?;
    let mut dev = project.dev.clone().unwrap_or_default();
    dev.auto_install = Some(auto_install);
    state.store.update_project_dev(&id, Some(dev))
}

#[tauri::command]
fn install_project_dependencies(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<ManagedService, String> {
    let project = state.store.project(&id)?;
    state.services.install_deps(&project)
}

#[tauri::command]
fn inspect_project(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<ProjectInspection, String> {
    let project = state.store.project(&id)?;
    Ok(studio_core::inspect_project(&project))
}

#[tauri::command]
fn read_project_tree(
    state: tauri::State<'_, AppState>,
    id: String,
    relative_dir: Option<String>,
) -> Result<Vec<FileEntry>, String> {
    let project = state.store.project(&id)?;
    studio_core::read_project_tree(&project, relative_dir.as_deref())
}

#[tauri::command]
fn read_project_file_content(
    state: tauri::State<'_, AppState>,
    id: String,
    relative_path: String,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::read_project_file_content(&project, &relative_path)
}

#[tauri::command]
fn get_git_changed_files(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<GitFileChange>, String> {
    let project = state.store.project(&id)?;
    studio_core::get_git_changed_files(&project)
}

#[tauri::command]
fn get_git_diff(
    state: tauri::State<'_, AppState>,
    id: String,
    file_path: Option<String>,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::get_git_diff(&project, file_path.as_deref())
}

#[tauri::command]
fn get_git_history(
    state: tauri::State<'_, AppState>,
    id: String,
    skip: Option<usize>,
    limit: Option<usize>,
    all_branches: Option<bool>,
) -> Result<GitHistoryResult, String> {
    let project = state.store.project(&id)?;
    studio_core::get_git_history(&project, skip, limit, all_branches)
}

#[tauri::command]
fn get_git_commit_details(
    state: tauri::State<'_, AppState>,
    id: String,
    oid: String,
) -> Result<GitCommitDetails, String> {
    let project = state.store.project(&id)?;
    studio_core::get_git_commit_details(&project, &oid)
}

#[tauri::command]
fn get_git_commit_file_diff(
    state: tauri::State<'_, AppState>,
    id: String,
    oid: String,
    file_path: String,
    old_path: Option<String>,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::get_git_commit_file_diff(&project, &oid, &file_path, old_path.as_deref())
}

#[tauri::command]
fn create_git_commit(
    state: tauri::State<'_, AppState>,
    id: String,
    message: String,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::create_git_commit(&project, &message)
}

#[tauri::command]
fn git_commit_amend(
    state: tauri::State<'_, AppState>,
    id: String,
    message: Option<String>,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::git_commit_amend(&project, message.as_deref())
}

#[tauri::command]
fn git_stage_file(
    state: tauri::State<'_, AppState>,
    id: String,
    path: String,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::git_stage_file(&project, &path)
}

#[tauri::command]
fn git_unstage_file(
    state: tauri::State<'_, AppState>,
    id: String,
    path: String,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::git_unstage_file(&project, &path)
}

#[tauri::command]
fn git_stage_all(state: tauri::State<'_, AppState>, id: String) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::git_stage_all(&project)
}

#[tauri::command]
fn git_unstage_all(state: tauri::State<'_, AppState>, id: String) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::git_unstage_all(&project)
}

#[tauri::command]
fn git_discard_file(
    state: tauri::State<'_, AppState>,
    id: String,
    path: String,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::git_discard_file(&project, &path)
}

#[tauri::command]
fn git_create_branch(
    state: tauri::State<'_, AppState>,
    id: String,
    branch_name: String,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::git_create_branch(&project, &branch_name)
}

#[tauri::command]
fn git_remote_sync(
    state: tauri::State<'_, AppState>,
    id: String,
    action: String,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::git_remote_sync(&project, &action)
}

#[tauri::command]
fn get_git_branches(state: tauri::State<'_, AppState>, id: String) -> Result<Vec<String>, String> {
    let project = state.store.project(&id)?;
    studio_core::get_git_branches(&project)
}

#[tauri::command]
fn switch_git_branch(
    state: tauri::State<'_, AppState>,
    id: String,
    branch: String,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::switch_git_branch(&project, &branch)
}

#[tauri::command]
fn execute_project_script(
    state: tauri::State<'_, AppState>,
    id: String,
    command: String,
) -> Result<ExecutionResult, String> {
    let project = state.store.project(&id)?;
    studio_core::execute_project_script(&project, &command)
}

#[tauri::command]
fn send_http_request(
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    studio_core::send_http_request(&method, &url, &header_refs, body.as_deref())
}

#[tauri::command]
fn execute_sql_query(
    state: tauri::State<'_, AppState>,
    id: String,
    db_path: String,
    sql: String,
) -> Result<SqlQueryResult, String> {
    let project = state.store.project(&id)?;
    studio_core::execute_sql_query(&project, &db_path, &sql)
}

#[tauri::command]
fn get_db_tables(
    state: tauri::State<'_, AppState>,
    id: String,
    db_path: String,
) -> Result<Vec<DbTableInfo>, String> {
    let project = state.store.project(&id)?;
    studio_core::get_db_tables(&project, &db_path)
}

#[tauri::command]
fn get_table_columns(
    state: tauri::State<'_, AppState>,
    id: String,
    db_path: String,
    table_name: String,
) -> Result<Vec<DbColumnInfo>, String> {
    let project = state.store.project(&id)?;
    studio_core::get_table_columns(&project, &db_path, &table_name)
}

#[tauri::command]
fn get_table_data(
    state: tauri::State<'_, AppState>,
    id: String,
    db_path: String,
    table_name: String,
    page: usize,
    page_size: usize,
) -> Result<PaginatedData, String> {
    let project = state.store.project(&id)?;
    studio_core::get_table_data(&project, &db_path, &table_name, page, page_size)
}

#[tauri::command]
fn detect_listening_ports() -> Vec<ListeningPort> {
    studio_core::detect_listening_ports()
}

#[tauri::command]
fn generate_ai_project_context(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<AiProjectContext, String> {
    let project = state.store.project(&id)?;
    studio_core::generate_ai_project_context(&project)
}

#[tauri::command]
fn open_project_directory(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let project = state.store.project(&id)?;
    studio_core::open_project_directory(&project)
}

#[tauri::command]
fn open_in_terminal(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let project = state.store.project(&id)?;
    studio_core::open_in_terminal(&project)
}

#[tauri::command]
fn open_project_file(
    state: tauri::State<'_, AppState>,
    id: String,
    relative_path: String,
) -> Result<(), String> {
    let project = state.store.project(&id)?;
    studio_core::open_project_file(&project, &relative_path)
}

#[tauri::command]
async fn choose_project_directory() -> Option<String> {
    let folder = rfd::AsyncFileDialog::new().pick_folder().await;
    folder.map(|f| f.path().to_string_lossy().to_string())
}

#[tauri::command]
fn start_project_service(
    state: tauri::State<'_, AppState>,
    id: String,
    command: String,
    profile: Option<String>,
) -> Result<ManagedService, String> {
    let project = state.store.project(&id)?;
    state
        .services
        .start_with_profile(&project, &command, profile.as_deref())
}

#[tauri::command]
fn list_project_services(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<ManagedService>, String> {
    state.services.list(&id)
}

#[tauri::command]
fn stop_project_service(
    state: tauri::State<'_, AppState>,
    id: String,
    service_id: String,
) -> Result<ManagedService, String> {
    state.services.stop(&id, &service_id)
}

#[tauri::command]
fn restart_project_service(
    state: tauri::State<'_, AppState>,
    id: String,
    service_id: String,
) -> Result<ManagedService, String> {
    state.services.restart(&id, &service_id)
}

#[tauri::command]
fn update_project_auto_restart(
    state: tauri::State<'_, AppState>,
    id: String,
    auto_restart: bool,
    max_restarts: Option<u32>,
    restart_interval_secs: Option<u64>,
) -> Result<Project, String> {
    state
        .store
        .update_project_auto_restart(&id, auto_restart, max_restarts, restart_interval_secs)
}

#[tauri::command]
fn scan_dev_directory(
    state: tauri::State<'_, AppState>,
    path: String,
    depth: Option<u32>,
) -> Result<studio_core::DevScanReport, String> {
    let workspace = state.store.load()?;
    let existing = workspace
        .projects
        .iter()
        .map(|project| ExistingProject {
            id: project.id.clone(),
            path: project.path.clone(),
            has_dev: project.dev.is_some(),
        })
        .collect::<Vec<_>>();
    studio_core::scan_dev_directory(
        std::path::Path::new(&path),
        depth.unwrap_or(3) as usize,
        &existing,
    )
}

#[tauri::command]
fn import_dev_candidates(
    state: tauri::State<'_, AppState>,
    candidates: Vec<DevCandidate>,
) -> Result<DevImportOutcome, String> {
    state.store.import_dev_candidates(&candidates)
}

#[tauri::command]
fn start_dev_group(
    state: tauri::State<'_, AppState>,
    group: String,
) -> Result<Vec<ManagedService>, String> {
    let workspace = state.store.load()?;
    state.services.start_group(&workspace.projects, &group)
}

#[tauri::command]
fn stop_dev_group(
    state: tauri::State<'_, AppState>,
    group: String,
) -> Result<Vec<ManagedService>, String> {
    let workspace = state.store.load()?;
    state.services.stop_group(&workspace.projects, &group)
}

#[tauri::command]
fn dev_service_log_tail(
    state: tauri::State<'_, AppState>,
    id: String,
    service_id: String,
    lines: Option<u32>,
) -> Result<String, String> {
    state
        .services
        .log_tail(&id, &service_id, lines.unwrap_or(200) as usize)
}

#[tauri::command]
fn dev_project_log_tail(
    state: tauri::State<'_, AppState>,
    id: String,
    lines: Option<u32>,
) -> Result<Option<String>, String> {
    state.services.project_log_tail(&id, lines.unwrap_or(200) as usize)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    studio_core::open_url(&url)
}

#[tauri::command]
fn write_project_file(
    state: tauri::State<'_, AppState>,
    id: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let project = state.store.project(&id)?;
    studio_core::write_project_file(&project, &relative_path, &content)
}

#[tauri::command]
fn append_project_file(
    state: tauri::State<'_, AppState>,
    id: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let project = state.store.project(&id)?;
    studio_core::append_project_file(&project, &relative_path, &content)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let workspace_path = config_dir.join("workspace.json");
            let store = Arc::new(WorkspaceStore::new(workspace_path));
            let services = Arc::new(ServiceManager::new());

            let initial_port = studio_core::agent_http::resolve_agent_port();
            match studio_core::agent_http::start_agent_server(
                Arc::clone(&store),
                Arc::clone(&services),
                initial_port,
            ) {
                Ok(srv) => {
                    AGENT_PORT.store(srv.port(), Ordering::Relaxed);
                    AGENT_RUNNING.store(true, Ordering::Relaxed);
                    if let Ok(mut lock) = SERVER_HANDLE.lock() {
                        *lock = Some(srv);
                    }
                }
                Err(err) => {
                    AGENT_RUNNING.store(false, Ordering::Relaxed);
                    AGENT_PORT.store(0, Ordering::Relaxed);
                    eprintln!("Failed to start Studio Agent HTTP server: {err}");
                }
            }

            app.manage(AppState { store, services });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_http_info,
            load_workspace,
            add_project,
            select_project,
            remove_project,
            inspect_project,
            read_project_tree,
            read_project_file_content,
            get_git_changed_files,
            get_git_diff,
            get_git_history,
            get_git_commit_details,
            get_git_commit_file_diff,
            create_git_commit,
            git_commit_amend,
            git_stage_file,
            git_unstage_file,
            git_stage_all,
            git_unstage_all,
            git_discard_file,
            git_create_branch,
            git_remote_sync,
            get_git_branches,
            switch_git_branch,
            execute_project_script,
            send_http_request,
            execute_sql_query,
            get_db_tables,
            get_table_columns,
            get_table_data,
            detect_listening_ports,
            generate_ai_project_context,
            open_project_directory,
            open_in_terminal,
            open_project_file,
            choose_project_directory,
            start_project_service,
            list_project_services,
            stop_project_service,
            restart_project_service,
            update_project_auto_restart,
            scan_dev_directory,
            import_dev_candidates,
            start_dev_group,
            stop_dev_group,
            dev_service_log_tail,
            dev_project_log_tail,
            open_url,
            update_project_dev,
            update_project_auto_install,
            install_project_dependencies,
            write_project_file,
            append_project_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if let Err(error) = app.state::<AppState>().services.shutdown() {
                    api.prevent_exit();
                    rfd::MessageDialog::new()
                        .set_title("服务尚未停止")
                        .set_description(format!("工作台保持打开，请重试停止服务后退出。\n{error}"))
                        .set_level(rfd::MessageLevel::Error)
                        .show();
                } else {
                    if let Ok(mut lock) = SERVER_HANDLE.lock() {
                        if let Some(mut srv) = lock.take() {
                            srv.stop();
                        }
                    }
                }
            } else if let tauri::RunEvent::Exit = event {
                if let Ok(mut lock) = SERVER_HANDLE.lock() {
                    if let Some(mut srv) = lock.take() {
                        srv.stop();
                    }
                }
                if let Err(error) = app.state::<AppState>().services.shutdown() {
                    eprintln!("工作台退出时未能清理全部托管进程：{error}");
                }
            }
        });
}
