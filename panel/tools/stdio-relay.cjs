#!/usr/bin/env node
// Stdio relay for MCP clients that can only launch a command, such as
// Claude Desktop (Chat and Cowork). Each JSON-RPC line from stdin is POSTed
// to the MCP the panel serves at http://127.0.0.1:7790/mcp, so every client
// shares the panel's single-writer queue. No dependencies.
//
// - The token is read from the data dir on every request, so "Regenerate
//   token" in the panel needs no config change.
// - Requests have no timeout: renders can take minutes, and the panel must
//   never see an in-flight evalScript abandoned.
// - While AE is closed, initialize is answered here (with the panel's
//   capabilities: tools, prompts, resources) and tools/list, prompts/list and
//   resources/list come from the last lists the panel served, and prompts/get
//   and resources/read from the guidance text it served, so everything stays
//   registered and readable; a tool call tells the user to start AE.
// - The toolset. "core" is a small tool list (a few everyday tools plus ae_search_tools /
//   ae_get_tool_schema / ae_invoke_tool); "full" is every tool. The relay sends core on every
//   request in an X-Chroma-Toolset header; full sends nothing.
//   * CHROMA_AE_MCP_TOOLSET set: it wins ("core", "full"; anything else is logged once and
//     treated as full).
//   * Unset: decided at the client's initialize from params.clientInfo.name. Claude Desktop
//     (believed to be "claude-ai", matched exactly, case-insensitively) gets core; every other
//     client (Cursor, Codex, ...) gets full. Before an initialize it is full.
//   The choice is logged once on stderr (the host's MCP log) with the client name and the
//   reason. The tool list cache is kept per toolset.
// - X-Chroma-Client carries the client's name (sanitised, at most 40 characters) on every
//   request once known; the panel's usage log records it.
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");

// Mirrors resolveStateDir() in panel/client/common.js, NOT defaultDataDir() in
// server/src/quarantine.ts — those two disagree on the non-Windows/non-macOS
// fallback, and it's common.js's dir that the panel actually writes token to
// (see writeTokenFile there). Mirroring the wrong one left this relay looking
// for the token in a directory the panel never writes to on that platform.
function dataDir() {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "chroma-ae-mcp");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "chroma-ae-mcp");
  }
  return path.join(os.homedir(), ".chroma-ae-mcp");
}

function resolvePort() {
  const n = Number.parseInt((process.env.CHROMA_AE_MCP_PORT || "").trim(), 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : 7790;
}

// The environment's choice: { set, toolset, note }. Unset leaves the choice to the client's name.
// A set value that is not "core" or "full" behaves as full, with one line on stderr.
function resolveToolset() {
  const raw = process.env.CHROMA_AE_MCP_TOOLSET;
  if (raw === undefined) return { set: false, toolset: "full", note: "" };
  const v = String(raw).trim().toLowerCase();
  if (v === "" || v === "full") return { set: true, toolset: "full", note: "" };
  if (v === "core") return { set: true, toolset: "core", note: "" };
  return {
    set: true,
    toolset: "full",
    note: "CHROMA_AE_MCP_TOOLSET=" + JSON.stringify(String(raw).slice(0, 40)) + " is not 'core' or 'full'; using the full tool list.",
  };
}

// Client names that get core when the environment does not choose. Exact, lower case.
const CORE_CLIENTS = ["claude-ai"];

// A client name that is safe in a header and a log line: printable ASCII only, one line, 40 characters.
function sanitizeClientName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[^ -~]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

const PORT = resolvePort();
const ENV_TOOLSET = resolveToolset();
// The live choice. With the variable set it is fixed from the start; otherwise it stays full until
// the client's initialize names itself (see observeInitialize).
const TOOLSET = { toolset: ENV_TOOLSET.toolset };
let clientName = "";
let toolsetDecided = false;
const TOKEN_PATH = path.join(dataDir(), "token");

// Keep in step with server/src/mcp-rpc.ts.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// The version comes from the repo's VERSION file (relay at panel/tools/), or, in the packaged
// extension where scripts/package.ps1 stamps CSXS/manifest.xml instead, from the manifest's
// ExtensionBundleVersion. Falls back to 0.0.0.
function readVersion() {
  const semver = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
  try {
    const v = fs.readFileSync(path.join(__dirname, "..", "..", "VERSION"), "utf8").trim();
    if (semver.test(v)) return v;
  } catch {
    // not in the repo layout
  }
  try {
    const xml = fs.readFileSync(path.join(__dirname, "..", "CSXS", "manifest.xml"), "utf8");
    const m = /ExtensionBundleVersion="([^"]+)"/.exec(xml);
    if (m && semver.test(m[1])) return m[1];
  } catch {
    // no manifest beside the relay
  }
  return "0.0.0";
}

