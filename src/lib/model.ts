// Per-provider rows for the widgets: today's spend (or tokens) against the
// user's daily budget, the tightest provider rate window, running calls and
// whether the provider is paused on the hub.
import { type Alert, type LiveEvent, type Limits, type ProviderPref, type Settings, type Spend, tokens, usd, windowName } from "./hub";
import { providerName, providerOf } from "./providers";

export type Tone = "ok" | "warn" | "paused";

export interface ProviderRow {
  id: string;
  name: string;
  visible: boolean;
  spendUsd: number;
  tokens: number;
  requests: number;
  /** Share of the daily budget used, in percent (may exceed 100). */
  pct: number;
  /** Share of the tightest rate-limit window used, in percent. */
  rateUsed: number | null;
  rateLabel: string | null;
  /** Whether that window is an API rate limit or a subscription plan's usage window. */
  rateKind: "rate" | "plan";
  /**
   * What the strip measures: "budget" (API calls against the daily budget), "plan"
   * (a subscription's usage window) or "none" (subscription usage with no known limit).
   */
  meter: "budget" | "plan" | "none";
  running: number;
  paused: boolean;
  tone: Tone;
  /** Today's value in the chosen metric, e.g. "$1.84" or "612k". */
  value: string;
  /** The budget in the chosen metric, e.g. "$2.50" or "850k". */
  budget: string;
}

export const DEFAULT_PREF: Omit<ProviderPref, "id"> = { visible: true, budget_usd: 1, budget_tokens: 1_000_000 };

/** Settings order first, then providers seen today that have no row yet. */
export function providerIds(settings: Settings, spend: Spend | null, limits: Limits | null, running: LiveEvent[]): string[] {
  const ids = settings.providers.map(p => p.id);
  const add = (id: string | null) => { if (id && !ids.includes(id)) ids.push(id); };
  spend?.by_model.forEach(m => add(providerOf(m.model)));
  limits?.providers?.forEach(p => add(providerOf(p.target)));
  running.forEach(r => add(providerOf(r.routed_to ?? r.model)));
  return ids;
}

/** Settings' provider list with any newly seen providers appended (visible, default budget). */
export function withNewProviders(settings: Settings, ids: string[]): ProviderPref[] {
  const known = new Map(settings.providers.map(p => [p.id, p]));
  return ids.map(id => known.get(id) ?? { id, ...DEFAULT_PREF });
}

