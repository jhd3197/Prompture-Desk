// Automations: queue coding-agent steps (say, one GSD phase each) and the
// local companion runs them one after another — pre-moves for work that takes
// an hour a step. One page with three views: the list (what's running, past
// runs), a queue being built, and a queue's timeline.
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import {
  Check, CornerUpRight, FolderOpen, GripVertical, Pause, Play, Plus, RotateCw, Square, TriangleAlert, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Automation, type AutomationStep, type AutomationSummary, type LogLine, type NewAutomation, hub,
} from "../lib/hub";
import {
  type Segment, duration, isActive, isEnded, money, pauseLine, position, runSeconds, segments, stepSeconds,
} from "../lib/automations";
import type { DeskState } from "../lib/useDesk";

type View = { kind: "list" } | { kind: "new"; from?: Automation } | { kind: "run"; id: string };

type Draft = {
  cwd: string;
  agent: string;
  model: string;
  steps: Array<{ key: string; text: string; session: "same" | "new" }>;
  stop: { fail: boolean; ask: boolean; limit: boolean; cost: boolean; costUsd: number };
};

const MODELS: Record<string, string[]> = { claude: ["default", "opus", "sonnet", "haiku"], codex: ["default"] };
const DRAFT_KEY = "desk.automations.draft";
let keySeq = 0;
const newKey = () => `k${++keySeq}`;

function emptyDraft(): Draft {
  return { cwd: "", agent: "claude", model: "default", steps: [], stop: { fail: true, ask: true, limit: true, cost: false, costUsd: 10 } };
}

function loadDraft(): Draft {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    if (saved && typeof saved === "object") return { ...emptyDraft(), ...saved, steps: (saved.steps ?? []).map((s: Draft["steps"][0]) => ({ ...s, key: newKey() })) };
  } catch { /* storage may be unavailable */ }
  return emptyDraft();
}

function saveDraft(draft: Draft) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
}

function draftFrom(run: Automation): Draft {
  const cost = run.stop.cost_usd;
  return {
    cwd: run.cwd, agent: run.agent, model: run.model ?? "default",
    steps: run.steps.map(s => ({ key: newKey(), text: s.text, session: s.session })),
    stop: { fail: run.stop.fail, ask: run.stop.ask, limit: run.stop.limit, cost: cost != null, costUsd: cost ?? 10 },
  };
}

/** Re-render every second while something is running, for the timers. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/**
 * Drag-to-reorder with pointer events (the webview's file-drop handling
 * swallows HTML drag and drop). The order is local while dragging and
 * committed on release.
 */
function useReorder(keys: string[], commit: (order: string[]) => void) {
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const grip = (key: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(key);
      setOrder(keys);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!dragging || !order || !listRef.current) return;
      const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-row]"));
      const below = rows.findIndex(r => e.clientY < r.getBoundingClientRect().bottom);
      const to = below === -1 ? rows.length - 1 : below;
      const from = order.indexOf(dragging);
      if (to === from || to < 0) return;
      const next = [...order];
      next.splice(from, 1);
      next.splice(to, 0, dragging);
      setOrder(next);
    },
    onPointerUp: () => {
      if (order && order.join() !== keys.join()) commit(order);
      setDragging(null);
      setOrder(null);
    },
    onPointerCancel: () => { setDragging(null); setOrder(null); },
  });
  return { listRef, dragging, order: order ?? keys, grip };
}

/** Split pasted or typed text into steps, one per line. */
const lines = (text: string) => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

// ---------------------------------------------------------------- page

export function AutomationsPage({ d }: { d: DeskState }) {
  const a = d.automations;
  const current = a?.current ?? null;
  const [view, setView] = useState<View>(() => (isActive(current) ? { kind: "run", id: current!.id } : { kind: "list" }));
  // A queue that starts elsewhere (or before this page loaded) opens here.
  const activeId = isActive(current) ? current.id : null;
  useEffect(() => { if (activeId) setView(v => (v.kind === "list" ? { kind: "run", id: activeId } : v)); }, [activeId]);

  if (!d.caps.automations) {
    return <p className="d-empty">{d.mode === "hub" ? "Automations run with Prompture on this PC." : "Automations need a newer Prompture. Update it in Settings › About."}</p>;
  }
  if (!a) return <p className="d-empty">Loading…</p>;

  if (view.kind === "new") {
    return <Builder d={d} from={view.from} onCancel={() => setView({ kind: "list" })} onStarted={run => setView({ kind: "run", id: run.id })} />;
  }
  if (view.kind === "run") {
    return (
      <RunView d={d} id={view.id} onBack={() => setView({ kind: "list" })}
        onNew={from => setView({ kind: "new", from })} />
    );
  }
  return <List d={d} open={id => setView({ kind: "run", id })} create={from => setView({ kind: "new", from })} />;
}

