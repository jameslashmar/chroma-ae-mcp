#!/usr/bin/env node
// scripts/check-live-evidence.mjs — the "Live evidence" check on pull requests.
//
//   node scripts/check-live-evidence.mjs <base sha> <head sha>
//
// No machine in CI runs After Effects, so a PR that changes After Effects code has to
// bring evidence that it ran in a real AE: a report written by `node qa/live-evidence.mjs`
// (qa/evidence/<commit>.json; docs/LIVE-EVIDENCE.md). This script refuses the PR unless
// one such report:
//   - names a commit that is an ancestor of the PR head, with nothing but evidence files
//     and Markdown changed after it (so the code that ran is the code being merged);
//   - ran the full live smoke test to the end, with every failure explained;
//   - covers every tool the PR adds (a smoke step or a manual check names it).
// A PR that changes no After Effects code needs no evidence. Honour-based: a report can be
// written by hand, but then someone wrote a false report rather than forgot a step.
// Plain Node 20, no dependencies. Exits 1 when the evidence is missing or not good enough.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export const SCHEMA = "chroma-ae-mcp.live-evidence.v1";

/** Paths whose changes need evidence from a live After Effects. */
export const AE_CODE = /^(panel\/host\/|panel\/tools\/|panel\/CSXS\/|panel\/client\/[^/]+\.(js|cjs|html)$|server\/src\/)/;
/** What may change after the commit the evidence names. */
export const AFTER_EVIDENCE_OK = /^(qa\/evidence\/[^/]+\.json|.*\.md)$/;
export const EVIDENCE_FILE = /^qa\/evidence\/[^/]+\.json$/;
/** A tool name as a tool definition writes it in server/src. */
export const TOOL_NAME_RE = /name: "(ae_[a-z0-9_]+)"/g;

export function toolNamesIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(TOOL_NAME_RE)) out.add(m[1]);
  return out;
}

/** True when a check label from the smoke test or a manual check names `tool`. */
export function namesTool(label, tool) {
  const s = String(label ?? "");
  return s === tool || s.startsWith(tool + " ") || s.startsWith(tool + "(") || s.startsWith(tool + ":");
}

/**
 * Checks one evidence report. `facts` are what git says about it:
 * { isAncestor: boolean, changedSince: string[] } for report.sourceCommit against the PR head.
 * `newTools`: tool names the PR adds. Returns a list of problems (empty = good evidence).
 */
export function problemsWith(report, facts, newTools) {
  const p = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) return ["not a JSON object"];
  if (report.schema !== SCHEMA) p.push(`schema must be "${SCHEMA}"`);
  if (!/^[0-9a-f]{40}$/.test(String(report.sourceCommit ?? ""))) p.push("sourceCommit must be a full 40-character commit SHA");
  else if (!facts.isAncestor) p.push(`commit ${report.sourceCommit.slice(0, 12)} is not in this PR's history`);
  else {
    const later = (facts.changedSince ?? []).filter((f) => !AFTER_EVIDENCE_OK.test(f));
    if (later.length) p.push(`files changed after the tested commit ${report.sourceCommit.slice(0, 12)}: ${later.slice(0, 8).join(", ")}${later.length > 8 ? ", …" : ""} (run qa/live-evidence.mjs again on the latest commit)`);
  }
  if (!String(report.ae?.version ?? "").trim()) p.push("ae.version is missing");
  if (Array.isArray(report.ae?.extLoadFailures) && report.ae.extLoadFailures.length) p.push(`the panel failed to load host files: ${report.ae.extLoadFailures.slice(0, 3).join(", ")}`);
  const smoke = report.smoke;
  if (!smoke || typeof smoke !== "object") p.push("smoke results are missing");
  else {
    if (smoke.fatal) p.push(`the smoke test stopped early: ${String(smoke.fatal).slice(0, 160)}`);
    if (!(Number(smoke.total) > 0)) p.push("the smoke test ran no checks");
    const explained = report.explainedFailures && typeof report.explainedFailures === "object" ? report.explainedFailures : {};
    const unexplained = (smoke.failed ?? []).filter((f) => String(explained[f.tool] ?? "").trim().length < 10);
    if (unexplained.length) p.push(`failed checks without an explanation (explainedFailures, 10+ characters each): ${unexplained.slice(0, 6).map((f) => f.tool).join("; ")}${unexplained.length > 6 ? "; …" : ""}`);
  }
  const manual = Array.isArray(report.manual) ? report.manual : [];
  for (const m of manual) {
    if (!["pass", "fail", "n/a"].includes(m?.result)) p.push(`manual check "${m?.check}" needs result pass, fail or n/a`);
    else if (m.result === "fail" && String(m.notes ?? "").trim().length < 10) p.push(`manual check "${m.check}" failed without notes`);
  }
  const labels = [...(smoke?.checked ?? []), ...(smoke?.skipped ?? []).map((s) => (typeof s === "string" ? s : s?.tool)), ...manual.map((m) => m?.tool ?? m?.check)];
  const uncovered = [...newTools].filter((t) => !labels.some((l) => namesTool(l, t)));
  if (uncovered.length) p.push(`new tools with no live check (add a step to qa/smoke-mcp.mjs, or a manual check naming the tool): ${uncovered.join(", ")}`);
  return p;
}

