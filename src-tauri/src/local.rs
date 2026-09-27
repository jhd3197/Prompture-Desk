//! Local mode: Prompture on this machine, no hub needed.
//!
//! `prompture companion` (Prompture 1.13+) serves this machine's Prompture
//! usage with the same companion API as prompture-hub, on 127.0.0.1 with a
//! bearer token, and writes both to `~/.prompture/companion.json`. Desk reads
//! that file, and starts the companion itself when none is running — tied to
//! Desk's own process so it stops when Desk quits.
//!
//! Desk starts the Prompture the user installed if it has a companion. If not
//! (no Python, no Prompture, or an older one), Desk sets up its own copy with
//! the bundled `uv`, which brings its own Python and keeps everything inside
//! Desk's data folder, so installing Desk is all a user has to do.
//!
//! Desk keeps its own copy current per the `prompture_updates` setting:
//! upgraded daily before it starts (`auto`), offered in the UI when PyPI has a
//! newer release (`ask`), or left alone (`off`). A Prompture the user installed
//! is theirs to upgrade; Desk only reports when it's behind.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const LOCAL_ID: &str = "local";
const START_TIMEOUT: Duration = Duration::from_secs(15);
const SETUP_TIMEOUT: Duration = Duration::from_secs(600);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(60);
const UPDATE_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// The oldest Prompture whose companion has everything Desk uses (routing Claude
/// Code, Codex and Gemini CLI with call records, presets and fallback, shared
/// project memory, a clean shutdown). An older one Desk started is replaced by
/// Desk's own copy, and Desk's own copy is upgraded to at least this.
pub const MIN_PROMPTURE: &str = "1.13.4";
/// What Desk's own copy installs; `PROMPTURE_DESK_PACKAGE` overrides it (a path or pin, for development).
const PACKAGE: &str = "prompture>=1.13.4";
const PYTHON: &str = "3.12";
const PYPI_JSON: &str = "https://pypi.org/pypi/prompture/json";
/// How long a PyPI answer is reused before asking again.
const LATEST_TTL: Duration = Duration::from_secs(60 * 60);

/// Serializes find-or-start: the live stream and the first data request both
/// call [`ensure`] at startup, and must not launch two companions.
static ENSURE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

type Report = Box<dyn Fn(Option<&str>) + Send + Sync>;

/// Where Desk keeps its own Prompture, and how setup progress reaches the UI.
struct Managed {
    dir: PathBuf,
    report: Report,
}

static MANAGED: OnceLock<Managed> = OnceLock::new();

/// Whether the companion Desk last started is its own copy (which Desk may upgrade).
static RUNNING_OWN: AtomicBool = AtomicBool::new(false);

const MODE_AUTO: u8 = 0;
const MODE_ASK: u8 = 1;
const MODE_OFF: u8 = 2;
static UPDATE_MODE: AtomicU8 = AtomicU8::new(MODE_AUTO);

/// The last PyPI answer and when it came.
static LATEST: Mutex<Option<(Instant, String)>> = Mutex::new(None);

/// Apply the `prompture_updates` setting: "auto", "ask" or "off".
pub fn set_update_mode(mode: &str) {
    let m = match mode {
        "ask" => MODE_ASK,
        "off" => MODE_OFF,
        _ => MODE_AUTO,
    };
    UPDATE_MODE.store(m, Ordering::Relaxed);
}

/// Call once at startup. `report` receives setup progress text, then `None` when done.
pub fn init(dir: PathBuf, report: impl Fn(Option<&str>) + Send + Sync + 'static) {
    let _ = MANAGED.set(Managed { dir, report: Box::new(report) });
}

