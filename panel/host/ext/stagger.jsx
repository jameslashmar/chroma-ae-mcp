// panel/host/ext/stagger.jsx
//
// Host functions for the stagger tools:
// - staggerRead (read): layers' timing, and optionally one property's keys
//   (times, or every field of every key) on each layer and on a source layer
// - staggerApply (guarded write): moves layers in time (startTime), or shifts
//   or copies a property's keys by rebuilding them, one offset per layer
// - staggerLayoutRead (read): layers' Position, and whether it can be set
// - staggerLayoutApply (guarded write): sets Position on layers
//
// AE has no call that moves a key, so a shift reads everything about each key
// (value, interpolation, ease, spatial tangents, continuity, auto-bezier,
// roving, label, selection), removes all of the property's keys and adds them
// again. The server compares the fields in a separate evalScript afterwards.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first, validate everything that can
//   fail before A.withUndo, and change things inside it.
// - Before and after reads run in separate evalScript calls from the server.
// - Reads change nothing in AE (no selection, time or active item).

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_STRING = 20000;
  var MAX_KEYS_TOTAL = 1000;
  var MAX_WARNINGS = 20;
  var TIME_LIMIT = 10800;

  // A rollback that could not finish leaves AE changed; say so in the error instead of reading like a clean refusal.
  function appendRestoreFailures(err, failures) {
    if (!failures.length) return;
    try {
      err.message = err.message + " (the rollback was incomplete, so After Effects was left changed: " + failures.join("; ") + "; inspect before retrying)";
    } catch (eMsg) {}
  }

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

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  function boundString(s) {
    var str = String(s);
    if (str.length > MAX_STRING) return str.substring(0, MAX_STRING) + " ...[truncated]";
    return str;
  }

  // The layers asked for (in the order given, once each), or the selected
  // layers by stack index. Reading selectedLayers changes nothing.
  function targetLayers(comp, args) {
    var out = [];
    var seen = {};
    var i;
    if (args.layers && args.layers.length) {
      for (i = 0; i < args.layers.length; i++) {
        var l = findLayer(comp, args.layers[i]);
        if (seen[l.id]) continue;
        seen[l.id] = true;
        out.push(l);
      }
      return out;
    }
    var sel = [];
    try {
      sel = comp.selectedLayers;
    } catch (e) {
      sel = [];
    }
    for (i = 0; i < sel.length; i++) {
      if (seen[sel[i].id]) continue;
      seen[sel[i].id] = true;
      out.push(sel[i]);
    }
    out.sort(function (a, b) { return a.index - b.index; });
    if (out.length === 0) fail("bad_args", "No layers given and none selected in the comp");
    return out;
  }

  function lookupProperty(layer, path) {
    var p = layer;
    for (var i = 0; i < path.length; i++) {
      var next = null;
      try {
        next = p.property(path[i]);
      } catch (e) {
        next = null;
      }
      if (!next) return null;
      p = next;
    }
    return p;
  }

  function checkPath(path) {
    if (!path || !isArray(path) || path.length < 1) fail("bad_args", "property_path must be a non-empty array of names or match names");
    for (var i = 0; i < path.length; i++) {
      if (typeof path[i] !== "string" || path[i].length < 1) fail("bad_args", "property_path entries must be non-empty strings");
    }
  }

  // ---------- value and key state ----------

  function interpName(v) {
    try {
      if (v === KeyframeInterpolationType.LINEAR) return "linear";
      if (v === KeyframeInterpolationType.HOLD) return "hold";
      if (v === KeyframeInterpolationType.BEZIER) return "bezier";
    } catch (e) {}
    return String(v);
  }

  // A key's value as plain data, for the read-back comparison.
  function plainValue(v, depth) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === "number" || t === "boolean") return v;
    if (t === "string") return boundString(v);
    if (depth === undefined) depth = 0;
    if (isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length && i < MAX_LIST; i++) a.push(plainValue(v[i], depth + 1));
      return a;
    }
    try {
      if (v instanceof TextDocument) return { text: boundString(v.text) };
    } catch (e1) {}
    try {
      if (v instanceof Shape) {
        return {
          closed: v.closed,
          vertices: plainValue(v.vertices, depth + 1),
          inTangents: plainValue(v.inTangents, depth + 1),
          outTangents: plainValue(v.outTangents, depth + 1)
        };
      }
    } catch (e2) {}
    try {
      if (v instanceof MarkerValue) return { comment: boundString(v.comment), duration: v.duration };
    } catch (e3) {}
    try {
      return "[" + v.reflect.name + "]";
    } catch (e4) {}
    return boundString(v);
  }

  function copyEase(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length && i < 4; i++) out.push({ speed: list[i].speed, influence: list[i].influence });
    return out;
  }

  function copyNumbers(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length && i < 4; i++) out.push(list[i]);
    return out;
  }

  // Everything about the property's keys, raw, in key order. A getter that
  // throws (a marker property has no ease, a flat property no tangents) just
  // leaves its field out. Values stay AE objects so they can be written back.
  function snapshotKeys(p, cap) {
    var keys = [];
    var n = p.numKeys;
    var spatial = false;
    try {
      spatial = p.isSpatial === true;
    } catch (eSp) {}
    for (var k = 1; k <= n && keys.length < cap; k++) {
      var s = { time: p.keyTime(k), value: null };
      try { s.value = p.keyValue(k); } catch (e1) {}
      try { s.inInterp = p.keyInInterpolationType(k); } catch (e2) {}
      try { s.outInterp = p.keyOutInterpolationType(k); } catch (e3) {}
      try { s.inEase = copyEase(p.keyInTemporalEase(k)); } catch (e4) {}
      try { s.outEase = copyEase(p.keyOutTemporalEase(k)); } catch (e5) {}
      try { s.tCont = p.keyTemporalContinuous(k) === true; } catch (e6) {}
      try { s.tAuto = p.keyTemporalAutoBezier(k) === true; } catch (e7) {}
      if (spatial) {
        try { s.inTan = copyNumbers(p.keyInSpatialTangent(k)); } catch (e8) {}
        try { s.outTan = copyNumbers(p.keyOutSpatialTangent(k)); } catch (e9) {}
        try { s.sCont = p.keySpatialContinuous(k) === true; } catch (e10) {}
        try { s.sAuto = p.keySpatialAutoBezier(k) === true; } catch (e11) {}
        try { s.roving = p.keyRoving(k) === true; } catch (e12) {}
      }
      // keyLabel / keySelected: AE 22.6+.
      try { s.label = p.keyLabel(k); } catch (e13) {}
      try { s.selected = p.keySelected(k) === true; } catch (e14) {}
      keys.push(s);
    }
    return keys;
  }

  // The snapshot as plain data (what the server compares).
  function describeKeys(snap) {
    var out = [];
    for (var i = 0; i < snap.length; i++) {
      var s = snap[i];
      var d = { time: s.time, value: plainValue(s.value) };
      if (s.inInterp !== undefined) d.inInterp = interpName(s.inInterp);
      if (s.outInterp !== undefined) d.outInterp = interpName(s.outInterp);
      if (s.inEase !== undefined) d.easeIn = s.inEase;
      if (s.outEase !== undefined) d.easeOut = s.outEase;
      if (s.tCont !== undefined) d.temporalContinuous = s.tCont;
      if (s.tAuto !== undefined) d.temporalAutoBezier = s.tAuto;
      if (s.inTan !== undefined) d.tangentIn = s.inTan;
      if (s.outTan !== undefined) d.tangentOut = s.outTan;
      if (s.sCont !== undefined) d.spatialContinuous = s.sCont;
      if (s.sAuto !== undefined) d.spatialAutoBezier = s.sAuto;
      if (s.roving !== undefined) d.roving = s.roving;
      if (s.label !== undefined) d.label = s.label;
      if (s.selected !== undefined) d.selected = s.selected;
      out.push(d);
    }
    return out;
  }

  function warn(warnings, message) {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
  }

  // Runs one setter; a failure becomes a warning, not an error.
  function attempt(warnings, tag, idx, what, fn) {
    try {
      fn();
    } catch (e) {
      warn(warnings, tag + " key " + idx + ": " + what + ": " + e.message);
    }
  }

  function makeEase(list) {
    var out = [];
    for (var j = 0; j < list.length; j++) out.push(new KeyframeEase(list[j].speed, list[j].influence));
    return out;
  }

  function writeOneKey(p, s, idx, spatial, warnings, tag) {
    var bezierIn = true;
    var bezierOut = true;
    var haveInterp = s.inInterp !== undefined && s.outInterp !== undefined;
    if (haveInterp) {
      bezierIn = s.inInterp === KeyframeInterpolationType.BEZIER;
      bezierOut = s.outInterp === KeyframeInterpolationType.BEZIER;
    }
    var setInterp = function () { p.setInterpolationTypeAtKey(idx, s.inInterp, s.outInterp); };
    // 1. Interpolation.
    if (haveInterp) attempt(warnings, tag, idx, "interpolation", setInterp);
    // 2. Temporal flags that must be off before ease is set.
    if (s.tAuto === false) {
      attempt(warnings, tag, idx, "temporal continuity", function () { p.setTemporalAutoBezierAtKey(idx, false); });
    }
    if (s.tCont !== undefined && s.tAuto !== true) {
      attempt(warnings, tag, idx, "temporal continuity", function () { p.setTemporalContinuousAtKey(idx, s.tCont); });
    }
    // 3. Ease: not for an auto-bezier key (it computes its own), and not for a key with no
    // bezier side (setting ease on a linear or hold key may turn it into bezier).
    if (s.inEase && s.outEase && s.tAuto !== true && (bezierIn || bezierOut)) {
      attempt(warnings, tag, idx, "ease", function () { p.setTemporalEaseAtKey(idx, makeEase(s.inEase), makeEase(s.outEase)); });
      // With one bezier side only, put the interpolation back in case the ease call changed the other side.
      if (haveInterp && bezierIn !== bezierOut) attempt(warnings, tag, idx, "interpolation", setInterp);
    }
    // 4. Auto-bezier on, last.
    if (s.tAuto === true) {
      attempt(warnings, tag, idx, "temporal continuity", function () { p.setTemporalAutoBezierAtKey(idx, true); });
    }
    if (!spatial) return;
    // Spatial side: flags off, continuity, tangents, then auto-bezier on.
    if (s.sAuto === false) {
      attempt(warnings, tag, idx, "spatial continuity", function () { p.setSpatialAutoBezierAtKey(idx, false); });
    }
    if (s.sCont !== undefined && s.sAuto !== true) {
      attempt(warnings, tag, idx, "spatial continuity", function () { p.setSpatialContinuousAtKey(idx, s.sCont); });
    }
    if (s.inTan && s.outTan && s.sAuto !== true) {
      attempt(warnings, tag, idx, "spatial tangents", function () { p.setSpatialTangentsAtKey(idx, s.inTan, s.outTan); });
    }
    if (s.sAuto === true) {
      attempt(warnings, tag, idx, "spatial continuity", function () { p.setSpatialAutoBezierAtKey(idx, true); });
    }
  }

  // Puts the snapshot's keys back on the property, `dt` seconds later. The
  // property's existing keys are removed first. Per key the order is:
  // interpolation; auto-bezier and continuity turned off BEFORE ease and
  // tangents (so AE doesn't recompute them); ease and spatial tangents;
  // auto-bezier turned on last. Every setter is called without comparing to a
  // same-script read (which may be stale), so the result is right whether or
  // not AE's ease and tangent setters clear the flags themselves. Roving goes
  // once every key exists, then label and selection. A failed value write
  // throws; a failed extra goes to `warnings` and the read-back reports it.
  function writeKeys(p, snap, dt, warnings, tag) {
    var i;
    var idx;
    for (i = p.numKeys; i >= 1; i--) p.removeKey(i);
    for (i = 0; i < snap.length; i++) p.setValueAtTime(snap[i].time + dt, snap[i].value);
    // Two keys landing on one time merge into one: refuse the result (backstop; the checks before the write catch it first).
    if (p.numKeys !== snap.length) {
      fail("bad_args", tag + ": " + snap.length + " keys went in but " + p.numKeys + " are left (two keys landed on the same time)");
    }
    var spatial = false;
    try {
      spatial = p.isSpatial === true;
    } catch (eSp) {}
    for (i = 0; i < snap.length; i++) {
      writeOneKey(p, snap[i], i + 1, spatial, warnings, tag);
    }
    // Roving goes last: AE spreads the roving keys' times once all keys exist.
    // The first and last key can't rove.
    if (spatial) {
      for (i = 1; i < snap.length - 1; i++) {
        if (snap[i].roving === true) {
          (function (n) {
            attempt(warnings, tag, n, "roving", function () { p.setRovingAtKey(n, true); });
          })(i + 1);
        }
      }
    }
    for (i = 0; i < snap.length; i++) {
      (function (n, sn) {
        if (sn.label !== undefined && sn.label !== 0) {
          attempt(warnings, tag, n, "label or selection", function () { p.setLabelAtKey(n, sn.label); });
        }
        if (sn.selected === true) {
          attempt(warnings, tag, n, "label or selection", function () { p.setSelectedAtKey(n, true); });
        }
      })(i + 1, snap[i]);
    }
  }

  // The key helpers, shared with ext/timeline.jsx (ae_keyframes_transform). Only exposed: ae_stagger
  // behaves as before. snapshot(p, cap) reads every key; write(p, snap, dt, warnings, tag) removes the
  // property's keys and puts the snapshot back dt seconds later; collisions(snap, dt, frameDuration, label)
  // refuses two keys on one frame; describe(snap) turns a snapshot into plain data for a read-back.
  A.__keys = {
    snapshot: snapshotKeys,
    write: writeKeys,
    collisions: checkFrameCollisions,
    describe: describeKeys
  };

  // ---------- reads ----------

  function layerEntry(l) {
    var e = {
      index: l.index,
      id: l.id,
      name: l.name,
      startTime: l.startTime,
      inPoint: l.inPoint,
      outPoint: l.outPoint,
      stretch: l.stretch
    };
    try { e.locked = l.locked === true; } catch (e1) {}
    return e;
  }

  // What the stagger needs to know about one property on one layer. detail:
  // "times" lists the key times, "full" every field of every key.
  function propertyInfo(layer, path, detail) {
    var p = lookupProperty(layer, path);
    if (!p) return { found: false, reason: "Property path not found" };
    if (p.propertyType !== PropertyType.PROPERTY) return { found: false, reason: "Path resolves to a group, not a property" };
    var info = {
      found: true,
      name: p.name,
      matchName: p.matchName,
      valueType: p.propertyValueType,
      numKeys: p.numKeys
    };
    try { info.isSpatial = p.isSpatial === true; } catch (e1) {}
    try { info.expression = p.expressionEnabled === true; } catch (e2) {}
    try { info.separationLeader = p.dimensionsSeparated === true; } catch (e3) {}
    if (p.numKeys > MAX_LIST) info.truncated = true;
    if (p.numKeys > 0 && detail === "times") {
      var times = [];
      for (var k = 1; k <= p.numKeys && k <= MAX_LIST; k++) times.push(p.keyTime(k));
      info.times = times;
    } else if (p.numKeys > 0 && detail === "full") {
      info.keys = describeKeys(snapshotKeys(p, MAX_LIST));
    }
    return info;
  }

  A.staggerRead = function (args) {
    var comp = requireComp(args.comp_id);
    var layers = targetLayers(comp, args);
    var hasPath = args.property_path !== undefined && args.property_path !== null;
    if (hasPath) checkPath(args.property_path);
    var detail = args.detail;
    var out = {
      comp_id: comp.id,
      name: comp.name,
      frameDuration: comp.frameDuration,
      duration: comp.duration,
      numLayers: comp.numLayers,
      layers: []
    };
    var n = layers.length;
    if (n > MAX_LIST) {
      n = MAX_LIST;
      out.truncated = true;
    }
    for (var i = 0; i < n; i++) {
      var e = layerEntry(layers[i]);
      if (hasPath) e.property = propertyInfo(layers[i], args.property_path, detail);
      out.layers.push(e);
    }
    if (args.source) {
      var src = findLayer(comp, args.source);
      var se = layerEntry(src);
      if (hasPath) se.property = propertyInfo(src, args.property_path, detail);
      out.source = se;
    }
    return out;
  };

  // ---------- apply: layers in time, keys shifted or copied ----------

  function checkTime(t, what) {
    if (typeof t !== "number" || !isFinite(t)) fail("bad_args", what + " is not a number");
    if (t < -TIME_LIMIT || t > TIME_LIMIT) fail("bad_args", what + " (" + t + "s) is outside AE's range of +-" + TIME_LIMIT + "s");
  }

  function assertUnlocked(layer) {
    var locked = false;
    try {
      locked = layer.locked === true;
    } catch (e) {
      locked = false;
    }
    if (locked) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first");
  }

  // Two keys that round onto one frame after the shift would merge: refuse before writing.
  function checkFrameCollisions(snap, dt, frameDuration, label) {
    if (!(frameDuration > 0)) return;
    var seen = {};
    for (var i = 0; i < snap.length; i++) {
      var f = "f" + Math.round((snap[i].time + dt) / frameDuration);
      if (seen[f]) fail("bad_args", label + ": two keys would land on the same frame after the shift (" + (snap[i].time + dt) + "s); use another offset");
      seen[f] = true;
    }
  }

  function staggerLayersApply(args, comp) {
    var targets = args.targets;
    var trim = args.trim;
    if (trim === undefined || trim === null) trim = "keep_duration";
    if (trim !== "keep_duration" && trim !== "keep_out" && trim !== "to_comp_end") fail("bad_args", "Unknown trim mode \"" + trim + "\"");
    var jobs = [];
    var i;
    for (i = 0; i < targets.length; i++) {
      var t = targets[i];
      var layer = findLayer(comp, { id: t.id });
      assertUnlocked(layer);
      checkTime(t.to, "Start time of \"" + layer.name + "\"");
      // The plan was made from a read; a layer someone moved since is not the layer it was planned for.
      if (Math.abs(layer.startTime - t.from) > 0.0001) {
        fail("bad_args", "Layer \"" + layer.name + "\" moved since the plan was made (start " + layer.startTime + "s, planned from " + t.from + "s). Plan again.");
      }
      var shift = t.to - layer.startTime;
      var wantOut = null;
      if (trim === "keep_out") wantOut = layer.outPoint;
      if (trim === "to_comp_end") wantOut = comp.duration;
      if (wantOut !== null && layer.inPoint + shift >= wantOut - 0.000001) {
        fail("bad_args", "\"" + layer.name + "\" would start at " + (layer.inPoint + shift) + "s, at or after the out point it keeps (" + wantOut + "s); use trim keep_duration");
      }
      jobs.push({ layer: layer, to: t.to, from: layer.startTime, out: layer.outPoint, wantOut: wantOut });
    }
    return A.withUndo(args.label || "Stagger layers", function () {
      var done = [];
      var warnings = [];
      var result = [];
      var restoreFailed = [];
      try {
        for (var j = 0; j < jobs.length; j++) {
          var job = jobs[j];
          job.layer.startTime = job.to;
          done.push(job);
          if (job.wantOut !== null) {
            try {
              job.layer.outPoint = job.wantOut;
            } catch (eOut) {
              warn(warnings, "\"" + job.layer.name + "\": out point: " + eOut.message);
            }
          }
          result.push({
            id: job.layer.id,
            index: job.layer.index,
            name: job.layer.name,
            from: job.from,
            to: job.to,
            inPoint: job.layer.inPoint,
            outPoint: job.layer.outPoint
          });
        }
      } catch (ePost) {
        // Put back what already moved, in this same undo group, so a failed call leaves nothing half-done.
        for (var r = done.length - 1; r >= 0; r--) {
          try {
            done[r].layer.startTime = done[r].from;
            done[r].layer.outPoint = done[r].out;
          } catch (eRs) {
            restoreFailed.push("\"" + done[r].layer.name + "\" could not be moved back: " + eRs.message);
          }
        }
        appendRestoreFailures(ePost, restoreFailed);
        throw ePost;
      }
      return { mode: "layers", trim: trim, layers: result, warnings: warnings };
    });
  }

  function keyJob(comp, t, args, label) {
    var layer = findLayer(comp, { id: t.id });
    var p = lookupProperty(layer, args.property_path);
    if (!p) fail("not_found", "\"" + layer.name + "\" has no property " + args.property_path.join(" > "));
    if (p.propertyType !== PropertyType.PROPERTY) fail("bad_args", "Path resolves to a group, not a property");
    assertUnlocked(layer);
    var separated = false;
    try {
      separated = p.dimensionsSeparated === true;
    } catch (eSep) {
      separated = false;
    }
    if (separated) fail("bad_args", "\"" + layer.name + "\": that Position has separated dimensions; use X Position / Y Position (ADBE Position_0, ADBE Position_1)");
    return { layer: layer, prop: p, offset: t.offset, label: label };
  }

  function staggerKeysApply(args, comp) {
    var copy = args.mode === "copy_keys";
    var jobs = [];
    var total = 0;
    var snapSource = null;
    var i;
    var k;
    var srcProp = null;
    if (copy) {
      if (!args.source) fail("bad_args", "copy_keys needs a source layer");
      var srcLayer = findLayer(comp, args.source);
      srcProp = lookupProperty(srcLayer, args.property_path);
      if (!srcProp) fail("not_found", "The source layer has no property " + args.property_path.join(" > "));
      if (srcProp.numKeys < 1) fail("bad_args", "The source property has no keys to copy");
      if (srcProp.numKeys > MAX_LIST) fail("bad_args", "The source property has " + srcProp.numKeys + " keys; at most " + MAX_LIST + " are copied at once");
      snapSource = snapshotKeys(srcProp, MAX_LIST);
      total += snapSource.length * args.targets.length;
    }
    for (i = 0; i < args.targets.length; i++) {
      var t = args.targets[i];
      var job = keyJob(comp, t, args, "\"" + findLayer(comp, { id: t.id }).name + "\"");
      var p = job.prop;
      checkTime(t.offset, "Offset of " + job.label);
      if (copy) {
        if (job.layer.id === findLayer(comp, args.source).id) fail("bad_args", "The source layer can't also be a target");
        if (p.matchName !== srcProp.matchName || p.propertyValueType !== srcProp.propertyValueType) {
          fail("bad_args", job.label + ": its property is a different kind from the source's (" + p.matchName + " vs " + srcProp.matchName + ")");
        }
        if (p.numKeys > 0 && args.replace_existing !== true) {
          fail("bad_args", job.label + " already has " + p.numKeys + " keys on that property; pass replace_existing to overwrite them");
        }
        job.snap = snapSource;
        for (k = 0; k < snapSource.length; k++) checkTime(snapSource[k].time + t.offset, "A key time on " + job.label);
        checkFrameCollisions(snapSource, t.offset, comp.frameDuration, job.label);
        job.original = snapshotKeys(p, MAX_LIST);
        if (p.numKeys === 0) {
          // Without keys the property has a static value; keep it to put back if the copy fails.
          try {
            job.origValue = p.value;
            job.hasOrigValue = true;
          } catch (eVal) {
            job.hasOrigValue = false;
          }
        }
        if (p.numKeys > MAX_LIST) fail("bad_args", job.label + " has more than " + MAX_LIST + " keys on that property; they can't be restored if the copy fails");
      } else {
        if (p.numKeys < 1) fail("bad_args", job.label + " has no keys on that property");
        if (p.numKeys > MAX_LIST) fail("bad_args", job.label + " has " + p.numKeys + " keys on that property; at most " + MAX_LIST + " are shifted at once");
        // The plan was made from a read; keys edited since are not the keys it was planned for.
        if (p.numKeys !== t.num_keys || Math.abs(p.keyTime(1) - t.first_time) > 0.0001) {
          fail("bad_args", job.label + ": its keys changed since the plan was made. Plan again.");
        }
        job.snap = snapshotKeys(p, MAX_LIST);
        job.original = job.snap;
        total += job.snap.length;
        for (k = 0; k < job.snap.length; k++) checkTime(job.snap[k].time + t.offset, "A key time on " + job.label);
        checkFrameCollisions(job.snap, t.offset, comp.frameDuration, job.label);
      }
      jobs.push(job);
    }
    if (total > MAX_KEYS_TOTAL) {
      fail("bad_args", total + " keys would be rebuilt; at most " + MAX_KEYS_TOTAL + " per call. Split the layers into batches.");
    }
    return A.withUndo(args.label || (copy ? "Copy keys with offset" : "Stagger keys"), function () {
      var done = [];
      var warnings = [];
      var result = [];
      var restoreFailed = [];
      try {
        for (var j = 0; j < jobs.length; j++) {
          var jb = jobs[j];
          done.push(jb);
          writeKeys(jb.prop, jb.snap, jb.offset, warnings, jb.label);
          result.push({
            id: jb.layer.id,
            index: jb.layer.index,
            name: jb.layer.name,
            offset: jb.offset,
            numKeys: jb.prop.numKeys,
            firstKey: jb.prop.numKeys > 0 ? jb.prop.keyTime(1) : null
          });
        }
      } catch (ePost) {
        // Put each property's original keys back, in this same undo group.
        for (var r = done.length - 1; r >= 0; r--) {
          try {
            writeKeys(done[r].prop, done[r].original, 0, [], done[r].label);
            if (done[r].hasOrigValue === true && done[r].original.length === 0) done[r].prop.setValue(done[r].origValue);
          } catch (eRs) {
            restoreFailed.push("the original keys of " + done[r].label + " could not be put back: " + eRs.message);
          }
        }
        appendRestoreFailures(ePost, restoreFailed);
        throw ePost;
      }
      return { mode: args.mode, layers: result, warnings: warnings };
    });
  }

  A.staggerApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    if (args.mode !== "layers" && args.mode !== "keys" && args.mode !== "copy_keys") fail("bad_args", "Unknown mode \"" + args.mode + "\"");
    if (!args.targets || !isArray(args.targets) || args.targets.length === 0) fail("bad_args", "No targets to stagger");
    if (args.targets.length > MAX_LIST) fail("bad_args", "At most " + MAX_LIST + " layers per call");
    if (args.mode === "layers") return staggerLayersApply(args, comp);
    checkPath(args.property_path);
    return staggerKeysApply(args, comp);
  };

  // ---------- layout: Position on a grid or circle ----------

  function transformGroup(layer) {
    try {
      return layer.property("ADBE Transform Group");
    } catch (e) {
      return null;
    }
  }

  // "static", "keyed" or "expression"; a separated Position is judged by its X, Y and Z properties.
  function positionState(layer) {
    var g = transformGroup(layer);
    if (!g) return { state: "missing" };
    var p = g.property("ADBE Position");
    if (!p) return { state: "missing" };
    var props = [p];
    var separated = false;
    try { separated = p.dimensionsSeparated === true; } catch (e0) {}
    if (separated) {
      props = [];
      var names = ["ADBE Position_0", "ADBE Position_1", "ADBE Position_2"];
      for (var i = 0; i < names.length; i++) {
        var f = g.property(names[i]);
        if (f) props.push(f);
      }
    }
    var state = "static";
    for (var j = 0; j < props.length; j++) {
      if (props[j].numKeys > 0) state = "keyed";
      else if (state === "static") {
        try { if (props[j].expressionEnabled === true) state = "expression"; } catch (e1) {}
      }
    }
    return { state: state, separated: separated, prop: p, followers: props, group: g };
  }

  A.staggerLayoutRead = function (args) {
    var comp = requireComp(args.comp_id);
    var layers = targetLayers(comp, args);
    var out = { comp_id: comp.id, name: comp.name, width: comp.width, height: comp.height, numLayers: comp.numLayers, layers: [] };
    var n = layers.length;
    if (n > MAX_LIST) {
      n = MAX_LIST;
      out.truncated = true;
    }
    for (var i = 0; i < n; i++) {
      var l = layers[i];
      var e = { index: l.index, id: l.id, name: l.name, parent: null };
      try { if (l.parent) e.parent = l.parent.index; } catch (e1) {}
      try { e.threeD = l.threeDLayer === true; } catch (e2) {}
      try { e.locked = l.locked === true; } catch (e3) {}
      var ps = positionState(l);
      e.state = ps.state;
      if (ps.prop) {
        e.separated = ps.separated === true;
        e.position = plainValue(ps.prop.value);
      }
      out.layers.push(e);
    }
    return out;
  };

  A.staggerLayoutApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    if (!args.targets || !isArray(args.targets) || args.targets.length === 0) fail("bad_args", "No targets to place");
    if (args.targets.length > MAX_LIST) fail("bad_args", "At most " + MAX_LIST + " layers per call");
    var jobs = [];
    for (var i = 0; i < args.targets.length; i++) {
      var t = args.targets[i];
      var layer = findLayer(comp, { id: t.id });
      assertUnlocked(layer);
      if (!t.position || !isArray(t.position) || t.position.length < 2 || typeof t.position[0] !== "number" || typeof t.position[1] !== "number" || !isFinite(t.position[0]) || !isFinite(t.position[1])) {
        fail("bad_args", "Position for \"" + layer.name + "\" must be [x, y]");
      }
      var ps = positionState(layer);
      if (ps.state === "missing") fail("bad_args", "\"" + layer.name + "\" has no Position");
      if (ps.separated && ps.followers.length < 2) fail("bad_args", "\"" + layer.name + "\" has a separated Position but its X and Y properties were not found");
      if (ps.state === "keyed") fail("bad_args", "\"" + layer.name + "\" has Position keyframes; remove them first (ae_remove_keyframes) or shift them instead");
      if (ps.state === "expression") fail("bad_args", "\"" + layer.name + "\" has a Position expression, which would override the value");
      var cur = ps.prop.value;
      // A 2D layer's Position can still read three values; keep Z.
      var next = [];
      for (var k = 0; k < cur.length; k++) next.push(cur[k]);
      next[0] = t.position[0];
      next[1] = t.position[1];
      jobs.push({ layer: layer, ps: ps, from: cur, next: next });
    }
    return A.withUndo(args.label || "Stagger layout", function () {
      var done = [];
      var result = [];
      var restoreFailed = [];
      try {
        for (var j = 0; j < jobs.length; j++) {
          var job = jobs[j];
          done.push(job);
          if (job.ps.separated) {
            job.ps.followers[0].setValue(job.next[0]);
            job.ps.followers[1].setValue(job.next[1]);
          } else {
            job.ps.prop.setValue(job.next);
          }
          result.push({ id: job.layer.id, index: job.layer.index, name: job.layer.name, position: [job.next[0], job.next[1]] });
        }
      } catch (ePost) {
        for (var r = done.length - 1; r >= 0; r--) {
          try {
            if (done[r].ps.separated) {
              done[r].ps.followers[0].setValue(done[r].from[0]);
              done[r].ps.followers[1].setValue(done[r].from[1]);
            } else {
              done[r].ps.prop.setValue(done[r].from);
            }
          } catch (eRs) {
            restoreFailed.push("the Position of \"" + done[r].layer.name + "\" could not be put back: " + eRs.message);
          }
        }
        appendRestoreFailures(ePost, restoreFailed);
        throw ePost;
      }
      return { layers: result };
    });
  };
})($.global);
