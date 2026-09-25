import { useState } from "react";
import { Meter, Sparkline, ago } from "../components/ui";
import { type Alert, type KeyLimits, type LiveEvent, type ProviderLimits, TOOL_NAMES, hub, usd, windowName } from "../lib/hub";
import type { DeskState } from "../lib/useDesk";

function controlError(e: unknown): string {
  const text = String(e);
  return text.includes("read scope") ? "This device is read-only. Pair again with control to change keys." : text;
}

// ---------------------------------------------------------------- Now

function RunningRow({ e }: { e: LiveEvent }) {
  const waiting = e.state === "waiting";
  return (
    <div className="item">
      <span className={`pulse ${waiting ? "waiting" : ""}`} />
      <div className="item-main">
        <div className="item-title ellipsis mono">{e.routed_to ?? e.model}</div>
        <div className="item-sub ellipsis">
          {e.key_name ?? `key ${e.key_id}`}
          {e.project && <> · {e.project}</>}
          {waiting ? " · waiting on you" : e.ttft_ms != null ? " · streaming" : ""}
        </div>
      </div>
      <span className="faint tnum" style={{ fontSize: 11 }}>{ago(e.ts)}</span>
    </div>
  );
}

function FinishedRow({ e }: { e: LiveEvent }) {
  const failed = e.status !== "ok";
  return (
    <div className="item">
      <div className="item-main">
        <div className="item-title ellipsis mono">{e.served_by ?? e.model}</div>
        <div className="item-sub ellipsis">
          {e.key_name && <>{e.key_name} · </>}{e.project ?? "no project"} · {e.latency_ms ?`${(e.latency_ms / 1000).toFixed(1)}s` : "—"}
          {e.fallback && " · fallback"}
        </div>
      </div>
      {failed
        ? <span className="badge badge-danger">{e.status}</span>
        : <span className="mono tnum" style={{ fontSize: 12 }}>{usd(e.cost_usd ?? 0)}</span>}
    </div>
  );
}

