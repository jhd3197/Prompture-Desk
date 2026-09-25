// Prompture Desk's window: a small dashboard and the settings, side by side in
// one sidebar. It opens centred from the tray, the tray menu and the widget.

import { listen } from "@tauri-apps/api/event";
import {
  Activity, AppWindow, ArrowUpRight, Bell, Gauge, Info, Layers, LayoutDashboard, type LucideIcon, Palette, Plug,
  SquareTerminal, TriangleAlert, X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Mark } from "./components/Mark";
import { Sparkline, Strip, ago, useAppearance } from "./components/ui";
import { type Page, type Settings, type Spend, desk, hub, tokens, usd } from "./lib/hub";
import { totalLabel, warningLine } from "./lib/model";
import { ProviderLogo, providerName, providerOf } from "./lib/providers";
import { type DeskState, useDesk } from "./lib/useDesk";
import "./styles/app.css";
import { Onboarding } from "./views/Onboarding";
import {
  AboutSection, AlertsSection, AppearanceSection, ConnectionSection, ProvidersSection, type Save, WidgetSection,
} from "./views/Settings";
import { ToolsCard, ToolsView } from "./views/Tools";
import { AlertsView, HeadroomView, NowView } from "./views/Views";

const DASHBOARD: Array<[Page, string, LucideIcon]> = [
  ["overview", "Overview", LayoutDashboard], ["activity", "Activity", Activity], ["tools", "Coding tools", SquareTerminal],
  ["limits", "Limits", Gauge],
  ["alerts", "Alerts", TriangleAlert],
];
const SETTINGS: Array<[Page, string, LucideIcon]> = [
  ["widget", "Widget", AppWindow], ["appearance", "Appearance", Palette], ["providers", "Providers", Layers],
  ["notifications", "Notifications", Bell], ["connection", "Connection", Plug], ["about", "About", Info],
];
const TITLES = Object.fromEntries([...DASHBOARD, ...SETTINGS].map(([p, t]) => [p, t])) as Record<Page, string>;

function fmt(settings: Settings, row: { cost_usd: number; tokens: number } | undefined): string {
  if (!row) return "—";
  return settings.metric === "tokens" ? tokens(row.tokens) : usd(row.cost_usd);
}

// ---------------------------------------------------------------- Overview