fn report(text: Option<&str>) {
    if let Some(m) = MANAGED.get() {
        (m.report)(text);
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct LocalState {
    pub url: String,
    pub token: String,
    #[serde(default)]
    pub pid: Option<u32>,
}

/// Why local mode couldn't start, in terms the onboarding screen can act on.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum LocalError {
    /// No `prompture` command or importable package was found, and Desk can't set one up.
    NotInstalled(String),
    /// Prompture is installed but has no `companion` command (older than 1.13).
    NeedsUpgrade(String),
    Failed(String),
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

pub fn state_path() -> Option<PathBuf> {
    home().map(|h| h.join(".prompture").join("companion.json"))
}

pub fn read_state() -> Option<LocalState> {
    let raw = std::fs::read_to_string(state_path()?).ok()?;
    serde_json::from_str::<LocalState>(&raw).ok().filter(|s| !s.url.is_empty() && !s.token.is_empty())
}

pub async fn reachable(http: &reqwest::Client, state: &LocalState) -> bool {
    http.get(format!("{}/v1/companion/info", state.url))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn companion_args(owner_pid: u32) -> [String; 3] {
    ["companion".into(), "--exit-with-pid".into(), owner_pid.to_string()]
}

fn launcher(program: impl AsRef<std::ffi::OsStr>, prefix: &[&str], owner_pid: u32) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(prefix).args(companion_args(owner_pid)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    no_window(&mut cmd);
    cmd
}

/// Ways to launch a Prompture the user installed, most specific first.
fn launchers(owner_pid: u32) -> Vec<Command> {
    let candidates: Vec<Vec<&str>> = if cfg!(windows) {
        // Through cmd so .bat shims (pyenv, pipx) resolve like they do in a terminal.
        vec![
            vec!["cmd", "/C", "prompture"],
            vec!["cmd", "/C", "py", "-m", "prompture"],
            vec!["cmd", "/C", "python", "-m", "prompture"],
        ]
    } else {
        vec![vec!["prompture"], vec!["python3", "-m", "prompture"], vec!["python", "-m", "prompture"]]
    };
    candidates.into_iter().map(|parts| launcher(parts[0], &parts[1..], owner_pid)).collect()
}

fn stderr_of(child: &mut Child) -> String {
    let mut text = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut text);
    }
    text
}

/// Classify a launcher that exited before the companion came up.
pub fn classify_exit(stderr: &str) -> Option<LocalError> {
    let lower = stderr.to_lowercase();
    if lower.contains("no such command") && lower.contains("companion") {
        return Some(LocalError::NeedsUpgrade(
            "Prompture on this PC is older than 1.13 and has no companion. Update it: pipx upgrade prompture (or pip install -U prompture).".into(),
        ));
    }
    let missing = [
        "is not recognized as an internal or external command",
        "no module named prompture",
        "command not found",
        "can't find",
        "not found",
        "was not found",
    ];
    if missing.iter().any(|m| lower.contains(m)) || stderr.trim().is_empty() {
        return None; // this launcher isn't available; try the next one
    }
    Some(LocalError::Failed(stderr.lines().last().unwrap_or("the companion exited").trim().to_string()))
}

/// Start the first launcher that brings a companion up.
/// `Err(None)` means none of them was available at all.
async fn start_first(http: &reqwest::Client, launchers: Vec<Command>) -> Result<LocalState, Option<LocalError>> {
    let mut last_problem: Option<LocalError> = None;
    for mut launcher in launchers {
        let Ok(mut child) = launcher.spawn() else { continue };
        let started = Instant::now();
        loop {
            if let Some(state) = read_state() {
                if reachable(http, &state).await {
                    // Keep draining stderr so the companion never blocks on a full pipe.
                    if let Some(mut err) = child.stderr.take() {
                        std::thread::spawn(move || {
                            let mut sink = Vec::new();
                            let _ = err.read_to_end(&mut sink);
                        });
                    }
                    return Ok(state);
                }
            }
            if let Ok(Some(_status)) = child.try_wait() {
                if let Some(problem) = classify_exit(&stderr_of(&mut child)) {
                    let upgrade = matches!(problem, LocalError::NeedsUpgrade(_));
                    last_problem = Some(problem);
                    if upgrade {
                        return Err(last_problem);
                    }
                }
                break;
            }
            if started.elapsed() > START_TIMEOUT {
                let _ = child.kill();
                last_problem = Some(LocalError::Failed("the Prompture companion didn't start in time".into()));
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    Err(last_problem)
}

// ------------------------------------------------------------------ Desk's own copy

/// The `uv` shipped next to Desk's executable.
fn uv_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let uv = exe.parent()?.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    uv.is_file().then_some(uv)
}

fn managed_bin(dir: &Path) -> PathBuf {
    dir.join("bin").join(if cfg!(windows) { "prompture.exe" } else { "prompture" })
}

/// A `uv` command confined to Desk's folder: its own Python, tools and cache.
fn uv_command(uv: &Path, dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(uv);
    cmd.args(args)
        .env("UV_TOOL_DIR", dir.join("tools"))
        .env("UV_TOOL_BIN_DIR", dir.join("bin"))
        .env("UV_PYTHON_INSTALL_DIR", dir.join("python"))
        .env("UV_CACHE_DIR", dir.join("cache"))
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("UV_NO_PROGRESS", "1")
        .env_remove("VIRTUAL_ENV")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    cmd
}

/// Run to completion (or kill after `timeout`); returns success and stderr.
fn run(mut cmd: Command, timeout: Duration) -> (bool, String) {
    let Ok(mut child) = cmd.spawn() else { return (false, "couldn't start uv".into()) };
    let mut err = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_string(&mut text);
        }
        text
    });
    let started = Instant::now();
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(_) => break false,
        }
    };
    (ok, reader.join().unwrap_or_default())
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

