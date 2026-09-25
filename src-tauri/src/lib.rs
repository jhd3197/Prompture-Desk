//! Prompture Desk: a tray companion for Prompture.
//!
//! It works in two modes behind one API (the companion API):
//! - **local** — Prompture on this machine (`prompture companion`), no hub;
//! - **hub** — a paired prompture-hub, which adds keys, running calls,
//!   alert rules and controls.
//!
//! The Rust side owns everything that touches the network or a secret:
//! requests, pairing, the device token (OS keychain), the local companion
//! process, the live stream and the tray icon. The webviews render and call
//! the commands below.

mod hub;
mod live;
mod local;
mod platform;
mod store;
mod tray;
mod windows;

use hub::{DeviceCode, HubError, PollOutcome};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use store::{HubProfile, Settings};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutostartExt;

/// Ports a hub on this machine is likely to answer on (the hub's default first).
const LOCAL_CANDIDATES: [&str; 2] = ["http://127.0.0.1:1984", "http://localhost:1984"];

struct AppState {
    path: PathBuf,
    settings: Mutex<Settings>,
    http: reqwest::Client,
    live: Mutex<Option<JoinHandle<()>>>,
    pairing: Mutex<Option<(String, DeviceCode)>>,
    status: Mutex<live::LiveStatus>,
}

impl AppState {
    fn snapshot(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    /// Change settings, persist them, and tell every window to reload.
    fn update<R: Runtime>(&self, app: &AppHandle<R>, f: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let settings = {
            let mut guard = self.settings.lock().unwrap();
            f(&mut guard);
            store::save(&self.path, &guard)?;
            guard.clone()
        };
        let _ = app.emit("desk://settings", ());
        Ok(settings)
    }

    /// Base URL and bearer token for the active connection.
    async fn active_credentials(&self) -> Result<(String, String), HubError> {
        let settings = self.snapshot();
        let hub = settings.active().ok_or_else(|| HubError::Http("not connected".into()))?;
        if hub.is_local() {
            let state = local::ensure(&self.http, std::process::id())
                .await
                .map_err(|e| HubError::Unreachable(format!("{e:?}")))?;
            return Ok((state.url, state.token));
        }
        let token = store::get_token(&hub.id).ok_or(HubError::Unauthorized(401))?;
        Ok((hub.url.clone(), token))
    }
}

/// The active hub's URL; `None` in local mode (the local companion has no dashboard).
pub(crate) fn active_hub_url<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let settings = app.try_state::<AppState>()?.snapshot();
    settings.active().filter(|h| !h.is_local()).map(|h| h.url.clone())
}

pub(crate) fn remember_status(app: &AppHandle, status: live::LiveStatus) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.status.lock().unwrap() = status;
    }
}

/// Connected: local mode, or a hub whose device token is in the keychain.
fn is_paired(settings: &Settings) -> bool {
    settings.active().map(|h| h.is_local() || store::get_token(&h.id).is_some()).unwrap_or(false)
}

fn restart_live(app: &AppHandle, state: &AppState) {
    if let Some(handle) = state.live.lock().unwrap().take() {
        handle.abort();
    }
    let settings = state.snapshot();
    let Some(active) = settings.active() else { return };
    let source = if active.is_local() {
        live::Source::Local { owner_pid: std::process::id() }
    } else {
        let Some(token) = store::get_token(&active.id) else { return };
        live::Source::Hub { url: active.url.clone(), token }
    };
    let handle = tauri::async_runtime::spawn(live::run(app.clone(), source));
    *state.live.lock().unwrap() = Some(handle);
}

/// "This PC" for a hub on localhost, otherwise its host name.
fn default_hub_name(url: &str) -> String {
    let host = url.split("://").nth(1).unwrap_or(url).split(['/', ':']).next().unwrap_or(url);
    match host {
        "127.0.0.1" | "localhost" => "Hub on this PC".to_string(),
        other => other.to_string(),
    }
}

#[derive(Serialize)]
struct SettingsView {
    settings: Settings,
    paired: bool,
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> SettingsView {
    let settings = state.snapshot();
    let paired = is_paired(&settings);
    SettingsView { settings, paired }
}

/// Save every preference at once. Hub connections are managed by their own
/// commands, so the incoming copies of those fields are ignored.
#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, prefs: Settings) -> Result<Settings, String> {
    let saved = state.update(&app, |s| {
        let (hubs, active) = (std::mem::take(&mut s.hubs), s.active_hub.take());
        *s = prefs;
        s.hubs = hubs;
        s.active_hub = active;
    })?;
    windows::apply_widget(&app, &saved, is_paired(&saved));
    local::set_update_mode(&saved.prompture_updates);
    let autostart = app.autolaunch();
    let enabled = autostart.is_enabled().unwrap_or(false);
    if saved.launch_at_login != enabled {
        let result = if saved.launch_at_login { autostart.enable() } else { autostart.disable() };
        result.map_err(|e| format!("couldn't change launch at login: {e}"))?;
    }
    Ok(saved)
}

