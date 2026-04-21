// Entry point shared between the binary (`marvin-desktop`) and the macOS
// app bundle. Keeping the mobile-style `lib.rs` shape even though MARVIN
// is macOS-only today — Tauri 2's stock scaffold, matches the template
// docs, and costs nothing.

use std::net::TcpStream;
use std::time::Duration;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![marvin_server_is_up])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