export function NowView({ d }: { d: DeskState }) {
  const recent = [...d.finished].reverse().slice(0, 8);
  return (
    <>
      <div className="card">
        <div className="row between">
          <h3>Last 30 minutes</h3>
          <span className="faint tnum" style={{ fontSize: 11 }}>{d.finished.length} calls</span>
        </div>
        <Sparkline events={d.finished} />
      </div>
      <div className="card">
        <h3>{d.caps.running_calls ? `Running now · ${d.running.length}` : "Running now"}</h3>
        {!d.caps.running_calls && (
          <div className="muted" style={{ fontSize: 12 }}>
            Calls appear under "Just finished" as they complete. Seeing calls while they run needs prompture-hub.
          </div>
        )}
        {d.caps.running_calls && (d.running.length === 0
          ? <div className="empty" style={{ padding: 12 }}>Nothing in flight.</div>
          : <div className="list">{d.running.map(e => <RunningRow key={e.request_id} e={e} />)}</div>)}
      </div>
      {recent.length > 0 && (
        <div className="card">
          <h3>Just finished</h3>
          <div className="list">{recent.map(e => <FinishedRow key={`${e.request_id}-${e.id}`} e={e} />)}</div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Headroom

function KeyCard({ k, onChanged }: { k: KeyLimits; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState(k.route_override ?? "");
  const [editing, setEditing] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); onChanged(); } catch (e) { setError(controlError(e)); }
  };
  const used = k.spend.fraction_used ?? 0;
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row between">
        <div className="grow">
          <div className="item-title ellipsis">{k.name}</div>
          <div className="item-sub ellipsis">
            {k.default_project ? `project ${k.default_project}` : "no default project"}
            {k.route_override && <> · routed to <span className="mono">{k.route_override}</span></>}
          </div>
        </div>
        {k.paused && <span className="badge badge-warn">paused</span>}
      </div>
      <div className="row between item-sub">
        <span>{usd(k.spend.spent_usd)} of {usd(k.spend.cap_usd)} this {k.spend.period}</span>
        <span className="tnum">{k.rate.calls_last_minute}/{k.rate.limit_per_min} per min</span>
      </div>
      <Meter fraction={used} />
      <div className="row" style={{ gap: 6 }}>
        <button className="btn btn-sm" onClick={() => run(() => (k.paused ? hub.resumeKey(k.id) : hub.pauseKey(k.id)))}>
          {k.paused ? "Resume" : "Pause"}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setEditing(v => !v)}>Route…</button>
      </div>
      {editing && (
        <div className="row">
          <input className="input mono" placeholder="combo/cheap (empty clears)" value={route} onChange={e => setRoute(e.target.value)} />
          <button className="btn btn-sm" onClick={() => run(async () => { await hub.updateKey(k.id, { route_override: route.trim() }); setEditing(false); })}>
            Save
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function resetsIn(at: number | null): string {
  if (at == null) return "";
  const mins = Math.max(0, Math.round((at * 1000 - Date.now()) / 60_000));
  if (mins < 60) return `resets in ${mins}m`;
  if (mins < 48 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `resets ${new Date(at * 1000).toLocaleDateString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

function PlanCard({ p }: { p: ProviderLimits }) {
  const windows = Object.entries(p.windows ?? {}).filter(([, w]) => w.limit != null && w.remaining != null);
  return (
    <div className="item" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
      <div className="row between">
        <span className="item-title">{p.tool_name ?? TOOL_NAMES[p.tool ?? ""] ?? p.target}</span>
        {p.plan && <span className="item-sub">{p.plan}</span>}
      </div>
      {windows.map(([name, w]) => {
        const reset = w.resets_at != null && w.resets_at * 1000 <= Date.now();
        const used = reset ? 0 : 100 - (w.remaining ?? 0);
        return (
          <div key={name} className="stack" style={{ gap: 3 }}>
            <div className="row between item-sub">
              <span>{windowName(name)}</span>
              <span className="tnum">{used}% used{w.resets_at != null && !reset ? ` · ${resetsIn(w.resets_at)}` : ""}</span>
            </div>
            <Meter fraction={(100 - used) / 100} invert />
          </div>
        );
      })}
    </div>
  );
}

export function HeadroomView({ d }: { d: DeskState }) {
  const l = d.limits;
  if (!l) return <div className="empty">{d.error ?? "Loading limits…"}</div>;
  const plans = (l.providers ?? []).filter(p => p.source === "plan");
  const rates = (l.providers ?? []).filter(p => p.source !== "plan");
  return (
    <>
      {plans.length > 0 && (
        <div className="card">
          <h3>Coding plans</h3>
          <div className="list">{plans.map(p => <PlanCard key={p.target} p={p} />)}</div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
            Subscription plan usage for the coding tools on this PC.
          </div>
        </div>
      )}
      {l.keys.map(k => <KeyCard key={k.id} k={k} onChanged={d.refresh} />)}
      {!d.caps.key_controls && l.keys.length === 0 && (
        <div className="card muted" style={{ fontSize: 12 }}>
          Per-key spend caps and routes come with prompture-hub. Budgets per provider are in Settings › Providers.
        </div>
      )}
      {rates.length > 0 && (
        <div className="card">
          <h3>Provider rate limits</h3>
          <div className="list">
            {rates.map(p => (
              <div key={p.target} className="item" style={{ flexDirection: "column", alignItems: "stretch", gap: 5 }}>
                <div className="row between">
                  <span className="item-title mono ellipsis">{p.target}</span>
                  <span className="item-sub">
                    {p.current_headroom == null ? "window reset" : `${Math.round(p.current_headroom * 100)}% of ${windowName(p.current_window)} left`}
                  </span>
                </div>
                {p.current_headroom != null && <Meter fraction={p.current_headroom} invert />}
              </div>
            ))}
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>From the rate-limit headers each provider sends.</div>
        </div>
      )}
      {l.accounts && l.accounts.length > 0 && (
        <div className="card">
          <h3>Provider accounts</h3>
          <div className="list">
            {l.accounts.map(a => (
              <div key={a.source} className="item">
                <div className="item-main">
                  <div className="item-title">{a.source}</div>
                  <div className="item-sub">{a.error ?? (a.period ? `${a.period} spend ${a.spent ?? "—"}` : "balance")}</div>
                </div>
                {a.balance != null && <span className="mono tnum">{a.balance.toFixed(2)} {a.currency ?? ""}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Alerts

export function AlertsView({ d }: { d: DeskState }) {
  const [error, setError] = useState<string | null>(null);
  const ack = async (a: Alert) => {
    setError(null);
    try { await hub.ackAlert(a.alert_id); d.refresh(); } catch (e) { setError(controlError(e)); }
  };
  if (d.alerts.length === 0) {
    return (
      <div className="empty">
        {d.caps.alert_rules
          ? "No alerts. Add rules in the hub dashboard under Settings › Alerts."
          : "No alerts. Amber strips still warn you near a budget or rate limit; alert rules with webhooks come with prompture-hub."}
      </div>
    );
  }
  return (
    <div className="card">
      {error && <div className="error" style={{ marginBottom: 6 }}>{error}</div>}
      <div className="list">
        {d.alerts.map(a => (
          <div key={a.alert_id} className="item">
            <div className="item-main">
              <div className="item-title">{a.rule ?? a.kind}</div>
              <div className="item-sub">{a.message}</div>
              <div className="faint" style={{ fontSize: 11 }}>{ago(a.created_at)} ago</div>
            </div>
            {a.acknowledged_at
              ? <span className="badge">seen</span>
              : <button className="btn btn-sm" onClick={() => ack(a)}>Ack</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