async fn fetch_info(http: &reqwest::Client, url: &str) -> Result<Value, HubError> {
    let info = hub::request(http, url, None, "GET", "/v1/companion/info", None).await?;
    let version = info.get("api_version").and_then(Value::as_u64).unwrap_or(0);
    if !matches!(info.get("service").and_then(Value::as_str), Some("prompture-hub" | "prompture")) {
        return Err(HubError::Http("that address answered, but it isn't a prompture-hub".into()));
    }
    if version < hub::MIN_API_VERSION {
        return Err(HubError::Http("this hub is too old for Prompture Desk; update prompture-hub".into()));
    }
    Ok(info)
}

#[tauri::command]
async fn probe_hub(state: State<'_, AppState>, url: String) -> Result<Value, HubError> {
    let url = hub::normalize_url(&url);
    let info = fetch_info(&state.http, &url).await?;
    Ok(json!({ "url": url, "info": info }))
}

#[tauri::command]
async fn discover_local(state: State<'_, AppState>) -> Result<Option<Value>, HubError> {
    for url in LOCAL_CANDIDATES {
        if let Ok(info) = fetch_info(&state.http, url).await {
            return Ok(Some(json!({ "url": url, "info": info })));
        }
    }
    Ok(None)
}

#[tauri::command]
async fn start_pairing(
    state: State<'_, AppState>,
    url: String,
    control: bool,
) -> Result<DeviceCode, HubError> {
    let url = hub::normalize_url(&url);
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "desktop".into());
    let scope = if control { "read control" } else { "read" };
    let code = hub::start_pairing(&state.http, &url, &format!("Prompture Desk on {host}"), scope).await?;
    *state.pairing.lock().unwrap() = Some((url, code.clone()));
    Ok(code)
}

