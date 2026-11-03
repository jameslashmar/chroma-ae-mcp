// panel/host/ext/interpret.jsx
//
// Host functions for the footage interpretation and proxy tools:
// - interpretRead (read): per footage item the settings of the Interpret
//   Footage dialog (alpha mode, premultiply colour, invert, fields, high
//   quality fields, pulldown, conform / native / display frame rate, loop,
//   pixel aspect) and its proxy state; optionally the render queue's
//   "Proxy Use" setting and a probe for colour-profile properties
// - interpretApply (guarded write): sets any of those on one footage item
//   in dependency order (fields, then pulldown, then conform rate), with
//   guessAlphaMode / guessPulldown, and puts the old values back if a step fails
// - interpretProxy (guarded write): set a file, a sequence or a solid as the
//   proxy, clear it, or switch useProxy, on footage or comp items
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - The writes check the target guard first and validate every type, range and
//   dependency before A.withUndo opens (AE throws mid-write otherwise).
// - Reads change nothing: no time, selection, resolution or active item.
// - The read after a write runs in a separate evalScript from the server.
// - No dialogs are suppressed: a popup is read and answered through ae_dialogs.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_ITEMS = 500;
  var MAX_QUEUE = 100;
  var MAX_REACH = 500;
  var MAX_WALK = 5000;
  var MAX_STR = 20000;

  var ALPHA_NAMES = ["ignore", "straight", "premultiplied"];
  var FIELD_NAMES = ["off", "upper_field_first", "lower_field_first"];
  var PULLDOWN_NAMES = [
    "off",
    "wssww_24p_advance",
    "sswww_24p_advance",
    "swwws_24p_advance",
    "wwwss_24p_advance",
    "wwssw_24p_advance",
    "wssww",
    "sswww",
    "swwws",
    "wwwss",
    "wwssw"
  ];
  // PulldownPhase's real keys (the names above are for the tool; these are AE's).
  var PULLDOWN_KEYS = {
    off: "OFF",
    wssww_24p_advance: "WSSWW_24P_ADVANCE",
    sswww_24p_advance: "SSWWW_24P_ADVANCE",
    swwws_24p_advance: "SWWWS_24P_ADVANCE",
    wwwss_24p_advance: "WWWSS_24P_ADVANCE",
    wwssw_24p_advance: "WWSSW_24P_ADVANCE",
    wssww: "WSSWW",
    sswww: "SSWWW",
    swwws: "SWWWS",
    wwwss: "WWWSS",
    wwssw: "WWSSW"
  };
  var RQ_STATUS_KEYS = ["WILL_CONTINUE", "NEEDS_OUTPUT", "UNQUEUED", "QUEUED", "RENDERING", "USER_STOPPED", "ERR_STOPPED", "DONE"];

  function fail(kind, message, extra) {
    var e = new Error(message);
    e.__kind = kind;
    if (extra) {
      if (extra.actual !== undefined) e.__actual = extra.actual;
      if (extra.expected !== undefined) e.__expected = extra.expected;
    }
    throw e;
  }

  function assertGuard(expect) {
    if (!expect || expect.project_path === undefined) {
      fail("guard", "Mutation refused: no expect.project_path given.");
    }
    var g = A.checkGuard({ expect: expect });
    if (!g.ok) {
      fail(
        "guard",
        "Target guard refused mutation: the open project or comp does not match expect. Stop and re-read state.",
        {
          expected: expect,
          actual: { project_path: g.project_path, comp_id: g.comp_id, comp_is_valid: g.comp_is_valid }
        }
      );
    }
  }

  function clip(s, n) {
    s = String(s);
    if (s.length > n) return s.substring(0, n) + " ...[truncated]";
    return s;
  }

  function itemById(id) {
    var item = null;
    try {
      item = app.project.itemByID(id);
    } catch (e) {
      item = null;
    }
    return item;
  }

  function isFootageItem(it) {
    try {
      return it instanceof FootageItem;
    } catch (e) {
      return false;
    }
  }

  function isCompItem(it) {
    try {
      return it instanceof CompItem;
    } catch (e) {
      return false;
    }
  }

  // The name of an enum value ("premultiplied"), or the number as a string.
  function enumName(enumObj, keys, value) {
    var i;
    if (!enumObj) return String(value);
    for (i = 0; i < keys.length; i++) {
      if (enumObj[keys[i]] !== undefined && enumObj[keys[i]] === value) return keys[i].toLowerCase();
    }
    return String(value);
  }

  function alphaValue(name) {
    if (name === "ignore") return AlphaMode.IGNORE;
    if (name === "straight") return AlphaMode.STRAIGHT;
    if (name === "premultiplied") return AlphaMode.PREMULTIPLIED;
    fail("bad_args", "Unknown alpha mode \"" + name + "\"");
    return null;
  }

  function alphaName(v) {
    return enumName(AlphaMode, ["IGNORE", "STRAIGHT", "PREMULTIPLIED"], v);
  }

  function fieldValue(name) {
    if (name === "off") return FieldSeparationType.OFF;
    if (name === "upper_field_first") return FieldSeparationType.UPPER_FIELD_FIRST;
    if (name === "lower_field_first") return FieldSeparationType.LOWER_FIELD_FIRST;
    fail("bad_args", "Unknown field separation \"" + name + "\"");
    return null;
  }

  function fieldName(v) {
    return enumName(FieldSeparationType, ["OFF", "UPPER_FIELD_FIRST", "LOWER_FIELD_FIRST"], v);
  }

  function pulldownValue(name) {
    var key = PULLDOWN_KEYS[name];
    if (key === undefined || typeof PulldownPhase === "undefined" || PulldownPhase[key] === undefined) {
      fail("bad_args", "Unknown pulldown phase \"" + name + "\"");
    }
    return PulldownPhase[key];
  }

  function pulldownName(v) {
    var i;
    if (typeof PulldownPhase === "undefined") return String(v);
    for (i = 0; i < PULLDOWN_NAMES.length; i++) {
      var key = PULLDOWN_KEYS[PULLDOWN_NAMES[i]];
      if (PulldownPhase[key] !== undefined && PulldownPhase[key] === v) return PULLDOWN_NAMES[i];
    }
    return String(v);
  }

  function methodValue(name) {
    if (name === "guess_3_2") return PulldownMethod.PULLDOWN_3_2;
    if (name === "guess_24p_advance") return PulldownMethod.ADVANCE_24P;
    fail("bad_args", "Unknown pulldown method \"" + name + "\"");
    return null;
  }

  function sourceKind(it) {
    var src = null;
    try {
      src = it.mainSource;
    } catch (e0) {
      return "footage";
    }
    if (!src) return "footage";
    try {
      if (src instanceof SolidSource) return "solid";
    } catch (e1) {}
    try {
      if (src instanceof PlaceholderSource) return "placeholder";
    } catch (e2) {}
    try {
      if (src instanceof FileSource) return "file";
    } catch (e3) {}
    return "footage";
  }

  function proxyOf(it) {
    var ps = null;
    try {
      ps = it.proxySource;
    } catch (e0) {
      return null;
    }
    if (!ps) return null;
    var px = { kind: "footage" };
    try {
      if (ps instanceof SolidSource) px.kind = "solid";
      else if (ps instanceof PlaceholderSource) px.kind = "placeholder";
      else if (ps instanceof FileSource) px.kind = "file";
    } catch (e1) {}
    if (px.kind === "solid") {
      try { px.color = [ps.color[0], ps.color[1], ps.color[2]]; } catch (e2) {}
    }
    if (px.kind === "file") {
      try {
        if (ps.file) px.file = clip(ps.file.fsName, MAX_STR);
      } catch (e3) {}
      try {
        var mp = ps.missingFootagePath;
        if (mp !== undefined && mp !== null && String(mp).length > 0) px.missing = true;
      } catch (e4) {}
      if (px.missing !== true) {
        try {
          if (ps.file && ps.file.exists === false) px.missing = true;
        } catch (e5) {}
      }
    }
    try { px.is_still = ps.isStill === true; } catch (e6) {}
    try { px.has_alpha = ps.hasAlpha === true; } catch (e7) {}
    return px;
  }

  // The interpretation of one item, every field read on its own so one that
  // throws (a still has no fields; some footage rejects pixelAspect) lands in
  // `unreadable` instead of failing the read.
  function infoOf(it) {
    var out = { id: it.id, name: clip(it.name, 500) };
    var unreadable = [];
    var src = null;
    try { out.width = it.width; out.height = it.height; } catch (e0) {}
    if (isCompItem(it)) {
      out.kind = "comp";
    } else {
      out.kind = sourceKind(it);
      try { src = it.mainSource; } catch (e1) { src = null; }
    }
    try { out.use_proxy = it.useProxy === true; } catch (e2) { unreadable.push("use_proxy"); }
    out.proxy = proxyOf(it);
    if (out.kind !== "file" || !src) {
      if (unreadable.length > 0) out.unreadable = unreadable;
      return out;
    }
    try {
      if (src.file) out.file = clip(src.file.fsName, MAX_STR);
    } catch (e3) {}
    try { out.missing = it.footageMissing === true; } catch (e4) {}
    try { out.has_video = it.hasVideo === true; } catch (e5) {}
    try { out.is_still = src.isStill === true; } catch (e6) { unreadable.push("is_still"); }
    try { out.has_alpha = src.hasAlpha === true; } catch (e7) { unreadable.push("has_alpha"); }
    try { out.pixel_aspect = it.pixelAspect; } catch (e8) { unreadable.push("pixel_aspect"); }
    if (out.has_alpha === true) {
      try {
        out.alpha_mode = alphaName(src.alphaMode);
      } catch (e9) { unreadable.push("alpha_mode"); }
      if (out.alpha_mode === "premultiplied") {
        try {
          var pc = src.premulColor;
          out.premul_color = [pc[0], pc[1], pc[2]];
        } catch (e10) { unreadable.push("premul_color"); }
      }
      try { out.invert_alpha = src.invertAlpha === true; } catch (e11) { unreadable.push("invert_alpha"); }
    }
    if (out.is_still !== true) {
      try { out.field_separation = fieldName(src.fieldSeparationType); } catch (e12) { unreadable.push("field_separation"); }
      if (out.field_separation !== undefined && out.field_separation !== "off") {
        try { out.high_quality_field_separation = src.highQualityFieldSeparation === true; } catch (e13) { unreadable.push("high_quality_field_separation"); }
      }
      try { out.remove_pulldown = pulldownName(src.removePulldown); } catch (e14) { unreadable.push("remove_pulldown"); }
      try { out.conform_frame_rate = src.conformFrameRate; } catch (e15) { unreadable.push("conform_frame_rate"); }
      try { out.native_frame_rate = src.nativeFrameRate; } catch (e16) { unreadable.push("native_frame_rate"); }
      try { out.display_frame_rate = src.displayFrameRate; } catch (e17) { unreadable.push("display_frame_rate"); }
      try { out.loop = src.loop; } catch (e18) { unreadable.push("loop"); }
    }
    if (unreadable.length > 0) out.unreadable = unreadable;
    return out;
  }

  // The ids of the comp and of every item its layers use, through precomps.
  // Read-only and bounded: stops after MAX_WALK layers or MAX_REACH ids and
  // then says it is not complete.
  function reachOf(rootComp) {
    var ids = [];
    var seen = {};
    var stack = [rootComp];
    var layersSeen = 0;
    var complete = true;
    seen[rootComp.id] = true;
    ids.push(rootComp.id);
    while (stack.length > 0) {
      var comp = stack.pop();
      var nl = 0;
      try { nl = comp.numLayers; } catch (e0) { complete = false; continue; }
      for (var j = 1; j <= nl; j++) {
        if (layersSeen >= MAX_WALK) { complete = false; break; }
        layersSeen++;
        var src = null;
        try { src = comp.layer(j).source; } catch (e1) { complete = false; continue; }
        if (!src) continue;
        var sid = null;
        try { sid = src.id; } catch (e2) { complete = false; continue; }
        if (seen[sid] === true) continue;
        if (ids.length >= MAX_REACH) { complete = false; break; }
        seen[sid] = true;
        ids.push(sid);
        if (isCompItem(src)) stack.push(src);
      }
    }
    return { ids: ids, complete: complete };
  }

  // What the render queue's render settings say about proxies, for each queued
  // item. The key name ("Proxy Use") is the documented one; if this AE build
  // doesn't answer to it the result says so rather than guessing.
  function renderQueueProxy() {
    var out = { key_found: false, items: [], truncated: false };
    try {
      var rq = app.project.renderQueue;
      var n = rq.numItems;
      if (n > MAX_QUEUE) {
        n = MAX_QUEUE;
        out.truncated = true;
      }
      for (var i = 1; i <= n; i++) {
        var r = rq.item(i);
        var e = { index: i };
        try { e.comp = clip(r.comp.name, 200); } catch (e0) {}
        e.reach_complete = false;
        try {
          var rc = reachOf(r.comp);
          e.reach = rc.ids;
          e.reach_complete = rc.complete;
        } catch (eR0) {}
        try { e.status = enumName(RQItemStatus, RQ_STATUS_KEYS, r.status); } catch (e1) {}
        try {
          var st = r.getSettings(GetSettingsFormat.STRING);
          var v = st["Proxy Use"];
          if (v !== undefined && v !== null) {
            e.proxy_use = String(v);
            out.key_found = true;
          }
        } catch (e2) {
          e.settings_unreadable = true;
        }
        out.items.push(e);
      }
    } catch (e3) {
      out.error = clip(e3.message || e3, 500);
    }
    return out;
  }

  // Probe only: names on the footage source that look like colour-profile
  // settings. Nothing here is relied on; the tool reports what it finds.
  function colourProbe(it) {
    var out = { checked: it.id, matches: [] };
    try {
      var props = it.mainSource.reflect.properties;
      for (var i = 0; i < props.length && out.matches.length < 50; i++) {
        var nm = String(props[i].name);
        if (/colou?r|profile|ocio|gamma|linear/i.test(nm)) out.matches.push(nm);
      }
    } catch (e) {
      out.error = clip(e.message || e, 300);
    }
    return out;
  }

  A.interpretRead = function (args) {
    var items = [];
    var out = { items: items, skipped: { solid: 0, placeholder: 0 }, truncated: false };
    var i;
    var firstFile = null;
    if (args.item_ids && typeof args.item_ids.length === "number") {
      for (i = 0; i < args.item_ids.length && i < MAX_ITEMS; i++) {
        var it0 = itemById(args.item_ids[i]);
        if (!it0 || !(isFootageItem(it0) || isCompItem(it0))) {
          items.push({ id: args.item_ids[i], error: "not_found" });
          continue;
        }
        items.push(infoOf(it0));
        if (!firstFile && sourceKind(it0) === "file") firstFile = it0;
      }
      if (args.item_ids.length > MAX_ITEMS) out.truncated = true;
      out.total_items = items.length;
    } else {
      var total = 0;
      var n = app.project.numItems;
      for (i = 1; i <= n; i++) {
        var it = app.project.item(i);
        if (isFootageItem(it)) {
          var kind = sourceKind(it);
          if (kind === "solid") {
            out.skipped.solid++;
            continue;
          }
          if (kind === "placeholder") {
            out.skipped.placeholder++;
            continue;
          }
        } else if (isCompItem(it)) {
          // A comp only matters here when it carries a proxy.
          var cp = null;
          try { cp = it.proxySource; } catch (e0) { cp = null; }
          if (!cp) continue;
        } else {
          continue;
        }
        total++;
        if (items.length >= MAX_ITEMS) {
          out.truncated = true;
          continue;
        }
        items.push(infoOf(it));
        if (!firstFile && sourceKind(it) === "file") firstFile = it;
      }
      out.total_items = total;
    }
    if (args.include_render_queue !== false) out.render_queue = renderQueueProxy();
    if (args.probe_colour === true && firstFile) out.colour_probe = colourProbe(firstFile);
    return out;
  };

  // ---------- interpretApply ----------

  // The raw AE values of one footage source, each only if it can be read.
  function rawState(it, src) {
    var st = {};
    var still = false;
    try { still = src.isStill === true; } catch (e0) {}
    try { st.pixelAspect = it.pixelAspect; } catch (e1) {}
    var hasAlpha = false;
    try { hasAlpha = src.hasAlpha === true; } catch (e2) {}
    if (hasAlpha) {
      try { st.alphaMode = src.alphaMode; } catch (e3) {}
      if (st.alphaMode === AlphaMode.PREMULTIPLIED) {
        try {
          var pc = src.premulColor;
          st.premulColor = [pc[0], pc[1], pc[2]];
        } catch (e4) {}
      }
      try { st.invertAlpha = src.invertAlpha === true; } catch (e5) {}
    }
    if (!still) {
      try { st.fieldSep = src.fieldSeparationType; } catch (e6) {}
      if (st.fieldSep !== undefined && st.fieldSep !== FieldSeparationType.OFF) {
        try { st.hq = src.highQualityFieldSeparation === true; } catch (e7) {}
      }
      try { st.pulldown = src.removePulldown; } catch (e8) {}
      try { st.conform = src.conformFrameRate; } catch (e9) {}
      try { st.loop = src.loop; } catch (e10) {}
    }
    return st;
  }

  // One write step; `soft` swallows a failure (used when putting values back).
  function step(soft, fn) {
    if (!soft) {
      fn();
      return;
    }
    try {
      fn();
    } catch (e) {}
  }

  // Writes the target in dependency order. AE refuses a pulldown while fields
  // are off, fields off while a pulldown is on, and conform 0 while a pulldown
  // is on, so: pulldown off first when it is going off, then fields, then the
  // pulldown, then high quality, then the conform rate.
  function applyTarget(it, src, cur, tgt, soft) {
    if (tgt.pulldown !== undefined && tgt.pulldown === PulldownPhase.OFF && cur.pulldown !== undefined && cur.pulldown !== PulldownPhase.OFF) {
      step(soft, function () { src.removePulldown = PulldownPhase.OFF; });
    }
    if (tgt.guessMethod !== undefined) {
      step(soft, function () { src.guessPulldown(tgt.guessMethod); });
    } else if (tgt.fieldSep !== undefined && tgt.fieldSep !== cur.fieldSep) {
      step(soft, function () { src.fieldSeparationType = tgt.fieldSep; });
    }
    if (tgt.pulldown !== undefined && tgt.pulldown !== PulldownPhase.OFF && tgt.pulldown !== cur.pulldown) {
      step(soft, function () { src.removePulldown = tgt.pulldown; });
    }
    if (tgt.hq !== undefined) {
      step(soft, function () { src.highQualityFieldSeparation = tgt.hq; });
    }
    if (tgt.conform !== undefined) {
      step(soft, function () { src.conformFrameRate = tgt.conform; });
    }
    if (tgt.loop !== undefined) {
      step(soft, function () { src.loop = tgt.loop; });
    }
    if (tgt.guessAlpha === true) {
      step(soft, function () { src.guessAlphaMode(); });
    }
    if (tgt.alphaMode !== undefined) {
      step(soft, function () { src.alphaMode = tgt.alphaMode; });
    }
    if (tgt.premulColor !== undefined) {
      step(soft, function () { src.premulColor = [tgt.premulColor[0], tgt.premulColor[1], tgt.premulColor[2]]; });
    }
    if (tgt.invertAlpha !== undefined) {
      step(soft, function () { src.invertAlpha = tgt.invertAlpha; });
    }
    if (tgt.pixelAspect !== undefined) {
      step(soft, function () { it.pixelAspect = tgt.pixelAspect; });
    }
  }

  // Fields where two rawState results differ; `expected` is from a, `actual` from b.
  function stateDiff(a, b) {
    var keys = ["pixelAspect", "alphaMode", "invertAlpha", "fieldSep", "hq", "pulldown", "conform", "loop", "premulColor"];
    var res = { names: [], expected: {}, actual: {} };
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var x = a[key];
      var y = b[key];
      if (x === undefined) continue;
      var same;
      if (key === "premulColor") same = y !== undefined && sameList(x, y);
      else if (typeof x === "number" && typeof y === "number") same = Math.abs(x - y) <= 1e-6;
      else same = x === y;
      if (!same) {
        res.names.push(key);
        res.expected[key] = x;
        res.actual[key] = y === undefined ? null : y;
      }
    }
    return res;
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function sameList(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > 1e-6) return false;
    }
    return true;
  }

  A.interpretApply = function (args) {
    assertGuard(args.expect);
    var it = itemById(args.item_id);
    if (!it || !isFootageItem(it)) fail("not_found", "No footage item with id " + args.item_id);
    if (sourceKind(it) !== "file") fail("bad_args", "\"" + it.name + "\" is a " + sourceKind(it) + " item; only footage from a file has an interpretation");
    var src = it.mainSource;
    var missing = false;
    try { missing = it.footageMissing === true; } catch (eM) {}
    if (missing) fail("bad_args", "\"" + it.name + "\" is missing its file; relink it first");
    var hasVideo = true;
    try { hasVideo = it.hasVideo === true; } catch (eV) {}
    if (!hasVideo) fail("bad_args", "\"" + it.name + "\" has no video, so it has no interpretation to set");
    var isStill = false;
    try { isStill = src.isStill === true; } catch (eS) {}
    var hasAlpha = false;
    try { hasAlpha = src.hasAlpha === true; } catch (eA) {}

    var cur = rawState(it, src);
    var tgt = {};
    var changed = [];
    var alpha = args.alpha;

    // ----- alpha -----
    if (alpha) {
      if (!hasAlpha) fail("bad_args", "\"" + it.name + "\" has no alpha channel, so there is no alpha interpretation to set");
      var finalMode = cur.alphaMode;
      if (alpha.mode === "guess") {
        if (alpha.premul_color !== undefined || alpha.invert !== undefined) fail("bad_args", "alpha mode 'guess' can't be combined with premul_color or invert");
        tgt.guessAlpha = true;
        changed.push("alpha_mode");
      } else if (alpha.mode !== undefined && alpha.mode !== null) {
        tgt.alphaMode = alphaValue(alpha.mode);
        finalMode = tgt.alphaMode;
        if (tgt.alphaMode !== cur.alphaMode) changed.push("alpha_mode");
      }
      if (alpha.premul_color !== undefined && alpha.premul_color !== null) {
        var pcv = alpha.premul_color;
        if (typeof pcv.length !== "number" || pcv.length !== 3) fail("bad_args", "premul_color must be [r, g, b]");
        for (var ci = 0; ci < 3; ci++) {
          if (!isNum(pcv[ci]) || pcv[ci] < 0 || pcv[ci] > 1) fail("bad_args", "premul_color values must be numbers in 0..1");
        }
        if (finalMode !== AlphaMode.PREMULTIPLIED) fail("bad_args", "premul_color applies to premultiplied alpha only; set alpha mode 'premultiplied' with it");
        tgt.premulColor = [pcv[0], pcv[1], pcv[2]];
        if (!sameList(cur.premulColor, tgt.premulColor)) changed.push("premul_color");
      }
      if (alpha.invert !== undefined && alpha.invert !== null) {
        if (typeof alpha.invert !== "boolean") fail("bad_args", "alpha invert must be true or false");
        if (finalMode === AlphaMode.IGNORE) fail("bad_args", "invert has no effect while alpha is ignored; pick straight or premultiplied");
        tgt.invertAlpha = alpha.invert;
        if (alpha.invert !== cur.invertAlpha) changed.push("invert_alpha");
      }
    }

    // ----- fields, pulldown, conform, loop -----
    var wantsVideoOnly =
      args.field_separation !== undefined ||
      args.high_quality_field_separation !== undefined ||
      args.pulldown !== undefined ||
      args.conform_frame_rate !== undefined ||
      args.loop !== undefined;
    if (wantsVideoOnly && isStill) {
      fail("bad_args", "\"" + it.name + "\" is a still: field separation, pulldown, conform rate and loop don't apply to it");
    }
    var guessing = false;
    if (args.pulldown === "guess_3_2" || args.pulldown === "guess_24p_advance") {
      guessing = true;
      if (args.field_separation !== undefined || args.high_quality_field_separation !== undefined || args.conform_frame_rate !== undefined) {
        fail("bad_args", "pulldown 'guess' sets the fields and the frame rate itself; run it alone, then adjust in a second call");
      }
      tgt.guessMethod = methodValue(args.pulldown);
      changed.push("field_separation", "remove_pulldown", "conform_frame_rate");
    }
    var finalField = cur.fieldSep;
    var finalPull = cur.pulldown;
    if (args.field_separation !== undefined && args.field_separation !== null) {
      tgt.fieldSep = fieldValue(args.field_separation);
      finalField = tgt.fieldSep;
      if (tgt.fieldSep !== cur.fieldSep) changed.push("field_separation");
    }
    if (!guessing && args.pulldown !== undefined && args.pulldown !== null) {
      tgt.pulldown = pulldownValue(args.pulldown);
      finalPull = tgt.pulldown;
      if (tgt.pulldown !== cur.pulldown) changed.push("remove_pulldown");
    }
    if (!guessing) {
      if (finalField === FieldSeparationType.OFF && cur.pulldown !== PulldownPhase.OFF && args.pulldown === undefined) {
        fail("bad_args", "Field separation can't go off while a pulldown is removed; set pulldown 'off' in the same call");
      }
      if (finalPull !== undefined && finalPull !== PulldownPhase.OFF && finalField === FieldSeparationType.OFF) {
        fail("bad_args", "A pulldown can only be removed from footage with field separation on; set field_separation to upper_field_first or lower_field_first");
      }
    }
    if (args.high_quality_field_separation !== undefined && args.high_quality_field_separation !== null) {
      if (typeof args.high_quality_field_separation !== "boolean") fail("bad_args", "high_quality_field_separation must be true or false");
      if (finalField === undefined || finalField === FieldSeparationType.OFF) {
        fail("bad_args", "High quality field separation needs field separation on");
      }
      tgt.hq = args.high_quality_field_separation;
      if (tgt.hq !== cur.hq) changed.push("high_quality_field_separation");
    }
    if (args.conform_frame_rate !== undefined && args.conform_frame_rate !== null) {
      var cf = args.conform_frame_rate;
      if (!isNum(cf) || cf < 0 || cf > 99) fail("bad_args", "conform_frame_rate must be a number in 0..99 (0 = the footage's own rate)");
      if (cf === 0 && finalPull !== undefined && finalPull !== PulldownPhase.OFF) {
        fail("bad_args", "The conform rate can't be 0 while a pulldown is removed; turn the pulldown off in the same call");
      }
      tgt.conform = cf;
      if (cf !== cur.conform) changed.push("conform_frame_rate");
    }
    if (args.loop !== undefined && args.loop !== null) {
      if (!isNum(args.loop) || Math.floor(args.loop) !== args.loop || args.loop < 1 || args.loop > 9999) fail("bad_args", "loop must be a whole number in 1..9999");
      tgt.loop = args.loop;
      if (tgt.loop !== cur.loop) changed.push("loop");
    }
    if (args.pixel_aspect !== undefined && args.pixel_aspect !== null) {
      if (!isNum(args.pixel_aspect) || args.pixel_aspect < 0.01 || args.pixel_aspect > 100) fail("bad_args", "pixel_aspect must be a number in 0.01..100");
      tgt.pixelAspect = args.pixel_aspect;
      if (tgt.pixelAspect !== cur.pixelAspect) changed.push("pixel_aspect");
    }
    var asked = alpha || wantsVideoOnly || args.pixel_aspect !== undefined;
    if (!asked) fail("bad_args", "Nothing to set");

    var out = { item_id: it.id, name: it.name, changed: changed, no_change: changed.length === 0 };
    // Everything asked for is already so: don't open an undo group for it.
    if (changed.length === 0) return out;

    return A.withUndo(args.label || "Interpret footage", function () {
      try {
        applyTarget(it, src, cur, tgt, false);
      } catch (e) {
        // Put back what was there, in this same undo group, so a failed call
        // leaves the footage as it was found.
        var now = rawState(it, src);
        applyTarget(it, src, now, cur, true);
        // Read it again and only claim success when every field matches.
        var left = stateDiff(cur, rawState(it, src));
        if (left.names.length === 0) {
          e.message = e.message + " (the footage's old interpretation was put back)";
        } else {
          e.message = e.message + " (the old interpretation could NOT be fully put back; still different: " + left.names.join(", ") + ". Inspect with ae_get_footage_interpretation before retrying)";
          e.__expected = left.expected;
          e.__actual = left.actual;
        }
        throw e;
      }
      return out;
    });
  };

  // ---------- interpretProxy ----------

  A.interpretProxy = function (args) {
    assertGuard(args.expect);
    var action = args.action;
    var known = { set_file: 1, set_sequence: 1, set_solid: 1, clear: 1, use_on: 1, use_off: 1 };
    if (typeof action !== "string" || known[action] !== 1) fail("bad_args", "Unknown proxy action \"" + action + "\"");
    var ids = args.item_ids;
    if (!ids || typeof ids.length !== "number" || ids.length < 1) fail("bad_args", "Give at least one item id");
    if (ids.length > 100) fail("bad_args", "At most 100 items per call");
    var isSet = action === "set_file" || action === "set_sequence" || action === "set_solid";
    if (isSet && ids.length !== 1) fail("bad_args", "A proxy is set on one item at a time");

    var items = [];
    var seen = {};
    var i;
    for (i = 0; i < ids.length; i++) {
      var it = itemById(ids[i]);
      if (!it || !(isFootageItem(it) || isCompItem(it))) fail("not_found", "No footage or comp item with id " + ids[i]);
      if (seen[it.id]) continue;
      seen[it.id] = true;
      items.push(it);
    }

    var proxyFile = null;
    var solid = null;
    if (action === "set_file" || action === "set_sequence") {
      if (typeof args.file !== "string" || args.file.length < 1) fail("bad_args", "file is required to set a proxy");
      proxyFile = new File(args.file);
      if (!proxyFile.exists) fail("not_found", "Proxy file does not exist: " + args.file);
    }
    if (action === "set_solid") {
      solid = args.solid;
      if (!solid) fail("bad_args", "solid is required for set_solid");
      if (!solid.color || typeof solid.color.length !== "number" || solid.color.length !== 3) fail("bad_args", "solid.color must be [r, g, b]");
      for (var ci = 0; ci < 3; ci++) {
        if (!isNum(solid.color[ci]) || solid.color[ci] < 0 || solid.color[ci] > 1) fail("bad_args", "solid.color values must be numbers in 0..1");
      }
      if (!isNum(solid.width) || !isNum(solid.height) || solid.width < 1 || solid.height < 1 || solid.width > 30000 || solid.height > 30000) {
        fail("bad_args", "solid width and height must be numbers in 1..30000");
      }
      if (solid.pixel_aspect !== undefined && solid.pixel_aspect !== null && (!isNum(solid.pixel_aspect) || solid.pixel_aspect < 0.01 || solid.pixel_aspect > 100)) {
        fail("bad_args", "solid.pixel_aspect must be a number in 0.01..100");
      }
      if (solid.name !== undefined && solid.name !== null && (typeof solid.name !== "string" || solid.name.length > 200)) fail("bad_args", "solid.name must be a string of at most 200 characters");
    }
    if (args.use_proxy !== undefined && args.use_proxy !== null) {
      if (typeof args.use_proxy !== "boolean") fail("bad_args", "use_proxy must be true or false");
      if (!isSet) fail("bad_args", "use_proxy goes with set_file, set_sequence or set_solid; use the use_on / use_off actions otherwise");
    }
    for (i = 0; i < items.length; i++) {
      var hasProxy = proxyOf(items[i]) !== null;
      if (action === "use_on" && !hasProxy) fail("bad_args", "\"" + items[i].name + "\" has no proxy to switch on");
      if (isSet && isFootageItem(items[i])) {
        var gone = false;
        try { gone = items[i].footageMissing === true; } catch (eG) {}
        if (gone) fail("bad_args", "\"" + items[i].name + "\" is missing its file; relink it before giving it a proxy");
      }
    }

    // Skip items already in the wanted state so no empty change lands on the undo stack.
    var todo = [];
    var skipped = [];
    for (i = 0; i < items.length; i++) {
      var cur = items[i];
      var curUse = false;
      try { curUse = cur.useProxy === true; } catch (eU) {}
      var has = proxyOf(cur) !== null;
      if (action === "use_on" && curUse) skipped.push(cur.id);
      else if (action === "use_off" && !curUse) skipped.push(cur.id);
      else if (action === "clear" && !has) skipped.push(cur.id);
      else todo.push({ item: cur, was_use: curUse });
    }
    var out = { action: action, item_ids: [], skipped_ids: skipped, no_change: todo.length === 0 };
    if (todo.length === 0) return out;

    return A.withUndo(args.label || "Footage proxy", function () {
      var done = [];
      try {
        for (var k = 0; k < todo.length; k++) {
          var t = todo[k].item;
          if (action === "use_on") t.useProxy = true;
          else if (action === "use_off") t.useProxy = false;
          else if (action === "clear") t.setProxyToNone();
          else if (action === "set_file") t.setProxy(proxyFile);
          else if (action === "set_sequence") t.setProxyWithSequence(proxyFile, args.force_alphabetical === true);
          else if (action === "set_solid") {
            var pa = 1;
            if (solid.pixel_aspect !== undefined && solid.pixel_aspect !== null) pa = solid.pixel_aspect;
            var sname = "Proxy";
            if (solid.name) sname = solid.name;
            t.setProxyWithSolid([solid.color[0], solid.color[1], solid.color[2]], sname, solid.width, solid.height, pa);
          }
          done.push(todo[k]);
          if (isSet && args.use_proxy !== undefined && args.use_proxy !== null) t.useProxy = args.use_proxy;
          out.item_ids.push(t.id);
        }
      } catch (e) {
        // Switch the items already done back (a set or clear can't be undone from here).
        var changed = [];
        for (var r = 0; r < done.length; r++) {
          if (action === "use_on" || action === "use_off") {
            try { done[r].item.useProxy = done[r].was_use; } catch (eR) {}
          } else {
            try { changed.push(done[r].item.id); } catch (eC) {}
          }
        }
        if (changed.length > 0) {
          try { e.message = String(e.message) + " (already changed and left as is: ids " + changed.join(", ") + "; Ctrl+Z undoes them)"; } catch (eM) {}
          try { e.__actual = { changed_ids: changed }; } catch (eA) {}
        }
        throw e;
      }
      return out;
    });
  };
})($.global);
