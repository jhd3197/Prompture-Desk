/**
 * Interface language (Settings › Appearance › Language).
 *
 * Desk keeps its copy inline in the components, so translation happens at the
 * DOM: a MutationObserver rewrites text nodes and a few attributes as React
 * renders them, and puts the English back when switching to English. Values
 * (numbers, model names, paths, code) are left alone. Ported from Faro.
 *
 * Each language is a file in ./locales: exact strings, then patterns for text
 * with numbers or names in it.
 */

import { es } from "./locales/es";
import { zh } from "./locales/zh";

export type UiLanguage = "system" | "en" | "es" | "zh-CN";
type Resolved = Exclude<UiLanguage, "system">;

export interface Locale {
  lang: string;
  words: Record<string, string>;
  /** Tried in order on the trimmed text; each gets the regex groups. */
  patterns: Array<[RegExp, (...m: string[]) => string]>;
}

const LOCALES: Partial<Record<Resolved, Locale>> = { es, "zh-CN": zh };

/** Attributes that carry readable text. */
const ATTRIBUTES = ["title", "aria-label", "placeholder"];

let locale: Locale | null = null;

function translate(value: string): string {
  if (!locale) return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const normalized = trimmed.replace(/\s+/g, " ");
  const exact = locale.words[trimmed] ?? locale.words[normalized];
  if (exact) return value.replace(trimmed, exact);
  for (const [re, fn] of locale.patterns) {
    const m = normalized.match(re);
    if (m) return value.replace(trimmed, fn(...m.slice(1)));
  }
  return value;
}

/** Translate a string outside the DOM (notifications, the tray tooltip). */
export function tr(text: string): string {
  return translate(text);
}

// The English for every node and attribute rewritten, so switching language
// can restore it. React re-setting a node's text fires the observer, which
// records the fresh original before translating again.
const originalText = new WeakMap<Node, string>();
const originalAttrs = new WeakMap<Element, Record<string, string>>();
let observer: MutationObserver | null = null;

function visit(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    const text = root.nodeValue;
    if (text && text.trim() && !root.parentElement?.closest("code, pre, .mono")) {
      const next = translate(text);
      if (next !== text) {
        originalText.set(root, text);
        root.nodeValue = next;
      }
    }
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const element = root as Element;
  if (["SCRIPT", "STYLE", "CODE", "PRE"].includes(element.tagName)) return;
  for (const attr of ATTRIBUTES) {
    const value = element.getAttribute(attr);
    if (!value) continue;
    const next = translate(value);
    if (next !== value) {
      const saved = originalAttrs.get(element) ?? {};
      saved[attr] = value;
      originalAttrs.set(element, saved);
      element.setAttribute(attr, next);
    }
  }
  for (const child of Array.from(element.childNodes)) visit(child);
}

function restore(root: Node): void {
  const text = originalText.get(root);
  if (text !== undefined) {
    root.nodeValue = text;
    originalText.delete(root);
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    const element = root as Element;
    const saved = originalAttrs.get(element);
    if (saved) {
      for (const [attr, value] of Object.entries(saved)) element.setAttribute(attr, value);
      originalAttrs.delete(element);
    }
  }
  for (const child of Array.from(root.childNodes)) restore(child);
}

function start(): void {
  if (observer) return;
  visit(document.body);
  observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "characterData" || record.type === "attributes") visit(record.target);
      else for (const node of Array.from(record.addedNodes)) visit(node);
    }
  });
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES,
  });
}

function stop(): void {
  if (!observer) return;
  observer.disconnect();
  observer = null;
  restore(document.body);
}

/** "system" follows the OS language. */
export function resolveUiLanguage(lang: UiLanguage | undefined): Resolved {
  if (lang && lang !== "system") return lang;
  const os = navigator.language.toLowerCase();
  return os.startsWith("zh") ? "zh-CN" : os.startsWith("es") ? "es" : "en";
}

export function applyUiLanguage(lang: UiLanguage | undefined): void {
  const next = LOCALES[resolveUiLanguage(lang)] ?? null;
  if (next === locale) return;
  // Back to English first, so a switch between two languages starts clean.
  stop();
  locale = next;
  document.documentElement.lang = next?.lang ?? "en";
  if (locale) start();
}
