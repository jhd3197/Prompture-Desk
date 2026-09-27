// Savings: what calls through the router cost, what the original path would
// have cost, and why each call went where it did.
import { useCallback, useEffect, useState } from "react";
import { Segmented, ago } from "../components/ui";
import { type RoutedCall, type Savings, type SavingsRow, count, hub, tokens, usd } from "../lib/hub";
import { ProviderLogo, providerOf } from "../lib/providers";

type Period = Savings["period"];
type Group = "tool" | "project" | "rule" | "served";

const TOOL_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };
const BILLING: Record<RoutedCall["billing"], string> = {
  subscription: "Plan", api: "API", local: "Local", unknown: "Unknown",
};

/** Money that can go either way: "+$1.20" saved, "−$0.40" when routing cost more. */
function signed(v: number): string {
  if (Math.abs(v) < 0.00005) return "$0.00";
  return `${v > 0 ? "+" : "−"}${usd(Math.abs(v))}`;
}

function short(model: string): string {
  return model.split(" → ").pop()!.split("/").slice(1).join("/") || model;
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="d-stat">
      <span className="d-stat-label">{label}</span>
      <span className={`num d-stat-value ${tone ?? ""}`}>{value}</span>
      {sub && <span className="d-stat-sub">{sub}</span>}
    </div>
  );
}

function Totals({ t }: { t: SavingsRow }) {
  return (
    <div className="d-stats sv-stats">
      <Stat label="API spend" value={usd(t.cost_usd)} sub={`${count(t.calls)} calls`} />
      <Stat label="Saved (est.)" value={signed(t.savings_usd)} sub={`vs ${usd(t.baseline_usd)}`} tone={t.savings_usd < 0 ? "sv-neg" : ""} />
      <Stat label="Routed" value={count(t.routed)} sub={t.fallbacks ? `${count(t.fallbacks)} fallbacks` : "no fallbacks"} />
      {t.new_spend_usd > 0 && <Stat label="New spend" value={usd(t.new_spend_usd)} sub="plan calls sent to APIs" tone="sv-warn" />}
    </div>
  );
}

