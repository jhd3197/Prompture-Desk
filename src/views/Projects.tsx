import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { projects, type Project, type ProjectCatalog, type ProjectSession } from "../lib/projects";
import { AgentLogo } from "./Tools";

const AGENTS = [{ id: "claude-code", name: "Claude Code" }, { id: "codex", name: "Codex CLI" }];

export function ProjectsView() {
  const [list, setList] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [sessions, setSessions] = useState<ProjectSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function discover() {
    setLoading(true); setCatalogError("");
    try { setCatalog(await projects.catalog()); }
    catch (e) { setCatalogError(String(e)); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let alive = true;
    projects.list().then(items => { if (alive) { setList(items); setSelected(items[0] ?? null); } }).catch(e => { if (alive) setError(String(e)); });
    void discover();
    const poll = () => projects.sessions().then(items => { if (alive) setSessions(items); }).catch(e => { if (alive) setError(String(e)); });
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  function choose(project: Project) {
    setSelected(project); setError(""); setNotice(""); setRemoving(false);
  }

  async function add() {
    setBusy(true); setError("");
    try {
      const folder = await open({ directory: true, multiple: false, title: "Choose a project folder" });
      if (typeof folder !== "string") return;
      const existing = list.find(p => p.folder.toLowerCase() === folder.toLowerCase());
      if (existing) { choose(existing); return; }
      const saved = await projects.save({ id: "", name: folder.split(/[\\/]/).filter(Boolean).pop() || "Project", folder, model: "", agent: "claude-code" });
      setList(items => [...items, saved]); choose(saved);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  async function save(launch = false) {
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await projects.save(selected);
      setList(items => items.map(p => p.id === saved.id ? saved : p)); setSelected(saved);
      if (launch) {
        await projects.launch(saved.id);
        setSessions(await projects.sessions());
        setNotice("Terminal opened. Session startup is shown below.");
      } else setNotice("Project defaults saved.");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  const model = catalog?.models.find(m => m.id === selected?.model.trim());
  const agent = catalog?.agents.find(a => a.id === selected?.agent);
  const blocked = model?.tools === false;
  const dirty = selected && JSON.stringify(selected) !== JSON.stringify(list.find(p => p.id === selected.id));
  const patch = (value: Partial<Project>) => { if (selected) { setSelected({ ...selected, ...value }); setNotice(""); } };

  return <div className="d-view p-page">
    <div className="row between">
      <span className="s-muted">Launch an agent CLI in a saved folder.</span>
      <button className="s-btn primary" disabled={busy} onClick={add}><Plus size={14} /> Add project</button>
    </div>
    {error && <p className="s-error" role="alert">{error}</p>}
    <div className="p-layout">
      <nav className="p-folders" aria-label="Saved projects">
        {list.map(p => <button key={p.id} className={`p-folder ${selected?.id === p.id ? "active" : ""}`} disabled={busy}
          onClick={() => choose(p)} aria-current={selected?.id === p.id ? "page" : undefined}>
          <FolderOpen size={17} /><span><strong>{p.name}</strong><small>{p.model || "Choose a model"}</small></span>
        </button>)}
        {!list.length && <p className="d-empty">Your project folders will appear here.</p>}
      </nav>
      {selected ? <div className="p-workspace">
        <section className="d-card p-launcher">
          <div className="row between"><h3>{selected.name}</h3><button className="s-btn ghost sm" aria-label="Remove project" disabled={busy} onClick={() => setRemoving(!removing)}><Trash2 size={14} /></button></div>
          <p className="mono p-path" title={selected.folder}>{selected.folder}</p>
          {removing && <div className="p-remove"><span>Remove this saved project? Its folder and terminals stay open.</span>
            <button className="s-btn sm" disabled={busy} onClick={async () => {
              setBusy(true); setError("");
              try { await projects.remove(selected.id); const next = list.filter(p => p.id !== selected.id); setList(next); setSelected(next[0] ?? null); setRemoving(false); }
              catch (e) { setError(String(e)); } finally { setBusy(false); }
            }}>Remove</button><button className="s-btn ghost sm" onClick={() => setRemoving(false)}>Cancel</button></div>}
          <label className="p-field">Project name<input className="s-addr" value={selected.name} disabled={busy} onChange={e => patch({ name: e.target.value })} /></label>
          <label className="p-field">Model<input className="s-addr mono" list="project-models" placeholder="provider/model" value={selected.model} disabled={busy}
            onChange={e => patch({ model: e.target.value })} aria-describedby="project-model-help" /></label>
          <datalist id="project-models">{catalog?.models.map(m => <option key={m.id} value={m.id}>{m.tools === false ? "No tool support" : ""}</option>)}</datalist>
          <div className="row between"><small id="project-model-help" className={blocked ? "s-error" : "s-muted"}>
            {blocked ? "This model cannot call tools. Choose another model." : model?.tools === true ? "Tool support reported. Agent compatibility depends on the model." : "Compatibility unverified. Use a model that supports tool calling."}
          </small><button className="s-btn ghost sm" disabled={loading || busy} onClick={discover} aria-label="Refresh models"><RefreshCw size={13} />{loading ? "Loading…" : "Refresh"}</button></div>
          {catalogError && <p className="s-error" role="alert">{catalogError}</p>}
          <fieldset className="p-agents" disabled={busy}><legend>Agent</legend>{AGENTS.map(a => {
            const installed = catalog?.agents.find(item => item.id === a.id)?.installed;
            return <label className={`p-agent ${selected.agent === a.id ? "active" : ""}`} key={a.id}>
              <input type="radio" name="project-agent" value={a.id} checked={selected.agent === a.id} disabled={installed === false || blocked} onChange={() => patch({ agent: a.id })} />
              <AgentLogo id={a.id === "claude-code" ? "claude" : a.id} /><span>{a.name}<small>{installed === false ? "Not on PATH" : installed ? "Installed" : "Availability unverified"}</small></span>
            </label>;
          })}</fieldset>
          <div className="p-actions"><button className="s-btn primary" disabled={busy || loading || blocked || agent?.installed === false || !selected.model.trim() || !selected.name.trim()} onClick={() => save(true)}><Play size={14} />{busy ? "Working…" : "Launch in terminal"}</button>
            <button className="s-btn" disabled={busy || !dirty} onClick={() => save()}>Save defaults</button></div>
          <p className="s-muted p-note">Windows PowerShell opens in this folder. Each terminal keeps its selected model. Close the terminal to end its session.</p>
          {notice && <p role="status" className="s-muted">{notice}</p>}
        </section>
        <section className="d-card p-history"><h3>Sessions opened from Desk</h3>
          {sessions.filter(s => s.project === selected.id).map(s => <div className="p-session" key={s.id}>
            <AgentLogo id={s.agent === "claude-code" ? "claude" : s.agent} size={18} /><div className="grow"><span className="mono">{s.model}</span>
              {s.status.error && <p className="s-error" role="alert">{s.status.error}</p>}</div>
            <span className="d-tag">{s.status.state === "exited" && s.status.exit_code ? `Exited (${s.status.exit_code})` : s.status.state}</span>
          </div>)}
          {!sessions.some(s => s.project === selected.id) && <p className="d-empty">No terminals launched for this project during this Desk run.</p>}
        </section>
      </div> : <section className="d-card p-empty"><FolderOpen size={32} strokeWidth={1.3} /><h3>Start with a project folder</h3><p>Choose a folder, select a model and agent, then launch.</p><button className="s-btn" onClick={add} disabled={busy}>Choose folder</button></section>}
    </div>
  </div>;
}
