//! Settings on disk and device tokens in the OS keychain.
//!
//! `settings.json` in the app config dir holds hub connections and view
//! preferences. A device token (`phd_…`) is a credential, so it never goes in
//! that file: it lives in the platform keychain under the hub's id.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "dev.prompture.desk";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HubProfile {
    pub id: String,
    pub name: String,
    pub url: String,
    /// "hub" (a paired prompture-hub) or "local" (Prompture on this machine).
    #[serde(default = "hub_kind")]
    pub kind: String,
}

fn hub_kind() -> String {
    "hub".into()
}

impl HubProfile {
    pub fn is_local(&self) -> bool {
        self.kind == "local"
    }
}

/// One provider's row in the widgets: shown or not, and the daily budget its strip fills against.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderPref {
    pub id: String,
    pub visible: bool,
    pub budget_usd: f64,
    pub budget_tokens: u64,
}

impl Default for ProviderPref {
    fn default() -> Self {
        Self { id: String::new(), visible: true, budget_usd: 1.0, budget_tokens: 1_000_000 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub hubs: Vec<HubProfile>,
    pub active_hub: Option<String>,

    // Widget
    /// "dock" (edge dock), "capsule" (top capsule) or "tray" (tray icon only).
    pub widget_style: String,
    /// "price" or "tokens".
    pub metric: String,
    /// Edge dock side: "left" or "right".
    pub dock_edge: String,
    /// The page of Desk the dock's button opens: "overview", "activity", "tools" or "widget" (settings).
    pub dock_button: String,
    /// Edge dock vertical position, as a fraction of the work area height.
    pub dock_y: f64,
    /// "always" (always shown) or "hover" (tucks into a sliver at the screen edge until hovered).
    pub visibility: String,
    /// "compact" (glyphs and strips), "detailed" (adds labels) or "auto" (per platform).
    pub detail: String,
    pub show_alerts: bool,
    pub always_on_top: bool,
    pub hide_fullscreen: bool,
    pub launch_at_login: bool,

    // Appearance
    /// "light", "dark" or "system".
    pub theme: String,
    /// Index into the accent hue list.
    pub accent: u8,
    /// Widget opacity in percent.
    pub opacity: u8,

    // Providers, in widget order
    pub providers: Vec<ProviderPref>,

    // Alerts
    /// Strips turn amber at this share (percent) of a budget or rate window.
    pub warn_at: u8,
    pub notify_alerts: bool,
    pub notify_errors: bool,
    pub notify_paused: bool,
    pub notify_long_calls: bool,
    pub play_sound: bool,

    // Connection
    /// How often limits and spend are re-read (the live stream is continuous).
    pub refresh_secs: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hubs: Vec::new(),
            active_hub: None,
            widget_style: "capsule".into(),
            metric: "price".into(),
            dock_edge: "right".into(),
            dock_button: "overview".into(),
            dock_y: 0.2,
            visibility: "hover".into(),
            detail: "auto".into(),
            show_alerts: true,
            always_on_top: true,
            hide_fullscreen: true,
            launch_at_login: false,
            theme: "system".into(),
            accent: 0,
            opacity: 100,
            providers: Vec::new(),
            warn_at: 85,
            notify_alerts: true,
            notify_errors: false,
            notify_paused: true,
            notify_long_calls: false,
            play_sound: false,
            refresh_secs: 5,
        }
    }
}

impl Settings {
    pub fn active(&self) -> Option<&HubProfile> {
        let id = self.active_hub.as_ref()?;
        self.hubs.iter().find(|h| &h.id == id)
    }
}

pub fn settings_path(config_dir: PathBuf) -> PathBuf {
    config_dir.join("settings.json")
}

pub fn load(path: &PathBuf) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(path: &PathBuf, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

fn entry(hub_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, hub_id).map_err(|e| e.to_string())
}

pub fn get_token(hub_id: &str) -> Option<String> {
    entry(hub_id).ok()?.get_password().ok()
}

pub fn set_token(hub_id: &str, token: &str) -> Result<(), String> {
    entry(hub_id)?.set_password(token).map_err(|e| e.to_string())
}

pub fn delete_token(hub_id: &str) {
    if let Ok(e) = entry(hub_id) {
        let _ = e.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_broken_file_gives_defaults() {
        let dir = std::env::temp_dir().join(format!("pdesk-{}", uuid::Uuid::new_v4()));
        let path = settings_path(dir.clone());
        assert_eq!(load(&path), Settings::default());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path), Settings::default());
    }

    #[test]
    fn round_trip_and_active_lookup() {
        let dir = std::env::temp_dir().join(format!("pdesk-{}", uuid::Uuid::new_v4()));
        let path = settings_path(dir);
        let mut s = Settings::default();
        s.hubs.push(HubProfile { id: "a".into(), name: "Home".into(), url: "http://127.0.0.1:1984".into(), kind: "hub".into() });
        s.active_hub = Some("a".into());
        save(&path, &s).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded, s);
        assert_eq!(loaded.active().unwrap().name, "Home");
    }

    #[test]
    fn partial_file_fills_missing_fields() {
        let dir = std::env::temp_dir().join(format!("pdesk-{}", uuid::Uuid::new_v4()));
        let path = settings_path(dir.clone());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, r#"{"metric": "tokens", "providers": [{"id": "claude"}], "mini_visible": true}"#).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.metric, "tokens");
        assert_eq!(loaded.widget_style, "capsule");
        assert_eq!(loaded.providers[0], ProviderPref { id: "claude".into(), ..Default::default() });
    }
}
