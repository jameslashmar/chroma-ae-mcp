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
    return m;
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
    return A.withUndo(args.label || "Add markers", function () {
      var placed = [];
      var replaced = 0;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        var t = m.time;
        // Layer (source) time to comp time; time remapping is not followed.
        if (fromLayer) t = layer.startTime + (m.time * layer.stretch) / 100;
        var mv = new MarkerValue(m.comment ? String(m.comment) : "");
        if (m.duration) mv.duration = m.duration;
        if (m.chapter) mv.chapter = String(m.chapter);
        if (m.url) mv.url = String(m.url);
        if (m.label !== undefined && m.label !== null) {
          try { mv.label = m.label; } catch (eLabel) {}
        }
        if (prop.numKeys > 0) {
          var k = prop.nearestKeyIndex(t);
          if (Math.abs(prop.keyTime(k) - t) < 0.0005) replaced++;
        }
        prop.setValueAtTime(t, mv);
        placed.push({ time: t, comment: mv.comment });
      }
      return { target: layer ? "layer" : "comp", placed: placed, replaced: replaced };
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
    return A.withUndo(args.label || "Remove markers", function () {
      var removed = [];
      for (var i = prop.numKeys; i >= 1; i--) {
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
        if (match) {
          removed.push(markerEntry(prop, i));
          prop.removeKey(i);
        }
      }
      removed.reverse();
      return { target: layer ? "layer" : "comp", removed: removed };
    });
  };
})($.global);
