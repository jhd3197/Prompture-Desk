import {
  currentMonitor, cursorPosition, getCurrentWindow, LogicalSize, PhysicalPosition, primaryMonitor,
} from "@tauri-apps/api/window";
import { ArrowUpRight, Check, Pause, Play, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Mark } from "./components/Mark";
import { Strip, useAppearance } from "./components/ui";
import { duration, isActive, position, runSeconds, stepLabel, stepSeconds } from "./lib/automations";
import { type Automation, type LiveEvent, type Settings, desk, hub, tokens, usd } from "./lib/hub";
import { type ProviderRow, activeRows, isDetailed, totalLabel, warningLine } from "./lib/model";
import { ProviderLogo, providerName, providerOf } from "./lib/providers";
import { type DeskState, useDesk } from "./lib/useDesk";
import "./styles/app.css";

const PAD = 14; // transparent margin around the widget, room for its shadow
const TOP_GAP = 8; // logical px between the screen top and the island
const VISIBLE_GAP = 10; // logical px between the dock and the screen edge
const IGNORE_MOVES_MS = 600; // our own setPosition also fires move events
const MORPH_MS = 520; // island and dock shape transitions (CSS: .5s / .45s)
const LEAVE_GRACE_MS = 280; // a pointer leaving this briefly doesn't collapse anything
const DONE_MS = 2600; // how long "call finished" shows
const TAB_W = 8; // width of a tucked dock's edge tab (and its hover target)
const QUEUE_DONE_MS = 60_000; // how long a finished queue stays in the capsule

// ---------------------------------------------------------------- shared

type Phase = "setup" | "loading" | "offline" | "idle" | "live";

/** What the widget is showing, before hover and animation. */
function phase(d: DeskState): Phase {
  if (!d.paired) return "setup";
  if (d.status.state === "unauthorized") return "offline";
  if (d.setup || d.status.state !== "live" || !d.spend) return "loading";
  return d.spend.total.requests === 0 && d.running.length === 0 ? "idle" : "live";
}

function phaseTitle(d: DeskState, p: Phase): string {
  switch (p) {
    case "setup": return "Prompture Desk isn't set up yet";
    case "loading": return d.setup ?? (d.status.state === "retrying" ? "Reconnecting…" : "Connecting…");
    case "offline": return d.status.message ?? "Offline";
    case "idle": return "Connected · no calls yet today";
    default: return "Live";
  }
}

/** Hover that survives the window resizing under the pointer: a leave only
 *  counts if, after a short grace period, the pointer is really outside. */
function useHoverIntent() {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const onEnter = useCallback(() => { window.clearTimeout(timer.current); setHovered(true); }, []);
  const onLeave = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const win = getCurrentWindow();
        const [pos, size, at] = [await win.outerPosition(), await win.outerSize(), await cursorPosition()];
        const inside = at.x >= pos.x && at.x < pos.x + size.width && at.y >= pos.y && at.y < pos.y + size.height;
        if (inside) return;
      } catch { /* no cursor position: trust the leave */ }
      setHovered(false);
    }, LEAVE_GRACE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { hovered, onEnter, onLeave };
}

/** A call that just finished, for DONE_MS after it arrives. */
function useJustFinished(d: DeskState): LiveEvent | null {
  const [done, setDone] = useState<LiveEvent | null>(null);
  const seen = useRef<string | null>(null);
  const last = d.finished[d.finished.length - 1];
  useEffect(() => {
    if (!last) return;
    const key = `${last.request_id ?? ""}|${last.id ?? ""}|${last.ts ?? ""}`;
    if (key === seen.current) return;
    seen.current = key;
    // Events replayed on (re)connect are old news.
    if (Date.now() - Date.parse(last.ts ?? "") > 10_000) return;
    setDone(last);
    const t = window.setTimeout(() => setDone(null), DONE_MS);
    return () => window.clearTimeout(t);
  }, [last]);
  return done;
}

function Pulse() { return <span className="pulse-dot" />; }