const SERVER_INFO = { name: "chroma-ae-mcp", version: readVersion() };

// Methods the panel's MCP serves. Anything else is "method not found" even offline.
const KNOWN_METHODS = [
  "initialize", "ping", "tools/list", "tools/call", "prompts/list", "prompts/get", "resources/list", "resources/read",
];

const NOT_RUNNING =
  "After Effects is not reachable. Start After Effects and wait until " +
  "Window > Extensions > Chroma AE MCP shows Connected, then try again.";

class PanelUnavailable extends Error {}

function log(msg) {
  process.stderr.write("[chroma-ae relay] " + msg + "\n");
}

if (ENV_TOOLSET.note) log(ENV_TOOLSET.note);

// Called with each incoming message before it is handled. The first initialize fixes the toolset
// (once) and the client name, and logs the choice once.
function observeInitialize(message) {
  const list = Array.isArray(message) ? message : [message];
  for (const m of list) {
    if (toolsetDecided) return;
    if (!m || typeof m !== "object" || m.method !== "initialize") continue;
    const info = m.params && typeof m.params === "object" && m.params.clientInfo && typeof m.params.clientInfo === "object" ? m.params.clientInfo : {};
    clientName = sanitizeClientName(info.name);
    toolsetDecided = true;
    let why;
    if (ENV_TOOLSET.set) {
      why = "env";
    } else if (clientName && CORE_CLIENTS.indexOf(clientName.toLowerCase()) >= 0) {
      TOOLSET.toolset = "core";
      why = "client " + clientName;
    } else {
      why = "default full";
    }
    log("toolset " + TOOLSET.toolset + " (" + why + "); client " + JSON.stringify(clientName || "unknown"));
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch (err) {
    throw new PanelUnavailable(NOT_RUNNING + " (No token at " + TOKEN_PATH + ".)");
  }
}

function post(bodyText) {
  const token = readToken();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/mcp",
        method: "POST",
        headers: Object.assign(
          {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Content-Length": Buffer.byteLength(bodyText),
          },
          // The panel is stateless, so the choice goes with every request. A panel that does
          // not know the header ignores it and serves the full list.
          TOOLSET.toolset === "core" ? { "X-Chroma-Toolset": "core" } : {},
          clientName ? { "X-Chroma-Client": clientName } : {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") })
        );
        res.on("error", reject);
      }
    );
    req.on("error", (err) => reject(new PanelUnavailable(NOT_RUNNING + " (" + err.message + ")")));
    req.end(bodyText);
  });
}

function hasId(msg) {
  return msg && typeof msg === "object" && "id" in msg && msg.id !== undefined;
}

// The last lists the panel served, one file per key so several relay processes (Claude Desktop
// can start more than one) never read-modify-write a shared file. Each holds {<key>: [...]}.
const LIST_RESULT_KEY = { "tools/list": "tools", "prompts/list": "prompts", "resources/list": "resources" };

function cachePath(key) {
  return path.join(dataDir(), "relay-" + key + "-cache.json");
}

// The file a list is cached in. The core toolset's tool list has its own file
// (relay-tools-core-cache.json), so switching toolsets never shows the other one's list;
// the full list keeps the original name, relay-tools-cache.json.
function listFileKey(key) {
  return key === "tools" && TOOLSET.toolset === "core" ? "tools-core" : key;
}

function readListCache(key) {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(listFileKey(key)), "utf8"));
    return cached && Array.isArray(cached[key]) ? cached[key] : null;
  } catch {
    return null;
  }
}

function writeListCache(key, list) {
  try {
    const file = cachePath(listFileKey(key));
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ [key]: list }));
    fs.renameSync(tmp, file);
  } catch (err) {
    log("could not cache the " + key + " list: " + err.message);
  }
}

// The core toolset's initialize carries `instructions`; keep the last ones so the offline
// initialize (AE closed) can still hand them to the client.
function readInstructionsCache() {
  if (TOOLSET.toolset !== "core") return null;
  try {
    const c = JSON.parse(fs.readFileSync(cachePath("instructions-core"), "utf8"));
    return c && typeof c.instructions === "string" ? c.instructions : null;
  } catch {
    return null;
  }
}

function writeInstructionsCache(text) {
  try {
    const file = cachePath("instructions-core");
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ instructions: text }));
    fs.renameSync(tmp, file);
  } catch (err) {
    log("could not cache the instructions: " + err.message);
  }
}

