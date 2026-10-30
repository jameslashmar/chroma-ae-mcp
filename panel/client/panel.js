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
  // body is optional: requestService(method, path, callback) sends none.
  function requestService(method, routePath, body, callback) {
    if (typeof body === "function") {
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

    req.setTimeout(HTTP_TIMEOUT_MS, function () {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", function (err) {
      finish(err, 0, null);
    });

    req.end(payload);
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
    bindAskActions();

    tick();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }

  boot();
})();