fn package() -> String {
    std::env::var("PROMPTURE_DESK_PACKAGE").ok().filter(|p| !p.trim().is_empty()).unwrap_or_else(|| PACKAGE.into())
}

/// uv links `cpython-3.12-…` to the patch release it downloads. Windows refuses
/// that junction on some PCs (os error 448, e.g. with OneDrive Files On-Demand),
/// after the download itself has landed.
fn link_refused(log: &str) -> bool {
    log.contains("minor version link") || log.contains("os error 448")
}

/// The Python uv downloaded into Desk's folder, by its real (patch) path, so
/// installing with it needs no junction.
fn downloaded_python(dir: &Path) -> Option<PathBuf> {
    let prefix = format!("cpython-{PYTHON}.");
    std::fs::read_dir(dir.join("python"))
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .map(|e| e.path().join(if cfg!(windows) { "python.exe" } else { "bin/python3" }))
        .filter(|p| p.is_file())
        .max()
}

/// Install (or reinstall) Desk's own Prompture.
async fn install_managed(uv: PathBuf, dir: PathBuf) -> Result<(), LocalError> {
    let pkg = package();
    let (ok, log) = tauri::async_runtime::spawn_blocking(move || {
        let install = |python: &str| {
            run(uv_command(&uv, &dir, &["tool", "install", "--force", "--python", python, &pkg]), SETUP_TIMEOUT)
        };
        let (ok, log) = install(PYTHON);
        match downloaded_python(&dir) {
            Some(python) if !ok && link_refused(&log) => install(&python.to_string_lossy()),
            _ => (ok, log),
        }
    })
    .await
    .unwrap_or((false, String::new()));
    if ok {
        return Ok(());
    }
    Err(LocalError::Failed(format!(
        "Couldn't set up Prompture. Check the internet connection and try again.\n{}",
        tail(&log, 4)
    )))
}

