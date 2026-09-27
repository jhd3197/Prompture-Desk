// Memory: notes coding agents share per project (decisions, conventions,
// commands, verified fixes), what each session was given, and workflows that
// recur often enough to become skills.
import { Check, Pin, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Toggle, ago } from "../components/ui";
import {
  type MemoryInjection, type MemoryNote, type MemoryOverview, type MemoryProject, type NoteKind, type SkillIdea, hub,
} from "../lib/hub";

const KINDS: Array<[NoteKind, string]> = [
  ["fix", "Fix"], ["command", "Command"], ["convention", "Convention"], ["decision", "Decision"], ["fact", "Fact"],
];
const WHO: Record<string, string> = { claude: "Claude Code", codex: "Codex", you: "You" };

const clean = (e: unknown) => String(e).replace(/^Error:\s*/, "");
const when = (ts: number) => ago(new Date(ts * 1000).toISOString());

function NoteRow({ note, onChange, onDelete }: {
  note: MemoryNote; onChange: (c: Partial<MemoryNote>) => Promise<void>; onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.content);
  const [source, setSource] = useState(note.source ?? "");
  useEffect(() => { setText(note.content); setSource(note.source ?? ""); }, [note.content, note.source]);
  return (
    <div className="m-note">
      <span className="d-tag">{note.kind}</span>
      {editing ? (
        <div className="stack grow" style={{ gap: 6 }}>
          <textarea className="s-addr m-text" rows={2} value={text} onChange={e => setText(e.target.value)} aria-label="Note" />
          <input className="s-addr mono r-input" placeholder="Source (file:line)" value={source} onChange={e => setSource(e.target.value)} />
          <span className="row" style={{ gap: 6 }}>
            <button className="s-btn sm primary" disabled={!text.trim()} onClick={async () => {
              await onChange({ content: text, source });
              setEditing(false);
            }}>Save</button>
            <button className="s-btn sm ghost" onClick={() => setEditing(false)}>Cancel</button>
          </span>
        </div>
      ) : (
        <button className="m-note-body grow" onClick={() => setEditing(true)} title="Edit">
          <span>{note.content}</span>
          <span className="d-prov-sub">
            {[note.source, WHO[note.agent ?? ""] ?? note.agent, when(note.updated)].filter(Boolean).join(" · ")}
          </span>
        </button>
      )}
      <button className={`m-icon ${note.verified ? "on" : ""}`} aria-pressed={note.verified}
        title={note.verified ? "Verified: shared with sessions" : "Not verified: kept back"}
        onClick={() => onChange({ verified: !note.verified })}><Check size={14} aria-hidden /></button>
      <button className={`m-icon ${note.pinned ? "on" : ""}`} aria-pressed={note.pinned}
        title={note.pinned ? "Pinned: every session gets it" : "Pin for every session"}
        onClick={() => onChange({ pinned: !note.pinned })}><Pin size={14} aria-hidden /></button>
      <button className="m-icon" title="Delete" onClick={onDelete}><Trash2 size={14} aria-hidden /></button>
    </div>
  );
}

function AddNote({ onAdd }: { onAdd: (n: { kind: NoteKind; content: string; source: string; verified: boolean }) => Promise<void> }) {
  const [kind, setKind] = useState<NoteKind>("fix");
  const [content, setContent] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="r-line" style={{ marginTop: 0 }}>
        <select className="s-addr r-select" aria-label="Kind" value={kind} onChange={e => setKind(e.target.value as NoteKind)}>
          {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <input className="s-addr r-input" placeholder="What agents should know" value={content} onChange={e => setContent(e.target.value)} />
      </div>
      <div className="r-line" style={{ marginTop: 0 }}>
        <input className="s-addr mono r-input" placeholder="Source (file:line), optional" value={source} onChange={e => setSource(e.target.value)} />
        <button className="s-btn sm primary" disabled={!content.trim() || busy} onClick={async () => {
          setBusy(true);
          try { await onAdd({ kind, content, source, verified: true }); setContent(""); setSource(""); } finally { setBusy(false); }
        }}><Plus size={14} aria-hidden /> Add</button>
      </div>
    </div>
  );
}

