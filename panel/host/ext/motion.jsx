// motion.jsx: read properties over time for the motion tools (graph and review).
//
// Rules (see docs/BUILDERS.md):
// - ES3 only: no let/const/arrows/template strings/classes, no chained ternaries.
// - Read functions must not mutate project/comp state or touch the undo stack.
//   valueAtTime() reads without moving the comp's time indicator.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_SAMPLES = 1000;
  var MAX_KEYS = 500;
  var MAX_ANIMATED = 200;
  var MAX_VISITED = 20000;
  var MAX_DEPTH = 10;
  // On a 2D layer AE still reports these as 3D values with a constant Z
  // (measured on AE 26.2), which would flatten the value graph.
  var TWO_D_ON_2D_LAYERS = { "ADBE Anchor Point": true, "ADBE Position": true, "ADBE Scale": true };

  function fail(kind, message) {
    var e = new Error(message);
    e.__kind = kind;
    throw e;
  }

  function isArray(v) {
    return v instanceof Array;
  }

  function requireComp(id) {
    var item = null;
    try { item = app.project.itemByID(id); } catch (e) { item = null; }
    if (!item || !(item instanceof CompItem)) fail("not_found", "No CompItem with id " + id);
    return item;
  }

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
      var byName = comp.layer(sel.name);
      if (!byName) fail("not_found", "No layer named \"" + sel.name + "\"");
      return byName;
    }
    fail("bad_args", "layer selector needs id, index or name");
    return null;
  }

  function resolvePath(layer, path) {
    var p = layer;
    for (var i = 0; i < path.length; i++) {
      var next = null;
      try { next = p.property(path[i]); } catch (e) { next = null; }
      if (!next) fail("not_found", "Property path not found at \"" + path[i] + "\" (" + path.join(" > ") + ")");
      p = next;
    }
    return p;
  }

  function valueTypeName(p) {
    var t = p.propertyValueType;
    if (t === PropertyValueType.OneD) return "OneD";
    if (t === PropertyValueType.TwoD) return "TwoD";
    if (t === PropertyValueType.TwoD_SPATIAL) return "TwoD_SPATIAL";
    if (t === PropertyValueType.ThreeD) return "ThreeD";
    if (t === PropertyValueType.ThreeD_SPATIAL) return "ThreeD_SPATIAL";
    if (t === PropertyValueType.COLOR) return "COLOR";
    return null;
  }

  function interpName(t) {
    if (t === KeyframeInterpolationType.LINEAR) return "linear";
    if (t === KeyframeInterpolationType.BEZIER) return "bezier";
    if (t === KeyframeInterpolationType.HOLD) return "hold";
    return String(t);
  }

  // Copies a value into a plain array, keeping the first `dims` entries
  // (0 keeps them all).
  function asVector(v, dims) {
    if (isArray(v)) {
      var out = [];
      var n = v.length;
      if (dims > 0 && dims < n) n = dims;
      for (var i = 0; i < n; i++) out.push(v[i]);
      return out;
    }
    return [v];
  }

  function easeList(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push({ speed: list[i].speed, influence: list[i].influence });
    return out;
  }

  // Samples a numeric property (with expressions applied) on a regular time
  // grid, plus its keyframes and their temporal ease. args:
  // { comp_id, layer, path, start?, end?, step? }. The default range runs from
  // the first to the last keyframe, or over the work area without keys; the
  // default step is one comp frame. Sample count is capped at MAX_SAMPLES by
  // widening the step.
  A.sampleProperty = function (args) {
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var p = resolvePath(l, args.path);
    if (p.propertyType !== PropertyType.PROPERTY) fail("bad_args", "\"" + p.name + "\" is a group, not a property");
    var vt = valueTypeName(p);
    if (vt === null) fail("bad_args", "\"" + p.name + "\" does not hold a number, vector or colour, so it has no speed to measure");

    var dims = 0;
    if (l.threeDLayer === false && TWO_D_ON_2D_LAYERS[p.matchName] === true) dims = 2;

    var fps = c.frameRate;
    var start;
    var end;
    if (args.start !== undefined && args.start !== null) {
      start = args.start;
    } else if (p.numKeys >= 2) {
      start = p.keyTime(1);
    } else {
      start = c.workAreaStart;
    }
    if (args.end !== undefined && args.end !== null) {
      end = args.end;
    } else if (p.numKeys >= 2) {
      end = p.keyTime(p.numKeys);
    } else {
      end = c.workAreaStart + c.workAreaDuration;
    }
    if (end <= start) fail("bad_args", "Empty range: start " + start + "s, end " + end + "s");

    var step = 1 / fps;
    if (args.step !== undefined && args.step !== null && args.step > 0) step = args.step;
    var samplesCapped = false;
    if ((end - start) / step > MAX_SAMPLES - 1) {
      step = (end - start) / (MAX_SAMPLES - 1);
      samplesCapped = true;
    }

    var times = [];
    var values = [];
    var n = Math.floor((end - start) / step + 1e-6);
    for (var i = 0; i <= n; i++) {
      var t = start + i * step;
      times.push(t);
      values.push(asVector(p.valueAtTime(t, false), dims));
    }
    if (end - times[times.length - 1] > 1e-6) {
      times.push(end);
      values.push(asVector(p.valueAtTime(end, false), dims));
    }

    var keys = [];
    var nk = p.numKeys;
    if (nk > MAX_KEYS) nk = MAX_KEYS;
    for (var k = 1; k <= nk; k++) {
      var key = {
        index: k,
        time: p.keyTime(k),
        value: asVector(p.keyValue(k), dims),
        in_interp: interpName(p.keyInInterpolationType(k)),
        out_interp: interpName(p.keyOutInterpolationType(k))
      };
      try { key.in_ease = easeList(p.keyInTemporalEase(k)); } catch (e1) {}
      try { key.out_ease = easeList(p.keyOutTemporalEase(k)); } catch (e2) {}
      keys.push(key);
    }

    var expr = false;
    try { expr = p.canSetExpression && p.expressionEnabled && p.expression !== ""; } catch (e3) { expr = false; }

    return {
      comp: { id: c.id, name: c.name, fps: fps },
      layer: { index: l.index, id: l.id, name: l.name },
      property: {
        name: p.name,
        matchName: p.matchName,
        value_type: vt,
        spatial: vt === "TwoD_SPATIAL" || vt === "ThreeD_SPATIAL",
        dimensions: values[0].length,
        num_keys: p.numKeys,
        keys_truncated: p.numKeys > MAX_KEYS,
        // step was widened to stay under MAX_SAMPLES: fewer samples than the
        // comp's frame grid would give, so fast detail between samples can be missed.
        samples_capped: samplesCapped,
        expression: expr
      },
      start: start,
      end: end,
      step: step,
      times: times,
      values: values,
      keys: keys
    };
  };

  // Lists the keyframed numeric properties (2+ keys) of a comp's layers, for
  // the motion review. args: { comp_id, layers? }. Each path step is a match
  // name, except inside indexed groups (effects, masks, shape contents),
  // where siblings can share both a match name and a display name - so the
  // step there is the sibling's 1-based position, which property() also
  // accepts and which can't collide.
  // Bounded by MAX_ANIMATED results and MAX_VISITED properties.
  A.listAnimatedProperties = function (args) {
    var c = requireComp(args.comp_id);
    var layers = [];
    var i;
    if (args.layers && args.layers.length > 0) {
      for (i = 0; i < args.layers.length; i++) layers.push(findLayer(c, args.layers[i]));
    } else {
      for (i = 1; i <= c.numLayers; i++) layers.push(c.layer(i));
    }

    var found = [];
    var visited = 0;
    var truncated = false;

    function walk(group, path, depth, layer, indexed) {
      if (depth > MAX_DEPTH) return;
      var n = 0;
      try { n = group.numProperties; } catch (e0) { n = 0; }
      for (var k = 1; k <= n; k++) {
        if (found.length >= MAX_ANIMATED || visited >= MAX_VISITED) {
          truncated = true;
          return;
        }
        visited++;
        var p = null;
        try { p = group.property(k); } catch (e1) { p = null; }
        if (!p) continue;
        var step;
        if (indexed) {
          step = k; // 1-based position: siblings here can share a name, this can't collide.
        } else {
          step = p.matchName;
        }
        var nextPath = path.concat([step]);
        if (p.propertyType === PropertyType.PROPERTY) {
          var keys = 0;
          try { keys = p.numKeys; } catch (e2) { keys = 0; }
          if (keys >= 2 && valueTypeName(p) !== null) {
            var expr = false;
            try { expr = p.canSetExpression && p.expressionEnabled && p.expression !== ""; } catch (e3) { expr = false; }
            found.push({
              layer: { index: layer.index, id: layer.id, name: layer.name },
              path: nextPath,
              name: p.name,
              matchName: p.matchName,
              num_keys: keys,
              first_key_time: p.keyTime(1),
              last_key_time: p.keyTime(keys),
              expression: expr
            });
          }
        } else {
          walk(p, nextPath, depth + 1, layer, p.propertyType === PropertyType.INDEXED_GROUP);
        }
      }
    }

    for (i = 0; i < layers.length; i++) {
      walk(layers[i], [], 1, layers[i], false);
      if (truncated) break;
    }

    var projectPath = "<unsaved>";
    try { if (app.project.file) projectPath = app.project.file.fsName; } catch (e4) {}

    return {
      comp: {
        id: c.id,
        name: c.name,
        fps: c.frameRate,
        width: c.width,
        height: c.height,
        workAreaStart: c.workAreaStart,
        workAreaDuration: c.workAreaDuration
      },
      project_path: projectPath,
      layers_scanned: layers.length,
      properties: found,
      truncated: truncated
    };
  };
})($.global);
