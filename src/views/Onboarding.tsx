import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { type DeviceCode, type HubInfo, type LocalProblem, desk } from "../lib/hub";

type Step =
  | { kind: "choose" }
  | { kind: "code"; url: string; code: DeviceCode };

type LocalState =
  | { kind: "idle" }
  | { kind: "working"; text: string }
  | { kind: "problem"; problem: LocalProblem };

const INSTALL_CMD = "pipx install prompture";
const UPGRADE_CMD = "pipx upgrade prompture";

function asProblem(e: unknown): LocalProblem {
  if (e && typeof e === "object" && "code" in e) return e as LocalProblem;
  return { code: "failed", message: String(e) };
}

export function Onboarding({ onPaired }: { onPaired: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [local, setLocal] = useState<LocalState>({ kind: "idle" });
  const [hubHere, setHubHere] = useState<{ url: string; info: HubInfo } | null>(null);
  const [showHub, setShowHub] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [control, setControl] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef<number | undefined>(undefined);

  // Setup progress while Desk installs or updates its own Prompture.
  useEffect(() => {
    const off = listen<string | null>("desk://local-setup", e => {
      if (e.payload) setLocal(l => (l.kind === "working" ? { kind: "working", text: e.payload! } : l));
    });
    return () => { off.then(fn => fn()); };
  }, []);

  useEffect(() => {
    desk.discoverLocal().then(found => setHubHere(found?.info.service === "prompture-hub" ? found : null)).catch(() => undefined);
    return () => window.clearTimeout(pollTimer.current);
  }, []);

  // ---------------------------------------------------------- local mode
  const useLocal = async () => {
    setLocal({ kind: "working", text: "Starting Prompture on this PC…" });
    try {
      await desk.connectLocal();
      onPaired();
    } catch (e) {
      setLocal({ kind: "problem", problem: asProblem(e) });
    }
  };

  // ---------------------------------------------------------- hub pairing
  const pair = async (target: string) => {
    setError(null);
    setBusy(true);
    try {
      const probed = await desk.probe(target);
      const code = await desk.startPairing(probed.url, control);
      setStep({ kind: "code", url: probed.url, code });
      schedulePoll(code.interval);
      openUrl(code.verification_uri_complete).catch(() => undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const schedulePoll = (interval: number) => {
    window.clearTimeout(pollTimer.current);
    pollTimer.current = window.setTimeout(async () => {
      const res = await desk.pollPairing(name || undefined).catch(e => ({ state: "failed" as const, message: String(e) }));
      switch (res.state) {
        case "pending": schedulePoll(interval); break;
        case "slow_down": schedulePoll(interval + 5); break;
        case "approved": onPaired(); break;
        case "denied": setError("The pairing was denied in the dashboard."); setStep({ kind: "choose" }); break;
        case "expired": setError("The code expired. Start again."); setStep({ kind: "choose" }); break;
        default: setError("message" in res ? res.message : "Pairing failed."); setStep({ kind: "choose" });
      }
    }, interval * 1000);
  };

  if (step.kind === "code") {
    return (
      <div className="body">
        <div className="card stack">
          <h3>Approve this device</h3>
          <p className="muted" style={{ margin: 0 }}>
            The hub's pairing page should have opened in your browser. Check that it shows this code, then approve.
          </p>
          <div className="code-box">{step.code.user_code}</div>
          <button className="btn" onClick={() => openUrl(step.code.verification_uri_complete)}>Open the approval page again</button>
          <div className="row muted" style={{ fontSize: 12 }}>
            <span className="pulse" />Waiting for approval on {step.url.replace(/^https?:\/\//, "")}…
          </div>
        </div>
        <button className="btn btn-ghost" onClick={() => { window.clearTimeout(pollTimer.current); setStep({ kind: "choose" }); }}>Cancel</button>
      </div>
    );
  }

  const problem = local.kind === "problem" ? local.problem : null;
  return (
    <div className="body">
      <div className="card stack">
        <h3>Prompture on this PC</h3>
        <p className="muted" style={{ margin: 0 }}>
          See what your Prompture scripts and apps are spending — per provider and project, with rate limits and
          provider balances. No server to set up, and no Python needed: Desk sets Prompture up for you.
        </p>
        {local.kind === "working" ? (
          <div className="row muted" style={{ fontSize: 12.5 }}><span className="pulse" />{local.text}</div>
        ) : (
          <button className="btn btn-primary" onClick={useLocal}>{problem ? "Try again" : "Use Prompture on this PC"}</button>
        )}
        {problem?.code === "not_installed" && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="error">{problem.message}</div>
            <span className="item-sub">In a terminal: <code className="mono" style={{ userSelect: "text" }}>{INSTALL_CMD}</code></span>
          </div>
        )}
        {problem?.code === "needs_upgrade" && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="error">{problem.message}</div>
            <span className="item-sub">In a terminal: <code className="mono" style={{ userSelect: "text" }}>{UPGRADE_CMD}</code></span>
          </div>
        )}
        {problem?.code === "failed" && (
          <div className="error" style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>{problem.message}</div>
        )}
      </div>

      <div className="card stack">
        <div className="row between">
          <h3 style={{ margin: 0 }}>Connect a prompture-hub</h3>
          {!showHub && <button className="btn btn-sm btn-ghost" onClick={() => setShowHub(true)}>Set up</button>}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Optional. A hub sees every call routed through it — including coding tools — and adds running calls,
          per-key caps, alert rules and controls.
        </p>
        {(showHub || hubHere) && (
          <>
            {hubHere && (
              <div className="row between">
                <div>
                  <div className="item-title">Found a hub on this PC</div>
                  <div className="item-sub mono">{hubHere.url} · v{hubHere.info.version}</div>
                </div>
                <button className="btn" disabled={busy} onClick={() => pair(hubHere.url)}>Pair</button>
              </div>
            )}
            <div className="row">
              <input
                className="input mono" placeholder="https://hub.example.com or 192.168.1.20:1984"
                value={url} onChange={e => setUrl(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && url.trim()) pair(url); }}
              />
              <button className="btn" disabled={busy || !url.trim()} onClick={() => pair(url)}>Pair</button>
            </div>
            <input className="input" placeholder="Name for this hub (optional)" value={name} onChange={e => setName(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={control} onChange={e => setControl(e.target.checked)} />
              Ask for control too (pause keys and providers, switch routes, acknowledge alerts)
            </label>
            {error && <div className="error">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