/**
 * The whole decision. `changed`: files the PR changes. `reports`: [{ path, report, facts }]
 * for each evidence file the PR adds or changes. Returns { ok, needed, message, used? }.
 */
export function decide(changed, reports, newTools) {
  const ae = changed.filter((f) => AE_CODE.test(f));
  if (!ae.length) return { ok: true, needed: false, message: "No After Effects code changed, so no live evidence is needed." };
  const lead = `This PR changes After Effects code (${ae.slice(0, 5).join(", ")}${ae.length > 5 ? `, and ${ae.length - 5} more` : ""}), so it needs evidence that it ran in After Effects.`;
  if (!reports.length)
    return {
      ok: false,
      needed: true,
      message: `${lead}\n\nNo report found. On a machine with After Effects and this branch's panel installed, run \`node qa/live-evidence.mjs\` on the PR's latest commit, then commit the qa/evidence/<commit>.json it writes. See docs/LIVE-EVIDENCE.md.`,
    };
  const tried = [];
  for (const r of reports) {
    const problems = problemsWith(r.report, r.facts, newTools);
    if (!problems.length) return { ok: true, needed: true, used: r.path, message: `${lead}\n\nGood evidence: ${r.path}.` };
    tried.push(`${r.path}:\n${problems.map((x) => `  - ${x}`).join("\n")}`);
  }
  return { ok: false, needed: true, message: `${lead}\n\nNo report is good enough:\n\n${tried.join("\n\n")}` };
}

// ---------- CLI ----------

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function toolsAt(ref) {
  let text = "";
  try {
    text = git(["grep", "-h", "-o", "-E", 'name: "ae_[a-z0-9_]+"', ref, "--", "server/src"]);
  } catch {
    text = ""; // git grep exits 1 when nothing matches
  }
  return toolNamesIn(text);
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("Usage: node scripts/check-live-evidence.mjs <base sha> <head sha>");
    process.exit(2);
  }
  const mergeBase = git(["merge-base", base, head]);
  const changed = git(["diff", "--name-only", `${mergeBase}..${head}`]).split("\n").filter(Boolean);
  const before = toolsAt(mergeBase);
  const newTools = new Set([...toolsAt(head)].filter((t) => !before.has(t)));
  const reports = [];
  for (const f of changed.filter((x) => EVIDENCE_FILE.test(x))) {
    let report;
    try {
      report = JSON.parse(git(["show", `${head}:${f}`]));
    } catch (e) {
      reports.push({ path: f, report: null, facts: { isAncestor: false } });
      continue;
    }
    const src = String(report?.sourceCommit ?? "");
    let isAncestor = false;
    let changedSince = [];
    if (/^[0-9a-f]{40}$/.test(src)) {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", src, head]);
        isAncestor = true;
        changedSince = git(["diff", "--name-only", `${src}..${head}`]).split("\n").filter(Boolean);
      } catch {
        isAncestor = false;
      }
    }
    reports.push({ path: f, report, facts: { isAncestor, changedSince } });
  }
  const result = decide(changed, reports, newTools);
  console.log(result.message);
  if (newTools.size) console.log(`\nNew tools in this PR: ${[...newTools].join(", ")}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Live evidence: ${result.ok ? "passed" : "missing or not good enough"}\n\n${result.message}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
