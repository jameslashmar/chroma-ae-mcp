// panel/host/ext/shapes.jsx
//
// Host functions for the shape tool:
// - shapeContents (read): a shape layer's top-level contents, each group's
//   shapes, fills and strokes (caps, joins, dashes, taper, wave, gradients)
//   with their main values
// - shapeEdit (guarded write): add groups (rectangle, ellipse, star, polygon
//   or a free path, with fill, stroke, gradient fill or gradient stroke),
//   remove top-level contents, duplicate them, or move them in the stack
//
// Adding a property invalidates references to its siblings (as with
// effects), so every step looks its target up again from the layer.
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

  var MAX_ITEMS = 200;

  function fail(kind, message, extra) {
    var e = new Error(message);
    e.__kind = kind;
    if (extra) {
      if (extra.actual !== undefined) e.__actual = extra.actual;
      if (extra.expected !== undefined) e.__expected = extra.expected;
    }
    throw e;
  }

  function has(v) {
    return v !== undefined && v !== null;
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

  function shapeLayer(comp, sel) {
    var l = findLayer(comp, sel);
    var isShape = false;
    try { isShape = String(l.reflect.name) === "ShapeLayer"; } catch (e) {}
    if (!isShape) fail("bad_args", "\"" + l.name + "\" is not a shape layer (create one with ae_create_layer type 'shape')");
    return l;
  }

  function contentsOf(layer) {
    return layer.property("ADBE Root Vectors Group");
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

  function val(group, matchName) {
    try {
      var p = group.property(matchName);
      if (!p) return null;
      var v = p.value;
      if (v instanceof Array) {
        var out = [];
        for (var i = 0; i < v.length; i++) out.push(v[i]);
        return out;
      }
      if (typeof v === "number" || typeof v === "boolean") return v;
      return null;
    } catch (e) {
      return null;
    }
  }

  var KIND_BY_MATCH = {
    "ADBE Vector Shape - Rect": "rect",
    "ADBE Vector Shape - Ellipse": "ellipse",
    "ADBE Vector Shape - Star": "star",
    "ADBE Vector Shape - Group": "path",
    "ADBE Vector Graphic - Fill": "fill",
    "ADBE Vector Graphic - Stroke": "stroke",
    "ADBE Vector Graphic - G-Fill": "gradient_fill",
    "ADBE Vector Graphic - G-Stroke": "gradient_stroke",
    "ADBE Vector Group": "group"
  };

  var DASH_NAMES = [
    "ADBE Vector Stroke Dash 1", "ADBE Vector Stroke Gap 1",
    "ADBE Vector Stroke Dash 2", "ADBE Vector Stroke Gap 2",
    "ADBE Vector Stroke Dash 3", "ADBE Vector Stroke Gap 3"
  ];
  var TAPER_FIELDS = {
    start_length: "ADBE Vector Taper Start Length",
    end_length: "ADBE Vector Taper End Length",
    start_width: "ADBE Vector Taper Start Width",
    end_width: "ADBE Vector Taper End Width",
    start_ease: "ADBE Vector Taper Start Ease",
    end_ease: "ADBE Vector Taper End Ease"
  };
  var WAVE_FIELDS = {
    amount: "ADBE Vector Taper Wave Amount",
    wavelength: "ADBE Vector Taper Wavelength",
    phase: "ADBE Vector Taper Wave Phase"
  };
  var LINE_CAP = { butt: 1, round: 2, projecting: 3 };
  var LINE_JOIN = { miter: 1, round: 2, bevel: 3 };
  var FILL_RULE = { non_zero: 1, even_odd: 2 };
  var GRAD_TYPE = { linear: 1, radial: 2 };

  function readFields(group, fields) {
    var out = {};
    for (var k in fields) {
      if (fields.hasOwnProperty(k)) out[k] = val(group, fields[k]);
    }
    return out;
  }

  function strokeChildAdded(c) {
    try {
      return c.canSetExpression !== false;
    } catch (e) {
      return true;
    }
  }

  function describeStrokeDetails(p, d) {
    d.line_cap = val(p, "ADBE Vector Stroke Line Cap");
    d.line_join = val(p, "ADBE Vector Stroke Line Join");
    d.miter_limit = val(p, "ADBE Vector Stroke Miter Limit");
    try {
      var dg = p.property("ADBE Vector Stroke Dashes");
      if (dg) {
        // AE 26 lists every Dash, Gap and Offset child of a stroke whether it was
        // added or not (a solid stroke still shows 7 children: 10, 10, ... and 0).
        // Only the added ones answer canSetExpression with true (seen live), so
        // the others are left out and a solid stroke reads back with no dashes.
        d.dashes = [];
        for (var i = 1; i <= dg.numProperties && i <= 8; i++) {
          var dc = dg.property(i);
          if (!strokeChildAdded(dc)) continue;
          d.dashes.push({ matchName: dc.matchName, value: val(dg, dc.matchName) });
        }
      }
    } catch (eD) {}
    try {
      var tp = p.property("ADBE Vector Stroke Taper");
      if (tp) d.taper = readFields(tp, TAPER_FIELDS);
    } catch (eT) {}
    try {
      var wv = p.property("ADBE Vector Stroke Wave");
      if (wv) d.wave = readFields(wv, WAVE_FIELDS);
    } catch (eW) {}
  }

  function describeGradient(p, d) {
    d.gradient_type = val(p, "ADBE Vector Grad Type");
    d.start_point = val(p, "ADBE Vector Grad Start Pt");
    d.end_point = val(p, "ADBE Vector Grad End Pt");
    d.highlight_length = val(p, "ADBE Vector Grad HiLite Length");
    d.highlight_angle = val(p, "ADBE Vector Grad HiLite Angle");
  }

  function describeItem(p) {
    var kind = KIND_BY_MATCH[p.matchName];
    if (!kind) kind = "other";
    var d = { name: p.name, matchName: p.matchName, kind: kind };
    if (kind === "rect") {
      d.size = val(p, "ADBE Vector Rect Size");
      d.position = val(p, "ADBE Vector Rect Position");
      d.roundness = val(p, "ADBE Vector Rect Roundness");
    } else if (kind === "ellipse") {
      d.size = val(p, "ADBE Vector Ellipse Size");
      d.position = val(p, "ADBE Vector Ellipse Position");
    } else if (kind === "star") {
      var t = val(p, "ADBE Vector Star Type");
      d.star_kind = "star";
      if (t === 2) d.star_kind = "polygon";
      d.points = val(p, "ADBE Vector Star Points");
      d.outer_radius = val(p, "ADBE Vector Star Outer Radius");
      d.inner_radius = val(p, "ADBE Vector Star Inner Radius");
    } else if (kind === "path") {
      try {
        var sh = p.property("ADBE Vector Shape").value;
        d.vertices = sh.vertices.length;
        d.closed = sh.closed;
      } catch (eShape) {}
    } else if (kind === "fill") {
      d.color = val(p, "ADBE Vector Fill Color");
      d.opacity = val(p, "ADBE Vector Fill Opacity");
      d.rule = val(p, "ADBE Vector Fill Rule");
    } else if (kind === "stroke") {
      d.color = val(p, "ADBE Vector Stroke Color");
      d.width = val(p, "ADBE Vector Stroke Width");
      d.opacity = val(p, "ADBE Vector Stroke Opacity");
      describeStrokeDetails(p, d);
    } else if (kind === "gradient_fill") {
      describeGradient(p, d);
      d.opacity = val(p, "ADBE Vector Fill Opacity");
      d.rule = val(p, "ADBE Vector Fill Rule");
    } else if (kind === "gradient_stroke") {
      describeGradient(p, d);
      d.width = val(p, "ADBE Vector Stroke Width");
      d.opacity = val(p, "ADBE Vector Stroke Opacity");
      describeStrokeDetails(p, d);
    } else if (kind === "group") {
      var items = [];
      try {
        var vectors = p.property("ADBE Vectors Group");
        for (var i = 1; i <= vectors.numProperties && items.length < MAX_ITEMS; i++) items.push(describeItem(vectors.property(i)));
      } catch (eGroup) {}
      d.items = items;
      try { d.group_position = val(p.property("ADBE Vector Transform Group"), "ADBE Vector Position"); } catch (eT) {}
    }
    return d;
  }

  A.shapeContents = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = shapeLayer(comp, args.layer);
    var contents = contentsOf(layer);
    var out = { layer: { index: layer.index, id: layer.id, name: layer.name }, count: contents.numProperties, contents: [], truncated: false };
    for (var i = 1; i <= contents.numProperties; i++) {
      if (out.contents.length >= MAX_ITEMS) {
        out.truncated = true;
        break;
      }
      var d = describeItem(contents.property(i));
      d.index = i;
      out.contents.push(d);
    }
    return out;
  };

  function setIf(group, matchName, v) {
    if (v === undefined || v === null) return;
    var p = group.property(matchName);
    if (!p) fail("bad_args", "No " + matchName + " in " + group.name);
    p.setValue(v);
  }

  function color3(c) {
    if (!c) return null;
    var a = 1;
    if (c.length > 3) a = c[3];
    return [c[0], c[1], c[2], a];
  }

  // ---------- checks that run before the undo group opens ----------

  function needsTaperOrWave(s) {
    var st = s.stroke;
    var gs = s.gradient_stroke;
    return !!((st && (st.taper || st.wave)) || (gs && (gs.taper || gs.wave)));
  }

  function checkStrokeDetails(st, what) {
    if (!st) return;
    if (has(st.line_cap) && !has(LINE_CAP[st.line_cap])) fail("bad_args", what + ".line_cap must be butt, round or projecting");
    if (has(st.line_join) && !has(LINE_JOIN[st.line_join])) fail("bad_args", what + ".line_join must be miter, round or bevel");
    if (has(st.dashes)) {
      if (!(st.dashes instanceof Array) || st.dashes.length < 1 || st.dashes.length > 3) fail("bad_args", what + ".dashes needs 1 to 3 {dash, gap} pairs");
      for (var i = 0; i < st.dashes.length; i++) {
        var dg = st.dashes[i];
        if (!dg || typeof dg.dash !== "number" || typeof dg.gap !== "number" || dg.dash < 0 || dg.gap < 0) {
          fail("bad_args", what + ".dashes[" + i + "] needs dash and gap as numbers >= 0");
        }
      }
    }
    if (has(st.dash_offset) && !has(st.dashes)) fail("bad_args", what + ".dash_offset goes with dashes");
    // Known hard limits of AE's taper (percentages 0..100), checked here so a bad value never reaches the undo group.
    if (has(st.taper)) {
      for (var tk in TAPER_FIELDS) {
        if (TAPER_FIELDS.hasOwnProperty(tk) && has(st.taper[tk]) && (typeof st.taper[tk] !== "number" || st.taper[tk] < 0 || st.taper[tk] > 100)) {
          fail("bad_args", what + ".taper." + tk + " must be a number 0..100 (percent)");
        }
      }
    }
    if (has(st.wave)) {
      for (var wk in WAVE_FIELDS) {
        if (WAVE_FIELDS.hasOwnProperty(wk) && has(st.wave[wk]) && typeof st.wave[wk] !== "number") fail("bad_args", what + ".wave." + wk + " must be a number");
      }
    }
    if (has(st.miter_limit) && (typeof st.miter_limit !== "number" || st.miter_limit < 1)) fail("bad_args", what + ".miter_limit must be a number >= 1");
  }

  function checkSpec(s, n) {
    var what = "shape " + n;
    if (has(s.stroke) && has(s.gradient_stroke)) fail("bad_args", what + ": give stroke or gradient_stroke, not both");
    if (has(s.fill) && has(s.gradient_fill)) fail("bad_args", what + ": give fill or gradient_fill, not both");
    checkStrokeDetails(s.stroke, what + ".stroke");
    checkStrokeDetails(s.gradient_stroke, what + ".gradient_stroke");
    if (has(s.fill) && has(s.fill.rule) && !has(FILL_RULE[s.fill.rule])) fail("bad_args", what + ".fill.rule must be non_zero or even_odd");
    if (has(s.gradient_fill) && has(s.gradient_fill.rule) && !has(FILL_RULE[s.gradient_fill.rule])) fail("bad_args", what + ".gradient_fill.rule must be non_zero or even_odd");
    var gr = [s.gradient_fill, s.gradient_stroke];
    for (var g = 0; g < gr.length; g++) {
      if (gr[g] && !has(GRAD_TYPE[gr[g].type])) fail("bad_args", what + ": gradient type must be linear or radial");
      if (gr[g] && has(gr[g].highlight_length) && (typeof gr[g].highlight_length !== "number" || gr[g].highlight_length < -100 || gr[g].highlight_length > 100)) {
        fail("bad_args", what + ": highlight_length must be a number -100..100 (percent)");
      }
    }
    if (needsTaperOrWave(s) && !versionAtLeast(17, 1, 1)) {
      fail("bad_args", what + ": stroke taper and wave need After Effects 17.1.1 or later (this is " + app.version + ")");
    }
  }

  // ---------- adding items ----------

  // Adds an item at the end of a group's contents and returns its index.
  function addVectorItem(layer, gi, matchName) {
    var vs = contentsOf(layer).property(gi).property("ADBE Vectors Group");
    var before = vs.numProperties;
    vs.addProperty(matchName);
    vs = contentsOf(layer).property(gi).property("ADBE Vectors Group");
    if (vs.numProperties !== before + 1) fail("bad_args", "AE did not add " + matchName);
    var at = vs.numProperties;
    if (vs.property(at).matchName !== matchName) {
      at = -1;
      for (var i = vs.numProperties; i >= 1; i--) {
        if (vs.property(i).matchName === matchName) {
          at = i;
          break;
        }
      }
      if (at < 0) fail("bad_args", "AE did not add " + matchName);
    }
    return at;
  }

  function itemAt(layer, gi, si) {
    return contentsOf(layer).property(gi).property("ADBE Vectors Group").property(si);
  }

  function isHiddenError(e) {
    var t = "";
    try { t = String(e.message); } catch (e1) { t = String(e); }
    return /hidden/i.test(t);
  }

  // Writes one child of a stroke's sub-group (Dashes, Taper, Wave). In AE 26 a
  // new stroke already lists every Dash, Gap and Offset child but keeps the ones
  // not added yet hidden, and setValue on a hidden property throws "the property
  // or a parent property is hidden". So a child that is missing, or refuses the
  // write because it is hidden, is added to its group (what the + button does)
  // and looked up again from the layer before the write is tried once more.
  function setStrokeChild(layer, gi, si, groupMatch, childMatch, value, what) {
    var grp = itemAt(layer, gi, si).property(groupMatch);
    if (!grp) fail("bad_args", what + " group " + groupMatch + " is missing (needs After Effects 17.1.1 or later)");
    var prop = grp.property(childMatch);
    var added = false;
    if (!prop) {
      if (!grp.canAddProperty(childMatch)) fail("bad_args", "AE cannot add " + childMatch + " to the stroke's " + groupMatch);
      grp.addProperty(childMatch);
      added = true;
      prop = itemAt(layer, gi, si).property(groupMatch).property(childMatch);
      if (!prop) fail("bad_args", childMatch + " is missing after it was added");
    }
    try {
      prop.setValue(value);
    } catch (eSet) {
      if (added || !isHiddenError(eSet)) throw eSet;
      grp = itemAt(layer, gi, si).property(groupMatch);
      if (!grp.canAddProperty(childMatch)) fail("bad_args", childMatch + " is hidden in the stroke's " + groupMatch + " and AE will not add it: " + A.formatError(eSet));
      grp.addProperty(childMatch);
      prop = itemAt(layer, gi, si).property(groupMatch).property(childMatch);
      if (!prop) fail("bad_args", childMatch + " is missing after it was added");
      prop.setValue(value);
    }
  }

  function setGroupFields(layer, gi, si, groupMatch, fields, spec, what) {
    for (var k in fields) {
      if (fields.hasOwnProperty(k) && has(spec[k])) {
        setStrokeChild(layer, gi, si, groupMatch, fields[k], spec[k], what);
      }
    }
  }

  // Dashes are written one child at a time; every add invalidates the
  // siblings, so the stroke is looked up again from the layer each time.
  function applyDashes(layer, gi, si, dashes, offset) {
    var wanted = [];
    var values = [];
    var i;
    for (i = 0; i < dashes.length; i++) {
      wanted.push(DASH_NAMES[i * 2]);
      values.push(dashes[i].dash);
      wanted.push(DASH_NAMES[i * 2 + 1]);
      values.push(dashes[i].gap);
    }
    if (has(offset)) {
      wanted.push("ADBE Vector Stroke Offset");
      values.push(offset);
    }
    for (i = 0; i < wanted.length; i++) {
      setStrokeChild(layer, gi, si, "ADBE Vector Stroke Dashes", wanted[i], values[i], "Stroke dashes");
    }
  }

  function applyStrokeDetails(layer, gi, si, st) {
    var item = itemAt(layer, gi, si);
    if (has(st.line_cap)) setIf(item, "ADBE Vector Stroke Line Cap", LINE_CAP[st.line_cap]);
    if (has(st.line_join)) setIf(itemAt(layer, gi, si), "ADBE Vector Stroke Line Join", LINE_JOIN[st.line_join]);
    if (has(st.miter_limit)) setIf(itemAt(layer, gi, si), "ADBE Vector Stroke Miter Limit", st.miter_limit);
    if (has(st.dashes)) applyDashes(layer, gi, si, st.dashes, st.dash_offset);
    if (has(st.taper)) setGroupFields(layer, gi, si, "ADBE Vector Stroke Taper", TAPER_FIELDS, st.taper, "Stroke taper");
    if (has(st.wave)) setGroupFields(layer, gi, si, "ADBE Vector Stroke Wave", WAVE_FIELDS, st.wave, "Stroke wave");
  }

  function applyGradient(layer, gi, si, g) {
    var item = itemAt(layer, gi, si);
    setIf(item, "ADBE Vector Grad Type", GRAD_TYPE[g.type]);
    setIf(itemAt(layer, gi, si), "ADBE Vector Grad Start Pt", g.start_point);
    setIf(itemAt(layer, gi, si), "ADBE Vector Grad End Pt", g.end_point);
    setIf(itemAt(layer, gi, si), "ADBE Vector Grad HiLite Length", g.highlight_length);
    setIf(itemAt(layer, gi, si), "ADBE Vector Grad HiLite Angle", g.highlight_angle);
  }

  // Adds one group with its shape, fill and stroke. Returns the group's index.
  function addGroup(layer, spec, n) {
    var contents = contentsOf(layer);
    contents.addProperty("ADBE Vector Group");
    var gi = contents.numProperties;
    pendingGroups.push(gi);
    var name = spec.name;
    if (!name) name = spec.type + " " + n;
    contentsOf(layer).property(gi).name = name;
    var made = { index: gi, name: name };
    var shapeMatch = null;
    if (spec.type === "rect") shapeMatch = "ADBE Vector Shape - Rect";
    else if (spec.type === "ellipse") shapeMatch = "ADBE Vector Shape - Ellipse";
    else if (spec.type === "star" || spec.type === "polygon") shapeMatch = "ADBE Vector Shape - Star";
    else if (spec.type === "path") shapeMatch = "ADBE Vector Shape - Group";
    else fail("bad_args", "Unknown shape type \"" + spec.type + "\"");

    var vectors = function () { return contentsOf(layer).property(gi).property("ADBE Vectors Group"); };
    vectors().addProperty(shapeMatch);
    var shape = vectors().property(1);
    if (spec.type === "rect") {
      setIf(shape, "ADBE Vector Rect Size", spec.size);
      setIf(shape, "ADBE Vector Rect Position", spec.position);
      setIf(shape, "ADBE Vector Rect Roundness", spec.roundness);
    } else if (spec.type === "ellipse") {
      setIf(shape, "ADBE Vector Ellipse Size", spec.size);
      setIf(shape, "ADBE Vector Ellipse Position", spec.position);
    } else if (spec.type === "star" || spec.type === "polygon") {
      if (spec.type === "polygon") shape.property("ADBE Vector Star Type").setValue(2);
      else shape.property("ADBE Vector Star Type").setValue(1);
      setIf(shape, "ADBE Vector Star Points", spec.points);
      setIf(shape, "ADBE Vector Star Position", spec.position);
      setIf(shape, "ADBE Vector Star Rotation", spec.rotation);
      setIf(shape, "ADBE Vector Star Outer Radius", spec.outer_radius);
      if (spec.type === "star") setIf(shape, "ADBE Vector Star Inner Radius", spec.inner_radius);
    } else {
      var s = new Shape();
      s.vertices = spec.vertices;
      if (spec.in_tangents) s.inTangents = spec.in_tangents;
      if (spec.out_tangents) s.outTangents = spec.out_tangents;
      s.closed = spec.closed !== false;
      shape.property("ADBE Vector Shape").setValue(s);
    }
    var si;
    if (spec.stroke) {
      si = addVectorItem(layer, gi, "ADBE Vector Graphic - Stroke");
      setIf(itemAt(layer, gi, si), "ADBE Vector Stroke Color", color3(spec.stroke.color));
      setIf(itemAt(layer, gi, si), "ADBE Vector Stroke Width", spec.stroke.width);
      setIf(itemAt(layer, gi, si), "ADBE Vector Stroke Opacity", spec.stroke.opacity);
      applyStrokeDetails(layer, gi, si, spec.stroke);
    }
    if (spec.gradient_stroke) {
      si = addVectorItem(layer, gi, "ADBE Vector Graphic - G-Stroke");
      applyGradient(layer, gi, si, spec.gradient_stroke);
      setIf(itemAt(layer, gi, si), "ADBE Vector Stroke Width", spec.gradient_stroke.width);
      setIf(itemAt(layer, gi, si), "ADBE Vector Stroke Opacity", spec.gradient_stroke.opacity);
      applyStrokeDetails(layer, gi, si, spec.gradient_stroke);
      made.gradient_colors = "default ramp (colour stops are not written by script; save the look as a preset in AE and apply it with ae_apply_preset)";
    }
    if (spec.fill) {
      si = addVectorItem(layer, gi, "ADBE Vector Graphic - Fill");
      setIf(itemAt(layer, gi, si), "ADBE Vector Fill Color", color3(spec.fill.color));
      setIf(itemAt(layer, gi, si), "ADBE Vector Fill Opacity", spec.fill.opacity);
      if (has(spec.fill.rule)) setIf(itemAt(layer, gi, si), "ADBE Vector Fill Rule", FILL_RULE[spec.fill.rule]);
    }
    if (spec.gradient_fill) {
      si = addVectorItem(layer, gi, "ADBE Vector Graphic - G-Fill");
      applyGradient(layer, gi, si, spec.gradient_fill);
      setIf(itemAt(layer, gi, si), "ADBE Vector Fill Opacity", spec.gradient_fill.opacity);
      if (has(spec.gradient_fill.rule)) setIf(itemAt(layer, gi, si), "ADBE Vector Fill Rule", FILL_RULE[spec.gradient_fill.rule]);
      made.gradient_colors = "default ramp (colour stops are not written by script; save the look as a preset in AE and apply it with ae_apply_preset)";
    }
    if (spec.group_position) {
      setIf(contentsOf(layer).property(gi).property("ADBE Vector Transform Group"), "ADBE Vector Position", spec.group_position);
    }
    return made;
  }

  // The groups this call has added, for the rollback of a failed add.
  var pendingGroups = [];

  // ---------- selecting contents ----------

  // Index of the top-level content a selector names; a name shared by several is refused.
  function resolveContent(contents, sel, verb) {
    var idx = -1;
    if (sel.index !== undefined && sel.index !== null) {
      if (sel.index < 1 || sel.index > contents.numProperties) fail("not_found", "Content index " + sel.index + " out of range");
      return sel.index;
    }
    var hits = 0;
    for (var k = 1; k <= contents.numProperties; k++) {
      if (contents.property(k).name === sel.name) {
        hits++;
        idx = k;
      }
    }
    if (hits === 0) fail("not_found", "No content named \"" + sel.name + "\"");
    if (hits > 1) fail("bad_args", hits + " contents are named \"" + sel.name + "\"; " + verb + " by index");
    return idx;
  }

  // Expressions that read contents by position (content(2)) silently point at
  // something else after a duplicate or a move. Only the layers of this comp are
  // scanned (up to 300); expressions in other comps that reach this layer are not.
  function findContentRefs(comp, layer) {
    var warnings = [];
    var re = /content\(\s*\d+\s*\)/;
    var layerRe = new RegExp("layer\\(\\s*" + layer.index + "\\s*\\)");
    var visited = { n: 0, truncated: false };
    function walk(group, path, x, depth) {
      for (var i = 1; i <= group.numProperties; i++) {
        if (visited.n >= 6000) {
          visited.truncated = true;
          return;
        }
        visited.n++;
        var p = group.property(i);
        if (!p) continue;
        var np = path.concat([p.name]);
        if (p.propertyType === PropertyType.PROPERTY) {
          var t = null;
          try {
            if (p.expressionEnabled && p.expression) t = String(p.expression);
          } catch (eE) {
            t = null;
          }
          if (t !== null && re.test(t)) {
            var mine = x.id === layer.id;
            if (!mine) mine = t.indexOf("\"" + layer.name + "\"") >= 0 || t.indexOf("'" + layer.name + "'") >= 0 || layerRe.test(t);
            if (mine && warnings.length < 20) {
              warnings.push({
                layer: x.name,
                property: np.join(" > "),
                expression: t.length > 200 ? t.substring(0, 200) + " ..." : t,
                note: "reads shape contents by position; it may point at something else after this change"
              });
            }
          }
        } else if (depth < 10) {
          walk(p, np, x, depth + 1);
        }
      }
    }
    for (var li = 1; li <= comp.numLayers && li <= 300; li++) {
      var x2 = comp.layer(li);
      try {
        walk(x2, [], x2, 0);
      } catch (eW) {}
    }
    return { warnings: warnings, truncated: visited.truncated };
  }

  A.shapeEdit = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = shapeLayer(comp, args.layer);
    var adds = args.add || [];
    var removes = args.remove || [];
    var dupSpecs = args.duplicate || [];
    var moveSpecs = args.move || [];
    var a;
    var r;
    if (adds.length > MAX_ITEMS) fail("bad_args", "At most " + MAX_ITEMS + " shapes per call");
    for (a = 0; a < adds.length; a++) checkSpec(adds[a], a + 1);
    if (dupSpecs.length > 0 && (removes.length > 0 || moveSpecs.length > 0)) {
      fail("bad_args", "duplicate can't be combined with remove or move in one call: the positions would shift under each other");
    }
    if (moveSpecs.length > 0 && removes.length > 0) fail("bad_args", "move can't be combined with remove in one call");
    if (adds.length > 0 && (dupSpecs.length > 0 || moveSpecs.length > 0)) {
      fail("bad_args", "add can't be combined with duplicate or move in one call: if an add were refused by AE, the copies and moves could not be taken back out; do the add in its own call");
    }
    // Resolve what to remove first, by index from the end, so names and indexes don't shift under us.
    var contents = contentsOf(layer);
    var drop = [];
    for (r = 0; r < removes.length; r++) {
      var idx = resolveContent(contents, removes[r], "remove");
      // Two selectors for the same content remove it once; a second removal would take whatever shifted into its place.
      var dup = false;
      for (var d = 0; d < drop.length; d++) {
        if (drop[d] === idx) dup = true;
      }
      if (!dup) drop.push(idx);
    }
    drop.sort(function (x, y) { return y - x; });

    // Duplicates: selectors refer to the contents as they are now.
    var dupPlan = [];
    var totalCopies = 0;
    for (r = 0; r < dupSpecs.length; r++) {
      var di = resolveContent(contents, dupSpecs[r], "duplicate");
      var copiesWanted = dupSpecs[r].count;
      if (!has(copiesWanted)) copiesWanted = 1;
      if (typeof copiesWanted !== "number" || Math.floor(copiesWanted) !== copiesWanted || copiesWanted < 1 || copiesWanted > 50) {
        fail("bad_args", "duplicate count must be a whole number 1..50");
      }
      for (var q = 0; q < dupPlan.length; q++) {
        if (dupPlan[q].index === di) fail("bad_args", "Content " + di + " is listed twice in duplicate; give one entry with a count");
      }
      totalCopies += copiesWanted;
      dupPlan.push({ index: di, name: contents.property(di).name, count: copiesWanted });
    }
    if (totalCopies > 200) fail("bad_args", "At most 200 copies per call");
    dupPlan.sort(function (x, y) { return y.index - x.index; });

    // Moves: applied in the order given. Names are stable under moves, indexes
    // refer to the position at that step; both are checked on a name list first.
    var simNames = [];
    var m;
    for (m = 1; m <= contents.numProperties; m++) simNames.push(contents.property(m).name);
    var moveTrivial = true;
    for (r = 0; r < moveSpecs.length; r++) {
      var ms = moveSpecs[r];
      var mfrom = -1;
      if (has(ms.index)) {
        if (ms.index < 1 || ms.index > simNames.length) fail("not_found", "Content index " + ms.index + " out of range");
        mfrom = ms.index;
      } else {
        var mh = 0;
        for (m = 0; m < simNames.length; m++) {
          if (simNames[m] === ms.name) {
            mh++;
            mfrom = m + 1;
          }
        }
        if (mh === 0) fail("not_found", "No content named \"" + ms.name + "\"");
        if (mh > 1) fail("bad_args", mh + " contents are named \"" + ms.name + "\"; move by index");
      }
      if (typeof ms.to !== "number" || Math.floor(ms.to) !== ms.to || ms.to < 1 || ms.to > simNames.length) {
        fail("bad_args", "move.to must be a whole number 1.." + simNames.length);
      }
      if (ms.to !== mfrom) moveTrivial = false;
      var movedName = simNames.splice(mfrom - 1, 1)[0];
      simNames.splice(ms.to - 1, 0, movedName);
    }
    var reorders = dupPlan.length > 0 || (moveSpecs.length > 0 && !moveTrivial);
    if (reorders && layer.locked) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first");

    if (drop.length === 0 && adds.length === 0 && dupPlan.length === 0 && (moveSpecs.length === 0 || moveTrivial)) {
      return { removed: [], added: [], count: contents.numProperties, no_op: true, note: "Nothing to change: every move targets the position the content already has" };
    }
    var refs = null;
    if (reorders) refs = findContentRefs(comp, layer);

    return A.withUndo(args.label || "Edit shapes", function () {
      var removed = [];
      var p;
      for (r = 0; r < drop.length; r++) {
        p = contentsOf(layer).property(drop[r]);
        removed.push({ index: drop[r], name: p.name });
        p.remove();
      }
      var duplicated = [];
      var cells = [];
      var located = true;
      var n;
      var e;
      var k;
      for (e = 0; e < dupPlan.length && located; e++) {
        var rec = { source_index: dupPlan[e].index, source_name: dupPlan[e].name, copies: [], requested: dupPlan[e].count };
        duplicated.push(rec);
        var src = { rec: rec, pos: dupPlan[e].index };
        cells.push(src);
        for (n = 0; n < dupPlan[e].count && located; n++) {
          var madeCopy = contentsOf(layer).property(src.pos).duplicate();
          var ci = -1;
          try {
            ci = madeCopy.propertyIndex;
          } catch (eIdx) {
            ci = -1;
          }
          if (typeof ci !== "number" || ci < 1) {
            located = false;
          } else {
            for (k = 0; k < cells.length; k++) {
              if (cells[k] !== src && cells[k].pos >= ci) cells[k].pos = cells[k].pos + 1;
            }
            if (ci <= src.pos) src.pos = src.pos + 1;
            var cell = { rec: rec, pos: ci, copy: true };
            cells.push(cell);
          }
        }
      }
      var cnow = contentsOf(layer);
      for (k = 0; k < cells.length; k++) {
        if (cells[k].copy) {
          cells[k].rec.copies.push({ index: cells[k].pos, name: cnow.property(cells[k].pos).name });
        } else {
          cells[k].rec.source_index_after = cells[k].pos;
        }
      }
      for (e = 0; e < duplicated.length; e++) {
        duplicated[e].copies.sort(function (x, y) { return x.index - y.index; });
      }
      var moved = [];
      for (r = 0; r < moveSpecs.length; r++) {
        var cur = contentsOf(layer);
        var from = resolveContent(cur, moveSpecs[r], "move");
        var mname = cur.property(from).name;
        if (from !== moveSpecs[r].to) cur.property(from).moveTo(moveSpecs[r].to);
        moved.push({ name: mname, from: from, to: moveSpecs[r].to });
      }
      var added = [];
      pendingGroups = [];
      try {
        for (a = 0; a < adds.length; a++) added.push(addGroup(layer, adds[a], contentsOf(layer).numProperties + 1));
      } catch (eAdd) {
        // Take back the groups this call added. Removals made earlier in this call (remove + add) stay: Edit > Undo brings them back.
        try {
          var undoList = pendingGroups.slice(0).sort(function (x, y) { return y - x; });
          for (var u = 0; u < undoList.length; u++) contentsOf(layer).property(undoList[u]).remove();
        } catch (eRm) {}
        throw eAdd;
      }
      var out = { removed: removed, added: added, count: contentsOf(layer).numProperties };
      if (dupSpecs.length > 0) {
        out.duplicated = duplicated;
        out.duplicate_located = located;
      }
      if (moveSpecs.length > 0) out.moved = moved;
      if (refs && refs.warnings.length > 0) out.expression_warnings = refs.warnings;
      if (refs && refs.truncated) out.expression_scan_truncated = true;
      if (refs) out.expression_scan_scope = "this comp's layers only (up to 300); expressions in other comps that reach this layer by comp(\"X\").layer(...).content(n) are not scanned";
      return out;
    });
  };
})($.global);
