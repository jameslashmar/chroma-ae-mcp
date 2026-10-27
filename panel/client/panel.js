// panel/client/panel.js — Chroma AE MCP UI-only CEP panel.
// Polls GET /health on the background service, tails <stateDir>/service.log,
// and provides Copy setup command + Regenerate token controls. Never starts a server.

(function () {
  "use strict";

  var http = require("http");
  var fs = require("fs");
  var path = require("path");

  var common = (typeof window !== "undefined" && window.ChromaAeCommon)
    ? window.ChromaAeCommon
    : require(path.join(__dirname, "common.js"));

  var POLL_INTERVAL_MS = 1000;
  var HTTP_TIMEOUT_MS = 3000;
  var MAX_LOG_LINES = common.MAX_LOG_LINES || 200;
  var INITIAL_TAIL_BYTES = 64 * 1024; // Read last 64 KB on initial tail load

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

  var host = common.createHostAdapter();
  var paths = common.getPaths();
  var boundPort = common.resolvePort(paths.configPath);
  var sessionToken = "";

  function setBadge(text, stateClass) {
    if (!$badge) return;
    $badge.textContent = text;
    $badge.className = "badge" + (stateClass ? " " + stateClass : "");
  }

  function appendLogRow(level, text) {
    if (!$log || typeof document === "undefined") return;
    var row = document.createElement("div");
    row.className = "log-entry" + (level ? " " + level : "");
    row.textContent = text;
    $log.appendChild(row);
    while ($log.childNodes.length > MAX_LOG_LINES) {
      $log.removeChild($log.firstChild);
    }
    $log.scrollTop = $log.scrollHeight;
  }

  function logUi(level, msg) {
    if (msg === undefined) {
      msg = level;
      level = "";
    }
    var ts = new Date().toISOString().substring(11, 19);
    appendLogRow(level, "[" + ts + "] " + msg);
  }

  // ---------- Token file reading & setup command display ----------
  function updateSetupUi() {
    if ($setupCommand) {
      $setupCommand.textContent = common.buildSetupCommand(
        boundPort,
        common.maskToken(sessionToken)
      );
    }
  }

  function refreshTokenFromDisk() {
    var diskToken = common.readTokenFile(paths.tokenPath);
    if (common.isValidToken(diskToken) && diskToken !== sessionToken) {
      sessionToken = diskToken;
      updateSetupUi();
    }
    return sessionToken;
  }

  // ---------- Tail <stateDir>/service.log ----------
  var lastLogSize = -1;
  var logCarryover = "";

  function renderLogLine(rawLine) {
    var trimmed = String(rawLine || "").replace(/\r$/, "");
    if (!trimmed) return;
    var parsed = common.parseLogLine(trimmed);
    appendLogRow(parsed.level, parsed.text);
  }

  function pollServiceLog() {
    try {
      if (!fs.existsSync(paths.logPath)) {
        return;
      }
      var st = fs.statSync(paths.logPath);
      if (lastLogSize === -1) {
        // Initial read: load tail of existing service.log
        var startOffset = st.size > INITIAL_TAIL_BYTES ? st.size - INITIAL_TAIL_BYTES : 0;
        var readLen = st.size - startOffset;
        if (readLen > 0) {
          var fdInit = fs.openSync(paths.logPath, "r");
          try {
            var bufInit = Buffer.alloc(readLen);
            var bytesReadInit = fs.readSync(fdInit, bufInit, 0, readLen, startOffset);
            var textInit = bufInit.slice(0, bytesReadInit).toString("utf8");
            var linesInit = textInit.split("\n");
            // If we started mid-file, drop the first potentially partial line
            if (startOffset > 0 && linesInit.length > 0) {
              linesInit.shift();
            }
            // Keep trailing incomplete line in carryover if file didn't end with newline
            logCarryover = linesInit.length > 0 ? linesInit.pop() : "";
            var startIdx = linesInit.length > MAX_LOG_LINES ? linesInit.length - MAX_LOG_LINES : 0;
            for (var i = startIdx; i < linesInit.length; i++) {
              renderLogLine(linesInit[i]);
            }
          } finally {
            try { fs.closeSync(fdInit); } catch (e) {}
          }
        }
        lastLogSize = st.size;
        return;
      }

      if (st.size < lastLogSize) {
        // Log file was rotated or truncated
        lastLogSize = 0;
        logCarryover = "";
      }

      if (st.size > lastLogSize) {
        var delta = st.size - lastLogSize;
        var fd = fs.openSync(paths.logPath, "r");
        try {
          var buf = Buffer.alloc(delta);
          var bytesRead = fs.readSync(fd, buf, 0, delta, lastLogSize);
          lastLogSize += bytesRead;
          var chunkText = logCarryover + buf.slice(0, bytesRead).toString("utf8");
          var lines = chunkText.split("\n");
          logCarryover = lines.length > 0 ? lines.pop() : "";
          for (var j = 0; j < lines.length; j++) {
            renderLogLine(lines[j]);
          }
        } finally {
          try { fs.closeSync(fd); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  // ---------- HTTP client to service ----------
  function requestService(method, routePath, callback) {
    refreshTokenFromDisk();
    if (!common.isValidToken(sessionToken)) {
      callback(new Error("Token file not ready at " + paths.tokenPath), 0, null);
      return;
    }

    var done = false;
    function finish(err, statusCode, body) {
      if (done) return;
      done = true;
      callback(err, statusCode, body);
    }

    var headers = {
      Host: "127.0.0.1:" + boundPort,
      Authorization: "Bearer " + sessionToken
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = "0";
    }

    var req = http.request(
      {
        hostname: "127.0.0.1",
        port: boundPort,
        path: routePath,
        method: method,
        headers: headers
      },
      function (res) {
        var chunks = [];
        res.on("data", function (c) {
          chunks.push(c);
        });
        res.on("end", function () {
          var raw = Buffer.concat(chunks).toString("utf8");
          var parsed = null;
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch (e) {
              parsed = null;
            }
          }
          finish(null, res.statusCode || 0, parsed);
        });
      }
    );

    req.setTimeout(HTTP_TIMEOUT_MS, function () {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", function (err) {
      finish(err, 0, null);
    });

    req.end();
  }

  // ---------- Poll GET /health ----------
  var healthInFlight = false;

  function pollHealth() {
    if (healthInFlight) return;
    healthInFlight = true;

    requestService("GET", "/health", function (err, statusCode, body) {
      healthInFlight = false;

      if (err || statusCode !== 200 || !body || body.ok !== true) {
        setBadge("offline", "err");
        if ($inflight) $inflight.textContent = "idle";
        if ($queueDepth) $queueDepth.textContent = "0";
        return;
      }

      if (body.aeVersion && body.aeVersion !== "unknown" && $ae) {
        $ae.textContent = "AE " + body.aeVersion;
      }

      if ($inflight) {
        if (body.inFlight && typeof body.inFlight === "object") {
          var lbl = body.inFlight.label
            ? body.inFlight.label + " (" + body.inFlight.id + ")"
            : String(body.inFlight.id || "busy");
          $inflight.textContent = lbl;
        } else {
          $inflight.textContent = "idle";
        }
      }

      if ($queueDepth) {
        $queueDepth.textContent = String(
          typeof body.queueDepth === "number" ? body.queueDepth : 0
        );
      }

      if (body.busy || body.inFlight) {
        setBadge("busy", "busy");
      } else {
        setBadge("ready", "ok");
      }
    });
  }

  // ---------- Setup command & Regenerate token buttons ----------
  function bindSetupActions() {
    if ($copySetupBtn) {
      $copySetupBtn.addEventListener("click", function () {
        refreshTokenFromDisk();
        if (!common.isValidToken(sessionToken)) {
          logUi("err", "Token file is unavailable at " + paths.tokenPath);
          return;
        }
        var cmd = common.buildSetupCommand(boundPort, sessionToken);
        common.copyTextToClipboard(cmd, function (copied) {
          if (copied) {
            logUi("ok", "Copied setup command to clipboard");
          } else {
            logUi("err", "Failed to copy setup command to clipboard");
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

        requestService("POST", "/admin/regenerate-token", function (err, statusCode, body) {
          if (err) {
            logUi("err", "Failed to regenerate token: " + err.message);
            return;
          }
          if (statusCode !== 200 || !body || body.ok !== true) {
            var errMsg = (body && body.error && body.error.message)
              ? body.error.message
              : "HTTP " + statusCode;
            logUi("err", "Failed to regenerate token: " + errMsg);
            return;
          }
          refreshTokenFromDisk();
          updateSetupUi();
          pollServiceLog();
          pollHealth();
        });
      });
    }
  }

  // ---------- Lifecycle & Boot ----------
  var pollTimer = null;

  function tick() {
    refreshTokenFromDisk();
    pollServiceLog();
    pollHealth();
  }

  function shutdown() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeunload", shutdown);
    window.addEventListener("unload", shutdown);
  }

  function boot() {
    setBadge("starting", "");
    if ($port) $port.textContent = "127.0.0.1:" + boundPort;

    if (host) {
      var env = host.getHostEnvironment();
      if (env && env.appVersion && $ae) {
        $ae.textContent = "AE " + String(env.appVersion);
      }
    }

    refreshTokenFromDisk();
    updateSetupUi();
    bindSetupActions();

    tick();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }

  boot();
})();
