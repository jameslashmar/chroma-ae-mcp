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
//   resources/list come from the last lists the panel served, so everything
//   stays registered and a call or a read tells the user to start AE.
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

const PORT = resolvePort();
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
  "Window > Extensions > Chroma AE MCP shows READY, then try again.";

class PanelUnavailable extends Error {}

function log(msg) {
  process.stderr.write("[chroma-ae relay] " + msg + "\n");
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
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(bodyText),
        },
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

function readListCache(key) {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(key), "utf8"));
    return cached && Array.isArray(cached[key]) ? cached[key] : null;
  } catch {
    return null;
  }
}

function writeListCache(key, list) {
  try {
    const file = cachePath(key);
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ [key]: list }));
    fs.renameSync(tmp, file);
  } catch (err) {
    log("could not cache the " + key + " list: " + err.message);
  }
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
      return {
        jsonrpc: "2.0",
        id,
        // The same capabilities as the panel, so a client that starts before AE still
        // asks for prompts and resources (their lists come from the cache below).
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: SERVER_INFO,
        },
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
    default:
      if (KNOWN_METHODS.indexOf(msg.method) < 0) {
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + String(msg.method) } };
      }
      // prompts/get and resources/read need the panel.
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

async function relay(message) {
  let res;
  try {
    res = await post(JSON.stringify(message));
  } catch (err) {
    if (!(err instanceof PanelUnavailable)) throw err;
    replyOffline(message, err.message);
    return;
  }
  if (res.status === 202) return;
  if (res.status === 401) {
    replyOffline(message, "The Chroma AE MCP panel rejected the token in " + TOKEN_PATH + ". Restart After Effects.");
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
    writeListCache(listKey, body.result[listKey]);
  }
  send(body);
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
