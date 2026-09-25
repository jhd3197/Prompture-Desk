// Coding tools: usage Prompture reads from the logs coding agents keep on this
// PC (Claude Code, Codex, Kimi Code, Gemini CLI, …), plus which ones are
// installed and which Prompture can also run.
import { Check, Cloud, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { Segmented, Strip, Toggle, ago } from "../components/ui";
import { type InstalledAgent, type Settings, type ToolUsage, type Tools, hub, tokens, usd } from "../lib/hub";
import { ProviderLogo } from "../lib/providers";

type Period = Tools["period"];

/** The provider logo that stands for each agent. */
const AGENT_LOGO: Record<string, string> = {
  claude: "claude", codex: "openai", kimi: "kimi", gemini: "gemini", qwen: "qwen", antigravity: "gemini",
};

export function AgentLogo({ id, size = 22 }: { id: string; size?: number }) {
  return <ProviderLogo id={AGENT_LOGO[id] ?? id} size={size} />;
}

/** Poll /v1/tools while the page is open. */
export function useTools(period: Period, enabled: boolean, refreshSecs: number): { data: Tools | null; error: string | null } {
  const [data, setData] = useState<Tools | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => hub.tools(period)
      .then(t => { if (live) { setData(t); setError(null); } })
      .catch(e => { if (live) setError(String(e)); });
    load();
    const timer = window.setInterval(load, Math.max(5, refreshSecs) * 1000);
    return () => { live = false; window.clearInterval(timer); };
  }, [period, enabled, refreshSecs]);
  return { data, error };
}

function costLabel(a: ToolUsage): string {
  if (a.cost_source === "unknown") return "price unknown";
  const prefix = a.cost_source === "reported" ? "" : "≈ ";
  return `${prefix}${usd(a.cost_usd)}${a.cost_source === "reported" ? "" : " API"}`;
}

