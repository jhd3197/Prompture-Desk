//! The tray chip: a tray icon redrawn from hub state.
//!
//! Normally the icon is the app's own (`icons/32x32.png`), greyed out while
//! offline. In the Tray chip style the panel sends bars, and the icon becomes a
//! dark rounded tile with one vertical bar per visible provider (height = share
//! of its budget used, colour = ok / near limit / paused). Either way an amber
//! dot marks an open alert. The tooltip carries the one-line summary. The panel
//! window computes the numbers and sends a [`TraySummary`].

use std::sync::OnceLock;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Runtime};

pub const TRAY_ID: &str = "main";
const SIZE: u32 = 32;
const MAX_BARS: usize = 5;

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
pub struct TrayBar {
    /// Share of the budget used, 0..1.
    pub fraction: f64,
    /// "ok" | "warn" | "paused"
    pub tone: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TraySummary {
    /// "ok" | "attention" | "offline"
    pub state: String,
    #[serde(default)]
    pub bars: Vec<TrayBar>,
    #[serde(default)]
    pub alert: bool,
    pub tooltip: String,
}

type Rgb = (u8, u8, u8);

const TILE: Rgb = (42, 46, 53);
const TRACK: Rgb = (58, 63, 71);
const OK: Rgb = (63, 191, 116);
const WARN: Rgb = (229, 163, 58);
const PAUSED: Rgb = (107, 114, 128);

fn tone(t: &str) -> Rgb {
    match t {
        "warn" => WARN,
        "paused" => PAUSED,
        _ => OK,
    }
}

fn in_rounded_rect(x: u32, y: u32, radius: f64) -> bool {
    let (fx, fy, max) = (x as f64 + 0.5, y as f64 + 0.5, SIZE as f64);
    let cx = fx.clamp(radius, max - radius);
    let cy = fy.clamp(radius, max - radius);
    (fx - cx).powi(2) + (fy - cy).powi(2) <= radius * radius
}

/// The app icon as 32×32 RGBA.
fn app_icon() -> &'static [u8] {
    static ICON: OnceLock<Vec<u8>> = OnceLock::new();
    ICON.get_or_init(|| {
        let icon = Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("bundled 32x32 icon");
        assert_eq!((icon.width(), icon.height()), (SIZE, SIZE));
        icon.rgba().to_vec()
    })
}

/// Render the 32×32 RGBA icon. Pure so it can be unit-tested.
pub fn render(summary: &TraySummary) -> Vec<u8> {
    let offline = summary.state == "offline";
    let bars: Vec<&TrayBar> = summary.bars.iter().take(MAX_BARS).collect();
    let mut px = if offline || bars.is_empty() { app_icon().to_vec() } else { vec![0u8; (SIZE * SIZE * 4) as usize] };
    if offline {
        // Grey, dimmed: the same icon, clearly not live.
        for p in px.chunks_exact_mut(4) {
            let luma = (0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64) * 0.6;
            p[0] = luma as u8;
            p[1] = luma as u8;
            p[2] = luma as u8;
        }
    }
    let mut put = |x: u32, y: u32, c: Rgb| {
        let i = ((y * SIZE + x) * 4) as usize;
        px[i] = c.0;
        px[i + 1] = c.1;
        px[i + 2] = c.2;
        px[i + 3] = 255;
    };
    if !offline && !bars.is_empty() {
        for y in 0..SIZE {
            for x in 0..SIZE {
                if in_rounded_rect(x, y, 7.0) {
                    put(x, y, TILE);
                }
            }
        }
        // Bars sit on a baseline, centred as a group.
        let (bar_w, gap, bottom, max_h) = (3u32, 2u32, 26u32, 18.0_f64);
        let group = bars.len() as u32 * bar_w + (bars.len() as u32 - 1) * gap;
        let left = (SIZE - group) / 2;
        for (i, bar) in bars.iter().enumerate() {
            let x0 = left + i as u32 * (bar_w + gap);
            let h = (max_h * bar.fraction.clamp(0.0, 1.0)).round().max(3.0) as u32;
            for y in (bottom - max_h as u32)..bottom {
                for x in x0..x0 + bar_w {
                    put(x, y, if y >= bottom - h { tone(&bar.tone) } else { TRACK });
                }
            }
        }
    }

    if summary.alert && !offline {
        for y in 3..10 {
            for x in 22..29 {
                let (dx, dy) = (x as f64 - 25.0, y as f64 - 6.0);
                if dx * dx + dy * dy <= 10.5 {
                    put(x, y, WARN);
                }
            }
        }
    }
    px
}

