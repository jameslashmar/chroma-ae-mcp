// qa/report.js — JUnit XML + Markdown report writer for the AE QA harness.
// Plain Node 20 ESM, zero external dependencies.

import * as fs from "node:fs";
import * as path from "node:path";

export function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generates JUnit XML for a suite result object:
 * `{ suiteName, startedAt, durationMs, scenarios: [{ name, file, status, durationMs, assertions, error, snapshots }] }`
 */
export function buildJUnitXml(suiteResult) {
  const suiteName = suiteResult.suiteName || "chroma-ae-qa";
  const scenarios = suiteResult.scenarios || [];
  const tests = scenarios.length;
  const failures = scenarios.filter((s) => s.status === "failed").length;
  const skipped = scenarios.filter((s) => s.status === "skipped").length;
  const timeSec = ((suiteResult.durationMs || 0) / 1000).toFixed(3);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(suiteName)}" tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}" time="${timeSec}">`,
    `  <testsuite name="${escapeXml(suiteName)}" tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}" time="${timeSec}">`,
  ];

  for (const s of scenarios) {
    const caseTime = ((s.durationMs || 0) / 1000).toFixed(3);
    const className = s.file ? path.basename(s.file, path.extname(s.file)) : suiteName;
    if (s.status === "passed") {
      lines.push(
        `    <testcase name="${escapeXml(s.name)}" classname="${escapeXml(className)}" time="${caseTime}" />`
      );
    } else if (s.status === "skipped") {
      lines.push(
        `    <testcase name="${escapeXml(s.name)}" classname="${escapeXml(className)}" time="${caseTime}">`,
        `      <skipped />`,
        `    </testcase>`
      );
    } else {
      const errMsg = s.error?.message || String(s.error || "Scenario failed");
      const errStack = s.error?.stack || errMsg;
      lines.push(
        `    <testcase name="${escapeXml(s.name)}" classname="${escapeXml(className)}" time="${caseTime}">`,
        `      <failure message="${escapeXml(errMsg)}" type="${escapeXml(s.error?.name || "Error")}">${escapeXml(errStack)}</failure>`,
        `    </testcase>`
      );
    }
  }

  lines.push("  </testsuite>", "</testsuites>", "");
  return lines.join("\n");
}

/**
 * Generates a Markdown summary report with scenario table, failure diagnostics, and snapshot links.
 */
export function buildMarkdownReport(suiteResult) {
  const suiteName = suiteResult.suiteName || "Chroma AE QA Report";
  const scenarios = suiteResult.scenarios || [];
  const passed = scenarios.filter((s) => s.status === "passed").length;
  const failed = scenarios.filter((s) => s.status === "failed").length;
  const skipped = scenarios.filter((s) => s.status === "skipped").length;
  const totalSec = ((suiteResult.durationMs || 0) / 1000).toFixed(2);

  const lines = [
    `# ${suiteName}`,
    "",
    `- **Passed:** ${passed}`,
    `- **Failed:** ${failed}`,
    `- **Skipped:** ${skipped}`,
    `- **Total Duration:** ${totalSec}s`,
    "",
    "| Scenario | Status | Assertions | Duration | Snapshots |",
    "|---|---|---:|---:|---|",
  ];

  for (const s of scenarios) {
    const statusBadge =
      s.status === "passed"
        ? "PASS"
        : s.status === "skipped"
        ? "SKIP"
        : "FAIL";
    const dur = `${s.durationMs || 0}ms`;
    const assertions = typeof s.assertions === "number" ? s.assertions : 0;
    const snaps =
      Array.isArray(s.snapshots) && s.snapshots.length > 0
        ? s.snapshots
            .map((p, idx) => `[frame-${idx + 1}](${String(p).replace(/\\/g, "/")})`)
            .join(", ")
        : "-";
    lines.push(
      `| ${s.name} | ${statusBadge} | ${assertions} | ${dur} | ${snaps} |`
    );
  }

  const failedScenarios = scenarios.filter((s) => s.status === "failed");
  if (failedScenarios.length > 0) {
    lines.push("", "## Failures", "");
    for (const s of failedScenarios) {
      const errMsg = s.error?.message || String(s.error || "Unknown failure");
      lines.push(`### ${s.name}`, "", "```", errMsg, "```", "");
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Writes `junit.xml` and `report.md` into `outDir`.
 */
export function writeReports(suiteResult, outDir) {
  const targetDir = path.resolve(outDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const junitPath = path.join(targetDir, "junit.xml");
  const markdownPath = path.join(targetDir, "report.md");

  fs.writeFileSync(junitPath, buildJUnitXml(suiteResult), "utf8");
  fs.writeFileSync(markdownPath, buildMarkdownReport(suiteResult), "utf8");

  return { junitPath, markdownPath };
}