/** "6:25 PM" today, "Sat 6:25 PM" within a week, else "Oct 3". */
export function resetTime(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000);
  const hours = (at.getTime() - Date.now()) / 3_600_000;
  if (hours < 20) return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (hours < 24 * 6) return at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function providerRows(
  settings: Settings,
  spend: Spend | null,
  limits: Limits | null,
  running: LiveEvent[],
  apiSpend: Spend | null = null,
): ProviderRow[] {
  const prefs = new Map(settings.providers.map(p => [p.id, p]));
  const paused = new Set(limits?.paused_providers ?? []);
  const tokensMode = settings.metric === "tokens";
  return providerIds(settings, spend, limits, running).map(id => {
    const pref = prefs.get(id) ?? { id, ...DEFAULT_PREF };
    const models = spend?.by_model.filter(m => providerOf(m.model) === id) ?? [];
    const spendUsd = models.reduce((a, m) => a + m.cost_usd, 0);
    const tokenCount = models.reduce((a, m) => a + m.tokens, 0);
    const requests = models.reduce((a, m) => a + m.requests, 0);
    // Budgets are for pay-per-token API calls; subscription (coding-tool) usage isn't billed per token.
    const apiModels = (apiSpend ?? spend)?.by_model.filter(m => providerOf(m.model) === id) ?? [];
    const apiUsd = apiModels.reduce((a, m) => a + m.cost_usd, 0);
    const apiTokens = apiModels.reduce((a, m) => a + m.tokens, 0);

    let rateUsed: number | null = null;
    let rateLabel: string | null = null;
    let rateKind: "rate" | "plan" = "rate";
    for (const target of limits?.providers ?? []) {
      if (providerOf(target.target) !== id || target.current_headroom == null) continue;
      const used = Math.round((1 - target.current_headroom) * 100);
      if (rateUsed == null || used > rateUsed) {
        rateUsed = used;
        const w = target.current_window ? target.windows?.[target.current_window] : undefined;
        const unit = windowName(target.current_window);
        rateKind = target.source === "plan" ? "plan" : "rate";
        rateLabel = rateKind === "rate" && w?.limit != null && w.remaining != null
          ? `${tokens(w.limit - w.remaining)} / ${tokens(w.limit)} ${unit}`
          : rateKind === "plan"
            ? `${Math.max(0, 100 - used)}% of ${unit} left${w?.resets_at ? ` · resets ${resetTime(w.resets_at)}` : ""}`
            : `${used}% of ${unit}`;
      }
    }

    const budgetPct = tokensMode
      ? (pref.budget_tokens > 0 ? (apiTokens / pref.budget_tokens) * 100 : 0)
      : (pref.budget_usd > 0 ? (apiUsd / pref.budget_usd) * 100 : 0);
    const meter: ProviderRow["meter"] = apiTokens > 0 || apiUsd > 0 ? "budget"
      : rateKind === "plan" && rateUsed != null ? "plan"
        : tokenCount > 0 ? "none" : "budget";
    const pct = meter === "budget" ? budgetPct : meter === "plan" ? (rateUsed ?? 0) : 0;
    const isPaused = paused.has(id);
    const worst = Math.max(budgetPct, rateUsed ?? 0);
    return {
      id,
      name: providerName(id),
      visible: pref.visible,
      spendUsd,
      tokens: tokenCount,
      requests,
      pct,
      rateUsed,
      rateLabel,
      rateKind,
      meter,
      running: running.filter(r => providerOf(r.routed_to ?? r.model) === id).length,
      paused: isPaused,
      tone: isPaused ? "paused" : worst >= settings.warn_at ? "warn" : "ok",
      value: tokenCount === 0 && spendUsd === 0 ? "—" : tokensMode ? tokens(tokenCount) : usd(spendUsd),
      budget: tokensMode ? tokens(pref.budget_tokens) : usd(pref.budget_usd),
    };
  });
}

/** Used today, or with a call in flight. */
export function isUsed(r: ProviderRow): boolean {
  return r.tokens > 0 || r.spendUsd > 0 || r.running > 0;
}

/** Rows to show: visible ones, and with `hide_unused` only those used today. */
export function activeRows(rows: ProviderRow[], settings: Settings): ProviderRow[] {
  return rows.filter(r => r.visible && (!settings.hide_unused || isUsed(r)));
}

export function totalLabel(settings: Settings, spend: Spend | null): { value: string; sub: string } {
  return settings.metric === "tokens"
    ? { value: tokens(spend?.total.tokens ?? 0), sub: "tok today" }
    : { value: usd(spend?.total.cost_usd ?? 0), sub: "today" };
}

/** The one warning line a widget shows: the newest open hub alert, else the provider nearest a limit. */
export function warningLine(alerts: Alert[], rows: ProviderRow[], settings: Settings): string | null {
  const open = alerts.find(a => !a.acknowledged_at);
  if (open) return open.message;
  const hot = rows
    .filter(r => r.visible && r.tone === "warn")
    .sort((a, b) => Math.max(b.pct, b.rateUsed ?? 0) - Math.max(a.pct, a.rateUsed ?? 0))[0];
  if (!hot) return null;
  return hot.meter === "budget" && hot.pct >= (hot.rateUsed ?? 0)
    ? `${hot.name} at ${Math.round(hot.pct)}% of today's ${settings.metric === "tokens" ? "token " : ""}budget`
    : hot.rateKind === "plan"
      ? `${hot.name} plan: ${hot.rateLabel}`
      : `${hot.name} at ${hot.rateUsed}% of its rate window`;
}

export function isDetailed(settings: Settings): boolean {
  if (settings.detail === "compact") return false;
  if (settings.detail === "detailed") return true;
  return navigator.userAgent.includes("Windows");
}
