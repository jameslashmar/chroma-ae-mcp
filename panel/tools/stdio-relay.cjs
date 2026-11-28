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
//   ae_get_tool_schema / ae_invoke_tool); "full" is every tool. The relay sends the choice on every
//   request in an X-Chroma-Toolset header (the panel's own default is core too).
//   * CHROMA_AE_MCP_TOOLSET set: it wins ("core", "full"; anything else is logged once and
//     treated as core).
//   * Unset: every client gets core, Claude Code included. It used to get full on the belief that
//     it loads MCP tool schemas on demand; measured 2026-11-27 (Claude Code 2.1.332) it sent all 136
//     schemas with every request, about 143k tokens. A missing core cache falls back to the full
//     cached list, so nothing is lost.
//   The choice is logged once on stderr (the host's MCP log) with the client name and the
//   reason. The tool list cache is kept per toolset.
// - X-Chroma-Client carries the client's name (sanitised, at most 40 characters) on every
//   request once known; the panel's usage log records it.
// - MCP revision 2026-07-28 (and the Skills extension). A request whose params carry
//   _meta["io.modelcontextprotocol/protocolVersion"] is "modern": no initialize, every request
//   stands alone. Online it is posted as is, plus the headers a 2026-07-28 HTTP client sends
//   (MCP-Protocol-Version, Mcp-Method, Mcp-Name for tools/call, prompts/get and resources/read;
//   a value that is not plain printable ASCII goes as =?base64?...?=), and never
//   X-Chroma-Elicitation. X-Chroma-Client comes from the request's _meta clientInfo when it has a
//   name. The panel's 400 and 404 JSON-RPC error bodies pass through unchanged.
//   * The first modern request with a client name fixes the client name and logs the toolset
//     choice, as the first initialize does.
//   * server/discover fills the instructions cache (core), and after the panel answers a modern
//     skills/list the relay keeps the skill entries and reads every file they list through the panel
//     into the skills cache beside the entries (once per process, serialised with the guidance prefetch;
//     the guidance contents cache is not touched, and a legacy offline resources/read never serves them).
//   * While AE is closed a modern request is answered the way the panel would, in the modern shape
//     (resultType, serverInfo in _meta, ttlMs 0, cacheScope): server/discover is built in, the lists,
//     prompts/get, resources/read, skills/list and skills/get come from the caches, and the
//     validation errors (-32022, -32602, -32601) mirror the panel. Legacy requests are unchanged.
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

// A Microsoft Store app (an MSIX package, such as the Store build of Claude Desktop) and every process
// it starts see a private overlay of AppData: a file created there lands in
// %LOCALAPPDATA%\Packages\<family>\LocalCache\Local\chroma-ae-mcp\token and from then on the packaged
// processes read that copy, not the real token. This lists such copies (Windows only, never throws).
// Mirrors findPackagedTokenCopies() in panel/client/common.js, which this file cannot require:
// the two must stay in step.
function findPackagedTokenCopies() {
  const found = [];
  try {
    if (process.platform !== "win32") return found;
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const packagesDir = path.join(localAppData, "Packages");
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      try {
        if (!entry.isDirectory()) continue;
        const tokenPath = path.join(packagesDir, entry.name, "LocalCache", "Local", "chroma-ae-mcp", "token");
        if (fs.statSync(tokenPath).isFile()) found.push({ package: entry.name, path: tokenPath });
      } catch {}
    }
  } catch {}
  return found;
}

