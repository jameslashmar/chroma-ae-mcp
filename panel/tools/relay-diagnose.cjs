#!/usr/bin/env node
// Says exactly what is wrong when the Chroma AE MCP panel service cannot be reached, and which
// After Effects owns it. Plain CommonJS, no dependencies, Windows and macOS, no After Effects needed.
//
//   node panel/tools/relay-diagnose.cjs          prints a report; exit 0 when everything is fine, 2 otherwise
//   node panel/tools/relay-diagnose.cjs --json   the same as JSON
//
// Used by the stdio relay (the text of a tool call's error while AE is unreachable) and by the
// ae_diagnostics tool (its `startup` section).
//
//   gather(opts)        collects facts; every probe has its own short timeout and try/catch, a failed
//                       probe becomes null, never an exception.
//   decide(facts)       pure: { code, ok, message, fix[], facts_summary }.
//   formatReport(res)   the multi-line text.
//   diagnose(opts)      gather + decide, cached 15 s per process.
//
// Hard limits: never calls After Effects, never writes a file, reads the token only to send it to
// the service's own /health (it is never put in a fact, a message or a log line).
// CHROMA_AE_MCP_DIAGNOSE=quick skips every probe that starts a process (AE process list, registry,
// port owner); =off makes the relay use its old one-line text.
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const CACHE_MS = 15 * 1000;
const TOTAL_BUDGET_MS = 6 * 1000;
const HTTP_TIMEOUT_MS = 2 * 1000;
const EXEC_TIMEOUT_MS = 3 * 1000;
const BUSY_LONG_MS = 60 * 1000;
const MIN_SUPPORTED_MAJOR = 25; // panel/CSXS/manifest.xml: Host AEFT [25.0,99.9]
const EXTENSION_ID = "london.chroma.aemcp";
const CSXS_VERSIONS = ["11", "12", "13"];

// ---------- locations (mirror panel/client/common.js and stdio-relay.cjs) ----------

function stateDir(env) {
  const e = env || process.env;
  if (process.platform === "win32") {
    return path.join(e.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "chroma-ae-mcp");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "chroma-ae-mcp");
  return path.join(os.homedir(), ".chroma-ae-mcp");
}

function resolvePort(env) {
  const n = Number.parseInt(String((env || process.env).CHROMA_AE_MCP_PORT || "").trim(), 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : 7790;
}

function cepExtensionDirs(env) {
  const e = env || process.env;
  if (process.platform === "win32") {
    const appData = e.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    // The system-wide folder a ZXP installer uses: 32-bit and 64-bit Common Files are both looked at.
    const commons = [e["CommonProgramFiles(x86)"], e.CommonProgramFiles];
    if (!commons[0] && !commons[1]) commons.push("C:\\Program Files (x86)\\Common Files");
    const dirs = [path.join(appData, "Adobe", "CEP", "extensions")];
    commons.forEach((c) => {
      if (!c) return;
      const d = path.join(c, "Adobe", "CEP", "extensions");
      if (dirs.indexOf(d) < 0) dirs.push(d);
    });
    return dirs;
  }
  if (process.platform === "darwin") {
    return [
      path.join(os.homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions"),
      "/Library/Application Support/Adobe/CEP/extensions",
    ];
  }
  return [];
}

function adobeInstallRoot(env) {
  const e = env || process.env;
  if (process.platform === "win32") return path.join(e.ProgramFiles || "C:\\Program Files", "Adobe");
  if (process.platform === "darwin") return "/Applications";
  return null;
}

// ---------- helpers ----------

// Programs this file starts are given by absolute path: a bare name could run a file planted in the working folder.
function systemExe(winRelative, unixPath) {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    return path.join(root, "System32", winRelative);
  }
  return unixPath;
}
const POWERSHELL_EXE = () => systemExe(path.join("WindowsPowerShell", "v1.0", "powershell.exe"), "/usr/bin/pwsh");
const REG_EXE = () => systemExe("reg.exe", "/usr/bin/false");
const NETSTAT_EXE = () => systemExe("netstat.exe", "/usr/bin/false");

function withTimeout(promise, ms, label) {
  let timer;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error((label || "probe") + " timed out after " + ms + " ms")), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function safe(fn, failed, name) {
  try {
    return await fn();
  } catch (err) {
    if (failed) failed.push(name + ": " + (err && err.message ? err.message : String(err)));
    return null;
  }
}

function defaultExec(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs || EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout || "");
          err.stderr = String(stderr || "");
          reject(err);
        } else {
          resolve({ stdout: String(stdout || "") });
        }
      }
    );
  });
}

