// Entry point shared between the binary (`marvin-desktop`) and the macOS
// app bundle. Keeping the mobile-style `lib.rs` shape even though MARVIN
// is macOS-only today — Tauri 2's stock scaffold, matches the template
// docs, and costs nothing.

use std::net::TcpStream;
use std::time::Duration;

use tauri::menu::{
    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::Emitter;

/// Best-effort health probe for the MARVIN web server the desktop shell
/// wraps. Returns `true` when port 3030 is accepting connections on
/// loopback. Used by the front-page script to show a clear "MARVIN isn't
/// running — start `bin/marvin` first" message instead of a silent blank
/// window.
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
///
/// Design: the native menu items emit `marvin:menu` events with one of
/// these IDs. The web app's Tauri-event listener maps IDs to actions
/// (toggle pane, quick-open, reset session, etc.). The web app's
/// existing `window.keydown` handlers keep running unchanged — when the
/// user presses a shortcut, JS `preventDefault()`s before the event
/// reaches the native menu, so there's no double-fire.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![marvin_server_is_up])
        .setup(|app| {
            let handle = app.handle();

            // MARVIN submenu (leftmost on macOS — takes the app name).
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

            // File — session-level actions.
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

            // Edit — stock platform items so Cmd-C/V/Z etc. work in text
            // inputs (Monaco, chat input), plus MARVIN's cancel-turn.
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

            // View — the pane toggles the user types ⌘B/⌘G/⌘J/⌘⇧P for.
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

            // Window — stock platform items.
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .item(&PredefinedMenuItem::minimize(handle, None)?)
                .item(&PredefinedMenuItem::maximize(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::close_window(handle, None)?)
                .build()?;

            // Help — external links. `shell:allow-open` (in capabilities/
            // default.json) permits the frontend JS path; native menu
            // items go via tauri_plugin_shell which respects the same
            // allowlist.
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
            Ok(())
        })
        .on_menu_event(|app, event| {
            // Re-emit the click as a Tauri event the web app can listen
            // for. We don't invoke actions from Rust because the
            // actions themselves live in React state (togglePane,
            // reset, etc.) — the TS side is the canonical place.
            let id = event.id().as_ref().to_string();
            // Non-MARVIN menu events (fullscreen, minimize, platform
            // edit items) have IDs we don't own; skip them so the TS
            // listener doesn't see noise.
            if !id.starts_with("marvin:") {
                return;
            }
            let _ = app.emit("marvin:menu", serde_json::json!({ "id": id }));
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