// The guidance text behind the prompts and resources, so prompts/get and resources/read work
// while AE is closed too. Filled whenever the panel serves a prompt or resource list: each
// resource is read, and each prompt is fetched twice, without its argument and with
// ARG_MARK in it, so an argument given offline lands exactly where the panel would put it.
// Shape: { resources: { <uri>: contents[] }, prompts: { <name>: { arg, plain, marked } } }.
const CONTENT_CACHE = "contents";
const ARG_MARK = "\u0000chroma-relay-arg\u0000";

function readContentCache() {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(CONTENT_CACHE), "utf8"));
    if (c && typeof c === "object" && c.resources && c.prompts) return c;
  } catch {
    // no cache yet
  }
  return null;
}

function writeContentCache(c) {
  try {
    const file = cachePath(CONTENT_CACHE);
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, file);
  } catch (err) {
    log("could not cache the guidance text: " + err.message);
  }
}

let prefetched = false;
let warnedOldPanel = false;
let prefetchId = 0;

async function ask(method, params) {
  const res = await post(JSON.stringify({ jsonrpc: "2.0", id: "relay-prefetch-" + ++prefetchId, method, params }));
  const body = JSON.parse(res.text);
  if (!body || !body.result) throw new Error(method + " failed: " + JSON.stringify(body && body.error));
  return body.result;
}

// Once per process, after the panel answered a list: fetch every prompt and resource it serves.
async function prefetchContents() {
  if (prefetched) return;
  prefetched = true;
  try {
    const cache = { resources: {}, prompts: {} };
    const resources = (await ask("resources/list", {})).resources || [];
    for (const r of resources) {
      if (r && typeof r.uri === "string") cache.resources[r.uri] = (await ask("resources/read", { uri: r.uri })).contents;
    }
    const prompts = (await ask("prompts/list", {})).prompts || [];
    for (const p of prompts) {
      if (!p || typeof p.name !== "string") continue;
      const arg = Array.isArray(p.arguments) && p.arguments[0] ? p.arguments[0].name : null;
      const entry = { arg, plain: await ask("prompts/get", { name: p.name }), marked: null };
      if (arg) entry.marked = await ask("prompts/get", { name: p.name, arguments: { [arg]: ARG_MARK } });
      cache.prompts[p.name] = entry;
    }
    writeContentCache(cache);
  } catch (err) {
    prefetched = false;
    log("could not fetch the guidance text: " + (err && err.message ? err.message : String(err)));
  }
}

// prompts/get from the cache: the plain text, or the marked one with the argument put in.
function cachedPrompt(entry, args) {
  const value = entry.arg && args && typeof args[entry.arg] === "string" ? args[entry.arg].trim() : "";
  if (!value || !entry.marked) return entry.plain;
  return JSON.parse(JSON.stringify(entry.marked), (_k, v) => (typeof v === "string" ? v.split(ARG_MARK).join(value) : v));
}

// The reply for one message while the panel cannot answer, or null to send nothing.
function offlineReply(msg, reason) {
  if (!hasId(msg)) return null;
  const id = msg.id;
  const params = (msg.params && typeof msg.params === "object") ? msg.params : {};
  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.indexOf(asked) >= 0 ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
      const instructions = readInstructionsCache();
      return {
        jsonrpc: "2.0",
        id,
        // The same capabilities as the panel, so a client that starts before AE still
        // asks for prompts and resources (their lists come from the cache below).
        result: Object.assign(
          {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
              prompts: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: SERVER_INFO,
          },
          instructions ? { instructions } : {}
        ),
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
    case "prompts/list":
    case "resources/list": {
      const key = LIST_RESULT_KEY[msg.method];
      const list = readListCache(key);
      if (list) return { jsonrpc: "2.0", id, result: { [key]: list } };
      // Before the panel has ever been reached, an empty list beats an error for these two.
      if (key !== "tools") return { jsonrpc: "2.0", id, result: { [key]: [] } };
      return { jsonrpc: "2.0", id, error: { code: -32000, message: reason } };
    }
    case "tools/call":
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: reason }], isError: true } };
    case "resources/read":
    case "prompts/get": {
      const cache = readContentCache();
      if (!cache) return { jsonrpc: "2.0", id, error: { code: -32000, message: reason } };
      if (msg.method === "resources/read") {
        const contents = typeof params.uri === "string" ? cache.resources[params.uri] : undefined;
        if (contents) return { jsonrpc: "2.0", id, result: { contents } };
        return { jsonrpc: "2.0", id, error: { code: -32002, message: "Resource not found: " + JSON.stringify(params.uri) + ". Use resources/list." } };
      }
      const entry = typeof params.name === "string" ? cache.prompts[params.name] : undefined;
      if (entry) return { jsonrpc: "2.0", id, result: cachedPrompt(entry, params.arguments) };
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params: unknown prompt " + JSON.stringify(params.name) + ". Available: " + Object.keys(cache.prompts).join(", ") } };
    }
    default:
      if (KNOWN_METHODS.indexOf(msg.method) < 0) {
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + String(msg.method) } };
      }
      return { jsonrpc: "2.0", id, error: { code: -32000, message: reason } };
  }
}