// ---------------------------------------------------------------- list

const SEG_CLASS: Record<Segment, string> = {
  done: "done", skip: "skip", fail: "fail", wait: "wait", stop: "stop", run: "run", pause: "pause",
};

function Segments({ run, height = 6 }: { run: Pick<Automation, "status" | "current"> & { steps: Array<{ status: AutomationStep["status"] }> }; height?: number }) {
  const segs = segments(run as Automation);
  return (
    <div className="au-segs" style={{ height }}>
      {segs.map((s, i) => <span key={i} className={`au-seg ${SEG_CLASS[s]}`} />)}
    </div>
  );
}

type Filter = "all" | "finished" | "failed" | "stopped";

function when(epoch: number): string {
  const d = new Date(epoch * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function outcome(h: AutomationSummary): { icon: React.ReactNode; tone: string; text: string } {
  const skipped = h.steps.filter(s => s.status === "skipped").length;
  const failed = h.steps.filter(s => s.status === "failed").length;
  if (h.status === "finished") {
    const extra = [skipped && `${skipped} skipped`, failed && `${failed} failed`].filter(Boolean).join(" · ");
    return { icon: <Check size={14} />, tone: "ok", text: extra ? `Done · ${extra}` : "Done" };
  }
  if (h.status === "failed") return { icon: <X size={14} />, tone: "fail", text: h.last_error ? `Failed · ${h.last_error}` : "Failed" };
  return { icon: <Square size={11} />, tone: "muted", text: h.note ?? "Stopped by you" };
}

function List({ d, open, create }: { d: DeskState; open: (id: string) => void; create: (from?: Automation) => void }) {
  const a = d.automations!;
  const run = a.current;
  const live = isActive(run);
  const now = useNow(live);
  const [filter, setFilter] = useState<Filter>("all");
  const rows = a.history.filter(h => h.id !== (live ? run!.id : "") && (filter === "all" || h.status === filter));
  const counts = (k: Filter) => (k === "all" ? a.history.length : a.history.filter(h => h.status === k).length);
  const act = (action: "pause" | "resume") => hub.automationAction(action).then(d.setAutomation).catch(() => d.reloadAutomations());
  const again = (id: string) => hub.automationRun(id).then(create).catch(() => create());

  return (
    <div className="d-page au-page">
      <div className="au-bar">
        <span className="au-group">Now</span>
        <button className="s-btn primary" onClick={() => create()}><Plus size={14} aria-hidden /> New queue</button>
      </div>
      {live && run ? (
        <section className={`au-now ${run.status === "paused" ? "paused" : ""}`}>
          <div className="au-now-head">
            <StatusIcon run={run} />
            <div className="au-now-main">
              <span className="au-now-name">{run.project} · {run.agent_name}</span>
              <span className={`au-now-status ${run.status === "paused" ? (run.reason === "fail" ? "fail" : "warn") : ""}`}>
                {run.status === "paused" ? pauseLine(run) : run.pausing ? "Pauses after this step" : "Running"} · {run.steps[run.current]?.text}
              </span>
            </div>
            <span className="num au-stats">{position(run)} of {run.steps.length} · {duration(runSeconds(run, now))}{run.cost_usd ? ` · ${money(run.cost_usd)}` : ""}</span>
            {run.status === "running" && !run.pausing && <button className="s-btn" onClick={() => act("pause")}>Pause</button>}
            {(run.status === "paused" || run.pausing) && run.reason !== "ask" && <button className="s-btn" onClick={() => act("resume")}>Resume</button>}
            <button className="s-btn" onClick={() => open(run.id)}>Open</button>
          </div>
          <Segments run={run} />
        </section>
      ) : (
        <div className="au-nothing">
          <span>Nothing running</span>
          <button className="s-btn" onClick={() => create()}><Plus size={14} aria-hidden /> New queue</button>
        </div>
      )}

      <div className="au-bar">
        <span className="au-group">History</span>
        <div className="seg" role="radiogroup" aria-label="Filter">
          {([["all", "All"], ["finished", "Done"], ["failed", "Failed"], ["stopped", "Stopped"]] as Array<[Filter, string]>).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={filter === k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>
              {label} <span className="au-count">{counts(k)}</span>
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="d-empty">{a.history.length === 0 ? "No queues yet." : "Nothing here."}</p>
      ) : (
        <div className="au-table">
          <div className="au-hrow au-thead"><span /><span>Queue</span><span>Steps</span><span>Last step</span><span>When</span><span className="r">Time</span><span className="r">Cost</span><span /></div>
          {rows.map(h => {
            const o = outcome(h);
            const done = h.steps.filter(s => s.status === "done").length;
            return (
              <div key={h.id} className="au-hrow">
                <span className={`au-icon ${o.tone}`}>{o.icon}</span>
                <span className="au-cell2"><span className="ellipsis" title={h.cwd}>{h.project}</span><small>{h.agent_name}</small></span>
                <span className="au-cell2"><Segments run={h} height={4} /><small className="num">{done} of {h.steps.length}</small></span>
                <span className="au-cell2"><span className="mono ellipsis" title={h.last ?? ""}>{h.last}</span><small className={`ellipsis ${o.tone}`}>{o.text}</small></span>
                <small className="au-muted">{when(h.ended_at ?? h.created_at)}</small>
                <small className="num au-muted r">{duration(h.duration_s)}</small>
                <small className="num r">{money(h.cost_usd || null)}</small>
                <span className="au-actions">
                  <button className="s-btn sm" onClick={() => open(h.id)}>Open</button>
                  <button className="s-btn sm" title="Run again" aria-label="Run again" onClick={() => again(h.id)}><RotateCw size={12} /></button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ run }: { run: Automation }) {
  if (run.status === "paused") return <span className={`au-icon ${run.reason === "fail" ? "fail" : "warn"}`}>{run.reason === "fail" ? <X size={14} /> : <Pause size={14} />}</span>;
  return <span className="au-icon"><span className="au-pulse" /></span>;
}

// ---------------------------------------------------------------- builder

function Builder({ d, from, onCancel, onStarted }: {
  d: DeskState; from?: Automation; onCancel: () => void; onStarted: (run: Automation) => void;
}) {
  const a = d.automations!;
  const [draft, setDraft] = useState<Draft>(() => (from ? draftFrom(from) : loadDraft()));
  const [editing, setEditing] = useState<string | null>(null);
  const [roadmap, setRoadmap] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<Draft>) => setDraft(x => ({ ...x, ...patch }));
  useEffect(() => saveDraft(draft), [draft]);

  const recent = useMemo(() => [...new Set([draft.cwd, ...a.history.map(h => h.cwd)].filter(Boolean))], [a.history, draft.cwd]);
  const agents = a.agents;
  const models = MODELS[draft.agent] ?? ["default"];

  // The folder's unchecked roadmap phases, for "From roadmap".
  useEffect(() => {
    if (!draft.cwd) { setRoadmap([]); return; }
    const t = window.setTimeout(() => hub.roadmap(draft.cwd).then(r => setRoadmap(r.steps)).catch(() => setRoadmap([])), 300);
    return () => window.clearTimeout(t);
  }, [draft.cwd]);

  const addLines = (text: string) => {
    const add = lines(text);
    if (add.length) update({ steps: [...draft.steps, ...add.map(t => ({ key: newKey(), text: t, session: "same" as const }))] });
  };
  const fromRoadmap = () => {
    const have = new Set(draft.steps.map(s => s.text));
    addLines(roadmap.filter(t => !have.has(t)).join("\n"));
  };
  const addEmpty = () => {
    const key = newKey();
    update({ steps: [...draft.steps, { key, text: "", session: "same" }] });
    setEditing(key);
  };
  const commitEdit = (key: string, value: string) => {
    const v = value.trim();
    setEditing(null);
    update({ steps: v ? draft.steps.map(s => (s.key === key ? { ...s, text: v } : s)) : draft.steps.filter(s => s.key !== key) });
  };
  const reorder = useReorder(draft.steps.map(s => s.key), order =>
    update({ steps: order.map(k => draft.steps.find(s => s.key === k)!) }));
  const shown = reorder.order.map(k => draft.steps.find(s => s.key === k)!).filter(Boolean);

  const browse = async () => {
    const picked = await pickFolder({ directory: true, defaultPath: draft.cwd || undefined }).catch(() => null);
    if (typeof picked === "string") update({ cwd: picked });
  };

  const run = async () => {
    const steps = draft.steps.filter(s => s.text.trim());
    if (!draft.cwd || !steps.length) return;
    setBusy(true);
    setError(null);
    const body: NewAutomation = {
      cwd: draft.cwd, agent: draft.agent, model: draft.model === "default" ? null : draft.model,
      steps: steps.map(s => ({ text: s.text, session: s.session })),
      stop: { fail: draft.stop.fail, ask: draft.stop.ask, limit: draft.stop.limit, cost_usd: draft.stop.cost ? draft.stop.costUsd : null },
    };
    try {
      const started = await hub.startAutomation(body);
      d.setAutomation(started);
      d.reloadAutomations();
      onStarted(started);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  const stops: Array<[keyof Omit<Draft["stop"], "costUsd">, string, string?]> = [
    ["fail", "a step fails"], ["ask", "it asks me something"], ["limit", "plan limit is near", "→ wait for reset"], ["cost", "cost passes"],
  ];
  const ready = !!draft.cwd && draft.steps.some(s => s.text.trim());

  return (
    <div className="au-builder">
      <div className="au-scroll">
        <div className="au-form">
          <span className="au-label">Project</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="s-addr mono au-input" list="au-recent" value={draft.cwd} placeholder="C:\path\to\project"
              onChange={e => update({ cwd: e.target.value })} spellCheck={false} />
            <datalist id="au-recent">{recent.map(p => <option key={p} value={p} />)}</datalist>
            <button className="s-btn" onClick={browse}><FolderOpen size={14} aria-hidden /> Browse</button>
          </div>
          <span className="au-label">Agent</span>
          <div className="row" style={{ gap: 16 }}>
            <select className="au-select" value={draft.agent} onChange={e => update({ agent: e.target.value, model: "default" })}>
              {agents.map(x => <option key={x.id} value={x.id} disabled={!x.installed}>{x.name}{x.installed ? "" : " (not installed)"}</option>)}
            </select>
            <span className="au-label">Model</span>
            <select className="au-select" value={draft.model} onChange={e => update({ model: e.target.value })}>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        <div className="au-steps-head">
          <span className="s-field-title">Steps</span>
          <div className="row" style={{ gap: 8 }}>
            {roadmap.length > 0 && <button className="s-btn" onClick={fromRoadmap}>From roadmap</button>}
            <button className="s-btn" onClick={addEmpty}><Plus size={14} aria-hidden /> Add</button>
          </div>
        </div>
        {draft.steps.length === 0 ? (
          <div className="au-empty">
            <span>No steps yet</span>
            <div className="row" style={{ gap: 8 }}>
              {roadmap.length > 0 && <button className="s-btn" onClick={fromRoadmap}>From roadmap</button>}
              <button className="s-btn" onClick={addEmpty}><Plus size={14} aria-hidden /> Add</button>
            </div>
          </div>
        ) : (
          <div className="au-list" ref={reorder.listRef}>
            {shown.map((s, i) => (
              <div key={s.key} data-row className={`au-srow ${reorder.dragging === s.key ? "dragging" : ""}`}>
                <span className="s-grip" title="Drag to reorder" {...reorder.grip(s.key)}><GripVertical size={16} aria-hidden /></span>
                <span className="num au-idx">{i + 1}</span>
                {editing === s.key ? (
                  <input className="au-edit mono" autoFocus defaultValue={s.text} placeholder="Type a step…"
                    onBlur={e => commitEdit(s.key, e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }} />
                ) : (
                  <span className="mono ellipsis au-text" onClick={() => setEditing(s.key)} title="Click to edit">{s.text}</span>
                )}
                {i > 0 ? (
                  <button className="au-session" title="Continue the previous step's session, or start a fresh one"
                    onClick={() => update({ steps: draft.steps.map(x => (x.key === s.key ? { ...x, session: x.session === "new" ? "same" : "new" } : x)) })}>
                    {s.session === "new" ? "New session" : "Same session"}
                  </button>
                ) : <span />}
                <button className="au-x" aria-label="Remove step" onClick={() => update({ steps: draft.steps.filter(x => x.key !== s.key) })}><X size={14} /></button>
              </div>
            ))}
            <AddRow placeholder="Add a step, or paste several lines" onAdd={addLines} />
          </div>
        )}

        <div className="au-form top">
          <span className="au-label">Stop if</span>
          <div className="au-stops">
            {stops.map(([k, label, extra]) => (
              <label key={k} className="au-check">
                <input type="checkbox" checked={draft.stop[k]} onChange={e => update({ stop: { ...draft.stop, [k]: e.target.checked } })} />
                <span>{label}</span>
                {extra && <small>{extra}</small>}
                {k === "cost" && (
                  <span className="s-budget"><span className="s-budget-unit">$</span>
                    <input type="number" min={1} step={1} value={draft.stop.costUsd}
                      onChange={e => update({ stop: { ...draft.stop, costUsd: Math.max(1, Number(e.target.value) || 1), cost: true } })} />
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
      </div>
      <footer className="au-foot">
        <span className="au-warn"><TriangleAlert size={14} aria-hidden /> Runs without asking for permission</span>
        <span className="grow" />
        {error && <span className="s-error au-err">{error}</span>}
        <button className="s-btn ghost" onClick={onCancel}>Cancel</button>
        <button className="s-btn primary" disabled={!ready || busy} onClick={run}><Play size={14} aria-hidden /> Run</button>
      </footer>
    </div>
  );
}

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => void }) {
  return (
    <div className="au-srow au-addrow">
      <span /><span className="au-idx"><Plus size={14} aria-hidden /></span>
      <input className="au-add mono" placeholder={placeholder}
        onKeyDown={e => { if (e.key === "Enter") { onAdd(e.currentTarget.value); e.currentTarget.value = ""; } }}
        onPaste={e => {
          const text = e.clipboardData.getData("text");
          if (/\n/.test(text)) { e.preventDefault(); onAdd(text); }
        }} />
    </div>
  );
}

// ---------------------------------------------------------------- timeline

function RunView({ d, id, onBack, onNew }: { d: DeskState; id: string; onBack: () => void; onNew: (from?: Automation) => void }) {
  const current = d.automations?.current;
  const [past, setPast] = useState<Automation | null>(null);
  const isCurrent = current?.id === id;
  useEffect(() => {
    if (isCurrent) return;
    hub.automationRun(id).then(setPast).catch(() => onBack());
  }, [id, isCurrent]);
  const run = isCurrent ? current! : past;
  const live = isActive(run);
  const now = useNow(live);
  const [log, setLog] = useState<AutomationStep | null>(null);
  const [error, setError] = useState<string | null>(null);

  const take = useCallback((p: Promise<Automation>) => {
    setError(null);
    p.then(d.setAutomation).catch(e => { setError(String(e).replace(/^Error: /, "")); d.reloadAutomations(); });
  }, [d]);

  // Steps that haven't started can change while it runs.
  const firstWaiting = run ? run.current + (live ? 1 : 0) : 0;
  const waiting = run && live ? run.steps.slice(firstWaiting) : [];
  const putWaiting = (steps: Array<Pick<AutomationStep, "text" | "session"> & { id?: string }>) =>
    take(hub.setSteps(steps.map(s => ({ id: s.id, text: s.text, session: s.session }))));
  const reorder = useReorder(waiting.map(s => s.id), order =>
    putWaiting(order.map(k => waiting.find(s => s.id === k)!)));

  if (!run) return <p className="d-empty">Loading…</p>;
  const ended = isEnded(run);
  const segs = segments(run);
  const total = runSeconds(run, now);
  const doneCount = ended ? run.steps.filter(s => s.status === "done").length : position(run);
  const head = `${run.project} · ${run.agent_name}`;
  const title = run.status === "finished" ? `Queue finished · ${head}` : ended ? `Queue ${run.status === "failed" ? "failed" : "stopped"} · ${head}` : `Queue · ${head}`;
  const progress = ended ? (run.status === "finished" ? 1 : run.current / Math.max(1, run.steps.length))
    : (run.current + 0.5) / Math.max(1, run.steps.length);
  const tone = run.status === "paused" ? (run.reason === "fail" ? "fail" : "warn") : run.status === "failed" ? "fail" : run.status === "stopped" ? "stop" : "ok";
  const fixed = ended ? run.steps : run.steps.slice(0, firstWaiting);
  const shownWaiting = reorder.order.map(k => waiting.find(s => s.id === k)!).filter(Boolean);

  return (
    <div className="au-builder">
      <div className="au-tl-head">
        <div className="au-bar">
          <button className="d-link au-back" onClick={onBack}>Automations</button>
          <div className="row" style={{ gap: 8 }}>
            {live && run.status === "running" && !run.pausing && <button className="s-btn" onClick={() => take(hub.automationAction("pause"))}>Pause</button>}
            {live && (run.status === "paused" || run.pausing) && run.reason !== "ask" && run.reason !== "fail" &&
              <button className="s-btn" onClick={() => take(hub.automationAction("resume"))}>Resume</button>}
            {live && <button className="s-btn danger" onClick={() => take(hub.automationAction("stop"))}>Stop</button>}
            {ended && <button className="s-btn" onClick={() => onNew(run)}><RotateCw size={13} aria-hidden /> Run again</button>}
            {ended && <button className="s-btn primary" onClick={() => onNew()}><Plus size={14} aria-hidden /> New queue</button>}
          </div>
        </div>
        <span className="au-title">{title}</span>
        <div className="au-progress-row">
          <div className="au-progress"><span className={`tone-${tone}`} style={{ width: `${(progress * 100).toFixed(1)}%` }} /></div>
          <span className="num au-stats">{doneCount} of {run.steps.length} · {duration(total)}{run.cost_usd ? ` · ${money(run.cost_usd)}` : ""}</span>
        </div>
        {run.pausing && <span className="au-note warn">Pauses after this step</span>}
        {ended && run.note && <span className="au-note">{run.note}</span>}
        {error && <span className="s-error au-note">{error}</span>}
      </div>
      <div className="au-scroll au-tl">
        {fixed.map((s, i) => (
          <StepRow key={s.id} run={run} step={s} index={i} seg={segs[i]} now={now} take={take} onLog={() => setLog(s)} />
        ))}
        {live && (
          <div ref={reorder.listRef}>
            {shownWaiting.map(s => (
              <div key={s.id} data-row className={`au-trow ${reorder.dragging === s.id ? "dragging" : ""}`}>
                <div className="au-tline">
                  <span className="s-grip" title="Drag to reorder" {...reorder.grip(s.id)}><GripVertical size={16} aria-hidden /></span>
                  <span className="au-icon muted"><span className="au-ring" /></span>
                  <span className="mono ellipsis au-text waiting">{s.text}</span>
                  <span /><span />
                  <span className="au-actions">
                    <button className="au-x" aria-label="Remove step" onClick={() => putWaiting(waiting.filter(x => x.id !== s.id))}><X size={14} /></button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        {live && <AddRow placeholder="Add a step to the end of the queue" onAdd={text => putWaiting([...waiting, ...lines(text).map(t => ({ text: t, session: "same" as const }))])} />}
      </div>
      {log && <LogDrawer run={run} step={log} onClose={() => setLog(null)} />}
    </div>
  );
}

function StepRow({ run, step, index, seg, now, take, onLog }: {
  run: Automation; step: AutomationStep; index: number; seg: Segment; now: number;
  take: (p: Promise<Automation>) => void; onLog: () => void;
}) {
  const isCurrent = !isEnded(run) && index === run.current;
  const paused = isCurrent && run.status === "paused";
  const running = step.status === "running";
  const started = step.started_at != null || step.duration_s > 0;
  const icon = (() => {
    if (running) return <span className="au-icon"><span className="au-pulse" /></span>;
    if (paused && run.reason === "fail") return <span className="au-icon fail"><X size={14} /></span>;
    if (paused) return <span className="au-icon warn"><Pause size={14} /></span>;
    switch (seg) {
      case "done": return <span className="au-icon ok"><Check size={14} /></span>;
      case "skip": return <span className="au-icon muted"><CornerUpRight size={14} /></span>;
      case "fail": return <span className="au-icon fail"><X size={14} /></span>;
      case "stop": return <span className="au-icon muted"><Square size={11} /></span>;
      default: return <span className="au-icon muted"><span className="au-ring" /></span>;
    }
  })();
  const [answer, setAnswer] = useState("");
  const send = () => { if (answer.trim()) { take(hub.answer(answer.trim())); setAnswer(""); } };

  return (
    <div className={`au-trow ${isCurrent ? "current" : ""}`}>
      <div className="au-tline">
        <span />
        {icon}
        <span className={`mono ellipsis au-text ${step.status === "skipped" ? "skipped" : ""} ${step.status === "waiting" && !isCurrent ? "waiting" : ""}`} title={step.text}>{step.text}</span>
        <span className="num au-muted r">{started ? duration(stepSeconds(step, now)) : ""}</span>
        <span className="num r">{money(step.cost_usd)}</span>
        <span className="au-actions">
          {started && !(paused && run.reason === "fail") && <button className="s-btn sm" onClick={onLog}>Log</button>}
          {isCurrent && (running || (paused && run.reason !== "ask" && run.reason !== "fail")) &&
            <button className="s-btn sm" onClick={() => take(hub.automationAction("skip"))}>Skip</button>}
        </span>
      </div>
      {running && step.action && <div className="au-sub mono">└ {step.action}</div>}
      {paused && run.reason === "ask" && (
        <div className="au-ask">
          <span><b>Asks:</b> {run.question}</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="au-answer" placeholder="Type an answer…" value={answer} onChange={e => setAnswer(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") send(); }} autoFocus />
            <button className="s-btn primary" disabled={!answer.trim()} onClick={send}>Send</button>
            <button className="s-btn" title="Treat the step as done and go on" onClick={() => take(hub.automationAction("resume"))}>Continue</button>
          </div>
        </div>
      )}
      {paused && run.reason !== "ask" && (
        <div className="au-pline">
          <span className={run.reason === "fail" ? "fail" : "warn"}>{pauseLine(run)}</span>
          {run.reason === "limit" && <button className="s-btn sm" onClick={() => take(hub.automationAction("resume"))}>Resume now</button>}
          {run.reason === "fail" && <>
            <button className="s-btn sm" onClick={() => take(hub.automationAction("resume"))}>Retry</button>
            <button className="s-btn sm" onClick={() => take(hub.automationAction("skip"))}>Skip</button>
            <button className="s-btn sm" onClick={onLog}>Log</button>
          </>}
          {run.reason === "cost" && <button className="s-btn sm" onClick={() => take(hub.automationAction("resume"))}>Continue</button>}
          {run.reason === "manual" && <button className="s-btn sm" onClick={() => take(hub.automationAction("resume"))}>Resume</button>}
        </div>
      )}
    </div>
  );
}

function LogDrawer({ run, step, onClose }: { run: Automation; step: AutomationStep; onClose: () => void }) {
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const live = step.status === "running" || run.steps.find(s => s.id === step.id)?.status === "running";
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const load = () => hub.automationLog(run.id, step.id).then(r => { if (alive) setLines(r.lines); }).catch(() => undefined);
    load();
    if (!live) return () => { alive = false; };
    const t = window.setInterval(load, 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, [run.id, step.id, live]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [lines?.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const stamp = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  return (
    <>
      <div className="au-scrim" onClick={onClose} />
      <aside className="au-drawer">
        <header className="au-drawer-head">
          <div className="au-cell2"><small>Log</small><span className="mono ellipsis">{step.text}</span></div>
          <button className="s-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="au-log">
          {lines === null && <p className="d-empty">Loading…</p>}
          {lines?.length === 0 && <p className="d-empty">Nothing yet.</p>}
          {lines?.map((l, i) => (
            <div key={i} className={`au-logline ${l.kind}`}><span className="num">{stamp(l.t)}</span><span>{l.text}</span></div>
          ))}
          <div ref={endRef} />
        </div>
      </aside>
    </>
  );
}
