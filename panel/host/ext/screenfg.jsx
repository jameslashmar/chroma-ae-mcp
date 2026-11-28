// panel/host/ext/screenfg.jsx
//
// Host functions for ae_screen_foreground: keeping what passes in front of a
// replaced green or blue screen (a hand, a finger, a pen) over the insert.
// Every name starts with "screenfg".
//
// - screenfgInfo (read): the comp, the insert layer (its effects, its motion
//   blur, its pin's corner values on every frame of its span), the plate layer,
//   and the parts of an earlier build found by name
// - screenfgApply (guarded write), mode "build": one undo group that makes
//     '<name> KEY'   a precomp of a duplicate of the plate with Keylight on it
//                    (Replace Method Source; off until the server has measured)
//     '<name> AREA'  a precomp of a duplicate of the insert, grown by Minimax:
//                    the KEY layer's alpha matte, so the key only acts where the
//                    insert is
//     '<name> WRAP'  a comp of two KEY layers: blur(1 - alpha) times alpha, the
//                    band just inside the subject's edge (a luma matte)
//     '<name> wrap OUT (old screen)'  the insert filled with the old screen's
//                    colour, blurred, in Subtract, through the WRAP matte
//     '<name> wrap IN (new screen)'   the insert blurred, in Add, through the
//                    WRAP matte
//   and optionally CC Force Motion Blur on the insert with the shutter centred
//   on the frame (phase = -angle / 2), because the track sits on the middle of
//   the plate's blur; mode "set": the measured values on those parts
// - screenfgRead (read): the read-back for the receipt, in a separate call
//
// Rules: ES3 only; reads change nothing; the write checks the guard first and
// validates before A.withUndo; effects are looked up again after every
// addProperty; a failed build removes what it made in the same call.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_FRAMES = 3000;
  var KEYLIGHT = "Keylight 906";
  var KL_VIEW = "Keylight 906-0002";
  var KL_COLOUR = "Keylight 906-0004";
  var KL_CLIP_BLACK = "Keylight 906-0012";
  var KL_CLIP_WHITE = "Keylight 906-0013";
  var KL_REPLACE = "Keylight 906-0019";
  var SHIFT = "ADBE Shift Channels";
  var INVERT = "ADBE Invert";
  var BOX = "ADBE Box Blur2";
  var MINIMAX = "ADBE Minimax";
  var FILL = "ADBE Fill";
  var FORCE_MB = "CC Force Motion Blur";
  var PIN_MATCHES = ["CC Power Pin", "ADBE Corner Pin"];
  // Shift Channels' menu: 1 Alpha ... 9 Full On (measured on AE 27.0).
  var SHIFT_ALPHA = 1;
  var SHIFT_FULL_ON = 9;
  var SUFFIX = {
    key: " KEY",
    area: " AREA",
    wrap: " WRAP",
    wrap_in: " wrap IN (new screen)",
    wrap_out: " wrap OUT (old screen)"
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
      fail("guard", "Target guard refused mutation: the open project or comp does not match expect. Stop and re-read state.", {
        expected: expect,
        actual: { project_path: g.project_path, comp_id: g.comp_id, comp_is_valid: g.comp_is_valid }
      });
    }
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

  function layerByIndexId(comp, sel, what) {
    if (!sel || typeof sel.index !== "number" || typeof sel.id !== "number") fail("bad_args", what + " needs both an index and an id");
    if (sel.index < 1 || sel.index > comp.numLayers) fail("not_found", what + ": layer index " + sel.index + " out of range");
    var l = comp.layer(sel.index);
    if (l.id !== sel.id) fail("guard", what + ": layer " + sel.index + " is not the layer read earlier (id " + sel.id + "); the stack changed. Re-read and retry.");
    return l;
  }

  function layerById(comp, id) {
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).id === id) return comp.layer(i);
    }
    return null;
  }

  function compByName(name) {
    var found = null;
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it instanceof CompItem && it.name === name) {
        if (found) return { many: true };
        found = it;
      }
    }
    return found;
  }

  function layerByName(comp, name) {
    var found = null;
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).name === name) {
        if (found) return { many: true };
        found = comp.layer(i);
      }
    }
    return found;
  }

  function fxOf(layer) {
    return layer.property("ADBE Effect Parade");
  }

  function effectsOf(layer, matchName) {
    var out = [];
    var fx = fxOf(layer);
    if (!fx) return out;
    for (var i = 1; i <= fx.numProperties; i++) {
      if (fx.property(i).matchName === matchName) out.push(i);
    }
    return out;
  }

  // The last effect with this match name, looked up fresh.
  function lastEffect(layer, matchName) {
    var idx = effectsOf(layer, matchName);
    if (idx.length === 0) return null;
    return fxOf(layer).property(idx[idx.length - 1]);
  }

  function addEffect(layer, matchName) {
    var fx = fxOf(layer);
    if (!fx) fail("bad_args", "Layer \"" + layer.name + "\" takes no effects");
    var made = null;
    try {
      made = fx.addProperty(matchName);
    } catch (e) {
      made = null;
    }
    if (!made) fail("failed", "The effect " + matchName + " could not be added on this AE.");
    return lastEffect(layer, matchName);
  }

  function removeEffects(layer, matchName) {
    var idx = effectsOf(layer, matchName);
    for (var k = idx.length - 1; k >= 0; k--) fxOf(layer).property(idx[k]).remove();
    return idx.length;
  }

  function param(effect, matchName, what) {
    var p = null;
    try {
      p = effect.property(matchName);
    } catch (e) {
      p = null;
    }
    if (!p) fail("failed", what + ": the parameter " + matchName + " was not found on this AE.");
    return p;
  }

  function setParam(layer, effectMatch, paramMatch, value) {
    var e = lastEffect(layer, effectMatch);
    if (!e) fail("failed", effectMatch + " is not on \"" + layer.name + "\"");
    param(e, paramMatch, effectMatch).setValue(value);
  }

  function valueOf(p) {
    var v = null;
    try {
      v = p.value;
    } catch (e) {
      v = null;
    }
    if (v !== null && typeof v === "object" && v.length !== undefined) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(Number(v[i]));
      return a;
    }
    return v;
  }

  function pinOf(layer) {
    for (var k = 0; k < PIN_MATCHES.length; k++) {
      var e = lastEffect(layer, PIN_MATCHES[k]);
      if (e) return { effect: e, kind: PIN_MATCHES[k] };
    }
    return null;
  }

  // The first four two-dimensional parameters of a pin effect: its corners, in whatever order it keeps them.
  function pinCornerProps(effect) {
    var out = [];
    for (var i = 1; i <= effect.numProperties && out.length < 4; i++) {
      var p = effect.property(i);
      var t = null;
      try {
        t = p.propertyValueType;
      } catch (e) {
        t = null;
      }
      if (t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.TwoD) out.push(p);
    }
    return out;
  }

  function sourceKind(l) {
    var s = null;
    try {
      s = l.source;
    } catch (e) {
      s = null;
    }
    if (!s) return "none";
    if (s instanceof CompItem) return "comp";
    if (s instanceof FootageItem) return "footage";
    return "other";
  }

  function hasVideo(l) {
    var v = true;
    try {
      v = l.hasVideo !== false;
    } catch (e) {
      v = true;
    }
    return v;
  }

  function opacityKeyed(l) {
    var n = 0;
    try {
      n = l.property("ADBE Transform Group").property("ADBE Opacity").numKeys;
    } catch (e) {
      n = 0;
    }
    return n > 0;
  }

  function baseName(insertName) {
    var s = String(insertName);
    if (s.length > 7 && s.substring(s.length - 7) === " INSERT") return s.substring(0, s.length - 7);
    return s;
  }

  function namesFor(name) {
    return {
      key: name + SUFFIX.key,
      area: name + SUFFIX.area,
      wrap: name + SUFFIX.wrap,
      wrap_in: name + SUFFIX.wrap_in,
      wrap_out: name + SUFFIX.wrap_out
    };
  }

  function ours(name, l) {
    var n = namesFor(name);
    return l.name === n.key || l.name === n.area || l.name === n.wrap || l.name === n.wrap_in || l.name === n.wrap_out;
  }

  // The plate when none is named: the first enabled layer below the insert with a picture that is not ours.
  function guessPlate(comp, ins, name) {
    for (var i = ins.index + 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      if (!l.enabled || !hasVideo(l) || ours(name, l)) continue;
      var k = sourceKind(l);
      if (k === "footage" || k === "comp") return l;
    }
    return null;
  }

  function brief(l) {
    if (!l) return null;
    return { index: l.index, id: l.id, name: l.name, locked: l.locked === true, enabled: l.enabled === true, source_kind: sourceKind(l) };
  }

  function effectList(l) {
    var out = [];
    var fx = fxOf(l);
    if (!fx) return out;
    for (var i = 1; i <= fx.numProperties && i <= 40; i++) {
      var e = fx.property(i);
      out.push({ index: i, match: e.matchName, name: e.name, enabled: e.enabled === true });
    }
    return out;
  }

  function forceMbFacts(l) {
    var e = lastEffect(l, FORCE_MB);
    if (!e) return null;
    var f = { enabled: e.enabled === true, override: null, angle: null, phase: null };
    try {
      f.override = Number(e.property("CC Force Motion Blur-0002").value);
      f.angle = Number(e.property("CC Force Motion Blur-0003").value);
      f.phase = Number(e.property("CC Force Motion Blur-0005").value);
    } catch (eP) {}
    return f;
  }

  function existingParts(comp, name) {
    var n = namesFor(name);
    var out = { layers: {}, comps: {} };
    var keys = ["key", "area", "wrap", "wrap_in", "wrap_out"];
    for (var k = 0; k < keys.length; k++) {
      var l = layerByName(comp, n[keys[k]]);
      if (l && l.many) out.layers[keys[k]] = { many: true };
      else out.layers[keys[k]] = l ? { index: l.index, id: l.id, source_id: l.source ? l.source.id : null } : null;
    }
    var cks = ["key", "area", "wrap"];
    for (var c = 0; c < cks.length; c++) {
      var it = compByName(n[cks[c]]);
      if (it && it.many) out.comps[cks[c]] = { many: true };
      else out.comps[cks[c]] = it ? { id: it.id } : null;
    }
    return out;
  }

  // args: { comp_id, insert: selector, plate?: selector, name? }
  A.screenfgInfo = function (args) {
    var comp = requireComp(args.comp_id);
    var ins = findLayer(comp, args.insert);
    var name = args.name ? String(args.name) : baseName(ins.name);
    var plate = args.plate ? findLayer(comp, args.plate) : guessPlate(comp, ins, name);
    var fps = Number(comp.frameRate);
    if (!(fps > 0)) fps = 25;
    var shutterAngle = null;
    var shutterPhase = null;
    try {
      shutterAngle = Number(comp.shutterAngle);
      shutterPhase = Number(comp.shutterPhase);
    } catch (eS) {}
    var pin = pinOf(ins);
    var frames = [];
    var truncated = false;
    if (pin) {
      var props = pinCornerProps(pin.effect);
      var pos = ins.property("ADBE Transform Group").property("ADBE Position");
      var t0 = Math.max(0, ins.inPoint);
      var t1 = Math.min(comp.duration, ins.outPoint);
      var n = Math.floor((t1 - t0) * fps + 1e-6);
      if (n > MAX_FRAMES) {
        n = MAX_FRAMES;
        truncated = true;
      }
      for (var f = 0; f < n; f++) {
        var t = t0 + f / fps;
        var cs = [];
        for (var c = 0; c < props.length; c++) {
          var v = props[c].valueAtTime(t, false);
          cs.push([Number(v[0]), Number(v[1])]);
        }
        var pv = pos.valueAtTime(t, false);
        frames.push({ t: t, c: cs, p: [Number(pv[0]), Number(pv[1])] });
      }
    }
    var keylightOnPlate = plate ? effectsOf(plate, KEYLIGHT).length > 0 : false;
    var src = null;
    try {
      src = ins.source;
    } catch (eSrc) {
      src = null;
    }
    var srcPar = 1;
    try {
      if (src && Number(src.pixelAspect) > 0) srcPar = Number(src.pixelAspect);
    } catch (ePa) {
      srcPar = 1;
    }
    return {
      comp: {
        id: comp.id,
        name: comp.name,
        width: comp.width,
        height: comp.height,
        pixel_aspect: comp.pixelAspect,
        fps: fps,
        duration: comp.duration,
        motion_blur: comp.motionBlur === true,
        shutter_angle: shutterAngle,
        shutter_phase: shutterPhase
      },
      ae_version: String(app.version),
      can_set_track_matte: typeof ins.setTrackMatte === "function",
      has_subtract: typeof BlendingMode !== "undefined" && BlendingMode.SUBTRACT !== undefined,
      name: name,
      insert: {
        index: ins.index,
        id: ins.id,
        name: ins.name,
        locked: ins.locked === true,
        enabled: ins.enabled === true,
        in_point: ins.inPoint,
        out_point: ins.outPoint,
        source_kind: sourceKind(ins),
        source_pixel_aspect: srcPar,
        motion_blur: ins.motionBlur === true,
        opacity_keyed: opacityKeyed(ins),
        effects: effectList(ins),
        pin: pin ? pin.kind : null,
        force_mb: forceMbFacts(ins),
        frames: frames,
        frames_truncated: truncated
      },
      plate: brief(plate),
      plate_has_keylight: keylightOnPlate,
      existing: existingParts(comp, name)
    };
  };

  // ---------- the write ----------

  function removeQuiet(thing) {
    try {
      thing.remove();
    } catch (e) {}
  }

  function setForceMb(ins, mb) {
    var e = lastEffect(ins, FORCE_MB);
    var added = false;
    var before = forceMbFacts(ins);
    if (!e) {
      e = addEffect(ins, FORCE_MB);
      added = true;
    }
    e = lastEffect(ins, FORCE_MB);
    param(e, "CC Force Motion Blur-0002", FORCE_MB).setValue(1);
    e = lastEffect(ins, FORCE_MB);
    param(e, "CC Force Motion Blur-0003", FORCE_MB).setValue(mb.angle);
    e = lastEffect(ins, FORCE_MB);
    param(e, "CC Force Motion Blur-0005", FORCE_MB).setValue(mb.phase);
    return { added: added, before: before, angle: mb.angle, phase: mb.phase };
  }

  function checkNumber(v, lo, hi, what) {
    if (!isNum(v) || v < lo || v > hi) fail("bad_args", what + " must be a number from " + lo + " to " + hi + " (got " + v + ")");
  }

  function checkColour(c, what) {
    if (!c || c.length !== 3) fail("bad_args", what + " must be [r, g, b] in 0..1");
    for (var i = 0; i < 3; i++) checkNumber(c[i], 0, 1, what);
  }

  function build(comp, a) {
    var ins = layerByIndexId(comp, a.insert, "The insert layer");
    var plate = layerByIndexId(comp, a.plate, "The plate layer");
    var name = String(a.name);
    var n = namesFor(name);
    if (ins.id === plate.id) fail("bad_args", "The insert and the plate are the same layer.");
    if (ins.locked) fail("refused", "The insert layer \"" + ins.name + "\" is locked; unlock it first.");
    if (plate.locked) fail("refused", "The plate layer \"" + plate.name + "\" is locked; unlock it first.");
    if (typeof ins.setTrackMatte !== "function") fail("refused", "Layer-based track mattes are needed (After Effects 23 or later).");
    if (typeof BlendingMode === "undefined" || BlendingMode.SUBTRACT === undefined) fail("refused", "This AE has no Subtract blending mode.");
    if (opacityKeyed(ins)) fail("refused", "The insert's Opacity is keyframed; the wrap layers copy it and set their own opacity. Remove the keys or bake them into the insert comp first.");
    if (effectsOf(plate, KEYLIGHT).length > 0) fail("refused", "The plate \"" + plate.name + "\" already has Keylight on it: the key here is made on a copy of the plate as it was shot. Turn that Keylight off or name the unkeyed plate.");
    var keysToCheck = ["key", "area", "wrap", "wrap_in", "wrap_out"];
    for (var k = 0; k < keysToCheck.length; k++) {
      if (layerByName(comp, n[keysToCheck[k]])) fail("exists", "A layer named \"" + n[keysToCheck[k]] + "\" is already in the comp; the parts of an earlier call are re-tuned, not rebuilt (the server reads them first).");
    }
    var cks = ["key", "area", "wrap"];
    for (var c = 0; c < cks.length; c++) {
      if (compByName(n[cks[c]])) fail("exists", "A comp named \"" + n[cks[c]] + "\" is already in the project; rename or remove it, or pass another name.");
    }
    checkNumber(a.grow_px, 0, 200, "grow_px");
    checkNumber(a.map_radius, 0, 200, "map_radius");
    checkNumber(a.light_radius, 0, 500, "light_radius");
    if (a.insert_mb) {
      checkNumber(a.insert_mb.angle, 0, 720, "insert_mb.angle");
      checkNumber(a.insert_mb.phase, -360, 360, "insert_mb.phase");
    }

    return A.withUndo("ae_screen_foreground: build", function () {
      var madeLayers = [];
      var madeComps = [];
      var mbOut = null;
      try {
        // KEY: the plate as it is composited (its own effects and transform kept), keyed in a precomp.
        var dup = plate.duplicate();
        try {
          dup.audioEnabled = false;
        } catch (eAu) {}
        var dupIndex = dup.index;
        var keyComp = comp.layers.precompose([dupIndex], n.key, true);
        madeComps.push(keyComp);
        var keyLayer = comp.layer(dupIndex);
        madeLayers.push(keyLayer);
        keyLayer.name = n.key;
        var keyInner = keyComp.layer(1);
        keyInner.enabled = true;
        addEffect(keyInner, KEYLIGHT);
        setParam(keyInner, KEYLIGHT, KL_REPLACE, 2);
        setParam(keyInner, KEYLIGHT, KL_CLIP_BLACK, 0);
        setParam(keyInner, KEYLIGHT, KL_CLIP_WHITE, 100);
        setParam(keyInner, KEYLIGHT, KL_VIEW, 11);
        lastEffect(keyInner, KEYLIGHT).enabled = false;

        // AREA: where the insert is, grown, as the KEY layer's alpha matte.
        ins = layerById(comp, a.insert.id);
        var ad = ins.duplicate();
        var adIndex = ad.index;
        var areaComp = comp.layers.precompose([adIndex], n.area, true);
        madeComps.push(areaComp);
        var areaLayer = comp.layer(adIndex);
        madeLayers.push(areaLayer);
        areaLayer.name = n.area;
        var areaInner = areaComp.layer(1);
        areaInner.enabled = true;
        removeEffects(areaInner, FORCE_MB);
        addEffect(areaInner, MINIMAX);
        setParam(areaInner, MINIMAX, "ADBE Minimax-0001", 2);
        setParam(areaInner, MINIMAX, "ADBE Minimax-0002", a.grow_px);
        setParam(areaInner, MINIMAX, "ADBE Minimax-0003", 1);
        areaLayer.enabled = false;
        keyLayer = layerById(comp, keyLayer.id);
        keyLayer.setTrackMatte(areaLayer, TrackMatteType.ALPHA);

        // WRAP: blur(1 - alpha) x alpha of the key, opaque, as a luma matte.
        var wrapComp = app.project.items.addComp(n.wrap, comp.width, comp.height, comp.pixelAspect, comp.duration, comp.frameRate);
        madeComps.push(wrapComp);
        var lo = wrapComp.layers.add(keyComp);
        lo.name = "1 - alpha, blurred";
        addEffect(lo, SHIFT);
        setParam(lo, SHIFT, "ADBE Shift Channels-0001", SHIFT_FULL_ON);
        setParam(lo, SHIFT, "ADBE Shift Channels-0002", SHIFT_ALPHA);
        setParam(lo, SHIFT, "ADBE Shift Channels-0003", SHIFT_ALPHA);
        setParam(lo, SHIFT, "ADBE Shift Channels-0004", SHIFT_ALPHA);
        addEffect(lo, INVERT);
        setParam(lo, INVERT, "ADBE Invert-0001", 1);
        addEffect(lo, BOX);
        setParam(lo, BOX, "ADBE Box Blur2-0001", a.map_radius);
        setParam(lo, BOX, "ADBE Box Blur2-0002", 3);
        setParam(lo, BOX, "ADBE Box Blur2-0004", 1);
        var hi = wrapComp.layers.add(keyComp);
        hi.name = "alpha";
        addEffect(hi, SHIFT);
        setParam(hi, SHIFT, "ADBE Shift Channels-0001", SHIFT_FULL_ON);
        setParam(hi, SHIFT, "ADBE Shift Channels-0002", SHIFT_ALPHA);
        setParam(hi, SHIFT, "ADBE Shift Channels-0003", SHIFT_ALPHA);
        setParam(hi, SHIFT, "ADBE Shift Channels-0004", SHIFT_ALPHA);
        hi.blendingMode = BlendingMode.MULTIPLY;
        var wrapLayer = comp.layers.add(wrapComp);
        madeLayers.push(wrapLayer);
        wrapLayer.name = n.wrap;
        wrapLayer.enabled = false;

        // The two wrap layers: copies of the insert (its pin and keys), blurred, through the WRAP matte.
        ins = layerById(comp, a.insert.id);
        var wo = ins.duplicate();
        madeLayers.push(wo);
        wo.name = n.wrap_out;
        removeEffects(wo, FORCE_MB);
        addEffect(wo, FILL);
        setParam(wo, FILL, "ADBE Fill-0002", [0, 1, 0, 1]);
        addEffect(wo, BOX);
        setParam(wo, BOX, "ADBE Box Blur2-0001", a.light_radius);
        setParam(wo, BOX, "ADBE Box Blur2-0002", 3);
        setParam(wo, BOX, "ADBE Box Blur2-0004", 0);
        wo.blendingMode = BlendingMode.SUBTRACT;
        wo.property("ADBE Transform Group").property("ADBE Opacity").setValue(0);
        wo.setTrackMatte(wrapLayer, TrackMatteType.LUMA);
        ins = layerById(comp, a.insert.id);
        var wi = ins.duplicate();
        madeLayers.push(wi);
        wi.name = n.wrap_in;
        removeEffects(wi, FORCE_MB);
        addEffect(wi, BOX);
        setParam(wi, BOX, "ADBE Box Blur2-0001", a.light_radius);
        setParam(wi, BOX, "ADBE Box Blur2-0002", 3);
        setParam(wi, BOX, "ADBE Box Blur2-0004", 0);
        wi.blendingMode = BlendingMode.ADD;
        wi.property("ADBE Transform Group").property("ADBE Opacity").setValue(0);
        wi.setTrackMatte(wrapLayer, TrackMatteType.LUMA);

        // Order, top down: wrap IN, wrap OUT, WRAP, KEY, AREA, the insert.
        ins = layerById(comp, a.insert.id);
        areaLayer.moveBefore(ins);
        keyLayer.moveBefore(areaLayer);
        wrapLayer.moveBefore(keyLayer);
        wo.moveBefore(wrapLayer);
        wi.moveBefore(wo);

        if (a.insert_mb) mbOut = setForceMb(layerById(comp, a.insert.id), a.insert_mb);
      } catch (err) {
        for (var r = madeLayers.length - 1; r >= 0; r--) removeQuiet(madeLayers[r]);
        for (var q = madeComps.length - 1; q >= 0; q--) removeQuiet(madeComps[q]);
        throw err;
      }
      return {
        built: true,
        name: name,
        comps: { key: { id: keyComp.id, name: keyComp.name }, area: { id: areaComp.id, name: areaComp.name }, wrap: { id: wrapComp.id, name: wrapComp.name } },
        layers: {
          wrap_in: { index: wi.index, id: wi.id },
          wrap_out: { index: wo.index, id: wo.id },
          wrap: { index: wrapLayer.index, id: wrapLayer.id },
          key: { index: keyLayer.index, id: keyLayer.id },
          area: { index: areaLayer.index, id: areaLayer.id },
          insert: { index: layerById(comp, a.insert.id).index, id: a.insert.id }
        },
        inner: { key: keyComp.layer(1).id, area: areaComp.layer(1).id, wrap_blur: wrapComp.layer(2).id },
        insert_mb: mbOut
      };
    });
  }

  // The parts as the server read them: every one must still be there.
  function resolveParts(comp, p) {
    var names = ["wrap_in", "wrap_out", "wrap", "key", "area", "insert"];
    var out = {};
    for (var i = 0; i < names.length; i++) {
      var sel = p.layers ? p.layers[names[i]] : null;
      if (!sel) fail("bad_args", "parts.layers." + names[i] + " missing");
      out[names[i]] = layerByIndexId(comp, sel, "The " + names[i].replace("_", " ") + " layer");
    }
    var keyComp = requireComp(p.comps.key);
    var areaComp = requireComp(p.comps.area);
    var wrapComp = requireComp(p.comps.wrap);
    out.key_inner = keyComp.numLayers >= 1 ? keyComp.layer(1) : null;
    out.area_inner = areaComp.numLayers >= 1 ? areaComp.layer(1) : null;
    out.wrap_blur = null;
    for (var w = 1; w <= wrapComp.numLayers; w++) {
      if (effectsOf(wrapComp.layer(w), INVERT).length > 0) out.wrap_blur = wrapComp.layer(w);
    }
    if (!out.key_inner || !lastEffect(out.key_inner, KEYLIGHT)) fail("not_found", "The KEY comp has no layer with Keylight; rebuild (remove the parts and call again).");
    if (!out.area_inner || !lastEffect(out.area_inner, MINIMAX)) fail("not_found", "The AREA comp has no layer with Minimax; rebuild.");
    if (!out.wrap_blur || !lastEffect(out.wrap_blur, BOX)) fail("not_found", "The WRAP comp has no blurred layer; rebuild.");
    if (!lastEffect(out.wrap_out, FILL) || !lastEffect(out.wrap_out, BOX) || !lastEffect(out.wrap_in, BOX)) fail("not_found", "A wrap layer lost its effects; rebuild.");
    return out;
  }

  function setParams(comp, a) {
    var parts = resolveParts(comp, a.parts);
    var k = a.keylight || null;
    var wr = a.wrap || null;
    if (k) {
      if (k.colour !== undefined) checkColour(k.colour, "keylight.colour");
      if (k.clip_black !== undefined) checkNumber(k.clip_black, 0, 100, "keylight.clip_black");
      if (k.clip_white !== undefined) checkNumber(k.clip_white, 0, 100, "keylight.clip_white");
    }
    if (wr) {
      if (wr.opacity !== undefined) checkNumber(wr.opacity, 0, 100, "wrap.opacity");
      if (wr.colour !== undefined) checkColour(wr.colour, "wrap.colour");
      if (wr.map_radius !== undefined) checkNumber(wr.map_radius, 0, 200, "wrap.map_radius");
      if (wr.light_radius !== undefined) checkNumber(wr.light_radius, 0, 500, "wrap.light_radius");
    }
    if (a.grow_px !== undefined) checkNumber(a.grow_px, 0, 200, "grow_px");
    if (a.insert_mb) {
      checkNumber(a.insert_mb.angle, 0, 720, "insert_mb.angle");
      checkNumber(a.insert_mb.phase, -360, 360, "insert_mb.phase");
      if (parts.insert.locked) fail("refused", "The insert layer is locked; unlock it to change its motion blur.");
    }
    if (wr && wr.opacity !== undefined && (opacityKeyed(parts.wrap_in) || opacityKeyed(parts.wrap_out))) fail("refused", "A wrap layer's Opacity is keyframed; remove the keys first.");
    return A.withUndo("ae_screen_foreground: set", function () {
      var done = [];
      var mbOut = null;
      if (k) {
        var inner = parts.key_inner;
        if (k.colour !== undefined) {
          setParam(inner, KEYLIGHT, KL_COLOUR, [k.colour[0], k.colour[1], k.colour[2]]);
          done.push("keylight.colour");
        }
        if (k.clip_black !== undefined) {
          setParam(inner, KEYLIGHT, KL_CLIP_BLACK, k.clip_black);
          done.push("keylight.clip_black");
        }
        if (k.clip_white !== undefined) {
          setParam(inner, KEYLIGHT, KL_CLIP_WHITE, k.clip_white);
          done.push("keylight.clip_white");
        }
        if (k.enabled !== undefined) {
          lastEffect(inner, KEYLIGHT).enabled = k.enabled === true;
          done.push("keylight.enabled");
        }
      }
      if (wr) {
        if (wr.opacity !== undefined) {
          parts.wrap_in.property("ADBE Transform Group").property("ADBE Opacity").setValue(wr.opacity);
          parts.wrap_out.property("ADBE Transform Group").property("ADBE Opacity").setValue(wr.opacity);
          done.push("wrap.opacity");
        }
        if (wr.colour !== undefined) {
          setParam(parts.wrap_out, FILL, "ADBE Fill-0002", [wr.colour[0], wr.colour[1], wr.colour[2], 1]);
          done.push("wrap.colour");
        }
        if (wr.map_radius !== undefined) {
          setParam(parts.wrap_blur, BOX, "ADBE Box Blur2-0001", wr.map_radius);
          done.push("wrap.map_radius");
        }
        if (wr.light_radius !== undefined) {
          setParam(parts.wrap_in, BOX, "ADBE Box Blur2-0001", wr.light_radius);
          setParam(parts.wrap_out, BOX, "ADBE Box Blur2-0001", wr.light_radius);
          done.push("wrap.light_radius");
        }
      }
      if (a.grow_px !== undefined) {
        setParam(parts.area_inner, MINIMAX, "ADBE Minimax-0002", a.grow_px);
        done.push("grow_px");
      }
      if (a.insert_mb) mbOut = setForceMb(parts.insert, a.insert_mb);
      return { set: done, insert_mb: mbOut };
    });
  }

  // Removes the parts by id (layers, then the three comps); only what carries this tool's names.
  function removeParts(comp, a) {
    var name = String(a.name);
    var p = a.parts || {};
    var layers = [];
    var names = ["wrap_in", "wrap_out", "wrap", "key", "area"];
    for (var i = 0; i < names.length; i++) {
      var id = p.layers && p.layers[names[i]] ? p.layers[names[i]].id : null;
      if (id === null || id === undefined) continue;
      var l = layerById(comp, id);
      if (l && ours(name, l)) {
        if (l.locked) fail("refused", "\"" + l.name + "\" is locked; unlock it first.");
        layers.push(l);
      }
    }
    var comps = [];
    var n = namesFor(name);
    var cks = ["key", "area", "wrap"];
    for (var c = 0; c < cks.length; c++) {
      var cid = p.comps ? p.comps[cks[c]] : null;
      if (cid === null || cid === undefined) continue;
      var it = null;
      try {
        it = app.project.itemByID(cid);
      } catch (eI) {
        it = null;
      }
      if (it && it instanceof CompItem && it.name === n[cks[c]]) comps.push(it);
    }
    if (layers.length === 0 && comps.length === 0) return { no_op: true, removed: { layers: [], comps: [] } };
    return A.withUndo("ae_screen_foreground: remove", function () {
      var gone = { layers: [], comps: [] };
      for (var r = 0; r < layers.length; r++) {
        gone.layers.push(layers[r].name);
        layers[r].remove();
      }
      for (var q = 0; q < comps.length; q++) {
        gone.comps.push(comps[q].name);
        comps[q].remove();
      }
      return { removed: gone };
    });
  }

  // args: { comp_id, expect, mode: "build" | "set" | "remove", ... }
  A.screenfgApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    if (args.mode === "build") return build(comp, args);
    if (args.mode === "set") return setParams(comp, args);
    if (args.mode === "remove") return removeParts(comp, args);
    fail("bad_args", "mode must be build, set or remove");
    return null;
  };

  // ---------- read-back ----------

  var READ_PARAMS = {};
  READ_PARAMS[KEYLIGHT] = [KL_VIEW, KL_COLOUR, KL_CLIP_BLACK, KL_CLIP_WHITE, KL_REPLACE];
  READ_PARAMS[SHIFT] = ["ADBE Shift Channels-0001", "ADBE Shift Channels-0002", "ADBE Shift Channels-0003", "ADBE Shift Channels-0004"];
  READ_PARAMS[INVERT] = ["ADBE Invert-0001"];
  READ_PARAMS[BOX] = ["ADBE Box Blur2-0001", "ADBE Box Blur2-0002", "ADBE Box Blur2-0004"];
  READ_PARAMS[MINIMAX] = ["ADBE Minimax-0001", "ADBE Minimax-0002", "ADBE Minimax-0003"];
  READ_PARAMS[FILL] = ["ADBE Fill-0002"];
  READ_PARAMS[FORCE_MB] = ["CC Force Motion Blur-0002", "CC Force Motion Blur-0003", "CC Force Motion Blur-0005"];

  function describe(l) {
    if (!l) return null;
    var fxs = [];
    var fx = fxOf(l);
    for (var i = 1; fx && i <= fx.numProperties && i <= 40; i++) {
      var e = fx.property(i);
      var ps = {};
      var want = READ_PARAMS[e.matchName];
      if (want) {
        for (var j = 0; j < want.length; j++) {
          var p = null;
          try {
            p = e.property(want[j]);
          } catch (eP) {
            p = null;
          }
          if (p) ps[want[j]] = valueOf(p);
        }
      }
      fxs.push({ match: e.matchName, enabled: e.enabled === true, params: ps });
    }
    var matteId = null;
    var matteType = "none";
    try {
      matteId = l.trackMatteLayer ? l.trackMatteLayer.id : null;
      var tm = l.trackMatteType;
      if (tm === TrackMatteType.ALPHA) matteType = "alpha";
      else if (tm === TrackMatteType.ALPHA_INVERTED) matteType = "alpha_inverted";
      else if (tm === TrackMatteType.LUMA) matteType = "luma";
      else if (tm === TrackMatteType.LUMA_INVERTED) matteType = "luma_inverted";
    } catch (eM) {}
    var opacity = null;
    try {
      opacity = Number(l.property("ADBE Transform Group").property("ADBE Opacity").value);
    } catch (eO) {}
    return { index: l.index, id: l.id, name: l.name, enabled: l.enabled === true, blending_mode: blendName(l), matte_id: matteId, matte_type: matteType, opacity: opacity, source_id: l.source ? l.source.id : null, effects: fxs };
  }

  function blendName(l) {
    var m = null;
    try {
      m = l.blendingMode;
    } catch (e) {
      return null;
    }
    if (typeof BlendingMode === "undefined") return null;
    if (m === BlendingMode.NORMAL) return "normal";
    if (m === BlendingMode.ADD) return "add";
    if (m === BlendingMode.SUBTRACT) return "subtract";
    if (m === BlendingMode.MULTIPLY) return "multiply";
    return "other";
  }

  // args: { comp_id, layer_ids: { name: id }, comps?: { key, area, wrap } }
  A.screenfgRead = function (args) {
    var comp = requireComp(args.comp_id);
    var out = { layers: {}, inner: {}, order: [] };
    var ids = args.layer_ids || {};
    for (var k in ids) {
      if (ids.hasOwnProperty(k)) out.layers[k] = describe(layerById(comp, ids[k]));
    }
    for (var i = 1; i <= comp.numLayers && i <= 200; i++) out.order.push(comp.layer(i).id);
    var cs = args.comps || {};
    var key = null;
    var area = null;
    var wrap = null;
    try {
      key = cs.key ? app.project.itemByID(cs.key) : null;
      area = cs.area ? app.project.itemByID(cs.area) : null;
      wrap = cs.wrap ? app.project.itemByID(cs.wrap) : null;
    } catch (eI) {}
    out.inner.key = key && key.numLayers >= 1 ? describe(key.layer(1)) : null;
    out.inner.area = area && area.numLayers >= 1 ? describe(area.layer(1)) : null;
    out.inner.wrap = [];
    if (wrap) {
      for (var w = 1; w <= wrap.numLayers; w++) out.inner.wrap.push(describe(wrap.layer(w)));
    }
    out.comps = { key: key ? { id: key.id, width: key.width, height: key.height } : null, area: area ? { id: area.id } : null, wrap: wrap ? { id: wrap.id, width: wrap.width, height: wrap.height } : null };
    return out;
  };
})($.global);
