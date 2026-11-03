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
    if (pvt === PropertyValueType.COLOR) return 4;
    return 1;
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
    var out = { numKeys: prop.numKeys, keys: [], truncated: false, value: null };
    if (prop.numKeys === 0) {
      try { out.value = plain(prop.value); } catch (eV) {}
    }
    for (var i = 1; i <= prop.numKeys; i++) {
      var t = prop.keyTime(i);
      if (t < lo - 0.0005 || t > hi + 0.0005) continue;
      if (out.keys.length >= MAX_KEYS) {
        out.truncated = true;
        break;
      }
      out.keys.push({ index: i, time: t, value: plain(prop.keyValue(i)) });
    }
    return out;
  };

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
      var values = [];
      for (var i = 0; i < keys.length; i++) {
        times.push(keys[i].time);
        if (keys[i].value === null || keys[i].value === undefined) values.push(base);
        else values.push(keys[i].value);
      }
      prop.setValuesAtTimes(times, values);
      var dims = easeDims(prop);
      for (var k = 0; k < times.length; k++) {
        var idx = prop.nearestKeyIndex(times[k]);
        if (args.ease === "linear") {
          prop.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        } else {
          prop.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
          prop.setTemporalEaseAtKey(idx, easeArray(0, 33.333, dims), easeArray(0, 33.333, dims));
        }
      }
      return { set: times.length, cleared: cleared, base: base, property: prop.name, layer: { index: layer.index, id: layer.id, name: layer.name } };
    });
  };
})($.global);
