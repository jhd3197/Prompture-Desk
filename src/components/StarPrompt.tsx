// "Enjoying Prompture Desk?" — asks for a GitHub star, like ServerKit does.
// A star link sits by the brand; the card shows in About and, after a few days
// of use, at the foot of the sidebar. Dismissing or starring hides it for good.

import { openUrl } from "@tauri-apps/plugin-opener";
import { Star, X } from "lucide-react";
import { useState } from "react";

export const REPO_URL = "https://github.com/jhd3197/Prompture-Desk";

const DISMISSED_KEY = "desk.starPromptDismissed";
const FIRST_SEEN_KEY = "desk.firstSeen";
/** Days of use before the sidebar asks. */
const NUDGE_AFTER_DAYS = 3;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function star() {
  openUrl(REPO_URL).catch(() => undefined);
}

/** Whether the sidebar should ask yet: not dismissed, and Desk has been around a few days. */
function nudgeDue(): boolean {
  if (read(DISMISSED_KEY) === "true") return false;
  let first = Number(read(FIRST_SEEN_KEY));
  if (!first) { first = Date.now(); write(FIRST_SEEN_KEY, String(first)); }
  return Date.now() - first > NUDGE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

export function StarButton() {
  return (
    <button className="d-star" onClick={star} title="Star on GitHub" aria-label="Star Prompture Desk on GitHub">
      <Star size={14} aria-hidden />
    </button>
  );
}

/** The card. `compact` is the sidebar version. */
export function StarCard({ compact = false }: { compact?: boolean }) {
  const [shown, setShown] = useState(() => (compact ? nudgeDue() : read(DISMISSED_KEY) !== "true"));
  if (!shown) return null;
  const hide = () => { write(DISMISSED_KEY, "true"); setShown(false); };
  return (
    <div className={`star-card ${compact ? "compact" : ""}`}>
      <button className="star-x" onClick={hide} title="Dismiss" aria-label="Dismiss"><X size={13} /></button>
      {!compact && <span className="star-icon"><Star size={20} aria-hidden /></span>}
      <div className="star-body">
        <strong>Enjoying Prompture Desk?</strong>
        <span>A star on GitHub helps others find it.</span>
        <button className="s-btn primary star-go" onClick={() => { star(); hide(); }}>
          <Star size={14} aria-hidden /> Star on GitHub
        </button>
      </div>
    </div>
  );
}