function defaultHttpGet(port, token, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const headers = token ? { Authorization: "Bearer " + token } : {};
    const req = http.request({ host: "127.0.0.1", port, path: "/health", method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => finish({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => finish({ error: e.code || e.message }));
    });
    req.setTimeout(timeoutMs || HTTP_TIMEOUT_MS, () => {
      finish({ error: "timeout" });
      req.destroy();
    });
    req.on("error", (e) => finish({ error: e.code || e.message || "error" }));
    req.end();
  });
}

/** "Adobe After Effects 2026" / "(Beta)" in a path or command line -> "2026" / "Beta" / null. */
function aeLabelFromPath(p) {
  const m = /Adobe After Effects\s*(\(Beta\)|Beta|\d{4})/i.exec(String(p || ""));
  if (!m) return null;
  return /beta/i.test(m[1]) ? "Beta" : m[1];
}

function majorFromLabel(label) {
  if (!label || !/^\d{4}$/.test(label)) return null; // Beta: unknown, assume supported
  return Number(label) - 2000;
}

function aeName(proc) {
  return "After Effects " + (proc.label || "(version unknown)");
}

function describeProc(proc) {
  return aeName(proc) + (proc.pid ? " (pid " + proc.pid + ")" : "");
}

function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

// ---------- process list ----------

function parseWindowsProcesses(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((r) => r && typeof r === "object")
    .map((r) => classifyProcess({
      pid: Number(r.ProcessId) || null,
      path: r.ExecutablePath ? String(r.ExecutablePath) : "",
      command: r.CommandLine ? String(r.CommandLine) : "",
      started_at: r.Started ? String(r.Started) : null,
    }));
}

function parseMacProcesses(stdout) {
  const out = [];
  String(stdout || "")
    .split(/\r?\n/)
    .forEach((line) => {
      // "  123 Mon Nov  6 20:33:51 2026 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects"
      const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
      if (!m) return;
      const command = m[3];
      if (!/Adobe After Effects[^/]*\.app\/Contents\/MacOS\//i.test(command)) return;
      const started = new Date(m[2]);
      out.push(classifyProcess({
        pid: Number(m[1]),
        path: command,
        command,
        started_at: Number.isNaN(started.getTime()) ? null : started.toISOString(),
      }));
    });
  return out;
}

// A render engine (aerender's headless AfterFX) is not the user's After Effects. How it looks in
// the process list is a guess (a "-noui" flag or aerender in the command line): see the live checklist.
function classifyProcess(p) {
  const label = aeLabelFromPath(p.path) || aeLabelFromPath(p.command);
  const engine = /(^|\s)-noui(\s|$)/i.test(p.command) || /\baerender\b/i.test(p.command);
  return {
    pid: p.pid,
    path: p.path,
    label,
    major: majorFromLabel(label),
    started_at: p.started_at,
    engine,
  };
}

async function probeProcesses(exec) {
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance -ClassName Win32_Process -Filter 'Name=''AfterFX.exe''' | " +
      "Select-Object ProcessId,ExecutablePath,CommandLine,@{n='Started';e={$_.CreationDate.ToString('o')}} | " +
      "ConvertTo-Json -Compress";
    const res = await exec(POWERSHELL_EXE(), ["-NoProfile", "-NonInteractive", "-Command", script], EXEC_TIMEOUT_MS);
    const list = parseWindowsProcesses(res.stdout);
    if (list === null) throw new Error("unreadable process list");
    return list;
  }
  if (process.platform === "darwin") {
    const res = await exec("/bin/ps", ["-axo", "pid=,lstart=,command="], EXEC_TIMEOUT_MS);
    return parseMacProcesses(res.stdout);
  }
  return null;
}

