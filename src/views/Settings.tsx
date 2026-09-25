// The settings pages of Desk's window. Each section edits the shared settings
// through `save`; changes apply right away.

import { getVersion } from "@tauri-apps/api/app";
import { ArrowUpRight, Download, GripVertical, LoaderCircle, RefreshCw } from "lucide-react";
import { emit } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { Mark } from "../components/Mark";
import { StarCard } from "../components/StarPrompt";
import { ACCENT_HUES, Segmented, Toggle } from "../components/ui";
import { type ProviderPref, type Settings, desk, parseCount, tokens } from "../lib/hub";
import { providerIds, withNewProviders } from "../lib/model";
import { ProviderLogo, providerName } from "../lib/providers";
import { progress, updater, usePrompture, useUpdater } from "../lib/updater";
import type { DeskState } from "../lib/useDesk";

export type Save = (patch: Partial<Settings>) => void;

function Field({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="s-field">
      <div className="s-field-head">
        <span className="s-field-title">{title}</span>
        {hint && <span className="s-field-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({ label, sub, on, onChange }: { label: string; sub: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="s-toggle-row">
      <div className="s-toggle-text"><span>{label}</span><small>{sub}</small></div>
      <Toggle on={on} onChange={onChange} label={label} />
    </div>
  );
}

// ---------------------------------------------------------------- sections

const STYLE_CARDS: Array<[Settings["widget_style"], string, string, React.CSSProperties]> = [
  ["dock", "Edge dock", "Floats off a screen edge", { right: "10%", top: "18%", width: "12%", height: "58%" }],
  ["capsule", "Top capsule", "Floats under the top edge", { left: "30%", top: "8%", width: "40%", height: "16%" }],
  ["tray", "Tray chip", "Tray icon only", { right: "8%", bottom: "8%", width: "20%", height: "12%" }],
];

export function WidgetSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <Field title="Widget style">
        <div className="s-style-grid">
          {STYLE_CARDS.map(([value, name, sub, box]) => (
            <button key={value} className={`s-style ${s.widget_style === value ? "active" : ""}`} onClick={() => save({ widget_style: value })}>
              <div className="s-style-preview"><div className="s-style-box" style={box} /></div>
              <span className="s-style-name">{name}</span>
              <span className="s-style-sub">{sub}</span>
            </button>
          ))}
        </div>
      </Field>
      <Field title="Show usage as" hint="Tokens suit flat-rate plans.">
        <Segmented label="Show usage as" value={s.metric} options={[["price", "Price"], ["tokens", "Tokens"]]} onChange={v => save({ metric: v })} />
      </Field>
      {s.widget_style !== "tray" && (
        <Field title="Visibility" hint="Tucks into the screen edge until hovered.">
          <Segmented label="Visibility" value={s.visibility} options={[["always", "Always"], ["hover", "Reveal on hover"]]} onChange={v => save({ visibility: v })} />
        </Field>
      )}
      {s.widget_style === "dock" && (
        <Field title="Dock button opens">
          <Segmented label="Dock button opens" value={s.dock_button ?? "overview"} options={[["overview", "Overview"], ["activity", "Activity"], ["tools", "Coding tools"], ["widget", "Settings"]]} onChange={v => save({ dock_button: v })} />
        </Field>
      )}
      {s.widget_style === "dock" && (
        <Field title="Dock edge" hint="Or drag the dock by its total.">
          <Segmented label="Dock edge" value={s.dock_edge} options={[["left", "Left"], ["right", "Right"]]} onChange={v => save({ dock_edge: v })} />
        </Field>
      )}
      <Field title="Detail level" hint="Per platform: compact on macOS, labelled on Windows.">
        <Segmented label="Detail level" value={s.detail} options={[["compact", "Compact"], ["auto", "Per platform"], ["detailed", "Detailed"]]} onChange={v => save({ detail: v })} />
      </Field>
      <div>
        <ToggleRow label="Show alerts in widget" sub="When a limit is close" on={s.show_alerts} onChange={v => save({ show_alerts: v })} />
        <ToggleRow label="Always on top" sub="Stays above full-size windows" on={s.always_on_top} onChange={v => save({ always_on_top: v })} />
        <ToggleRow label="Hide during full-screen apps" sub="Games, video, presentations" on={s.hide_fullscreen} onChange={v => save({ hide_fullscreen: v })} />
        <ToggleRow label="Launch at login" sub="Starts with Windows / macOS" on={s.launch_at_login} onChange={v => save({ launch_at_login: v })} />
      </div>
    </>
  );
}

