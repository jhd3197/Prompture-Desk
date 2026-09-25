// Prompture Desk's window: a small dashboard and the settings, side by side in
// one sidebar. It opens centred from the tray, the tray menu and the widget.

import { listen } from "@tauri-apps/api/event";
import {
  Activity, AppWindow, ArrowUpRight, Bell, Gauge, Info, Layers, LayoutDashboard, type LucideIcon, Palette, Plug,
  Settings as Gear, SquareTerminal, TriangleAlert, X, ChevronLeft,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ActivityHeatmap } from "./components/Heatmap";
import { Mark } from "./components/Mark";
import { StarButton, StarCard } from "./components/StarPrompt";
import { Sparkline, Strip, ago, useAppearance } from "./components/ui";
import { type Page, type Settings, type Spend, count, desk, hub, tokens, usd } from "./lib/hub";
import { activeRows, totalLabel, warningLine } from "./lib/model";
import { ProviderLogo, providerName, providerOf } from "./lib/providers";
import { progress, updater, usePrompture, useUpdater } from "./lib/updater";
import { type DeskState, useDesk } from "./lib/useDesk";
import "./styles/app.css";
import { Onboarding } from "./views/Onboarding";
import {
  AboutSection, AlertsSection, AppearanceSection, ConnectionSection, ProvidersSection, type Save, WidgetSection,
} from "./views/Settings";
import { ToolsCard, ToolsView } from "./views/Tools";
import { ActivityPage } from "./views/ActivityPage";
import { AlertsView, HeadroomView } from "./views/Views";

