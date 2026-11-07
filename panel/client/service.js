// panel/client/service.js — Chroma AE MCP headless background CEP service.
// Owns the HTTP bridge server, token lifecycle, FIFO evalScript queue, core.jsx boot, and MCP bundle.

(function () {
  "use strict";

  var http = require("http");
  var fs = require("fs");
  var path = require("path");
  var crypto = require("crypto");

  var common = (typeof window !== "undefined" && window.ChromaAeCommon)
    ? window.ChromaAeCommon
    : require(path.join(__dirname, "common.js"));

  var PANEL_VERSION = common.PANEL_VERSION;
  var QUEUE_WAIT_LIMIT_MS = 600 * 1000; // 600 s queued limit
  var EVALSCRIPT_ERR_MESSAGE = "EvalScript error.";
  var RETRY_BIND_MS = 5000; // Retry binding port 7790 every 5 s if busy

  var host = common.createHostAdapter();
  var aeVersion = "unknown";
  // host/ext/*.jsx files that failed to load in the last boot: [{ file, line, message }].
  var extLoadFailures = [];
  var paths = common.getPaths();
  var sessionToken = "";

  function log(level, msg) {
    if (msg === undefined) {
      msg = level;
      level = "";
    }
    common.appendServiceLog(paths.logPath, level, msg, common.LOG_MAX_BYTES);
  }

  // ---------- FIFO Serialised evalScript Queue ----------
  var queue = [];
  var inFlight = null;
  var reqCounter = 0;

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

  function enqueueEval(id, script, label, sendResponse, raw) {
    var item = {
      id: id,
      script: script,
      label: label || "eval",
      raw: Boolean(raw),
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
  }

  // Never times out or aborts an in-flight evalScript.
  function dispatchItem(item) {
    var startedAt = Date.now();
    inFlight = {
      id: item.id,
      label: item.label,
      startedAt: startedAt
    };
    // Labels starting "quiet:" (the asset watcher's polling) log only on failure.
    var quiet = String(item.label).indexOf("quiet:") === 0;
    if (!quiet) log("", "-> " + item.label + " [" + item.id + "]");

    if (!host) {
      inFlight = null;
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

    var scriptToRun = item.raw ? String(item.script || "") : wrapScriptForEval(item.script);

    try {
      host.evalScript(scriptToRun, function (rawResult) {
        var durationMs = Date.now() - startedAt;
        inFlight = null;

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

        if (item.raw) {
          if (!quiet) log("ok", "<- " + item.label + " [" + item.id + "] ok (" + durationMs + "ms)");
          item.sendResponse(200, {
            id: item.id,
            ok: true,
            result: rawStr,
            durationMs: durationMs
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
          if (!quiet) log("ok", "<- " + item.label + " [" + item.id + "] ok (" + durationMs + "ms)");
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
    var extDir = common.resolveExtensionDir(host);
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
      var cepAdapter = (typeof window !== "undefined" && window.__adobe_cep__) ? {
        listExtensions: function () {
          try {
            var raw = window.__adobe_cep__.getExtensions();
            var list = typeof raw === "string" ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
            if (!Array.isArray(list)) list = [];
            return list.map(function (ext) {
              var item = {
                id: ext && ext.id ? String(ext.id) : "",
                name: ext && ext.name ? String(ext.name) : (ext && ext.id ? String(ext.id) : "")
              };
              if (ext && ext.mainPath) item.mainPath = String(ext.mainPath);
              if (ext && ext.type) item.type = String(ext.type);
              return item;
            });
          } catch (e) {
            log("err", "Failed to get extensions from CEP: " + (e && e.message ? e.message : String(e)));
            return [];
          }
        },
        openExtension: function (id) {
          try {
            window.__adobe_cep__.requestOpenExtension(id, "");
            return true;
          } catch (e) {
            log("err", "Failed to open extension " + id + ": " + (e && e.message ? e.message : String(e)));
            return false;
          }
        }
      } : undefined;

      panelMcp = createPanelMcp({
        evalScript: evalScriptForMcp,
        dataDir: paths.stateDir,
        log: log,
        cep: cepAdapter,
        serviceInfo: function () {
          return {
            panelVersion: PANEL_VERSION,
            aeVersion: aeVersion,
            extLoadFailures: extLoadFailures,
            port: boundPort,
            evalQueueDepth: queue.length,
            inFlight: inFlight
              ? { id: inFlight.id, label: inFlight.label, runningMs: Date.now() - inFlight.startedAt }
              : null,
            logPath: paths.logPath,
            rotatedLogPath: paths.rotatedLogPath,
            tokenPath: paths.tokenPath
          };
        }
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

  // The render gate of ae_render_queue_render, read from the MCP bundle once it is loaded:
  // { info: { job_id, state, ... }, message } while the gate is shut, else null. Never throws.
  function currentRenderLock() {
    try {
      if (panelMcp && typeof panelMcp.renderLock === "function") return panelMcp.renderLock() || null;
    } catch (e) {}
    return null;
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

  // ---------- HTTP Server & Port Retry ----------
  var boundPort = common.resolvePort(paths.configPath);
  var server = null;
  var isListening = false;
  var isBinding = false;
  var isShuttingDown = false;
  var retryTimer = null;
  var lastBindErrorKey = "";

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
        startedBy: "service",
        busy: inFlight !== null,
        queueDepth: queue.length,
        aeVersion: aeVersion,
        extLoadFailures: extLoadFailures,
        panelVersion: PANEL_VERSION,
        inFlight: inFlight
          ? { id: inFlight.id, label: inFlight.label, startedAt: inFlight.startedAt }
          : null,
        renderLock: (function () {
          var lock = currentRenderLock();
          return lock ? { job_id: lock.info.job_id, state: lock.info.state } : null;
        })()
      });
      return;
    }

    // The panel's "Clear render lock" button: the user's way out of a render gate that will not lift.
    if (req.method === "POST" && reqUrl === "/admin/clear-render-lock") {
      readRequestBody(req, res, function () {
        if (!panelMcp || typeof panelMcp.clearRenderLock !== "function") {
          sendJson(res, 503, { ok: false, error: { kind: "unavailable", message: "The MCP bundle is not loaded" } });
          return;
        }
        var cleared = null;
        try {
          cleared = panelMcp.clearRenderLock();
        } catch (e) {
          sendJson(res, 500, { ok: false, error: { kind: "internal", message: e && e.message ? e.message : String(e) } });
          return;
        }
        if (cleared) log("warn", "Render lock cleared by the user (job " + String(cleared.job_id) + ")");
        sendJson(res, 200, { ok: true, cleared: cleared ? { job_id: cleared.job_id, state: cleared.state } : null });
      });
      return;
    }

    if (req.method === "POST" && reqUrl === "/admin/regenerate-token") {
      readRequestBody(req, res, function () {
        try {
          var nextToken = common.generateToken();
          common.writeTokenFile(paths.tokenPath, paths.stateDir, nextToken, function (warnMsg) {
            log("warn", warnMsg);
          });
          sessionToken = nextToken;
          log("warn", "Token regenerated. Copy and paste the setup command again.");
          sendJson(res, 200, { ok: true });
        } catch (err) {
          log("err", "Failed to regenerate token: " + (err && err.message ? err.message : String(err)));
          sendJson(res, 500, {
            ok: false,
            error: {
              kind: "internal",
              message: "Failed to regenerate token: " + (err && err.message ? err.message : String(err))
            }
          });
        }
      });
      return;
    }

    // Save diagnostics button: the same file as the ae_diagnostics tool.
    if (req.method === "POST" && reqUrl === "/admin/diagnostics") {
      readRequestBody(req, res, function () {
        var mcpDiag = getPanelMcp();
        if (!mcpDiag || typeof mcpDiag.saveDiagnostics !== "function") {
          sendJson(res, 503, { ok: false, error: { kind: "unavailable", message: "The MCP bundle is not loaded" } });
          return;
        }
        Promise.resolve(mcpDiag.saveDiagnostics())
          .then(function (out) {
            log("ok", "Diagnostics saved to " + out.path);
            sendJson(res, 200, { ok: true, path: out.path, summary: out.summary });
          })
          .catch(function (err) {
            sendJson(res, 500, { ok: false, error: { kind: "internal", message: err && err.message ? err.message : String(err) } });
          });
      });
      return;
    }

    // Questions from ae_ask_user: the panel polls GET /ask and posts the answer.
    if (req.method === "GET" && reqUrl === "/ask") {
      var mcpAsks = getPanelMcp();
      sendJson(res, 200, {
        ok: true,
        questions: mcpAsks && mcpAsks.asks ? mcpAsks.asks.open() : []
      });
      return;
    }

    if (req.method === "POST" && reqUrl === "/ask/answer") {
      readRequestBody(req, res, function (rawBody) {
        var reply;
        try {
          reply = JSON.parse(rawBody);
        } catch (e) {
          sendJson(res, 400, {
            ok: false,
            error: { kind: "invalid_request", message: "Invalid JSON body: " + e.message }
          });
          return;
        }
        var mcpAnswer = getPanelMcp();
        if (!mcpAnswer || !mcpAnswer.asks || !reply || typeof reply !== "object") {
          sendJson(res, 503, {
            ok: false,
            error: { kind: "unavailable", message: "MCP bundle (mcp-bundle.cjs) is not loaded" }
          });
          return;
        }
        var outcome = mcpAnswer.asks.answer(String(reply.id || ""), reply);
        if (outcome.ok) {
          log("ok", (reply.dismissed ? "Question dismissed " : "Question answered ") + String(reply.id));
          sendJson(res, 200, { ok: true });
        } else {
          sendJson(res, 409, {
            ok: false,
            error: { kind: "invalid_request", message: outcome.error }
          });
        }
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
        var raw = parsedBody.raw === true;

        // While After Effects renders for ae_render_queue_render it cannot answer: an eval sent now
        // would only sit in the queue behind the render. Refuse it at once; nothing is sent.
        var renderLock = currentRenderLock();
        if (renderLock) {
          sendJson(res, 200, {
            id: id,
            ok: false,
            error: { kind: "queued", message: renderLock.message }
          });
          return;
        }

        enqueueEval(id, parsedBody.script, label, function (statusCode, payload) {
          sendJson(res, statusCode, payload);
        }, raw);
      });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: { kind: "not_found", message: "Route not found" }
    });
  }

  function scheduleBindRetry() {
    if (isShuttingDown || isListening || isBinding) return;
    if (retryTimer !== null) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      tryListen();
    }, RETRY_BIND_MS);
  }

  function tryListen() {
    if (isShuttingDown || isListening || isBinding) return;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    isBinding = true;
    var candidate = http.createServer(handleRequest);
    server = candidate;

    candidate.on("error", function (err) {
      if (server === candidate) {
        server = null;
      }
      isBinding = false;
      isListening = false;
      try {
        candidate.close();
      } catch (e) {}

      // Log a failure once, not on every 5 s retry (a second AE can hold the port for hours).
      var errKey = String((err && (err.code || err.message)) || "error");
      if (errKey !== lastBindErrorKey) {
        lastBindErrorKey = errKey;
        if (err && err.code === "EADDRINUSE") {
          log(
            "warn",
            "Port 127.0.0.1:" + boundPort + " is already in use (EADDRINUSE); retrying every 5s without logging again"
          );
        } else {
          log(
            "err",
            "HTTP server error on 127.0.0.1:" +
              boundPort +
              " — " +
              (err && err.message ? err.message : String(err)) +
              "; retrying every 5s without logging again"
          );
        }
      }
      // Binding retries only create a new listener. They never touch evalScript.
      scheduleBindRetry();
    });

    candidate.listen(boundPort, "127.0.0.1", function () {
      if (server !== candidate) {
        try {
          candidate.close();
        } catch (e) {}
        return;
      }
      isBinding = false;
      isListening = true;
      lastBindErrorKey = "";
      var addr = candidate.address();
      if (addr && typeof addr.port === "number") {
        boundPort = addr.port;
      }
      log("ok", "Listening on http://127.0.0.1:" + boundPort);
      // Load the MCP bundle only once this instance owns the port. Creating it starts the asset
      // watcher, which polls evalScript every 5 s while asset_watch is on in the shared
      // settings.json; an instance that never got the port must not poll or import.
      if (!isShuttingDown) getPanelMcp();
    });
  }

  // ---------- Load host/core.jsx into ExtendScript ----------
  function ensureCoreJsxLoaded() {
    return new Promise(function (resolve, reject) {
      if (!host) {
        resolve();
        return;
      }
      var extDir = common.resolveExtensionDir(host);
      var coreJsxPath = path.join(extDir, "host", "core.jsx");
      if (!fs.existsSync(coreJsxPath)) {
        reject(new Error("host/core.jsx not found at " + coreJsxPath));
        return;
      }
      // host/ext/*.jsx add tool groups. Each attaches its functions to
      // $.global.__chromaAe, so loading from inside this function is safe.
      var extDirJsx = path.join(extDir, "host", "ext");
      var extFiles = fs.existsSync(extDirJsx)
        ? fs.readdirSync(extDirJsx).filter(function (n) { return /\.jsx$/i.test(n); }).sort()
        : [];
      // Each ext file loads in its own try/catch inside the boot script, so one file that
      // fails to parse does not stop the files after it (see common.buildBootScript).
      var bootScript = common.buildBootScript(coreJsxPath, extDirJsx, extFiles);

      host.evalScript(bootScript, function (raw) {
        var str = String(raw || "");
        var parsed = common.parseBootResult(str);
        if (parsed) {
          if (parsed.aeVersion) {
            aeVersion = parsed.aeVersion;
          }
          extLoadFailures = parsed.failures;
          for (var i = 0; i < parsed.failures.length; i++) {
            var f = parsed.failures[i];
            log("err", "host/ext/" + f.file + " failed to load" + (f.line ? " at line " + f.line : "") + ": " + f.message);
          }
          if (parsed.failures.length > 0) {
            log("err", parsed.failures.length + " of " + extFiles.length + " host/ext files failed to load; their tools are unavailable");
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
    isShuttingDown = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (server) {
      try {
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
        server.close();
      } catch (e) {}
      server = null;
    }
    // Closing the port is not enough: the MCP bundle's asset watcher polls evalScript on its own timer.
    if (panelMcp !== null) {
      try {
        if (typeof panelMcp.stop === "function") panelMcp.stop();
        else if (panelMcp.assetWatcher && typeof panelMcp.assetWatcher.stop === "function") panelMcp.assetWatcher.stop();
      } catch (e) {}
    }
    isListening = false;
    isBinding = false;
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeunload", shutdown);
    window.addEventListener("unload", shutdown);
  }

  // ---------- Boot ----------
  var booted = false;

  // Render-engine guard. aerender's headless AfterFX.com engine loads CEP extensions, so this
  // runs before anything else: no token file, no icacls, no port, no core.jsx / host/ext boot,
  // no MCP bundle. One cheap evalScript asks app.isRenderEngine. Fail open: anything but an
  // exact "render engine" answer (empty, error, timeout, no host) starts the service as before.
  // The probe is never aborted. A late "render engine" answer after the timeout still stops us.
  var guardSettled = false;
  var guardTimer = null;

  function stopForRenderEngine(reason) {
    log("warn", "Render engine detected (" + reason + "): Chroma AE MCP service not started");
    shutdown();
  }

  function settleGuard(probe, fromTimeout) {
    var verdict = common.decideServiceStart({ probe: probe, env: process.env });
    if (guardSettled) {
      // Late answer after the timeout already let the service start.
      if (!fromTimeout && !verdict.start) stopForRenderEngine(verdict.reason + ", answered late");
      return;
    }
    guardSettled = true;
    if (guardTimer !== null) {
      clearTimeout(guardTimer);
      guardTimer = null;
    }
    if (!verdict.start) {
      stopForRenderEngine(verdict.reason);
      return;
    }
    if (verdict.kind !== "interactive") log("ok", "Render-engine check: " + verdict.reason + "; starting");
    startService();
  }

  function boot() {
    if (booted) return;
    booted = true;

    if (!host || common.isGuardOverridden(process.env)) {
      settleGuard(null, false);
      return;
    }
    guardTimer = setTimeout(function () {
      guardTimer = null;
      settleGuard(null, true);
    }, common.GUARD_TIMEOUT_MS);
    try {
      host.evalScript(common.GUARD_PROBE_SCRIPT, function (raw) {
        settleGuard(raw, false);
      });
    } catch (probeErr) {
      settleGuard(null, false);
    }
  }

  function startService() {
    if (isShuttingDown) return;
    if (host) {
      var env = host.getHostEnvironment();
      if (env && env.appVersion) {
        aeVersion = String(env.appVersion);
      }
    }

    try {
      var tokenState = common.initPrivateStorage(paths, function (warnMsg) {
        log("warn", warnMsg);
      });
      sessionToken = tokenState.token;
      log(
        "ok",
        (tokenState && tokenState.reused ? "Token loaded from " : "Token written to ") + paths.tokenPath
      );
    } catch (storageErr) {
      log("err", "Failed to initialize private token storage: " + storageErr.message);
      return;
    }

    ensureCoreJsxLoaded()
      .then(function () {
        log("ok", "Loaded host/core.jsx (__chromaAe ready)");
        tryListen();
      })
      .catch(function (err) {
        log("err", err.message);
        tryListen();
      });
  }

  boot();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      shutdown: shutdown
    };
  }
})();
