// panel/host/ext/audio.jsx
//
// Host functions for the audio tools:
// - audioCompInfo (read): what aerender needs to render a comp's audio
//   (unique name, length, frame rate, work area) and which layers carry sound
// - keysSnapshot (read): a property's keyframes in a time range
// - cueKeys (guarded write): keyframes on cue times (beats, onsets, words),
//   planned on the server, set with one setValuesAtTimes and eased
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

  var MAX_KEYS = 500;
  var MAX_LIST = 100;

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

  function resolvePath(layer, path) {
    var p = layer;
    for (var i = 0; i < path.length; i++) {
      var next = null;
      try {
        next = p.property(path[i]);
      } catch (e) {
        next = null;
      }
      if (!next) fail("not_found", "Property path not found at \"" + path[i] + "\" (" + path.join(" > ") + ")");
      p = next;
    }
    if (p.propertyType !== PropertyType.PROPERTY) fail("bad_args", "\"" + path.join(" > ") + "\" is a group, not a property");
    return p;
  }

  function plain(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
    if (v instanceof Array) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push(plain(v[i]));
      return out;
    }
    return String(v);
  }

  function easeDims(p) {
    try {
      if (p.isSpatial) return 1;
    } catch (e1) {}
    var pvt = p.propertyValueType;
    if (pvt === PropertyValueType.ThreeD) return 3;
    if (pvt === PropertyValueType.TwoD) return 2;
    return 1;
  }

  // How many numbers a property's value takes: [1] one, [2], [2, 3] for 3D (a 2D layer takes two), [4] a colour; null: not a number.
  function valueDims(p) {
    var t = p.propertyValueType;
    if (t === PropertyValueType.OneD) return [1];
    if (t === PropertyValueType.TwoD || t === PropertyValueType.TwoD_SPATIAL) return [2];
    if (t === PropertyValueType.ThreeD || t === PropertyValueType.ThreeD_SPATIAL) return [2, 3];
    if (t === PropertyValueType.COLOR) return [4];
    return null;
  }

  // The value in the shape the property takes, or bad_args; checked before anything is changed.
  function fitValue(p, v, what) {
    var dims = valueDims(p);
    if (!dims) fail("bad_args", "\"" + p.name + "\" does not take a numeric value");
    var n = 0;
    var i;
    if (Object.prototype.toString.call(v) === "[object Array]") {
      n = v.length;
      for (i = 0; i < n; i++) {
        if (typeof v[i] !== "number" || !isFinite(v[i])) fail("bad_args", what + " has a value that is not a number");
      }
      if (dims[0] === 1 && n === 1) return v[0];
    } else if (typeof v !== "number" || !isFinite(v)) {
      fail("bad_args", what + " is not a number");
    } else if (dims[0] === 1) {
      return v;
    }
    var ok = false;
    for (i = 0; i < dims.length; i++) {
      if (n === dims[i]) ok = true;
    }
    if (!ok) {
      fail("bad_args", what + " does not fit \"" + p.name + "\": it takes " + dims.join(" or ") + " number" + (dims[0] === 1 ? "" : "s") + (n ? ", got " + n : ", got a single number"));
    }
    return v;
  }

  // Sets the ease on one key with the length AE reports for it, falling back through the likely lengths.
  function setEase(p, idx) {
    var lens = [];
    try { lens.push(p.keyInTemporalEase(idx).length); } catch (eLen) {}
    lens.push(easeDims(p), 1, 2, 3);
    var tried = {};
    var last = null;
    for (var i = 0; i < lens.length; i++) {
      var n = lens[i];
      if (!n || tried[n]) continue;
      tried[n] = true;
      try {
        p.setTemporalEaseAtKey(idx, easeArray(0, 33.333, n), easeArray(0, 33.333, n));
        return;
      } catch (eSet) {
        last = eSet;
      }
    }
    throw last;
  }

  function easeArray(speed, influence, dims) {
    var arr = [];
    for (var i = 0; i < dims; i++) arr.push(new KeyframeEase(speed, influence));
    return arr;
  }

  A.audioCompInfo = function (args) {
    var comp = requireComp(args.comp_id);
    var sameName = 0;
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it instanceof CompItem && it.name === comp.name) sameName++;
    }
    var layers = [];
    for (var j = 1; j <= comp.numLayers && layers.length < MAX_LIST; j++) {
      var l = comp.layer(j);
      var sounds = false;
      try { sounds = l.hasAudio === true && l.audioEnabled === true; } catch (eA) {}
      if (sounds) layers.push({ index: l.index, id: l.id, name: l.name, inPoint: l.inPoint, outPoint: l.outPoint });
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
      audio_layers: layers,
      project_path: "<unsaved>",
      dirty: null
    };
    try { out.display_start_time = comp.displayStartTime; } catch (eD) {}
    try { if (app.project.file) out.project_path = app.project.file.fsName; } catch (eP) {}
    try { out.dirty = app.project.dirty === true; } catch (eDirty) {}
    return out;
  };

  A.keysSnapshot = function (args) {
    var comp = requireComp(args.comp_id);
    var prop = resolvePath(findLayer(comp, args.layer), args.path);
    var lo = -1e9;
    var hi = 1e9;
    if (args.start !== undefined && args.start !== null) lo = args.start;
    if (args.end !== undefined && args.end !== null) hi = args.end;
    // A caller verifying a write may read more than the usual list bound, never more than the cue-key cap.
    var limit = MAX_KEYS;
    if (typeof args.max === "number" && args.max > 0) limit = Math.min(Math.floor(args.max), 3 * MAX_KEYS);
    var out = { numKeys: prop.numKeys, keys: [], truncated: false, value: null };
    // The match name lets ae_remove_keyframes' dry run see a Time Remap target.
    try { out.match_name = String(prop.matchName); } catch (eM) {}
    if (prop.numKeys === 0) {
      try { out.value = plain(prop.value); } catch (eV) {}
    }
    for (var i = 1; i <= prop.numKeys; i++) {
      var t = prop.keyTime(i);
      if (t < lo - 0.0005 || t > hi + 0.0005) continue;
      if (out.keys.length >= limit) {
        out.truncated = true;
        break;
      }
      out.keys.push({ index: i, time: t, value: plain(prop.keyValue(i)) });
    }
    return out;
  };

  // AE throws mid-write for a value past a property's hard limits (Opacity 0..100,
  // slider ranges), so values are checked against them before anything changes.
  function checkLimits(prop, value, what) {
    var lo = null;
    var hi = null;
    try { if (prop.hasMin) lo = prop.minValue; } catch (e1) { lo = null; }
    try { if (prop.hasMax) hi = prop.maxValue; } catch (e2) { hi = null; }
    if (lo === null && hi === null) return;
    var list = value;
    if (!(value instanceof Array)) list = [value];
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] !== "number") continue;
      if (lo !== null && list[i] < lo) fail("bad_args", what + " " + list[i] + " is below the minimum of \"" + prop.name + "\" (" + lo + ")");
      if (hi !== null && list[i] > hi) fail("bad_args", what + " " + list[i] + " is above the maximum of \"" + prop.name + "\" (" + hi + ")");
    }
  }

  A.cueKeys = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var prop = resolvePath(layer, args.path);
    if (!prop.canVaryOverTime) fail("bad_args", "\"" + prop.name + "\" can't be keyframed");
    var keys = args.keys || [];
    if (keys.length === 0) fail("bad_args", "No keys to set");
    if (keys.length > 3 * MAX_KEYS) fail("bad_args", "Too many keys in one call");
    // A base left out is the property's own value where the cues start (before any expression).
    var base = args.base;
    if (base === undefined || base === null) base = plain(prop.valueAtTime(keys[0].time, true));
    // Everything that can fail is checked before the undo group, so no key is removed and then left half done.
    if (!valueDims(prop)) fail("bad_args", "\"" + prop.name + "\" does not take a numeric value");
    base = fitValue(prop, base, "base");
    var vals = [];
    for (var s = 0; s < keys.length; s++) {
      if (keys[s].value === null || keys[s].value === undefined) vals.push(base);
      else vals.push(fitValue(prop, keys[s].value, "peak"));
    }
    checkLimits(prop, base, "base");
    for (var v = 0; v < vals.length; v++) checkLimits(prop, vals[v], "peak");
    var separated = false;
    try { separated = prop.dimensionsSeparated === true; } catch (eSep) { separated = false; }
    if (separated) fail("bad_args", "\"" + prop.name + "\" has separated dimensions; key its X and Y properties instead");
    // Hold-only properties (checkboxes, dropdowns) take no BEZIER or LINEAR keys.
    var wantType = KeyframeInterpolationType.BEZIER;
    if (args.ease === "linear") wantType = KeyframeInterpolationType.LINEAR;
    var interpOk = true;
    try { interpOk = prop.isInterpolationTypeValid(wantType) !== false; } catch (eIv) { interpOk = true; }
    return A.withUndo(args.label || "Keys on cues", function () {
      var cleared = 0;
      if (args.clear_range) {
        for (var c = prop.numKeys; c >= 1; c--) {
          var kt = prop.keyTime(c);
          if (kt >= args.clear_range[0] - 0.0005 && kt <= args.clear_range[1] + 0.0005) {
            prop.removeKey(c);
            cleared++;
          }
        }
      }
      var times = [];
      for (var i = 0; i < keys.length; i++) times.push(keys[i].time);
      prop.setValuesAtTimes(times, vals);
      // The keys exist now; a rejected interpolation or ease is reported, not thrown.
      var easeWarning = null;
      if (!interpOk) easeWarning = "\"" + prop.name + "\" only takes hold keys; interpolation and ease left as they are";
      for (var k = 0; interpOk && k < times.length; k++) {
        var idx = prop.nearestKeyIndex(times[k]);
        try {
          prop.setInterpolationTypeAtKey(idx, wantType, wantType);
          if (wantType === KeyframeInterpolationType.BEZIER) setEase(prop, idx);
        } catch (eEase) {
          if (easeWarning === null) easeWarning = "Ease not applied at key " + idx + ": " + eEase.toString();
        }
      }
      return { set: times.length, cleared: cleared, base: base, ease_warning: easeWarning, property: prop.name, layer: { index: layer.index, id: layer.id, name: layer.name } };
    });
  };
})($.global);
