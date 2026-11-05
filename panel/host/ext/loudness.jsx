// panel/host/ext/loudness.jsx
//
// Host functions for the loudness tools:
// - loudnessRead (read): the comp's facts aerender needs to render its audio
//   (unique name, length, frame rate, project path) and every layer with sound:
//   its Audio Levels value or keys, the property's limits, lock and expression
// - loudnessApply (guarded write): a gain in dB on the Audio Levels of the
//   audio layers (existing level keys are offset, never overwritten), plus
//   optional fade in / fade out keys merged with them. A fade runs over the comp's first and last seconds by default
//   (fade_scope "comp": a layer gets the part of the ramp that falls on it), or at each layer's own points ("layer"); level keys inside a fade follow it.
//
// The loudness measurement itself runs on the server, on the audio aerender
// rendered; this file only reads and sets levels.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Everything that can fail is checked before the undo group opens.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var MAX_KEYS = 500;
  var MAX_PLAN_KEYS = 500;
  var MAX_REPORT_KEYS = 5000;
  var MAX_READ_KEYS = 5000;
  var DEFAULT_FLOOR_DB = -96;

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

  function plain(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
    if (isArray(v)) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push(plain(v[i]));
      return out;
    }
    return String(v);
  }

  // The layer's Audio Levels property, or null for a layer without sound.
  function levelsOf(layer) {
    var grp = null;
    var prop = null;
    try {
      grp = layer.property("ADBE Audio Group");
    } catch (e1) {
      grp = null;
    }
    if (!grp) return null;
    try {
      prop = grp.property("ADBE Audio Levels");
    } catch (e2) {
      prop = null;
    }
    return prop;
  }

  function hasSound(layer) {
    try {
      return layer.hasAudio === true;
    } catch (e) {
      return false;
    }
  }

  function soundOn(layer) {
    try {
      return layer.audioEnabled === true;
    } catch (e) {
      return false;
    }
  }

  function isLocked(layer) {
    try {
      return layer.locked === true;
    } catch (e) {
      return false;
    }
  }

  // A limit of the property as one number (a TwoD property may report a pair), or null when it has none.
  function limit(prop, which) {
    var v = null;
    try {
      if (which === "min" && prop.hasMin) v = prop.minValue;
      if (which === "max" && prop.hasMax) v = prop.maxValue;
    } catch (e) {
      v = null;
    }
    if (isArray(v)) v = v[0];
    if (typeof v !== "number" || !isFinite(v)) return null;
    return v;
  }

  function hasExpression(prop) {
    try {
      return prop.expressionEnabled === true;
    } catch (e) {
      return false;
    }
  }

  function layerKind(layer) {
    var l = layer;
    var rn = "";
    try {
      if (l.reflect && l.reflect.name) rn = String(l.reflect.name);
    } catch (eR) {}
    if (rn === "ThreeDModelLayer") return "model_3d";
    if (rn === "ParametricMeshLayer") return "parametric_mesh";
    try {
      if (typeof ThreeDModelLayer !== "undefined" && l instanceof ThreeDModelLayer) return "model_3d";
    } catch (eM1) {}
    try {
      if (typeof ParametricMeshLayer !== "undefined" && l instanceof ParametricMeshLayer) return "parametric_mesh";
    } catch (eM2) {}
    try {
      if (layer.source && layer.source instanceof CompItem) return "precomp";
    } catch (e1) {}
    try {
      if (layer.hasVideo === false) return "audio";
    } catch (e2) {}
    return "footage";
  }

  // budget.left is the total number of keys a whole read may still return (all layers together).
  function levelsInfo(layer, budget, skipKeys) {
    var prop = levelsOf(layer);
    if (!prop) return null;
    var out = { value: null, num_keys: 0, keys: [], keys_truncated: false, min: limit(prop, "min"), max: limit(prop, "max"), expression: hasExpression(prop) };
    var n = 0;
    try {
      n = prop.numKeys;
    } catch (e1) {
      n = 0;
    }
    out.num_keys = n;
    if (n === 0) {
      try {
        out.value = plain(prop.value);
      } catch (e2) {}
      return out;
    }
    if (skipKeys) {
      out.keys_truncated = true;
      return out;
    }
    for (var i = 1; i <= n; i++) {
      if (out.keys.length >= MAX_KEYS || budget.left <= 0) {
        out.keys_truncated = true;
        break;
      }
      budget.left--;
      out.keys.push({ time: prop.keyTime(i), value: plain(prop.keyValue(i)) });
    }
    return out;
  }

  A.loudnessRead = function (args) {
    var comp = requireComp(args.comp_id);
    var sameName = 0;
    var i;
    for (i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it instanceof CompItem && it.name === comp.name) sameName++;
    }
    var layers = [];
    var truncated = false;
    var budget = { left: MAX_READ_KEYS };
    var skipKeys = args.skip_keys === true;
    for (i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      if (!hasSound(l)) continue;
      if (layers.length >= MAX_LAYERS) {
        truncated = true;
        break;
      }
      layers.push({
        index: l.index,
        id: l.id,
        name: l.name,
        kind: layerKind(l),
        audio_enabled: soundOn(l),
        locked: isLocked(l),
        inPoint: l.inPoint,
        outPoint: l.outPoint,
        levels: levelsInfo(l, budget, skipKeys)
      });
    }
    var out = {
      comp_id: comp.id,
      name: comp.name,
      name_unique: sameName === 1,
      duration: comp.duration,
      fps: comp.frameRate,
      frame_duration: comp.frameDuration,
      display_start_time: 0,
      work_area_start: comp.workAreaStart,
      work_area_duration: comp.workAreaDuration,
      layers: layers,
      truncated: truncated,
      project_path: "<unsaved>",
      dirty: null
    };
    try { out.display_start_time = comp.displayStartTime; } catch (eD) {}
    try { if (app.project.file) out.project_path = app.project.file.fsName; } catch (eP) {}
    try { out.dirty = app.project.dirty === true; } catch (eDirty) {}
    return out;
  };

  function num(v, what) {
    if (typeof v !== "number" || !isFinite(v)) fail("bad_args", what + " is not a number");
    return v;
  }

  // The level pair with `gain` dB added. A channel at the property's floor is silence and stays silent;
  // past the maximum is refused (clamping would change the loudness quietly), below the floor is clamped.
  function shifted(value, gain, lo, hi, who, state) {
    if (!isArray(value) || value.length < 1) fail("bad_args", "\"" + who + "\" has an Audio Levels value of an unexpected shape");
    var out = [];
    for (var c = 0; c < value.length; c++) {
      var v = value[c];
      if (typeof v !== "number") fail("bad_args", "\"" + who + "\" has an Audio Levels value that is not a number");
      var r = v;
      if (!(lo !== null && v <= lo + 0.0001)) r = v + gain;
      if (hi !== null && r > hi + 0.000001) {
        fail("bad_args", "\"" + who + "\": " + (Math.round(r * 100) / 100) + " dB is above the Audio Levels maximum of " + hi + " dB. Use a smaller gain.");
      }
      if (lo !== null && r < lo) {
        r = lo;
        state.clamped = true;
      }
      out.push(r);
    }
    return out;
  }

  function pairOf(value, db) {
    var out = [];
    for (var i = 0; i < value.length; i++) out.push(db);
    return out;
  }

  // The level partway (fraction f, 0..1) from the fade's floor to the level, per channel.
  function blendToward(level, floor, f) {
    var out = [];
    if (f >= 1) {
      for (var k = 0; k < level.length; k++) out.push(level[k]);
      return out;
    }
    for (var c = 0; c < level.length; c++) {
      var base = floor;
      if (level[c] < base) base = level[c];
      out.push(base + (level[c] - base) * f);
    }
    return out;
  }

  // Everything one layer's write needs, worked out and checked before the undo group opens.
  // A fade runs from rs to re: scope "comp" uses the comp's range (rangeStart .. rangeEnd) for every
  // layer, so a layer that is only there for part of a fade gets the part of the ramp that falls on it;
  // scope "layer" uses the layer's own in and out points.
  function planLayer(layer, prop, o) {
    var who = layer.name;
    var lo = limit(prop, "min");
    var hi = limit(prop, "max");
    var state = { clamped: false };
    var rs = layer.inPoint;
    var re = layer.outPoint;
    var tol = 0.000000001;
    if (o.scope === "comp") {
      rs = o.rangeStart;
      re = o.rangeEnd;
      tol = o.eps;
    }
    var a = Math.max(layer.inPoint, rs);
    var b = Math.min(layer.outPoint, re);
    var fadeIn = o.fadeIn;
    var fadeOut = o.fadeOut;
    if (fadeIn + fadeOut > re - rs + 0.000001) {
      if (o.scope === "comp") {
        fail("bad_args", "The fades add up to " + (fadeIn + fadeOut) + " s, but the comp is " + (Math.round((re - rs) * 1000) / 1000) + " s long");
      }
      fail("bad_args", "\"" + who + "\" is audible for " + (Math.round((re - rs) * 1000) / 1000) + " s; the fades on it add up to " + (fadeIn + fadeOut) + " s");
    }
    // A fade that ends before the layer starts, or starts after it ends, does not touch it.
    if (b <= a) {
      fadeIn = 0;
      fadeOut = 0;
    } else {
      if (a >= rs + fadeIn - tol) fadeIn = 0;
      if (b <= re - fadeOut + tol) fadeOut = 0;
    }
    var n = prop.numKeys;
    if (n > MAX_PLAN_KEYS) fail("bad_args", "\"" + who + "\" has " + n + " Audio Levels keys; this tool offsets at most " + MAX_PLAN_KEYS);
    var floor = o.floor;
    if (lo !== null && floor < lo) floor = lo;
    var plan = { mode: "keys", existing: [], added: [], staticValue: null, clamped: false, finalKeys: [], fadeIn: fadeIn, fadeOut: fadeOut, noop: false };
    var i;
    if (o.gain === 0 && fadeIn === 0 && fadeOut === 0) {
      plan.noop = true;
      return plan;
    }
    // How far along the fades the layer is at time t: 0 at the floor, 1 at full level.
    function frac(t) {
      var f = 1;
      var x;
      if (fadeIn > 0) {
        x = (t - rs) / fadeIn;
        if (x < f) f = x;
      }
      if (fadeOut > 0) {
        x = (re - t) / fadeOut;
        if (x < f) f = x;
      }
      if (f < 0) f = 0;
      return f;
    }
    if (n === 0 && fadeIn === 0 && fadeOut === 0) {
      plan.mode = "static";
      plan.staticValue = shifted(plain(prop.value), o.gain, lo, hi, who, state);
      plan.clamped = state.clamped;
      return plan;
    }
    // The times that get a key of their own: the layer's ends where a fade is still running, and where
    // each fade reaches full level. Baseline reads first: nothing is written until every value is known and in range.
    var times = [];
    if (frac(a) < 1 - 0.000000001) times.push(a);
    if (fadeIn > 0 && rs + fadeIn > a + 0.000000001 && rs + fadeIn < b - 0.000000001) times.push(rs + fadeIn);
    if (fadeOut > 0 && re - fadeOut > a + 0.000000001 && re - fadeOut < b - 0.000000001) times.push(re - fadeOut);
    if (frac(b) < 1 - 0.000000001) times.push(b);
    var bases = [];
    for (i = 0; i < times.length; i++) bases.push(plain(prop.valueAtTime(times[i], false)));
    for (i = 1; i <= n; i++) {
      var kt = prop.keyTime(i);
      var kv = shifted(plain(prop.keyValue(i)), o.gain, lo, hi, who, state);
      // A key inside a fade follows the fade: its level is blended with the fade ramp, so the
      // ramp keeps the length that was asked for instead of ending at the first key in it.
      if (kt > a + 0.000000001 && kt < b - 0.000000001) kv = blendToward(kv, floor, frac(kt));
      plan.existing.push({ index: i, time: kt, value: kv });
    }
    // An added key never sits above the layer's own level: where the fade is at the floor it takes the lower of the floor and that level.
    for (i = 0; i < times.length; i++) {
      plan.added.push({ time: times[i], value: blendToward(shifted(bases[i], o.gain, lo, hi, who, state), floor, frac(times[i])) });
    }
    plan.clamped = state.clamped;
    // The keys the layer ends up with: the existing ones, then the added ones replacing any at the exact same time.
    var merged = [];
    for (i = 0; i < plan.existing.length; i++) merged.push({ time: plan.existing[i].time, value: plan.existing[i].value });
    for (i = 0; i < plan.added.length; i++) {
      var hit = -1;
      for (var m = 0; m < merged.length; m++) {
        if (Math.abs(merged[m].time - plan.added[i].time) < 0.000000001) hit = m;
      }
      if (hit >= 0) merged[hit] = { time: plan.added[i].time, value: plan.added[i].value };
      else merged.push({ time: plan.added[i].time, value: plan.added[i].value });
    }
    merged.sort(function (x, y) { return x.time - y.time; });
    plan.finalKeys = merged;
    return plan;
  }

  function setKeyValue(prop, plan) {
    var i;
    for (i = 0; i < plan.existing.length; i++) {
      var k = plan.existing[i];
      if (typeof prop.setValueAtKey === "function") prop.setValueAtKey(k.index, k.value);
      else prop.setValueAtTime(k.time, k.value);
    }
    for (i = 0; i < plan.added.length; i++) {
      prop.setValueAtTime(plan.added[i].time, plan.added[i].value);
    }
  }

  A.loudnessApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var gain = 0;
    if (args.gain_db !== undefined && args.gain_db !== null) gain = num(args.gain_db, "gain_db");
    var fadeIn = 0;
    var fadeOut = 0;
    if (args.fade_in !== undefined && args.fade_in !== null) fadeIn = num(args.fade_in, "fade_in");
    if (args.fade_out !== undefined && args.fade_out !== null) fadeOut = num(args.fade_out, "fade_out");
    var scope = "comp";
    if (args.fade_scope !== undefined && args.fade_scope !== null) scope = args.fade_scope;
    if (scope !== "comp" && scope !== "layer") fail("bad_args", "fade_scope is \"comp\" or \"layer\"");
    var floor = DEFAULT_FLOOR_DB;
    if (args.fade_floor_db !== undefined && args.fade_floor_db !== null) floor = num(args.fade_floor_db, "fade_floor_db");
    if (fadeIn < 0 || fadeOut < 0) fail("bad_args", "Fade lengths can't be negative");
    if (gain === 0 && fadeIn === 0 && fadeOut === 0) fail("bad_args", "Nothing to do: give a gain_db other than 0, or a fade_in or fade_out");

    var targets = [];
    var i;
    if (args.layers && args.layers.length) {
      for (i = 0; i < args.layers.length; i++) {
        var one = findLayer(comp, args.layers[i]);
        var dup = false;
        for (var d = 0; d < targets.length; d++) {
          if (targets[d].id === one.id) dup = true;
        }
        if (!dup) targets.push(one);
      }
    } else {
      for (i = 1; i <= comp.numLayers; i++) {
        var cand = comp.layer(i);
        if (hasSound(cand) && soundOn(cand)) targets.push(cand);
      }
    }
    if (targets.length === 0) fail("bad_args", "No layer with audio switched on in \"" + comp.name + "\"");
    if (targets.length > MAX_LAYERS) fail("bad_args", "More than " + MAX_LAYERS + " audio layers; name the layers to change");

    // Every layer is checked and planned before the first write.
    var plans = [];
    var eps = 0.000001;
    if (typeof comp.frameDuration === "number" && comp.frameDuration > 0) eps = comp.frameDuration / 2;
    var opts = { gain: gain, fadeIn: fadeIn, fadeOut: fadeOut, floor: floor, scope: scope, rangeStart: 0, rangeEnd: comp.duration, eps: eps };
    var skipped = [];
    for (i = 0; i < targets.length; i++) {
      var layer = targets[i];
      if (!hasSound(layer)) fail("bad_args", "\"" + layer.name + "\" has no audio");
      if (isLocked(layer)) fail("bad_args", "\"" + layer.name + "\" is locked; unlock it first");
      var prop = levelsOf(layer);
      if (!prop) fail("bad_args", "\"" + layer.name + "\" has no Audio Levels property");
      if (hasExpression(prop)) fail("bad_args", "\"" + layer.name + "\" has an expression on Audio Levels; remove it or change the expression");
      var planned = planLayer(layer, prop, opts);
      if (planned.noop) skipped.push(layer.name);
      else plans.push({ layer: layer, prop: prop, plan: planned });
    }
    if (plans.length === 0) {
      fail("bad_args", "Nothing to change: with gain_db 0 and fade_scope \"comp\", a fade only applies to layers that are there during the first fade_in seconds or the last fade_out seconds of the comp; none are. " +
        "Use fade_scope \"layer\" to fade each layer at its own in and out points.");
    }

    return A.withUndo(args.label || "Loudness gain and fades", function () {
      var done = [];
      var budget = MAX_REPORT_KEYS;
      for (var p = 0; p < plans.length; p++) {
        var item = plans[p];
        if (item.plan.mode === "static") item.prop.setValue(item.plan.staticValue);
        else setKeyValue(item.prop, item.plan);
        var reported = item.plan.finalKeys.slice(0, Math.min(MAX_PLAN_KEYS, budget));
        budget -= reported.length;
        done.push({
          index: item.layer.index,
          id: item.layer.id,
          name: item.layer.name,
          mode: item.plan.mode,
          value: item.plan.staticValue,
          keys: reported,
          key_count: item.plan.finalKeys.length,
          keys_truncated: reported.length < item.plan.finalKeys.length,
          fade_in: item.plan.fadeIn,
          fade_out: item.plan.fadeOut,
          clamped: item.plan.clamped
        });
      }
      return { gain_db: gain, fade_in: fadeIn, fade_out: fadeOut, fade_floor_db: floor, fade_scope: scope, skipped: skipped, layers: done };
    });
  };
})($.global);