// ---------- PlayerDebugMode ----------

async function probeDebugMode(exec) {
  const out = {};
  for (const v of CSXS_VERSIONS) {
    try {
      if (process.platform === "win32") {
        const res = await exec(REG_EXE(), ["query", "HKCU\\Software\\Adobe\\CSXS." + v, "/v", "PlayerDebugMode"], EXEC_TIMEOUT_MS);
        const m = /PlayerDebugMode\s+REG_\w+\s+(\S+)/i.exec(res.stdout);
        out[v] = m ? m[1] === "1" || /^0x0*1$/i.test(m[1]) : false;
      } else if (process.platform === "darwin") {
        const res = await exec("/usr/bin/defaults", ["read", "com.adobe.CSXS." + v, "PlayerDebugMode"], EXEC_TIMEOUT_MS);
        out[v] = String(res.stdout).trim() === "1";
      } else {
        out[v] = null;
      }
    } catch (err) {
      // reg and defaults exit non-zero when the key or value is missing: that is "not set", not a failure.
      out[v] = typeof err.code === "number" ? false : null;
    }
  }
  return out;
}

// ---------- who holds the port ----------

async function probePortHolder(exec, port) {
  if (process.platform === "win32") {
    const res = await exec(NETSTAT_EXE(), ["-ano", "-p", "tcp"], EXEC_TIMEOUT_MS);
    let pid = null;
    String(res.stdout)
      .split(/\r?\n/)
      .forEach((line) => {
        const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && Number(m[2]) === port && pid === null) pid = Number(m[3]);
      });
    if (pid === null) return null;
    let name = null;
    try {
      const psExe = POWERSHELL_EXE();
      const n = await exec(
        fs.existsSync(psExe) ? psExe : "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + pid + " -ErrorAction SilentlyContinue).ProcessName"],
        EXEC_TIMEOUT_MS
      );
      name = String(n.stdout).trim() || null;
    } catch (e) {
      name = null;
    }
    return { pid, name };
  }
  if (process.platform === "darwin") {
    const res = await exec("/usr/sbin/lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-Fpc"], EXEC_TIMEOUT_MS);
    const pid = /^p(\d+)$/m.exec(res.stdout);
    const cmd = /^c(.+)$/m.exec(res.stdout);
    return pid ? { pid: Number(pid[1]), name: cmd ? cmd[1] : null } : null;
  }
  return null;
}

// ---------- gather ----------

function installedVersions(root) {
  if (!root) return null;
  const names = fs.readdirSync(root).filter((n) => /^Adobe After Effects/i.test(n));
  const labels = names.map((n) => aeLabelFromPath(n)).filter(Boolean);
  labels.sort();
  return labels;
}

// A signed package carries META-INF/signatures.xml; the development install is a junction or symlink to
// the repo, or has the .debug file. Anything else is unknown (null): the check never claims
// "unsigned panels are blocked" for a panel it cannot tell is unsigned.
function panelSigned(ext) {
  try {
    if (fs.existsSync(path.join(ext, "META-INF", "signatures.xml"))) return true;
    if (fs.lstatSync(ext).isSymbolicLink()) return false;
    if (fs.existsSync(path.join(ext, ".debug"))) return false;
  } catch (e) {
    return null;
  }
  return null;
}

function readPanelInstall(env) {
  for (const dir of cepExtensionDirs(env)) {
    const ext = path.join(dir, EXTENSION_ID);
    if (!fs.existsSync(ext)) continue;
    let version = null;
    try {
      const m = /ExtensionBundleVersion="([^"]+)"/.exec(fs.readFileSync(path.join(ext, "CSXS", "manifest.xml"), "utf8"));
      if (m) version = m[1];
    } catch (e) {
      version = null;
    }
    return { installed: true, dir: ext, version, signed: panelSigned(ext) };
  }
  return { installed: false, dir: cepExtensionDirs(env)[0] || null, version: null };
}