function AgentCard({ a, max, metric }: { a: ToolUsage; max: number; metric: Settings["metric"] }) {
  const value = metric === "tokens" || a.cost_source === "unknown" ? tokens(a.tokens) : usd(a.cost_usd);
  const cached = a.input_tokens > 0 ? Math.round((a.cache_read_tokens / a.input_tokens) * 100) : 0;
  return (
    <section className="d-card t-agent">
      <header className="t-agent-head">
        <AgentLogo id={a.agent} size={28} />
        <div className="t-agent-title">
          <span className="d-prov-name">{a.name}</span>
          <span className="d-prov-sub">{a.requests.toLocaleString()} calls · last {ago(a.last_used)}</span>
        </div>
        <div className="t-agent-value">
          <span className="num d-stat-value">{value}</span>
          <span className="d-stat-sub">{metric === "tokens" ? costLabel(a) : `${tokens(a.tokens)} tokens`}</span>
        </div>
      </header>
      <Strip pct={(a.tokens / max) * 100} tone="ok" height={5} />
      <div className="t-split">
        <span>In <b className="num">{tokens(a.input_tokens)}</b>{cached > 0 && <> ({cached}% cached)</>}</span>
        <span>Out <b className="num">{tokens(a.output_tokens)}</b></span>
        {a.reasoning_tokens > 0 && <span>Reasoning <b className="num">{tokens(a.reasoning_tokens)}</b></span>}
      </div>
      <div className="t-cols">
        <div>
          <span className="t-label">Models</span>
          {a.models.slice(0, 3).map(m => (
            <div key={m.model} className="t-line"><span className="mono ellipsis" title={m.model}>{m.model?.split("/").pop()}</span><span className="num">{tokens(m.tokens)}</span></div>
          ))}
        </div>
        <div>
          <span className="t-label">Projects</span>
          {a.projects.slice(0, 3).map(p => (
            <div key={p.project ?? "-"} className="t-line"><span className="ellipsis" title={p.project ?? undefined}>{p.project ?? "—"}</span><span className="num">{tokens(p.tokens)}</span></div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Opt-in: Claude Code's 5-hour and weekly plan windows, read the way Claude Code reads them. */
function ClaudePlanSwitch({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setOn(initial), [initial]);
  const change = async (next: boolean) => {
    setError(null);
    setOn(next);
    try {
      const res = await hub.setClaudePlan(next);
      setOn(res.claude_plan_usage);
    } catch (e) {
      setOn(!next);
      setError(String(e));
    }
  };
  return (
    <section className="d-card">
      <div className="row between" style={{ gap: 16 }}>
        <div className="stack" style={{ gap: 4 }}>
          <span className="d-prov-name">Claude Code plan limits</span>
          <span className="d-prov-sub" style={{ maxWidth: 620, lineHeight: 1.5 }}>
            Your 5-hour and weekly windows, read like <code className="mono">/usage</code> with Claude Code's login.
          </span>
        </div>
        <Toggle on={on} onChange={change} label="Claude Code plan limits" />
      </div>
      {error && <span className="s-error" style={{ fontSize: 12 }}>{error}</span>}
    </section>
  );
}

function InstalledRow({ a, used }: { a: InstalledAgent; used: boolean }) {
  return (
    <div className="t-installed">
      <AgentLogo id={a.id} size={20} />
      <span className="grow">{a.name}</span>
      {a.usage ? (
        <span className="t-chip" title="Usage is read from this PC"><Check size={12} aria-hidden /> {used ? "Counted" : "No calls this period"}</span>
      ) : (
        <span className="t-chip muted" title="This tool keeps usage in its online account"><Cloud size={12} aria-hidden /> Usage stays online</span>
      )}
      {a.runnable && <span className="t-chip" title="Prompture can run this agent for you"><Play size={12} aria-hidden /> Runnable</span>}
    </div>
  );
}

export function ToolsView({ settings, enabled }: { settings: Settings; enabled: boolean }) {
  const [period, setPeriod] = useState<Period>("day");
  const { data, error } = useTools(period, enabled, settings.refresh_secs * 3);
  if (!enabled) {
    return <p className="d-empty">Coding tools are only available with Prompture on this PC.</p>;
  }
  if (!data) return <p className="d-empty">{error ?? "Reading your coding tools' logs…"}</p>;
  const max = Math.max(1, ...data.agents.map(a => a.tokens));
  const used = new Set(data.agents.map(a => a.agent));
  return (
    <div className="d-page">
      <div className="row between">
        <p className="d-empty" style={{ maxWidth: 560 }}>From each tool's local logs. Costs are API-equivalent.</p>
        <Segmented label="Period" value={period} options={[["day", "Today"], ["week", "Week"], ["month", "Month"]]} onChange={v => setPeriod(v)} />
      </div>
      {data.agents.length === 0 && <p className="d-empty">{`No coding-tool calls ${period === "day" ? "today" : `this ${period}`}.`}</p>}
      <div className="t-grid">
        {data.agents.map(a => <AgentCard key={a.agent} a={a} max={max} metric={settings.metric} />)}
      </div>
      {data.installed.some(a => a.id === "claude") && <ClaudePlanSwitch initial={!!data.claude_plan_usage} />}
      {data.installed.length > 0 && (
        <section className="d-card">
          <header className="d-card-head"><h3>Installed on this PC</h3></header>
          {data.installed.map(a => <InstalledRow key={a.id} a={a} used={used.has(a.id)} />)}
        </section>
      )}
    </div>
  );
}

const PERIOD_WORDS: Record<Period, string> = { day: "today", week: "this week", month: "this month" };

/**
 * The Overview's coding-tools card: each tool's tokens for today, the week or
 * the month. Clicking a tool narrows the activity grid to it (`selected`).
 */
export function ToolsCard({
  settings, enabled, onOpen, selected, onSelect,
}: {
  settings: Settings;
  enabled: boolean;
  onOpen: () => void;
  selected?: string | null;
  onSelect?: (name: string | null) => void;
}) {
  const [period, setPeriod] = useState<Period>("day");
  const { data } = useTools(period, enabled, settings.refresh_secs * 3);
  if (!enabled || !data) return null;
  const max = Math.max(1, ...data.agents.map(a => a.tokens));
  return (
    <section className="d-card">
      <header className="d-card-head">
        <h3>Coding tools</h3>
        <div className="row" style={{ gap: 8 }}>
          <Segmented small label="Period" value={period} options={[["day", "Day"], ["week", "Week"], ["month", "Month"]]} onChange={v => setPeriod(v)} />
          <button className="d-link" onClick={onOpen}>Details</button>
        </div>
      </header>
      {data.agents.length === 0 && <p className="d-empty">{`No coding-tool calls ${PERIOD_WORDS[period]}.`}</p>}
      {data.agents.slice(0, 6).map(a => {
        const on = selected === a.name;
        return (
          <button
            key={a.agent}
            className={`d-bar-row t-row t-pick ${on ? "on" : ""}`}
            title={on ? "Show every source in the activity grid" : `Show only ${a.name} in the activity grid`}
            onClick={() => onSelect?.(on ? null : a.name)}
          >
            <span className="row" style={{ gap: 8, minWidth: 0 }}><AgentLogo id={a.agent} size={18} /><span className="ellipsis">{a.name}</span></span>
            <span className="d-bar"><span style={{ width: `${(a.tokens / max) * 100}%` }} /></span>
            <span className="num d-bar-val">{tokens(a.tokens)}</span>
          </button>
        );
      })}
    </section>
  );
}
