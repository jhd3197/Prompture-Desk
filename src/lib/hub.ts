// Typed wrappers around the Rust commands. Every hub request goes through
// Rust, which holds the device token; the webview never sees it.
import { invoke } from "@tauri-apps/api/core";

export interface HubProfile { id: string; name: string; url: string; kind: "hub" | "local" }

export interface ProviderPref { id: string; visible: boolean; budget_usd: number; budget_tokens: number }

export interface Settings {
  hubs: HubProfile[];
  active_hub: string | null;
  widget_style: "dock" | "capsule" | "tray";
  /** "hover" tucks the widget into a sliver at the screen edge until hovered. */
  visibility: "always" | "hover";
  metric: "price" | "tokens";
  dock_edge: "left" | "right";
  /** The page of Desk the dock's button opens. */
  dock_button: "overview" | "activity" | "tools" | "widget";
  dock_y: number;
  detail: "compact" | "auto" | "detailed";
  show_alerts: boolean;
  always_on_top: boolean;
  hide_fullscreen: boolean;
  launch_at_login: boolean;
  theme: "light" | "dark" | "system";
  accent: number;
  opacity: number;
  providers: ProviderPref[];
  /** Show only providers used today (or with a call running). */
  hide_unused: boolean;
  warn_at: number;
  notify_alerts: boolean;
  notify_errors: boolean;
  notify_paused: boolean;
  notify_long_calls: boolean;
  play_sound: boolean;
  refresh_secs: number;
  language: "system" | "en" | "es" | "zh-CN";
  /** Desk's own Prompture: upgraded daily ("auto"), offered ("ask") or left alone ("off"). */
  prompture_updates: "auto" | "ask" | "off";
}

/** The Prompture behind local mode, against the newest release on PyPI. */
export interface PromptureStatus {
  mode: Settings["prompture_updates"];
  /** "desk": Desk's own copy, which it can update; "system": one the user installed. */
  source: "desk" | "system" | null;
  version: string | null;
  latest: string | null;
  update_available: boolean;
}

export interface Capabilities {
  running_calls: boolean;
  projects: boolean;
  key_controls: boolean;
  provider_controls: boolean;
  alert_rules: boolean;
  /** Local companion only: usage read from coding agents' own logs (/v1/tools). */
  coding_tools?: boolean;
  /** Local companion only: per-day totals for the activity grid (/v1/activity). */
  activity?: boolean;
  /** Local companion only: queued coding-agent steps (/v1/automations). */
  automations?: boolean;
}

export interface HubInfo {
  service: string;
  mode?: "hub" | "local";
  version: string;
  api_version: number;
  features: Record<string, string>;
  capabilities?: Capabilities;
}

/** Hubs from before capabilities were advertised could do everything. */
export const HUB_CAPABILITIES: Capabilities = {
  running_calls: true, projects: true, key_controls: true, provider_controls: true, alert_rules: true, coding_tools: false,
};

/** One row per model or project inside a coding agent's totals. */
export interface ToolBreakdown { model?: string; project?: string | null; requests: number; tokens: number; cost_usd: number }

/** A coding agent's usage for a period, read from its own logs by Prompture. */
export interface ToolUsage {
  agent: string;
  name: string;
  requests: number;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  /** API-equivalent cost; "estimated" from model rates, "reported" by the tool, or "unknown". */
  cost_usd: number;
  cost_source: "reported" | "estimated" | "mixed" | "unknown";
  last_used: string | null;
  models: ToolBreakdown[];
  projects: ToolBreakdown[];
}

/** One local day of usage: Prompture calls plus coding tools. */
export interface ActivityDay {
  date: string; // YYYY-MM-DD, local
  requests: number;
  tokens: number;
  cost_usd: number;
  sources: Array<{ name: string; requests: number; tokens: number; cost_usd?: number }>;
}

/** Per-day totals; only active days are listed. */
export interface Activity { start: string; end: string; days: ActivityDay[] }

export interface InstalledAgent { id: string; name: string; installed: boolean; runnable: boolean; usage: boolean }

export interface Tools {
  period: "day" | "week" | "month";
  start: string;
  agents: ToolUsage[];
  installed: InstalledAgent[];
  /** Whether Claude Code's plan windows are fetched (opt-in; uses Claude Code's login). */
  claude_plan_usage?: boolean;
}

