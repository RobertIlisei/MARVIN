// Entry point shared between the binary (`marvin-desktop`) and the macOS
// app bundle. Keeping the mobile-style `lib.rs` shape even though MARVIN
// is macOS-only today — Tauri 2's stock scaffold, matches the template
// docs, and costs nothing.

use std::net::TcpStream;
use std::time::Duration;

use tauri::menu::{
    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{Emitter, WindowEvent};

#[cfg(not(debug_assertions))]
use parking_lot::Mutex;
#[cfg(not(debug_assertions))]
use tauri::Manager;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

// Handle to the Next.js sidecar — only populated in release builds (see
// `spawn_sidecar`). parking_lot's Mutex is non-poisoning, which matters
// because the WindowEvent handler and the setup thread both touch it
// across different lifecycle phases.
#[cfg(not(debug_assertions))]
static SIDECAR: Mutex<Option<CommandChild>> = Mutex::new(None);

/// Best-effort health probe for the MARVIN web server the desktop shell
/// wraps. Returns `true` when port 3030 is accepting connections on
/// loopback. In dev (debug builds) this polls the externally-run
/// `bin/marvin`; in release it polls the bundled sidecar.
#[tauri::command]
fn marvin_server_is_up() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:3030".parse().expect("valid socket addr"),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// Menu-item IDs shared with the TypeScript side. Keep in sync with
/// `apps/web/src/components/shell/use-tauri-menu.ts`.
mod ids {
    pub const NEW_SESSION: &str = "marvin:new-session";
    pub const QUICK_OPEN: &str = "marvin:quick-open";
    pub const SHORTCUTS: &str = "marvin:shortcuts";
    pub const CANCEL_TURN: &str = "marvin:cancel-turn";
    pub const PROJECT_PICKER: &str = "marvin:project-picker";
    pub const TOGGLE_FILES: &str = "marvin:toggle-files";
    pub const TOGGLE_GRAPH: &str = "marvin:toggle-graph";
    pub const TOGGLE_TERMINAL: &str = "marvin:toggle-terminal";
    pub const TOGGLE_PREVIEW: &str = "marvin:toggle-preview";
    pub const TOGGLE_BRAIN: &str = "marvin:toggle-brain";
    pub const OPEN_DOCS: &str = "marvin:open-docs";
    pub const OPEN_REPO: &str = "marvin:open-repo";
}

/// Spawn the bundled Next.js standalone server via the `node` sidecar
/// (see ADR-0011). Called only in release builds — in dev we assume
/// the user runs `bin/marvin` separately and MARVIN already listens on
/// localhost:3030.
#[cfg(not(debug_assertions))]
fn spawn_sidecar(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let server_js = resource_dir.join("resources/next/apps/web/server.js");
    let server_js_str = server_js
        .to_str()
        .ok_or("resource path is not valid UTF-8")?
        .to_string();

    let sidecar = app.shell().sidecar("node")?;
    let (mut rx, child) = sidecar
        .args([server_js_str])
        .env("PORT", "3030")
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .spawn()?;
    *SIDECAR.lock() = Some(child);

    // Drain stdout/stderr so the Node process doesn't block on a full
    // pipe. We forward lines to the Tauri log bus so users who launch
    // the .app from a terminal see "starting MARVIN server…" output,
    // and crashes surface there instead of silently hanging the splash.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    eprintln!("[marvin-server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[marvin-server:err] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[marvin-server] exited: code={:?} signal={:?}",
                        payload.code, payload.signal
                    );
                    break;
                }
                CommandEvent::Error(e) => {
                    eprintln!("[marvin-server] error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[cfg(not(debug_assertions))]
fn kill_sidecar() {
    if let Some(child) = SIDECAR.lock().take() {
        // Best-effort — on macOS this sends SIGTERM. Next.js traps it
        // and shuts down gracefully.
        let _ = child.kill();
    }
}

#[cfg(debug_assertions)]
fn kill_sidecar() {
    // no-op in dev builds
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![marvin_server_is_up])
        .setup(|app| {
            let handle = app.handle();

            // --- Native menu bar (see `on_menu_event` below for wiring) ---
            let about_metadata = AboutMetadataBuilder::new()
                .name(Some("MARVIN".to_string()))
                .version(Some(env!("CARGO_PKG_VERSION").to_string()))
                .website(Some(
                    "https://github.com/RobertIlisei/MARVIN".to_string(),
                ))
                .website_label(Some("Homepage".to_string()))
                .comments(Some(
                    "Moderately Advanced Robotic Virtual Intelligence Network."
                        .to_string(),
                ))
                .build();
            let marvin_menu = SubmenuBuilder::new(handle, "MARVIN")
                .item(&PredefinedMenuItem::about(
                    handle,
                    Some("About MARVIN"),
                    Some(about_metadata),
                )?)
                .separator()
                .item(&PredefinedMenuItem::services(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::hide(handle, None)?)
                .item(&PredefinedMenuItem::hide_others(handle, None)?)
                .item(&PredefinedMenuItem::show_all(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(handle, None)?)
                .build()?;

            let new_session = MenuItemBuilder::with_id(ids::NEW_SESSION, "New Session")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(handle)?;
            let project_picker =
                MenuItemBuilder::with_id(ids::PROJECT_PICKER, "Open Project…")
                    .accelerator("CmdOrCtrl+K")
                    .build(handle)?;
            let close_window = PredefinedMenuItem::close_window(handle, Some("Close Window"))?;
            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&new_session)
                .item(&project_picker)
                .separator()
                .item(&close_window)
                .build()?;

            let cancel_turn = MenuItemBuilder::with_id(ids::CANCEL_TURN, "Cancel Turn")
                .accelerator("CmdOrCtrl+.")
                .build(handle)?;
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .item(&PredefinedMenuItem::undo(handle, None)?)
                .item(&PredefinedMenuItem::redo(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(handle, None)?)
                .item(&PredefinedMenuItem::copy(handle, None)?)
                .item(&PredefinedMenuItem::paste(handle, None)?)
                .item(&PredefinedMenuItem::select_all(handle, None)?)
                .separator()
                .item(&cancel_turn)
                .build()?;

            let quick_open = MenuItemBuilder::with_id(ids::QUICK_OPEN, "Go to File…")
                .accelerator("CmdOrCtrl+P")
                .build(handle)?;
            let toggle_files = MenuItemBuilder::with_id(ids::TOGGLE_FILES, "Toggle Files")
                .accelerator("CmdOrCtrl+B")
                .build(handle)?;
            let toggle_graph = MenuItemBuilder::with_id(ids::TOGGLE_GRAPH, "Toggle Graph")
                .accelerator("CmdOrCtrl+G")
                .build(handle)?;
            let toggle_terminal =
                MenuItemBuilder::with_id(ids::TOGGLE_TERMINAL, "Toggle Terminal")
                    .accelerator("CmdOrCtrl+J")
                    .build(handle)?;
            let toggle_preview =
                MenuItemBuilder::with_id(ids::TOGGLE_PREVIEW, "Toggle Preview")
                    .accelerator("CmdOrCtrl+Shift+P")
                    .build(handle)?;
            let toggle_brain = MenuItemBuilder::with_id(ids::TOGGLE_BRAIN, "Toggle Brain")
                .build(handle)?;
            let shortcuts = MenuItemBuilder::with_id(ids::SHORTCUTS, "Keyboard Shortcuts")
                .accelerator("Shift+/")
                .build(handle)?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&quick_open)
                .separator()
                .item(&toggle_files)
                .item(&toggle_graph)
                .item(&toggle_terminal)
                .item(&toggle_preview)
                .item(&toggle_brain)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(handle, None)?)
                .separator()
                .item(&shortcuts)
                .build()?;

            let window_menu = SubmenuBuilder::new(handle, "Window")
                .item(&PredefinedMenuItem::minimize(handle, None)?)
                .item(&PredefinedMenuItem::maximize(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::close_window(handle, None)?)
                .build()?;

            let open_docs = MenuItemBuilder::with_id(ids::OPEN_DOCS, "MARVIN Documentation")
                .build(handle)?;
            let open_repo = MenuItemBuilder::with_id(ids::OPEN_REPO, "GitHub Repository")
                .build(handle)?;
            let help_menu = SubmenuBuilder::new(handle, "Help")
                .item(&open_docs)
                .item(&open_repo)
                .build()?;

            let menu = MenuBuilder::new(handle)
                .items(&[
                    &marvin_menu,
                    &file_menu,
                    &edit_menu,
                    &view_menu,
                    &window_menu,
                    &help_menu,
                ])
                .build()?;
            app.set_menu(menu)?;

            // --- Sidecar (release only) — ADR-0011 ---
            #[cfg(not(debug_assertions))]
            {
                if let Err(e) = spawn_sidecar(&handle) {
                    eprintln!("[marvin-desktop] failed to spawn sidecar: {}", e);
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            if !id.starts_with("marvin:") {
                return;
            }
            let _ = app.emit("marvin:menu", serde_json::json!({ "id": id }));
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // Only act on the main window — auxiliary windows
                // (e.g. future "About" child windows) shouldn't take
                // the server down with them.
                if window.label() == "main" {
                    kill_sidecar();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
