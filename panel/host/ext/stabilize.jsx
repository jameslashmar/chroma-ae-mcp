// panel/host/ext/stabilize.jsx
//
// Host functions for ae_stabilize and ae_stabilize_roundtrip. Every name
// starts with "stabilize" because other groups add functions to the same
// object. Layer-transform and Corner Pin keys are written by the planar
// group's A.planarWriteRaw (planar.jsx must be loaded); the Transform effect
// ('ADBE Geometry2'), Motion Tile ('ADBE Tile') and the roundtrip rig are
// this file's own code.
//
// - stabilizeInspect (read): the plate layer, its transform at a time, its
//   keys, effects and masks, and the comp, so the server can refuse early
// - stabilizeApply (guarded write): the stabilizing keys on the layer
//   transform, a Transform effect or a Corner Pin, plus an optional Motion
//   Tile in front of them, in one undo group
// - stabilizeReadBack (read): key counts and values, effect order, flags
// - stabilizeRigBuild (guarded write): the work comp, the plate copy as a
//   guide layer, the work comp placed over the plate with the inverse motion
// - stabilizeRigRead (read): what a rig looks like in the project
// - stabilizeRigRemove (guarded write): takes a rig this tool made out again
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Reads never change time, selection, solo, resolution or the active item.
// - Writes check the guard first, validate everything that can fail before
//   A.withUndo, and open and close the undo group in the same call.
// - Adding an effect invalidates references to the others: effects are
//   looked up again, by their (unique) name, after every addProperty.
// - A write that fails inside the group takes back what it added: the group
//   closes, but it leaves no half-made effect or comp behind.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_FRAMES = 3000;
  var MAX_LISTED = 50;
  var RIG_PREFIX = "chroma-ae-mcp:stabilize-roundtrip";
  var TRANSFORM_FX_NAME = "Stabilize Transform";
  var TILE_FX_NAME = "Stabilize Tile";
  var TRANSFORM_FX = "ADBE Geometry2";
  var TILE_FX = "ADBE Tile";
  var PIN_FX = "ADBE Corner Pin";

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

  function compFps(comp) {
    var fps = Number(comp.frameRate);
    if (!(fps > 0)) fps = 25;
    return fps;
  }

  function requireSquarePixels(comp) {
    var pa = Number(comp.pixelAspect);
    if (pa > 0 && Math.abs(pa - 1) > 1e-6) {
      fail("bad_args", "The comp's pixel aspect is " + pa + ", not 1. Stabilizing works on square pixels only.");
    }
  }

  function xy(v) {
    return [Number(v[0]), Number(v[1])];
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

  function expressionOn(prop) {
    var ex = false;
    try {
      ex = prop.expressionEnabled === true;
    } catch (e) {
      ex = false;
    }
    return ex;
  }

  function separatedDims(prop) {
    try {
      return prop.dimensionsSeparated === true;
    } catch (e) {
      return false;
    }
  }

  // Auto-Orient Along Path adds a path-tangent rotation on top of written Position keys.
  function autoOrientOn(layer) {
    try {
      if (typeof AutoOrientType === "undefined") return false;
      return layer.autoOrient !== AutoOrientType.NO_AUTO_ORIENT;
    } catch (e) {
      return false;
    }
  }

  function valueTypeName(prop) {
    var t = prop.propertyValueType;
    if (t === PropertyValueType.OneD) return "OneD";
    if (t === PropertyValueType.TwoD) return "TwoD";
    if (t === PropertyValueType.TwoD_SPATIAL) return "TwoD_SPATIAL";
    if (t === PropertyValueType.ThreeD) return "ThreeD";
    if (t === PropertyValueType.ThreeD_SPATIAL) return "ThreeD_SPATIAL";
    if (t === PropertyValueType.COLOR) return "COLOR";
    if (t === PropertyValueType.CUSTOM_VALUE) return "CUSTOM_VALUE";
    if (t === PropertyValueType.NO_VALUE) return "NO_VALUE";
    return "Other";
  }

  // ---------- validation of what the server sends ----------

  function checkTimes(times, what) {
    if (!isArr(times) || times.length < 1) fail("bad_args", what + ": times must be a non-empty array");
    if (times.length > MAX_FRAMES) fail("bad_args", what + ": " + times.length + " keys is over the " + MAX_FRAMES + " per property limit; a shot this long cannot be written in one call, and a second range cannot be added to a layer that already holds the first");
    for (var i = 0; i < times.length; i++) {
      if (!isNum(times[i]) || times[i] < 0) fail("bad_args", what + ": times[" + i + "] is not a time");
      if (i > 0 && !(times[i] > times[i - 1])) fail("bad_args", what + ": times must ascend");
    }
  }

  function checkSeries(values, n, width, what) {
    if (!isArr(values) || values.length !== n) fail("bad_args", what + ": needs " + n + " values, one per time");
    for (var i = 0; i < n; i++) {
      if (width === 1) {
        if (!isNum(values[i])) fail("bad_args", what + "[" + i + "] is not a number");
      } else {
        if (!isArr(values[i]) || values[i].length < width) fail("bad_args", what + "[" + i + "] needs " + width + " numbers");
        for (var j = 0; j < width; j++) {
          if (!isNum(values[i][j])) fail("bad_args", what + "[" + i + "][" + j + "] is not a number");
        }
      }
    }
  }

  // A property's hard limits: AE throws "out of range" mid-write.
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
        var v = values[i];
        if (width !== 1) v = values[i][j];
        var lo = mn;
        var hi = mx;
        if (isArr(lo)) lo = lo[j];
        if (isArr(hi)) hi = hi[j];
        if (hasMin && typeof lo === "number" && v < lo) fail("bad_args", what + ": value " + v + " is below the property's minimum " + lo);
        if (hasMax && typeof hi === "number" && v > hi) fail("bad_args", what + ": value " + v + " is above the property's maximum " + hi);
      }
    }
  }

  function shaped(prop, values, width) {
    if (width === 1) return values;
    var cur = null;
    try {
      cur = prop.valueAtTime(0, false);
    } catch (e) {
      cur = null;
    }
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var v = [values[i][0], values[i][1]];
      // A 2D layer's Position, Anchor and Scale may be 3-vectors; effect points are 2D.
      if (isArr(cur) && cur.length === 3) v.push(cur[2]);
      out.push(v);
    }
    return out;
  }

  function writeSeries(prop, times, values, width) {
    var k;
    for (k = prop.numKeys; k >= 1; k--) prop.removeKey(k);
    prop.setValuesAtTimes(times, shaped(prop, values, width));
    var lin = KeyframeInterpolationType.LINEAR;
    for (k = 1; k <= prop.numKeys; k++) prop.setInterpolationTypeAtKey(k, lin, lin);
    return prop.numKeys;
  }

  // ---------- inspect ----------

  var TRANSFORM_PROPS = [
    ["anchor", "ADBE Anchor Point"],
    ["position", "ADBE Position"],
    ["scale", "ADBE Scale"],
    ["rotation", "ADBE Rotate Z"]
  ];

  // args: { comp_id, layer: selector, ref_time }. Changes nothing.
  A.stabilizeInspect = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var t = Number(args.ref_time);
    if (!isFinite(t)) t = 0;
    var out = {
      comp: {
        id: comp.id,
        name: comp.name,
        width: comp.width,
        height: comp.height,
        pixel_aspect: comp.pixelAspect,
        fps: compFps(comp),
        frame_duration: comp.frameDuration,
        duration: comp.duration,
        motion_blur: false,
        num_layers: comp.numLayers
      },
      layer: null,
      transform: null,
      keys: {},
      expressions: [],
      effects: [],
      effects_truncated: false
    };
    try {
      out.comp.motion_blur = comp.motionBlur === true;
    } catch (eMb) {
      out.comp.motion_blur = false;
    }
    var lay = {
      index: layer.index,
      id: layer.id,
      name: layer.name,
      locked: layer.locked === true,
      three_d: isThreeD(layer),
      parent: null,
      has_video: true,
      width: null,
      height: null,
      source_id: null,
      source_pixel_aspect: 1,
      time_remap: false,
      start_time: null,
      in_point: layer.inPoint,
      out_point: layer.outPoint,
      stretch: null,
      num_masks: 0,
      guide: false,
      motion_blur: false,
      bicubic: false,
      separated_position: false,
      auto_orient: autoOrientOn(layer)
    };
    try {
      lay.start_time = layer.startTime;
      lay.stretch = layer.stretch;
    } catch (eT) {}
    if (layer.parent) lay.parent = { index: layer.parent.index, id: layer.parent.id, name: layer.parent.name };
    try {
      if (layer.hasVideo === false) lay.has_video = false;
    } catch (eHv) {}
    try {
      lay.width = layer.width;
      lay.height = layer.height;
    } catch (eWh) {}
    try {
      if (layer.source) {
        lay.source_id = layer.source.id;
        var spa = Number(layer.source.pixelAspect);
        if (spa > 0) lay.source_pixel_aspect = spa;
      }
    } catch (eSrc) {}
    try {
      lay.time_remap = layer.timeRemapEnabled === true;
    } catch (eTr) {}
    try {
      lay.guide = layer.guideLayer === true;
      lay.motion_blur = layer.motionBlur === true;
      if (typeof LayerSamplingQuality !== "undefined") lay.bicubic = layer.samplingQuality === LayerSamplingQuality.BICUBIC;
    } catch (eFl) {}
    var masks = child(layer, "ADBE Mask Parade");
    if (masks) lay.num_masks = masks.numProperties;
    out.layer = lay;

    var tg = child(layer, "ADBE Transform Group");
    if (tg) {
      var tr = {};
      for (var i = 0; i < TRANSFORM_PROPS.length; i++) {
        var key = TRANSFORM_PROPS[i][0];
        var p = child(tg, TRANSFORM_PROPS[i][1]);
        if (!p) continue;
        out.keys[key] = numKeysOf(p);
        if (expressionOn(p)) out.expressions.push(key);
        if (key === "position" && separatedDims(p)) lay.separated_position = true;
        var v = p.valueAtTime(t, false);
        if (key === "rotation") tr[key] = Number(v);
        else tr[key] = xy(v);
      }
      out.transform = tr;
    }

    var fxs = child(layer, "ADBE Effect Parade");
    if (fxs) {
      for (var f = 1; f <= fxs.numProperties; f++) {
        if (f > MAX_LISTED) {
          out.effects_truncated = true;
          break;
        }
        var fx = fxs.property(f);
        out.effects.push({ index: f, name: fx.name, matchName: fx.matchName });
      }
      out.num_effects = fxs.numProperties;
    } else {
      out.num_effects = 0;
    }
    return out;
  };

  // ---------- effect parameters ----------

  function enumParams(fx) {
    var params = [];
    for (var i = 1; i <= fx.numProperties; i++) {
      var p = null;
      try {
        p = fx.property(i);
      } catch (e) {
        p = null;
      }
      if (!p || p.propertyType !== PropertyType.PROPERTY) continue;
      params.push({ index: i, name: p.name, matchName: p.matchName, type: valueTypeName(p), prop: p });
    }
    return params;
  }

  function normName(s) {
    return String(s).replace(/^\s+|\s+$/g, "").toLowerCase();
  }

  // wanted: { key: { names: [...], index: n } }. Each key resolves to the index
  // of a parameter in `params` (by English display name, else by index), or null.
  function mapParams(params, wanted) {
    var out = {};
    var key;
    for (key in wanted) {
      if (!wanted.hasOwnProperty(key)) continue;
      var w = wanted[key];
      var hit = null;
      var i;
      var j;
      for (i = 0; i < params.length && hit === null; i++) {
        for (j = 0; j < w.names.length; j++) {
          if (normName(w.names[j]) === normName(params[i].name)) {
            hit = params[i].index;
            break;
          }
        }
      }
      if (hit === null && w.index !== undefined && w.index !== null) {
        for (i = 0; i < params.length; i++) {
          if (params[i].index === w.index) hit = w.index;
        }
      }
      out[key] = hit;
    }
    return out;
  }

  function paramByIndex(params, index) {
    for (var i = 0; i < params.length; i++) {
      if (params[i].index === index) return params[i];
    }
    return null;
  }

  function paramTable(params, map) {
    var rows = [];
    for (var i = 0; i < params.length; i++) {
      var role = "";
      for (var key in map) {
        if (map.hasOwnProperty(key) && map[key] === params[i].index) role = role === "" ? key : role + "+" + key;
      }
      rows.push({ index: params[i].index, name: params[i].name, matchName: params[i].matchName, type: params[i].type, role: role });
    }
    return rows;
  }

  function tableText(rows) {
    var parts = [];
    for (var i = 0; i < rows.length && i < 20; i++) parts.push(rows[i].index + " " + rows[i].name + " (" + rows[i].type + ")");
    return parts.join(", ");
  }

  function wantType(params, map, key, types, what) {
    var p = paramByIndex(params, map[key]);
    if (!p) fail("not_found", what + " has no " + key + " parameter. Its parameters: " + tableText(paramTable(params, map)));
    var ok = false;
    for (var i = 0; i < types.length; i++) {
      if (p.type === types[i]) ok = true;
    }
    if (!ok) {
      fail("bad_args", what + ": the parameter taken for " + key + " (" + p.name + ") is a " + p.type + ", not " + types.join(" or ") + ". Its parameters: " + tableText(paramTable(params, map)));
    }
    return p;
  }

  // ---------- effects by unique name ----------

  // A name no effect on the layer has yet: base, then "base 2", "base 3"...
  function uniqueFxName(fxs, base) {
    var taken = {};
    var i;
    for (i = 1; i <= fxs.numProperties; i++) taken[fxs.property(i).name] = true;
    if (taken[base] !== true) return base;
    var n = 2;
    while (taken[base + " " + n] === true) n++;
    return base + " " + n;
  }

  function findFx(layer, matchName, name) {
    var fxs = child(layer, "ADBE Effect Parade");
    if (!fxs) return null;
    for (var i = 1; i <= fxs.numProperties; i++) {
      var fx = fxs.property(i);
      if (fx.matchName === matchName && fx.name === name) return fx;
    }
    return null;
  }

  function addNamedFx(layer, matchName, baseName, created) {
    var fxs = layer.property("ADBE Effect Parade");
    var name = uniqueFxName(fxs, baseName);
    var added = fxs.addProperty(matchName);
    added.name = name;
    // Noted at once, so a failure further on can take the effect out again.
    created.push({ matchName: matchName, name: name });
    // References go stale after addProperty: look it up again.
    var fx = findFx(layer, matchName, name);
    if (!fx) fail("not_found", "The " + matchName + " effect was added but could not be found again");
    return { fx: fx, name: name };
  }

  function removeFxNamed(layer, matchName, name) {
    try {
      var fx = findFx(layer, matchName, name);
      if (fx) fx.remove();
    } catch (e) {}
  }

  function removeAllFx(layer, matchName) {
    try {
      var fxs = child(layer, "ADBE Effect Parade");
      if (!fxs) return;
      for (var i = fxs.numProperties; i >= 1; i--) {
        var fx = fxs.property(i);
        if (fx && fx.matchName === matchName) fx.remove();
      }
    } catch (e) {}
  }

  // True when the effect named `firstName` sits before (above) the one at
  // `secondIndex`. When it does not, it is moved there with moveTo (the
  // Scripting Guide gives the argument as the new index; not yet measured).
  function ensureFxBefore(layer, firstMatch, firstName, secondIndex) {
    var first = findFx(layer, firstMatch, firstName);
    if (!first) return { checked: false, ok: false, moved: false };
    var idx = first.propertyIndex;
    if (idx < secondIndex) return { checked: true, ok: true, moved: false };
    var moved = false;
    try {
      if (typeof first.moveTo === "function") {
        first.moveTo(secondIndex);
        moved = true;
      }
    } catch (e) {
      moved = false;
    }
    var again = findFx(layer, firstMatch, firstName);
    // The second effect shifted down by one when the first moved in front of it.
    var newSecond = secondIndex;
    if (moved) newSecond = secondIndex + 1;
    return { checked: true, ok: !!again && again.propertyIndex < newSecond, moved: moved };
  }

  // ---------- the Motion Tile ----------

  function addTile(layer, tile, created) {
    var made = addNamedFx(layer, TILE_FX, TILE_FX_NAME, created);
    var fx = made.fx;
    var params = enumParams(fx);
    var map = mapParams(params, tile.wanted);
    var what = "Motion Tile";
    var pw = wantType(params, map, "outW", ["OneD"], what);
    var ph = wantType(params, map, "outH", ["OneD"], what);
    var outW = tile.output_w_pct;
    var outH = tile.output_h_pct;
    var clamped = false;
    var lim = [pw, ph];
    var vals = [outW, outH];
    for (var i = 0; i < 2; i++) {
      var pr = lim[i].prop;
      try {
        if (pr.hasMax === true && typeof pr.maxValue === "number" && vals[i] > pr.maxValue) {
          vals[i] = pr.maxValue;
          clamped = true;
        }
        if (pr.hasMin === true && typeof pr.minValue === "number" && vals[i] < pr.minValue) {
          vals[i] = pr.minValue;
          clamped = true;
        }
      } catch (eLim) {}
    }
    pw.prop.setValue(vals[0]);
    ph.prop.setValue(vals[1]);
    var mirrorSet = false;
    if (map.mirror !== null && map.mirror !== undefined) {
      var pm = paramByIndex(params, map.mirror);
      if (pm && pm.type === "OneD") {
        pm.prop.setValue(1);
        mirrorSet = true;
      }
    }
    return {
      name: made.name,
      index: fx.propertyIndex,
      output_w_pct: vals[0],
      output_h_pct: vals[1],
      clamped: clamped,
      mirror_edges: mirrorSet,
      param_table: paramTable(params, map)
    };
  }

  // ---------- the Transform effect ----------

  function addTransformEffect(layer, args, created) {
    var made = addNamedFx(layer, TRANSFORM_FX, TRANSFORM_FX_NAME, created);
    var fx = made.fx;
    var params = enumParams(fx);
    var map = mapParams(params, args.effect_wanted);
    var what = "The Transform effect";
    var pAnchor = wantType(params, map, "anchor", ["TwoD", "TwoD_SPATIAL"], what);
    var pPos = wantType(params, map, "position", ["TwoD", "TwoD_SPATIAL"], what);
    var pScale = wantType(params, map, "scaleH", ["OneD"], what);
    var pRot = wantType(params, map, "rotation", ["OneD"], what);
    var times = args.times;
    var v = args.values;
    var scalars = [];
    var i;
    for (i = 0; i < v.scale.length; i++) scalars.push(v.scale[i][0]);
    checkLimits(pAnchor.prop, v.anchor, 2, what + " Anchor Point");
    checkLimits(pPos.prop, v.position, 2, what + " Position");
    checkLimits(pScale.prop, scalars, 1, what + " Scale");
    checkLimits(pRot.prop, v.rotation, 1, what + " Rotation");
    // Uniform Scale stays on so that Scale Height drives both axes.
    var uniformSet = false;
    if (map.uniform !== null && map.uniform !== undefined) {
      var pu = paramByIndex(params, map.uniform);
      if (pu && pu.type === "OneD") {
        pu.prop.setValue(1);
        uniformSet = true;
      }
    }
    var props = [];
    props.push({ role: "anchor", name: pAnchor.name, numKeys: writeSeries(pAnchor.prop, times, v.anchor, 2) });
    props.push({ role: "position", name: pPos.name, numKeys: writeSeries(pPos.prop, times, v.position, 2) });
    props.push({ role: "rotation", name: pRot.name, numKeys: writeSeries(pRot.prop, times, v.rotation, 1) });
    props.push({ role: "scale", name: pScale.name, numKeys: writeSeries(pScale.prop, times, scalars, 1) });
    var shutter = null;
    if (isNum(args.shutter_angle)) {
      shutter = { set: false, angle: args.shutter_angle };
      var pUse = null;
      var pAng = null;
      if (map.shutterUse !== null && map.shutterUse !== undefined) pUse = paramByIndex(params, map.shutterUse);
      if (map.shutter !== null && map.shutter !== undefined) pAng = paramByIndex(params, map.shutter);
      if (pUse && pAng && pUse.type === "OneD" && pAng.type === "OneD") {
        checkLimits(pAng.prop, [args.shutter_angle], 1, what + " Shutter Angle");
        pUse.prop.setValue(0);
        pAng.prop.setValue(args.shutter_angle);
        shutter.set = true;
      }
    }
    // The effect resamples with its own Sampling popup (1 Bilinear, 2 Bicubic; not yet measured): the layer's
    // sampling quality does not reach it.
    var sampling = null;
    if (args.bicubic === true) {
      sampling = { set: false, value: 2 };
      if (map.sampling !== null && map.sampling !== undefined) {
        var pSamp = paramByIndex(params, map.sampling);
        if (pSamp && pSamp.type === "OneD") {
          pSamp.prop.setValue(2);
          sampling.set = true;
        }
      }
    }
    return {
      name: made.name,
      index: fx.propertyIndex,
      uniform_scale_on: uniformSet,
      sampling: sampling,
      shutter: shutter,
      props: props,
      param_table: paramTable(params, map)
    };
  }

  // ---------- checks on the layer ----------

  function plateChecks(comp, layer, what) {
    if (layer.locked === true) fail("bad_args", what + " is locked");
    if (isThreeD(layer)) fail("bad_args", what + " is a 3D layer; stabilizing works in 2D only.");
    if (layer.parent) fail("bad_args", what + " has a parent (\"" + layer.parent.name + "\"); unparent it first, the stabilizing keys would be in the parent's space.");
    requireSquarePixels(comp);
    try {
      if (layer.source) {
        var spa = Number(layer.source.pixelAspect);
        if (spa > 0 && Math.abs(spa - 1) > 1e-6) {
          fail("bad_args", what + "'s footage has a pixel aspect of " + spa + ", not 1; Anchor Point is not safe on non-square pixels. Interpret the footage as square first.");
        }
      }
    } catch (eSrc) {
      if (eSrc.__kind) throw eSrc;
    }
  }

  function precheckTransformKeys(layer, replace, what) {
    var tg = child(layer, "ADBE Transform Group");
    if (!tg) fail("not_found", what + " has no Transform group");
    for (var i = 0; i < TRANSFORM_PROPS.length; i++) {
      var p = child(tg, TRANSFORM_PROPS[i][1]);
      if (!p) fail("not_found", what + " has no " + TRANSFORM_PROPS[i][1]);
      var n = numKeysOf(p);
      if (n > 0 && replace !== true) fail("bad_args", what + " " + p.name + " already has " + n + " keyframes; pass replace_keys to replace them");
      if (expressionOn(p)) fail("bad_args", what + " " + p.name + " has an expression, which would override the keys; remove the expression first");
      if (TRANSFORM_PROPS[i][0] === "position" && separatedDims(p)) {
        fail("bad_args", what + " has separated Position dimensions; join them (Separate Dimensions off) before writing Position keys.");
      }
    }
  }

  function setFlags(layer, comp, args) {
    var flags = { bicubic: null, motion_blur: null, comp_motion_blur: null };
    if (args.bicubic === true) {
      try {
        if (typeof LayerSamplingQuality !== "undefined") {
          layer.samplingQuality = LayerSamplingQuality.BICUBIC;
          flags.bicubic = true;
        }
      } catch (e1) {
        flags.bicubic = false;
      }
    }
    if (args.motion_blur === true) {
      try {
        layer.motionBlur = true;
        flags.motion_blur = true;
      } catch (e2) {
        flags.motion_blur = false;
      }
    }
    if (args.comp_motion_blur === true) {
      try {
        comp.motionBlur = true;
        flags.comp_motion_blur = true;
      } catch (e3) {
        flags.comp_motion_blur = false;
      }
    }
    return flags;
  }

  // ---------- ae_stabilize ----------

  // args: { comp_id, layer: { index, id }, target: 'layer_transform' |
  // 'transform_effect' | 'corner_pin', times, values, replace_keys?,
  // effect_wanted?, shutter_angle?, tile?: { output_w_pct, output_h_pct,
  // wanted }, bicubic?, motion_blur?, comp_motion_blur?, expect }.
  // values: { anchor, position, rotation, scale } or { ul, ur, ll, lr }.
  A.stabilizeApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = layerByIndexId(comp, args.layer.index, args.layer.id);
    var what = "Layer \"" + layer.name + "\"";
    plateChecks(comp, layer, what);
    var target = args.target;
    if (target !== "layer_transform" && target !== "transform_effect" && target !== "corner_pin") {
      fail("bad_args", "Unknown stabilize target \"" + target + "\"");
    }
    checkTimes(args.times, what);
    var n = args.times.length;
    var v = args.values;
    if (!v) fail("bad_args", what + ": values missing");
    var replace = args.replace_keys === true;
    if (target === "corner_pin") {
      var roles = ["ul", "ur", "ll", "lr"];
      for (var r = 0; r < 4; r++) checkSeries(v[roles[r]], n, 2, what + " " + roles[r]);
    } else {
      checkSeries(v.anchor, n, 2, what + " anchor");
      checkSeries(v.position, n, 2, what + " position");
      checkSeries(v.rotation, n, 1, what + " rotation");
      checkSeries(v.scale, n, 2, what + " scale");
    }
    if (target === "layer_transform" && autoOrientOn(layer)) fail("bad_args", what + " has Auto-Orient on, which would turn the plate along the written Position keys; set Auto-Orient to Off first.");
    if (target === "layer_transform") precheckTransformKeys(layer, replace, what);
    if (target === "transform_effect" && !args.effect_wanted) fail("bad_args", "effect_wanted missing");
    if (args.tile) {
      if (!isNum(args.tile.output_w_pct) || !isNum(args.tile.output_h_pct) || !(args.tile.output_w_pct > 0) || !(args.tile.output_h_pct > 0)) {
        fail("bad_args", "tile needs positive output_w_pct and output_h_pct");
      }
      if (!args.tile.wanted) fail("bad_args", "tile.wanted missing");
    }
    if (target === "corner_pin") {
      // planarWriteRaw would reuse the first Corner Pin on the layer and key over it: only a layer without one is safe.
      var fxList = child(layer, "ADBE Effect Parade");
      if (fxList) {
        for (var q = 1; q <= fxList.numProperties; q++) {
          if (fxList.property(q).matchName === "ADBE Corner Pin") {
            fail("bad_args", what + " already has a Corner Pin (\"" + fxList.property(q).name + "\"); stabilizing would key over it. Remove it first.");
          }
        }
      }
    }
    if (target !== "transform_effect" && typeof A.planarWriteRaw !== "function") {
      fail("not_found", "The planar host functions are not loaded (planar.jsx), so the keys cannot be written.");
    }

    return A.withUndo("Chroma AE MCP: stabilize", function () {
      var result = { layer_index: layer.index, layer_id: layer.id, target: target, written: [], tile: null, effect: null, order: null, flags: null };
      var addedTile = null;
      var addedFx = null;
      var created = [];
      try {
        var i;
        if (args.tile) {
          result.tile = addTile(layer, args.tile, created);
          addedTile = result.tile.name;
        }
        if (target === "transform_effect") {
          result.effect = addTransformEffect(layer, args, created);
          addedFx = result.effect.name;
          result.written.push({
            layer_index: layer.index,
            layer_id: layer.id,
            target: "transform_effect",
            effect_index: result.effect.index,
            effect_name: result.effect.name,
            props: result.effect.props
          });
        } else {
          var write = {
            layer_index: layer.index,
            layer_id: layer.id,
            target: "transform",
            replace_keys: replace,
            times: args.times,
            values: v
          };
          if (target === "corner_pin") {
            write.target = "corner_pin";
            write.add_effect = true;
          }
          var raw = A.planarWriteRaw({ comp_id: comp.id, writes: [write] });
          for (i = 0; i < raw.written.length; i++) result.written.push(raw.written[i]);
        }
        // The tile must sit before the effect that stabilizes (a layer transform renders after all effects).
        if (addedTile !== null) {
          var mainIndex = null;
          if (target === "transform_effect") {
            var mainFx = findFx(layer, TRANSFORM_FX, addedFx);
            if (mainFx) mainIndex = mainFx.propertyIndex;
          } else if (target === "corner_pin" && result.written.length > 0) {
            mainIndex = result.written[0].effect_index;
          }
          if (mainIndex !== null && mainIndex !== undefined) {
            result.order = ensureFxBefore(layer, TILE_FX, addedTile, mainIndex);
            if (target === "corner_pin") {
              // The pin was the only one on the layer (checked above), so it is found by match name; moving the tile shifts it.
              var pinNow = null;
              var pinFxs = child(layer, "ADBE Effect Parade");
              for (var pq = 1; pinFxs && pq <= pinFxs.numProperties; pq++) {
                if (pinFxs.property(pq).matchName === "ADBE Corner Pin") {
                  pinNow = pinFxs.property(pq);
                  break;
                }
              }
              if (pinNow) result.written[0].effect_index = pinNow.propertyIndex;
            }
            // The effects may have moved: report where they are now.
            var tileNow = findFx(layer, TILE_FX, addedTile);
            if (tileNow) result.tile.index = tileNow.propertyIndex;
            if (addedFx !== null) {
              var fxNow = findFx(layer, TRANSFORM_FX, addedFx);
              if (fxNow) {
                result.effect.index = fxNow.propertyIndex;
                result.written[0].effect_index = fxNow.propertyIndex;
              }
            }
          }
        }
        result.flags = setFlags(layer, comp, args);
      } catch (e) {
        // Take back what this call added; the keys were validated before anything was written.
        for (var c = created.length - 1; c >= 0; c--) removeFxNamed(layer, created[c].matchName, created[c].name);
        // The planar writer adds the Corner Pin itself and never reports it before it writes: the pre-check
        // guarantees the layer had none, so every one on it now is this call's.
        if (target === "corner_pin") removeAllFx(layer, PIN_FX);
        throw e;
      }
      return result;
    });
  };

  // ---------- read-back ----------

  // args: { comp_id, layer_id, kind: 'layer_transform' | 'transform_effect' |
  // 'corner_pin', effect_index?, effect_wanted?, tile_index?, tile_wanted?, times }
  // Key counts and values at the sample times, the flags, the tile and the
  // effect order. Changes nothing.
  A.stabilizeReadBack = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = layerById(comp, args.layer_id);
    var times = args.times;
    if (!isArr(times)) times = [];
    var out = { items: [], flags: null, tile: null, effects: [], sampling: null };
    if (!layer) {
      out.items.push({ layer_id: args.layer_id, found: false, props: [] });
      return out;
    }
    var i;
    var s;
    if (args.kind === "transform_effect") {
      var entry = { layer_id: layer.id, layer_index: layer.index, found: true, props: [] };
      var fxs = child(layer, "ADBE Effect Parade");
      var fx = null;
      if (fxs && args.effect_index >= 1 && args.effect_index <= fxs.numProperties) fx = fxs.property(args.effect_index);
      if (fx && fx.matchName === TRANSFORM_FX) {
        var params = enumParams(fx);
        var map = mapParams(params, args.effect_wanted);
        var roles = [["anchor", "anchor"], ["position", "position"], ["rotation", "rotation"], ["scale", "scaleH"]];
        for (i = 0; i < roles.length; i++) {
          var pr = paramByIndex(params, map[roles[i][1]]);
          if (!pr) continue;
          var rec = { role: roles[i][0], numKeys: pr.prop.numKeys, samples: [] };
          for (s = 0; s < times.length; s++) rec.samples.push({ time: times[s], value: pr.prop.valueAtTime(times[s], false) });
          entry.props.push(rec);
        }
        entry.effect_index = fx.propertyIndex;
        var pSm = paramByIndex(params, map.sampling);
        if (pSm && pSm.type === "OneD") out.sampling = pSm.prop.value;
      } else {
        entry.effect_found = false;
      }
      out.items.push(entry);
    } else {
      var kind = "transform";
      if (args.kind === "corner_pin") kind = "corner_pin";
      var item = { layer_id: layer.id, kind: kind, times: times };
      if (kind === "corner_pin" && args.effect_index !== undefined && args.effect_index !== null) item.effect_index = args.effect_index;
      if (typeof A.planarKeys !== "function") fail("not_found", "The planar host functions are not loaded (planar.jsx).");
      var got = A.planarKeys({ comp_id: comp.id, items: [item] });
      out.items = got.items;
    }
    var flags = { bicubic: null, motion_blur: null, comp_motion_blur: null };
    try {
      flags.motion_blur = layer.motionBlur === true;
      flags.comp_motion_blur = comp.motionBlur === true;
      if (typeof LayerSamplingQuality !== "undefined") flags.bicubic = layer.samplingQuality === LayerSamplingQuality.BICUBIC;
    } catch (eFl) {}
    out.flags = flags;
    var all = child(layer, "ADBE Effect Parade");
    if (all) {
      for (i = 1; i <= all.numProperties && i <= MAX_LISTED; i++) out.effects.push({ index: i, name: all.property(i).name, matchName: all.property(i).matchName });
    }
    if (args.tile_index !== undefined && args.tile_index !== null && all && args.tile_index >= 1 && args.tile_index <= all.numProperties) {
      var tfx = all.property(args.tile_index);
      var tile = { found: tfx.matchName === TILE_FX, index: args.tile_index };
      if (tile.found && args.tile_wanted) {
        var tparams = enumParams(tfx);
        var tmap = mapParams(tparams, args.tile_wanted);
        var tw = paramByIndex(tparams, tmap.outW);
        var th = paramByIndex(tparams, tmap.outH);
        var tm = paramByIndex(tparams, tmap.mirror);
        if (tw) tile.output_w_pct = tw.prop.value;
        if (th) tile.output_h_pct = th.prop.value;
        if (tm) tile.mirror_edges = tm.prop.value;
      }
      out.tile = tile;
    }
    return out;
  };

  // ---------- the roundtrip rig ----------

  function esc(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  function markerOf(layer) {
    var c = "";
    try {
      c = String(layer.comment);
    } catch (e) {
      c = "";
    }
    if (c.indexOf(RIG_PREFIX) !== 0) return null;
    var body = c.substring(RIG_PREFIX.length);
    var info = { raw: c, role: "outer", plate_id: null, work_comp_id: null, pad: null, ref_time: null, track_id: null };
    if (body.charAt(0) === ":") {
      info.role = body.substring(1);
      return info;
    }
    if (body.charAt(0) === ";") {
      // key=value pairs; a layer comment is user text, so nothing in it is ever evaluated.
      var parts = body.substring(1).split(";");
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf("=");
        if (eq < 1) continue;
        var k = parts[i].substring(0, eq);
        var v = parts[i].substring(eq + 1);
        if (k === "plate_id" || k === "work_comp_id" || k === "pad" || k === "ref_time") {
          if (isFinite(Number(v))) info[k] = Number(v);
        } else if (k === "track_id") {
          info.track_id = v;
        }
      }
    }
    return info;
  }

  function markerText(plate, work, m) {
    var track = "";
    if (m && typeof m.track_id === "string") track = m.track_id.replace(/[^A-Za-z0-9_\-]/g, "");
    var pad = 0;
    var ref = 0;
    if (m && isNum(m.pad)) pad = m.pad;
    if (m && isNum(m.ref_time)) ref = m.ref_time;
    return RIG_PREFIX + ";plate_id=" + plate.id + ";work_comp_id=" + work.id + ";pad=" + pad + ";ref_time=" + ref + ";track_id=" + track;
  }

  function setStaticTransform(layer, st) {
    var tg = layer.property("ADBE Transform Group");
    var anchor = child(tg, "ADBE Anchor Point");
    var pos = child(tg, "ADBE Position");
    var scale = child(tg, "ADBE Scale");
    var rot = child(tg, "ADBE Rotate Z");
    if (!anchor || !pos || !scale || !rot) fail("not_found", "Layer \"" + layer.name + "\" lacks Anchor, Position, Scale or Rotation");
    anchor.setValue(shaped(anchor, [st.anchor], 2)[0]);
    pos.setValue(shaped(pos, [st.position], 2)[0]);
    scale.setValue(shaped(scale, [st.scale], 2)[0]);
    rot.setValue(st.rotation);
  }

  function checkStatic(st, what) {
    if (!st || !isArr(st.anchor) || !isArr(st.position) || !isArr(st.scale) || !isNum(st.rotation)) {
      fail("bad_args", what + ": static transform needs anchor, position, scale and rotation");
    }
    checkSeries([st.anchor], 1, 2, what + " static anchor");
    checkSeries([st.position], 1, 2, what + " static position");
    checkSeries([st.scale], 1, 2, what + " static scale");
  }

  function checkRigKeys(k, n, what) {
    if (!k || (k.target !== "transform" && k.target !== "corner_pin")) fail("bad_args", what + ": target must be transform or corner_pin");
    checkTimes(k.times, what);
    if (k.times.length !== n) fail("bad_args", what + ": inner and outer keys must share the same times");
    var r;
    if (k.target === "corner_pin") {
      var roles = ["ul", "ur", "ll", "lr"];
      for (r = 0; r < 4; r++) checkSeries(k.values[roles[r]], n, 2, what + " " + roles[r]);
    } else {
      checkSeries(k.values.anchor, n, 2, what + " anchor");
      checkSeries(k.values.position, n, 2, what + " position");
      checkSeries(k.values.rotation, n, 1, what + " rotation");
      checkSeries(k.values.scale, n, 2, what + " scale");
    }
    checkStatic(k.static_transform, what);
  }

  function rigWrite(compId, layer, k) {
    var write = {
      layer_index: layer.index,
      layer_id: layer.id,
      target: k.target,
      replace_keys: true,
      times: k.times,
      values: k.values
    };
    if (k.target === "corner_pin") write.add_effect = true;
    var raw = A.planarWriteRaw({ comp_id: compId, writes: [write] });
    return raw.written;
  }

  // args: { comp_id, plate: { index, id }, name, layer_name, pad, width, height,
  // copy_effects?, guide_mode: 'guide_layer' | 'opacity_switch', motion_blur?,
  // comp_motion_blur?, marker: {...}, inner: { target, times, values,
  // static_transform }, outer: { ... same }, expect }
  A.stabilizeRigBuild = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var plate = layerByIndexId(comp, args.plate.index, args.plate.id);
    var what = "Layer \"" + plate.name + "\"";
    plateChecks(comp, plate, what);
    if (!plate.source) fail("bad_args", what + " has no source (it is a text, shape, null or camera layer), so a copy of it cannot be placed in a work comp.");
    var copyEffects = args.copy_effects === true;
    var fxs = child(plate, "ADBE Effect Parade");
    var masks = child(plate, "ADBE Mask Parade");
    var hasFx = !!fxs && fxs.numProperties > 0;
    var hasMasks = !!masks && masks.numProperties > 0;
    if ((hasFx || hasMasks) && !copyEffects) {
      fail("bad_args", what + " has " + (hasFx ? "effects" : "masks") + " that a plain copy would leave behind. Pass copy_effects (AE has crashed when undoing copyToComp on a layer with effects) or clear them first.");
    }
    var timeRemap = false;
    try {
      timeRemap = plate.timeRemapEnabled === true;
    } catch (eTr) {
      timeRemap = false;
    }
    if (timeRemap) fail("bad_args", what + " uses Time Remap, which the copy cannot mirror; precompose or bake it first.");
    var tg = child(plate, "ADBE Transform Group");
    var kk;
    for (kk = 0; kk < TRANSFORM_PROPS.length; kk++) {
      var tp = child(tg, TRANSFORM_PROPS[kk][1]);
      if (tp && (numKeysOf(tp) > 0 || expressionOn(tp))) fail("bad_args", what + " has keys or an expression on " + tp.name + "; the rig takes a plate with a still transform.");
    }
    var W = args.width;
    var Hh = args.height;
    if (!isNum(W) || !isNum(Hh) || W < 1 || Hh < 1 || W > 30000 || Hh > 30000) fail("bad_args", "The work comp size is not valid");
    if (typeof args.name !== "string" || args.name.length < 1 || args.name.length > 200) fail("bad_args", "The work comp needs a name of 1 to 200 characters");
    if (typeof args.layer_name !== "string" || args.layer_name.length < 1 || args.layer_name.length > 200) fail("bad_args", "The rig layer needs a name of 1 to 200 characters");
    var n = 0;
    if (args.inner && isArr(args.inner.times)) n = args.inner.times.length;
    checkRigKeys(args.inner, n, "inner keys");
    checkRigKeys(args.outer, n, "outer keys");
    if (args.guide_mode !== "guide_layer" && args.guide_mode !== "opacity_switch") fail("bad_args", "guide_mode must be guide_layer or opacity_switch");
    if (typeof A.planarWriteRaw !== "function") fail("not_found", "The planar host functions are not loaded (planar.jsx), so the keys cannot be written.");
    if (!app.project.items || typeof app.project.items.addComp !== "function") fail("not_found", "This After Effects has no project.items.addComp");
    // copyToComp carries Auto-Orient onto the copy, where it would turn the plate along the written Position keys.
    if (copyEffects && args.inner.target === "transform" && autoOrientOn(plate)) {
      fail("bad_args", what + " has Auto-Orient on, which copy_effects would carry onto the copy, where it would turn the plate along the written Position keys; set Auto-Orient to Off first.");
    }
    // copyToComp carries separated Position onto the copy, where the static transform and the keys could not be written.
    if (copyEffects) {
      var plateTg = child(plate, "ADBE Transform Group");
      var platePos = child(plateTg, "ADBE Position");
      if (platePos && separatedDims(platePos)) {
        fail("bad_args", what + " has separated Position dimensions, which copy_effects would carry onto the copy; join them (Separate Dimensions off) first.");
      }
    }
    if (args.guide_mode === "opacity_switch") {
      // The expression finds the checkbox by comp name and layer name, so both must be unique.
      var sameComps = 0;
      var nItems = 0;
      try {
        nItems = app.project.numItems;
      } catch (eN) {
        nItems = 0;
      }
      for (kk = 1; kk <= nItems; kk++) {
        var pit = app.project.item(kk);
        if (pit instanceof CompItem && pit.name === comp.name) sameComps++;
      }
      if (sameComps > 1) {
        fail("bad_args", "guide_mode opacity_switch finds its checkbox by comp name, and " + sameComps + " comps in the project are named \"" + comp.name + "\"; rename them so the shot comp's name is unique, or use guide_mode guide_layer.");
      }
      if (args.name === comp.name) {
        fail("bad_args", "guide_mode opacity_switch finds its checkbox by comp name, and the work comp would take the shot comp's name \"" + comp.name + "\"; pass another name.");
      }
      for (kk = 1; kk <= comp.numLayers; kk++) {
        if (comp.layer(kk).name === args.layer_name) {
          fail("bad_args", "guide_mode opacity_switch finds its checkbox by layer name, and a layer named \"" + args.layer_name + "\" is already in comp " + comp.id + "; pass another name.");
        }
      }
    }
    if (args.inner.target === "corner_pin" && copyEffects && fxs) {
      for (kk = 1; kk <= fxs.numProperties; kk++) {
        if (fxs.property(kk).matchName === PIN_FX) fail("bad_args", what + " already has a Corner Pin, which a perspective rig would key over; remove it or use a similarity track.");
      }
    }
    for (kk = 1; kk <= comp.numLayers; kk++) {
      var mk = markerOf(comp.layer(kk));
      if (mk && mk.plate_id === plate.id && mk.role === "outer") {
        fail("bad_args", "Layer \"" + plate.name + "\" already has a stabilize rig (layer " + comp.layer(kk).index + "). Remove it first (action: remove).");
      }
    }

    return A.withUndo("Chroma AE MCP: stabilize roundtrip", function () {
      var work = null;
      var outerLayer = null;
      var res = { work_comp: null, inner: null, outer: null, flags: {}, guide_mode: args.guide_mode, order_ok: false };
      try {
        work = app.project.items.addComp(args.name, W, Hh, 1, comp.duration, compFps(comp));
        try {
          if (comp.parentFolder) work.parentFolder = comp.parentFolder;
        } catch (eFolder) {}
        var innerLayer;
        if (copyEffects) {
          plate.copyToComp(work);
          innerLayer = work.layer(1);
        } else {
          innerLayer = work.layers.add(plate.source);
          try {
            innerLayer.stretch = plate.stretch;
            innerLayer.startTime = plate.startTime;
            innerLayer.inPoint = plate.inPoint;
            innerLayer.outPoint = plate.outPoint;
          } catch (eTime) {}
        }
        innerLayer.name = plate.name;
        // The copy is not a guide in opacity_switch mode and opacity 0 does not mute audio: the footage's sound
        // would play a second time through the rig layer. The plate itself keeps its audio.
        var guideAudioOff = false;
        try {
          innerLayer.audioEnabled = false;
          guideAudioOff = true;
        } catch (eAu) {
          guideAudioOff = false;
        }
        setStaticTransform(innerLayer, args.inner.static_transform);
        var innerWritten = rigWrite(work.id, innerLayer, args.inner);
        if (args.guide_mode === "guide_layer") innerLayer.guideLayer = true;
        innerLayer.comment = RIG_PREFIX + ":guide";
        if (args.inner.target === "transform" && args.bicubic !== false) {
          try {
            if (typeof LayerSamplingQuality !== "undefined") innerLayer.samplingQuality = LayerSamplingQuality.BICUBIC;
          } catch (eQ) {}
        }

        outerLayer = comp.layers.add(work);
        outerLayer.name = args.layer_name;
        try {
          outerLayer.startTime = 0;
          outerLayer.inPoint = plate.inPoint;
          outerLayer.outPoint = plate.outPoint;
        } catch (eOut) {}
        outerLayer.moveBefore(plate);
        setStaticTransform(outerLayer, args.outer.static_transform);
        var outerWritten = rigWrite(comp.id, outerLayer, args.outer);
        outerLayer.comment = markerText(plate, work, args.marker);

        var flags = { bicubic: null, frame_blending_off: null, motion_blur: null, comp_motion_blur: null, guide_audio_off: guideAudioOff };
        try {
          if (typeof LayerSamplingQuality !== "undefined") {
            outerLayer.samplingQuality = LayerSamplingQuality.BICUBIC;
            flags.bicubic = true;
          }
        } catch (eBc) {
          flags.bicubic = false;
        }
        try {
          if (typeof FrameBlendingType !== "undefined") {
            outerLayer.frameBlendingType = FrameBlendingType.NO_FRAME_BLEND;
            flags.frame_blending_off = true;
          }
        } catch (eFb) {
          flags.frame_blending_off = false;
        }
        if (args.motion_blur === true) {
          try {
            outerLayer.motionBlur = true;
            flags.motion_blur = true;
          } catch (eMb) {
            flags.motion_blur = false;
          }
        }
        if (args.comp_motion_blur === true) {
          try {
            comp.motionBlur = true;
            flags.comp_motion_blur = true;
          } catch (eCm) {
            flags.comp_motion_blur = false;
          }
        }
        if (args.guide_mode === "opacity_switch") {
          var outerFxs = outerLayer.property("ADBE Effect Parade");
          var cb = outerFxs.addProperty("ADBE Checkbox Control");
          cb.name = "Show Stabilized Plate";
          var cbFx = outerLayer.property("ADBE Effect Parade").property("Show Stabilized Plate");
          cbFx.property(1).setValue(0);
          var opacity = child(child(innerLayer, "ADBE Transform Group"), "ADBE Opacity");
          opacity.expression =
            "comp(\"" + esc(comp.name) + "\").layer(\"" + esc(outerLayer.name) + "\").effect(\"Show Stabilized Plate\")(\"Checkbox\")*100;";
          flags.opacity_switch = true;
        }
        res.flags = flags;
        res.work_comp = { id: work.id, name: work.name, width: work.width, height: work.height, duration: work.duration, fps: compFps(work) };
        res.inner = { layer_id: innerLayer.id, layer_index: innerLayer.index, written: innerWritten, guide: innerLayer.guideLayer === true };
        res.outer = { layer_id: outerLayer.id, layer_index: outerLayer.index, written: outerWritten };
        res.plate = { id: plate.id, index: plate.index };
        res.order_ok = outerLayer.index === plate.index - 1;
      } catch (e) {
        // Never leave a half-made rig in the project.
        try {
          if (outerLayer) outerLayer.remove();
        } catch (e2) {}
        try {
          if (work) work.remove();
        } catch (e3) {}
        throw e;
      }
      return res;
    });
  };

  function layerBrief(l) {
    var guide = false;
    try {
      guide = l.guideLayer === true;
    } catch (e) {
      guide = false;
    }
    var audio = false;
    try {
      audio = l.audioEnabled === true;
    } catch (eAu) {
      audio = false;
    }
    var mk = markerOf(l);
    return { index: l.index, id: l.id, name: l.name, enabled: l.enabled === true, guide: guide, audio: audio, marker: mk ? mk.role : null };
  }

  // The outer rig layer: by id, by the work comp it holds, or by the marker of a plate.
  function findOuter(comp, args) {
    var i;
    var l;
    var mk;
    if (args.outer) {
      // A layer that is gone (after a removal) is no error for a read.
      try {
        return findLayer(comp, args.outer);
      } catch (eSel) {
        return null;
      }
    }
    for (i = 1; i <= comp.numLayers; i++) {
      l = comp.layer(i);
      mk = markerOf(l);
      if (!mk || mk.role !== "outer") continue;
      if (args.work_comp_id !== undefined && args.work_comp_id !== null) {
        var srcId = null;
        try {
          srcId = l.source ? l.source.id : null;
        } catch (e) {
          srcId = null;
        }
        if (srcId === args.work_comp_id) return l;
      } else if (args.plate_id !== undefined && args.plate_id !== null && mk.plate_id === args.plate_id) {
        return l;
      }
    }
    return null;
  }

  // args: { comp_id, outer?: selector, work_comp_id?, plate_id?, keys?: [{ tag,
  // comp_id, layer_id, kind, times, effect_index? }] }. The rig layer, the
  // plate, the work comp's layers and key counts and values. Changes nothing.
  A.stabilizeRigRead = function (args) {
    var comp = requireComp(args.comp_id);
    var out = { comp: { id: comp.id, num_layers: comp.numLayers, motion_blur: false }, outer: null, plate: null, work: null, truncated: false };
    try {
      out.comp.motion_blur = comp.motionBlur === true;
    } catch (eMb) {}
    var outer = findOuter(comp, args);
    var workId = args.work_comp_id;
    if (outer) {
      var mk = markerOf(outer);
      var srcId = null;
      try {
        srcId = outer.source ? outer.source.id : null;
      } catch (e) {
        srcId = null;
      }
      var rec = {
        found: true,
        index: outer.index,
        id: outer.id,
        name: outer.name,
        source_id: srcId,
        marker_ok: !!mk,
        in_point: outer.inPoint,
        out_point: outer.outPoint,
        motion_blur: false,
        bicubic: null,
        frame_blending_off: null
      };
      try {
        rec.motion_blur = outer.motionBlur === true;
        if (typeof LayerSamplingQuality !== "undefined") rec.bicubic = outer.samplingQuality === LayerSamplingQuality.BICUBIC;
        if (typeof FrameBlendingType !== "undefined") rec.frame_blending_off = outer.frameBlendingType === FrameBlendingType.NO_FRAME_BLEND;
      } catch (eFl) {}
      out.outer = rec;
      if (mk) {
        out.marker = { plate_id: mk.plate_id, work_comp_id: mk.work_comp_id, pad: mk.pad, ref_time: mk.ref_time, track_id: mk.track_id };
      }
      if (workId === undefined || workId === null) workId = srcId;
      if (mk && mk.plate_id !== null && (args.plate_id === undefined || args.plate_id === null)) {
        var pl = layerById(comp, mk.plate_id);
        if (pl) out.plate = { found: true, index: pl.index, id: pl.id, name: pl.name };
      }
    } else {
      out.outer = { found: false };
    }
    if (args.plate_id !== undefined && args.plate_id !== null) {
      var plate = layerById(comp, args.plate_id);
      out.plate = plate ? { found: true, index: plate.index, id: plate.id, name: plate.name } : { found: false };
    }
    if (workId !== undefined && workId !== null) {
      var item = null;
      try {
        item = app.project.itemByID(workId);
      } catch (e2) {
        item = null;
      }
      if (item && item instanceof CompItem) {
        var w = { found: true, id: item.id, name: item.name, width: item.width, height: item.height, duration: item.duration, fps: compFps(item), num_layers: item.numLayers, layers: [] };
        for (var i = 1; i <= item.numLayers; i++) {
          if (i > MAX_LISTED) {
            out.truncated = true;
            break;
          }
          w.layers.push(layerBrief(item.layer(i)));
        }
        out.work = w;
      } else {
        out.work = { found: false, id: workId };
      }
    }
    if (isArr(args.keys)) {
      out.keys = [];
      if (args.keys.length > 0 && typeof A.planarKeys !== "function") fail("not_found", "The planar host functions are not loaded (planar.jsx).");
      for (var k = 0; k < args.keys.length && k < 10; k++) {
        var kd = args.keys[k];
        var item = { layer_id: kd.layer_id, kind: kd.kind, times: kd.times };
        if (kd.effect_index !== undefined && kd.effect_index !== null) item.effect_index = kd.effect_index;
        var got = A.planarKeys({ comp_id: kd.comp_id, items: [item] });
        out.keys.push({ tag: kd.tag, items: got.items });
      }
    }
    return out;
  };

  // args: { comp_id, outer?: selector, work_comp_id?, plate_id?, delete_patches?, expect }
  // Removes the rig layer and its work comp, refusing when the work comp
  // holds layers beyond the guide plate (patches) unless delete_patches.
  A.stabilizeRigRemove = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var outer = findOuter(comp, args);
    if (!outer) fail("not_found", "No stabilize rig layer found in comp " + comp.id + " for that plate or work comp.");
    var mk = markerOf(outer);
    if (!mk || mk.role !== "outer") fail("guard", "Refused: layer \"" + outer.name + "\" was not made by ae_stabilize_roundtrip, so it was not removed.");
    var work = null;
    try {
      work = outer.source;
    } catch (e) {
      work = null;
    }
    if (!work || !(work instanceof CompItem)) fail("not_found", "The rig layer's work comp is gone; delete the layer by hand.");
    if (outer.locked === true) fail("bad_args", "The rig layer \"" + outer.name + "\" is locked; unlock it first.");
    var patches = 0;
    var i;
    for (i = 1; i <= work.numLayers; i++) {
      var inner = markerOf(work.layer(i));
      if (!inner || inner.role !== "guide") patches++;
    }
    var usedElsewhere = 0;
    try {
      var used = work.usedIn;
      if (used) {
        for (i = 0; i < used.length; i++) {
          if (used[i].id !== comp.id) usedElsewhere++;
        }
      }
    } catch (eUsed) {}
    if ((patches > 0 || usedElsewhere > 0) && args.delete_patches !== true) {
      fail(
        "bad_args",
        "The work comp \"" + work.name + "\" holds " + patches + " layer(s) besides the guide plate" +
          (usedElsewhere > 0 ? " and is used in " + usedElsewhere + " other comp(s)" : "") +
          "; removing the rig deletes them. Pass delete_patches to remove it anyway."
      );
    }
    var info = { outer_id: outer.id, outer_name: outer.name, work_comp_id: work.id, work_comp_name: work.name, layers_deleted: work.numLayers, patches: patches };
    A.withUndo("Chroma AE MCP: remove stabilize rig", function () {
      outer.remove();
      work.remove();
    });
    return info;
  };
})($.global);