function readOwner(file, now) {
  if (!fs.existsSync(file)) return { present: false };
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { present: true, instance: null, written_at: null, age_ms: null, pid_alive: null };
  }
  const instance = parsed && typeof parsed.instance === "object" ? parsed.instance : null;
  const writtenAt = parsed && parsed.written_at ? Date.parse(parsed.written_at) : NaN;
  let alive = null;
  if (instance && Number.isFinite(instance.pid)) {
    try {
      process.kill(instance.pid, 0);
      alive = true;
    } catch (e) {
      alive = e && e.code === "EPERM";
    }
  }
  return {
    present: true,
    instance,
    written_at: Number.isNaN(writtenAt) ? null : new Date(writtenAt).toISOString(),
    age_ms: Number.isNaN(writtenAt) ? null : now - writtenAt,
    pid_alive: alive,
  };
}

function summariseHealth(res) {
  if (!res || res.error) return { status: null, error: res ? res.error : "no answer", json: false, chroma: false, instance: null };
  let body = null;
  try {
    body = JSON.parse(res.text);
  } catch (e) {
    body = null;
  }
  const isObj = body && typeof body === "object";
  return {
    status: res.status,
    error: null,
    json: !!isObj,
    chroma: !!(isObj && res.status === 200 && body.ok === true && body.startedBy === "service"),
    // service.js answers a bad or missing token with 401 {ok:false,error:{kind:"auth"}}.
    auth_error: !!(isObj && res.status === 401 && body.error && body.error.kind === "auth"),
    instance: isObj && body.instance && typeof body.instance === "object" ? body.instance : null,
    ae_version: isObj && typeof body.aeVersion === "string" ? body.aeVersion : null,
    panel_version: isObj && typeof body.panelVersion === "string" ? body.panelVersion : null,
    busy: !!(isObj && body.busy),
    in_flight: isObj && body.inFlight && typeof body.inFlight === "object"
      ? { label: String(body.inFlight.label || body.inFlight.id || ""), started_at: Number(body.inFlight.startedAt) || null }
      : null,
  };
}

/**
 * opts: { port, dataDir, env, quick, exec, httpGet, now, budgetMs }. All optional; the injected
 * exec / httpGet exist for tests (no process is started, no socket opened).
 */
async function gather(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const now = typeof o.now === "number" ? o.now : Date.now();
  const quick = o.quick !== undefined ? !!o.quick : String(env.CHROMA_AE_MCP_DIAGNOSE || "").toLowerCase() === "quick";
  const port = o.port || resolvePort(env);
  const dir = o.dataDir || stateDir(env);
  const exec = o.exec || defaultExec;
  const httpGet = o.httpGet || defaultHttpGet;
  const failed = [];
  const tokenPath = path.join(dir, "token");

  let token = "";
  const tokenFact = await safe(
    () => {
      if (!fs.existsSync(tokenPath)) return { present: false, valid: false };
      token = fs.readFileSync(tokenPath, "utf8").trim();
      return { present: true, valid: /^[0-9a-fA-F]{64}$/.test(token) };
    },
    failed,
    "token"
  );

  const jobs = {
    owner: safe(() => readOwner(path.join(dir, "owner.json"), now), failed, "owner"),
    health: safe(async () => summariseHealth(await httpGet(port, token, HTTP_TIMEOUT_MS)), failed, "health"),
    panel: safe(() => readPanelInstall(env), failed, "panel"),
    installed: safe(() => installedVersions(adobeInstallRoot(env)), failed, "installed"),
    processes: quick ? Promise.resolve(null) : safe(() => probeProcesses(exec), failed, "processes"),
    debug: quick ? Promise.resolve(null) : safe(() => probeDebugMode(exec), failed, "debug"),
  };
  const names = Object.keys(jobs);
  // Each fact is kept as soon as its probe answers: a budget that runs out costs only the probes still running.
  const r = {};
  names.forEach((n) => {
    r[n] = null;
    jobs[n].then((v) => {
      r[n] = v;
    });
  });
  await withTimeout(Promise.all(names.map((n) => jobs[n])), o.budgetMs || TOTAL_BUDGET_MS, "diagnose").catch((err) => {
    failed.push(err.message);
  });
  // Only when something other than our service answered (or nothing did), who holds the port.
  let holder = null;
  if (!quick && r.health && !r.health.chroma) {
    holder = await safe(() => withTimeout(probePortHolder(exec, port), EXEC_TIMEOUT_MS, "port holder"), failed, "port holder");
  }

  const procs = Array.isArray(r.processes) ? r.processes : null;
  return {
    now,
    platform: process.platform,
    port,
    quick,
    state_dir: dir,
    token: tokenFact,
    owner: r.owner,
    health: r.health,
    processes: procs
      ? { interactive: procs.filter((p) => !p.engine), engines: procs.filter((p) => p.engine) }
      : null,
    installed: r.installed,
    panel: r.panel,
    debug_mode: r.debug,
    port_holder: holder,
    probes_failed: failed,
  };
}

