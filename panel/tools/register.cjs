// One-click registration of the chroma-ae MCP with the clients on this
// machine, for the panel's Register buttons. No dependencies.
//
// - Claude Code: `claude mcp add --scope user --transport http chroma-ae ...`
//   with the Bearer token (the CLI owns ~/.claude.json, so it is never
//   edited by hand). Regenerating the token means registering again.
// - Claude Desktop, Cursor and Codex: the stdio relay next to this file,
//   started with the machine's Node. The relay reads the token itself, so
//   their config files never hold it and a new token needs no change.
//
// Config files are backed up (<file>.chroma-bak) before they are written,
// and only the chroma-ae entry is touched.
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const NAME = "chroma-ae";

// Where Node and the Claude Code CLI usually live when PATH (which CEP may
// not share with the user's shell) doesn't have them.
function usualDirs(platform, home, appData) {
  if (platform === "win32") {
    return {
      node: ["C:\\Program Files\\nodejs", path.join(appData, "nvm", "current")],
      claude: [path.join(home, ".local", "bin"), path.join(appData, "npm")],
    };
  }
  return {
    node: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(home, ".volta", "bin")],
    claude: [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"],
  };
}

function defaultEnv() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return {
    platform: process.platform,
    home,
    appData,
    pathEnv: process.env.PATH || "",
    dirs: usualDirs(process.platform, home, appData),
    relayPath: path.join(__dirname, "stdio-relay.cjs"),
    // Asynchronous, so the panel stays responsive while a CLI runs.
    // Resolves { status, stdout, stderr, error }; never rejects.
    exec: (file, args, opts) =>
      new Promise((resolve) => {
        try {
          childProcess.execFile(
            file,
            args,
            Object.assign({ encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, opts || {}),
            (error, stdout, stderr) => {
              if (!error) {
                resolve({ status: 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
                return;
              }
              const numeric = typeof error.code === "number";
              resolve({
                status: numeric ? error.code : null,
                stdout: String(stdout || ""),
                stderr: String(stderr || ""),
                error: numeric && !error.killed ? undefined : error,
              });
            }
          );
        } catch (error) {
          resolve({ status: null, stdout: "", stderr: "", error });
        }
      }),
  };
}

function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

// First existing file named `names` on PATH, then in `extra` folders.
function findOnPath(env, names, extra) {
  const sep = env.platform === "win32" ? ";" : ":";
  const dirs = env.pathEnv.split(sep).filter(Boolean).concat(extra || []);
  for (const dir of dirs) {
    for (const n of names) {
      const full = path.join(dir.replace(/^"|"$/g, ""), n);
      if (exists(full)) return full;
    }
  }
  return null;
}

function findNode(env) {
  return findOnPath(env, env.platform === "win32" ? ["node.exe"] : ["node"], (env.dirs && env.dirs.node) || []);
}

function findClaude(env) {
  return findOnPath(env, env.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"], (env.dirs && env.dirs.claude) || []);
}

// ---------- config files ----------

function desktopConfigPath(env) {
  if (env.platform === "win32") return path.join(env.appData, "Claude", "claude_desktop_config.json");
  if (env.platform === "darwin") return path.join(env.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(env.home, ".config", "Claude", "claude_desktop_config.json");
}

function cursorConfigPath(env) {
  return path.join(env.home, ".cursor", "mcp.json");
}

function codexConfigPath(env) {
  return path.join(env.home, ".codex", "config.toml");
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (text.trim() === "") return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(file + " isn't plain JSON (comments?); edit it by hand.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(file + " isn't plain JSON (comments?); edit it by hand.");
  }
  return value;
}

// The first backup is kept: later writes never replace <file>.chroma-bak, so
// the user's original stays recoverable. A symlinked config is written
// through to its target instead of being replaced by a regular file.
function backupAndWrite(file, text) {
  let target = file;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) target = fs.realpathSync(file);
  } catch (e) {
    target = file;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && !fs.existsSync(file + ".chroma-bak")) fs.copyFileSync(target, file + ".chroma-bak");
  const tmp = target + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, target);
}

function setJsonServer(file, entry) {
  const cfg = readJson(file);
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
  if (entry) cfg.mcpServers[NAME] = entry;
  else delete cfg.mcpServers[NAME];
  backupAndWrite(file, JSON.stringify(cfg, null, 2) + "\n");
}

function hasJsonServer(file) {
  try {
    const cfg = readJson(file);
    return Boolean(cfg.mcpServers && cfg.mcpServers[NAME]);
  } catch (e) {
    return false;
  }
}

// TOML literal strings ('...') need no escaping for Windows paths; a path
// holding a single quote falls back to a basic string.
function tomlString(s) {
  if (s.indexOf("'") === -1 && !/[\r\n]/.test(s)) return "'" + s + "'";
  return JSON.stringify(s);
}

const NAME_PATTERN = "(?:" + NAME + "|\"" + NAME + "\"|'" + NAME + "')";
const TABLE_RE = new RegExp("^\\s*\\[\\s*mcp_servers\\s*\\.\\s*" + NAME_PATTERN + "\\s*\\]\\s*(?:#.*)?$");
const SUB_RE = new RegExp("^\\s*\\[\\s*mcp_servers\\s*\\.\\s*" + NAME_PATTERN + "\\s*\\.");
const MCP_SERVERS_TABLE_RE = /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/;
const DOTTED_RE = new RegExp("^\\s*mcp_servers\\s*\\.\\s*" + NAME_PATTERN + "\\s*[.=]");
const KEY_UNDER_TABLE_RE = new RegExp("^\\s*" + NAME_PATTERN + "\\s*[.=]");
const INLINE_RE = new RegExp("^\\s*mcp_servers\\s*=.*" + NAME);

// chroma-ae defined some other way than its own [mcp_servers.chroma-ae] table:
// an inline table, keys under [mcp_servers], or dotted keys. Appending a table
// would duplicate it and make the file invalid, so these are left to the user.
function tomlHasOtherForm(lines) {
  let inMcpServers = false;
  for (const l of lines) {
    if (/^\s*\[/.test(l)) inMcpServers = MCP_SERVERS_TABLE_RE.test(l);
    if (DOTTED_RE.test(l) || INLINE_RE.test(l)) return true;
    if (inMcpServers && KEY_UNDER_TABLE_RE.test(l)) return true;
  }
  return false;
}

const OTHER_FORM_MESSAGE =
  "chroma-ae is defined in ~/.codex/config.toml in a form this panel doesn't edit (an inline table, keys under [mcp_servers] or dotted keys). Edit that file by hand instead.";

// Lines of the [mcp_servers.chroma-ae] table (and its subtables), as [start, end).
function tomlTableRange(lines) {
  const start = lines.findIndex((l) => TABLE_RE.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !(/^\s*\[/.test(lines[end]) && !SUB_RE.test(lines[end]))) end++;
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  return [start, end];
}

/** Returns `toml` with the chroma-ae table replaced by `table` lines (or removed when null). Throws when chroma-ae is defined in another form. */
function upsertTomlTable(toml, table) {
  const lines = toml.replace(/\r\n/g, "\n").split("\n");
  const range = tomlTableRange(lines);
  if (!range && tomlHasOtherForm(lines)) throw new Error(OTHER_FORM_MESSAGE);
  if (range) {
    lines.splice(range[0], range[1] - range[0], ...(table || []));
    if (!table) {
      while (range[0] < lines.length && range[0] > 0 && lines[range[0]].trim() === "" && lines[range[0] - 1].trim() === "") {
        lines.splice(range[0], 1);
      }
    }
    return lines.join("\n");
  }
  if (!table) return toml;
  let body = toml.replace(/\s+$/, "");
  if (body !== "") body += "\n\n";
  return body + table.join("\n") + "\n";
}

function codexTable(nodePath, relayPath) {
  return ["[mcp_servers." + NAME + "]", "command = " + tomlString(nodePath), "args = [" + tomlString(relayPath) + "]"];
}

// ---------- clients ----------

function stdioEntry(env) {
  const node = findNode(env);
  if (!node) throw new Error("Node.js was not found on this machine. Install Node 18 or newer from nodejs.org, then try again.");
  if (!exists(env.relayPath)) throw new Error("The relay is missing at " + env.relayPath + ".");
  return { command: node, args: [env.relayPath] };
}

async function runClaude(env, args) {
  const claude = findClaude(env);
  if (!claude) throw new Error("The Claude Code CLI was not found. Install Claude Code, or copy the setup command instead.");
  // .cmd shims need a shell on Windows; the arguments are fixed strings and a hex token.
  const viaShell = /\.cmd$/i.test(claude);
  const quoted = viaShell ? args.map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)) : args;
  const res = await env.exec(viaShell ? '"' + claude + '"' : claude, quoted, { shell: viaShell });
  return { status: res.status, out: String(res.stdout || "") + String(res.stderr || ""), error: res.error };
}

function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (s) out = out.split(s).join("[token]");
  }
  return out;
}

