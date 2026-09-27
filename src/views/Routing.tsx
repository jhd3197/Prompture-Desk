// Routing: Claude Code and Codex send their model calls through the local
// companion. Each call passes through to the vendor with the tool's own login
// unless a rule here sends it to a Prompture model instead.
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Toggle } from "../components/ui";
import { type RouteRules, type RouterState, type RouterTool, type Spend, hub } from "../lib/hub";
import { AGENT_LOGO } from "../lib/model";
import { ProviderLogo } from "../lib/providers";
import { usePrompture } from "../lib/updater";

const TOOL_AGENT: Record<RouterTool["id"], string> = { "claude-code": "claude", codex: "codex" };
const VENDOR: Record<RouterTool["id"], string> = { "claude-code": "Anthropic", codex: "OpenAI" };
const MODEL_HINT: Record<RouterTool["id"], string> = { "claude-code": "claude-haiku-*", codex: "gpt-*-mini" };

type Rule = { pattern: string; target: string };

function toRules(r: RouteRules | undefined): { background: string; rules: Rule[] } {
  return {
    background: r?.kinds?.background ?? "",
    rules: Object.entries(r?.models ?? {}).map(([pattern, target]) => ({ pattern, target })),
  };
}

function fromRules(background: string, rules: Rule[], kinds: Record<string, string> = {}): RouteRules {
  const models: Record<string, string> = {};
  for (const r of rules) if (r.pattern.trim() && r.target.trim()) models[r.pattern.trim()] = r.target.trim();
  const rest = Object.fromEntries(Object.entries(kinds).filter(([k]) => k !== "background"));
  return { models, kinds: background.trim() ? { ...rest, background: background.trim() } : rest };
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
  const [saving, setSaving] = useState(false);
  useEffect(() => { setBackground(initial.background); setList(initial.rules); }, [initial]);
  const next = fromRules(background, list, rules?.kinds);
  const dirty = JSON.stringify(next) !== JSON.stringify(fromRules(initial.background, initial.rules, rules?.kinds));
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
        <span className="r-label">Background calls</span>
        <input
          className="s-addr mono r-input" list={listId} placeholder="Unchanged"
          value={background} onChange={e => setBackground(e.target.value)}
        />
      </label>
      <span className="d-prov-sub r-hint">Titles, quota checks, summaries.</span>
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
  const models = useMemo(() => [...new Set(["passthrough", ...(spend?.by_model.map(m => m.model) ?? [])])], [spend]);

  if (!enabled) return <NeedsPrompture statusKey={statusKey} />;
  if (!state) return <p className="d-empty">{error ?? "Loading…"}</p>;

  const run = async (fn: () => Promise<RouterState>) => {
    setError(null);
    try { setState(await fn()); } catch (e) { setError(String(e).replace(/^Error:\s*/, "")); }
  };
  const on = state.tools.filter(t => t.enabled);
  const claude = state.tools.find(t => t.id === "claude-code");

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

      {on.map(t => (
        <RulesCard
          key={t.id} tool={t} rules={state.routes.tools[t.id]} models={models}
          onSave={r => run(() => hub.saveRoutes({ tools: { ...state.routes.tools, [t.id]: r } }))}
        />
      ))}

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
