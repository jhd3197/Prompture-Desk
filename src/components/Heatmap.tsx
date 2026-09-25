// A GitHub-style activity grid: one square per local day, a column per week,
// shaded by how busy the day was (tokens or cost, following Settings › Metric).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Activity, type ActivityDay, type Settings, hub, tokens, usd } from "../lib/hub";

const CELL = 11;
const GAP = 3;
const LABELS_W = 30; // weekday labels column
const MAX_WEEKS = 53;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** YYYY-MM-DD of a local date. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** Load the last year of per-day totals, in this machine's timezone. */
function useActivity(enabled: boolean): Activity | null {
  const [data, setData] = useState<Activity | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => hub.activity(371, new Date().getTimezoneOffset()).then(a => { if (live) setData(a); }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 5 * 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [enabled]);
  return data;
}

/** Longest and current runs of consecutive active days, ending today. */
function streaks(active: Set<string>, today: Date): { current: number; longest: number } {
  let longest = 0;
  let run = 0;
  for (let i = 370; i >= 0; i--) {
    run = active.has(ymd(addDays(today, -i))) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  // Today may simply not have started yet: count from yesterday if today is empty.
  for (let i = active.has(ymd(today)) ? 0 : 1; active.has(ymd(addDays(today, -i))); i++) current++;
  return { current, longest };
}

/**
 * `source` narrows the grid to one contributor ("Prompture", "Claude Code", …);
 * null shows everything. Without `onSource` the grid picks its own filter.
 */
export function ActivityHeatmap({
  settings, enabled, source: controlled, onSource,
}: { settings: Settings; enabled: boolean; source?: string | null; onSource?: (s: string | null) => void }) {
  const raw = useActivity(enabled);
  const [own, setOwn] = useState<string | null>(null);
  const source = onSource ? (controlled ?? null) : own;
  const pick = onSource ?? setOwn;
  // Contributors across the year, busiest first, for the filter chips.
  const names = useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of raw?.days ?? []) for (const s of d.sources) totals.set(s.name, (totals.get(s.name) ?? 0) + s.tokens);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  }, [raw]);
  // The same days, counting only the chosen contributor.
  const data = useMemo<Activity | null>(() => {
    if (!raw || !source) return raw;
    const days = raw.days.flatMap(d => {
      const s = d.sources.find(x => x.name === source);
      return s ? [{ ...d, requests: s.requests, tokens: s.tokens, cost_usd: s.cost_usd ?? 0, sources: [s] }] : [];
    });
    return { ...raw, days };
  }, [raw, source]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ day: ActivityDay | null; date: string; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [data]);

  const byDate = useMemo(() => new Map((data?.days ?? []).map(d => [d.date, d])), [data]);
  const byTokens = settings.metric === "tokens";
  const value = (d: ActivityDay) => (byTokens ? d.tokens : d.cost_usd || d.tokens / 1e9);

  // Shade levels: quartiles of the active days' values, so the scale fits your own usage.
  const thresholds = useMemo(() => {
    const values = (data?.days ?? []).map(value).filter(v => v > 0).sort((a, b) => a - b);
    if (!values.length) return [Infinity, Infinity, Infinity];
    const q = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
    return [q(0.25), q(0.5), q(0.75)];
  }, [data, byTokens]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled || !data) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weeks = Math.max(8, Math.min(MAX_WEEKS, Math.floor((width - LABELS_W + GAP) / (CELL + GAP)) || MAX_WEEKS));
  // Columns run Sunday → Saturday; the last column holds today.
  const start = addDays(today, -today.getDay() - (weeks - 1) * 7);
  const level = (d: ActivityDay | undefined) => {
    if (!d || d.requests === 0) return 0;
    const v = value(d);
    return v <= thresholds[0] ? 1 : v <= thresholds[1] ? 2 : v <= thresholds[2] ? 3 : 4;
  };

  const columns: Array<Array<{ date: string; day: ActivityDay | undefined; future: boolean }>> = [];
  const monthLabels: Array<{ col: number; label: string }> = [];
  let calls = 0;
  let total = 0;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let dow = 0; dow < 7; dow++) {
      const date = addDays(start, w * 7 + dow);
      const key = ymd(date);
      const day = byDate.get(key);
      const future = date > today;
      if (day && !future) {
        calls += day.requests;
        total += byTokens ? day.tokens : day.cost_usd;
      }
      col.push({ date: key, day, future });
      if (date.getDate() === 1 && !future) monthLabels.push({ col: w, label: MONTHS[date.getMonth()] });
    }
    columns.push(col);
  }
  if (!monthLabels.length || monthLabels[0].col > 2) monthLabels.unshift({ col: 0, label: MONTHS[start.getMonth()] });
  const { current, longest } = streaks(new Set([...byDate.keys()]), today);
  const span = weeks >= 52 ? "the last year" : `the last ${Math.round(weeks / 4.35)} months`;

  return (
    <section className="d-card hm">
      <header className="d-card-head">
        <h3>Activity</h3>
        <span className="hm-summary">
          <b className="num">{calls.toLocaleString()}</b> calls · <b className="num">{byTokens ? tokens(total) : usd(total)}</b>{byTokens ? " tokens" : ""} in {span}{source ? ` · ${source}` : ""}
        </span>
      </header>
      {names.length > 1 && (
        <div className="hm-filters hm-filter-row" role="group" aria-label="Show activity for">
          {[null, ...names].map(n => (
            <button key={n ?? "all"} className={`hm-chip ${source === n ? "on" : ""}`} onClick={() => pick(n)}>{n ?? "All"}</button>
          ))}
        </div>
      )}
      <div ref={wrapRef} className="hm-wrap" onMouseLeave={() => setHover(null)}>
        <div className="hm-months" style={{ marginLeft: LABELS_W }}>
          {monthLabels.map(m => <span key={`${m.col}-${m.label}`} style={{ left: m.col * (CELL + GAP) }}>{m.label}</span>)}
        </div>
        <div className="hm-body">
          <div className="hm-days" style={{ width: LABELS_W }}>
            {["", "Mon", "", "Wed", "", "Fri", ""].map((d, i) => <span key={i} style={{ height: CELL }}>{d}</span>)}
          </div>
          <div className="hm-grid">
            {columns.map((col, w) => (
              <div key={w} className="hm-col">
                {col.map(c => (
                  <span
                    key={c.date}
                    className={`hm-cell l${c.future ? "x" : level(c.day)}`}
                    onMouseEnter={e => {
                      if (c.future) return setHover(null);
                      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const host = wrapRef.current!.getBoundingClientRect();
                      setHover({ day: c.day ?? null, date: c.date, x: box.left - host.left + CELL / 2, y: box.top - host.top });
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        {hover && <Tip hover={hover} byTokens={byTokens} width={width} />}
      </div>
      <footer className="hm-foot">
        <span>{current > 0 ? `${current}-day streak` : "No streak going"} · longest {longest} day{longest === 1 ? "" : "s"}</span>
        <span className="hm-legend">Less {[0, 1, 2, 3, 4].map(l => <span key={l} className={`hm-cell l${l}`} />)} More</span>
      </footer>
    </section>
  );
}

function Tip({ hover, byTokens, width }: { hover: { day: ActivityDay | null; date: string; x: number; y: number }; byTokens: boolean; width: number }) {
  const d = hover.day;
  const date = new Date(`${hover.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const left = Math.min(Math.max(hover.x, 110), Math.max(110, width - 110));
  return (
    <div className="hm-tip" style={{ left, top: hover.y }}>
      <div className="hm-tip-title">{d ? `${d.requests.toLocaleString()} calls` : "No calls"} · {date}</div>
      {d && (
        <>
          <div className="hm-tip-sub">{tokens(d.tokens)} tokens{d.cost_usd > 0 ? ` · ${byTokens ? "≈ " : ""}${usd(d.cost_usd)}` : ""}</div>
          {d.sources.slice(0, 3).map(s => (
            <div key={s.name} className="hm-tip-row"><span>{s.name}</span><span className="num">{tokens(s.tokens)}</span></div>
          ))}
        </>
      )}
    </div>
  );
}