export function AppearanceSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <Field title="Mode">
        <Segmented label="Mode" value={s.theme} options={[["light", "Light"], ["dark", "Dark"], ["system", "System"]]} onChange={v => save({ theme: v })} />
      </Field>
      <Field title="Accent color">
        <div className="s-swatches">
          {ACCENT_HUES.map((hue, i) => (
            <button key={hue} aria-label={`Accent ${i + 1}`} className={`s-swatch ${s.accent === i ? "active" : ""}`}
              style={{ background: `oklch(0.72 0.15 ${hue})` }} onClick={() => save({ accent: i })} />
          ))}
        </div>
      </Field>
      <Field title="Widget opacity">
        <Segmented label="Widget opacity" value={s.opacity} options={[[100, "100%"], [90, "90%"], [80, "80%"]]} onChange={v => save({ opacity: v })} />
      </Field>
      <Field title="Language" hint="System follows your OS language.">
        <Segmented label="Language" value={s.language ?? "system"} options={[["system", "System"], ["en", "English"], ["es", "Español"], ["zh-CN", "中文"]]} onChange={v => save({ language: v })} />
      </Field>
    </>
  );
}

/** Budget steps for − / +: round amounts from small to very large. */
const TOKEN_STEPS = [10e3, 25e3, 50e3, 100e3, 250e3, 500e3, 1e6, 2e6, 5e6, 10e6, 25e6, 50e6, 100e6, 250e6, 500e6, 1e9, 2e9, 5e9, 10e9];
const USD_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

function step(steps: number[], value: number, dir: 1 | -1): number {
  if (dir > 0) return steps.find(s => s > value * 1.0001) ?? steps[steps.length - 1];
  return [...steps].reverse().find(s => s < value * 0.9999) ?? steps[0];
}

/**
 * A provider's daily budget: − / + step through round amounts (… 500k, 1M, 2M …);
 * the value can still be typed ("2.5M", "750k") for anything in between.
 */
function BudgetInput({ pref, metric, onCommit }: { pref: ProviderPref; metric: Settings["metric"]; onCommit: (p: ProviderPref) => void }) {
  const isTokens = metric === "tokens";
  const value = isTokens ? pref.budget_tokens : pref.budget_usd;
  const show = (v: number) => (isTokens ? tokens(v) : v.toFixed(2));
  const [text, setText] = useState(show(value));
  useEffect(() => setText(show(value)), [value, isTokens]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (n: number) => onCommit(isTokens ? { ...pref, budget_tokens: Math.round(n) } : { ...pref, budget_usd: n });
  const commit = () => {
    const n = isTokens ? parseCount(text) : Number(text.replace(/[$,\s]/g, ""));
    if (n == null || !Number.isFinite(n) || n <= 0) { setText(show(value)); return; }
    set(n);
  };
  const steps = isTokens ? TOKEN_STEPS : USD_STEPS;
  const name = providerName(pref.id);
  return (
    <div className="s-budget" title={isTokens ? "Daily token budget · type 750k, 2.5M or 1B for other amounts" : "Daily budget in US dollars"}>
      <button type="button" className="s-step" onClick={() => set(step(steps, value, -1))} disabled={value <= steps[0]} aria-label={`Lower ${name}'s daily budget`}>−</button>
      <span className="s-budget-unit">{isTokens ? "tok" : "$"}</span>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); set(step(steps, value, e.key === "ArrowUp" ? 1 : -1)); }
        }}
        aria-label={`${name} daily budget`}
      />
      <button type="button" className="s-step" onClick={() => set(step(steps, value, 1))} aria-label={`Raise ${name}'s daily budget`}>+</button>
    </div>
  );
}

