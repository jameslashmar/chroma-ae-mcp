// panel/client/common.js — Shared helpers for Chroma AE MCP service and panel extensions.
// Runs inside the CEP 12 mixed-context environment (Chromium DOM + Node.js).

(function () {
  "use strict";

  var fs = require("fs");
  var path = require("path");
  var os = require("os");
  var crypto = require("crypto");
  var childProcess = require("child_process");

  // The version comes from the manifest, which scripts/package.ps1 stamps from VERSION,
  // so /health reports what is actually installed.
  var PANEL_VERSION = readBundleVersion();
  var DEFAULT_PORT = 7790;
  var LOG_MAX_BYTES = 1024 * 1024; // 1 MB rotation threshold
  var MAX_LOG_LINES = 200;

  function readBundleVersion() {
    try {
      var here = fileUrlToNativePath(String(window.location.href).split("#")[0].split("?")[0]);
      var manifest = path.join(path.dirname(path.dirname(here)), "CSXS", "manifest.xml");
      var m = /ExtensionBundleVersion="([^"]+)"/.exec(fs.readFileSync(manifest, "utf8"));
      if (m) return m[1];
    } catch (e) {}
    return "unknown";
  }

  // ---------- CEP Host Interface adapter ----------
  function fileUrlToNativePath(raw) {
    if (!raw || typeof raw !== "string") return "";
    var p = raw;
    if (p.indexOf("file://") === 0) {
      try {
        p = decodeURIComponent(p.replace(/^file:\/\//i, ""));
      } catch (e) {
        p = p.replace(/^file:\/\//i, "");
      }
    }
    // On Windows CEP returns "/C:/Users/..." — strip the leading slash before drive letter.
    if (/^\/[A-Za-z]:[\\/]/.test(p)) {
      p = p.substring(1);
    }
    return path.normalize(p);
  }

  function createHostAdapter() {
    if (typeof window !== "undefined" && typeof window.CSInterface === "function") {
      var csInst = new window.CSInterface();
      return {
        evalScript: function (script, cb) {
          csInst.evalScript(script, cb);
        },
        getExtensionPath: function () {
          var sysPath = (typeof window.SystemPath !== "undefined" && window.SystemPath.EXTENSION)
            ? window.SystemPath.EXTENSION
            : "extension";
          return fileUrlToNativePath(csInst.getSystemPath(sysPath));
        },
        getHostEnvironment: function () {
          try {
            return csInst.getHostEnvironment();
          } catch (e) {
            return null;
          }
        }
      };
    }

    if (typeof window !== "undefined" && window.__adobe_cep__) {
      var cep = window.__adobe_cep__;
      return {
        evalScript: function (script, cb) {
          cep.evalScript(script, cb);
        },
        getExtensionPath: function () {
          return fileUrlToNativePath(cep.getSystemPath("extension"));
        },
        getHostEnvironment: function () {
          try {
            var raw = cep.getHostEnvironment();
            return typeof raw === "string" ? JSON.parse(raw) : raw;
          } catch (e) {
            return null;
          }
        }
      };
    }

    return null;
  }

  function resolveExtensionDir(host) {
    if (host && typeof host.getExtensionPath === "function") {
      try {
        var extPath = host.getExtensionPath();
        if (extPath && fs.existsSync(extPath)) return extPath;
      } catch (e) {}
    }
    // Fallback relative to __dirname (which CEP anchors at extension root or client/).
    if (typeof __dirname === "string") {
      if (fs.existsSync(path.join(__dirname, "host", "core.jsx"))) {
        return __dirname;
      }
      var parent = path.resolve(__dirname, "..");
      if (fs.existsSync(path.join(parent, "host", "core.jsx"))) {
        return parent;
      }
    }
    return process.cwd();
  }

  // ---------- State folder, ACL & Bearer token ----------
  function resolveStateDir() {
    if (process.platform === "win32") {
      var localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      return path.join(localAppData, "chroma-ae-mcp");
    }
    if (process.platform === "darwin") {
      return path.join(os.homedir(), "Library", "Application Support", "chroma-ae-mcp");
    }
    return path.join(os.homedir(), ".chroma-ae-mcp");
  }

  function getPaths(customStateDir) {
    var sDir = customStateDir || resolveStateDir();
    return {
      stateDir: sDir,
      framesDir: path.join(sDir, "frames"),
      tokenPath: path.join(sDir, "token"),
      configPath: path.join(sDir, "config.json"),
      logPath: path.join(sDir, "service.log"),
      rotatedLogPath: path.join(sDir, "service.log.1")
    };
  }

  function isValidToken(candidate) {
    return typeof candidate === "string" && /^[0-9a-fA-F]{64}$/.test(candidate);
  }

  function generateToken() {
    return crypto.randomBytes(32).toString("hex");
  }

  function hardenWindowsFolderAcl(folderPath, onWarn) {
    if (process.platform !== "win32") return;
    var username = process.env.USERNAME || "";
    if (!username) {
      try {
        username = os.userInfo().username;
      } catch (e) {}
    }
    if (!username) return;
    var domain = process.env.USERDOMAIN || "";
    var candidates = [];
    if (domain) candidates.push(domain + "\\" + username);
    candidates.push(username);

    var applied = false;
    for (var i = 0; i < candidates.length; i++) {
      try {
        childProcess.execFileSync(
          "icacls",
          [folderPath, "/inheritance:r", "/grant:r", candidates[i] + ":(OI)(CI)F"],
          { windowsHide: true, stdio: "ignore" }
        );
        applied = true;
        break;
      } catch (e) {}
    }
    if (!applied && typeof onWarn === "function") {
      onWarn("icacls ACL restriction could not be applied to " + folderPath);
    }
  }

  function writeTokenFile(tokenPath, stateDir, token, onWarn) {
    var dir = stateDir || path.dirname(tokenPath);
    fs.mkdirSync(dir, { recursive: true, mode: 448 }); // 0o700 = 448
    try { fs.chmodSync(dir, 448); } catch (e) {}
    hardenWindowsFolderAcl(dir, onWarn);
    fs.writeFileSync(tokenPath, token, { encoding: "utf8", mode: 384 }); // 0o600 = 384
    try { fs.chmodSync(tokenPath, 384); } catch (e) {}
  }

  function readTokenFile(tokenPath) {
    try {
      if (fs.existsSync(tokenPath)) {
        return fs.readFileSync(tokenPath, "utf8").trim();
      }
    } catch (e) {}
    return "";
  }

  function initPrivateStorage(paths, onWarn) {
    var p = paths || getPaths();
    fs.mkdirSync(p.stateDir, { recursive: true, mode: 448 }); // 0o700 = 448
    try { fs.chmodSync(p.stateDir, 448); } catch (e) {}
    fs.mkdirSync(p.framesDir, { recursive: true, mode: 448 });
    try { fs.chmodSync(p.framesDir, 448); } catch (e) {}

    hardenWindowsFolderAcl(p.stateDir, onWarn);

    var existing = readTokenFile(p.tokenPath);
    if (isValidToken(existing)) {
      try { fs.chmodSync(p.tokenPath, 384); } catch (e) {}
      return { token: existing, reused: true };
    }

    var fresh = generateToken();
    fs.writeFileSync(p.tokenPath, fresh, { encoding: "utf8", mode: 384 }); // 0o600 = 384
    try { fs.chmodSync(p.tokenPath, 384); } catch (e) {}
    return { token: fresh, reused: false };
  }

  function resolvePort(configPath) {
    var envPort = process.env.CHROMA_AE_MCP_PORT;
    if (envPort) {
      var parsedEnv = parseInt(envPort, 10);
      if (Number.isFinite(parsedEnv) && parsedEnv > 0 && parsedEnv <= 65535) {
        return parsedEnv;
      }
    }
    if (typeof window !== "undefined" && window.localStorage) {
      try {
        var saved = window.localStorage.getItem("chroma_ae_mcp_port");
        if (saved) {
          var parsedSaved = parseInt(saved, 10);
          if (Number.isFinite(parsedSaved) && parsedSaved > 0 && parsedSaved <= 65535) {
            return parsedSaved;
          }
        }
      } catch (e) {}
    }
    var cfgFile = configPath || getPaths().configPath;
    try {
      if (cfgFile && fs.existsSync(cfgFile)) {
        var cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
        if (cfg && typeof cfg.port === "number" && cfg.port > 0 && cfg.port <= 65535) {
          return Math.floor(cfg.port);
        }
      }
    } catch (e) {}
    return DEFAULT_PORT;
  }

  // ---------- Setup command & clipboard helpers ----------
  function maskToken(token) {
    if (typeof token !== "string" || token.length < 12) return "••••••••";
    return token.slice(0, 4) + "••••••••" + token.slice(-4);
  }

  function buildSetupCommand(port, token) {
    return (
      "claude mcp add --scope user --transport http chroma-ae http://127.0.0.1:" +
      port +
      '/mcp --header "Authorization: Bearer ' +
      token +
      '"'
    );
  }

  function copyViaHiddenTextarea(text) {
    if (typeof document === "undefined" || !document.body) return false;
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = Boolean(document.execCommand("copy"));
    } catch (e) {
      ok = false;
    }
    try {
      document.body.removeChild(ta);
    } catch (e) {}
    return ok;
  }

  function copyTextToClipboard(text, callback) {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      try {
        navigator.clipboard.writeText(text).then(
          function () {
            callback(true);
          },
          function () {
            callback(copyViaHiddenTextarea(text));
          }
        );
        return;
      } catch (e) {
        // Fall through to hidden textarea + document.execCommand('copy')
      }
    }
    callback(copyViaHiddenTextarea(text));
  }

  // ---------- Service log formatting, rotation & parsing ----------
  function formatLogLine(level, msg) {
    var ts = new Date().toISOString().substring(11, 19);
    var normLevel = typeof level === "string" ? level.trim().toLowerCase() : "";
    if (normLevel === "ok" || normLevel === "warn" || normLevel === "err") {
      return "[" + ts + "] [" + normLevel.toUpperCase() + "] " + String(msg || "");
    }
    return "[" + ts + "] " + String(msg || "");
  }

  function parseLogLine(rawLine) {
    var line = String(rawLine || "");
    var match = /^\[(\d{2}:\d{2}:\d{2})\]\s+\[(OK|WARN|ERR)\]\s+(.*)$/.exec(line);
    if (match) {
      return {
        level: match[2].toLowerCase(),
        text: "[" + match[1] + "] " + match[3]
      };
    }
    return {
      level: "",
      text: line
    };
  }

  function rotateLogIfNeeded(logPath, incomingBytes, maxBytes) {
    var limit = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : LOG_MAX_BYTES;
    try {
      if (!fs.existsSync(logPath)) return;
      var st = fs.statSync(logPath);
      if (st.size + (incomingBytes || 0) < limit && st.size < limit) return;
      var backupPath = logPath + ".1";
      try {
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath);
        }
      } catch (e) {}
      try {
        fs.renameSync(logPath, backupPath);
      } catch (renameErr) {
        try {
          fs.copyFileSync(logPath, backupPath);
          fs.writeFileSync(logPath, "", { encoding: "utf8", mode: 384 });
        } catch (copyErr) {}
      }
    } catch (e) {}
  }

  function appendServiceLog(logPath, level, msg, maxBytes) {
    var line = formatLogLine(level, msg);
    var payload = line + "\n";
    try {
      var dir = path.dirname(logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 448 });
      }
      var byteLen = Buffer.byteLength(payload, "utf8");
      rotateLogIfNeeded(logPath, byteLen, maxBytes);
      fs.appendFileSync(logPath, payload, { encoding: "utf8", mode: 384 });
    } catch (e) {}
    return line;
  }

  var api = {
    PANEL_VERSION: PANEL_VERSION,
    DEFAULT_PORT: DEFAULT_PORT,
    LOG_MAX_BYTES: LOG_MAX_BYTES,
    MAX_LOG_LINES: MAX_LOG_LINES,
    fileUrlToNativePath: fileUrlToNativePath,
    createHostAdapter: createHostAdapter,
    resolveExtensionDir: resolveExtensionDir,
    resolveStateDir: resolveStateDir,
    getPaths: getPaths,
    isValidToken: isValidToken,
    generateToken: generateToken,
    hardenWindowsFolderAcl: hardenWindowsFolderAcl,
    writeTokenFile: writeTokenFile,
    readTokenFile: readTokenFile,
    initPrivateStorage: initPrivateStorage,
    resolvePort: resolvePort,
    maskToken: maskToken,
    buildSetupCommand: buildSetupCommand,
    copyViaHiddenTextarea: copyViaHiddenTextarea,
    copyTextToClipboard: copyTextToClipboard,
    formatLogLine: formatLogLine,
    parseLogLine: parseLogLine,
    rotateLogIfNeeded: rotateLogIfNeeded,
    appendServiceLog: appendServiceLog
  };

  if (typeof window !== "undefined") {
    window.ChromaAeCommon = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
