//! Desk as a Vela companion app.
//!
//! When Vela runs on this computer, Desk registers with it (see the
//! `vela-companion` crate). Once the owner connects it in Vela, today's usage,
//! the last week and the running automation show on the Vela desk and on every
//! phone signed in to it, and the automation can be paused, resumed, skipped or
//! stopped from there. Everything is read from the same Prompture connection
//! the panel uses; nothing here is stored.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use vela_companion::{Action, Companion, Handle, Layout, Size, Widgets};

use crate::{hub, AppState};

/// What Vela asks for has to come back in five seconds; leave room for it.
const READ_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Default)]
pub struct VelaLink(Mutex<Option<Handle>>);

/// Register with Vela. Harmless when Vela is not installed: the file waits.
pub fn start(app: &AppHandle) {
    app.manage(VelaLink::default());
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let (for_widgets, for_actions) = (handle.clone(), handle.clone());
        let companion = Companion::new("prompture-desk", "Prompture Desk", env!("CARGO_PKG_VERSION"))
            .description("AI usage and coding-agent automations on this computer.")
            .color("#8b7ff6")
            .icon_png(include_bytes!("../icons/128x128.png").to_vec())
            .widget("today", "Today", Layout::Stat, Size::S)
            .widget("week", "Last 7 days", Layout::Chart, Size::M)
            .widget("automation", "Automation", Layout::Actions, Size::M)
            .action(Action::new("pause", "Pause automation").description("Pauses after the current step."))
            .action(Action::new("resume", "Resume automation"))
            .action(Action::new("skip", "Skip step").confirm("Skip the current step?"))
            .action(Action::new("stop", "Stop automation").confirm("Stop the running automation?"))
            .on_widgets(move || {
                let app = for_widgets.clone();
                async move { tokio::time::timeout(READ_TIMEOUT, widgets(&app)).await.unwrap_or_default() }
            })
            .on_action(move |id| {
                let app = for_actions.clone();
                async move { action(&app, &id).await }
            });
        match companion.start().await {
            Ok(registered) => {
                if let Some(link) = handle.try_state::<VelaLink>() {
                    *link.0.lock().unwrap() = Some(registered);
                }
            }
            Err(e) => eprintln!("[vela] could not register: {e}"),
        }
    });
}

/// Unregister, so Vela shows Desk as closed rather than not answering.
pub fn stop(app: &AppHandle) {
    if let Some(link) = app.try_state::<VelaLink>() {
        link.0.lock().unwrap().take();
    }
}

async fn get(app: &AppHandle, path: &str) -> Result<Value, hub::HubError> {
    call(app, "GET", path).await
}

async fn call(app: &AppHandle, method: &str, path: &str) -> Result<Value, hub::HubError> {
    let state = app.state::<AppState>();
    let (url, token) = state.active_credentials().await?;
    let body = (method == "POST").then(|| json!({}));
    hub::request(&state.http, &url, Some(&token), method, path, body).await
}

/// Minutes behind UTC, the way the panel's JavaScript sends it.
fn tz_offset() -> i32 {
    -chrono::Local::now().offset().local_minus_utc() / 60
}

async fn widgets(app: &AppHandle) -> Widgets {
    let mut out = Widgets::new();
    let tokens_first = app.state::<AppState>().snapshot().metric == "tokens";
    let tz = tz_offset();
    let (spend_path, activity_path) =
        (format!("/v1/spend?period=day&tz_offset={tz}"), format!("/v1/activity?days=7&tz_offset={tz}"));
    let (spend, activity, automations) =
        tokio::join!(get(app, &spend_path), get(app, &activity_path), get(app, "/v1/automations"));
    if let Ok(spend) = spend {
        out.insert("today".into(), today(&spend["total"], tokens_first));
    }
    if let Ok(activity) = activity {
        out.insert("week".into(), week(&activity, tokens_first));
    }
    if let Ok(automations) = automations {
        out.insert("automation".into(), automation(&automations["current"]));
    }
    out
}

fn today(total: &Value, tokens_first: bool) -> Value {
    let calls = total["requests"].as_u64().unwrap_or(0);
    let tokens = total["tokens"].as_f64().unwrap_or(0.0);
    let cost = total["cost_usd"].as_f64().unwrap_or(0.0);
    let (value, other) = if tokens_first {
        (short_count(tokens), usd(cost))
    } else {
        (usd(cost), format!("{} tokens", short_count(tokens)))
    };
    let plural = if calls == 1 { "" } else { "s" };
    json!({ "value": value, "caption": format!("{calls} call{plural} · {other}") })
}

fn week(activity: &Value, tokens_first: bool) -> Value {
    // Only active days are listed; the chart needs all seven, oldest first.
    let today = chrono::Local::now().date_naive();
    let days = activity["days"].as_array().cloned().unwrap_or_default();
    let series: Vec<f64> = (0..7)
        .rev()
        .map(|back| {
            let date = (today - chrono::Duration::days(back)).format("%Y-%m-%d").to_string();
            days.iter()
                .find(|day| day["date"] == date.as_str())
                .map(|day| {
                    if tokens_first { day["tokens"].as_f64() } else { day["cost_usd"].as_f64() }.unwrap_or(0.0)
                })
                .unwrap_or(0.0)
        })
        .collect();
    let total: f64 = series.iter().sum();
    let value = if tokens_first { short_count(total) } else { usd(total) };
    json!({ "value": value, "series": series, "caption": "last 7 days" })
}