export function ProvidersSection({ s, save, d }: { s: Settings; save: Save; d: DeskState }) {
  const prefs = withNewProviders(s, providerIds(s, d.spend, d.limits, d.running));
  const put = (next: ProviderPref[]) => save({ providers: next });
  // Reordering uses pointer events: the webview's file-drop handling swallows
  // HTML drag and drop. The order is local while dragging and saved on release.
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const shown = order ? order.map(id => prefs.find(p => p.id === id)!).filter(Boolean) : prefs;

  const onGripDown = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(id);
    setOrder(prefs.map(p => p.id));
  };
  const onGripMove = (e: React.PointerEvent) => {
    if (!dragging || !order || !listRef.current) return;
    const rows = Array.from(listRef.current.children) as HTMLElement[];
    // The row under the pointer takes the dragged one's place.
    const below = rows.findIndex(r => e.clientY < r.getBoundingClientRect().bottom);
    const to = below === -1 ? rows.length - 1 : below;
    const from = order.indexOf(dragging);
    if (to === from) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, dragging);
    setOrder(next);
  };
  const onGripUp = () => {
    if (order && order.join() !== prefs.map(p => p.id).join()) put(shown);
    setDragging(null);
    setOrder(null);
  };

  return (
    <>
      <ToggleRow label="Hide unused providers" sub="Only show providers used today" on={s.hide_unused ?? true} onChange={v => save({ hide_unused: v })} />
      <Field title="Providers in the widget" hint="Drag to reorder. Budgets are daily.">
        {prefs.length === 0 ? (
          <div className="s-empty">Providers appear here once calls go through {d.mode === "hub" ? "the hub" : "Prompture"}.</div>
        ) : (
          <div className="s-list" ref={listRef}>
            {shown.map(p => {
              const row = d.rows.find(r => r.id === p.id);
              const used = row && (row.tokens > 0 || row.spendUsd > 0);
              return (
                <div key={p.id} className={`s-list-row ${dragging === p.id ? "dragging" : ""}`}>
                  <span className="s-grip" onPointerDown={e => onGripDown(e, p.id)} onPointerMove={onGripMove}
                    onPointerUp={onGripUp} onPointerCancel={onGripUp} title="Drag to reorder">
                    <GripVertical size={16} aria-hidden />
                  </span>
                  <ProviderLogo id={p.id} size={28} />
                  <span className="s-list-name">{providerName(p.id)}
                    <small>{used ? `${row.value} today` : "Not used today"}</small>
                  </span>
                  <BudgetInput pref={p} metric={s.metric} onCommit={np => put(prefs.map(x => (x.id === np.id ? np : x)))} />
                  <Toggle label={`Show ${providerName(p.id)}`} on={p.visible} onChange={v => put(prefs.map(x => (x.id === p.id ? { ...x, visible: v } : x)))} />
                </div>
              );
            })}
          </div>
        )}
      </Field>
    </>
  );
}

export function AlertsSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <Field title="Warn at" hint="Strips turn amber past this.">
        <Segmented label="Warn at" value={s.warn_at} options={[[70, "70%"], [85, "85%"], [95, "95%"]]} onChange={v => save({ warn_at: v })} />
      </Field>
      <div>
        <ToggleRow label="Notify on hub alerts" sub="From the hub's alert rules" on={s.notify_alerts} onChange={v => save({ notify_alerts: v })} />
        <ToggleRow label="Notify when a key or provider is paused" sub="Including hitting its spend cap" on={s.notify_paused} onChange={v => save({ notify_paused: v })} />
        <ToggleRow label="Notify when long calls finish" sub="Calls over 30s" on={s.notify_long_calls} onChange={v => save({ notify_long_calls: v })} />
        <ToggleRow label="Notify on failed calls" sub="Every call that ends in an error" on={s.notify_errors} onChange={v => save({ notify_errors: v })} />
        <ToggleRow label="Play a sound" sub="Uses the system alert sound" on={s.play_sound} onChange={v => { save({ play_sound: v }); if (v) desk.playAlertSound(); }} />
      </div>
      <button className="s-link" onClick={() => desk.openDashboard()}>Edit alert rules in the hub dashboard <ArrowUpRight size={13} aria-hidden /></button>
    </>
  );
}