function replyOffline(message, reason) {
  const messages = Array.isArray(message) ? message : [message];
  for (const msg of messages) {
    const reply = offlineReply(msg, reason);
    if (reply) send(reply);
  }
}

// A tool call that cannot reach the panel gets the exact reason (relay-diagnose.cjs: AE closed, an
// unsupported AE, no PlayerDebugMode, service down, another AE holds the port, token rejected...)
// instead of one text for everything. Never for initialize, ping or the list calls: they are
// answered offline at once and must stay instant. Any failure of the check, or CHROMA_AE_MCP_DIAGNOSE=off,
// keeps the old text.
// CHROMA_AE_MCP_DIAGNOSE_BUDGET_MS lowers it (a test knob); the default is 6 s.
const DIAGNOSE_BUDGET_MS = (() => {
  const n = Number.parseInt(process.env.CHROMA_AE_MCP_DIAGNOSE_BUDGET_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 6000) : 6000;
})();

function involvesToolCall(message) {
  const list = Array.isArray(message) ? message : [message];
  return list.some((m) => m && typeof m === "object" && hasId(m) && m.method === "tools/call");
}

async function reasonFor(message, fallback) {
  if (!involvesToolCall(message)) return fallback;
  if (String(process.env.CHROMA_AE_MCP_DIAGNOSE || "").trim().toLowerCase() === "off") return fallback;
  let timer;
  try {
    const diag = require("./relay-diagnose.cjs");
    const res = await Promise.race([
      diag.diagnose({ port: PORT, dataDir: dataDir() }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("diagnosis timed out")), DIAGNOSE_BUDGET_MS);
      }),
    ]);
    // ok means the service answers after all (the failed call was a race): keep the old text then.
    if (!res || res.ok || typeof res.message !== "string" || !res.message) return fallback;
    log(res.code + ": " + res.message);
    return res.message + (res.fix && res.fix[0] ? " " + res.fix[0] : "");
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function relay(message) {
  let res;
  try {
    res = await post(JSON.stringify(message));
  } catch (err) {
    if (!(err instanceof PanelUnavailable)) throw err;
    replyOffline(message, await reasonFor(message, err.message));
    return;
  }
  if (res.status === 202) return;
  if (res.status === 401) {
    replyOffline(
      message,
      await reasonFor(message, "The Chroma AE MCP panel rejected the token in " + TOKEN_PATH + ". Restart After Effects.")
    );
    return;
  }
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    replyOffline(message, "The Chroma AE MCP panel sent an unreadable reply (HTTP " + res.status + ").");
    return;
  }
  const listKey = !Array.isArray(message) ? LIST_RESULT_KEY[message.method] : undefined;
  if (listKey && body.result && Array.isArray(body.result[listKey])) {
    const olderPanel =
      listKey === "tools" &&
      TOOLSET.toolset === "core" &&
      !body.result.tools.some((t) => t && t.name === "ae_search_tools");
    if (olderPanel) {
      // An older panel ignores the header and serves the full list. Pass it on, but do not
      // file it under the core toolset.
      if (!warnedOldPanel) {
        warnedOldPanel = true;
        log("the panel does not know the core toolset (no ae_search_tools in its list); showing its full list.");
      }
    } else {
      writeListCache(listKey, body.result[listKey]);
    }
  }
  if (
    !Array.isArray(message) &&
    message.method === "initialize" &&
    TOOLSET.toolset === "core" &&
    body.result &&
    typeof body.result.instructions === "string"
  ) {
    writeInstructionsCache(body.result.instructions);
  }
  send(body);
  // After the reply, so the client never waits on it; the process stays up until it is written.
  if (listKey === "prompts" || listKey === "resources") await prefetchContents();
}

let pending = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

process.stdout.on("error", () => process.exit(0));

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (message === null || typeof message !== "object") {
    send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  observeInitialize(message);
  pending++;
  relay(message)
    .catch((err) => {
      log("relay failed: " + (err && err.stack ? err.stack : String(err)));
      replyOffline(message, "Relay error: " + (err && err.message ? err.message : String(err)));
    })
    .finally(() => {
      pending--;
      maybeExit();
    });
});
rl.on("close", () => {
  stdinClosed = true;
  maybeExit();
});
