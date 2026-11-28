#!/usr/bin/env node
/**
 * qa/bench/run-bench.mjs: does Claude, with this MCP, actually finish everyday After Effects work?
 *
 * For each task in tasks.mjs: a fresh project, the task's setup, a save, then Claude Code runs headless
 * (`claude -p`) with only this MCP (and Read, to look at frames), and the check reads the result back.
 * Recorded per task: pass/fail with the numbers, tool calls (and which failed), turns, tokens, cost, time.
 *
 *   node qa/bench/run-bench.mjs [--tasks T01,T05] [--toolset core|full|default] [--model <alias>]
 *                               [--claude <path to claude>] [--out <dir>] [--timeout-min 15] [--budget-usd 5]
 *
 * Needs After Effects with the panel service running (port 7790), the token, the `claude` CLI logged in,
 * and ffmpeg (T14). Every task is a real Claude session and costs real usage: about $0.3-3 each.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { readToken, DEFAULT_HOST, DEFAULT_PORT } from "../client.js";
import { TASKS } from "./tasks.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const only = opt("tasks", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const toolset = opt("toolset", "core");
const model = opt("model", "");
const claudeBin = opt("claude", process.env.CLAUDE_BIN || "claude");
const timeoutMin = Number(opt("timeout-min", "15"));
const budgetUsd = opt("budget-usd", "5");
const ffmpeg = process.env.FFMPEG || "ffmpeg";
const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
const outDir = path.resolve(opt("out", path.join("qa", "out", "bench", stamp)));
fs.mkdirSync(outDir, { recursive: true });

const token = readToken();
let rpcId = 0;
function post(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: DEFAULT_HOST, port: DEFAULT_PORT, method: "POST", path: "/mcp", timeout: 600_000, headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
async function call(name, a = {}) {
  const raw = await post({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: a } });
  const j = JSON.parse(raw);
  const text = j.result?.content?.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { __text: text, __error: j.error?.message };
  }
}
/** A read-only ExtendScript (function body) through ae_run_jsx; returns its value. */
async function jsx(code) {
  const r = await call("ae_run_jsx", { code, mutates: false, label: "bench check" });
  if (r.ok === false || r.__error) throw new Error(`check script failed: ${r.message ?? r.error ?? r.__error ?? r.__text}`);
  return r.result;
}
async function projectPath() {
  const s = await call("ae_status", {});
  return s.project_path ?? s.project?.path ?? "<unsaved>";
}

/** A fresh project with the task's setup, saved into the task's folder. */
async function prepare(task, dir, files) {
  const cur = await projectPath();
  const n = await call("ae_project_session", { action: "new", if_dirty: "discard", user_confirmed: true, expect: { project_path: cur } });
  if (n.ok === false) throw new Error(`new project: ${n.message ?? n.error}`);
  const s = await call("ae_run_jsx", { code: task.setup(files), mutates: true, label: `bench setup ${task.id}`, expect: { project_path: "<unsaved>" } });
  if (s.ok === false) throw new Error(`setup: ${s.message ?? s.error}`);
  const aep = path.join(dir, `${task.id}.aep`);
  const sv = await call("ae_save", { save_as: { path: aep, overwrite: true }, expect: { project_path: "<unsaved>" } });
  if (sv.ok === false) throw new Error(`save: ${sv.message ?? sv.error}`);
  return aep;
}

const SYSTEM =
  "You are working in After Effects through the chroma-ae MCP tools, unattended, for an automated test. " +
  "Do not ask the user anything (do not call ae_ask_user); make sensible choices and finish the task. " +
  "The project is already open in After Effects. When you are done, say in one line what you did.";

/** Runs Claude Code headless on the prompt; resolves with the stream-json lines and whether it timed out. */
function runClaude(prompt, dir) {
  const mcp = { mcpServers: { "chroma-ae": { type: "http", url: `http://${DEFAULT_HOST}:${DEFAULT_PORT}/mcp`, headers: { Authorization: `Bearer ${token}`, ...(toolset === "default" ? {} : { "X-Chroma-Toolset": toolset }) } } } };
  const cfg = path.join(dir, "mcp.json");
  fs.writeFileSync(cfg, JSON.stringify(mcp));
  const argv = [
    "-p", prompt,
    "--mcp-config", cfg, "--strict-mcp-config",
    "--tools", "Read",
    "--allowedTools", "mcp__chroma-ae",
    "--permission-mode", "bypassPermissions",
    "--append-system-prompt", SYSTEM,
    "--output-format", "stream-json", "--verbose",
    "--max-turns", "60",
    "--max-budget-usd", budgetUsd,
    "--no-session-persistence",
    ...(model ? ["--model", model] : []),
  ];
  const transcript = path.join(dir, "transcript.jsonl");
  return new Promise((resolve) => {
    const out = fs.createWriteStream(transcript);
    const child = spawn(claudeBin, argv, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.pipe(out);
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMin * 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      out.end(() => resolve({ transcript, code, timedOut, stderr: err.slice(-2000) }));
    });
  });
}