/** One step of an automation queue. */
export interface AutomationStep {
  id: string;
  text: string;
  /** "same" continues the previous step's session; "new" starts fresh. */
  session: "same" | "new";
  status: "waiting" | "running" | "done" | "failed" | "skipped" | "asked" | "stopped";
  started_at: number | null;
  ended_at: number | null;
  duration_s: number;
  cost_usd: number | null;
  tokens: number;
  /** What the agent is doing right now: "Editing src/app.py…". */
  action: string | null;
  /** When the attempt running now started (epoch seconds). */
  running_since: number | null;
  error: string | null;
}

/** A queue: coding-agent steps run one after another in a project folder. */
export interface Automation {
  id: string;
  cwd: string;
  project: string;
  agent: string;
  agent_name: string;
  model: string | null;
  status: "running" | "paused" | "finished" | "failed" | "stopped";
  reason: "ask" | "limit" | "fail" | "cost" | "manual" | null;
  /** Index of the step running or waiting on you. */
  current: number;
  /** Pause requested; takes effect when the running step finishes. */
  pausing: boolean;
  question: string | null;
  resumes_at: number | null;
  created_at: number;
  ended_at: number | null;
  note: string | null;
  stop: { fail: boolean; ask: boolean; limit: boolean; cost_usd: number | null };
  cost_usd: number;
  duration_s: number;
  steps: AutomationStep[];
}

/** A past run, as the history lists it. */
export interface AutomationSummary extends Omit<Automation, "steps"> {
  steps: Array<{ status: AutomationStep["status"]; text: string }>;
  last: string | null;
  last_error: string | null;
}

export interface Automations {
  /** The running queue, or the last one while it's still on screen. */
  current: Automation | null;
  history: AutomationSummary[];
  agents: Array<{ id: string; name: string; installed: boolean }>;
}

export interface NewAutomation {
  cwd: string;
  agent: string;
  model: string | null;
  steps: Array<{ text: string; session: "same" | "new" }>;
  stop: Automation["stop"];
}

export interface LogLine { t: number; text: string; kind: "cmd" | "tool" | "msg" | "ok" | "err" | "info" | "you" }

export type LocalProblem = { code: "not_installed" | "needs_upgrade" | "failed"; message: string };

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type PollResult =
  | { state: "pending" | "slow_down" | "denied" | "expired" }
  | { state: "approved"; scope: string }
  | { state: "failed"; message: string };

export interface KeyLimits {
  id: number;
  name: string;
  default_project: string | null;
  paused: boolean;
  route_override: string | null;
  spend: {
    period: "day" | "week" | "month";
    cap_usd: number;
    spent_usd: number;
    fraction_used: number | null;
    resets_at: string;
  };
  rate: { limit_per_min: number; calls_last_minute: number };
}

export interface LimitWindow { limit: number | null; remaining: number | null; resets_at: number | null }

export interface ProviderLimits {
  target: string;
  /** "headers" for API rate limits; "plan" for a subscription's usage windows (percent units). */
  source?: string;
  /** For plans: the coding tool ("claude-code" | "codex") and the plan's name. */
  tool?: string;
  tool_name?: string;
  plan?: string | null;
  current_headroom: number | null;
  current_window: string | null;
  observed_at: number;
  windows: Record<string, LimitWindow>;
}

export interface AccountLimits {
  source: string;
  provider: string;
  currency: string | null;
  balance: number | null;
  spent: number | null;
  limit: number | null;
  period: string | null;
  error: string | null;
}

export interface Limits {
  generated_at: string;
  keys: KeyLimits[];
  providers: ProviderLimits[] | null;
  accounts: AccountLimits[] | null;
  paused_providers?: string[];
}

export interface SpendRow { requests: number; cost_usd: number; tokens: number; errors: number }

export interface Spend {
  period: "day" | "week" | "month";
  resets_at: string;
  total: SpendRow;
  by_project: Array<SpendRow & { project: string | null }>;
  by_key: Array<SpendRow & { key_id: number; name: string }>;
  by_model: Array<SpendRow & { model: string }>;
}