// How long to wait for the service to rewrite a stale packaged copy (it does so when it rejects a request).
const STORE_COPY_WAIT_MS = (() => {
  const n = Number.parseInt(process.env.CHROMA_AE_MCP_STORE_COPY_WAIT_MS || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
})();

function storeAppName(packageName) {
  return /^Claude_/i.test(packageName)
    ? "Claude Desktop (Microsoft Store build)"
    : packageName + " (a Microsoft Store app)";
}

function storeCopyMessage(copy) {
  const isClaude = /^Claude_/i.test(copy.package);
  const copyDir = path.dirname(copy.path);
  return (
    storeAppName(copy.package) + " reads its own copy of the token at " + copy.path +
    ", not the file After Effects writes (" + TOKEN_PATH + "), and that copy is out of date. Quit " +
    (isClaude ? "Claude Desktop" : "that app") + " from the tray, rename the folder " + copyDir +
    " to chroma-ae-mcp.old, then reopen " + (isClaude ? "Claude Desktop" : "it") + "." +
    (isClaude
      ? " Don't remove chroma-ae from claude_desktop_config.json; Claude Desktop doesn't read Claude Code's settings."
      : "")
  );
}

function resolvePort() {
  const n = Number.parseInt((process.env.CHROMA_AE_MCP_PORT || "").trim(), 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : 7790;
}

// The environment's choice: { set, toolset, note }. Unset leaves the choice to the client's name.
// A set value that is not "core" or "full" behaves as full, with one line on stderr.
function resolveToolset() {
  const raw = process.env.CHROMA_AE_MCP_TOOLSET;
  if (raw === undefined) return { set: false, toolset: "core", note: "" };
  const v = String(raw).trim().toLowerCase();
  if (v === "full") return { set: true, toolset: "full", note: "" };
  if (v === "") return { set: true, toolset: "core", note: "" };
  if (v === "core") return { set: true, toolset: "core", note: "" };
  return {
    set: true,
    toolset: "core",
    note: "CHROMA_AE_MCP_TOOLSET=" + JSON.stringify(String(raw).slice(0, 40)) + " is not 'core' or 'full'; using the core tool list.",
  };
}

// A client name that is safe in a header and a log line: printable ASCII only, one line, 40 characters.
function sanitizeClientName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[^ -~]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

const PORT = resolvePort();
const ENV_TOOLSET = resolveToolset();
// The live choice. With the variable set it is fixed from the start; otherwise it starts as core
// and the client's initialize can switch it to full (see observeInitialize).
const TOOLSET = { toolset: ENV_TOOLSET.toolset };
let clientName = "";
// The client said at initialize that it handles elicitation/create: the panel may then ask it questions.
let clientElicits = false;
let toolsetDecided = false;
const TOKEN_PATH = path.join(dataDir(), "token");

// Keep in step with server/src/mcp-rpc.ts.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];
const ALL_PROTOCOL_VERSIONS = MODERN_PROTOCOL_VERSIONS.concat(SUPPORTED_PROTOCOL_VERSIONS);
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const SKILL_URI_PREFIX = "skill://";
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
    const caps = m.params && typeof m.params === "object" && m.params.capabilities && typeof m.params.capabilities === "object" ? m.params.capabilities : {};
    clientElicits = !!caps.elicitation && typeof caps.elicitation === "object";
    toolsetDecided = true;
    logToolsetOnce();
  }
}

// The toolset line goes to stderr once per process, whichever comes first: an initialize or a modern request.
let toolsetLogged = false;
function logToolsetOnce() {
  if (toolsetLogged) return;
  toolsetLogged = true;
  log("toolset " + TOOLSET.toolset + " (" + (ENV_TOOLSET.set ? "env" : "default core") + "); client " + JSON.stringify(clientName || "unknown"));
}

