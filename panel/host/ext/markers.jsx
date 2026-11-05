// panel/host/ext/markers.jsx
//
// Host functions for the marker tools:
// - listMarkers (read): a comp's or a layer's markers
// - addMarkers (guarded write): many markers in one undo group, at comp time
//   or at the layer's own (source) time
// - removeMarkers (guarded write): all, a time range, a comment match, or indexes
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_MARKERS = 500;
  var MAX_STRING = 2000;

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

  function findLayer(comp, sel) {
    var i;
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

  function markerProp(comp, layer) {
    var p = null;
    if (layer) {
      try {
        p = layer.property("ADBE Marker");
      } catch (e1) {
        p = null;
      }
      if (!p) fail("bad_args", "Layer \"" + layer.name + "\" has no markers property");
      return p;
    }
    try {
      p = comp.markerProperty;
    } catch (e2) {
      p = null;
    }
    if (!p) fail("bad_args", "This AE can't script comp markers (CompItem.markerProperty is missing)");
    return p;
  }

  function clip(s) {
    var str = String(s);
    if (str.length > MAX_STRING) return str.substring(0, MAX_STRING) + " ...[truncated]";
    return str;
  }

  function markerEntry(prop, i) {
    var mv = prop.keyValue(i);
    var m = { index: i, time: prop.keyTime(i), duration: 0, comment: "" };
    try { m.duration = mv.duration; } catch (e1) {}
    try { m.comment = clip(mv.comment); } catch (e2) {}
    try { m.label = mv.label; } catch (e3) {}
    try { if (mv.chapter) m.chapter = clip(mv.chapter); } catch (e4) {}
    try { if (mv.url) m.url = clip(mv.url); } catch (e5) {}
    try { if (mv.cuePointName) m.cuePointName = clip(mv.cuePointName); } catch (e6) {}
    try { if (mv.protectedRegion) m.protectedRegion = true; } catch (e7) {}
    // Snake_case fields added with the marker edit tool (only the ones that are set).
    try { if (mv.frameTarget) m.frame_target = clip(mv.frameTarget); } catch (e8) {}
    try { if (mv.cuePointName) m.cue_point_name = clip(mv.cuePointName); } catch (e9) {}
    try { if (mv.eventCuePoint === true) m.event_cue_point = true; } catch (e10) {}
    try { if (mv.protectedRegion === true) m.protected_region = true; } catch (e11) {}
    var prm = readParams(mv);
    if (prm !== null) m.params = prm;
    return m;
  }

  // MarkerValue.getParameters() as {key: string}, at most 50 entries; null when there are none or the member is missing.
  function readParams(mv) {
    var out = {};
    var count = 0;
    try {
      if (typeof mv.getParameters !== "function") return null;
      var prm = mv.getParameters();
      if (!prm) return null;
      for (var k in prm) {
        if (!prm.hasOwnProperty(k)) continue;
        if (count >= 50) break;
        out[k] = clip(prm[k]);
        count++;
      }
    } catch (e) {
      return null;
    }
    if (count === 0) return null;
    return out;
  }

  // MarkerValue.getParameters() copied whole (no entry cap, no clipping), for rebuilding a marker without losing any parameter; null when there are none.
  function rawParams(mv) {
    var out = {};
    var count = 0;
    try {
      if (typeof mv.getParameters !== "function") return null;
      var prm = mv.getParameters();
      if (!prm) return null;
      for (var k in prm) {
        if (!prm.hasOwnProperty(k)) continue;
        out[k] = prm[k];
        count++;
      }
    } catch (e) {
      return null;
    }
    if (count === 0) return null;
    return out;
  }

  // Does this AE's MarkerValue have the member? (Reads a throwaway value; changes nothing.)
  var probeValue = null;
  function supports(name) {
    try {
      if (probeValue === null) probeValue = new MarkerValue("");
      if (name === "getParameters" || name === "setParameters") return typeof probeValue[name] === "function";
      return typeof probeValue[name] !== "undefined";
    } catch (e) {
      return false;
    }
  }

  var EXTRA_MEMBERS = [
    ["protected_region", "protectedRegion"],
    ["frame_target", "frameTarget"],
    ["cue_point_name", "cuePointName"],
    ["event_cue_point", "eventCuePoint"]
  ];

  // Checks the new marker fields in m (an add entry or an edit's set); throws before any change.
  function checkExtras(m, isComp, what) {
    var i;
    for (i = 0; i < EXTRA_MEMBERS.length; i++) {
      var key = EXTRA_MEMBERS[i][0];
      if (m[key] === undefined || m[key] === null) continue;
      if (key === "protected_region" || key === "event_cue_point") {
        if (typeof m[key] !== "boolean") fail("bad_args", what + ": " + key + " must be true or false");
      } else if (typeof m[key] !== "string") {
        fail("bad_args", what + ": " + key + " must be text");
      }
      if (!supports(EXTRA_MEMBERS[i][1])) fail("bad_args", what + ": this After Effects has no MarkerValue." + EXTRA_MEMBERS[i][1] + " (" + key + " needs a newer version)");
    }
    if (m.protected_region === true && !isComp) fail("bad_args", what + ": protected_region is for composition markers only, not layer markers");
    if (m.params !== undefined && m.params !== null) {
      if (typeof m.params !== "object" || m.params instanceof Array) fail("bad_args", what + ": params must be an object of text values");
      var n = 0;
      for (var pk in m.params) {
        if (!m.params.hasOwnProperty(pk)) continue;
        n++;
        var pv = m.params[pk];
        if (typeof pv !== "string" && typeof pv !== "number" && typeof pv !== "boolean") fail("bad_args", what + ": params." + pk + " must be text, a number or true/false");
      }
      if (n > 50) fail("bad_args", what + ": at most 50 params");
      if (!supports("setParameters")) fail("bad_args", what + ": this After Effects has no MarkerValue.setParameters");
    }
  }

  // Writes the new fields of m onto the MarkerValue mv; returns the names that AE refused.
  function applyExtras(mv, m) {
    var refused = [];
    var i;
    for (i = 0; i < EXTRA_MEMBERS.length; i++) {
      var key = EXTRA_MEMBERS[i][0];
      if (m[key] === undefined || m[key] === null) continue;
      try { mv[EXTRA_MEMBERS[i][1]] = m[key]; } catch (e) { refused.push(key); }
    }
    if (m.params !== undefined && m.params !== null) {
      var flat = {};
      for (var pk in m.params) {
        if (m.params.hasOwnProperty(pk)) flat[pk] = String(m.params[pk]);
      }
      try { mv.setParameters(flat); } catch (e2) { refused.push("params"); }
    }
    return refused;
  }

  // A fresh MarkerValue with every field of src (a key's value must be copied before the key is removed).
  function copyMarker(src, isComp) {
    var mv = new MarkerValue("");
    var failed = [];
    var names = ["comment", "duration", "chapter", "url", "frameTarget", "cuePointName", "eventCuePoint", "label", "protectedRegion"];
    for (var i = 0; i < names.length; i++) {
      var v;
      try { v = src[names[i]]; } catch (e0) { v = undefined; }
      if (v === undefined || v === null) continue;
      if (names[i] === "protectedRegion" && (v !== true || !isComp)) continue;
      try { mv[names[i]] = v; } catch (e1) { failed.push(names[i]); }
    }
    var prm = rawParams(src);
    if (prm !== null) {
      try { mv.setParameters(prm); } catch (e2) { failed.push("params"); }
    }
    return { mv: mv, failed: failed };
  }

  // The fields of a MarkerValue as the read-back will see them (listMarkers' names).
  function expectedFields(mv) {
    var f = {};
    try { f.comment = clip(mv.comment); } catch (e1) {}
    try { f.duration = mv.duration; } catch (e2) {}
    try { f.label = mv.label; } catch (e3) {}
    try { f.chapter = clip(mv.chapter); } catch (e4) {}
    try { f.url = clip(mv.url); } catch (e5) {}
    try { f.frame_target = clip(mv.frameTarget); } catch (e6) {}
    try { f.cue_point_name = clip(mv.cuePointName); } catch (e7) {}
    try { f.event_cue_point = mv.eventCuePoint === true; } catch (e8) {}
    try { f.protected_region = mv.protectedRegion === true; } catch (e9) {}
    var prm = readParams(mv);
    f.params = prm === null ? {} : prm;
    return f;
  }

  A.listMarkers = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = null;
    if (args.layer) layer = findLayer(comp, args.layer);
    var prop = markerProp(comp, layer);
    var out = { comp_id: comp.id, target: "comp", numMarkers: prop.numKeys, markers: [], truncated: false };
    if (layer) {
      out.target = "layer";
      out.layer = { index: layer.index, id: layer.id, name: layer.name, startTime: layer.startTime, stretch: layer.stretch };
    }
    var n = prop.numKeys;
    if (n > MAX_MARKERS) {
      n = MAX_MARKERS;
      out.truncated = true;
    }
    for (var i = 1; i <= n; i++) out.markers.push(markerEntry(prop, i));
    return out;
  };

  A.addMarkers = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = null;
    if (args.layer) layer = findLayer(comp, args.layer);
    var prop = markerProp(comp, layer);
    var list = args.markers || [];
    if (list.length > MAX_MARKERS) fail("bad_args", "At most " + MAX_MARKERS + " markers per call");
    var fromLayer = args.relative_to === "layer";
    if (fromLayer && !layer) fail("bad_args", "relative_to 'layer' needs a layer");
    // Validate every marker before the undo group, so a write never stops halfway.
    // Layer (source) time to comp time; time remapping is not followed. The duration
    // is scaled by the stretch like the time (a reversed layer uses its absolute value).
    var plan = [];
    var scale = 1;
    if (fromLayer) scale = Math.abs(layer.stretch) / 100;
    for (var v = 0; v < list.length; v++) {
      var pm = list[v];
      if (typeof pm.time !== "number" || !isFinite(pm.time)) fail("bad_args", "Marker " + (v + 1) + " has no usable time");
      var pt = pm.time;
      if (fromLayer) pt = layer.startTime + (pm.time * layer.stretch) / 100;
      if (!isFinite(pt)) fail("bad_args", "Marker " + (v + 1) + " lands at a time AE can't use");
      var pd = 0;
      if (pm.duration) {
        if (typeof pm.duration !== "number" || !isFinite(pm.duration) || pm.duration < 0) fail("bad_args", "Marker " + (v + 1) + " has a bad duration");
        pd = pm.duration * scale;
      }
      checkExtras(pm, !layer, "Marker " + (v + 1));
      plan.push({ t: pt, d: pd });
    }
    return A.withUndo(args.label || "Add markers", function () {
      var placed = [];
      var replaced = 0;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        var t = plan[i].t;
        var mv = new MarkerValue(m.comment ? String(m.comment) : "");
        if (plan[i].d) mv.duration = plan[i].d;
        if (m.chapter) mv.chapter = String(m.chapter);
        if (m.url) mv.url = String(m.url);
        var labelFailed = false;
        if (m.label !== undefined && m.label !== null) {
          try { mv.label = m.label; } catch (eLabel) { labelFailed = true; }
        }
        var refused = applyExtras(mv, m);
        if (prop.numKeys > 0) {
          var k = prop.nearestKeyIndex(t);
          if (Math.abs(prop.keyTime(k) - t) < 0.0005) replaced++;
        }
        prop.setValueAtTime(t, mv);
        // What was asked for, so the server can check it against the read-back.
        var rec = { time: t, comment: mv.comment, duration: plan[i].d };
        if (m.label !== undefined && m.label !== null) rec.label = m.label;
        if (labelFailed) rec.label_failed = true;
        if (m.chapter) rec.chapter = clip(m.chapter);
        if (m.url) rec.url = clip(m.url);
        if (m.protected_region !== undefined && m.protected_region !== null) rec.protected_region = m.protected_region;
        if (m.frame_target) rec.frame_target = clip(m.frame_target);
        if (m.cue_point_name) rec.cue_point_name = clip(m.cue_point_name);
        if (m.event_cue_point !== undefined && m.event_cue_point !== null) rec.event_cue_point = m.event_cue_point;
        if (m.params !== undefined && m.params !== null) rec.params = expectedFields(mv).params;
        if (refused.length) rec.refused = refused;
        placed.push(rec);
      }
      return { target: layer ? "layer" : "comp", placed: placed, replaced: replaced, frame_duration: comp.frameDuration };
    });
  };

  var MARKER_TIME_LIMIT = 10800;
  var EDIT_FIELDS = ["comment", "duration", "label", "chapter", "url", "protected_region", "frame_target", "cue_point_name", "event_cue_point", "params"];

  // editMarkers: change fields of existing markers and/or move them. A marker is found by index or by
  // time; a move reads every field of the marker first (a key's value is gone once the key is removed),
  // removes the keys from the highest index down, and adds each marker again at its new time as a fresh
  // MarkerValue with every field copied plus the changes. dry_run only plans.
  A.editMarkers = function (args) {
    var dry = args.dry_run === true;
    if (!dry) assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = null;
    if (args.layer) layer = findLayer(comp, args.layer);
    var prop = markerProp(comp, layer);
    var isComp = !layer;
    var edits = args.edits;
    if (!edits || Object.prototype.toString.call(edits) !== "[object Array]" || edits.length === 0) fail("bad_args", "No edits given");
    if (edits.length > MAX_MARKERS) fail("bad_args", "At most " + MAX_MARKERS + " edits per call");
    var fromLayer = args.relative_to === "layer";
    if (fromLayer && !layer) fail("bad_args", "relative_to 'layer' needs a layer");
    var scale = 1;
    var toComp = function (t) { return t; };
    if (fromLayer) {
      scale = Math.abs(layer.stretch) / 100;
      toComp = function (t) { return layer.startTime + (t * layer.stretch) / 100; };
    }
    var n = prop.numKeys;
    var plan = [];
    var taken = {};
    var finalTimes = [];
    var i;
    var f;
    for (i = 1; i <= n; i++) finalTimes[i] = prop.keyTime(i);
    for (i = 0; i < edits.length; i++) {
      var ed = edits[i];
      var what = "Edit " + (i + 1);
      var hasIndex = ed.index !== undefined && ed.index !== null;
      var hasTime = ed.time !== undefined && ed.time !== null;
      if (hasIndex === hasTime) fail("bad_args", what + ": give index or time, not both and not neither");
      var idx = 0;
      if (hasIndex) {
        idx = ed.index;
        if (typeof idx !== "number" || idx < 1 || idx > n || Math.floor(idx) !== idx) fail("bad_args", what + ": marker " + idx + " out of range (1.." + n + ")");
      } else {
        if (typeof ed.time !== "number" || !isFinite(ed.time)) fail("bad_args", what + ": time is not a number");
        if (n < 1) fail("bad_args", what + ": there are no markers");
        var want = toComp(ed.time);
        idx = prop.nearestKeyIndex(want);
        if (Math.abs(prop.keyTime(idx) - want) > 0.001) fail("bad_args", what + ": no marker at " + want + "s (the nearest is at " + prop.keyTime(idx) + "s)");
      }
      if (taken[idx]) fail("bad_args", what + ": marker " + idx + " is edited twice");
      taken[idx] = true;
      var set = ed.set;
      var hasSet = false;
      if (set) {
        for (f = 0; f < EDIT_FIELDS.length; f++) {
          if (set[EDIT_FIELDS[f]] !== undefined && set[EDIT_FIELDS[f]] !== null) hasSet = true;
        }
        checkExtras(set, isComp, what);
        if (set.duration !== undefined && set.duration !== null && (typeof set.duration !== "number" || !isFinite(set.duration) || set.duration < 0)) fail("bad_args", what + ": bad duration");
        if (set.label !== undefined && set.label !== null && (typeof set.label !== "number" || set.label < 0 || set.label > 16)) fail("bad_args", what + ": label must be 0..16");
      }
      var oldTime = prop.keyTime(idx);
      var newTime = oldTime;
      var moves = ed.move_to !== undefined && ed.move_to !== null;
      if (moves) {
        if (typeof ed.move_to !== "number" || !isFinite(ed.move_to)) fail("bad_args", what + ": move_to is not a number");
        newTime = toComp(ed.move_to);
        if (!isFinite(newTime) || Math.abs(newTime) > MARKER_TIME_LIMIT) fail("bad_args", what + ": move_to lands at a time AE can't use");
        if (Math.abs(newTime - oldTime) < 0.0000005) moves = false;
      }
      if (!hasSet && !moves) {
        if (ed.move_to === undefined || ed.move_to === null) fail("bad_args", what + ": nothing to change (give set or move_to)");
      }
      finalTimes[idx] = newTime;
      plan.push({ index: idx, from: oldTime, to: newTime, moved: moves, set: set, hasSet: hasSet });
    }
    // Two markers on one time would merge into one: refuse the result.
    var sorted = [];
    for (i = 1; i <= n; i++) sorted.push(finalTimes[i]);
    sorted.sort(function (a, b) { return a - b; });
    for (i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i] - sorted[i - 1]) < 0.0005) fail("bad_args", "Two markers would end up at " + sorted[i] + "s; move_to a free time");
    }
    var changed = false;
    for (i = 0; i < plan.length; i++) {
      if (plan[i].moved || plan[i].hasSet) changed = true;
    }
    var summary = [];
    for (i = 0; i < plan.length; i++) {
      summary.push({ index: plan[i].index, from: plan[i].from, to: plan[i].to, moved: plan[i].moved });
    }
    if (dry) {
      return { dry_run: true, target: isComp ? "comp" : "layer", edits: summary, changed: changed, numMarkers: n };
    }
    if (!changed) {
      return { no_op: true, target: isComp ? "comp" : "layer", edits: summary, changed: false, numMarkers: n };
    }
    return A.withUndo(args.label || "Edit markers", function () {
      var done = [];
      var j;
      var p;
      // Copy every marker's fields first: after removeKey the value is gone.
      for (j = 0; j < plan.length; j++) {
        p = plan[j];
        var copied = copyMarker(prop.keyValue(p.index), isComp);
        var mv = copied.mv;
        var refused = [];
        var s = p.set;
        if (s) {
          if (s.comment !== undefined && s.comment !== null) mv.comment = String(s.comment);
          if (s.duration !== undefined && s.duration !== null) mv.duration = s.duration * scale;
          if (s.chapter !== undefined && s.chapter !== null) mv.chapter = String(s.chapter);
          if (s.url !== undefined && s.url !== null) mv.url = String(s.url);
          if (s.label !== undefined && s.label !== null) {
            try { mv.label = s.label; } catch (eLabel) { refused.push("label"); }
          }
          var more = applyExtras(mv, s);
          for (f = 0; f < more.length; f++) refused.push(more[f]);
        }
        done.push({ plan: p, mv: mv, copyFailed: copied.failed, refused: refused });
      }
      // Moving markers leave first (highest index first, so the others keep their index).
      var gone = [];
      for (j = 0; j < plan.length; j++) {
        if (plan[j].moved) gone.push(plan[j].index);
      }
      gone.sort(function (a, b) { return b - a; });
      for (j = 0; j < gone.length; j++) prop.removeKey(gone[j]);
      var result = [];
      for (j = 0; j < done.length; j++) {
        var d = done[j];
        prop.setValueAtTime(d.plan.to, d.mv);
        var rec = { index: d.plan.index, from: d.plan.from, to: d.plan.to, moved: d.plan.moved, fields: expectedFields(d.mv) };
        if (d.copyFailed.length) rec.copy_failed = d.copyFailed;
        if (d.refused.length) rec.refused = d.refused;
        result.push(rec);
      }
      return { target: isComp ? "comp" : "layer", edits: result, frame_duration: comp.frameDuration, numMarkers: prop.numKeys };
    });
  };

  A.removeMarkers = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = null;
    if (args.layer) layer = findLayer(comp, args.layer);
    var prop = markerProp(comp, layer);
    var wantIndex = {};
    var hasIndexes = false;
    if (args.indexes) {
      for (var w = 0; w < args.indexes.length; w++) {
        wantIndex[args.indexes[w]] = true;
        hasIndexes = true;
      }
    }
    var needle = null;
    if (args.comment_contains) needle = String(args.comment_contains).toLowerCase();
    // Reads only: pick the matches before the undo group opens.
    var hits = [];
    var n = prop.numKeys;
    for (var i = 1; i <= n; i++) {
      var t = prop.keyTime(i);
      var match = args.all === true;
      if (!match && hasIndexes && wantIndex[i]) match = true;
      if (!match && (args.start !== undefined || args.end !== undefined) && needle === null) {
        var lo = -1e9;
        var hi = 1e9;
        if (args.start !== undefined && args.start !== null) lo = args.start;
        if (args.end !== undefined && args.end !== null) hi = args.end;
        if (t >= lo - 0.0005 && t <= hi + 0.0005) match = true;
      }
      if (!match && needle !== null) {
        var c = "";
        try { c = String(prop.keyValue(i).comment).toLowerCase(); } catch (eC) {}
        var inRange = true;
        if (args.start !== undefined && args.start !== null && t < args.start - 0.0005) inRange = false;
        if (args.end !== undefined && args.end !== null && t > args.end + 0.0005) inRange = false;
        if (inRange && c.indexOf(needle) >= 0) match = true;
      }
      if (match) hits.push(i);
    }
    // Report the first MAX_MARKERS (in time order) in full; the count covers them all.
    var removed = [];
    for (var h = 0; h < hits.length && h < MAX_MARKERS; h++) removed.push(markerEntry(prop, hits[h]));
    return A.withUndo(args.label || "Remove markers", function () {
      for (var r = hits.length - 1; r >= 0; r--) prop.removeKey(hits[r]);
      return {
        target: layer ? "layer" : "comp",
        removed: removed,
        removed_count: hits.length,
        removed_truncated: hits.length > removed.length
      };
    });
  };
})($.global);