// The user-scope entry `claude mcp add --scope user` keeps in ~/.claude.json.
function claudeCodeEntry(env) {
  try {
    const cfg = readJson(path.join(env.home, ".claude.json"));
    return (cfg.mcpServers && cfg.mcpServers[NAME]) || null;
  } catch (e) {
    return null;
  }
}

function claudeCodeRegistered(env) {
  return Boolean(claudeCodeEntry(env));
}

const CLIENTS = {
  "claude-code": {
    label: "Claude Code",
    registered: claudeCodeRegistered,
    async register(env, opts) {
      const old = claudeCodeEntry(env);
      await runClaude(env, ["mcp", "remove", NAME, "--scope", "user"]);
      const url = "http://127.0.0.1:" + opts.port + "/mcp";
      const res = await runClaude(env, ["mcp", "add", "--scope", "user", "--transport", "http", NAME, url, "--header", "Authorization: Bearer " + opts.token]);
      if (res.error || res.status !== 0) {
        const secrets = [opts.token];
        let note = "";
        if (old) {
          // Write the exact old entry straight back into ~/.claude.json,
          // through the same backup-first, atomic-rename path the other
          // three hosts use (backupAndWrite), instead of reconstructing a
          // `claude mcp add` command. That reconstruction only ever covered
          // the http-transport shape; any other shape (stdio, sse, or
          // anything a future Claude Code CLI adds) silently skipped the
          // restore entirely and still claimed "could not be restored"
          // without having tried. Restoring the raw JSON is shape-agnostic.
          let restored = false;
          try {
            const file = path.join(env.home, ".claude.json");
            const cfg = readJson(file);
            if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
            cfg.mcpServers[NAME] = old;
            backupAndWrite(file, JSON.stringify(cfg, null, 2) + "\n");
            restored = true;
          } catch (e) {
            restored = false;
          }
          note = restored ? " The old registration was restored." : " The old registration could not be restored.";
        }
        throw new Error("claude mcp add failed: " + redact(res.out.trim() || String(res.error), secrets) + note);
      }
      return "Registered at user scope. New Claude Code sessions get the ae_* tools.";
    },
    async unregister(env) {
      const res = await runClaude(env,["mcp", "remove", NAME, "--scope", "user"]);
      if (res.error || res.status !== 0) throw new Error("claude mcp remove failed: " + res.out.trim());
      return "Removed from Claude Code.";
    },
  },
  "claude-desktop": {
    label: "Claude Desktop",
    registered: (env) => hasJsonServer(desktopConfigPath(env)),
    register(env) {
      setJsonServer(desktopConfigPath(env), stdioEntry(env));
      return "Added to Claude Desktop. Quit and reopen Claude Desktop to load it.";
    },
    unregister(env) {
      setJsonServer(desktopConfigPath(env), null);
      return "Removed from Claude Desktop. Quit and reopen it.";
    },
  },
  cursor: {
    label: "Cursor",
    registered: (env) => hasJsonServer(cursorConfigPath(env)),
    register(env) {
      setJsonServer(cursorConfigPath(env), stdioEntry(env));
      return "Added to Cursor (~/.cursor/mcp.json). Reload Cursor's MCP settings.";
    },
    unregister(env) {
      setJsonServer(cursorConfigPath(env), null);
      return "Removed from Cursor.";
    },
  },
  codex: {
    label: "Codex",
    registered(env) {
      try {
        const lines = fs.readFileSync(codexConfigPath(env), "utf8").split(/\r?\n/);
        return tomlTableRange(lines) !== null || tomlHasOtherForm(lines);
      } catch (e) {
        return false;
      }
    },
    register(env) {
      const entry = stdioEntry(env);
      const file = codexConfigPath(env);
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      backupAndWrite(file, upsertTomlTable(before, codexTable(entry.command, entry.args[0])));
      return "Added to Codex (~/.codex/config.toml). Start a new Codex session.";
    },
    unregister(env) {
      const file = codexConfigPath(env);
      if (!fs.existsSync(file)) return "Codex has no config file.";
      backupAndWrite(file, upsertTomlTable(fs.readFileSync(file, "utf8"), null));
      return "Removed from Codex.";
    },
  },
};