// A modern request has no initialize: its _meta clientInfo names the client. The first one with a
// name fixes the client name (if none is known) and logs the toolset choice once. It does not count as the
// initialize: a client that probes with server/discover and then falls back to initialize is still observed
// there (its name and whether it elicits).
function observeModern(message) {
  const info = modernInfo(message);
  if (!info || !info.client) return;
  if (!clientName) clientName = info.client;
  logToolsetOnce();
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// The request's _meta protocol version, or undefined.
function metaVersion(msg) {
  const meta = isPlainObject(msg) && isPlainObject(msg.params) ? msg.params._meta : undefined;
  return isPlainObject(meta) ? meta[META_VERSION] : undefined;
}

// What the relay needs to know about a modern request (a request with an id, whose _meta names a
// protocol version that is not one of the legacy revisions), or null. client is the sanitised
// _meta clientInfo name, "" when there is none.
function modernInfo(msg) {
  if (!isPlainObject(msg) || !hasId(msg) || typeof msg.method !== "string") return null;
  const v = metaVersion(msg);
  if (typeof v !== "string" || SUPPORTED_PROTOCOL_VERSIONS.indexOf(v) >= 0) return null;
  const info = msg.params._meta[META_CLIENT_INFO];
  let name;
  if (msg.method === "tools/call" || msg.method === "prompts/get") name = msg.params.name;
  else if (msg.method === "resources/read") name = msg.params.uri;
  return {
    version: v,
    method: msg.method,
    name: typeof name === "string" ? name : undefined,
    client: isPlainObject(info) ? sanitizeClientName(info.name) : "",
  };
}

// A header value that is not plain printable ASCII, has leading or trailing whitespace, or itself
// looks like the Base64 sentinel goes as =?base64?<base64 of UTF-8>?= (streamable HTTP, Value Encoding).
function encodeHeaderValue(v) {
  if (/[^ -~]/.test(v) || v !== v.trim() || /^=\?base64\?.*\?=$/i.test(v)) {
    return "=?base64?" + Buffer.from(v, "utf8").toString("base64") + "?=";
  }
  return v;
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

// modern: the modernInfo() of the request in bodyText, or null/undefined for everything else.
function post(bodyText, modern) {
  const token = readToken();
  const client = modern && modern.client ? modern.client : clientName;
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
            // A tools/call with _meta.progressToken is answered as an event stream (progress, then the result).
            Accept: "application/json, text/event-stream",
            "Content-Length": Buffer.byteLength(bodyText),
          },
          // The panel is stateless, so the choice goes with every request, full included (the
          // panel's default is core).
          { "X-Chroma-Toolset": TOOLSET.toolset },
          client ? { "X-Chroma-Client": client } : {},
          // A 2026-07-28 server never sends the client a request, so a modern call never asks for elicitation.
          clientElicits && !modern ? { "X-Chroma-Elicitation": "1" } : {},
          modern
            ? Object.assign(
                {
                  "MCP-Protocol-Version": encodeHeaderValue(modern.version),
                  "Mcp-Method": encodeHeaderValue(modern.method),
                },
                modern.name !== undefined ? { "Mcp-Name": encodeHeaderValue(modern.name) } : {}
              )
            : {}
        ),
      },
      (res) => {
        if (/text\/event-stream/i.test(String(res.headers["content-type"] || ""))) {
          // Progress notifications go out as they arrive; the result is handled below like a JSON reply.
          let buf = "";
          let final = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            buf += c;
            let i;
            while ((i = buf.indexOf("\n\n")) !== -1) {
              const event = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = event
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).replace(/^ /, ""))
                .join("\n");
              if (!data) continue;
              let msg;
              try {
                msg = JSON.parse(data);
              } catch {
                continue;
              }
              // Notifications (progress) and the panel's own requests (elicitation/create) go to the client now;
              // the call's result is the reply handled below.
              if (msg && typeof msg === "object" && !Array.isArray(msg) && (msg.id === undefined || typeof msg.method === "string")) send(msg);
              else final = data;
            }
          });
          res.on("end", () => resolve({ status: res.statusCode || 0, text: final, token }));
          res.on("error", reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8"), token })
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
// The modern resources/list names the skill files, the legacy one the guidance resources, so each
// era has its own cache file (tools and prompts lists are the same in both eras).
const MODERN_RESOURCES_FILE = "resources-modern";
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

// fileKey names a cache file apart from the key's own (the modern resources list, see below).
function readListCache(key, fileKey) {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(fileKey || listFileKey(key)), "utf8"));
    return cached && Array.isArray(cached[key]) ? cached[key] : null;
  } catch {
    return null;
  }
}

let warnedCoreCacheFallback = false;

// The full tool list's cache file, whatever the toolset (the 0.7.0 name).
function readFullToolsCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath("tools"), "utf8"));
    return cached && Array.isArray(cached.tools) ? cached.tools : null;
  } catch {
    return null;
  }
}

function writeListCache(key, list, fileKey) {
  try {
    const file = cachePath(fileKey || listFileKey(key));
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

// The skills cache: { skills: [entries], files: { <skill:// uri>: contents[] } }, written whole.
function writeSkillsCache(skills, files) {
  try {
    const file = cachePath("skills");
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ skills, files }));
    fs.renameSync(tmp, file);
  } catch (err) {
    log("could not cache the skills: " + err.message);
  }
}

function readSkillFiles() {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath("skills"), "utf8"));
    return c && isPlainObject(c.files) ? c.files : null;
  } catch {
    return null;
  }
}