/** Week and month totals, re-read now and then (today's come with the live state). */
function usePeriods(paired: boolean): { week: Spend | null; month: Spend | null } {
  const [week, setWeek] = useState<Spend | null>(null);
  const [month, setMonth] = useState<Spend | null>(null);
  useEffect(() => {
    if (!paired) return;
    const load = () => {
      hub.spend("week").then(setWeek).catch(() => undefined);
      hub.spend("month").then(setMonth).catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, [paired]);
  return { week, month };
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

function Overview({ d, s, go }: { d: DeskState; s: Settings; go: (p: Page) => void }) {
  const { week, month } = usePeriods(d.paired);
  const today = d.spend?.total;
  const total = totalLabel(s, d.spend);
  const rows = d.rows.filter(r => r.visible);
  const warn = s.show_alerts ? warningLine(d.alerts, d.rows, s) : null;
  const projects = [...(d.spend?.by_project ?? [])].sort((a, b) => b.cost_usd - a.cost_usd || b.tokens - a.tokens).slice(0, 5);
  const projectMax = Math.max(1e-9, ...projects.map(p => (s.metric === "tokens" ? p.tokens : p.cost_usd)));
  const recent = [...d.finished].reverse().slice(0, 6);

  return (
    <div className="d-page">
      <section className="d-hero">
        <div className="d-hero-total">
          <span className="num d-hero-value">{total.value}</span>
          <span className="d-hero-sub">{total.sub}</span>
        </div>
        <div className="d-stats">
          <Stat label="Calls today" value={String(today?.requests ?? 0)} sub={today?.errors ? `${today.errors} failed` : "no failures"} />
          <Stat label="This week" value={fmt(s, week?.total)} sub={week ? `${week.total.requests} calls` : undefined} />
          <Stat label="This month" value={fmt(s, month?.total)} sub={month ? `${month.total.requests} calls` : undefined} />
        </div>
      </section>

      {warn && <button className="d-warn" onClick={() => go("limits")}><TriangleAlert size={14} aria-hidden /> {warn}</button>}

      <div className="d-grid">
        <section className="d-card">
          <header className="d-card-head">
            <h3>Providers today</h3>
            <button className="d-link" onClick={() => go("providers")}>Budgets</button>
          </header>
          {rows.length === 0 ? (
            <p className="d-empty">
              No calls yet today. Your coding tools (Claude Code, Codex, Kimi Code, …) and anything your code runs through Prompture show up here — tag your code with
              <code className="mono"> PROMPTURE_PROJECT=name</code> to see spend per project.
            </p>
          ) : (
            <div className="d-prov">
              {rows.map(r => (
                <div key={r.id} className="d-prov-row">
                  <ProviderLogo id={r.id} size={28} dim={r.paused} />
                  <div className="d-prov-main">
                    <div className="row between">
                      <span className="d-prov-name">{r.name}{r.paused && <span className="d-tag">paused</span>}</span>
                      <span className="num d-prov-val">{r.value}<span className="d-of"> / {r.budget}</span></span>
                    </div>
                    <Strip pct={r.pct} tone={r.tone} height={5} />
                    {r.rateLabel && <span className="d-prov-sub">{r.rateKind === "plan" ? "Plan" : "Rate window"} {r.rateLabel}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="d-col">
          <ToolsCard settings={s} enabled={!!d.caps.coding_tools} onOpen={() => go("tools")} />
          <section className="d-card">
            <header className="d-card-head"><h3>Projects today</h3></header>
            {projects.length === 0 ? (
              <p className="d-empty">No project tags yet.</p>
            ) : projects.map(p => {
              const v = s.metric === "tokens" ? p.tokens : p.cost_usd;
              return (
                <div key={p.project ?? "-"} className="d-bar-row">
                  <span className="d-bar-name ellipsis">{p.project ?? "untagged"}</span>
                  <span className="d-bar"><span style={{ width: `${(v / projectMax) * 100}%` }} /></span>
                  <span className="num d-bar-val">{fmt(s, p)}</span>
                </div>
              );
            })}
          </section>

          <section className="d-card">
            <header className="d-card-head">
              <h3>Recent calls</h3>
              <button className="d-link" onClick={() => go("activity")}>All activity</button>
            </header>
            <Sparkline events={d.finished} height={32} />
            {recent.length === 0 && <p className="d-empty">Nothing in the last 30 minutes.</p>}
            {recent.map((e, i) => {
              const prov = providerOf(e.served_by ?? e.model);
              return (
                <div key={`${e.request_id}-${i}`} className="d-call">
                  {prov ? <ProviderLogo id={prov} size={18} /> : <span className="d-call-dot" />}
                  <span className="d-call-model mono ellipsis">{e.served_by ?? e.model}</span>
                  <span className="d-call-sub">{[e.key_name, e.project].filter(Boolean).join(" · ") || (prov ? providerName(prov) : "")}</span>
                  {e.status !== "ok"
                    ? <span className="d-tag danger">{e.status}</span>
                    : <span className="num d-call-cost">{usd(e.cost_usd ?? 0)}</span>}
                  <span className="d-call-ago">{ago(e.ts)}</span>
                </div>
              );
            })}
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- window

function DeskWindow() {
  const d = useDesk({ primary: true });
  useAppearance(d.settings);
  const [page, setPage] = useState<Page>("overview");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const offs = [
      listen<Page>("desk://navigate", e => { setAdding(false); setPage(e.payload); }),
      listen("desk://add-hub", () => setAdding(true)),
    ];
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") getCurrentWindow().hide(); };
    window.addEventListener("keydown", onKey);
    return () => { offs.forEach(off => off.then(fn => fn())); window.removeEventListener("keydown", onKey); };
  }, []);

  const s = d.settings;
  if (!s) return <div className="s-window d-loading">Starting…</div>;

  const save: Save = patch => {
    setError(null);
    desk.saveSettings({ ...s, ...patch }).catch(e => setError(String(e)));
  };
  const hide = () => getCurrentWindow().hide();
  const isSettings = isSettingsPage(page);
  // Before setup the dashboard has nothing to show, so it's replaced by onboarding; settings still open.
  const onboarding = adding || (!d.paired && !isSettings);
  const openAlerts = d.alerts.filter(a => !a.acknowledged_at).length;
  const counts: Partial<Record<Page, number>> = { activity: d.running.length, alerts: openAlerts };

  const nav = (items: Array<[Page, string, LucideIcon]>) => items.map(([p, label, Icon]) => (
    <button key={p} className={`s-nav ${!onboarding && page === p ? "active" : ""}`}
      onClick={() => { setAdding(false); setPage(p); }}>
      <Icon className="s-nav-glyph" size={16} strokeWidth={1.75} aria-hidden />
      <span className="grow">{label}</span>
      {!!counts[p] && <span className="d-count">{counts[p]}</span>}
    </button>
  ));

  return (
    <div className="s-window">
      <nav className="s-side" data-tauri-drag-region>
        <div className="d-brand" data-tauri-drag-region>
          <span className="d-brand-row" data-tauri-drag-region>
            <Mark size={26} className="d-logo" />
            <span className="d-brand-name" data-tauri-drag-region>Prompture Desk</span>
          </span>
        </div>
        <span className="d-group">Dashboard</span>
        {nav(DASHBOARD)}
        <span className="d-group">Settings</span>
        {nav(SETTINGS)}
        <span className="grow" data-tauri-drag-region />
        {d.mode === "hub" && <button className="d-link d-side-link" onClick={() => desk.openDashboard()}>Hub dashboard <ArrowUpRight size={13} aria-hidden /></button>}
      </nav>
      <div className="s-main">
        <header className="s-head" data-tauri-drag-region>
          <span data-tauri-drag-region>{onboarding ? (adding ? "Connect a prompture-hub" : "Welcome") : TITLES[page]}</span>
          <button className="s-close" onClick={hide} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="s-body">
          {onboarding ? (
            <div className="d-onboarding">
              <Onboarding onPaired={async () => { setAdding(false); await d.reloadSettings(); setPage("overview"); }} />
            </div>
          ) : (
            <>
              {page === "overview" && <Overview d={d} s={s} go={setPage} />}
              {page === "activity" && <div className="d-view"><NowView d={d} /></div>}
              {page === "tools" && <ToolsView settings={s} enabled={!!d.caps.coding_tools} />}
              {page === "limits" && <div className="d-view"><HeadroomView d={d} /></div>}
              {page === "alerts" && <div className="d-view"><AlertsView d={d} /></div>}
              {page === "widget" && <WidgetSection s={s} save={save} />}
              {page === "appearance" && <AppearanceSection s={s} save={save} />}
              {page === "providers" && <ProvidersSection s={s} save={save} d={d} />}
              {page === "notifications" && <AlertsSection s={s} save={save} />}
              {page === "connection" && <ConnectionSection s={s} save={save} d={d} />}
              {page === "about" && <AboutSection />}
            </>
          )}
        </div>
        {isSettings && !onboarding && (
          <footer className="s-foot">
            <span className={error ? "s-error" : "s-muted"}>{error ?? "Settings save automatically."}</span>
            <button className="s-done" onClick={() => setPage("overview")}>Done</button>
          </footer>
        )}
      </div>
    </div>
  );
}

function isSettingsPage(p: Page): boolean {
  return SETTINGS.some(([q]) => q === p);
}

ReactDOM.createRoot(document.getElementById("root")!).render(<DeskWindow />);
