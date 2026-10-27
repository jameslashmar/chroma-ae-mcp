// panel/client/main.js — Chroma AE MCP CEP panel bridge.
// Runs inside the CEP 12 mixed-context environment (Chromium DOM + Node.js).

(function () {
  "use strict";

  var http = require("http");
  var fs = require("fs");
  var path = require("path");
  var os = require("os");
  var crypto = require("crypto");
  var childProcess = require("child_process");

  var PANEL_VERSION = "0.1.0";
  var DEFAULT_PORT = 7790;
  var QUEUE_WAIT_LIMIT_MS = 600 * 1000; // 600 s queued limit
  var EVALSCRIPT_ERR_MESSAGE = "EvalScript error.";
  var MAX_LOG_LINES = 200;

  // ---------- DOM references & UI helpers ----------
  var $badge = typeof document !== "undefined" ? document.getElementById("status-badge") : null;
  var $port = typeof document !== "undefined" ? document.getElementById("port-value") : null;
  var $ae = typeof document !== "undefined" ? document.getElementById("ae-version") : null;
  var $inflight = typeof document !== "undefined" ? document.getElementById("inflight-label") : null;
  var $queueDepth = typeof document !== "undefined" ? document.getElementById("queue-depth") : null;
  var $setupCommand = typeof document !== "undefined" ? document.getElementById("setup-command") : null;
  var $copySetupBtn = typeof document !== "undefined" ? document.getElementById("copy-setup-btn") : null;
  var $regenTokenBtn = typeof document !== "undefined" ? document.getElementById("regen-token-btn") : null;
  var $log = typeof document !== "undefined" ? document.getElementById("log") : null;

  function setBadge(text, stateClass) {
    if (!$badge) return;
    $badge.textContent = text;
    $badge.className = "badge" + (stateClass ? " " + stateClass : "");
  }

  function log(level, msg) {
    if (msg === undefined) {
      msg = level;
      level = "";
    }
    if (!$log || typeof document === "undefined") return;
    var row = document.createElement("div");
    row.className = "log-entry" + (level ? " " + level : "");
    var ts = new Date().toISOString().substring(11, 19);
    row.textContent = "[" + ts + "] " + msg;
    $log.appendChild(row);
    while ($log.childNodes.length > MAX_LOG_LINES) {
      $log.removeChild($log.firstChild);
    }
    $log.scrollTop = $log.scrollHeight;
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

  var host = createHostAdapter();
  var aeVersion = "unknown";

  function resolveExtensionDir() {
    if (host) {
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

  var stateDir = resolveStateDir();
  var framesDir = path.join(stateDir, "frames");
  var tokenPath = path.join(stateDir, "token");
  var configPath = path.join(stateDir, "config.json");
  var sessionToken = "";

  function isValidToken(candidate) {
    return typeof candidate === "string" && /^[0-9a-fA-F]{64}$/.test(candidate);
  }

  function hardenWindowsFolderAcl(folderPath) {
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
    if (!applied) {
      log("warn", "icacls ACL restriction could not be applied to " + folderPath);
    }
  }

  function writeTokenFile(token) {
    hardenWindowsFolderAcl(stateDir);
    fs.writeFileSync(tokenPath, token, { encoding: "utf8", mode: 384 }); // 0o600 = 384
    try { fs.chmodSync(tokenPath, 384); } catch (e) {}
  }

  function initPrivateStorage() {
    fs.mkdirSync(stateDir, { recursive: true, mode: 448 }); // 0o700 = 448
    try { fs.chmodSync(stateDir, 448); } catch (e) {}
    fs.mkdirSync(framesDir, { recursive: true, mode: 448 });
    try { fs.chmodSync(framesDir, 448); } catch (e) {}

    hardenWindowsFolderAcl(stateDir);

    var existing = "";
    try {
      if (fs.existsSync(tokenPath)) {
        existing = fs.readFileSync(tokenPath, "utf8").trim();
      }
    } catch (e) {
      existing = "";
    }

    if (isValidToken(existing)) {
      sessionToken = existing;
      try { fs.chmodSync(tokenPath, 384); } catch (e) {}
      return { reused: true };
    }

    sessionToken = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(tokenPath, sessionToken, { encoding: "utf8", mode: 384 }); // 0o600 = 384
    try { fs.chmodSync(tokenPath, 384); } catch (e) {}
    return { reused: false };
  }

  function resolvePort() {
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
    try {
      if (fs.existsSync(configPath)) {
        var cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (cfg && typeof cfg.port === "number" && cfg.port > 0 && cfg.port <= 65535) {
          return Math.floor(cfg.port);
        }
      }
    } catch (e) {}
    return DEFAULT_PORT;
  }

  // ---------- FIFO Serialised evalScript Queue ----------
  var queue = [];
  var inFlight = null;
  var reqCounter = 0;

  function updateQueueUi() {
    if ($inflight) {
      $inflight.textContent = inFlight ? (inFlight.label + " (" + inFlight.id + ")") : "idle";
    }
    if ($queueDepth) {
      $queueDepth.textContent = String(queue.length);
    }
    if (inFlight) {
      setBadge("busy", "busy");
    } else {
      setBadge("ready", "ok");
    }
  }

  // Wrap user/server script inside:
  // (function(){ try { return JSON-encoded {ok,result} } catch(e) { return JSON-encoded {ok:false,error} } })()
  // using __chromaAe.stringify from core.jsx (never native JSON).
  function wrapScriptForEval(script) {
    var trimmed = String(script || "").trim();
    while (trimmed.length > 0 && trimmed.charAt(trimmed.length - 1) === ";") {
      trimmed = trimmed.slice(0, -1).trim();
    }
    var expr;
    if (/^return\b/.test(trimmed)) {
      expr = "(function(){\n" + script + "\n})()";
    } else if (trimmed.length === 0) {
      expr = "null";
    } else {
      expr = "(\n" + trimmed + "\n)";
    }
    return (
      "(function(){" +
      "try{" +
      "var __r=" + expr + ";" +
      "if(__r&&typeof __r==='object'&&__r.__chromaError===true){" +
      "return __chromaAe.stringify({ok:false,error:__r.error});" +
      "}" +
      "return __chromaAe.stringify({ok:true,result:__r});" +
      "}catch(e){" +
      "return __chromaAe.stringify({ok:false,error:__chromaAe.formatError(e)});" +
      "}" +
      "})()"
    );
  }

  function enqueueEval(id, script, label, sendResponse) {
    var item = {
      id: id,
      script: script,
      label: label || "eval",
      enqueuedAt: Date.now(),
      expired: false,
      timer: null,
      sendResponse: sendResponse
    };

    item.timer = setTimeout(function () {
      if (item.expired) return;
      var idx = queue.indexOf(item);
      if (idx === -1) return; // Already dispatched into evalScript; never abort in-flight evalScript.
      item.expired = true;
      queue.splice(idx, 1);
      updateQueueUi();
      log("warn", "Queued timeout (600s) expired before turn: " + item.label + " [" + item.id + "]");
      item.sendResponse(200, {
        id: item.id,
        ok: false,
        error: {
          message: "Request waited more than 600s in panel queue before execution",
          kind: "queued"
        }
      });
    }, QUEUE_WAIT_LIMIT_MS);

    queue.push(item);
    updateQueueUi();
    pumpQueue();
  }

  function pumpQueue() {
    if (inFlight !== null) return;
    while (queue.length > 0) {
      var next = queue.shift();
      if (!next || next.expired) continue;
      if (next.timer !== null) {
        clearTimeout(next.timer);
        next.timer = null;
      }
      dispatchItem(next);
      return;
    }
    updateQueueUi();
  }

  // Never times out or aborts an in-flight evalScript.
  function dispatchItem(item) {
    var startedAt = Date.now();
    inFlight = {
      id: item.id,
      label: item.label,
      startedAt: startedAt
    };
    updateQueueUi();
    log("", "-> " + item.label + " [" + item.id + "]");

    if (!host) {
      inFlight = null;
      updateQueueUi();
      item.sendResponse(200, {
        id: item.id,
        ok: false,
        error: {
          message: "CEP host interface is unavailable",
          kind: "evalscript_error"
        }
      });
      pumpQueue();
      return;
    }

    var wrapped = wrapScriptForEval(item.script);

    try {
      host.evalScript(wrapped, function (rawResult) {
        var durationMs = Date.now() - startedAt;
        inFlight = null;
        updateQueueUi();

        var rawStr = rawResult === undefined || rawResult === null ? "" : String(rawResult);
        if (rawStr === EVALSCRIPT_ERR_MESSAGE) {
          log("err", "<- " + item.label + " [" + item.id + "] EvalScript error (" + durationMs + "ms)");
          item.sendResponse(200, {
            id: item.id,
            ok: false,
            error: {
              message: "ExtendScript returned EvalScript_ErrMessage",
              kind: "evalscript_error"
            }
          });
          pumpQueue();
          return;
        }

        var parsed;
        try {
          parsed = JSON.parse(rawStr);
        } catch (parseErr) {
          log("err", "<- " + item.label + " [" + item.id + "] invalid JSON (" + durationMs + "ms)");
          item.sendResponse(200, {
            id: item.id,
            ok: false,
            error: {
              message: "ExtendScript returned non-JSON: " + rawStr.slice(0, 200),
              kind: "evalscript_error"
            }
          });
          pumpQueue();
          return;
        }

        if (!parsed || typeof parsed !== "object") {
          item.sendResponse(200, {
            id: item.id,
            ok: false,
            error: {
              message: "ExtendScript returned invalid payload envelope",
              kind: "evalscript_error"
            }
          });
          pumpQueue();
          return;
        }

        if (parsed.ok === true) {
          log("ok", "<- " + item.label + " [" + item.id + "] ok (" + durationMs + "ms)");
          item.sendResponse(200, {
            id: item.id,
            ok: true,
            result: parsed.result,
            durationMs: durationMs
          });
        } else {
          var errObj = parsed.error && typeof parsed.error === "object"
            ? parsed.error
            : { message: String(parsed.error || "Unknown ExtendScript error"), kind: "runtime" };
          if (!errObj.kind) errObj.kind = "runtime";
          if (!errObj.message) errObj.message = "ExtendScript error";
          log("err", "<- " + item.label + " [" + item.id + "] " + errObj.kind + ": " + errObj.message);
          item.sendResponse(200, {
            id: item.id,
            ok: false,
            error: errObj,
            durationMs: durationMs
          });
        }

        pumpQueue();
      });
    } catch (invokeErr) {
      inFlight = null;
      updateQueueUi();
      log("err", "evalScript throw on " + item.label + ": " + invokeErr.message);
      item.sendResponse(200, {
        id: item.id,
        ok: false,
        error: {
          message: "Failed to invoke evalScript: " + invokeErr.message,
          kind: "evalscript_error"
        }
      });
      pumpQueue();
    }
  }

  // ---------- Panel MCP bundle integration ----------
  function evalScriptForMcp(script, label) {
    return new Promise(function (resolve) {
      reqCounter += 1;
      var id = "mcp_" + reqCounter;
      var lbl = typeof label === "string" && label.length > 0 ? label : "mcp";
      enqueueEval(id, String(script || ""), lbl, function (_statusCode, payload) {
        if (payload && payload.ok === true) {
          resolve({
            ok: true,
            result: payload.result,
            durationMs: typeof payload.durationMs === "number" ? payload.durationMs : 0
          });
        } else {
          resolve({
            ok: false,
            error: (payload && payload.error) || {
              message: "ExtendScript evaluation failed",
              kind: "evalscript_error"
            }
          });
        }
      });
    });
  }

  function resolveMcpBundlePath() {
    var extDir = resolveExtensionDir();
    var clientBundle = path.join(extDir, "client", "mcp-bundle.cjs");
    if (fs.existsSync(clientBundle)) return clientBundle;
    var panelClientBundle = path.join(extDir, "panel", "client", "mcp-bundle.cjs");
    if (fs.existsSync(panelClientBundle)) return panelClientBundle;
    if (typeof __dirname === "string") {
      var dirBundle = path.join(__dirname, "mcp-bundle.cjs");
      if (fs.existsSync(dirBundle)) return dirBundle;
    }
    return clientBundle;
  }

  var panelMcp = null;
  var panelMcpErrorLogged = false;

  function getPanelMcp() {
    if (panelMcp !== null) return panelMcp;
    var bundlePath = resolveMcpBundlePath();
    if (!fs.existsSync(bundlePath)) {
      if (!panelMcpErrorLogged) {
        panelMcpErrorLogged = true;
        log("err", "MCP bundle missing at " + bundlePath + " — /mcp unavailable (/eval remains working)");
      }
      return null;
    }
    try {
      var mod = require(bundlePath);
      var createPanelMcp = mod && (mod.createPanelMcp || (mod.default && mod.default.createPanelMcp));
      if (typeof createPanelMcp !== "function") {
        if (!panelMcpErrorLogged) {
          panelMcpErrorLogged = true;
          log("err", "MCP bundle at " + bundlePath + " does not export createPanelMcp");
        }
        return null;
      }
      panelMcp = createPanelMcp({
        evalScript: evalScriptForMcp,
        dataDir: stateDir,
        log: log
      });
      log("ok", "Loaded MCP bundle (" + path.basename(bundlePath) + ")");
      return panelMcp;
    } catch (err) {
      if (!panelMcpErrorLogged) {
        panelMcpErrorLogged = true;
        log(
          "err",
          "Failed to load MCP bundle at " + bundlePath + ": " + (err && err.message ? err.message : String(err))
        );
      }
      return null;
    }
  }

  // ---------- Setup command UI & clipboard ----------
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

  function updateSetupUi() {
    if ($setupCommand) {
      $setupCommand.textContent = buildSetupCommand(boundPort, maskToken(sessionToken));
    }
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

  function bindSetupActions() {
    if ($copySetupBtn) {
      $copySetupBtn.addEventListener("click", function () {
        var cmd = buildSetupCommand(boundPort, sessionToken);
        copyTextToClipboard(cmd, function (copied) {
          if (copied) {
            log("ok", "Copied setup command to clipboard");
          } else {
            log("err", "Failed to copy setup command to clipboard");
          }
        });
      });
    }

    if ($regenTokenBtn) {
      $regenTokenBtn.addEventListener("click", function () {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          var confirmed = window.confirm(
            "Regenerate the MCP Bearer token? You must copy and paste the setup command again."
          );
          if (!confirmed) return;
        }
        try {
          var nextToken = crypto.randomBytes(32).toString("hex");
          writeTokenFile(nextToken);
          sessionToken = nextToken;
          updateSetupUi();
          log("warn", "Token regenerated. Copy and paste the setup command again.");
        } catch (err) {
          log("err", "Failed to regenerate token: " + err.message);
        }
      });
    }
  }

  // ---------- Security validation ----------
  function verifyBearerToken(authHeader) {
    if (typeof authHeader !== "string") return false;
    var prefix = "Bearer ";
    if (authHeader.slice(0, prefix.length) !== prefix) return false;
    var candidate = authHeader.slice(prefix.length).trim();
    if (!sessionToken || candidate.length !== sessionToken.length) return false;
    try {
      return crypto.timingSafeEqual(
        Buffer.from(candidate, "utf8"),
        Buffer.from(sessionToken, "utf8")
      );
    } catch (e) {
      return false;
    }
  }

  function sendJson(res, statusCode, payload) {
    if (res.writableEnded) return;
    var body = JSON.stringify(payload);
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  }

  function readRequestBody(req, res, onBody) {
    var chunks = [];
    var totalBytes = 0;
    var maxBodyBytes = 10 * 1024 * 1024; // 10 MB safety limit
    var aborted = false;

    req.on("data", function (chunk) {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        aborted = true;
        sendJson(res, 413, {
          ok: false,
          error: { kind: "invalid_request", message: "Request body too large" }
        });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", function () {
      if (aborted) return;
      var rawBody = Buffer.concat(chunks).toString("utf8");
      onBody(rawBody);
    });

    req.on("error", function (err) {
      log("err", "Request stream error: " + err.message);
    });
  }

  // ---------- HTTP Server ----------
  var boundPort = resolvePort();
  var server = null;

  function handleRequest(req, res) {
    var headers = req.headers || {};

    // 1. Reject any request carrying an Origin header (browser).
    if (headers.origin !== undefined) {
      log("warn", "Rejected request with Origin header: " + String(headers.origin));
      sendJson(res, 403, {
        ok: false,
        error: { kind: "forbidden", message: "Requests carrying an Origin header are rejected" }
      });
      return;
    }

    // 2. Reject any request whose Host is not 127.0.0.1:<port>.
    var expectedHost = "127.0.0.1:" + boundPort;
    if (headers.host !== expectedHost) {
      log("warn", "Rejected request with invalid Host header: " + String(headers.host));
      sendJson(res, 403, {
        ok: false,
        error: { kind: "forbidden", message: "Host header must be " + expectedHost }
      });
      return;
    }

    // 3. Every request requires Authorization: Bearer <token>.
    if (!verifyBearerToken(headers.authorization)) {
      log("warn", "Rejected unauthorized request to " + String(req.url));
      sendJson(res, 401, {
        ok: false,
        error: { kind: "auth", message: "Missing or invalid Bearer token" }
      });
      return;
    }

    var reqUrl = (req.url || "/").split("?")[0];

    if (req.method === "GET" && reqUrl === "/health") {
      sendJson(res, 200, {
        ok: true,
        busy: inFlight !== null,
        queueDepth: queue.length,
        aeVersion: aeVersion,
        panelVersion: PANEL_VERSION,
        inFlight: inFlight
          ? { id: inFlight.id, startedAt: inFlight.startedAt }
          : null
      });
      return;
    }

    if ((req.method === "POST" || req.method === "GET") && reqUrl === "/mcp") {
      readRequestBody(req, res, function (rawBody) {
        var mcp = getPanelMcp();
        if (!mcp || typeof mcp.handleHttp !== "function") {
          sendJson(res, 503, {
            ok: false,
            error: {
              kind: "unavailable",
              message: "MCP bundle (mcp-bundle.cjs) is not loaded"
            }
          });
          return;
        }
        try {
          Promise.resolve(mcp.handleHttp(req, res, rawBody)).catch(function (err) {
            log("err", "MCP handler error: " + (err && err.message ? err.message : String(err)));
            if (!res.writableEnded) {
              sendJson(res, 500, {
                ok: false,
                error: { kind: "internal", message: "Internal MCP handler error" }
              });
            }
          });
        } catch (syncErr) {
          log("err", "MCP handler throw: " + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
          if (!res.writableEnded) {
            sendJson(res, 500, {
              ok: false,
              error: { kind: "internal", message: "Internal MCP handler error" }
            });
          }
        }
      });
      return;
    }

    if (req.method === "POST" && reqUrl === "/eval") {
      readRequestBody(req, res, function (rawBody) {
        var parsedBody;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch (e) {
          sendJson(res, 400, {
            ok: false,
            error: { kind: "invalid_request", message: "Invalid JSON body: " + e.message }
          });
          return;
        }

        if (!parsedBody || typeof parsedBody !== "object" || typeof parsedBody.script !== "string") {
          sendJson(res, 400, {
            ok: false,
            error: {
              kind: "invalid_request",
              message: "POST /eval requires JSON {id:string, script:string, label:string}"
            }
          });
          return;
        }

        reqCounter += 1;
        var id = typeof parsedBody.id === "string" && parsedBody.id.length > 0
          ? parsedBody.id
          : "req_" + reqCounter;
        var label = typeof parsedBody.label === "string" && parsedBody.label.length > 0
          ? parsedBody.label
          : "eval";

        enqueueEval(id, parsedBody.script, label, function (statusCode, payload) {
          sendJson(res, statusCode, payload);
        });
      });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: { kind: "not_found", message: "Route not found" }
    });
  }

  // ---------- Load host/core.jsx into ExtendScript ----------
  function ensureCoreJsxLoaded() {
    return new Promise(function (resolve, reject) {
      if (!host) {
        resolve();
        return;
      }
      var extDir = resolveExtensionDir();
      var coreJsxPath = path.join(extDir, "host", "core.jsx");
      if (!fs.existsSync(coreJsxPath)) {
        reject(new Error("host/core.jsx not found at " + coreJsxPath));
        return;
      }
      var bootScript =
        "(function(){" +
        "if(typeof __chromaAe==='undefined'||!__chromaAe){" +
        "$.evalFile(" + JSON.stringify(coreJsxPath) + ");" +
        "}" +
        "if(typeof __chromaAe==='object'&&__chromaAe){" +
        "return String(app.version||'')+'|ok';" +
        "}" +
        "return 'missing';" +
        "})()";

      host.evalScript(bootScript, function (raw) {
        var str = String(raw || "");
        if (str.slice(-3) === "|ok") {
          var ver = str.slice(0, -3);
          if (ver) {
            aeVersion = ver;
            if ($ae) $ae.textContent = "AE " + aeVersion;
          }
          resolve();
        } else {
          reject(new Error("Failed to initialize __chromaAe from host/core.jsx (got: " + str + ")"));
        }
      });
    });
  }

  // ---------- Cleanup ----------
  function shutdown() {
    if (server) {
      try {
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
        server.close();
      } catch (e) {}
      server = null;
    }
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeunload", shutdown);
    window.addEventListener("unload", shutdown);
  }

  // ---------- Boot ----------
  function boot() {
    setBadge("starting", "");
    if ($port) $port.textContent = "127.0.0.1:" + boundPort;
    bindSetupActions();

    if (host) {
      var env = host.getHostEnvironment();
      if (env && env.appVersion) {
        aeVersion = String(env.appVersion);
        if ($ae) $ae.textContent = "AE " + aeVersion;
      }
    }

    try {
      var tokenState = initPrivateStorage();
      updateSetupUi();
      log("", (tokenState && tokenState.reused ? "Token loaded from " : "Token written to ") + tokenPath);
    } catch (storageErr) {
      setBadge("error", "err");
      log("err", "Failed to initialize private token storage: " + storageErr.message);
      return;
    }

    getPanelMcp();

    ensureCoreJsxLoaded()
      .then(function () {
        log("ok", "Loaded host/core.jsx (__chromaAe ready)");
        server = http.createServer(handleRequest);
        server.on("error", function (err) {
          setBadge("error", "err");
          log("err", "HTTP server error on 127.0.0.1:" + boundPort + " — " + err.message);
        });
        server.listen(boundPort, "127.0.0.1", function () {
          var addr = server.address();
          if (addr && typeof addr.port === "number") {
            boundPort = addr.port;
          }
          if ($port) $port.textContent = "127.0.0.1:" + boundPort;
          updateSetupUi();
          updateQueueUi();
          log("ok", "Listening on http://127.0.0.1:" + boundPort);
        });
      })
      .catch(function (err) {
        setBadge("error", "err");
        log("err", err.message);
      });
  }

  boot();
})();
