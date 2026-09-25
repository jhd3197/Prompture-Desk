// Keep a console window from opening alongside the app in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    prompture_desk_lib::run()
}
