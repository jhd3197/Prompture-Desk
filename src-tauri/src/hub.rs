//! HTTP client for a prompture-hub's companion API.
//!
//! All hub traffic goes through Rust (not the webview's `fetch`), so the hub
//! needs no CORS configuration and the device token never enters page JS.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

pub const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// Oldest companion API this app understands (`api_version` in `/v1/companion/info`).
pub const MIN_API_VERSION: u64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum HubError {
    #[error("can't reach the hub: {0}")]
    Unreachable(String),
    #[error("the hub refused the device token (HTTP {0}); pair again")]
    Unauthorized(u16),
    #[error("{0}")]
    Http(String),
}

impl Serialize for HubError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub fn normalize_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    }
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("prompture-desk/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client")
}

async fn detail(resp: reqwest::Response) -> String {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("detail").or_else(|| v.get("error_description")).cloned())
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("HTTP {}", status.as_u16()))
}

/// One authenticated request to the active hub. `path` starts with `/v1/`.
pub async fn request(
    http: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, HubError> {
    if !path.starts_with("/v1/") {
        return Err(HubError::Http("only /v1/ companion paths are allowed".into()));
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| HubError::Http(e.to_string()))?;
    let mut req = http.request(method, format!("{base}{path}")).timeout(Duration::from_secs(20));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| HubError::Unreachable(e.to_string()))?;
    let status = resp.status().as_u16();
    if status == 401 {
        return Err(HubError::Unauthorized(status));
    }
    if !resp.status().is_success() {
        return Err(HubError::Http(detail(resp).await));
    }
    if status == 204 {
        return Ok(Value::Null);
    }
    resp.json().await.map_err(|e| HubError::Http(e.to_string()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

pub async fn start_pairing(
    http: &reqwest::Client,
    base: &str,
    client_name: &str,
    scope: &str,
) -> Result<DeviceCode, HubError> {
    let resp = http
        .post(format!("{base}/v1/companion/device/code"))
        .form(&[("client_name", client_name), ("scope", scope)])
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| HubError::Unreachable(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(HubError::Http(detail(resp).await));
    }
    resp.json().await.map_err(|e| HubError::Http(e.to_string()))
}

/// Outcome of one token poll (RFC 8628 §3.5).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PollOutcome {
    Pending,
    SlowDown,
    Approved { token: String, scope: String },
    Denied,
    Expired,
    Failed { message: String },
}

pub fn classify_poll(status: u16, body: &Value) -> PollOutcome {
    if status == 200 {
        return match body.get("access_token").and_then(Value::as_str) {
            Some(token) => PollOutcome::Approved {
                token: token.to_string(),
                scope: body.get("scope").and_then(Value::as_str).unwrap_or("read").to_string(),
            },
            None => PollOutcome::Failed { message: "hub returned no token".into() },
        };
    }
    match body.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => PollOutcome::Pending,
        Some("slow_down") => PollOutcome::SlowDown,
        Some("access_denied") => PollOutcome::Denied,
        Some("expired_token") => PollOutcome::Expired,
        other => PollOutcome::Failed {
            message: other.map(str::to_string).unwrap_or_else(|| format!("HTTP {status}")),
        },
    }
}

pub async fn poll_pairing(http: &reqwest::Client, base: &str, device_code: &str) -> PollOutcome {
    let resp = http
        .post(format!("{base}/v1/companion/device/token"))
        .form(&[("grant_type", DEVICE_GRANT), ("device_code", device_code)])
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            let body: Value = r.json().await.unwrap_or(Value::Null);
            classify_poll(status, &body)
        }
        Err(e) => PollOutcome::Failed { message: e.to_string() },
    }
}

/// Incremental Server-Sent Events parser: feed bytes, get complete events.
#[derive(Default)]
pub struct SseParser {
    buffer: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

impl SseParser {
    pub fn feed(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.buffer.push_str(&chunk.replace("\r\n", "\n"));
        let mut events = Vec::new();
        while let Some(end) = self.buffer.find("\n\n") {
            let block: String = self.buffer.drain(..end + 2).collect();
            let mut ev = SseEvent { id: None, event: None, data: String::new() };
            let mut has_data = false;
            for line in block.lines() {
                if line.starts_with(':') || line.is_empty() {
                    continue;
                }
                let (field, value) = line.split_once(':').unwrap_or((line, ""));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match field {
                    "id" => ev.id = Some(value.to_string()),
                    "event" => ev.event = Some(value.to_string()),
                    "data" => {
                        if has_data {
                            ev.data.push('\n');
                        }
                        ev.data.push_str(value);
                        has_data = true;
                    }
                    _ => {}
                }
            }
            if has_data {
                events.push(ev);
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn urls_are_normalized() {
        assert_eq!(normalize_url(" 127.0.0.1:1984/ "), "http://127.0.0.1:1984");
        assert_eq!(normalize_url("https://hub.example.com/"), "https://hub.example.com");
    }

    #[test]
    fn poll_outcomes_follow_rfc_8628() {
        assert_eq!(classify_poll(400, &json!({"error": "authorization_pending"})), PollOutcome::Pending);
        assert_eq!(classify_poll(400, &json!({"error": "slow_down"})), PollOutcome::SlowDown);
        assert_eq!(classify_poll(400, &json!({"error": "access_denied"})), PollOutcome::Denied);
        assert_eq!(classify_poll(400, &json!({"error": "expired_token"})), PollOutcome::Expired);
        assert_eq!(
            classify_poll(200, &json!({"access_token": "phd_x", "scope": "read control"})),
            PollOutcome::Approved { token: "phd_x".into(), scope: "read control".into() }
        );
        assert!(matches!(classify_poll(500, &Value::Null), PollOutcome::Failed { .. }));
    }

    #[test]
    fn sse_parser_handles_split_chunks_and_comments() {
        let mut p = SseParser::default();
        assert!(p.feed("retry: 3000\n\n: keep-alive\n\nid: 7\nevent: request.sta").is_empty());
        let events = p.feed("rted\ndata: {\"a\":1}\n\n");
        assert_eq!(
            events,
            vec![SseEvent { id: Some("7".into()), event: Some("request.started".into()), data: "{\"a\":1}".into() }]
        );
    }

    #[test]
    fn sse_parser_joins_multiline_data_and_crlf() {
        let mut p = SseParser::default();
        let events = p.feed("data: one\r\ndata: two\r\n\r\n");
        assert_eq!(events[0].data, "one\ntwo");
    }
}
