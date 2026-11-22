#!/usr/bin/env node
// qa/ci-live.mjs — the live job for a self-hosted runner with After Effects
// (see docs/CI-RUNNER.md and .github/workflows/ae-live.yml).
//
//   node qa/ci-live.mjs [--start-ae <AfterFX path | After Effects .app>] [--wait <seconds>]
//
// 1. Waits for the panel service's /health (starting AE first if asked and
//    it isn't running).
// 2. Checks the CEP extension points at this checkout, then reloads the
//    service through its debug port (8097), so it loads this checkout's
//    bundle and host/ext/*.jsx.
// 3. Runs qa/smoke-mcp.mjs in a fresh work dir and exits with its code.
// Node 22 (for the global WebSocket). No dependencies.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const waitSeconds = Number(arg("--wait") ?? 300);
const aeExe = arg("--start-ae") ?? process.env.AE_EXE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy() {
  try {
    const h = await createClient().health();
    return h && h.ok === true && !h.busy ? h : null;
  } catch {
    return null;
  }
}

async function waitForHealth(seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const h = await healthy();
    if (h) return h;
    await sleep(3000);
  }
  return null;
}

function extensionDir() {
  const base =
    process.platform === "win32"
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Adobe", "CEP", "extensions")
      : path.join(os.homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions");
  return path.join(base, "london.chroma.aemcp");
}

function serviceLogPath() {
  const base =
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "chroma-ae-mcp")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "chroma-ae-mcp")
        : path.join(os.homedir(), ".chroma-ae-mcp");
  return path.join(base, "service.log");
}

function logSize() {
  try {
    return fs.statSync(serviceLogPath()).size;
  } catch {
    return 0;
  }
}

// True once a "Listening on http://127.0.0.1:" line has been written after `offset`
// (a log that shrank was rotated, so it is read from the start).
function listeningSince(offset) {
  try {
    const text = fs.readFileSync(serviceLogPath(), "utf8");
    const buf = Buffer.from(text, "utf8");
    const from = buf.length < offset ? 0 : offset;
    return buf.subarray(from).toString("utf8").includes("Listening on http://127.0.0.1:");
  } catch {
    return false;
  }
}

async function waitForListening(offset, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (listeningSince(offset)) return true;
    await sleep(1000);
  }
  return false;
}

// When the service cannot be reloaded through its debug port (no port: a copy without the .debug
// file was loaded, or PlayerDebugMode is off; or a Node without the global WebSocket), restart
// AE on macOS instead, which also loads core.jsx changes a reload would not. Only with a clean
// project: quitting over unsaved changes would open AE's save prompt.
async function restartAeMac() {
  const client = createClient();
  const dirty = await client.eval("app.project ? app.project.dirty : false", { label: "ci-live: dirty check" });
  if (dirty === true) throw new Error("The open project has unsaved changes; not quitting After Effects over them. Save or close it, then run again.");
  const app = aeExe ?? "Adobe After Effects 2026";
  console.log("macOS: the service cannot be reloaded through its debug port here, so restarting After Effects to load this checkout.");
  spawnSync("osascript", ["-e", `tell application ${JSON.stringify(path.basename(app, ".app"))} to quit`], { stdio: "inherit" });
  const until = Date.now() + 180_000;
  while (Date.now() < until && (await healthy())) await sleep(2000);
  await sleep(3000);
  spawn("open", ["-a", app], { detached: true, stdio: "ignore" }).unref();
}

async function debugPortOpen() {
  try {
    await fetch("http://127.0.0.1:8097/json", { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

async function reloadService() {
  const canReload = typeof WebSocket === "function" && (await debugPortOpen());
  if (!canReload) {
    if (process.platform === "darwin") return restartAeMac();
    if (typeof WebSocket !== "function") throw new Error(`Node ${process.version} has no global WebSocket; run this with Node 22.`);
    throw new Error("The service has no debug port 8097 (PlayerDebugMode off, or the panel's .debug file missing?)");
  }
  const targets = await (await fetch("http://127.0.0.1:8097/json")).json();
  const target = targets.find((t) => t.webSocketDebuggerUrl);
  if (!target) throw new Error("The service has no debug target on port 8097 (PlayerDebugMode off?)");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "location.reload()" } }));
  await sleep(500);
  ws.close();
}

