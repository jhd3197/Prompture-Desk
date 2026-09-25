// Fetch the uv binary Desk ships as a sidecar (src-tauri/binaries/uv-<target triple>[.exe]).
//
// Desk uses uv to set up Prompture on machines that don't have it: uv brings its own
// Python, so someone who only installs Desk never needs Python or a terminal.
// The version is pinned and every download is checked against its published SHA-256.
//
// Runs before `tauri dev` / `tauri build`; does nothing when the binary is already there.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

const triple = targetTriple();
const windows = triple.includes("windows");
const exe = windows ? ".exe" : "";
const dest = join(root, "src-tauri", "binaries", `uv-${triple}${exe}`);
if (existsSync(dest)) process.exit(0);

// uv publishes msvc builds only; a gnu Rust host still runs them.
const asset = `uv-${triple.replace("windows-gnu", "windows-msvc")}${windows ? ".zip" : ".tar.gz"}`;
const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;
console.log(`fetching uv ${UV_VERSION} (${asset})`);

const [archive, sums] = await Promise.all([download(base), download(`${base}.sha256`)]);
const expected = sums.toString("utf8").trim().split(/\s+/)[0].toLowerCase();
const actual = createHash("sha256").update(archive).digest("hex");
if (actual !== expected) throw new Error(`uv checksum mismatch: expected ${expected}, got ${actual}`);

const work = mkdtempSync(join(tmpdir(), "desk-uv-"));
try {
  const file = join(work, asset);
  writeFileSync(file, archive);
  // Windows ships bsdtar, which reads zip; name it so a GNU tar on PATH (Git Bash) is not used.
  const tar = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", file, "-C", work]);
  const found = [join(work, `uv${exe}`), join(work, asset.replace(/\.(zip|tar\.gz)$/, ""), `uv${exe}`)].find(existsSync);
  if (!found) throw new Error("uv binary not found in the archive");
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(found, dest);
  if (!windows) execFileSync("chmod", ["+x", dest]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`uv ready: ${dest} (${(readFileSync(dest).length / 1e6).toFixed(1)} MB)`);
