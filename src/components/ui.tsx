import { useEffect } from "react";
import type { LiveEvent, Settings } from "../lib/hub";
import { applyUiLanguage } from "../lib/i18n";

/** Accent hues offered in Settings › Appearance (index = Settings.accent). */
export const ACCENT_HUES = [150, 190, 235, 275, 320, 15, 55, 95];

/** Apply light/dark/system mode, the accent hue and the language from settings to this window. */
export function useAppearance(settings: Settings | null) {
  const mode = settings?.theme ?? "system";
  const language = settings?.language;
  useEffect(() => { if (language) applyUiLanguage(language); }, [language]);
  const hue = ACCENT_HUES[settings?.accent ?? 0] ?? ACCENT_HUES[0];
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches);
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
  useEffect(() => {
    document.documentElement.style.setProperty("--accent-h", String(hue));
  }, [hue]);
}

export function Meter({ fraction, invert = false }: { fraction: number; invert?: boolean }) {
  // `fraction` is how full the meter is. For spend, fuller is worse; for
  // headroom (invert), emptier is worse.
  const f = Math.max(0, Math.min(1, fraction));
  const badness = invert ? 1 - f : f;
  const tone = badness >= 0.95 ? "danger" : badness >= 0.8 ? "warn" : "";
  return (
    <div className={`meter ${tone}`} role="meter" aria-valuenow={Math.round(f * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${f * 100}%` }} />
    </div>
  );
}

/** A thin usage strip: `pct` of the width, coloured by tone. */
export function Strip({ pct, tone, width, height = 4 }: { pct: number; tone: string; width?: number | string; height?: number }) {
  return (
    <div className="strip" style={{ width, height, borderRadius: height / 2 }}>
      <div className={`strip-fill tone-${tone}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%`, borderRadius: height / 2 }} />
    </div>
  );
}

/** Requests per minute over the last `minutes`, drawn as a small line. */
export function Sparkline({ events, minutes = 30, height = 28 }: { events: LiveEvent[]; minutes?: number; height?: number }) {
  const now = Date.now();
  const buckets = new Array(minutes).fill(0);
  for (const e of events) {
    const age = Math.floor((now - Date.parse(e.ts ?? "")) / 60_000);
    if (age >= 0 && age < minutes) buckets[minutes - 1 - age] += 1;
  }
  const max = Math.max(1, ...buckets);
  const w = 100;
  const step = w / (minutes - 1);
  const points = buckets.map((v, i) => `${(i * step).toFixed(2)},${(height - 2 - (v / max) * (height - 4)).toFixed(2)}`);
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} style={{ height }} preserveAspectRatio="none" aria-label={`${events.length} calls in the last ${minutes} minutes`}>
      <polyline points={points.join(" ")} fill="none" stroke="var(--ok)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
      <span className="toggle-knob" />
    </button>
  );
}

export function Segmented<T extends string | number>({
  value, options, onChange, label, small = false,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
  label: string;
  /** A tighter variant for card headers. */
  small?: boolean;
}) {
  return (
    <div className={`seg ${small ? "seg-sm" : ""}`} role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? "active" : ""} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}