fn update_marker(dir: &Path) -> PathBuf {
    dir.join("last-update-check")
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// When Desk last tried to bring its copy up to [`MIN_PROMPTURE`].
fn minimum_marker(dir: &Path) -> PathBuf {
    dir.join("last-minimum-upgrade")
}

/// Whether bringing Desk's copy up to the minimum may be tried again (every six hours at most).
fn minimum_due(dir: &Path) -> bool {
    let last = std::fs::read_to_string(minimum_marker(dir)).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
    now_secs().saturating_sub(last) >= 6 * 60 * 60
}

fn update_due(dir: &Path) -> bool {
    let last = std::fs::read_to_string(update_marker(dir)).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
    now_secs().saturating_sub(last) >= UPDATE_EVERY.as_secs()
}

/// Upgrade Desk's own Prompture. Best effort: offline just keeps the current one.
/// Runs before the companion starts, since Windows can't replace a running executable.
async fn update_managed(uv: PathBuf, dir: PathBuf) {
    let _ = std::fs::write(update_marker(&dir), now_secs().to_string());
    let _ = tauri::async_runtime::spawn_blocking(move || {
        run(uv_command(&uv, &dir, &["tool", "upgrade", "prompture"]), UPDATE_TIMEOUT)
    })
    .await;
}

/// `uv tool upgrade prompture`, waited for; returns success and stderr.
async fn upgrade_blocking(uv: PathBuf, dir: PathBuf) -> (bool, String) {
    tauri::async_runtime::spawn_blocking(move || {
        run(uv_command(&uv, &dir, &["tool", "upgrade", "prompture"]), SETUP_TIMEOUT)
    })
    .await
    .unwrap_or((false, String::new()))
}

/// Start the companion from Desk's own Prompture, setting it up or updating it first.
async fn start_managed(http: &reqwest::Client, owner_pid: u32) -> Result<LocalState, LocalError> {
    let (Some(m), Some(uv)) = (MANAGED.get(), uv_path()) else {
        return Err(LocalError::NotInstalled("Prompture isn't installed on this PC (or not on PATH).".into()));
    };
    let bin = managed_bin(&m.dir);
    if !bin.is_file() {
        report(Some("Setting up Prompture — first run only, about a minute…"));
        install_managed(uv.clone(), m.dir.clone()).await?;
        let _ = std::fs::write(update_marker(&m.dir), now_secs().to_string());
    } else if UPDATE_MODE.load(Ordering::Relaxed) == MODE_AUTO && update_due(&m.dir) {
        report(Some("Checking for Prompture updates…"));
        update_managed(uv.clone(), m.dir.clone()).await;
    }
    report(Some("Starting Prompture…"));
    match start_first(http, vec![launcher(&bin, &[], owner_pid)]).await {
        // Too old for Desk even with updates off: the minimum isn't optional. Tried at most every
        // few hours, so a minimum PyPI doesn't have yet doesn't slow every start.
        Ok(state) if outdated(running_version(http).await.as_deref()) && minimum_due(&m.dir) => {
            let _ = std::fs::write(minimum_marker(&m.dir), now_secs().to_string());
            report(Some("Updating Prompture…"));
            stop_gracefully(http, &state).await;
            let _ = std::fs::write(update_marker(&m.dir), now_secs().to_string());
            let _ = upgrade_blocking(uv.clone(), m.dir.clone()).await;
            report(Some("Starting Prompture…"));
            let mut started = start_first(http, vec![launcher(&bin, &[], owner_pid)]).await;
            // `uv tool upgrade` keeps the first install's constraint, so it can stop short of
            // the minimum: reinstall with today's.
            if let Ok(state) = &started {
                if outdated(running_version(http).await.as_deref()) {
                    report(Some("Updating Prompture…"));
                    stop_gracefully(http, state).await;
                    let reinstalled = install_managed(uv, m.dir.clone()).await;
                    report(Some("Starting Prompture…"));
                    started = start_first(http, vec![launcher(&bin, &[], owner_pid)]).await;
                    if let (Err(e), Err(_)) = (reinstalled, &started) {
                        return Err(e);
                    }
                }
            }
            started.map_err(|e| {
                e.unwrap_or_else(|| LocalError::Failed("Prompture was updated but its companion didn't start.".into()))
            })
        }
        Ok(state) => Ok(state),
        // Our copy predates the companion (or is broken): reinstall once and retry.
        Err(_) => {
            report(Some("Updating Prompture…"));
            install_managed(uv, m.dir.clone()).await?;
            report(Some("Starting Prompture…"));
            start_first(http, vec![launcher(&bin, &[], owner_pid)]).await.map_err(|e| {
                e.unwrap_or_else(|| LocalError::Failed("Prompture was set up but its companion didn't start.".into()))
            })
        }
    }
}

/// A reachable local companion: the running one, or one started now.
pub async fn ensure(http: &reqwest::Client, owner_pid: u32) -> Result<LocalState, LocalError> {
    let _one_at_a_time = ENSURE.lock().await;
    if let Some(state) = read_state() {
        if reachable(http, &state).await {
            return Ok(state);
        }
    }
    let own = match start_first(http, launchers(owner_pid)).await {
        Ok(state) if !outdated(running_version(http).await.as_deref()) => {
            RUNNING_OWN.store(false, Ordering::Relaxed);
            return Ok(state);
        }
        // Started, but too old for what Desk shows: Desk's own, current copy takes over.
        Ok(state) => {
            stop_gracefully(http, &state).await;
            Some(LocalError::NeedsUpgrade(format!(
                "Prompture on this PC is older than {MIN_PROMPTURE}. Update it: pipx upgrade prompture (or pip install -U prompture)."
            )))
        }
        Err(problem) => problem,
    };
    let result = start_managed(http, owner_pid).await;
    RUNNING_OWN.store(result.is_ok(), Ordering::Relaxed);
    report(None);
    result.map_err(|managed| match (managed, own) {
        // Without a bundled uv, the user's own install is the more useful thing to report.
        (LocalError::NotInstalled(msg), None) => LocalError::NotInstalled(msg),
        (LocalError::NotInstalled(_), Some(own)) => own,
        (managed, _) => managed,
    })
}

// ------------------------------------------------------------------ updates

/// What the UI shows about the Prompture behind local mode.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PromptureStatus {
    /// "auto", "ask" or "off".
    pub mode: &'static str,
    /// "desk" (Desk's own copy, which Desk can upgrade) or "system" (one the
    /// user installed); `None` when no companion is running.
    pub source: Option<&'static str>,
    /// The running companion's Prompture version.
    pub version: Option<String>,
    /// The newest release on PyPI; `None` when updates are off or PyPI is unreachable.
    pub latest: Option<String>,
    pub update_available: bool,
    /// The oldest Prompture Desk works fully with ([`MIN_PROMPTURE`]).
    pub required: &'static str,
    /// The running companion is older than `required` (one the user installed and started).
    pub update_required: bool,
}