let prefetched = false;
let skillsPrefetched = false;
let warnedOldPanel = false;
let prefetchId = 0;
// Prefetches write the same cache file, so they run one after another.
let prefetchChain = Promise.resolve();
function runPrefetch(task) {
  prefetchChain = prefetchChain.then(task).catch(() => {});
  return prefetchChain;
}

async function ask(method, params) {
  const res = await post(JSON.stringify({ jsonrpc: "2.0", id: "relay-prefetch-" + ++prefetchId, method, params }));
  const body = JSON.parse(res.text);
  if (!body || !body.result) throw new Error(method + " failed: " + JSON.stringify(body && body.error));
  return body.result;
}

// The relay's own modern requests (skill files). The panel needs no initialize for them.
async function askModern(method, params) {
  const msg = {
    jsonrpc: "2.0",
    id: "relay-prefetch-" + ++prefetchId,
    method,
    params: Object.assign({}, params, {
      _meta: {
        [META_VERSION]: MODERN_PROTOCOL_VERSIONS[0],
        [META_CAPABILITIES]: {},
        [META_CLIENT_INFO]: { name: "chroma-ae-relay", version: SERVER_INFO.version },
      },
    }),
  };
  const res = await post(JSON.stringify(msg), modernInfo(msg));
  const body = JSON.parse(res.text);
  if (!body || !body.result) throw new Error(method + " failed: " + JSON.stringify(body && body.error));
  return body.result;
}

// Once per process, after the panel answered a modern skills/list: keep the skill entries and read
// every file they list (into the skills cache, by URI; the guidance contents cache is not touched),
// so skills/get and resources/read of a skill file work while AE is closed. All or nothing: one failed read keeps the old cache.
// An older panel that does not know skills/list never gets here.
async function prefetchSkills(skills) {
  if (skillsPrefetched) return;
  skillsPrefetched = true;
  try {
    const files = {};
    for (const skill of skills) {
      const resources = skill && Array.isArray(skill.resources) ? skill.resources : [];
      for (const r of resources) {
        if (r && typeof r.uri === "string" && !(r.uri in files)) files[r.uri] = (await askModern("resources/read", { uri: r.uri })).contents;
      }
    }
    writeSkillsCache(skills, files);
  } catch (err) {
    skillsPrefetched = false;
    log("could not fetch the skills: " + (err && err.message ? err.message : String(err)));
  }
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

// The tool list for tools/list while the panel cannot answer: the toolset's cache, or for core the
// full cache; null when there is none.
function cachedToolList() {
  let list = readListCache("tools");
  if (!list && TOOLSET.toolset === "core") {
    // An upgrader from 0.7.0 has only the full cache. A full list beats a session with no
    // tools (listChanged is false, so Desktop would not ask again).
    list = readFullToolsCache();
    if (list && !warnedCoreCacheFallback) {
      warnedCoreCacheFallback = true;
      log("no core tools cache yet; answering tools/list from the full cache until AE has served the core list once");
    }
  }
  return list;
}

// Keep in step with server/src/mcp-modern.ts: the panel's modern error codes.
function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: Object.assign({ code, message }, data !== undefined ? { data } : {}) };
}

// How the panel classifies a request (server/src/mcp-modern.ts): "modern", "legacy", or an error reply.
function classifyOffline(msg, params) {
  const meta = isPlainObject(params._meta) ? params._meta : {};
  const v = meta[META_VERSION];
  if (v === undefined) {
    if (msg.method === "server/discover" || msg.method === "skills/list" || msg.method === "skills/get") {
      return rpcError(
        msg.id, -32602,
        "Invalid params: " + msg.method + " needs _meta[\"" + META_VERSION + "\"] (" + MODERN_PROTOCOL_VERSIONS[0] + ")",
        { supported: ALL_PROTOCOL_VERSIONS }
      );
    }
    return "legacy";
  }
  if (typeof v === "string" && MODERN_PROTOCOL_VERSIONS.indexOf(v) >= 0) {
    if (!isPlainObject(meta[META_CAPABILITIES])) {
      return rpcError(msg.id, -32602, "Invalid params: missing _meta[\"" + META_CAPABILITIES + "\"]");
    }
    return "modern";
  }
  if (typeof v === "string" && SUPPORTED_PROTOCOL_VERSIONS.indexOf(v) >= 0) return "legacy";
  return rpcError(msg.id, -32022, "Unsupported protocol version", { supported: ALL_PROTOCOL_VERSIONS, requested: v });
}