function Given({ items, notes }: { items: MemoryInjection[]; notes: MemoryNote[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return <p className="d-empty">No session has been given notes yet.</p>;
  return (
    <>
      {items.map(i => (
        <div key={i.id} className="sv-call-wrap">
          <button className={`sv-call m-given ${open === i.id ? "open" : ""}`} onClick={() => setOpen(o => (o === i.id ? null : i.id))}>
            <span className="d-prov-name">{WHO[i.agent] ?? i.agent}</span>
            <span className="d-call-sub ellipsis">
              {i.fact_ids.length} note{i.fact_ids.length === 1 ? "" : "s"} · {i.tokens} tokens · {i.via === "hook" ? "hook" : "router"}
            </span>
            <span className="d-call-ago">{when(i.ts)}</span>
          </button>
          {open === i.id && (
            <div className="sv-detail">
              <div className="sv-kv"><span>Session</span><span className="mono">{i.session}</span></div>
              {i.fact_ids.some(id => !notes.find(n => n.id === id)) && (
                <div className="sv-kv"><span>Note</span><span>Some of these notes were edited or deleted since.</span></div>
              )}
              <pre className="m-given-text mono">{i.text}</pre>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function Skills({ project, skills, folder, onSaved }: { project: string; skills: SkillIdea[]; folder: string | null; onSaved: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (skills.length === 0) return <p className="d-empty">No workflow has repeated enough yet.</p>;
  return (
    <>
      {error && <span className="s-error">{error}</span>}
      {skills.map(s => (
        <div key={s.name} className="sv-call-wrap">
          <div className="m-skill">
            <button className="m-note-body grow" onClick={() => setOpen(o => (o === s.name ? null : s.name))}>
              <span className="mono">{s.name}</span>
              <span className="d-prov-sub ellipsis">{s.steps.join(" → ")} · seen {s.occurrences}×</span>
            </button>
            {s.saved ? <span className="d-tag">saved</span> : (
              <button className="s-btn sm" disabled={!folder} title={folder ? `Save to ${folder}/.claude/skills` : "Folder not known yet"}
                onClick={async () => {
                  setError(null);
                  try { await hub.saveSkill(project, s.name); onSaved(); } catch (e) { setError(clean(e)); }
                }}>Save as skill</button>
            )}
          </div>
          {open === s.name && <pre className="m-given-text mono">{s.markdown}</pre>}
        </div>
      ))}
    </>
  );
}

export function MemoryView({ enabled }: { enabled: boolean }) {
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [data, setData] = useState<MemoryProject | null>(null);
  const [hooks, setHooks] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(() => {
    hub.memory().then(o => {
      setOverview(o);
      setProject(p => p ?? o.projects[0]?.project ?? null);
    }).catch(e => setError(clean(e)));
    hub.router().then(r => setHooks(r.hooks.claude)).catch(() => undefined);
  }, []);
  const loadProject = useCallback(() => {
    if (project) hub.memoryProject(project).then(setData).catch(e => setError(clean(e)));
  }, [project]);
  useEffect(() => { if (enabled) loadOverview(); }, [enabled, loadOverview]);
  useEffect(() => {
    loadProject();
    const t = window.setInterval(loadProject, 10_000);
    return () => window.clearInterval(t);
  }, [loadProject]);

  if (!enabled) return <p className="d-empty">Memory needs routing, on Prompture on this PC.</p>;
  if (!overview) return <p className="d-empty">{error ?? "Loading…"}</p>;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); loadProject(); loadOverview(); } catch (e) { setError(clean(e)); }
  };
  const s = overview.settings;
  const setSetting = (patch: Partial<typeof s>) => run(() => hub.memorySettings(patch));

  return (
    <div className="d-page">
      <section className="d-card">
        <div className="row between" style={{ gap: 16 }}>
          <div className="stack" style={{ gap: 4 }}>
            <span className="d-prov-name">Give sessions their project's notes</span>
            <span className="d-prov-sub">Once per session, only what fits the first prompt.</span>
          </div>
          <Toggle on={s.enabled} label="Project notes" onChange={v => setSetting({ enabled: v })} />
        </div>
        {s.enabled && (
          <div className="r-line">
            <span className="r-label grow">Up to</span>
            <input className="s-addr num r-num" aria-label="Most tokens of notes per session" inputMode="numeric"
              defaultValue={s.budget_tokens} key={s.budget_tokens}
              onBlur={e => { const n = parseInt(e.target.value, 10); if (n && n !== s.budget_tokens) void setSetting({ budget_tokens: n }); }} />
            <span className="d-prov-sub">tokens</span>
          </div>
        )}
        {s.enabled && hooks === false && (
          <span className="d-prov-sub">Claude Code gets notes through its hooks: turn on "Show when Claude Code needs you" in Routing.</span>
        )}
        {error && <span className="s-error">{error}</span>}
      </section>

      {overview.projects.length === 0 ? (
        <p className="d-empty">No projects yet. Notes appear as agents work, or add one with <code className="mono">prompture memory add</code>.</p>
      ) : (
        <>
          <select className="s-addr r-select" aria-label="Project" value={project ?? ""} onChange={e => setProject(e.target.value)}>
            {overview.projects.map(p => (
              <option key={p.project} value={p.project}>{p.project}{p.facts ? ` (${p.facts})` : ""}</option>
            ))}
          </select>
          {data && data.project === project && (
            <>
              <section className="d-card">
                <header className="d-card-head"><h3>Notes</h3></header>
                {data.facts.length === 0 && <p className="d-empty">No notes for {data.project} yet.</p>}
                {data.facts.map(n => (
                  <NoteRow key={n.id} note={n}
                    onChange={c => run(() => hub.editNote(data.project, n.id, c))}
                    onDelete={() => run(() => hub.deleteNote(data.project, n.id))} />
                ))}
                <AddNote onAdd={n => run(() => hub.addNote(data.project, n))} />
              </section>
              <section className="d-card">
                <header className="d-card-head"><h3>Given to sessions</h3></header>
                <Given items={data.injections} notes={data.facts} />
              </section>
              <section className="d-card">
                <header className="d-card-head"><h3>Skill ideas</h3></header>
                <Skills project={data.project} skills={data.skills} folder={data.folder} onSaved={loadProject} />
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
