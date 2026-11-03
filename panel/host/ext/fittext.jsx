// panel/host/ext/fittext.jsx
//
// Host functions for the text-fitting tools:
// - fittextMeasure (read): bounds, size, box state and font state of text
//   layers, measured with sourceRectAtTime at a given time
// - fittextApply (guarded write): scales the font size of chosen layers by a
//   factor, run by run, so per-range sizes keep their proportions; scales a
//   fixed leading with it
// - fittextLive (guarded write): a Scale expression that shrinks a text layer
//   to fit a region as its text changes, or removes it
// - fittextBackdrop (guarded write): a rectangle shape layer below a text
//   layer whose size and position follow the text by expression
// - fittextBackdropRead (read): the text's bounds and the backdrop's state
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first, validate everything that can
//   fail before A.withUndo, and wrap changes in A.withUndo.
// - Before and after reads run in separate evalScript calls from the server.
// - Reads never touch time, selection or anything on the undo stack.
// - TextDocument.characterRange (AE 24.3+) is probed at run time. Whether its
//   end index is exclusive is checked against CharacterRange.text, so the code
//   works either way.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var MAX_SCAN_CHARS = 2000;
  // Characters whose size is read one by one in a single measure call, over all layers.
  var MAX_SCAN_TOTAL = 4000;
  var MIN_SIZE = 0.1;
  var MAX_SIZE = 1296;
  var MAX_LEADING = 5000;
  var LIVE_MARKER = "// chroma-fit-text live";

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

  function requireComp(id) {
    var item = null;
    try {
      item = app.project.itemByID(id);
    } catch (e) {
      item = null;
    }
    if (!item || !(item instanceof CompItem)) fail("not_found", "No CompItem with id " + id);
    return item;
  }

  // By id, index, or a name only one layer has.
  function findLayer(comp, sel) {
    var i;
    if (!sel) fail("bad_args", "layer selector missing");
    if (sel.id !== undefined && sel.id !== null) {
      for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).id === sel.id) return comp.layer(i);
      }
      fail("not_found", "No layer with id " + sel.id + " in comp " + comp.id);
    }
    if (sel.index !== undefined && sel.index !== null) {
      if (sel.index < 1 || sel.index > comp.numLayers) fail("not_found", "Layer index " + sel.index + " out of range");
      return comp.layer(sel.index);
    }
    if (sel.name !== undefined && sel.name !== null) {
      var count = 0;
      var found = null;
      for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === sel.name) {
          count++;
          if (!found) found = comp.layer(i);
        }
      }
      if (count === 0) fail("not_found", "No layer named \"" + sel.name + "\"");
      if (count > 1) fail("bad_args", count + " layers are named \"" + sel.name + "\"; select by id or index");
      return found;
    }
    fail("bad_args", "layer selector needs id, index or name");
    return null;
  }

  function isTextLayer(l) {
    try {
      return !!(l.reflect && l.reflect.name === "TextLayer");
    } catch (e) {
      return false;
    }
  }

  function sourceTextProp(layer) {
    var p = null;
    try {
      var tg = layer.property("ADBE Text Properties");
      if (tg) p = tg.property("ADBE Text Document");
    } catch (e) {
      p = null;
    }
    return p;
  }

  function requireTextProp(layer) {
    if (!isTextLayer(layer)) fail("bad_args", "Layer \"" + layer.name + "\" is not a text layer");
    var p = sourceTextProp(layer);
    if (!p) fail("bad_args", "Layer \"" + layer.name + "\" has no Source Text property");
    return p;
  }

  function documentAt(prop, time) {
    if (prop.numKeys > 0) return prop.valueAtTime(time, false);
    return prop.value;
  }

  // ---------- character ranges (AE 24.3+) ----------

  function hasRanges(doc) {
    try {
      return typeof doc.characterRange === "function";
    } catch (e) {
      return false;
    }
  }

  function norm(s) {
    return String(s).replace(/\r\n?|\n/g, "\n");
  }

  // The doc says characterRange(start, signedEnd) without saying whether the
  // end is in the range. Ask for the first character and see what text comes
  // back: one character means the end is exclusive.
  function rangeEndMode(doc) {
    var text = String(doc.text);
    if (text.length === 0) return "exclusive";
    try {
      var t = doc.characterRange(0, 1).text;
      if (t === undefined || t === null) return "exclusive";
      t = norm(t);
      var want = norm(text.substring(0, 1));
      if (t === want) return "exclusive";
      if (text.length > 1 && t === norm(text.substring(0, 2))) return "inclusive";
    } catch (e) {}
    return "exclusive";
  }

  function rangeAt(doc, mode, start, end) {
    if (mode === "inclusive") return doc.characterRange(start, end - 1);
    return doc.characterRange(start, end);
  }

  // The text without one trailing line break: a range can't span the final one.
  function rangeLength(text) {
    var n = text.length;
    if (n > 0) {
      var c = text.charAt(n - 1);
      if (c === "\r" || c === "\n") n--;
    }
    return n;
  }

  // Runs of equal font size, one character at a time. null when the text is
  // empty, too long to scan, or the build has no ranges. Mixed reads
  // (undefined) can't happen for one character; if one does, the run is
  // skipped rather than guessed.
  function sizeRuns(doc, mode) {
    var text = String(doc.text);
    var n = rangeLength(text);
    if (n === 0 || n > MAX_SCAN_CHARS || !hasRanges(doc)) return null;
    var runs = [];
    for (var i = 0; i < n; i++) {
      var s;
      try {
        s = rangeAt(doc, mode, i, i + 1).fontSize;
      } catch (e) {
        return null;
      }
      if (typeof s !== "number" || !isFinite(s)) return null;
      var last = runs.length ? runs[runs.length - 1] : null;
      if (last && Math.abs(last.size - s) < 0.000001) {
        last.end = i + 1;
      } else {
        runs.push({ start: i, end: i + 1, size: s });
      }
    }
    return runs;
  }

  function clampSize(v) {
    if (v < MIN_SIZE) return MIN_SIZE;
    if (v > MAX_SIZE) return MAX_SIZE;
    return Math.round(v * 100) / 100;
  }

  function justificationName(j) {
    try {
      if (j === ParagraphJustification.LEFT_JUSTIFY) return "left";
      if (j === ParagraphJustification.CENTER_JUSTIFY) return "center";
      if (j === ParagraphJustification.RIGHT_JUSTIFY) return "right";
    } catch (e) {}
    return String(j);
  }

  // ---------- measuring ----------

  function scaleExpressionProp(layer) {
    try {
      return layer.property("ADBE Transform Group").property("ADBE Scale");
    } catch (e) {
      return null;
    }
  }

  function liveState(layer) {
    var sp = scaleExpressionProp(layer);
    var st = { installed: false, error: null, foreign: false };
    if (!sp) return st;
    try {
      if (sp.expressionEnabled === true) {
        var exprText = String(sp.expression);
        if (exprText.indexOf(LIVE_MARKER) === 0) {
          st.installed = true;
        } else if (exprText !== "") {
          st.foreign = true;
        }
      }
    } catch (e1) {}
    try {
      if (st.installed && sp.expressionError) st.error = String(sp.expressionError);
    } catch (e2) {}
    return st;
  }

  // The size of one character, for the two-character probe used when the scan budget is spent.
  function charSize(doc, mode, at) {
    try {
      var s = rangeAt(doc, mode, at, at + 1).fontSize;
      if (typeof s === "number" && isFinite(s)) return s;
    } catch (e) {}
    return null;
  }

  // scan: { sizes: bool, budget: characters left for full scans in this call, capped: bool }
  function measureEntry(layer, time, scan) {
    var prop = requireTextProp(layer);
    var doc = documentAt(prop, time);
    var text = String(doc.text);
    var e = {
      id: layer.id,
      index: layer.index,
      name: layer.name,
      text_length: text.length,
      numKeys: prop.numKeys,
      expression: false,
      locked: false
    };
    try { e.locked = layer.locked === true; } catch (eLk) {}
    try { e.expression = prop.expressionEnabled === true; } catch (e0) {}
    try { e.fontSize = Number(doc.fontSize); } catch (e1) {}
    try { e.leading = Number(doc.leading); } catch (e2) {}
    // With auto leading on, a build may report the computed leading; writing it would switch to fixed.
    try { if (doc.autoLeading !== undefined) e.autoLeading = doc.autoLeading === true; } catch (eAl) {}
    try { e.tracking = Number(doc.tracking); } catch (e3) {}
    try { e.justification = justificationName(doc.justification); } catch (e4) {}
    try { e.boxText = doc.boxText === true; } catch (e5) {}
    if (e.boxText === true) {
      try {
        var bs = doc.boxTextSize;
        e.boxTextSize = [Number(bs[0]), Number(bs[1])];
      } catch (e6) {}
    }
    // AE 24.6+; undefined elsewhere.
    try {
      if (doc.boxOverflow !== undefined) e.boxOverflow = doc.boxOverflow === true;
    } catch (e7) {}
    try {
      if (doc.fontObject && doc.fontObject.isSubstitute !== undefined) e.fontSubstituted = doc.fontObject.isSubstitute === true;
    } catch (e8) {}
    if (scan.sizes && hasRanges(doc)) {
      var endMode = rangeEndMode(doc);
      var n = rangeLength(text);
      if (n > 0 && n <= MAX_SCAN_CHARS && n <= scan.budget) {
        scan.budget -= n;
        var runs = sizeRuns(doc, endMode);
        if (runs) {
          var lo = runs[0].size;
          var hi = runs[0].size;
          for (var r = 1; r < runs.length; r++) {
            if (runs[r].size < lo) lo = runs[r].size;
            if (runs[r].size > hi) hi = runs[r].size;
          }
          e.sizes_vary = runs.length > 1;
          e.min_run_size = lo;
          e.max_run_size = hi;
          e.sizes_scan = "full";
        }
      } else if (n > 0) {
        // Too long, or the budget for this call is spent: compare the first and last characters only.
        scan.capped = true;
        var s0 = charSize(doc, endMode, 0);
        var s1 = charSize(doc, endMode, n - 1);
        if (s0 !== null && s1 !== null) {
          e.sizes_vary = Math.abs(s0 - s1) > 0.000001;
          e.min_run_size = Math.min(s0, s1);
          e.max_run_size = Math.max(s0, s1);
          e.sizes_scan = "probe";
        }
      }
    }
    var rect = layer.sourceRectAtTime(time, false);
    e.bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    e.live_fit = liveState(layer);
    return e;
  }

  A.fittextMeasure = function (args) {
    var comp = requireComp(args.comp_id);
    var time = comp.time;
    if (typeof args.time === "number" && isFinite(args.time)) time = args.time;
    var layers = [];
    var skipped = [];
    var truncated = false;
    var i;
    if (args.layers && args.layers.length) {
      var seen = {};
      for (i = 0; i < args.layers.length && layers.length < MAX_LAYERS; i++) {
        var l = findLayer(comp, args.layers[i]);
        if (seen[l.id]) continue;
        seen[l.id] = true;
        if (!isTextLayer(l)) {
          skipped.push({ id: l.id, name: l.name, reason: "not a text layer" });
          continue;
        }
        layers.push(l);
      }
    } else {
      for (i = 1; i <= comp.numLayers; i++) {
        var cand = comp.layer(i);
        if (!isTextLayer(cand)) continue;
        if (layers.length >= MAX_LAYERS) {
          truncated = true;
          break;
        }
        layers.push(cand);
      }
    }
    var out = [];
    var rangesSupported = false;
    // sizes: false skips the per-character size scan (a fit does not need it).
    // Otherwise the scan is capped per call: later layers get a two-character probe.
    var scan = { sizes: args.sizes !== false, budget: MAX_SCAN_TOTAL, capped: false };
    for (i = 0; i < layers.length; i++) {
      var entry = measureEntry(layers[i], time, scan);
      out.push(entry);
    }
    if (layers.length) {
      try { rangesSupported = hasRanges(documentAt(requireTextProp(layers[0]), time)); } catch (eR) {}
    }
    return {
      comp_id: comp.id,
      comp: { width: comp.width, height: comp.height },
      time: time,
      ranges_supported: rangesSupported,
      layers: out,
      truncated: truncated,
      sizes_scan_capped: scan.capped,
      skipped: skipped
    };
  };

  // ---------- fitting ----------

  A.fittextApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var items = args.items;
    if (!items || typeof items.length !== "number" || items.length < 1 || items.length > MAX_LAYERS) {
      fail("bad_args", "items must list 1 to " + MAX_LAYERS + " layers");
    }
    var scaleLeading = args.scale_leading !== false;
    var plan = [];
    var seen = {};
    var i;
    // Everything that can fail is checked here, before anything is written.
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      var layer = findLayer(comp, it.layer);
      if (seen[layer.id]) fail("bad_args", "Layer \"" + layer.name + "\" is listed twice");
      seen[layer.id] = true;
      if (typeof it.factor !== "number" || !isFinite(it.factor) || !(it.factor > 0)) fail("bad_args", "factor must be a number above 0");
      if (layer.locked === true) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first");
      var prop = requireTextProp(layer);
      if (prop.numKeys > 0) fail("bad_args", "Source Text of \"" + layer.name + "\" is keyed; fitting it would have to repeat per keyframe");
      var exprOn = false;
      try { exprOn = prop.expressionEnabled === true; } catch (eX) {}
      if (exprOn) fail("bad_args", "Source Text of \"" + layer.name + "\" has an expression that would override the size");
      var doc = prop.value;
      var current = Number(doc.fontSize);
      if (typeof it.expect_size === "number" && Math.abs(current - it.expect_size) > Math.max(0.01, it.expect_size * 0.001)) {
        fail("guard", "The font size of \"" + layer.name + "\" changed since it was measured (" + it.expect_size + " then, " + current + " now). Measure again.", {
          expected: it.expect_size,
          actual: current
        });
      }
      var mode = "uniform";
      var runs = null;
      var endMode = "exclusive";
      if (hasRanges(doc)) {
        endMode = rangeEndMode(doc);
        runs = sizeRuns(doc, endMode);
        if (runs && runs.length > 1) mode = "runs";
      }
      var lead = 0;
      try { lead = Number(doc.leading); } catch (eL) {}
      var newLead = null;
      // Auto leading follows the size by itself; writing a leading would switch it to fixed.
      var autoLead = false;
      try { autoLead = doc.autoLeading === true; } catch (eAu) {}
      if (scaleLeading && lead > 0 && !autoLead) {
        newLead = lead * it.factor;
        if (newLead > MAX_LEADING) newLead = MAX_LEADING;
        newLead = Math.round(newLead * 100) / 100;
      }
      var steps = [];
      if (mode === "runs") {
        for (var r = 0; r < runs.length; r++) {
          steps.push({ start: runs[r].start, end: runs[r].end, size: clampSize(runs[r].size * it.factor) });
        }
      }
      plan.push({
        layer: layer,
        prop: prop,
        mode: mode,
        endMode: endMode,
        from: current,
        to: clampSize(current * it.factor),
        steps: steps,
        leadFrom: lead,
        leadTo: newLead,
        autoLead: autoLead
      });
    }

    return A.withUndo(args.label || "Fit text", function () {
      var done = [];
      for (var k = 0; k < plan.length; k++) {
        var p = plan[k];
        var d = p.prop.value;
        var just = null;
        try { just = d.justification; } catch (eJ) {}
        if (p.mode === "runs") {
          for (var s = 0; s < p.steps.length; s++) {
            rangeAt(d, p.endMode, p.steps[s].start, p.steps[s].end).fontSize = p.steps[s].size;
          }
        } else {
          d.fontSize = p.to;
        }
        if (p.leadTo !== null) d.leading = p.leadTo;
        p.prop.setValue(d);
        // The TextDocument round trip can drop justification: look once and put it back.
        var reasserted = false;
        try {
          var back = p.prop.value;
          if (just !== null && back.justification !== just) {
            back.justification = just;
            p.prop.setValue(back);
            reasserted = true;
          }
        } catch (eB) {}
        done.push({
          id: p.layer.id,
          index: p.layer.index,
          name: p.layer.name,
          mode: p.mode,
          from_size: p.from,
          to_size: p.to,
          leading_from: p.leadFrom,
          leading_to: p.leadTo,
          auto_leading: p.autoLead,
          runs: p.steps.length,
          justification_reasserted: reasserted
        });
      }
      return { comp_id: comp.id, layers: done };
    });
  };

  // ---------- live fit ----------

  function liveExpression(maxW, maxH) {
    var lines = [LIVE_MARKER, "var r = thisLayer.sourceRectAtTime(time, false);", "var s = 1;"];
    if (typeof maxW === "number") lines.push("if (r.width > 0) s = Math.min(s, " + maxW + " / r.width);");
    if (typeof maxH === "number") lines.push("if (r.height > 0) s = Math.min(s, " + maxH + " / r.height);");
    lines.push("value * s;");
    return lines.join("\n");
  }

  A.fittextLive = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var sels = args.layers;
    if (!sels || typeof sels.length !== "number" || sels.length < 1 || sels.length > MAX_LAYERS) fail("bad_args", "layers must list 1 to " + MAX_LAYERS + " layers");
    var remove = args.remove === true;
    var maxW = args.max_width;
    var maxH = args.max_height;
    if (!remove) {
      var hasW = typeof maxW === "number" && isFinite(maxW) && maxW > 0;
      var hasH = typeof maxH === "number" && isFinite(maxH) && maxH > 0;
      if (!hasW && !hasH) fail("bad_args", "max_width and/or max_height must be numbers above 0");
      if (!hasW) maxW = null;
      if (!hasH) maxH = null;
    }
    var targets = [];
    var seen = {};
    for (var i = 0; i < sels.length; i++) {
      var layer = findLayer(comp, sels[i]);
      if (seen[layer.id]) continue;
      seen[layer.id] = true;
      requireTextProp(layer);
      var sp = scaleExpressionProp(layer);
      if (!sp) fail("bad_args", "Layer \"" + layer.name + "\" has no Scale property");
      var ours = liveState(layer).installed;
      // A locked layer can't change: removing only counts where there is an expression of ours to remove.
      if (layer.locked === true && (!remove || ours)) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first");
      var existing = "";
      try { existing = sp.expressionEnabled === true ? String(sp.expression) : ""; } catch (eE) {}
      if (!remove) {
        if (!sp.canSetExpression) fail("bad_args", "The Scale of \"" + layer.name + "\" can't take an expression");
        if (existing !== "" && !ours) fail("bad_args", "The Scale of \"" + layer.name + "\" already has an expression that is not this tool's; remove it first");
      }
      targets.push({ layer: layer, prop: sp, ours: ours });
    }
    var text = "";
    if (!remove) text = liveExpression(maxW === null ? undefined : maxW, maxH === null ? undefined : maxH);

    return A.withUndo(args.label || (remove ? "Remove live fit" : "Live fit text"), function () {
      var done = [];
      for (var k = 0; k < targets.length; k++) {
        var t = targets[k];
        if (remove) {
          if (t.ours) {
            t.prop.expression = "";
            done.push({ id: t.layer.id, name: t.layer.name, removed: true });
          } else {
            done.push({ id: t.layer.id, name: t.layer.name, removed: false });
          }
        } else {
          t.prop.expression = text;
          done.push({ id: t.layer.id, name: t.layer.name, expression: true });
        }
      }
      return { comp_id: comp.id, layers: done };
    });
  };

  // ---------- backdrop ----------

  function exprString(s) {
    return "\"" + String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\r\n]+/g, " ") + "\"";
  }

  function backdropLayer(comp, textLayer, id) {
    if (id === undefined || id === null) return null;
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).id === id) return comp.layer(i);
    }
    return null;
  }

  A.fittextBackdrop = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var text = findLayer(comp, args.layer);
    requireTextProp(text);
    var pad = args.padding;
    if (!pad || typeof pad.length !== "number" || pad.length !== 2 || typeof pad[0] !== "number" || typeof pad[1] !== "number" || !(pad[0] >= 0) || !(pad[1] >= 0)) {
      fail("bad_args", "padding must be [x, y] of numbers 0 or more");
    }
    var color = args.color;
    if (!color || color.length !== 3) fail("bad_args", "color must be [r, g, b]");
    for (var ci = 0; ci < 3; ci++) {
      if (typeof color[ci] !== "number" || !isFinite(color[ci]) || color[ci] < 0 || color[ci] > 1) fail("bad_args", "color values must be numbers in 0..1");
    }
    var opacity = args.opacity;
    if (typeof opacity !== "number" || !(opacity >= 0 && opacity <= 100)) fail("bad_args", "opacity must be a number in 0..100");
    var radius = args.corner_radius;
    if (typeof radius !== "number" || !(radius >= 0)) fail("bad_args", "corner_radius must be a number 0 or more");
    var name = args.name;
    if (name === undefined || name === null) name = text.name + " Box";
    if (typeof name !== "string" || name.length < 1 || name.length > 200) fail("bad_args", "name must be 1 to 200 characters");

    var ref = "var L = thisComp.layer(" + exprString(text.name) + ");\nvar r = L.sourceRectAtTime(time, false);\n";
    // Both come from the four corners of the text's bounds in comp space, so
    // Scale, rotation and a parent are all in the box.
    var corners =
      ref +
      "var c = [L.toComp([r.left, r.top]), L.toComp([r.left + r.width, r.top]), L.toComp([r.left + r.width, r.top + r.height]), L.toComp([r.left, r.top + r.height])];\n" +
      "var x0 = c[0][0], x1 = c[0][0], y0 = c[0][1], y1 = c[0][1];\n" +
      "for (var i = 1; i < 4; i++) { x0 = Math.min(x0, c[i][0]); x1 = Math.max(x1, c[i][0]); y0 = Math.min(y0, c[i][1]); y1 = Math.max(y1, c[i][1]); }\n";
    var sizeExpr = corners + "[x1 - x0 + " + (2 * pad[0]) + ", y1 - y0 + " + (2 * pad[1]) + "];";
    var posExpr = corners + "[(x0 + x1) / 2, (y0 + y1) / 2];";

    return A.withUndo(args.label || "Text backdrop", function () {
      var shape = comp.layers.addShape();
      // The layer exists from here: a failed step takes it back out in this same undo group.
      try {
        shape.name = name;
        shape.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0]);
        var contents = shape.property("ADBE Root Vectors Group");
        var group = contents.addProperty("ADBE Vector Group");
        var inner = group.property("ADBE Vectors Group");
        var rect = inner.addProperty("ADBE Vector Shape - Rect");
        var fill = inner.addProperty("ADBE Vector Graphic - Fill");
        rect.property("ADBE Vector Rect Size").expression = sizeExpr;
        rect.property("ADBE Vector Rect Position").expression = posExpr;
        rect.property("ADBE Vector Rect Roundness").setValue(radius);
        fill.property("ADBE Vector Fill Color").setValue([color[0], color[1], color[2], 1]);
        fill.property("ADBE Vector Fill Opacity").setValue(opacity);
        shape.moveAfter(text);
      } catch (ePost) {
        try { shape.remove(); } catch (eRm) {}
        throw ePost;
      }
      return {
        comp_id: comp.id,
        text: { id: text.id, name: text.name },
        backdrop: { id: shape.id, index: shape.index, name: shape.name }
      };
    });
  };

  A.fittextBackdropRead = function (args) {
    var comp = requireComp(args.comp_id);
    var text = findLayer(comp, args.layer);
    requireTextProp(text);
    var time = comp.time;
    var rect = text.sourceRectAtTime(time, false);
    var out = {
      text: {
        id: text.id,
        index: text.index,
        name: text.name,
        bounds: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
    };
    // What turns the layer's own bounds into comp-space ones. Scale is read as
    // evaluated (a Scale expression included); a parent, rotation or 3D layer
    // makes the expected box a bounding-box question the server does not compute.
    var tf = null;
    try { tf = text.property("ADBE Transform Group"); } catch (eTf) {}
    if (tf) {
      try {
        var scv = tf.property("ADBE Scale").value;
        out.text.scale = [Number(scv[0]), Number(scv[1])];
      } catch (eSc) {}
      try { out.text.rotation = Number(tf.property("ADBE Rotate Z").value); } catch (eRo) {}
    }
    try { out.text.parented = !!text.parent; } catch (ePa) {}
    try { out.text.three_d = text.threeDLayer === true; } catch (e3d) {}
    var b = backdropLayer(comp, text, args.backdrop_id);
    if (b) {
      var info = { id: b.id, index: b.index, name: b.name, kind: "shape", expression_error: null };
      try { info.kind = b.reflect.name === "ShapeLayer" ? "shape" : String(b.reflect.name); } catch (e1) {}
      try {
        var sizeProp = b.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group").property("ADBE Vector Shape - Rect").property("ADBE Vector Rect Size");
        var sv = sizeProp.value;
        info.size = [Number(sv[0]), Number(sv[1])];
        if (sizeProp.expressionError) info.expression_error = String(sizeProp.expressionError);
      } catch (e2) {}
      out.backdrop = info;
    }
    return out;
  };
})($.global);
