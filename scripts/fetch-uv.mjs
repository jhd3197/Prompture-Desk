// Fetch the uv binary Desk ships as a sidecar (src-tauri/binaries/uv-<target triple>[.exe]).
//
// Desk uses uv to set up Prompture on machines that don't have it: uv brings its own
// Python, so someone who only installs Desk never needs Python or a terminal.
// The version is pinned and every download is checked against its published SHA-256.
//
// Runs before `tauri dev` / `tauri build`; does nothing when the binary is already there.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UV_VERSION = "0.12.18";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function targetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = out.match(/^host: (\S+)/m)?.[1];
  if (!host) throw new Error("couldn't read the Rust host triple from `rustc -vV`");
  return host;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Download, verify and unpack uv for one target triple into `work`; returns the binary's path. */
async function fetchUv(triple, work) {
  const windows = triple.includes("windows");
  const exe = windows ? ".exe" : "";
  // uv publishes msvc builds only; a gnu Rust host still runs them.
  const asset = `uv-${triple.replace("windows-gnu", "windows-msvc")}${windows ? ".zip" : ".tar.gz"}`;
  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;
  console.log(`fetching uv ${UV_VERSION} (${asset})`);

  const [archive, sums] = await Promise.all([download(base), download(`${base}.sha256`)]);
  const expected = sums.toString("utf8").trim().split(/\s+/)[0].toLowerCase();
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`uv checksum mismatch: expected ${expected}, got ${actual}`);

  const dir = join(work, triple);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, asset);
  writeFileSync(file, archive);
  // Windows ships bsdtar, which reads zip; name it so a GNU tar on PATH (Git Bash) is not used.
  const tar = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", file, "-C", dir]);
  const found = [join(dir, `uv${exe}`), join(dir, asset.replace(/\.(zip|tar\.gz)$/, ""), `uv${exe}`)].find(existsSync);
  if (!found) throw new Error("uv binary not found in the archive");
  return found;
}

const triple = targetTriple();
const windows = triple.includes("windows");
const binaries = join(root, "src-tauri", "binaries");
const target = (t) => join(binaries, `uv-${t}${windows ? ".exe" : ""}`);
const dest = target(triple);
// A universal macOS build compiles each architecture on its own (each wants its
// own uv) and then bundles the merged one.
const wanted = triple === "universal-apple-darwin"
  ? [target("aarch64-apple-darwin"), target("x86_64-apple-darwin"), dest]
  : [dest];
if (wanted.every(existsSync)) process.exit(0);

const work = mkdtempSync(join(tmpdir(), "desk-uv-"));
try {
  mkdirSync(binaries, { recursive: true });
  // Copy rather than rename: the temp dir can be on another drive (CI runners).
  if (triple === "universal-apple-darwin") {
    const arm = await fetchUv("aarch64-apple-darwin", work);
    const intel = await fetchUv("x86_64-apple-darwin", work);
    copyFileSync(arm, target("aarch64-apple-darwin"));
    copyFileSync(intel, target("x86_64-apple-darwin"));
    // uv has no universal build; merge the two.
    execFileSync("lipo", ["-create", "-output", dest, arm, intel]);
  } else {
    copyFileSync(await fetchUv(triple, work), dest);
  }
  if (!windows) for (const f of wanted) execFileSync("chmod", ["+x", f]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`uv ready: ${dest} (${(readFileSync(dest).length / 1e6).toFixed(1)} MB)`);
