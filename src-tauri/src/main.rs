#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tauri::ipc::Response;

#[tauri::command]
async fn rpc(op: serde_json::Value) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Picker queries work with already-running daemons, without restarting user processes.
        let result = match op["op"].as_str() {
            Some("completeDirectory") => {
                vessel_core::directories::complete(op["path"].as_str().unwrap_or(""))
            }
            Some("inspectDirectory") => {
                vessel_core::directories::inspect(op["path"].as_str().unwrap_or(""))
            }
            _ => vessel_core::client_json(op),
        };
        result.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn available_shells(
    configured: String,
) -> Result<Vec<vessel_core::model::ShellOption>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        vessel_core::platform::available_shells(&configured)
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
async fn read_terminal(
    id: String,
    cursor: Option<u64>,
    reader_id: Option<String>,
) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        vessel_core::client_raw(
            serde_json::json!({"op":"read","id":id,"cursor":cursor,"readerId":reader_id}),
        )
        .map(Response::new)
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn main() {
    if std::env::args().any(|a| a == "--daemon") {
        if let Err(e) = vessel_core::serve() {
            eprintln!("Vessel daemon: {e:#}");
        }
        return;
    }
    if let Err(e) = vessel_core::ensure_daemon() {
        eprintln!("Vessel: {e:#}");
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| {
        use tauri::menu::{MenuBuilder, SubmenuBuilder};
        let vessel = SubmenuBuilder::new(app, "Vessel")
            .about(None)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        // Do not reserve Cmd+W in a native Window menu: it closes a terminal through the command system.
        MenuBuilder::new(app).item(&vessel).item(&edit).build()
    });
    builder
        .invoke_handler(tauri::generate_handler![
            rpc,
            read_terminal,
            available_shells
        ])
        .run(tauri::generate_context!())
        .expect("Vessel desktop failed");
}
