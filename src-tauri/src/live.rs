//! Background connection to the hub's `/v1/live` stream.
//!
//! Every parsed event is re-emitted to the webviews as `hub://live`, and the
//! connection state as `hub://status`. The task reconnects with exponential
//! backoff and resumes from the last event id, so a sleep/wake or a hub
//! restart costs nothing but a short gap.

use crate::hub::{self, SseParser};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
pub struct LiveStatus {
    pub state: &'static str, // "idle" | "connecting" | "live" | "retrying" | "unauthorized"
    pub message: Option<String>,
}

impl Default for LiveStatus {
    fn default() -> Self {
        Self { state: "idle", message: None }
    }
}

/// Record the connection state (windows that load later ask for it) and broadcast it.
fn status(app: &AppHandle, state: &'static str, message: Option<String>) {
    let current = LiveStatus { state, message };
    crate::remember_status(app, current.clone());
    let _ = app.emit("hub://status", current);
}

/// Where the stream comes from.
pub enum Source {
    /// A prompture-hub with a paired device token.
    Hub { url: String, token: String },
    /// The local Prompture companion; its address is re-read (and the
    /// companion restarted if needed) on every connection attempt.
    Local { owner_pid: u32 },
}

/// Run until the task is aborted (another hub was selected) or the token is refused.
pub async fn run(app: AppHandle, source: Source) {
    let http = hub::client();
    let mut last_id: Option<String> = None;
    let mut backoff = Duration::from_secs(1);
    loop {
        status(&app, "connecting", None);
        let (base, token) = match &source {
            Source::Hub { url, token } => (url.clone(), token.clone()),
            Source::Local { owner_pid } => match crate::local::ensure(&http, *owner_pid).await {
                Ok(state) => (state.url, state.token),
                Err(problem) => {
                    status(&app, "retrying", Some(format!("{problem:?}")));
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue;
                }
            },
        };
        let mut req = http.get(format!("{base}/v1/live")).bearer_auth(&token);
        if let Some(id) = &last_id {
            req = req.header("Last-Event-ID", id);
        }
        match req.send().await {
            Ok(resp) if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 => {
                status(&app, "unauthorized", Some("The hub no longer accepts this device. Pair again.".into()));
                return;
            }
            Ok(resp) if resp.status().is_success() => {
                status(&app, "live", None);
                backoff = Duration::from_secs(1);
                let mut parser = SseParser::default();
                let mut stream = resp.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let Ok(bytes) = chunk else { break };
                    for ev in parser.feed(&String::from_utf8_lossy(&bytes)) {
                        if ev.id.is_some() {
                            last_id = ev.id.clone();
                        }
                        if ev.event.as_deref() == Some("resync") {
                            // We fell behind: reconnect without an id to get a fresh snapshot.
                            last_id = None;
                        }
                        if let Ok(value) = serde_json::from_str::<Value>(&ev.data) {
                            let _ = app.emit("hub://live", value);
                        }
                    }
                }
                status(&app, "retrying", Some("stream closed".into()));
            }
            Ok(resp) => status(&app, "retrying", Some(format!("HTTP {}", resp.status().as_u16()))),
            Err(e) => status(&app, "retrying", Some(e.to_string())),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}
