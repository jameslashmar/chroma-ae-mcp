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
// - While AE is closed, initialize is answered here and tools/list comes
//   from the last list the panel served, so the tools stay registered and a
//   call tells the user to start AE.
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");

// Mirrors resolveStateDir() in panel/client/common.js, NOT defaultDataDir()
// in server/src/quarantine.ts -- those two disagree on the non-Windows/
// non-macOS fallback, and it's common.js's dir that the panel actually
// writes the token to (see writeTokenFile there). Mirroring the wrong one
// leaves this relay looking for the token in a directory the panel never
// writes to on that platform.
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
const TOOLS_CACHE_PATH = path.join(dataDir(), "relay-tools-cache.json");

// Keep in step with server/src/mcp-rpc.ts.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "chroma-ae-mcp", version: "0.2.0" };

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

function readToolsCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(TOOLS_CACHE_PATH, "utf8"));
    return Array.isArray(cached.tools) ? cached.tools : null;
  } catch {
    return null;
  }
}

function writeToolsCache(tools) {
  try {
    const tmp = TOOLS_CACHE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ tools }));
    fs.renameSync(tmp, TOOLS_CACHE_PATH);
  } catch (err) {
    log("could not cache the tool list: " + err.message);
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
        result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": {
      const tools = readToolsCache();
      if (tools) return { jsonrpc: "2.0", id, result: { tools } };
      return { jsonrpc: "2.0", id, error: { code: -32000, message: reason } };
    }
    case "tools/call":
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: reason }], isError: true } };
    default:
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
  if (!Array.isArray(message) && message.method === "tools/list" && body.result && Array.isArray(body.result.tools)) {
    writeToolsCache(body.result.tools);
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
