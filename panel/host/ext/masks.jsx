// panel/host/ext/masks.jsx
//
// Host functions for the mask and text animator tools:
// - maskList (read): a layer's masks with mode, inversion, feather, opacity,
//   expansion and the path's box
// - maskEdit (guarded write): add (rectangle, ellipse or a free path), change
//   and remove masks
// - textAnimators (read): a text layer's animators, their properties and
//   range selectors
// - addTextAnimator (guarded write): an animator with properties and a range
//   selector, optionally a keyframed reveal
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

  function copy(v) {
    if (v instanceof Array) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push(copy(v[i]));
      return out;
    }
    return v;
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

  function describeMask(m, i) {
    var d = { index: i, name: m.name, mode: null, inverted: false, feather: null, opacity: null, expansion: null, vertices: 0, closed: true, box: null, animated: false };
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
    return d;
  }

  A.maskList = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var p = parade(layer);
    var out = { layer: { index: layer.index, id: layer.id, name: layer.name }, count: p.numProperties, masks: [] };
    for (var i = 1; i <= p.numProperties && i <= MAX_LIST; i++) out.masks.push(describeMask(p.property(i), i));
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

  function applyMask(layer, index, spec) {
    var m = function () { return parade(layer).property(index); };
    if (spec.name) m().name = spec.name;
    if (spec.shape === "rect" || spec.shape === "ellipse") m().property("ADBE Mask Shape").setValue(boxShape(spec.shape, spec.box));
    else if (spec.shape === "path") m().property("ADBE Mask Shape").setValue(pathShape(spec));
    if (spec.mode) m().maskMode = modeValue(spec.mode);
    if (spec.inverted !== undefined && spec.inverted !== null) m().inverted = spec.inverted === true;
    if (spec.feather !== undefined && spec.feather !== null) m().property("ADBE Mask Feather").setValue(spec.feather);
    if (spec.opacity !== undefined && spec.opacity !== null) m().property("ADBE Mask Opacity").setValue(spec.opacity);
    if (spec.expansion !== undefined && spec.expansion !== null) m().property("ADBE Mask Offset").setValue(spec.expansion);
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

  A.maskEdit = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var p = parade(layer);
    var sets = [];
    var drops = [];
    var i;
    for (i = 0; i < (args.set || []).length; i++) sets.push({ index: maskIndex(p, args.set[i].mask), spec: args.set[i] });
    for (i = 0; i < (args.remove || []).length; i++) drops.push(maskIndex(p, args.remove[i]));
    drops.sort(function (a, b) { return b - a; });
    return A.withUndo(args.label || "Edit masks", function () {
      var changed = [];
      for (var s = 0; s < sets.length; s++) {
        applyMask(layer, sets[s].index, sets[s].spec);
        changed.push({ index: sets[s].index, name: parade(layer).property(sets[s].index).name });
      }
      var removed = [];
      for (var d = 0; d < drops.length; d++) {
        removed.push({ index: drops[d], name: parade(layer).property(drops[d]).name });
        parade(layer).property(drops[d]).remove();
      }
      var added = [];
      var adds = args.add || [];
      for (var a = 0; a < adds.length; a++) {
        parade(layer).addProperty("ADBE Mask Atom");
        var idx = parade(layer).numProperties;
        applyMask(layer, idx, adds[a]);
        added.push({ index: idx, name: parade(layer).property(idx).name });
      }
      return { changed: changed, removed: removed, added: added, count: parade(layer).numProperties };
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

  var ANIM_PROPS = {
    position: "ADBE Text Position 3D",
    scale: "ADBE Text Scale 3D",
    rotation: "ADBE Text Rotation",
    opacity: "ADBE Text Opacity",
    fill_color: "ADBE Text Fill Color",
    tracking: "ADBE Text Tracking Amount",
    blur: "ADBE Text Blur"
  };

  var BASED_ON = { characters: 1, characters_excluding_spaces: 2, words: 3, lines: 4 };
  var SHAPES = { square: 1, ramp_up: 2, ramp_down: 3, triangle: 4, round: 5, smooth: 6 };

  A.textAnimators = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var anims = animators(layer);
    var out = { layer: { index: layer.index, id: layer.id, name: layer.name }, count: anims.numProperties, animators: [] };
    for (var i = 1; i <= anims.numProperties && i <= MAX_LIST; i++) {
      var a = anims.property(i);
      var entry = { index: i, name: a.name, properties: [], selectors: [] };
      var props = a.property("ADBE Text Animator Properties");
      for (var k = 1; k <= props.numProperties; k++) {
        var p = props.property(k);
        var pe = { name: p.name, matchName: p.matchName, value: null, keys: 0 };
        try { pe.value = copy(p.value); } catch (eV) {}
        try { pe.keys = p.numKeys; } catch (eK) {}
        entry.properties.push(pe);
      }
      var sels = a.property("ADBE Text Selectors");
      for (var s = 1; s <= sels.numProperties; s++) {
        var sel = sels.property(s);
        var se = { name: sel.name, matchName: sel.matchName };
        try {
          se.start = sel.property("ADBE Text Percent Start").value;
          se.end = sel.property("ADBE Text Percent End").value;
          se.offset = sel.property("ADBE Text Percent Offset").value;
          se.start_keys = sel.property("ADBE Text Percent Start").numKeys;
          se.end_keys = sel.property("ADBE Text Percent End").numKeys;
          se.offset_keys = sel.property("ADBE Text Percent Offset").numKeys;
        } catch (eS) {}
        entry.selectors.push(se);
      }
      out.animators.push(entry);
    }
    return out;
  };

  A.addTextAnimator = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    animators(layer);
    var props = args.properties || {};
    var keys = [];
    for (var key in props) {
      if (!props.hasOwnProperty(key)) continue;
      if (!ANIM_PROPS[key]) fail("bad_args", "Unknown animator property \"" + key + "\"");
      keys.push(key);
    }
    if (keys.length === 0) fail("bad_args", "Give at least one animator property");
    var sel = args.selector || {};
    if (sel.based_on && !BASED_ON[sel.based_on]) fail("bad_args", "Unknown based_on \"" + sel.based_on + "\"");
    if (sel.shape && !SHAPES[sel.shape]) fail("bad_args", "Unknown selector shape \"" + sel.shape + "\"");
    return A.withUndo(args.label || "Add text animator", function () {
      animators(layer).addProperty("ADBE Text Animator");
      var ai = animators(layer).numProperties;
      var anim = function () { return animators(layer).property(ai); };
      if (args.name) anim().name = args.name;
      for (var k = 0; k < keys.length; k++) {
        anim().property("ADBE Text Animator Properties").addProperty(ANIM_PROPS[keys[k]]);
        anim().property("ADBE Text Animator Properties").property(ANIM_PROPS[keys[k]]).setValue(props[keys[k]]);
      }
      anim().property("ADBE Text Selectors").addProperty("ADBE Text Selector");
      var selector = function () { return anim().property("ADBE Text Selectors").property(1); };
      if (sel.start !== undefined) selector().property("ADBE Text Percent Start").setValue(sel.start);
      if (sel.end !== undefined) selector().property("ADBE Text Percent End").setValue(sel.end);
      if (sel.offset !== undefined) selector().property("ADBE Text Percent Offset").setValue(sel.offset);
      var adv = function () { return selector().property("ADBE Text Range Advanced"); };
      if (sel.based_on) adv().property("ADBE Text Range Type2").setValue(BASED_ON[sel.based_on]);
      if (sel.shape) adv().property("ADBE Text Range Shape").setValue(SHAPES[sel.shape]);
      if (sel.ease_high !== undefined) adv().property("ADBE Text Levels Max Ease").setValue(sel.ease_high);
      if (sel.ease_low !== undefined) adv().property("ADBE Text Levels Min Ease").setValue(sel.ease_low);
      if (sel.randomize === true) adv().property("ADBE Text Randomize Order").setValue(1);
      var rv = args.reveal;
      if (rv) {
        var target = "ADBE Text Percent Start";
        if (rv.property === "end") target = "ADBE Text Percent End";
        else if (rv.property === "offset") target = "ADBE Text Percent Offset";
        var tp = selector().property(target);
        tp.setValueAtTime(rv.start_time, rv.from);
        tp.setValueAtTime(rv.start_time + rv.duration, rv.to);
      }
      return { index: ai, name: anim().name, properties: keys };
    });
  };
})($.global);
