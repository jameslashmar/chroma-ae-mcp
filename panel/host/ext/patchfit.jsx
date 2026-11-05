// panel/host/ext/patchfit.jsx
//
// Host functions for the patchfit tools (ae_patch_color_match, ae_patch_grain,
// ae_patch_finish): fitting a frozen or cloned patch to the shot's light,
// grain, sharpness, edge and motion blur. Every name starts with "patchfit"
// because other groups add functions to the same object.
//
// - patchfitInfo (read): the comp (size, rate, shutter, colour settings), the
//   patch layer (effects, masks, switches) and which layers make the plate
// - patchfitColorApply (guarded write): a Levels (Individual Controls) or
//   Exposure effect on the patch, keyed per channel
// - patchfitEffectState (read): an effect's parameters and sampled values
// - patchfitGrainApply (guarded write): optional degrain on the patch, an
//   adjustment layer above it matted to the patch's alpha, grain on that layer
// - patchfitGrainTune (guarded write): the grain intensity, one undo step
// - patchfitGrainState (read): the grain layer, its matte and effect values
// - patchfitFinishApply (guarded write): Gaussian Blur, mask feather and
//   expansion, motion blur switches, CC Force Motion Blur, layer quality
// - patchfitFinishState (read): what patchfitFinishApply sets
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Reads never change time, selection, solo, resolution or the active item.
// - Writes check the guard first, validate what can fail before A.withUndo,
//   and open and close the undo group in the same call.
// - Adding an effect invalidates references to the others, so effects are
//   looked up again after addProperty and moveTo, and parameters are resolved
//   by display name (the match names are undocumented) with the table returned.
// - A.planarEffectSlot (planar.jsx) places new effects in the shared patch
//   effect order; without it the effect stays where AE put it.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 50;
  var MAX_EFFECTS = 500;
  var MAX_SHOW = 501;
  var TMP_SUFFIX = " (new)";
  var MAX_PARAMS = 200;
  var MAX_KEYS = 3000;
  var MAX_SAMPLES = 50;
  var NAME_COLOR = "Chroma drift match";
  var NAME_BLUR = "Chroma sit-in blur";
  var NAME_FMB = "Chroma force motion blur";
  var NAME_GRAIN = "Chroma grain";
  var NAME_DEGRAIN = "Chroma degrain";
  var GRAIN_SUFFIX = " GRAIN";

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
    return typeof v === "number" && v === v && v !== Infinity && v !== -Infinity;
  }

  function lower(s) {
    return String(s).replace(/^\s+|\s+$/g, "").toLowerCase();
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

  function layerBrief(l) {
    return { index: l.index, id: l.id, name: l.name };
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

  function readProp(obj, name) {
    var v;
    try {
      v = obj[name];
    } catch (e) {
      v = undefined;
    }
    return v;
  }

  function hasVideo(layer) {
    return readProp(layer, "hasVideo") !== false;
  }

  // ---------- effects and their parameters ----------

  function effectGroup(layer) {
    return child(layer, "ADBE Effect Parade");
  }

  // Up to MAX_EFFECTS effects; effectCount has the true number so a caller can tell it was cut.
  function effectList(layer) {
    var out = [];
    var fxs = effectGroup(layer);
    if (!fxs) return out;
    for (var i = 1; i <= fxs.numProperties && i <= MAX_EFFECTS; i++) {
      var fx = fxs.property(i);
      out.push({ index: i, name: fx.name, matchName: fx.matchName });
    }
    return out;
  }

  function effectCount(layer) {
    var fxs = effectGroup(layer);
    if (!fxs) return 0;
    return fxs.numProperties;
  }

  // Where this group's own effects sit, found over every effect (the list is cut at MAX_EFFECTS).
  function ownEffects(layer) {
    var names = { color: NAME_COLOR, blur: NAME_BLUR, force_motion_blur: NAME_FMB, grain: NAME_GRAIN, degrain: NAME_DEGRAIN };
    var out = {};
    for (var k in names) {
      if (names.hasOwnProperty(k)) {
        var f = findEffectByName(layer, names[k]);
        out[k] = f ? f.index : null;
      }
    }
    return out;
  }

  // Why a menu item index is not valid for this parameter, or null (also null when the parameter reports no limits).
  function popupProblem(prop, idx) {
    if (readProp(prop, "hasMax") === true && idx > prop.maxValue) return "item " + idx + " is past the menu's last item (" + prop.maxValue + ")";
    if (readProp(prop, "hasMin") === true && idx < prop.minValue) return "item " + idx + " is before the menu's first item (" + prop.minValue + ")";
    return null;
  }

  function isWholeNumber(v) {
    return isNum(v) && Math.floor(v) === v;
  }

  // Names the effect that addEffect made under a temporary name; null when it cannot be found.
  function finalizeName(layer, tmpName, finalName) {
    var found = findEffectByName(layer, tmpName);
    if (!found) return null;
    var fx = effectGroup(layer).property(found.index);
    var renamed = true;
    try {
      fx.name = finalName;
    } catch (eRename) {
      renamed = false;
    }
    return { index: found.index, renamed: renamed };
  }

  // Removes a solid layer and, when nothing else uses it, the solid footage item addSolid made in the project's Solids folder.
  function removeSolidLayer(layer) {
    var src = null;
    try {
      src = layer.source;
    } catch (eSrc) {
      src = null;
    }
    layer.remove();
    if (src) {
      try {
        var isSolid = typeof SolidSource === "undefined" || (src.mainSource && src.mainSource instanceof SolidSource);
        if (isSolid && src.usedIn.length === 0) src.remove();
      } catch (eRem) {}
    }
  }

  // Comp pixels per layer pixel through the layer's Scale and its parents' (the pin effect's own scale is not in it).
  function compScale(layer) {
    var sx = 1;
    var sy = 1;
    var keyed = false;
    var t = 0;
    try {
      t = layer.containingComp.time;
    } catch (eT) {
      t = 0;
    }
    var l = layer;
    var depth = 0;
    while (l && depth < 20) {
      var sc = child(child(l, "ADBE Transform Group"), "ADBE Scale");
      if (sc) {
        var v;
        try {
          v = sc.valueAtTime(t, false);
        } catch (eV) {
          v = undefined;
        }
        if (isArr(v) && isNum(v[0]) && isNum(v[1])) {
          sx = sx * Math.abs(v[0]) / 100;
          sy = sy * Math.abs(v[1]) / 100;
        }
        if (sc.numKeys > 0 || sc.expressionEnabled === true) keyed = true;
      }
      var par = null;
      try {
        par = l.parent;
      } catch (eP) {
        par = null;
      }
      l = par;
      depth++;
    }
    return { x: sx, y: sy, keyed: keyed, pinned: pinned(layer) };
  }

  function removeQuietly(layer, name) {
    try {
      removeEffectNamed(layer, name);
    } catch (e) {}
  }

  // The effect with this name, or null: { index, matchName }.
  function findEffectByName(layer, name) {
    var fxs = effectGroup(layer);
    if (!fxs) return null;
    for (var i = 1; i <= fxs.numProperties; i++) {
      var fx = fxs.property(i);
      if (fx.name === name) return { index: i, matchName: fx.matchName };
    }
    return null;
  }

  function typeName(prop) {
    var t = readProp(prop, "propertyValueType");
    if (t === PropertyValueType.OneD) return "1d";
    if (t === PropertyValueType.TwoD) return "2d";
    if (t === PropertyValueType.ThreeD) return "3d";
    if (t === PropertyValueType.COLOR) return "color";
    if (t === PropertyValueType.LAYER_INDEX) return "layer";
    if (t === PropertyValueType.CUSTOM_VALUE) return "custom";
    return "other";
  }

  // The parameters of an effect, with the Property object kept for the writer.
  function paramList(fx) {
    var out = [];
    for (var i = 1; i <= fx.numProperties && i <= MAX_PARAMS; i++) {
      var p = null;
      try {
        p = fx.property(i);
      } catch (e) {
        p = null;
      }
      if (!p) continue;
      var isValue = p.propertyType === PropertyType.PROPERTY;
      var t = "header";
      if (isValue) t = typeName(p);
      out.push({ index: i, name: p.name, matchName: p.matchName, type: t, prop: p });
    }
    return out;
  }

  // Display name first (case and edge spaces ignored), then the index fallback.
  function pickParam(params, names, fallbackIndex) {
    var i;
    var j;
    for (i = 0; i < params.length; i++) {
      if (params[i].type === "header") continue;
      for (j = 0; j < names.length; j++) {
        if (lower(params[i].name) === lower(names[j])) return { entry: params[i], how: "name" };
      }
    }
    if (fallbackIndex !== undefined && fallbackIndex !== null) {
      for (i = 0; i < params.length; i++) {
        if (params[i].index === fallbackIndex && params[i].type !== "header") return { entry: params[i], how: "index" };
      }
    }
    return null;
  }

  // Everything the effect has, for an error that tells the caller what to map.
  function paramNames(params) {
    var out = [];
    for (var i = 0; i < params.length && i < 60; i++) {
      out.push(params[i].index + ":" + params[i].name);
    }
    return out;
  }

  function tableRow(role, hit) {
    if (!hit) return { role: role, name: null, matchName: null, index: null, how: "missing" };
    return { role: role, name: hit.entry.name, matchName: hit.entry.matchName, index: hit.entry.index, how: hit.how };
  }

  function stripProps(params) {
    var out = [];
    for (var i = 0; i < params.length; i++) {
      out.push({ index: params[i].index, name: params[i].name, matchName: params[i].matchName, type: params[i].type });
    }
    return out;
  }

  // Clamp to the property's own limits when it reports them; notes what moved.
  function limited(prop, v, role, notes) {
    var out = v;
    if (!isNum(v)) return v;
    if (readProp(prop, "hasMin") === true && v < prop.minValue) out = prop.minValue;
    if (readProp(prop, "hasMax") === true && out > prop.maxValue) out = prop.maxValue;
    if (out !== v && notes) notes.push(role + " " + v + " -> " + out + " (the parameter's limit)");
    return out;
  }

  function setKeyed(prop, times, values) {
    if (times.length === 1) {
      prop.setValue(values[0]);
      return;
    }
    prop.setValuesAtTimes(times, values);
    var n = prop.numKeys;
    if (n > MAX_KEYS) n = MAX_KEYS;
    for (var k = 1; k <= n; k++) {
      try {
        prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
      } catch (e) {}
    }
  }

  // Adds an effect, names it and moves it to its place in the shared patch
  // effect order. Returns the effect looked up again (references go stale).
  function addEffect(comp, layer, matchName, name, category) {
    var fxs = effectGroup(layer);
    if (!fxs) fail("bad_args", "Layer \"" + layer.name + "\" has no effects group");
    var made = fxs.addProperty(matchName);
    var idx = made.propertyIndex;
    try {
      made.name = name;
    } catch (eName) {}
    var want = idx;
    if (category && typeof A.planarEffectSlot === "function") {
      try {
        want = A.planarEffectSlot({ comp_id: comp.id, layer_index: layer.index, layer_id: layer.id, category: category, new_index: idx });
      } catch (eSlot) {
        want = idx;
      }
    }
    var moved = false;
    if (isNum(want) && want !== idx) {
      try {
        made.moveTo(want);
        moved = true;
      } catch (eMove) {
        want = idx;
      }
    }
    var at = idx;
    if (moved) at = want;
    var fx = effectGroup(layer).property(at);
    if (!fx || fx.name !== name) {
      var again = findEffectByName(layer, name);
      if (!again) fail("runtime", "The effect \"" + name + "\" could not be found again after it was added");
      fx = effectGroup(layer).property(again.index);
      at = again.index;
    }
    return { fx: fx, index: at, slot_wanted: want, moved: moved };
  }

  function removeEffectNamed(layer, name) {
    var found = findEffectByName(layer, name);
    if (found) effectGroup(layer).property(found.index).remove();
  }

  // The first value of a property for display: static value, or the value at the first key.
  function plainValue(prop) {
    var v;
    try {
      v = prop.value;
    } catch (e) {
      v = undefined;
    }
    return v;
  }

  // ---------- reading the comp and the patch layer ----------

  function pinned(layer) {
    var fxs = effectGroup(layer);
    if (!fxs) return false;
    for (var i = 1; i <= fxs.numProperties; i++) {
      var mn = fxs.property(i).matchName;
      if (mn === "ADBE Corner Pin" || mn === "CC Power Pin") return true;
    }
    return false;
  }

  function maskList(layer) {
    var out = [];
    var masks = child(layer, "ADBE Mask Parade");
    if (!masks) return out;
    for (var i = 1; i <= masks.numProperties && i <= MAX_LIST; i++) {
      var m = masks.property(i);
      var feather = child(m, "ADBE Mask Feather");
      var offset = child(m, "ADBE Mask Offset");
      var mode = readProp(m, "maskMode");
      var f = null;
      var o = null;
      var fk = false;
      var ok = false;
      if (feather) {
        f = plainValue(feather);
        fk = feather.numKeys > 0 || feather.expressionEnabled === true;
      }
      if (offset) {
        o = plainValue(offset);
        ok = offset.numKeys > 0 || offset.expressionEnabled === true;
      }
      out.push({ index: i, name: m.name, mode: mode === undefined ? null : mode, feather: f, expansion: o, feather_keyed: fk, expansion_keyed: ok });
    }
    return out;
  }

  function compBrief(comp) {
    var fps = Number(comp.frameRate);
    if (!(fps > 0)) fps = 25;
    var out = {
      id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      pixel_aspect: comp.pixelAspect,
      fps: fps,
      frame_duration: comp.frameDuration,
      duration: comp.duration,
      time: comp.time,
      work_area_start: comp.workAreaStart,
      work_area_duration: comp.workAreaDuration,
      shutter_angle: readProp(comp, "shutterAngle"),
      shutter_phase: readProp(comp, "shutterPhase"),
      motion_blur: readProp(comp, "motionBlur") === true,
      bits_per_channel: null,
      linear_blending: null,
      working_space: null,
      linearize_working_space: null
    };
    var v = readProp(app.project, "bitsPerChannel");
    if (v !== undefined) out.bits_per_channel = v;
    v = readProp(app.project, "linearBlending");
    if (v !== undefined) out.linear_blending = v === true;
    v = readProp(app.project, "workingSpace");
    if (v !== undefined) out.working_space = String(v);
    v = readProp(app.project, "linearizeWorkingSpace");
    if (v !== undefined) out.linearize_working_space = v === true;
    return out;
  }

  // True/false when the layer's setting is / is not that enum value, null when it cannot be read.
  function enumIs(layer, prop, enumName, key) {
    var want = layerEnum(enumName, key);
    var have = readProp(layer, prop);
    if (want === undefined || have === undefined) return null;
    return have === want;
  }

  function layerDetail(layer) {
    var out = layerBrief(layer);
    out.locked = layer.locked === true;
    out.enabled = layer.enabled === true;
    out.has_video = hasVideo(layer);
    out.three_d = readProp(layer, "threeDLayer") === true;
    out.in_point = layer.inPoint;
    out.out_point = layer.outPoint;
    out.motion_blur = readProp(layer, "motionBlur") === true;
    out.sampling_bicubic = enumIs(layer, "samplingQuality", "LayerSamplingQuality", "BICUBIC");
    out.frame_blend_none = enumIs(layer, "frameBlendingType", "FrameBlendingType", "NO_FRAME_BLEND");
    out.quality_best = enumIs(layer, "quality", "LayerQuality", "BEST");
    out.effects = effectList(layer);
    out.effects_total = effectCount(layer);
    out.effects_truncated = out.effects_total > MAX_EFFECTS;
    out.own_effects = ownEffects(layer);
    out.masks = maskList(layer);
    out.pinned = pinned(layer);
    out.comp_scale = compScale(layer);
    return out;
  }

  // args: { comp_id, layer: selector, hide_layers?: [selector] }. Changes nothing.
  A.patchfitInfo = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var hidden = {};
    var hideList = [];
    var i;
    hidden[layer.index] = true;
    if (isArr(args.hide_layers)) {
      for (i = 0; i < args.hide_layers.length && i < MAX_LIST; i++) {
        var h = findLayer(comp, args.hide_layers[i]);
        hidden[h.index] = true;
        hideList.push(layerBrief(h));
      }
    }
    var show = [];
    var showTruncated = false;
    for (i = 1; i <= comp.numLayers; i++) {
      if (hidden[i] === true) continue;
      var l = comp.layer(i);
      if (l.enabled === true && hasVideo(l)) {
        if (show.length >= MAX_SHOW) {
          showTruncated = true;
          break;
        }
        show.push({ index: i, id: l.id });
      }
    }
    return { comp: compBrief(comp), layer: layerDetail(layer), hidden: hideList, show: show, show_truncated: showTruncated, total_layers: comp.numLayers };
  };

  // ---------- reading an effect ----------

  function sampleParam(p, times) {
    var out = [];
    for (var i = 0; i < times.length && i < MAX_SAMPLES; i++) {
      var v;
      try {
        v = p.valueAtTime(times[i], false);
      } catch (e) {
        v = undefined;
      }
      if (isNum(v)) out.push({ time: times[i], value: v });
    }
    return out;
  }

  function effectDetail(fx, index, times) {
    var params = paramList(fx);
    var out = { index: index, name: fx.name, matchName: fx.matchName, params: [] };
    for (var i = 0; i < params.length; i++) {
      var pr = params[i];
      var row = { index: pr.index, name: pr.name, matchName: pr.matchName, type: pr.type, num_keys: 0, expression: false, value: null, samples: [] };
      if (pr.type !== "header" && pr.type !== "custom") {
        var p = pr.prop;
        row.num_keys = p.numKeys;
        row.expression = p.expressionEnabled === true;
        var v = plainValue(p);
        // A checkbox may report true / false: the read-back compares numbers.
        if (v === true) v = 1;
        if (v === false) v = 0;
        if (isNum(v)) row.value = v;
        if (isArr(times) && times.length && isNum(v)) row.samples = sampleParam(p, times);
      }
      out.params.push(row);
    }
    return out;
  }

  // args: { comp_id, layer: selector, name: effect name, times?: [seconds] }. Changes nothing.
  A.patchfitEffectState = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var out = { layer: layerBrief(layer), effects: effectList(layer), effects_total: effectCount(layer), effect: null };
    var found = findEffectByName(layer, args.name);
    if (found) out.effect = effectDetail(effectGroup(layer).property(found.index), found.index, args.times);
    return out;
  };

  // ---------- colour: Levels or Exposure ----------

  var CHANNELS = [
    { key: "red", label: "Red" },
    { key: "green", label: "Green" },
    { key: "blue", label: "Blue" }
  ];
  var LEVELS_ROLES = [
    { role: "in_black", suffix: "Input Black" },
    { role: "in_white", suffix: "Input White" },
    { role: "out_black", suffix: "Output Black" },
    { role: "out_white", suffix: "Output White" }
  ];
  var EXPOSURE_ROLES = [
    { role: "exposure", suffix: "Exposure" },
    { role: "offset", suffix: "Offset" }
  ];

  function checkSeries(args) {
    var times = args.times;
    var i;
    if (!isArr(times) || times.length < 1) fail("bad_args", "times must be a non-empty array");
    if (times.length > MAX_KEYS) fail("bad_args", "At most " + MAX_KEYS + " keys");
    for (i = 0; i < times.length; i++) {
      if (!isNum(times[i]) || times[i] < 0) fail("bad_args", "times[" + i + "] is not a time in seconds");
      if (i > 0 && times[i] <= times[i - 1]) fail("bad_args", "times must ascend");
    }
    var roles = LEVELS_ROLES;
    if (args.mode === "exposure") roles = EXPOSURE_ROLES;
    else if (args.mode !== "levels") fail("bad_args", "mode must be levels or exposure");
    if (!args.series) fail("bad_args", "series missing");
    for (var c = 0; c < CHANNELS.length; c++) {
      var ch = args.series[CHANNELS[c].key];
      if (!ch) fail("bad_args", "series." + CHANNELS[c].key + " missing");
      for (var r = 0; r < roles.length; r++) {
        var vals = ch[roles[r].role];
        if (!isArr(vals) || vals.length !== times.length) fail("bad_args", "series." + CHANNELS[c].key + "." + roles[r].role + " needs " + times.length + " values");
        for (i = 0; i < vals.length; i++) {
          if (!isNum(vals[i])) fail("bad_args", "series." + CHANNELS[c].key + "." + roles[r].role + "[" + i + "] is not a finite number");
        }
      }
    }
    return roles;
  }

  // args: { comp_id, layer: {id}, mode: "levels"|"exposure", times, series:
  //   { red|green|blue: { in_black, in_white, out_black, out_white } or { exposure, offset } },
  //   bypass_linear?: bool, replace_existing?: bool, expect, label }
  // Levels values are 0..1 and scaled to the unit the effect reports.
  A.patchfitColorApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var roles = checkSeries(args);
    if (layer.locked === true) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first.");
    if (!hasVideo(layer)) fail("bad_args", "Layer \"" + layer.name + "\" has no video, so it takes no colour effect.");
    if (!effectGroup(layer)) fail("bad_args", "Layer \"" + layer.name + "\" has no effects group.");
    var existing = findEffectByName(layer, NAME_COLOR);
    if (existing && args.replace_existing !== true) {
      fail("bad_args", "Layer \"" + layer.name + "\" already has an effect named \"" + NAME_COLOR + "\" (effect " + existing.index + "). Pass replace_existing to replace it.");
    }
    var matchName = "ADBE Pro Levels2";
    if (args.mode === "exposure") matchName = "ADBE Exposure2";
    var times = args.times;

    var tmpName = NAME_COLOR + TMP_SUFFIX;

    return A.withUndo(args.label || "Chroma AE MCP: patch colour match", function () {
      // The new effect goes in under a temporary name and the earlier one is removed only
      // once every parameter resolved and took its value, so a failure never costs the old correction.
      var added = addEffect(comp, layer, matchName, tmpName, "color");
      var fx = added.fx;
      var params = paramList(fx);
      var wanted = [];
      var table = [];
      var missing = [];
      var c;
      var r;
      for (c = 0; c < CHANNELS.length; c++) {
        for (r = 0; r < roles.length; r++) {
          var role = CHANNELS[c].key + "." + roles[r].role;
          var hit = pickParam(params, [CHANNELS[c].label + " " + roles[r].suffix], null);
          table.push(tableRow(role, hit));
          if (!hit) missing.push(CHANNELS[c].label + " " + roles[r].suffix);
          wanted.push({ channel: CHANNELS[c].key, role: roles[r].role, hit: hit });
        }
      }
      var extras = [];
      var channelsParam = null;
      var bypassParam = null;
      if (args.mode === "exposure") {
        channelsParam = pickParam(params, ["Channels"], null);
        bypassParam = pickParam(params, ["Bypass Linear Light Conversion"], null);
        table.push(tableRow("channels", channelsParam));
        table.push(tableRow("bypass_linear", bypassParam));
        if (!channelsParam) missing.push("Channels");
      }
      if (missing.length > 0) {
        // Nothing may stay half-made in the project; the earlier effect was not touched.
        removeQuietly(layer, tmpName);
        fail("not_found", "The " + matchName + " effect has no parameter named " + missing.join(", ") + ". It has: " + paramNames(params).join(", "), { actual: stripProps(params) });
      }
      var scale = 1;
      var channelsWritten = null;
      var bypassWritten = null;
      var clamped = [];
      try {
        if (args.mode === "levels") {
          var iw = null;
          for (c = 0; c < wanted.length; c++) {
            if (wanted[c].role === "in_white") iw = wanted[c].hit.entry.prop;
          }
          var d = iw ? plainValue(iw) : undefined;
          if (isNum(d) && d > 1.5) scale = d;
        } else {
          // Individual Channels. With the linear conversion bypassed a gain fitted on encoded values maps directly;
          // without it the server has already converted the values to linear light.
          channelsParam.entry.prop.setValue(2);
          channelsWritten = 2;
          if (bypassParam) {
            if (args.bypass_linear !== false) {
              bypassParam.entry.prop.setValue(1);
              bypassWritten = 1;
            } else {
              bypassParam.entry.prop.setValue(0);
              bypassWritten = 0;
            }
          } else {
            extras.push("No \"Bypass Linear Light Conversion\" parameter: Exposure works in linear light, so a gain fitted on encoded values is approximate.");
          }
        }
        for (c = 0; c < wanted.length; c++) {
          var w = wanted[c];
          var prop = w.hit.entry.prop;
          var vals = args.series[w.channel][w.role];
          var scaled = [];
          for (var i = 0; i < vals.length; i++) {
            var v = vals[i];
            if (args.mode === "levels") v = v * scale;
            scaled.push(limited(prop, v, w.channel + "." + w.role, clamped));
          }
          setKeyed(prop, times, scaled);
        }
      } catch (eWrite) {
        removeQuietly(layer, tmpName);
        throw eWrite;
      }
      // Everything took: now the earlier effect can go and the new one gets the name.
      var replaced = false;
      if (existing) {
        try {
          removeEffectNamed(layer, NAME_COLOR);
          replaced = true;
        } catch (eOld) {
          extras.push("The earlier \"" + NAME_COLOR + "\" effect could not be removed: " + (eOld && eOld.message ? eOld.message : eOld));
        }
      }
      var fin = finalizeName(layer, tmpName, NAME_COLOR);
      var finalIndex = fin ? fin.index : added.index;
      if (fin && !fin.renamed) extras.push("The new effect could not be renamed to \"" + NAME_COLOR + "\"; it is still named \"" + tmpName + "\".");
      var slotWanted = added.slot_wanted;
      if (replaced && existing.index < added.index) slotWanted = added.slot_wanted - 1;
      return {
        layer: layerBrief(layer),
        effect: { index: finalIndex, name: NAME_COLOR, matchName: matchName },
        mode: args.mode,
        scale: scale,
        table: table,
        keys: times.length,
        slot: { wanted: slotWanted, moved: added.moved },
        replaced: replaced,
        clamped: clamped,
        channels_written: channelsWritten,
        bypass_written: bypassWritten,
        notes: extras
      };
    });
  };

  // ---------- grain ----------

  // "Final Output" is the last item of each Viewing Mode menu: Add Grain has Preview, Blending Matte,
  // Final Output (3); Match Grain has Preview, Noise Samples, Compensation Noise, Blending Matte,
  // Final Output (5); Remove Grain has Preview, Noise Samples, Blending Matte, Final Output (4).
  // The item order is unmeasured on AE 26; viewing_mode_index and degrain_viewing_mode_index override it,
  // and the index is checked against the menu's own range before it is set.
  var GRAIN_KINDS = {
    add: {
      matchName: "VISINF Grain Implant",
      label: "Add Grain",
      finalIndex: 3
    },
    match: {
      matchName: "VISINF Grain Duplication",
      label: "Match Grain",
      finalIndex: 5
    }
  };
  var DEGRAIN_KINDS = {
    median: { matchName: "ADBE Median", label: "Median", finalIndex: null },
    remove_grain: { matchName: "VISINF Grain Removal", label: "Remove Grain", finalIndex: 4 }
  };

  function findAdjustmentFor(comp, patch) {
    var want = patch.name + GRAIN_SUFFIX;
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      if (l.name === want) return l;
    }
    return null;
  }

  function isOurGrainLayer(l) {
    return readProp(l, "adjustmentLayer") === true && findEffectByName(l, NAME_GRAIN) !== null;
  }

  // args: { comp_id, layer: {id} (the patch), method: "add"|"match", degrain: "none"|"median"|"remove_grain",
  //   intensity, size?, softness?, viewing_mode_index? (the grain effect's Final Output item),
  //   degrain_viewing_mode_index? (Remove Grain's), plate_layer?: {id} (match), replace_existing?, expect, label }
  // The new degrain effect and grain layer are made and checked first; the earlier ones are removed only
  // when everything took, and a failure takes back only what this call added.
  A.patchfitGrainApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var patch = findLayer(comp, args.layer);
    var kind = GRAIN_KINDS[args.method];
    if (!kind) fail("bad_args", "method must be add or match");
    var degrain = args.degrain;
    if (degrain === undefined || degrain === null) degrain = "none";
    if (degrain !== "none" && !DEGRAIN_KINDS[degrain]) fail("bad_args", "degrain must be none, median or remove_grain");
    if (!isNum(args.intensity) || args.intensity < 0) fail("bad_args", "intensity must be a number of 0 or more");
    var grainModeOverride = null;
    if (args.viewing_mode_index !== undefined && args.viewing_mode_index !== null) {
      if (!isWholeNumber(args.viewing_mode_index) || args.viewing_mode_index < 1) fail("bad_args", "viewing_mode_index must be a whole number of 1 or more");
      grainModeOverride = args.viewing_mode_index;
    }
    var degrainModeOverride = null;
    if (args.degrain_viewing_mode_index !== undefined && args.degrain_viewing_mode_index !== null) {
      if (!isWholeNumber(args.degrain_viewing_mode_index) || args.degrain_viewing_mode_index < 1) fail("bad_args", "degrain_viewing_mode_index must be a whole number of 1 or more");
      degrainModeOverride = args.degrain_viewing_mode_index;
    }
    if (patch.locked === true) fail("bad_args", "Layer \"" + patch.name + "\" is locked; unlock it first.");
    if (!hasVideo(patch)) fail("bad_args", "Layer \"" + patch.name + "\" has no video.");
    var matteApi = readProp(patch, "setTrackMatte");
    if (matteApi === undefined || matteApi === null) {
      fail("bad_args", "This After Effects has no layer-based track matte (setTrackMatte needs AE 23): the grain layer could not be matted to the patch's alpha.");
    }
    var plate = null;
    if (args.method === "match") {
      if (!args.plate_layer) fail("bad_args", "Match Grain needs plate_layer, the layer whose grain it copies.");
      plate = findLayer(comp, args.plate_layer);
      if (plate.id === patch.id) fail("bad_args", "plate_layer can't be the patch itself.");
    }
    var existingAdj = findAdjustmentFor(comp, patch);
    if (existingAdj) {
      if (!isOurGrainLayer(existingAdj)) fail("bad_args", "A layer named \"" + existingAdj.name + "\" exists and is not made by this tool.");
      if (args.replace_existing !== true) fail("bad_args", "\"" + existingAdj.name + "\" already exists. Pass replace_existing to replace it, or tune it.");
      if (existingAdj.locked === true) fail("bad_args", "\"" + existingAdj.name + "\" is locked; unlock it first.");
    }
    var oldDegrain = null;
    if (degrain !== "none") {
      oldDegrain = findEffectByName(patch, NAME_DEGRAIN);
      if (oldDegrain && args.replace_existing !== true) {
        fail("bad_args", "Layer \"" + patch.name + "\" already has an effect named \"" + NAME_DEGRAIN + "\". Pass replace_existing to replace it.");
      }
    }
    var patchId = patch.id;
    var plateId = plate ? plate.id : null;
    var existingAdjId = existingAdj ? existingAdj.id : null;
    var tmpDegrain = NAME_DEGRAIN + TMP_SUFFIX;

    return A.withUndo(args.label || "Chroma AE MCP: patch grain", function () {
      var notes = [];
      var out = { patch: layerBrief(patch), degrain: null, adjustment: null, grain: null, api: "setTrackMatte", patch_enabled: null, notes: notes };
      var p;
      var degrainAdded = false;
      var solidId = null;
      var solid = null;
      var modeIndex = null;
      var degrainIndex = null;
      var kindD = null;
      var dTable = [];
      var gAdded = null;
      var table = [];

      try {
        if (degrain !== "none") {
          kindD = DEGRAIN_KINDS[degrain];
          var dAdded = addEffect(comp, patch, kindD.matchName, tmpDegrain, "degrain");
          degrainAdded = true;
          var dParams = paramList(dAdded.fx);
          if (degrain === "median") {
            var radius = pickParam(dParams, ["Radius"], 1);
            dTable.push(tableRow("radius", radius));
            if (!radius) fail("not_found", "The Median effect has no Radius parameter. It has: " + paramNames(dParams).join(", "));
            radius.entry.prop.setValue(limited(radius.entry.prop, 1, "radius", notes));
          } else {
            var dMode = pickParam(dParams, ["Viewing Mode"], null);
            dTable.push(tableRow("viewing_mode", dMode));
            if (!dMode) fail("not_found", "Remove Grain has no Viewing Mode parameter. It has: " + paramNames(dParams).join(", "));
            degrainIndex = kindD.finalIndex;
            if (degrainModeOverride !== null) degrainIndex = degrainModeOverride;
            var dProblem = popupProblem(dMode.entry.prop, degrainIndex);
            if (dProblem) fail("bad_args", "Remove Grain's Viewing Mode: " + dProblem + ". Pass degrain_viewing_mode_index with the item of Final Output.");
            dMode.entry.prop.setValue(degrainIndex);
          }
        }

        // The adjustment layer, directly above the patch, matted to the patch's alpha.
        patch = findLayer(comp, { id: patchId });
        var dur = patch.outPoint - patch.inPoint;
        if (!(dur > 0)) dur = comp.duration;
        var adjName = patch.name + GRAIN_SUFFIX;
        solid = comp.layers.addSolid([0, 0, 0], adjName, comp.width, comp.height, 1, dur);
        solidId = solid.id;
        solid.adjustmentLayer = true;
        patch = findLayer(comp, { id: patchId });
        // The solid starts at time 0 with the patch's length: move it to the patch's start first, so the in
        // point never passes the out point, then set both.
        try {
          solid.startTime = patch.inPoint;
        } catch (eStart) {}
        try {
          solid.outPoint = patch.outPoint;
          solid.inPoint = patch.inPoint;
        } catch (eIn) {
          notes.push("The grain layer's in and out points could not be set to the patch's.");
        }
        if (Math.abs(solid.inPoint - patch.inPoint) > 0.001 || Math.abs(solid.outPoint - patch.outPoint) > 0.001) {
          notes.push("The grain layer spans " + solid.inPoint + " to " + solid.outPoint + " s, not the patch's " + patch.inPoint + " to " + patch.outPoint + " s.");
        }
        solid.moveBefore(patch);
        patch = findLayer(comp, { id: patchId });
        solid = findLayer(comp, { id: solidId });
        var patchWasOn = patch.enabled === true;
        solid.setTrackMatte(patch, TrackMatteType.ALPHA);
        // The matte layer may be switched off by the call (the UI does); the patch must stay in the composite.
        patch = findLayer(comp, { id: patchId });
        if (patchWasOn && patch.enabled !== true) {
          try {
            patch.enabled = true;
          } catch (eOn) {}
          patch = findLayer(comp, { id: patchId });
          if (patch.enabled === true) notes.push("setTrackMatte switched the patch layer off; it was switched back on.");
          else notes.push("setTrackMatte switched the patch layer off and it could not be switched back on: switch it on, or the patch is missing from the composite.");
        }
        out.patch_enabled = patch.enabled === true;

        gAdded = addEffect(comp, solid, kind.matchName, NAME_GRAIN, null);
        var gParams = paramList(gAdded.fx);
        var roles = {
          viewing_mode: pickParam(gParams, ["Viewing Mode"], null),
          intensity: pickParam(gParams, ["Intensity"], null),
          size: pickParam(gParams, ["Size"], null),
          softness: pickParam(gParams, ["Softness"], null),
          animation_speed: pickParam(gParams, ["Animation Speed"], null),
          random_seed: pickParam(gParams, ["Random Seed", "Seed"], null),
          noise_source: null
        };
        if (args.method === "match") roles.noise_source = pickParam(gParams, ["Noise Source Layer"], null);
        var keysInOrder = ["viewing_mode", "intensity", "size", "softness", "animation_speed", "random_seed", "noise_source"];
        for (p = 0; p < keysInOrder.length; p++) {
          if (keysInOrder[p] === "noise_source" && args.method !== "match") continue;
          table.push(tableRow(keysInOrder[p], roles[keysInOrder[p]]));
        }
        if (!roles.viewing_mode || !roles.intensity || (args.method === "match" && !roles.noise_source)) {
          fail("not_found", kind.label + " is missing a parameter the tool needs (Viewing Mode, Intensity" + (args.method === "match" ? ", Noise Source Layer" : "") + "). It has: " + paramNames(gParams).join(", "), { actual: stripProps(gParams) });
        }
        // The Preview viewing mode renders only a small box and Blending Matte a matte image: Final Output is the one that matters.
        modeIndex = kind.finalIndex;
        if (grainModeOverride !== null) modeIndex = grainModeOverride;
        var gProblem = popupProblem(roles.viewing_mode.entry.prop, modeIndex);
        if (gProblem) fail("bad_args", kind.label + "'s Viewing Mode: " + gProblem + ". Pass viewing_mode_index with the item of Final Output.");
        roles.viewing_mode.entry.prop.setValue(modeIndex);
        roles.intensity.entry.prop.setValue(limited(roles.intensity.entry.prop, args.intensity, "intensity", notes));
        if (roles.size && isNum(args.size)) roles.size.entry.prop.setValue(limited(roles.size.entry.prop, args.size, "size", notes));
        if (roles.softness && isNum(args.softness)) roles.softness.entry.prop.setValue(limited(roles.softness.entry.prop, args.softness, "softness", notes));
        if (roles.animation_speed) roles.animation_speed.entry.prop.setValue(limited(roles.animation_speed.entry.prop, 1, "animation_speed", notes));
        if (roles.random_seed) roles.random_seed.entry.prop.setValue(limited(roles.random_seed.entry.prop, (patchId % 997) + 1, "random_seed", notes));
        if (args.method === "match") {
          var src = findLayer(comp, { id: plateId });
          var np = roles.noise_source.entry.prop;
          var staged = false;
          // On the newest AE the source stage can be chosen, so the plate's own effects do not feed the sample.
          var stageApi = readProp(np, "setInputLayerAndStage");
          if (stageApi !== undefined && stageApi !== null && typeof LayerInputStageType !== "undefined") {
            try {
              np.setInputLayerAndStage(src.index, LayerInputStageType.SOURCE);
              staged = true;
            } catch (eStage) {
              staged = false;
            }
          }
          if (!staged) {
            np.setValue(src.index);
            notes.push("The noise source is set to the plate layer's index; this AE has no input-stage call, so the plate's effects feed it.");
          }
        }
      } catch (eBuild) {
        // Take back only what this call added; the earlier layer and degrain were not touched.
        if (solidId !== null) {
          try {
            removeSolidLayer(findLayer(comp, { id: solidId }));
          } catch (eSolid) {}
        }
        if (degrainAdded) {
          try {
            removeQuietly(findLayer(comp, { id: patchId }), tmpDegrain);
          } catch (eDeg) {}
        }
        throw eBuild;
      }

      // Everything took: the earlier layer and degrain can go, and the new degrain gets its name.
      if (existingAdjId !== null) {
        try {
          removeSolidLayer(findLayer(comp, { id: existingAdjId }));
        } catch (eOldAdj) {
          notes.push("The earlier grain layer could not be removed: " + (eOldAdj && eOldAdj.message ? eOldAdj.message : eOldAdj));
        }
      }
      patch = findLayer(comp, { id: patchId });
      if (degrainAdded) {
        if (oldDegrain) {
          try {
            removeEffectNamed(patch, NAME_DEGRAIN);
          } catch (eOldDeg) {
            notes.push("The earlier degrain effect could not be removed: " + (eOldDeg && eOldDeg.message ? eOldDeg.message : eOldDeg));
          }
        }
        var dFin = finalizeName(patch, tmpDegrain, NAME_DEGRAIN);
        if (dFin && !dFin.renamed) notes.push("The degrain effect could not be renamed to \"" + NAME_DEGRAIN + "\"; it is still named \"" + tmpDegrain + "\".");
        out.degrain = { index: dFin ? dFin.index : null, name: NAME_DEGRAIN, matchName: kindD.matchName, table: dTable, viewing_mode_index: degrainIndex };
      }
      solid = findLayer(comp, { id: solidId });
      out.adjustment = layerBrief(solid);
      out.grain = { index: gAdded.index, name: NAME_GRAIN, matchName: kind.matchName, table: table, viewing_mode_index: modeIndex };
      return out;
    });
  };

  // args: { comp_id, layer: {id} (the grain layer), intensity, expect, label }. One undo step.
  A.patchfitGrainTune = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    if (!isNum(args.intensity) || args.intensity < 0) fail("bad_args", "intensity must be a number of 0 or more");
    if (layer.locked === true) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first.");
    var found = findEffectByName(layer, NAME_GRAIN);
    if (!found) fail("not_found", "Layer \"" + layer.name + "\" has no \"" + NAME_GRAIN + "\" effect; it was not made by ae_patch_grain.");
    var fx = effectGroup(layer).property(found.index);
    var params = paramList(fx);
    var hit = pickParam(params, ["Intensity"], null);
    if (!hit) fail("not_found", "The grain effect has no Intensity parameter. It has: " + paramNames(params).join(", "));
    var prop = hit.entry.prop;
    if (prop.numKeys > 0 || prop.expressionEnabled === true) fail("bad_args", "Intensity is keyframed or driven by an expression; the tool leaves it alone.");
    var before = plainValue(prop);
    return A.withUndo(args.label || "Chroma AE MCP: patch grain tune", function () {
      var notes = [];
      var v = limited(prop, args.intensity, "intensity", notes);
      prop.setValue(v);
      return { layer: layerBrief(layer), effect_index: found.index, intensity_before: before, intensity: v, notes: notes };
    });
  };

  // args: { comp_id, patch: {id}, layer?: {id} (the grain layer; default: found by name) }. Changes nothing.
  A.patchfitGrainState = function (args) {
    var comp = requireComp(args.comp_id);
    var patch = findLayer(comp, args.patch);
    var adj = null;
    if (args.layer) adj = findLayer(comp, args.layer);
    else adj = findAdjustmentFor(comp, patch);
    var out = { patch: layerBrief(patch), patch_effects: effectList(patch), patch_effects_total: effectCount(patch), degrain: null, adjustment: null, matte: null, effect: null };
    out.patch.enabled = patch.enabled === true;
    out.patch.in_point = patch.inPoint;
    out.patch.out_point = patch.outPoint;
    var dg = findEffectByName(patch, NAME_DEGRAIN);
    if (dg) out.degrain = effectDetail(effectGroup(patch).property(dg.index), dg.index, null);
    if (!adj) return out;
    out.adjustment = layerBrief(adj);
    out.adjustment.adjustment_layer = readProp(adj, "adjustmentLayer") === true;
    out.adjustment.in_point = adj.inPoint;
    out.adjustment.out_point = adj.outPoint;
    out.adjustment.above_patch = adj.index === patch.index - 1;
    var ml = readProp(adj, "trackMatteLayer");
    var mt = readProp(adj, "trackMatteType");
    out.matte = { type: mt === undefined ? null : mt, layer_id: ml ? ml.id : null, alpha: mt === TrackMatteType.ALPHA };
    var found = findEffectByName(adj, NAME_GRAIN);
    if (found) out.effect = effectDetail(effectGroup(adj).property(found.index), found.index, null);
    return out;
  };

  // ---------- finishing: blur, edge, motion blur, quality ----------

  function layerEnum(name, key) {
    var table = null;
    try {
      table = G[name];
    } catch (e) {
      table = null;
    }
    if (!table) return undefined;
    return table[key];
  }

  // Validates a finish plan against the layer and the comp; throws before any change.
  function checkFinish(args, comp, layer, report) {
    var plan = args;
    var i;
    if (layer.locked === true) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first.");
    if (plan.blur) {
      var b = plan.blur;
      if (!isArr(b.times) || !isArr(b.values) || b.times.length < 1 || b.times.length !== b.values.length || b.times.length > MAX_KEYS) {
        fail("bad_args", "blur needs matching non-empty times and values (at most " + MAX_KEYS + ")");
      }
      for (i = 0; i < b.times.length; i++) {
        if (!isNum(b.times[i]) || b.times[i] < 0 || (i > 0 && b.times[i] <= b.times[i - 1])) fail("bad_args", "blur.times must be ascending seconds");
        if (!isNum(b.values[i]) || b.values[i] < 0) fail("bad_args", "blur.values[" + i + "] is not a Blurriness of 0 or more");
      }
      var oldBlur = findEffectByName(layer, NAME_BLUR);
      if (oldBlur && b.replace_existing !== true) {
        fail("bad_args", "Layer \"" + layer.name + "\" already has \"" + NAME_BLUR + "\". Pass replace_existing to replace it.");
      }
      report.had_blur = oldBlur ? true : false;
    }
    if (plan.edge) {
      if (isArr(plan.edge.masks)) {
        if (plan.edge.masks.length < 1 || plan.edge.masks.length > MAX_LIST) fail("bad_args", "edge.masks needs 1 to " + MAX_LIST + " entries");
        for (i = 0; i < plan.edge.masks.length; i++) {
          var em = plan.edge.masks[i];
          if (!em || !isWholeNumber(em.index) || em.index < 1) fail("bad_args", "edge.masks[" + i + "].index must be a mask number of 1 or more");
          if (!isNum(em.feather) || em.feather < 0 || !isNum(em.expansion)) fail("bad_args", "edge.masks[" + i + "] needs feather of 0 or more and a number expansion");
        }
      } else if (!isNum(plan.edge.feather) || plan.edge.feather < 0 || !isNum(plan.edge.expansion)) {
        fail("bad_args", "edge needs feather of 0 or more and a number expansion");
      }
      if (maskList(layer).length === 0) fail("bad_args", "Layer \"" + layer.name + "\" has no masks, so there is no mask edge to feather.");
    }
    if (plan.comp) {
      if (plan.comp.shutter_angle !== undefined && plan.comp.shutter_angle !== null) {
        if (!isNum(plan.comp.shutter_angle) || plan.comp.shutter_angle < 0 || plan.comp.shutter_angle > 720) fail("bad_args", "Shutter angle must be 0..720");
      }
    }
    if (plan.force_motion_blur) {
      var f = plan.force_motion_blur;
      if (!isNum(f.shutter_angle) || f.shutter_angle < 0 || f.shutter_angle > 720) fail("bad_args", "force_motion_blur.shutter_angle must be 0..720");
      var oldF = findEffectByName(layer, NAME_FMB);
      if (oldF && f.replace_existing !== true) fail("bad_args", "Layer \"" + layer.name + "\" already has \"" + NAME_FMB + "\". Pass replace_existing to replace it.");
    }
    if (plan.layer_switches && plan.layer_switches.motion_blur === true && !hasVideo(layer)) {
      fail("bad_args", "Layer \"" + layer.name + "\" has no video, so motion blur does not apply.");
    }
  }

  // args: { comp_id, layer: {id}, blur?: { times, values (Blurriness), replace_existing? },
  //   edge?: { feather, expansion } for every mask, or { masks: [{ index, feather, expansion }] } per mask,
  //   layer_switches?: { motion_blur?, sampling_bicubic?, frame_blend_none?, quality_best? },
  //   comp?: { motion_blur?, shutter_angle? }, force_motion_blur?: { shutter_angle, replace_existing? }, expect, label }
  // The two effects that can fail (blur, CC Force Motion Blur) are made and checked first, under temporary
  // names, and the earlier ones removed only when both took. After that nothing throws: a switch, a mask
  // or the comp that cannot be set goes into notes or skipped.
  A.patchfitFinishApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var report = { had_blur: false };
    checkFinish(args, comp, layer, report);
    var layerId = layer.id;
    var hadFmb = args.force_motion_blur ? findEffectByName(layer, NAME_FMB) !== null : false;
    var tmpBlur = NAME_BLUR + TMP_SUFFIX;
    var tmpFmb = NAME_FMB + TMP_SUFFIX;

    return A.withUndo(args.label || "Chroma AE MCP: patch finish", function () {
      var notes = [];
      var out = { layer: layerBrief(layer), blur: null, edge: null, layer_switches: null, comp: null, force_motion_blur: null, notes: notes };
      var i;
      var blurAdded = false;
      var fmbAdded = false;
      var blurInfo = null;
      var fmbInfo = null;
      try {
        if (args.blur) {
          var added = addEffect(comp, layer, "ADBE Gaussian Blur 2", tmpBlur, "blur");
          blurAdded = true;
          var params = paramList(added.fx);
          var amount = pickParam(params, ["Blurriness"], 1);
          var repeat = pickParam(params, ["Repeat Edge Pixels"], 3);
          var table = [tableRow("blurriness", amount), tableRow("repeat_edge", repeat)];
          if (!amount) fail("not_found", "Gaussian Blur has no Blurriness parameter. It has: " + paramNames(params).join(", "));
          var vals = [];
          for (i = 0; i < args.blur.values.length; i++) vals.push(limited(amount.entry.prop, args.blur.values[i], "blurriness", notes));
          setKeyed(amount.entry.prop, args.blur.times, vals);
          if (repeat) {
            try {
              repeat.entry.prop.setValue(1);
            } catch (eRep) {
              notes.push("Repeat Edge Pixels could not be switched on.");
            }
          }
          blurInfo = { table: table, keys: args.blur.times.length, slot: { wanted: added.slot_wanted, moved: added.moved } };
          layer = findLayer(comp, { id: layerId });
        }
        if (args.force_motion_blur) {
          var fAdded = addEffect(comp, layer, "CC Force Motion Blur", tmpFmb, "motion_blur");
          fmbAdded = true;
          var fParams = paramList(fAdded.fx);
          var fAngle = pickParam(fParams, ["Shutter Angle"], null);
          var fOverride = pickParam(fParams, ["Override Shutter Angle"], null);
          var fTable = [tableRow("shutter_angle", fAngle), tableRow("override_shutter", fOverride)];
          if (!fAngle) fail("not_found", "CC Force Motion Blur has no Shutter Angle parameter. It has: " + paramNames(fParams).join(", "));
          if (fOverride) fOverride.entry.prop.setValue(1);
          fAngle.entry.prop.setValue(limited(fAngle.entry.prop, args.force_motion_blur.shutter_angle, "shutter_angle", notes));
          fmbInfo = { table: fTable, slot: { wanted: fAdded.slot_wanted, moved: fAdded.moved } };
        }
      } catch (eAdd) {
        // Nothing else was changed yet: take back what this call added and leave the earlier effects alone.
        try {
          layer = findLayer(comp, { id: layerId });
          if (blurAdded) removeQuietly(layer, tmpBlur);
          if (fmbAdded) removeQuietly(layer, tmpFmb);
        } catch (eBack) {}
        throw eAdd;
      }

      // Both effects took: the earlier ones go and the new ones get their names.
      layer = findLayer(comp, { id: layerId });
      if (blurAdded) {
        if (report.had_blur) {
          try {
            removeEffectNamed(layer, NAME_BLUR);
          } catch (eOldBlur) {
            notes.push("The earlier \"" + NAME_BLUR + "\" effect could not be removed.");
          }
        }
        var bFin = finalizeName(layer, tmpBlur, NAME_BLUR);
        if (bFin && !bFin.renamed) notes.push("The blur could not be renamed to \"" + NAME_BLUR + "\"; it is still named \"" + tmpBlur + "\".");
        blurInfo.index = bFin ? bFin.index : null;
        blurInfo.name = NAME_BLUR;
        out.blur = blurInfo;
      }
      if (fmbAdded) {
        if (hadFmb) {
          try {
            removeEffectNamed(layer, NAME_FMB);
          } catch (eOldFmb) {
            notes.push("The earlier \"" + NAME_FMB + "\" effect could not be removed.");
          }
        }
        var fFin = finalizeName(layer, tmpFmb, NAME_FMB);
        if (fFin && !fFin.renamed) notes.push("CC Force Motion Blur could not be renamed to \"" + NAME_FMB + "\"; it is still named \"" + tmpFmb + "\".");
        fmbInfo.index = fFin ? fFin.index : null;
        fmbInfo.name = NAME_FMB;
        out.force_motion_blur = fmbInfo;
      }

      if (args.edge) {
        var masks = child(layer, "ADBE Mask Parade");
        var targets = [];
        if (isArr(args.edge.masks)) {
          targets = args.edge.masks;
        } else {
          for (i = 1; i <= masks.numProperties && i <= MAX_LIST; i++) targets.push({ index: i, feather: args.edge.feather, expansion: args.edge.expansion });
        }
        var done = [];
        var skipped = [];
        for (var t = 0; t < targets.length; t++) {
          var tg = targets[t];
          if (tg.index > masks.numProperties) {
            skipped.push({ index: tg.index, reason: "the layer has no such mask" });
            continue;
          }
          try {
            var m = masks.property(tg.index);
            var mode = readProp(m, "maskMode");
            if (mode !== undefined && mode === layerEnum("MaskMode", "NONE")) {
              skipped.push({ index: tg.index, reason: "mask mode is None" });
              continue;
            }
            var feather = child(m, "ADBE Mask Feather");
            var offset = child(m, "ADBE Mask Offset");
            if (!feather || !offset) {
              skipped.push({ index: tg.index, reason: "no feather or expansion property" });
              continue;
            }
            if (feather.numKeys > 0 || offset.numKeys > 0 || feather.expressionEnabled === true || offset.expressionEnabled === true) {
              skipped.push({ index: tg.index, reason: "feather or expansion is keyframed or driven by an expression" });
              continue;
            }
            var fv = limited(feather, tg.feather, "feather", notes);
            var ev = limited(offset, tg.expansion, "expansion", notes);
            feather.setValue([fv, fv]);
            offset.setValue(ev);
            done.push({ index: tg.index, feather: fv, expansion: ev });
          } catch (eMask) {
            skipped.push({ index: tg.index, reason: "could not be set: " + (eMask && eMask.message ? eMask.message : eMask) });
          }
        }
        out.edge = { masks: done, skipped: skipped };
      }
      var sw = args.layer_switches;
      if (sw) {
        var set = {};
        layer = findLayer(comp, { id: layerId });
        if (sw.motion_blur === true) {
          try {
            layer.motionBlur = true;
            set.motion_blur = true;
          } catch (eMb) {
            notes.push("Layer motion blur could not be switched on: " + (eMb && eMb.message ? eMb.message : eMb));
          }
        }
        if (sw.sampling_bicubic === true) {
          var bic = layerEnum("LayerSamplingQuality", "BICUBIC");
          if (bic !== undefined) {
            try {
              layer.samplingQuality = bic;
              set.sampling_quality = "bicubic";
            } catch (eSq) {
              notes.push("The sampling quality could not be set: " + (eSq && eSq.message ? eSq.message : eSq));
            }
          } else {
            notes.push("LayerSamplingQuality is not available; the sampling quality was not set.");
          }
        }
        if (sw.frame_blend_none === true) {
          var nb = layerEnum("FrameBlendingType", "NO_FRAME_BLEND");
          if (nb !== undefined) {
            try {
              layer.frameBlendingType = nb;
              set.frame_blend = "none";
            } catch (eFb) {
              notes.push("Frame blending could not be set: " + (eFb && eFb.message ? eFb.message : eFb));
            }
          } else {
            notes.push("FrameBlendingType is not available; frame blending was not set.");
          }
        }
        if (sw.quality_best === true) {
          var best = layerEnum("LayerQuality", "BEST");
          if (best !== undefined) {
            try {
              layer.quality = best;
              set.quality = "best";
            } catch (eQ) {
              notes.push("The layer quality could not be set: " + (eQ && eQ.message ? eQ.message : eQ));
            }
          } else {
            notes.push("LayerQuality is not available; the quality was not set.");
          }
        }
        out.layer_switches = set;
      }
      if (args.comp) {
        var cset = {};
        if (args.comp.motion_blur === true) {
          try {
            comp.motionBlur = true;
            cset.motion_blur = true;
          } catch (eCm) {
            notes.push("Comp motion blur could not be switched on: " + (eCm && eCm.message ? eCm.message : eCm));
          }
        }
        if (isNum(args.comp.shutter_angle)) {
          try {
            comp.shutterAngle = args.comp.shutter_angle;
            cset.shutter_angle = args.comp.shutter_angle;
          } catch (eCs) {
            notes.push("The comp's shutter angle could not be set: " + (eCs && eCs.message ? eCs.message : eCs));
          }
        }
        out.comp = cset;
      }
      return out;
    });
  };

  // args: { comp_id, layer: {id} }. Changes nothing.
  A.patchfitFinishState = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var out = { comp: compBrief(comp), layer: layerDetail(layer), blur: null, force_motion_blur: null };
    var b = findEffectByName(layer, NAME_BLUR);
    if (b) out.blur = effectDetail(effectGroup(layer).property(b.index), b.index, args.times);
    var f = findEffectByName(layer, NAME_FMB);
    if (f) out.force_motion_blur = effectDetail(effectGroup(layer).property(f.index), f.index, null);
    return out;
  };
})($.global);
