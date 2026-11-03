// panel/host/ext/timeremap.jsx
//
// Host functions for the time remap tools:
// - timeremapRead (read): a layer's time remap state: in, out, start, stretch,
//   the source's length and frame duration, the Time Remap keys with their
//   eases, the expression, and valueAtTime samples at times the caller names
// - timeremapApply (guarded write): carries out a plan the server worked out
//   in Node (docs in server/src/tools/ext/timeremap.ts): enable or disable
//   remapping, replace the remap keys, set the loop expression, change
//   layer.stretch, move the in and out points
//
// The maths (source time at a comp time, the integral of a speed ramp, the
// mirrored keys of a reverse) lives in Node. This file validates the plan
// against the layer, then writes it, so it checks that the layer still looks
// as it did when the plan was made and refuses otherwise.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Before and after reads run in separate evalScript calls from the server.
// - Everything that can fail is checked before A.withUndo opens.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_KEYS_READ = 500;
  var MAX_KEYS_WRITE = 3000;
  var MAX_SAMPLES = 100;
  var MAX_EXPRESSION = 20000;
  var SNAPSHOT_TOLERANCE = 1e-5;

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

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function remapProp(layer) {
    var p = null;
    try {
      p = layer.property("ADBE Time Remapping");
    } catch (e) {
      p = null;
    }
    return p;
  }

  function interpName(t) {
    if (t === KeyframeInterpolationType.LINEAR) return "linear";
    if (t === KeyframeInterpolationType.BEZIER) return "bezier";
    if (t === KeyframeInterpolationType.HOLD) return "hold";
    return String(t);
  }

  function interpValue(name) {
    if (name === "linear") return KeyframeInterpolationType.LINEAR;
    if (name === "bezier") return KeyframeInterpolationType.BEZIER;
    if (name === "hold") return KeyframeInterpolationType.HOLD;
    fail("bad_args", "Unknown interpolation \"" + name + "\"");
    return null;
  }

  // The source's own frame length; a comp's or footage's frameDuration, else
  // from its frame rate, else the comp's.
  function frameDurationOf(src, comp) {
    var fd = 0;
    try {
      fd = src.frameDuration;
    } catch (e0) {
      fd = 0;
    }
    if (!isNum(fd) || fd <= 0) {
      try {
        if (isNum(src.frameRate) && src.frameRate > 0) fd = 1 / src.frameRate;
      } catch (e1) {
        fd = 0;
      }
    }
    if (!isNum(fd) || fd <= 0) fd = comp.frameDuration;
    return fd;
  }

  function easeList(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) out.push({ speed: list[i].speed, influence: list[i].influence });
    return out;
  }

  function keyEntry(prop, i) {
    var inI = prop.keyInInterpolationType(i);
    var outI = prop.keyOutInterpolationType(i);
    var k = {
      index: i,
      time: prop.keyTime(i),
      value: prop.keyValue(i),
      in_interp: interpName(inI),
      out_interp: interpName(outI)
    };
    // Ease only means something on a Bezier side; a read of a linear side can throw,
    // so each side is read on its own.
    if (inI === KeyframeInterpolationType.BEZIER) {
      try {
        k.in_ease = easeList(prop.keyInTemporalEase(i));
      } catch (e0) {}
    }
    if (outI === KeyframeInterpolationType.BEZIER) {
      try {
        k.out_ease = easeList(prop.keyOutTemporalEase(i));
      } catch (e1) {}
    }
    return k;
  }

  function numberList(v, cap) {
    var out = [];
    if (!v || typeof v.length !== "number") return out;
    for (var i = 0; i < v.length && out.length < cap; i++) {
      if (isNum(v[i])) out.push(v[i]);
    }
    return out;
  }

  function infoOf(comp, layer, sampleTimes) {
    var src = null;
    try {
      src = layer.source;
    } catch (e0) {
      src = null;
    }
    var out = {
      comp_id: comp.id,
      comp_name: comp.name,
      comp_duration: comp.duration,
      comp_frame_duration: comp.frameDuration,
      layer: { index: layer.index, id: layer.id, name: layer.name },
      kind: "",
      eligible: false,
      ineligible_reason: null,
      remap_enabled: false,
      can_set_remap: null,
      in_point: layer.inPoint,
      out_point: layer.outPoint,
      start_time: layer.startTime,
      stretch: layer.stretch,
      source: null,
      keys: [],
      num_keys: 0,
      keys_truncated: false,
      expression: null,
      expression_enabled: false,
      samples: []
    };
    try {
      if (layer.reflect && layer.reflect.name) out.kind = String(layer.reflect.name);
    } catch (e1) {}
    try {
      out.remap_enabled = layer.timeRemapEnabled === true;
    } catch (e2) {}
    try {
      if (layer.canSetTimeRemapEnabled !== undefined) out.can_set_remap = layer.canSetTimeRemapEnabled === true;
    } catch (e3) {}
    if (src) {
      var dur = 0;
      try {
        dur = src.duration;
      } catch (e4) {
        dur = 0;
      }
      out.source = {
        id: src.id,
        name: src.name,
        duration: dur,
        frame_duration: frameDurationOf(src, comp),
        is_comp: src instanceof CompItem
      };
      if (!(dur > 0)) {
        out.ineligible_reason = "the layer's source is a still or a solid (duration 0), so it has no time to remap";
      } else if (out.can_set_remap === false && !out.remap_enabled) {
        out.ineligible_reason = "After Effects reports that time remapping can't be enabled on this layer";
      } else {
        out.eligible = true;
      }
    } else {
      out.ineligible_reason = "the layer has no footage or comp source (text, shape, camera, light and null layers can't be time remapped)";
    }
    if (!out.remap_enabled) return out;
    var prop = remapProp(layer);
    if (!prop) return out;
    var n = prop.numKeys;
    out.num_keys = n;
    var lim = n;
    if (lim > MAX_KEYS_READ) {
      lim = MAX_KEYS_READ;
      out.keys_truncated = true;
    }
    for (var i = 1; i <= lim; i++) out.keys.push(keyEntry(prop, i));
    try {
      var ex = String(prop.expression);
      if (ex.length > MAX_EXPRESSION) ex = ex.substring(0, MAX_EXPRESSION);
      out.expression = ex;
      out.expression_enabled = prop.expressionEnabled === true;
    } catch (e5) {}
    var times = numberList(sampleTimes, MAX_SAMPLES);
    for (var s = 0; s < times.length; s++) {
      var v = null;
      try {
        v = prop.valueAtTime(times[s], false);
      } catch (e6) {
        v = null;
      }
      out.samples.push({ time: times[s], value: v });
    }
    return out;
  }

  // Samples only exist while remapping is on; with it off the server uses its
  // own maths, so the times come back with null values.
  function nullSamples(info, sampleTimes) {
    if (info.remap_enabled) return;
    var times = numberList(sampleTimes, MAX_SAMPLES);
    for (var s = 0; s < times.length; s++) info.samples.push({ time: times[s], value: null });
  }

  A.timeremapRead = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var info = infoOf(comp, layer, args.sample_times);
    nullSamples(info, args.sample_times);
    return info;
  };

  function findById(comp, id) {
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).id === id) return comp.layer(i);
    }
    fail("not_found", "No layer with id " + id + " in comp " + comp.id);
    return null;
  }

  function near(a, b) {
    return isNum(a) && isNum(b) && Math.abs(a - b) <= SNAPSHOT_TOLERANCE * Math.max(1, Math.abs(b));
  }

  function round6(n) {
    return Math.round(n * 1e6);
  }

  // The same hash the server makes (remapFingerprint in timeremap.ts) of the remap
  // keys (up to the 500 a read returns), the expression and the source.
  function remapFingerprint(layer) {
    var prop = layer.timeRemapEnabled === true ? remapProp(layer) : null;
    var n = 0;
    var text = "";
    var expr = "";
    if (prop) {
      n = prop.numKeys;
      var lim = n;
      if (lim > MAX_KEYS_READ) lim = MAX_KEYS_READ;
      text = String(n) + "#";
      for (var i = 1; i <= lim; i++) text += round6(prop.keyTime(i)) + ":" + round6(prop.keyValue(i)) + "|";
      try {
        expr = String(prop.expression);
        if (expr.length > MAX_EXPRESSION) expr = expr.substring(0, MAX_EXPRESSION);
      } catch (e0) {
        expr = "";
      }
    } else {
      text = "0#";
    }
    text += "#" + expr + "#";
    var src = null;
    try {
      src = layer.source;
    } catch (e1) {
      src = null;
    }
    text += src ? src.id + ":" + round6(src.duration) : "none";
    var h = 5381;
    for (var c = 0; c < text.length; c++) h = (h * 33 + text.charCodeAt(c)) % 4294967296;
    return { fingerprint: String(h), num_keys: n };
  }

  // The layer must still look as it did when the server planned the change.
  function checkSnapshot(layer, snap) {
    if (!snap) fail("bad_args", "plan.snapshot missing");
    var now = {
      in_point: layer.inPoint,
      out_point: layer.outPoint,
      start_time: layer.startTime,
      stretch: layer.stretch,
      remap_enabled: layer.timeRemapEnabled === true
    };
    if (
      !near(now.in_point, snap.in_point) ||
      !near(now.out_point, snap.out_point) ||
      !near(now.start_time, snap.start_time) ||
      !near(now.stretch, snap.stretch) ||
      now.remap_enabled !== (snap.remap_enabled === true)
    ) {
      fail("stale", "The layer changed since the plan was made (in, out, start, stretch or remap switch). Read it again and re-plan.", {
        expected: snap,
        actual: now
      });
    }
    // Plans built from the remap keys or expression also carry a fingerprint of them.
    if (snap.fingerprint !== undefined) {
      var fp = remapFingerprint(layer);
      if (fp.fingerprint !== String(snap.fingerprint)) {
        fail("stale", "The layer's Time Remap keys, expression or source changed since the plan was made. Read it again and re-plan.", {
          expected: { num_keys: snap.num_keys, fingerprint: snap.fingerprint },
          actual: fp
        });
      }
    }
  }

  var INTERP_NAMES = { linear: 1, bezier: 1, hold: 1 };

  // AE merges keys that land on the same frame; catch that before the write starts.
  function checkFrameSpacing(times, frameDuration) {
    if (!isNum(frameDuration) || !(frameDuration > 0)) return;
    var lastFrame = null;
    for (var i = 0; i < times.length; i++) {
      var f = Math.round(times[i] / frameDuration);
      if (lastFrame !== null && f === lastFrame) {
        fail("bad_args", "keys " + i + " and " + (i + 1) + " fall on the same comp frame (" + frameDuration + " s); After Effects would merge them");
      }
      lastFrame = f;
    }
  }

  function checkKeys(keys, duration, frameDuration) {
    if (!keys || typeof keys.length !== "number") fail("bad_args", "plan.keys must be a list");
    if (keys.length < 1 || keys.length > MAX_KEYS_WRITE) fail("bad_args", "plan.keys needs 1.." + MAX_KEYS_WRITE + " keys");
    var last = null;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!k || !isNum(k.time) || !isNum(k.value)) fail("bad_args", "key " + (i + 1) + " needs a numeric time and value");
      if (Math.abs(k.time) > 10800) fail("bad_args", "key " + (i + 1) + " time is outside +/-10800 s");
      if (last !== null && !(k.time > last)) fail("bad_args", "key times must be strictly ascending");
      last = k.time;
      // Time Remap holds source time: inside the source.
      if (k.value < -1e-9 || k.value > duration + 1e-9) {
        fail("bad_args", "key " + (i + 1) + " value " + k.value + " s is outside the source (0.." + duration + " s)");
      }
      if (k.in_interp === undefined || k.out_interp === undefined || INTERP_NAMES[k.in_interp] !== 1 || INTERP_NAMES[k.out_interp] !== 1) {
        fail("bad_args", "key " + (i + 1) + " needs in_interp and out_interp of linear, bezier or hold");
      }
      if (k.ease) {
        // Each side's ease is given exactly when that side is Bezier.
        var sides = ["in", "out"];
        for (var sd = 0; sd < 2; sd++) {
          var nm = sides[sd];
          var speed = k.ease[nm + "_speed"];
          var infl = k.ease[nm + "_influence"];
          if (k[nm + "_interp"] !== "bezier") {
            if (speed !== undefined || infl !== undefined) fail("bad_args", "key " + (i + 1) + " has an " + nm + " ease but its " + nm + " side is not Bezier");
          } else if (speed !== undefined || infl !== undefined) {
            if (!isNum(speed) || !isNum(infl)) fail("bad_args", "key " + (i + 1) + " ease needs a numeric speed and influence on each side it gives");
            // KeyframeEase influence is limited to 0.1..100; AE throws outside it.
            if (infl < 0.1 || infl > 100) fail("bad_args", "key " + (i + 1) + " ease influence must be in 0.1..100");
          }
        }
      }
    }
    var times = [];
    for (var t = 0; t < keys.length; t++) times.push(keys[t].time);
    checkFrameSpacing(times, frameDuration);
  }

  function checkPerFrame(pf, duration, frameDuration) {
    if (!pf || !pf.times || !pf.values || typeof pf.times.length !== "number" || typeof pf.values.length !== "number") fail("bad_args", "plan.per_frame needs times and values");
    if (pf.times.length !== pf.values.length) fail("bad_args", "plan.per_frame times and values differ in length");
    if (pf.times.length < 2 || pf.times.length > MAX_KEYS_WRITE) fail("bad_args", "plan.per_frame needs 2.." + MAX_KEYS_WRITE + " samples");
    var last = null;
    for (var i = 0; i < pf.times.length; i++) {
      if (!isNum(pf.times[i]) || !isNum(pf.values[i])) fail("bad_args", "per-frame sample " + (i + 1) + " is not numeric");
      if (last !== null && !(pf.times[i] > last)) fail("bad_args", "per-frame times must be strictly ascending");
      last = pf.times[i];
      if (pf.values[i] < -1e-9 || pf.values[i] > duration + 1e-9) {
        fail("bad_args", "per-frame sample " + (i + 1) + " is outside the source (0.." + duration + " s)");
      }
    }
    checkFrameSpacing(pf.times, frameDuration);
  }

  // Hard limits of the property itself, when it can be asked before the write.
  function checkPropLimits(prop, values) {
    var lo = null;
    var hi = null;
    try {
      if (prop.hasMin) lo = prop.minValue;
      if (prop.hasMax) hi = prop.maxValue;
    } catch (e) {
      return;
    }
    for (var i = 0; i < values.length; i++) {
      if (isNum(lo) && values[i] < lo - 1e-9) fail("bad_args", "Time Remap can't go below " + lo + " s (asked for " + values[i] + ")");
      if (isNum(hi) && values[i] > hi + 1e-9) fail("bad_args", "Time Remap can't go above " + hi + " s (asked for " + values[i] + ")");
    }
  }

  function removeAllKeys(prop) {
    // Highest index first: removing one renumbers those above it.
    for (var i = prop.numKeys; i >= 1; i--) prop.removeKey(i);
  }

  function styleKey(prop, i, k) {
    var inT = interpValue(k.in_interp);
    var outT = interpValue(k.out_interp);
    var e = k.ease;
    if (!e) {
      prop.setInterpolationTypeAtKey(i, inT, outT);
      return;
    }
    var hasIn = e.in_speed !== undefined;
    var hasOut = e.out_speed !== undefined;
    // A side without an ease gets AE's default one; its interpolation is set afterwards
    // (setting an ease may switch that side to Bezier).
    var inEase = new KeyframeEase(hasIn ? e.in_speed : 0, hasIn ? e.in_influence : 16.666666);
    var outEase = new KeyframeEase(hasOut ? e.out_speed : 0, hasOut ? e.out_influence : 16.666666);
    if (k.in_interp === "bezier" && k.out_interp === "bezier") {
      prop.setInterpolationTypeAtKey(i, inT, outT);
      prop.setTemporalEaseAtKey(i, [inEase], [outEase]);
    } else {
      prop.setTemporalEaseAtKey(i, [inEase], [outEase]);
      prop.setInterpolationTypeAtKey(i, inT, outT);
    }
  }

  // Nothing here throws once the first key is removed: a key count that differs from the
  // plan is returned, and the read-back reports it as a num_keys mismatch.
  function writeKeys(prop, keys) {
    var i;
    removeAllKeys(prop);
    for (i = 0; i < keys.length; i++) prop.setValueAtTime(keys[i].time, keys[i].value);
    var kept = prop.numKeys;
    if (kept === keys.length) {
      for (i = 0; i < keys.length; i++) styleKey(prop, i + 1, keys[i]);
    }
    return kept;
  }

  function writePerFrame(prop, pf) {
    var i;
    removeAllKeys(prop);
    prop.setValuesAtTimes(pf.times, pf.values);
    var kept = prop.numKeys;
    if (kept === pf.times.length) {
      for (i = 1; i <= pf.times.length; i++) prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
    }
    return kept;
  }

  A.timeremapApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findById(comp, args.layer_id);
    var plan = args.plan;
    if (!plan || typeof plan !== "object") fail("bad_args", "plan missing");
    checkSnapshot(layer, plan.snapshot);

    var src = null;
    try {
      src = layer.source;
    } catch (e0) {
      src = null;
    }
    if (!src || !(src.duration > 0)) fail("bad_args", "\"" + layer.name + "\" has no footage or comp source with a length, so it has no time to remap");
    var duration = src.duration;
    var wasEnabled = layer.timeRemapEnabled === true;

    var enable = plan.enable === true;
    var disable = plan.disable === true;
    if (enable && disable) fail("bad_args", "plan can't both enable and disable remapping");
    var writesKeys = plan.keys !== undefined && plan.keys !== null;
    var writesFrames = plan.per_frame !== undefined && plan.per_frame !== null;
    var setsExpression = typeof plan.expression === "string";
    if (writesKeys && writesFrames) fail("bad_args", "plan can't give both keys and per_frame");
    if (disable && (writesKeys || writesFrames || setsExpression)) fail("bad_args", "plan can't write keys or an expression while disabling remapping");
    if ((writesKeys || writesFrames || setsExpression) && !enable && !wasEnabled) fail("bad_args", "plan writes remap keys but remapping is off and the plan doesn't enable it");
    if (enable && !wasEnabled) {
      try {
        if (layer.canSetTimeRemapEnabled === false) fail("bad_args", "After Effects says time remapping can't be enabled on \"" + layer.name + "\"");
      } catch (eCan) {
        if (eCan.__kind) throw eCan;
      }
    }
    if (disable && !wasEnabled) fail("bad_args", "Time remapping is already off on \"" + layer.name + "\"");

    if (writesKeys) checkKeys(plan.keys, duration, comp.frameDuration);
    if (writesFrames) checkPerFrame(plan.per_frame, duration, comp.frameDuration);
    if (setsExpression && plan.expression.length > 2000) fail("bad_args", "expression is longer than 2000 characters");
    if (wasEnabled && (writesKeys || writesFrames)) {
      var existing = remapProp(layer);
      var vals = [];
      var j;
      if (writesKeys) {
        for (j = 0; j < plan.keys.length; j++) vals.push(plan.keys[j].value);
      } else {
        vals = plan.per_frame.values;
      }
      if (existing) checkPropLimits(existing, vals);
    }

    var stretch = null;
    if (plan.stretch !== undefined && plan.stretch !== null) {
      stretch = plan.stretch;
      if (!isNum(stretch) || stretch === 0 || Math.abs(stretch) < 1 || Math.abs(stretch) > 9900) {
        fail("bad_args", "stretch must be a number with an absolute value in 1..9900 (percent)");
      }
      // With remapping on, the remap keys own the timing.
      if ((wasEnabled && !disable) || enable) fail("bad_args", "stretch can't be changed while time remapping is on");
    }
    // Work out the kept in point's new start time now, from values read before any
    // write, so AE's +/-10800 s start time limit is checked before the undo group.
    var inBefore = null;
    var newStart = null;
    var startBefore = null;
    if (stretch !== null) {
      inBefore = layer.inPoint;
      var outBefore = layer.outPoint;
      startBefore = layer.startTime;
      var strBefore = layer.stretch;
      if (plan.keep_in_point === true && strBefore !== 0) {
        var offA;
        var offB;
        if (strBefore > 0) {
          offA = (inBefore - startBefore) * 100 / strBefore;
          offB = (outBefore - startBefore) * 100 / strBefore;
        } else {
          offA = (outBefore - startBefore) * 100 / strBefore;
          offB = (inBefore - startBefore) * 100 / strBefore;
        }
        var offIn = offA;
        if (stretch < 0) offIn = offB;
        newStart = inBefore - stretch / 100 * offIn;
        if (!isNum(newStart) || Math.abs(newStart) > 10800) {
          fail("bad_args", "keeping the in point would put the start time at " + (Math.round(newStart * 1000) / 1000) + " s, outside +/-10800 s");
        }
      }
    }
    var inPoint = null;
    var outPoint = null;
    if (plan.in_point !== undefined && plan.in_point !== null) {
      if (!isNum(plan.in_point) || Math.abs(plan.in_point) > 10800) fail("bad_args", "in_point must be a number of seconds in +/-10800");
      inPoint = plan.in_point;
    }
    if (plan.out_point !== undefined && plan.out_point !== null) {
      if (!isNum(plan.out_point) || Math.abs(plan.out_point) > 10800) fail("bad_args", "out_point must be a number of seconds in +/-10800");
      outPoint = plan.out_point;
    }
    if (inPoint !== null && outPoint !== null && !(outPoint > inPoint)) fail("bad_args", "out_point must be after in_point");
    if (!enable && !disable && !writesKeys && !writesFrames && !setsExpression && stretch === null && inPoint === null && outPoint === null) {
      fail("bad_args", "the plan changes nothing");
    }

    return A.withUndo(args.label || "Time remap", function () {
      var enabledHere = false;
      var keysWritten = 0;
      var prop = null;
      try {
        if (disable) layer.timeRemapEnabled = false;
        if (enable && !wasEnabled) {
          layer.timeRemapEnabled = true;
          enabledHere = true;
        }
        if (writesKeys || writesFrames || setsExpression) {
          prop = remapProp(layer);
          if (!prop) fail("bad_args", "\"" + layer.name + "\" has no Time Remap property after enabling it");
        }
        if (writesKeys) {
          keysWritten = writeKeys(prop, plan.keys);
        }
        if (writesFrames) {
          keysWritten = writePerFrame(prop, plan.per_frame);
        }
        if (setsExpression) prop.expression = plan.expression;
        if (stretch !== null) {
          layer.stretch = stretch;
          // The start time was solved above from values read before the write
          // (a read after it can be stale); set it outright.
          if (newStart !== null && Math.abs(newStart - startBefore) > 1e-9) layer.startTime = newStart;
        }
        if (inPoint !== null) layer.inPoint = inPoint;
        if (outPoint !== null) layer.outPoint = outPoint;
      } catch (err) {
        // Remapping was off before this call: put it back, so a failed call
        // leaves the layer as it was.
        if (enabledHere) {
          try { layer.timeRemapEnabled = false; } catch (eBack) {}
        }
        throw err;
      }
      return {
        layer: { index: layer.index, id: layer.id, name: layer.name },
        operation: plan.operation,
        enabled_here: enabledHere,
        keys_written: keysWritten,
        snapshot: plan.snapshot
      };
    });
  };
})($.global);