/// Poll once. On approval the token goes straight to the keychain; the
/// webview only learns that pairing succeeded.
#[tauri::command]
async fn poll_pairing(app: AppHandle, state: State<'_, AppState>, name: Option<String>) -> Result<Value, String> {
    let Some((url, code)) = state.pairing.lock().unwrap().clone() else {
        return Ok(json!({ "state": "failed", "message": "no pairing in progress" }));
    };
    match hub::poll_pairing(&state.http, &url, &code.device_code).await {
        PollOutcome::Approved { token, scope } => {
            let id = uuid::Uuid::new_v4().to_string();
            store::set_token(&id, &token)?;
            let label = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| default_hub_name(&url));
            state.update(&app, |s| {
                s.hubs.push(HubProfile { id: id.clone(), name: label, url: url.clone(), kind: "hub".into() });
                s.active_hub = Some(id.clone());
            })?;
            *state.pairing.lock().unwrap() = None;
            restart_live(&app, &state);
            windows::apply_widget(&app, &state.snapshot(), true);
            Ok(json!({ "state": "approved", "scope": scope }))
        }
        other => serde_json::to_value(other).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
async fn hub_request(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, HubError> {
    let (url, token) = state.active_credentials().await?;
    hub::request(&state.http, &url, Some(&token), &method, &path, body).await
}

/// Use Prompture on this machine: find or start the local companion and make it the active connection.
#[tauri::command]
async fn connect_local(app: AppHandle, state: State<'_, AppState>) -> Result<Value, local::LocalError> {
    let found = local::ensure(&state.http, std::process::id()).await?;
    let info = fetch_info(&state.http, &found.url)
        .await
        .map_err(|e| local::LocalError::Failed(e.to_string()))?;
    let saved = state
        .update(&app, |s| {
            s.hubs.retain(|h| !h.is_local());
            s.hubs.insert(
                0,
                HubProfile {
                    id: local::LOCAL_ID.into(),
                    name: "Prompture on this PC".into(),
                    url: found.url.clone(),
                    kind: "local".into(),
                },
            );
            s.active_hub = Some(local::LOCAL_ID.into());
        })
        .map_err(local::LocalError::Failed)?;
    restart_live(&app, &state);
    windows::apply_widget(&app, &saved, true);
    Ok(json!({ "url": found.url, "info": info }))
}

/// The local Prompture's version, the newest on PyPI, and whether Desk can update it.
#[tauri::command]
async fn prompture_status(state: State<'_, AppState>, fresh: Option<bool>) -> Result<local::PromptureStatus, ()> {
    Ok(local::status(&state.http, fresh.unwrap_or(false)).await)
}

/// Upgrade Desk's own Prompture now and reconnect to it.
#[tauri::command]
async fn update_prompture(app: AppHandle, state: State<'_, AppState>) -> Result<local::PromptureStatus, local::LocalError> {
    local::upgrade_now(&state.http, std::process::id()).await?;
    if state.snapshot().active().is_some_and(|h| h.is_local()) {
        restart_live(&app, &state);
    }
    Ok(local::status(&state.http, false).await)
}

#[tauri::command]
fn select_hub(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Settings, String> {
    let settings = state.update(&app, |s| {
        if s.hubs.iter().any(|h| h.id == id) {
            s.active_hub = Some(id.clone());
        }
    })?;
    restart_live(&app, &state);
    Ok(settings)
}

#[tauri::command]
fn remove_hub(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Settings, String> {
    if id != local::LOCAL_ID {
        store::delete_token(&id);
    }
    let settings = state.update(&app, |s| {
        s.hubs.retain(|h| h.id != id);
        if s.active_hub.as_deref() == Some(id.as_str()) {
            s.active_hub = s.hubs.first().map(|h| h.id.clone());
        }
    })?;
    restart_live(&app, &state);
    Ok(settings)
}

#[tauri::command]
fn live_status(state: State<'_, AppState>) -> live::LiveStatus {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
fn reconnect_live(app: AppHandle, state: State<'_, AppState>) {
    restart_live(&app, &state);
}

#[tauri::command]
fn update_tray(app: AppHandle, summary: tray::TraySummary) -> Result<(), String> {
    if let Some(icon) = app.tray_by_id(tray::TRAY_ID) {
        tray::apply(&icon, &summary).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_dashboard(app: AppHandle) {
    windows::open_dashboard(&app);
}

/// Open Desk's window, on `page` (a sidebar entry) when given.
#[tauri::command]
fn open_desk(app: AppHandle, page: Option<String>) {
    windows::show_main(&app, page.as_deref());
}

#[tauri::command]
fn play_alert_sound() {
    platform::alert_sound();
}

/// Hide the widget while a full-screen app runs (if enabled), and bring it back after.
fn watch_fullscreen(app: AppHandle) {
    std::thread::spawn(move || {
        let mut hidden_by_us = false;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let Some(state) = app.try_state::<AppState>() else { continue };
            let settings = state.snapshot();
            let wants_widget = windows::widget_wanted(&settings, is_paired(&settings));
            let fullscreen = settings.hide_fullscreen && platform::fullscreen_active();
            if wants_widget && fullscreen && !hidden_by_us {
                windows::set_widget_visible(&app, false);
                hidden_by_us = true;
            } else if hidden_by_us && !fullscreen {
                windows::set_widget_visible(&app, wants_widget);
                hidden_by_us = false;
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&[windows::MAIN, windows::WIDGET])
                .build(),
        )
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let path = store::settings_path(config_dir);
            let emitter = app.handle().clone();
            local::init(app.path().app_local_data_dir()?.join("runtime"), move |text| {
                let _ = emitter.emit("desk://local-setup", text);
            });
            let settings = store::load(&path);
            local::set_update_mode(&settings.prompture_updates);
            app.manage(AppState {
                path,
                settings: Mutex::new(settings),
                http: hub::client(),
                live: Mutex::new(None),
                pairing: Mutex::new(None),
                status: Mutex::new(live::LiveStatus::default()),
            });
            tray::build(app.handle())?;
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            restart_live(&handle, &state);
            let settings = state.snapshot();
            let paired = is_paired(&settings);
            windows::apply_widget(&handle, &settings, paired);
            if !paired {
                // First run: open Desk so onboarding is visible.
                windows::show_main(&handle, None);
            }
            watch_fullscreen(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing a window only hides it; Desk keeps running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            probe_hub,
            discover_local,
            start_pairing,
            poll_pairing,
            hub_request,
            select_hub,
            remove_hub,
            reconnect_live,
            live_status,
            update_tray,
            open_dashboard,
            open_desk,
            play_alert_sound,
            connect_local,
            prompture_status,
            update_prompture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Prompture Desk");
}

#[cfg(test)]
mod tests {
    use super::default_hub_name;

    #[test]
    fn hub_names_default_to_host() {
        assert_eq!(default_hub_name("http://127.0.0.1:1984"), "Hub on this PC");
        assert_eq!(default_hub_name("http://localhost:1984"), "Hub on this PC");
        assert_eq!(default_hub_name("https://hub.example.com"), "hub.example.com");
        assert_eq!(default_hub_name("http://192.168.1.20:1984/"), "192.168.1.20");
    }
}