const DASHBOARD: Array<[Page, string, LucideIcon]> = [
  ["overview", "Overview", LayoutDashboard], ["activity", "Activity", Activity], ["tools", "Coding tools", SquareTerminal],
  ["providers", "Providers", Layers], ["limits", "Limits", Gauge], ["alerts", "Alerts", TriangleAlert],
];
const SETTINGS: Array<[Page, string, LucideIcon]> = [
  ["widget", "Widget", AppWindow], ["appearance", "Appearance", Palette],
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
  const rows = activeRows(d.rows, s);
  const warn = s.show_alerts ? warningLine(d.alerts, d.rows, s) : null;
  const projects = [...(d.spend?.by_project ?? [])].sort((a, b) => b.cost_usd - a.cost_usd || b.tokens - a.tokens).slice(0, 5);
  const projectMax = Math.max(1e-9, ...projects.map(p => (s.metric === "tokens" ? p.tokens : p.cost_usd)));
  const recent = [...d.finished].reverse().slice(0, 6);
  // One contributor to show in the activity grid; null = everything.
  const [source, setSource] = useState<string | null>(null);

  return (
    <div className="d-page">
      <section className="d-hero">
        <div className="d-hero-total">
          <span className="num d-hero-value">{total.value}</span>
          <span className="d-hero-sub">{total.sub}</span>
        </div>
        <div className="d-stats">
          <Stat label="Calls today" value={count(today?.requests ?? 0)} sub={today?.errors ? `${count(today.errors)} failed` : "no failures"} />
          <Stat label="This week" value={fmt(s, week?.total)} sub={week ? `${count(week.total.requests)} calls` : undefined} />
          <Stat label="This month" value={fmt(s, month?.total)} sub={month ? `${count(month.total.requests)} calls` : undefined} />
        </div>
      </section>

      <ActivityHeatmap settings={s} enabled={!!d.caps.activity} source={source} onSource={setSource} />

      {warn && <button className="d-warn" onClick={() => go("limits")}><TriangleAlert size={14} aria-hidden /> {warn}</button>}

      <div className="d-grid">
        <section className="d-card">
          <header className="d-card-head">
            <h3>Providers today</h3>
            <button className="d-link" onClick={() => go("providers")}>Budgets</button>
          </header>
          {rows.length === 0 ? (
            <p className="d-empty">
              No calls yet today. Set <code className="mono">PROMPTURE_PROJECT=name</code> to split spend by project.
            </p>
          ) : (
            <div className="d-prov">
              {rows.map(r => (
                <div key={r.id} className="d-prov-row">
                  <ProviderLogo id={r.id} size={28} dim={r.paused} />
                  <div className="d-prov-main">
                    <div className="row between">
                      <span className="d-prov-name">{r.name}{r.paused && <span className="d-tag">paused</span>}</span>
                      <span className="num d-prov-val">{r.value}{r.meter === "budget" && <span className="d-of"> / {r.budget}</span>}</span>
                    </div>
                    {r.meter !== "none" && <Strip pct={r.pct} tone={r.tone} height={5} />}
                    {r.meter === "none" && <span className="d-prov-sub">Subscription use · no limit known</span>}
                    {r.rateLabel && <span className="d-prov-sub">{r.rateKind === "plan" ? "Plan ·" : "Rate window"} {r.rateLabel}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="d-col">
          <ToolsCard settings={s} enabled={!!d.caps.coding_tools} onOpen={() => go("tools")} selected={source} onSelect={setSource} />
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

// ---------------------------------------------------------------- updates

/** Desk's update checks: at launch when due, then hourly (Desk lives in the tray for days). */
function useUpdateChecks() {
  useEffect(() => {
    updater.checkIfDue();
    const t = window.setInterval(() => updater.checkIfDue(), 60 * 60 * 1000);
    return () => window.clearInterval(t);
  }, []);
}

/** A small prompt at the foot of the sidebar: a Desk update, or (in "ask" mode) a Prompture one. */
function UpdatePrompt({ d, s }: { d: DeskState; s: Settings }) {
  const u = useUpdater();
  const ask = d.mode === "local" && s.prompture_updates === "ask";
  const p = usePrompture(ask, d.status.state);
  const [hidePrompture, setHidePrompture] = useState(false);

  if (!u.dismissed && (u.status === "available" || u.status === "downloading" || u.status === "ready")) {
    const pct = progress(u);
    return (
      <div className="d-update">
        <div className="d-update-row">
          <span>{u.status === "ready" ? "Restart to finish updating." : `Update to ${u.version}`}</span>
          {u.status === "available" && <button className="d-update-x" onClick={() => updater.dismiss()} title="Not now"><X size={13} /></button>}
        </div>
        {u.status === "downloading" && <div className="d-update-bar"><span style={{ width: `${pct ?? 30}%` }} /></div>}
        {u.status === "available" && <button className="d-link" onClick={() => updater.install()}>Download &amp; install</button>}
        {u.status === "ready" && <button className="d-link" onClick={() => updater.restart()}>Restart now</button>}
      </div>
    );
  }
  const st = p.status;
  if (ask && !hidePrompture && st?.update_available && st.source === "desk") {
    return (
      <div className="d-update">
        <div className="d-update-row">
          <span>{`Prompture ${st.latest} is available.`}</span>
          {!p.busy && <button className="d-update-x" onClick={() => setHidePrompture(true)} title="Not now"><X size={13} /></button>}
        </div>
        {p.error && <span className="s-error">{p.error}</span>}
        <button className="d-link" disabled={!!p.busy} onClick={p.update}>{p.busy === "updating" ? "Updating Prompture…" : "Update now"}</button>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------- window

function DeskWindow() {
  const d = useDesk({ primary: true });
  useAppearance(d.settings);
  useUpdateChecks();
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
            <span className="d-brand-name grow" data-tauri-drag-region>Prompture Desk</span>
            <StarButton />
          </span>
        </div>
        {isSettings && !onboarding ? (
          <>
            <button className="d-back" onClick={() => setPage("overview")}><ChevronLeft size={16} aria-hidden /> Settings</button>
            {nav(SETTINGS)}
          </>
        ) : nav(DASHBOARD)}
        <span className="grow" data-tauri-drag-region />
        <UpdatePrompt d={d} s={s} />
        {!isSettings && <StarCard compact />}
        {d.mode === "hub" && !isSettings && <button className="d-link d-side-link" onClick={() => desk.openDashboard()}>Hub dashboard <ArrowUpRight size={13} aria-hidden /></button>}
        {!isSettings && (
          <button className={`s-nav d-gear`} onClick={() => { setAdding(false); setPage("widget"); }}>
            <Gear className="s-nav-glyph" size={16} strokeWidth={1.75} aria-hidden />
            <span className="grow">Settings</span>
          </button>
        )}
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
              {page === "activity" && <ActivityPage d={d} settings={s} />}
              {page === "tools" && <ToolsView settings={s} enabled={!!d.caps.coding_tools} />}
              {page === "limits" && <div className="d-view"><HeadroomView d={d} /></div>}
              {page === "alerts" && <div className="d-view"><AlertsView d={d} /></div>}
              {page === "widget" && <WidgetSection s={s} save={save} />}
              {page === "appearance" && <AppearanceSection s={s} save={save} />}
              {page === "providers" && <ProvidersSection s={s} save={save} d={d} />}
              {page === "notifications" && <AlertsSection s={s} save={save} />}
              {page === "connection" && <ConnectionSection s={s} save={save} d={d} />}
              {page === "about" && <AboutSection s={s} save={save} d={d} />}
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
