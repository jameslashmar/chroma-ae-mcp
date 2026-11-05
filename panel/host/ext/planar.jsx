// panel/host/ext/planar.jsx
//
// Host functions for the planar tools (ae_track_multi, ae_track_read,
// ae_track_apply) and for the wave-4 tools that build on them. Every name
// starts with "planar" because other groups add functions to the same object.
//
// - planarComp (read): comp size, frame rate, current time, work area, and
//   the layers asked for
// - planarIsolateBegin (guarded write): duplicate a comp and switch every
//   layer off except the plate layers, in the COPY, one undo group
// - planarIsolateEnd (guarded write): remove that copy, and only such a copy
// - planarLayerSpace (read): a layer's transform and parent chain per time
// - planarRead (read): a track that exists in the project (nulls, Corner Pin
//   or CC Power Pin keys, AE Tracker points, transform keys), sampled on the
//   frame grid and converted to comp pixels
// - planarEffectSlot (read): where a new effect of a category belongs in a
//   patch layer's effect stack
// - planarWriteRaw (validates, then writes, opens NO undo group: callers wrap it)
// - planarApply (guarded write): new null layers plus planarWriteRaw's writes
//   in one undo group, everything validated before the group opens
// - planarKeys (read): key counts and sampled values, for the read-back
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Reads never change time, selection, solo, resolution or the active item.
// - Writes check the guard first, validate everything that can fail before
//   A.withUndo, and open and close the undo group in the same call.
// - Adding an effect invalidates references to the others: effects and their
//   points are looked up again after addProperty and moveTo.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_FRAMES = 3000;
  var MAX_CHAIN = 20;
  var MAX_POINTS = 8;
  var ISOLATE_PREFIX = "_chroma_plate_";
  var MAX_SHOW = 100;

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

  function compFps(comp) {
    var fps = Number(comp.frameRate);
    if (!(fps > 0)) fps = 25;
    return fps;
  }

  // ---------- matrices (row-major, [x y 1]) ----------

  function mulM(a, b) {
    var out = [];
    var r;
    var c;
    for (r = 0; r < 3; r++) {
      for (c = 0; c < 3; c++) {
        out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
      }
    }
    return out;
  }

  function identM() {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  function layerM(t) {
    var r = (t.rotation * Math.PI) / 180;
    var c = Math.cos(r);
    var s = Math.sin(r);
    var sx = t.scale[0] / 100;
    var sy = t.scale[1] / 100;
    var l00 = c * sx;
    var l01 = -s * sy;
    var l10 = s * sx;
    var l11 = c * sy;
    return [
      l00, l01, t.position[0] - (l00 * t.anchor[0] + l01 * t.anchor[1]),
      l10, l11, t.position[1] - (l10 * t.anchor[0] + l11 * t.anchor[1]),
      0, 0, 1
    ];
  }

  function applyM(m, p) {
    return [m[0] * p[0] + m[1] * p[1] + m[2], m[3] * p[0] + m[4] * p[1] + m[5]];
  }

  function xy(v) {
    return [Number(v[0]), Number(v[1])];
  }

  function transformAt(layer, t) {
    var tg = layer.property("ADBE Transform Group");
    if (!tg) fail("not_found", "Layer \"" + layer.name + "\" has no Transform group");
    var a = child(tg, "ADBE Anchor Point");
    var p = child(tg, "ADBE Position");
    var s = child(tg, "ADBE Scale");
    var r = child(tg, "ADBE Rotate Z");
    if (!a || !p || !s || !r) fail("not_found", "Layer \"" + layer.name + "\" lacks Anchor, Position, Scale or Rotation");
    return {
      anchor: xy(a.valueAtTime(t, false)),
      position: xy(p.valueAtTime(t, false)),
      scale: xy(s.valueAtTime(t, false)),
      rotation: Number(r.valueAtTime(t, false))
    };
  }

  // The parents' matrices only: parent px -> comp px. Refuses a 3D parent.
  function parentChain(layer, t) {
    var m = identM();
    var chain = [];
    var p = layer.parent;
    var n = 0;
    while (p && n < MAX_CHAIN) {
      if (isThreeD(p)) fail("bad_args", "Parent \"" + p.name + "\" is a 3D layer; planar tracks work in 2D only.");
      var tr = transformAt(p, t);
      chain.push(tr);
      m = mulM(layerM(tr), m);
      p = p.parent;
      n++;
    }
    return { matrix: m, chain: chain };
  }

  // layer px -> comp px at time t
  function layerToComp(layer, t) {
    if (isThreeD(layer)) fail("bad_args", "Layer \"" + layer.name + "\" is a 3D layer; planar tracks work in 2D only.");
    var pc = parentChain(layer, t);
    return mulM(pc.matrix, layerM(transformAt(layer, t)));
  }

  function requireSquarePixels(comp) {
    var pa = Number(comp.pixelAspect);
    if (pa > 0 && Math.abs(pa - 1) > 1e-6) {
      fail("bad_args", "The comp's pixel aspect is " + pa + ", not 1. Planar tracking works on square pixels only.");
    }
  }

  // ---------- comp info ----------

  // args: { comp_id, layers?: [selector] }
  A.planarComp = function (args) {
    var comp = requireComp(args.comp_id);
    var out = {
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
      layers: []
    };
    if (args.layers && args.layers.length) {
      for (var i = 0; i < args.layers.length && i < MAX_SHOW; i++) {
        out.layers.push(layerBrief(findLayer(comp, args.layers[i])));
      }
    }
    return out;
  };

  // ---------- isolating the plate ----------

  // args: { comp_id, show_layers: [{ index, id }], expect }. The comp is
  // duplicated and every layer of the COPY is switched off except the listed
  // ones, which are switched on. A duplicated comp's layers get new ids but
  // keep their indexes, so the copy is addressed by index.
  A.planarIsolateBegin = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var want = args.show_layers;
    var i;
    if (!want || !want.length) fail("bad_args", "No plate layers to show");
    if (want.length > MAX_SHOW) fail("bad_args", "At most " + MAX_SHOW + " plate layers");
    var show = {};
    for (i = 0; i < want.length; i++) {
      var l = layerByIndexId(comp, want[i].index, want[i].id);
      if (show[l.index] === true) fail("bad_args", "Layer index " + l.index + " is listed twice");
      show[l.index] = true;
    }
    var made = A.withUndo("Chroma AE MCP: isolate plate (copy)", function () {
      var copy = comp.duplicate();
      try {
        copy.name = ISOLATE_PREFIX + comp.name;
        for (var k = 1; k <= copy.numLayers; k++) {
          var cl = copy.layer(k);
          // The copy is our own throwaway, so a lock on it can go.
          var hasVideo = true;
          try {
            if (cl.hasVideo === false) hasVideo = false;
          } catch (eHv) {}
          // Audio-only layers have no video switch to set.
          if (!hasVideo) continue;
          try {
            if (cl.locked === true) cl.locked = false;
          } catch (eLk) {}
          var wantOn = show[k] === true;
          // Solo hides every layer that is not soloed, enabled or not: the copy keeps none, so the plate renders.
          try {
            if (cl.solo === true) cl.solo = false;
          } catch (eSo) {}
          try {
            if (cl.enabled !== wantOn) cl.enabled = wantOn;
          } catch (eEn) {
            // A plate layer that cannot be switched on is a real failure; an odd hidden one is not.
            if (wantOn) throw eEn;
          }
        }
        return { copy_id: copy.id, copy_name: copy.name };
      } catch (e) {
        // Never leave a half-made copy in the project.
        try {
          copy.remove();
        } catch (e2) {}
        throw e;
      }
    });
    return { copy_id: made.copy_id, copy_name: made.copy_name, original_id: comp.id };
  };

  // args: { copy_id, expect }. Removes the temporary copy, and only such a copy.
  A.planarIsolateEnd = function (args) {
    assertGuard(args.expect);
    var item = null;
    try {
      item = app.project.itemByID(args.copy_id);
    } catch (e) {
      item = null;
    }
    if (!item) return { removed: false, already_gone: true, copy_id: args.copy_id };
    if (!(item instanceof CompItem) || String(item.name).indexOf(ISOLATE_PREFIX) !== 0) {
      fail("guard", "Refused: item " + args.copy_id + " is not a plate copy, so it was not removed.");
    }
    A.withUndo("Chroma AE MCP: isolate plate (remove copy)", function () {
      item.remove();
    });
    return { removed: true, copy_id: args.copy_id };
  };

  // args: { item_id }. Whether an item with that id is still in the project. Changes nothing.
  A.planarItemExists = function (args) {
    var item = null;
    try {
      item = app.project.itemByID(args.item_id);
    } catch (e) {
      item = null;
    }
    return { exists: item ? true : false, item_id: args.item_id };
  };

  // ---------- layer space ----------

  // args: { comp_id, layer: { index, id }, times: [seconds] }
  A.planarLayerSpace = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = layerByIndexId(comp, args.layer.index, args.layer.id);
    var times = args.times;
    if (!isArr(times) || times.length < 1) fail("bad_args", "times must be a non-empty array");
    if (times.length > MAX_FRAMES) fail("bad_args", "At most " + MAX_FRAMES + " times");
    if (isThreeD(layer)) fail("bad_args", "Layer \"" + layer.name + "\" is a 3D layer; planar tracks work in 2D only.");
    requireSquarePixels(comp);
    var out = [];
    for (var i = 0; i < times.length; i++) {
      var t = Number(times[i]);
      var own = transformAt(layer, t);
      var pc = parentChain(layer, t);
      out.push({
        time: t,
        anchor: own.anchor,
        position: own.position,
        scale: own.scale,
        rotation: own.rotation,
        parent_chain: pc.chain,
        three_d: false
      });
    }
    return { layer: layerBrief(layer), width: layer.width, height: layer.height, samples: out };
  };

  // ---------- effect order on a patch layer ----------

  var EFFECT_CATEGORIES = {
    color: ["ADBE Pro Levels2", "ADBE Easy Levels2", "ADBE Exposure2", "ADBE CurvesCustom", "ADBE HUE SATURATION", "ADBE Tint", "ADBE Brightness & Contrast 2"],
    degrain: ["ADBE Median", "VISINF Grain Removal", "ADBE Remove Grain"],
    blur: ["ADBE Gaussian Blur 2"],
    pin: ["ADBE Corner Pin", "CC Power Pin"],
    motion_blur: ["CC Force Motion Blur"]
  };
  var CATEGORY_ORDER = ["color", "degrain", "blur", "pin", "motion_blur"];

  function categoryOf(matchName) {
    for (var c = 0; c < CATEGORY_ORDER.length; c++) {
      var list = EFFECT_CATEGORIES[CATEGORY_ORDER[c]];
      for (var i = 0; i < list.length; i++) {
        if (list[i] === matchName) return c;
      }
    }
    return -1;
  }

  // args: { comp_id, layer_index, layer_id, category, new_index? }. The 1-based
  // index a new effect of that category belongs at: effects the tools did not
  // add stay in front, then colour < degrain < blur < pin < motion blur.
  // `new_index` is the index of the effect just added (left out of the count);
  // without it the effect is taken not to exist yet, so a caller that has
  // already added the effect MUST pass new_index. Changes nothing.
  A.planarEffectSlot = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = layerByIndexId(comp, args.layer_index, args.layer_id);
    var rank = -1;
    var c;
    for (c = 0; c < CATEGORY_ORDER.length; c++) {
      if (CATEGORY_ORDER[c] === args.category) rank = c;
    }
    if (rank < 0) fail("bad_args", "Unknown effect category \"" + args.category + "\"");
    var effects = layer.property("ADBE Effect Parade");
    // Walk the stack by position, the new effect left out. `last` is the
    // position of the last tool effect that must stay in front of the new one;
    // `lead` counts the unknown effects in front of the first tool effect.
    var pos = 0;
    var last = 0;
    var lead = 0;
    var seenTool = false;
    if (effects) {
      for (var i = 1; i <= effects.numProperties; i++) {
        if (args.new_index !== undefined && args.new_index !== null && i === args.new_index) continue;
        pos++;
        var fx = effects.property(i);
        var cat = categoryOf(fx.matchName);
        if (cat < 0) {
          if (!seenTool) lead++;
        } else {
          seenTool = true;
          if (cat <= rank) last = pos;
        }
      }
    }
    // An unknown effect between two tool effects keeps its place: the slot
    // follows the last tool effect that belongs in front, else the leading
    // unknown effects (those the tools did not add stay in front).
    if (last > 0) return last + 1;
    return lead + 1;
  };

  // ---------- pin effect parameters ----------

  var PIN_KINDS = {
    corner_pin: {
      matchName: "ADBE Corner Pin",
      roles: ["ul", "ur", "ll", "lr"],
      names: ["Upper Left", "Upper Right", "Lower Left", "Lower Right"],
      matchNames: ["ADBE Corner Pin-0001", "ADBE Corner Pin-0002", "ADBE Corner Pin-0003", "ADBE Corner Pin-0004"]
    },
    power_pin: {
      matchName: "CC Power Pin",
      roles: ["ul", "ur", "ll", "lr"],
      names: ["Top Left", "Top Right", "Bottom Left", "Bottom Right"],
      matchNames: ["", "", "", ""]
    }
  };

  // The four point properties of a pin effect and how each was found (by
  // display name, by match name, or by its position in the effect), so the
  // caller can report the table it used.
  function pinParams(fx, kind) {
    var def = PIN_KINDS[kind];
    var out = [];
    var used = {};
    for (var r = 0; r < 4; r++) {
      var prop = null;
      var how = "";
      if (def.matchNames[r] !== "") {
        prop = child(fx, def.matchNames[r]);
        if (prop && prop.propertyType === PropertyType.PROPERTY) how = "match";
        else prop = null;
      }
      if (!prop) {
        prop = child(fx, def.names[r]);
        if (prop && prop.propertyType === PropertyType.PROPERTY) how = "name";
        else prop = null;
      }
      if (!prop) {
        try {
          prop = fx.property(r + 1);
        } catch (e) {
          prop = null;
        }
        if (prop) how = "index";
      }
      if (!prop) fail("not_found", "The " + kind + " effect has no " + def.names[r] + " point (found no property by name, match name or index " + (r + 1) + ")");
      if (used[prop.matchName + "|" + prop.name] === true) fail("bad_args", "The " + kind + " effect's points could not be told apart; its parameters are not what was expected.");
      used[prop.matchName + "|" + prop.name] = true;
      out.push({ role: def.roles[r], prop: prop, name: prop.name, matchName: prop.matchName, how: how, index: r + 1 });
    }
    return out;
  }

  function pinTable(params) {
    var t = [];
    for (var i = 0; i < params.length; i++) {
      t.push({ role: params[i].role, name: params[i].name, matchName: params[i].matchName, how: params[i].how });
    }
    return t;
  }

  // The effect of a kind: by 1-based effect index, or the first of that kind.
  function findPinEffect(layer, kind, effectIndex) {
    var effects = layer.property("ADBE Effect Parade");
    if (!effects) return null;
    var def = PIN_KINDS[kind];
    var i;
    if (effectIndex !== undefined && effectIndex !== null) {
      if (effectIndex < 1 || effectIndex > effects.numProperties) fail("not_found", "Layer \"" + layer.name + "\" has no effect " + effectIndex);
      var one = effects.property(effectIndex);
      if (one.matchName !== def.matchName) fail("bad_args", "Effect " + effectIndex + " on \"" + layer.name + "\" is \"" + one.name + "\" (" + one.matchName + "), not a " + def.matchName);
      return one;
    }
    for (i = 1; i <= effects.numProperties; i++) {
      if (effects.property(i).matchName === def.matchName) return effects.property(i);
    }
    return null;
  }

  function effectNames(layer) {
    var names = [];
    var effects = layer.property("ADBE Effect Parade");
    if (!effects) return names;
    for (var i = 1; i <= effects.numProperties && i <= 50; i++) {
      names.push(effects.property(i).name + " (" + effects.property(i).matchName + ")");
    }
    return names;
  }

  // ---------- reading a track that exists ----------

  // True when a Position has its dimensions separated (setValuesAtTimes on it throws then).
  function separatedDims(prop) {
    try {
      return prop.dimensionsSeparated === true;
    } catch (e) {
      return false;
    }
  }

  function frameKey(t, fps) {
    return Math.round(t * fps);
  }

  // Key bookkeeping over several properties: the time span, the frames every
  // property has a key on, and keys off the frame grid.
  function KeyInfo(fps) {
    this.fps = fps;
    this.min = null;
    this.max = null;
    this.frames = [];
    this.offGrid = 0;
    this.expressions = [];
    this.props = 0;
  }

  KeyInfo.prototype.add = function (prop, label) {
    var set = {};
    var n = 0;
    try {
      n = prop.numKeys;
    } catch (e) {
      n = 0;
    }
    for (var k = 1; k <= n; k++) {
      var t = prop.keyTime(k);
      if (this.min === null || t < this.min) this.min = t;
      if (this.max === null || t > this.max) this.max = t;
      var fk = frameKey(t, this.fps);
      if (Math.abs(t * this.fps - fk) > 0.01) this.offGrid++;
      set[fk] = true;
    }
    try {
      if (prop.expressionEnabled === true) this.expressions.push(label);
    } catch (e2) {}
    this.frames.push(set);
    this.props++;
  };

  KeyInfo.prototype.keyedAt = function (fk) {
    if (this.frames.length === 0) return false;
    for (var i = 0; i < this.frames.length; i++) {
      if (this.frames[i][fk] !== true) return false;
    }
    return true;
  };

  function addChainKeys(info, layer) {
    var l = layer;
    var n = 0;
    while (l && n < MAX_CHAIN) {
      var tg = l.property("ADBE Transform Group");
      var names = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z"];
      for (var i = 0; i < names.length; i++) {
        var p = child(tg, names[i]);
        if (p && p.numKeys > 0) info.add(p, l.name + " " + names[i]);
        else if (p && p.expressionEnabled === true) info.add(p, l.name + " " + names[i]);
      }
      l = l.parent;
      n++;
    }
  }

  // The frame grid [start, end]: times, capped at MAX_FRAMES.
  function gridTimes(comp, startT, endT) {
    var fps = compFps(comp);
    var f0 = Math.round(startT * fps);
    var f1 = Math.round(endT * fps);
    if (f1 < f0) {
      var tmp = f0;
      f0 = f1;
      f1 = tmp;
    }
    var truncated = false;
    if (f1 - f0 + 1 > MAX_FRAMES) {
      f1 = f0 + MAX_FRAMES - 1;
      truncated = true;
    }
    var times = [];
    for (var f = f0; f <= f1; f++) times.push(f / fps);
    return { times: times, truncated: truncated };
  }

  function pickSpan(info, args, what) {
    var startT = args.start;
    var endT = args.end;
    if ((startT === undefined || startT === null) && info.min !== null) startT = info.min;
    if ((endT === undefined || endT === null) && info.max !== null) endT = info.max;
    if (startT === undefined || startT === null || endT === undefined || endT === null) {
      fail("bad_args", what + " has no keyframes and no start/end was given, so there is nothing to read.");
    }
    return { start: startT, end: endT };
  }

  function finishRead(comp, kind, names, info, grid, series, extra) {
    var fps = compFps(comp);
    var keyed = 0;
    for (var i = 0; i < grid.times.length; i++) {
      if (info.keyedAt(frameKey(grid.times[i], fps))) keyed++;
    }
    var out = {
      kind: kind,
      comp: { id: comp.id, width: comp.width, height: comp.height, fps: fps, frame_duration: comp.frameDuration, pixel_aspect: comp.pixelAspect },
      names: names,
      times: grid.times,
      series: series,
      truncated: grid.truncated,
      keyed_frames: keyed,
      interpolated_frames: grid.times.length - keyed,
      off_grid_keys: info.offGrid,
      expression_driven: info.expressions
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
      }
    }
    return out;
  }

  function readNulls(comp, args) {
    var sels = args.layers;
    if (!isArr(sels) || sels.length < 1 || sels.length > MAX_POINTS) fail("bad_args", "Give 1 to " + MAX_POINTS + " layers");
    var info = new KeyInfo(compFps(comp));
    var layers = [];
    var names = [];
    var i;
    for (i = 0; i < sels.length; i++) {
      var l = findLayer(comp, sels[i]);
      if (isThreeD(l)) fail("bad_args", "Layer \"" + l.name + "\" is a 3D layer; planar tracks work in 2D only.");
      var pos = child(l.property("ADBE Transform Group"), "ADBE Position");
      if (pos && separatedDims(pos)) fail("bad_args", "Layer \"" + l.name + "\" has separated Position dimensions; join them (Separate Dimensions off) first.");
      if (!pos || (pos.numKeys < 1 && pos.expressionEnabled !== true)) fail("bad_args", "Layer \"" + l.name + "\" has no Position keys to read.");
      info.add(pos, l.name + " Position");
      addChainKeys(info, l.parent);
      layers.push(l);
      names.push(l.name);
    }
    var span = pickSpan(info, args, "These layers");
    var grid = gridTimes(comp, span.start, span.end);
    var series = [];
    for (var t = 0; t < grid.times.length; t++) {
      var row = [];
      for (i = 0; i < layers.length; i++) {
        var pc = parentChain(layers[i], grid.times[t]);
        var p = xy(child(layers[i].property("ADBE Transform Group"), "ADBE Position").valueAtTime(grid.times[t], false));
        row.push(applyM(pc.matrix, p));
      }
      series.push(row);
    }
    return finishRead(comp, "nulls", names, info, grid, series, null);
  }

  function readPin(comp, args) {
    var layer = findLayer(comp, args.layer);
    var kinds = ["corner_pin", "power_pin"];
    var want = args.effect;
    if (want === "corner_pin" || want === "power_pin") {
      kinds = [want];
    } else if (args.effect_index !== undefined && args.effect_index !== null) {
      // No kind given: take it from the effect at that index.
      var fxParade = layer.property("ADBE Effect Parade");
      if (fxParade && args.effect_index >= 1 && args.effect_index <= fxParade.numProperties) {
        var atIdx = fxParade.property(args.effect_index);
        if (atIdx.matchName === PIN_KINDS.corner_pin.matchName) kinds = ["corner_pin"];
        else if (atIdx.matchName === PIN_KINDS.power_pin.matchName) kinds = ["power_pin"];
        else fail("bad_args", "Effect " + args.effect_index + " on \"" + layer.name + "\" is \"" + atIdx.name + "\" (" + atIdx.matchName + "), neither a Corner Pin nor a CC Power Pin");
      }
    }
    var fx = null;
    var kind = "";
    for (var k = 0; k < kinds.length && !fx; k++) {
      fx = findPinEffect(layer, kinds[k], args.effect_index);
      if (fx) kind = kinds[k];
    }
    if (!fx) fail("not_found", "Layer \"" + layer.name + "\" has no Corner Pin or CC Power Pin effect. Its effects: " + effectNames(layer).join(", "));
    var params = pinParams(fx, kind);
    var info = new KeyInfo(compFps(comp));
    var i;
    for (i = 0; i < 4; i++) info.add(params[i].prop, "pin " + params[i].role);
    addChainKeys(info, layer);
    var span = pickSpan(info, args, "The " + kind + " effect");
    var grid = gridTimes(comp, span.start, span.end);
    // Order the corners clockwise: UL, UR, LR, LL.
    var order = [0, 1, 3, 2];
    var names = [];
    for (i = 0; i < 4; i++) names.push(params[order[i]].role);
    var series = [];
    for (var t = 0; t < grid.times.length; t++) {
      var m = layerToComp(layer, grid.times[t]);
      var row = [];
      for (i = 0; i < 4; i++) {
        row.push(applyM(m, xy(params[order[i]].prop.valueAtTime(grid.times[t], false))));
      }
      series.push(row);
    }
    return finishRead(comp, kind, names, info, grid, series, {
      layer: layerBrief(layer),
      effect: { index: fx.propertyIndex, name: fx.name, matchName: fx.matchName },
      param_table: pinTable(params)
    });
  }

  function readTracker(comp, args) {
    var layer = findLayer(comp, args.layer);
    var trackers = layer.property("ADBE MTrackers");
    if (!trackers || trackers.numProperties < 1) {
      fail("not_found", "Layer \"" + layer.name + "\" has no AE Tracker data (ADBE MTrackers). Its top-level properties: " + topNames(layer).join(", "));
    }
    var tr = null;
    var i;
    for (i = 1; i <= trackers.numProperties; i++) {
      var cand = trackers.property(i);
      if (args.tracker === undefined || args.tracker === null || cand.name === args.tracker) {
        tr = cand;
        break;
      }
    }
    if (!tr) fail("not_found", "No tracker named \"" + args.tracker + "\" on layer \"" + layer.name + "\"");
    var pts = [];
    var confs = [];
    var names = [];
    for (i = 1; i <= tr.numProperties; i++) {
      var pt = tr.property(i);
      if (pt.matchName !== "ADBE MTracker Pt") continue;
      if (isArr(args.points) && args.points.length > 0) {
        var listed = false;
        for (var q = 0; q < args.points.length; q++) {
          if (args.points[q] === pt.name) listed = true;
        }
        if (!listed) continue;
      }
      var fc = child(pt, "ADBE MTracker Pt Feature Center");
      if (!fc) fc = child(pt, "Feature Center");
      if (!fc) fail("not_found", "Track point \"" + pt.name + "\" has no Feature Center property");
      pts.push(fc);
      confs.push(child(pt, "ADBE MTracker Pt Confidence"));
      names.push(pt.name);
    }
    if (pts.length < 1) fail("not_found", "Tracker \"" + tr.name + "\" has no track points" + (isArr(args.points) ? " with those names" : ""));
    if (pts.length > MAX_POINTS) fail("bad_args", "The tracker has " + pts.length + " points; name up to " + MAX_POINTS + " with `points`");
    var info = new KeyInfo(compFps(comp));
    for (i = 0; i < pts.length; i++) info.add(pts[i], names[i] + " Feature Center");
    addChainKeys(info, layer);
    var span = pickSpan(info, args, "The tracker");
    var grid = gridTimes(comp, span.start, span.end);
    var series = [];
    var confidence = [];
    for (var t = 0; t < grid.times.length; t++) {
      var m = layerToComp(layer, grid.times[t]);
      var row = [];
      var crow = [];
      for (i = 0; i < pts.length; i++) {
        row.push(applyM(m, xy(pts[i].valueAtTime(grid.times[t], false))));
        if (confs[i]) {
          var cv = null;
          try {
            cv = Number(confs[i].valueAtTime(grid.times[t], false));
          } catch (e) {
            cv = null;
          }
          crow.push(cv);
        } else {
          crow.push(null);
        }
      }
      series.push(row);
      confidence.push(crow);
    }
    return finishRead(comp, "tracker", names, info, grid, series, { layer: layerBrief(layer), tracker: tr.name, confidence: confidence });
  }

  function topNames(layer) {
    var out = [];
    for (var i = 1; i <= layer.numProperties && i <= 40; i++) {
      out.push(layer.property(i).matchName);
    }
    return out;
  }

  function readTransform(comp, args) {
    var layer = findLayer(comp, args.layer);
    if (isThreeD(layer)) fail("bad_args", "Layer \"" + layer.name + "\" is a 3D layer; planar tracks work in 2D only.");
    var w = Number(layer.width);
    var h = Number(layer.height);
    if (!(w > 0) || !(h > 0)) fail("bad_args", "Layer \"" + layer.name + "\" has no width and height (it is not a footage, solid or comp layer), so its corners cannot be tracked.");
    var info = new KeyInfo(compFps(comp));
    var tg = layer.property("ADBE Transform Group");
    var names = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z"];
    var i;
    for (i = 0; i < names.length; i++) {
      var p = child(tg, names[i]);
      if (p && (p.numKeys > 0 || p.expressionEnabled === true)) info.add(p, names[i]);
    }
    addChainKeys(info, layer.parent);
    var span = pickSpan(info, args, "The layer's Position, Scale and Rotation");
    var grid = gridTimes(comp, span.start, span.end);
    var corners = [[0, 0], [w, 0], [w, h], [0, h]];
    var series = [];
    for (var t = 0; t < grid.times.length; t++) {
      var m = layerToComp(layer, grid.times[t]);
      var row = [];
      for (i = 0; i < 4; i++) row.push(applyM(m, corners[i]));
      series.push(row);
    }
    return finishRead(comp, "transform", ["ul", "ur", "lr", "ll"], info, grid, series, { layer: layerBrief(layer), layer_size: [w, h] });
  }

  // args: { comp_id, source: { kind, ... } }. Read only.
  A.planarRead = function (args) {
    var comp = requireComp(args.comp_id);
    requireSquarePixels(comp);
    var src = args.source;
    if (!src || !src.kind) fail("bad_args", "source.kind is missing");
    if (src.kind === "nulls") return readNulls(comp, src);
    if (src.kind === "corner_pin") return readPin(comp, src);
    if (src.kind === "tracker") return readTracker(comp, src);
    if (src.kind === "transform") return readTransform(comp, src);
    fail("bad_args", "Unknown source kind \"" + src.kind + "\"");
    return null;
  };

  // ---------- writing ----------

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function checkTimes(times, what) {
    if (!isArr(times) || times.length < 1) fail("bad_args", what + ": times must be a non-empty array");
    if (times.length > MAX_FRAMES) fail("bad_args", what + ": " + times.length + " keys is over the " + MAX_FRAMES + " per property limit; narrow the write to one span (range)");
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

  function checkWritable(prop, replace, what) {
    var n = 0;
    try {
      n = prop.numKeys;
    } catch (e) {
      n = 0;
    }
    if (n > 0 && replace !== true) fail("bad_args", what + " already has " + n + " keyframes; pass replace_keys to replace them");
    var ex = false;
    try {
      ex = prop.expressionEnabled === true;
    } catch (e2) {
      ex = false;
    }
    if (ex) fail("bad_args", what + " has an expression, which would override the keys; remove the expression first");
  }

  // Plan one write: resolve and check everything, touch nothing.
  function planWrite(comp, w, replaceAll) {
    var layer = layerByIndexId(comp, w.layer_index, w.layer_id);
    var what = "Layer \"" + layer.name + "\"";
    if (layer.locked === true) fail("bad_args", what + " is locked");
    if (isThreeD(layer)) fail("bad_args", what + " is a 3D layer; planar tracks work in 2D only.");
    checkTimes(w.times, what);
    var n = w.times.length;
    var replace = w.replace_keys === true || replaceAll === true;
    var plan = { layer: layer, w: w, props: [], pin: null, addEffect: false, replace: replace };
    var vals = w.values;
    if (!vals) fail("bad_args", what + ": values missing");
    var tg = layer.property("ADBE Transform Group");
    var p;
    if (w.target === "corner_pin" || w.target === "power_pin") {
      var kind = w.target;
      var roles = ["ul", "ur", "ll", "lr"];
      for (var r = 0; r < 4; r++) checkSeries(vals[roles[r]], n, 2, what + " " + roles[r]);
      var fx = findPinEffect(layer, kind, w.effect_index);
      if (!fx) {
        if (w.add_effect !== true) fail("not_found", what + " has no " + PIN_KINDS[kind].matchName + " effect; pass add_effect to add one. Its effects: " + effectNames(layer).join(", "));
        // The layer must be able to take the effect: find out now, not inside the undo group.
        var parade = layer.property("ADBE Effect Parade");
        if (!parade) fail("not_found", what + " cannot take effects (no Effect Parade)");
        var canAdd = true;
        try {
          if (typeof parade.canAddProperty === "function") canAdd = parade.canAddProperty(PIN_KINDS[kind].matchName) === true;
        } catch (eCa) {
          canAdd = true;
        }
        if (!canAdd) fail("not_found", what + " cannot take " + PIN_KINDS[kind].matchName + " (the effect is missing on this install, or the layer cannot hold it)");
        plan.addEffect = true;
      } else {
        var params = pinParams(fx, kind);
        plan.pin = { kind: kind, effect_index: fx.propertyIndex, table: pinTable(params) };
        for (var k = 0; k < 4; k++) {
          checkWritable(params[k].prop, replace, what + " " + params[k].name);
          checkLimits(params[k].prop, vals[params[k].role], 2, what + " " + params[k].name);
        }
      }
      plan.kind = kind;
    } else if (w.target === "position" || w.target === "transform") {
      var defs = [
        ["position", "ADBE Position", 2],
        ["rotation", "ADBE Rotate Z", 1],
        ["scale", "ADBE Scale", 2],
        ["anchor", "ADBE Anchor Point", 2]
      ];
      var any = false;
      for (var d = 0; d < defs.length; d++) {
        var key = defs[d][0];
        if (vals[key] === undefined || vals[key] === null) continue;
        if (w.target === "position" && key !== "position") fail("bad_args", what + ": target 'position' writes position only");
        checkSeries(vals[key], n, defs[d][2], what + " " + key);
        p = child(tg, defs[d][1]);
        if (!p) fail("not_found", what + " has no " + defs[d][1]);
        if (defs[d][1] === "ADBE Position" && separatedDims(p)) fail("bad_args", what + " has separated Position dimensions; join them (Separate Dimensions off) before writing Position keys.");
        checkWritable(p, replace, what + " " + p.name);
        checkLimits(p, vals[key], defs[d][2], what + " " + p.name);
        plan.props.push({ key: key, matchName: defs[d][1], width: defs[d][2] });
        any = true;
      }
      if (!any) fail("bad_args", what + ": no position, rotation, scale or anchor values given");
    } else {
      fail("bad_args", "Unknown write target \"" + w.target + "\"");
    }
    return plan;
  }

  // Property values for setValuesAtTimes. A 2D layer's Position and Scale
  // may read as [x, y, z] (measured on AE 26): a short value is padded with
  // the property's current z so either shape of property accepts it.
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
      // Pin points are 2D and read as two numbers; a layer's Position and Scale may be 3-vectors.
      if (isArr(cur) && cur.length === 3) v.push(cur[2]);
      out.push(v);
    }
    return out;
  }

  function tangentZero(prop) {
    var n = 2;
    try {
      var v = prop.valueAtTime(0, false);
      if (isArr(v) && v.length === 3) n = 3;
    } catch (e) {
      n = 2;
    }
    var z = [0, 0];
    if (n === 3) z.push(0);
    return z;
  }

  function writeSeries(prop, times, values, width, replace) {
    var k;
    if (replace) {
      for (k = prop.numKeys; k >= 1; k--) prop.removeKey(k);
    }
    prop.setValuesAtTimes(times, shaped(prop, values, width));
    var lin = KeyframeInterpolationType.LINEAR;
    var spatial = false;
    try {
      spatial = prop.isSpatial === true;
    } catch (eSp) {
      spatial = false;
    }
    for (k = 1; k <= prop.numKeys; k++) {
      prop.setInterpolationTypeAtKey(k, lin, lin);
      // A spatial property (Position, the pin points) also has a path between keys: zero tangents make it straight.
      if (spatial) {
        try {
          prop.setSpatialAutoBezierAtKey(k, false);
          prop.setSpatialContinuousAtKey(k, false);
          prop.setSpatialTangentsAtKey(k, tangentZero(prop), tangentZero(prop));
        } catch (eTan) {}
      }
    }
    return prop.numKeys;
  }

  // The writing half: assumes planWrite passed. Opens no undo group.
  function performWrite(comp, plan) {
    var w = plan.w;
    var layer = plan.layer;
    var result = { layer_index: layer.index, layer_id: layer.id, target: w.target, props: [] };
    var tg = layer.property("ADBE Transform Group");
    var i;
    if (plan.kind) {
      var kind = plan.kind;
      var fx = null;
      var effectIndex = null;
      var moved = false;
      if (plan.addEffect) {
        var effects = layer.property("ADBE Effect Parade");
        var added = effects.addProperty(PIN_KINDS[kind].matchName);
        var idx = added.propertyIndex;
        var slot = A.planarEffectSlot({ comp_id: comp.id, layer_index: layer.index, layer_id: layer.id, category: "pin", new_index: idx });
        if (slot !== idx && typeof added.moveTo === "function") {
          added.moveTo(slot);
          idx = slot;
          moved = true;
        }
        // Look the effect up again: references go stale after addProperty and moveTo.
        fx = layer.property("ADBE Effect Parade").property(idx);
        if (!fx || fx.matchName !== PIN_KINDS[kind].matchName) {
          fx = findPinEffect(layer, kind, null);
        }
        effectIndex = fx.propertyIndex;
        result.effect_added = true;
        result.slot_moved = moved;
        result.slot_wanted = slot;
        // A new effect's point limits cannot be checked before it exists.
        result.limits_unverified = true;
      } else {
        fx = findPinEffect(layer, kind, w.effect_index);
        effectIndex = fx.propertyIndex;
        result.effect_added = false;
      }
      var params = pinParams(fx, kind);
      result.effect_index = effectIndex;
      result.param_table = pinTable(params);
      for (i = 0; i < 4; i++) {
        var n = writeSeries(params[i].prop, w.times, w.values[params[i].role], 2, plan.replace);
        result.props.push({ role: params[i].role, name: params[i].name, numKeys: n });
      }
      return result;
    }
    for (i = 0; i < plan.props.length; i++) {
      var pd = plan.props[i];
      var prop = child(tg, pd.matchName);
      var cnt = writeSeries(prop, w.times, w.values[pd.key], pd.width, plan.replace);
      result.props.push({ role: pd.key, name: prop.name, numKeys: cnt });
    }
    return result;
  }

  function validateWrites(comp, writes, replaceAll) {
    if (!isArr(writes)) fail("bad_args", "writes must be an array");
    var plans = [];
    var seen = {};
    for (var i = 0; i < writes.length; i++) {
      var key = writes[i].layer_id + ":" + writes[i].target;
      if (seen[key] === true) fail("bad_args", "Two writes target the same layer and property group (" + key + ")");
      seen[key] = true;
      plans.push(planWrite(comp, writes[i], replaceAll));
    }
    return plans;
  }

  // args: { comp_id, writes: [{ layer_index, layer_id, target, effect_index?,
  // add_effect?, replace_keys?, times, values }] }. Validates all, then writes.
  // Opens NO undo group: the caller wraps it in A.withUndo.
  A.planarWriteRaw = function (args) {
    var comp = requireComp(args.comp_id);
    var plans = validateWrites(comp, args.writes, false);
    var written = [];
    for (var i = 0; i < plans.length; i++) written.push(performWrite(comp, plans[i]));
    return { written: written };
  };

  function planNull(comp, nl) {
    if (!nl || typeof nl.name !== "string" || nl.name.length < 1 || nl.name.length > 200) fail("bad_args", "A new null needs a name of 1 to 200 characters");
    checkTimes(nl.times, "Null \"" + nl.name + "\"");
    var n = nl.times.length;
    checkSeries(nl.position, n, 2, "Null \"" + nl.name + "\" position");
    if (nl.rotation !== undefined && nl.rotation !== null) checkSeries(nl.rotation, n, 1, "Null \"" + nl.name + "\" rotation");
    if (nl.scale !== undefined && nl.scale !== null) checkSeries(nl.scale, n, 2, "Null \"" + nl.name + "\" scale");
  }

  // args: { comp_id, writes: [...], new_nulls: [{ name, times, position,
  // rotation?, scale? }], replace_keys?, expect }. Guarded; one undo group.
  A.planarApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    requireSquarePixels(comp);
    var nulls = args.new_nulls;
    if (nulls === undefined || nulls === null) nulls = [];
    if (!isArr(nulls) || nulls.length > MAX_POINTS + 1) fail("bad_args", "At most " + (MAX_POINTS + 1) + " new nulls");
    var i;
    for (i = 0; i < nulls.length; i++) planNull(comp, nulls[i]);
    var writes = args.writes;
    if (writes === undefined || writes === null) writes = [];
    var plans = validateWrites(comp, writes, args.replace_keys === true);
    if (plans.length === 0 && nulls.length === 0) fail("bad_args", "Nothing to write");
    return A.withUndo("Chroma AE MCP: apply track", function () {
      var out = { nulls: [], written: [] };
      var lin = KeyframeInterpolationType.LINEAR;
      for (var a = 0; a < nulls.length; a++) {
        var nl = nulls[a];
        var layer = comp.layers.addNull(comp.duration);
        layer.name = nl.name;
        var tg = layer.property("ADBE Transform Group");
        var series = [
          ["position", "ADBE Position", 2],
          ["rotation", "ADBE Rotate Z", 1],
          ["scale", "ADBE Scale", 2]
        ];
        var made = { layer_id: layer.id, layer_index: layer.index, name: layer.name, props: [] };
        for (var s = 0; s < series.length; s++) {
          var vals = nl[series[s][0]];
          if (vals === undefined || vals === null) continue;
          var prop = child(tg, series[s][1]);
          var cnt = writeSeries(prop, nl.times, vals, series[s][2], false);
          made.props.push({ role: series[s][0], name: prop.name, numKeys: cnt });
        }
        out.nulls.push(made);
      }
      for (var b = 0; b < plans.length; b++) out.written.push(performWrite(comp, plans[b]));
      return out;
    });
  };

  // ---------- read-back ----------

  // args: { comp_id, items: [{ layer_id, kind: 'transform' | 'corner_pin' |
  // 'power_pin', effect_index?, times: [sample times] }] }. Key counts and
  // values at the sample times. Changes nothing.
  A.planarKeys = function (args) {
    var comp = requireComp(args.comp_id);
    var out = [];
    var items = args.items;
    if (!isArr(items)) fail("bad_args", "items must be an array");
    for (var i = 0; i < items.length && i < 50; i++) {
      var it = items[i];
      var layer = null;
      for (var li = 1; li <= comp.numLayers; li++) {
        if (comp.layer(li).id === it.layer_id) layer = comp.layer(li);
      }
      if (!layer) {
        out.push({ layer_id: it.layer_id, found: false, props: [] });
        continue;
      }
      var times = it.times;
      if (!isArr(times)) times = [];
      var entry = { layer_id: layer.id, layer_index: layer.index, found: true, props: [] };
      var list = [];
      var tg = layer.property("ADBE Transform Group");
      if (it.kind === "corner_pin" || it.kind === "power_pin") {
        var fx = findPinEffect(layer, it.kind, it.effect_index);
        if (fx) {
          var params = pinParams(fx, it.kind);
          entry.effect_index = fx.propertyIndex;
          for (var r = 0; r < 4; r++) list.push({ role: params[r].role, prop: params[r].prop });
        } else {
          entry.effect_found = false;
        }
      } else {
        var names = [["position", "ADBE Position"], ["rotation", "ADBE Rotate Z"], ["scale", "ADBE Scale"], ["anchor", "ADBE Anchor Point"]];
        for (var n = 0; n < names.length; n++) {
          var tp = child(tg, names[n][1]);
          if (tp) list.push({ role: names[n][0], prop: tp });
        }
      }
      for (var p = 0; p < list.length; p++) {
        var rec = { role: list[p].role, numKeys: list[p].prop.numKeys, samples: [] };
        for (var s = 0; s < times.length; s++) {
          rec.samples.push({ time: times[s], value: list[p].prop.valueAtTime(times[s], false) });
        }
        entry.props.push(rec);
      }
      out.push(entry);
    }
    var res = { items: out };
    if (items.length > 50) res.truncated = true;
    return res;
  };
})($.global);
