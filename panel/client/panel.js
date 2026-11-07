// panel/client/panel.js — Chroma AE MCP UI-only CEP panel.
// Polls GET /health on the background service, tails <stateDir>/service.log,
// shows session tiles, a reply-time chart and a Log built from the service's
// "tool ..." lines, and provides Copy setup command + Regenerate token controls.
// Never starts a server.

(function () {
  "use strict";

  var http = require("http");
  var https = require("https");
  var crypto = require("crypto");
  var os = require("os");
  var childProcess = require("child_process");
  var fs = require("fs");
  var path = require("path");

  var common = (typeof window !== "undefined" && window.ChromaAeCommon)
    ? window.ChromaAeCommon
    : require(path.join(__dirname, "common.js"));

  var POLL_INTERVAL_MS = 1000;
  var HTTP_TIMEOUT_MS = 3000;
  var MAX_LOG_LINES = common.MAX_LOG_LINES || 200;
  var INITIAL_TAIL_BYTES = 256 * 1024; // Read last 256 KB on initial tail load (enough for a session's tiles)
  var LOG_VIEW_KEY = "chroma-ae-mcp.logView";

  // ---------- DOM references & UI helpers ----------
  var $badge = typeof document !== "undefined" ? document.getElementById("status-badge") : null;
  var $statusText = typeof document !== "undefined" ? document.getElementById("status-text") : null;
  var $port = typeof document !== "undefined" ? document.getElementById("port-value") : null;
  var $ae = typeof document !== "undefined" ? document.getElementById("ae-version") : null;
  var $inflight = typeof document !== "undefined" ? document.getElementById("inflight-label") : null;
  var $queueDepth = typeof document !== "undefined" ? document.getElementById("queue-depth") : null;
  var $setupCommand = typeof document !== "undefined" ? document.getElementById("setup-command") : null;
  var $copySetupBtn = typeof document !== "undefined" ? document.getElementById("copy-setup-btn") : null;
  var $writeDesktopBtn = typeof document !== "undefined" ? document.getElementById("write-desktop-btn") : null;
  var $regenTokenBtn = typeof document !== "undefined" ? document.getElementById("regen-token-btn") : null;
  var $log = typeof document !== "undefined" ? document.getElementById("log") : null;

  var host = common.createHostAdapter();
  var paths = common.getPaths();
  var boundPort = common.resolvePort(paths.configPath);
  var sessionToken = "";

  function setBadge(text, stateClass) {
    if (!$badge) return;
    if ($statusText) $statusText.textContent = text;
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
    if ($rawCount) $rawCount.textContent = String($log.childNodes.length);
  }

  function logUi(level, msg) {
    if (msg === undefined) {
      msg = level;
      level = "";
    }
    renderLogLine(common.formatLogLine(level, msg));
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
    if (stats && stats.ingest(trimmed)) statsDirty = true;
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

  // ---------- Session tiles, reply-time chart and Log ----------
  var stats = common.createSessionStats(MAX_LOG_LINES);
  var statsDirty = false;

  function el(id) {
    return typeof document !== "undefined" ? document.getElementById(id) : null;
  }

  var $statCalls = el("stat-calls");
  var $statErrors = el("stat-errors");
  var $tileErrors = el("tile-errors");
  var $statMedian = el("stat-median");
  var $statCheckpoints = el("stat-checkpoints");
  var $chart = el("chart");
  var $chartMax = el("chart-max");
  var $chartNote = el("chart-note");
  var $logEntries = el("log-entries");
  var $logCount = el("log-count");
  var $rawCount = el("raw-count");
  var $logToggle = el("log-toggle");
  var $logFull = el("log-full");
  var $logBody = el("log-body");

  // "26.0.0x45" -> "26.0"
  function shortVersion(v) {
    var m = /^(\d+\.\d+)/.exec(String(v || ""));
    return m ? m[1] : String(v || "");
  }

  function renderChart(snap) {
    if (!$chart) return;
    while ($chart.firstChild) $chart.removeChild($chart.firstChild);
    var ms = snap.recentMs;
    if (!ms.length) {
      $chart.setAttribute("aria-label", "No tool calls yet");
      if ($chartMax) $chartMax.textContent = "";
      if ($chartNote) $chartNote.textContent = "No tool calls yet.";
      return;
    }
    var max = Math.max.apply(null, ms);
    var maxAt = ms.lastIndexOf(max);
    for (var i = 0; i < ms.length; i++) {
      var bar = document.createElement("div");
      bar.className = "chart-bar" + (i === maxAt ? " max" : "");
      bar.style.height = Math.max(4, Math.round((ms[i] / (max || 1)) * 100)) + "%";
      bar.title = ms[i] + " ms";
      $chart.appendChild(bar);
    }
    $chart.setAttribute("aria-label", "Reply times of the last " + ms.length + " tool calls, median " + snap.medianMs + " ms, slowest " + max + " ms");
    if ($chartMax) $chartMax.textContent = "max " + max + " ms";
    if ($chartNote) $chartNote.textContent = snap.slowest ? "Slowest: " + snap.slowest : "";
  }

  function entryNode(e) {
    var row = document.createElement("div");
    var failed = (e.kind === "tool" && !e.ok) || e.level === "err";
    var cls = "entry";
    if (e.kind === "checkpoint") cls += " checkpoint";
    if (e.kind === "event" || e.kind === "session") cls += " event";
    if (e.level === "warn") cls += " warn";
    if (failed) cls += " failed";
    row.className = cls;
    var rail = document.createElement("div");
    rail.className = "entry-rail";
    var dot = document.createElement("span");
    dot.className = "entry-dot";
    var line = document.createElement("span");
    line.className = "entry-line";
    rail.appendChild(dot);
    rail.appendChild(line);
    var text = document.createElement("div");
    text.className = "entry-text";
    var title = document.createElement("div");
    title.className = "entry-title";
    var meta = document.createElement("div");
    meta.className = "entry-meta";
    if (e.kind === "event" || e.kind === "session") {
      title.textContent = e.title;
      meta.textContent = e.time.substring(0, 5) + (e.detail ? " · " + e.detail : "");
      if (e.detail) meta.title = e.detail;
    } else if (e.kind === "checkpoint") {
      title.textContent = "Checkpoint saved";
      meta.textContent = e.time.substring(0, 5) + " · before " + e.tool;
      meta.title = e.file;
    } else {
      title.textContent = e.tool;
      meta.textContent = e.time.substring(0, 5) + " · " + (e.ok ? e.ms + " ms" : "failed: " + e.error);
    }
    text.appendChild(title);
    text.appendChild(meta);
    row.appendChild(rail);
    row.appendChild(text);
    return row;
  }

  function renderStats() {
    statsDirty = false;
    var snap = stats.snapshot();
    if ($statCalls) $statCalls.textContent = String(snap.calls);
    if ($statErrors) $statErrors.textContent = String(snap.errors);
    if ($tileErrors) $tileErrors.classList.toggle("has-errors", snap.errors > 0);
    if ($statMedian) $statMedian.textContent = snap.medianMs === null ? "–" : String(snap.medianMs);
    if ($statCheckpoints) $statCheckpoints.textContent = String(snap.checkpoints);
    renderChart(snap);
    if ($logCount) $logCount.textContent = String(snap.entries.length);
    if (!$logEntries) return;
    while ($logEntries.firstChild) $logEntries.removeChild($logEntries.firstChild);
    if (!snap.entries.length) {
      var empty = document.createElement("div");
      empty.className = "log-empty";
      empty.textContent = "Nothing yet. Tool calls from Claude show up here.";
      $logEntries.appendChild(empty);
      return;
    }
    // Newest first.
    for (var i = snap.entries.length - 1; i >= 0; i--) {
      $logEntries.appendChild(entryNode(snap.entries[i]));
    }
  }

  // The Log is "closed", "open" (below the tiles) or "full" (fills the panel).
  var logView = "closed";

  function readLogView() {
    try {
      var v = window.localStorage.getItem(LOG_VIEW_KEY);
      if (v === "open" || v === "full" || v === "closed") return v;
    } catch (e) {}
    return "closed";
  }

  function setLogView(v) {
    logView = v;
    try { window.localStorage.setItem(LOG_VIEW_KEY, v); } catch (e) {}
    var open = v !== "closed";
    var full = v === "full";
    document.body.classList.toggle("log-open", open);
    document.body.classList.toggle("log-full", full);
    if ($logBody) $logBody.hidden = !open;
    if ($logToggle) $logToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if ($logFull) {
      $logFull.setAttribute("aria-pressed", full ? "true" : "false");
      $logFull.setAttribute("aria-label", full ? "Exit full panel" : "Fill the panel");
      $logFull.title = full ? "Exit full panel" : "Fill the panel";
    }
  }

  function bindLogView() {
    if (typeof document === "undefined" || !$logToggle) return;
    setLogView(readLogView());
    $logToggle.addEventListener("click", function () {
      setLogView(logView === "closed" ? "open" : "closed");
    });
    if ($logFull) {
      $logFull.addEventListener("click", function () {
        setLogView(logView === "full" ? "open" : "full");
      });
    }
  }

  // ---------- HTTP client to service ----------
  // body is optional: requestService(method, path, callback) sends none.
  function requestService(method, routePath, body, callback, timeoutMs) {
    if (typeof body === "function") {
      timeoutMs = callback;
      callback = body;
      body = null;
    }
    var payload = body === null || body === undefined ? "" : JSON.stringify(body);
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
      headers["Content-Length"] = String(Buffer.byteLength(payload));
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

    req.setTimeout(timeoutMs || HTTP_TIMEOUT_MS, function () {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", function (err) {
      finish(err, 0, null);
    });

    req.end(payload);
  }

  // ---------- Poll GET /health ----------
  var healthInFlight = false;

  // Where this panel's own After Effects is installed, read once. null when the host cannot say.
  var ownHostPath;
  function ownHostPathOnce() {
    if (ownHostPath === undefined) {
      ownHostPath = null;
      try {
        if (host && typeof host.getHostPath === "function") ownHostPath = host.getHostPath() || null;
      } catch (e) {}
    }
    return ownHostPath;
  }

  function samePath(a, b) {
    var norm = function (x) { return String(x || "").split("\\").join("/").replace(/\/+$/, "").toLowerCase(); };
    return norm(a) === norm(b);
  }

  // The service answering on the port belongs to another After Effects than this panel's:
  // returns its instance block, else null. Both paths must be known; otherwise assume the same.
  function otherAeInstance(body) {
    var inst = body && body.instance && typeof body.instance === "object" ? body.instance : null;
    var mine = ownHostPathOnce();
    if (!inst || !inst.host_path || !mine) return null;
    return samePath(inst.host_path, mine) ? null : inst;
  }

  function pollHealth() {
    if (healthInFlight) return;
    healthInFlight = true;

    requestService("GET", "/health", function (err, statusCode, body) {
      healthInFlight = false;

      if (err || statusCode !== 200 || !body || body.ok !== true) {
        setBadge("Offline", "err");
        if ($inflight) $inflight.textContent = "";
        if ($queueDepth) $queueDepth.textContent = "0";
        return;
      }

      // Another After Effects holds the port: say so instead of showing its version as this one's.
      var otherAe = otherAeInstance(body);
      if (otherAe) {
        var otherLabel = otherAe.ae_label || shortVersion(otherAe.ae_version || body.aeVersion);
        if ($ae) $ae.textContent = "AE " + otherLabel + " (not this AE)";
        if ($inflight) $inflight.textContent = "";
        if ($queueDepth) $queueDepth.textContent = "0";
        if ($clearLockBtn) $clearLockBtn.hidden = true;
        setBadge("Other AE has the connection (" + otherLabel + ")", "err");
        if ($badge) $badge.title = "The MCP service on 127.0.0.1:" + boundPort + " belongs to After Effects " + otherLabel + ". This After Effects is not serving MCP; close one of them.";
        return;
      }

      if (body.aeVersion && body.aeVersion !== "unknown" && $ae) {
        $ae.textContent = "AE " + shortVersion(body.aeVersion);
      }

      if ($inflight) {
        if (body.inFlight && typeof body.inFlight === "object") {
          var lbl = body.inFlight.label
            ? body.inFlight.label + " (" + body.inFlight.id + ")"
            : String(body.inFlight.id || "busy");
          $inflight.textContent = "Running " + lbl;
          $inflight.title = "After Effects is running " + lbl;
        } else {
          $inflight.textContent = "";
        }
      }

      if ($queueDepth) {
        $queueDepth.textContent = String(
          typeof body.queueDepth === "number" ? body.queueDepth : 0
        );
      }

      // "Clear render lock" shows only while the render gate is shut.
      if ($clearLockBtn) {
        var locked = !!(body.renderLock && typeof body.renderLock === "object");
        $clearLockBtn.hidden = !locked;
        if (!locked) {
          clearLockArmed = false;
          $clearLockBtn.textContent = "Clear render lock";
        }
      }

      if (body.busy || body.inFlight) {
        setBadge("Working", "busy");
      } else {
        setBadge("Connected", "ok");
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
        var setup = chosenSetup(sessionToken);
        if (!setup) return;
        var label = chosenLabel();
        common.copyTextToClipboard(setup.text, function (copied) {
          if (copied) {
            logUi("ok", "Copied the " + label + " setup " + (setup.kind === "command" ? "command" : "config entry"));
            flashCopied();
          } else {
            logUi("err", "Failed to copy the " + label + " setup to the clipboard");
          }
        });
      });
    }

    if ($regenTokenBtn) {
      $regenTokenBtn.addEventListener("click", function () {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          var confirmed = window.confirm(
            "Regenerate the MCP Bearer token? Claude Code's user-scope chroma-ae entry is registered again automatically (whether it was added from this panel or with the pasted command). Claude Desktop, Cursor and Codex use the relay and need nothing."
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
          reregisterClaudeCode();
          pollServiceLog();
          pollHealth();
        });
      });
    }
  }

  // ---------- Register with clients, and Save diagnostics ----------
  // tools/register.cjs adds or removes the chroma-ae entry for Claude Code
  // (its CLI), Claude Desktop, Cursor and Codex (the stdio relay).
  var $registerClients = typeof document !== "undefined" ? document.getElementById("register-clients") : null;
  var $diagnosticsBtn = typeof document !== "undefined" ? document.getElementById("diagnostics-btn") : null;
  var $clearLockBtn = typeof document !== "undefined" ? document.getElementById("clear-render-lock-btn") : null;
  var clearLockArmed = false;
  var register = null;

  function loadRegister() {
    if (register) return register;
    try {
      register = require(path.join(common.resolveExtensionDir(host), "tools", "register.cjs"));
    } catch (e) {
      logUi("err", "Register helper unavailable: " + (e && e.message ? e.message : String(e)));
    }
    return register;
  }

  // One AI is chosen at a time; Copy puts that AI's setup on the clipboard.
  var CLIENT_KEY = "chroma-ae-mcp.client";
  var $setupWhere = el("setup-where");
  var chosenClient = "claude-code";
  var clientList = [];
  try {
    chosenClient = window.localStorage.getItem(CLIENT_KEY) || "claude-code";
  } catch (e) {}

  function chosenLabel() {
    for (var i = 0; i < clientList.length; i++) {
      if (clientList[i].id === chosenClient) return clientList[i].label;
    }
    return "Claude Code";
  }

  // { kind, text, where } for the chosen AI, or null (and the reason shown) when it can't be built.
  function chosenSetup(token) {
    if (!loadRegister()) return null;
    try {
      return register.setupText(chosenClient, { port: boundPort, token: token });
    } catch (e) {
      if ($setupWhere) {
        $setupWhere.textContent = e && e.message ? e.message : String(e);
        $setupWhere.classList.add("err");
      }
      return null;
    }
  }

  var copiedTimer = null;
  function flashCopied() {
    if (!$copySetupBtn) return;
    $copySetupBtn.textContent = "Copied";
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(function () { copiedTimer = null; renderSetupHint(); }, 1500);
  }

  // What the last "Add to Claude Desktop" click said (cleared when another AI is chosen).
  var desktopNote = "";

  function renderSetupHint() {
    var setup = chosenSetup(common.maskToken(sessionToken));
    var label = chosenLabel();
    var already = false;
    var entry = null;
    for (var i = 0; i < clientList.length; i++) {
      if (clientList[i].id === chosenClient) {
        already = clientList[i].registered;
        entry = clientList[i];
      }
    }
    if ($copySetupBtn && !copiedTimer) {
      $copySetupBtn.textContent = setup && setup.kind === "config" ? "Copy config for " + label : "Copy setup command";
    }
    // Claude Desktop: the panel can write the entry itself (with a backup), including the core toolset.
    // An existing entry without CHROMA_AE_MCP_TOOLSET lists every tool, so offer the switch.
    var desktopAction = "";
    if (chosenClient === "claude-desktop" && entry) {
      if (!entry.registered) desktopAction = "Add to Claude Desktop (core toolset)";
      else if (entry.toolset === "unset") desktopAction = "Use the core toolset in Claude Desktop";
    }
    if ($writeDesktopBtn) {
      $writeDesktopBtn.hidden = !desktopAction;
      if (desktopAction) $writeDesktopBtn.textContent = desktopAction;
    }
    if (!setup || !$setupWhere) return;
    $setupWhere.classList.remove("err");
    var text = setup.where;
    if (chosenClient === "claude-desktop" && already) {
      if (entry && entry.toolset === "unset") {
        text = "Claude Desktop has chroma-ae but lists all tools. The button switches it to the core toolset (short list plus search) and backs up the config; then quit Claude Desktop from the tray and reopen it.";
      } else if (entry && entry.toolset === "core") {
        text = "Claude Desktop has chroma-ae with the core toolset. To list all tools, remove CHROMA_AE_MCP_TOOLSET from the entry's env in claude_desktop_config.json and restart Claude Desktop.";
      } else {
        text = "Claude Desktop already has chroma-ae (CHROMA_AE_MCP_TOOLSET is set by you and is kept).";
      }
    } else if (already) {
      text = label + " already has chroma-ae. " + text;
    }
    if (chosenClient === "claude-desktop" && desktopNote) text = desktopNote + " " + text;
    $setupWhere.textContent = text;
  }

  function bindDesktopAction() {
    if (!$writeDesktopBtn) return;
    $writeDesktopBtn.addEventListener("click", function () {
      if (!loadRegister()) return;
      register.setRegistered("claude-desktop", true, { toolset: "core" }).then(
        function (message) {
          desktopNote = message;
          logUi("ok", "Claude Desktop config written (core toolset). Restart Claude Desktop.");
          renderRegister();
        },
        function (err) {
          desktopNote = "";
          logUi("err", "Claude Desktop was not changed: " + (err && err.message ? err.message : String(err)));
          if ($setupWhere) {
            $setupWhere.textContent = "Claude Desktop was not changed: " + (err && err.message ? err.message : String(err));
            $setupWhere.classList.add("err");
          }
        }
      );
    });
  }

  // The section twirls closed once it has done its job. Until the user chooses,
  // it starts closed when any AI is already set up and open when none is.
  var REGISTER_OPEN_KEY = "chroma-ae-mcp.registerOpen";
  var $registerToggle = el("register-toggle");
  var $registerBody = el("register-body");
  var $registerSummary = el("register-summary");
  var registerOpenSet = false;

  function setRegisterOpen(open, remember) {
    registerOpenSet = true;
    if ($registerBody) $registerBody.hidden = !open;
    if ($registerToggle) $registerToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (remember) {
      try { window.localStorage.setItem(REGISTER_OPEN_KEY, open ? "1" : "0"); } catch (e) {}
    }
  }

  function bindRegisterToggle() {
    if (!$registerToggle) return;
    var stored = null;
    try { stored = window.localStorage.getItem(REGISTER_OPEN_KEY); } catch (e) {}
    if (stored === "1" || stored === "0") setRegisterOpen(stored === "1", false);
    $registerToggle.addEventListener("click", function () {
      setRegisterOpen($registerToggle.getAttribute("aria-expanded") !== "true", true);
    });
  }

  function renderRegister() {
    if (!$registerClients || !loadRegister()) return;
    clientList = register.status();
    var setUp = clientList.filter(function (c) { return c.registered; }).map(function (c) {
      return String(c.label).replace(/^Claude\s+/, "");
    });
    if ($registerSummary) $registerSummary.textContent = setUp.length ? "Set up: " + setUp.join(", ") : "Nothing set up";
    if (!registerOpenSet) setRegisterOpen(setUp.length === 0, false);
    var known = clientList.some(function (c) { return c.id === chosenClient; });
    if (!known) chosenClient = "claude-code";
    $registerClients.innerHTML = "";
    clientList.forEach(function (c) {
      var chip = document.createElement("button");
      var on = c.id === chosenClient;
      chip.type = "button";
      chip.className = "register-chip" + (on ? " on" : "");
      chip.textContent = String(c.label).replace(/^Claude\s+/, "");
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", on ? "true" : "false");
      chip.tabIndex = on ? 0 : -1;
      chip.title = "Set up chroma-ae in " + c.label;
      chip.addEventListener("click", function () { chooseClient(c.id, true); });
      chip.addEventListener("keydown", function (ev) {
        var step = 0;
        if (ev.key === "ArrowRight" || ev.key === "ArrowDown") step = 1;
        if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") step = -1;
        if (!step) return;
        ev.preventDefault();
        var idx = 0;
        for (var i = 0; i < clientList.length; i++) if (clientList[i].id === c.id) idx = i;
        var next = clientList[(idx + step + clientList.length) % clientList.length];
        chooseClient(next.id, true);
      });
      $registerClients.appendChild(chip);
    });
    renderSetupHint();
  }

  function chooseClient(id, focus) {
    if (id !== chosenClient) desktopNote = "";
    chosenClient = id;
    try { window.localStorage.setItem(CLIENT_KEY, id); } catch (e) {}
    renderRegister();
    if (focus && $registerClients) {
      var on = $registerClients.querySelector(".register-chip.on");
      if (on) on.focus();
    }
  }

  // Claude Code holds the token itself, so a new token means registering again.
  function reregisterClaudeCode() {
    if (!loadRegister()) return;
    var cc = register.status().filter(function (c) { return c.id === "claude-code"; })[0];
    if (!cc || !cc.registered) return;
    if (!common.isValidToken(sessionToken)) {
      logUi("err", "Claude Code was not registered again: the new token could not be read from " + paths.tokenPath + ". Copy the setup command instead.");
      return;
    }
    register.setRegistered("claude-code", true, { port: boundPort, token: sessionToken }).then(
      function () {
        logUi("ok", "Claude Code registered again with the new token");
        renderRegister();
      },
      function (e) {
        logUi("err", "Claude Code: " + (e && e.message ? e.message : String(e)) + " Copy the setup command instead.");
        renderRegister();
      }
    );
  }

  // Two clicks: the first arms it, the second sends. Only the user can press it; no tool can.
  function bindClearRenderLock() {
    if (!$clearLockBtn) return;
    $clearLockBtn.addEventListener("click", function () {
      if (!clearLockArmed) {
        clearLockArmed = true;
        $clearLockBtn.textContent = "Click again: After Effects is NOT rendering";
        return;
      }
      clearLockArmed = false;
      $clearLockBtn.disabled = true;
      requestService("POST", "/admin/clear-render-lock", function (err, statusCode, body) {
        $clearLockBtn.disabled = false;
        $clearLockBtn.textContent = "Clear render lock";
        if (err || statusCode !== 200 || !body || body.ok !== true) {
          var why = err ? err.message : (body && body.error && body.error.message) || "HTTP " + statusCode;
          logUi("err", "Clearing the render lock failed: " + why);
          return;
        }
        logUi("ok", body.cleared ? "Render lock cleared (job " + body.cleared.job_id + ")" : "There was no render lock");
        pollHealth();
      });
    });
  }

  function bindDiagnostics() {
    if (!$diagnosticsBtn) return;
    $diagnosticsBtn.addEventListener("click", function () {
      $diagnosticsBtn.disabled = true;
      requestService("POST", "/admin/diagnostics", function (err, statusCode, body) {
        $diagnosticsBtn.disabled = false;
        if (err || statusCode !== 200 || !body || body.ok !== true) {
          var why = err ? err.message : (body && body.error && body.error.message) || "HTTP " + statusCode;
          logUi("err", "Diagnostics failed: " + why);
          return;
        }
        common.copyTextToClipboard(body.path, function () {});
        logUi("ok", "Diagnostics saved (path copied): " + body.path);
      }, 30000);
    });
  }

  // ---------- Questions from the agent (ae_ask_user) ----------
  // The service keeps the questions; this polls GET /ask, shows the oldest,
  // and posts the answer to POST /ask/answer. Ease questions draw each
  // option's cubic-bezier with a moving dot, and the chosen curve can be
  // reshaped in the editor before sending.
  var SVG_NS = "http://www.w3.org/2000/svg";
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  var PREVIEW_MS = 1400;
  var PREVIEW_PAUSE_MS = 500;
  // Editor viewBox is 200x200: time 0..1 spans x 20..180, progress 0..1
  // spans y 160..40, which leaves room for overshooting handles.
  var ED_X0 = 20;
  var ED_W = 160;
  var ED_Y0 = 160;
  var ED_H = 120;
  var ED_Y_MIN = -0.33;
  var ED_Y_MAX = 1.33;

  function byId(id) {
    return typeof document !== "undefined" ? document.getElementById(id) : null;
  }

  var $ask = byId("ask");
  var $askMore = byId("ask-more");
  var $askQuestion = byId("ask-question");
  var $askContext = byId("ask-context");
  var $askOptions = byId("ask-options");
  var $askEditor = byId("ask-editor");
  var $askEditorSvg = byId("ask-editor-svg");
  var $askCurveValue = byId("ask-curve-value");
  var $askEditorDot = byId("ask-editor-dot");
  var $askOther = byId("ask-other");
  var $askSend = byId("ask-send");
  var $askDismiss = byId("ask-dismiss");
  var $askStatus = byId("ask-status");

  var currentAsk = null;
  var askSelected = [];
  var askCurve = null;
  var askSending = false;
  var askPollInFlight = false;
  var previewDots = [];
  var previewTimer = null;
  var dragHandle = -1;
  var imageCache = {};
  var imageCacheOrder = [];
  // Bounds imageCache's growth: entries are base64 data URLs up to MAX_IMAGE_BYTES
  // each, and a long AE session calling ae_ask_user with distinct preview images
  // (tracking/keying frames) would otherwise grow this unboundedly for the life of
  // the panel process.
  var MAX_IMAGE_CACHE_ENTRIES = 24;

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  // CSS cubic-bezier: progress at normalized time x (x(s) is monotonic for x1, x2 in 0..1).
  function bezierProgress(curve, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    function axis(a, b, s) {
      var u = 1 - s;
      return 3 * a * s * u * u + 3 * b * s * s * u + s * s * s;
    }
    var lo = 0;
    var hi = 1;
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2;
      if (axis(curve[0], curve[2], mid) < x) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return axis(curve[1], curve[3], (lo + hi) / 2);
  }

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) {
        el.setAttribute(k, String(attrs[k]));
      }
    }
    return el;
  }

  function curvePath(curve, px, py) {
    return "M" + px(0) + "," + py(0) +
      " C" + px(curve[0]) + "," + py(curve[1]) +
      " " + px(curve[2]) + "," + py(curve[3]) +
      " " + px(1) + "," + py(1);
  }

  function curveThumb(curve) {
    var svg = svgEl("svg", { viewBox: "0 0 100 54", preserveAspectRatio: "none" });
    function px(x) { return 6 + x * 88; }
    function py(y) { return 44 - y * 34; }
    svg.appendChild(svgEl("line", {
      x1: px(0), y1: py(0), x2: px(1), y2: py(1),
      stroke: "#3a3a3a", "stroke-width": 1, "vector-effect": "non-scaling-stroke"
    }));
    svg.appendChild(svgEl("path", {
      d: curvePath(curve, px, py),
      fill: "none", stroke: "#8cc4ff", "stroke-width": 2, "vector-effect": "non-scaling-stroke"
    }));
    return svg;
  }

  function imageDataUrl(p) {
    if (Object.prototype.hasOwnProperty.call(imageCache, p)) return imageCache[p];
    var url = null;
    try {
      var st = fs.statSync(p);
      if (st.isFile() && st.size <= MAX_IMAGE_BYTES) {
        var mime = /\.png$/i.test(p) ? "image/png" : "image/jpeg";
        url = "data:" + mime + ";base64," + fs.readFileSync(p).toString("base64");
      }
    } catch (e) {}
    imageCache[p] = url;
    imageCacheOrder.push(p);
    while (imageCacheOrder.length > MAX_IMAGE_CACHE_ENTRIES) {
      delete imageCache[imageCacheOrder.shift()];
    }
    return url;
  }

  function buildOption(q, opt) {
    var card = document.createElement("button");
    card.type = "button";
    card.className = "ask-option";
    card.setAttribute("data-id", opt.id);
    if (q.kind === "ease" && opt.curve) {
      card.appendChild(curveThumb(opt.curve));
      var track = document.createElement("div");
      track.className = "ask-track";
      var dot = document.createElement("span");
      dot.className = "ask-dot";
      track.appendChild(dot);
      card.appendChild(track);
      previewDots.push({ el: dot, curve: opt.curve });
    }
    if (opt.image_path) {
      var src = imageDataUrl(opt.image_path);
      if (src) {
        var img = document.createElement("img");
        img.src = src;
        img.alt = opt.label;
        card.appendChild(img);
      }
    }
    var label = document.createElement("div");
    label.className = "ask-option-label";
    label.textContent = opt.label;
    card.appendChild(label);
    if (opt.description) {
      var desc = document.createElement("div");
      desc.className = "ask-option-desc";
      desc.textContent = opt.description;
      card.appendChild(desc);
    }
    card.addEventListener("click", function () {
      chooseOption(opt);
    });
    return card;
  }

  function chooseOption(opt) {
    if (!currentAsk) return;
    var idx = askSelected.indexOf(opt.id);
    if (currentAsk.multi_select) {
      if (idx >= 0) {
        askSelected.splice(idx, 1);
      } else {
        askSelected.push(opt.id);
      }
    } else {
      askSelected = [opt.id];
    }
    if (currentAsk.kind === "ease" && opt.curve && askSelected.indexOf(opt.id) >= 0) {
      askCurve = opt.curve.slice();
      renderEditor();
    }
    refreshAskState();
  }

  function refreshAskState() {
    if (!$askOptions || !$askSend) return;
    var cards = $askOptions.querySelectorAll(".ask-option");
    for (var i = 0; i < cards.length; i++) {
      var on = askSelected.indexOf(cards[i].getAttribute("data-id")) >= 0;
      cards[i].classList.toggle("selected", on);
    }
    var hasOther = !!($askOther && !$askOther.hidden && $askOther.value.trim().length > 0);
    $askSend.disabled = askSending || (askSelected.length === 0 && !hasOther);
    if ($askDismiss) $askDismiss.disabled = askSending;
  }

  function edX(x) { return ED_X0 + x * ED_W; }
  function edY(y) { return ED_Y0 - y * ED_H; }

  function renderEditor() {
    if (!$askEditor || !$askEditorSvg) return;
    var svg = $askEditorSvg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!askCurve) {
      $askEditor.hidden = true;
      return;
    }
    $askEditor.hidden = false;
    var c = askCurve;
    svg.appendChild(svgEl("rect", {
      x: edX(0), y: edY(1), width: ED_W, height: ED_H, fill: "none", stroke: "#2f2f2f"
    }));
    svg.appendChild(svgEl("line", { x1: edX(0), y1: edY(0), x2: edX(1), y2: edY(1), stroke: "#2a2a2a" }));
    svg.appendChild(svgEl("line", { x1: edX(0), y1: edY(0), x2: edX(c[0]), y2: edY(c[1]), stroke: "#6a6a6a" }));
    svg.appendChild(svgEl("line", { x1: edX(1), y1: edY(1), x2: edX(c[2]), y2: edY(c[3]), stroke: "#6a6a6a" }));
    svg.appendChild(svgEl("path", { d: curvePath(c, edX, edY), fill: "none", stroke: "#8cc4ff", "stroke-width": 2.5 }));
    addHandle(0, c[0], c[1]);
    addHandle(1, c[2], c[3]);
    if ($askCurveValue) {
      $askCurveValue.textContent = "cubic-bezier(" + round3(c[0]) + ", " + round3(c[1]) + ", " +
        round3(c[2]) + ", " + round3(c[3]) + ")";
    }
  }

  function addHandle(which, x, y) {
    var h = svgEl("circle", {
      cx: edX(x), cy: edY(y), r: 7, fill: "#f5c065", stroke: "#1e1e1e", "stroke-width": 1.5, "class": "ask-handle"
    });
    h.addEventListener("mousedown", function (ev) {
      ev.preventDefault();
      dragHandle = which;
    });
    $askEditorSvg.appendChild(h);
  }

  function onDragMove(ev) {
    if (dragHandle < 0 || !askCurve || !$askEditorSvg) return;
    var r = $askEditorSvg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var sx = (ev.clientX - r.left) * (200 / r.width);
    var sy = (ev.clientY - r.top) * (200 / r.height);
    askCurve[dragHandle * 2] = round3(clamp((sx - ED_X0) / ED_W, 0, 1));
    askCurve[dragHandle * 2 + 1] = round3(clamp((ED_Y0 - sy) / ED_H, ED_Y_MIN, ED_Y_MAX));
    renderEditor();
  }

  // Progress 0..1 spans the middle 84% of the track, so anticipation and
  // overshoot stay visible inside it.
  function trackLeft(progress) {
    return clamp(8 + progress * 84, 0, 100) + "%";
  }

  function animatePreviews() {
    var t = (Date.now() % (PREVIEW_MS + PREVIEW_PAUSE_MS)) / PREVIEW_MS;
    if (t > 1) t = 1;
    for (var i = 0; i < previewDots.length; i++) {
      previewDots[i].el.style.left = trackLeft(bezierProgress(previewDots[i].curve, t));
    }
    if ($askEditorDot && askCurve) {
      $askEditorDot.style.left = trackLeft(bezierProgress(askCurve, t));
    }
  }

  function startPreviews() {
    if (previewTimer === null && currentAsk && currentAsk.kind === "ease") {
      previewTimer = setInterval(animatePreviews, 33);
    }
  }

  function stopPreviews() {
    if (previewTimer !== null) {
      clearInterval(previewTimer);
      previewTimer = null;
    }
  }

  function showAsk(q) {
    if (!$ask) return;
    stopPreviews();
    currentAsk = q;
    askSelected = [];
    askCurve = null;
    askSending = false;
    previewDots = [];
    $askQuestion.textContent = q.question;
    $askContext.textContent = q.context || "";
    while ($askOptions.firstChild) $askOptions.removeChild($askOptions.firstChild);
    for (var i = 0; i < q.options.length; i++) {
      $askOptions.appendChild(buildOption(q, q.options[i]));
    }
    $askOther.value = "";
    $askOther.hidden = !q.allow_other;
    $askStatus.textContent = "";
    renderEditor();
    $ask.hidden = false;
    document.body.classList.add("asking");
    $ask.classList.remove("ask-new");
    void $ask.offsetWidth; // restart the flash animation
    $ask.classList.add("ask-new");
    logUi("", "Claude asks: " + q.question);
    refreshAskState();
    startPreviews();
  }

  function hideAsk() {
    stopPreviews();
    currentAsk = null;
    askCurve = null;
    if ($ask) $ask.hidden = true;
    if (typeof document !== "undefined") document.body.classList.remove("asking");
  }

  function pollAsks() {
    if (askPollInFlight || !$ask) return;
    askPollInFlight = true;
    requestService("GET", "/ask", function (err, statusCode, body) {
      askPollInFlight = false;
      if (err || statusCode !== 200 || !body || body.ok !== true) return;
      var qs = Array.isArray(body.questions) ? body.questions : [];
      if (qs.length === 0) {
        if (currentAsk) hideAsk();
        return;
      }
      if ($askMore) $askMore.textContent = qs.length > 1 ? "+" + (qs.length - 1) + " more" : "";
      if (!currentAsk || currentAsk.id !== qs[0].id) {
        showAsk(qs[0]);
      }
    });
  }

  function sendAnswer(dismissed) {
    if (!currentAsk || askSending) return;
    var q = currentAsk;
    var body = { id: q.id };
    if (dismissed) {
      body.dismissed = true;
    } else {
      body.choice_ids = askSelected.slice();
      var other = $askOther && !$askOther.hidden ? $askOther.value.trim() : "";
      if (other) body.other = other;
      if (q.kind === "ease" && askCurve) body.curve = askCurve.slice();
    }
    askSending = true;
    $askStatus.textContent = "";
    refreshAskState();
    requestService("POST", "/ask/answer", body, function (err, statusCode, resp) {
      askSending = false;
      if (err || statusCode !== 200 || !resp || resp.ok !== true) {
        var msg = resp && resp.error && resp.error.message
          ? resp.error.message
          : (err ? err.message : "HTTP " + statusCode);
        $askStatus.textContent = msg;
        refreshAskState();
        if (msg === "already answered" || msg === "unknown question") {
          hideAsk();
          pollAsks();
        }
        return;
      }
      logUi("ok", dismissed ? "Skipped the question" : "Answer sent");
      hideAsk();
      pollAsks();
    });
  }

  function bindAskActions() {
    if (!$ask) return;
    $askSend.addEventListener("click", function () { sendAnswer(false); });
    $askDismiss.addEventListener("click", function () { sendAnswer(true); });
    $askOther.addEventListener("input", refreshAskState);
    $askOther.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !$askSend.disabled) sendAnswer(false);
    });
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", function () { dragHandle = -1; });
  }

  // ---------- Lifecycle & Boot ----------
  var pollTimer = null;

  function tick() {
    refreshTokenFromDisk();
    pollServiceLog();
    if (statsDirty) renderStats();
    pollHealth();
    pollAsks();
  }

  function shutdown() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    stopPreviews();
  }

  // ---------- Update from the latest GitHub release ----------
  // Checks once at start-up and on "Check for updates". "Update" downloads the
  // release's .zxp to Downloads, checks its SHA256, and opens it, so the ZXP
  // installer that is registered for .zxp installs it. AE then needs a restart.
  // A dev install (panel/ junctioned into CEP) never updates this way: an installer
  // could delete through the junction into the repo.
  var $updateBar = el("update-bar");
  var $updateTitle = el("update-title");
  var $updateStatus = el("update-status");
  var $updateBtn = el("update-btn");
  var $updateNotes = el("update-notes");
  var $updateCheckBtn = el("update-check-btn");
  var latestRelease = null;
  var updating = false;
  var UPDATE_FIRST_CHECK_MS = 8000;

  function setUpdateStatus(text, isErr) {
    if (!$updateStatus) return;
    $updateStatus.textContent = text || "";
    $updateStatus.classList.toggle("err", !!isErr);
  }

  function isDevInstall() {
    try {
      return fs.lstatSync(common.resolveExtensionDir(host)).isSymbolicLink();
    } catch (e) {
      return false;
    }
  }

  // GET with redirects (release downloads redirect to GitHub's object store).
  function httpsGet(url, onResponse, onError, hops) {
    hops = hops || 0;
    var req = https.get(url, {
      headers: { "User-Agent": "chroma-ae-mcp/" + common.PANEL_VERSION, "Accept": "application/vnd.github+json" },
      timeout: 20000
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        httpsGet(res.headers.location, onResponse, onError, hops + 1);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        onError(new Error("GitHub answered " + res.statusCode));
        return;
      }
      onResponse(res);
    });
    req.on("timeout", function () { req.destroy(new Error("timed out")); });
    req.on("error", onError);
  }

  function checkForUpdate(manual) {
    if ($updateCheckBtn) {
      $updateCheckBtn.disabled = true;
      $updateCheckBtn.textContent = "Checking…";
    }
    function done(label) {
      if (!$updateCheckBtn) return;
      $updateCheckBtn.disabled = false;
      $updateCheckBtn.textContent = label || "Check for updates";
      if (label) setTimeout(function () { $updateCheckBtn.textContent = "Check for updates"; }, 4000);
    }
    httpsGet(common.RELEASES_API, function (res) {
      var body = "";
      res.setEncoding("utf8");
      res.on("data", function (d) { body += d; });
      res.on("end", function () {
        var rel = null;
        try { rel = common.parseLatestRelease(JSON.parse(body)); } catch (e) {}
        if (!rel) {
          if (manual) logUi("warn", "Update check: the latest release has no installable .zxp");
          done(manual ? "No update found" : "");
          return;
        }
        if (common.compareVersions(rel.version, common.PANEL_VERSION) > 0) {
          showUpdate(rel);
          done("");
        } else {
          if (manual) logUi("ok", "Up to date (v" + common.PANEL_VERSION + ")");
          done(manual ? "Up to date" : "");
        }
      });
    }, function (err) {
      if (manual) logUi("warn", "Update check failed: " + err.message);
      done(manual ? "Check failed" : "");
    });
  }

  function showUpdate(rel) {
    latestRelease = rel;
    if (!$updateBar) return;
    $updateTitle.textContent = "v" + rel.version + " is out";
    if (isDevInstall()) {
      $updateBtn.hidden = true;
      setUpdateStatus("Dev install: update with git pull.");
    } else {
      $updateBtn.hidden = false;
      setUpdateStatus("You have v" + common.PANEL_VERSION + ".");
    }
    $updateBar.hidden = false;
  }

  function downloadDir() {
    var dl = path.join(os.homedir(), "Downloads");
    try {
      if (fs.statSync(dl).isDirectory()) return dl;
    } catch (e) {}
    return path.dirname(paths.logPath);
  }

  function openFile(file) {
    var cmd = process.platform === "win32" ? "explorer.exe" : "open";
    var child = childProcess.spawn(cmd, [file], { detached: true, stdio: "ignore" });
    child.on("error", function () {});
    child.unref();
  }

  function runUpdate() {
    var rel = latestRelease;
    if (!rel || updating) return;
    if (!rel.sha256) {
      setUpdateStatus("The release has no SHA256 to check against.", true);
      logUi("err", "Update: v" + rel.version + " has no SHA256, not installing");
      return;
    }
    updating = true;
    $updateBtn.disabled = true;
    var target = path.join(downloadDir(), rel.fileName);
    var partial = target + ".part";
    setUpdateStatus("Downloading…");
    function fail(msg) {
      updating = false;
      $updateBtn.disabled = false;
      try { fs.unlinkSync(partial); } catch (e) {}
      setUpdateStatus(msg, true);
      logUi("err", "Update: " + msg);
    }
    httpsGet(rel.url, function (res) {
      var total = parseInt(res.headers["content-length"], 10) || rel.size || 0;
      var got = 0;
      var hash = crypto.createHash("sha256");
      var out;
      try {
        out = fs.createWriteStream(partial);
      } catch (e) {
        res.resume();
        fail("Can't write " + partial);
        return;
      }
      res.on("data", function (d) {
        got += d.length;
        hash.update(d);
        if (total) setUpdateStatus("Downloading… " + Math.round((got / total) * 100) + "%");
      });
      res.on("error", function (e) { out.destroy(); fail("Download failed: " + e.message); });
      out.on("error", function (e) { fail("Can't save the file: " + e.message); });
      out.on("finish", function () {
        var sha = hash.digest("hex");
        if (sha !== rel.sha256) {
          fail("Download didn't match the release's SHA256. Nothing was installed.");
          return;
        }
        try {
          try { fs.unlinkSync(target); } catch (e) {}
          fs.renameSync(partial, target);
        } catch (e) {
          fail("Can't save " + target);
          return;
        }
        updating = false;
        $updateBtn.disabled = false;
        $updateBtn.textContent = "Open again";
        setUpdateStatus("Installer opened. Restart After Effects when it's done.");
        logUi("ok", "Update v" + rel.version + " downloaded to " + target);
        openFile(target);
      });
      res.pipe(out);
    }, function (err) {
      fail("Download failed: " + err.message);
    });
  }

  function bindUpdate() {
    if ($updateCheckBtn) $updateCheckBtn.addEventListener("click", function () { checkForUpdate(true); });
    if ($updateBtn) $updateBtn.addEventListener("click", function () {
      if ($updateBtn.textContent === "Open again" && latestRelease) {
        openFile(path.join(downloadDir(), latestRelease.fileName));
        return;
      }
      runUpdate();
    });
    if ($updateNotes) $updateNotes.addEventListener("click", function () {
      if (!latestRelease || !latestRelease.notesUrl) return;
      try {
        if (typeof cep !== "undefined" && cep.util && cep.util.openURLInDefaultBrowser) {
          cep.util.openURLInDefaultBrowser(latestRelease.notesUrl);
          return;
        }
      } catch (e) {}
      openFile(latestRelease.notesUrl);
    });
    setTimeout(function () { checkForUpdate(false); }, UPDATE_FIRST_CHECK_MS);
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeunload", shutdown);
    window.addEventListener("unload", shutdown);
  }

  function boot() {
    setBadge("Starting", "");
    if ($badge) $badge.title = "Listening on 127.0.0.1:" + boundPort;

    if (host) {
      var env = host.getHostEnvironment();
      if (env && env.appVersion && $ae) {
        $ae.textContent = "AE " + shortVersion(env.appVersion);
      }
    }
    bindLogView();

    refreshTokenFromDisk();
    updateSetupUi();
    bindSetupActions();
    bindDesktopAction();
    bindAskActions();
    bindDiagnostics();
    bindClearRenderLock();
    bindUpdate();
    bindRegisterToggle();
    renderRegister();

    tick();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }

  boot();
})();