/** The queue the capsule shows: one running, or one that finished in the last minute. Ticks each second. */
function useQueue(d: DeskState): Automation | null {
  const q = d.automations?.current ?? null;
  const [, tick] = useState(0);
  const recent = q?.status === "finished" && !!q.ended_at && Date.now() - q.ended_at * 1000 < QUEUE_DONE_MS;
  const shown = isActive(q) || recent;
  useEffect(() => {
    if (!shown) return;
    const t = window.setInterval(() => tick(n => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [shown]);
  return shown ? q : null;
}

/** The dock's way into Desk; an amber badge stands in for the old warning dot. */
function DeskButton({ page, warn }: { page: Settings["dock_button"]; warn: string | null }) {
  return (
    <button className="dock-open" title={warn ? `${warn} · open Desk` : "Open Prompture Desk"} onClick={() => desk.open(page)}>
      <Mark size={18} />
      {warn && <span className="dock-open-badge" />}
    </button>
  );
}

/** How much of today's budget the busiest provider has used, 0–1. */
function budgetUsed(d: DeskState): number {
  const top = Math.max(0, ...d.rows.filter(r => r.visible).map(r => r.pct));
  return Math.min(1, top / 100);
}

/** A half-dial: the arc fills and the needle turns with `fraction` (0–1). */
function Gauge({ fraction, warn, size = 26 }: { fraction: number; warn: boolean; size?: number }) {
  const f = Math.max(0, Math.min(1, fraction));
  const r = 10;
  const arc = Math.PI * r; // length of the half circle
  const angle = Math.PI * (1 - f); // needle: left (0) to right (1)
  const nx = 12 + Math.cos(angle) * 7;
  const ny = 13 - Math.sin(angle) * 7;
  return (
    <svg className={`gauge ${warn ? "warn" : ""}`} width={size} height={size * 0.62} viewBox="0 0 24 15" aria-hidden>
      <path className="gauge-track" d="M2 13a10 10 0 0 1 20 0" />
      {f > 0 && <path className="gauge-fill" d="M2 13a10 10 0 0 1 20 0" strokeDasharray={`${arc * f} ${arc}`} />}
      <line className="gauge-needle" x1="12" y1="13" x2={nx.toFixed(2)} y2={ny.toFixed(2)} />
      <circle className="gauge-hub" cx="12" cy="13" r="1.6" />
    </svg>
  );
}
function Spinner() { return <span className="spinner" aria-label="Loading" />; }
function Shimmer({ w }: { w: number }) { return <span className="shim" style={{ width: w }} />; }

// ---------------------------------------------------------------- Top capsule (island)

type Mode = Phase | "sliver" | "done" | "expanded" | "queue";
interface Box { w: number; h: number; r: number; top: number }

const SLIVER: Box = { w: 60, h: 5, r: 3, top: 0 };

/** Keep the transparent window around the island, top-centre, and give it room
 *  to animate: grow the window before the island grows, shrink it after. */
function useIslandWindow(target: Box): Box {
  const [shown, setShown] = useState<Box>(target);
  const current = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  const place = useCallback(async (w: number, h: number) => {
    const win = getCurrentWindow();
    const mon = (await currentMonitor()) ?? (await primaryMonitor());
    if (!mon) return;
    const sf = mon.scaleFactor;
    const wa = mon.workArea;
    await win.setSize(new LogicalSize(w, h));
    await win.setPosition(new PhysicalPosition(Math.round(wa.position.x + (wa.size.width - w * sf) / 2), wa.position.y));
    current.current = { w, h };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const w = target.w + PAD * 2;
    const h = target.top + target.h + PAD;
    const grow = { w: Math.max(current.current.w, w), h: Math.max(current.current.h, h) };
    const timer = window.setTimeout(() => { if (!cancelled) place(w, h); }, MORPH_MS);
    place(grow.w, grow.h).then(() => { if (!cancelled) setShown(target); });
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [place, target.w, target.h, target.r, target.top]); // eslint-disable-line react-hooks/exhaustive-deps

  return shown;
}

function Island({ d, settings }: { d: DeskState; settings: Settings }) {
  const p = phase(d);
  const rows = activeRows(d.rows, settings);
  const detailed = isDetailed(settings);
  const total = totalLabel(settings, d.spend);
  const warn = settings.show_alerts ? warningLine(d.alerts, d.rows, settings) : null;
  const { hovered, onEnter, onLeave } = useHoverIntent();
  const [open, setOpen] = useState(false);
  const done = useJustFinished(d);
  const connected = p === "live" || p === "idle";
  const queue = useQueue(d);
  // A queue waiting on you stays out even when the capsule hides until hovered.
  const needsYou = !!queue && queue.status === "paused";

  // Reveal on hover: leaving closes the panel too.
  useEffect(() => { if (!hovered && settings.visibility === "hover") setOpen(false); }, [hovered, settings.visibility]);
  useEffect(() => { if (!connected) setOpen(false); }, [connected]);

  const tucked = settings.visibility === "hover" && connected && !hovered && !open && !done && !needsYou;
  const mode: Mode = open && connected ? "expanded"
    : queue && connected && !tucked ? "queue"
      : done && connected ? "done" : tucked ? "sliver" : p;

  // Natural size of each layer, so the island can animate between them.
  const layers = useRef<Partial<Record<Mode, HTMLDivElement | null>>>({});
  const [natural, setNatural] = useState<{ w: number; h: number }>({ w: 150, h: 36 });
  useLayoutEffect(() => {
    const el = layers.current[mode];
    if (!el) return;
    const measure = () => setNatural(n => (n.w === el.scrollWidth && n.h === el.scrollHeight ? n : { w: el.scrollWidth, h: el.scrollHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode]);

  const target: Box = mode === "sliver" ? SLIVER
    : mode === "expanded" ? { w: 360, h: natural.h, r: 20, top: TOP_GAP }
      : { w: natural.w, h: 36, r: 18, top: TOP_GAP };
  const box = useIslandWindow(target);

  const onClick = () => {
    if (mode === "queue") desk.open("automations");
    else if (p === "setup") desk.open();
    else if (p === "offline") desk.open("connection");
    else if (connected) setOpen(o => !o);
  };
  const layer = (m: Mode) => ({
    ref: (el: HTMLDivElement | null) => { layers.current[m] = el; },
    className: `isl-layer ${m === "expanded" ? "isl-panel" : ""} ${mode === m ? "on" : ""}`,
    "aria-hidden": mode !== m,
  });
  const doneProvider = providerOf(done?.served_by ?? done?.model) ?? "";
  const doneTokens = Number(done?.prompt_tokens ?? 0) + Number(done?.completion_tokens ?? 0);
  const doneValue = !done ? "" : settings.metric === "tokens" && doneTokens > 0
    ? `${tokens(doneTokens)} tok` : usd(done.cost_usd ?? 0);

  return (
    <div className="island-zone" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div
        className={`island ${mode}`}
        style={{ width: box.w, height: box.h, borderRadius: box.r, top: box.top }}
        onClick={onClick}
        onDoubleClick={() => { if (connected) desk.open("overview"); }}
        title={mode === "sliver" ? phaseTitle(d, p) : connected ? "Click for details · double-click to open Desk" : undefined}
      >
        <div {...layer("setup")}>
          <span className="dot idle" />
          <span className="isl-text">Prompture Desk isn't set up</span>
          <span className="isl-cta">Set up</span>
        </div>
        <div {...layer("loading")} title={phaseTitle(d, p)}>
          <Spinner />
          <span className="shim-stack"><Shimmer w={64} /><Shimmer w={36} /></span>
        </div>
        <div {...layer("offline")}>
          <span className="dot off" />
          <span className="isl-text">Offline</span>
          <span className="isl-sub">{d.status.message ?? ""}</span>
        </div>
        <div {...layer("idle")}>
          <Gauge fraction={budgetUsed(d)} warn={false} size={22} />
          <span className="isl-sub">No calls yet today</span>
        </div>
        <div {...layer("live")}>
          <Pulse />
          <span className="num isl-total">{total.value}</span>
          {rows.length > 0 && <span className="isl-sep" />}
          {rows.map(r => (
            <span key={r.id} className="capsule-item">
              <span className="row" style={{ gap: 4 }}>
                <ProviderLogo id={r.id} size={16} dim={r.paused} />
                {detailed && <span className="num">{Math.round(r.pct)}%</span>}
              </span>
              {r.meter !== "none" && <span className={`tone-${r.tone}`} style={{ width: 16, height: 2, borderRadius: 1 }} />}
            </span>
          ))}
          {warn && <span className="dot wait" title={warn} />}
        </div>
        <div {...layer("done")}>
          <span className="isl-check"><Check size={11} strokeWidth={3} aria-hidden /></span>
          {doneProvider && <ProviderLogo id={doneProvider} size={16} />}
          <span className="isl-text">
            {doneProvider ? providerName(doneProvider) : "Call"} {done?.status === "error" ? "failed" : "finished"}
            {done?.latency_ms != null && ` · ${(done.latency_ms / 1000).toFixed(1)}s`}
          </span>
          <span className="num isl-done-val">{doneValue}</span>
        </div>
        <div {...layer("queue")} title="Open Automations">
          {queue && <QueueLayer run={queue} />}
        </div>
        <div {...layer("expanded")}>
          <div className="isl-head">
            <span className="row" style={{ gap: 8, alignItems: "baseline" }}>
              <span className="num isl-big">{total.value}</span>
              <span className="isl-sub">{total.sub}</span>
            </span>
            <span className="isl-sub">{d.caps.running_calls ? `${d.running.length} running` : `${d.finished.length} calls · 30 min`}</span>
          </div>
          {rows.length === 0 && <div className="isl-sub">No provider traffic yet today.</div>}
          {rows.map(r => (
            <div key={r.id} className="prow">
              <ProviderLogo id={r.id} size={20} dim={r.paused} />
              <span className="prow-name">{r.name}</span>
              <Strip pct={r.pct} tone={r.tone} />
              <span className="num">{r.value}</span>
            </div>
          ))}
          {warn && <div className="warn-line"><TriangleAlert size={12} aria-hidden /> {warn}</div>}
          <div className="expand-foot">
            <span>{phaseTitle(d, p)}</span>
            <button className="link-btn" onClick={e => { e.stopPropagation(); desk.open("overview"); }}>Open Desk <ArrowUpRight size={12} aria-hidden /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "▶ 2/4 · Phase 4 · 14m", with a thin progress line; amber while it waits on you. */
function QueueLayer({ run }: { run: Automation }) {
  const finished = run.status === "finished";
  const paused = run.status === "paused";
  const step = run.steps[Math.min(run.current, run.steps.length - 1)];
  const progress = finished ? 1 : (run.current + 0.5) / Math.max(1, run.steps.length);
  const tone = paused ? "warn" : "ok";
  return (
    <>
      <span className={`isl-q-icon ${tone}`}>
        {paused ? <Pause size={11} aria-hidden /> : finished ? <Check size={11} aria-hidden /> : <Play size={11} aria-hidden />}
      </span>
      <span className={`num isl-q-count ${tone}`}>{position(run)}/{run.steps.length}</span>
      <span className="isl-sub">·</span>
      <span className="isl-text">{finished ? "queue done" : step ? stepLabel(step.text) : ""}</span>
      <span className="isl-sub">·</span>
      <span className="num isl-sub">{duration(finished ? runSeconds(run) : step ? stepSeconds(step) : 0)}</span>
      <span className="isl-q-bar"><span className={`tone-${tone}`} style={{ width: `${(progress * 100).toFixed(1)}%` }} /></span>
    </>
  );
}

// ---------------------------------------------------------------- Edge dock

interface Size { w: number; h: number; railH: number }

/** Keep the dock's transparent window exactly around it, pinned to its edge.
 *  Tucked, the window shrinks to the edge tab. */
function useDockPlacement(
  settings: Settings,
  wrapRef: React.RefObject<HTMLElement>,
  railRef: React.RefObject<HTMLElement>,
  tuckedRef: React.MutableRefObject<boolean>,
) {
  const placedAt = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const place = useCallback(async () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const s = settingsRef.current;
    const railH = (railRef.current ?? wrap).offsetHeight + PAD * 2;
    const tucked = tuckedRef.current;
    const size: Size = tucked
      ? { w: TAB_W, h: railH, railH }
      : { w: wrap.offsetWidth + PAD * 2, h: wrap.offsetHeight + PAD * 2, railH };
    const win = getCurrentWindow();
    const mon = (await currentMonitor()) ?? (await primaryMonitor());
    if (!mon) return;
    const sf = mon.scaleFactor;
    const wa = mon.workArea;
    placedAt.current = Date.now();
    await win.setSize(new LogicalSize(size.w, size.h));
    const right = s.dock_edge === "right";
    const x = tucked
      ? (right ? wa.position.x + wa.size.width - size.w * sf : wa.position.x)
      : right
        ? wa.position.x + wa.size.width - (size.w - PAD + VISIBLE_GAP) * sf
        : wa.position.x + (VISIBLE_GAP - PAD) * sf;
    const room = Math.max(0, wa.size.height - size.railH * sf);
    let y = wa.position.y + Math.min(1, Math.max(0, s.dock_y)) * room;
    y = Math.min(y, wa.position.y + wa.size.height - size.h * sf); // keep an open card on screen
    await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
  }, [wrapRef, railRef, tuckedRef]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { place(); });
    });
    observer.observe(wrap);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [place, wrapRef]);

  useEffect(() => { place(); }, [place, settings.widget_style, settings.dock_edge, settings.dock_y, settings.detail]);

  return { placedAt, place };
}

function ProviderCard({
  row, warnAt, canPause, onChanged,
}: {
  row: ProviderRow;
  warnAt: number;
  canPause: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const tag = row.paused ? ["paused", "paused"] : row.tone === "warn" ? ["warn", "near limit"]
    : row.running ? ["ok", `${row.running} running`] : ["idle", "idle"];
  const toggle = async () => {
    setError(null);
    try {
      await (row.paused ? hub.resumeProvider(row.id) : hub.pauseProvider(row.id));
      onChanged();
    } catch (e) {
      setError(String(e).includes("read scope") ? "Read-only device: pair with control to pause." : String(e));
    }
  };
  return (
    <div className="pcard">
      <div className="card-head">
        <ProviderLogo id={row.id} size={20} />
        <span className="card-name">{row.name}</span>
        <span className={`tag ${tag[0]}`}>{tag[1]}</span>
      </div>
      <div className="card-big">
        <span className="num">{row.value}</span>
        <span>{row.meter === "budget" ? `of ${row.budget} today` : "today"}</span>
      </div>
      {row.meter === "budget" && (
        <div className="kv">
          <div className="kv-top"><span>Daily budget</span><span>{row.value} of {row.budget}</span></div>
          <Strip pct={row.pct} tone={row.paused ? "paused" : row.pct >= warnAt ? "warn" : "ok"} height={5} />
        </div>
      )}
      {row.meter === "none" && <div className="kv-top"><span>Subscription use</span><span>no limit known</span></div>}
      {row.rateUsed != null && (
        <div className="kv">
          <div className="kv-top"><span>{row.rateKind === "plan" ? "Plan" : "Rate window"}</span><span>{row.rateLabel}</span></div>
          <Strip pct={row.rateUsed} tone={row.rateUsed >= warnAt ? "warn" : "ok"} height={5} />
        </div>
      )}
      <div className="card-actions">
        {canPause && <button className="chip-btn" onClick={toggle}>{row.paused ? "Resume" : "Pause"}</button>}
        <button className="link-btn" onClick={() => desk.open("limits")}>Route…</button>
      </div>
      {error && <div className="warn-line" style={{ whiteSpace: "normal" }}>{error}</div>}
    </div>
  );
}

function Dock({ d, settings }: { d: DeskState; settings: Settings }) {
  const p = phase(d);
  // Until the first numbers arrive, the dock is just the spinner: no rows showing 0.
  const rows = p === "live" || p === "idle" ? activeRows(d.rows, settings) : [];
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const detailed = isDetailed(settings);
  const rowH = detailed ? 58 : 54;
  const total = totalLabel(settings, d.spend);
  const right = settings.dock_edge === "right";

  // Reveal on hover: the dock waits off-screen behind a tab of provider bars.
  const intent = useHoverIntent();
  // Tucked, the window is only the edge tab and its transparent margin, so
  // hover is tracked for the whole window rather than for the dock itself.
  useEffect(() => {
    const over = () => intent.onEnter();
    const out = (e: MouseEvent) => { if (!e.relatedTarget) intent.onLeave(); }; // left the window
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    return () => { document.removeEventListener("mouseover", over); document.removeEventListener("mouseout", out); };
  }, [intent.onEnter, intent.onLeave]);
  const reveal = settings.visibility !== "hover" || intent.hovered;
  const tuckedRef = useRef(!reveal);
  const [slid, setSlid] = useState(reveal); // the dock is at its resting place
  const { placedAt, place } = useDockPlacement(settings, wrapRef, railRef, tuckedRef);
  useEffect(() => {
    let cancelled = false;
    if (reveal) {
      tuckedRef.current = false;
      place().then(() => requestAnimationFrame(() => { if (!cancelled) setSlid(true); }));
      return () => { cancelled = true; };
    }
    setSlid(false);
    setHover(null);
    const t = window.setTimeout(() => { tuckedRef.current = true; place(); }, MORPH_MS);
    return () => window.clearTimeout(t);
  }, [reveal, place]);

  // Dragging the total snaps the dock to the nearest edge and remembers its height.
  useEffect(() => {
    let timer: number | undefined;
    const off = getCurrentWindow().onMoved(() => {
      if (Date.now() - placedAt.current < IGNORE_MOVES_MS || tuckedRef.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const win = getCurrentWindow();
        const [pos, size, mon] = [await win.outerPosition(), await win.outerSize(), await currentMonitor()];
        if (!mon || !railRef.current) return;
        const wa = mon.workArea;
        const centre = pos.x + size.width / 2;
        const edge = centre < wa.position.x + wa.size.width / 2 ? "left" : "right";
        const room = Math.max(1, wa.size.height - (railRef.current.offsetHeight + PAD * 2) * mon.scaleFactor);
        const dockY = Math.min(1, Math.max(0, (pos.y - wa.position.y) / room));
        await desk.saveSettings({ ...settings, dock_edge: edge, dock_y: dockY });
      }, 350);
    });
    return () => { window.clearTimeout(timer); off.then(fn => fn()); };
  }, [settings, placedAt]);

  // Opening the card resizes and moves the window, which shifts the layout under
  // the pointer for a moment. Ignore leaves during that, and collapse after a
  // short grace period that re-entering cancels.
  const leaveTimer = useRef<number | undefined>(undefined);
  const onLeave = () => {
    if (Date.now() - placedAt.current < IGNORE_MOVES_MS) return;
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setHover(null), 220);
  };
  const onEnter = () => window.clearTimeout(leaveTimer.current);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  const hovered = hover != null ? rows[hover] : undefined;
  const away = `translateX(${right ? "" : "-"}${140 + PAD}px)`;
  return (
    <div ref={wrapRef} className={`dock-wrap ${settings.dock_edge}`} onMouseLeave={onLeave} onMouseEnter={onEnter}>
      <div className={`dock-tab ${right ? "right" : "left"}`} style={{ opacity: slid ? 0 : 1 }} aria-hidden={slid}>
        {(rows.length ? rows : [null]).map((r, i) => (
          <span key={r?.id ?? i} className={r ? `tone-${r.tone}` : "tone-paused"} />
        ))}
      </div>
      <div ref={railRef} className="dock" style={{ width: detailed ? 62 : 54, transform: slid ? "translateX(0)" : away }}>
        <div className="dock-total" title="Drag to move · double-click for Desk" onMouseDown={e => { if (e.button === 0) getCurrentWindow().startDragging(); }} onDoubleClick={() => desk.open("overview")}>
          {p === "live" ? (
            <>
              <span className="num">{total.value}</span>
              <small>{total.sub}</small>
            </>
          ) : p === "loading" ? (
            <span title={phaseTitle(d, p)}><Spinner /></span>
          ) : (
            <span className="dock-state" title={phaseTitle(d, p)}>
              {p === "idle" ? (
                <Gauge fraction={budgetUsed(d)} warn={false} size={32} />
              ) : (
                <><span className="dot off" /><span className="state-label">Offline</span></>
              )}
            </span>
          )}
        </div>
        <div className="dock-sep" />
        {rows.map((r, i) => (
          <div key={r.id} className={`dock-row ${hover === i ? "hover" : ""}`} style={{ height: rowH }} onMouseEnter={() => setHover(i)}>
            <span style={{ position: "relative" }}>
              <ProviderLogo id={r.id} size={26} dim={r.paused} />
              {r.running > 0 && <span className="run-dot" />}
            </span>
            {r.meter !== "none" && <Strip pct={r.pct} tone={r.tone} width={30} />}
            {detailed && <span className="num">{r.value}</span>}
          </div>
        ))}
        <DeskButton page={settings.dock_button ?? "overview"} warn={settings.show_alerts ? warningLine(d.alerts, d.rows, settings) : null} />
      </div>
      {hovered && slid && (
        <div style={{ marginTop: 10 + 46 + (hover ?? 0) * rowH - 10 }}>
          <ProviderCard row={hovered} warnAt={settings.warn_at} canPause={d.caps.provider_controls} onChanged={d.refresh} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- root

function Widget() {
  const d = useDesk({ primary: false });
  useAppearance(d.settings);
  const s = d.settings;
  if (!s || s.widget_style === "tray") return null;
  return (
    <div className="widget-root" style={{ opacity: s.opacity / 100 }}>
      {s.widget_style === "dock" ? <Dock d={d} settings={s} /> : <Island d={d} settings={s} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Widget />);
