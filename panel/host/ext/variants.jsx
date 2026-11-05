// panel/host/ext/variants.jsx
//
// Host functions for the variants tools (try several versions of a change as
// comp copies, keep the one the user picks):
// - variantsPlan (read): validates a set of variants against a comp and says
//   what each would change, without touching anything
// - variantsCreate (guarded write): duplicates the comp once per variant into
//   a "chroma variants" folder and applies that variant's ops to the copy
// - variantsRead (read): the comp's digest, whether copies exist, and the
//   values the ops should have written, for the read-back
// - variantsPromote (guarded write): replays the chosen variant's ops on the
//   original (after a digest check that nothing moved while the user chose)
//   and removes or parks the copies, in one undo group
// - variantsDiscard (guarded write): removes or parks the copies only
//
// Ops are data, so the same list that built a copy can be replayed on the
// original: color, set_value, offset, shift_time, ease and comp_duration. An
// op only touches the layers of the comp it is applied to; a nested precomp
// is shared between a comp and its duplicate, so nothing inside a precomp
// source is ever edited.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first, validate everything that can
//   fail before A.withUndo, and change things inside it.
// - Before and after reads run in separate evalScript calls from the server,
//   so the values a write should leave behind come from its inputs, never from
//   a read in the same script.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_PROPS_SCANNED = 3000;
  var MAX_SECONDS = 10800;
  var DEFAULT_FOLDER = "chroma variants";
  var TRANSFORM = "ADBE Transform Group";
  var POSITION = "ADBE Position";

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

  function itemById(id) {
    var item = null;
    try {
      item = app.project.itemByID(id);
    } catch (e) {
      item = null;
    }
    return item;
  }

  function requireComp(id) {
    var item = itemById(id);
    if (!item || !(item instanceof CompItem)) fail("not_found", "No CompItem with id " + id);
    return item;
  }

  // A list from args or from AE: arrays built in another realm fail instanceof.
  function isList(v) {
    return v !== null && v !== undefined && typeof v === "object" && typeof v.length === "number";
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function copyList(v) {
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(v[i]);
    return out;
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

  function resolveProp(layer, path) {
    if (!isList(path) || path.length === 0) fail("bad_args", "path must be a non-empty array of property names");
    var p = layer;
    for (var i = 0; i < path.length; i++) {
      var next = null;
      try {
        next = p.property(path[i]);
      } catch (e) {
        next = null;
      }
      if (!next) fail("not_found", "Property \"" + path[i] + "\" not found on layer \"" + layer.name + "\" (" + copyList(path).join(" > ") + ")");
      p = next;
    }
    if (p.propertyType !== PropertyType.PROPERTY) {
      fail("bad_args", "Path " + copyList(path).join(" > ") + " on \"" + layer.name + "\" is a group, not a property");
    }
    return p;
  }

  // "color", "scalar" or "vector"; null for anything this tool can't set.
  function valueKind(p) {
    var t = p.propertyValueType;
    if (t === PropertyValueType.COLOR) return "color";
    if (t === PropertyValueType.OneD) return "scalar";
    if (t === PropertyValueType.TwoD || t === PropertyValueType.ThreeD || t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.ThreeD_SPATIAL) {
      return "vector";
    }
    return null;
  }

  function pathText(path) {
    return copyList(path).join(" > ");
  }

  function requireWritable(layer, p, path) {
    var what = "\"" + pathText(path) + "\" on \"" + layer.name + "\"";
    var expr = false;
    try { expr = p.expressionEnabled === true; } catch (e0) {}
    if (expr) fail("bad_args", what + " has an active expression, which would override the variant; remove or disable it first");
    var sep = false;
    try { sep = p.dimensionsSeparated === true; } catch (e1) {}
    if (sep) fail("bad_args", what + " has separated dimensions; address the X, Y (and Z) properties one by one");
  }

  // A property's hard limits: AE throws "out of range" mid-write otherwise.
  function checkLimits(p, value, what) {
    var vals = isList(value) ? value : [value];
    var hasMin = false;
    var hasMax = false;
    var lo = 0;
    var hi = 0;
    try { hasMin = p.hasMin === true; if (hasMin) lo = p.minValue; } catch (e0) { hasMin = false; }
    try { hasMax = p.hasMax === true; if (hasMax) hi = p.maxValue; } catch (e1) { hasMax = false; }
    for (var i = 0; i < vals.length; i++) {
      if (hasMin && vals[i] < lo) fail("bad_args", what + ": " + vals[i] + " is below the property's minimum " + lo);
      if (hasMax && vals[i] > hi) fail("bad_args", what + ": " + vals[i] + " is above the property's maximum " + hi);
    }
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

  // The layers of one op, in selector order, each once.
  function resolveTargets(comp, sels) {
    if (!isList(sels) || sels.length === 0) fail("bad_args", "an op needs at least one layer");
    if (sels.length > 50) fail("bad_args", "an op takes at most 50 layers");
    var out = [];
    var seen = {};
    for (var i = 0; i < sels.length; i++) {
      var l = findLayer(comp, sels[i]);
      if (seen[l.index]) fail("bad_args", "Layer \"" + l.name + "\" (index " + l.index + ") is selected twice in one op");
      seen[l.index] = true;
      assertUnlocked(l);
      out.push(l);
    }
    return out;
  }

  // ---------- compiling an op against a comp ----------

  function clamp(n, lo, hi) {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function checkCurve(c) {
    if (!isList(c) || c.length !== 4) fail("bad_args", "curve must be [x1, y1, x2, y2]");
    for (var i = 0; i < 4; i++) {
      if (!isNum(c[i])) fail("bad_args", "curve values must be finite numbers");
    }
    if (c[0] < 0.001 || c[0] > 1 || c[2] < 0 || c[2] > 0.999) fail("bad_args", "curve x1 must be within 0.001..1 and x2 within 0..0.999");
  }

  // The transform properties of a layer that have two or more keys.
  function keyedTransformPaths(layer) {
    var out = [];
    var tg = null;
    try { tg = layer.property(TRANSFORM); } catch (e0) { tg = null; }
    if (!tg) return out;
    for (var i = 1; i <= tg.numProperties; i++) {
      var p = null;
      try { p = tg.property(i); } catch (e1) { p = null; }
      if (p && p.propertyType === PropertyType.PROPERTY && p.numKeys >= 2) out.push([TRANSFORM, p.matchName]);
    }
    return out;
  }

  // The same property reached by a match name or a display name gets one key:
  // the chain of match names and indexes from the property up to the layer.
  function canonKey(p) {
    var parts = [];
    var cur = p;
    var guard = 0;
    while (cur && guard < 20) {
      var mn = "";
      var pi = 0;
      try { mn = cur.matchName; } catch (e0) { mn = ""; }
      try { pi = cur.propertyIndex; } catch (e1) { pi = 0; }
      parts.unshift(mn + "#" + pi);
      var up = null;
      try { up = cur.parentProperty; } catch (e2) { up = null; }
      cur = up;
      guard++;
    }
    return parts.join(">");
  }

  function compileOp(comp, op, n) {
    var kind = op ? op.op : null;
    var where = "op " + (n + 1) + " (" + kind + ")";
    var plan = { op: kind, n: n, targets: [] };
    var i;
    var layers;
    var l;
    var p;
    var cur;

    if (kind === "comp_duration") {
      if (!isNum(op.seconds) || op.seconds <= 0 || op.seconds > MAX_SECONDS) fail("bad_args", where + ": seconds must be a number in 0..10800");
      plan.from = comp.duration;
      plan.to = op.seconds;
      return plan;
    }

    layers = resolveTargets(comp, op.layers);

    if (kind === "shift_time") {
      var offset = 0;
      var stagger = 0;
      if (op.offset !== undefined && op.offset !== null) offset = op.offset;
      if (op.stagger !== undefined && op.stagger !== null) stagger = op.stagger;
      if (!isNum(offset) || !isNum(stagger)) fail("bad_args", where + ": offset and stagger must be numbers of seconds");
      if (offset === 0 && stagger === 0) fail("bad_args", where + ": give a non-zero offset or stagger");
      // A shift under one frame can't be told from no change in the read-back.
      var oneFrame = comp.frameRate > 0 ? 1 / comp.frameRate : 0;
      if ((offset !== 0 && Math.abs(offset) < oneFrame * 0.999) || (stagger !== 0 && Math.abs(stagger) < oneFrame * 0.999)) {
        fail("bad_args", where + ": offset and stagger must each be at least one frame (" + oneFrame + "s at " + comp.frameRate + " fps), or 0");
      }
      for (i = 0; i < layers.length; i++) {
        l = layers[i];
        var to = l.startTime + offset + stagger * i;
        if (Math.abs(to) > MAX_SECONDS) fail("bad_args", where + ": \"" + l.name + "\" would start at " + to + "s, past the 3 hour limit");
        plan.targets.push({ index: l.index, name: l.name, from: l.startTime, to: to });
      }
      return plan;
    }

    if (kind === "color") {
      var c = op.color;
      if (!isList(c) || (c.length !== 3 && c.length !== 4)) fail("bad_args", where + ": color must be [r, g, b] or [r, g, b, a]");
      for (i = 0; i < c.length; i++) {
        if (!isNum(c[i]) || c[i] < 0 || c[i] > 1) fail("bad_args", where + ": color values must be numbers in 0..1");
      }
      for (i = 0; i < layers.length; i++) {
        l = layers[i];
        p = resolveProp(l, op.path);
        if (valueKind(p) !== "color") fail("bad_args", where + ": \"" + pathText(op.path) + "\" on \"" + l.name + "\" is not a colour property");
        requireWritable(l, p, op.path);
        var alpha = 1;
        if (c.length === 4) {
          alpha = c[3];
        } else {
          cur = p.numKeys > 0 ? p.keyValue(1) : p.value;
          if (isList(cur) && cur.length > 3 && isNum(cur[3])) alpha = cur[3];
        }
        plan.targets.push({ index: l.index, name: l.name, path: copyList(op.path), pkey: canonKey(p), value: [c[0], c[1], c[2], alpha] });
      }
      return plan;
    }

    if (kind === "set_value") {
      for (i = 0; i < layers.length; i++) {
        l = layers[i];
        p = resolveProp(l, op.path);
        var vk = valueKind(p);
        if (vk !== "scalar" && vk !== "vector") {
          fail("bad_args", where + ": \"" + pathText(op.path) + "\" on \"" + l.name + "\" is not a number or vector property" + (vk === "color" ? " (use the color op)" : ""));
        }
        requireWritable(l, p, op.path);
        if (p.numKeys > 0) fail("bad_args", where + ": \"" + pathText(op.path) + "\" on \"" + l.name + "\" has keyframes; use offset, ease or shift_time instead");
        cur = p.value;
        var val = null;
        var given = null;
        if (vk === "scalar") {
          if (!isNum(op.value)) fail("bad_args", where + ": value must be a number for \"" + pathText(op.path) + "\"");
          val = op.value;
          given = val;
        } else {
          if (!isList(op.value) || op.value.length < 2 || op.value.length > cur.length) {
            fail("bad_args", where + ": value must be an array of 2.." + cur.length + " numbers for \"" + pathText(op.path) + "\"");
          }
          given = copyList(op.value);
          for (var vi = 0; vi < given.length; vi++) {
            if (!isNum(given[vi])) fail("bad_args", where + ": value entries must be finite numbers");
          }
          // Dimensions left out keep their value: write and check the whole vector.
          val = copyList(cur);
          for (var vj = 0; vj < given.length; vj++) val[vj] = given[vj];
        }
        checkLimits(p, given, where + " on \"" + l.name + "\"");
        plan.targets.push({ index: l.index, name: l.name, path: copyList(op.path), pkey: canonKey(p), value: val });
      }
      return plan;
    }

    if (kind === "offset") {
      var path = [TRANSFORM, POSITION];
      if (op.path) path = copyList(op.path);
      var delta = op.delta;
      if (!isList(delta) || delta.length < 2 || delta.length > 3) fail("bad_args", where + ": delta must be [dx, dy] or [dx, dy, dz]");
      for (i = 0; i < delta.length; i++) {
        if (!isNum(delta[i])) fail("bad_args", where + ": delta entries must be finite numbers");
      }
      for (i = 0; i < layers.length; i++) {
        l = layers[i];
        p = resolveProp(l, path);
        if (valueKind(p) !== "vector") fail("bad_args", where + ": \"" + pathText(path) + "\" on \"" + l.name + "\" is not a position-like (2D or 3D) property");
        requireWritable(l, p, path);
        var k = 1;
        if (op.cumulative === true) k = i;
        var current = [];
        if (p.numKeys > 0) {
          for (var ki = 1; ki <= p.numKeys; ki++) current.push(copyList(p.keyValue(ki)));
        } else {
          current.push(copyList(p.value));
        }
        if (delta.length > current[0].length) fail("bad_args", where + ": delta has more dimensions than \"" + pathText(path) + "\" on \"" + l.name + "\"");
        var next = [];
        for (var ci = 0; ci < current.length; ci++) {
          var moved = copyList(current[ci]);
          for (var d = 0; d < delta.length; d++) moved[d] = moved[d] + delta[d] * k;
          checkLimits(p, moved, where + " on \"" + l.name + "\"");
          next.push(moved);
        }
        plan.targets.push({ index: l.index, name: l.name, path: path, pkey: canonKey(p), values: next, dims: delta.length });
      }
      return plan;
    }

    if (kind === "ease") {
      checkCurve(op.curve);
      var found = 0;
      for (i = 0; i < layers.length; i++) {
        l = layers[i];
        var paths = [];
        if (op.path) {
          p = resolveProp(l, op.path);
          if (p.numKeys < 2) fail("bad_args", where + ": \"" + pathText(op.path) + "\" on \"" + l.name + "\" needs at least two keyframes");
          paths.push(copyList(op.path));
        } else {
          paths = keyedTransformPaths(l);
        }
        for (var pi = 0; pi < paths.length; pi++) {
          var ep = resolveProp(l, paths[pi]);
          // Text, shape paths, markers and custom values have no number to ease.
          if (valueKind(ep) === null) {
            fail("bad_args", where + ": \"" + pathText(paths[pi]) + "\" on \"" + l.name + "\" is not a number, vector or colour property, so it can't be eased");
          }
          var spatial = false;
          try { spatial = ep.isSpatial === true; } catch (eSp) {}
          if (spatial && (op.curve[1] < 0 || op.curve[3] > 1)) {
            fail("bad_args", where + ": \"" + pathText(paths[pi]) + "\" on \"" + l.name + "\" is spatial, so a curve that overshoots (y1 below 0 or y2 above 1) can't be applied");
          }
          plan.targets.push({ index: l.index, name: l.name, path: paths[pi], pkey: canonKey(ep), curve: copyList(op.curve) });
          found++;
        }
      }
      if (found === 0) fail("bad_args", where + ": none of the layers has an animated transform property with two or more keyframes; give a path");
      return plan;
    }

    fail("bad_args", "Unknown op \"" + kind + "\"");
    return plan;
  }

  // Every op is worked out against the unmodified comp, so two ops on one
  // target would overwrite each other with absolute values. Refuse that.
  function claimTargets(used, plan) {
    var keys = [];
    var j;
    if (plan.op === "comp_duration") {
      keys.push({ key: "comp_duration", what: "the comp duration" });
    } else {
      for (j = 0; j < plan.targets.length; j++) {
        var t = plan.targets[j];
        if (plan.op === "shift_time") {
          keys.push({ key: "start|" + t.index, what: "the start time of \"" + t.name + "\"" });
        } else {
          // An ease only clashes with another ease, or with a colour write that
          // flattens the values its speeds come from. It sits fine beside an offset.
          var what = "\"" + pathText(t.path) + "\" on \"" + t.name + "\"";
          var pk = t.pkey ? t.pkey : copyList(t.path).join(">");
          if (plan.op === "ease") {
            keys.push({ key: "ease|" + t.index + "|" + pk, what: what + " (ease)" });
          } else if (plan.op === "offset") {
            keys.push({ key: "prop|" + t.index + "|" + pk, what: what });
          } else {
            keys.push({ key: "prop|" + t.index + "|" + pk, what: what });
            keys.push({ key: "ease|" + t.index + "|" + pk, what: what });
          }
        }
      }
    }
    for (j = 0; j < keys.length; j++) {
      if (used[keys[j].key] !== undefined) {
        fail("bad_args", "op " + (plan.n + 1) + " (" + plan.op + "): " + keys[j].what + " is already changed by op " + (used[keys[j].key] + 1) + " in this variant; combine them into one op or put them in separate variants");
      }
    }
    for (j = 0; j < keys.length; j++) used[keys[j].key] = plan.n;
  }

  function compileOps(comp, ops) {
    if (!isList(ops) || ops.length === 0) fail("bad_args", "a variant needs at least one op");
    var plans = [];
    var used = {};
    for (var i = 0; i < ops.length; i++) {
      var plan = compileOp(comp, ops[i], i);
      claimTargets(used, plan);
      plans.push(plan);
    }
    return plans;
  }

  // ---------- applying a compiled op to a comp ----------

  function layerAt(comp, t) {
    if (t.index < 1 || t.index > comp.numLayers) fail("mapping", "Layer index " + t.index + " is out of range in comp \"" + comp.name + "\"");
    var l = comp.layer(t.index);
    // Duplicates keep their indexes and names; anything else means the copy isn't 1:1.
    if (l.name !== t.name) fail("mapping", "Layer " + t.index + " in comp \"" + comp.name + "\" is \"" + l.name + "\", not \"" + t.name + "\"");
    return l;
  }

  function easeCopy(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(new KeyframeEase(list[i].speed, list[i].influence));
    return out;
  }

  // How far a segment moves in dimension d (signed), or its straight-line
  // length when AE eases the property as one dimension (spatial).
  function segmentSpan(a, b, d, dims) {
    if (isList(a) && isList(b)) {
      if (dims === 1) {
        var sum = 0;
        for (var i = 0; i < a.length; i++) sum += (b[i] - a[i]) * (b[i] - a[i]);
        return Math.sqrt(sum);
      }
      return b[d] - a[d];
    }
    return b - a;
  }

  function clampInfluence(n) {
    return clamp(n, 0.1, 100);
  }

  // Sets each segment's out ease on its first key and in ease on its last from
  // a cubic-bezier, the way a graph editor reads it. Returns what to expect back.
  function applyEase(p, curve) {
    var n = p.numKeys;
    var spatial = false;
    try { spatial = p.isSpatial === true; } catch (eSp) {}
    var x1 = clamp(curve[0], 0.001, 1);
    var x2 = clamp(curve[2], 0, 0.999);
    var y1 = curve[1];
    var y2 = curve[3];
    var outInfluence = clampInfluence(x1 * 100);
    var inInfluence = clampInfluence((1 - x2) * 100);
    var ins = [];
    var outs = [];
    var changedIn = [];
    var changedOut = [];
    var k;
    var d;
    for (k = 1; k <= n; k++) {
      ins.push(easeCopy(p.keyInTemporalEase(k)));
      outs.push(easeCopy(p.keyOutTemporalEase(k)));
      changedIn.push(false);
      changedOut.push(false);
    }
    for (k = 1; k < n; k++) {
      var dt = p.keyTime(k + 1) - p.keyTime(k);
      if (!(dt > 0)) continue;
      var from = p.keyValue(k);
      var to = p.keyValue(k + 1);
      var dims = outs[k - 1].length;
      for (d = 0; d < dims; d++) {
        var avg = segmentSpan(from, to, d, dims) / dt;
        outs[k - 1][d] = new KeyframeEase((y1 / x1) * avg, outInfluence);
      }
      dims = ins[k].length;
      for (d = 0; d < dims; d++) {
        var avgIn = segmentSpan(from, to, d, dims) / dt;
        ins[k][d] = new KeyframeEase(((1 - y2) / (1 - x2)) * avgIn, inInfluence);
      }
      changedOut[k - 1] = true;
      changedIn[k] = true;
    }
    var expected = [];
    for (k = 1; k <= n; k++) {
      if (!changedIn[k - 1] && !changedOut[k - 1]) continue;
      // Same order as ae_animate's curve path: auto and continuous keys would
      // recompute or average the speeds, and the ease goes on after the
      // interpolation because changing it afterwards can reset the ease.
      try { p.setTemporalAutoBezierAtKey(k, false); } catch (eAuto) {}
      try { p.setTemporalContinuousAtKey(k, false); } catch (eCont) {}
      p.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
      p.setTemporalEaseAtKey(k, ins[k - 1], outs[k - 1]);
      var want = { key: k };
      if (changedIn[k - 1]) {
        want.in_influence = inInfluence;
        // Spatial speeds are approximate along a curved path: only check the others.
        if (!spatial) want.in_speed = ins[k - 1][0].speed;
      }
      if (changedOut[k - 1]) {
        want.out_influence = outInfluence;
        if (!spatial) want.out_speed = outs[k - 1][0].speed;
      }
      expected.push(want);
    }
    return expected;
  }

  // Applies one compiled op. Adds one probe per (op, layer) to `probes` and a
  // line to `changes`.
  function applyPlan(comp, plan, probes, changes) {
    var i;
    var t;
    var l;
    var p;
    var names = [];
    var kind = plan.op;

    if (kind === "comp_duration") {
      comp.duration = plan.to;
      probes.push({ kind: "comp_duration", expected: plan.to });
      changes.push({ op: kind, from: plan.from, to: plan.to });
      return;
    }

    for (i = 0; i < plan.targets.length; i++) {
      t = plan.targets[i];
      l = layerAt(comp, t);
      names.push(t.name);
      if (kind === "shift_time") {
        l.startTime = t.to;
        probes.push({ kind: "start_time", layer_index: t.index, expected: t.to });
      } else if (kind === "color" || kind === "set_value") {
        p = resolveProp(l, t.path);
        var keyed = p.numKeys;
        var expectedValues = [];
        if (keyed > 0) {
          // setValue throws on a keyed property: write every key instead.
          for (var k = 1; k <= keyed; k++) {
            p.setValueAtKey(k, t.value);
            if (k <= MAX_LIST) expectedValues.push(t.value);
          }
        } else {
          p.setValue(t.value);
          expectedValues.push(t.value);
        }
        var valuesProbe = { kind: "values", layer_index: t.index, path: t.path, expected: expectedValues };
        if (keyed > MAX_LIST) valuesProbe.truncated = true;
        probes.push(valuesProbe);
      } else if (kind === "offset") {
        p = resolveProp(l, t.path);
        var count = p.numKeys;
        if (count > 0) {
          if (count !== t.values.length) fail("mapping", "\"" + pathText(t.path) + "\" on \"" + t.name + "\" has " + count + " keys, expected " + t.values.length);
          for (var kk = 1; kk <= count; kk++) p.setValueAtKey(kk, t.values[kk - 1]);
        } else {
          p.setValue(t.values[0]);
        }
        var offsetProbe = { kind: "values", layer_index: t.index, path: t.path, expected: t.values.slice(0, MAX_LIST), dims: t.dims };
        if (t.values.length > MAX_LIST) offsetProbe.truncated = true;
        probes.push(offsetProbe);
      } else if (kind === "ease") {
        p = resolveProp(l, t.path);
        if (p.numKeys < 2) fail("mapping", "\"" + pathText(t.path) + "\" on \"" + t.name + "\" has fewer than two keys");
        var keysWanted = applyEase(p, t.curve);
        var easeProbe = { kind: "ease", layer_index: t.index, path: t.path, keys: keysWanted };
        if (keysWanted.length > MAX_LIST) {
          easeProbe.keys = keysWanted.slice(0, MAX_LIST);
          easeProbe.truncated = true;
        }
        probes.push(easeProbe);
      }
    }
    var line = { op: kind, layers: names };
    if (kind === "shift_time") {
      line.shifts = [];
      for (var s = 0; s < plan.targets.length; s++) {
        line.shifts.push({ layer: plan.targets[s].name, from: plan.targets[s].from, to: plan.targets[s].to });
      }
    }
    if (kind === "ease") line.curve = plan.targets[0].curve;
    changes.push(line);
  }

  // ---------- project housekeeping ----------

  function folderNameOf(args) {
    if (args.folder_name !== undefined && args.folder_name !== null && args.folder_name !== "") return String(args.folder_name);
    return DEFAULT_FOLDER;
  }

  function findFolder(name) {
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it instanceof FolderItem && it.name === name && it.parentFolder === app.project.rootFolder) return it;
    }
    return null;
  }

  function uniqueCompName(base) {
    var taken = {};
    for (var i = 1; i <= app.project.numItems; i++) taken[app.project.item(i).name] = true;
    if (!taken[base]) return base;
    for (var n = 2; n < 10000; n++) {
      if (!taken[base + " " + n]) return base + " " + n;
    }
    return base;
  }

  function inFolder(item, folderName) {
    var f = null;
    try { f = item.parentFolder; } catch (e) { f = null; }
    return !!f && f.name === folderName && f !== app.project.rootFolder;
  }

  // Removes or parks the copies. Only a comp inside the variants folder that
  // no other comp uses is ever removed.
  function cleanupCopies(ids, mode, folderName) {
    var out = { removed: [], parked: [], skipped: [], folder_removed: false };
    var i;
    for (i = 0; i < ids.length; i++) {
      var item = itemById(ids[i]);
      if (!item) {
        out.skipped.push({ comp_id: ids[i], reason: "already gone" });
        continue;
      }
      if (!(item instanceof CompItem) || !inFolder(item, folderName)) {
        out.skipped.push({ comp_id: ids[i], reason: "not a comp in the \"" + folderName + "\" folder, left alone" });
        continue;
      }
      if (mode === "park") {
        out.parked.push(ids[i]);
        continue;
      }
      var used = 0;
      try { used = item.usedIn.length; } catch (eUsed) { used = 0; }
      if (used > 0) {
        out.skipped.push({ comp_id: ids[i], reason: "used in another comp, left alone" });
        continue;
      }
      item.remove();
      out.removed.push(ids[i]);
    }
    if (mode === "delete") {
      var folder = findFolder(folderName);
      if (folder && folder.numItems === 0) {
        folder.remove();
        out.folder_removed = true;
      }
    }
    return out;
  }

  // ---------- reads ----------

  function hash(s) {
    var h1 = 2166136261;
    var h2 = 5381;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0;
      h1 = (h1 + (h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24)) >>> 0;
      h2 = (((h2 << 5) + h2) ^ c) >>> 0;
    }
    return ("00000000" + h1.toString(16)).slice(-8) + ("00000000" + h2.toString(16)).slice(-8) + "-" + s.length;
  }

  function layerLine(l) {
    var s = l.index + "|" + l.name + "|" + l.enabled + "|" + l.inPoint + "|" + l.outPoint + "|" + l.startTime;
    var tg = null;
    try { tg = l.property(TRANSFORM); } catch (e0) { tg = null; }
    if (tg) {
      for (var i = 1; i <= tg.numProperties; i++) {
        var p = null;
        try { p = tg.property(i); } catch (e1) { p = null; }
        if (!p || p.propertyType !== PropertyType.PROPERTY) continue;
        s += "|" + p.matchName + "=" + p.numKeys + ":";
        var exprOn = false;
        try { exprOn = p.expressionEnabled === true; } catch (e3) {}
        if (exprOn) {
          // An expression's value depends on the time indicator: use its text.
          try { s += "expr:" + String(p.expression); } catch (e4) {}
        } else {
          try {
            if (p.numKeys > 0) {
              // Every key's time and value (time-independent), up to a cap.
              for (var kq = 1; kq <= p.numKeys && kq <= 50; kq++) s += "@" + p.keyTime(kq) + "=" + A.stringify(p.keyValue(kq));
            } else {
              s += A.stringify(p.value);
            }
          } catch (e2) {}
        }
      }
    }
    return s;
  }

  // prop.value is the value at the comp's current time, so a keyed or
  // expression-driven leaf must not contribute it: moving the time indicator
  // is not an edit. Keyframes, expression text and static values stay.
  function stripTimeValues(n, depth) {
    if (n === null || n === undefined || typeof n !== "object" || depth > 40) return;
    var i;
    if (isList(n)) {
      for (i = 0; i < n.length; i++) stripTimeValues(n[i], depth + 1);
      return;
    }
    if (n.kind === "property" && (n.numKeys > 0 || n.expressionEnabled === true)) n.value = null;
    for (var key in n) {
      if (Object.prototype.hasOwnProperty.call(n, key)) stripTimeValues(n[key], depth + 1);
    }
  }

  // Something to compare before and after the user chose. The deep
  // fingerprint when its host function is loaded; otherwise the layer stack
  // and its transforms.
  function compDigest(comp) {
    var text = null;
    var basis = "fingerprint";
    var truncated = false;
    if (typeof A.compFingerprint === "function") {
      try {
        var fp = A.compFingerprint({ comp_id: comp.id });
        stripTimeValues(fp, 0);
        text = A.stringify(fp);
        truncated = fp.truncated === true;
      } catch (e0) {
        text = null;
      }
    }
    if (text === null) {
      basis = "layers";
      var parts = [comp.name, comp.width, comp.height, comp.duration, comp.frameRate, comp.numLayers];
      var n = comp.numLayers;
      if (n > MAX_LIST) {
        n = MAX_LIST;
        truncated = true;
      }
      for (var i = 1; i <= n; i++) parts.push(layerLine(comp.layer(i)));
      text = parts.join("\n");
    }
    return { digest: hash(text), basis: basis, truncated: truncated };
  }

  function compInfo(comp) {
    var out = {
      comp_id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      fps: comp.frameRate,
      duration: comp.duration,
      workAreaStart: comp.workAreaStart,
      workAreaDuration: comp.workAreaDuration,
      numLayers: comp.numLayers
    };
    return out;
  }

  // Precomps that would be shared between the original and a copy, and
  // expressions that name another comp: both keep pointing at the original.
  function scanWarnings(comp) {
    var out = { shared_precomps: [], comp_expressions: [], truncated: false };
    var scanned = { count: 0 };
    var n = comp.numLayers;
    if (n > MAX_LIST) {
      n = MAX_LIST;
      out.truncated = true;
    }
    for (var i = 1; i <= n; i++) {
      var l = comp.layer(i);
      var src = null;
      try { src = l.source; } catch (e0) { src = null; }
      if (src && src instanceof CompItem && out.shared_precomps.length < 50) {
        out.shared_precomps.push({ layer_index: i, layer: l.name, source_id: src.id, source: src.name });
      }
      scanExpressions(l, l, i, out, scanned, 0);
      if (scanned.count >= MAX_PROPS_SCANNED) {
        out.truncated = true;
        break;
      }
    }
    return out;
  }

  function scanExpressions(layer, prop, index, out, scanned, depth) {
    if (depth > 6 || scanned.count >= MAX_PROPS_SCANNED) return;
    var count = 0;
    try { count = prop.numProperties; } catch (e0) { count = 0; }
    for (var i = 1; i <= count; i++) {
      var child = null;
      try { child = prop.property(i); } catch (e1) { child = null; }
      if (!child) continue;
      scanned.count++;
      if (child.propertyType === PropertyType.PROPERTY) {
        var on = false;
        try { on = child.expressionEnabled === true; } catch (e2) { on = false; }
        if (on && out.comp_expressions.length < 50) {
          var text = "";
          try { text = String(child.expression); } catch (e3) {}
          if (/comp\s*\(/.test(text)) out.comp_expressions.push({ layer_index: index, layer: layer.name, property: child.name });
        }
      } else {
        scanExpressions(layer, child, index, out, scanned, depth + 1);
      }
    }
  }

  function speedOf(list) {
    if (!isList(list) || list.length === 0) return null;
    return list[0].speed;
  }

  function influenceOf(list) {
    if (!isList(list) || list.length === 0) return null;
    return list[0].influence;
  }

  function interpName(v) {
    if (v === KeyframeInterpolationType.BEZIER) return "bezier";
    if (v === KeyframeInterpolationType.LINEAR) return "linear";
    if (v === KeyframeInterpolationType.HOLD) return "hold";
    return String(v);
  }

  function readProbe(pr) {
    var out = { comp_id: pr.comp_id, kind: pr.kind, layer_index: pr.layer_index, path: pr.path, ok: false };
    try {
      var comp = requireComp(pr.comp_id);
      if (pr.kind === "comp_duration") {
        out.actual = comp.duration;
        out.ok = true;
        return out;
      }
      if (pr.layer_index < 1 || pr.layer_index > comp.numLayers) {
        out.error = "layer index " + pr.layer_index + " out of range";
        return out;
      }
      var layer = comp.layer(pr.layer_index);
      if (pr.kind === "start_time") {
        out.actual = layer.startTime;
        out.ok = true;
        return out;
      }
      var p = resolveProp(layer, pr.path);
      if (pr.kind === "values") {
        var vals = [];
        var n = p.numKeys;
        if (n > 0) {
          for (var k = 1; k <= n && k <= MAX_LIST; k++) vals.push(copyList(isList(p.keyValue(k)) ? p.keyValue(k) : [p.keyValue(k)]));
        } else {
          var v = p.value;
          vals.push(copyList(isList(v) ? v : [v]));
        }
        out.actual = vals;
        out.ok = true;
      } else if (pr.kind === "ease") {
        var keys = [];
        for (var q = 0; q < pr.keys.length && q < MAX_LIST; q++) {
          var key = pr.keys[q].key;
          keys.push({
            key: key,
            in_influence: influenceOf(p.keyInTemporalEase(key)),
            out_influence: influenceOf(p.keyOutTemporalEase(key)),
            in_speed: speedOf(p.keyInTemporalEase(key)),
            out_speed: speedOf(p.keyOutTemporalEase(key)),
            in_interp: interpName(p.keyInInterpolationType(key)),
            out_interp: interpName(p.keyOutInterpolationType(key))
          });
        }
        out.actual = keys;
        out.ok = true;
      } else {
        out.error = "unknown probe kind " + pr.kind;
      }
    } catch (e) {
      out.error = String(e.message || e);
    }
    return out;
  }

  A.variantsRead = function (args) {
    // Without a comp_id (discard) the original is not read: it may be gone.
    var out = { original: null, copies: [], probes: [] };
    if (args.comp_id !== undefined && args.comp_id !== null) {
      var comp = requireComp(args.comp_id);
      out.original = compInfo(comp);
      var d = compDigest(comp);
      out.original.digest = d.digest;
      out.original.digest_basis = d.basis;
      out.original.digest_truncated = d.truncated;
    }
    var folderName = folderNameOf(args);
    var folder = findFolder(folderName);
    out.folder = folder ? { id: folder.id, name: folder.name, numItems: folder.numItems } : null;
    var ids = args.copy_ids;
    var i;
    if (isList(ids)) {
      for (i = 0; i < ids.length && i < MAX_LIST; i++) {
        var item = itemById(ids[i]);
        var entry = { comp_id: ids[i], exists: false };
        if (item && item instanceof CompItem) {
          try {
            entry.exists = true;
            entry.name = item.name;
            entry.numLayers = item.numLayers;
            entry.duration = item.duration;
            entry.in_folder = inFolder(item, folderName);
          } catch (eItem) {
            entry.exists = false;
          }
        }
        out.copies.push(entry);
      }
    }
    var probes = args.probes;
    if (isList(probes)) {
      for (i = 0; i < probes.length && i < MAX_LIST; i++) out.probes.push(readProbe(probes[i]));
      if (probes.length > MAX_LIST) out.probes_truncated = true;
    }
    return out;
  };

  // ---------- plan / create ----------

  function describePlans(plans) {
    var out = [];
    for (var i = 0; i < plans.length; i++) {
      var pl = plans[i];
      var entry = { op: pl.op, layers: [] };
      for (var j = 0; j < pl.targets.length; j++) entry.layers.push(pl.targets[j].name);
      if (pl.op === "comp_duration") {
        entry.from = pl.from;
        entry.to = pl.to;
      }
      out.push(entry);
    }
    return out;
  }

  function planAll(comp, variants) {
    if (!isList(variants) || variants.length < 2 || variants.length > 6) fail("bad_args", "give 2 to 6 variants");
    var seen = {};
    var out = [];
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      if (!v || typeof v.id !== "string" || v.id.length === 0) fail("bad_args", "every variant needs an id");
      if (seen[v.id]) fail("bad_args", "Variant id \"" + v.id + "\" is used twice");
      seen[v.id] = true;
      var plans = null;
      try {
        plans = compileOps(comp, v.ops);
      } catch (e) {
        e.message = "Variant \"" + v.id + "\": " + e.message;
        throw e;
      }
      out.push({ id: v.id, label: v.label, plans: plans });
    }
    return out;
  }

  A.variantsPlan = function (args) {
    var comp = requireComp(args.comp_id);
    var folderName = folderNameOf(args);
    if (inFolder(comp, folderName)) fail("bad_args", "Comp \"" + comp.name + "\" is itself a variant copy; make variants of the original");
    var planned = planAll(comp, args.variants);
    var variants = [];
    for (var i = 0; i < planned.length; i++) {
      variants.push({ id: planned[i].id, label: planned[i].label, changes: describePlans(planned[i].plans) });
    }
    var warnings = scanWarnings(comp);
    return { original: compInfo(comp), folder_name: folderName, variants: variants, warnings: warnings, dry_run: true };
  };

  A.variantsCreate = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var folderName = folderNameOf(args);
    if (inFolder(comp, folderName)) fail("bad_args", "Comp \"" + comp.name + "\" is itself a variant copy; make variants of the original");
    // Every op is checked against the original before anything is duplicated.
    var planned = planAll(comp, args.variants);
    var warnings = scanWarnings(comp);
    // Taken before anything is written, so it is not a stale read.
    var startDigest = compDigest(comp);

    return A.withUndo(args.label || "Chroma AE MCP: variants", function () {
      var folderMade = false;
      var folder = findFolder(folderName);
      if (!folder) {
        folder = app.project.items.addFolder(folderName);
        folderMade = true;
      }
      var made = [];
      var copies = [];
      try {
        for (var i = 0; i < planned.length; i++) {
          var pv = planned[i];
          var copy = comp.duplicate();
          made.push(copy);
          copy.name = uniqueCompName(comp.name + " [" + pv.id + "]");
          copy.parentFolder = folder;
          if (copy.numLayers !== comp.numLayers) {
            fail("mapping", "The duplicate has " + copy.numLayers + " layers, the original " + comp.numLayers + "; layer indexes would not line up");
          }
          var probes = [];
          var changes = [];
          for (var j = 0; j < pv.plans.length; j++) applyPlan(copy, pv.plans[j], probes, changes);
          for (var q = 0; q < probes.length; q++) probes[q].comp_id = copy.id;
          copies.push({
            variant_id: pv.id,
            label: pv.label,
            comp_id: copy.id,
            name: copy.name,
            duration: copy.duration,
            changes: changes,
            probes: probes
          });
        }
      } catch (e) {
        // Take back what this call made, in the same undo group, so a failed
        // call leaves nothing half-built.
        for (var r = made.length - 1; r >= 0; r--) {
          try { made[r].remove(); } catch (eRm) {}
        }
        if (folderMade) {
          try { if (folder.numItems === 0) folder.remove(); } catch (eFo) {}
        }
        throw e;
      }
      var originalInfo = compInfo(comp);
      originalInfo.digest = startDigest.digest;
      originalInfo.digest_basis = startDigest.basis;
      originalInfo.digest_truncated = startDigest.truncated;
      return {
        original: originalInfo,
        folder: { id: folder.id, name: folder.name },
        copies: copies,
        warnings: warnings
      };
    });
  };

  // ---------- promote / discard ----------

  function idList(v) {
    var out = [];
    if (!isList(v)) return out;
    for (var i = 0; i < v.length && i < MAX_LIST; i++) {
      if (isNum(v[i])) out.push(v[i]);
    }
    return out;
  }

  A.variantsPromote = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var folderName = folderNameOf(args);
    var mode = args.cleanup;
    if (mode !== "delete" && mode !== "park") fail("bad_args", "cleanup must be \"delete\" or \"park\"");
    if (inFolder(comp, folderName)) fail("bad_args", "Comp \"" + comp.name + "\" is a variant copy; promote onto the original");
    // The user may have edited while choosing: replaying the spec on a
    // changed comp could land somewhere else, so stop.
    if (args.digest !== undefined && args.digest !== null) {
      var now = compDigest(comp);
      if (now.digest !== args.digest) {
        fail(
          "drift",
          "Comp \"" + comp.name + "\" changed after the variants were made, so the pick was not applied. Make new variants of the current comp.",
          { expected: args.digest, actual: now.digest }
        );
      }
    }
    var plans = compileOps(comp, args.ops);
    var copyIds = idList(args.copy_ids);

    return A.withUndo(args.label || "Chroma AE MCP: apply variant", function () {
      var probes = [];
      var changes = [];
      for (var i = 0; i < plans.length; i++) applyPlan(comp, plans[i], probes, changes);
      for (var q = 0; q < probes.length; q++) probes[q].comp_id = comp.id;
      var cleaned = cleanupCopies(copyIds, mode, folderName);
      // Duration and work area were just written in this script: leave them
      // out, the separate read-back has the real ones.
      return { original: { comp_id: comp.id, name: comp.name, numLayers: comp.numLayers }, changes: changes, probes: probes, cleanup: cleaned };
    });
  };

  A.variantsDiscard = function (args) {
    assertGuard(args.expect);
    var mode = args.cleanup;
    if (mode !== "delete" && mode !== "park") fail("bad_args", "cleanup must be \"delete\" or \"park\"");
    var folderName = folderNameOf(args);
    var copyIds = idList(args.copy_ids);
    return A.withUndo(args.label || "Chroma AE MCP: discard variants", function () {
      return { cleanup: cleanupCopies(copyIds, mode, folderName) };
    });
  };
})($.global);