// A modern result: the payload plus resultType and the server's identity. cache: "private" or
// "public" for the answers a client may cache; the relay's own answers are never fresh for long, so ttlMs is 0.
function modernResult(id, payload, cache) {
  return {
    jsonrpc: "2.0",
    id,
    result: Object.assign({}, payload, cache ? { ttlMs: 0, cacheScope: cache } : {}, {
      resultType: "complete",
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
    }),
  };
}

// The modern reply while the panel cannot answer (the panel's own shapes, from the caches).
function modernOfflineReply(msg, params, reason) {
  const id = msg.id;
  switch (msg.method) {
    case "server/discover": {
      const instructions = readInstructionsCache();
      return modernResult(
        id,
        Object.assign(
          {
            supportedVersions: ALL_PROTOCOL_VERSIONS,
            capabilities: {
              tools: { listChanged: false },
              prompts: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              extensions: { [SKILLS_EXTENSION]: {} },
            },
          },
          instructions ? { instructions } : {}
        ),
        "private"
      );
    }
    case "tools/list": {
      const tools = cachedToolList();
      return tools ? modernResult(id, { tools }, "private") : rpcError(id, -32603, reason);
    }
    case "prompts/list":
      return modernResult(id, { prompts: readListCache("prompts") || [] }, "public");
    case "resources/list":
      return modernResult(id, { resources: readListCache("resources", MODERN_RESOURCES_FILE) || [] }, "public");
    case "resources/templates/list":
      return modernResult(id, { resourceTemplates: [] }, "public");
    case "tools/call":
      return modernResult(id, { content: [{ type: "text", text: reason }], isError: true });
    case "resources/read":
    case "prompts/get": {
      if (msg.method === "resources/read" && typeof params.uri === "string" && params.uri.startsWith(SKILL_URI_PREFIX)) {
        const files = readSkillFiles();
        if (!files) return rpcError(id, -32603, reason);
        if (Object.prototype.hasOwnProperty.call(files, params.uri) && files[params.uri]) return modernResult(id, { contents: files[params.uri] }, "public");
        return rpcError(id, -32602, "Resource not found: " + params.uri, { uri: params.uri });
      }
      const cache = readContentCache();
      if (!cache) return rpcError(id, -32603, reason);
      if (msg.method === "resources/read") {
        const contents = typeof params.uri === "string" && Object.prototype.hasOwnProperty.call(cache.resources, params.uri) ? cache.resources[params.uri] : undefined;
        if (contents) return modernResult(id, { contents }, "public");
        return rpcError(id, -32602, "Resource not found: " + String(params.uri), { uri: params.uri });
      }
      const entry = typeof params.name === "string" && Object.prototype.hasOwnProperty.call(cache.prompts, params.name) ? cache.prompts[params.name] : undefined;
      if (entry) return modernResult(id, cachedPrompt(entry, params.arguments));
      return rpcError(id, -32602, "Invalid params: unknown prompt " + JSON.stringify(params.name) + ". Available: " + Object.keys(cache.prompts).join(", "));
    }
    case "skills/list":
      return modernResult(id, { skills: readListCache("skills") || [] }, "public");
    case "skills/get": {
      if (typeof params.uri !== "string") return rpcError(id, -32602, "Invalid params: uri is required");
      const skills = readListCache("skills");
      if (!skills) return rpcError(id, -32603, reason);
      const skill = skills.find((s) => s && s.uri === params.uri);
      if (!skill) return rpcError(id, -32602, "No skill is served at " + params.uri);
      return modernResult(id, { skill }, "public");
    }
    default:
      return rpcError(id, -32601, "Method not found: " + String(msg.method));
  }
}