export interface Alert {
  alert_id: number;
  rule: string | null;
  kind: string;
  subject: string;
  message: string;
  created_at: string;
  acknowledged_at: string | null;
}

/** One event from the hub's /v1/live stream. */
export interface LiveEvent {
  type: string;
  id?: number;
  ts?: string;
  request_id?: string;
  key_id?: number | null;
  key_name?: string;
  model?: string;
  served_by?: string | null;
  routed_to?: string | null;
  project?: string | null;
  endpoint?: string;
  stream?: boolean;
  status?: string;
  state?: "working" | "waiting";
  cost_usd?: number;
  latency_ms?: number;
  ttft_ms?: number | null;
  fallback?: boolean;
  message?: string;
  running?: LiveEvent[];
  [extra: string]: unknown;
}

export interface LiveStatus {
  state: "idle" | "connecting" | "live" | "retrying" | "unauthorized";
  message: string | null;
}

export const desk = {
  settings: () => invoke<{ settings: Settings; paired: boolean }>("get_settings"),
  saveSettings: (prefs: Settings) => invoke<Settings>("save_settings", { prefs }),
  playAlertSound: () => invoke<void>("play_alert_sound"),
  probe: (url: string) => invoke<{ url: string; info: HubInfo }>("probe_hub", { url }),
  discoverLocal: () => invoke<{ url: string; info: HubInfo } | null>("discover_local"),
  /** Use Prompture on this PC; rejects with a LocalProblem. */
  connectLocal: () => invoke<{ url: string; info: HubInfo }>("connect_local"),
  /** `fresh` skips the cached PyPI answer. */
  promptureStatus: (fresh = false) => invoke<PromptureStatus>("prompture_status", { fresh }),
  /** Upgrade Desk's own Prompture and restart it; rejects with a LocalProblem. */
  updatePrompture: () => invoke<PromptureStatus>("update_prompture"),
  startPairing: (url: string, control: boolean) => invoke<DeviceCode>("start_pairing", { url, control }),
  pollPairing: (name?: string) => invoke<PollResult>("poll_pairing", { name }),
  selectHub: (id: string) => invoke<Settings>("select_hub", { id }),
  removeHub: (id: string) => invoke<Settings>("remove_hub", { id }),
  reconnect: () => invoke<void>("reconnect_live"),
  liveStatus: () => invoke<LiveStatus>("live_status"),
  updateTray: (summary: {
    state: string;
    bars: Array<{ fraction: number; tone: "ok" | "warn" | "paused" }>;
    alert: boolean;
    tooltip: string;
  }) => invoke<void>("update_tray", { summary }),
  openDashboard: () => invoke<void>("open_dashboard"),
  /** Open Desk's window, on a sidebar page ("overview", "activity", "widget", …) when given. */
  open: (page?: Page) => invoke<void>("open_desk", { page: page ?? null }),
};

function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return invoke<T>("hub_request", { method, path, body: body ?? null });
}

/** Pages of Desk's window, dashboard first, then settings. */
export type Page =
  | "overview" | "activity" | "tools" | "automations" | "limits" | "alerts"
  | "widget" | "appearance" | "providers" | "notifications" | "connection" | "about";

