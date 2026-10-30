// panel/host/ext/effects.jsx
//
// Host functions for the effect tools:
// - listLayerEffects (read): a layer's effects with every parameter, and
//   whether a script can set it
// - addEffect / setEffect / removeEffect / applyPreset (guarded writes)
// - presetFolders (read): where AE keeps its .ffx animation presets
// - keyLayerInfo (read) / applyGreenScreenKey (guarded write): ae_key_greenscreen
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_EFFECTS = 100;
  var MAX_PARAMS = 300;
  var MAX_DEPTH = 4;
  var MAX_STRING = 2000;

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
      var byName = comp.layer(sel.name);
      if (!byName) fail("not_found", "No layer named \"" + sel.name + "\"");
      return byName;
    }
    fail("bad_args", "layer selector needs id, index or name");
    return null;
  }

  function effectParade(layer) {
    var parade = null;
    try {
      parade = layer.property("ADBE Effect Parade");
    } catch (e) {
      parade = null;
    }
    if (!parade) fail("bad_args", "Layer \"" + layer.name + "\" cannot hold effects");
    return parade;
  }

  // An effect by 1-based index or by name; a name shared by several effects is refused.
  function findEffect(parade, sel) {
    if (!sel) fail("bad_args", "effect selector missing");
    if (sel.index !== undefined && sel.index !== null) {
      if (sel.index < 1 || sel.index > parade.numProperties) {
        fail("not_found", "Effect index " + sel.index + " out of range (1.." + parade.numProperties + ")");
      }
      return parade.property(sel.index);
    }
    if (sel.name !== undefined && sel.name !== null) {
      var found = null;
      var count = 0;
      for (var i = 1; i <= parade.numProperties; i++) {
        if (parade.property(i).name === sel.name) {
          found = parade.property(i);
          count++;
        }
      }
      if (count === 0) fail("not_found", "No effect named \"" + sel.name + "\"");
      if (count > 1) fail("bad_args", count + " effects are named \"" + sel.name + "\"; select by index");
      return found;
    }
    fail("bad_args", "effect selector needs index or name");
    return null;
  }

  function valueTypeName(p) {
    var t = null;
    try {
      t = p.propertyValueType;
    } catch (e) {
      return "unknown";
    }
    if (t === PropertyValueType.NO_VALUE) return "none";
    if (t === PropertyValueType.CUSTOM_VALUE) return "custom";
    if (t === PropertyValueType.OneD) return "1d";
    if (t === PropertyValueType.TwoD) return "2d";
    if (t === PropertyValueType.TwoD_SPATIAL) return "2d_spatial";
    if (t === PropertyValueType.ThreeD) return "3d";
    if (t === PropertyValueType.ThreeD_SPATIAL) return "3d_spatial";
    if (t === PropertyValueType.COLOR) return "color";
    if (t === PropertyValueType.LAYER_INDEX) return "layer";
    if (t === PropertyValueType.MASK_INDEX) return "mask";
    if (t === PropertyValueType.SHAPE) return "shape";
    if (t === PropertyValueType.TEXT_DOCUMENT) return "text";
    if (t === PropertyValueType.MARKER) return "marker";
    return String(t);
  }

  // Types a script cannot set: arbitrary data such as Colorama's Output Cycle
  // or the Curves curve, and parameters that only group or label others.
  function settableType(typeName) {
    if (typeName === "none" || typeName === "custom" || typeName === "unknown") return false;
    if (typeName === "shape" || typeName === "text" || typeName === "marker") return false;
    return true;
  }

  function plainValue(v) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === "number" || t === "boolean") return v;
    if (t === "string") {
      if (v.length > MAX_STRING) return v.substring(0, MAX_STRING) + " ...[truncated]";
      return v;
    }
    if (v instanceof Array) {
      var out = [];
      for (var i = 0; i < v.length && i < 16; i++) out.push(plainValue(v[i]));
      return out;
    }
    try {
      return "[" + v.reflect.name + "]";
    } catch (e) {}
    return String(v);
  }

  function describeParams(group, prefix, depth, out, state) {
    for (var i = 1; i <= group.numProperties; i++) {
      if (state.count >= MAX_PARAMS) {
        state.truncated = true;
        return;
      }
      var p = group.property(i);
      var path = prefix.concat([p.name]);
      if (p.propertyType === PropertyType.PROPERTY) {
        var typeName = valueTypeName(p);
        // Valueless entries are the effect UI's section headers and end markers.
        if (typeName === "none") continue;
        var entry = {
          index: i,
          name: p.name,
          matchName: p.matchName,
          path: path,
          type: typeName,
          settable: settableType(typeName)
        };
        if (typeName !== "none" && typeName !== "custom") {
          try {
            entry.value = plainValue(p.value);
          } catch (eVal) {}
        }
        // Custom data can still come from an effect set up by hand, through an
        // expression on this parameter (measured on Colorama's Output Cycle).
        if (typeName === "custom") {
          try {
            entry.linkable_by_expression = p.canSetExpression === true;
          } catch (eLink) {}
        }
        try {
          if (p.numKeys > 0) entry.numKeys = p.numKeys;
        } catch (eKeys) {}
        try {
          if (p.expressionEnabled && p.expression) entry.expression = plainValue(p.expression);
        } catch (eExpr) {}
        out.push(entry);
        state.count++;
      } else if (depth < MAX_DEPTH) {
        describeParams(p, path, depth + 1, out, state);
      }
    }
  }

  function describeEffect(fx) {
    var params = [];
    var state = { count: 0, truncated: false };
    describeParams(fx, [], 0, params, state);
    var out = {
      index: fx.propertyIndex,
      name: fx.name,
      matchName: fx.matchName,
      enabled: fx.enabled,
      params: params
    };
    if (state.truncated) out.params_truncated = true;
    return out;
  }

  function describeLayerEffects(c, l) {
    var parade = effectParade(l);
    var effects = [];
    for (var i = 1; i <= parade.numProperties && i <= MAX_EFFECTS; i++) {
      effects.push(describeEffect(parade.property(i)));
    }
    var out = { comp_id: c.id, layer_id: l.id, layer_index: l.index, layer_name: l.name, effects: effects };
    if (parade.numProperties > MAX_EFFECTS) out.truncated = true;
    return out;
  }

  // A parameter by display name, match name, or 1-based index among the
  // effect's top-level properties; names are searched inside groups too.
  function findParam(fx, key) {
    if (typeof key === "number") {
      if (key < 1 || key > fx.numProperties) fail("not_found", "Parameter index " + key + " out of range on " + fx.name);
      return fx.property(key);
    }
    // A section header can share its name with the parameter under it
    // (Colorama's "Output Cycle"), so headers only match as a last resort.
    var header = null;
    var stack = [fx];
    while (stack.length > 0) {
      var g = stack.shift();
      for (var i = 1; i <= g.numProperties; i++) {
        var p = g.property(i);
        if (p.name === key || p.matchName === key) {
          if (p.propertyType !== PropertyType.PROPERTY || valueTypeName(p) !== "none") return p;
          if (!header) header = p;
        }
        if (p.propertyType !== PropertyType.PROPERTY) stack.push(p);
      }
    }
    if (header) return header;
    fail("not_found", "No parameter \"" + key + "\" on effect " + fx.name);
    return null;
  }

  function coerceValue(p, typeName, value) {
    if (typeName === "color" && value instanceof Array && value.length === 3) {
      return [value[0], value[1], value[2], 1];
    }
    if (typeof value === "boolean") {
      if (value) return 1;
      return 0;
    }
    return value;
  }

  // Sets static parameter values. Animated parameters get the value at the
  // comp's current time, as ae_set_property does.
  function applyParams(c, fx, params) {
    var done = [];
    if (!params) return done;
    for (var i = 0; i < params.length; i++) {
      var p = findParam(fx, params[i].param);
      if (p.propertyType !== PropertyType.PROPERTY) fail("bad_args", "\"" + params[i].param + "\" is a group, not a parameter");
      var typeName = valueTypeName(p);
      if (!settableType(typeName)) {
        fail(
          "bad_args",
          "Parameter \"" + p.name + "\" on " + fx.name + " holds " + typeName +
            " data that AE does not let scripts read or set. Ways in, all inside AE: link it with an expression to the same parameter of an effect set up by hand " +
            "(ae_set_property on the path ['ADBE Effect Parade', '" + fx.name + "', '" + p.matchName + "'] with an expression such as thisComp.layer(\"Look\").effect(\"" + fx.name + "\")(\"" + p.name + "\")); " +
            "apply an animation preset (.ffx) saved from AE with ae_apply_preset; " +
            "or use the effect's own preset menu if it has one (Colorama: Use Preset Palette)."
        );
      }
      var v = coerceValue(p, typeName, params[i].value);
      if (p.numKeys > 0) {
        p.setValueAtTime(c.time, v);
        done.push({ param: p.name, how: "value_at_current_time" });
      } else {
        p.setValue(v);
        done.push({ param: p.name, how: "value" });
      }
    }
    return done;
  }

  A.listLayerEffects = function (args) {
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    return describeLayerEffects(c, l);
  };

  A.addEffect = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var parade = effectParade(l);
    if (!parade.canAddProperty(args.effect)) {
      fail("not_found", "AE has no effect \"" + args.effect + "\" (use a match name or display name from ae_list_effects)");
    }
    return A.withUndo("Chroma AE MCP: add effect " + args.effect, function () {
      var fx = parade.addProperty(args.effect);
      if (args.name) fx.name = args.name;
      var done = applyParams(c, fx, args.params);
      return {
        comp_id: c.id,
        layer_id: l.id,
        index: fx.propertyIndex,
        name: fx.name,
        matchName: fx.matchName,
        params_set: done
      };
    });
  };

  A.setEffect = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var fx = findEffect(effectParade(l), args.effect);
    return A.withUndo("Chroma AE MCP: set effect " + fx.name, function () {
      if (args.enabled !== undefined && args.enabled !== null) fx.enabled = args.enabled === true;
      if (args.name) fx.name = args.name;
      var done = applyParams(c, fx, args.params);
      return {
        comp_id: c.id,
        layer_id: l.id,
        index: fx.propertyIndex,
        name: fx.name,
        matchName: fx.matchName,
        enabled: fx.enabled,
        params_set: done
      };
    });
  };

  A.removeEffect = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var fx = findEffect(effectParade(l), args.effect);
    var removed = { index: fx.propertyIndex, name: fx.name, matchName: fx.matchName };
    return A.withUndo("Chroma AE MCP: remove effect " + fx.name, function () {
      fx.remove();
      return { comp_id: c.id, layer_id: l.id, removed: removed };
    });
  };

  // applyPreset acts on the comp's selected layers, so the target is selected
  // alone for the call and the user's selection is put back afterwards.
  A.applyPreset = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var f = new File(args.preset_path);
    if (!f.exists) fail("not_found", "No preset file at " + args.preset_path);
    if (!/\.ffx$/i.test(f.name)) fail("bad_args", "Not an animation preset (.ffx): " + f.name);
    var before = c.numLayers;
    return A.withUndo("Chroma AE MCP: apply preset " + decodeURI(f.name), function () {
      var selected = [];
      var i;
      for (i = 1; i <= c.numLayers; i++) {
        if (c.layer(i).selected) selected.push(c.layer(i));
      }
      for (i = 0; i < selected.length; i++) selected[i].selected = false;
      l.selected = true;
      try {
        l.applyPreset(f);
      } finally {
        l.selected = false;
        for (i = 0; i < selected.length; i++) {
          try {
            selected[i].selected = true;
          } catch (eSel) {}
        }
      }
      return {
        comp_id: c.id,
        layer_id: l.id,
        preset: f.fsName,
        layers_added: c.numLayers - before
      };
    });
  };

  // ---------- Green screen keying (ae_key_greenscreen) ----------
  // Keylight's parameters are addressed by match name: several share a
  // display name (two "Replace Method", two "Saturation").

  var KEYLIGHT = "Keylight 906";
  var KEY_CLEANER = "ADBE KeyCleaner";
  var SPILL = "ADBE Spill2";
  var KEYLIGHT_PARAMS = {
    screen_gain: "Keylight 906-0005",
    screen_balance: "Keylight 906-0006",
    clip_black: "Keylight 906-0012",
    clip_white: "Keylight 906-0013",
    screen_shrink_grow: "Keylight 906-0015",
    screen_softness: "Keylight 906-0016"
  };

  function effectByMatchName(parade, matchName) {
    for (var i = 1; i <= parade.numProperties; i++) {
      if (parade.property(i).matchName === matchName) return parade.property(i);
    }
    return null;
  }

  // Read: the plate layer, its keyer, and any visible layer below it, which
  // would show through the key and spoil the alpha check.
  A.keyLayerInfo = function (args) {
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var parade = effectParade(l);
    var kl = effectByMatchName(parade, KEYLIGHT);
    var times = args.times || [];
    var below = [];
    for (var i = l.index + 1; i <= c.numLayers; i++) {
      var x = c.layer(i);
      var shows = false;
      try {
        shows = x.enabled && x.hasVideo && !x.adjustmentLayer && !x.guideLayer;
      } catch (eShow) {}
      if (!shows) continue;
      for (var t = 0; t < times.length; t++) {
        if (x.activeAtTime(times[t])) {
          below.push(x.name);
          break;
        }
      }
    }
    var keylight = null;
    if (kl) {
      keylight = { index: kl.propertyIndex, name: kl.name, enabled: kl.enabled, screen_colour: plainValue(kl.property("Keylight 906-0004").value) };
      for (var k in KEYLIGHT_PARAMS) {
        if (KEYLIGHT_PARAMS.hasOwnProperty(k)) keylight[k] = kl.property(KEYLIGHT_PARAMS[k]).value;
      }
    }
    var projectPath = "<unsaved>";
    if (app.project.file) projectPath = app.project.file.fsName;
    return {
      project_path: projectPath,
      comp: {
        id: c.id,
        width: c.width,
        height: c.height,
        fps: c.frameRate,
        workAreaStart: c.workAreaStart,
        workAreaDuration: c.workAreaDuration
      },
      layer: { id: l.id, index: l.index, name: l.name, inPoint: l.inPoint, outPoint: l.outPoint },
      keylight: keylight,
      has_key_cleaner: effectByMatchName(parade, KEY_CLEANER) !== null,
      has_spill_suppressor: effectByMatchName(parade, SPILL) !== null,
      layers_below_visible: below
    };
  };

  // Write: Keylight on the screen colour (reused if the layer has one), plus
  // Key Cleaner and Advanced Spill Suppressor when asked, in one undo group.
  A.applyGreenScreenKey = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var parade = effectParade(l);
    var col = args.screen_color;
    if (!(col instanceof Array) || col.length < 3) fail("bad_args", "screen_color must be [r, g, b] in 0..1");
    return A.withUndo("Chroma AE MCP: key " + l.name, function () {
      var added = [];
      var kl = effectByMatchName(parade, KEYLIGHT);
      if (!kl) {
        kl = parade.addProperty(KEYLIGHT);
        added.push(kl.name);
      }
      kl.property("Keylight 906-0004").setValue([col[0], col[1], col[2], 1]);
      for (var k in KEYLIGHT_PARAMS) {
        if (KEYLIGHT_PARAMS.hasOwnProperty(k) && args[k] !== undefined && args[k] !== null) {
          kl.property(KEYLIGHT_PARAMS[k]).setValue(args[k]);
        }
      }
      // Adding effects below invalidates `kl` ("Object is invalid", AE 26.2.1).
      var klIndex = kl.propertyIndex;
      if (args.cleanup) {
        if (!effectByMatchName(parade, KEY_CLEANER)) {
          added.push(parade.addProperty(KEY_CLEANER).name);
        }
        // Re-fetch the Effect Parade group itself: the measured trap in BUILDERS.md
        // only covers one addProperty invalidating a sibling effect's own reference
        // (`kl`, handled above via klIndex); it was never measured for a *second*
        // addProperty on the same undo step, so don't trust the group reference to
        // have survived the Key Cleaner add before looking up Spill in it.
        parade = effectParade(l);
        var sp = effectByMatchName(parade, SPILL);
        if (!sp) {
          sp = parade.addProperty(SPILL);
          added.push(sp.name);
        }
        // Ultra, which uses this Key Color. Standard picks its own and crushed
        // the blue of a navy subject (82 to 36 of 255, measured on AE 26.2.1).
        sp.property("ADBE Spill2-0001").setValue(2);
        sp.property("ADBE Spill2-0003").setValue([col[0], col[1], col[2], 1]);
      }
      return { comp_id: c.id, layer_id: l.id, keylight_index: klIndex, added: added };
    });
  };

  // AE's own Presets folder and each "After Effects <version>/User Presets"
  // under Documents/Adobe. The server walks them for .ffx files.
  A.presetFolders = function () {
    var folders = [];
    try {
      var app1 = new Folder(Folder.appPackage.fsName + "/Presets");
      if (app1.exists) folders.push({ kind: "app", path: app1.fsName });
    } catch (e1) {}
    try {
      var adobe = new Folder(Folder.myDocuments.fsName + "/Adobe");
      var subs = adobe.getFiles("After Effects*");
      for (var i = 0; i < subs.length; i++) {
        if (subs[i] instanceof Folder) {
          var user = new Folder(subs[i].fsName + "/User Presets");
          if (user.exists) folders.push({ kind: "user", path: user.fsName });
        }
      }
    } catch (e2) {}
    return { folders: folders };
  };
})($.global);
