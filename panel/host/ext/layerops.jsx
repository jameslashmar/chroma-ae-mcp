// panel/host/ext/layerops.jsx
//
// Host functions for ae_layer_ops:
// - layeropsRead (read): a comp's layers with their switches, parent and
//   times, and (when asked) every expression in the comp, so the server can
//   tell which layer(index) references a reorder, duplicate or delete moved
// - layeropsPlan (read): what an action would do, without doing it
// - layeropsApply (guarded write): parent, reorder, sort, duplicate, delete,
//   trim, rename or layer switches, in one undo group
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - The write checks the target guard first and validates everything that can
//   fail (selectors, ranges, locked layers, enum names) before A.withUndo.
// - Inside the undo group a layer that AE refuses is skipped and reported, so
//   one bad layer does not leave the others half done with a thrown error.
// - Reads never change time, selection, solo or anything else on the undo stack.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var MAX_INCLUDE = 50;
  var MAX_EXPR = 500;
  var MAX_EXPR_TEXT = 20000;
  var MAX_PROPS = 20000;
  var MAX_NAME = 200;
  var MAX_TIME = 36000;
  var MAX_COPIES = 50;
  var MAX_REPORT = 500;

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

  // ---------- small helpers ----------

  // A layer attribute that throws or is missing on this layer type reads as undefined.
  function prop(l, key) {
    try {
      return l[key];
    } catch (e) {
      return undefined;
    }
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function hasItems(v) {
    return v !== undefined && v !== null && typeof v.length === "number" && v.length > 0;
  }

  function hasKeys(o) {
    if (!o || typeof o !== "object") return false;
    for (var k in o) {
      if (o.hasOwnProperty(k) && o[k] !== undefined && o[k] !== null) return true;
    }
    return false;
  }

  function idList(layers) {
    var out = [];
    for (var i = 0; i < layers.length; i++) out.push(layers[i].id);
    return out;
  }

  function indexOfId(ids, id) {
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] === id) return i;
    }
    return -1;
  }

  function describe(l) {
    return { id: l.id, index: l.index, name: l.name };
  }

  function layeropsKind(l) {
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
      if (l.adjustmentLayer) return "adjustment";
    } catch (e2) {}
    try {
      if (l.source && l.source instanceof CompItem) return "precomp";
    } catch (e3) {}
    try {
      if (l.source && l.source.mainSource && l.source.mainSource instanceof SolidSource) return "solid";
    } catch (e4) {}
    try {
      if (l.hasAudio && !l.hasVideo) return "audio";
    } catch (e5) {}
    if (reflectName === "AVLayer") return "footage";
    return reflectName.toLowerCase();
  }

  function isCameraOrLight(kind) {
    return kind === "camera" || kind === "light";
  }

  // The layer's parent, or null (also when AE will not say).
  function parentOf(l) {
    try {
      if (l.parent) return l.parent;
    } catch (e) {}
    return null;
  }

  // ---------- enums ----------

  var BLEND_TABLE = [
    ["normal", "NORMAL"], ["dissolve", "DISSOLVE"], ["dancing_dissolve", "DANCING_DISSOLVE"],
    ["darken", "DARKEN"], ["multiply", "MULTIPLY"], ["color_burn", "COLOR_BURN"],
    ["classic_color_burn", "CLASSIC_COLOR_BURN"], ["linear_burn", "LINEAR_BURN"], ["darker_color", "DARKER_COLOR"],
    ["add", "ADD"], ["lighten", "LIGHTEN"], ["screen", "SCREEN"], ["color_dodge", "COLOR_DODGE"],
    ["classic_color_dodge", "CLASSIC_COLOR_DODGE"], ["linear_dodge", "LINEAR_DODGE"], ["lighter_color", "LIGHTER_COLOR"],
    ["overlay", "OVERLAY"], ["soft_light", "SOFT_LIGHT"], ["hard_light", "HARD_LIGHT"],
    ["linear_light", "LINEAR_LIGHT"], ["vivid_light", "VIVID_LIGHT"], ["pin_light", "PIN_LIGHT"],
    ["hard_mix", "HARD_MIX"], ["difference", "DIFFERENCE"], ["classic_difference", "CLASSIC_DIFFERENCE"],
    ["exclusion", "EXCLUSION"], ["subtract", "SUBTRACT"], ["divide", "DIVIDE"],
    ["hue", "HUE"], ["saturation", "SATURATION"], ["color", "COLOR"], ["luminosity", "LUMINOSITY"],
    ["stencil_alpha", "STENCIL_ALPHA"], ["stencil_luma", "STENCIL_LUMA"],
    ["silhouette_alpha", "SILHOUETE_ALPHA"], ["silhouette_luma", "SILHOUETTE_LUMA"],
    ["alpha_add", "ALPHA_ADD"], ["luminescent_premul", "LUMINESCENT_PREMUL"]
  ];

  // The BlendingMode value for a name, or undefined when this AE has no such mode.
  // The Scripting Guide spells one key SILHOUETE_ALPHA; the right spelling is tried too.
  function blendKeyValue(key) {
    var v = BlendingMode[key];
    if (v === undefined && key === "SILHOUETE_ALPHA") v = BlendingMode.SILHOUETTE_ALPHA;
    return v;
  }

  function blendValue(name) {
    if (typeof BlendingMode === "undefined") return undefined;
    for (var i = 0; i < BLEND_TABLE.length; i++) {
      if (BLEND_TABLE[i][0] === name) return blendKeyValue(BLEND_TABLE[i][1]);
    }
    return undefined;
  }

  function blendName(value) {
    if (typeof BlendingMode === "undefined" || value === undefined) return undefined;
    for (var i = 0; i < BLEND_TABLE.length; i++) {
      if (blendKeyValue(BLEND_TABLE[i][1]) === value) return BLEND_TABLE[i][0];
    }
    return "unknown";
  }

  function qualityValue(name) {
    if (typeof LayerQuality === "undefined") return undefined;
    if (name === "best") return LayerQuality.BEST;
    if (name === "draft") return LayerQuality.DRAFT;
    if (name === "wireframe") return LayerQuality.WIREFRAME;
    return undefined;
  }

  function qualityName(value) {
    if (typeof LayerQuality === "undefined" || value === undefined) return undefined;
    if (value === LayerQuality.BEST) return "best";
    if (value === LayerQuality.DRAFT) return "draft";
    if (value === LayerQuality.WIREFRAME) return "wireframe";
    return "unknown";
  }

  function samplingValue(name) {
    if (typeof LayerSamplingQuality === "undefined") return undefined;
    if (name === "bilinear") return LayerSamplingQuality.BILINEAR;
    if (name === "bicubic") return LayerSamplingQuality.BICUBIC;
    return undefined;
  }

  function samplingName(value) {
    if (typeof LayerSamplingQuality === "undefined" || value === undefined) return undefined;
    if (value === LayerSamplingQuality.BILINEAR) return "bilinear";
    if (value === LayerSamplingQuality.BICUBIC) return "bicubic";
    return "unknown";
  }

  // ---------- read ----------

  function entryOf(l) {
    var s = {
      index: l.index,
      id: l.id,
      name: l.name,
      kind: layeropsKind(l),
      enabled: l.enabled === true,
      inPoint: l.inPoint,
      outPoint: l.outPoint,
      startTime: l.startTime,
      parent: null,
      parent_id: null
    };
    var p = parentOf(l);
    if (p) {
      try {
        s.parent = p.index;
        s.parent_id = p.id;
      } catch (e0) {}
    }
    var v = prop(l, "shy");
    if (v !== undefined) s.shy = v === true;
    v = prop(l, "solo");
    if (v !== undefined) s.solo = v === true;
    v = prop(l, "locked");
    if (v !== undefined) s.locked = v === true;
    v = prop(l, "guideLayer");
    if (v !== undefined) s.guide = v === true;
    v = prop(l, "label");
    if (v !== undefined) s.label = v;
    v = prop(l, "threeDLayer");
    if (v !== undefined) s.threeD = v === true;
    v = prop(l, "motionBlur");
    if (v !== undefined) s.motionBlur = v === true;
    v = prop(l, "collapseTransformation");
    if (v !== undefined) s.collapse = v === true;
    v = qualityName(prop(l, "quality"));
    if (v !== undefined) s.quality = v;
    v = samplingName(prop(l, "samplingQuality"));
    if (v !== undefined) s.samplingQuality = v;
    v = blendName(prop(l, "blendingMode"));
    if (v !== undefined) s.blendMode = v;
    return s;
  }

  function numberList(v) {
    var out = [];
    if (!v || typeof v.length !== "number") return out;
    for (var i = 0; i < v.length && out.length < MAX_INCLUDE; i++) {
      if (isNum(v[i])) out.push(v[i]);
    }
    return out;
  }

  // Layers past the 500 cap that the caller asked for by id or index, so a
  // read-back can still find them in a big comp.
  function includedBeyondCap(comp, include) {
    var extra = [];
    var total = comp.numLayers;
    if (total <= MAX_LAYERS || !include) return extra;
    var wantIds = numberList(include.ids);
    var wantIndexes = numberList(include.indexes);
    var picked = {};
    var i;
    var k;
    for (i = 0; i < wantIndexes.length; i++) {
      if (wantIndexes[i] > MAX_LAYERS && wantIndexes[i] <= total) picked[wantIndexes[i]] = true;
    }
    if (wantIds.length > 0) {
      for (i = MAX_LAYERS + 1; i <= total; i++) {
        var lid = comp.layer(i).id;
        for (k = 0; k < wantIds.length; k++) {
          if (wantIds[k] === lid) picked[i] = true;
        }
      }
    }
    for (i = MAX_LAYERS + 1; i <= total; i++) {
      if (picked[i]) extra.push(entryOf(comp.layer(i)));
    }
    return extra;
  }

  // Every expression under a property group, depth-limited and capped.
  function walkExpressions(group, path, layer, out, state, depth) {
    var n = 0;
    try {
      n = group.numProperties;
    } catch (e0) {
      return;
    }
    for (var i = 1; i <= n; i++) {
      if (state.visited >= MAX_PROPS || out.length >= MAX_EXPR) {
        state.truncated = true;
        return;
      }
      var p = null;
      try {
        p = group.property(i);
      } catch (e1) {
        p = null;
      }
      if (!p) continue;
      state.visited++;
      var pname = "";
      try {
        pname = String(p.name);
      } catch (e2) {}
      var here = pname;
      if (path !== "") here = path + " > " + pname;
      var type = null;
      try {
        type = p.propertyType;
      } catch (e3) {}
      if (type === PropertyType.PROPERTY) {
        var text = "";
        try {
          if (p.canSetExpression) text = p.expression;
        } catch (e4) {
          text = "";
        }
        if (typeof text === "string" && text.length > 0) {
          var enabled = true;
          try {
            enabled = p.expressionEnabled === true;
          } catch (e5) {}
          var fullLength = text.length;
          var cut = false;
          if (text.length > MAX_EXPR_TEXT) {
            text = text.substring(0, MAX_EXPR_TEXT);
            cut = true;
          }
          // Only expressions that mention layer( can matter to the server's scan.
          if (cut || text.indexOf("layer") !== -1) {
            var item = { layer_id: layer.id, layer_index: layer.index, layer_name: layer.name, path: here, text: text, enabled: enabled };
            if (cut) {
              item.text_truncated = true;
              item.text_length = fullLength;
            }
            out.push(item);
          }
        }
      } else if (depth < 12) {
        walkExpressions(p, here, layer, out, state, depth + 1);
      }
    }
  }

  function readStack(comp, opts) {
    var n = comp.numLayers;
    var cap = n;
    if (n > MAX_LAYERS) cap = MAX_LAYERS;
    var layers = [];
    var i;
    for (i = 1; i <= cap; i++) layers.push(entryOf(comp.layer(i)));
    var extra = includedBeyondCap(comp, opts);
    for (i = 0; i < extra.length; i++) layers.push(extra[i]);
    var out = {
      comp_id: comp.id,
      name: comp.name,
      frameDuration: comp.frameDuration,
      numLayers: n,
      layers: layers,
      truncated: n > MAX_LAYERS
    };
    if (opts && opts.scan === true) {
      var exprs = [];
      var state = { visited: 0, truncated: false };
      for (i = 1; i <= cap; i++) {
        if (state.truncated) break;
        walkExpressions(comp.layer(i), "", comp.layer(i), exprs, state, 0);
      }
      out.expressions = exprs;
      out.expressions_truncated = state.truncated || n > MAX_LAYERS;
    }
    return out;
  }

  A.layeropsRead = function (args) {
    var out = readStack(requireComp(args.comp_id), {
      ids: args.include_ids,
      indexes: args.include_indexes,
      scan: args.scan_expressions === true
    });
    if (args.with_comp_id !== undefined && args.with_comp_id !== null) {
      out.with_comp = readStack(requireComp(args.with_comp_id), { ids: args.include_ids, scan: args.scan_expressions === true });
    }
    return out;
  };

  // ---------- selection ----------

  function matchesWhere(l, where) {
    var v;
    if (where.label !== undefined && where.label !== null && prop(l, "label") !== where.label) return false;
    if (where.kind !== undefined && where.kind !== null && layeropsKind(l) !== where.kind) return false;
    if (where.name_contains !== undefined && where.name_contains !== null) {
      if (String(l.name).toLowerCase().indexOf(String(where.name_contains).toLowerCase()) === -1) return false;
    }
    if (where.shy !== undefined && where.shy !== null && (prop(l, "shy") === true) !== where.shy) return false;
    if (where.locked !== undefined && where.locked !== null && (prop(l, "locked") === true) !== where.locked) return false;
    if (where.enabled !== undefined && where.enabled !== null && (l.enabled === true) !== where.enabled) return false;
    if (where.has_parent !== undefined && where.has_parent !== null) {
      v = parentOf(l) !== null;
      if (v !== where.has_parent) return false;
    }
    return true;
  }

  // The layers an action works on: the listed layers (or the whole stack),
  // narrowed by where, in stack order.
  function selectionOf(comp, args, needsSelection) {
    var sels = args.layers;
    var hasLayers = hasItems(sels);
    var hasWhere = hasKeys(args.where);
    if (!hasLayers && !hasWhere && needsSelection) fail("bad_args", "Give layers or a where filter to say which layers to work on");
    var picked = [];
    var seen = {};
    var i;
    if (hasLayers) {
      if (sels.length > MAX_LAYERS) fail("bad_args", "At most " + MAX_LAYERS + " layers per call");
      for (i = 0; i < sels.length; i++) {
        var l = findLayer(comp, sels[i]);
        if (!seen[l.id]) {
          seen[l.id] = true;
          picked.push(l);
        }
      }
    } else {
      if (comp.numLayers > MAX_LAYERS) fail("bad_args", "This comp has more than " + MAX_LAYERS + " layers; name the layers to work on");
      for (i = 1; i <= comp.numLayers; i++) picked.push(comp.layer(i));
    }
    var out = [];
    for (i = 0; i < picked.length; i++) {
      if (!hasWhere || matchesWhere(picked[i], args.where)) out.push(picked[i]);
    }
    out.sort(function (a, b) { return a.index - b.index; });
    return out;
  }

  function stackIds(comp) {
    var ids = [];
    for (var i = 1; i <= comp.numLayers; i++) ids.push(comp.layer(i).id);
    return ids;
  }

  function layerMap(comp) {
    var map = {};
    for (var i = 1; i <= comp.numLayers; i++) map[comp.layer(i).id] = comp.layer(i);
    return map;
  }

  // ---------- ordering ----------

  // keep[i] is true for the entries of seq on one longest increasing run.
  function increasingRun(seq) {
    var tails = [];
    var prev = [];
    var keep = [];
    var i;
    for (i = 0; i < seq.length; i++) {
      var lo = 0;
      var hi = tails.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (seq[tails[mid]] < seq[i]) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) prev[i] = tails[lo - 1];
      else prev[i] = -1;
      tails[lo] = i;
      keep[i] = false;
    }
    var k = -1;
    if (tails.length > 0) k = tails[tails.length - 1];
    while (k >= 0) {
      keep[k] = true;
      k = prev[k];
    }
    return keep;
  }

  // The fewest layer moves from the current id order to the wanted one:
  // layers on the longest run that is already in order stay, the rest are
  // placed after their predecessor in the wanted order.
  function planMoves(current, wanted) {
    var want = {};
    var i;
    for (i = 0; i < wanted.length; i++) want[wanted[i]] = i;
    var seq = [];
    for (i = 0; i < current.length; i++) seq.push(want[current[i]]);
    var keep = increasingRun(seq);
    var stays = {};
    for (i = 0; i < current.length; i++) {
      if (keep[i]) stays[current[i]] = true;
    }
    var moves = [];
    for (i = 0; i < wanted.length; i++) {
      if (stays[wanted[i]]) continue;
      var after = null;
      if (i > 0) after = wanted[i - 1];
      moves.push({ id: wanted[i], after_id: after });
    }
    return moves;
  }

  function sameOrder(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Fills the plan from the current and wanted id orders.
  function finishOrder(plan, comp, wanted) {
    var current = stackIds(comp);
    var moves = [];
    if (!sameOrder(current, wanted)) moves = planMoves(current, wanted);
    plan.work.moves = moves;
    plan.work.todo = moves.length;
    plan.out.moves = moves.length;
    plan.out.order_after = wanted.slice(0, MAX_LAYERS);
    plan.out.order_truncated = wanted.length > MAX_LAYERS;
    var map = layerMap(comp);
    for (var i = 0; i < moves.length; i++) plan.lockCandidates.push(map[moves[i].id]);
    if (moves.length === 0) plan.out.warnings.push("The layers are already in that order; nothing to move");
  }

  // Natural, case-insensitive order: "Layer 2" before "Layer 10".
  function chunks(s) {
    var out = [];
    var re = /(\d+)|(\D+)/g;
    var m = re.exec(s);
    while (m !== null) {
      if (m[1] !== undefined && m[1] !== "") out.push({ num: parseInt(m[1], 10), str: m[1] });
      else out.push({ num: null, str: m[2] });
      m = re.exec(s);
    }
    return out;
  }

  function naturalCompare(a, b) {
    var x = chunks(String(a).toLowerCase());
    var y = chunks(String(b).toLowerCase());
    var n = x.length;
    if (y.length < n) n = y.length;
    for (var i = 0; i < n; i++) {
      if (x[i].num !== null && y[i].num !== null) {
        if (x[i].num !== y[i].num) return x[i].num < y[i].num ? -1 : 1;
      } else if (x[i].str !== y[i].str) {
        return x[i].str < y[i].str ? -1 : 1;
      }
    }
    if (x.length === y.length) return 0;
    return x.length < y.length ? -1 : 1;
  }

  function zOf(l) {
    try {
      var v = l.property("ADBE Transform Group").property("ADBE Position").value;
      if (v && v.length >= 3 && isNum(v[2])) return v[2];
    } catch (e) {}
    return 0;
  }

  function sortKey(l, by) {
    if (by === "name") return l.name;
    if (by === "start_time") return l.startTime;
    if (by === "in_point") return l.inPoint;
    if (by === "out_point") return l.outPoint;
    if (by === "z") return zOf(l);
    if (by === "label") {
      var lb = prop(l, "label");
      if (isNum(lb)) return lb;
      return 0;
    }
    return l.index;
  }

  // ---------- planning ----------

  function newPlan(action) {
    return {
      out: { action: action, targets: [], skipped: [], warnings: [] },
      work: { todo: 0 },
      lockCandidates: [],
      selfLock: false
    };
  }

  function skip(plan, l, reason, key) {
    var s = { id: l.id, index: l.index, name: l.name, reason: reason };
    if (key !== undefined) s.key = key;
    if (plan.out.skipped.length < MAX_REPORT) plan.out.skipped.push(s);
  }

  function setTargets(plan, layers) {
    for (var i = 0; i < layers.length; i++) {
      if (plan.out.targets.length < MAX_REPORT) plan.out.targets.push(describe(layers[i]));
    }
  }

  function wouldLoop(newParent, child) {
    var p = newParent;
    var guard = 0;
    while (p && guard < 10000) {
      if (p.id === child.id) return true;
      p = parentOf(p);
      guard++;
    }
    return false;
  }

  function planParent(comp, args, plan) {
    var targets = selectionOf(comp, args, true);
    setTargets(plan, targets);
    var unparent = args.unparent === true;
    var newParent = null;
    if (unparent && args.parent) fail("bad_args", "Give parent or unparent, not both");
    if (!unparent) {
      if (!args.parent) fail("bad_args", "Give parent (the new parent layer) or unparent: true");
      newParent = findLayer(comp, args.parent);
    }
    var jump = args.keep_position === false;
    var apply = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var cur = parentOf(t);
      if (unparent) {
        if (!cur) skip(plan, t, "has no parent");
        else apply.push(t);
      } else if (t.id === newParent.id) {
        skip(plan, t, "a layer can't be its own parent");
      } else if (wouldLoop(newParent, t)) {
        skip(plan, t, "that would make a parent loop");
      } else if (cur && cur.id === newParent.id) {
        skip(plan, t, "already parented to it");
      } else {
        apply.push(t);
      }
    }
    plan.out.parent_id = null;
    plan.out.parent_name = null;
    if (newParent) {
      plan.out.parent_id = newParent.id;
      plan.out.parent_name = newParent.name;
    }
    plan.out.mode = "keep_position";
    if (jump) plan.out.mode = "jump";
    plan.work.apply = apply;
    plan.work.newParent = newParent;
    plan.work.jump = jump;
    plan.work.todo = apply.length;
    plan.lockCandidates = apply.slice(0);
    if (jump && apply.length > 0) plan.out.warnings.push("keep_position is false: the layers keep their own transform values, so they will visibly jump");
  }

  function planReorder(comp, args, plan) {
    var targets = selectionOf(comp, args, true);
    setTargets(plan, targets);
    var how = args.move_to;
    if (how !== "beginning" && how !== "end" && how !== "before" && how !== "after") {
      fail("bad_args", "move_to must be beginning, end, before or after");
    }
    var rel = null;
    if (how === "before" || how === "after") {
      if (!args.relative_to) fail("bad_args", "move_to " + how + " needs relative_to");
      rel = findLayer(comp, args.relative_to);
    }
    var isTarget = {};
    var i;
    for (i = 0; i < targets.length; i++) isTarget[targets[i].id] = true;
    if (rel && isTarget[rel.id]) fail("bad_args", "relative_to \"" + rel.name + "\" is one of the layers being moved");
    var all = stackIds(comp);
    var rest = [];
    for (i = 0; i < all.length; i++) {
      if (!isTarget[all[i]]) rest.push(all[i]);
    }
    var block = idList(targets);
    var wanted = [];
    if (how === "beginning") {
      wanted = block.concat(rest);
    } else if (how === "end") {
      wanted = rest.concat(block);
    } else {
      var at = indexOfId(rest, rel.id);
      if (how === "after") at++;
      wanted = rest.slice(0, at).concat(block).concat(rest.slice(at));
    }
    plan.out.move_to = how;
    if (rel) plan.out.relative_to = describe(rel);
    finishOrder(plan, comp, wanted);
  }

  function planSort(comp, args, plan) {
    var targets = selectionOf(comp, args, false);
    setTargets(plan, targets);
    var by = args.sort_by;
    if (!by) fail("bad_args", "sort needs sort_by: name, start_time, in_point, out_point, z, label or index");
    var known = { name: 1, start_time: 1, in_point: 1, out_point: 1, z: 1, label: 1, index: 1 };
    if (known[by] !== 1) fail("bad_args", "Unknown sort_by \"" + by + "\"");
    var desc = args.descending === true;
    var decorated = [];
    var i;
    for (i = 0; i < targets.length; i++) decorated.push({ l: targets[i], key: sortKey(targets[i], by), at: i });
    decorated.sort(function (a, b) {
      var c = 0;
      if (by === "name") {
        c = naturalCompare(a.key, b.key);
      } else if (a.key < b.key) {
        c = -1;
      } else if (a.key > b.key) {
        c = 1;
      }
      if (desc) c = -c;
      if (c !== 0) return c;
      return a.at - b.at;
    });
    // The sorted layers take the stack slots the selected layers held.
    var wanted = stackIds(comp);
    var slots = [];
    for (i = 0; i < targets.length; i++) slots.push(targets[i].index - 1);
    for (i = 0; i < slots.length; i++) wanted[slots[i]] = decorated[i].l.id;
    plan.out.sort_by = by;
    plan.out.descending = desc;
    finishOrder(plan, comp, wanted);
  }

  function hasEffects(l) {
    try {
      var fx = l.property("ADBE Effect Parade");
      return !!fx && fx.numProperties > 0;
    } catch (e) {
      return false;
    }
  }

  function planDuplicate(comp, args, plan) {
    var targets = selectionOf(comp, args, true);
    setTargets(plan, targets);
    var count = 1;
    if (args.count !== undefined && args.count !== null) count = args.count;
    if (!isNum(count) || count < 1 || count > MAX_COPIES || Math.floor(count) !== count) fail("bad_args", "count must be a whole number from 1 to " + MAX_COPIES);
    var dest = null;
    if (args.to_comp_id !== undefined && args.to_comp_id !== null) {
      dest = requireComp(args.to_comp_id);
      if (dest.id === comp.id) fail("bad_args", "to_comp_id is this comp; leave it out to duplicate in place");
      if (count > 1) fail("bad_args", "count above 1 works for duplicates in the same comp only");
    }
    if (targets.length * count + comp.numLayers > 100000) fail("bad_args", "That would add too many layers");
    var apply = [];
    var order = stackIds(comp);
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (dest) {
        var src = prop(t, "source");
        if (src && src.id === dest.id) {
          skip(plan, t, "its source is the destination comp, so the copy would contain itself");
          continue;
        }
        if (hasEffects(t)) {
          plan.out.warnings.push("\"" + t.name + "\" has effects: undoing copyToComp on a layer with effects crashed AE in the past (13.7). Prefer duplicating in place and moving the copy");
        }
      }
      apply.push(t);
    }
    if (!dest) {
      // Each copy lands directly above its original.
      var wanted = [];
      var isApply = {};
      for (i = 0; i < apply.length; i++) isApply[apply[i].id] = true;
      for (i = 0; i < order.length; i++) {
        if (isApply[order[i]]) {
          for (var c = 0; c < count; c++) wanted.push(null);
        }
        wanted.push(order[i]);
      }
      plan.out.order_after = wanted.slice(0, MAX_LAYERS);
      plan.out.order_truncated = wanted.length > MAX_LAYERS;
    }
    plan.out.count = count;
    if (dest) plan.out.to_comp_id = dest.id;
    plan.work.apply = apply;
    plan.work.count = count;
    plan.work.dest = dest;
    plan.work.todo = apply.length;
  }

  function planDelete(comp, args, plan) {
    var targets = selectionOf(comp, args, true);
    setTargets(plan, targets);
    var gone = {};
    var i;
    for (i = 0; i < targets.length; i++) gone[targets[i].id] = true;
    var orphans = [];
    var dependents = [];
    for (i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      if (gone[l.id]) continue;
      var p = parentOf(l);
      if (p && gone[p.id] && orphans.length < MAX_REPORT) orphans.push({ id: l.id, name: l.name, parent_id: p.id });
      var m = prop(l, "trackMatteLayer");
      if (m && gone[m.id] && dependents.length < MAX_REPORT) dependents.push({ id: l.id, name: l.name, matte_id: m.id });
    }
    plan.out.orphaned_children = orphans;
    plan.out.matte_dependents = dependents;
    if (orphans.length > 0) plan.out.warnings.push(orphans.length + " child layer(s) lose their parent; AE decides whether they keep their on-screen position");
    if (dependents.length > 0) plan.out.warnings.push(dependents.length + " layer(s) used a deleted layer as their track matte");
    var wanted = [];
    var all = stackIds(comp);
    for (i = 0; i < all.length; i++) {
      if (!gone[all[i]]) wanted.push(all[i]);
    }
    plan.out.order_after = wanted.slice(0, MAX_LAYERS);
    plan.out.order_truncated = wanted.length > MAX_LAYERS;
    plan.work.apply = targets;
    plan.work.todo = targets.length;
    plan.lockCandidates = targets.slice(0);
  }

  function checkTime(name, v) {
    if (v === undefined || v === null) return;
    if (!isNum(v) || v < -MAX_TIME || v > MAX_TIME) fail("bad_args", name + " must be a number of seconds within " + MAX_TIME);
  }

  function planTrim(comp, args, plan) {
    var targets = selectionOf(comp, args, true);
    setTargets(plan, targets);
    checkTime("in_point", args.in_point);
    checkTime("out_point", args.out_point);
    checkTime("start_time", args.start_time);
    var hasIn = args.in_point !== undefined && args.in_point !== null;
    var hasOut = args.out_point !== undefined && args.out_point !== null;
    var hasStart = args.start_time !== undefined && args.start_time !== null;
    if (!hasIn && !hasOut && !hasStart) fail("bad_args", "trim needs in_point, out_point or start_time");
    var apply = [];
    var trims = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var start = t.startTime;
      var inP = t.inPoint;
      var outP = t.outPoint;
      if (hasStart) {
        // Moving the start moves the in and out points with it.
        inP = inP + (args.start_time - start);
        outP = outP + (args.start_time - start);
        start = args.start_time;
      }
      if (hasIn) inP = args.in_point;
      if (hasOut) outP = args.out_point;
      if (!(inP < outP)) {
        skip(plan, t, "the in point (" + inP + ") must be before the out point (" + outP + ")");
        continue;
      }
      apply.push(t);
      trims.push({ id: t.id, start_time: start, in_point: inP, out_point: outP });
    }
    plan.out.trims = trims;
    plan.work.apply = apply;
    plan.work.trims = trims;
    plan.work.hasStart = hasStart;
    plan.work.todo = apply.length;
    plan.lockCandidates = apply.slice(0);
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = "0" + s;
    return s;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  }

  // Replaces every occurrence of a literal (no regular expressions, so no
  // runaway patterns inside AE).
  function replaceAll(text, find, rep, caseSensitive) {
    if (caseSensitive) return text.split(find).join(rep);
    var re = new RegExp(escapeRegExp(find), "gi");
    return text.replace(re, function () { return rep; });
  }

  function planRename(comp, args, plan) {
    var targets = selectionOf(comp, args, true);
    setTargets(plan, targets);
    var hasFind = args.find !== undefined && args.find !== null && args.find !== "";
    var hasTemplate = args.template !== undefined && args.template !== null && args.template !== "";
    if (!hasFind && !hasTemplate) fail("bad_args", "rename needs find (with replace) or template");
    if (hasFind && typeof args.find !== "string") fail("bad_args", "find must be a string");
    var rep = "";
    if (args.replace !== undefined && args.replace !== null) rep = String(args.replace);
    var tpl = "";
    if (hasTemplate) tpl = String(args.template);
    var startN = 1;
    if (args.start_number !== undefined && args.start_number !== null) startN = args.start_number;
    var width = 0;
    if (args.number_pad !== undefined && args.number_pad !== null) width = args.number_pad;
    if (!isNum(startN) || Math.floor(startN) !== startN || startN < 0 || startN > 1000000) fail("bad_args", "start_number must be a whole number from 0 to 1000000");
    if (!isNum(width) || Math.floor(width) !== width || width < 0 || width > 8) fail("bad_args", "number_pad must be a whole number from 0 to 8");
    var caseSensitive = args.case_sensitive === true;
    var apply = [];
    var renames = [];
    var counter = startN;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var name = String(t.name);
      var base = name;
      if (hasFind) base = replaceAll(base, args.find, rep, caseSensitive);
      var result = base;
      if (hasTemplate) {
        result = tpl.split("{name}").join(base).split("{n}").join(pad(counter, width)).split("{index}").join(pad(t.index, width));
        counter++;
      }
      if (result === name) {
        skip(plan, t, "the name would not change");
        continue;
      }
      if (result.length === 0) {
        skip(plan, t, "the new name would be empty");
        continue;
      }
      if (result.length > MAX_NAME) {
        skip(plan, t, "the new name would be longer than " + MAX_NAME + " characters");
        continue;
      }
      apply.push(t);
      renames.push({ id: t.id, from: name, to: result });
    }
    // Names that end up the same make by-name selectors ambiguous.
    var finalNames = {};
    var r;
    for (r = 1; r <= comp.numLayers; r++) finalNames[comp.layer(r).id] = comp.layer(r).name;
    for (r = 0; r < renames.length; r++) finalNames[renames[r].id] = renames[r].to;
    var seen = {};
    var dupes = {};
    for (var k in finalNames) {
      if (!finalNames.hasOwnProperty(k)) continue;
      var fn = finalNames[k];
      if (seen[fn]) dupes[fn] = true;
      seen[fn] = true;
    }
    var dupList = [];
    for (var d in dupes) {
      if (dupes.hasOwnProperty(d)) dupList.push(d);
    }
    if (dupList.length > 0) plan.out.warnings.push("These names would be shared by several layers: " + dupList.slice(0, 10).join(", "));
    plan.out.renames = renames;
    plan.work.apply = apply;
    plan.work.renames = renames;
    plan.work.fixRefs = args.fix_name_references === true;
    plan.work.todo = apply.length;
    plan.lockCandidates = apply.slice(0);
  }

  // The switch changes one layer can take, and why each other is skipped.
  var SWITCH_KEYS = ["shy", "solo", "locked", "guide", "enabled", "collapse_transformations", "three_d", "motion_blur", "quality", "sampling_quality", "blend_mode", "label_color"];

  function switchPlanFor(l, args, plan) {
    var kind = layeropsKind(l);
    var camLight = isCameraOrLight(kind);
    var audioOnly = prop(l, "hasVideo") === false;
    var changes = [];
    for (var i = 0; i < SWITCH_KEYS.length; i++) {
      var key = SWITCH_KEYS[i];
      var want = args[key];
      if (want === undefined || want === null) continue;
      var from;
      var reason = null;
      if (key === "shy") from = prop(l, "shy") === true;
      else if (key === "solo") from = prop(l, "solo") === true;
      else if (key === "locked") from = prop(l, "locked") === true;
      else if (key === "enabled") from = l.enabled === true;
      else if (key === "label_color") from = prop(l, "label");
      else if (key === "guide") {
        from = prop(l, "guideLayer") === true;
        if (camLight || prop(l, "guideLayer") === undefined) reason = "the guide switch needs an AV layer";
      } else if (key === "collapse_transformations") {
        from = prop(l, "collapseTransformation") === true;
        var can = prop(l, "canSetCollapseTransformation");
        if (camLight || audioOnly) {
          reason = "collapse transformations needs a precomp or vector layer";
        } else if (can === false) {
          reason = "collapse transformations can't be set on this layer (it needs a precomp or vector layer)";
        } else if (can === undefined && kind !== "precomp" && kind !== "shape") {
          reason = "collapse transformations needs a precomp or vector layer";
        }
      } else if (key === "three_d") {
        from = prop(l, "threeDLayer") === true;
        if (camLight) reason = "cameras and lights are always 3D";
        else if (audioOnly) reason = "an audio-only layer has no 3D switch";
        else if (prop(l, "threeDLayer") === undefined) reason = "this layer has no 3D switch";
      } else if (key === "motion_blur") {
        from = prop(l, "motionBlur") === true;
        if (camLight || audioOnly || prop(l, "motionBlur") === undefined) reason = "motion blur needs a layer with video";
      } else if (key === "quality") {
        from = qualityName(prop(l, "quality"));
        if (camLight || audioOnly || from === undefined) reason = "quality needs a layer with video";
      } else if (key === "sampling_quality") {
        from = samplingName(prop(l, "samplingQuality"));
        if (camLight || audioOnly || from === undefined) reason = "sampling quality needs a layer with video (AE 12+)";
      } else if (key === "blend_mode") {
        from = blendName(prop(l, "blendingMode"));
        if (camLight || audioOnly || from === undefined) reason = "blend mode needs a layer with video";
      }
      if (reason !== null) {
        skip(plan, l, reason, key);
      } else if (from === want) {
        plan.work.unchanged++;
      } else {
        changes.push({ id: l.id, key: key, from: from, to: want });
      }
    }
    return changes;
  }

  function planSwitches(comp, args, plan) {
    var targets = selectionOf(comp, args, true);
    setTargets(plan, targets);
    var any = false;
    var i;
    for (i = 0; i < SWITCH_KEYS.length; i++) {
      if (args[SWITCH_KEYS[i]] !== undefined && args[SWITCH_KEYS[i]] !== null) any = true;
    }
    if (!any) fail("bad_args", "switches needs at least one of: " + SWITCH_KEYS.join(", "));
    if (args.blend_mode !== undefined && args.blend_mode !== null && blendValue(args.blend_mode) === undefined) {
      fail("bad_args", "This AE has no blend mode \"" + args.blend_mode + "\"");
    }
    if (args.quality !== undefined && args.quality !== null && qualityValue(args.quality) === undefined) {
      fail("bad_args", "Unknown layer quality \"" + args.quality + "\"; use best, draft or wireframe");
    }
    if (args.sampling_quality !== undefined && args.sampling_quality !== null && samplingValue(args.sampling_quality) === undefined) {
      fail("bad_args", "Unknown sampling quality \"" + args.sampling_quality + "\" (bilinear or bicubic; AE 12+)");
    }
    if (args.label_color !== undefined && args.label_color !== null) {
      if (!isNum(args.label_color) || Math.floor(args.label_color) !== args.label_color || args.label_color < 0 || args.label_color > 16) {
        fail("bad_args", "label_color must be a whole number from 0 to 16");
      }
    }
    plan.work.unchanged = 0;
    var changes = [];
    var byLayer = [];
    var needsUnlock = [];
    for (i = 0; i < targets.length; i++) {
      var list = switchPlanFor(targets[i], args, plan);
      if (list.length === 0) continue;
      byLayer.push({ layer: targets[i], changes: list });
      var other = false;
      for (var c = 0; c < list.length; c++) {
        changes.push(list[c]);
        if (list[c].key !== "locked") other = true;
      }
      if (other && args.locked !== false) needsUnlock.push(targets[i]);
    }
    plan.out.changes = changes.slice(0, MAX_REPORT);
    plan.out.changes_truncated = changes.length > MAX_REPORT;
    plan.out.unchanged = plan.work.unchanged;
    plan.work.byLayer = byLayer;
    plan.work.todo = changes.length;
    plan.lockCandidates = needsUnlock;
    plan.selfLock = true;
  }

  function buildPlan(comp, args) {
    var action = args.action;
    var plan = newPlan(action);
    if (action === "parent") planParent(comp, args, plan);
    else if (action === "reorder") planReorder(comp, args, plan);
    else if (action === "sort") planSort(comp, args, plan);
    else if (action === "duplicate") planDuplicate(comp, args, plan);
    else if (action === "delete") planDelete(comp, args, plan);
    else if (action === "trim") planTrim(comp, args, plan);
    else if (action === "rename") planRename(comp, args, plan);
    else if (action === "switches") planSwitches(comp, args, plan);
    else fail("bad_args", "Unknown action \"" + action + "\"");
    // Locked layers refuse edits: they are unlocked and relocked in the same
    // call when the caller says so, and the call is refused when not.
    var locked = [];
    var seen = {};
    for (var i = 0; i < plan.lockCandidates.length; i++) {
      var l = plan.lockCandidates[i];
      if (l && !seen[l.id] && prop(l, "locked") === true) {
        seen[l.id] = true;
        locked.push(l);
      }
    }
    plan.work.locked = locked;
    plan.out.locked = [];
    for (var j = 0; j < locked.length && j < MAX_REPORT; j++) plan.out.locked.push(describe(locked[j]));
    plan.out.unlock_locked = args.unlock_locked === true;
    return plan;
  }

  A.layeropsPlan = function (args) {
    var comp = requireComp(args.comp_id);
    var plan = buildPlan(comp, args);
    var out = plan.out;
    out.dry_run = true;
    out.would_change = plan.work.todo;
    if (plan.work.locked.length > 0 && args.unlock_locked !== true) {
      out.warnings.push(plan.work.locked.length + " locked layer(s) need editing: the real call is refused unless unlock_locked is true");
    }
    return out;
  };

  // ---------- applying ----------

  function applyParent(plan, result) {
    var applied = [];
    var w = plan.work;
    for (var i = 0; i < w.apply.length; i++) {
      var t = w.apply[i];
      try {
        if (w.newParent === null) {
          if (w.jump) t.setParentWithJump();
          else t.parent = null;
        } else if (w.jump) {
          t.setParentWithJump(w.newParent);
        } else {
          t.parent = w.newParent;
        }
        applied.push(t.id);
      } catch (e) {
        skip(plan, t, "AE refused: " + e.message);
      }
    }
    result.applied_ids = applied;
  }

  function applyMoves(comp, plan, result) {
    var map = layerMap(comp);
    var moved = [];
    var moves = plan.work.moves;
    for (var i = 0; i < moves.length; i++) {
      var layer = map[moves[i].id];
      try {
        if (moves[i].after_id === null) layer.moveToBeginning();
        else layer.moveAfter(map[moves[i].after_id]);
        moved.push(layer.id);
      } catch (e) {
        skip(plan, layer, "AE refused to move it: " + e.message);
      }
    }
    result.moved_ids = moved;
  }

  function applyDuplicate(comp, plan, result) {
    var w = plan.work;
    var made = [];
    var i;
    var c;
    // Bottom to top, so the copies come out in the stack's order.
    for (i = w.apply.length - 1; i >= 0; i--) {
      var t = w.apply[i];
      try {
        if (w.dest) {
          var known = {};
          for (var k = 1; k <= w.dest.numLayers; k++) known[w.dest.layer(k).id] = true;
          t.copyToComp(w.dest);
          // copyToComp returns nothing: the new layer is the one that was not there before.
          for (var m = 1; m <= w.dest.numLayers; m++) {
            var dl = w.dest.layer(m);
            if (!known[dl.id]) made.push({ source_id: t.id, id: dl.id, name: dl.name, index: dl.index });
          }
        } else {
          for (c = 0; c < w.count; c++) {
            var d = t.duplicate();
            made.push({ source_id: t.id, id: d.id, name: d.name, index: d.index });
          }
        }
      } catch (e) {
        skip(plan, t, "AE refused to copy it: " + e.message);
      }
    }
    result.duplicates = made.slice(0, MAX_REPORT);
    result.duplicates_total = made.length;
  }

  function applyDelete(plan, result) {
    var gone = [];
    var list = plan.work.apply;
    for (var i = list.length - 1; i >= 0; i--) {
      var t = list[i];
      var info = { id: t.id, name: t.name };
      try {
        t.remove();
        gone.push(info);
      } catch (e) {
        skip(plan, t, "AE refused to delete it: " + e.message);
      }
    }
    result.deleted = gone.slice(0, MAX_REPORT);
    result.deleted_total = gone.length;
  }

  function applyTrim(plan, result) {
    var w = plan.work;
    var done = [];
    var partial = [];
    for (var i = 0; i < w.apply.length; i++) {
      var t = w.apply[i];
      var tr = w.trims[i];
      var before = { s: t.startTime, i: t.inPoint, o: t.outPoint };
      try {
        if (w.hasStart) t.startTime = tr.start_time;
        // Set the point that moves away from the other one first, so the in point is never past the out point.
        if (tr.in_point >= t.outPoint) {
          t.outPoint = tr.out_point;
          t.inPoint = tr.in_point;
        } else {
          t.inPoint = tr.in_point;
          t.outPoint = tr.out_point;
        }
        done.push(t.id);
      } catch (e) {
        // Put back what was read before the try, so a half-applied trim does not stay.
        var restored = true;
        try {
          t.startTime = before.s;
          t.inPoint = before.i;
          t.outPoint = before.o;
        } catch (eB) {
          restored = false;
          partial.push(t.id);
        }
        var why = "AE refused: " + e.message;
        if (!restored) why += " (the layer may be partly trimmed)";
        skip(plan, t, why);
      }
    }
    result.applied_ids = done;
    result.partial_ids = partial;
  }

  function jsString(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  function applyRename(plan, result) {
    var w = plan.work;
    var done = [];
    var fixes = 0;
    var i;
    for (i = 0; i < w.apply.length; i++) {
      var t = w.apply[i];
      try {
        t.name = w.renames[i].to;
        done.push(t.id);
      } catch (e) {
        skip(plan, t, "AE refused: " + e.message);
      }
    }
    result.applied_ids = done;
    if (w.fixRefs) {
      if (typeof app.project.autoFixExpressions !== "function") {
        plan.out.warnings.push("This AE has no Project.autoFixExpressions; name references in expressions were not repaired");
      } else {
        // Repairs only expressions that now error; a reference AE already updated is left alone.
        for (i = 0; i < w.renames.length; i++) {
          if (indexOfId(done, w.renames[i].id) === -1) continue;
          try {
            app.project.autoFixExpressions("\"" + jsString(w.renames[i].from) + "\"", "\"" + jsString(w.renames[i].to) + "\"");
            fixes++;
          } catch (e2) {}
        }
      }
    }
    result.name_fixes_attempted = fixes;
  }

  function setSwitch(l, key, to) {
    if (key === "shy") l.shy = to;
    else if (key === "solo") l.solo = to;
    else if (key === "locked") l.locked = to;
    else if (key === "enabled") l.enabled = to;
    else if (key === "guide") l.guideLayer = to;
    else if (key === "collapse_transformations") l.collapseTransformation = to;
    else if (key === "three_d") l.threeDLayer = to;
    else if (key === "motion_blur") l.motionBlur = to;
    else if (key === "label_color") l.label = to;
    else if (key === "quality") l.quality = qualityValue(to);
    else if (key === "sampling_quality") l.samplingQuality = samplingValue(to);
    else if (key === "blend_mode") l.blendingMode = blendValue(to);
  }

  function applySwitches(plan, args, result) {
    var applied = [];
    var unlocked = [];
    var relocked = [];
    var list = plan.work.byLayer;
    for (var i = 0; i < list.length; i++) {
      var l = list[i].layer;
      var changes = list[i].changes;
      var wasLocked = prop(l, "locked") === true;
      var other = false;
      var c;
      for (c = 0; c < changes.length; c++) {
        if (changes[c].key !== "locked") other = true;
      }
      try {
        if (wasLocked && other) {
          l.locked = false;
          unlocked.push(l.id);
        }
        for (c = 0; c < changes.length; c++) {
          if (changes[c].key === "locked") continue;
          try {
            setSwitch(l, changes[c].key, changes[c].to);
            applied.push({ id: l.id, key: changes[c].key, from: changes[c].from, to: changes[c].to });
          } catch (e1) {
            skip(plan, l, "AE refused: " + e1.message, changes[c].key);
          }
        }
      } finally {
        // The lock ends as asked, or as it was.
        var finalLock = wasLocked;
        if (args.locked !== undefined && args.locked !== null) finalLock = args.locked;
        try {
          if ((prop(l, "locked") === true) !== finalLock) l.locked = finalLock;
          if (finalLock !== wasLocked) applied.push({ id: l.id, key: "locked", from: wasLocked, to: finalLock });
          if (wasLocked && other && finalLock) relocked.push(l.id);
        } catch (e2) {
          skip(plan, l, "AE refused to set the lock: " + e2.message, "locked");
        }
      }
    }
    result.changes = applied.slice(0, MAX_REPORT);
    result.changes_total = applied.length;
    result.unlocked = unlocked;
    result.relocked = relocked;
  }

  A.layeropsApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var plan = buildPlan(comp, args);
    var out = plan.out;
    var locked = plan.work.locked;
    if (locked.length > 0 && args.unlock_locked !== true) {
      var names = [];
      for (var n = 0; n < locked.length && n < 10; n++) names.push("\"" + locked[n].name + "\"");
      fail(
        "locked",
        locked.length + " locked layer(s) would be edited: " + names.join(", ") + ". Pass unlock_locked: true to unlock and relock them in the same call, or unlock them first.",
        { actual: idList(locked) }
      );
    }
    var result = out;
    result.dry_run = false;
    result.no_op = plan.work.todo === 0;
    if (result.no_op) return result;

    var action = args.action;
    var label = args.label || "Chroma AE MCP: layer ops (" + action + ")";
    return A.withUndo(label, function () {
      var i;
      var relock = [];
      var relockIds = [];
      // Switches handle their own lock; every other action unlocks first and relocks after.
      if (!plan.selfLock) {
        for (i = 0; i < locked.length; i++) {
          try {
            locked[i].locked = false;
            relock.push(locked[i]);
            relockIds.push(locked[i].id);
          } catch (eU) {
            skip(plan, locked[i], "AE refused to unlock it: " + eU.message);
          }
        }
      }
      try {
        if (action === "parent") applyParent(plan, result);
        else if (action === "reorder" || action === "sort") applyMoves(comp, plan, result);
        else if (action === "duplicate") applyDuplicate(comp, plan, result);
        else if (action === "delete") applyDelete(plan, result);
        else if (action === "trim") applyTrim(plan, result);
        else if (action === "rename") applyRename(plan, result);
        else if (action === "switches") applySwitches(plan, args, result);
      } finally {
        if (!plan.selfLock) {
          var again = [];
          // A deleted layer is gone and can't be relocked; setting it throws and is ignored.
          // Ids were read before the write: a removed layer's properties throw.
          for (i = 0; i < relock.length; i++) {
            try {
              relock[i].locked = true;
              again.push(relockIds[i]);
            } catch (eR) {}
          }
          result.unlocked = relockIds;
          result.relocked = again;
        }
      }
      return result;
    });
  };
})($.global);