export function ConnectionSection({ s, save, d }: { s: Settings; save: Save; d: DeskState }) {
  const [test, setTest] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const active = s.hubs.find(h => h.id === s.active_hub);
  const isLocal = active?.kind === "local";
  const runTest = async () => {
    if (!active) return;
    setTest("Testing…");
    try {
      const res = isLocal ? await desk.connectLocal() : await desk.probe(active.url);
      setTest(`Reachable · ${res.info.service} v${res.info.version}`);
    } catch (e) {
      setTest(typeof e === "object" && e && "message" in e ? String((e as { message: string }).message) : String(e));
    }
  };
  const useLocal = async () => {
    setSwitching("Starting Prompture on this PC…");
    try {
      await desk.connectLocal();
      setSwitching(null);
    } catch (e) {
      setSwitching(typeof e === "object" && e && "message" in e ? String((e as { message: string }).message) : String(e));
    }
  };
  const dot = d.status.state === "live" ? "live" : d.status.state === "unauthorized" || d.status.state === "idle" ? "off" : "wait";
  return (
    <>
      <Field title={isLocal ? "Prompture on this PC" : "Hub address"}>
        <div className="row" style={{ gap: 10 }}>
          <div className="s-addr num">{active?.url ?? "Not connected"}</div>
          <span className="row" style={{ gap: 6 }}><span className={`dot ${dot}`} /><span className="s-muted">{d.status.state}</span></span>
          <button className="s-btn" onClick={runTest} disabled={!active}>Test</button>
        </div>
        {test && <span className="s-field-hint">{test}</span>}
      </Field>
      {isLocal && (
        <div className="s-empty" style={{ textAlign: "left" }}>
          A prompture-hub adds running calls, per-key caps, alert rules and controls.
        </div>
      )}
      {s.hubs.filter(h => h.id !== s.active_hub).length > 0 && (
        <Field title="Other connections">
          <div className="s-list">
            {s.hubs.filter(h => h.id !== s.active_hub).map(h => (
              <div key={h.id} className="s-list-row">
                <span className="s-list-name">{h.name}<small className="num">{h.kind === "local" ? "this PC" : h.url}</small></span>
                <button className="s-btn" onClick={() => desk.selectHub(h.id)}>Use</button>
                <button className="s-btn ghost" onClick={() => desk.removeHub(h.id)}>Forget</button>
              </div>
            ))}
          </div>
        </Field>
      )}
      <div className="row" style={{ gap: 8 }}>
        {!isLocal && !s.hubs.some(h => h.kind === "local") && <button className="s-btn" onClick={useLocal}>Use Prompture on this PC</button>}
        <button className="s-btn" onClick={() => emit("desk://add-hub")}>
          {isLocal ? "Connect a prompture-hub" : "Pair another hub"}
        </button>
        {active && !isLocal && <button className="s-btn ghost" onClick={() => desk.removeHub(active.id)}>Forget this hub</button>}
      </div>
      {switching && <span className="s-field-hint">{switching}</span>}
      <Field title="Refresh every" hint="How often spend and limits are re-read.">
        <Segmented label="Refresh every" value={s.refresh_secs} options={[[1, "1s"], [5, "5s"], [15, "15s"]]} onChange={v => save({ refresh_secs: v })} />
      </Field>
    </>
  );
}

