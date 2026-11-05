// panel/host/ext/mattes.jsx
//
// Host functions for the mattes tools (ae_mask_follow, ae_garbage_matte,
// ae_caf_prep). Every name starts with "mattes" because other groups add
// functions to the same object.
//
// - mattesMaskRead (read): a layer's masks, one mask in detail (mode, feather,
//   expansion, key counts, the path at a time, sampled paths), the pin effects
//   on the layer, and the comp's size and work area
// - mattesFollowApply (guarded write): keys a mask path with the shapes the
//   server computed (one setValuesAtTimes), on an existing mask or a new one,
//   plus the mask's mode, feather, expansion and, optionally, the work area
// - mattesGarbageRead (read): layers, their track mattes, and one matte layer
//   with its mask and effects, for the receipt
// - mattesGarbageApply (guarded write): a comp-size matte solid with a (keyed)
//   mask, wired up as the track matte of one or more layers; or an existing
//   layer wired up as the matte
// - mattesFindFill (read): footage layers that look like what Content-Aware
//   Fill generates
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Reads never change time, selection, solo, resolution or the active item.
// - Writes check the guard first, validate everything that can fail before
//   A.withUndo, and open and close the undo group in the same call.
// - Adding a property invalidates references to its siblings: masks and
//   effects are looked up again from the layer after every addProperty.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_KEYS = 3000;
  var MAX_VERTS = 500;
  var MAX_LIST = 500;
  var MAX_SAMPLES = 12;
  var MAX_NAMES = 50;
  var CHOKER = "ADBE Simple Choker";
  var PIN_MATCH_NAMES = ["ADBE Corner Pin", "CC Power Pin"];
  // Order matters: segment locations first, then the arrays that index into them.
  var FEATHER_FIELDS = ["featherSegLocs", "featherRelSegLocs", "featherRadii", "featherInterps", "featherTensions", "featherTypes", "featherRelCornerAngles"];

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

  function isArr(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
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

  // A layer given as { index, id }: both must still agree.
  function layerByIndexId(comp, index, id) {
    if (typeof index !== "number" || typeof id !== "number") fail("bad_args", "A layer needs both an index and an id");
    if (index < 1 || index > comp.numLayers) fail("not_found", "Layer index " + index + " out of range");
    var l = comp.layer(index);
    if (l.id !== id) fail("guard", "Layer " + index + " is not the layer read earlier (id " + id + "); the stack changed. Re-read and retry.");
    return l;
  }

  function layerById(comp, id) {
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).id === id) return comp.layer(i);
    }
    return null;
  }

  function child(group, matchName) {
    if (!group) return null;
    var p = null;
    try {
      p = group.property(matchName);
    } catch (e) {
      p = null;
    }
    return p;
  }

  function isThreeD(layer) {
    var v = false;
    try {
      v = layer.threeDLayer === true;
    } catch (e) {
      v = false;
    }
    return v;
  }

  function reflectName(l) {
    var n = "";
    try {
      if (l.reflect && l.reflect.name) n = String(l.reflect.name);
    } catch (e) {
      n = "";
    }
    return n;
  }

  function layerBrief(l) {
    return {
      index: l.index,
      id: l.id,
      name: l.name,
      locked: l.locked === true,
      enabled: l.enabled === true,
      three_d: isThreeD(l)
    };
  }

  function compFps(comp) {
    var fps = Number(comp.frameRate);
    if (!(fps > 0)) fps = 25;
    return fps;
  }

  function compBrief(comp) {
    return {
      id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      pixel_aspect: comp.pixelAspect,
      fps: compFps(comp),
      duration: comp.duration,
      work_area_start: comp.workAreaStart,
      work_area_duration: comp.workAreaDuration,
      num_layers: comp.numLayers
    };
  }

  function numKeysOf(prop) {
    var n = 0;
    try {
      n = prop.numKeys;
    } catch (e) {
      n = 0;
    }
    return n;
  }

  function hasExpression(prop) {
    var ex = false;
    try {
      ex = prop.expressionEnabled === true;
    } catch (e) {
      ex = false;
    }
    return ex;
  }

  // ---------- masks ----------

  function maskParade(layer) {
    var p = null;
    try {
      p = layer.property("ADBE Mask Parade");
    } catch (e) {
      p = null;
    }
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

  function blurValue(n) {
    if (typeof MaskMotionBlur === "undefined") {
      fail("bad_args", "This AE has no MaskMotionBlur enum, so a mask's motion blur can't be set by script.");
    }
    if (n === "same_as_layer") return MaskMotionBlur.SAME_AS_LAYER;
    if (n === "on") return MaskMotionBlur.ON;
    if (n === "off") return MaskMotionBlur.OFF;
    fail("bad_args", "Unknown mask motion blur \"" + n + "\"");
    return null;
  }

  function blurName(v) {
    if (typeof MaskMotionBlur === "undefined") return null;
    if (v === MaskMotionBlur.SAME_AS_LAYER) return "same_as_layer";
    if (v === MaskMotionBlur.ON) return "on";
    if (v === MaskMotionBlur.OFF) return "off";
    return String(v);
  }

  function maskIndexOf(parade, sel) {
    var i;
    if (!sel) fail("bad_args", "mask selector missing");
    if (sel.index !== undefined && sel.index !== null) {
      if (sel.index < 1 || sel.index > parade.numProperties) fail("not_found", "Mask " + sel.index + " out of range (the layer has " + parade.numProperties + ")");
      return sel.index;
    }
    var hit = -1;
    var hits = 0;
    for (i = 1; i <= parade.numProperties; i++) {
      if (parade.property(i).name === sel.name) {
        hits++;
        hit = i;
      }
    }
    if (hits === 0) fail("not_found", "No mask named \"" + sel.name + "\"");
    if (hits > 1) fail("bad_args", hits + " masks are named \"" + sel.name + "\"; use the index");
    return hit;
  }

  function pairList(list) {
    var out = [];
    if (!list || typeof list.length !== "number") return out;
    for (var i = 0; i < list.length && i < MAX_VERTS; i++) out.push([list[i][0], list[i][1]]);
    return out;
  }

  function numberList(list) {
    var out = [];
    if (!list || typeof list.length !== "number") return out;
    for (var i = 0; i < list.length && i < MAX_VERTS * 4; i++) out.push(Number(list[i]));
    return out;
  }

  function featherCount(s) {
    var n = 0;
    try {
      if (s.featherSegLocs && typeof s.featherSegLocs.length === "number") n = s.featherSegLocs.length;
    } catch (e) {
      n = 0;
    }
    return n;
  }

  // A mask path as plain data. The feather arrays stay on the Shape; the
  // caller only needs to know how many feather points there are and the radii.
  function shapeData(s) {
    var n = 0;
    try {
      n = s.vertices.length;
    } catch (e) {
      n = 0;
    }
    if (n > MAX_VERTS) fail("bad_args", "The mask has " + n + " vertices; at most " + MAX_VERTS + " are handled.");
    var out = {
      vertices: pairList(s.vertices),
      inTangents: pairList(s.inTangents),
      outTangents: pairList(s.outTangents),
      closed: true,
      feather_points: featherCount(s),
      feather_radii: []
    };
    try {
      out.closed = s.closed !== false;
    } catch (e1) {}
    if (out.feather_points > 0) {
      try {
        out.feather_radii = numberList(s.featherRadii);
      } catch (e2) {
        out.feather_radii = [];
      }
    }
    return out;
  }

  function twoD(v) {
    if (isArr(v) || (v && typeof v.length === "number")) return [Number(v[0]), Number(v[1])];
    return [Number(v), Number(v)];
  }

  // One mask in detail. withShape adds the path at refTime; times adds sampled paths.
  function maskDetail(layer, index, refTime, withShape, times) {
    var m = maskParade(layer).property(index);
    var d = {
      index: index,
      name: m.name,
      mode: null,
      inverted: false,
      motion_blur: null,
      roto_bezier: false,
      locked: false,
      feather: null,
      expansion: null,
      opacity: null,
      shape_keys: 0,
      shape_expression: false,
      feather_keys: 0,
      expansion_keys: 0,
      opacity_keys: 0
    };
    try { d.mode = modeName(m.maskMode); } catch (e1) {}
    try { d.inverted = m.inverted === true; } catch (e2) {}
    try { d.motion_blur = blurName(m.maskMotionBlur); } catch (e3) {}
    try { d.roto_bezier = m.rotoBezier === true; } catch (e4) {}
    try { d.locked = m.locked === true; } catch (e5) {}
    var fp = child(m, "ADBE Mask Feather");
    var ep = child(m, "ADBE Mask Offset");
    var op = child(m, "ADBE Mask Opacity");
    var sp = child(m, "ADBE Mask Shape");
    if (fp) {
      d.feather_keys = numKeysOf(fp);
      // A keyed feather is read at refTime (not at the comp's current time).
      try {
        if (d.feather_keys > 0) d.feather = twoD(fp.valueAtTime(refTime, false));
        else d.feather = twoD(fp.value);
      } catch (e6) {}
    }
    if (ep) {
      try { d.expansion = Number(ep.value); } catch (e7) {}
      d.expansion_keys = numKeysOf(ep);
    }
    if (op) {
      try { d.opacity = Number(op.value); } catch (e8) {}
      d.opacity_keys = numKeysOf(op);
    }
    if (sp) {
      d.shape_keys = numKeysOf(sp);
      // First and last key time: a merge of ranges needs ref_time inside this span.
      if (d.shape_keys > 0) {
        try { d.shape_key_span = [Number(sp.keyTime(1)), Number(sp.keyTime(d.shape_keys))]; } catch (e10) {}
      }
      d.shape_expression = hasExpression(sp);
      if (withShape) d.shape = shapeData(sp.valueAtTime(refTime, false));
      if (!withShape) {
        try { d.vertices = sp.value.vertices.length; } catch (e9) {}
      }
      if (times && times.length) {
        d.samples = [];
        for (var i = 0; i < times.length && i < MAX_SAMPLES; i++) {
          var sv = sp.valueAtTime(Number(times[i]), false);
          d.samples.push({ time: Number(times[i]), vertices: pairList(sv.vertices), feather_points: featherCount(sv) });
        }
      }
    }
    return d;
  }

  function pinEffectNames(layer) {
    var names = [];
    var effects = child(layer, "ADBE Effect Parade");
    if (!effects) return names;
    for (var i = 1; i <= effects.numProperties; i++) {
      var fx = effects.property(i);
      for (var k = 0; k < PIN_MATCH_NAMES.length; k++) {
        if (fx.matchName === PIN_MATCH_NAMES[k]) names.push(fx.name);
      }
    }
    return names;
  }

  function effectNames(layer) {
    var names = [];
    var effects = child(layer, "ADBE Effect Parade");
    if (!effects) return names;
    for (var i = 1; i <= effects.numProperties && i <= MAX_NAMES; i++) {
      names.push(effects.property(i).name + " (" + effects.property(i).matchName + ")");
    }
    return names;
  }

  // args: { comp_id, layer: selector, mask?: { index } | { name }, ref_time?, with_shape?, times? }
  A.mattesMaskRead = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var out = { comp: compBrief(comp), layer: layerBrief(layer), can_hold_masks: true, mask_count: 0, pin_effects: [], mask: null };
    var parade = null;
    try {
      parade = layer.property("ADBE Mask Parade");
    } catch (e) {
      parade = null;
    }
    if (!parade) {
      out.can_hold_masks = false;
      return out;
    }
    out.mask_count = parade.numProperties;
    out.pin_effects = pinEffectNames(layer);
    if (args.mask) {
      var idx = maskIndexOf(parade, args.mask);
      var refTime = isNum(args.ref_time) ? args.ref_time : 0;
      out.mask = maskDetail(layer, idx, refTime, args.with_shape === true, isArr(args.times) ? args.times : null);
    }
    return out;
  };

  // ---------- shared write checks ----------

  function checkTimes(times, what) {
    if (!isArr(times)) fail("bad_args", what + ": times must be an array");
    if (times.length > MAX_KEYS) fail("bad_args", what + ": " + times.length + " keys is over the " + MAX_KEYS + " per property limit; use a larger decimate_px or key a shorter stretch");
    for (var i = 0; i < times.length; i++) {
      if (!isNum(times[i]) || times[i] < 0) fail("bad_args", what + ": times[" + i + "] is not a time");
      if (i > 0 && !(times[i] > times[i - 1])) fail("bad_args", what + ": times must ascend");
    }
  }

  function checkPairs(list, n, what) {
    if (!isArr(list) || list.length !== n) fail("bad_args", what + " needs " + n + " [x, y] points");
    for (var i = 0; i < n; i++) {
      var pt = list[i];
      if (!isArr(pt) || pt.length !== 2 || !isNum(pt[0]) || !isNum(pt[1])) fail("bad_args", what + "[" + i + "] is not a finite [x, y]");
    }
  }

  function checkShape(sh, n, what) {
    if (!sh || !isArr(sh.vertices)) fail("bad_args", what + ": a shape needs vertices");
    var cnt = sh.vertices.length;
    if (cnt < 2 || cnt > MAX_VERTS) fail("bad_args", what + ": a mask path needs 2-" + MAX_VERTS + " vertices, got " + cnt);
    if (n !== null && cnt !== n) fail("bad_args", what + ": the vertex count changes between keys (" + n + " then " + cnt + "); AE needs the same count in every key");
    checkPairs(sh.vertices, cnt, what + " vertices");
    checkPairs(sh.inTangents, cnt, what + " inTangents");
    checkPairs(sh.outTangents, cnt, what + " outTangents");
    return cnt;
  }

  // A property's hard limits: AE throws "out of range" mid-write. values is a list of numbers or [x, y] pairs.
  function checkLimits(prop, values, width, what) {
    var hasMin = false;
    var hasMax = false;
    var mn = null;
    var mx = null;
    try {
      hasMin = prop.hasMin === true;
      hasMax = prop.hasMax === true;
      if (hasMin) mn = prop.minValue;
      if (hasMax) mx = prop.maxValue;
    } catch (e) {
      return;
    }
    for (var i = 0; i < values.length; i++) {
      for (var j = 0; j < width; j++) {
        var v = width === 1 ? values[i] : values[i][j];
        var lo = mn;
        var hi = mx;
        if (isArr(lo)) lo = lo[j];
        if (isArr(hi)) hi = hi[j];
        if (hasMin && typeof lo === "number" && v < lo) fail("bad_args", what + ": value " + v + " is below the property's minimum " + lo);
        if (hasMax && typeof hi === "number" && v > hi) fail("bad_args", what + ": value " + v + " is above the property's maximum " + hi);
      }
    }
  }

  // Keys or an expression on a property the write is about to set.
  function checkSettable(prop, replace, what) {
    var n = numKeysOf(prop);
    if (n > 0 && replace !== true) fail("bad_args", what + " already has " + n + " keyframes; pass replace_keys to replace them");
    if (hasExpression(prop)) fail("bad_args", what + " has an expression, which would override the value; remove the expression first");
  }

  function clearKeys(prop) {
    for (var k = prop.numKeys; k >= 1; k--) prop.removeKey(k);
  }

  // Keys inside a time range { start, end } (seconds, ends included).
  function keysInRange(prop, r) {
    var n = 0;
    for (var k = 1; k <= numKeysOf(prop); k++) {
      var t = prop.keyTime(k);
      if (t >= r.start - 1e-9 && t <= r.end + 1e-9) n++;
    }
    return n;
  }

  function clearKeysInRange(prop, r) {
    for (var k = prop.numKeys; k >= 1; k--) {
      var t = prop.keyTime(k);
      if (t >= r.start - 1e-9 && t <= r.end + 1e-9) prop.removeKey(k);
    }
  }

  // Like checkSettable, but only the keys inside the range count: the others stay.
  function checkSettableInRange(prop, replace, r, what) {
    var n = keysInRange(prop, r);
    if (n > 0 && replace !== true) fail("bad_args", what + " already has " + n + " keyframes inside that range; pass replace_keys to replace them (keys outside the range are kept)");
    if (hasExpression(prop)) fail("bad_args", what + " has an expression, which would override the value; remove the expression first");
  }

  function linearKeys(prop) {
    var lin = KeyframeInterpolationType.LINEAR;
    for (var k = 1; k <= prop.numKeys; k++) prop.setInterpolationTypeAtKey(k, lin, lin);
  }

  // Linear interpolation only on the keys inside the range: the others keep theirs.
  function linearKeysInRange(prop, r) {
    var lin = KeyframeInterpolationType.LINEAR;
    for (var k = 1; k <= prop.numKeys; k++) {
      var t = prop.keyTime(k);
      if (t >= r.start - 1e-9 && t <= r.end + 1e-9) prop.setInterpolationTypeAtKey(k, lin, lin);
    }
  }

  function pairArg(v, what) {
    if (!isArr(v) || v.length !== 2 || !isNum(v[0]) || !isNum(v[1])) fail("bad_args", what + " must be [x, y]");
    return v;
  }

  // Shape for setValue / setValuesAtTimes. A refShape (the mask's own path)
  // lends its feather arrays, so the feather points stay on their segments;
  // scale multiplies featherRadii (null leaves them).
  function buildShape(data, closed, refShape, scale) {
    var s = new Shape();
    s.vertices = data.vertices;
    s.inTangents = data.inTangents;
    s.outTangents = data.outTangents;
    s.closed = closed !== false;
    if (refShape) {
      for (var f = 0; f < FEATHER_FIELDS.length; f++) {
        var name = FEATHER_FIELDS[f];
        var v;
        try {
          v = refShape[name];
        } catch (e0) {
          v = undefined;
        }
        if (v === undefined || v === null) continue;
        if (name === "featherRadii" && scale !== null && scale !== undefined) {
          var scaled = [];
          for (var r = 0; r < v.length; r++) scaled.push(v[r] * scale);
          v = scaled;
        }
        try {
          s[name] = v;
        } catch (e1) {}
      }
    }
    return s;
  }

  function setWorkArea(comp, wa) {
    var fd = 1 / compFps(comp);
    // Shrink first so the new start can't push the old end past the comp.
    comp.workAreaDuration = fd;
    comp.workAreaStart = wa.start;
    comp.workAreaDuration = wa.duration;
  }

  // Returns the work area to set: the duration is clamped to what is left of
  // the comp, so start + duration never goes past comp.duration. Only float
  // noise (1e-6 s) is clamped; anything more is refused.
  function checkWorkArea(comp, wa) {
    if (!wa || !isNum(wa.start) || !isNum(wa.duration)) fail("bad_args", "work_area needs start and duration in seconds");
    var fd = 1 / compFps(comp);
    if (wa.start < 0 || !(wa.duration >= fd * 0.999)) fail("bad_args", "work_area start must be >= 0 and its duration at least one frame");
    if (wa.start + wa.duration > comp.duration + 1e-6) {
      fail("bad_args", "work_area ends at " + (wa.start + wa.duration) + " s, past the comp's end (" + comp.duration + " s)");
    }
    var room = comp.duration - wa.start;
    var dur = wa.duration;
    if (dur > room) dur = room;
    if (!(dur >= fd * 0.999)) fail("bad_args", "work_area leaves less than one frame before the comp's end (" + comp.duration + " s)");
    return { start: wa.start, duration: dur };
  }

  // ---------- mask follow ----------

  // args: { comp_id, layer: { index, id }, mask: { index } | null (a new mask),
  //   name?, mode?, inverted?, motion_blur?, opacity?, expansion?, feather?: [x, y],
  //   base_feather?, feather_scales?, ref_time, closed, times, shapes, static_shape,
  //   replace_keys?, work_area?: { start, duration }, expect, label }
  // shapes[i] = { vertices, inTangents, outTangents } for times[i]. Validates all, then writes.
  function planFollow(comp, layer, args) {
    var what = "Layer \"" + layer.name + "\"";
    if (layer.locked === true) fail("bad_args", what + " is locked");
    var parade = maskParade(layer);
    var replace = args.replace_keys === true;
    var times = args.times;
    if (times === undefined || times === null) times = [];
    checkTimes(times, what);
    var shapes = args.shapes;
    if (times.length > 0) {
      if (!isArr(shapes) || shapes.length !== times.length) fail("bad_args", what + ": needs one shape per time");
      if (args.static_shape) fail("bad_args", what + ": give keyed shapes or one static shape, not both");
    }
    var keyRange = null;
    if (args.key_range) {
      if (!isNum(args.key_range.start) || !isNum(args.key_range.end) || !(args.key_range.end > args.key_range.start)) fail("bad_args", what + ": key_range needs start < end in seconds");
      keyRange = { start: args.key_range.start, end: args.key_range.end };
    }
    var plan = {
      created: !args.mask,
      index: 0,
      keyRange: keyRange,
      refShape: null,
      times: times,
      shapes: times.length > 0 ? shapes : null,
      staticShape: args.static_shape ? args.static_shape : null,
      replace: replace,
      vertexCount: 0,
      workArea: null
    };
    var m = null;
    var sp = null;
    if (args.mask) {
      plan.index = maskIndexOf(parade, args.mask);
      m = parade.property(plan.index);
      var locked = false;
      try { locked = m.locked === true; } catch (e0) { locked = false; }
      if (locked) fail("bad_args", what + " mask " + plan.index + " is locked");
      sp = child(m, "ADBE Mask Shape");
      if (!sp) fail("not_found", "Mask " + plan.index + " has no path property");
    }
    // The path.
    var n = null;
    var i;
    if (plan.shapes) {
      for (i = 0; i < plan.shapes.length; i++) {
        var cnt = checkShape(plan.shapes[i], n, what + " shape " + i);
        if (n === null) n = cnt;
      }
      plan.vertexCount = n;
    }
    if (plan.staticShape) {
      plan.vertexCount = checkShape(plan.staticShape, null, what + " static shape");
    }
    if (sp && (plan.shapes || plan.staticShape)) {
      if (keyRange) checkSettableInRange(sp, replace, keyRange, what + " mask " + plan.index + " path");
      else checkSettable(sp, replace, what + " mask " + plan.index + " path");
      var refShape = null;
      refShape = sp.valueAtTime(isNum(args.ref_time) ? args.ref_time : 0, false);
      var have = refShape.vertices.length;
      if (plan.vertexCount !== have) {
        fail("bad_args", what + " mask " + plan.index + " has " + have + " vertices and the shapes have " + plan.vertexCount + "; the vertex count of a mask can't change while it is followed");
      }
      plan.refShape = refShape;
    }
    // The other mask properties.
    if (args.mode) modeValue(args.mode);
    if (args.motion_blur) blurValue(args.motion_blur);
    if (args.opacity !== undefined && args.opacity !== null && !isNum(args.opacity)) fail("bad_args", "opacity must be a number");
    if (args.expansion !== undefined && args.expansion !== null && !isNum(args.expansion)) fail("bad_args", "expansion must be a number");
    if (args.feather !== undefined && args.feather !== null) pairArg(args.feather, "feather");
    var scales = args.feather_scales;
    if (scales !== undefined && scales !== null) {
      if (!isArr(scales) || scales.length !== times.length) fail("bad_args", what + ": feather_scales needs one number per time");
      for (i = 0; i < scales.length; i++) {
        if (!isNum(scales[i]) || scales[i] < 0) fail("bad_args", what + ": feather_scales[" + i + "] is not a non-negative number");
      }
      pairArg(args.base_feather, "base_feather");
    }
    if (m) {
      var fp = child(m, "ADBE Mask Feather");
      var ep = child(m, "ADBE Mask Offset");
      var op = child(m, "ADBE Mask Opacity");
      if (fp && ((args.feather !== undefined && args.feather !== null) || (scales !== undefined && scales !== null))) {
        if (keyRange && scales) checkSettableInRange(fp, replace, keyRange, what + " mask " + plan.index + " feather");
        else checkSettable(fp, replace, what + " mask " + plan.index + " feather");
        if (scales) {
          var fv = [];
          for (i = 0; i < scales.length; i++) fv.push([args.base_feather[0] * scales[i], args.base_feather[1] * scales[i]]);
          checkLimits(fp, fv, 2, what + " mask feather");
        } else {
          checkLimits(fp, [args.feather], 2, what + " mask feather");
        }
      }
      if (ep && args.expansion !== undefined && args.expansion !== null) {
        checkSettable(ep, replace, what + " mask " + plan.index + " expansion");
        checkLimits(ep, [args.expansion], 1, what + " mask expansion");
      }
      if (op && args.opacity !== undefined && args.opacity !== null) {
        checkSettable(op, replace, what + " mask " + plan.index + " opacity");
        checkLimits(op, [args.opacity], 1, what + " mask opacity");
      }
    }
    if (args.work_area) plan.workArea = checkWorkArea(comp, args.work_area);
    return plan;
  }

  // Sets the path (keyed or static). withFeather false leaves the reference
  // shape's feather arrays out.
  function setPath(mk, plan, args, scales, withFeather) {
    var prop = mk().property("ADBE Mask Shape");
    var ref = null;
    if (withFeather) ref = plan.refShape;
    var i;
    if (plan.shapes) {
      var objs = [];
      for (i = 0; i < plan.shapes.length; i++) {
        var sc = null;
        if (withFeather && scales !== undefined && scales !== null) sc = scales[i];
        objs.push(buildShape(plan.shapes[i], args.closed, ref, sc));
      }
      prop.setValuesAtTimes(plan.times, objs);
    } else {
      prop.setValue(buildShape(plan.staticShape, args.closed, ref, null));
    }
  }

  // The path goes first, so a failure here leaves the other properties alone.
  // AE checks the feather data when the Shape is applied, not when its fields
  // are assigned: if that fails, the path is written again without the feather
  // arrays and the result says so. It throws only when nothing was changed yet.
  function writePath(mk, plan, args, scales, out) {
    var prop = mk().property("ADBE Mask Shape");
    if (plan.keyRange) {
      if (plan.replace) out.replaced_keys = keysInRange(prop, plan.keyRange);
      else out.replaced_keys = 0;
    } else {
      out.replaced_keys = numKeysOf(prop);
    }
    var changed = plan.created;
    var err = null;
    out.kept_keys = 0;
    var featherPts = 0;
    if (plan.refShape) featherPts = featherCount(plan.refShape);
    try {
      if (plan.keyRange) {
        if (plan.replace && keysInRange(prop, plan.keyRange) > 0) {
          clearKeysInRange(prop, plan.keyRange);
          changed = true;
        }
        out.kept_keys = numKeysOf(mk().property("ADBE Mask Shape"));
      } else if (plan.replace && numKeysOf(prop) > 0) {
        clearKeys(prop);
        changed = true;
      }
      setPath(mk, plan, args, scales, true);
    } catch (e1) {
      err = e1;
      if (featherPts > 0) {
        try {
          if (plan.keyRange) clearKeysInRange(mk().property("ADBE Mask Shape"), plan.keyRange);
          else clearKeys(mk().property("ADBE Mask Shape"));
          changed = true;
          setPath(mk, plan, args, scales, false);
          out.feather_fallback = true;
          out.feather_points_dropped = featherPts;
          out.feather_error = String(e1.message);
          err = null;
        } catch (e2) {
          err = e2;
        }
      }
    }
    if (err) {
      if (!changed) throw err;
      out.path_error = String(err.message);
      out.keys = numKeysOf(mk().property("ADBE Mask Shape"));
      return;
    }
    prop = mk().property("ADBE Mask Shape");
    if (plan.shapes) {
      try {
        if (plan.keyRange) linearKeysInRange(prop, plan.keyRange);
        else linearKeys(prop);
      } catch (e3) {
        out.interpolation_error = String(e3.message);
      }
    }
    out.keys = mk().property("ADBE Mask Shape").numKeys;
  }

  function performFollow(comp, layer, plan, args) {
    var out = { layer: { index: layer.index, id: layer.id, name: layer.name }, created: plan.created, replaced_keys: 0 };
    var i;
    if (plan.created) {
      maskParade(layer).addProperty("ADBE Mask Atom");
      plan.index = maskParade(layer).numProperties;
    }
    // Every step looks the mask up again from the layer.
    var mk = function () {
      return maskParade(layer).property(plan.index);
    };
    var scales = args.feather_scales;
    if (plan.shapes || plan.staticShape) writePath(mk, plan, args, scales, out);
    if (args.name) mk().name = args.name;
    if (args.mode) mk().maskMode = modeValue(args.mode);
    if (args.inverted !== undefined && args.inverted !== null) mk().inverted = args.inverted === true;
    if (args.motion_blur) mk().maskMotionBlur = blurValue(args.motion_blur);
    var prop;
    if (args.expansion !== undefined && args.expansion !== null) {
      prop = mk().property("ADBE Mask Offset");
      if (plan.replace) clearKeys(prop);
      prop.setValue(args.expansion);
    }
    if (args.opacity !== undefined && args.opacity !== null) {
      prop = mk().property("ADBE Mask Opacity");
      if (plan.replace) clearKeys(prop);
      prop.setValue(args.opacity);
    }
    if (scales !== undefined && scales !== null && plan.times.length > 0) {
      prop = mk().property("ADBE Mask Feather");
      if (plan.replace) {
        if (plan.keyRange) clearKeysInRange(prop, plan.keyRange);
        else clearKeys(prop);
      }
      var fv = [];
      for (i = 0; i < scales.length; i++) fv.push([args.base_feather[0] * scales[i], args.base_feather[1] * scales[i]]);
      prop.setValuesAtTimes(plan.times, fv);
      if (plan.keyRange) linearKeysInRange(mk().property("ADBE Mask Feather"), plan.keyRange);
      else linearKeys(mk().property("ADBE Mask Feather"));
    } else if (args.feather !== undefined && args.feather !== null) {
      prop = mk().property("ADBE Mask Feather");
      if (plan.replace) clearKeys(prop);
      prop.setValue(args.feather);
    }
    if (plan.workArea) {
      var prevStart = comp.workAreaStart;
      var prevDur = comp.workAreaDuration;
      try {
        setWorkArea(comp, plan.workArea);
      } catch (eW) {
        out.work_area_error = String(eW.message);
        try {
          setWorkArea(comp, { start: prevStart, duration: prevDur });
        } catch (eW2) {}
      }
      out.work_area = { start: comp.workAreaStart, duration: comp.workAreaDuration };
    }
    var after = mk();
    out.mask = { index: plan.index, name: after.name };
    out.vertices = plan.vertexCount;
    // What the host believes it left, for the receipt; the read-back is separate.
    out.mode = modeName(after.maskMode);
    return out;
  }

  A.mattesFollowApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = layerByIndexId(comp, args.layer.index, args.layer.id);
    var plan = planFollow(comp, layer, args);
    return A.withUndo(args.label || "Mask follow", function () {
      return performFollow(comp, layer, plan, args);
    });
  };

  // ---------- garbage matte ----------

  function matteTypeName(t) {
    if (t === TrackMatteType.ALPHA) return "alpha";
    if (t === TrackMatteType.ALPHA_INVERTED) return "alpha_inverted";
    if (t === TrackMatteType.LUMA) return "luma";
    if (t === TrackMatteType.LUMA_INVERTED) return "luma_inverted";
    if (t === TrackMatteType.NO_TRACK_MATTE) return "none";
    return String(t);
  }

  function matteTypeValue(name) {
    if (name === "alpha") return TrackMatteType.ALPHA;
    if (name === "alpha_inverted") return TrackMatteType.ALPHA_INVERTED;
    if (name === "luma") return TrackMatteType.LUMA;
    if (name === "luma_inverted") return TrackMatteType.LUMA_INVERTED;
    fail("bad_args", "Unknown track matte type \"" + name + "\"");
    return null;
  }

  // AE 23 made the matte a layer reference (setTrackMatte); before, it was the layer above.
  function hasModernMatteApi(layer) {
    try {
      return layer.setTrackMatte !== undefined && layer.setTrackMatte !== null;
    } catch (e) {
      return false;
    }
  }

  function hasVideoOf(l) {
    var v = true;
    try {
      if (l.hasVideo === false) v = false;
    } catch (e) {
      v = true;
    }
    return v;
  }

  function briefOf(l) {
    return { index: l.index, id: l.id, name: l.name };
  }

  function matteEntry(l) {
    var e = { found: true, id: l.id, index: l.index, name: l.name, enabled: l.enabled === true, locked: l.locked === true, matte_type: "none", matte_layer: null };
    try {
      var tm = l.trackMatteType;
      if (tm !== undefined) e.matte_type = matteTypeName(tm);
    } catch (e1) {}
    var modernRead = false;
    try {
      modernRead = l.trackMatteLayer !== undefined;
      if (l.trackMatteLayer) e.matte_layer = briefOf(l.trackMatteLayer);
    } catch (e2) {}
    // Before AE 23 there is no trackMatteLayer: a layer with a track matte uses the layer directly above.
    if (!modernRead && e.matte_type !== "none") {
      try {
        if (l.index > 1) {
          e.matte_layer = briefOf(l.containingComp.layer(l.index - 1));
          e.legacy = true;
        }
      } catch (e2b) {}
    }
    try { e.is_track_matte = l.isTrackMatte === true; } catch (e3) {}
    return e;
  }

  function chokeValue(layer) {
    var effects = child(layer, "ADBE Effect Parade");
    if (!effects) return null;
    for (var i = 1; i <= effects.numProperties; i++) {
      if (effects.property(i).matchName === CHOKER) {
        var p = child(effects.property(i), "ADBE Simple Choker-0002");
        if (!p) p = child(effects.property(i), "Choke Matte");
        if (p) return Number(p.value);
      }
    }
    return null;
  }

  // args: { comp_id, layers?: [selector], layer_ids?: [id], matte?: selector, matte_id?: id, times? }
  A.mattesGarbageRead = function (args) {
    var comp = requireComp(args.comp_id);
    var out = { comp: compBrief(comp), layers: [], matte: null };
    var i;
    var sels = isArr(args.layers) ? args.layers : [];
    for (i = 0; i < sels.length && i < MAX_LIST; i++) {
      try {
        out.layers.push(matteEntry(findLayer(comp, sels[i])));
      } catch (e) {
        out.layers.push({ found: false, selector: sels[i], message: String(e.message) });
      }
    }
    var ids = isArr(args.layer_ids) ? args.layer_ids : [];
    for (i = 0; i < ids.length && i < MAX_LIST; i++) {
      var l = layerById(comp, ids[i]);
      if (l) out.layers.push(matteEntry(l));
      else out.layers.push({ found: false, id: ids[i], message: "No layer with that id" });
    }
    var matte = null;
    if (args.matte_id !== undefined && args.matte_id !== null) matte = layerById(comp, args.matte_id);
    else if (args.matte) {
      try {
        matte = findLayer(comp, args.matte);
      } catch (e2) {
        matte = null;
      }
    }
    if (matte) {
      var me = matteEntry(matte);
      me.is_solid = false;
      try { me.is_solid = matte.source && matte.source.mainSource instanceof SolidSource; } catch (e3) {}
      me.effects = effectNames(matte);
      me.choke = chokeValue(matte);
      var parade = child(matte, "ADBE Mask Parade");
      me.mask_count = parade ? parade.numProperties : 0;
      me.mask = null;
      if (parade && parade.numProperties >= 1) me.mask = maskDetail(matte, 1, 0, false, isArr(args.times) ? args.times : null);
      out.matte = me;
    }
    return out;
  };

  // True / false when app.effects can say whether an effect exists; null when it can't.
  function effectKnown(matchName) {
    var list = null;
    try {
      list = app.effects;
    } catch (e) {
      list = null;
    }
    if (!list || typeof list.length !== "number") return null;
    for (var i = 0; i < list.length; i++) {
      try {
        if (list[i].matchName === matchName) return true;
      } catch (e2) {}
    }
    return false;
  }

  function addChoke(layer, amount) {
    var res = { applied: false, value: amount };
    try {
      child(layer, "ADBE Effect Parade").addProperty(CHOKER);
      // The effect is new on a new solid, so it is the only one; look it up again anyway.
      var effects = child(layer, "ADBE Effect Parade");
      var fx = null;
      for (var i = 1; i <= effects.numProperties; i++) {
        if (effects.property(i).matchName === CHOKER) fx = effects.property(i);
      }
      if (!fx) {
        res.error = "The Simple Choker effect was not found after adding it";
        return res;
      }
      var p = child(fx, "ADBE Simple Choker-0002");
      if (!p) p = child(fx, "Choke Matte");
      if (!p) {
        res.error = "The Simple Choker has no Choke Matte property (found by match name ADBE Simple Choker-0002 or by name)";
        return res;
      }
      p.setValue(amount);
      res.applied = true;
    } catch (e) {
      res.error = String(e.message);
    }
    return res;
  }

  // args: { comp_id, targets: [selector], matte_type, matte_layer?: selector,
  //   name?, closed?, times?, shapes?, static_shape?, ref_time?, feather?: [x, y],
  //   expansion?, choke?, hide_matte?, replace_existing_matte?, expect, label }
  // A new matte is a comp-size white solid placed directly above the topmost
  // target, holding one mask (mode Add) that is keyed when times/shapes are given.
  A.mattesGarbageApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var typeValue = matteTypeValue(args.matte_type);
    var tsel = args.targets;
    if (!isArr(tsel) || tsel.length < 1) fail("bad_args", "targets must be a non-empty array");
    var targets = [];
    var i;
    var j;
    for (i = 0; i < tsel.length; i++) {
      var tl = findLayer(comp, tsel[i]);
      for (j = 0; j < targets.length; j++) {
        if (targets[j].id === tl.id) fail("bad_args", "\"" + tl.name + "\" is listed twice in targets");
      }
      var rn = reflectName(tl);
      if (rn === "CameraLayer" || rn === "LightLayer") fail("bad_args", "Track mattes apply to AV layers only; \"" + tl.name + "\" is a " + rn);
      if (tl.locked === true) fail("bad_args", "Target \"" + tl.name + "\" is locked");
      if (!hasVideoOf(tl)) fail("bad_args", "Target \"" + tl.name + "\" has no video (an audio-only layer), so a track matte makes no sense on it");
      var existing;
      try {
        existing = tl.trackMatteType;
      } catch (eT) {
        existing = undefined;
      }
      if (existing === undefined) fail("bad_args", "\"" + tl.name + "\" can't take a track matte");
      if (existing !== TrackMatteType.NO_TRACK_MATTE && args.replace_existing_matte !== true) {
        fail("bad_args", "\"" + tl.name + "\" already has a " + matteTypeName(existing) + " track matte; pass replace_existing_matte to replace it");
      }
      targets.push(tl);
    }
    var modern = hasModernMatteApi(targets[0]);
    var topTarget = targets[0];
    for (i = 1; i < targets.length; i++) {
      if (targets[i].index < topTarget.index) topTarget = targets[i];
    }
    var existingMatte = null;
    var hide = args.hide_matte !== false;
    if (args.matte_layer) {
      existingMatte = findLayer(comp, args.matte_layer);
      if (existingMatte.locked === true && (existingMatte.enabled === true) === hide) {
        fail("bad_args", "Matte layer \"" + existingMatte.name + "\" is locked and its video switch would have to change (hide_matte is " + hide + "); unlock it first or pass hide_matte: " + !hide);
      }
      if (!hasVideoOf(existingMatte)) fail("bad_args", "Matte layer \"" + existingMatte.name + "\" has no video, so it can't be a track matte");
      // A matte whose own matte chain leads back to a target would be a loop.
      var chain = null;
      try { chain = existingMatte.trackMatteLayer; } catch (eC0) { chain = null; }
      for (var hop = 0; hop < 50 && chain; hop++) {
        for (j = 0; j < targets.length; j++) {
          if (targets[j].id === chain.id) {
            fail("bad_args", "Matte layer \"" + existingMatte.name + "\" is itself matted by \"" + targets[j].name + "\" (directly or through other mattes), which would make a matte loop");
          }
        }
        var nextLink = null;
        try { nextLink = chain.trackMatteLayer; } catch (eC) { nextLink = null; }
        chain = nextLink;
      }
      for (i = 0; i < targets.length; i++) {
        if (targets[i].id === existingMatte.id) fail("bad_args", "A layer can't be its own track matte");
      }
      var mrn = reflectName(existingMatte);
      if (mrn === "CameraLayer" || mrn === "LightLayer") fail("bad_args", "A " + mrn + " can't be a track matte");
      if (!modern) {
        if (targets.length > 1) fail("bad_args", "This AE (before 23) takes the layer above as the matte, so one matte can serve one target only.");
        if (existingMatte.index !== targets[0].index - 1) {
          fail("bad_args", "This AE (before 23) uses the layer directly above as the matte; move \"" + existingMatte.name + "\" to index " + (targets[0].index - 1) + " first");
        }
      }
    } else if (!modern && targets.length > 1) {
      fail("bad_args", "This AE (before 23) takes the layer above as the matte, so one new matte can serve one target only.");
    }
    // The matte solid's mask.
    var times = args.times;
    if (times === undefined || times === null) times = [];
    var shapes = args.shapes;
    var hasMask = !existingMatte;
    if (hasMask) {
      checkTimes(times, "The matte mask");
      if (times.length > 0) {
        if (!isArr(shapes) || shapes.length !== times.length) fail("bad_args", "The matte mask needs one shape per time");
        var n = null;
        for (i = 0; i < shapes.length; i++) {
          var c = checkShape(shapes[i], n, "The matte mask shape " + i);
          if (n === null) n = c;
        }
      } else if (args.static_shape) {
        checkShape(args.static_shape, null, "The matte mask");
      } else {
        fail("bad_args", "A new matte needs a region (a static shape or keyed shapes)");
      }
      if (args.feather !== undefined && args.feather !== null) pairArg(args.feather, "feather");
      if (args.expansion !== undefined && args.expansion !== null && !isNum(args.expansion)) fail("bad_args", "expansion must be a number");
      if (args.choke !== undefined && args.choke !== null) {
        if (!isNum(args.choke)) fail("bad_args", "choke must be a number");
        if (effectKnown(CHOKER) === false) fail("bad_args", "This AE has no Simple Choker effect (" + CHOKER + ")");
      }
    }
    var matteName = args.name;
    if (!matteName) matteName = targets[0].name + " MATTE";
    var targetIds = [];
    for (i = 0; i < targets.length; i++) targetIds.push(targets[i].id);
    var topId = topTarget.id;
    var topIndexBefore = topTarget.index;

    return A.withUndo(args.label || "Garbage matte", function () {
      var out = { created: hasMask, api: "legacy", targets: [], keys: 0 };
      if (modern) out.api = "setTrackMatte";
      var matte = existingMatte;
      var matteId;
      if (hasMask) {
        matte = comp.layers.addSolid([1, 1, 1], matteName, comp.width, comp.height, comp.pixelAspect, comp.duration);
        matte.name = matteName;
        matteId = matte.id;
        // Directly above the topmost target.
        var top = layerById(comp, topId);
        layerById(comp, matteId).moveBefore(top);
        var layerNow = layerById(comp, matteId);
        maskParade(layerNow).addProperty("ADBE Mask Atom");
        var mi = maskParade(layerNow).numProperties;
        var mk = function () {
          return maskParade(layerById(comp, matteId)).property(mi);
        };
        mk().maskMode = MaskMode.ADD;
        mk().name = "Matte";
        if (args.feather !== undefined && args.feather !== null) mk().property("ADBE Mask Feather").setValue(args.feather);
        if (args.expansion !== undefined && args.expansion !== null) mk().property("ADBE Mask Offset").setValue(args.expansion);
        var prop;
        if (times.length > 0) {
          var objs = [];
          for (var s = 0; s < shapes.length; s++) objs.push(buildShape(shapes[s], args.closed, null, null));
          prop = mk().property("ADBE Mask Shape");
          prop.setValuesAtTimes(times, objs);
          prop = mk().property("ADBE Mask Shape");
          linearKeys(prop);
          out.keys = prop.numKeys;
        } else {
          mk().property("ADBE Mask Shape").setValue(buildShape(args.static_shape, args.closed, null, null));
        }
        out.mask = { index: mi };
        if (args.choke !== undefined && args.choke !== null && args.choke !== 0) {
          out.choke = addChoke(layerById(comp, matteId), args.choke);
        }
      } else {
        matteId = existingMatte.id;
      }
      var previous = [];
      for (var t = 0; t < targetIds.length; t++) {
        var tn = layerById(comp, targetIds[t]);
        var mnow = layerById(comp, matteId);
        var prev = null;
        try {
          if (tn.trackMatteLayer) prev = briefOf(tn.trackMatteLayer);
        } catch (eP) {
          prev = null;
        }
        var setError = null;
        try {
          if (modern) tn.setTrackMatte(mnow, typeValue);
          else tn.trackMatteType = typeValue;
        } catch (eS) {
          setError = String(eS.message);
        }
        var te = briefOf(layerById(comp, targetIds[t]));
        if (setError) te.error = setError;
        if (prev) te.previous_matte = prev;
        out.targets.push(te);
        if (prev) previous.push(prev);
      }
      // setTrackMatte may switch the matte's video off by itself: set the choice explicitly.
      var fin = layerById(comp, matteId);
      try {
        if ((fin.enabled === true) === hide) fin.enabled = !hide;
      } catch (eE) {
        out.enabled_error = String(eE.message);
      }
      fin = layerById(comp, matteId);
      out.matte = briefOf(fin);
      out.hidden = hide;
      out.top_target_index_before = topIndexBefore;
      return out;
    });
  };

  // ---------- Content-Aware Fill leftovers ----------

  function looksLikeFill(name) {
    return /fill/i.test(String(name));
  }

  // args: { comp_id, plate?: selector }
  A.mattesFindFill = function (args) {
    var comp = requireComp(args.comp_id);
    var fd = 1 / compFps(comp);
    var wa = { start: comp.workAreaStart, end: comp.workAreaStart + comp.workAreaDuration };
    var out = { comp: compBrief(comp), plate: null, fill_folders: [], candidates: [], scanned: 0, truncated: false };
    var plateIndex = null;
    if (args.plate) {
      var pl = findLayer(comp, args.plate);
      out.plate = layerBrief(pl);
      plateIndex = pl.index;
    }
    var i;
    var items = app.project.numItems;
    for (i = 1; i <= items && out.fill_folders.length < MAX_NAMES; i++) {
      var it = app.project.item(i);
      if (it instanceof FolderItem && looksLikeFill(it.name)) out.fill_folders.push(it.name);
    }
    var n = comp.numLayers;
    if (n > MAX_LIST) {
      n = MAX_LIST;
      out.truncated = true;
    }
    for (i = 1; i <= n; i++) {
      var l = comp.layer(i);
      out.scanned++;
      var src = null;
      try { src = l.source; } catch (e0) { src = null; }
      if (!src || !(src instanceof FootageItem)) continue;
      var folderName = "";
      try { if (src.parentFolder) folderName = String(src.parentFolder.name); } catch (e1) { folderName = ""; }
      var inFolder = looksLikeFill(folderName);
      var byName = looksLikeFill(src.name) || looksLikeFill(l.name);
      if (!inFolder && !byName) continue;
      var c = {
        layer: briefOf(l),
        enabled: l.enabled === true,
        source: { id: src.id, name: src.name, folder: folderName },
        in_point: l.inPoint,
        out_point: l.outPoint,
        in_fill_folder: inFolder,
        name_matches: byName,
        above_plate: plateIndex === null ? null : l.index < plateIndex,
        matches_work_area: Math.abs(l.inPoint - wa.start) <= 2 * fd && Math.abs(l.outPoint - wa.end) <= 2 * fd
      };
      try { if (src.file) c.source.file = String(src.file.fsName); } catch (e2) {}
      if (out.candidates.length < MAX_NAMES) out.candidates.push(c);
    }
    return out;
  };
})($.global);
