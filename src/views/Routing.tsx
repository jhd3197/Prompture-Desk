// Routing: Claude Code and Codex send their model calls through the local
// companion. Each call passes through to the vendor with the tool's own login
// unless a preset or a rule here sends it to another model.
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Segmented, Toggle } from "../components/ui";
import {
  type Preset, type RouteRules, type RouterState, type RouterTool, type Routes, type Spend, hub,
} from "../lib/hub";
import { AGENT_LOGO } from "../lib/model";
import { ProviderLogo } from "../lib/providers";
import { usePrompture } from "../lib/updater";

const TOOL_AGENT: Record<RouterTool["id"], string> = { "claude-code": "claude", codex: "codex" };
const VENDOR: Record<RouterTool["id"], string> = { "claude-code": "Anthropic", codex: "OpenAI" };
const MODEL_HINT: Record<RouterTool["id"], string> = { "claude-code": "claude-haiku-*", codex: "gpt-*-mini" };

const PRESET_NAMES: Record<Preset, string> = { quality: "Quality", balanced: "Balanced", economy: "Economy" };
/** Preset choices; "" = none here (the next level up decides). */
type PresetChoice = Preset | "";
const KIND_WORDS: Record<string, string> = {
  main: "turns", tool_result: "tool follow-ups", title: "titles", compaction: "summaries",
};
const TIER_WORDS: Record<string, string> = { small: "small model", mid: "mid model", large: "large model" };

/** "titles → small model · summaries → mid model", from a preset's kind map. */
function presetLine(kinds: Record<string, string> | undefined): string {
  const parts = Object.entries(kinds ?? {}).map(([kind, to]) => {
    const tier = to.startsWith("native:") ? to.slice(7) : to;
    return `${KIND_WORDS[kind] ?? kind} → ${TIER_WORDS[tier] ?? tier}`;
  });
  return parts.length ? parts.join(" · ") : "Every call keeps the model it asked for.";
}

type Rule = { pattern: string; target: string };

function toRules(r: RouteRules | undefined): { background: string; rules: Rule[] } {
  return {
    background: r?.kinds?.background ?? "",
    rules: Object.entries(r?.models ?? {}).map(([pattern, target]) => ({ pattern, target })),
  };
}

function fromRules(background: string, rules: Rule[], base: RouteRules | undefined): RouteRules {
  const models: Record<string, string> = {};
  for (const r of rules) if (r.pattern.trim() && r.target.trim()) models[r.pattern.trim()] = r.target.trim();
  const rest = Object.fromEntries(Object.entries(base?.kinds ?? {}).filter(([k]) => k !== "background"));
  const kinds = background.trim() ? { ...rest, background: background.trim() } : rest;
  return { ...(base?.preset ? { preset: base.preset } : {}), models, kinds };
}

function PresetSelect({ value, onChange, label, inherit }: {
  value: PresetChoice; onChange: (v: PresetChoice) => void; label: string; inherit: string;
}) {
  return (
    <select className="s-addr r-select" aria-label={label} value={value} onChange={e => onChange(e.target.value as PresetChoice)}>
      <option value="">{inherit}</option>
      {(Object.keys(PRESET_NAMES) as Preset[]).map(p => <option key={p} value={p}>{PRESET_NAMES[p]}</option>)}
    </select>
  );
}