// ---------- decide (pure) ----------

function isSupported(proc) {
  return proc.major === null || proc.major >= MIN_SUPPORTED_MAJOR;
}

function sameInstall(proc, hostPath) {
  if (!proc || !hostPath || !proc.path) return false;
  const a = String(proc.path).replace(/\\/g, "/").toLowerCase();
  const b = String(hostPath).replace(/\\/g, "/").toLowerCase();
  return a.indexOf(b) === 0 || b.indexOf(a.replace(/\/[^/]*$/, "")) === 0;
}

function summaryLines(f) {
  const lines = [];
  lines.push("service port: 127.0.0.1:" + f.port);
  if (f.health) {
    if (f.health.status === null) lines.push("service /health: no answer (" + (f.health.error || "unknown") + ")");
    else lines.push("service /health: HTTP " + f.health.status + (f.health.chroma ? " (Chroma AE MCP)" : f.health.json ? " (json, not ours)" : " (not json)"));
  }
  if (f.processes) {
    const ae = f.processes.interactive.map(describeProc);
    lines.push("After Effects running: " + (ae.length ? ae.join(", ") : "none"));
    if (f.processes.engines.length) lines.push("render engines (not counted): " + f.processes.engines.map(describeProc).join(", "));
  } else {
    lines.push("After Effects running: not checked");
  }
  if (f.installed) lines.push("After Effects installed: " + (f.installed.length ? f.installed.join(", ") : "none found") + " (supported: 2025 and newer)");
  if (f.panel) lines.push("panel installed: " + (f.panel.installed ? "yes" + (f.panel.version ? " (" + f.panel.version + ")" : "") : "no"));
  if (f.debug_mode) {
    lines.push("PlayerDebugMode: " + CSXS_VERSIONS.map((v) => "CSXS." + v + "=" + (f.debug_mode[v] === null ? "?" : f.debug_mode[v] ? "1" : "not set")).join(", "));
  }
  if (f.owner && f.owner.present) {
    const i = f.owner.instance;
    lines.push("owner.json: " + (i ? "After Effects " + (i.ae_label || "?") + ", service pid " + i.pid + (f.owner.pid_alive === false ? " (gone)" : "") : "unreadable"));
  }
  if (f.port_holder) lines.push("port held by: " + (f.port_holder.name || "unknown program") + " (pid " + f.port_holder.pid + ")");
  if (f.token) lines.push("token file: " + (f.token.present ? "present" : "missing"));
  if (f.probes_failed && f.probes_failed.length) lines.push("probes that failed: " + f.probes_failed.join("; "));
  return lines;
}

function result(f, code, ok, message, fix) {
  return { code, ok, message, fix, facts_summary: summaryLines(f) };
}

