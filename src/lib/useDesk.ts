// One hook that keeps a window's view of the hub current: settings, live
// stream, running calls, and polled limits / spend / alerts.
//
// Every window uses it. Only the panel (the "primary" window, always loaded
// even while hidden) drives the tray icon, notifications and sounds, so they
// fire once rather than once per window.
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted, requestPermission, sendNotification,
} from "@tauri-apps/plugin-notification";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Alert, type Capabilities, type LiveEvent, type LiveStatus, type Limits, type Settings, type Spend,
  HUB_CAPABILITIES, desk, hub,
} from "./hub";
import { type ProviderRow, providerRows, totalLabel } from "./model";

/** Finished calls kept for the activity sparkline. */
const HISTORY_MS = 30 * 60_000;
const LONG_CALL_MS = 30_000;

export interface DeskState {
  settings: Settings | null;
  paired: boolean;
  status: LiveStatus;
  /** What Desk is doing to get Prompture ready (first-run setup, an update), else null. */
  setup: string | null;
  running: LiveEvent[];
  finished: LiveEvent[];
  limits: Limits | null;
  spend: Spend | null;
  alerts: Alert[];
  rows: ProviderRow[];
  /** "local" (Prompture on this PC) or "hub". */
  mode: "local" | "hub" | null;
  caps: Capabilities;
  error: string | null;
  refresh: () => void;
  reloadSettings: () => Promise<void>;
}