fn automation(current: &Value) -> Value {
    if current.is_null() {
        return json!({ "value": "Idle", "caption": "No automation running." });
    }
    let status = current["status"].as_str().unwrap_or("");
    let steps = current["steps"].as_array().map(Vec::len).unwrap_or(0);
    let step = current["current"].as_u64().unwrap_or(0) as usize + 1;
    let project = current["project"].as_str().unwrap_or("Automation");
    let doing = current["steps"][step - 1]["action"].as_str().filter(|text| !text.is_empty());
    let reason = current["reason"].as_str();
    // Waiting on the person: a question, or a stop rule that tripped.
    let attention = status == "paused" && matches!(reason, Some("ask") | Some("limit") | Some("fail") | Some("cost"));
    let caption = match (status, reason) {
        ("paused", Some("ask")) => current["question"].as_str().unwrap_or("It has a question for you.").to_string(),
        ("paused", Some("limit")) => "Paused at a usage limit.".into(),
        ("paused", Some("fail")) => "Paused after a step failed.".into(),
        ("paused", Some("cost")) => "Paused at its cost limit.".into(),
        ("paused", _) => format!("Paused at step {step} of {steps}."),
        ("running", _) => match doing {
            Some(text) => format!("Step {step} of {steps} · {text}"),
            None => format!("Step {step} of {steps}"),
        },
        (other, _) => format!("{} · {steps} steps", capitalize(other)),
    };
    let actions = match status {
        "running" if current["pausing"].as_bool() == Some(true) => json!([{ "action": "stop", "label": "Stop" }]),
        "running" => json!([{ "action": "pause", "label": "Pause" }, { "action": "stop", "label": "Stop" }]),
        "paused" => json!([{ "action": "resume", "label": "Resume" }, { "action": "stop", "label": "Stop" }]),
        _ => json!([]),
    };
    let mut summary = json!({
        "value": truncate(project, 60),
        "caption": truncate(&caption, 200),
        "attention": attention,
        "actions": actions,
    });
    if attention {
        summary["badge"] = json!("1");
    }
    summary
}

async fn action(app: &AppHandle, id: &str) -> Result<String, String> {
    let current = get(app, "/v1/automations").await.map_err(|e| e.to_string())?;
    if current["current"].is_null() || !matches!(current["current"]["status"].as_str(), Some("running" | "paused")) {
        return Err("No automation is running.".into());
    }
    call(app, "POST", &format!("/v1/automations/current/{id}")).await.map_err(|e| e.to_string())?;
    Ok(match id {
        "pause" => "Pauses after the current step.",
        "resume" => "Resumed.",
        "skip" => "Skipped.",
        "stop" => "Stopped.",
        _ => "Done.",
    }
    .into())
}

fn usd(v: f64) -> String {
    if v == 0.0 {
        "$0.00".into()
    } else if v < 0.01 {
        format!("${v:.4}")
    } else {
        format!("${v:.2}")
    }
}

/// 950, 12.4k, 116M, 1.66B — the panel's short counts.
fn short_count(v: f64) -> String {
    for (size, unit) in [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "k")] {
        if v >= size {
            let n = v / size;
            let digits = if n >= 100.0 { 0 } else if n >= 10.0 { 1 } else { 2 };
            let text = format!("{n:.digits$}");
            let text = if text.contains('.') { text.trim_end_matches('0').trim_end_matches('.') } else { &text };
            return format!("{text}{unit}");
        }
    }
    format!("{}", v.round() as u64)
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_read_like_the_panel() {
        assert_eq!(short_count(950.0), "950");
        assert_eq!(short_count(12_400.0), "12.4k");
        assert_eq!(short_count(116_000_000.0), "116M");
        assert_eq!(short_count(1_660_000_000.0), "1.66B");
        assert_eq!(short_count(2_000_000.0), "2M");
        assert_eq!(usd(4.123), "$4.12");
        assert_eq!(usd(0.0012), "$0.0012");
    }

    #[test]
    fn a_question_needs_the_person() {
        let summary = automation(&json!({
            "status": "paused", "reason": "ask", "question": "Use the staging database?",
            "project": "shop", "current": 1, "steps": [{}, {}, {}],
        }));
        assert_eq!(summary["attention"], true);
        assert_eq!(summary["caption"], "Use the staging database?");
        assert_eq!(summary["actions"][0]["action"], "resume");
        assert_eq!(summary["badge"], "1");
    }

    #[test]
    fn a_running_step_says_what_it_is_doing() {
        let summary = automation(&json!({
            "status": "running", "project": "shop", "current": 0, "pausing": false,
            "steps": [{ "action": "Editing src/app.py…" }, {}],
        }));
        assert_eq!(summary["attention"], false);
        assert_eq!(summary["caption"], "Step 1 of 2 · Editing src/app.py…");
        assert_eq!(summary["actions"][0]["action"], "pause");
        assert!(summary.get("badge").is_none());
    }

    #[test]
    fn nothing_running_is_idle() {
        assert_eq!(automation(&Value::Null)["value"], "Idle");
    }

    #[test]
    fn today_leads_with_the_chosen_metric() {
        let total = json!({ "requests": 18, "tokens": 1_240_000, "cost_usd": 4.12 });
        assert_eq!(today(&total, false), json!({ "value": "$4.12", "caption": "18 calls · 1.24M tokens" }));
        assert_eq!(today(&total, true), json!({ "value": "1.24M", "caption": "18 calls · $4.12" }));
    }
}
