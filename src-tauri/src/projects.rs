//! Saved folders and external-terminal sessions. No command text comes from the UI.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub model: String,
    pub agent: String,
}

static PROJECT_LOCK: Mutex<()> = Mutex::new(());
static PYTHON: OnceLock<PathBuf> = OnceLock::new();
static SESSIONS: Mutex<Vec<Session>> = Mutex::new(Vec::new());
struct Session {
    id: String,
    project: String,
    model: String,
    agent: String,
    dir: PathBuf,
    child: Child,
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn read_projects(path: &Path) -> Result<Vec<Project>, String> {
    match std::fs::read(path) {
        Ok(data) => {
            serde_json::from_slice(&data).map_err(|e| format!("Could not read saved projects: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn write_projects(path: &Path, projects: &[Project]) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    let data = serde_json::to_vec_pretty(projects).map_err(|e| e.to_string())?;
    std::fs::write(&temp, data).map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<Project>, String> {
    let _guard = PROJECT_LOCK.lock().map_err(|e| e.to_string())?;
    read_projects(&root(&app)?.join("projects.json"))
}

fn validate(project: &Project) -> Result<(), String> {
    if project.name.trim().is_empty() || project.name.len() > 200 {
        return Err("Give the project a name (up to 200 characters).".into());
    }
    if !Path::new(&project.folder).is_absolute() || !Path::new(&project.folder).is_dir() {
        return Err("The project folder is missing. Choose an existing local folder.".into());
    }
    if !["claude-code", "codex"].contains(&project.agent.as_str()) {
        return Err("Choose a supported CLI agent.".into());
    }
    if project.model.len() > 300 || project.model.chars().any(char::is_control) {
        return Err("Invalid model name.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn save_project(app: AppHandle, mut project: Project) -> Result<Project, String> {
    project.name = project.name.trim().to_string();
    project.model = project.model.trim().to_string();
    validate(&project)?;
    let _guard = PROJECT_LOCK.lock().map_err(|e| e.to_string())?;
    let path = root(&app)?.join("projects.json");
    let mut projects = read_projects(&path)?;
    if project.id.is_empty() {
        project.id = uuid::Uuid::new_v4().to_string();
    }
    if let Some(saved) = projects.iter_mut().find(|p| p.id == project.id) {
        *saved = project.clone();
    } else {
        projects.push(project.clone());
    }
    write_projects(&path, &projects)?;
    Ok(project)
}

#[tauri::command]
pub fn remove_project(app: AppHandle, id: String) -> Result<(), String> {
    let _guard = PROJECT_LOCK.lock().map_err(|e| e.to_string())?;
    let path = root(&app)?.join("projects.json");
    let mut projects = read_projects(&path)?;
    projects.retain(|p| p.id != id);
    write_projects(&path, &projects)
}

fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn wait(child: &mut Child, timeout: Duration) -> Result<bool, String> {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(status.success());
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Prompture took too long to respond. Check the local runtime and retry.".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn python(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = PYTHON.get() {
        return Ok(path.clone());
    }
    let runtime = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime/tools/prompture");
    let mut candidates = vec![runtime.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    })];
    // Resolve PATH entries to absolute paths before changing to a project folder.
    // Never accidentally execute a python.exe supplied by that project.
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if !directory.is_absolute() {
            continue;
        }
        for name in if cfg!(windows) {
            vec!["python3.exe", "python.exe", "py.exe"]
        } else {
            vec!["python3", "python"]
        } {
            let path = directory.join(name);
            if path.is_file() && !candidates.contains(&path) {
                candidates.push(path);
            }
        }
    }
    for path in candidates {
        let mut cmd = Command::new(&path);
        cmd.args(["-I", "-c", "from prompture.companion.router import Router; from prompture.companion.server import CompanionServer; from prompture.infra.discovery import get_available_models"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        hidden(&mut cmd);
        if let Ok(mut child) = cmd.spawn() {
            if wait(&mut child, Duration::from_secs(10)).unwrap_or(false) {
                let _ = PYTHON.set(path.clone());
                return Ok(path);
            }
        }
    }
    Err("No compatible local Prompture Python runtime found. Set up or update local Prompture in Connection settings, then retry.".into())
}

fn helper(dir: &Path) -> Result<PathBuf, String> {
    let path = dir.join("project_session.py");
    std::fs::write(&path, include_str!("project_session.py")).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn project_catalog(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let python = python(&app)?;
        let dir = root(&app)?.join(format!("catalog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let result = (|| {
            let script = helper(&dir)?;
            let out = dir.join("output.txt");
            let mut cmd = Command::new(python);
            cmd.arg("-I")
                .arg(script)
                .arg("--catalog")
                .stdin(Stdio::null())
                .stdout(std::fs::File::create(&out).map_err(|e| e.to_string())?)
                .stderr(Stdio::null());
            hidden(&mut cmd);
            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            if !wait(&mut child, Duration::from_secs(60))? {
                return Err(
                    "Could not discover local models. Check your Prompture provider configuration."
                        .into(),
                );
            }
            let text = std::fs::read_to_string(out).map_err(|e| e.to_string())?;
            let data = text
                .lines()
                .find_map(|line| line.strip_prefix("DESK_CATALOG="))
                .ok_or("Prompture returned no model catalog.")?;
            serde_json::from_str(data).map_err(|e| e.to_string())
        })();
        let _ = std::fs::remove_dir_all(dir);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn launch_project(app: AppHandle, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = list_projects(app.clone())?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("Project not found.")?;
        validate(&project)?;
        if !project.model.contains('/') || project.model.ends_with('/') {
            return Err("Choose a normalized provider/model name.".into());
        }
        let python = python(&app)?;
        let session_id = uuid::Uuid::new_v4().to_string();
        let dir = root(&app)?.join(&session_id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let script = helper(&dir)?;
        std::fs::write(
            dir.join("launch.json"),
            serde_json::to_vec(&project).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let child = terminal(&python, &script, &dir, &project.folder)?;
        SESSIONS.lock().map_err(|e| e.to_string())?.push(Session {
            id: session_id.clone(),
            project: project.id,
            model: project.model,
            agent: project.agent,
            dir,
            child,
        });
        Ok(session_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn terminal(python: &Path, script: &Path, dir: &Path, folder: &str) -> Result<Child, String> {
    use std::os::windows::process::CommandExt;
    // An explicitly requested interactive window. Environment values are data,
    // not interpolated PowerShell source (including paths with $, quotes or &).
    Command::new("powershell.exe").args(["-NoLogo", "-NoProfile", "-NoExit", "-Command",
        "& $env:PROMPTURE_DESK_PYTHON -I $env:PROMPTURE_DESK_HELPER $env:PROMPTURE_DESK_SESSION"])
        .env("PROMPTURE_DESK_PYTHON", python).env("PROMPTURE_DESK_HELPER", script)
        .env("PROMPTURE_DESK_SESSION", dir).current_dir(folder)
        .creation_flags(0x0000_0010).spawn().map_err(|e| format!("Could not open PowerShell: {e}"))
}

#[cfg(not(windows))]
fn terminal(_python: &Path, _script: &Path, _dir: &Path, _folder: &str) -> Result<Child, String> {
    Err("Project terminal launching is currently available on Windows.".into())
}

#[tauri::command]
pub fn project_sessions() -> Result<Vec<Value>, String> {
    let mut sessions = SESSIONS.lock().map_err(|e| e.to_string())?;
    Ok(sessions.iter_mut().rev().map(|s| {
        let mut status: Value = std::fs::read(s.dir.join("status.json")).ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or(json!({"state": "starting"}));
        if s.child.try_wait().ok().flatten().is_some() && [Some("starting"), Some("running")].contains(&status["state"].as_str()) {
            status = json!({"state": "closed"});
        }
        json!({"id": s.id, "project": s.project, "model": s.model, "agent": s.agent, "status": status})
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_file_can_be_replaced_and_corruption_is_reported() {
        let dir = std::env::temp_dir().join(format!("desk-project-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("projects.json");
        assert!(read_projects(&path).unwrap().is_empty());
        write_projects(&path, &[]).unwrap();
        let p = Project {
            id: "one".into(),
            name: "A project".into(),
            folder: dir.to_string_lossy().into(),
            model: "ollama/model".into(),
            agent: "codex".into(),
        };
        write_projects(&path, &[p]).unwrap();
        assert_eq!(read_projects(&path).unwrap()[0].name, "A project");
        std::fs::write(&path, b"broken").unwrap();
        assert!(read_projects(&path).is_err());
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn validates_folders_agents_and_control_characters() {
        let mut p = Project {
            id: String::new(),
            name: "Project".into(),
            folder: std::env::current_dir().unwrap().to_string_lossy().into(),
            model: "ollama/qwen".into(),
            agent: "codex".into(),
        };
        assert!(validate(&p).is_ok());
        p.agent = "powershell; arbitrary command".into();
        assert!(validate(&p).is_err());
        p.agent = "codex".into();
        p.model = "ollama/model\ncommand".into();
        assert!(validate(&p).is_err());
        p.model.clear();
        p.folder = "relative".into();
        assert!(validate(&p).is_err());
    }
}
