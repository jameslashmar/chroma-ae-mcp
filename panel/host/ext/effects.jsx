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
      // Count matches instead of trusting comp.layer(name), which silently
      // returns just the first match -- the same selector would then
      // resolve to an arbitrary layer here but be correctly refused as
      // ambiguous by data.jsx's layerIndex(), a real cross-tool
      // inconsistency for duplicate layer names (common in AE comps).
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

  // ---------- layer input stage (AE 26.5+) and popup labels (AE 26.0+) ----------

  var LAYER_STAGES = { source: 0, effects: -1, masks: -2 };
  var MAX_OPTIONS = 100;

  function stageValue(name) {
    var t = null;
    try {
      if (typeof LayerInputStageType !== "undefined") t = LayerInputStageType;
    } catch (eT) {
      t = null;
    }
    if (t) {
      if (name === "source" && t.SOURCE !== undefined) return t.SOURCE;
      if (name === "effects" && t.ALL_EFFECTS !== undefined) return t.ALL_EFFECTS;
      if (name === "masks" && t.ONLY_MASKS !== undefined) return t.ONLY_MASKS;
    }
    return LAYER_STAGES[name];
  }

  function stageName(n) {
    if (n === stageValue("source")) return "source";
    if (n === stageValue("effects")) return "effects";
    if (n === stageValue("masks")) return "masks";
    return "stage " + n;
  }

  function supportsInputStage(p) {
    try {
      return typeof p.setInputLayerAndStage === "function";
    } catch (e) {
      return false;
    }
  }

  // Reports the picked layer and stage of a layer picker where AE has them (26.5+).
  function addLayerInputInfo(p, entry) {
    entry.input_stage_supported = supportsInputStage(p);
    if (!entry.input_stage_supported) return;
    try {
      var pair = p.inputLayerAndStage;
      if (pair && typeof pair.length === "number" && pair.length >= 2) {
        entry.input_layer = pair[0];
        entry.input_stage = stageName(pair[1]);
      } else if (pair !== undefined && pair !== null) {
        entry.input_layer_and_stage = plainValue(pair);
      }
    } catch (eP) {}
    try {
      var st = p.layerInputStage;
      if (typeof st === "number" && entry.input_stage === undefined) entry.input_stage = stageName(st);
    } catch (eS) {}
  }

  function popupOptions(p) {
    try {
      var o = p.propertyParameters;
      if (o && typeof o.length === "number" && o.length > 0 && typeof o[0] === "string") {
        var out = [];
        for (var i = 0; i < o.length && i < MAX_OPTIONS; i++) out.push(String(o[i]).substring(0, 200));
        return out;
      }
    } catch (e) {}
    return null;
  }

  function addPopupInfo(p, entry) {
    var opts = popupOptions(p);
    if (!opts) return;
    entry.options = opts;
    try {
      var vt = p.valueText;
      if (typeof vt === "string") entry.value_text = vt.substring(0, 200);
    } catch (eV) {}
  }

  function trimText(s) {
    return String(s).replace(/^\s+|\s+$/g, "");
  }

  // 1-based menu item for a label (case-insensitive, trimmed).
  function popupIndex(p, label) {
    var opts = popupOptions(p);
    if (!opts) {
      fail(
        "bad_args",
        "Parameter \"" + p.name + "\" reports no menu labels on this AE (needs 26.0+, and not every effect popup exposes them); give the 1-based item number instead"
      );
    }
    var want = trimText(label).toLowerCase();
    for (var i = 0; i < opts.length; i++) {
      if (trimText(opts[i]).toLowerCase() === want) return i + 1;
    }
    fail("bad_args", "No menu item \"" + label + "\" on \"" + p.name + "\". Items: " + opts.slice(0, 40).join(" | "));
    return -1;
  }

  // ---------- expression references that effect order or count changes retarget ----------

  var EXPR_VISIT_LIMIT = 6000;

  function collectExpressions(group, path, out, state, depth) {
    for (var i = 1; i <= group.numProperties; i++) {
      if (state.visited >= EXPR_VISIT_LIMIT) {
        state.truncated = true;
        return;
      }
      state.visited++;
      var p = group.property(i);
      if (!p) continue;
      var np = path.concat([p.name]);
      if (p.propertyType === PropertyType.PROPERTY) {
        try {
          if (p.expressionEnabled && p.expression) out.push({ path: np, text: String(p.expression) });
        } catch (eE) {}
      } else if (depth < 8) {
        collectExpressions(p, np, out, state, depth + 1);
      }
    }
  }

  // Scans this comp's layers only (up to 300); other comps' expressions are not looked at.
  // Expressions with effect(<number>) on this layer, or on layers that mention it,
  // read an effect by position: they silently retarget when the stack changes.
  function findEffectIndexRefs(comp, layer) {
    var warnings = [];
    var re = /effect\(\s*\d+\s*\)/;
    var layerRe = new RegExp("layer\\(\\s*" + layer.index + "\\s*\\)");
    var state = { visited: 0, truncated: false };
    for (var i = 1; i <= comp.numLayers && i <= 300; i++) {
      var x = comp.layer(i);
      var found = [];
      try {
        collectExpressions(x, [], found, state, 0);
      } catch (eC) {}
      for (var k = 0; k < found.length; k++) {
        var t = found[k].text;
        if (!re.test(t)) continue;
        if (x.id !== layer.id) {
          var mentions = t.indexOf("\"" + layer.name + "\"") >= 0 || t.indexOf("'" + layer.name + "'") >= 0 || layerRe.test(t);
          if (!mentions) continue;
        }
        if (warnings.length < 20) {
          warnings.push({
            layer: x.name,
            property: found[k].path.join(" > "),
            expression: t.length > 200 ? t.substring(0, 200) + " ..." : t,
            note: "reads an effect by position; it may point at a different effect after this change"
          });
        }
      }
    }
    return { warnings: warnings, truncated: state.truncated };
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
        if (typeName === "layer") addLayerInputInfo(p, entry);
        if (typeName === "1d") addPopupInfo(p, entry);
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

  // The layer style slots ('<style>/enabled') with their enabled state; empty when the layer has none.
  function layerStyleSlots(l) {
    var slots = [];
    try {
      var g = l.property("ADBE Layer Styles");
      if (!g) return slots;
      for (var i = 1; i <= g.numProperties && slots.length < 20; i++) {
        var sp = g.property(i);
        if (!sp) continue;
        var mn = String(sp.matchName);
        if (mn.length > 8 && mn.substring(mn.length - 8) === "/enabled") {
          var on = null;
          try {
            on = sp.enabled === true;
          } catch (eEn) {
            on = null;
          }
          slots.push({ slot: mn, enabled: on });
        }
      }
    } catch (eG) {}
    return slots;
  }

  function describeLayerEffects(c, l) {
    var parade = effectParade(l);
    var effects = [];
    for (var i = 1; i <= parade.numProperties && i <= MAX_EFFECTS; i++) {
      effects.push(describeEffect(parade.property(i)));
    }
    var out = { comp_id: c.id, layer_id: l.id, layer_index: l.index, layer_name: l.name, effects: effects };
    if (parade.numProperties > MAX_EFFECTS) out.truncated = true;
    var slots = layerStyleSlots(l);
    if (slots.length > 0) out.layer_styles = slots;
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

  // Resolves every parameter of a call to what will be written, so that
  // everything that can fail fails before an undo group opens (or, for a new
  // effect, before its values are written).
  function planParams(c, l, fx, params) {
    var plans = [];
    if (!params) return plans;
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
      var v = params[i].value;
      var plan = { i: i, prop: p, typeName: typeName, kind: "value", value: null, label: null, stage: null, resolved: false };
      if (typeof v === "string") {
        if (typeName !== "1d") fail("bad_args", "Parameter \"" + p.name + "\" is not a popup: a text value only picks a menu item by its label");
        plan.value = popupIndex(p, v);
        plan.label = v;
        plan.resolved = true;
      } else if (v !== null && typeof v === "object" && typeof v.length !== "number") {
        if (typeName !== "layer") fail("bad_args", "Parameter \"" + p.name + "\" is not a layer picker: {layer, stage} only goes to layer parameters");
        var li = 0;
        if (v.layer !== 0) li = findLayer(c, v.layer).index;
        plan.value = li;
        plan.resolved = true;
        if (v.stage !== undefined && v.stage !== null) {
          if (!LAYER_STAGES.hasOwnProperty(v.stage)) fail("bad_args", "stage must be source, masks or effects");
          if (!supportsInputStage(p)) {
            fail("bad_args", "Choosing an input stage needs After Effects 26.5 or later (this AE has no setInputLayerAndStage); leave stage out to pick the layer only");
          }
          if (li === 0 && v.stage !== "source") fail("bad_args", "A stage needs a layer: layer 0 means none");
          if (li === l.index && v.stage !== "source") {
            fail("bad_args", "Layer " + li + " is the layer the effect sits on: taking its " + v.stage + " as input is a cycle. Use stage source or another layer");
          }
          if (p.numKeys > 0) fail("bad_args", "Parameter \"" + p.name + "\" is keyframed; an input stage can't be set on it");
          if (l.locked) fail("bad_args", "Layer \"" + l.name + "\" is locked; unlock it first");
          plan.kind = "stage";
          plan.stage = v.stage;
          plan.prev = null;
          try {
            var pv = p.inputLayerAndStage;
            if (pv && typeof pv.length === "number" && pv.length >= 2) plan.prev = [pv[0], pv[1]];
          } catch (ePv) {
            plan.prev = null;
          }
        }
      } else {
        plan.value = coerceValue(p, typeName, v);
      }
      plans.push(plan);
    }
    return plans;
  }

  // Puts the layer and stage back that earlier stage plans of this call replaced.
  function undoStagePlans(applied) {
    for (var u = applied.length - 1; u >= 0; u--) {
      var pl = applied[u];
      if (!pl.prev) continue;
      try {
        pl.prop.setInputLayerAndStage(pl.prev[0], pl.prev[1]);
      } catch (eU) {}
    }
  }

  // Writes the plans: input-stage picks first, then values. Animated
  // parameters get the value at the comp's current time, as ae_set_property does.
  // only: "stage" or "value" runs just that kind (setEffect runs stages first and undoes them if a later step throws).
  function runPlans(c, plans, only) {
    var done = [];
    var applied = [];
    var pass;
    var n;
    var limit;
    for (pass = 0; pass < 2; pass++) {
      for (n = 0; n < plans.length; n++) {
        var plan = plans[n];
        var isStage = plan.kind === "stage";
        if ((pass === 0) !== isStage) continue;
        if (only === "stage" && !isStage) continue;
        if (only === "value" && isStage) continue;
        var p = plan.prop;
        if (isStage) {
          // The safe limit changes with effects and sources, so it is read once, right before the write, and only reported (AE itself refuses a cycle).
          limit = null;
          try {
            limit = p.getInputStageCycleSafeLimit();
          } catch (eLim) {
            limit = null;
          }
          try {
            p.setInputLayerAndStage(plan.value, stageValue(plan.stage));
          } catch (eSet) {
            undoStagePlans(applied);
            fail("bad_args", "AE refused layer " + plan.value + " with stage " + plan.stage + " for \"" + p.name + "\" (a cycle, or a stage this layer does not have): " + String(eSet.message || eSet));
          }
          applied.push(plan);
          done[plan.i] = { param: p.name, how: "layer_and_stage", resolved_value: plan.value, stage: plan.stage, cycle_safe_limit: limit };
        } else if (p.numKeys > 0) {
          p.setValueAtTime(c.time, plan.value);
          done[plan.i] = { param: p.name, how: "value_at_current_time" };
        } else {
          p.setValue(plan.value);
          done[plan.i] = { param: p.name, how: "value" };
          if (plan.resolved) done[plan.i].resolved_value = plan.value;
          if (plan.label !== null) done[plan.i].label = plan.label;
        }
      }
    }
    return done;
  }

  A.listLayerEffects = function (args) {
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    return describeLayerEffects(c, l);
  };

  // ---------- Layer styles (probe: not yet measured on a live AE) ----------

  var LAYER_STYLES = {
    dropShadow: 1, innerShadow: 1, outerGlow: 1, innerGlow: 1, bevelEmboss: 1,
    chromeFX: 1, solidFill: 1, gradientFill: 1, patternFill: 1, frameFX: 1
  };

  var STYLE_NOT_ADDABLE =
    "not addable by script, use a preset: save the layer style as an .ffx animation preset in AE and apply it with ae_apply_preset; " +
    "once it exists, edit its parameters with ae_set_property on ['ADBE Layer Styles', '<style>/enabled', ...]";

  function addLayerStyle(c, l, args) {
    if (args.params && args.params.length > 0) {
      fail("bad_args", "params do not apply to a layer style; set its parameters afterwards with ae_set_property on ['ADBE Layer Styles', '" + args.effect + "/enabled', ...]");
    }
    if (args.name) fail("bad_args", "A layer style can't be renamed");
    if (l.locked) fail("bad_args", "Layer \"" + l.name + "\" is locked; unlock it first");
    var styles = null;
    try {
      styles = l.property("ADBE Layer Styles");
    } catch (eS) {
      styles = null;
    }
    if (!styles) fail("bad_args", "Layer \"" + l.name + "\" has no Layer Styles group");
    // The style slots' match names are '<style>/enabled' (the slots are listed whether or not a style is applied).
    var slotName = args.effect + "/enabled";
    var can = false;
    try {
      can = styles.canAddProperty(slotName) === true;
    } catch (eCan) {
      can = false;
    }
    if (!can) fail("bad_args", "Layer style " + args.effect + " is " + STYLE_NOT_ADDABLE);
    return A.withUndo("Chroma AE MCP: add layer style " + args.effect, function () {
      try {
        styles.addProperty(slotName);
      } catch (eAdd) {
        fail("bad_args", "Layer style " + args.effect + " is " + STYLE_NOT_ADDABLE + " (AE said: " + String(eAdd.message || eAdd) + ")");
      }
      return { comp_id: c.id, layer_id: l.id, layer_style: true, style: args.effect, slot: slotName };
    });
  }

  A.addEffect = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    if (LAYER_STYLES.hasOwnProperty(args.effect)) return addLayerStyle(c, l, args);
    var parade = effectParade(l);
    if (!parade.canAddProperty(args.effect)) {
      fail("not_found", "AE has no effect \"" + args.effect + "\" (use a match name or display name from ae_list_effects)");
    }
    return A.withUndo("Chroma AE MCP: add effect " + args.effect, function () {
      var fx = parade.addProperty(args.effect);
      var at = fx.propertyIndex;
      var done;
      try {
        if (args.name) fx.name = args.name;
        done = runPlans(c, planParams(c, l, fx, args.params));
      } catch (ePar) {
        // A value AE or the checks refused: take the half-made effect back out in this group.
        try {
          effectParade(l).property(at).remove();
        } catch (eRm) {}
        throw ePar;
      }
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

  function has(v) {
    return v !== undefined && v !== null;
  }

  A.setEffect = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var parade = effectParade(l);
    var fx = findEffect(parade, args.effect);
    var from = fx.propertyIndex;
    var count = parade.numProperties;
    var wantMove = has(args.move_to);
    var wantDup = has(args.duplicate);
    if (wantMove && wantDup) fail("bad_args", "Give move_to or duplicate, not both: after a duplicate the effect positions are not predictable");
    if (wantMove) {
      if (typeof args.move_to !== "number" || Math.floor(args.move_to) !== args.move_to || args.move_to < 1 || args.move_to > count) {
        fail("bad_args", "move_to must be a whole number 1.." + count);
      }
    }
    if (wantDup) {
      if (typeof args.duplicate !== "number" || Math.floor(args.duplicate) !== args.duplicate || args.duplicate < 1 || args.duplicate > 20) {
        fail("bad_args", "duplicate must be a whole number 1..20");
      }
      if (count + args.duplicate > MAX_EFFECTS) fail("bad_args", "The layer would hold more than " + MAX_EFFECTS + " effects");
    }
    var reorders = (wantMove && args.move_to !== from) || wantDup;
    if (reorders && l.locked) fail("bad_args", "Layer \"" + l.name + "\" is locked; unlock it first");
    var plans = planParams(c, l, fx, args.params);
    var hasEnabled = has(args.enabled);
    var result = {
      comp_id: c.id,
      layer_id: l.id,
      index: from,
      name: fx.name,
      matchName: fx.matchName,
      enabled: fx.enabled,
      params_set: []
    };
    if (!hasEnabled && !args.name && plans.length === 0 && !reorders) {
      result.no_op = true;
      result.note = "Nothing to change: the effect is already at index " + from;
      return result;
    }
    var refs = null;
    if (reorders) refs = findEffectIndexRefs(c, l);
    var matchName = fx.matchName;
    // No pre-check against getInputStageCycleSafeLimit: what it counts is not settled; AE's own throw is caught in runPlans.
    var prevEnabled = fx.enabled;
    var prevName = fx.name;
    return A.withUndo("Chroma AE MCP: set effect " + fx.name, function () {
      var stageDone = runPlans(c, plans, "stage");
      var valueDone;
      try {
        if (hasEnabled) fx.enabled = args.enabled === true;
        if (args.name) fx.name = args.name;
        valueDone = runPlans(c, plans, "value");
      } catch (eVal) {
        var applied2 = [];
        for (var sj = 0; sj < plans.length; sj++) {
          if (plans[sj].kind === "stage") applied2.push(plans[sj]);
        }
        undoStagePlans(applied2);
        try {
          fx.enabled = prevEnabled;
          fx.name = prevName;
        } catch (eBack) {}
        throw eVal;
      }
      var done = [];
      for (var dj = 0; dj < plans.length; dj++) {
        if (plans[dj].kind === "stage") done[plans[dj].i] = stageDone[plans[dj].i];
        else done[plans[dj].i] = valueDone[plans[dj].i];
      }
      result.params_set = done;
      result.name = fx.name;
      result.enabled = fx.enabled;
      var p2 = effectParade(l);
      var at = from;
      var n;
      if (wantMove) {
        if (args.move_to !== from) {
          p2.property(from).moveTo(args.move_to);
          at = args.move_to;
        }
        result.move = { from: from, to: args.move_to, matched: effectParade(l).property(at).matchName === matchName };
      }
      if (wantDup) {
        var copies = [];
        var located = true;
        var made = 0;
        for (n = 0; n < args.duplicate && located; n++) {
          var dup = effectParade(l).property(at).duplicate();
          made++;
          var di = -1;
          try {
            di = dup.propertyIndex;
          } catch (eDi) {
            di = -1;
          }
          if (typeof di !== "number" || di < 1) {
            located = false;
          } else {
            for (var q = 0; q < copies.length; q++) {
              if (copies[q] >= di) copies[q] = copies[q] + 1;
            }
            if (di <= at) at = at + 1;
            copies.push(di);
          }
        }
        result.duplicates = [];
        var parade3 = effectParade(l);
        for (n = 0; n < copies.length; n++) {
          var cp = parade3.property(copies[n]);
          result.duplicates.push({ index: copies[n], name: cp.name, matchName: cp.matchName });
        }
        result.duplicate_made = made;
        result.duplicate_located = located;
      }
      result.index = at;
      if (refs && refs.warnings.length > 0) {
        result.expression_warnings = refs.warnings;
      }
      if (refs && refs.truncated) result.expression_scan_truncated = true;
      if (refs) result.expression_scan_scope = "this comp's layers only (up to 300); expressions in other comps that reach this layer by comp(\"X\").layer(...).effect(n) are not scanned";
      return result;
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