// What the panel's Copy button puts on the clipboard for one client, with a line
// saying where it goes. Claude Code and Codex get a CLI command; Claude Desktop and
// Cursor get the entry to add under "mcpServers" in their JSON config.
// opts: { port, token }. Throws when Node or the relay can't be found.
function setupText(id, opts, env) {
  const e = env || defaultEnv();
  const o = opts || {};
  const quote = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
  if (id === "claude-code") {
    return {
      kind: "command",
      text:
        "claude mcp add --scope user --transport http " + NAME + " http://127.0.0.1:" + o.port +
        '/mcp --header "Authorization: Bearer ' + o.token + '"',
      where: "Paste it into a terminal, then start a new Claude Code session.",
    };
  }
  const entry = stdioEntry(e);
  if (id === "codex") {
    return {
      kind: "command",
      text: "codex mcp add " + NAME + " -- " + quote(entry.command) + " " + quote(entry.args[0]),
      where: "Paste it into a terminal, then start a new Codex session.",
    };
  }
  const json = JSON.stringify({ [NAME]: entry }, null, 2);
  // The entry alone, without the outer braces, so it pastes into an existing "mcpServers".
  const text = json.slice(1, -1).replace(/^\n/, "").replace(/\n$/, "").replace(/^ {2}/gm, "");
  if (id === "claude-desktop") {
    return {
      kind: "config",
      text,
      where: 'Add it inside "mcpServers" in claude_desktop_config.json (Settings > Developer > Edit Config), then quit and reopen Claude Desktop.',
    };
  }
  if (id === "cursor") {
    return {
      kind: "config",
      text,
      where: 'Add it inside "mcpServers" in ~/.cursor/mcp.json, then reload Cursor\'s MCP settings.',
    };
  }
  throw new Error("Unknown client " + id);
}

function status(env) {
  const e = env || defaultEnv();
  return Object.keys(CLIENTS).map((id) => {
    let registered = false;
    try {
      registered = CLIENTS[id].registered(e);
    } catch (err) {
      registered = false;
    }
    return { id, label: CLIENTS[id].label, registered };
  });
}

/** Registers (on: true) or removes (on: false) one client. Returns a Promise of a message; rejects with a readable error. */
async function setRegistered(id, on, opts, env) {
  const client = CLIENTS[id];
  if (!client) throw new Error("Unknown client " + id);
  const e = env || defaultEnv();
  return on ? client.register(e, opts || {}) : client.unregister(e, opts || {});
}

module.exports = {
  NAME,
  status,
  setRegistered,
  setupText,
  upsertTomlTable,
  codexTable,
  tomlString,
  findNode,
  defaultEnv,
};
