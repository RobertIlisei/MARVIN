// Prevents additional console window on Windows in release — harmless
// on macOS, kept for cross-platform hygiene.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    marvin_desktop_lib::run()
}