export const hub = {
  info: () => call<HubInfo>("GET", "/v1/companion/info"),
  limits: () => call<Limits>("GET", "/v1/limits"),
  /** `sources: "api"` leaves coding-tool (subscription) usage out — what budgets measure. */
  spend: (period: "day" | "week" | "month" = "day", sources: "all" | "api" = "all") =>
    call<Spend>("GET", `/v1/spend?period=${period}&tz_offset=${TZ()}${sources === "api" ? "&sources=api" : ""}`),
  setClaudePlan: (enabled: boolean) => call<{ claude_plan_usage: boolean }>("POST", "/v1/tools/claude-plan", { enabled }),
  alerts: () => call<Alert[]>("GET", "/v1/alerts?limit=50"),
  tools: (period: "day" | "week" | "month" = "day") => call<Tools>("GET", `/v1/tools?period=${period}&tz_offset=${TZ()}`),
  /** Calls that finished in the last `minutes` (local companion), to fill views on connect. */
  recent: (minutes: number) => call<LiveEvent[]>("GET", `/v1/recent?minutes=${minutes}`),
  /** `tzOffset` is `Date.getTimezoneOffset()`, so days break at local midnight. */
  activity: (days: number, tzOffset: number) => call<Activity>("GET", `/v1/activity?days=${days}&tz_offset=${tzOffset}`),
  ackAlert: (id: number) => call<Alert>("POST", `/v1/alerts/${id}/ack`),
  automations: () => call<Automations>("GET", "/v1/automations"),
  automationRun: (id: string) => call<Automation>("GET", `/v1/automations/runs/${id}`),
  automationLog: (run: string, step: string) =>
    call<{ lines: LogLine[] }>("GET", `/v1/automations/runs/${run}/steps/${step}/log`),
  /** `/gsd:execute-phase N` for each unchecked phase in the folder's .planning/ROADMAP.md. */
  roadmap: (cwd: string) => call<{ steps: string[] }>("GET", `/v1/automations/roadmap?cwd=${encodeURIComponent(cwd)}`),
  startAutomation: (body: NewAutomation) => call<Automation>("POST", "/v1/automations", body),
  /** Replace the steps that haven't started (ids keep the ones that stay). */
  setSteps: (steps: Array<{ id?: string; text: string; session: "same" | "new" }>) =>
    call<Automation>("POST", "/v1/automations/current/steps", { steps }),
  automationAction: (action: "pause" | "resume" | "skip" | "stop") =>
    call<Automation>("POST", `/v1/automations/current/${action}`, {}),
  answer: (text: string) => call<Automation>("POST", "/v1/automations/current/answer", { text }),
  pauseKey: (id: number) => call<KeyLimits>("POST", `/v1/keys/${id}/pause`),
  resumeKey: (id: number) => call<KeyLimits>("POST", `/v1/keys/${id}/resume`),
  updateKey: (id: number, data: { route_override?: string; daily_spend_cap_usd?: number }) =>
    call<KeyLimits>("PATCH", `/v1/keys/${id}`, data),
  pauseProvider: (name: string) => call<{ provider: string; paused: boolean }>("POST", `/v1/providers/${encodeURIComponent(name)}/pause`),
  resumeProvider: (name: string) => call<{ provider: string; paused: boolean }>("POST", `/v1/providers/${encodeURIComponent(name)}/resume`),
};

const WINDOW_NAMES: Record<string, string> = { session_5h: "5-hour session", weekly: "weekly" };

/** "session_5h" → "5-hour session", "weekly_opus" → "weekly Opus", "input_tokens" → "input tokens". */
export function windowName(name: string | null | undefined): string {
  if (!name) return "";
  if (WINDOW_NAMES[name]) return WINDOW_NAMES[name];
  const scoped = name.match(/^weekly_(.+)$/);
  if (scoped) return `weekly ${scoped[1].charAt(0).toUpperCase()}${scoped[1].slice(1)}`;
  return name.replace(/[_-]/g, " ");
}

/** Fallback names for plan targets from companions that don't send `tool_name`. */
export const TOOL_NAMES: Record<string, string> = { claude: "Claude Code", "claude-code": "Claude Code", codex: "Codex" };

const UNITS: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];

/** Short token counts with three significant digits: 950, 12.4k, 116M, 1.66B, 13.5B. */
export function tokens(v: number): string {
  for (const [size, unit] of UNITS) {
    if (v >= size) {
      const n = v / size;
      return `${+n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)}${unit}`;
    }
  }
  return String(Math.round(v));
}

/** Parse a count typed by a person: "1M", "2.5b", "500k", "1,000,000". */
export function parseCount(text: string): number | null {
  const m = text.trim().toLowerCase().replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)([kmbt]?)$/);
  if (!m) return null;
  const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2] as "" | "k" | "m" | "b" | "t"];
  return Math.round(Number(m[1]) * mult);
}

/** A whole number with separators: 11,115. */
export function count(v: number): string {
  return Math.round(v).toLocaleString();
}

export function usd(v: number): string {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** This machine's offset from UTC, as the companion expects it (minutes behind UTC). */
const TZ = () => new Date().getTimezoneOffset();