pub fn apply<R: Runtime>(tray: &TrayIcon<R>, summary: &TraySummary) -> tauri::Result<()> {
    tray.set_icon(Some(Image::new_owned(render(summary), SIZE, SIZE)))?;
    tray.set_tooltip(Some(summary.tooltip.as_str()))?;
    Ok(())
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let open = MenuItem::with_id(app, "open", "Open Prompture Desk", true, None::<&str>)?;
    let widget = MenuItem::with_id(app, "widget", "Show / hide widget", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let dashboard = MenuItem::with_id(app, "dashboard", "Open hub dashboard", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Prompture Desk", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &widget, &settings, &dashboard, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    let initial = TraySummary { state: "offline".into(), tooltip: "Prompture Desk — not connected".into(), ..Default::default() };
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::new_owned(render(&initial), SIZE, SIZE))
        .tooltip(&initial.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => crate::windows::show_main(app, Some("overview")),
            "widget" => crate::windows::toggle_widget(app),
            "settings" => crate::windows::show_main(app, Some("widget")),
            "dashboard" => crate::windows::open_dashboard(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::windows::toggle_main(tray.app_handle());
            }
        })
        .build(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(px: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    fn bar(fraction: f64, tone: &str) -> TrayBar {
        TrayBar { fraction, tone: tone.into() }
    }

    #[test]
    fn without_bars_it_is_the_app_icon() {
        let img = render(&TraySummary { state: "ok".into(), ..Default::default() });
        assert_eq!(img, app_icon());
    }

    #[test]
    fn tile_corners_are_transparent() {
        let img = render(&TraySummary { state: "ok".into(), bars: vec![bar(0.5, "ok")], ..Default::default() });
        assert_eq!(pixel(&img, 0, 0)[3], 0);
        assert_eq!(pixel(&img, 16, 30)[3], 255);
    }

    #[test]
    fn bars_fill_from_the_baseline_with_their_tone() {
        let img = render(&TraySummary {
            state: "ok".into(),
            bars: vec![bar(1.0, "ok"), bar(0.5, "warn"), bar(0.0, "paused")],
            ..Default::default()
        });
        // Three 3px bars with 2px gaps = 13px, starting at x = 9.
        assert_eq!(pixel(&img, 10, 9), [63, 191, 116, 255]); // full bar reaches the top
        assert_eq!(pixel(&img, 15, 9), [58, 63, 71, 255]); // half bar: track above
        assert_eq!(pixel(&img, 15, 24), [229, 163, 58, 255]); // half bar: amber below
        assert_eq!(pixel(&img, 20, 25), [107, 114, 128, 255]); // empty bar keeps a 3px stub
    }

    #[test]
    fn alert_dot_and_offline() {
        let alerting = render(&TraySummary { state: "ok".into(), bars: vec![bar(0.2, "ok")], alert: true, ..Default::default() });
        assert_eq!(pixel(&alerting, 25, 6), [229, 163, 58, 255]);
        // Offline: the app icon in grey, bars and alert ignored.
        let offline = render(&TraySummary { state: "offline".into(), bars: vec![bar(0.9, "ok")], alert: true, ..Default::default() });
        let icon = app_icon();
        for (o, i) in offline.chunks_exact(4).zip(icon.chunks_exact(4)) {
            assert!(o[0] == o[1] && o[1] == o[2]);
            assert_eq!(o[3], i[3]);
        }
    }
}