export function useDesk({ primary }: { primary: boolean }): DeskState {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [paired, setPaired] = useState(false);
  const [status, setStatus] = useState<LiveStatus>({ state: "connecting", message: null });
  const [setup, setSetup] = useState<string | null>(null);
  const [running, setRunning] = useState<Record<string, LiveEvent>>({});
  const [finished, setFinished] = useState<LiveEvent[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [caps, setCaps] = useState<Capabilities>(HUB_CAPABILITIES);
  const settingsRef = useRef<Settings | null>(null);
  const spendTimer = useRef<number | undefined>(undefined);

  const reloadSettings = useCallback(async () => {
    const res = await desk.settings();
    settingsRef.current = res.settings;
    setSettings(res.settings);
    setPaired(res.paired);
  }, []);

  const loadLimits = useCallback(() => {
    hub.limits().then(l => { setLimits(l); setError(null); }).catch(e => setError(String(e)));
  }, []);
  const loadSpend = useCallback(() => { hub.spend("day").then(setSpend).catch(() => undefined); }, []);
  const loadAlerts = useCallback(() => { hub.alerts().then(setAlerts).catch(() => undefined); }, []);
  const refresh = useCallback(() => { loadLimits(); loadSpend(); loadAlerts(); }, [loadLimits, loadSpend, loadAlerts]);

  const notify = useCallback(async (title: string, body: string) => {
    if (!primary) return;
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
    if (settingsRef.current?.play_sound) desk.playAlertSound().catch(() => undefined);
  }, [primary]);

  useEffect(() => {
    // A window can load before the app has finished starting; keep asking until it answers.
    let timer: number | undefined;
    const first = (delay: number) => {
      reloadSettings().catch(() => { timer = window.setTimeout(() => first(Math.min(delay * 2, 2000)), delay); });
    };
    first(100);
    const off = listen("desk://settings", () => { reloadSettings().catch(() => undefined); });
    return () => { window.clearTimeout(timer); off.then(fn => fn()); };
  }, [reloadSettings]);

  const active = settings?.hubs.find(h => h.id === settings.active_hub) ?? null;
  const mode = active ? active.kind : null;

  // What the active connection can do (the local companion has no controls).
  useEffect(() => {
    if (!paired || !active) return;
    let cancelled = false;
    const load = () => hub.info()
      .then(info => { if (!cancelled) setCaps(info.capabilities ?? HUB_CAPABILITIES); })
      .catch(() => { if (!cancelled) window.setTimeout(load, 3000); });
    load();
    return () => { cancelled = true; };
  }, [paired, active?.id, active?.url]);

  // Poll the slower-moving views while paired, at the chosen rate.
  const refreshSecs = settings?.refresh_secs ?? 5;
  useEffect(() => {
    if (!paired) return;
    refresh();
    const timer = window.setInterval(refresh, Math.max(1, refreshSecs) * 1000);
    return () => window.clearInterval(timer);
  }, [paired, refresh, refreshSecs]);

  useEffect(() => {
    // The stream may have connected before this window loaded.
    desk.liveStatus().then(setStatus).catch(() => undefined);
    const unlisten = [
      listen<LiveStatus>("hub://status", e => setStatus(e.payload)),
      listen<string | null>("desk://local-setup", e => setSetup(e.payload)),
      listen<LiveEvent>("hub://live", e => {
        const ev = e.payload;
        const prefs = settingsRef.current;
        switch (ev.type) {
          case "snapshot":
            setRunning(Object.fromEntries((ev.running ?? []).map(r => [r.request_id as string, r])));
            break;
          case "request.started":
            if (ev.request_id) setRunning(r => ({ ...r, [ev.request_id as string]: ev }));
            break;
          case "request.first_token":
          case "request.activity":
            if (ev.request_id) {
              const id = ev.request_id;
              setRunning(r => (r[id] ? { ...r, [id]: { ...r[id], ...ev, type: "request.started" } } : r));
            }
            break;
          case "request.finished": {
            if (ev.request_id) {
              const id = ev.request_id;
              setRunning(r => { const next = { ...r }; delete next[id]; return next; });
            }
            const cutoff = Date.now() - HISTORY_MS;
            setFinished(f => [...f.filter(x => Date.parse(x.ts ?? "") > cutoff), ev]);
            window.clearTimeout(spendTimer.current);
            spendTimer.current = window.setTimeout(loadSpend, 1500);
            const who = `${ev.model ?? "A call"}${ev.project ? ` (${ev.project})` : ""}`;
            if (ev.status === "quota_exceeded" && prefs?.notify_paused) {
              notify("Spend cap reached", `${ev.project ?? ev.key_name ?? "A key"} hit its cap; calls are being refused.`);
            } else if (ev.status === "error" && prefs?.notify_errors) {
              notify("Call failed", `${who} failed.`);
            } else if (ev.status === "ok" && prefs?.notify_long_calls && (ev.latency_ms ?? 0) > LONG_CALL_MS) {
              notify("Long call finished", `${who} took ${Math.round((ev.latency_ms ?? 0) / 1000)}s.`);
            }
            break;
          }
          case "alert.fired":
            loadAlerts();
            if (prefs?.notify_alerts) notify(`Prompture: ${ev.rule ?? "alert"}`, String(ev.message ?? ""));
            break;
          case "key.updated": {
            loadLimits();
            const changes = (ev.changes ?? {}) as { paused?: boolean };
            if (changes.paused && prefs?.notify_paused) notify("Key paused", `${ev.key_name ?? "A key"} is paused.`);
            break;
          }
          case "provider.updated":
            loadLimits();
            if (ev.paused && prefs?.notify_paused) notify("Provider paused", `${ev.provider} is paused on the hub.`);
            break;
        }
      }),
    ];
    return () => { unlisten.forEach(p => p.then(fn => fn())); };
  }, [notify, loadSpend, loadAlerts, loadLimits]);

  const runningList = useMemo(
    () => Object.values(running).sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? "")),
    [running],
  );
  const rows = useMemo(
    () => (settings ? providerRows(settings, spend, limits, runningList) : []),
    [settings, spend, limits, runningList],
  );

  // Tray chip, from the panel window only.
  useEffect(() => {
    if (!primary || !settings) return;
    const open = alerts.filter(a => !a.acknowledged_at).length;
    const visible = rows.filter(r => r.visible);
    const offline = !paired || status.state !== "live";
    const warn = visible.some(r => r.tone === "warn");
    const total = totalLabel(settings, spend);
    const parts = offline
      ? [paired ? `Hub ${status.state}` : "Not connected"]
      : [`${total.value} ${total.sub}`, `${runningList.length} running`, `${open} alert${open === 1 ? "" : "s"}`];
    desk.updateTray({
      state: offline ? "offline" : open > 0 || warn ? "attention" : "ok",
      bars: visible.slice(0, 5).map(r => ({ fraction: Math.min(1, r.pct / 100), tone: r.tone })),
      alert: settings.show_alerts && (open > 0 || warn),
      tooltip: `Prompture Desk — ${parts.join(" · ")}`,
    }).catch(() => undefined);
  }, [primary, settings, paired, status.state, alerts, rows, spend, runningList.length]);

  return {
    settings, paired, status, setup, running: runningList, finished, limits, spend, alerts, rows, mode, caps, error,
    refresh, reloadSettings,
  };
}
