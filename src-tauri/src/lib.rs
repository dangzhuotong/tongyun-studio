use std::path::PathBuf;
use studio_core::{
    ExecutionResult, FileEntry, GitFileChange, HttpResponse, ProjectInspection, SqlQueryResult,
    Workspace, WorkspaceStore,
};
use tauri::Manager;

pub struct AppState {
    pub store: WorkspaceStore,
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
fn inspect_project(state: tauri::State<'_, AppState>, id: String) -> Result<ProjectInspection, String> {
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
fn create_git_commit(
    state: tauri::State<'_, AppState>,
    id: String,
    message: String,
) -> Result<String, String> {
    let project = state.store.project(&id)?;
    studio_core::create_git_commit(&project, &message)
}

#[tauri::command]
fn get_git_branches(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<String>, String> {
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
            let workspace_path = config_dir.join("workspace.json");
            app.manage(AppState {
                store: WorkspaceStore::new(workspace_path),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            add_project,
            select_project,
            remove_project,
            inspect_project,
            read_project_tree,
            read_project_file_content,
            get_git_changed_files,
            get_git_diff,
            create_git_commit,
            get_git_branches,
            switch_git_branch,
            execute_project_script,
            send_http_request,
            execute_sql_query,
            open_project_directory,
            open_in_terminal,
            open_project_file,
            choose_project_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
