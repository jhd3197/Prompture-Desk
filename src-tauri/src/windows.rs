//! The two windows:
//!
//! - **main** — Prompture Desk itself: a centred window with the dashboard
//!   (overview, activity, limits, alerts) and settings side by side in one
//!   sidebar. Closing it hides it; the tray and the widget bring it back.
//! - **widget** — the floating widget (edge dock or top capsule). It sizes and
//!   places itself from the webview; Rust only shows, hides and pins it.

use crate::store::Settings;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

pub const MAIN: &str = "main";
pub const WIDGET: &str = "widget";

fn window<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<WebviewWindow<R>> {
    app.get_webview_window(label)
}

/// Bring Desk to the front, centred when it wasn't already open, on `page`
/// (a sidebar entry such as "overview" or "widget") when one is given.
pub fn show_main<R: Runtime>(app: &AppHandle<R>, page: Option<&str>) {
    let Some(w) = window(app, MAIN) else { return };
    if !w.is_visible().unwrap_or(false) {
        let _ = w.center();
    }
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    if let Some(page) = page {
        let _ = w.emit("desk://navigate", page);
    }
}

/// Tray click: open Desk, or put it away if it is already in front.
pub fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(w) = window(app, MAIN) else { return };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
    } else {
        show_main(app, None);
    }
}

pub fn set_widget_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    if let Some(w) = window(app, WIDGET) {
        let _ = if visible { w.show() } else { w.hide() };
    }
}

pub fn toggle_widget<R: Runtime>(app: &AppHandle<R>) {
    let visible = window(app, WIDGET).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    set_widget_visible(app, !visible);
}

/// Show or hide the widget for the chosen style, and pin it on top or not.
/// Whether the floating widget should be on screen. Before setup only the
/// capsule shows, as a "not set up" island that opens onboarding.
pub fn widget_wanted(settings: &Settings, paired: bool) -> bool {
    match settings.widget_style.as_str() {
        "tray" => false,
        "capsule" => true,
        _ => paired,
    }
}

pub fn apply_widget<R: Runtime>(app: &AppHandle<R>, settings: &Settings, paired: bool) {
    if let Some(w) = window(app, WIDGET) {
        let _ = w.set_always_on_top(settings.always_on_top);
    }
    set_widget_visible(app, widget_wanted(settings, paired));
}

/// Open the hub's web dashboard. Local mode has no web dashboard, so Desk's own opens instead.
pub fn open_dashboard<R: Runtime>(app: &AppHandle<R>) {
    match crate::active_hub_url(app) {
        Some(url) => {
            let _ = app.opener().open_url(format!("{url}/app/"), None::<&str>);
        }
        None => show_main(app, Some("overview")),
    }
}