function decide(facts) {
  const f = facts || {};
  const port = f.port || 7790;
  const health = f.health || null;
  const interactive = f.processes ? f.processes.interactive : null;
  const supported = interactive ? interactive.filter(isSupported) : null;
  const prefix = "Chroma AE MCP: ";

  // The port answers.
  if (health && health.status === 401 && health.auth_error) {
    return result(f, "token_rejected", false,
      prefix + "the service on 127.0.0.1:" + port + " rejected the token" + (f.token && f.token.present ? "" : " (there is no token file)") + ".",
      ["Regenerate the token in the Chroma AE MCP panel, run the registration again, and restart the MCP client."]);
  }
  if (health && health.status !== null && health.chroma) {
    const inst = health.instance || null;
    // Which AE owns it, by matching the instance's host path to a process.
    if (interactive && interactive.length >= 2) {
      let owner = null;
      if (inst && inst.host_path) owner = interactive.find((p) => sameInstall(p, inst.host_path)) || null;
      const since = inst && inst.started_at && clock(inst.started_at) ? "since " + clock(inst.started_at) : "";
      let ownerLabel;
      if (owner) {
        ownerLabel = aeName(owner) + " (pid " + owner.pid + (since ? ", " + since : "") + ")";
      } else {
        const detail = [inst && inst.pid ? "service pid " + inst.pid : "", since].filter(Boolean).join(", ");
        ownerLabel = "After Effects " + ((inst && inst.ae_label) || health.ae_version || "(version unknown)") + (detail ? " (" + detail + ")" : "");
      }
      const others = interactive.filter((p) => p !== owner);
      return result(f, "other_ae_holds_port", false,
        prefix + "the service is held by " + ownerLabel + ". " +
          others.map(describeProc).join(" and ") + (others.length === 1 ? " is" : " are") + " also running and cannot serve MCP.",
        ["Close one of the After Effects windows, or restart the one you want first (the first to start keeps the port)."]);
    }
    if (health.busy && health.in_flight && health.in_flight.started_at && f.now - health.in_flight.started_at >= BUSY_LONG_MS) {
      const mins = Math.round((f.now - health.in_flight.started_at) / 60000);
      return result(f, "service_busy", false,
        prefix + "After Effects is connected but has been busy for " + mins + " min with \"" + health.in_flight.label + "\".",
        ["Call ae_status: it answers at once and says why (popup, script or render)."]);
    }
    const who = inst ? "After Effects " + (inst.ae_label || "") + (inst.pid ? " (service pid " + inst.pid + ")" : "") : "After Effects " + (health.ae_version || "");
    return result(f, "ok", true, prefix + "connected to " + who.trim() + ".", []);
  }
  if (health && health.status !== null) {
    const holder = f.port_holder ? (f.port_holder.name || "another program") + " (pid " + f.port_holder.pid + ")" : "another program";
    return result(f, "port_other_program", false,
      prefix + "127.0.0.1:" + port + " is used by " + holder + " (HTTP " + health.status + "), not by the Chroma AE MCP service.",
      ["Stop that program, or set CHROMA_AE_MCP_PORT to a free port for the service and for every client."]);
  }

  // Nothing answered our request, but a program owns the port.
  if (f.port_holder) {
    const name = (f.port_holder.name || "another program") + " (pid " + f.port_holder.pid + ")";
    return result(f, "port_other_program", false,
      prefix + "127.0.0.1:" + port + " is used by " + name + ", and it did not answer like the Chroma AE MCP service.",
      ["Stop that program, or set CHROMA_AE_MCP_PORT to a free port for the service and for every client."]);
  }

  // Nothing answers on the port.
  const panelKnownMissing = f.panel && f.panel.installed === false;
  if (f.token && f.token.present === false && !(f.owner && f.owner.present)) {
    if (panelKnownMissing) {
      return result(f, "panel_not_installed", false,
        prefix + "the panel is not installed (not found in " + (f.panel.dir || "the CEP extensions folder") + "), and the service has never started on this machine.",
        ["Run scripts/install-dev.ps1 (development) or the installer, restart After Effects and open Window > Extensions > Chroma AE MCP."]);
    }
    return result(f, "no_token", false,
      prefix + "the service has never started on this machine (no token file in " + (f.state_dir || "the data folder") + ").",
      ["Install the panel, start After Effects 2025 or newer, and open Window > Extensions > Chroma AE MCP once."]);
  }
  if (panelKnownMissing) {
    return result(f, "panel_not_installed", false,
      prefix + "the panel is not installed (not found in " + (f.panel.dir || "the CEP extensions folder") + ").",
      ["Run scripts/install-dev.ps1 (development) or the installer, then restart After Effects."]);
  }
  if (interactive && interactive.length === 0) {
    const installed = f.installed && f.installed.length ? " (installed: " + f.installed.join(", ") + "; supported: 2025 and newer)" : "";
    return result(f, "ae_not_running", false,
      prefix + "After Effects is not running" + installed + ".",
      ["Start After Effects 2025 or newer and wait until Window > Extensions > Chroma AE MCP shows Connected."]);
  }
  if (interactive && supported && supported.length === 0) {
    return result(f, "only_unsupported_ae", false,
      prefix + interactive.map(describeProc).join(" and ") + " is running, but the panel needs After Effects 2025 or newer (the extension manifest accepts host versions 25.0 and up), so it does not appear there.",
      ["Start After Effects 2025, 2026 or Beta."]);
  }
  const running = interactive && interactive.length ? interactive.map(describeProc).join(" and ") + (interactive.length === 1 ? " is" : " are") + " running" : "After Effects may be running";
  const dbg = f.debug_mode;
  if (dbg && dbg["12"] === false && dbg["13"] === false && f.panel && f.panel.signed === false) {
    return result(f, "debug_mode_off", false,
      prefix + running + ", but this development install is unsigned and unsigned panels are blocked: PlayerDebugMode is not set in CSXS.12 or CSXS.13.",
      ["Set PlayerDebugMode=1 (scripts/install-dev.ps1 does it) and restart After Effects."]);
  }
  const dbgNote = dbg && (dbg["12"] === true || dbg["13"] === true)
    ? " (" + (dbg["12"] ? "CSXS.12" : "CSXS.13") + " PlayerDebugMode is set.)"
    : "";
  return result(f, "service_down", false,
    prefix + running + ", but the service is not listening on 127.0.0.1:" + port + "." + dbgNote,
    ["Open Window > Extensions > Chroma AE MCP once; After Effects starts the service when the panel is activated. If the entry is missing, check the version" + (f.panel && f.panel.signed === true ? "" : " and PlayerDebugMode") + "; the end of service.log in " + (f.state_dir || "the data folder") + " says why."]);
}

