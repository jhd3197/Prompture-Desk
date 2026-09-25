// The Activity page: what's happening now and lately — the year's grid, the
// last 30 minutes minute by minute, where the calls came from, and each call.
import { useMemo, useState } from "react";
import { ActivityHeatmap } from "../components/Heatmap";
import { ago } from "../components/ui";
import { type LiveEvent, type Settings, count, tokens, usd } from "../lib/hub";
import { ProviderLogo, providerOf } from "../lib/providers";
import type { DeskState } from "../lib/useDesk";
import { AgentLogo } from "./Tools";

const MINUTES = 30;

/** Where a call came from: the coding tool, the hub key, or Prompture itself. */
function sourceOf(e: LiveEvent): string {
  return e.key_name ?? (typeof e.tool === "string" ? e.tool : "Prompture");
}

function SourceLogo({ e, size = 18 }: { e: LiveEvent; size?: number }) {
  if (typeof e.tool === "string") return <AgentLogo id={e.tool} size={size} />;
  const prov = providerOf(e.served_by ?? e.model);
  return prov ? <ProviderLogo id={prov} size={size} /> : <span className="d-call-dot" />;
}

function callTokens(e: LiveEvent): number {
  return Number(e.prompt_tokens ?? 0) + Number(e.completion_tokens ?? 0);
}

/** Calls per minute over the last 30 minutes, as bars. */
function MinuteBars({ events }: { events: LiveEvent[] }) {
  const now = Date.now();
  const buckets = Array.from({ length: MINUTES }, () => ({ ok: 0, failed: 0 }));
  for (const e of events) {
    const age = Math.floor((now - Date.parse(e.ts ?? "")) / 60_000);
    if (age < 0 || age >= MINUTES) continue;
    const b = buckets[MINUTES - 1 - age];
    if (e.status === "ok") b.ok += 1; else b.failed += 1;
  }
  const max = Math.max(1, ...buckets.map(b => b.ok + b.failed));
  return (
    <div className="a-bars" role="img" aria-label={`${events.length} calls in the last ${MINUTES} minutes`}>
      {buckets.map((b, i) => (
        <span key={i} className="a-bar" title={`${MINUTES - 1 - i === 0 ? "This minute" : `${MINUTES - 1 - i} min ago`}: ${b.ok + b.failed} calls`}>
          {b.failed > 0 && <span className="a-bar-fail" style={{ height: `${(b.failed / max) * 100}%` }} />}
          <span className="a-bar-ok" style={{ height: `${(b.ok / max) * 100}%` }} />
        </span>
      ))}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="d-stat">
      <span className="d-stat-label">{label}</span>
      <span className="num d-stat-value">{value}</span>
      {sub && <span className="d-stat-sub">{sub}</span>}
    </div>
  );
}