function Breakdown({ data }: { data: Savings }) {
  const [group, setGroup] = useState<Group>("tool");
  const rows: Array<SavingsRow & { name: string }> = (
    group === "tool" ? data.by_tool.map(r => ({ ...r, name: TOOL_NAMES[r.tool ?? ""] ?? r.tool ?? "—" }))
      : group === "project" ? data.by_project.map(r => ({ ...r, name: r.project ?? "No project" }))
        : group === "rule" ? data.by_rule.map(r => ({ ...r, name: r.rule === "none" ? "No rule" : r.rule ?? "—" }))
          : data.by_served.map(r => ({ ...r, name: short(r.served ?? "—") }))
  );
  return (
    <section className="d-card">
      <header className="d-card-head">
        <h3>By</h3>
        <Segmented<Group> small label="Group by" value={group} onChange={setGroup}
          options={[["tool", "Tool"], ["project", "Project"], ["rule", "Rule"], ["served", "Model"]]} />
      </header>
      {rows.length === 0 ? <p className="d-empty">No calls yet.</p> : (
        <div className="sv-table">
          <span className="sv-th">Name</span><span className="sv-th num">Calls</span>
          <span className="sv-th num">Spend</span><span className="sv-th num">Saved</span>
          {rows.map(r => (
            <div key={r.name} className="sv-row">
              <span className="ellipsis" title={r.name}>{r.name}</span>
              <span className="num">{count(r.calls)}{r.routed > 0 && r.routed < r.calls ? <span className="sv-dim"> · {count(r.routed)} routed</span> : null}</span>
              <span className="num">{usd(r.cost_usd)}</span>
              <span className={`num ${r.savings_usd < 0 ? "sv-neg" : ""}`}>{signed(r.savings_usd)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Detail({ call, onEscalated }: { call: RoutedCall; onEscalated: () => void }) {
  const [full, setFull] = useState<RoutedCall | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { hub.routerCall(call.id).then(setFull).catch(() => setFull(call)); }, [call]);
  const c = full ?? call;
  const task = c.task;
  const cached = c.input_tokens ? Math.round((c.cache_read_tokens / c.input_tokens) * 100) : 0;
  const escalate = async () => {
    if (!c.session) return;
    setBusy(true);
    try {
      const r = await hub.escalateTask(c.tool, c.session, "asked from Desk");
      setNote(r.escalated ? "The task moves to a stronger model from its next call." : "Nothing stronger to move to, or the task budget is spent.");
      onEscalated();
    } catch (e) { setNote(String(e).replace(/^Error:\s*/, "")); } finally { setBusy(false); }
  };
  return (
    <div className="sv-detail">
      <div className="sv-kv"><span>Asked for</span><span className="mono">{c.requested}</span></div>
      <div className="sv-kv"><span>Answered by</span><span className="mono">{c.served}</span></div>
      <div className="sv-kv"><span>Why</span><span>{c.rule.reason}</span></div>
      <div className="sv-kv"><span>Billing</span><span>{BILLING[c.billing]}{c.original_billing !== c.billing ? ` (was ${BILLING[c.original_billing].toLowerCase()})` : ""}</span></div>
      <div className="sv-kv"><span>Tokens</span><span className="num">
        {tokens(c.input_tokens)} in{cached ? ` (${cached}% cached)` : ""} · {tokens(c.output_tokens)} out
        {c.cache_write_tokens ? ` · ${tokens(c.cache_write_tokens)} cache writes` : ""}
      </span></div>
      <div className="sv-kv"><span>Time</span><span className="num">{(c.latency_ms / 1000).toFixed(1)}s{c.ttft_ms != null ? ` · first token ${(c.ttft_ms / 1000).toFixed(1)}s` : ""}</span></div>
      <div className="sv-kv"><span>Cost</span><span className="num">
        {c.billing === "subscription" ? `plan (${usd(c.plan_equivalent_usd)} at API prices)` : usd(c.cost_usd)}
        {c.route !== "passthrough" && ` · original ${c.original_billing === "subscription" ? "plan" : `≈ ${usd(c.baseline_usd)}`}`}
        {c.route !== "passthrough" && ` · ${signed(c.savings_usd)}`}
      </span></div>
      {c.switched && <div className="sv-kv"><span>Cache</span><span>Model changed here, so the prompt cache started over.</span></div>}
      {c.error && <div className="sv-kv"><span>Error</span><span className="s-error">{c.error}</span></div>}
      {c.attempts.length > 0 && (
        <div className="sv-kv"><span>Attempts</span><span className="stack" style={{ gap: 2 }}>
          {c.attempts.map((a, i) => (
            <span key={i} className="mono">{i + 1}. {a.model} — {a.status}{a.error ? `: ${a.error}` : ""}</span>
          ))}
        </span></div>
      )}
      {task && (
        <div className="sv-kv"><span>Task</span><span className="stack" style={{ gap: 2 }}>
          <span>{task.project ?? "No project"} · {count(task.attempts)} attempts · {usd(task.spent_usd)} routed{task.waiting ? " · waiting for you" : ""}</span>
          {task.escalations.map((e, i) => (
            <span key={i} className="d-prov-sub">{e.to ? `Escalated to ${e.to}` : `Not escalated (${e.blocked})`}: {e.reason}</span>
          ))}
          <span><button className="s-btn sm" disabled={busy} onClick={escalate}>Use a stronger model</button></span>
          {note && <span className="d-prov-sub">{note}</span>}
        </span></div>
      )}
    </div>
  );
}

function Calls({ period }: { period: Period }) {
  const [routedOnly, setRoutedOnly] = useState(true);
  const [calls, setCalls] = useState<RoutedCall[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    hub.routerCalls(period, routedOnly).then(setCalls).catch(() => setCalls([]));
  }, [period, routedOnly]);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [load]);
  return (
    <section className="d-card">
      <header className="d-card-head">
        <h3>Calls</h3>
        <Segmented<"routed" | "all"> small label="Which calls" value={routedOnly ? "routed" : "all"}
          onChange={v => setRoutedOnly(v === "routed")} options={[["routed", "Routed"], ["all", "All"]]} />
      </header>
      {calls === null ? <p className="d-empty">Loading…</p> : calls.length === 0 ? (
        <p className="d-empty">{routedOnly ? "No routed calls yet." : "No calls yet."}</p>
      ) : calls.slice(0, 100).map(c => {
        const prov = providerOf(c.served.split(" → ").pop()!);
        return (
          <div key={c.id} className="sv-call-wrap">
            <button className={`sv-call ${open === c.id ? "open" : ""}`} onClick={() => setOpen(o => (o === c.id ? null : c.id))}>
              {prov ? <ProviderLogo id={prov} size={18} /> : <span className="d-call-dot" />}
              <span className="stack ellipsis" style={{ gap: 1 }}>
                <span className="mono ellipsis">{c.route === "passthrough" ? short(c.served) : `${short(c.requested)} → ${short(c.served)}`}</span>
                <span className="d-call-sub ellipsis">{c.rule.reason}</span>
              </span>
              {c.status !== "ok"
                ? <span className="d-tag danger">error</span>
                : <span className="num d-call-cost">{c.billing === "subscription" ? "plan" : usd(c.cost_usd)}</span>}
              <span className={`num sv-save ${c.savings_usd < 0 ? "sv-neg" : ""}`}>{c.route === "passthrough" ? "" : signed(c.savings_usd)}</span>
              <span className="d-call-ago">{ago(c.ts)}</span>
            </button>
            {open === c.id && <Detail call={c} onEscalated={load} />}
          </div>
        );
      })}
    </section>
  );
}

export function SavingsView({ enabled }: { enabled: boolean }) {
  const [period, setPeriod] = useState<Period>("day");
  const [data, setData] = useState<Savings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => hub.routerSavings(period)
      .then(d => { if (live) { setData(d); setError(null); } })
      .catch(e => { if (live) setError(String(e).replace(/^Error:\s*/, "")); });
    load();
    const t = window.setInterval(load, 10_000);
    return () => { live = false; window.clearInterval(t); };
  }, [enabled, period]);

  if (!enabled) return <p className="d-empty">Savings need routing, on Prompture on this PC.</p>;
  return (
    <div className="d-page">
      <Segmented<Period> label="Period" value={period} onChange={setPeriod}
        options={[["day", "Today"], ["week", "This week"], ["month", "This month"]]} />
      {error && <span className="s-error">{error}</span>}
      {data && <Totals t={data.total} />}
      {data && <Breakdown data={data} />}
      <Calls period={period} />
      <span className="d-prov-sub">Estimates from model rates. Plan calls cost nothing extra.</span>
    </div>
  );
}