/// `MAJOR.MINOR.PATCH` as a comparable tuple, ignoring pre-release and build parts.
fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut it = core.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next().unwrap_or("0").parse().ok()?;
    let patch = it.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_semver(latest), parse_semver(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// Whether a companion reporting `version` is older than [`MIN_PROMPTURE`].
/// A source checkout (a local version like `1.9.2.dev0+gd6daa79`, or "0") is
/// whatever its code is, whatever its metadata says, so it never counts as old.
fn outdated(version: Option<&str>) -> bool {
    version.is_some_and(|v| {
        !v.contains('+') && parse_semver(v).is_some_and(|p| p != (0, 0, 0)) && is_newer(MIN_PROMPTURE, v)
    })
}

/// The newest Prompture on PyPI, cached for [`LATEST_TTL`].
async fn latest_version(http: &reqwest::Client, fresh: bool) -> Option<String> {
    if !fresh {
        if let Some((at, v)) = LATEST.lock().unwrap().clone() {
            if at.elapsed() < LATEST_TTL {
                return Some(v);
            }
        }
    }
    let body: serde_json::Value =
        http.get(PYPI_JSON).timeout(Duration::from_secs(8)).send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
    let version = body.get("info")?.get("version")?.as_str()?.to_string();
    *LATEST.lock().unwrap() = Some((Instant::now(), version.clone()));
    Some(version)
}

/// The running companion's version, without starting one.
async fn running_version(http: &reqwest::Client) -> Option<String> {
    let state = read_state()?;
    let info: serde_json::Value = http
        .get(format!("{}/v1/companion/info", state.url))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    info.get("version")?.as_str().map(str::to_string)
}

/// Where the local Prompture stands. `fresh` skips the PyPI cache (a manual check).
pub async fn status(http: &reqwest::Client, fresh: bool) -> PromptureStatus {
    let mode = UPDATE_MODE.load(Ordering::Relaxed);
    let version = running_version(http).await;
    let latest = if mode == MODE_OFF { None } else { latest_version(http, fresh).await };
    let update_available = matches!((&latest, &version), (Some(l), Some(v)) if is_newer(l, v));
    PromptureStatus {
        mode: match mode {
            MODE_ASK => "ask",
            MODE_OFF => "off",
            _ => "auto",
        },
        source: version.as_ref().map(|_| if RUNNING_OWN.load(Ordering::Relaxed) { "desk" } else { "system" }),
        update_required: outdated(version.as_deref()),
        required: MIN_PROMPTURE,
        version,
        latest,
        update_available,
    }
}

/// End a companion by pid, so its files can be replaced.
fn stop(pid: u32) {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("kill");
        c.arg(pid.to_string());
        c
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    no_window(&mut cmd);
    let _ = cmd.status();
}

/// Stop a companion so it can clean up after itself: routed CLIs are pointed
/// back at their vendors before it exits. Ends the process instead when it
/// doesn't answer (companions before 1.13.3 have no `/v1/shutdown`).
async fn stop_gracefully(http: &reqwest::Client, state: &LocalState) {
    let asked = http
        .post(format!("{}/v1/shutdown", state.url))
        .bearer_auth(&state.token)
        .json(&serde_json::json!({}))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success());
    if asked {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(8) {
            if !reachable(http, state).await {
                // A moment for the process to exit and let go of its files.
                tokio::time::sleep(Duration::from_millis(700)).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    if let Some(pid) = state.pid {
        let _ = tauri::async_runtime::spawn_blocking(move || stop(pid)).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Upgrade Desk's own Prompture now: stop its companion (Windows can't replace
/// a running executable), upgrade, and start it again.
pub async fn upgrade_now(http: &reqwest::Client, owner_pid: u32) -> Result<LocalState, LocalError> {
    let (Some(m), Some(uv)) = (MANAGED.get(), uv_path()) else {
        return Err(LocalError::Failed("Desk has no Prompture of its own to update.".into()));
    };
    if !managed_bin(&m.dir).is_file() {
        return Err(LocalError::Failed("Desk hasn't set up its own Prompture yet.".into()));
    }
    if !RUNNING_OWN.load(Ordering::Relaxed) && read_state().is_some() {
        return Err(LocalError::Failed(
            "The Prompture running now is one you installed. Update it with: pipx upgrade prompture (or pip install -U prompture).".into(),
        ));
    }
    {
        let _one_at_a_time = ENSURE.lock().await;
        report(Some("Updating Prompture…"));
        if let Some(state) = read_state() {
            stop_gracefully(http, &state).await;
        }
        let _ = std::fs::write(update_marker(&m.dir), now_secs().to_string());
        let (ok, log) = upgrade_blocking(uv.clone(), m.dir.clone()).await;
        // If the upgrade stops short of the minimum, the start below reinstalls right away.
        let _ = std::fs::remove_file(minimum_marker(&m.dir));
        *LATEST.lock().unwrap() = None;
        if !ok {
            report(None);
            // Bring the old version back up before reporting the failure.
            let _ = start_first(http, vec![launcher(managed_bin(&m.dir), &[], owner_pid)]).await;
            return Err(LocalError::Failed(format!("Couldn't update Prompture.\n{}", tail(&log, 4))));
        }
    }
    ensure(http, owner_pid).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_classification() {
        let old = "Usage: prompture [OPTIONS] COMMAND [ARGS]...\nError: No such command 'companion'.";
        assert!(matches!(classify_exit(old), Some(LocalError::NeedsUpgrade(_))));
        assert_eq!(classify_exit("'prompture' is not recognized as an internal or external command,"), None);
        assert_eq!(classify_exit("/usr/bin/python3: No module named prompture"), None);
        assert_eq!(classify_exit(""), None);
        assert!(matches!(classify_exit("Traceback...\nOSError: [Errno 98] Address in use"), Some(LocalError::Failed(m)) if m.contains("Address in use")));
    }

    #[test]
    fn state_file_parsing() {
        let s: LocalState = serde_json::from_str(r#"{"url": "http://127.0.0.1:5123", "token": "t", "pid": 7}"#).unwrap();
        assert_eq!(s, LocalState { url: "http://127.0.0.1:5123".into(), token: "t".into(), pid: Some(7) });
    }

    #[test]
    fn launchers_pass_the_owner_pid() {
        let cmds = launchers(4242);
        assert_eq!(cmds.len(), 3);
        let args: Vec<String> = cmds[0].get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.ends_with(&["companion".to_string(), "--exit-with-pid".to_string(), "4242".to_string()]));
    }

    #[test]
    fn uv_stays_inside_desks_folder() {
        let dir = Path::new("/data/desk/runtime");
        let cmd = uv_command(Path::new("uv"), dir, &["tool", "install", "prompture"]);
        let envs: Vec<(String, String)> = cmd
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
            .collect();
        for key in ["UV_TOOL_DIR", "UV_TOOL_BIN_DIR", "UV_PYTHON_INSTALL_DIR", "UV_CACHE_DIR"] {
            let (_, value) = envs.iter().find(|(k, _)| k == key).expect(key);
            assert!(Path::new(value).starts_with(dir), "{key} = {value}");
        }
        assert!(envs.contains(&("UV_PYTHON_PREFERENCE".into(), "only-managed".into())));
    }

    #[test]
    fn update_is_due_without_a_marker() {
        let dir = std::env::temp_dir().join(format!("desk-update-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(update_due(&dir));
        std::fs::write(update_marker(&dir), now_secs().to_string()).unwrap();
        assert!(!update_due(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn versions_compare_by_release() {
        assert!(is_newer("1.14.0", "1.13.2"));
        assert!(is_newer("1.13.10", "1.13.9"));
        assert!(!is_newer("1.13.2", "1.13.2"));
        assert!(!is_newer("1.13.2", "1.14.0.dev3+g1a2b3c"));
        assert!(!is_newer("garbage", "1.0.0"));
        assert_eq!(parse_semver("v2.0"), Some((2, 0, 0)));
    }

    #[test]
    fn companions_older_than_the_minimum_are_outdated() {
        assert!(outdated(Some("1.13.2")));
        assert!(outdated(Some("1.12.9")));
        assert!(!outdated(Some(MIN_PROMPTURE)));
        assert!(!outdated(Some("1.14.0")));
        assert!(!outdated(Some("1.14.0.dev3+g1a2b3c")));
        assert!(!outdated(Some("1.9.2.dev0+gd6daa79c8.d20260818"))); // a source checkout
        assert!(outdated(Some("1.13.3.dev2"))); // a published pre-release is compared
        assert!(!outdated(Some("0")));
        assert!(!outdated(None));
        assert!(!outdated(Some("garbage")));
    }

    #[test]
    fn update_mode_parses_with_auto_fallback() {
        set_update_mode("off");
        assert_eq!(UPDATE_MODE.load(Ordering::Relaxed), MODE_OFF);
        set_update_mode("nonsense");
        assert_eq!(UPDATE_MODE.load(Ordering::Relaxed), MODE_AUTO);
    }

    #[test]
    fn tail_keeps_the_last_lines() {
        assert_eq!(tail("a\n\nb\nc\nd\n", 2), "c\nd");
        assert_eq!(tail("only", 4), "only");
    }

    #[test]
    fn refused_link_falls_back_to_the_downloaded_python() {
        assert!(link_refused("error: Failed to create Python minor version link directory"));
        assert!(!link_refused("error: Failed to fetch: https://pypi.org"));

        let dir = std::env::temp_dir().join(format!("desk-py-{}", std::process::id()));
        let exe = if cfg!(windows) { "python.exe" } else { "bin/python3" };
        let real = dir.join("python").join(format!("cpython-{PYTHON}.14-windows-x86_64-none"));
        std::fs::create_dir_all(real.join(exe).parent().unwrap()).unwrap();
        std::fs::write(real.join(exe), "").unwrap();
        // The minor link itself (here a plain folder) is never picked.
        std::fs::create_dir_all(dir.join("python").join(format!("cpython-{PYTHON}-windows-x86_64-none"))).unwrap();
        assert_eq!(downloaded_python(&dir), Some(real.join(exe)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