export function AboutSection({ s, save, d }: { s: Settings; save: Save; d: DeskState }) {
  const [version, setVersion] = useState("");
  useEffect(() => { getVersion().then(setVersion).catch(() => undefined); }, []);
  const platform = navigator.userAgent.includes("Windows") ? "Windows" : navigator.userAgent.includes("Mac") ? "macOS" : "Linux";
  return (
    <>
      <div className="row" style={{ gap: 14 }}>
        <Mark size={48} className="s-about-mark" />
        <div className="s-about">
          <span className="s-about-name">Prompture Desk</span>
          <span className="num s-muted">v{version} · {platform}</span>
        </div>
      </div>
      <StarCard />
      <DeskUpdates />
      {d.mode === "local" && <PromptureUpdates s={s} save={save} d={d} />}
      <p className="s-muted" style={{ margin: 0, fontSize: 12 }}>
        Built on Prompture. Provider logos from LobeHub Icons (MIT), interface icons from Lucide (ISC).
      </p>
    </>
  );
}

/** Desk's own updates: check, download with progress, restart. */
function DeskUpdates() {
  const u = useUpdater();
  const pct = progress(u);
  const line = u.status === "available" ? `Prompture Desk ${u.version} is available.`
    : u.status === "downloading" ? (pct != null ? `Downloading update… ${pct}%` : "Downloading update…")
      : u.status === "ready" ? "Restart to finish updating."
        : u.status === "checking" ? "Checking…"
          : u.status === "error" ? u.error ?? "Update check failed."
            : u.status === "current" ? "You're on the latest version." : null;
  return (
    <Field title="Updates">
      <div className="s-update">
        <span className={`grow ${u.status === "error" ? "s-error" : "s-muted"}`}>{line}</span>
        {u.status === "available" && <button className="s-btn primary" onClick={() => updater.install()}><Download size={14} aria-hidden /> Download &amp; install</button>}
        {u.status === "ready" && <button className="s-btn primary" onClick={() => updater.restart()}><RefreshCw size={14} aria-hidden /> Restart now</button>}
        {(u.status === "idle" || u.status === "current" || u.status === "error" || u.status === "checking") && (
          <button className="s-btn" disabled={u.status === "checking"} onClick={() => updater.check(false)}>Check for updates</button>
        )}
      </div>
    </Field>
  );
}

/** The Prompture behind local mode: its version, and how Desk keeps its own copy current. */
function PromptureUpdates({ s, save, d }: { s: Settings; save: Save; d: DeskState }) {
  const p = usePrompture(true, `${d.status.state}|${s.prompture_updates}`);
  const st = p.status;
  const line = !st?.version ? "Not running"
    : st.update_available ? `Prompture ${st.latest} is available.`
      : st.latest ? "Up to date" : null;
  return (
    <Field title="Prompture updates">
      <div className="s-update">
        <span className="grow stack" style={{ gap: 2 }}>
          <span className="num">{st?.version ? `v${st.version}` : "—"}{st?.source && <span className="s-muted"> · {st.source === "desk" ? "Desk's own copy" : "Installed by you"}</span>}</span>
          {line && <span className="s-muted" style={{ fontSize: 12 }}>{line}</span>}
          {st?.update_available && st.source === "system" && <span className="s-muted" style={{ fontSize: 12 }}>Update with pipx upgrade prompture.</span>}
          {p.error && <span className="s-error" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{p.error}</span>}
        </span>
        {st?.update_available && st.source === "desk" ? (
          <button className="s-btn primary" disabled={!!p.busy} onClick={p.update}>
            {p.busy === "updating" ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Download size={14} aria-hidden />} Update now
          </button>
        ) : (
          <button className="s-btn" disabled={!!p.busy || s.prompture_updates === "off"} onClick={p.recheck}>
            {p.busy === "checking" ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>
      <Segmented label="Prompture updates" value={s.prompture_updates ?? "auto"}
        options={[["auto", "Automatic"], ["ask", "Ask"], ["off", "Off"]]} onChange={v => save({ prompture_updates: v })} />
    </Field>
  );
}
