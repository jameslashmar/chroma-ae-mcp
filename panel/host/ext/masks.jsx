// panel/host/ext/masks.jsx
//
// Host functions for the mask and text animator tools:
// - maskList (read): a layer's masks with mode, inversion, feather, opacity,
//   expansion, feather falloff, motion blur, colour, lock, RotoBezier and the
//   path's box
// - maskEdit (guarded write): add (rectangle, ellipse or a free path), change,
//   duplicate, reorder (moveTo) and remove masks
// - textAnimators (read): a text layer's animators, their properties, their
//   selectors (range, wiggly, expression, with every child property) and the
//   layer's More Options
// - addTextAnimator (guarded write): an animator with any animator property,
//   range / wiggly / expression selectors, variable font axes (AE 26) and
//   More Options grouping, optionally a keyframed reveal
//
// Adding a property invalidates references to its siblings, so every step
// looks its target up again from the layer.
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

  var MAX_LIST = 100;
  var MAX_MASK_LIST = 200;
  var MAX_CHILDREN = 60;
  var KAPPA = 0.5522847498;

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

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function copy(v) {
    if (isArray(v)) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push(copy(v[i]));
      return out;
    }
    return v;
  }

  function present(v) {
    return v !== undefined && v !== null;
  }

  function memberOf(obj, name) {
    try {
      return obj[name] !== undefined;
    } catch (e) {
      return false;
    }
  }

  function shortError(e) {
    var s = "";
    try { s = String(e.message || e); } catch (e0) { s = "unknown error"; }
    if (s.length > 300) s = s.substring(0, 300);
    return s;
  }

  // A locked layer is refused before anything is written.
  function ensureUnlocked(layer) {
    var locked = false;
    try { locked = layer.locked === true; } catch (e) { locked = false; }
    if (locked) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first (ae_layer_ops). Nothing was changed.");
  }

  function tokenPos(list, tok) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === tok) return i;
    }
    return -1;
  }

  // ---------- masks ----------

  function parade(layer) {
    var p = null;
    try { p = layer.property("ADBE Mask Parade"); } catch (e) { p = null; }
    if (!p) fail("bad_args", "\"" + layer.name + "\" can't hold masks");
    return p;
  }

  function modeName(m) {
    if (m === MaskMode.NONE) return "none";
    if (m === MaskMode.ADD) return "add";
    if (m === MaskMode.SUBTRACT) return "subtract";
    if (m === MaskMode.INTERSECT) return "intersect";
    if (m === MaskMode.LIGHTEN) return "lighten";
    if (m === MaskMode.DARKEN) return "darken";
    if (m === MaskMode.DIFFERENCE) return "difference";
    return String(m);
  }

  function modeValue(n) {
    if (n === "none") return MaskMode.NONE;
    if (n === "add") return MaskMode.ADD;
    if (n === "subtract") return MaskMode.SUBTRACT;
    if (n === "intersect") return MaskMode.INTERSECT;
    if (n === "lighten") return MaskMode.LIGHTEN;
    if (n === "darken") return MaskMode.DARKEN;
    if (n === "difference") return MaskMode.DIFFERENCE;
    fail("bad_args", "Unknown mask mode \"" + n + "\"");
    return null;
  }

  // MaskFeatherFalloff and MaskMotionBlur are newer enums: guarded, and a missing one is reported, not thrown.
  function falloffName(v) {
    if (typeof MaskFeatherFalloff !== "undefined") {
      if (v === MaskFeatherFalloff.FFO_LINEAR) return "linear";
      if (v === MaskFeatherFalloff.FFO_SMOOTH) return "smooth";
    }
    return String(v);
  }

  function falloffValue(n) {
    if (n !== "linear" && n !== "smooth") fail("bad_args", "Unknown feather_falloff \"" + n + "\" (linear or smooth)");
    if (typeof MaskFeatherFalloff === "undefined") return null;
    if (n === "linear") return MaskFeatherFalloff.FFO_LINEAR;
    return MaskFeatherFalloff.FFO_SMOOTH;
  }

  function motionBlurName(v) {
    if (typeof MaskMotionBlur !== "undefined") {
      if (v === MaskMotionBlur.SAME_AS_LAYER) return "same_as_layer";
      if (v === MaskMotionBlur.ON) return "on";
      if (v === MaskMotionBlur.OFF) return "off";
    }
    return String(v);
  }

  function motionBlurValue(n) {
    if (n !== "same_as_layer" && n !== "on" && n !== "off") fail("bad_args", "Unknown motion_blur \"" + n + "\" (same_as_layer, on or off)");
    if (typeof MaskMotionBlur === "undefined") return null;
    if (n === "same_as_layer") return MaskMotionBlur.SAME_AS_LAYER;
    if (n === "on") return MaskMotionBlur.ON;
    return MaskMotionBlur.OFF;
  }

  function describeMask(m, i) {
    var d = {
      index: i, name: m.name, mode: null, inverted: false, feather: null, opacity: null, expansion: null,
      vertices: 0, closed: true, box: null, animated: false,
      feather_falloff: null, motion_blur: null, color: null, locked: null, roto_bezier: null
    };
    try { d.mode = modeName(m.maskMode); } catch (e1) {}
    try { d.inverted = m.inverted === true; } catch (e2) {}
    try { d.feather = copy(m.property("ADBE Mask Feather").value); } catch (e3) {}
    try { d.opacity = m.property("ADBE Mask Opacity").value; } catch (e4) {}
    try { d.expansion = m.property("ADBE Mask Offset").value; } catch (e5) {}
    try {
      var shapeProp = m.property("ADBE Mask Shape");
      d.animated = shapeProp.numKeys > 0;
      var s = shapeProp.value;
      d.vertices = s.vertices.length;
      d.closed = s.closed;
      var minX = 1e12;
      var minY = 1e12;
      var maxX = -1e12;
      var maxY = -1e12;
      for (var k = 0; k < s.vertices.length; k++) {
        var v = s.vertices[k];
        if (v[0] < minX) minX = v[0];
        if (v[0] > maxX) maxX = v[0];
        if (v[1] < minY) minY = v[1];
        if (v[1] > maxY) maxY = v[1];
      }
      if (s.vertices.length) d.box = [minX, minY, maxX, maxY];
    } catch (e6) {}
    try { if (m.maskFeatherFalloff !== undefined) d.feather_falloff = falloffName(m.maskFeatherFalloff); } catch (e7) {}
    try { if (m.maskMotionBlur !== undefined) d.motion_blur = motionBlurName(m.maskMotionBlur); } catch (e8) {}
    try { if (m.color !== undefined) d.color = copy(m.color); } catch (e9) {}
    try { if (m.locked !== undefined) d.locked = m.locked === true; } catch (e10) {}
    try { if (m.rotoBezier !== undefined) d.roto_bezier = m.rotoBezier === true; } catch (e11) {}
    return d;
  }

  A.maskList = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var p = parade(layer);
    var out = { layer: { index: layer.index, id: layer.id, name: layer.name }, count: p.numProperties, masks: [], truncated: false };
    for (var i = 1; i <= p.numProperties && i <= MAX_MASK_LIST; i++) out.masks.push(describeMask(p.property(i), i));
    if (p.numProperties > MAX_MASK_LIST) out.truncated = true;
    return out;
  };

  // A Shape for a rectangle [left, top, width, height] or the ellipse inside it.
  function boxShape(kind, r) {
    var l = r[0];
    var t = r[1];
    var w = r[2];
    var h = r[3];
    var s = new Shape();
    if (kind === "rect") {
      s.vertices = [[l, t], [l + w, t], [l + w, t + h], [l, t + h]];
      s.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
      s.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
    } else {
      var cx = l + w / 2;
      var cy = t + h / 2;
      var ox = (w / 2) * KAPPA;
      var oy = (h / 2) * KAPPA;
      s.vertices = [[cx, t], [l + w, cy], [cx, t + h], [l, cy]];
      s.inTangents = [[-ox, 0], [0, -oy], [ox, 0], [0, oy]];
      s.outTangents = [[ox, 0], [0, oy], [-ox, 0], [0, -oy]];
    }
    s.closed = true;
    return s;
  }

  function pathShape(spec) {
    var s = new Shape();
    s.vertices = spec.vertices;
    if (spec.in_tangents) s.inTangents = spec.in_tangents;
    if (spec.out_tangents) s.outTangents = spec.out_tangents;
    s.closed = spec.closed !== false;
    return s;
  }

  // Sets a mask attribute (not a Property) when this AE has the member, else records it in notes.skipped.
  function setAttr(notes, layer, index, member, field, value) {
    var node = parade(layer).property(index);
    if (value === null || !memberOf(node, member)) {
      notes.skipped.push({ mask: index, field: field, reason: "This After Effects has no MaskPropertyGroup." + member + "." });
      return;
    }
    node[member] = value;
  }

  function applyMask(layer, index, spec, notes) {
    var m = function () { return parade(layer).property(index); };
    // A locked mask is unlocked for the edit and locked again afterwards (unless the change says locked: false).
    var wasLocked = false;
    try { wasLocked = m().locked === true; } catch (eL) { wasLocked = false; }
    if (spec.locked === false || wasLocked) setAttr(notes, layer, index, "locked", "locked", false);
    // The edits run in try/finally so a write that throws cannot leave a mask that was locked unlocked.
    var edited = false;
    try {
    if (spec.name) m().name = spec.name;
    if (spec.shape === "rect" || spec.shape === "ellipse") m().property("ADBE Mask Shape").setValue(boxShape(spec.shape, spec.box));
    else if (spec.shape === "path") m().property("ADBE Mask Shape").setValue(pathShape(spec));
    if (spec.mode) m().maskMode = modeValue(spec.mode);
    if (spec.inverted !== undefined && spec.inverted !== null) m().inverted = spec.inverted === true;
    if (spec.feather !== undefined && spec.feather !== null) m().property("ADBE Mask Feather").setValue(spec.feather);
    if (spec.opacity !== undefined && spec.opacity !== null) m().property("ADBE Mask Opacity").setValue(spec.opacity);
    if (spec.expansion !== undefined && spec.expansion !== null) m().property("ADBE Mask Offset").setValue(spec.expansion);
    if (present(spec.feather_falloff)) setAttr(notes, layer, index, "maskFeatherFalloff", "feather_falloff", falloffValue(spec.feather_falloff));
    if (present(spec.motion_blur)) setAttr(notes, layer, index, "maskMotionBlur", "motion_blur", motionBlurValue(spec.motion_blur));
    if (present(spec.color)) setAttr(notes, layer, index, "color", "color", copy(spec.color));
    if (present(spec.roto_bezier)) {
      setAttr(notes, layer, index, "rotoBezier", "roto_bezier", spec.roto_bezier === true);
      if (spec.roto_bezier === true) {
        notes.warnings.push("roto_bezier is on for mask " + index + ": After Effects recomputes its tangents from the vertices, so tangents written to this mask are replaced.");
      }
    }
    edited = true;
    } finally {
      // Relock even after a failed edit (only a mask that was locked); the relock cannot hide the original error.
      try {
        if (edited) {
          if (spec.locked === true || (wasLocked && spec.locked !== false)) setAttr(notes, layer, index, "locked", "locked", true);
        } else if (wasLocked && spec.locked !== false) {
          setAttr(notes, layer, index, "locked", "locked", true);
        }
      } catch (eRelock) {
        if (edited) throw eRelock;
      }
    }
  }

  // The mask fields a spec writes, with the property each one lives on.
  var MASK_FIELDS = [
    ["shape", "ADBE Mask Shape"],
    ["feather", "ADBE Mask Feather"],
    ["opacity", "ADBE Mask Opacity"],
    ["expansion", "ADBE Mask Offset"]
  ];

  // Does this spec write anything besides picking the mask?
  function specHasChange(spec) {
    for (var key in spec) {
      if (!spec.hasOwnProperty(key) || key === "mask") continue;
      if (present(spec[key])) return true;
    }
    return false;
  }

  function validateMaskAttrs(spec) {
    if (present(spec.feather_falloff)) falloffValue(spec.feather_falloff);
    if (present(spec.motion_blur)) motionBlurValue(spec.motion_blur);
    if (present(spec.color)) {
      var ok = isArray(spec.color) && spec.color.length === 3;
      for (var c = 0; ok && c < 3; c++) {
        if (!isNum(spec.color[c]) || spec.color[c] < 0 || spec.color[c] > 1) ok = false;
      }
      if (!ok) fail("bad_args", "color is [r, g, b] with each value 0 to 1.");
    }
    if (present(spec.locked) && typeof spec.locked !== "boolean") fail("bad_args", "locked is true or false.");
    if (present(spec.roto_bezier) && typeof spec.roto_bezier !== "boolean") fail("bad_args", "roto_bezier is true or false.");
  }

  // Refuses what applyMask would throw on halfway: an unknown mode or attribute value, or a value for a
  // property that has keys (setValue throws on those). index 0 is a new mask.
  function checkMaskSpec(p, index, spec) {
    if (spec.mode) modeValue(spec.mode);
    validateMaskAttrs(spec);
    if (index === 0) return;
    var m = p.property(index);
    for (var f = 0; f < MASK_FIELDS.length; f++) {
      var field = MASK_FIELDS[f][0];
      if (spec[field] === undefined || spec[field] === null) continue;
      if (m.property(MASK_FIELDS[f][1]).numKeys > 0) {
        fail("bad_args", "Mask " + index + " (\"" + m.name + "\") has keyframes on " + field + "; change it with ae_set_property. Nothing was changed.");
      }
    }
  }

  function maskIndex(p, sel) {
    if (sel.index !== undefined && sel.index !== null) {
      if (sel.index < 1 || sel.index > p.numProperties) fail("not_found", "Mask " + sel.index + " out of range");
      return sel.index;
    }
    var hit = -1;
    var hits = 0;
    for (var i = 1; i <= p.numProperties; i++) {
      if (p.property(i).name === sel.name) {
        hits++;
        hit = i;
      }
    }
    if (hits === 0) fail("not_found", "No mask named \"" + sel.name + "\"");
    if (hits > 1) fail("bad_args", hits + " masks are named \"" + sel.name + "\"; use the index");
    return hit;
  }

  // Expressions on the layer that address masks by index (mask(1)) or by name (mask("Mask 1")): a reorder, copy or
  // removal changes what they read. Read only, bounded.
  function scanMaskRefs(group, path, depth, state) {
    var n = 0;
    try { n = group.numProperties; } catch (e0) { return; }
    for (var i = 1; i <= n && state.visited < 4000; i++) {
      var node = null;
      try { node = group.property(i); } catch (e1) { node = null; }
      if (!node) continue;
      state.visited++;
      var label = node.name;
      if (path !== "") label = path + " > " + node.name;
      var leaf = false;
      try { leaf = node.propertyType === PropertyType.PROPERTY; } catch (e2) { leaf = false; }
      if (leaf) {
        var ex = "";
        try {
          if (node.canSetExpression && node.expression) ex = String(node.expression);
        } catch (e3) { ex = ""; }
        if (ex !== "") {
          var re = /mask\s*\(\s*(\d+|"[^"]*"|'[^']*')\s*\)/gi;
          var hit = re.exec(ex);
          while (hit && state.refs.length < 20) {
            state.refs.push({ where: label, ref: hit[0] });
            hit = re.exec(ex);
          }
        }
      } else if (depth < 8) {
        scanMaskRefs(node, label, depth + 1, state);
      }
    }
  }

  A.maskEdit = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var p = parade(layer);
    ensureUnlocked(layer);
    var n0 = p.numProperties;
    var sets = [];
    var drops = [];
    var dups = [];
    var moves = [];
    var adds = args.add || [];
    var i;
    var s;
    var d;
    var dc;
    for (i = 0; i < (args.set || []).length; i++) sets.push({ index: maskIndex(p, args.set[i].mask), spec: args.set[i] });
    for (i = 0; i < (args.remove || []).length; i++) drops.push(maskIndex(p, args.remove[i]));
    drops.sort(function (a, b) { return b - a; });
    // The same mask selected twice (by index and by name) is removed once.
    for (i = drops.length - 1; i > 0; i--) {
      if (drops[i] === drops[i - 1]) drops.splice(i, 1);
    }
    var dupTotal = 0;
    for (i = 0; i < (args.duplicate || []).length; i++) {
      dc = args.duplicate[i].count;
      if (!present(dc)) dc = 1;
      if (!isNum(dc) || dc < 1 || dc > 50 || dc !== Math.floor(dc)) fail("bad_args", "duplicate count is a whole number from 1 to 50.");
      dups.push({ index: maskIndex(p, args.duplicate[i].mask), count: dc });
      dupTotal += dc;
    }
    for (i = 0; i < (args.move_to || []).length; i++) {
      var to = args.move_to[i].index;
      if (!isNum(to) || to < 1 || to !== Math.floor(to)) fail("bad_args", "move_to index is a whole number from 1.");
      var from = maskIndex(p, args.move_to[i].mask);
      for (var mm = 0; mm < moves.length; mm++) {
        if (moves[mm].index === from) fail("bad_args", "Mask " + from + " is moved twice in one call.");
      }
      moves.push({ index: from, to: to });
    }
    // Everything that can fail runs before the undo group, so a refused call changes nothing.
    for (s = 0; s < sets.length; s++) {
      for (d = 0; d < drops.length; d++) {
        if (sets[s].index === drops[d]) fail("bad_args", "Mask " + sets[s].index + " is both changed and removed");
      }
      checkMaskSpec(p, sets[s].index, sets[s].spec);
    }
    for (i = 0; i < adds.length; i++) checkMaskSpec(p, 0, adds[i]);
    for (d = 0; d < drops.length; d++) {
      for (i = 0; i < dups.length; i++) {
        if (dups[i].index === drops[d]) fail("bad_args", "Mask " + drops[d] + " is both duplicated and removed");
      }
      for (i = 0; i < moves.length; i++) {
        if (moves[i].index === drops[d]) fail("bad_args", "Mask " + drops[d] + " is both moved and removed");
      }
    }
    var stackAfter = n0 - drops.length + dupTotal;
    if (stackAfter + adds.length > 200) fail("bad_args", "That would leave " + (stackAfter + adds.length) + " masks on the layer (the limit here is 200).");
    for (i = 0; i < moves.length; i++) {
      if (moves[i].to > stackAfter) fail("bad_args", "move_to index " + moves[i].to + " is past the last mask (" + stackAfter + " after the removals and copies).");
    }
    var anyWork = adds.length > 0 || drops.length > 0 || dups.length > 0;
    for (s = 0; s < sets.length; s++) {
      if (specHasChange(sets[s].spec)) anyWork = true;
    }
    for (i = 0; i < moves.length; i++) {
      if (moves[i].index !== moves[i].to) anyWork = true;
    }
    if (!anyWork) {
      return { no_op: true, changed: [], removed: [], added: [], duplicated: [], moved: [], count: n0, unsupported: [], warnings: [] };
    }
    var warnings = [];
    if (drops.length > 0 || dups.length > 0 || moves.length > 0) {
      var state = { visited: 0, refs: [] };
      scanMaskRefs(layer, "", 0, state);
      if (state.refs.length > 0) {
        var shown = [];
        for (i = 0; i < state.refs.length && i < 5; i++) shown.push(state.refs[i].where + ": " + state.refs[i].ref);
        warnings.push(state.refs.length + " expression reference(s) on this layer address masks by index or name (" + shown.join("; ") + "). Removing, copying or reordering masks changes which mask an index points at: check them.");
      }
    }
    return A.withUndo(args.label || "Edit masks", function () {
      var notes = { skipped: [], warnings: warnings };
      var cur = [];
      var changed = [];
      var removed = [];
      var duplicated = [];
      var moved = [];
      var added = [];
      var dupSeq = 0;
      var copyOf = {};
      var c;
      var pos;
      var ni;
      var node;
      var srcName;
      for (c = 1; c <= n0; c++) cur.push(c);
      for (s = 0; s < sets.length; s++) {
        applyMask(layer, sets[s].index, sets[s].spec, notes);
        changed.push({ index: sets[s].index, name: parade(layer).property(sets[s].index).name });
      }
      for (d = 0; d < drops.length; d++) {
        pos = tokenPos(cur, drops[d]);
        removed.push({ index: drops[d], name: parade(layer).property(pos + 1).name });
        parade(layer).property(pos + 1).remove();
        cur.splice(pos, 1);
      }
      for (i = 0; i < dups.length; i++) {
        for (c = 0; c < dups[i].count; c++) {
          pos = tokenPos(cur, dups[i].index);
          srcName = parade(layer).property(pos + 1).name;
          node = parade(layer).property(pos + 1).duplicate();
          ni = -1;
          try { ni = node.propertyIndex; } catch (eI) { ni = -1; }
          if (!isNum(ni) || ni < 1 || ni > parade(layer).numProperties) {
            ni = pos + 2;
            notes.warnings.push("The copy's position could not be read, so it is assumed to sit directly below mask " + (pos + 1) + ".");
          }
          dupSeq++;
          cur.splice(ni - 1, 0, "d" + dupSeq);
          copyOf["d" + dupSeq] = dups[i].index;
          duplicated.push({ source_index: dups[i].index, source_name: srcName, index: ni, name: parade(layer).property(ni).name, token: "d" + dupSeq });
        }
      }
      for (i = 0; i < moves.length; i++) {
        pos = tokenPos(cur, moves[i].index);
        var movedName = parade(layer).property(pos + 1).name;
        if (pos + 1 !== moves[i].to) {
          parade(layer).property(pos + 1).moveTo(moves[i].to);
          cur.splice(pos, 1);
          cur.splice(moves[i].to - 1, 0, moves[i].index);
        }
        moved.push({ from: pos + 1, to: moves[i].to, name: movedName, name_at_target: parade(layer).property(moves[i].to).name });
      }
      var order = [];
      for (c = 1; c <= parade(layer).numProperties && c <= 200; c++) order.push(parade(layer).property(c).name);
      for (s = 0; s < sets.length; s++) {
        pos = tokenPos(cur, sets[s].index);
        if (pos >= 0) changed[s].final_index = pos + 1;
      }
      // The order the plan says the stack has (before new masks): an original mask by its starting index, a copy by its source.
      // This comes from the plan, not from a read in this script, so the receipt can compare it with the separate read-back.
      var planOrder = [];
      for (c = 0; c < cur.length; c++) {
        if (typeof cur[c] === "string") planOrder.push({ copy_of: copyOf[cur[c]] });
        else planOrder.push({ original: cur[c] });
      }
      for (i = 0; i < duplicated.length; i++) {
        pos = tokenPos(cur, duplicated[i].token);
        duplicated[i].final_index = pos + 1;
        delete duplicated[i].token;
      }
      for (var a = 0; a < adds.length; a++) {
        parade(layer).addProperty("ADBE Mask Atom");
        var idx = parade(layer).numProperties;
        applyMask(layer, idx, adds[a], notes);
        added.push({ index: idx, name: parade(layer).property(idx).name });
      }
      return {
        changed: changed, removed: removed, added: added, duplicated: duplicated, moved: moved, order: order, plan_order: planOrder,
        count: parade(layer).numProperties, unsupported: notes.skipped, warnings: notes.warnings
      };
    });
  };

  // ---------- text animators ----------

  function textProps(layer) {
    var isText = false;
    try { isText = String(layer.reflect.name) === "TextLayer"; } catch (e) {}
    if (!isText) fail("bad_args", "\"" + layer.name + "\" is not a text layer");
    return layer.property("ADBE Text Properties");
  }

  function animators(layer) {
    return textProps(layer).property("ADBE Text Animators");
  }

  // Animator properties by key: match names (the first is the documented one, the rest are fallbacks tried in order),
  // the kind of value, and a hard range where AE has one.
  //   num: a number; vec2: [x, y]; vec3: [x, y] or [x, y, z]; color: [r, g, b] or [r, g, b, a], 0 to 1; any: a number or 1 to 4 numbers.
  function AP(m, kind, min, max) {
    return { m: m, kind: kind, min: min, max: max };
  }

  var ANIM_PROPS = {
    anchor_point: AP(["ADBE Text Anchor Point 3D"], "vec3"),
    position: AP(["ADBE Text Position 3D"], "vec3"),
    scale: AP(["ADBE Text Scale 3D"], "vec3"),
    skew: AP(["ADBE Text Skew"], "num"),
    skew_axis: AP(["ADBE Text Skew Axis"], "num"),
    rotation_x: AP(["ADBE Text Rotation X"], "num"),
    rotation_y: AP(["ADBE Text Rotation Y"], "num"),
    rotation: AP(["ADBE Text Rotation"], "num"),
    opacity: AP(["ADBE Text Opacity"], "num", 0, 100),
    fill_opacity: AP(["ADBE Text Fill Opacity"], "num", 0, 100),
    fill_color: AP(["ADBE Text Fill Color"], "color"),
    fill_hue: AP(["ADBE Text Fill Hue"], "num"),
    fill_saturation: AP(["ADBE Text Fill Saturation"], "num"),
    fill_brightness: AP(["ADBE Text Fill Brightness"], "num"),
    stroke_opacity: AP(["ADBE Text Stroke Opacity"], "num", 0, 100),
    stroke_color: AP(["ADBE Text Stroke Color"], "color"),
    stroke_hue: AP(["ADBE Text Stroke Hue"], "num"),
    stroke_saturation: AP(["ADBE Text Stroke Saturation"], "num"),
    stroke_brightness: AP(["ADBE Text Stroke Brightness"], "num"),
    stroke_width: AP(["ADBE Text Stroke Width"], "num"),
    tracking_type: AP(["ADBE Text Track Type", "ADBE Text Tracking Type"], "num"),
    tracking: AP(["ADBE Text Tracking Amount"], "num"),
    line_anchor: AP(["ADBE Text Line Anchor"], "num"),
    line_spacing: AP(["ADBE Text Line Spacing"], "vec2"),
    character_alignment: AP(["ADBE Text Character Change Type", "ADBE Text Character Align", "ADBE Text Character Alignment"], "any"),
    character_range: AP(["ADBE Text Character Range", "ADBE Text Character Range Type"], "any"),
    character_value: AP(["ADBE Text Character Replace", "ADBE Text Character Value"], "any"),
    character_offset: AP(["ADBE Text Character Offset"], "any"),
    variable_font_spacing: AP(["ADBE Text Variable Font Spacing"], "num"),
    blur: AP(["ADBE Text Blur"], "vec2")
  };

  function allNums(v, min, max) {
    if (!isArray(v) || v.length < min || v.length > max) return false;
    for (var i = 0; i < v.length; i++) {
      if (!isNum(v[i])) return false;
    }
    return true;
  }

  function checkAnimValue(key, value) {
    var def = ANIM_PROPS[key];
    var ok = true;
    if (def.kind === "num") ok = isNum(value);
    else if (def.kind === "vec2") ok = allNums(value, 2, 2);
    else if (def.kind === "vec3") ok = allNums(value, 2, 3);
    else if (def.kind === "color") {
      ok = allNums(value, 3, 4);
      for (var c = 0; ok && c < value.length; c++) {
        if (value[c] < 0 || value[c] > 1) ok = false;
      }
    } else ok = isNum(value) || allNums(value, 1, 4);
    if (!ok) fail("bad_args", "Animator property \"" + key + "\" needs " + describeKind(def.kind) + ". Nothing was changed.");
    if (isNum(value) && def.min !== undefined && value < def.min) fail("bad_args", "Animator property \"" + key + "\" can't go below " + def.min + ". Nothing was changed.");
    if (isNum(value) && def.max !== undefined && value > def.max) fail("bad_args", "Animator property \"" + key + "\" can't go above " + def.max + ". Nothing was changed.");
  }

  function describeKind(kind) {
    if (kind === "num") return "a number";
    if (kind === "vec2") return "[x, y]";
    if (kind === "vec3") return "[x, y] or [x, y, z]";
    if (kind === "color") return "[r, g, b] or [r, g, b, a], each 0 to 1";
    return "a number or a list of 1 to 4 numbers";
  }

  var BASED_ON = { characters: 1, characters_excluding_spaces: 2, words: 3, lines: 4 };
  var SHAPES = { square: 1, ramp_up: 2, ramp_down: 3, triangle: 4, round: 5, smooth: 6 };
  var SEL_MODES = { add: 1, subtract: 2, intersect: 3, min: 4, max: 5, difference: 6 };
  var SEL_UNITS = { percentage: 1, index: 2 };
  var GROUPING = { character: 1, word: 2, line: 3, all: 4 };

  var SEL_TYPES = {
    range: "ADBE Text Selector",
    wiggly: "ADBE Text Wiggly Selector",
    expression: "ADBE Text Expressible Selector"
  };

  // Selector fields: match names to try (the first is documented where the Guide documents it), display names to fall
  // back to, and the kind of value. The Wiggly and Expression children are not on the Guide's match-name page, so they
  // are also found by their display names, and a field that cannot be found fails with the selector's real children.
  function SF(cands, names, kind, map) {
    return { c: cands, n: names, kind: kind, map: map };
  }

  var SEL_FIELDS = {
    range: {
      start: SF(["ADBE Text Percent Start"], ["Start"], "num"),
      end: SF(["ADBE Text Percent End"], ["End"], "num"),
      offset: SF(["ADBE Text Percent Offset"], ["Offset"], "num"),
      units: SF(["ADBE Text Range Units"], ["Units"], "enum", SEL_UNITS),
      based_on: SF(["ADBE Text Range Type2"], ["Based On"], "enum", BASED_ON),
      mode: SF(["ADBE Text Selector Mode"], ["Mode"], "enum", SEL_MODES),
      amount: SF(["ADBE Text Selector Max Amount"], ["Amount"], "num"),
      shape: SF(["ADBE Text Range Shape"], ["Shape"], "enum", SHAPES),
      smoothness: SF(["ADBE Text Selector Smoothness"], ["Smoothness"], "num"),
      ease_high: SF(["ADBE Text Levels Max Ease"], ["Ease High"], "num"),
      ease_low: SF(["ADBE Text Levels Min Ease"], ["Ease Low"], "num"),
      randomize: SF(["ADBE Text Randomize Order"], ["Randomize Order"], "bool"),
      random_seed: SF(["ADBE Text Random Seed"], ["Random Seed"], "num")
    },
    wiggly: {
      mode: SF(["ADBE Text Wiggly Mode", "ADBE Text Selector Mode"], ["Mode"], "enum", SEL_MODES),
      max_amount: SF(["ADBE Text Wiggly Max Amount"], ["Max Amount"], "num"),
      min_amount: SF(["ADBE Text Wiggly Min Amount"], ["Min Amount"], "num"),
      based_on: SF(["ADBE Text Range Type2"], ["Based On"], "enum", BASED_ON),
      wiggles_per_second: SF(["ADBE Text Temporal Freq"], ["Wiggles/Second", "Wiggles / Second"], "num"),
      correlation: SF(["ADBE Text Character Correlation"], ["Correlation"], "num"),
      temporal_phase: SF(["ADBE Text Temporal Phase"], ["Temporal Phase"], "num"),
      spatial_phase: SF(["ADBE Text Spatial Phase"], ["Spatial Phase"], "num"),
      lock_dimensions: SF(["ADBE Text Wiggly Lock Dim"], ["Lock Dimensions"], "bool"),
      random_seed: SF(["ADBE Text Wiggly Random Seed", "ADBE Text Random Seed"], ["Random Seed"], "num")
    },
    expression: {
      based_on: SF(["ADBE Text Range Type2"], ["Based On"], "enum", BASED_ON),
      expression: SF(["ADBE Text Expressible Amount"], ["Amount"], "expr")
    }
  };

  // With Units set to Index, After Effects drives the selection from the Index properties, not the Percent ones.
  var INDEX_FIELDS = {
    start: SF(["ADBE Text Index Start"], [], "num"),
    end: SF(["ADBE Text Index End"], [], "num"),
    offset: SF(["ADBE Text Index Offset"], [], "num")
  };

  function rangeField(type, spec, key) {
    if (type === "range" && spec && spec.units === "index" && INDEX_FIELDS.hasOwnProperty(key)) return INDEX_FIELDS[key];
    return SEL_FIELDS[type][key];
  }

  function lookedFor(def) {
    var txt = def.c.join(", ");
    if (def.n.length > 0) txt += " and \"" + def.n.join("\", \"") + "\"";
    return txt;
  }

  // The order fields are written in: units before start and end, so index values are read as indexes; smoothness before
  // shape, because After Effects hides Smoothness (and refuses writes to it) once the shape is not Square.
  var SEL_ORDER = [
    "units", "based_on", "mode", "amount", "smoothness", "shape", "ease_high", "ease_low", "randomize", "random_seed",
    "max_amount", "min_amount", "wiggles_per_second", "correlation", "temporal_phase", "spatial_phase", "lock_dimensions",
    "expression", "start", "end", "offset"
  ];

  var MAX_EXPRESSION = 20000;

  function selectorType(matchName) {
    if (matchName === SEL_TYPES.range) return "range";
    if (matchName === SEL_TYPES.wiggly) return "wiggly";
    if (matchName === SEL_TYPES.expression) return "expression";
    return "other";
  }

  function fieldValue(def, key, v) {
    if (def.kind === "enum") {
      if (typeof v !== "string" || !def.map.hasOwnProperty(v)) {
        if (key === "based_on") fail("bad_args", "Unknown based_on \"" + v + "\"");
        if (key === "shape") fail("bad_args", "Unknown selector shape \"" + v + "\"");
        fail("bad_args", "Unknown " + key + " \"" + v + "\"");
      }
      return def.map[v];
    }
    if (def.kind === "bool") {
      if (typeof v !== "boolean") fail("bad_args", "Selector field \"" + key + "\" is true or false.");
      if (v) return 1;
      return 0;
    }
    if (def.kind === "expr") {
      if (typeof v !== "string" || v === "") fail("bad_args", "Selector field \"" + key + "\" is a non-empty expression string.");
      if (v.length > MAX_EXPRESSION) fail("bad_args", "The expression is longer than " + MAX_EXPRESSION + " characters.");
      return v;
    }
    if (!isNum(v)) fail("bad_args", "Selector field \"" + key + "\" is a number.");
    return v;
  }

  // Refuses a selector spec before the undo group: a field that belongs to another selector type, or a bad value.
  function checkSelectorSpec(spec, type) {
    if (!SEL_FIELDS.hasOwnProperty(type)) fail("bad_args", "Unknown selector type \"" + type + "\" (range, wiggly or expression)");
    var defs = SEL_FIELDS[type];
    for (var key in spec) {
      if (!spec.hasOwnProperty(key) || key === "type" || !present(spec[key])) continue;
      if (!defs.hasOwnProperty(key)) fail("bad_args", "Selector field \"" + key + "\" does not belong to a " + type + " selector. Nothing was changed.");
      fieldValue(defs[key], key, spec[key]);
    }
    if (type === "range" && present(spec.random_seed) && spec.randomize !== true) fail("bad_args", "random_seed needs randomize: true (After Effects hides Random Seed while Randomize Order is off). Nothing was changed.");
    if (type === "expression" && !present(spec.expression)) fail("bad_args", "An expression selector needs `expression`. Nothing was changed.");
  }

  // Every property under a selector (two levels), in tree order, groups skipped.
  function collectLeaves(group, out, depth) {
    var n = 0;
    try { n = group.numProperties; } catch (e0) { return; }
    for (var i = 1; i <= n && out.length < 80; i++) {
      var node = null;
      try { node = group.property(i); } catch (e1) { node = null; }
      if (!node) continue;
      var leaf = false;
      try { leaf = node.propertyType === PropertyType.PROPERTY; } catch (e2) { leaf = false; }
      if (leaf) out.push(node);
      else if (depth < 2) collectLeaves(node, out, depth + 1);
    }
  }

  function findField(selector, cands, names) {
    var all = [];
    var i;
    var j;
    collectLeaves(selector, all, 0);
    for (j = 0; j < cands.length; j++) {
      for (i = 0; i < all.length; i++) {
        if (all[i].matchName === cands[j]) return all[i];
      }
    }
    for (j = 0; j < names.length; j++) {
      for (i = 0; i < all.length; i++) {
        if (String(all[i].name).toLowerCase() === String(names[j]).toLowerCase()) return all[i];
      }
    }
    return null;
  }

  function childSummary(selector) {
    var all = [];
    var out = [];
    collectLeaves(selector, all, 0);
    for (var i = 0; i < all.length && i < 30; i++) out.push(all[i].matchName + " (" + all[i].name + ")");
    return out.join(", ");
  }

  function selectorNode(layer, ai, si) {
    return animators(layer).property(ai).property("ADBE Text Selectors").property(si);
  }

  function setValueChecked(prop, value, label) {
    if (typeof value === "number") {
      var lo = false;
      var hi = false;
      try { lo = prop.hasMin === true && value < prop.minValue; } catch (e0) { lo = false; }
      try { hi = prop.hasMax === true && value > prop.maxValue; } catch (e1) { hi = false; }
      if (lo) fail("bad_args", label + " can't go below " + prop.minValue + ".");
      if (hi) fail("bad_args", label + " can't go above " + prop.maxValue + ".");
    }
    try {
      prop.setValue(value);
    } catch (e2) {
      fail("bad_args", "After Effects refused " + label + ": " + shortError(e2));
    }
  }

  function fillSelector(layer, ai, si, type, spec, outFields) {
    var defs = SEL_FIELDS[type];
    var o;
    var key;
    var def;
    var prop;
    var value;
    for (o = 0; o < SEL_ORDER.length; o++) {
      key = SEL_ORDER[o];
      if (!defs.hasOwnProperty(key) || !present(spec[key])) continue;
      def = rangeField(type, spec, key);
      prop = findField(selectorNode(layer, ai, si), def.c, def.n);
      if (!prop) {
        fail("bad_args", "The " + type + " selector has no \"" + key + "\" property in this After Effects (looked for " + lookedFor(def) + "). Its children are: " + childSummary(selectorNode(layer, ai, si)) + ".");
      }
      value = fieldValue(def, key, spec[key]);
      if (def.kind === "expr") {
        var canExpr = false;
        try { canExpr = prop.canSetExpression === true; } catch (e0) { canExpr = false; }
        if (!canExpr) fail("bad_args", "The selector's " + key + " property can't take an expression.");
        prop.expression = value;
      } else {
        setValueChecked(prop, value, "the selector's " + key);
      }
      outFields[key] = { match_name: prop.matchName, name: prop.name };
    }
  }

  // The animator property node (looked up again each time) and its value, set on a fresh reference.
  function addAnimProp(layer, ai, key) {
    var cands = ANIM_PROPS[key].m;
    var lastError = "";
    var c;
    var grp;
    var pr;
    for (c = 0; c < cands.length; c++) {
      grp = animators(layer).property(ai).property("ADBE Text Animator Properties");
      // Some properties arrive as the companion of another one (Skew brings Skew Axis): reuse it instead of adding it again.
      pr = null;
      try { pr = grp.property(cands[c]); } catch (e1) { pr = null; }
      if (pr) return pr;
      try {
        if (typeof grp.canAddProperty === "function" && grp.canAddProperty(cands[c]) === false) {
          lastError = "canAddProperty is false";
          continue;
        }
        grp.addProperty(cands[c]);
      } catch (e0) {
        lastError = shortError(e0);
        continue;
      }
      pr = animators(layer).property(ai).property("ADBE Text Animator Properties").property(cands[c]);
      if (pr) return pr;
      lastError = "the property did not appear";
    }
    fail("bad_args", "After Effects would not add the animator property \"" + key + "\" (tried " + cands.join(", ") + "): " + lastError + ".");
    return null;
  }

  A.textAnimators = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var anims = animators(layer);
    var out = { layer: { index: layer.index, id: layer.id, name: layer.name }, count: anims.numProperties, animators: [], truncated: false };
    for (var i = 1; i <= anims.numProperties && i <= MAX_LIST; i++) {
      var a = anims.property(i);
      var entry = { index: i, name: a.name, properties: [], selectors: [] };
      var props = a.property("ADBE Text Animator Properties");
      for (var k = 1; k <= props.numProperties && k <= MAX_LIST; k++) {
        var p = props.property(k);
        var pe = { name: p.name, matchName: p.matchName, value: null, keys: 0 };
        try { pe.value = copy(p.value); } catch (eV) {}
        try { pe.keys = p.numKeys; } catch (eK) {}
        entry.properties.push(pe);
      }
      var sels = a.property("ADBE Text Selectors");
      for (var s = 1; s <= sels.numProperties && s <= MAX_LIST; s++) {
        var sel = sels.property(s);
        var se = { index: s, name: sel.name, matchName: sel.matchName, type: selectorType(sel.matchName), children: [] };
        // With Units on Index the selection comes from the Index properties, so those are what start/end/offset report.
        var startMn = "ADBE Text Percent Start";
        var endMn = "ADBE Text Percent End";
        var offsetMn = "ADBE Text Percent Offset";
        try {
          var unitsProp = null;
          if (se.type === "range") unitsProp = findField(sel, SEL_FIELDS.range.units.c, SEL_FIELDS.range.units.n);
          if (unitsProp && unitsProp.value === 2 && sel.property("ADBE Text Index Start") && sel.property("ADBE Text Index End") && sel.property("ADBE Text Index Offset")) {
            startMn = "ADBE Text Index Start";
            endMn = "ADBE Text Index End";
            offsetMn = "ADBE Text Index Offset";
            se.units = "index";
          }
        } catch (eU) {}
        try {
          se.start = sel.property(startMn).value;
          se.end = sel.property(endMn).value;
          se.offset = sel.property(offsetMn).value;
          se.start_keys = sel.property(startMn).numKeys;
          se.end_keys = sel.property(endMn).numKeys;
          se.offset_keys = sel.property(offsetMn).numKeys;
        } catch (eS) {}
        var leaves = [];
        collectLeaves(sel, leaves, 0);
        for (var c = 0; c < leaves.length && c < MAX_CHILDREN; c++) {
          var ce = { name: leaves[c].name, matchName: leaves[c].matchName, value: null, keys: 0 };
          try { ce.value = copy(leaves[c].value); } catch (eCV) {}
          try { ce.keys = leaves[c].numKeys; } catch (eCK) {}
          try {
            if (leaves[c].canSetExpression && leaves[c].expression) {
              var exText = String(leaves[c].expression);
              if (exText.length > MAX_EXPRESSION) exText = exText.substring(0, MAX_EXPRESSION);
              ce.expression = exText;
              ce.expression_error = String(leaves[c].expressionError || "");
            }
          } catch (eCE) {}
          se.children.push(ce);
        }
        entry.selectors.push(se);
      }
      out.animators.push(entry);
    }
    if (anims.numProperties > MAX_LIST) out.truncated = true;
    out.more_options = readMoreOptions(layer);
    return out;
  };

  // ---------- More Options (anchor point grouping and friends), a text layer's own group ----------

  var MORE_FIELDS = {
    anchor_point_grouping: { m: "ADBE Text Anchor Point Option", kind: "enum", map: GROUPING },
    grouping_alignment: { m: "ADBE Text Anchor Point Align", kind: "vec2" },
    fill_and_stroke: { m: "ADBE Text Render Order", kind: "int", min: 1, max: 3 },
    inter_character_blending: { m: "ADBE Text Character Blend Mode", kind: "int", min: 1, max: 40 }
  };

  var MORE_ORDER = ["anchor_point_grouping", "grouping_alignment", "fill_and_stroke", "inter_character_blending"];

  function moreProp(layer, key) {
    var mo = null;
    try { mo = textProps(layer).property("ADBE Text More Options"); } catch (e0) { mo = null; }
    if (!mo) return null;
    return mo.property(MORE_FIELDS[key].m);
  }

  function readMoreOptions(layer) {
    var out = {};
    var any = false;
    for (var o = 0; o < MORE_ORDER.length; o++) {
      var pr = null;
      try { pr = moreProp(layer, MORE_ORDER[o]); } catch (e0) { pr = null; }
      if (!pr) continue;
      try {
        out[MORE_ORDER[o]] = copy(pr.value);
        any = true;
      } catch (e1) {}
    }
    if (!any) return null;
    return out;
  }

  function planGrouping(layer, grouping) {
    var plan = [];
    if (!grouping) return plan;
    var key;
    for (key in grouping) {
      if (!grouping.hasOwnProperty(key) || !present(grouping[key])) continue;
      if (!MORE_FIELDS.hasOwnProperty(key)) fail("bad_args", "Unknown grouping field \"" + key + "\"");
    }
    for (var o = 0; o < MORE_ORDER.length; o++) {
      key = MORE_ORDER[o];
      if (!present(grouping[key])) continue;
      var def = MORE_FIELDS[key];
      var v = grouping[key];
      var value = v;
      if (def.kind === "enum") {
        if (typeof v !== "string" || !def.map.hasOwnProperty(v)) fail("bad_args", "Unknown " + key + " \"" + v + "\" (character, word, line or all).");
        value = def.map[v];
      } else if (def.kind === "vec2") {
        if (!allNums(v, 2, 2)) fail("bad_args", key + " is [x, y] in percent.");
      } else if (!isNum(v) || v !== Math.floor(v) || v < def.min || v > def.max) {
        fail("bad_args", key + " is a menu index from " + def.min + " to " + def.max + ".");
      }
      var pr = moreProp(layer, key);
      if (!pr) fail("bad_args", "This layer has no " + key + " property (" + def.m + ") under More Options. Nothing was changed.");
      if (pr.numKeys > 0) fail("bad_args", "More Options " + key + " has keyframes; change it with ae_set_property. Nothing was changed.");
      plan.push({ key: key, value: value, old: copy(pr.value) });
    }
    return plan;
  }

  // ---------- variable font axes (AE 26.0) ----------

  function addUnique(list, v) {
    if (v === "" || v === "undefined") return;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === v) return;
    }
    list.push(v);
  }

  function postScriptOf(obj) {
    try {
      if (obj && obj.fontObject && obj.fontObject.postScriptName) return String(obj.fontObject.postScriptName);
    } catch (e0) {}
    try {
      if (obj && obj.font) return String(obj.font);
    } catch (e1) {}
    return "";
  }

  // The fonts the layer uses (the whole-layer font, plus per-character fonts when this AE can read them) with their axes.
  function layerFonts(layer) {
    var out = { fonts: [], unchecked: false, mixed_scanned: false };
    var doc = null;
    var names = [];
    var i;
    try { doc = textProps(layer).property("ADBE Text Document").value; } catch (e0) { doc = null; }
    if (!doc) {
      out.unchecked = true;
      return out;
    }
    addUnique(names, postScriptOf(doc));
    var scan = false;
    try { scan = typeof doc.characterRange === "function"; } catch (e1) { scan = false; }
    if (scan) {
      var len = 0;
      try { len = String(doc.text).length; } catch (e2) { len = 0; }
      for (i = 0; i < len && i < 400; i++) {
        try {
          addUnique(names, postScriptOf(doc.characterRange(i, i + 1)));
          out.mixed_scanned = true;
        } catch (e3) {
          break;
        }
      }
    }
    if (typeof A.fontsResolve !== "function") {
      out.unchecked = true;
      return out;
    }
    for (i = 0; i < names.length; i++) {
      var r = null;
      try { r = A.fontsResolve({ postscript: names[i] }); } catch (e4) { r = null; }
      if (!r || r.unchecked) {
        out.unchecked = true;
        continue;
      }
      if (r.font) {
        out.fonts.push({ postscript: names[i], axes: r.font.axes || [], has_axes: r.font.has_design_axes === true });
      } else {
        out.fonts.push({ postscript: names[i], axes: [], has_axes: false, unresolved: true });
        out.unchecked = true;
      }
    }
    if (out.fonts.length === 0) out.unchecked = true;
    return out;
  }

  function planAxes(layer, axes) {
    var plan = [];
    if (!axes || axes.length === 0) return plan;
    var ver = parseFloat(String(app.version));
    if (!(ver >= 26)) fail("bad_args", "variable_axes need After Effects 26.0 or newer (this is " + app.version + "). Nothing was changed.");
    var group = textProps(layer);
    var hasApi = false;
    try { hasApi = typeof group.addVariableFontAxis === "function"; } catch (e0) { hasApi = false; }
    if (!hasApi) fail("bad_args", "This After Effects has no PropertyGroup.addVariableFontAxis (it needs 26.0). Nothing was changed.");
    var info = layerFonts(layer);
    var seen = {};
    for (var a = 0; a < axes.length; a++) {
      var tag = axes[a].tag;
      var value = axes[a].value;
      if (typeof tag !== "string" || tag.length !== 4) fail("bad_args", "An axis tag is 4 characters (wght, wdth, slnt, opsz or a custom uppercase tag).");
      if (!isNum(value)) fail("bad_args", "Axis \"" + tag + "\" needs a numeric value.");
      if (seen.hasOwnProperty(tag)) fail("bad_args", "Axis \"" + tag + "\" is given twice.");
      seen[tag] = true;
      var applies = [];
      var skipped = [];
      var lo = null;
      var hi = null;
      var available = [];
      for (var f = 0; f < info.fonts.length; f++) {
        var found = null;
        for (var x = 0; x < info.fonts[f].axes.length; x++) {
          addUnique(available, info.fonts[f].axes[x].tag);
          if (info.fonts[f].axes[x].tag === tag) found = info.fonts[f].axes[x];
        }
        if (found) {
          applies.push(info.fonts[f].postscript);
          if (isNum(found.min) && (lo === null || found.min < lo)) lo = found.min;
          if (isNum(found.max) && (hi === null || found.max > hi)) hi = found.max;
        } else {
          skipped.push(info.fonts[f].postscript);
        }
      }
      var custom = /^[A-Z]{4}$/.test(tag);
      if (applies.length === 0 && !custom && !info.unchecked) {
        var fontNames = [];
        for (var g = 0; g < info.fonts.length; g++) fontNames.push(info.fonts[g].postscript);
        var msg = "The layer's font (" + fontNames.join(", ") + ") has no axis \"" + tag + "\".";
        if (available.length > 0) msg += " Its axes: " + available.join(", ") + ".";
        else msg += " It is not a variable font.";
        fail("bad_args", msg + " Nothing was changed.");
      }
      if (applies.length > 0 && lo !== null && value < lo) fail("bad_args", "Axis \"" + tag + "\" can't go below " + lo + " in this font. Nothing was changed.");
      if (applies.length > 0 && hi !== null && value > hi) fail("bad_args", "Axis \"" + tag + "\" can't go above " + hi + " in this font. Nothing was changed.");
      plan.push({ tag: tag, value: value, applies_to: applies, skipped_fonts: skipped, unchecked: info.unchecked || (applies.length === 0), custom: custom });
    }
    return plan;
  }

  A.addTextAnimator = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    animators(layer);
    ensureUnlocked(layer);
    var props = args.properties || {};
    var keys = [];
    var key;
    var i;
    for (key in props) {
      if (!props.hasOwnProperty(key) || !present(props[key])) continue;
      if (!ANIM_PROPS.hasOwnProperty(key)) fail("bad_args", "Unknown animator property \"" + key + "\"");
      checkAnimValue(key, props[key]);
      keys.push(key);
    }
    var axes = args.variable_axes || [];
    if (keys.length === 0 && axes.length === 0) fail("bad_args", "Give at least one animator property");
    var specs = [];
    var types = [];
    if (args.selector) specs.push(args.selector);
    var more = args.more_selectors || [];
    for (i = 0; i < more.length; i++) specs.push(more[i]);
    if (specs.length === 0) specs.push({});
    var firstRange = -1;
    for (i = 0; i < specs.length; i++) {
      var type = "range";
      if (present(specs[i].type)) type = specs[i].type;
      checkSelectorSpec(specs[i], type);
      types.push(type);
      if (type === "range" && firstRange < 0) firstRange = i;
    }
    var rv = args.reveal;
    if (rv) {
      if (firstRange < 0) fail("bad_args", "reveal keys a range selector, and none was given.");
      if (!isNum(rv.from) || !isNum(rv.to) || !isNum(rv.start_time) || !isNum(rv.duration) || rv.duration <= 0) {
        fail("bad_args", "reveal needs numeric from, to, start_time and a positive duration.");
      }
      if (present(rv.property) && rv.property !== "start" && rv.property !== "end" && rv.property !== "offset") fail("bad_args", "reveal.property is start, end or offset.");
    }
    var groupPlan = planGrouping(layer, args.grouping);
    var axisPlan = planAxes(layer, axes);
    return A.withUndo(args.label || "Add text animator", function () {
      var ai = 0;
      var made = false;
      var restore = [];
      var selOut = [];
      var axesOut = [];
      var propOut = {};
      var warnings = [];
      var groupOut = {};
      var r;
      var k;
      var s2;
      var a2;
      var si;
      var fields;
      var pr;
      var ret;
      var grp;
      try {
        animators(layer).addProperty("ADBE Text Animator");
        ai = animators(layer).numProperties;
        made = true;
        if (args.name) animators(layer).property(ai).name = args.name;
        for (k = 0; k < keys.length; k++) {
          pr = addAnimProp(layer, ai, keys[k]);
          propOut[keys[k]] = { match_name: pr.matchName, name: pr.name };
          setValueChecked(pr, props[keys[k]], "the animator's " + keys[k]);
        }
        for (a2 = 0; a2 < axisPlan.length; a2++) {
          grp = animators(layer).property(ai).property("ADBE Text Animator Properties");
          ret = grp.addVariableFontAxis(axisPlan[a2].tag);
          pr = null;
          if (ret && typeof ret.setValue === "function") {
            pr = ret;
          } else {
            grp = animators(layer).property(ai).property("ADBE Text Animator Properties");
            pr = grp.property(grp.numProperties);
          }
          var axIndex = grp.numProperties;
          try { if (isNum(pr.propertyIndex)) axIndex = pr.propertyIndex; } catch (eIx) {}
          var axName = pr.name;
          var axMatch = pr.matchName;
          setValueChecked(pr, axisPlan[a2].value, "the variable axis " + axisPlan[a2].tag);
          axesOut.push({
            tag: axisPlan[a2].tag, value: axisPlan[a2].value, index: axIndex, name: axName, match_name: axMatch,
            applies_to: axisPlan[a2].applies_to, skipped_fonts: axisPlan[a2].skipped_fonts, custom: axisPlan[a2].custom
          });
          if (axisPlan[a2].skipped_fonts.length > 0 && axisPlan[a2].applies_to.length > 0) {
            warnings.push("Axis " + axisPlan[a2].tag + " applies only where the font has it; these fonts in the layer do not: " + axisPlan[a2].skipped_fonts.join(", ") + ".");
          }
          if (axisPlan[a2].unchecked) {
            warnings.push("Axis " + axisPlan[a2].tag + " could not be checked against the font's axes (custom tag or no font data); it renders only if the font has it.");
          }
        }
        for (s2 = 0; s2 < specs.length; s2++) {
          try {
            animators(layer).property(ai).property("ADBE Text Selectors").addProperty(SEL_TYPES[types[s2]]);
          } catch (eSel) {
            fail("bad_args", "After Effects would not add a " + types[s2] + " selector (" + SEL_TYPES[types[s2]] + "): " + shortError(eSel));
          }
          si = animators(layer).property(ai).property("ADBE Text Selectors").numProperties;
          fields = {};
          fillSelector(layer, ai, si, types[s2], specs[s2], fields);
          selOut.push({ index: si, type: types[s2], fields: fields });
        }
        if (rv) {
          var rvKey = "start";
          if (rv.property === "end") rvKey = "end";
          else if (rv.property === "offset") rvKey = "offset";
          var target = rangeField("range", specs[firstRange], rvKey);
          var tp = findField(selectorNode(layer, ai, selOut[firstRange].index), target.c, target.n);
          if (!tp) fail("bad_args", "The range selector has no " + lookedFor(target) + " property to key. Its children are: " + childSummary(selectorNode(layer, ai, selOut[firstRange].index)) + ".");
          tp.setValueAtTime(rv.start_time, rv.from);
          tp.setValueAtTime(rv.start_time + rv.duration, rv.to);
        }
        for (k = 0; k < groupPlan.length; k++) {
          restore.push({ key: groupPlan[k].key, value: groupPlan[k].old });
          moreProp(layer, groupPlan[k].key).setValue(groupPlan[k].value);
          groupOut[groupPlan[k].key] = groupPlan[k].value;
        }
      } catch (eBuild) {
        for (r = restore.length - 1; r >= 0; r--) {
          try { moreProp(layer, restore[r].key).setValue(restore[r].value); } catch (eRs) {}
        }
        if (made) {
          try { animators(layer).property(ai).remove(); } catch (eRb) {}
        }
        throw eBuild;
      }
      return {
        index: ai, name: animators(layer).property(ai).name, properties: keys, property_matches: propOut,
        variable_axes: axesOut, selectors: selOut, grouping: groupOut, warnings: warnings
      };
    });
  };
})($.global);
