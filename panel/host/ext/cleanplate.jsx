// panel/host/ext/cleanplate.jsx
//
// Host functions for the clean-plate tools (ae_cleanplate_pick,
// ae_cleanplate_setup). Every name starts with "cleanplate" because other
// groups add functions to the same object.
//
// - cleanplateRead (read): comp, project depth, and the plate and holdout
//   layers (kind, locks, parent, time remap ability, which transform
//   properties are animated)
// - cleanplateBuild (guarded write, ONE undo group): the patch rig. A freeze
//   (duplicate + time remap with one hold key), a still (imported PNG) or a
//   clone (duplicate shifted in space and time) goes into a comp-size patch
//   precomp; the patch layer gets masks, track keys (A.planarWriteRaw from
//   planar.jsx, inside this group), sampling, motion blur and a holdout matte.
//   Everything is validated before the group opens; a failure inside the group
//   removes what the call made.
// - cleanplateInspect (read): what the build left, for the read-back
// - cleanplateReload (guarded, no undo step): FootageItem.mainSource.reload()
// - cleanplateFootage (read): a footage item's state, for the reload read-back
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Reads never change time, selection, solo, resolution or the active item.
// - Writes check the guard first, validate before A.withUndo, and open and
//   close the undo group in the same call.
// - Do not call other groups' guarded host functions from the write (they
//   open their own undo groups); planarWriteRaw opens none.
// - Properties are looked up again after addProperty (stale references).

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_REGIONS = 16;
  var MAX_VERTS = 200;
  var MAX_KEYS = 3000;

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

  function xy(v) {
    return [Number(v[0]), Number(v[1])];
  }

  // ---------- layer description ----------

  function layerKind(l) {
    var reflectName = "";
    try {
      if (l.reflect && l.reflect.name) reflectName = String(l.reflect.name);
    } catch (e0) {}
    if (reflectName === "TextLayer") return "text";
    if (reflectName === "ShapeLayer") return "shape";
    if (reflectName === "CameraLayer") return "camera";
    if (reflectName === "LightLayer") return "light";
    try {
      if (l.nullLayer) return "null";
    } catch (e1) {}
    try {
      if (l.source && l.source instanceof CompItem) return "precomp";
    } catch (e2) {}
    try {
      if (l.source && l.source.mainSource && l.source.mainSource instanceof SolidSource) return "solid";
    } catch (e3) {}
    return "footage";
  }

  var TRANSFORM_PROPS = [
    ["anchor", "ADBE Anchor Point"],
    ["position", "ADBE Position"],
    ["scale", "ADBE Scale"],
    ["rotation", "ADBE Rotate Z"]
  ];

  function isAnimated(p) {
    if (!p) return false;
    try {
      return p.numKeys > 0 || p.expressionEnabled === true;
    } catch (e) {
      return false;
    }
  }

  // True when Position has its dimensions separated (X and Y Position).
  function positionSeparated(layer) {
    var tg = layer.property("ADBE Transform Group");
    var pp = tg ? child(tg, "ADBE Position") : null;
    if (!pp) return false;
    try {
      return pp.dimensionsSeparated === true;
    } catch (e) {
      return false;
    }
  }

  function animatedProps(layer) {
    var out = [];
    var tg = layer.property("ADBE Transform Group");
    if (!tg) return out;
    for (var i = 0; i < TRANSFORM_PROPS.length; i++) {
      var p = child(tg, TRANSFORM_PROPS[i][1]);
      if (!p) continue;
      var anim = isAnimated(p);
      // With separated dimensions the keys and expressions live on X and Y Position.
      if (!anim && TRANSFORM_PROPS[i][1] === "ADBE Position" && positionSeparated(layer)) {
        anim = isAnimated(child(tg, "ADBE Position_0")) || isAnimated(child(tg, "ADBE Position_1"));
      }
      if (anim) out.push(TRANSFORM_PROPS[i][0]);
    }
    return out;
  }

  // Names of the effects on the layer that have a keyed or expression-driven parameter (bounded).
  function animatedEffects(layer) {
    var out = [];
    var fxs = null;
    try {
      fxs = layer.property("ADBE Effect Parade");
    } catch (e0) {
      fxs = null;
    }
    if (!fxs) return out;
    var budget = { left: 2000 };
    var n = 0;
    try {
      n = fxs.numProperties;
    } catch (e1) {
      n = 0;
    }
    for (var i = 1; i <= n && out.length < 20; i++) {
      var fx = fxs.property(i);
      if (fx && groupHasAnimation(fx, budget)) out.push(String(fx.name));
    }
    return out;
  }

  function groupHasAnimation(g, budget) {
    var n = 0;
    try {
      n = g.numProperties;
    } catch (e0) {
      n = 0;
    }
    for (var i = 1; i <= n; i++) {
      if (budget.left <= 0) return false;
      budget.left--;
      var p = null;
      try {
        p = g.property(i);
      } catch (e1) {
        p = null;
      }
      if (!p) continue;
      var isProp = false;
      try {
        isProp = p.propertyType === PropertyType.PROPERTY;
      } catch (e2) {
        isProp = false;
      }
      if (isProp) {
        if (isAnimated(p)) return true;
      } else if (groupHasAnimation(p, budget)) {
        return true;
      }
    }
    return false;
  }

  function layerInfo(l, t) {
    var parentId = null;
    try {
      if (l.parent) parentId = l.parent.id;
    } catch (e0) {}
    var srcId = null;
    var isStill = false;
    try {
      if (l.source) {
        srcId = l.source.id;
        if (l.source.mainSource && l.source.mainSource.isStill === true) isStill = true;
      }
    } catch (e1) {}
    var canRemap = null;
    try {
      if (l.canSetTimeRemapEnabled !== undefined) canRemap = l.canSetTimeRemapEnabled === true;
    } catch (e2) {}
    var remapOn = false;
    try {
      remapOn = l.timeRemapEnabled === true;
    } catch (e3) {}
    var modern = false;
    try {
      modern = typeof l.setTrackMatte === "function";
    } catch (e4) {}
    var hasVideo = true;
    try {
      if (l.hasVideo === false) hasVideo = false;
    } catch (e5) {}
    var w = 0;
    var h = 0;
    try {
      w = l.width;
      h = l.height;
    } catch (e6) {}
    var separated = false;
    var pos = [0, 0];
    var tg = l.property("ADBE Transform Group");
    var pp = child(tg, "ADBE Position");
    if (pp) {
      try {
        separated = pp.dimensionsSeparated === true;
      } catch (e7) {}
      try {
        pos = xy(pp.valueAtTime(t, false));
      } catch (e8) {}
    }
    var opAnimated = false;
    try {
      opAnimated = isAnimated(child(tg, "ADBE Opacity"));
    } catch (e9) {}
    var fxAnimated = [];
    try {
      fxAnimated = animatedEffects(l);
    } catch (e10) {}
    return {
      index: l.index,
      id: l.id,
      name: l.name,
      kind: layerKind(l),
      locked: l.locked === true,
      three_d: isThreeD(l),
      has_video: hasVideo,
      enabled: l.enabled === true,
      parent_id: parentId,
      start_time: l.startTime,
      stretch: l.stretch,
      in_point: l.inPoint,
      out_point: l.outPoint,
      width: w,
      height: h,
      source_id: srcId,
      source_is_still: isStill,
      can_time_remap: canRemap,
      time_remap_enabled: remapOn,
      modern_matte_api: modern,
      transform_animated: animatedProps(l),
      opacity_animated: opAnimated,
      effects_animated: fxAnimated,
      position_separated: separated,
      position: pos
    };
  }

  // args: { comp_id, plate?: selector, holdout?: selector, ref_time? }. Changes nothing.
  A.cleanplateRead = function (args) {
    var comp = requireComp(args.comp_id);
    var t = 0;
    if (isNum(args.ref_time)) t = args.ref_time;
    var rf = null;
    try {
      rf = comp.resolutionFactor;
    } catch (e0) {}
    var mb = null;
    try {
      mb = comp.motionBlur === true;
    } catch (e1) {}
    var bpc = null;
    try {
      bpc = app.project.bitsPerChannel;
    } catch (e2) {}
    var lin = null;
    try {
      lin = app.project.linearBlending === true;
    } catch (e3) {}
    var projectPath = "<unsaved>";
    try {
      if (app.project.file) projectPath = String(app.project.file.fsName);
    } catch (e4) {}
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
        work_area_start: comp.workAreaStart,
        work_area_duration: comp.workAreaDuration,
        motion_blur: mb,
        resolution_factor: null
      },
      project: { path: projectPath, bits_per_channel: bpc, linear_blending: lin },
      plate: null,
      holdout: null,
      num_layers: comp.numLayers
    };
    if (rf && typeof rf.length === "number") out.comp.resolution_factor = [Number(rf[0]), Number(rf[1])];
    if (args.plate) out.plate = layerInfo(findLayer(comp, args.plate), t);
    if (args.holdout) out.holdout = layerInfo(findLayer(comp, args.holdout), t);
    return out;
  };

  // ---------- matrices (to see whether a precomp layer is the identity) ----------

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

  function transformOf(layer, t) {
    var tg = layer.property("ADBE Transform Group");
    return {
      anchor: xy(child(tg, "ADBE Anchor Point").valueAtTime(t, false)),
      position: xy(child(tg, "ADBE Position").valueAtTime(t, false)),
      scale: xy(child(tg, "ADBE Scale").valueAtTime(t, false)),
      rotation: Number(child(tg, "ADBE Rotate Z").valueAtTime(t, false))
    };
  }

  // The matrix is the identity AND anchor and position sit at the comp centre: the server's
  // track keys are written about the centre, so an identity layer with anchor [0, 0] is not enough.
  function nearIdentity(layer, t, comp) {
    var tr = transformOf(layer, t);
    var m = layerM(tr);
    var cx = comp.width / 2;
    var cy = comp.height / 2;
    return (
      Math.abs(m[0] - 1) < 0.001 &&
      Math.abs(m[4] - 1) < 0.001 &&
      Math.abs(m[1]) < 0.001 &&
      Math.abs(m[3]) < 0.001 &&
      Math.abs(m[2]) < 0.5 &&
      Math.abs(m[5]) < 0.5 &&
      Math.abs(tr.anchor[0] - cx) < 0.5 &&
      Math.abs(tr.anchor[1] - cy) < 0.5 &&
      Math.abs(tr.position[0] - cx) < 0.5 &&
      Math.abs(tr.position[1] - cy) < 0.5
    );
  }

  // ---------- validation ----------

  function checkShape(s, what) {
    if (!s || !isArr(s.vertices) || !isArr(s.inTangents) || !isArr(s.outTangents)) fail("bad_args", what + ": a shape needs vertices, inTangents and outTangents");
    var n = s.vertices.length;
    if (n < 3 || n > MAX_VERTS) fail("bad_args", what + ": a shape needs 3 to " + MAX_VERTS + " vertices");
    if (s.inTangents.length !== n || s.outTangents.length !== n) fail("bad_args", what + ": the tangent lists must be as long as the vertices");
    for (var i = 0; i < n; i++) {
      var trio = [s.vertices[i], s.inTangents[i], s.outTangents[i]];
      for (var k = 0; k < 3; k++) {
        if (!isArr(trio[k]) || trio[k].length < 2 || !isNum(trio[k][0]) || !isNum(trio[k][1])) fail("bad_args", what + ": point " + i + " is not [x, y]");
      }
    }
  }

  function checkTimes(times, what) {
    if (!isArr(times) || times.length < 1 || times.length > MAX_KEYS) fail("bad_args", what + ": times must be a list of 1 to " + MAX_KEYS + " numbers");
    for (var i = 0; i < times.length; i++) {
      if (!isNum(times[i]) || times[i] < 0) fail("bad_args", what + ": time " + i + " is not a number of seconds");
      if (i > 0 && !(times[i] > times[i - 1])) fail("bad_args", what + ": times must ascend");
    }
  }

  function makeShape(s) {
    var shape = new Shape();
    shape.vertices = s.vertices;
    shape.inTangents = s.inTangents;
    shape.outTangents = s.outTangents;
    shape.closed = true;
    return shape;
  }

  // ---------- pieces of the build ----------

  // The plate's own animated transform (and any expression) replaced by its value at t.
  function bakeTransformAt(layer, t) {
    var tg = layer.property("ADBE Transform Group");
    for (var i = 0; i < TRANSFORM_PROPS.length; i++) {
      var p = child(tg, TRANSFORM_PROPS[i][1]);
      if (!p) continue;
      var anim = false;
      try {
        anim = p.numKeys > 0 || p.expressionEnabled === true;
      } catch (e) {
        anim = false;
      }
      if (!anim) continue;
      var v = p.valueAtTime(t, false);
      for (var k = p.numKeys; k >= 1; k--) p.removeKey(k);
      try {
        if (p.expressionEnabled === true) p.expressionEnabled = false;
      } catch (eEx) {}
      p.setValue(v);
    }
  }

  // A keyed or expression-driven property replaced by its value at t (the caller has checked it is animated).
  function bakeProp(p, t) {
    var v = p.valueAtTime(t, false);
    for (var k = p.numKeys; k >= 1; k--) p.removeKey(k);
    try {
      if (p.expressionEnabled === true) p.expressionEnabled = false;
    } catch (eEx) {}
    p.setValue(v);
  }

  // Every keyed or expression-driven parameter of the layer's effects (Corner Pin, CC Power Pin,
  // Transform ...) replaced by its value at t: a freeze must not keep warping per frame.
  // acc: { baked: n, failed: [names], left: n }.
  function bakeGroupAt(g, t, acc) {
    var n = 0;
    try {
      n = g.numProperties;
    } catch (e0) {
      n = 0;
    }
    for (var i = 1; i <= n; i++) {
      if (acc.left <= 0) return;
      acc.left--;
      var p = null;
      try {
        p = g.property(i);
      } catch (e1) {
        p = null;
      }
      if (!p) continue;
      var isProp = false;
      try {
        isProp = p.propertyType === PropertyType.PROPERTY;
      } catch (e2) {
        isProp = false;
      }
      if (!isProp) {
        bakeGroupAt(p, t, acc);
        continue;
      }
      if (!isAnimated(p)) continue;
      try {
        bakeProp(p, t);
        acc.baked++;
      } catch (e3) {
        acc.failed.push(String(p.name));
      }
    }
  }

  function bakeEffectsAt(layer, t) {
    var acc = { baked: 0, failed: [], left: 3000 };
    var fxs = null;
    try {
      fxs = layer.property("ADBE Effect Parade");
    } catch (e0) {
      fxs = null;
    }
    if (fxs) bakeGroupAt(fxs, t, acc);
    return acc;
  }

  // The stabilize rig's opacity switch ("Show Stabilized Plate" checkbox) must not survive on a patch copy.
  function opacityIsSwitch(p) {
    try {
      return p.expressionEnabled === true && String(p.expression).indexOf("Show Stabilized Plate") >= 0;
    } catch (e) {
      return false;
    }
  }

  // Opacity of a plate copy. The rig's switch expression becomes a plain 100. For a freeze any
  // other keys or expression become the value at t; a clone keeps its own keys (it is live).
  // Returns a note, or null when nothing changed.
  function neutraliseOpacity(layer, t, freeze) {
    var tg = layer.property("ADBE Transform Group");
    var op = child(tg, "ADBE Opacity");
    if (!op || !isAnimated(op)) return null;
    var sw = opacityIsSwitch(op);
    if (!sw && !freeze) return null;
    var v = sw ? 100 : Number(op.valueAtTime(t, false));
    var hadKeys = op.numKeys > 0;
    for (var k = op.numKeys; k >= 1; k--) op.removeKey(k);
    try {
      if (op.expressionEnabled === true) op.expressionEnabled = false;
    } catch (eEx) {}
    op.setValue(v);
    if (sw) return "The plate copy's Opacity was driven by the stabilize rig's 'Show Stabilized Plate' switch; it is now a plain 100" + (hadKeys ? " (its keys were removed)" : "") + ", so the patch shows in the final render.";
    return "The plate copy's animated Opacity was replaced by its value at ref_time (" + Math.round(v * 100) / 100 + ").";
  }

  // Layer > Time > Freeze Frame, through the DOM: time remap with one hold key
  // at the source time that ref_time shows. Returns false when the layer is a
  // still (nothing to freeze).
  function freezeLayer(layer, refTime) {
    var canSet = layer.canSetTimeRemapEnabled;
    if (canSet === false) return false;
    layer.timeRemapEnabled = true;
    var trm = layer.property("ADBE Time Remapping");
    if (!trm) fail("not_found", "Layer \"" + layer.name + "\" has no Time Remap after enabling it");
    var srcT = Number(trm.valueAtTime(refTime, false));
    trm.setValueAtTime(refTime, srcT);
    var keepIdx = trm.nearestKeyIndex(refTime);
    var keepTime = trm.keyTime(keepIdx);
    for (var k = trm.numKeys; k >= 1; k--) {
      if (trm.numKeys > 1 && Math.abs(trm.keyTime(k) - keepTime) > 0.000001) trm.removeKey(k);
    }
    trm.setInterpolationTypeAtKey(1, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
    try {
      if (typeof FrameBlendingType !== "undefined") layer.frameBlendingType = FrameBlendingType.NO_FRAME_BLEND;
    } catch (eFb) {}
    return true;
  }

  function removeMade(made) {
    try {
      if (made.patchLayer) made.patchLayer.remove();
    } catch (e1) {}
    try {
      if (made.patchComp) made.patchComp.remove();
    } catch (e2) {}
    try {
      if (made.srcLayer && !made.patchComp) made.srcLayer.remove();
    } catch (e3) {}
    try {
      if (made.imported) made.imported.remove();
    } catch (e4) {}
  }

  function maskModeName(m) {
    if (m === MaskMode.ADD) return "add";
    if (m === MaskMode.SUBTRACT) return "subtract";
    if (m === MaskMode.INTERSECT) return "intersect";
    if (m === MaskMode.LIGHTEN) return "lighten";
    if (m === MaskMode.DARKEN) return "darken";
    if (m === MaskMode.DIFFERENCE) return "difference";
    if (m === MaskMode.NONE) return "none";
    return String(m);
  }

  function matteName(t) {
    if (t === TrackMatteType.ALPHA) return "alpha";
    if (t === TrackMatteType.ALPHA_INVERTED) return "alpha_inverted";
    if (t === TrackMatteType.LUMA) return "luma";
    if (t === TrackMatteType.LUMA_INVERTED) return "luma_inverted";
    if (t === TrackMatteType.NO_TRACK_MATTE) return "none";
    return String(t);
  }

  // args: { comp_id, plate_index, plate_id, source, ref_time, name,
  // still_path?, still_footage_id?, regions: [{ shape, keys: { times, shapes }
  // | null }], feather, expansion, writes: [{ target, times, values,
  // add_effect?, replace_keys? }], clone: { frames, static_shift, position:
  // { times, shifts } } | null, holdout: { id } | null, hide_holdout,
  // motion_blur, label, expect }. Guarded; one undo group.
  A.cleanplateBuild = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var source = args.source;
    var i;
    var pa = Number(comp.pixelAspect);
    if (pa > 0 && Math.abs(pa - 1) > 0.000001) fail("bad_args", "The comp's pixel aspect is " + pa + ", not 1.");
    if (source !== "freeze" && source !== "still" && source !== "clone_offset") fail("bad_args", "Unknown source \"" + source + "\"");
    if (!isNum(args.ref_time) || args.ref_time < 0) fail("bad_args", "ref_time must be a number of seconds");
    var refTime = args.ref_time;
    var plate = layerByIndexId(comp, args.plate_index, args.plate_id);
    var what = "Plate \"" + plate.name + "\"";
    if (plate.locked === true) fail("bad_args", what + " is locked");
    if (isThreeD(plate)) fail("bad_args", what + " is a 3D layer; the patch tools work in 2D only");
    if (source !== "still" && plate.parent) fail("bad_args", what + " has a parent; use source 'still'");
    if (source !== "still" && positionSeparated(plate)) fail("bad_args", what + " has separated Position dimensions (X and Y Position); join them first, or use source 'still'");
    var name = args.name;
    if (typeof name !== "string" || name.length < 1 || name.length > 200) fail("bad_args", "name must be 1 to 200 characters");
    var regions = args.regions;
    if (!isArr(regions) || regions.length < 1 || regions.length > MAX_REGIONS) fail("bad_args", "regions must hold 1 to " + MAX_REGIONS + " shapes");
    for (i = 0; i < regions.length; i++) {
      checkShape(regions[i].shape, "regions[" + i + "]");
      if (regions[i].keys) {
        checkTimes(regions[i].keys.times, "regions[" + i + "] mask keys");
        if (!isArr(regions[i].keys.shapes) || regions[i].keys.shapes.length !== regions[i].keys.times.length) fail("bad_args", "regions[" + i + "]: mask key shapes must match the times");
        for (var ks = 0; ks < regions[i].keys.shapes.length; ks++) checkShape(regions[i].keys.shapes[ks], "regions[" + i + "] key " + ks);
      }
    }
    if (!isNum(args.feather) || args.feather < 0 || args.feather > 500) fail("bad_args", "feather must be 0 to 500 px");
    if (!isNum(args.expansion) || args.expansion < 0 || args.expansion > 500) fail("bad_args", "expansion must be 0 to 500 px");
    if (args.expansion + 0.000001 < args.feather / 2) fail("bad_args", "expansion must be at least half the feather, or the object's edge shows through");
    var writes = args.writes;
    if (writes === undefined || writes === null) writes = [];
    if (!isArr(writes)) fail("bad_args", "writes must be an array");
    if (writes.length > 0 && typeof A.planarWriteRaw !== "function") fail("not_found", "planar.jsx is not loaded, so the track cannot be written");
    for (i = 0; i < writes.length; i++) checkTimes(writes[i].times, "write " + i);
    var clone = args.clone;
    if (source === "clone_offset") {
      if (!clone) fail("bad_args", "clone_offset needs the clone description");
      if (!isNum(clone.frames)) fail("bad_args", "clone.frames must be a number");
      if (clone.position) {
        checkTimes(clone.position.times, "clone position");
        if (!isArr(clone.position.shifts) || clone.position.shifts.length !== clone.position.times.length) fail("bad_args", "clone shifts must match the times");
        if (clone.position.times.length > 0 && typeof A.planarWriteRaw !== "function") fail("not_found", "planar.jsx is not loaded, so the clone cannot be keyed");
      } else if (!isArr(clone.static_shift) || clone.static_shift.length !== 2) {
        fail("bad_args", "clone needs a track-compensated position or a static_shift");
      }
    }
    var stillItem = null;
    if (source === "still") {
      if (args.still_footage_id !== undefined && args.still_footage_id !== null) {
        try {
          stillItem = app.project.itemByID(args.still_footage_id);
        } catch (eSi) {
          stillItem = null;
        }
        if (!stillItem || !(stillItem instanceof FootageItem)) fail("not_found", "No footage item with id " + args.still_footage_id);
        if (stillItem.width !== comp.width || stillItem.height !== comp.height) fail("bad_args", "The still is " + stillItem.width + "x" + stillItem.height + " and the comp is " + comp.width + "x" + comp.height + "; the patch comp is comp-sized, so they must match");
      } else {
        if (typeof args.still_path !== "string" || args.still_path.length < 1) fail("bad_args", "source still needs still_path or still_footage_id");
        var f = new File(args.still_path);
        if (!f.exists) fail("not_found", "The still file does not exist: " + args.still_path);
      }
    }
    if (source === "freeze" && plate.canSetTimeRemapEnabled === false) {
      var stillPlate = false;
      try {
        stillPlate = plate.source && plate.source.mainSource && plate.source.mainSource.isStill === true;
      } catch (ePs) {}
      if (!stillPlate) fail("bad_args", what + " cannot be time-remapped; use source 'still'");
    }
    var holdoutLayer = null;
    if (args.holdout) {
      holdoutLayer = layerById(comp, args.holdout.id);
      if (!holdoutLayer) fail("not_found", "No holdout layer with id " + args.holdout.id);
      if (holdoutLayer.id === plate.id) fail("bad_args", "The holdout cannot be the plate");
      if (typeof plate.setTrackMatte !== "function") fail("bad_args", "Layer-based track mattes need AE 23 or later");
      var hk = layerKind(holdoutLayer);
      if (hk === "camera" || hk === "light") fail("bad_args", "A " + hk + " layer cannot be a track matte");
      // Checked here, before the undo group: switching a locked layer's video off would fail mid-build.
      if (holdoutLayer.locked === true) fail("bad_args", "The holdout layer \"" + holdoutLayer.name + "\" is locked; unlock it first");
      // An audio-only layer cannot be a matte and has no video to switch off.
      var holdVideo = true;
      try {
        if (holdoutLayer.hasVideo === false) holdVideo = false;
      } catch (eHv) {}
      if (!holdVideo) fail("bad_args", "The holdout layer \"" + holdoutLayer.name + "\" has no video, so it cannot be a track matte");
    }
    var trim = args.trim;
    if (trim !== undefined && trim !== null) {
      if (!isNum(trim.start) || !isNum(trim.end) || trim.start < 0 || !(trim.end > trim.start)) fail("bad_args", "trim needs start and end in seconds, end after start");
    } else {
      trim = null;
    }

    return A.withUndo(args.label || "Clean plate patch", function () {
      var made = { srcLayer: null, patchComp: null, patchLayer: null, imported: null };
      var notes = [];
      var out = {};
      try {
        // 1. The source layer, directly above the plate.
        var src = null;
        if (source === "still") {
          var item = stillItem;
          if (!item) {
            item = app.project.importFile(new ImportOptions(new File(args.still_path)));
            made.imported = item;
            out.imported_item = { id: item.id, name: item.name };
          }
          src = comp.layers.add(item, comp.duration);
          made.srcLayer = src;
          src.moveBefore(plate);
          src.name = plate.name + " (still)";
        } else {
          src = plate.duplicate();
          made.srcLayer = src;
          src.name = plate.name + (source === "freeze" ? " (frozen)" : " (clone)");
          try {
            src.guideLayer = false;
          } catch (eGl) {}
          try {
            src.enabled = true;
          } catch (eEn) {}
        }
        // 2. Freeze, or the clone's shift.
        if (source === "freeze") {
          bakeTransformAt(src, refTime);
          var fxb = bakeEffectsAt(src, refTime);
          if (fxb.baked > 0) notes.push(fxb.baked + " keyed or expression-driven effect parameter(s) on the plate copy (Corner Pin, Transform ...) were replaced by their value at ref_time, so the frozen frame does not keep moving.");
          if (fxb.failed.length > 0) notes.push("These effect parameters could not be fixed at ref_time and may still animate: " + fxb.failed.slice(0, 10).join(", ") + ".");
          var opn = neutraliseOpacity(src, refTime, true);
          if (opn) notes.push(opn);
          var froze = freezeLayer(src, refTime);
          out.freeze_skipped = froze === false;
          if (froze === false) notes.push("The plate is a still image, so there was nothing to freeze: the duplicate is the freeze.");
        } else if (source === "clone_offset") {
          var opc = neutraliseOpacity(src, refTime, false);
          if (opc) notes.push(opc);
          if (clone.frames !== 0) {
            var ip = src.inPoint;
            var op = src.outPoint;
            src.startTime = src.startTime - clone.frames * comp.frameDuration;
            try {
              src.inPoint = ip;
              src.outPoint = op;
            } catch (eTrim) {
              notes.push("The clone's in and out points could not be restored after the time shift; check its length.");
            }
          }
          if (clone.position) {
            var base = xy(child(src.property("ADBE Transform Group"), "ADBE Position").valueAtTime(refTime, false));
            var vals = [];
            for (i = 0; i < clone.position.shifts.length; i++) vals.push([base[0] + clone.position.shifts[i][0], base[1] + clone.position.shifts[i][1]]);
            A.planarWriteRaw({ comp_id: comp.id, writes: [{ layer_index: src.index, layer_id: src.id, target: "position", replace_keys: true, times: clone.position.times, values: { position: vals } }] });
          } else {
            var pp = child(src.property("ADBE Transform Group"), "ADBE Position");
            var cur = pp.value;
            var moved = [cur[0] + clone.static_shift[0], cur[1] + clone.static_shift[1]];
            if (cur.length > 2) moved.push(cur[2]);
            pp.setValue(moved);
          }
        }
        // 3. The patch precomp, comp-sized.
        var pcomp = comp.layers.precompose([src.index], name, true);
        made.patchComp = pcomp;
        if (pcomp.width !== comp.width || pcomp.height !== comp.height) fail("bad_args", "The patch comp came out " + pcomp.width + "x" + pcomp.height + ", not comp-sized; nothing was kept");
        var patch = null;
        for (i = 1; i <= comp.numLayers; i++) {
          var cl = comp.layer(i);
          var csrc = null;
          try {
            csrc = cl.source;
          } catch (eCs) {}
          if (csrc && csrc.id === pcomp.id) patch = cl;
        }
        if (!patch) fail("not_found", "The patch layer was not found after precomposing");
        made.patchLayer = patch;
        // The server's keys assume the patch layer is the identity in comp space.
        if (!nearIdentity(patch, refTime, comp)) {
          var ptg = patch.property("ADBE Transform Group");
          var centre = [comp.width / 2, comp.height / 2];
          var cprops = [["ADBE Anchor Point", centre], ["ADBE Position", centre], ["ADBE Scale", [100, 100]], ["ADBE Rotate Z", 0]];
          for (var cp = 0; cp < cprops.length; cp++) {
            var tp = child(ptg, cprops[cp][0]);
            var cv = cprops[cp][1];
            var now = tp.value;
            if (isArr(now) && now.length > 2 && isArr(cv)) cv = [cv[0], cv[1], now[2]];
            if (tp.numKeys === 0) tp.setValue(cv);
          }
          notes.push("The patch layer was not centred after precomposing; its anchor, position, scale and rotation were reset so the patch comp lines up with the comp.");
        }
        // 4. Masks, one per region; each looked up again after addProperty.
        var masks = patch.property("ADBE Mask Parade");
        for (i = 0; i < regions.length; i++) {
          var added = masks.addProperty("ADBE Mask Atom");
          var midx = masks.numProperties;
          try {
            if (typeof added.propertyIndex === "number") midx = added.propertyIndex;
          } catch (ePi) {}
          var m = masks.property(midx);
          m.property("ADBE Mask Shape").setValue(makeShape(regions[i].shape));
          m = masks.property(midx);
          m.maskMode = MaskMode.ADD;
          m.property("ADBE Mask Feather").setValue([args.feather, args.feather]);
          m.property("ADBE Mask Offset").setValue(args.expansion);
          try {
            m.name = "Patch " + (i + 1);
          } catch (eNm) {}
          if (regions[i].keys) {
            var shapes = [];
            for (var sk = 0; sk < regions[i].keys.shapes.length; sk++) shapes.push(makeShape(regions[i].keys.shapes[sk]));
            var sp = masks.property(midx).property("ADBE Mask Shape");
            sp.setValuesAtTimes(regions[i].keys.times, shapes);
            for (var ik = 1; ik <= sp.numKeys; ik++) sp.setInterpolationTypeAtKey(ik, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
          }
        }
        out.masks = regions.length;
        // 5. Track keys on the patch layer (planar.jsx opens no undo group of its own here).
        if (writes.length > 0) {
          var planned = [];
          for (i = 0; i < writes.length; i++) {
            var w = writes[i];
            planned.push({ layer_index: patch.index, layer_id: patch.id, target: w.target, add_effect: w.add_effect === true, replace_keys: w.replace_keys === true, times: w.times, values: w.values });
          }
          out.written = A.planarWriteRaw({ comp_id: comp.id, writes: planned }).written;
        }
        // The patch layer lives only where the track holds: outside, AE would hold the last key.
        if (trim) {
          try {
            var tin = Math.max(Number(patch.inPoint), trim.start);
            var tout = Math.min(Number(patch.outPoint), trim.end);
            if (tout > tin) {
              patch.outPoint = tout;
              patch.inPoint = tin;
              out.trimmed = { in_point: patch.inPoint, out_point: patch.outPoint };
            } else {
              notes.push("The patch layer could not be trimmed to the tracked span (it does not overlap the layer).");
            }
          } catch (eTrimP) {
            notes.push("The patch layer could not be trimmed to the tracked span; trim its in and out points to where the track holds.");
          }
        }
        // 6. Sampling, motion blur, holdout.
        try {
          if (typeof LayerSamplingQuality !== "undefined") patch.samplingQuality = LayerSamplingQuality.BICUBIC;
        } catch (eSq) {}
        if (args.motion_blur === true) {
          try {
            patch.motionBlur = true;
          } catch (eMb) {}
        }
        if (holdoutLayer) {
          patch.setTrackMatte(holdoutLayer, TrackMatteType.ALPHA_INVERTED);
          var hidden = false;
          if (args.hide_holdout !== false) {
            holdoutLayer.enabled = false;
            hidden = true;
          }
          out.holdout = { id: holdoutLayer.id, name: holdoutLayer.name, hidden: hidden };
        }
        out.patch_layer = { index: patch.index, id: patch.id, name: patch.name };
        out.patch_comp = { id: pcomp.id, name: pcomp.name, width: pcomp.width, height: pcomp.height };
        out.source = source;
        out.notes = notes;
        return out;
      } catch (e) {
        // Take back what this call made, in this same undo group.
        removeMade(made);
        throw e;
      }
    });
  };

  // ---------- read-back ----------

  // args: { comp_id, plate_id, patch_layer_id, patch_comp_id, holdout_id? }. Changes nothing.
  A.cleanplateInspect = function (args) {
    var comp = requireComp(args.comp_id);
    var out = { num_layers: comp.numLayers, plate: null, patch: null, inner: null, holdout: null };
    var plate = layerById(comp, args.plate_id);
    if (plate) out.plate = { index: plate.index, id: plate.id, enabled: plate.enabled === true };
    if (args.holdout_id !== undefined && args.holdout_id !== null) {
      var ho = layerById(comp, args.holdout_id);
      if (ho) out.holdout = { id: ho.id, enabled: ho.enabled === true };
    }
    var patch = null;
    if (args.patch_layer_id !== undefined && args.patch_layer_id !== null) patch = layerById(comp, args.patch_layer_id);
    if (!patch) {
      out.patch = { found: false };
    } else {
      var p = { found: true, index: patch.index, id: patch.id, name: patch.name, enabled: patch.enabled === true, in_point: Number(patch.inPoint), out_point: Number(patch.outPoint), source_id: null, sampling_quality: null, motion_blur: null, matte: null, masks: [], effects: [] };
      try {
        if (patch.source) p.source_id = patch.source.id;
      } catch (e1) {}
      try {
        p.sampling_quality = String(patch.samplingQuality);
      } catch (e2) {}
      try {
        p.motion_blur = patch.motionBlur === true;
      } catch (e3) {}
      try {
        var tm = patch.trackMatteType;
        if (tm !== undefined) p.matte = { type: matteName(tm), layer_id: patch.trackMatteLayer ? patch.trackMatteLayer.id : null };
      } catch (e4) {}
      var masks = patch.property("ADBE Mask Parade");
      var mi;
      if (masks) {
        for (mi = 1; mi <= masks.numProperties && mi <= 50; mi++) {
          var m = masks.property(mi);
          var rec = { mode: "", feather: null, expansion: null, num_keys_path: 0 };
          try {
            rec.mode = maskModeName(m.maskMode);
          } catch (e5) {}
          try {
            rec.feather = child(m, "ADBE Mask Feather").value;
          } catch (e6) {}
          try {
            rec.expansion = Number(child(m, "ADBE Mask Offset").value);
          } catch (e7) {}
          try {
            rec.num_keys_path = child(m, "ADBE Mask Shape").numKeys;
          } catch (e8) {}
          p.masks.push(rec);
        }
      }
      var fxs = patch.property("ADBE Effect Parade");
      if (fxs) {
        for (var fi = 1; fi <= fxs.numProperties && fi <= 50; fi++) p.effects.push(fxs.property(fi).matchName);
      }
      var tg = patch.property("ADBE Transform Group");
      p.position_keys = child(tg, "ADBE Position").numKeys;
      p.scale_keys = child(tg, "ADBE Scale").numKeys;
      p.rotation_keys = child(tg, "ADBE Rotate Z").numKeys;
      out.patch = p;
    }
    if (args.patch_comp_id !== undefined && args.patch_comp_id !== null) {
      var pc = null;
      try {
        pc = app.project.itemByID(args.patch_comp_id);
      } catch (e9) {
        pc = null;
      }
      if (pc && pc instanceof CompItem) {
        var inner = { layers: pc.numLayers, first: null };
        if (pc.numLayers > 0) {
          var il = pc.layer(1);
          var trk = 0;
          var trOn = false;
          try {
            trOn = il.timeRemapEnabled === true;
          } catch (e10) {}
          try {
            var trp = il.property("ADBE Time Remapping");
            if (trp) trk = trp.numKeys;
          } catch (e11) {}
          inner.first = {
            name: il.name,
            kind: layerKind(il),
            time_remap_enabled: trOn,
            time_remap_keys: trk,
            position_keys: child(il.property("ADBE Transform Group"), "ADBE Position").numKeys
          };
        }
        out.inner = inner;
      }
    }
    return out;
  };

  // ---------- reload ----------

  // args: { footage_id }. The item's state after a reload. Changes nothing.
  A.cleanplateFootage = function (args) {
    var item = null;
    try {
      item = app.project.itemByID(args.footage_id);
    } catch (e0) {
      item = null;
    }
    if (!item || !(item instanceof FootageItem)) return { found: false };
    var p = "";
    try {
      if (item.file) p = String(item.file.fsName);
    } catch (e1) {}
    var missing = false;
    try {
      missing = item.footageMissing === true;
    } catch (e2) {}
    return { found: true, id: item.id, name: item.name, path: p, missing: missing, width: item.width, height: item.height };
  };

  // args: { comp_id, footage_id? | patch_comp_id?, expect }. Guarded. Reloading
  // is not an undo step, so no undo group is opened and the call reports no_op.
  A.cleanplateReload = function (args) {
    assertGuard(args.expect);
    var item = null;
    if (args.footage_id !== undefined && args.footage_id !== null) {
      try {
        item = app.project.itemByID(args.footage_id);
      } catch (e0) {
        item = null;
      }
    } else if (args.patch_comp_id !== undefined && args.patch_comp_id !== null) {
      var pc = requireComp(args.patch_comp_id);
      for (var i = 1; i <= pc.numLayers && !item; i++) {
        var s = null;
        try {
          s = pc.layer(i).source;
        } catch (e1) {}
        var isStillFile = false;
        try {
          isStillFile = !!(s && s instanceof FootageItem && s.mainSource instanceof FileSource && s.mainSource.isStill === true);
        } catch (eSt) {}
        if (isStillFile) item = s;
      }
      if (!item) fail("bad_args", "This patch has no still; reload applies to source still");
    } else {
      fail("bad_args", "Give footage_id or patch_comp_id");
    }
    if (!item || !(item instanceof FootageItem)) fail("not_found", "No file footage to reload");
    if (!(item.mainSource instanceof FileSource)) fail("bad_args", "Item \"" + item.name + "\" is not file footage, so there is nothing to reload");
    if (typeof item.mainSource.reload !== "function") fail("bad_args", "This AE has no FileSource.reload");
    var path = "";
    try {
      if (item.file) {
        path = String(item.file.fsName);
        if (item.file.exists === false) fail("not_found", "The file is missing: " + path + ". Save the painted PNG over it first.");
      }
    } catch (eF) {
      if (eF.__kind) throw eF;
    }
    item.mainSource.reload();
    return { no_op: true, reloaded: true, footage: { id: item.id, name: item.name, path: path } };
  };
})($.global);
