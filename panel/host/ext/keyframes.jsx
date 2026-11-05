// panel/host/ext/keyframes.jsx
//
// Host functions for the keyframe tools:
// - removeKeys (guarded write): all of a property's keys, a list of them, or
//   those in a time range. With every key gone, the property keeps the value
//   it had at one moment (AE's stopwatch uses the current time).
//   Removing every Time Remap key is refused: AE would switch remapping off and hide the property.
// ae_get_keyframes reads through getKeyframeEase (animate.jsx), and the
// read-backs through keysSnapshot (audio.jsx).
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

  A.removeKeys = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var prop = resolvePath(layer, args.path);
    var want = {};
    var hasList = false;
    if (args.keys) {
      for (var w = 0; w < args.keys.length; w++) {
        if (args.keys[w] < 1 || args.keys[w] > prop.numKeys) fail("bad_args", "Key " + args.keys[w] + " out of range (1.." + prop.numKeys + ")");
        want[args.keys[w]] = true;
        hasList = true;
      }
    }
    var picked = [];
    for (var i = 1; i <= prop.numKeys; i++) {
      var t = prop.keyTime(i);
      var match = args.all === true;
      if (!match && hasList && want[i]) match = true;
      if (!match && !hasList && (args.start !== undefined || args.end !== undefined)) {
        match = true;
        if (args.start !== undefined && args.start !== null && t < args.start - 0.0005) match = false;
        if (args.end !== undefined && args.end !== null && t > args.end + 0.0005) match = false;
      }
      if (match) picked.push(i);
    }
    if (picked.length === 0) fail("bad_args", "No keys match that selection; the property has " + prop.numKeys + " key(s)");
    var keepAll = picked.length > 0 && picked.length === prop.numKeys;
    // Removing the last key of Time Remap makes After Effects switch time remapping off and hide
    // the property (seen live: layer.timeRemapEnabled turned false, setValue then threw "hidden").
    // That is what ae_time_remap disable does on purpose, so it is refused here, before anything changes.
    if (keepAll && prop.matchName === "ADBE Time Remapping") {
      fail("bad_args", "Removing every Time Remap key makes After Effects switch time remapping off. Keep at least one key, or use ae_time_remap with operation disable to switch it off on purpose.");
    }
    // The value to keep once every key is gone, read before anything changes.
    var keepValue = null;
    var keepAt = null;
    if (keepAll && prop.propertyValueType !== PropertyValueType.CUSTOM_VALUE) {
      keepAt = comp.time;
      if (args.static_value_at !== undefined && args.static_value_at !== null) keepAt = args.static_value_at;
      try { keepValue = prop.valueAtTime(keepAt, true); } catch (eKeep) { keepValue = null; }
    }
    return A.withUndo(args.label || "Remove keyframes", function () {
      var removed = [];
      for (var k = picked.length - 1; k >= 0; k--) {
        var idx = picked[k];
        removed.push({ index: idx, time: prop.keyTime(idx), value: plain(prop.keyValue(idx)) });
        prop.removeKey(idx);
      }
      removed.reverse();
      var out = { removed: removed, numKeys: prop.numKeys, property: prop.name };
      if (keepAll && keepValue !== null && prop.numKeys === 0) {
        // A property that After Effects hides once its keys are gone refuses setValue; the keys
        // are already removed then, so the call reports that instead of throwing.
        var wrote = false;
        try {
          prop.setValue(keepValue);
          wrote = true;
        } catch (eSet) {
          out.static_value_error = String(eSet);
        }
        // Text and shape values flatten to "[object ...]", which proves nothing: not reported.
        if (wrote && (typeof keepValue === "number" || keepValue instanceof Array)) {
          out.static_value = plain(keepValue);
          out.static_value_at = keepAt;
        }
      }
      return out;
    });
  };

  // keyframesSelection (read): the property's selected keys, for ae_remove_keyframes keys: "selected".
  // Property.selectedKeys lists the 1-based indexes; without it each key is asked (keySelected).
  // Changes nothing in AE.
  A.keyframesSelection = function (args) {
    var comp = requireComp(args.comp_id);
    var prop = resolvePath(findLayer(comp, args.layer), args.path);
    var out = { numKeys: prop.numKeys, selected_keys: [], times: [], source: "none" };
    var idx = [];
    var viaList = false;
    try {
      var list = prop.selectedKeys;
      if (list && list.length !== undefined) {
        for (var a = 0; a < list.length; a++) idx.push(list[a]);
        viaList = true;
        out.source = "selectedKeys";
      }
    } catch (eList) {
      viaList = false;
    }
    if (!viaList) {
      for (var k = 1; k <= prop.numKeys; k++) {
        try {
          if (prop.keySelected(k) === true) idx.push(k);
          out.source = "keySelected";
        } catch (eKey) {
          break;
        }
      }
    }
    idx.sort(function (x, y) { return x - y; });
    for (var i = 0; i < idx.length && i < 500; i++) {
      if (idx[i] < 1 || idx[i] > prop.numKeys) continue;
      out.selected_keys.push(idx[i]);
      out.times.push(prop.keyTime(idx[i]));
    }
    if (idx.length > 500) out.truncated = true;
    return out;
  };

  // keysSnapshot for the read-backs of removeKeys: with no keys left, `value`
  // is the one before any expression, which is what removeKeys wrote with
  // setValue (prop.value would carry a wiggle on top). Read-only.
  A.keysSnapshotStatic = function (args) {
    var out = A.keysSnapshot(args);
    if (out.numKeys === 0) {
      var comp = requireComp(args.comp_id);
      var prop = resolvePath(findLayer(comp, args.layer), args.path);
      try { out.value = plain(prop.valueAtTime(comp.time, true)); } catch (eStatic) {}
    }
    return out;
  };
})($.global);