function formatReport(res) {
  const lines = [];
  lines.push(res.ok ? "OK (" + res.code + ")" : "Problem: " + res.code);
  lines.push(res.message);
  if (res.fix && res.fix.length) {
    lines.push("");
    lines.push("What to do:");
    res.fix.forEach((x) => lines.push("  - " + x));
  }
  if (res.facts_summary && res.facts_summary.length) {
    lines.push("");
    lines.push("What was found:");
    res.facts_summary.forEach((x) => lines.push("  " + x));
  }
  return lines.join("\n");
}

// ---------- diagnose (cached) ----------

let cache = null; // { at, key, promise }

/** gather + decide. The result is cached 15 s per process, so a burst of client calls starts PowerShell once. */
function diagnose(opts) {
  const o = opts || {};
  const now = Date.now();
  const key = JSON.stringify([o.port || null, o.dataDir || null, !!o.quick]);
  if (!o.fresh && cache && cache.key === key && now - cache.at < CACHE_MS) return cache.promise;
  const promise = gather(o)
    .then((facts) => Object.assign(decide(facts), { facts }))
    .catch((err) => ({
      code: "unknown",
      ok: false,
      message: "Chroma AE MCP: the check itself failed (" + (err && err.message ? err.message : String(err)) + ").",
      fix: [],
      facts_summary: [],
      facts: null,
    }));
  cache = { at: now, key, promise };
  return promise;
}

function resetCache() {
  cache = null;
}

module.exports = {
  diagnose,
  gather,
  decide,
  formatReport,
  resetCache,
  aeLabelFromPath,
  parseWindowsProcesses,
  parseMacProcesses,
  stateDir,
  resolvePort,
  CACHE_MS,
};

if (require.main === module) {
  const asJson = process.argv.indexOf("--json") >= 0;
  diagnose({ fresh: true }).then((res) => {
    if (asJson) {
      const { facts, ...rest } = res;
      process.stdout.write(JSON.stringify(rest, null, 2) + "\n");
    } else {
      process.stdout.write(formatReport(res) + "\n");
    }
    process.exitCode = res.ok ? 0 : 2;
  });
}
