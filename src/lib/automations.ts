// Automations: coding-agent steps the local companion runs one after another.
// Shared by the Automations page, the capsule and the notifications.
import type { Automation, AutomationStep } from "./hub";
import { usd } from "./hub";

export const isEnded = (run: Automation | null | undefined): boolean =>
  !!run && (run.status === "finished" || run.status === "failed" || run.status === "stopped");

export const isActive = (run: Automation | null | undefined): run is Automation => !!run && !isEnded(run);

/** "/gsd:execute-phase 4" → "Phase 4"; other steps as typed, shortened. */
export function stepLabel(text: string): string {
  const gsd = text.match(/^\/gsd:(execute-phase|plan-phase|verify-work|discuss-phase)\s+(\S+)/);
  if (gsd) {
    const verb = { "execute-phase": "Phase", "plan-phase": "Plan", "verify-work": "Verify", "discuss-phase": "Discuss" }[gsd[1]];
    return `${verb} ${gsd[2]}`;
  }
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** 45s, 14m, 1h 12m. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** How long a step has run, counting the attempt in progress. */
export function stepSeconds(step: AutomationStep, now = Date.now()): number {
  const live = step.running_since ? Math.max(0, now / 1000 - step.running_since) : 0;
  return step.duration_s + live;
}

export function runSeconds(run: Automation, now = Date.now()): number {
  return run.steps.reduce((sum, s) => sum + stepSeconds(s, now), 0);
}

export const money = (v: number | null | undefined): string => (v == null ? "" : usd(v));

/** "4:30 PM" (or "Mon 4:30 PM" when it isn't today). */
export function clock(epoch: number): string {
  const d = new Date(epoch * 1000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** The one line under a paused step. */
export function pauseLine(run: Automation): string {
  switch (run.reason) {
    case "limit": return run.resumes_at ? `Plan limit near · resumes ${clock(run.resumes_at)}` : "Plan limit near";
    case "fail": return `Failed${run.steps[run.current]?.error ? ` · ${run.steps[run.current].error}` : ""}`;
    case "cost": return `Cost passed ${usd(run.stop.cost_usd ?? 0)}`;
    case "ask": return "Asks a question";
    default: return "Paused";
  }
}

/** Steps done (or skipped) so far, for "2 of 4". */
export function position(run: Automation): number {
  return isEnded(run) ? run.steps.length : Math.min(run.current + 1, run.steps.length);
}

/** One segment per step for the thin progress bars. */
export type Segment = "done" | "skip" | "fail" | "wait" | "stop" | "run" | "pause";

export function segments(run: Automation): Segment[] {
  return run.steps.map((s, i) => {
    if (s.status === "done") return "done";
    if (s.status === "skipped") return "skip";
    if (s.status === "failed") return "fail";
    if (s.status === "stopped") return "stop";
    if (!isEnded(run) && i === run.current) return run.status === "paused" ? "pause" : "run";
    return "wait";
  });
}

/**
 * The notification a change deserves, if any: a step finished, the queue needs
 * you, or it's done. `prev` is the same run as last seen.
 */
export function automationNotice(prev: Automation | null, next: Automation): { title: string; body: string } | null {
  if (!prev || prev.id !== next.id) return null;
  if (next.status === "finished" && prev.status !== "finished") {
    const done = next.steps.filter(s => s.status === "done").length;
    return {
      title: "Queue finished",
      body: `${next.project} queue done · ${done} of ${next.steps.length} · ${duration(next.duration_s)}${next.cost_usd ? ` · ${usd(next.cost_usd)}` : ""}`,
    };
  }
  const step = next.steps[next.current];
  if (next.status === "paused" && (prev.status !== "paused" || prev.reason !== next.reason) && next.reason !== "manual" && step) {
    const label = stepLabel(step.text);
    const body = next.reason === "ask" ? `${label} asks a question · open Automations`
      : next.reason === "fail" ? `${label} failed · open Automations`
        : next.reason === "limit" ? `${pauseLine(next)}`
          : `${pauseLine(next)} · open Automations`;
    return { title: "Needs you", body };
  }
  for (const s of next.steps) {
    const before = prev.steps.find(p => p.id === s.id);
    if (before && before.status === "running" && s.status === "done" && next.status !== "finished") {
      return { title: "Step done", body: `${stepLabel(s.text)} done · ${duration(s.duration_s)}${s.cost_usd ? ` · ${usd(s.cost_usd)}` : ""}` };
    }
  }
  return null;
}
