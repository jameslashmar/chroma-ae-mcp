// panel/host/ext/paths.jsx
//
// Host functions for the path tools:
// - pathsRead (read): one shape or mask path as vertices and tangents, with its
//   keys, expression and (masks) feather points
// - pathsOperators (read): a shape group's contents, with Trim Paths, Offset
//   Paths and Repeater values and keys
// - pathsLinkState (read): a target path and its link source, side by side
// - pathsConnectorState (read): layer count, the two endpoint layers and the
//   connector layer's path
// - pathsApply (guarded write): write a Shape into a path, as a value or as a
//   key at a time; the new path is computed on the server
// - pathsOperator (guarded write): add Trim Paths (with a draw-on preset),
//   Offset Paths or a Repeater (or a two-Repeater grid) to a shape group
// - pathsLink (guarded write): link a path to another by expression, or unlink
// - pathsConnector (guarded write): a shape layer whose path follows two layers
//
// Only free paths ('ADBE Vector Shape - Group') and masks have a path to read
// or write; rectangle, ellipse and star shapes are parametric and are refused.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Everything that can fail is checked before A.withUndo; the few steps that
//   can only be checked once an operator exists take it back out again inside
//   the same undo group.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_POINTS = 500;
  var MAX_KEYS = 500;
  var MAX_ITEMS = 200;
  var MAX_STRING = 20000;

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

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function has(v) {
    return v !== undefined && v !== null;
  }

  function isShapeLayer(l) {
    try {
      return String(l.reflect.name) === "ShapeLayer";
    } catch (e) {
      return false;
    }
  }

  function layerInfo(l) {
    return { index: l.index, id: l.id, name: l.name };
  }

  function truncateString(s) {
    s = String(s);
    if (s.length > MAX_STRING) return s.substring(0, MAX_STRING) + " ...[truncated]";
    return s;
  }

  // "26.2.1" >= (17, 1, 1)
  function versionAtLeast(major, minor, patch) {
    var parts = String(app.version).split(".");
    var have = [parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10)];
    var want = [major, minor, patch];
    for (var i = 0; i < 3; i++) {
      var h = have[i];
      if (isNaN(h)) h = 0;
      if (h > want[i]) return true;
      if (h < want[i]) return false;
    }
    return true;
  }

  // ---------- resolving a path ----------

  // Position of a child by 1-based index or by a name only one child has.
  function pickIndex(group, sel, what) {
    var i;
    if (has(sel.index)) {
      if (sel.index < 1 || sel.index > group.numProperties) fail("not_found", what + " index " + sel.index + " out of range (1.." + group.numProperties + ")");
      return sel.index;
    }
    if (has(sel.name)) {
      var hits = 0;
      var at = -1;
      for (i = 1; i <= group.numProperties; i++) {
        if (group.property(i).name === sel.name) {
          hits++;
          at = i;
        }
      }
      if (hits === 0) fail("not_found", "No " + what + " named \"" + sel.name + "\"");
      if (hits > 1) fail("bad_args", hits + " items are named \"" + sel.name + "\"; select by index");
      return at;
    }
    fail("bad_args", what + " selector needs index or name");
    return -1;
  }

  function countNamed(group, name) {
    var n = 0;
    for (var i = 1; i <= group.numProperties; i++) {
      if (group.property(i).name === name) n++;
    }
    return n;
  }

  function indexesWith(group, matchName) {
    var out = [];
    for (var i = 1; i <= group.numProperties; i++) {
      if (group.property(i).matchName === matchName) out.push(i);
    }
    return out;
  }

  function rootOf(layer) {
    var r = null;
    try {
      r = layer.property("ADBE Root Vectors Group");
    } catch (e) {
      r = null;
    }
    if (!r) fail("bad_args", "\"" + layer.name + "\" has no shape contents");
    return r;
  }

  function vectorsOf(layer, groupIndex) {
    return rootOf(layer).property(groupIndex).property("ADBE Vectors Group");
  }

  // The group a selector names in a shape layer's top-level contents. Without
  // a selector the layer's only group.
  function resolveGroup(layer, sel) {
    if (!isShapeLayer(layer)) fail("bad_args", "\"" + layer.name + "\" is not a shape layer");
    var root = rootOf(layer);
    var gi;
    if (sel) {
      gi = pickIndex(root, sel, "Group");
    } else {
      var groups = indexesWith(root, "ADBE Vector Group");
      if (groups.length !== 1) fail("bad_args", "\"" + layer.name + "\" has " + groups.length + " groups; name the group (index or name)");
      gi = groups[0];
    }
    if (root.property(gi).matchName !== "ADBE Vector Group") {
      fail("bad_args", "Content " + gi + " (\"" + root.property(gi).name + "\") is not a group");
    }
    return gi;
  }

  // ref: { layer, mask: {index|name} } or { layer, shape: {group?, path?} }.
  // Returns the Path property with the names an expression needs.
  function resolveTarget(comp, ref) {
    if (!ref || !ref.layer) fail("bad_args", "A path target needs a layer");
    var layer = findLayer(comp, ref.layer);
    var hasMask = has(ref.mask);
    var hasShape = has(ref.shape);
    if (hasMask === hasShape) fail("bad_args", "Give exactly one of mask or shape for the path target");
    var t = { layer: layer, kind: "", prop: null, maskName: null, groupIndex: 0, groupName: null, pathIndex: 0, pathName: null };
    if (hasMask) {
      var parade = null;
      try {
        parade = layer.property("ADBE Mask Parade");
      } catch (e0) {
        parade = null;
      }
      if (!parade) fail("bad_args", "\"" + layer.name + "\" can't hold masks");
      var mi = pickIndex(parade, ref.mask, "Mask");
      var mask = parade.property(mi);
      var mprop = mask.property("ADBE Mask Shape");
      if (!mprop) fail("bad_args", "Mask " + mi + " has no mask path");
      t.kind = "mask";
      t.prop = mprop;
      t.maskIndex = mi;
      t.maskName = mask.name;
      return t;
    }
    var gi = resolveGroup(layer, ref.shape.group);
    var group = rootOf(layer).property(gi);
    var vectors = group.property("ADBE Vectors Group");
    var pi;
    if (has(ref.shape.path)) {
      pi = pickIndex(vectors, ref.shape.path, "Path");
    } else {
      var paths = indexesWith(vectors, "ADBE Vector Shape - Group");
      if (paths.length !== 1) fail("bad_args", "Group \"" + group.name + "\" has " + paths.length + " free paths; name the path (shape.path)");
      pi = paths[0];
    }
    var item = vectors.property(pi);
    if (item.matchName !== "ADBE Vector Shape - Group") {
      fail("bad_args", "Content " + pi + " of group \"" + group.name + "\" (\"" + item.name + "\") is not a free path; rectangle, ellipse and star shapes have no vertices to read or write");
    }
    var sprop = item.property("ADBE Vector Shape");
    if (!sprop) fail("bad_args", "Path \"" + item.name + "\" has no path property");
    t.kind = "shape";
    t.prop = sprop;
    t.groupIndex = gi;
    t.groupName = group.name;
    t.pathIndex = pi;
    t.pathName = item.name;
    return t;
  }

  function targetInfo(t) {
    var out = { kind: t.kind, layer: layerInfo(t.layer) };
    if (t.kind === "mask") {
      out.mask = { index: t.maskIndex, name: t.maskName };
    } else {
      out.group = { index: t.groupIndex, name: t.groupName };
      out.path_item = { index: t.pathIndex, name: t.pathName };
    }
    return out;
  }

  // ---------- reading a path ----------

  function featherPoints(v) {
    try {
      if (v.featherSegLocs && typeof v.featherSegLocs.length === "number") return v.featherSegLocs.length;
    } catch (e) {}
    return 0;
  }

  function pairList(list, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var p = null;
      try {
        p = list[i];
      } catch (e) {
        p = null;
      }
      if (p) out.push([p[0], p[1]]);
      else out.push([0, 0]);
    }
    return out;
  }

  function serialisePath(v) {
    var total = 0;
    try {
      total = v.vertices.length;
    } catch (e) {}
    var n = total;
    var truncated = false;
    if (n > MAX_POINTS) {
      n = MAX_POINTS;
      truncated = true;
    }
    var closed = true;
    try {
      closed = v.closed === true;
    } catch (e1) {}
    return {
      closed: closed,
      vertexCount: total,
      vertices: pairList(v.vertices, n),
      inTangents: pairList(v.inTangents, n),
      outTangents: pairList(v.outTangents, n),
      truncated: truncated
    };
  }

  function readValue(prop, comp, time) {
    if (has(time)) return prop.valueAtTime(time, false);
    if (prop.numKeys > 0) return prop.valueAtTime(comp.time, false);
    return prop.value;
  }

  function expressionInfo(prop) {
    var out = { enabled: false, text: "", error: "" };
    try {
      out.enabled = prop.expressionEnabled === true;
    } catch (e0) {}
    try {
      out.text = truncateString(prop.expression);
    } catch (e1) {}
    try {
      if (prop.expressionError) out.error = truncateString(prop.expressionError);
    } catch (e2) {}
    return out;
  }

  function readTarget(comp, t, time) {
    var prop = t.prop;
    var v = readValue(prop, comp, time);
    var out = targetInfo(t);
    out.path = serialisePath(v);
    out.feather_points = featherPoints(v);
    out.numKeys = prop.numKeys;
    out.key_times = [];
    for (var k = 1; k <= prop.numKeys && k <= MAX_KEYS; k++) out.key_times.push(prop.keyTime(k));
    out.key_times_truncated = prop.numKeys > MAX_KEYS;
    if (has(time) || prop.numKeys > 0) {
      out.time = time;
      if (!has(time)) out.time = comp.time;
    }
    out.expression = expressionInfo(prop);
    // 1 = normal, 3 = reversed; the match name is 'ADBE Vector Shape Direction'.
    if (t.kind === "shape") {
      try {
        var dirProp = prop.parentProperty.property("ADBE Vector Shape Direction");
        if (dirProp) out.direction = dirProp.value;
      } catch (e3) {}
    }
    return out;
  }

  A.pathsRead = function (args) {
    var comp = requireComp(args.comp_id);
    var t = resolveTarget(comp, args.target);
    if (has(args.time) && !isNum(args.time)) fail("bad_args", "time must be a number of seconds");
    return readTarget(comp, t, args.time);
  };

  // ---------- reading a group's operators ----------

  function numberOf(group, matchNames) {
    for (var i = 0; i < matchNames.length; i++) {
      try {
        var p = group.property(matchNames[i]);
        if (p) {
          var v = p.value;
          if (typeof v === "number") return v;
          if (v && typeof v.length === "number") return [v[0], v[1]];
        }
      } catch (e) {}
    }
    return null;
  }

  function keyTimesOf(group, matchName) {
    var out = [];
    try {
      var p = group.property(matchName);
      if (p) {
        for (var k = 1; k <= p.numKeys && out.length < 20; k++) out.push(p.keyTime(k));
      }
    } catch (e) {}
    return out;
  }

  function keyValuesOf(group, matchName) {
    var out = [];
    try {
      var p = group.property(matchName);
      if (p) {
        for (var k = 1; k <= p.numKeys && out.length < 20; k++) out.push(p.keyValue(k));
      }
    } catch (e) {}
    return out;
  }

  var OP_KIND = {
    "ADBE Vector Filter - Trim": "trim",
    "ADBE Vector Filter - Offset": "offset",
    "ADBE Vector Filter - Repeater": "repeater",
    "ADBE Vector Shape - Group": "path",
    "ADBE Vector Shape - Rect": "rect",
    "ADBE Vector Shape - Ellipse": "ellipse",
    "ADBE Vector Shape - Star": "star",
    "ADBE Vector Graphic - Fill": "fill",
    "ADBE Vector Graphic - Stroke": "stroke",
    "ADBE Vector Group": "group"
  };

  function describeOperator(item, i) {
    var kind = OP_KIND[item.matchName];
    if (!kind) kind = "other";
    var d = { index: i, name: item.name, matchName: item.matchName, kind: kind };
    var c;
    if (kind === "trim") {
      d.start = numberOf(item, ["ADBE Vector Trim Start"]);
      d.end = numberOf(item, ["ADBE Vector Trim End"]);
      d.offset = numberOf(item, ["ADBE Vector Trim Offset"]);
      d.trim_type = numberOf(item, ["ADBE Vector Trim Type"]);
      d.start_key_times = keyTimesOf(item, "ADBE Vector Trim Start");
      d.end_key_times = keyTimesOf(item, "ADBE Vector Trim End");
      d.start_key_values = keyValuesOf(item, "ADBE Vector Trim Start");
      d.end_key_values = keyValuesOf(item, "ADBE Vector Trim End");
    } else if (kind === "offset") {
      d.amount = numberOf(item, ["ADBE Vector Offset Amount"]);
      d.line_join = numberOf(item, ["ADBE Vector Offset Line Join"]);
      d.miter_limit = numberOf(item, ["ADBE Vector Offset Miter Limit"]);
      d.copies = numberOf(item, ["ADBE Vector Offset Copies"]);
      d.copy_offset = numberOf(item, ["ADBE Vector Offset Copy Offset"]);
    } else if (kind === "repeater") {
      d.copies = numberOf(item, ["ADBE Vector Repeater Copies"]);
      d.offset = numberOf(item, ["ADBE Vector Repeater Offset"]);
      d.order = numberOf(item, ["ADBE Vector Repeater Order"]);
      d.transform = [];
      try {
        var tr = item.property("ADBE Vector Repeater Transform");
        for (c = 1; c <= tr.numProperties && d.transform.length < 20; c++) {
          var cp = tr.property(c);
          var cv = null;
          try {
            cv = numberOf(tr, [cp.matchName]);
          } catch (eV) {}
          d.transform.push({ name: cp.name, matchName: cp.matchName, value: cv });
        }
      } catch (eT) {}
    }
    return d;
  }

  A.pathsOperators = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var gi = resolveGroup(layer, args.group);
    var group = rootOf(layer).property(gi);
    var vectors = group.property("ADBE Vectors Group");
    var out = { layer: layerInfo(layer), group: { index: gi, name: group.name }, count: vectors.numProperties, items: [], truncated: false };
    for (var i = 1; i <= vectors.numProperties; i++) {
      if (out.items.length >= MAX_ITEMS) {
        out.truncated = true;
        break;
      }
      out.items.push(describeOperator(vectors.property(i), i));
    }
    return out;
  };

  // ---------- writing a path ----------

  var FEATHER_FIELDS = ["featherSegLocs", "featherRelSegLocs", "featherRadii", "featherInterps", "featherTensions", "featherTypes", "featherRelCornerAngles"];

  // Checks a path from the server; returns nothing, throws bad_args.
  function checkPathData(p) {
    if (!p || typeof p.length === "number") fail("bad_args", "path must be an object with vertices");
    var vs = p.vertices;
    if (!vs || typeof vs.length !== "number" || vs.length < 2) fail("bad_args", "A path needs at least 2 vertices");
    if (vs.length > MAX_POINTS) fail("bad_args", "At most " + MAX_POINTS + " vertices per path");
    var lists = [vs, p.inTangents, p.outTangents];
    for (var l = 0; l < lists.length; l++) {
      var list = lists[l];
      if (!list || typeof list.length !== "number" || list.length !== vs.length) fail("bad_args", "vertices, inTangents and outTangents need one [x, y] each, all the same length");
      for (var i = 0; i < list.length; i++) {
        var pt = list[i];
        if (!pt || typeof pt.length !== "number" || pt.length !== 2 || !isNum(pt[0]) || !isNum(pt[1])) fail("bad_args", "Point " + (i + 1) + " is not a finite [x, y]");
      }
    }
    if (typeof p.closed !== "boolean") fail("bad_args", "closed must be true or false");
  }

  function checksumOf(shape) {
    var sum = 0;
    var lists = [shape.vertices, shape.inTangents, shape.outTangents];
    for (var l = 0; l < lists.length; l++) {
      for (var i = 0; i < lists[l].length; i++) {
        sum = sum + lists[l][i][0] * (1 + (i % 7)) + lists[l][i][1] * (2 + (i % 5));
      }
    }
    return Math.round(sum * 1000) / 1000;
  }

  function shapeFrom(p, current, keepFeather) {
    var s = new Shape();
    s.vertices = p.vertices;
    s.inTangents = p.inTangents;
    s.outTangents = p.outTangents;
    s.closed = p.closed;
    if (keepFeather) {
      for (var f = 0; f < FEATHER_FIELDS.length; f++) {
        try {
          if (current[FEATHER_FIELDS[f]] !== undefined) s[FEATHER_FIELDS[f]] = current[FEATHER_FIELDS[f]];
        } catch (e) {}
      }
    }
    return s;
  }

  A.pathsApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var t = resolveTarget(comp, args.target);
    var prop = t.prop;
    var p = args.path;
    checkPathData(p);
    var timed = has(args.time);
    if (timed && !isNum(args.time)) fail("bad_args", "time must be a number of seconds");
    var exp = expressionInfo(prop);
    if (exp.enabled) {
      fail("bad_args", "The path has an expression, which overrides any value written here; remove it first (ae_path_link with unlink)");
    }
    var keyed = prop.numKeys > 0;
    if (keyed && !timed) {
      fail("bad_args", "The path is keyframed (" + prop.numKeys + " keys); give `time` to write a key at that time");
    }
    var current = readValue(prop, comp, args.time);
    var cur = serialisePath(current);
    if (cur.truncated) fail("bad_args", "The current path has more than " + MAX_POINTS + " vertices and can't be checked; edit it with ae_set_property");
    if (has(args.base)) {
      var curSum = checksumOf(cur);
      if (cur.vertexCount !== args.base.count || Math.abs(curSum - args.base.checksum) > 0.01) {
        fail("conflict", "The path changed since it was read (" + cur.vertexCount + " vertices now, " + args.base.count + " when read); read it again", {
          expected: args.base,
          actual: { count: cur.vertexCount, checksum: curSum }
        });
      }
    }
    var newCount = p.vertices.length;
    var countChanges = newCount !== cur.vertexCount;
    if (keyed) {
      // The other keys keep their vertex count; a different one breaks the morph between keys.
      var firstKey = serialisePath(prop.keyValue(1));
      if (firstKey.vertexCount !== newCount && args.allow_vertex_count_change !== true) {
        fail("bad_args", "The path's keys have " + firstKey.vertexCount + " vertices and this has " + newCount + ", which breaks the morph between keys; match the count or pass allow_vertex_count_change");
      }
    }
    if (countChanges && featherPoints(current) > 0 && args.allow_feather_loss !== true) {
      fail("bad_args", "The mask has " + featherPoints(current) + " feather points that belong to its current vertices; changing the vertex count would leave them on the wrong segments. Pass allow_feather_loss to clear them");
    }
    // Feather points sit on segment indexes, so they only stay right when the
    // segments keep their order: a plain write or a mirror. Any other operation
    // (reverse, resample, smooth) can keep the count and still move the segments.
    var op = args.operation;
    var keepsOrder = !has(op) || op === "set" || op === "mirror";
    // A mirror with reverse_direction also reverses the vertex order.
    if (args.reorders === true) keepsOrder = false;
    var featherN = featherPoints(current);
    if (featherN > 0 && !countChanges && !keepsOrder && args.allow_feather_loss !== true) {
      fail("bad_args", "The mask has " + featherN + " feather points that belong to its current segments; '" + op + "' changes which segment is which. Pass allow_feather_loss to clear them");
    }
    var shape = shapeFrom(p, current, !countChanges && keepsOrder);

    return A.withUndo(args.label || "Write path", function () {
      var out = targetInfo(t);
      out.previous_vertex_count = cur.vertexCount;
      out.vertex_count = newCount;
      out.closed = p.closed;
      out.wrote = "value";
      if (!timed) {
        prop.setValue(shape);
        return out;
      }
      out.wrote = "key";
      out.time = args.time;
      // A key at this time keeps its interpolation and ease if AE replaces it in place;
      // put them back afterwards in case it doesn't.
      var saved = null;
      if (keyed) {
        var near = prop.nearestKeyIndex(args.time);
        if (Math.abs(prop.keyTime(near) - args.time) < 0.0005) {
          saved = { inI: prop.keyInInterpolationType(near), outI: prop.keyOutInterpolationType(near), inE: prop.keyInTemporalEase(near), outE: prop.keyOutTemporalEase(near) };
        }
      }
      prop.setValueAtTime(args.time, shape);
      out.replaced_key = saved !== null;
      if (saved) {
        var at = prop.nearestKeyIndex(args.time);
        try {
          prop.setInterpolationTypeAtKey(at, saved.inI, saved.outI);
          prop.setTemporalEaseAtKey(at, saved.inE, saved.outE);
          out.ease_restored = true;
        } catch (eEase) {
          out.ease_restored = false;
        }
      }
      return out;
    });
  };

  // ---------- operators ----------

  // The first property of a group found under any of these names or match names.
  function child(group, names) {
    for (var i = 0; i < names.length; i++) {
      var p = null;
      try {
        p = group.property(names[i]);
      } catch (e) {
        p = null;
      }
      if (p) return p;
    }
    return null;
  }

  function inRange(v, lo, hi) {
    return isNum(v) && v >= lo && v <= hi;
  }

  function point2(v) {
    return v && typeof v.length === "number" && v.length === 2 && isNum(v[0]) && isNum(v[1]);
  }

  var LINE_JOIN = { miter: 1, round: 2, bevel: 3 };
  var TRIM_TYPE = { simultaneously: 1, individually: 2 };
  var REPEATER_ORDER = { above: 1, below: 2 };

  function checkTrim(s) {
    if (has(s.start) && !inRange(s.start, 0, 100)) fail("bad_args", "trim.start must be 0..100");
    if (has(s.end) && !inRange(s.end, 0, 100)) fail("bad_args", "trim.end must be 0..100");
    if (has(s.offset) && !inRange(s.offset, -100000, 100000)) fail("bad_args", "trim.offset must be a number of degrees");
    if (has(s.type) && !has(TRIM_TYPE[s.type])) fail("bad_args", "trim.type must be simultaneously or individually");
    if (has(s.draw_on)) {
      var d = s.draw_on;
      if (has(s.start) || has(s.end)) fail("bad_args", "draw_on animates Start or End; don't also set trim.start or trim.end");
      if (!isNum(d.start_time) || d.start_time < 0) fail("bad_args", "draw_on.start_time must be seconds >= 0");
      if (!isNum(d.duration) || d.duration <= 0) fail("bad_args", "draw_on.duration must be seconds > 0");
      if (d.direction !== undefined && d.direction !== "forward" && d.direction !== "reverse" && d.direction !== "center") fail("bad_args", "draw_on.direction must be forward, reverse or center");
      if (d.ease !== undefined && d.ease !== "easy" && d.ease !== "linear") fail("bad_args", "draw_on.ease must be easy or linear");
    }
  }

  function checkOffset(s) {
    if (has(s.amount) && !inRange(s.amount, -100000, 100000)) fail("bad_args", "offset.amount must be a number");
    if (has(s.line_join) && !has(LINE_JOIN[s.line_join])) fail("bad_args", "offset.line_join must be miter, round or bevel");
    if (has(s.miter_limit) && !inRange(s.miter_limit, 1, 100)) fail("bad_args", "offset.miter_limit must be 1..100");
    if (has(s.copies)) {
      if (!inRange(s.copies, 1, 100) || Math.floor(s.copies) !== s.copies) fail("bad_args", "offset.copies must be a whole number 1..100");
      if (!versionAtLeast(17, 1, 1)) fail("bad_args", "Offset Paths Copies need After Effects 17.1.1 or later");
    }
    if (has(s.copy_offset)) {
      if (!inRange(s.copy_offset, -100000, 100000)) fail("bad_args", "offset.copy_offset must be a number");
      if (!versionAtLeast(17, 1, 1)) fail("bad_args", "Offset Paths Copy Offset needs After Effects 17.1.1 or later");
    }
  }

  function checkRepeater(s) {
    if (has(s.copies) && (!inRange(s.copies, 0, 500) || Math.floor(s.copies) !== s.copies)) fail("bad_args", "repeater.copies must be a whole number 0..500");
    if (has(s.offset) && !inRange(s.offset, -100000, 100000)) fail("bad_args", "repeater.offset must be a number");
    if (has(s.order) && !has(REPEATER_ORDER[s.order])) fail("bad_args", "repeater.order must be below or above");
    if (has(s.position) && !point2(s.position)) fail("bad_args", "repeater.position must be [x, y]");
    if (has(s.scale) && !point2(s.scale)) fail("bad_args", "repeater.scale must be [x, y] in percent");
    if (has(s.anchor) && !point2(s.anchor)) fail("bad_args", "repeater.anchor must be [x, y]");
    if (has(s.rotation) && !inRange(s.rotation, -100000, 100000)) fail("bad_args", "repeater.rotation must be degrees");
    if (has(s.start_opacity) && !inRange(s.start_opacity, 0, 100)) fail("bad_args", "repeater.start_opacity must be 0..100");
    if (has(s.end_opacity) && !inRange(s.end_opacity, 0, 100)) fail("bad_args", "repeater.end_opacity must be 0..100");
    if (has(s.grid)) {
      var g = s.grid;
      if (has(s.copies) || has(s.position)) fail("bad_args", "grid sets the copies and position itself; don't also set repeater.copies or repeater.position");
      if (!inRange(g.columns, 1, 500) || Math.floor(g.columns) !== g.columns) fail("bad_args", "grid.columns must be a whole number 1..500");
      if (!inRange(g.rows, 1, 500) || Math.floor(g.rows) !== g.rows) fail("bad_args", "grid.rows must be a whole number 1..500");
      if (g.columns * g.rows > 10000) fail("bad_args", "A grid of more than 10000 cells would freeze After Effects");
      if (!point2(g.spacing)) fail("bad_args", "grid.spacing must be [dx, dy]");
    }
  }

  // Sets a property by the first name that exists; fails (and so rolls the
  // operator back) when none does.
  function setNamed(group, names, value, what) {
    var p = child(group, names);
    if (!p) fail("bad_args", what + " was not found on the new operator (looked for " + names.join(", ") + ")");
    p.setValue(value);
    return p;
  }

  // Adds an operator at the end of a group's contents and returns its index.
  // Adding invalidates references to its siblings, so the caller looks the
  // operator up again by index each time it needs it.
  var pathsAdded = [];

  function addOperator(layer, gi, matchName, name) {
    var vectors = vectorsOf(layer, gi);
    var known = {};
    var i;
    for (i = 1; i <= vectors.numProperties; i++) {
      if (vectors.property(i).matchName === matchName) known[vectors.property(i).name] = true;
    }
    var before = vectors.numProperties;
    vectors.addProperty(matchName);
    vectors = vectorsOf(layer, gi);
    var at = vectors.numProperties;
    if (vectors.numProperties !== before + 1) fail("bad_args", "AE did not add " + matchName);
    for (i = 1; i <= vectors.numProperties; i++) {
      var it = vectors.property(i);
      if (it.matchName === matchName && !known[it.name]) {
        at = i;
        break;
      }
    }
    // Operators act on what is above them, so they go last.
    if (at !== vectors.numProperties) {
      try {
        vectors.property(at).moveTo(vectors.numProperties);
        at = vectors.numProperties;
      } catch (eMove) {}
    }
    // Remember exactly which items are ours, for the rollback. An item inserted
    // above an earlier one pushes that one down.
    for (var tr = 0; tr < pathsAdded.length; tr++) {
      if (pathsAdded[tr] >= at) pathsAdded[tr] = pathsAdded[tr] + 1;
    }
    pathsAdded.push(at);
    if (has(name)) vectorsOf(layer, gi).property(at).name = name;
    return at;
  }

  function easeKeys(prop, ease) {
    if (ease !== "easy") return true;
    try {
      for (var k = 1; k <= prop.numKeys; k++) {
        prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER);
        prop.setTemporalEaseAtKey(k, [new KeyframeEase(0, 33.333333)], [new KeyframeEase(0, 33.333333)]);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function applyTrim(layer, gi, at, s, out) {
    var op = function () { return vectorsOf(layer, gi).property(at); };
    if (has(s.type)) setNamed(op(), ["ADBE Vector Trim Type"], TRIM_TYPE[s.type], "Trim Multiple Shapes");
    if (has(s.start)) setNamed(op(), ["ADBE Vector Trim Start"], s.start, "Trim Start");
    if (has(s.end)) setNamed(op(), ["ADBE Vector Trim End"], s.end, "Trim End");
    if (has(s.offset)) setNamed(op(), ["ADBE Vector Trim Offset"], s.offset, "Trim Offset");
    if (!has(s.draw_on)) return;
    var d = s.draw_on;
    var t0 = d.start_time;
    var t1 = d.start_time + d.duration;
    var dir = d.direction;
    if (!has(dir)) dir = "forward";
    var ease = d.ease;
    if (!has(ease)) ease = "easy";
    var startProp;
    var endProp;
    if (dir === "forward") {
      endProp = child(op(), ["ADBE Vector Trim End"]);
      if (!endProp) fail("bad_args", "Trim End was not found on the new operator");
      endProp.setValueAtTime(t0, 0);
      endProp.setValueAtTime(t1, 100);
      out.eased = easeKeys(child(op(), ["ADBE Vector Trim End"]), ease);
    } else if (dir === "reverse") {
      startProp = child(op(), ["ADBE Vector Trim Start"]);
      if (!startProp) fail("bad_args", "Trim Start was not found on the new operator");
      setNamed(op(), ["ADBE Vector Trim End"], 100, "Trim End");
      child(op(), ["ADBE Vector Trim Start"]).setValueAtTime(t0, 100);
      child(op(), ["ADBE Vector Trim Start"]).setValueAtTime(t1, 0);
      out.eased = easeKeys(child(op(), ["ADBE Vector Trim Start"]), ease);
    } else {
      startProp = child(op(), ["ADBE Vector Trim Start"]);
      endProp = child(op(), ["ADBE Vector Trim End"]);
      if (!startProp || !endProp) fail("bad_args", "Trim Start or End was not found on the new operator");
      startProp.setValueAtTime(t0, 50);
      child(op(), ["ADBE Vector Trim Start"]).setValueAtTime(t1, 0);
      child(op(), ["ADBE Vector Trim End"]).setValueAtTime(t0, 50);
      child(op(), ["ADBE Vector Trim End"]).setValueAtTime(t1, 100);
      var okStart = easeKeys(child(op(), ["ADBE Vector Trim Start"]), ease);
      var okEnd = easeKeys(child(op(), ["ADBE Vector Trim End"]), ease);
      out.eased = okStart && okEnd;
    }
    out.draw_on = { start_time: t0, end_time: t1, direction: dir, ease: ease };
  }

  function applyOffset(layer, gi, at, s) {
    var op = function () { return vectorsOf(layer, gi).property(at); };
    if (has(s.amount)) setNamed(op(), ["ADBE Vector Offset Amount"], s.amount, "Offset Amount");
    if (has(s.line_join)) setNamed(op(), ["ADBE Vector Offset Line Join"], LINE_JOIN[s.line_join], "Offset Line Join");
    if (has(s.miter_limit)) setNamed(op(), ["ADBE Vector Offset Miter Limit"], s.miter_limit, "Offset Miter Limit");
    if (has(s.copies)) setNamed(op(), ["ADBE Vector Offset Copies"], s.copies, "Offset Copies");
    if (has(s.copy_offset)) setNamed(op(), ["ADBE Vector Offset Copy Offset"], s.copy_offset, "Offset Copy Offset");
  }

  // The Transform group's children aren't in the Scripting Guide, so try the
  // match names seen in AE and then the display names, and report what the
  // group really holds.
  var REPEATER_CHILD = {
    anchor: ["ADBE Vector Repeater Anchor", "Anchor Point"],
    position: ["ADBE Vector Repeater Position", "Position"],
    scale: ["ADBE Vector Repeater Scale", "Scale"],
    rotation: ["ADBE Vector Repeater Rotation", "Rotation"],
    start_opacity: ["ADBE Vector Repeater Opacity 1", "Start Opacity"],
    end_opacity: ["ADBE Vector Repeater Opacity 2", "End Opacity"]
  };

  function repeaterTransform(layer, gi, at) {
    var tr = null;
    try {
      tr = vectorsOf(layer, gi).property(at).property("ADBE Vector Repeater Transform");
    } catch (e) {
      tr = null;
    }
    if (!tr) fail("bad_args", "The Repeater has no Transform group");
    return tr;
  }

  function applyRepeater(layer, gi, at, s, out) {
    var op = function () { return vectorsOf(layer, gi).property(at); };
    if (has(s.copies)) setNamed(op(), ["ADBE Vector Repeater Copies"], s.copies, "Repeater Copies");
    if (has(s.offset)) setNamed(op(), ["ADBE Vector Repeater Offset"], s.offset, "Repeater Offset");
    if (has(s.order)) {
      setNamed(op(), ["ADBE Vector Repeater Order"], REPEATER_ORDER[s.order], "Repeater Order");
      out.order_mapping = "unverified: above=1, below=2 (Lottie's Composite order); the read-back cannot tell the two apart, so check the stacking in AE";
    }
    var keys = ["anchor", "position", "scale", "rotation", "start_opacity", "end_opacity"];
    for (var k = 0; k < keys.length; k++) {
      if (has(s[keys[k]])) {
        setNamed(repeaterTransform(layer, gi, at), REPEATER_CHILD[keys[k]], s[keys[k]], "Repeater " + keys[k]);
      }
    }
    // What the Transform group holds on this AE, for anyone who needs the names.
    var tr = repeaterTransform(layer, gi, at);
    out.transform_children = [];
    for (var c = 1; c <= tr.numProperties && out.transform_children.length < 20; c++) {
      out.transform_children.push({ name: tr.property(c).name, matchName: tr.property(c).matchName });
    }
  }

  A.pathsOperator = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var gi = resolveGroup(layer, args.group);
    var op = args.operator;
    var spec;
    if (op === "trim") {
      spec = args.trim || {};
      checkTrim(spec);
    } else if (op === "offset") {
      spec = args.offset || {};
      checkOffset(spec);
    } else if (op === "repeater") {
      spec = args.repeater || {};
      checkRepeater(spec);
    } else {
      fail("bad_args", "operator must be trim, offset or repeater");
    }
    if (has(args.name) && (typeof args.name !== "string" || args.name.length < 1 || args.name.length > 200)) fail("bad_args", "name must be 1..200 characters");

    return A.withUndo(args.label || "Add path operator", function () {
      var group = rootOf(layer).property(gi);
      var startCount = group.property("ADBE Vectors Group").numProperties;
      var out = { layer: layerInfo(layer), group: { index: gi, name: group.name }, operator: op, added: [] };
      pathsAdded = [];
      try {
        if (op === "trim") {
          var ti = addOperator(layer, gi, "ADBE Vector Filter - Trim", args.name);
          applyTrim(layer, gi, ti, spec, out);
          out.added.push({ index: ti, name: vectorsOf(layer, gi).property(ti).name, matchName: "ADBE Vector Filter - Trim" });
        } else if (op === "offset") {
          var oi = addOperator(layer, gi, "ADBE Vector Filter - Offset", args.name);
          applyOffset(layer, gi, oi, spec);
          out.added.push({ index: oi, name: vectorsOf(layer, gi).property(oi).name, matchName: "ADBE Vector Filter - Offset" });
        } else if (has(spec.grid)) {
          // A grid is two Repeaters: copies along X, then that whole row along Y.
          var base = args.name;
          var nameX = null;
          var nameY = null;
          if (has(base)) {
            nameX = base + " X";
            nameY = base + " Y";
          }
          var xi = addOperator(layer, gi, "ADBE Vector Filter - Repeater", nameX);
          var specX = { copies: spec.grid.columns, position: [spec.grid.spacing[0], 0], offset: spec.offset, order: spec.order, anchor: spec.anchor, scale: spec.scale, rotation: spec.rotation, start_opacity: spec.start_opacity, end_opacity: spec.end_opacity };
          applyRepeater(layer, gi, xi, specX, out);
          out.added.push({ index: xi, name: vectorsOf(layer, gi).property(xi).name, matchName: "ADBE Vector Filter - Repeater", role: "columns" });
          var yi = addOperator(layer, gi, "ADBE Vector Filter - Repeater", nameY);
          var specY = { copies: spec.grid.rows, position: [0, spec.grid.spacing[1]], order: spec.order };
          applyRepeater(layer, gi, yi, specY, out);
          out.added.push({ index: yi, name: vectorsOf(layer, gi).property(yi).name, matchName: "ADBE Vector Filter - Repeater", role: "rows" });
        } else {
          var ri = addOperator(layer, gi, "ADBE Vector Filter - Repeater", args.name);
          applyRepeater(layer, gi, ri, spec, out);
          out.added.push({ index: ri, name: vectorsOf(layer, gi).property(ri).name, matchName: "ADBE Vector Filter - Repeater" });
        }
      } catch (eAdd) {
        // Take back whatever was added so a failed call leaves the group as it was.
        try {
          // Remove only the operators this call added, highest index first.
          var mine = pathsAdded.slice(0).sort(function (a, b) { return b - a; });
          for (var rm = 0; rm < mine.length; rm++) {
            vectorsOf(layer, gi).property(mine[rm]).remove();
          }
        } catch (eRm) {}
        throw eAdd;
      }
      out.count = vectorsOf(layer, gi).numProperties;
      return out;
    });
  };

  // ---------- links ----------

  // ExtendScript string literal for a name in an expression.
  function quote(s) {
    var t = String(s);
    t = t.split("\\").join("\\\\");
    t = t.split("\"").join("\\\"");
    t = t.split("\r").join("\\r");
    t = t.split("\n").join("\\n");
    return "\"" + t + "\"";
  }

  function layerExpr(comp, layer) {
    if (countNamed2(comp, layer.name) !== 1) {
      fail("bad_args", "More than one layer is named \"" + layer.name + "\"; an expression finds layers by name, so rename one first");
    }
    return "thisComp.layer(" + quote(layer.name) + ")";
  }

  function countNamed2(comp, name) {
    var n = 0;
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).name === name) n++;
    }
    return n;
  }

  // The expression text that points at a resolved path.
  function pathExpr(comp, t) {
    var text = layerExpr(comp, t.layer);
    if (t.kind === "mask") {
      if (countNamed(t.layer.property("ADBE Mask Parade"), t.maskName) !== 1) fail("bad_args", "More than one mask is named \"" + t.maskName + "\"; rename one first");
      return text + ".mask(" + quote(t.maskName) + ").maskPath";
    }
    var root = rootOf(t.layer);
    if (countNamed(root, t.groupName) !== 1) fail("bad_args", "More than one group is named \"" + t.groupName + "\"; rename one first");
    if (countNamed(root.property(t.groupIndex).property("ADBE Vectors Group"), t.pathName) !== 1) fail("bad_args", "More than one item is named \"" + t.pathName + "\" in the group; rename one first");
    return text + ".content(" + quote(t.groupName) + ").content(" + quote(t.pathName) + ").path";
  }

  A.pathsLinkState = function (args) {
    var comp = requireComp(args.comp_id);
    var t = resolveTarget(comp, args.target);
    var out = { target: readTarget(comp, t, args.time), source: null };
    if (has(args.source)) {
      var s = resolveTarget(comp, args.source);
      out.source = readTarget(comp, s, args.time);
    }
    return out;
  };

  A.pathsLink = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var t = resolveTarget(comp, args.target);
    var prop = t.prop;
    var before = expressionInfo(prop);
    var out = targetInfo(t);
    out.previous_expression = before.text;

    if (args.unlink === true) {
      if (!before.enabled && before.text === "") fail("bad_args", "The path has no expression to remove");
      var bake = args.bake === true;
      if (bake && prop.numKeys > 0) fail("bad_args", "bake writes a static value, but the path is keyframed; unlink without bake");
      var evaluated = null;
      var keepFeather = false;
      var droppedFeather = 0;
      var staticValue = null;
      if (bake) {
        evaluated = serialisePath(prop.value);
        if (evaluated.truncated) fail("bad_args", "The path has more than " + MAX_POINTS + " vertices; unlink without bake");
        // The path under the expression, read before anything changes.
        try {
          staticValue = prop.valueAtTime(comp.time, true);
        } catch (eStatic) {
          staticValue = null;
        }
        var staticFeather = 0;
        if (staticValue) staticFeather = featherPoints(staticValue);
        if (staticFeather > 0) {
          var staticCount = 0;
          try {
            staticCount = staticValue.vertices.length;
          } catch (eSc) {}
          if (staticCount === evaluated.vertexCount) {
            keepFeather = true;
          } else if (args.allow_feather_loss !== true) {
            fail("bad_args", "The path under the expression has " + staticFeather + " feather points on " + staticCount + " vertices, but the linked path has " + evaluated.vertexCount + "; baking would leave them on the wrong segments. Pass allow_feather_loss to bake without them");
          } else {
            droppedFeather = staticFeather;
          }
        }
        if (!keepFeather) staticValue = null;
      }
      return A.withUndo(args.label || "Unlink path", function () {
        prop.expression = "";
        try {
          prop.expressionEnabled = false;
        } catch (eEn) {}
        out.unlinked = true;
        out.baked = false;
        if (bake) {
          try {
            prop.setValue(shapeFrom(evaluated, staticValue, keepFeather));
          } catch (eBake) {
            // Put the expression back so a failed bake isn't a half-done unlink.
            try {
              prop.expression = before.text;
              prop.expressionEnabled = before.enabled;
            } catch (eBack) {}
            throw eBake;
          }
          out.baked = true;
          out.vertex_count = evaluated.vertexCount;
          out.feather_kept = keepFeather;
          out.feather_dropped = droppedFeather;
        }
        return out;
      });
    }

    if (!has(args.source)) fail("bad_args", "Give the source path to link to");
    var s = resolveTarget(comp, args.source);
    if (s.prop === t.prop || (s.layer.id === t.layer.id && s.kind === t.kind && s.maskIndex === t.maskIndex && s.groupIndex === t.groupIndex && s.pathIndex === t.pathIndex)) {
      fail("bad_args", "A path can't be linked to itself");
    }
    if (has(args.time_offset) && !isNum(args.time_offset)) fail("bad_args", "time_offset must be seconds");
    var canSet = true;
    try {
      canSet = prop.canSetExpression !== false;
    } catch (eCs) {}
    if (!canSet) fail("bad_args", "This path can't take an expression");
    var text = pathExpr(comp, s);
    if (has(args.time_offset) && args.time_offset !== 0) {
      text = text + ".valueAtTime(time - " + args.time_offset + ")";
    }
    return A.withUndo(args.label || "Link path", function () {
      prop.expression = text;
      prop.expressionEnabled = true;
      out.expression = text;
      out.source = targetInfo(s);
      return out;
    });
  };

  // ---------- connector ----------

  function connectorPoint(pt) {
    if (!has(pt)) return "anchorPoint";
    return "[" + pt[0] + ", " + pt[1] + "]";
  }

  function connectorExpression(fromLayerExpr, toLayerExpr, fromPt, toPt, style, curve) {
    var lines = [];
    lines.push("var a = " + fromLayerExpr + ";");
    lines.push("var b = " + toLayerExpr + ";");
    lines.push("var ca = a.toComp(" + (has(fromPt) ? connectorPoint(fromPt) : "a.anchorPoint") + ");");
    lines.push("var cb = b.toComp(" + (has(toPt) ? connectorPoint(toPt) : "b.anchorPoint") + ");");
    // toComp gives [x, y, z] for a 3D layer; the connector is 2D.
    lines.push("var p1 = fromComp([ca[0], ca[1]]);");
    lines.push("var p2 = fromComp([cb[0], cb[1]]);");
    if (style === "curve_h") {
      lines.push("var h = (p2[0] - p1[0]) * " + curve + ";");
      lines.push("createPath([p1, p2], [[0, 0], [-h, 0]], [[h, 0], [0, 0]], false);");
    } else if (style === "curve_v") {
      lines.push("var h = (p2[1] - p1[1]) * " + curve + ";");
      lines.push("createPath([p1, p2], [[0, 0], [0, -h]], [[0, h], [0, 0]], false);");
    } else {
      lines.push("createPath([p1, p2], [[0, 0], [0, 0]], [[0, 0], [0, 0]], false);");
    }
    return lines.join("\n");
  }

  function endpointLayer(comp, sel, what) {
    var l = findLayer(comp, sel.layer);
    var kind = "";
    try {
      kind = String(l.reflect.name);
    } catch (e) {}
    if (kind === "CameraLayer" || kind === "LightLayer") fail("bad_args", "The " + what + " layer \"" + l.name + "\" is a " + kind + "; a connector follows AV layers");
    if (has(sel.point) && !point2(sel.point)) fail("bad_args", what + ".point must be [x, y] in the layer's own space");
    return l;
  }

  A.pathsConnectorState = function (args) {
    var comp = requireComp(args.comp_id);
    var out = { num_layers: comp.numLayers, from: null, to: null, connector: null };
    if (has(args.from_id)) {
      try {
        out.from = layerInfo(findLayer(comp, { id: args.from_id }));
      } catch (e0) {}
    }
    if (has(args.to_id)) {
      try {
        out.to = layerInfo(findLayer(comp, { id: args.to_id }));
      } catch (e1) {}
    }
    if (has(args.layer_id)) {
      var layer = findLayer(comp, { id: args.layer_id });
      var t = resolveTarget(comp, { layer: { id: args.layer_id }, shape: { group: { index: 1 }, path: { index: 1 } } });
      out.connector = readTarget(comp, t, args.time);
      out.connector.layer_position = null;
      try {
        out.connector.layer_position = [layer.property("ADBE Transform Group").property("ADBE Position").value[0], layer.property("ADBE Transform Group").property("ADBE Position").value[1]];
      } catch (e2) {}
    }
    return out;
  };

  A.pathsConnector = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var from = endpointLayer(comp, args.from, "from");
    var to = endpointLayer(comp, args.to, "to");
    if (from.id === to.id) fail("bad_args", "A connector needs two different layers");
    var style = args.style;
    if (!has(style)) style = "straight";
    if (style !== "straight" && style !== "curve_h" && style !== "curve_v") fail("bad_args", "style must be straight, curve_h or curve_v");
    var curve = 0.5;
    if (has(args.curve)) {
      if (!inRange(args.curve, -5, 5)) fail("bad_args", "curve must be a number -5..5");
      curve = args.curve;
    }
    var width = 4;
    if (has(args.width)) {
      if (!inRange(args.width, 0, 1000)) fail("bad_args", "width must be 0..1000");
      width = args.width;
    }
    var color = [1, 1, 1];
    if (has(args.color)) {
      if (typeof args.color.length !== "number" || args.color.length !== 3) fail("bad_args", "color must be [r, g, b]");
      for (var ci = 0; ci < 3; ci++) {
        if (!inRange(args.color[ci], 0, 1)) fail("bad_args", "color values must be numbers in 0..1");
      }
      color = [args.color[0], args.color[1], args.color[2]];
    }
    var name = args.name;
    if (!has(name)) name = "Connector " + from.name + " - " + to.name;
    if (typeof name !== "string" || name.length < 1) fail("bad_args", "name must be 1..200 characters");
    if (name.length > 200) {
      if (has(args.name)) fail("bad_args", "name must be 1..200 characters");
      fail("bad_args", "The default connector name (\"Connector <from> - <to>\") is " + name.length + " characters, over the 200 limit; give a shorter name");
    }
    // The connector's expressions find the endpoints by name, and later name-based
    // selectors need every name to be unique, so the name must be new in this comp.
    if (countNamed2(comp, name) > 0) fail("bad_args", "A layer named \"" + name + "\" already exists in the comp; give the connector another name");
    var text = connectorExpression(layerExpr(comp, from), layerExpr(comp, to), args.from.point, args.to.point, style, curve);
    var behind = args.behind !== false;
    var lowest = from;
    if (to.index > from.index) lowest = to;

    return A.withUndo(args.label || "Create connector", function () {
      var layer = comp.layers.addShape();
      try {
        layer.name = name;
        var root = rootOf(layer);
        root.addProperty("ADBE Vector Group");
        var gi = root.numProperties;
        rootOf(layer).property(gi).name = "Connector";
        vectorsOf(layer, gi).addProperty("ADBE Vector Shape - Group");
        vectorsOf(layer, gi).addProperty("ADBE Vector Graphic - Stroke");
        var vectors = vectorsOf(layer, gi);
        var pathItem = null;
        var strokeItem = null;
        for (var i = 1; i <= vectors.numProperties; i++) {
          if (vectors.property(i).matchName === "ADBE Vector Shape - Group") pathItem = vectors.property(i);
          if (vectors.property(i).matchName === "ADBE Vector Graphic - Stroke") strokeItem = vectors.property(i);
        }
        if (!pathItem || !strokeItem) fail("bad_args", "AE did not add the path or stroke");
        var pathProp = pathItem.property("ADBE Vector Shape");
        pathProp.expression = text;
        pathProp.expressionEnabled = true;
        strokeItem.property("ADBE Vector Stroke Color").setValue([color[0], color[1], color[2], 1]);
        strokeItem.property("ADBE Vector Stroke Width").setValue(width);
        if (behind) layer.moveAfter(lowest);
      } catch (eMake) {
        try {
          layer.remove();
        } catch (eRm) {}
        throw eMake;
      }
      var res = { layer: layerInfo(layer), from: layerInfo(from), to: layerInfo(to), style: style, expression: text };
      return res;
    });
  };
})($.global);