function ToolRow({ tool, onChange }: { tool: RouterTool; onChange: (on: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const sub = !tool.installed ? "Not installed"
    : tool.routed ? "Through Prompture"
      : tool.enabled ? "Waiting for Prompture" : `Direct to ${VENDOR[tool.id]}`;
  return (
    <div className="r-tool">
      <ProviderLogo id={AGENT_LOGO[TOOL_AGENT[tool.id]]} size={24} />
      <div className="grow stack" style={{ gap: 2 }}>
        <span className="d-prov-name">{tool.name}</span>
        <span className="d-prov-sub" title={tool.routed ? tool.config : undefined}>{sub}</span>
      </div>
      <Toggle
        on={tool.enabled}
        label={`Route ${tool.name} through Prompture`}
        onChange={async v => { setBusy(true); try { await onChange(v); } finally { setBusy(false); } }}
      />
      {busy && <span className="spinner" aria-hidden />}
    </div>
  );
}

function RulesCard({
  tool, rules, models, onSave,
}: {
  tool: RouterTool;
  rules: RouteRules | undefined;
  models: string[];
  onSave: (r: RouteRules) => Promise<void>;
}) {
  const initial = useMemo(() => toRules(rules), [rules]);
  const [background, setBackground] = useState(initial.background);
  const [list, setList] = useState<Rule[]>(initial.rules);
  const [preset, setPreset] = useState<PresetChoice>(rules?.preset ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setBackground(initial.background); setList(initial.rules); setPreset(rules?.preset ?? ""); }, [initial, rules?.preset]);
  const next = { ...fromRules(background, list, { ...rules, preset: undefined }), ...(preset ? { preset } : {}) };
  const saved = { ...fromRules(initial.background, initial.rules, { ...rules, preset: undefined }), ...(rules?.preset ? { preset: rules.preset } : {}) };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  const listId = `r-models-${tool.id}`;
  const set = (i: number, patch: Partial<Rule>) => setList(l => l.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <section className="d-card">
      <header className="d-card-head">
        <h3>{tool.name}</h3>
        <button className="s-btn sm primary" disabled={!dirty || saving} onClick={async () => {
          setSaving(true);
          try { await onSave(next); } finally { setSaving(false); }
        }}>Save</button>
      </header>
      <datalist id={listId}>{models.map(m => <option key={m} value={m} />)}</datalist>
      <label className="r-line">
        <span className="r-label">Preset</span>
        <PresetSelect value={preset} onChange={setPreset} label={`${tool.name} preset`} inherit="Default" />
      </label>
      <label className="r-line">
        <span className="r-label">Background calls</span>
        <input
          className="s-addr mono r-input" list={listId} placeholder="Unchanged"
          value={background} onChange={e => setBackground(e.target.value)}
        />
      </label>
      <span className="d-prov-sub r-hint">Titles and summaries. Rules win over presets.</span>
      {list.map((r, i) => (
        <div key={i} className="r-line">
          <input
            className="s-addr mono r-input" placeholder={MODEL_HINT[tool.id]} aria-label="Requested model"
            value={r.pattern} onChange={e => set(i, { pattern: e.target.value })}
          />
          <span className="r-arrow">→</span>
          <input
            className="s-addr mono r-input" list={listId} placeholder="ollama/qwen3:8b" aria-label="Send to"
            value={r.target} onChange={e => set(i, { target: e.target.value })}
          />
          <button className="s-btn ghost sm" aria-label="Remove rule" onClick={() => setList(l => l.filter((_, j) => j !== i))}>
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
      <button className="s-btn ghost sm r-add" onClick={() => setList(l => [...l, { pattern: "", target: "" }])}>
        <Plus size={14} aria-hidden /> Model rule
      </button>
    </section>
  );
}

/** Per-project presets, for the projects Desk has seen calls from. */
function ProjectsCard({ routes, projects, onSave }: {
  routes: Routes; projects: string[]; onSave: (r: Routes) => Promise<void>;
}) {
  const names = [...new Set([...Object.keys(routes.projects ?? {}), ...projects])].sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return null;
  const setPreset = (name: string, preset: PresetChoice) => {
    const all = { ...(routes.projects ?? {}) };
    const entry = { ...(all[name] ?? {}) };
    if (preset) entry.preset = preset; else delete entry.preset;
    if (Object.keys(entry).length) all[name] = entry; else delete all[name];
    return onSave({ ...routes, projects: all });
  };
  return (
    <section className="d-card">
      <header className="d-card-head"><h3>Projects</h3></header>
      {names.map(name => (
        <div key={name} className="r-line">
          <span className="r-label ellipsis grow" title={name}>{name}</span>
          <PresetSelect
            value={routes.projects?.[name]?.preset ?? ""} label={`${name} preset`} inherit="Default"
            onChange={v => { void setPreset(name, v); }}
          />
        </div>
      ))}
    </section>
  );
}

/** Fallback models, escalation and the per-task budget. */
function LimitsCard({ state, models, onSave }: {
  state: RouterState; models: string[]; onSave: (r: Routes) => Promise<void>;
}) {
  const s = state.settings;
  const initial = useMemo(() => ({
    fallback: (s?.fallback.models ?? []).join(", "),
    allowPaid: !!s?.fallback.allow_paid,
    escalate: s?.escalation.enabled ?? true,
    failures: String(s?.escalation.after_failures ?? 3),
    usd: s?.budget.task_usd ? String(s.budget.task_usd) : "",
    attempts: String(s?.budget.task_attempts ?? 6),
  }), [s]);
  const [f, setF] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setF(initial), [initial]);
  if (!s) return null;
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const num = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
  const save = async () => {
    setSaving(true);
    try {
      const fallbackModels = f.fallback.split(",").map(m => m.trim()).filter(Boolean);
      const budget: Routes["budget"] = { task_attempts: num(f.attempts) ?? 6, on_exceed: s.budget.on_exceed };
      const usd = num(f.usd);
      if (usd && usd > 0) budget.task_usd = usd;
      await onSave({
        ...state.routes,
        fallback: { models: fallbackModels, allow_paid: f.allowPaid },
        escalation: { ...(state.routes.escalation ?? {}), enabled: f.escalate, after_failures: num(f.failures) ?? 3 },
        budget,
      });
    } finally { setSaving(false); }
  };
  return (
    <section className="d-card">
      <header className="d-card-head">
        <h3>When a call fails</h3>
        <button className="s-btn sm primary" disabled={!dirty || saving} onClick={save}>Save</button>
      </header>
      <datalist id="r-fallback-models">{models.map(m => <option key={m} value={m} />)}</datalist>
      <label className="r-line">
        <span className="r-label">Fallback models</span>
        <input className="s-addr mono r-input" list="r-fallback-models" placeholder="auto/cheap, ollama/qwen3:8b"
          value={f.fallback} onChange={e => setF({ ...f, fallback: e.target.value })} />
      </label>
      <div className="r-line">
        <span className="r-label grow">Plan calls may fall back to paid APIs</span>
        <Toggle on={f.allowPaid} label="Allow paid fallback for plan calls" onChange={v => setF({ ...f, allowPaid: v })} />
      </div>
      <div className="r-line">
        <span className="r-label grow">Escalate after failed tool results</span>
        <input className="s-addr num r-num" aria-label="Failed tool results before escalating" inputMode="numeric"
          value={f.failures} disabled={!f.escalate} onChange={e => setF({ ...f, failures: e.target.value })} />
        <Toggle on={f.escalate} label="Escalate tasks that keep failing" onChange={v => setF({ ...f, escalate: v })} />
      </div>
      <div className="r-line">
        <span className="r-label grow">Per task</span>
        <input className="s-addr num r-num" aria-label="Most attempts per task" inputMode="numeric"
          value={f.attempts} onChange={e => setF({ ...f, attempts: e.target.value })} />
        <span className="d-prov-sub">attempts</span>
        <input className="s-addr num r-num" aria-label="Most routed spend per task, in dollars" inputMode="decimal" placeholder="no cap"
          value={f.usd} onChange={e => setF({ ...f, usd: e.target.value })} />
        <span className="d-prov-sub">USD</span>
      </div>
      <span className="d-prov-sub r-hint">The vendor's own model is always the last fallback.</span>
    </section>
  );
}

/** Shown while the companion has no router: an older Prompture, or none yet. */
function NeedsPrompture({ statusKey }: { statusKey: unknown }) {
  const p = usePrompture(true, statusKey);
  const st = p.status;
  const need = `Routing needs Prompture ${st?.required ?? ""}+.`.replace(" +.", ".");
  return (
    <div className="d-empty stack" style={{ gap: 8, alignItems: "flex-start" }}>
      <span>{st?.version ? `${need} This PC runs ${st.version}.` : need}</span>
      {st?.source === "system" && <span className="mono">pipx upgrade prompture</span>}
      {st?.source === "desk" && (
        <button className="s-btn sm primary" disabled={!!p.busy} onClick={p.update}>
          {p.busy === "updating" ? "Updating…" : "Update now"}
        </button>
      )}
      {p.error && <span className="s-error" style={{ whiteSpace: "pre-wrap" }}>{p.error}</span>}
    </div>
  );
}

export function RoutingView({ enabled, spend, statusKey }: { enabled: boolean; spend: Spend | null; statusKey?: unknown }) {
  const [state, setState] = useState<RouterState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => hub.router().then(s => { if (live) { setState(s); setError(null); } }).catch(e => { if (live) setError(String(e)); });
    load();
    const timer = window.setInterval(load, 10_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [enabled]);

  // Models seen today, as suggestions for where to send calls.
  const models = useMemo(() => [...new Set(["passthrough", "auto/cheap", ...(spend?.by_model.map(m => m.model) ?? [])])], [spend]);
  const projects = useMemo(() => (spend?.by_project ?? []).map(p => p.project).filter((p): p is string => !!p), [spend]);

  if (!enabled) return <NeedsPrompture statusKey={statusKey} />;
  if (!state) return <p className="d-empty">{error ?? "Loading…"}</p>;

  const run = async (fn: () => Promise<RouterState>) => {
    setError(null);
    try { setState(await fn()); } catch (e) { setError(String(e).replace(/^Error:\s*/, "")); }
  };
  const save = (routes: Routes) => run(() => hub.saveRoutes(routes));
  const on = state.tools.filter(t => t.enabled);
  const claude = state.tools.find(t => t.id === "claude-code");
  const preset = state.routes.preset ?? "";

  return (
    <div className="d-page">
      <section className="d-card">
        <header className="d-card-head"><h3>Route through Prompture</h3></header>
        {state.tools.map(t => (
          <ToolRow key={t.id} tool={t} onChange={v => run(() => hub.setRouting(t.id, v))} />
        ))}
        <span className="d-prov-sub r-hint">Keeps each tool's login. Undone when Desk quits.</span>
        {error && <span className="s-error" style={{ fontSize: 12 }}>{error}</span>}
      </section>

      {on.length > 0 && state.presets && (
        <section className="d-card">
          <header className="d-card-head"><h3>Preset</h3></header>
          <Segmented<PresetChoice>
            label="Default preset" value={preset}
            options={[["", "Off"], ["quality", "Quality"], ["balanced", "Balanced"], ["economy", "Economy"]]}
            onChange={v => { void save({ ...state.routes, preset: v || undefined }); }}
          />
          <span className="d-prov-sub">{preset ? presetLine(state.presets[preset]) : "Nothing changes unless a rule says so."}</span>
          <span className="d-prov-sub">Same login, smaller models. Applies from the next prompt.</span>
        </section>
      )}

      {on.map(t => (
        <RulesCard
          key={t.id} tool={t} rules={state.routes.tools[t.id]} models={models}
          onSave={r => save({ ...state.routes, tools: { ...state.routes.tools, [t.id]: r } })}
        />
      ))}

      {on.length > 0 && state.presets && <ProjectsCard routes={state.routes} projects={projects} onSave={save} />}
      {on.length > 0 && <LimitsCard state={state} models={models} onSave={save} />}

      {claude?.installed && (
        <section className="d-card">
          <div className="row between" style={{ gap: 16 }}>
            <div className="stack" style={{ gap: 4 }}>
              <span className="d-prov-name">Show when Claude Code needs you</span>
              <span className="d-prov-sub">Adds hooks to Claude Code's settings.</span>
            </div>
            <Toggle on={state.hooks.claude} label="Claude Code hooks" onChange={v => run(() => hub.setAgentHooks(v))} />
          </div>
        </section>
      )}
    </div>
  );
}
