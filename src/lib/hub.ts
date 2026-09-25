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
  warn_at: number;
  notify_alerts: boolean;
  notify_errors: boolean;
  notify_paused: boolean;
  notify_long_calls: boolean;
  play_sound: boolean;
  refresh_secs: number;
}

export interface Capabilities {
  running_calls: boolean;
  projects: boolean;
  key_controls: boolean;
  provider_controls: boolean;
  alert_rules: boolean;
  /** Local companion only: usage read from coding agents' own logs (/v1/tools). */
  coding_tools?: boolean;
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

export interface InstalledAgent { id: string; name: string; installed: boolean; runnable: boolean; usage: boolean }

export interface Tools {
  period: "day" | "week" | "month";
  start: string;
  agents: ToolUsage[];
  installed: InstalledAgent[];
}

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
  | "overview" | "activity" | "tools" | "limits" | "alerts"
  | "widget" | "appearance" | "providers" | "notifications" | "connection" | "about";

export const hub = {
  info: () => call<HubInfo>("GET", "/v1/companion/info"),
  limits: () => call<Limits>("GET", "/v1/limits"),
  spend: (period: "day" | "week" | "month" = "day") => call<Spend>("GET", `/v1/spend?period=${period}`),
  alerts: () => call<Alert[]>("GET", "/v1/alerts?limit=50"),
  tools: (period: "day" | "week" | "month" = "day") => call<Tools>("GET", `/v1/tools?period=${period}`),
  ackAlert: (id: number) => call<Alert>("POST", `/v1/alerts/${id}/ack`),
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

export function tokens(v: number): string {
  if (v >= 1_000_000) return `${+(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 2)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(v);
}

export function usd(v: number): string {
  if (v === 0) return "$0.00";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}