export function ActivityPage({ d, settings }: { d: DeskState; settings: Settings }) {
  const [source, setSource] = useState<string | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const events = d.finished;
  const failed = events.filter(e => e.status !== "ok").length;
  const totalTokens = events.reduce((a, e) => a + callTokens(e), 0);
  const totalCost = events.reduce((a, e) => a + (e.cost_usd ?? 0), 0);
  const latencies = events.map(e => e.latency_ms ?? 0).filter(v => v > 0).sort((a, b) => a - b);
  const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;

  // Where the last 30 minutes came from, busiest first.
  const bySource = useMemo(() => {
    const m = new Map<string, { name: string; calls: number; tokens: number; sample: LiveEvent }>();
    for (const e of events) {
      const name = sourceOf(e);
      const s = m.get(name) ?? { name, calls: 0, tokens: 0, sample: e };
      s.calls += 1;
      s.tokens += callTokens(e);
      m.set(name, s);
    }
    return [...m.values()].sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
  }, [events]);
  const maxTokens = Math.max(1, ...bySource.map(s => s.tokens));

  const rows = [...events]
    .reverse()
    .filter(e => (!source || sourceOf(e) === source) && (!failedOnly || e.status !== "ok"))
    .slice(0, 60);

  return (
    <div className="d-page">
      <div className="d-stats a-stats">
        <Stat label="Last 30 minutes" value={count(events.length)} sub="calls" />
        <Stat label="Tokens" value={tokens(totalTokens)} sub={totalCost > 0 ? `≈ ${usd(totalCost)}` : undefined} />
        <Stat label="Failed" value={count(failed)} sub={events.length ? `${Math.round((failed / events.length) * 100)}% of calls` : "none"} />
        <Stat label="Typical call" value={median != null ? `${(median / 1000).toFixed(1)}s` : "—"} sub="median duration" />
        {d.caps.running_calls && <Stat label="Running now" value={count(d.running.length)} sub="through the hub" />}
      </div>

      <ActivityHeatmap settings={settings} enabled={!!d.caps.activity} />

      <div className="d-grid">
        <section className="d-card">
          <header className="d-card-head">
            <h3>Calls per minute</h3>
            <span className="hm-summary">last {MINUTES} minutes</span>
          </header>
          <MinuteBars events={events} />
          <div className="a-axis"><span>{MINUTES} min ago</span><span>now</span></div>
        </section>
        <section className="d-card">
          <header className="d-card-head"><h3>By source</h3></header>
          {bySource.length === 0 && <p className="d-empty">Nothing in the last {MINUTES} minutes.</p>}
          {bySource.slice(0, 6).map(s => (
            <button
              key={s.name}
              className={`d-bar-row t-row t-pick ${source === s.name ? "on" : ""}`}
              onClick={() => setSource(source === s.name ? null : s.name)}
              title={source === s.name ? "Show every call" : `Show only ${s.name}`}
            >
              <span className="row" style={{ gap: 8, minWidth: 0 }}><SourceLogo e={s.sample} /><span className="ellipsis">{s.name}</span></span>
              <span className="d-bar"><span style={{ width: `${(s.tokens / maxTokens) * 100}%` }} /></span>
              <span className="num d-bar-val">{count(s.calls)}</span>
            </button>
          ))}
        </section>
      </div>

      {d.caps.running_calls && d.running.length > 0 && (
        <section className="d-card">
          <header className="d-card-head"><h3>Running now</h3></header>
          {d.running.map(e => (
            <div key={e.request_id} className="a-call">
              <span className={`pulse ${e.state === "waiting" ? "waiting" : ""}`} />
              <span className="mono ellipsis">{e.routed_to ?? e.model}</span>
              <span className="d-call-sub ellipsis">{[sourceOf(e), e.project].filter(Boolean).join(" · ")}</span>
              <span className="d-call-ago">{ago(e.ts)}</span>
            </div>
          ))}
        </section>
      )}

      <section className="d-card">
        <header className="d-card-head">
          <h3>Recent calls</h3>
          <div className="hm-filters">
            {[null, ...bySource.map(s => s.name)].map(n => (
              <button key={n ?? "all"} className={`hm-chip ${source === n ? "on" : ""}`} onClick={() => setSource(n)}>{n ?? "All"}</button>
            ))}
            <button className={`hm-chip ${failedOnly ? "on" : ""}`} onClick={() => setFailedOnly(v => !v)}>Failed only</button>
          </div>
        </header>
        {rows.length === 0 ? (
          <p className="d-empty">{events.length ? "No calls match." : `No calls in the last ${MINUTES} minutes. They appear here as they finish.`}</p>
        ) : (
          <div className="a-table" role="table">
            <div className="a-row a-head" role="row">
              <span>When</span><span>Source</span><span>Model</span><span>Project</span>
              <span className="r">In</span><span className="r">Out</span><span className="r">Cost</span><span className="r">Took</span>
            </div>
            {rows.map((e, i) => (
              <div key={`${e.request_id}-${i}`} className={`a-row ${e.status !== "ok" ? "failed" : ""}`} role="row">
                <span className="d-call-ago">{ago(e.ts)}</span>
                <span className="row ellipsis" style={{ gap: 6 }}><SourceLogo e={e} size={16} /><span className="ellipsis">{sourceOf(e)}</span></span>
                <span className="mono ellipsis" title={e.served_by ?? e.model}>{(e.served_by ?? e.model ?? "").split("/").pop()}</span>
                <span className="ellipsis">{e.project ?? "—"}</span>
                <span className="num r">{tokens(Number(e.prompt_tokens ?? 0))}</span>
                <span className="num r">{tokens(Number(e.completion_tokens ?? 0))}</span>
                <span className="num r">{e.status !== "ok" ? <span className="d-tag danger">{e.status}</span> : usd(e.cost_usd ?? 0)}</span>
                <span className="num r">{e.latency_ms ? `${(e.latency_ms / 1000).toFixed(1)}s` : "—"}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
