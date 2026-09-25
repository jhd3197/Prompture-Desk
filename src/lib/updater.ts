// Updates for Desk itself and for the Prompture it runs.
//
// Desk: the Tauri updater plugin checks a signed `latest.json` on GitHub
// Releases, downloads the artifact (the plugin verifies it against the pubkey
// in tauri.conf.json, so nothing unsigned is installed), and relaunches.
// Prompture: Rust compares the running companion with PyPI and can upgrade
// Desk's own copy.
//
// Only the Desk window drives these; the widget never checks.

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { type LocalProblem, type PromptureStatus, desk } from "./hub";

/** Quiet launch checks run at most this often. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "desk.lastUpdateCheck";

export type UpdaterStatus = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error";

export interface UpdaterState {
  status: UpdaterStatus;
  version: string | null;
  downloaded: number;
  /** Null until the download reports its size. */
  total: number | null;
  error: string | null;
  /** Hides the prompt for this session only. */
  dismissed: boolean;
}

let state: UpdaterState = { status: "idle", version: null, downloaded: 0, total: null, error: null, dismissed: false };
// The plugin's Update isn't plain data, so it stays out of the state.
let held: Update | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<UpdaterState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}

function lastCheck(): number {
  try { return Number(localStorage.getItem(LAST_CHECK_KEY)) || 0; } catch { return 0; }
}

function markChecked() {
  try { localStorage.setItem(LAST_CHECK_KEY, String(Date.now())); } catch { /* storage unavailable */ }
}

export const updater = {
  /** `quiet` (the launch check) keeps a failed check out of sight: there's
   *  no latest.json until the first signed release. */
  async check(quiet: boolean) {
    if (state.status === "checking" || state.status === "downloading" || state.status === "ready") return;
    set({ status: "checking", error: null });
    markChecked();
    try {
      const update = await check();
      held = update;
      set(update ? { status: "available", version: update.version, dismissed: false } : { status: "current", version: null });
    } catch (e) {
      held = null;
      set(quiet ? { status: "idle" } : { status: "error", error: String(e) });
    }
  },

  async install() {
    if (!held || state.status === "downloading") return;
    set({ status: "downloading", downloaded: 0, total: null, error: null });
    try {
      await held.downloadAndInstall(event => {
        if (event.event === "Started") set({ total: event.data.contentLength ?? null, downloaded: 0 });
        else if (event.event === "Progress") set({ downloaded: state.downloaded + event.data.chunkLength });
      });
      set({ status: "ready" });
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  },

  async restart() {
    try { await relaunch(); } catch (e) { set({ status: "error", error: String(e) }); }
  },

  dismiss() { set({ dismissed: true }); },

  /** The throttled launch check. */
  checkIfDue() {
    if (Date.now() - lastCheck() > CHECK_EVERY_MS) void updater.check(true);
  },
};

export function useUpdater(): UpdaterState {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
  );
}

/** Download progress in percent, or null before the size is known. */
export function progress(s: UpdaterState): number | null {
  return s.total && s.total > 0 ? Math.min(100, Math.round((s.downloaded / s.total) * 100)) : null;
}

function problemText(e: unknown): string {
  return typeof e === "object" && e && "message" in e ? String((e as LocalProblem).message) : String(e);
}

/** The local Prompture's version and update state; re-read when `key` changes. */
export function usePrompture(enabled: boolean, key: unknown) {
  const [status, setStatus] = useState<PromptureStatus | null>(null);
  const [busy, setBusy] = useState<"checking" | "updating" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) { setStatus(null); return; }
    let live = true;
    desk.promptureStatus().then(s => { if (live) setStatus(s); }).catch(() => undefined);
    return () => { live = false; };
  }, [enabled, key]);

  const recheck = useCallback(async () => {
    setBusy("checking");
    setError(null);
    try { setStatus(await desk.promptureStatus(true)); } catch (e) { setError(problemText(e)); } finally { setBusy(null); }
  }, []);

  const update = useCallback(async () => {
    setBusy("updating");
    setError(null);
    try { setStatus(await desk.updatePrompture()); } catch (e) { setError(problemText(e)); } finally { setBusy(null); }
  }, []);

  return { status, busy, error, recheck, update };
}
