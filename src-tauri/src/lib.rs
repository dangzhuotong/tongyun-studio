use std::path::PathBuf;
use studio_core::{LaunchResult, ProjectInspection, ToolId, ToolStatus, Workspace, WorkspaceStore};
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
fn list_tools() -> Vec<ToolStatus> {
    studio_core::list_tools()
}

#[tauri::command]
fn launch_tool(tool_id: ToolId) -> Result<LaunchResult, String> {
    studio_core::launch_tool(tool_id)
}

#[tauri::command]
fn open_project_directory(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let project = state.store.project(&id)?;
    studio_core::open_project_directory(&project)
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
            list_tools,
            launch_tool,
            open_project_directory,
            choose_project_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
