#!/usr/bin/env node
// qa/live-evidence.mjs — run the live smoke test on this commit and write the evidence
// report a pull request needs (docs/LIVE-EVIDENCE.md; checked by scripts/check-live-evidence.mjs).
//
//   node qa/live-evidence.mjs [--notes <notes.json>] [--start-ae <AfterFX path>] [--wait <s>]
//
// 1. Refuses to run with uncommitted changes (the report names the commit that ran).
// 2. Runs qa/ci-live.mjs: checks the CEP extension points at this checkout, reloads the
//    panel service so this checkout's bundle and host files load, then runs the full
//    qa/smoke-mcp.mjs against the After Effects on this machine.
// 3. Writes qa/evidence/<commit>.json: the commit, OS, AE and panel versions, every check
//    with its result, and the notes file's manual checks and failure explanations.
//    No paths, project names or user names go in it.
//
// The notes file (optional) is JSON:
//   { "manual": [ { "tool": "ae_x", "check": "what was checked", "result": "pass"|"fail"|"n/a", "notes": "..." } ],
//     "explainedFailures": { "<check name as printed>": "why this failure is not the PR's fault" } }
// Manual checks cover what the smoke test can't (a dialog, a Media Encoder hand-off, a
// visual result). Name the tool in "tool" so a new tool counts as covered.
// Plain Node 20+ (22 for qa/ci-live.mjs), no dependencies.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");
const SCHEMA = "chroma-ae-mcp.live-evidence.v1";
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const dirty = git(["status", "--porcelain"])
  .split("\n")
  .filter(Boolean)
  .filter((l) => !/ qa\/evidence\//.test(l));
if (dirty.length) {
  console.error("Commit or stash your changes first: the report names the commit that ran.\n" + dirty.slice(0, 10).join("\n"));
  process.exit(2);
}
const sourceCommit = git(["rev-parse", "HEAD"]);

let notes = { manual: [], explainedFailures: {} };
const notesPath = arg("--notes");
if (notesPath) {
  try {
    notes = { ...notes, ...JSON.parse(fs.readFileSync(notesPath, "utf8")) };
  } catch (e) {
    console.error(`Could not read the notes file ${notesPath}: ${e.message}`);
    process.exit(2);
  }
}

const started = Date.now();
const passThrough = [];
for (const name of ["--start-ae", "--wait"]) if (arg(name)) passThrough.push(name, arg(name));
console.log(`Live smoke test of ${sourceCommit.slice(0, 12)} (several minutes)…`);
const run = spawnSync(process.execPath, [path.join(__dirname, "ci-live.mjs"), ...passThrough], { stdio: "inherit" });
if (run.status === 2) {
  console.error("The live run could not start (see above); no report written.");
  process.exit(2);
}

const smokePath = path.join(__dirname, "out", "smoke.json");
let smoke;
try {
  if (fs.statSync(smokePath).mtimeMs < started) throw new Error("not written by this run");
  smoke = JSON.parse(fs.readFileSync(smokePath, "utf8"));
} catch (e) {
  console.error(`No smoke results from this run (${smokePath}: ${e.message}); no report written.`);
  process.exit(2);
}

let health = {};
try {
  health = (await createClient().health()) ?? {};
} catch {
  health = {};
}

const results = Array.isArray(smoke.results) ? smoke.results : [];
const report = {
  schema: SCHEMA,
  sourceCommit,
  createdAt: new Date().toISOString(),
  host: { os: process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform, release: os.release() },
  ae: { version: String(health.aeVersion ?? ""), extLoadFailures: Array.isArray(health.extLoadFailures) ? health.extLoadFailures.map(String) : [] },
  panelVersion: String(health.panelVersion ?? ""),
  smoke: {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    fatal: smoke.fatal ? String(smoke.fatal).slice(0, 300) : null,
    checked: results.map((r) => String(r.tool)),
    failed: results.filter((r) => !r.ok).map((r) => ({ tool: String(r.tool), note: String(r.note ?? "").slice(0, 200) })),
    skipped: (smoke.skipped ?? []).map((s) => ({ tool: String(s.tool), why: String(s.why ?? "").slice(0, 200) })),
  },
  manual: Array.isArray(notes.manual) ? notes.manual : [],
  explainedFailures: notes.explainedFailures && typeof notes.explainedFailures === "object" ? notes.explainedFailures : {},
};

const outDir = path.join(repo, "qa", "evidence");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${sourceCommit.slice(0, 12)}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");

const unexplained = report.smoke.failed.filter((f) => String(report.explainedFailures[f.tool] ?? "").trim().length < 10);
console.log(`\nAE ${report.ae.version}, panel ${report.panelVersion}: ${report.smoke.passed}/${report.smoke.total} passed, ${report.smoke.skipped.length} skipped.`);
console.log(`Wrote ${path.relative(repo, outFile)}.`);
if (report.smoke.fatal) console.log(`The smoke test stopped early: ${report.smoke.fatal}. CI will refuse this report.`);
if (unexplained.length) {
  console.log(`\n${unexplained.length} failed check(s) need an explanation before CI accepts the report. Add them to a notes file's "explainedFailures" and run again with --notes:`);
  for (const f of unexplained.slice(0, 20)) console.log(`  "${f.tool}": "…"   (${f.note.slice(0, 100)})`);
}
console.log(`\nCommit it on top of the tested commit: git add ${path.relative(repo, outFile).replace(/\\/g, "/")} && git commit -m "Live evidence"`);