let health = await healthy();
if (!health && aeExe) {
  console.log(`Starting After Effects: ${aeExe}`);
  // macOS: AE_EXE is the app bundle ("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"), opened as an app.
  if (process.platform === "darwin") spawn("open", ["-a", aeExe], { detached: true, stdio: "ignore" }).unref();
  else spawn(aeExe, [], { detached: true, stdio: "ignore" }).unref();
}
health = health ?? (await waitForHealth(waitSeconds));
if (!health) {
  console.error(`The panel service did not answer /health within ${waitSeconds} s. Is AE running with the extension installed?`);
  process.exit(2);
}
console.log(`AE ${health.aeVersion}, panel ${health.panelVersion}`);

let linked = "";
try {
  linked = fs.realpathSync(extensionDir());
} catch {
  linked = "";
}
const panelDir = fs.realpathSync(path.join(repo, "panel"));
if (path.normalize(linked).toLowerCase() !== path.normalize(panelDir).toLowerCase()) {
  const installer = process.platform === "darwin" ? "scripts/install-dev-mac.sh" : "scripts/install-dev.ps1";
  console.error(`The CEP extension (${extensionDir()} -> ${linked || "missing"}) does not point at this checkout's panel (${panelDir}). Run ${installer} from this checkout once, then restart AE.`);
  process.exit(2);
}

// CEP loads every folder in extensions/ whose manifest carries this extension id, so a second copy
// (a ZXP moved aside, an old dev folder) can be loaded instead of the link (seen on macOS).
const extBase = path.dirname(extensionDir());
const others = [];
try {
  for (const name of fs.readdirSync(extBase)) {
    const dir = path.join(extBase, name);
    if (dir === extensionDir()) continue;
    try {
      const manifest = fs.readFileSync(path.join(dir, "CSXS", "manifest.xml"), "utf8");
      if (/ExtensionBundleId="london\.chroma\.aemcp"/.test(manifest)) others.push(dir);
    } catch {
      // not an extension folder
    }
  }
} catch {
  // no extensions folder to scan
}
if (others.length) {
  console.error(`Other copies of london.chroma.aemcp sit in ${extBase}: ${others.join(", ")}. CEP may load one of them instead of this checkout; move them out of that folder and run again.`);
  process.exit(2);
}

const logOffset = logSize();
await reloadService();
const reloadWait = process.platform === "darwin" ? 300 : 60;
if (!(await waitForListening(logOffset, reloadWait))) {
  console.error(`The service did not log "Listening on http://127.0.0.1:" within ${reloadWait} s of the reload (${serviceLogPath()}), so the new bundle is not confirmed to be running.`);
  process.exit(2);
}
const after = await waitForHealth(reloadWait);
if (!after) {
  console.error("The service did not come back after the reload.");
  process.exit(2);
}
// The link can be right while AE loads another folder with the same extension id (CEP scans every
// folder in extensions/, a backup copy included): the service says where it was loaded from.
const sameDir = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
if (typeof after.extensionDir === "string" && after.extensionDir && !sameDir(after.extensionDir, panelDir)) {
  console.error(`After Effects loaded the panel from ${after.extensionDir}, not this checkout (${panelDir}). Another folder in ${path.dirname(extensionDir())} carries the same extension id; move it out of that folder and run again.`);
  process.exit(2);
}
if (!after.extensionDir) console.log("The panel does not report its folder (an older service.js); the link check above is the only check.");

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
const workDir = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "_work", "qa", "ci", stamp);
console.log(`Smoke test in ${workDir}`);
const res = spawnSync(process.execPath, [path.join(__dirname, "smoke-mcp.mjs"), "--dir", workDir], { stdio: "inherit" });
process.exit(res.status ?? 1);