/** Tool calls, failures, turns, tokens, cost and the final line from a stream-json transcript. */
function summarise(transcript) {
  const lines = fs
    .readFileSync(transcript, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const calls = [];
  const byId = new Map();
  let final = null;
  let model = null;
  for (const m of lines) {
    if (m.type === "system" && m.subtype === "init") model = m.model;
    if (m.type === "assistant") {
      for (const c of m.message?.content ?? []) {
        if (c.type === "tool_use") {
          const e = { tool: c.name.replace(/^mcp__chroma-ae__/, ""), failed: false, why: "" };
          calls.push(e);
          byId.set(c.id, e);
        }
      }
    }
    if (m.type === "user") {
      for (const c of m.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const e = byId.get(c.tool_use_id);
        if (!e) continue;
        const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join(" ");
        if (c.is_error || /^\{"ok":false|"isError":true/.test(text)) {
          e.failed = true;
          e.why = text.replace(/\s+/g, " ").slice(0, 160);
        }
      }
    }
    if (m.type === "result") final = m;
  }
  const u = final?.usage ?? {};
  return {
    model,
    tool_calls: calls.length,
    failed_calls: calls.filter((c) => c.failed).length,
    tools: calls.map((c) => c.tool + (c.failed ? "!" : "")),
    failures: calls.filter((c) => c.failed).map((c) => `${c.tool}: ${c.why}`),
    turns: final?.num_turns ?? null,
    cost_usd: final?.total_cost_usd ?? null,
    duration_s: final?.duration_ms ? Math.round(final.duration_ms / 1000) : null,
    tokens: { input: u.input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
    stop: final?.subtype ?? "no result",
    said: (final?.result ?? "").replace(/\s+/g, " ").slice(0, 300),
  };
}

const tasks = TASKS.filter((t) => only.length === 0 || only.some((o) => t.id.startsWith(o)));
console.log(`Bench: ${tasks.length} task(s), toolset ${toolset}${model ? `, model ${model}` : ""}, out ${outDir}`);
const results = [];
for (const task of tasks) {
  const dir = path.join(outDir, task.id);
  fs.mkdirSync(dir, { recursive: true });
  const row = { id: task.id, title: task.title };
  try {
    const files = task.files ? task.files(dir, { ffmpeg }) : {};
    await prepare(task, dir, files);
    const prompt = task.prompt(files);
    row.prompt = prompt;
    const started = Date.now();
    const run = await runClaude(prompt, dir);
    row.wall_s = Math.round((Date.now() - started) / 1000);
    row.timed_out = run.timedOut;
    Object.assign(row, summarise(run.transcript));
    if (run.code !== 0 && !run.timedOut) row.exit = `claude exited ${run.code}: ${run.stderr.slice(-300)}`;
    const verdict = await task.check({ call, jsx, files, dir });
    row.pass = verdict.pass;
    row.checks = verdict.checks;
  } catch (err) {
    row.pass = false;
    row.error = err instanceof Error ? err.message : String(err);
  }
  results.push(row);
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`${row.pass ? "PASS" : "FAIL"}  ${task.id}  ${row.tool_calls ?? "-"} calls (${row.failed_calls ?? 0} failed), $${row.cost_usd?.toFixed?.(2) ?? "-"}, ${row.duration_s ?? row.wall_s ?? "-"} s${row.error ? `  ERROR ${row.error}` : ""}`);
  for (const c of row.checks ?? []) if (c.startsWith("FAIL")) console.log(`      ${c}`);
}

// Summary
const passed = results.filter((r) => r.pass).length;
const sum = (k) => results.reduce((a, r) => a + (typeof r[k] === "number" ? r[k] : 0), 0);
const md = [
  `# Task bench ${stamp}`,
  "",
  `${passed}/${results.length} passed. Toolset ${toolset}, model ${results.find((r) => r.model)?.model ?? model ?? "default"}. Total $${sum("cost_usd").toFixed(2)}, ${sum("tool_calls")} tool calls (${sum("failed_calls")} failed), ${Math.round(sum("duration_s") / 60)} min.`,
  "",
  "| Task | Result | Tool calls (failed) | Turns | Cost | Time |",
  "|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.id} ${r.title} | ${r.pass ? "pass" : "**fail**"} | ${r.tool_calls ?? "-"} (${r.failed_calls ?? 0}) | ${r.turns ?? "-"} | $${r.cost_usd?.toFixed?.(2) ?? "-"} | ${r.duration_s ?? r.wall_s ?? "-"} s |`),
  "",
  ...results.flatMap((r) => [
    `## ${r.id}: ${r.pass ? "pass" : "FAIL"}`,
    "",
    `Prompt: ${r.prompt ?? "-"}`,
    "",
    ...(r.checks ?? []).map((c) => `- ${c}`),
    ...(r.error ? [`- ERROR ${r.error}`] : []),
    ...(r.failures?.length ? ["", "Failed tool calls:", ...r.failures.map((f) => `- ${f}`)] : []),
    "",
    `Tools: ${(r.tools ?? []).join(", ")}`,
    "",
    `Claude said: ${r.said ?? "-"}`,
    "",
  ]),
].join("\n");
fs.writeFileSync(path.join(outDir, "summary.md"), md);
console.log(`\n${passed}/${results.length} passed. $${sum("cost_usd").toFixed(2)} in all. ${path.join(outDir, "summary.md")}`);