// The reply for one message while the panel cannot answer, or null to send nothing.
function offlineReply(msg, reason) {
  if (!hasId(msg)) return null;
  const id = msg.id;
  const params = (msg.params && typeof msg.params === "object") ? msg.params : {};
  // Keep in step with server/src/mcp-rpc.ts (era classification): a request that names a 2026-07-28
  // protocol version in _meta is answered in the modern shape; everything else as before.
  const era = classifyOffline(msg, params);
  if (typeof era === "object") return era;
  if (era === "modern") return modernOfflineReply(msg, params, reason);
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
      let list = readListCache(key);
      if (!list && key === "tools" && TOOLSET.toolset === "core") {
        // An upgrader from 0.7.0 has only the full cache. A full list beats a session with no
        // tools (listChanged is false, so Desktop would not ask again).
        list = readFullToolsCache();
        if (list && !warnedCoreCacheFallback) {
          warnedCoreCacheFallback = true;
          log("no core tools cache yet; answering tools/list from the full cache until AE has served the core list once");
        }
      }
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
  // The client's answer to a request the panel sent (elicitation/create): pass it on; there is nothing to reply.
  if (message && typeof message === "object" && !Array.isArray(message) && message.method === undefined && ("result" in message || "error" in message)) {
    try {
      await post(JSON.stringify(message));
    } catch (err) {
      log("could not pass a client answer to the panel: " + (err && err.message ? err.message : String(err)));
    }
    return;
  }
  const modern = modernInfo(message);
  let res;
  try {
    res = await post(JSON.stringify(message), modern);
  } catch (err) {
    if (!(err instanceof PanelUnavailable)) throw err;
    replyOffline(message, await reasonFor(message, err.message));
    return;
  }
  let storeCopies = [];
  if (res.status === 401) {
    storeCopies = findPackagedTokenCopies();
    if (storeCopies.length) {
      // The service rewrites a stale packaged copy when it rejects a request. Give it a moment, and if
      // the token we read has changed, send the same request once more. The retry is safe because a 401
      // means the service did nothing with the request: auth is checked before any routing.
      await new Promise((resolve) => setTimeout(resolve, STORE_COPY_WAIT_MS));
      let after = "";
      try { after = readToken(); } catch {}
      if (after && after !== res.token) {
        try {
          res = await post(JSON.stringify(message), modern);
        } catch (err) {
          if (!(err instanceof PanelUnavailable)) throw err;
          replyOffline(message, await reasonFor(message, err.message));
          return;
        }
      }
    }
  }
  if (res.status === 202) return;
  if (res.status === 401) {
    if (storeCopies.length) {
      // Not diagnosed: inside the package the "real" token path is the stale copy too, so the check
      // could not see the difference.
      replyOffline(message, storeCopyMessage(storeCopies[0]));
      return;
    }
    replyOffline(
      message,
      await reasonFor(
        message,
        "The Chroma AE MCP panel rejected the token in " + TOKEN_PATH +
          ". Another After Effects, or an old Chroma service, may hold the port with a different token. " +
          "Quit After Effects, make sure no AfterFX.exe is left in Task Manager, and start it again. " +
          'Running node "' + path.join(__dirname, "relay-diagnose.cjs") + '" tells which.'
      )
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
      writeListCache(listKey, body.result[listKey], modern && listKey === "resources" ? MODERN_RESOURCES_FILE : undefined);
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
  // A modern server/discover carries the same instructions as initialize.
  if (
    modern &&
    message.method === "server/discover" &&
    TOOLSET.toolset === "core" &&
    body.result &&
    typeof body.result.instructions === "string"
  ) {
    writeInstructionsCache(body.result.instructions);
  }
  send(body);
  // After the reply, so the client never waits on it; the process stays up until it is written.
  if (listKey === "prompts" || listKey === "resources") await runPrefetch(prefetchContents);
  if (modern && message.method === "skills/list" && body.result && Array.isArray(body.result.skills)) {
    await runPrefetch(() => prefetchSkills(body.result.skills));
  }
}

let pending = 0;
let stdinClosed = false;

// Exits once stdin has closed and every reply is out. On macOS a pipe is written asynchronously, so a
// process.exit straight after a large reply cut it at 64 KB; an empty write's callback runs only after
// every earlier write has been handed to the OS.
let exiting = false;
function maybeExit() {
  if (!stdinClosed || pending !== 0 || exiting) return;
  exiting = true;
  process.stdout.write("", () => process.exit(0));
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
  observeModern(message);
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
