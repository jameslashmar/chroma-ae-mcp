// panel/host/ext/screenrep.jsx
//
// Host functions for ae_screen_replace (and the project facts ae_screen_corners
// does not need). Every name starts with "screenrep" because other groups add
// functions to the same object.
//
// - screenrepInfo (read): the comp, the plate layer, the insert (a project item
//   or a layer's source), the project's linear-blending flag and whether
//   layer-based track mattes exist on this AE
// - screenrepApply (guarded write): one undo group that makes the insert
//   precomp at the screen's aspect, adds it to the comp above the plate, adds
//   Levels / Gaussian Blur / the pin / CC Force Motion Blur to it in the
//   shared effect order, keys the pin (and the layer transform for
//   transform_pin) with A.planarWriteRaw, and optionally puts a Screen-mode
//   duplicate of the plate above it, track-matted to the insert's alpha
// - screenrepRead (read): the read-back, in a separate call: the layers asked
//   for with their effects and parameter values, the insert comp, and the key
//   counts and samples (through A.planarKeys)
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Reads never change time, selection, solo, resolution or the active item.
// - The write checks the guard first, validates everything that can fail before
//   A.withUndo, and opens and closes the undo group in this one call.
// - Effect references go stale after addProperty and moveTo: an effect is looked
//   up again from the layer before each use.
// - The core of the write (comp, layer, pin, keys) is all or nothing: if it
//   throws, what the call made is removed again. The "look" steps (Levels, blur,
//   Power Pin expansion, reflections) are best effort: one that cannot find its
//   parameters undoes itself and is reported in look.skipped.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_FRAMES = 3000;
  var MAX_LIST = 500;
  var MAX_EFFECTS = 20;
  var MAX_PARAMS = 14;
  var PIN_MATCH = { corner_pin: "ADBE Corner Pin", power_pin: "CC Power Pin" };
  var LEVELS_MATCHES = ["ADBE Pro Levels2", "ADBE Easy Levels2"];
  var BLUR_MATCH = "ADBE Gaussian Blur 2";
  var FORCE_BLUR_MATCH = "CC Force Motion Blur";
  var LEVELS_NAMES = {
    in_black: ["Input Black", "RGB Input Black"],
    in_white: ["Input White", "RGB Input White"],
    out_black: ["Output Black", "RGB Output Black"],
    out_white: ["Output White", "RGB Output White"]
  };

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
  function layerByIndexId(comp, sel, what) {
    if (!sel || typeof sel.index !== "number" || typeof sel.id !== "number") fail("bad_args", what + " needs both an index and an id");
    if (sel.index < 1 || sel.index > comp.numLayers) fail("not_found", what + ": layer index " + sel.index + " out of range");
    var l = comp.layer(sel.index);
    if (l.id !== sel.id) fail("guard", what + ": layer " + sel.index + " is not the layer read earlier (id " + sel.id + "); the stack changed. Re-read and retry.");
    return l;
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

  function requireSquarePixels(comp) {
    var pa = Number(comp.pixelAspect);
    if (pa > 0 && Math.abs(pa - 1) > 1e-6) {
      fail("bad_args", "The comp's pixel aspect is " + pa + ", not 1. Screen replacement works on square pixels only.");
    }
  }

  function compFps(comp) {
    var fps = Number(comp.frameRate);
    if (!(fps > 0)) fps = 25;
    return fps;
  }

  // ---------- items ----------

  function itemOf(id) {
    var it = null;
    try {
      it = app.project.itemByID(id);
    } catch (e) {
      it = null;
    }
    return it;
  }

  function describeItem(it) {
    var kind = "other";
    if (it instanceof CompItem) kind = "comp";
    else if (it instanceof FootageItem) kind = "footage";
    var hasVideo = true;
    try {
      if (it.hasVideo === false) hasVideo = false;
    } catch (e1) {
      hasVideo = true;
    }
    var missing = false;
    try {
      missing = it.footageMissing === true;
    } catch (e2) {
      missing = false;
    }
    var pa = 1;
    try {
      pa = Number(it.pixelAspect);
      if (!(pa > 0)) pa = 1;
    } catch (e3) {
      pa = 1;
    }
    var dur = 0;
    try {
      dur = Number(it.duration);
      if (!isFinite(dur)) dur = 0;
    } catch (e4) {
      dur = 0;
    }
    return {
      kind: kind,
      item_id: it.id,
      name: it.name,
      width: Number(it.width),
      height: Number(it.height),
      duration: dur,
      has_video: hasVideo,
      missing: missing,
      pixel_aspect: pa
    };
  }

  // The insert as the server named it: { item_id } or { layer: { index, id } | selector }.
  function resolveInsert(comp, insert, strictLayer) {
    var info;
    var srcLayer = null;
    var item = null;
    if (!insert) fail("bad_args", "No insert given");
    if (insert.item_id !== undefined && insert.item_id !== null) {
      item = itemOf(insert.item_id);
      if (!item) fail("not_found", "No project item with id " + insert.item_id);
    } else if (insert.layer) {
      if (strictLayer) srcLayer = layerByIndexId(comp, insert.layer, "The insert layer");
      else srcLayer = findLayer(comp, insert.layer);
      var src = null;
      try {
        src = srcLayer.source;
      } catch (e) {
        src = null;
      }
      if (!src) fail("bad_args", "Layer \"" + srcLayer.name + "\" has no source item (a text, shape, null or camera layer); give the project item as insert.item_id.");
      item = src;
    } else {
      fail("bad_args", "insert needs item_id or layer");
    }
    if (!(item instanceof CompItem) && !(item instanceof FootageItem)) {
      fail("bad_args", "Project item " + item.id + " (\"" + item.name + "\") is not footage or a comp.");
    }
    if (item.id === comp.id) fail("bad_args", "The insert is the target comp itself: a comp cannot contain itself.");
    if (item instanceof CompItem) {
      // A shallow check for the common nested case: the insert comp already holds the target comp as a layer.
      var nestedSrc = null;
      for (var ni = 1; ni <= item.numLayers && ni <= 500; ni++) {
        try {
          nestedSrc = item.layer(ni).source;
        } catch (eNs) {
          nestedSrc = null;
        }
        if (nestedSrc && nestedSrc.id === comp.id) fail("bad_args", "The insert comp \"" + item.name + "\" contains the target comp, so adding it would be circular.");
      }
    }
    info = describeItem(item);
    if (!info.has_video || !(info.width > 0) || !(info.height > 0)) {
      fail("bad_args", "\"" + item.name + "\" has no picture (audio only, or no size), so it cannot be a screen insert.");
    }
    if (info.missing) fail("bad_args", "\"" + item.name + "\" is missing footage; relink it first.");
    return { item: item, info: info, layer: srcLayer };
  }

  // ---------- project and layer facts (read) ----------

  // args: { comp_id, plate?: selector, insert?: { item_id } | { layer: selector } }
  A.screenrepInfo = function (args) {
    var comp = requireComp(args.comp_id);
    var linear = false;
    try {
      linear = app.project.linearBlending === true;
    } catch (e) {
      linear = false;
    }
    var linearized = false;
    try {
      linearized = app.project.linearizeWorkingSpace === true;
    } catch (eLw) {
      linearized = false;
    }
    var mb = false;
    try {
      mb = comp.motionBlur === true;
    } catch (e2) {
      mb = false;
    }
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
        time: comp.time,
        work_area_start: comp.workAreaStart,
        work_area_duration: comp.workAreaDuration,
        num_layers: comp.numLayers,
        motion_blur: mb
      },
      ae_version: String(app.version),
      linear_blending: linear,
      linearize_working_space: linearized,
      can_set_track_matte: false,
      plate: null,
      insert: null
    };
    var probe = null;
    if (args.plate) {
      probe = findLayer(comp, args.plate);
      out.plate = layerBrief(probe);
    } else if (comp.numLayers > 0) {
      probe = comp.layer(1);
    }
    if (probe) out.can_set_track_matte = typeof probe.setTrackMatte === "function";
    if (args.insert) {
      var got = resolveInsert(comp, args.insert, false);
      out.insert = got.info;
      if (got.layer) out.insert.from_layer = layerBrief(got.layer);
    }
    return out;
  };

  // ---------- effects ----------

  function nameIs(actual, wanted) {
    var a = String(actual).toLowerCase();
    for (var i = 0; i < wanted.length; i++) {
      if (a === String(wanted[i]).toLowerCase()) return true;
    }
    return false;
  }

  // A parameter of an effect by display name (English), then by 1-based index if one is given.
  function findParam(fx, names, indexFallback) {
    var i;
    var p = null;
    for (i = 1; i <= fx.numProperties; i++) {
      try {
        p = fx.property(i);
      } catch (e) {
        p = null;
      }
      if (p && p.propertyType === PropertyType.PROPERTY && nameIs(p.name, names)) {
        return { prop: p, index: i, name: p.name, matchName: p.matchName, how: "name" };
      }
    }
    if (indexFallback !== undefined && indexFallback !== null) {
      try {
        p = fx.property(indexFallback);
      } catch (e2) {
        p = null;
      }
      if (p && p.propertyType === PropertyType.PROPERTY) {
        return { prop: p, index: indexFallback, name: p.name, matchName: p.matchName, how: "index" };
      }
    }
    return null;
  }

  function paramTable(fx) {
    var t = [];
    var p;
    for (var i = 1; i <= fx.numProperties && i <= MAX_PARAMS; i++) {
      try {
        p = fx.property(i);
      } catch (e) {
        p = null;
      }
      if (p) t.push({ index: i, name: p.name, matchName: p.matchName });
    }
    return t;
  }

  function effectAt(layer, index) {
    var parade = layer.property("ADBE Effect Parade");
    if (!parade || index < 1 || index > parade.numProperties) return null;
    return parade.property(index);
  }

  // The last effect of a match name, looked up again from the layer.
  function lastEffectOf(layer, matchName) {
    var parade = layer.property("ADBE Effect Parade");
    var found = null;
    if (!parade) return null;
    for (var i = 1; i <= parade.numProperties; i++) {
      if (parade.property(i).matchName === matchName) found = parade.property(i);
    }
    return found;
  }

  // Adds an effect and moves it to its place in the shared order. Returns the effect looked up again.
  function addEffect(comp, layer, matchName, category) {
    var parade = layer.property("ADBE Effect Parade");
    if (!parade) fail("not_found", "Layer \"" + layer.name + "\" has no Effects group");
    var added = parade.addProperty(matchName);
    var idx = added.propertyIndex;
    var slot = A.planarEffectSlot({ comp_id: comp.id, layer_index: layer.index, layer_id: layer.id, category: category, new_index: idx });
    if (slot !== idx && typeof added.moveTo === "function") {
      added.moveTo(slot);
      idx = slot;
    }
    var fx = effectAt(layer, idx);
    if (!fx || fx.matchName !== matchName) fx = lastEffectOf(layer, matchName);
    if (!fx) fail("not_found", "The " + matchName + " effect could not be found again after it was added");
    return fx;
  }

  // The index of an effect as addEffect left it (0 when it cannot be read).
  function indexOfFx(fx) {
    try {
      return Number(fx.propertyIndex) || 0;
    } catch (e) {
      return 0;
    }
  }

  // Removes the effect this call added: by its own index when that still holds the match name, else the last of that name.
  function dropEffect(layer, matchName, index) {
    try {
      var fx = null;
      if (index > 0) {
        fx = effectAt(layer, index);
        if (fx && fx.matchName !== matchName) fx = null;
      }
      if (!fx) fx = lastEffectOf(layer, matchName);
      if (fx) fx.remove();
    } catch (e) {}
  }

  function clampToLimits(prop, v) {
    var out = v;
    try {
      if (prop.hasMin === true && isNum(prop.minValue) && out < prop.minValue) out = prop.minValue;
      if (prop.hasMax === true && isNum(prop.maxValue) && out > prop.maxValue) out = prop.maxValue;
    } catch (e) {}
    return out;
  }

  // Levels: a fraction of full white is written as fraction * the effect's own full-white value
  // (its default Output White), because the unit depends on the project's bit depth.
  function addLevels(comp, layer, plan) {
    var fx = null;
    var usedMatch = "";
    var lastErr = "";
    var m;
    for (m = 0; m < LEVELS_MATCHES.length; m++) {
      try {
        fx = addEffect(comp, layer, LEVELS_MATCHES[m], "color");
        usedMatch = LEVELS_MATCHES[m];
        break;
      } catch (eAdd) {
        lastErr = String(eAdd.message || eAdd);
        fx = null;
      }
    }
    if (!fx) return { ok: false, reason: "Levels could not be added: " + lastErr };
    var fxIndex = indexOfFx(fx);
    var roles = ["in_black", "in_white", "out_black", "out_white"];
    var found = {};
    var missing = [];
    var r;
    for (r = 0; r < roles.length; r++) {
      if (plan[roles[r]] === undefined || plan[roles[r]] === null) continue;
      found[roles[r]] = findParam(fx, LEVELS_NAMES[roles[r]], null);
      if (!found[roles[r]]) missing.push(roles[r]);
    }
    var table = paramTable(fx);
    if (missing.length > 0) {
      dropEffect(layer, usedMatch, fxIndex);
      return { ok: false, reason: "Levels has no parameter named like " + missing.join(", ") + " on this AE", param_table: table };
    }
    // The unit: the default Output White, read before anything is changed.
    var unit = 1;
    var unitAssumed = true;
    var ow = findParam(fx, LEVELS_NAMES.out_white, null);
    if (ow) {
      var uv = null;
      try {
        uv = ow.prop.value;
      } catch (eU) {
        uv = null;
      }
      if (isNum(uv) && uv > 0) {
        unit = uv;
        unitAssumed = false;
      }
    }
    var wrote = [];
    try {
      for (r = 0; r < roles.length; r++) {
        if (!found[roles[r]]) continue;
        var want = clampToLimits(found[roles[r]].prop, plan[roles[r]] * unit);
        found[roles[r]].prop.setValue(want);
        wrote.push({ role: roles[r], name: found[roles[r]].name, matchName: found[roles[r]].matchName, how: found[roles[r]].how, value: want });
      }
    } catch (eSet) {
      dropEffect(layer, usedMatch, fxIndex);
      return { ok: false, reason: "Levels could not be set: " + String(eSet.message || eSet), param_table: table };
    }
    return { ok: true, effect_index: fxIndex, match_name: usedMatch, unit: unit, unit_assumed: unitAssumed, wrote: wrote, param_table: table };
  }

  function addBlur(comp, layer, blurriness) {
    var fx = null;
    try {
      fx = addEffect(comp, layer, BLUR_MATCH, "blur");
    } catch (eAdd) {
      return { ok: false, reason: "Gaussian Blur could not be added: " + String(eAdd.message || eAdd) };
    }
    var fxIndex = indexOfFx(fx);
    var p = findParam(fx, ["Blurriness"], 1);
    var table = paramTable(fx);
    if (!p) {
      dropEffect(layer, BLUR_MATCH, fxIndex);
      return { ok: false, reason: "Gaussian Blur has no Blurriness parameter on this AE", param_table: table };
    }
    var want = clampToLimits(p.prop, blurriness);
    try {
      p.prop.setValue(want);
    } catch (eSet) {
      dropEffect(layer, BLUR_MATCH, fxIndex);
      return { ok: false, reason: "Blurriness could not be set: " + String(eSet.message || eSet), param_table: table };
    }
    return { ok: true, effect_index: fxIndex, match_name: BLUR_MATCH, wrote: [{ role: "blurriness", name: p.name, matchName: p.matchName, how: p.how, value: want }], param_table: table };
  }

  // ---------- validation of the key arrays ----------

  function checkTimes(times, what) {
    if (!isArr(times) || times.length < 1) fail("bad_args", what + ": times must be a non-empty array");
    if (times.length > MAX_FRAMES) fail("bad_args", what + ": " + times.length + " keys is over the " + MAX_FRAMES + " per property limit; write the track in ranges");
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

  function checkPinValues(vals, n, what) {
    if (!vals) fail("bad_args", what + ": values missing");
    var roles = ["ul", "ur", "ll", "lr"];
    for (var r = 0; r < 4; r++) checkSeries(vals[roles[r]], n, 2, what + " " + roles[r]);
  }

  function setXY(prop, x, y) {
    var cur = null;
    try {
      cur = prop.value;
    } catch (e) {
      cur = null;
    }
    var v = [x, y];
    if (isArr(cur) && cur.length === 3) v.push(cur[2]);
    prop.setValue(v);
  }

  // ---------- the write ----------

  // args: { comp_id, name, insert: { item_id } | { layer: { index, id } }, insert_size: [w, h],
  //   insert_start?, trim_to_keys? (the layer's in/out points are cut to its keys), plate?: { index, id }, pin: 'power_pin' | 'corner_pin', expansion_pct,
  //   times, exact: { ul, ur, ll, lr }, expanded: { ul, ur, ll, lr }, transform?: { position, rotation, scale },
  //   motion_blur: 'none' | 'transform_pin' | 'force', look: { levels?: { in_black, in_white, out_black, out_white },
  //   blurriness? }, reflections?: { threshold, opacity }, switch_off_source: bool, expect }
  A.screenrepApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    requireSquarePixels(comp);
    var kind = args.pin;
    if (kind !== "power_pin" && kind !== "corner_pin") fail("bad_args", "pin must be power_pin or corner_pin");
    var name = args.name;
    if (typeof name !== "string" || name.length < 1 || name.length > 190) fail("bad_args", "A name of 1 to 190 characters is needed");
    var size = args.insert_size;
    if (!isArr(size) || size.length !== 2 || !isNum(size[0]) || !isNum(size[1]) || size[0] < 4 || size[1] < 4 || size[0] > 30000 || size[1] > 30000 || Math.floor(size[0]) !== size[0] || Math.floor(size[1]) !== size[1]) {
      fail("bad_args", "insert_size must be two whole numbers between 4 and 30000");
    }
    var times = args.times;
    checkTimes(times, "Screen replace");
    var n = times.length;
    checkPinValues(args.exact, n, "exact pin values");
    checkPinValues(args.expanded, n, "expanded pin values");
    var wantTransform = args.transform !== undefined && args.transform !== null;
    if (wantTransform) {
      checkSeries(args.transform.position, n, 2, "transform position");
      checkSeries(args.transform.rotation, n, 1, "transform rotation");
      checkSeries(args.transform.scale, n, 2, "transform scale");
    }
    var mbMode = args.motion_blur;
    if (mbMode !== "none" && mbMode !== "transform_pin" && mbMode !== "force") fail("bad_args", "motion_blur must be none, transform_pin or force");
    if (mbMode === "transform_pin" && !wantTransform) fail("bad_args", "motion_blur transform_pin needs the transform keys");
    if (mbMode !== "transform_pin" && wantTransform) fail("bad_args", "Transform keys are only written for motion_blur transform_pin");
    var startAt = args.insert_start;
    if (startAt === undefined || startAt === null) startAt = 0;
    if (!isNum(startAt)) fail("bad_args", "insert_start is not a number");
    if (startAt < -10800 || startAt > 10800) fail("bad_args", "insert_start must be within +-10800 s");
    // The insert comp lasts at most 10800 s (AE's limit), so a very negative start would leave the layer ending before the comp does.
    if (comp.duration - startAt > 10800) {
      fail("bad_args", "insert_start (" + startAt + " s) is too far before the comp start: the insert would have to last " + (comp.duration - startAt) + " s, more than After Effects' 10800 s limit. Use a later insert_start.");
    }
    if (args.trim_to_keys === true && times[times.length - 1] + 1 / compFps(comp) <= startAt) {
      fail("bad_args", "insert_start (" + startAt + " s) is at or after the end of the keys (" + times[times.length - 1] + " s): the layer would have no visible span. Use an insert_start before the last key.");
    }
    var look = args.look;
    if (!look) look = {};
    if (look.blurriness !== undefined && look.blurriness !== null && (!isNum(look.blurriness) || look.blurriness < 0)) fail("bad_args", "look.blurriness is not a number >= 0");
    var lv = look.levels;
    var lvRoles = ["in_black", "in_white", "out_black", "out_white"];
    var li;
    if (lv) {
      for (li = 0; li < lvRoles.length; li++) {
        if (lv[lvRoles[li]] !== undefined && lv[lvRoles[li]] !== null && (!isNum(lv[lvRoles[li]]) || lv[lvRoles[li]] < 0)) fail("bad_args", "look.levels." + lvRoles[li] + " is not a number >= 0");
      }
    }

    var plate = null;
    if (args.plate) {
      plate = layerByIndexId(comp, args.plate, "The plate");
    }
    var refl = args.reflections;
    if (refl) {
      if (!plate) fail("bad_args", "Reflections need the plate layer (plate)");
      if (typeof plate.setTrackMatte !== "function") fail("bad_args", "Reflections need layer-based track mattes (After Effects 23 or later); this AE has no setTrackMatte.");
      if (plate.locked === true) fail("bad_args", "The plate \"" + plate.name + "\" is locked; unlock it or turn the reflections off.");
      if (typeof plate.duplicate !== "function") fail("bad_args", "This AE has no Layer.duplicate");
      if (typeof BlendingMode === "undefined") fail("bad_args", "BlendingMode is not available, so the reflection layer cannot be set to Screen.");
      if (!isNum(refl.threshold) || refl.threshold < 0 || refl.threshold > 1) fail("bad_args", "reflections.threshold must be 0..1");
      if (!isNum(refl.opacity) || refl.opacity < 0 || refl.opacity > 100) fail("bad_args", "reflections.opacity must be 0..100");
    }
    var got = resolveInsert(comp, args.insert, true);
    var srcLayer = got.layer;
    if (plate && srcLayer && srcLayer.id === plate.id) {
      fail("bad_args", "The insert layer is the plate layer: the insert has to be a different layer from the one being replaced.");
    }
    if (args.switch_off_source === true && srcLayer && srcLayer.locked === true) {
      fail("bad_args", "The insert layer \"" + srcLayer.name + "\" is locked, so it cannot be switched off; unlock it or keep it with switch_off_source false.");
    }

    var cw = comp.width;
    var ch = comp.height;
    var fps = compFps(comp);
    // The insert comp must cover the whole shot from insert_start: a negative start would otherwise leave its last seconds empty.
    var insertDur = comp.duration;
    if (startAt < 0) insertDur = Math.min(10800, comp.duration - startAt);
    var made = { comp: null, layer: null, dup: null };
    var result = {};

    A.withUndo("Chroma AE MCP: replace screen", function () {
      var look_skipped = [];
      var lookOut = {};
      var layer;
      var tg;
      var res;
      var wres;
      var fx;
      var fxIdx;
      var expansion = { mode: "none" };
      var useValues = args.expanded;
      var writes;
      try {
        // 1. The insert precomp: the source at 100% and centred, in a comp of the screen's aspect.
        made.comp = app.project.items.addComp(name + " INSERT", size[0], size[1], 1, insertDur, fps);
        // The duration only applies to stills, whose length would otherwise come from the still-footage preference.
        var inner = made.comp.layers.add(got.item, insertDur);
        var itg = inner.property("ADBE Transform Group");
        setXY(child(itg, "ADBE Position"), size[0] / 2, size[1] / 2);

        // 2. The insert layer, with the transform the pin keys assume.
        layer = comp.layers.add(made.comp);
        made.layer = layer;
        layer.name = name + " INSERT";
        tg = layer.property("ADBE Transform Group");
        setXY(child(tg, "ADBE Anchor Point"), size[0] / 2, size[1] / 2);
        setXY(child(tg, "ADBE Position"), cw / 2, ch / 2);
        if (plate) layer.moveBefore(plate);
        // Always set it: with "Create Layers at Composition Start Time" off, layers.add starts the layer at the CTI.
        layer.startTime = startAt;
        if (args.trim_to_keys === true) {
          // A range write: the layer only shows over its own keys, so a second range's layer does not sit frozen over the first.
          var tIn = times[0];
          var tOut = times[n - 1] + 1 / fps;
          if (tIn > layer.inPoint) layer.inPoint = tIn;
          if (tOut < layer.outPoint) layer.outPoint = tOut;
        }

        // 3. Look: Levels, then blur (shared order: colour < blur < pin < motion blur).
        if (lv) {
          res = addLevels(comp, layer, lv);
          if (res.ok) lookOut.levels = res;
          else look_skipped.push({ step: "levels", reason: res.reason, param_table: res.param_table });
        }
        if (look.blurriness !== undefined && look.blurriness !== null && look.blurriness > 0) {
          res = addBlur(comp, layer, look.blurriness);
          if (res.ok) lookOut.blur = res;
          else look_skipped.push({ step: "blur", reason: res.reason, param_table: res.param_table });
        }

        // 4. The pin. CC Power Pin: Expansion when it exists, else the expanded corners stand in for it.
        // If CC Power Pin is missing or its points cannot be told apart on this AE, a Corner Pin is built instead.
        var pinKind = kind;
        var pinFallback = null;
        var attempts = [kind];
        if (kind === "power_pin") attempts.push("corner_pin");
        var skippedBefore = look_skipped.length;
        var pinDone = false;
        var at;
        var pinWrite = null;
        for (at = 0; at < attempts.length && !pinDone; at++) {
          pinKind = attempts[at];
          var addedIdx = 0;
          try {
            expansion = { mode: "none" };
            useValues = args.expanded;
            fx = addEffect(comp, layer, PIN_MATCH[pinKind], "pin");
            addedIdx = indexOfFx(fx);
            if (pinKind === "power_pin") {
              var ep = findParam(fx, ["Expansion", "Expand"], null);
              if (ep && args.expansion_pct > 0) {
                try {
                  var epWant = clampToLimits(ep.prop, args.expansion_pct);
                  ep.prop.setValue(epWant);
                  useValues = args.exact;
                  expansion = { mode: "param", name: ep.name, matchName: ep.matchName, value: epWant };
                } catch (eEp) {
                  look_skipped.push({ step: "power_pin_expansion", reason: "Expansion could not be set (" + String(eEp.message || eEp) + "); the corners were pushed outward instead" });
                  expansion = { mode: "values" };
                }
              } else {
                if (!ep && args.expansion_pct > 0) look_skipped.push({ step: "power_pin_expansion", reason: "CC Power Pin has no parameter named Expansion on this AE; the corners were pushed outward instead", param_table: paramTable(fx) });
                if (args.expansion_pct > 0) expansion = { mode: "values" };
                else useValues = args.exact;
              }
            } else if (args.expansion_pct > 0) {
              expansion = { mode: "values" };
            } else {
              useValues = args.exact;
            }
            fxIdx = addedIdx;
            if (!(fxIdx > 0)) fxIdx = lastEffectOf(layer, PIN_MATCH[pinKind]).propertyIndex;
            pinWrite = A.planarWriteRaw({ comp_id: comp.id, writes: [{ layer_index: layer.index, layer_id: layer.id, target: pinKind, effect_index: fxIdx, add_effect: false, replace_keys: false, times: times, values: useValues }] });
            pinDone = true;
          } catch (ePin) {
            if (pinKind !== "power_pin" || at + 1 >= attempts.length) throw ePin;
            pinFallback = "CC Power Pin could not be used on this AE (" + String(ePin.message || ePin) + "); a Corner Pin was built instead.";
            dropEffect(layer, PIN_MATCH.power_pin, addedIdx);
            look_skipped.length = skippedBefore;
          }
        }
        wres = { written: pinWrite.written };
        if (wantTransform) {
          var tres = A.planarWriteRaw({ comp_id: comp.id, writes: [{ layer_index: layer.index, layer_id: layer.id, target: "transform", replace_keys: false, times: times, values: args.transform }] });
          wres = { written: pinWrite.written.concat(tres.written) };
        }

        // 5. Motion blur.
        var mbOut = { mode: mbMode };
        if (mbMode === "transform_pin") {
          layer.motionBlur = true;
          mbOut.layer_switch = true;
          var compWas = false;
          try {
            compWas = comp.motionBlur === true;
          } catch (eMb) {
            compWas = false;
          }
          mbOut.comp_switch_was_on = compWas;
          if (!compWas) {
            comp.motionBlur = true;
            mbOut.comp_switch_turned_on = true;
          }
        } else if (mbMode === "force") {
          try {
            addEffect(comp, layer, FORCE_BLUR_MATCH, "motion_blur");
            mbOut.force_effect_index = lastEffectOf(layer, FORCE_BLUR_MATCH).propertyIndex;
          } catch (eFb) {
            look_skipped.push({ step: "force_motion_blur", reason: "CC Force Motion Blur could not be added: " + String(eFb.message || eFb) });
            dropEffect(layer, FORCE_BLUR_MATCH);
          }
        }

        // 6. Reflections: the plate again, above the insert, in Screen, keeping only highlights, matted by the insert's alpha.
        if (refl) {
          var dup = null;
          var reflOut = null;
          try {
            dup = plate.duplicate();
            made.dup = dup;
            dup.name = name + " reflections";
            dup.moveBefore(layer);
            try {
              dup.audioEnabled = false;
            } catch (eAu) {}
            var lres = addLevels(comp, dup, { in_black: refl.threshold });
            if (!lres.ok) throw new Error(lres.reason);
            dup.blendingMode = BlendingMode.SCREEN;
            var insertWasOn = layer.enabled === true;
            dup.setTrackMatte(layer, TrackMatteType.ALPHA);
            // Live in AE 26.2.1: setTrackMatte switches the matte layer off. The insert is the picture itself and must stay visible, so switch it back on (written without reading it first).
            if (insertWasOn) layer.enabled = true;
            // Always set it: the duplicate inherits the plate's opacity, which may not be 100, may be keyed, or may be driven by an expression.
            var op = child(dup.property("ADBE Transform Group"), "ADBE Opacity");
            if (op) {
              while (op.numKeys > 0) op.removeKey(1);
              // An expression would win over the value, so clear it first.
              if (op.canSetExpression && op.expression !== "") op.expression = "";
              op.setValue(refl.opacity);
            }
            reflOut = {
              layer_index: dup.index,
              layer_id: dup.id,
              name: dup.name,
              blending_mode: BlendingMode.SCREEN,
              track_matte_type: TrackMatteType.ALPHA,
              matte_layer_id: layer.id,
              levels: lres,
              opacity: refl.opacity
            };
          } catch (eRefl) {
            // The reflection is a finishing touch: take back what it made and say so.
            try {
              if (dup) dup.remove();
            } catch (eRm) {}
            made.dup = null;
            reflOut = null;
            look_skipped.push({ step: "reflections", reason: String(eRefl.message || eRefl) });
          }
          if (reflOut) lookOut.reflections = reflOut;
        }

        // 7. The original layer, when the insert came from one.
        var srcOut = null;
        if (srcLayer && args.switch_off_source === true) {
          var was = srcLayer.enabled === true;
          srcLayer.enabled = false;
          srcOut = { index: srcLayer.index, id: srcLayer.id, name: srcLayer.name, was_enabled: was };
        }

        result = {
          insert_comp: { id: made.comp.id, name: made.comp.name, width: made.comp.width, height: made.comp.height, duration: made.comp.duration },
          insert_layer: { index: layer.index, id: layer.id, name: layer.name },
          source_item: { id: got.info.item_id, name: got.info.name, kind: got.info.kind },
          pin: {
            kind: pinKind,
            effect_index: fxIdx,
            values_used: useValues === args.exact ? "exact" : "expanded",
            expansion: expansion,
            effect_added: true,
            param_table: wres.written[0].param_table
          },
          pin_fallback: pinFallback,
          written: wres.written,
          look: lookOut,
          look_skipped: look_skipped,
          motion_blur: mbOut,
          source_layer: srcOut,
          plate: plate ? { index: plate.index, id: plate.id, name: plate.name } : null,
          keys: n
        };
      } catch (e) {
        // All or nothing: take away what this call made, newest first.
        try {
          if (made.dup) made.dup.remove();
        } catch (e1) {}
        try {
          if (made.layer) made.layer.remove();
        } catch (e2) {}
        try {
          if (made.comp) made.comp.remove();
        } catch (e3) {}
        throw e;
      }
    });
    return result;
  };

  // ---------- read-back ----------

  function numOrNull(v) {
    if (typeof v === "number" && isFinite(v)) return v;
    return null;
  }

  function paramValue(p) {
    var v = null;
    try {
      v = p.value;
    } catch (e) {
      return null;
    }
    if (typeof v === "number") return numOrNull(v);
    if (isArr(v)) {
      var out = [];
      for (var i = 0; i < v.length && i < 4; i++) {
        if (typeof v[i] !== "number") return null;
        out.push(v[i]);
      }
      return out;
    }
    return null;
  }

  function effectsOf(layer) {
    var out = [];
    var parade = layer.property("ADBE Effect Parade");
    if (!parade) return out;
    for (var i = 1; i <= parade.numProperties && i <= MAX_EFFECTS; i++) {
      var fx = parade.property(i);
      var params = [];
      for (var k = 1; k <= fx.numProperties && k <= MAX_PARAMS; k++) {
        var p = null;
        try {
          p = fx.property(k);
        } catch (e) {
          p = null;
        }
        if (p && p.propertyType === PropertyType.PROPERTY) {
          params.push({ index: k, name: p.name, matchName: p.matchName, type: "param", value: paramValue(p) });
        }
      }
      out.push({ index: i, name: fx.name, matchName: fx.matchName, params: params });
    }
    return out;
  }

  function layerDetail(layer) {
    var d = { index: layer.index, id: layer.id, name: layer.name, enabled: layer.enabled === true, start_time: layer.startTime, in_point: layer.inPoint, out_point: layer.outPoint };
    try {
      d.motion_blur = layer.motionBlur === true;
    } catch (e1) {
      d.motion_blur = null;
    }
    try {
      d.blending_mode = layer.blendingMode;
    } catch (e2) {
      d.blending_mode = null;
    }
    try {
      d.track_matte_type = layer.trackMatteType;
    } catch (e3) {
      d.track_matte_type = null;
    }
    d.matte_layer_id = null;
    try {
      if (layer.trackMatteLayer) d.matte_layer_id = layer.trackMatteLayer.id;
    } catch (e4) {}
    try {
      d.source_id = layer.source ? layer.source.id : null;
    } catch (e5) {
      d.source_id = null;
    }
    d.opacity = null;
    try {
      d.opacity = layer.property("ADBE Transform Group").property("ADBE Opacity").value;
    } catch (e6) {
      d.opacity = null;
    }
    d.effects = effectsOf(layer);
    return d;
  }

  // args: { comp_id, layer_ids?: [id], insert_comp_id?, keys?: [planarKeys items] }
  A.screenrepRead = function (args) {
    var comp = requireComp(args.comp_id);
    var mb = null;
    try {
      mb = comp.motionBlur === true;
    } catch (e) {
      mb = null;
    }
    var out = { comp_id: comp.id, num_layers: comp.numLayers, comp_motion_blur: mb, layers: [], details: [], insert_comp: null, keys: null };
    var i;
    for (i = 1; i <= comp.numLayers && i <= MAX_LIST; i++) {
      var l = comp.layer(i);
      out.layers.push({ index: l.index, id: l.id, name: l.name, enabled: l.enabled === true });
    }
    if (comp.numLayers > MAX_LIST) out.truncated = true;
    var ids = args.layer_ids;
    if (isArr(ids)) {
      for (var k = 0; k < ids.length && k < 10; k++) {
        for (i = 1; i <= comp.numLayers; i++) {
          if (comp.layer(i).id === ids[k]) {
            out.details.push(layerDetail(comp.layer(i)));
            break;
          }
        }
      }
    }
    if (args.insert_comp_id !== undefined && args.insert_comp_id !== null) {
      var ic = itemOf(args.insert_comp_id);
      if (ic && ic instanceof CompItem) {
        var names = [];
        for (i = 1; i <= ic.numLayers && i <= 20; i++) names.push(ic.layer(i).name);
        out.insert_comp = { id: ic.id, name: ic.name, width: ic.width, height: ic.height, duration: ic.duration, num_layers: ic.numLayers, layer_names: names };
      }
    }
    if (isArr(args.keys) && args.keys.length > 0) {
      if (typeof A.planarKeys !== "function") fail("not_found", "planarKeys is not loaded, so the keys cannot be read back");
      out.keys = A.planarKeys({ comp_id: comp.id, items: args.keys });
    }
    return out;
  };
})($.global);
