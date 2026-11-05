// panel/host/ext/animate.jsx
//
// Host functions for Task G3 "animate":
// - setKeyframeEase / getKeyframeEase
// - setText / getTextDocument
// - importFootage / getFootageItems
// - replaceFootage / getFootageItem
// - animateKeyExtras (per-key interpolation, tangents, continuity, roving, labels; also applied by the two ease writers)
// - animateReloadTargets / animateReloadFootage (FileSource.reload)
// - setText also takes typography, paragraph and box options, per-paragraph character styles and checked fonts;
//   importFootage also takes import_as, range, force_alphabetical and placeholders.
//
// Credits:
// - Adapted from Engine-Room-Games/after-effects-mcp (MIT License):
//   reference/engine-room keyframes.jsx (temporal ease dimension derivation and 1-2-3-4 fallback ladder),
//   reference/engine-room text.jsx and docs/fragile-areas-ae.md (TextDocument round-trip and justification re-assertion),
//   reference/engine-room footage.jsx (ImportOptions sequence handling and SVG viewBox dimension check).
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

  var MAX_LIST = 500;
  var MAX_STRING = 20000;

  // ---------- error & guard helpers ----------

  function fail(kind, message, extra) {
    var e = new Error(message);
    e.__kind = kind;
    if (extra) {
      if (extra.actual !== undefined) e.__actual = extra.actual;
      if (extra.expected !== undefined) e.__expected = extra.expected;
      if (extra.line !== undefined) e.__line = extra.line;
      if (extra.sourceText !== undefined) e.__sourceText = extra.sourceText;
    }
    throw e;
  }

  function projectPath() {
    var f = app.project.file;
    if (!f) return "<unsaved>";
    return f.fsName;
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
          actual: {
            project_path: g.project_path,
            comp_id: g.comp_id,
            comp_is_valid: g.comp_is_valid
          }
        }
      );
    }
  }

  function compById(id) {
    var item = null;
    try {
      item = app.project.itemByID(id);
    } catch (e) {
      item = null;
    }
    if (item && item instanceof CompItem) return item;
    return null;
  }

  function requireComp(id) {
    var c = compById(id);
    if (!c) fail("not_found", "No CompItem with id " + id);
    return c;
  }

  function requireFootage(id) {
    var item = null;
    try {
      item = app.project.itemByID(id);
    } catch (e) {
      item = null;
    }
    if (!item) fail("not_found", "No project item with id " + id);
    if (!(item instanceof FootageItem)) {
      fail("bad_args", "Project item " + id + " (" + item.name + ") is not a FootageItem");
    }
    return item;
  }

  function findLayer(comp, sel) {
    var i;
    if (!sel) fail("bad_args", "layer selector missing");
    if (sel.id !== undefined && sel.id !== null) {
      for (i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        if (l.id === sel.id) return l;
      }
      fail("not_found", "No layer with id " + sel.id + " in comp " + comp.id);
    }
    if (sel.index !== undefined && sel.index !== null) {
      if (sel.index < 1 || sel.index > comp.numLayers) {
        fail("not_found", "Layer index " + sel.index + " out of range");
      }
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

  function resolvePath(layer, path) {
    if (!path || !path.length) {
      fail("bad_args", "Property path must be a non-empty array");
    }
    var p = layer;
    for (var i = 0; i < path.length; i++) {
      var next = null;
      try {
        next = p.property(path[i]);
      } catch (e) {
        next = null;
      }
      if (!next) {
        fail(
          "not_found",
          "Property path not found at \"" + path[i] + "\" (" + path.join(" > ") + ")"
        );
      }
      p = next;
    }
    return p;
  }

  function boundString(s) {
    var str = String(s);
    if (str.length > MAX_STRING) {
      return str.substring(0, MAX_STRING) + " ...[truncated]";
    }
    return str;
  }

  function serialiseValue(v) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === "number" || t === "boolean") return v;
    if (t === "string") return boundString(v);
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length && i < MAX_LIST; i++) {
        a.push(serialiseValue(v[i]));
      }
      return a;
    }
    if (v instanceof TextDocument) {
      return serialiseTextDoc(v);
    }
    try {
      return "[" + v.reflect.name + "]";
    } catch (e) {}
    return boundString(v);
  }

  // ---------- 1. Keyframe Easing (credits: reference/engine-room keyframes.jsx, MIT) ----------

  function clampInfluence(val) {
    var n = Number(val);
    if (isNaN(n) || !isFinite(n)) {
      fail("bad_args", "KeyframeEase influence must be a finite number");
    }
    if (n < 0.1) return 0.1;
    if (n > 100) return 100;
    return n;
  }

  function deriveEaseDimensions(p) {
    try {
      if (p.isSpatial) return 1;
    } catch (e1) {}
    try {
      var pvt = p.propertyValueType;
      if (
        pvt === PropertyValueType.TwoD_SPATIAL ||
        pvt === PropertyValueType.ThreeD_SPATIAL
      ) {
        return 1;
      }
      if (pvt === PropertyValueType.ThreeD) {
        return 3;
      }
      if (pvt === PropertyValueType.TwoD) {
        return 2;
      }
      if (pvt === PropertyValueType.COLOR) {
        return 4;
      }
      if (pvt === PropertyValueType.OneD) {
        return 1;
      }
    } catch (e2) {}
    return 1;
  }

  function makeEaseArray(speed, influence, dims) {
    var arr = [];
    for (var i = 0; i < dims; i++) {
      arr.push(new KeyframeEase(speed, influence));
    }
    return arr;
  }

  // Derives the expected dimension count for the property and walks a 1-2-3-4
  // fallback ladder if After Effects rejects the derived count (see fragile-areas-ae.md).
  function applyTemporalEaseWithLadder(p, keyIndex, inSpeed, inInfluence, outSpeed, outInfluence) {
    var preferred = deriveEaseDimensions(p);
    var candidates = [preferred];
    for (var d = 1; d <= 4; d++) {
      if (d !== preferred) {
        candidates.push(d);
      }
    }
    var firstErr = null;
    for (var c = 0; c < candidates.length; c++) {
      var dims = candidates[c];
      var inArr = makeEaseArray(inSpeed, inInfluence, dims);
      var outArr = makeEaseArray(outSpeed, outInfluence, dims);
      try {
        p.setTemporalEaseAtKey(keyIndex, inArr, outArr);
        return dims;
      } catch (e) {
        if (firstErr === null) {
          firstErr = e;
        }
      }
    }
    if (firstErr !== null) {
      throw firstErr;
    }
    return preferred;
  }

  function interpToName(interpVal) {
    try {
      if (interpVal === KeyframeInterpolationType.LINEAR) return "linear";
      if (interpVal === KeyframeInterpolationType.HOLD) return "hold";
      if (interpVal === KeyframeInterpolationType.BEZIER) return "bezier";
    } catch (e) {}
    return String(interpVal);
  }

  function serialiseEaseList(easeList) {
    var out = [];
    if (!easeList) return out;
    for (var i = 0; i < easeList.length && i < 4; i++) {
      out.push({
        speed: easeList[i].speed,
        influence: easeList[i].influence
      });
    }
    return out;
  }

  // lo and hi (optional, seconds) pick keys before the cap, so a range past
  // key 500 can still be read; truncated means more keys in range exist.
  function readPropertyKeyframes(p, lo, hi) {
    var keys = [];
    var n = p.numKeys;
    var truncated = false;
    if (lo === undefined || lo === null) lo = -1e9;
    if (hi === undefined || hi === null) hi = 1e9;
    // Spatial tangents let the server measure path length for curve easing.
    var spatial = false;
    try {
      spatial = p.isSpatial === true;
    } catch (eSp) {}
    // Which keys are selected in the timeline, and the key labels (22.6): additive fields.
    var selMap = null;
    try {
      var selKeys = p.selectedKeys;
      if (selKeys && typeof selKeys.length === "number") {
        selMap = {};
        for (var si = 0; si < selKeys.length; si++) selMap[selKeys[si]] = true;
      }
    } catch (eSel) {
      selMap = null;
    }
    var hasKeySelected = false;
    var hasKeyLabel = false;
    try { hasKeySelected = typeof p.keySelected === "function"; } catch (eHs) {}
    try { hasKeyLabel = typeof p.keyLabel === "function"; } catch (eHl) {}
    for (var k = 1; k <= n; k++) {
      var kt = p.keyTime(k);
      if (kt < lo - 0.0005 || kt > hi + 0.0005) continue;
      if (keys.length >= MAX_LIST) {
        truncated = true;
        break;
      }
      var kv = null;
      try {
        kv = serialiseValue(p.keyValue(k));
      } catch (e1) {}
      var inIt = null;
      var outIt = null;
      try {
        inIt = interpToName(p.keyInInterpolationType(k));
      } catch (e2) {}
      try {
        outIt = interpToName(p.keyOutInterpolationType(k));
      } catch (e3) {}
      var easeIn = [];
      var easeOut = [];
      try {
        easeIn = serialiseEaseList(p.keyInTemporalEase(k));
      } catch (e4) {}
      try {
        easeOut = serialiseEaseList(p.keyOutTemporalEase(k));
      } catch (e5) {}
      var entry = {
        keyIndex: k,
        time: kt,
        value: kv,
        inInterp: inIt,
        outInterp: outIt,
        easeIn: easeIn,
        easeOut: easeOut
      };
      if (spatial) {
        try {
          entry.inTangent = serialiseValue(p.keyInSpatialTangent(k));
        } catch (e6) {}
        try {
          entry.outTangent = serialiseValue(p.keyOutSpatialTangent(k));
        } catch (e7) {}
        // Roving keys have no fixed time: AE spreads them for an even speed.
        try { entry.roving = p.keyRoving(k) === true; } catch (e8) {}
        try { entry.spatialContinuous = p.keySpatialContinuous(k) === true; } catch (e9) {}
        try { entry.spatialAutoBezier = p.keySpatialAutoBezier(k) === true; } catch (e10) {}
      }
      try { entry.temporalContinuous = p.keyTemporalContinuous(k) === true; } catch (e11) {}
      try { entry.temporalAutoBezier = p.keyTemporalAutoBezier(k) === true; } catch (e12) {}
      if (selMap !== null) {
        entry.selected = selMap[k] === true;
      } else if (hasKeySelected) {
        try { entry.selected = p.keySelected(k) === true; } catch (eKs) {}
      }
      if (hasKeyLabel) {
        try { entry.label = p.keyLabel(k); } catch (eKl) {}
      }
      keys.push(entry);
    }
    var out = {
      name: p.name,
      matchName: p.matchName,
      isSpatial: spatial,
      numKeys: n,
      keyframes: keys
    };
    if (truncated) {
      out.truncated = true;
    }
    return out;
  }

  A.getKeyframeEase = function (args) {
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var p = resolvePath(l, args.path);
    if (p.propertyType !== PropertyType.PROPERTY) {
      fail("bad_args", "Path resolves to a group, not a property");
    }
    var info = readPropertyKeyframes(p, args.start, args.end);
    info.comp_id = c.id;
    info.layer_id = l.id;
    info.layer_index = l.index;
    return info;
  };

  A.setKeyframeEase = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var p = resolvePath(l, args.path);
    if (p.propertyType !== PropertyType.PROPERTY) {
      fail("bad_args", "Path resolves to a group, not a property");
    }
    if (p.numKeys < 1) {
      fail("bad_args", "Property has no keyframes: " + args.path.join(" > "));
    }

    var keyIndices = [];
    if (args.keys && args.keys.length > 0) {
      for (var i = 0; i < args.keys.length; i++) {
        var ki = Number(args.keys[i]);
        if (isNaN(ki) || Math.floor(ki) !== ki || ki < 1 || ki > p.numKeys) {
          fail(
            "bad_args",
            "Keyframe index " + args.keys[i] + " out of range (1.." + p.numKeys + ")"
          );
        }
        keyIndices.push(ki);
      }
    } else {
      for (var k = 1; k <= p.numKeys; k++) {
        keyIndices.push(k);
      }
    }

    var easeArg = args.ease;
    var inSpeed = 0;
    var inInfluence = 33.333333;
    var outSpeed = 0;
    var outInfluence = 33.333333;
    var targetInterp = KeyframeInterpolationType.BEZIER;
    var modeName = "custom";

    if (easeArg === "easy_ease") {
      inSpeed = 0;
      inInfluence = 33.333333;
      outSpeed = 0;
      outInfluence = 33.333333;
      targetInterp = KeyframeInterpolationType.BEZIER;
      modeName = "easy_ease";
    } else if (easeArg === "linear") {
      inSpeed = 0;
      inInfluence = 0.1;
      outSpeed = 0;
      outInfluence = 0.1;
      targetInterp = KeyframeInterpolationType.LINEAR;
      modeName = "linear";
    } else if (easeArg === "hold") {
      inSpeed = 0;
      inInfluence = 0.1;
      outSpeed = 0;
      outInfluence = 0.1;
      targetInterp = KeyframeInterpolationType.HOLD;
      modeName = "hold";
    } else if (easeArg && typeof easeArg === "object" && easeArg["in"] && easeArg.out) {
      inSpeed = Number(easeArg["in"].speed);
      inInfluence = clampInfluence(easeArg["in"].influence);
      outSpeed = Number(easeArg.out.speed);
      outInfluence = clampInfluence(easeArg.out.influence);
      if (isNaN(inSpeed) || !isFinite(inSpeed) || isNaN(outSpeed) || !isFinite(outSpeed)) {
        fail("bad_args", "KeyframeEase speed must be a finite number");
      }
      targetInterp = KeyframeInterpolationType.BEZIER;
      modeName = "custom";
    } else {
      fail(
        "bad_args",
        "ease must be 'easy_ease', 'linear', 'hold', or {in:{speed,influence}, out:{speed,influence}}"
      );
    }

    // Keys strictly between the first and last given key go roving, so a
    // move eased at its ends keeps one smooth speed through them. AE allows
    // roving on spatial properties only; refuse before anything changes.
    var rove = [];
    if (args.rove_between === true) {
      var spatialProp = false;
      try { spatialProp = p.isSpatial === true; } catch (eSpatial) {}
      if (!spatialProp) {
        fail("bad_args", "Roving works on spatial properties only (Position, Anchor Point); \"" + p.name + "\" is not one");
      }
      if (modeName === "hold") {
        fail("bad_args", "rove_between can't be combined with hold: held keys have no speed for roving to even out");
      }
      var lo = keyIndices[0];
      var hi = keyIndices[0];
      for (var r = 1; r < keyIndices.length; r++) {
        if (keyIndices[r] < lo) lo = keyIndices[r];
        if (keyIndices[r] > hi) hi = keyIndices[r];
      }
      for (var m = lo + 1; m < hi; m++) rove.push(m);
    }

    // Per-key extras (different in / out interpolation, tangents, continuity, roving, label): checked now.
    var extrasPlan = null;
    if (hasKeyExtras(args.extras)) {
      if (args.rove_between === true && args.extras.roving !== undefined && args.extras.roving !== null) {
        fail("bad_args", "rove_between and roving both set roving; give one of them");
      }
      extrasPlan = planKeyExtras(p, keyIndices, args.extras, easeInterpOf(easeArg));
    }

    return A.withUndo("Chroma AE MCP: set_keyframe_ease " + args.path.join(" > "), function () {
      var usedDims = deriveEaseDimensions(p);
      for (var j = 0; j < keyIndices.length; j++) {
        var idx = keyIndices[j];
        if (modeName === "hold") {
          try {
            usedDims = applyTemporalEaseWithLadder(
              p,
              idx,
              inSpeed,
              inInfluence,
              outSpeed,
              outInfluence
            );
          } catch (eHoldEase) {}
          p.setInterpolationTypeAtKey(idx, targetInterp, targetInterp);
        } else {
          usedDims = applyTemporalEaseWithLadder(
            p,
            idx,
            inSpeed,
            inInfluence,
            outSpeed,
            outInfluence
          );
          p.setInterpolationTypeAtKey(idx, targetInterp, targetInterp);
        }
      }
      var extraApplied = [];
      var extraFailed = [];
      if (extrasPlan !== null) extraApplied = applyKeyExtras(p, keyIndices, extrasPlan, extraFailed);
      // After the ends are eased, so AE retimes the roving keys against them.
      // A key AE won't rove (it may throw, or ignore the call) is reported, not
      // fatal: the eases above stay in this one undo group and the read-back
      // flags any key that didn't rove.
      var rovingFailed = [];
      for (var q = 0; q < rove.length; q++) {
        try { p.setRovingAtKey(rove[q], true); } catch (eRove) { rovingFailed.push(rove[q]); }
      }
      var easeResult = {
        comp_id: c.id,
        layer_id: l.id,
        path: args.path,
        keysUpdated: keyIndices,
        roving: rove,
        roving_failed: rovingFailed,
        numKeys: p.numKeys,
        easeDimensions: usedDims,
        mode: modeName
      };
      if (extrasPlan !== null) {
        easeResult.extras = { applied: extraApplied, roving: rovingKeys(extrasPlan, keyIndices), roving_failed: extraFailed };
      }
      return easeResult;
    });
  };

  function easeListFromArgs(list, dims, what) {
    if (!(list instanceof Array) || list.length !== dims) {
      fail("bad_args", what + " must list " + dims + " {speed, influence} entries");
    }
    var arr = [];
    for (var i = 0; i < list.length; i++) {
      var sp = Number(list[i].speed);
      if (isNaN(sp) || !isFinite(sp)) {
        fail("bad_args", what + " speed must be a finite number");
      }
      arr.push(new KeyframeEase(sp, clampInfluence(list[i].influence)));
    }
    return arr;
  }

  function copyEaseList(list) {
    var arr = [];
    for (var i = 0; i < list.length; i++) {
      arr.push(new KeyframeEase(list[i].speed, list[i].influence));
    }
    return arr;
  }

  // Sets the in and/or out ease of individual keys, keeping each side that is
  // not given. The server computes the sides from a curve (curveToSides).
  A.setKeyframeEaseSides = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var p = resolvePath(l, args.path);
    if (p.propertyType !== PropertyType.PROPERTY) {
      fail("bad_args", "Path resolves to a group, not a property");
    }
    var sides = args.sides;
    if (!(sides instanceof Array) || sides.length === 0) {
      fail("bad_args", "sides must be a non-empty array");
    }

    var plan = [];
    for (var i = 0; i < sides.length; i++) {
      var k = Number(sides[i].key);
      if (isNaN(k) || Math.floor(k) !== k || k < 1 || k > p.numKeys) {
        fail("bad_args", "Keyframe index " + sides[i].key + " out of range (1.." + p.numKeys + ")");
      }
      var dims = p.keyInTemporalEase(k).length;
      var step = { key: k, easeIn: null, easeOut: null };
      if (sides[i]["in"]) {
        step.easeIn = easeListFromArgs(sides[i]["in"], dims, "in ease of key " + k);
      }
      if (sides[i].out) {
        step.easeOut = easeListFromArgs(sides[i].out, dims, "out ease of key " + k);
      }
      plan.push(step);
    }

    var sidesExtras = null;
    var sideKeys = [];
    if (hasKeyExtras(args.extras)) {
      for (var sk = 0; sk < plan.length; sk++) sideKeys.push(plan[sk].key);
      sidesExtras = planKeyExtras(p, sideKeys, args.extras, "bezier");
    }

    return A.withUndo("Chroma AE MCP: set_keyframe_ease (curve) " + args.path.join(" > "), function () {
      var updated = [];
      for (var j = 0; j < plan.length; j++) {
        var key = plan[j].key;
        var inType = KeyframeInterpolationType.BEZIER;
        var inArr = plan[j].easeIn;
        if (!inArr) {
          inType = p.keyInInterpolationType(key);
          // in_interp 'bezier' (the only value accepted next to a curve) applies to a side the curve leaves alone too.
          if (sidesExtras !== null && sidesExtras.inInterp !== null) inType = sidesExtras.inInterp;
          inArr = copyEaseList(p.keyInTemporalEase(key));
        }
        var outType = KeyframeInterpolationType.BEZIER;
        var outArr = plan[j].easeOut;
        if (!outArr) {
          outType = p.keyOutInterpolationType(key);
          if (sidesExtras !== null && sidesExtras.outInterp !== null) outType = sidesExtras.outInterp;
          outArr = copyEaseList(p.keyOutTemporalEase(key));
        }
        // Auto and continuous keys would recompute or average the speeds.
        try {
          p.setTemporalAutoBezierAtKey(key, false);
        } catch (eAuto) {}
        try {
          p.setTemporalContinuousAtKey(key, false);
        } catch (eCont) {}
        p.setInterpolationTypeAtKey(key, inType, outType);
        p.setTemporalEaseAtKey(key, inArr, outArr);
        updated.push(key);
      }
      var curveResult = {
        comp_id: c.id,
        layer_id: l.id,
        path: args.path,
        keysUpdated: updated,
        numKeys: p.numKeys,
        mode: "curve"
      };
      if (sidesExtras !== null) {
        var sideFailed = [];
        var sideApplied = applyKeyExtras(p, sideKeys, sidesExtras, sideFailed);
        curveResult.extras = { applied: sideApplied, roving: rovingKeys(sidesExtras, sideKeys), roving_failed: sideFailed };
      }
      return curveResult;
    });
  };

  // ---------- 1b. Per-key extras (animateKeyExtras and the extras of the two ease writers) ----------
  //
  // in_interp / out_interp, in_tangent / out_tangent, the four continuity flags, roving and label.
  // Order per key: interpolation, then (the callers' ease), then continuity and tangents, then
  // roving last. Everything is checked before the undo group opens.

  var EXTRA_FIELDS = [
    "in_interp", "out_interp", "in_tangent", "out_tangent", "spatial_continuous", "spatial_auto_bezier",
    "temporal_continuous", "temporal_auto_bezier", "roving", "label"
  ];

  function hasKeyExtras(x) {
    if (!x || typeof x !== "object") return false;
    for (var i = 0; i < EXTRA_FIELDS.length; i++) {
      if (x[EXTRA_FIELDS[i]] !== undefined && x[EXTRA_FIELDS[i]] !== null) return true;
    }
    return false;
  }

  function interpFromName(name, what) {
    if (name === "linear") return KeyframeInterpolationType.LINEAR;
    if (name === "bezier") return KeyframeInterpolationType.BEZIER;
    if (name === "hold") return KeyframeInterpolationType.HOLD;
    fail("bad_args", what + " must be 'linear', 'bezier' or 'hold'");
    return null;
  }

  function numberList(v) {
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(Number(v[i]));
    return out;
  }

  function checkTangentArg(v, what) {
    if (!v || typeof v.length !== "number" || (v.length !== 2 && v.length !== 3)) {
      fail("bad_args", what + " must be an array of 2 or 3 numbers");
    }
    for (var i = 0; i < v.length; i++) {
      if (!isNum(v[i])) fail("bad_args", what + " must hold finite numbers");
    }
    return numberList(v);
  }

  function checkBool(v, what) {
    if (typeof v !== "boolean") fail("bad_args", what + " must be true or false");
    return v;
  }

  // easeInterp is the interpolation the caller's ease sets ("bezier", "linear", "hold"), or null when
  // there is no ease. With an ease, in_interp / out_interp may only repeat that interpolation.
  function planKeyExtras(p, keyIndices, ex, easeInterp) {
    var plan = { inInterp: null, outInterp: null, hasInterp: false, inTangent: null, outTangent: null, flags: {}, roving: null, label: null, spatialProp: false };
    var i;
    var k;
    try { plan.spatialProp = p.isSpatial === true; } catch (eSp) {}
    var spatialOnly = ["in_tangent", "out_tangent", "spatial_continuous", "spatial_auto_bezier"];
    for (i = 0; i < spatialOnly.length; i++) {
      if (ex[spatialOnly[i]] !== undefined && ex[spatialOnly[i]] !== null && !plan.spatialProp) {
        fail("bad_args", spatialOnly[i] + " works on spatial properties only (Position, Anchor Point); \"" + p.name + "\" is not one");
      }
    }
    if (ex.in_interp !== undefined && ex.in_interp !== null) plan.inInterp = interpFromName(ex.in_interp, "in_interp");
    if (ex.out_interp !== undefined && ex.out_interp !== null) plan.outInterp = interpFromName(ex.out_interp, "out_interp");
    if (easeInterp !== null) {
      if ((ex.in_interp !== undefined && ex.in_interp !== null && ex.in_interp !== easeInterp) || (ex.out_interp !== undefined && ex.out_interp !== null && ex.out_interp !== easeInterp)) {
        fail("bad_args", "in_interp / out_interp can't differ from the interpolation `ease` sets (" + easeInterp + "); use an extras-only call (no `ease`) for a mixed in / out interpolation");
      }
    } else {
      plan.hasInterp = plan.inInterp !== null || plan.outInterp !== null;
    }
    if (plan.hasInterp) {
      var types = [plan.inInterp, plan.outInterp];
      for (i = 0; i < types.length; i++) {
        if (types[i] === null) continue;
        if (typeof p.isInterpolationTypeValid === "function") {
          var valid = true;
          try { valid = p.isInterpolationTypeValid(types[i]); } catch (eV) { valid = true; }
          if (valid === false) {
            fail("bad_args", "\"" + p.name + "\" does not accept that interpolation (hold-only properties such as Source Text and checkboxes take hold only)");
          }
        }
      }
    }
    if (ex.in_tangent !== undefined && ex.in_tangent !== null) plan.inTangent = checkTangentArg(ex.in_tangent, "in_tangent");
    if (ex.out_tangent !== undefined && ex.out_tangent !== null) plan.outTangent = checkTangentArg(ex.out_tangent, "out_tangent");
    if (plan.inTangent !== null || plan.outTangent !== null) {
      for (k = 0; k < keyIndices.length; k++) {
        var cur = null;
        try { cur = p.keyInSpatialTangent(keyIndices[k]); } catch (eT) { cur = null; }
        if (cur && typeof cur.length === "number") {
          if (plan.inTangent !== null && plan.inTangent.length !== cur.length) fail("bad_args", "in_tangent needs " + cur.length + " numbers for this property");
          if (plan.outTangent !== null && plan.outTangent.length !== cur.length) fail("bad_args", "out_tangent needs " + cur.length + " numbers for this property");
        }
      }
    }
    var flagNames = ["spatial_continuous", "spatial_auto_bezier", "temporal_continuous", "temporal_auto_bezier"];
    for (i = 0; i < flagNames.length; i++) {
      if (ex[flagNames[i]] !== undefined && ex[flagNames[i]] !== null) plan.flags[flagNames[i]] = checkBool(ex[flagNames[i]], flagNames[i]);
    }
    // Auto bezier implies continuous: asking for auto bezier on and continuous off contradicts itself.
    if (plan.flags.spatial_auto_bezier === true && plan.flags.spatial_continuous === false) fail("bad_args", "spatial_auto_bezier true implies spatial_continuous true");
    if (plan.flags.temporal_auto_bezier === true && plan.flags.temporal_continuous === false) fail("bad_args", "temporal_auto_bezier true implies temporal_continuous true");
    if (plan.flags.spatial_auto_bezier === true && (plan.inTangent !== null || plan.outTangent !== null)) {
      fail("bad_args", "Tangents can't be set while spatial_auto_bezier is true (auto bezier recomputes them)");
    }
    if (ex.roving !== undefined && ex.roving !== null) {
      plan.roving = checkBool(ex.roving, "roving");
      if (plan.roving === true) {
        if (!plan.spatialProp) fail("bad_args", "Roving works on spatial properties only (Position, Anchor Point); \"" + p.name + "\" is not one");
        for (k = 0; k < keyIndices.length; k++) {
          if (keyIndices[k] === 1 || keyIndices[k] === p.numKeys) fail("bad_args", "The first and last keys can't rove (key " + keyIndices[k] + ")");
        }
      }
    }
    if (ex.label !== undefined && ex.label !== null) {
      var lab = Number(ex.label);
      if (!isNum(lab) || Math.floor(lab) !== lab || lab < 0 || lab > 16) fail("bad_args", "label must be a whole number from 0 to 16");
      if (typeof p.setLabelAtKey !== "function") fail("bad_args", "Key labels need After Effects 22.6 or later (Property.setLabelAtKey is missing here); nothing was written");
      plan.label = lab;
    }
    return plan;
  }

  // Runs inside the undo group. Returns the names of the settings applied; roving failures go to `failed`.
  function applyKeyExtras(p, keyIndices, plan, failed) {
    var applied = [];
    for (var j = 0; j < keyIndices.length; j++) {
      var key = keyIndices[j];
      if (plan.hasInterp) {
        var inT = plan.inInterp;
        var outT = plan.outInterp;
        if (inT === null) inT = p.keyInInterpolationType(key);
        if (outT === null) outT = p.keyOutInterpolationType(key);
        p.setInterpolationTypeAtKey(key, inT, outT);
      }
      if (plan.flags.temporal_auto_bezier !== undefined) p.setTemporalAutoBezierAtKey(key, plan.flags.temporal_auto_bezier);
      if (plan.flags.temporal_continuous !== undefined) p.setTemporalContinuousAtKey(key, plan.flags.temporal_continuous);
      // Spatial flags first, then the tangents, so AE does not re-align handles that were just set.
      if (plan.flags.spatial_auto_bezier !== undefined) p.setSpatialAutoBezierAtKey(key, plan.flags.spatial_auto_bezier);
      if (plan.flags.spatial_continuous !== undefined) p.setSpatialContinuousAtKey(key, plan.flags.spatial_continuous);
      if (plan.inTangent !== null || plan.outTangent !== null) {
        var tin = plan.inTangent;
        var tout = plan.outTangent;
        if (tin === null) tin = numberList(p.keyInSpatialTangent(key));
        if (tout === null) tout = numberList(p.keyOutSpatialTangent(key));
        // Tangents on an auto-bezier key would be recomputed straight away.
        if (plan.flags.spatial_auto_bezier === undefined) {
          try { p.setSpatialAutoBezierAtKey(key, false); } catch (eAb) {}
        }
        p.setSpatialTangentsAtKey(key, tin, tout);
      }
      if (plan.label !== null) p.setLabelAtKey(key, plan.label);
      // Roving last: AE retimes a roving key against its neighbours.
      if (plan.roving !== null) {
        try { p.setRovingAtKey(key, plan.roving); } catch (eRv) { failed.push(key); }
      }
    }
    if (plan.hasInterp) applied.push("interpolation");
    if (plan.flags.temporal_auto_bezier !== undefined) applied.push("temporal_auto_bezier");
    if (plan.flags.temporal_continuous !== undefined) applied.push("temporal_continuous");
    if (plan.inTangent !== null) applied.push("in_tangent");
    if (plan.outTangent !== null) applied.push("out_tangent");
    if (plan.flags.spatial_auto_bezier !== undefined) applied.push("spatial_auto_bezier");
    if (plan.flags.spatial_continuous !== undefined) applied.push("spatial_continuous");
    if (plan.label !== null) applied.push("label");
    if (plan.roving !== null) applied.push("roving");
    return applied;
  }

  function rovingKeys(plan, keys) {
    if (plan.roving === true) return keys;
    return [];
  }

  function easeInterpOf(easeArg) {
    if (easeArg === "linear") return "linear";
    if (easeArg === "hold") return "hold";
    return "bezier";
  }

  function keyIndicesOf(p, keys) {
    var out = [];
    var i;
    if (keys && keys.length > 0) {
      for (i = 0; i < keys.length; i++) {
        var ki = Number(keys[i]);
        if (isNaN(ki) || Math.floor(ki) !== ki || ki < 1 || ki > p.numKeys) {
          fail("bad_args", "Keyframe index " + keys[i] + " out of range (1.." + p.numKeys + ")");
        }
        out.push(ki);
      }
    } else {
      for (i = 1; i <= p.numKeys; i++) out.push(i);
    }
    return out;
  }

  // Extras only (no `ease`): the per-key settings the ease tool can't express.
  A.animateKeyExtras = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var p = resolvePath(l, args.path);
    if (p.propertyType !== PropertyType.PROPERTY) {
      fail("bad_args", "Path resolves to a group, not a property");
    }
    if (p.numKeys < 1) {
      fail("bad_args", "Property has no keyframes: " + args.path.join(" > "));
    }
    if (!hasKeyExtras(args.extras)) fail("bad_args", "No per-key settings given");
    var keyIndices = keyIndicesOf(p, args.keys);
    var plan = planKeyExtras(p, keyIndices, args.extras, null);
    return A.withUndo("Chroma AE MCP: set_keyframe_ease (per-key) " + args.path.join(" > "), function () {
      var failed = [];
      var applied = applyKeyExtras(p, keyIndices, plan, failed);
      return {
        comp_id: c.id,
        layer_id: l.id,
        path: args.path,
        keysUpdated: keyIndices,
        numKeys: p.numKeys,
        mode: "extras",
        extras: { applied: applied, roving: rovingKeys(plan, keyIndices), roving_failed: failed }
      };
    });
  };

  // ---------- 2. TextDocument Round-Trip (credits: reference/engine-room text.jsx & fragile-areas-ae.md, MIT) ----------

  function findSourceTextProp(layer) {
    var p = null;
    try {
      var textGroup = layer.property("ADBE Text Properties");
      if (textGroup) {
        p = textGroup.property("ADBE Text Document");
      }
    } catch (e1) {}
    if (!p) {
      try {
        p = layer.property("Source Text");
      } catch (e2) {}
    }
    if (!p) {
      try {
        var tg2 = layer.property("Text");
        if (tg2) {
          p = tg2.property("Source Text");
        }
      } catch (e3) {}
    }
    if (!p) {
      fail("bad_args", "Layer \"" + layer.name + "\" is not a text layer or has no Source Text property");
    }
    return p;
  }

  function justificationToEnum(name) {
    if (name === "left") return ParagraphJustification.LEFT_JUSTIFY;
    if (name === "center") return ParagraphJustification.CENTER_JUSTIFY;
    if (name === "right") return ParagraphJustification.RIGHT_JUSTIFY;
    fail("bad_args", "Invalid justification \"" + name + "\" (expected 'left', 'center', or 'right')");
    return null;
  }

  function justificationFromEnum(val) {
    try {
      if (val === ParagraphJustification.LEFT_JUSTIFY) return "left";
      if (val === ParagraphJustification.CENTER_JUSTIFY) return "center";
      if (val === ParagraphJustification.RIGHT_JUSTIFY) return "right";
      if (val === ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT) return "full_left";
      if (val === ParagraphJustification.FULL_JUSTIFY_LASTLINE_CENTER) return "full_center";
      if (val === ParagraphJustification.FULL_JUSTIFY_LASTLINE_RIGHT) return "full_right";
      if (val === ParagraphJustification.FULL_JUSTIFY_LASTLINE_FULL) return "full";
    } catch (e) {}
    return String(val);
  }

  function serialiseColorArray(arr) {
    if (!arr || !(arr instanceof Array)) return null;
    var out = [];
    for (var i = 0; i < arr.length && i < 4; i++) {
      out.push(Number(arr[i]));
    }
    return out;
  }

  function serialiseTextDoc(doc) {
    var out = {
      text: boundString(doc.text)
    };
    try { out.font = String(doc.font); } catch (e1) {}
    try { out.fontSize = Number(doc.fontSize); } catch (e2) {}
    try { out.tracking = Number(doc.tracking); } catch (e3) {}
    try { out.leading = Number(doc.leading); } catch (e4) {}
    try { out.applyFill = Boolean(doc.applyFill); } catch (e5) {}
    try {
      if (doc.applyFill) {
        out.fillColor = serialiseColorArray(doc.fillColor);
      } else {
        out.fillColor = null;
      }
    } catch (e6) {
      out.fillColor = null;
    }
    try { out.applyStroke = Boolean(doc.applyStroke); } catch (e7) {}
    try {
      if (doc.applyStroke) {
        out.strokeColor = serialiseColorArray(doc.strokeColor);
      } else {
        out.strokeColor = null;
      }
    } catch (e8) {
      out.strokeColor = null;
    }
    try { out.strokeWidth = Number(doc.strokeWidth); } catch (e9) {}
    try { out.justification = justificationFromEnum(doc.justification); } catch (e10) {}
    return out;
  }

  function setSourceTextValue(comp, srcProp, doc) {
    if (srcProp.numKeys > 0) {
      srcProp.setValueAtTime(comp.time, doc);
    } else {
      srcProp.setValue(doc);
    }
  }

  // Per reference/engine-room/docs/fragile-areas-ae.md (issues #93, #94):
  // A TextDocument round-trip in AE 26 can silently reset or mis-store justification.
  // Read back after setValue, re-assert justification once if it moved, and throw
  // if it still disagrees.
  function verifyAndReassertJustification(comp, srcProp, expectedJustEnum) {
    if (expectedJustEnum === null || expectedJustEnum === undefined) {
      return { justification: null, justificationReasserted: false };
    }
    var readBack = srcProp.value;
    var actualJust = null;
    try {
      actualJust = readBack.justification;
    } catch (e1) {}
    if (actualJust === expectedJustEnum) {
      return {
        justification: justificationFromEnum(actualJust),
        justificationReasserted: false
      };
    }

    // Re-assert justification alone once more
    readBack.justification = expectedJustEnum;
    setSourceTextValue(comp, srcProp, readBack);

    var secondRead = srcProp.value;
    var secondJust = null;
    try {
      secondJust = secondRead.justification;
    } catch (e2) {}
    if (secondJust !== expectedJustEnum) {
      var expName = justificationFromEnum(expectedJustEnum);
      var actName = justificationFromEnum(secondJust);
      fail(
        "runtime",
        "TextDocument justification did not stick after re-assertion: expected " +
          expName +
          ", got " +
          actName,
        {
          expected: expName,
          actual: actName
        }
      );
    }
    return {
      justification: justificationFromEnum(secondJust),
      justificationReasserted: true
    };
  }

  // ---------- character ranges (TextDocument.characterRange, AE 24.3+) ----------

  var RANGE_KEYS = ["font", "fontSize", "tracking", "baselineShift", "fillColor", "strokeColor", "strokeWidth", "applyFill", "applyStroke", "fauxBold", "fauxItalic"];
  var MAX_RANGES = 50;
  var MAX_MATCHES = 200;

  function hasRanges(doc) {
    try {
      return typeof doc.characterRange === "function";
    } catch (e) {
      return false;
    }
  }

  function normBreaks(s) {
    return String(s).split("\r\n").join("\n").split("\r").join("\n");
  }

  // The scripting guide does not say whether characterRange's end is part of
  // the range. Ask for the first character and see what text comes back.
  function rangeEndMode(doc) {
    var text = String(doc.text);
    if (text.length === 0) return "exclusive";
    try {
      var t = doc.characterRange(0, 1).text;
      if (t === undefined || t === null) return "exclusive";
      t = normBreaks(t);
      if (t === normBreaks(text.substring(0, 1))) return "exclusive";
      if (text.length > 1 && t === normBreaks(text.substring(0, 2))) return "inclusive";
    } catch (e) {}
    return "exclusive";
  }

  function rangeAt(doc, mode, start, end) {
    if (mode === "inclusive") return doc.characterRange(start, end - 1);
    return doc.characterRange(start, end);
  }

  // A range can't include the final line break.
  function rangeLength(text) {
    var n = text.length;
    if (n > 0) {
      var ch = text.charAt(n - 1);
      if (ch === "\r" || ch === "\n") n--;
    }
    return n;
  }

  // The style fields of one range, read as they are. A field AE reports as
  // undefined (mixed values in the range) is left out and listed in `mixed`.
  function readRangeStyle(r) {
    var style = {};
    var mixed = [];
    for (var i = 0; i < RANGE_KEYS.length; i++) {
      var k = RANGE_KEYS[i];
      var v;
      try {
        v = r[k];
      } catch (e) {
        v = undefined;
      }
      if (v === undefined || v === null) {
        mixed.push(k);
      } else if (k === "fillColor" || k === "strokeColor") {
        style[k] = serialiseColorArray(v);
      } else {
        style[k] = v;
      }
    }
    return { style: style, mixed: mixed };
  }

  function readRanges(doc, ranges) {
    var out = [];
    if (!ranges || typeof ranges.length !== "number") return out;
    if (!hasRanges(doc)) fail("bad_args", "Reading character ranges needs After Effects 24.3 or later (TextDocument.characterRange)");
    var mode = rangeEndMode(doc);
    var text = String(doc.text);
    // Up to MAX_MATCHES, the most resolveRanges can hand out, so a correct write is never read back short.
    for (var i = 0; i < ranges.length && i < MAX_MATCHES; i++) {
      var s = ranges[i].start;
      var e = ranges[i].end;
      if (typeof s !== "number" || typeof e !== "number" || s < 0 || e <= s || e > rangeLength(text)) {
        fail("bad_args", "Range " + i + " is outside the text");
      }
      var r = rangeAt(doc, mode, s, e);
      var got = readRangeStyle(r);
      var t = null;
      try { t = boundString(normBreaks(r.text)); } catch (eT) {}
      out.push({ start: s, end: e, text: t, style: got.style, mixed: got.mixed });
    }
    return out;
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  // Every range field value, checked before anything is written.
  function checkRangeFields(i, f) {
    var tag = "Range " + i + ": ";
    var c;
    if (f.font !== undefined && (typeof f.font !== "string" || f.font.length === 0)) fail("bad_args", tag + "font must be a non-empty string");
    if (f.fontSize !== undefined && (!isNum(f.fontSize) || !(f.fontSize >= 0.1 && f.fontSize <= 1296))) fail("bad_args", tag + "fontSize must be 0.1 to 1296");
    if (f.tracking !== undefined && (!isNum(f.tracking) || f.tracking < -1000 || f.tracking > 10000)) fail("bad_args", tag + "tracking must be a number from -1000 to 10000");
    if (f.baselineShift !== undefined && (!isNum(f.baselineShift) || f.baselineShift < -5000 || f.baselineShift > 5000)) fail("bad_args", tag + "baselineShift must be a number from -5000 to 5000");
    if (f.strokeWidth !== undefined && (!isNum(f.strokeWidth) || f.strokeWidth < 0 || f.strokeWidth > 1000)) fail("bad_args", tag + "strokeWidth must be a number from 0 to 1000");
    var colours = ["fillColor", "strokeColor"];
    for (var ci = 0; ci < colours.length; ci++) {
      var col = f[colours[ci]];
      if (col === undefined) continue;
      if (!col || typeof col.length !== "number" || col.length !== 3) fail("bad_args", tag + colours[ci] + " must be [r, g, b]");
      for (c = 0; c < 3; c++) {
        if (!isNum(col[c]) || col[c] < 0 || col[c] > 1) fail("bad_args", tag + colours[ci] + " values must be numbers in 0..1");
      }
    }
    var flags = ["applyFill", "applyStroke", "fauxBold", "fauxItalic"];
    for (var fi = 0; fi < flags.length; fi++) {
      if (f[flags[fi]] !== undefined && typeof f[flags[fi]] !== "boolean") fail("bad_args", tag + flags[fi] + " must be true or false");
    }
  }

  // Fields that overwrite each other: a colour turns its own switch on.
  function fieldGroup(k) {
    if (k === "fillColor" || k === "applyFill") return "fill";
    if (k === "strokeColor" || k === "applyStroke") return "stroke";
    return k;
  }

  // Two ranges that overlap and set the same field would leave the earlier one
  // reading back mixed, so that is refused rather than resolved silently.
  function checkOverlaps(out) {
    for (var a = 0; a < out.length; a++) {
      var ga = {};
      var ka;
      for (ka in out[a].style) {
        if (out[a].style.hasOwnProperty(ka)) ga[fieldGroup(ka)] = true;
      }
      for (var b = a + 1; b < out.length; b++) {
        if (!(out[a].end > out[b].start && out[b].end > out[a].start)) continue;
        var kb;
        for (kb in out[b].style) {
          if (out[b].style.hasOwnProperty(kb) && ga[fieldGroup(kb)]) {
            fail(
              "bad_args",
              "Range " + out[a].from + " (" + out[a].start + "-" + out[a].end + ") and range " + out[b].from + " (" + out[b].start + "-" + out[b].end + ") overlap and both set " + fieldGroup(kb) + "; split them so they do not overlap"
            );
          }
        }
      }
    }
  }

  // The ranges ae_set_text was asked for, as offsets into the final text
  // (`match` is looked up here). Checked before anything is written.
  function resolveRanges(ranges, finalText, doc, opts) {
    var out = [];
    if (!ranges || typeof ranges.length !== "number" || ranges.length === 0) return out;
    var maxSpecs = MAX_RANGES;
    if (opts && opts.maxSpecs) maxSpecs = opts.maxSpecs;
    if (ranges.length > maxSpecs) fail("bad_args", "At most " + maxSpecs + " ranges");
    if (!hasRanges(doc)) fail("bad_args", "Per-range styling needs After Effects 24.3 or later (TextDocument.characterRange); nothing was written");
    var limit = rangeLength(finalText);
    var plain = normBreaks(finalText);
    out.matchesTruncated = false;
    for (var i = 0; i < ranges.length; i++) {
      var rg = ranges[i];
      var st = rg.style;
      if (!st || typeof st !== "object") fail("bad_args", "Range " + i + " has no style");
      // A font given as {postscript} or {family, style} is looked up once per range and written as its PostScript name.
      var rangeFont = null;
      if (st.font !== undefined && st.font !== null) {
        rangeFont = checkFontSpec(st.font, opts && opts.allowSub === true, "Range " + i + " font");
        if (opts && opts.fonts) opts.fonts.push({ range: i, font: fontSummary(rangeFont) });
      }
      var spans = [];
      if (rg.match !== undefined && rg.match !== null) {
        var needle = normBreaks(rg.match);
        if (needle.length === 0) fail("bad_args", "Range " + i + " has an empty match");
        var from = 0;
        while (spans.length < MAX_MATCHES) {
          var at = plain.indexOf(needle, from);
          if (at < 0) break;
          spans.push([at, at + needle.length]);
          if (rg.occurrence === "first") break;
          from = at + needle.length;
        }
        if (spans.length >= MAX_MATCHES && rg.occurrence !== "first" && plain.indexOf(needle, from) >= 0) out.matchesTruncated = true;
        if (spans.length === 0) fail("not_found", "Range " + i + ": \"" + rg.match + "\" is not in the text");
      } else {
        var s = rg.start;
        var e = rg.end;
        if (e === undefined || e === null) e = limit;
        if (typeof s !== "number" || s < 0 || e <= s) fail("bad_args", "Range " + i + " needs 0 <= start < end");
        spans.push([s, e]);
      }
      for (var j = 0; j < spans.length; j++) {
        if (spans[j][1] > limit) fail("bad_args", "Range " + i + " runs past the text (" + limit + " characters; a range can't include the final line break)");
        var fields = {};
        for (var k = 0; k < RANGE_KEYS.length; k++) {
          var key = RANGE_KEYS[k];
          if (st[key] !== undefined && st[key] !== null) fields[key] = st[key];
        }
        if (rangeFont !== null) fields.font = rangeFont.postscript;
        checkRangeFields(i, fields);
        out.push({ start: spans[j][0], end: spans[j][1], style: fields, from: i });
      }
    }
    if (out.length > MAX_MATCHES) fail("bad_args", "More than " + MAX_MATCHES + " styled ranges");
    checkOverlaps(out);
    return out;
  }

  function writeRange(r, style) {
    var applied = [];
    if (style.font !== undefined) { r.font = String(style.font); applied.push("font"); }
    if (style.fontSize !== undefined) { r.fontSize = Number(style.fontSize); applied.push("fontSize"); }
    if (style.tracking !== undefined) { r.tracking = Number(style.tracking); applied.push("tracking"); }
    if (style.baselineShift !== undefined) { r.baselineShift = Number(style.baselineShift); applied.push("baselineShift"); }
    if (style.fillColor !== undefined) { r.fillColor = style.fillColor; applied.push("fillColor"); }
    if (style.strokeColor !== undefined) { r.strokeColor = style.strokeColor; applied.push("strokeColor"); }
    if (style.strokeWidth !== undefined) { r.strokeWidth = Number(style.strokeWidth); applied.push("strokeWidth"); }
    // After the colours, which turn the fill and stroke on by themselves.
    if (style.applyFill !== undefined) { r.applyFill = Boolean(style.applyFill); applied.push("applyFill"); }
    if (style.applyStroke !== undefined) { r.applyStroke = Boolean(style.applyStroke); applied.push("applyStroke"); }
    if (style.fauxBold !== undefined) { r.fauxBold = Boolean(style.fauxBold); applied.push("fauxBold"); }
    if (style.fauxItalic !== undefined) { r.fauxItalic = Boolean(style.fauxItalic); applied.push("fauxItalic"); }
    return applied;
  }

  // ---------- typography, paragraph and box options (TextDocument 24.0 to 24.6) ----------
  //
  // Every member is feature-detected on the document read before the undo group, so an older
  // After Effects refuses with the version it needs and nothing is written. Enum names are looked
  // up in the host's own enum objects (by constant name, then by a pattern, then loosely), so a
  // name this build lacks is reported with the members it does have.

  function hasMember(obj, name) {
    var present = false;
    try { present = (name in obj); } catch (e1) { present = false; }
    if (!present) {
      try { present = obj[name] !== undefined; } catch (e2) { present = false; }
    }
    return present;
  }

  function globalObject(name) {
    var v = null;
    try { v = G[name]; } catch (e) { v = null; }
    if (v !== null && v !== undefined && (typeof v === "object" || typeof v === "function")) return v;
    return null;
  }

  // opts: [tool name, constant name, pattern]. A table without a name is matched loosely.
  var ENUMS = {
    caps: { en: ["FontCapsOption"], opts: [["normal", "FONT_NORMAL_CAPS", "NORMAL"], ["small", "FONT_SMALL_CAPS", "^FONT_SMALL"], ["all", "FONT_ALL_CAPS", "^FONT_ALL_CAPS$"], ["all_small", "FONT_ALL_SMALL_CAPS", "ALL_SMALL"]] },
    baseline: { en: ["FontBaselineOption"], opts: [["normal", "FONT_NORMAL_BASELINE", "NORMAL"], ["superscript", "FONT_FAUXED_SUPERSCRIPT", "SUPER"], ["subscript", "FONT_FAUXED_SUBSCRIPT", "SUB"]], known: ["FONT_NORMAL_BASELINE", "FONT_FAUXED_SUPERSCRIPT", "FONT_FAUXED_SUBSCRIPT"] },
    kerning: { en: ["AutoKernType"], opts: [["metrics", "METRIC_KERN", "METRIC"], ["optical", "OPTICAL_KERN", "OPTICAL"], ["none", "NO_AUTO_KERN", "NO_AUTO"]] },
    line_join: { en: ["LineJoinType"], opts: [["miter", "LINE_JOIN_MITER", "MITER"], ["round", "LINE_JOIN_ROUND", "ROUND"], ["bevel", "LINE_JOIN_BEVEL", "BEVEL"]] },
    digit_set: { en: ["DigitSet"], opts: [], known: ["DEFAULT_DIGITS", "ARABIC_DIGITS", "HINDI_DIGITS", "FARSI_DIGITS", "ARABIC_DIGITS_RTL"] },
    baseline_direction: { en: ["BaselineDirection"], opts: [], known: ["BASELINE_WESTERN", "BASELINE_VERTICAL_ROTATED", "BASELINE_VERTICAL_CROSS_STREAM"] },
    line_orientation: { en: ["LineOrientation"], opts: [["horizontal", "HORIZONTAL", "^HORIZONTAL"], ["vertical_rtl", "VERTICAL_RIGHT_TO_LEFT", "RIGHT_TO_LEFT"], ["vertical_ltr", "VERTICAL_LEFT_TO_RIGHT", "LEFT_TO_RIGHT"]] },
    justify: { en: ["ParagraphJustification"], opts: [["left", "LEFT_JUSTIFY", ""], ["center", "CENTER_JUSTIFY", ""], ["right", "RIGHT_JUSTIFY", ""], ["full_left", "FULL_JUSTIFY_LASTLINE_LEFT", ""], ["full_center", "FULL_JUSTIFY_LASTLINE_CENTER", ""], ["full_right", "FULL_JUSTIFY_LASTLINE_RIGHT", ""], ["full", "FULL_JUSTIFY_LASTLINE_FULL", ""]] },
    leading_type: { en: ["LeadingType"], opts: [["roman", "ROMAN_LEADING_TYPE", "ROMAN"], ["japanese", "JAPANESE_LEADING_TYPE", "JAPAN"]] },
    direction: { en: ["ParagraphDirection", "Direction", "TextDirection"], opts: [["ltr", "DIRECTION_LEFT_TO_RIGHT", "LEFT_TO_RIGHT"], ["rtl", "DIRECTION_RIGHT_TO_LEFT", "RIGHT_TO_LEFT"]], known: ["DIRECTION_LEFT_TO_RIGHT", "DIRECTION_RIGHT_TO_LEFT"] },
    composer: { en: ["ComposerEngine"], opts: [["universal", "UNIVERSAL_TYPE_ENGINE", "UNIVERSAL"]] },
    vertical_align: { en: ["BoxVerticalAlignment"], opts: [["top", "TOP", "TOP"], ["center", "CENTER", "CENTER"], ["bottom", "BOTTOM", "BOTTOM"], ["justify", "JUSTIFY", "JUSTIFY"]], known: ["TOP", "CENTER", "BOTTOM", "JUSTIFY"] },
    auto_fit: { en: ["BoxAutoFitPolicy"], opts: [["none", "NONE", "NONE"], ["height_cursor", "HEIGHT_CURSOR", "CURSOR"], ["height_precise", "HEIGHT_PRECISE_BOUNDS", "PRECISE"], ["height_baseline", "HEIGHT_BASELINE", "BASELINE"]], known: ["NONE", "HEIGHT_CURSOR", "HEIGHT_PRECISE_BOUNDS", "HEIGHT_BASELINE"] },
    first_baseline: { en: ["BoxFirstBaselineAlignment"], opts: [], known: ["ASCENT", "CAP_HEIGHT", "EM_BOX", "LEADING", "LEGACY_METRIC", "MINIMUM_VALUE_ASIAN", "MINIMUM_VALUE_ROMAN", "X_HEIGHT"] }
  };

  function enumObjectFor(spec) {
    for (var i = 0; i < spec.en.length; i++) {
      var en = globalObject(spec.en[i]);
      if (en !== null) return en;
    }
    return null;
  }

  function enumKeys(en, spec) {
    var keys = [];
    var k;
    var i;
    try {
      for (k in en) {
        if (/^[A-Z][A-Z0-9_]*$/.test(k)) keys.push(k);
      }
    } catch (e) {}
    if (keys.length === 0) {
      try {
        var props = en.reflect.properties;
        for (i = 0; i < props.length; i++) {
          if (/^[A-Z][A-Z0-9_]*$/.test(String(props[i].name))) keys.push(String(props[i].name));
        }
      } catch (e2) {}
    }
    if (keys.length === 0 && spec && spec.known) {
      for (i = 0; i < spec.known.length; i++) {
        var present = false;
        try { present = en[spec.known[i]] !== undefined; } catch (e3) { present = false; }
        if (present) keys.push(spec.known[i]);
      }
    }
    return keys;
  }

  function looseToken(name) {
    return String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  }

  // {ok: true, value, key} or {ok: false, why}. An exact constant name wins; a partial name must match
  // exactly one constant, otherwise it is refused with the candidates.
  function enumValue(spec, name) {
    var en = enumObjectFor(spec);
    if (en === null) return { ok: false, why: spec.en[0] + " is not available in this After Effects" };
    var i;
    var keys = enumKeys(en, spec);
    for (i = 0; i < spec.opts.length; i++) {
      if (spec.opts[i][0] !== name) continue;
      if (spec.opts[i][1] !== "" && en[spec.opts[i][1]] !== undefined) return { ok: true, value: en[spec.opts[i][1]], key: spec.opts[i][1] };
      if (spec.opts[i][2] !== "") {
        var rx = new RegExp(spec.opts[i][2]);
        for (var k = 0; k < keys.length; k++) {
          if (rx.test(keys[k])) return { ok: true, value: en[keys[k]], key: keys[k] };
        }
      }
    }
    var token = looseToken(name);
    for (i = 0; i < keys.length; i++) {
      if (keys[i] === token) return { ok: true, value: en[keys[i]], key: keys[i] };
    }
    var cands = [];
    for (i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(token) >= 0) cands.push(keys[i]);
    }
    if (cands.length === 1) return { ok: true, value: en[cands[0]], key: cands[0] };
    if (cands.length > 1) {
      return { ok: false, why: "\"" + name + "\" matches several members of " + spec.en[0] + " (" + cands.join(", ") + "); give the full name" };
    }
    return { ok: false, why: "\"" + name + "\" is not a member of " + spec.en[0] + " here (it has: " + keys.join(", ") + ")" };
  }

  function enumName(spec, value) {
    var en = enumObjectFor(spec);
    if (en === null) return String(value);
    var i;
    for (i = 0; i < spec.opts.length; i++) {
      var r = enumValue(spec, spec.opts[i][0]);
      if (r.ok && r.value === value) return spec.opts[i][0];
    }
    var keys = enumKeys(en, spec);
    for (i = 0; i < keys.length; i++) {
      if (en[keys[i]] === value) return keys[i].toLowerCase();
    }
    return String(value);
  }

  // group: where the value sits in the typed read-back; kind: bool, num or enum.
  var TYPO_DESCS = [
    { key: "caps", member: "fontCapsOption", ver: "24.0", kind: "enum", spec: "caps", group: "typography" },
    { key: "baseline", member: "fontBaselineOption", ver: "24.0", kind: "enum", spec: "baseline", group: "typography" },
    { key: "ligature", member: "ligature", ver: "24.0", kind: "bool", group: "typography" },
    { key: "no_break", member: "noBreak", ver: "24.0", kind: "bool", group: "typography" },
    { key: "horizontal_scale", member: "horizontalScale", ver: "24.0", kind: "num", min: 0, max: 1000, group: "typography" },
    { key: "vertical_scale", member: "verticalScale", ver: "24.0", kind: "num", min: 0, max: 1000, group: "typography" },
    { key: "tsume", member: "tsume", ver: "24.0", kind: "num", min: 0, max: 100, group: "typography" },
    { key: "stroke_over_fill", member: "strokeOverFill", ver: "24.0", kind: "bool", group: "typography" },
    { key: "line_join", member: "lineJoinType", ver: "24.0", kind: "enum", spec: "line_join", group: "typography" },
    { key: "auto_leading", member: "autoLeading", ver: "24.0", kind: "bool", group: "typography" },
    { key: "digit_set", member: "digitSet", ver: "24.0", kind: "enum", spec: "digit_set", group: "typography" },
    { key: "baseline_direction", member: "baselineDirection", ver: "24.0", kind: "enum", spec: "baseline_direction", group: "typography" },
    { key: "line_orientation", member: "lineOrientation", ver: "24.2", kind: "enum", spec: "line_orientation", group: "typography" },
    { key: "faux_bold", member: "fauxBold", ver: "24.0", kind: "bool", group: "typography" },
    { key: "faux_italic", member: "fauxItalic", ver: "24.0", kind: "bool", group: "typography" }
  ];

  var PARA_DESCS = [
    { key: "space_before", member: "spaceBefore", ver: "24.0", kind: "num", min: -10000, max: 10000, group: "paragraph" },
    { key: "space_after", member: "spaceAfter", ver: "24.0", kind: "num", min: -10000, max: 10000, group: "paragraph" },
    { key: "first_line_indent", member: "firstLineIndent", ver: "24.0", kind: "num", min: -10000, max: 10000, group: "paragraph" },
    { key: "start_indent", member: "startIndent", ver: "24.0", kind: "num", min: -10000, max: 10000, group: "paragraph" },
    { key: "end_indent", member: "endIndent", ver: "24.0", kind: "num", min: -10000, max: 10000, group: "paragraph" },
    { key: "every_line_composer", member: "everyLineComposer", ver: "24.0", kind: "bool", group: "paragraph" },
    { key: "hanging_roman", member: "hangingRoman", ver: "24.0", kind: "bool", group: "paragraph" },
    { key: "auto_hyphenate", member: "autoHyphenate", ver: "24.0", kind: "bool", group: "paragraph" },
    { key: "leading_type", member: "leadingType", ver: "24.0", kind: "enum", spec: "leading_type", group: "paragraph" },
    { key: "direction", member: "direction", ver: "24.0", kind: "enum", spec: "direction", group: "paragraph" },
    { key: "composer", member: "composerEngine", ver: "24.0", kind: "enum", spec: "composer", group: "paragraph" }
  ];

  var BOX_DESCS = [
    { key: "vertical_align", member: "boxVerticalAlignment", ver: "24.6", kind: "enum", spec: "vertical_align", group: "box" },
    { key: "auto_fit", member: "boxAutoFitPolicy", ver: "24.6", kind: "enum", spec: "auto_fit", group: "box" },
    { key: "first_baseline", member: "boxFirstBaselineAlignment", ver: "24.6", kind: "enum", spec: "first_baseline", group: "box" },
    { key: "first_baseline_min", member: "boxFirstBaselineAlignmentMinimum", ver: "24.6", kind: "num", min: 0, max: 100000, group: "box" }
  ];

  function descValue(d, v, tag) {
    if (d.kind === "bool") {
      if (typeof v !== "boolean") fail("bad_args", tag + d.key + " must be true or false");
      return v;
    }
    if (d.kind === "num") {
      if (!isNum(v) || v < d.min || v > d.max) fail("bad_args", tag + d.key + " must be a number from " + d.min + " to " + d.max);
      return v;
    }
    if (typeof v !== "string" || v.length === 0) fail("bad_args", tag + d.key + " must be a name");
    var r = enumValue(ENUMS[d.spec], v);
    if (!r.ok) fail("bad_args", tag + d.key + ": " + r.why + "; nothing was written");
    return r.value;
  }

  function needMember(probe, d, tag) {
    if (!hasMember(probe, d.member)) {
      fail("bad_args", tag + d.key + " needs After Effects " + d.ver + " or later (TextDocument." + d.member + " is missing here); nothing was written");
    }
  }

  function planGroup(probe, descs, input, tag, plan) {
    if (!input || typeof input !== "object") return;
    for (var i = 0; i < descs.length; i++) {
      var d = descs[i];
      var v = input[d.key];
      if (v === undefined || v === null) continue;
      needMember(probe, d, tag);
      var val = descValue(d, v, tag);
      plan.ops.push({ member: d.member, value: val, key: d.key });
      plan.set[d.group][d.key] = v;
      if (d.kind === "enum") plan.set[d.group][d.key] = enumName(ENUMS[d.spec], val);
    }
  }

  function plainNumbers(v) {
    var out = [];
    if (!v || typeof v.length !== "number") return out;
    for (var i = 0; i < v.length; i++) out.push(Number(v[i]));
    return out;
  }

  // Everything a call asks for beyond text, fonts and the old style keys, checked against the document
  // read before the undo group. Returns {ops, set, notes}: ops are member assignments in write order.
  function planTypography(probe, st, par, boxArg) {
    var plan = { ops: [], set: { typography: {}, paragraph: {}, box: {} }, notes: [] };
    var i;
    if (st && typeof st === "object") {
      planGroup(probe, TYPO_DESCS, st, "style.", plan);
      if (st.kerning !== undefined && st.kerning !== null) {
        if (typeof st.kerning === "number") {
          if (!isNum(st.kerning) || st.kerning < -10000 || st.kerning > 10000) fail("bad_args", "style.kerning must be a number from -10000 to 10000");
          if (!hasMember(probe, "kerning")) fail("bad_args", "style.kerning needs After Effects 24.0 or later (TextDocument.kerning is missing here); nothing was written");
          plan.ops.push({ member: "kerning", value: st.kerning, key: "kerning" });
          plan.set.typography.kerning_value = st.kerning;
          plan.notes.push("A numeric kerning switches automatic kerning (metrics / optical) off.");
        } else {
          if (!hasMember(probe, "autoKernType")) fail("bad_args", "style.kerning needs After Effects 24.0 or later (TextDocument.autoKernType is missing here); nothing was written");
          var kr = enumValue(ENUMS.kerning, String(st.kerning));
          if (!kr.ok) fail("bad_args", "style.kerning: " + kr.why + "; nothing was written");
          plan.ops.push({ member: "autoKernType", value: kr.value, key: "kerning" });
          plan.set.typography.kerning_mode = st.kerning;
        }
      }
      if (st.leading !== undefined && st.leading !== null && st.auto_leading === true) {
        fail("bad_args", "style.leading and style.auto_leading true contradict each other (setting leading switches auto leading off)");
      }
      if (st.leading !== undefined && st.leading !== null && (st.auto_leading === undefined || st.auto_leading === null) && hasMember(probe, "autoLeading")) {
        plan.notes.push("Setting leading switches auto leading off.");
        plan.set.typography.auto_leading = false;
      }
    }
    if (par && typeof par === "object") {
      planGroup(probe, PARA_DESCS, par, "paragraph.", plan);
      if (par.composer !== undefined && par.composer !== null) {
        plan.notes.push("The composer engine only accepts the universal engine and the change is one-way.");
      }
    }
    if (boxArg && typeof boxArg === "object") {
      var any = false;
      var bk;
      for (bk in boxArg) {
        if (boxArg.hasOwnProperty(bk) && boxArg[bk] !== undefined && boxArg[bk] !== null) any = true;
      }
      if (any) {
        if (!hasMember(probe, "boxTextSize")) {
          fail("bad_args", "box options need After Effects 24.6 or later (TextDocument.boxTextSize is missing here); nothing was written");
        }
        var isPoint = false;
        var isBoxText = false;
        try { isPoint = probe.pointText === true; } catch (eP) {}
        try { isBoxText = probe.boxText === true; } catch (eB) {}
        if (isPoint && !isBoxText) {
          fail("bad_args", "box options need box text; this layer is point text, and point <-> box conversion is not scriptable. Nothing was written.");
        }
        if (boxArg.size !== undefined && boxArg.size !== null) {
          var sz = boxArg.size;
          if (boxArg.auto_fit === "height_cursor" || boxArg.auto_fit === "height_precise" || boxArg.auto_fit === "height_baseline") {
            fail("bad_args", "box.size and a height box.auto_fit contradict each other (auto fit sets the height from the text); give the size without auto_fit, or auto_fit alone. Nothing was written.");
          }
          if (!sz || typeof sz.length !== "number" || sz.length !== 2) fail("bad_args", "box.size must be [width, height]");
          for (i = 0; i < 2; i++) {
            if (!isNum(sz[i]) || Math.floor(sz[i]) !== sz[i] || sz[i] < 1 || sz[i] > 100000) fail("bad_args", "box.size values must be whole numbers from 1 to 100000");
          }
          if (boxArg.auto_fit === undefined || boxArg.auto_fit === null) {
            // The document may already carry a height auto-fit policy; it would reset the height after the write.
            var curFit = null;
            try { curFit = probe.boxAutoFitPolicy; } catch (eFit) { curFit = null; }
            if (curFit !== null && curFit !== undefined) {
              var curFitName = "";
              try { curFitName = enumName(ENUMS.auto_fit, curFit); } catch (eFn) { curFitName = ""; }
              if (curFitName === "height_cursor" || curFitName === "height_precise" || curFitName === "height_baseline") {
                fail("bad_args", "this text layer already has box.auto_fit \"" + curFitName + "\", which sets the height from the text, so box.size would not hold; give box.auto_fit \"none\" together with the size, or leave the size out. Nothing was written.");
              }
            }
          }
          plan.ops.push({ member: "boxTextSize", value: [sz[0], sz[1]], key: "size" });
          plan.set.box.size = [sz[0], sz[1]];
          plan.notes.push("A new box size rewraps the text; the receipt measures it again.");
        }
        if (boxArg.position !== undefined && boxArg.position !== null) {
          var ps = boxArg.position;
          if (!ps || typeof ps.length !== "number" || ps.length !== 2 || !isNum(ps[0]) || !isNum(ps[1])) fail("bad_args", "box.position must be [x, y]");
          if (!hasMember(probe, "boxTextPos")) fail("bad_args", "box.position needs After Effects 24.6 or later (TextDocument.boxTextPos is missing here); nothing was written");
          plan.ops.push({ member: "boxTextPos", value: [ps[0], ps[1]], key: "position" });
          plan.set.box.position = [ps[0], ps[1]];
        }
        var ordered = [BOX_DESCS[0], BOX_DESCS[1]];
        planGroup(probe, ordered, boxArg, "box.", plan);
        // Auto fit only works with the top vertical alignment.
        if (boxArg.auto_fit !== undefined && boxArg.auto_fit !== null && boxArg.auto_fit !== "none") {
          var top = enumValue(ENUMS.vertical_align, "top");
          if (top.ok) {
            var wantAlign = null;
            var cur = null;
            if (boxArg.vertical_align !== undefined && boxArg.vertical_align !== null) {
              var va = enumValue(ENUMS.vertical_align, boxArg.vertical_align);
              if (va.ok) wantAlign = va.value;
            } else {
              try { cur = probe.boxVerticalAlignment; } catch (eVa) { cur = null; }
              wantAlign = cur;
            }
            if (wantAlign !== null && wantAlign !== undefined && wantAlign !== top.value) {
              fail("bad_args", "box.auto_fit only works with box.vertical_align \"top\"; nothing was written");
            }
          }
        }
        if (boxArg.inset !== undefined && boxArg.inset !== null) {
          if (!hasMember(probe, "boxInsetSpacing")) fail("bad_args", "box.inset needs After Effects 24.6 or later (TextDocument.boxInsetSpacing is missing here); nothing was written");
          var curInset = null;
          try { curInset = probe.boxInsetSpacing; } catch (eIn) { curInset = null; }
          var inset = boxArg.inset;
          var insetOut = null;
          if (curInset && typeof curInset.length === "number" && curInset.length > 0) {
            if (typeof inset === "number") {
              if (!isNum(inset)) fail("bad_args", "box.inset must be a finite number");
              insetOut = [];
              for (i = 0; i < curInset.length; i++) insetOut.push(inset);
            } else {
              if (!inset || typeof inset.length !== "number" || inset.length !== curInset.length) {
                fail("bad_args", "box.inset needs " + curInset.length + " numbers (After Effects' own order) or one number for all");
              }
              insetOut = plainNumbers(inset);
            }
          } else if (typeof inset === "number") {
            insetOut = inset;
          } else {
            fail("bad_args", "this After Effects takes one number for box.inset; nothing was written");
          }
          plan.ops.push({ member: "boxInsetSpacing", value: insetOut, key: "inset" });
          plan.set.box.inset = insetOut;
        }
        var hasMin = boxArg.first_baseline_min !== undefined && boxArg.first_baseline_min !== null;
        if (hasMin && boxArg.first_baseline_min !== 0 && boxArg.first_baseline !== undefined && boxArg.first_baseline !== null) {
          fail("bad_args", "A non-zero box.first_baseline_min disables box.first_baseline; give one of them");
        }
        planGroup(probe, [BOX_DESCS[3], BOX_DESCS[2]], boxArg, "box.", plan);
      }
    }
    return plan;
  }

  function applyOps(doc, ops) {
    var names = [];
    for (var i = 0; i < ops.length; i++) {
      doc[ops[i].member] = ops[i].value;
      names.push(ops[i].key);
    }
    return names;
  }

  // One described member of a document, in the names the tool takes. A member that reads undefined (mixed
  // values in the text) goes to `mixed`, never to a value.
  function readDesc(doc, d, out, mixed) {
    if (!hasMember(doc, d.member)) return;
    var v;
    try { v = doc[d.member]; } catch (e) { v = undefined; }
    if (v === undefined || v === null) {
      mixed.push(d.group + "." + d.key);
      return;
    }
    if (d.kind === "bool") out[d.group][d.key] = v === true;
    else if (d.kind === "num") out[d.group][d.key] = Number(v);
    else out[d.group][d.key] = enumName(ENUMS[d.spec], v);
  }

  function readArrayMember(doc, member, group, key, out, mixed) {
    if (!hasMember(doc, member)) return;
    var v;
    try { v = doc[member]; } catch (e) { v = undefined; }
    if (v === undefined || v === null) {
      mixed.push(group + "." + key);
      return;
    }
    if (typeof v.length === "number") out[group][key] = plainNumbers(v);
    else out[group][key] = v;
  }

  // The typed state of a document, in the names ae_set_text takes. Reads reflect the first character
  // only; a value AE reports as undefined is listed in `mixed` and is unknown, never a mismatch.
  function readTypedState(doc) {
    var out = { typography: {}, paragraph: {}, box: {} };
    var mixed = [];
    var i;
    for (i = 0; i < TYPO_DESCS.length; i++) readDesc(doc, TYPO_DESCS[i], out, mixed);
    for (i = 0; i < PARA_DESCS.length; i++) readDesc(doc, PARA_DESCS[i], out, mixed);
    for (i = 0; i < BOX_DESCS.length; i++) readDesc(doc, BOX_DESCS[i], out, mixed);
    if (hasMember(doc, "autoKernType")) {
      var ak;
      try { ak = doc.autoKernType; } catch (eAk) { ak = undefined; }
      if (ak === undefined || ak === null) mixed.push("typography.kerning_mode");
      else out.typography.kerning_mode = enumName(ENUMS.kerning, ak);
    }
    if (hasMember(doc, "kerning")) {
      var kv;
      try { kv = doc.kerning; } catch (eKv) { kv = undefined; }
      if (kv === undefined || kv === null) mixed.push("typography.kerning_value");
      else out.typography.kerning_value = Number(kv);
    }
    var jv;
    try { jv = doc.justification; } catch (eJ) { jv = undefined; }
    if (jv !== undefined && jv !== null) out.paragraph.justify = justificationFromEnum(jv);
    readArrayMember(doc, "boxTextSize", "box", "size", out, mixed);
    readArrayMember(doc, "boxTextPos", "box", "position", out, mixed);
    readArrayMember(doc, "boxInsetSpacing", "box", "inset", out, mixed);
    try { if (hasMember(doc, "pointText")) out.box.point_text = doc.pointText === true; } catch (ePt) {}
    try { if (hasMember(doc, "boxText")) out.box.box_text = doc.boxText === true; } catch (eBt) {}
    return { typography: out.typography, paragraph: out.paragraph, box: out.box, mixed: mixed };
  }

  // The text's extent, to see what a new box size or paragraph spacing did to the wrap.
  function measureText(comp, layer, doc) {
    var m = {};
    try {
      var r = layer.sourceRectAtTime(comp.time, false);
      m.source_rect = { top: r.top, left: r.left, width: r.width, height: r.height };
    } catch (e1) {}
    try {
      if (doc.composedLineCount !== undefined) m.composed_line_count = doc.composedLineCount;
    } catch (e2) {}
    try {
      if (doc.boxText === true) {
        var sz = doc.boxTextSize;
        if (sz && typeof sz.length === "number" && sz.length >= 2) {
          m.box_size = [Number(sz[0]), Number(sz[1])];
        }
        var overflow = null;
        try {
          if (typeof doc.boxOverflow === "boolean") overflow = doc.boxOverflow;
        } catch (eOv) { overflow = null; }
        if (overflow !== null) {
          m.box_overflow = overflow;
        } else if (m.source_rect && m.box_size) {
          m.box_overflow = m.source_rect.height > m.box_size[1] + 0.5;
        }
      }
    } catch (e3) {}
    return m;
  }

  // ---------- fonts: PostScript name, {postscript} or {family, style}, checked against app.fonts ----------

  var fontCache = {};

  function fontSpecOf(f, where) {
    if (typeof f === "string") {
      if (f.length === 0) fail("bad_args", where + ": font must be a non-empty string");
      return { postscript: f };
    }
    if (f && typeof f === "object") {
      if (typeof f.postscript === "string" && f.postscript.length > 0) return { postscript: f.postscript };
      if (typeof f.family === "string" && f.family.length > 0 && typeof f.style === "string" && f.style.length > 0) {
        return { family: f.family, style: f.style };
      }
    }
    fail("bad_args", where + ": font must be a PostScript name, {postscript} or {family, style}");
    return null;
  }

  // {postscript, family, style, checked, unresolved, duplicates}. Without app.fonts (before AE 24) the
  // PostScript name is passed on unchecked, as it always was.
  function checkFontSpec(f, allowSub, where) {
    var spec = fontSpecOf(f, where);
    var cacheKey = "ps:" + spec.postscript + "|" + spec.family + "|" + spec.style;
    if (fontCache[cacheKey] !== undefined) return fontCache[cacheKey];
    var ps = spec.postscript;
    var out = { postscript: ps, family: null, style: null, checked: false, unresolved: false, duplicates: 0 };
    if (ps === undefined) out.postscript = null;
    var r = null;
    if (typeof A.fontsResolve === "function") {
      r = A.fontsResolve(spec);
    }
    if (r === null || r.unchecked) {
      if (!out.postscript) {
        fail("bad_args", where + ": {family, style} needs After Effects 24 or later to look the font up (app.fonts is missing); give the PostScript name");
      }
      fontCache[cacheKey] = out;
      return out;
    }
    if (r.ok && r.font) {
      out.postscript = r.font.postscript;
      out.family = r.font.family;
      out.style = r.font.style;
      out.checked = true;
      out.duplicates = r.duplicates;
      fontCache[cacheKey] = out;
      return out;
    }
    if (allowSub) {
      if (!out.postscript) fail("bad_args", where + ": allow_substitute needs a PostScript name (it cannot write a {family, style} that is not installed)");
      out.checked = true;
      out.unresolved = true;
      out.reason = r.reason;
      fontCache[cacheKey] = out;
      return out;
    }
    fail("not_found", where + ": " + r.reason + " Nothing was written; pass allow_substitute: true to write the name anyway.", { actual: { candidates: r.candidates } });
    return out;
  }

  function rawFontObject(fi) {
    var list = null;
    try { list = app.fonts.getFontsByPostScriptName(fi.postscript); } catch (e) { return null; }
    if (list !== null && list !== undefined && list.length === undefined) list = [list];
    if (!list || list.length === 0) return null;
    for (var i = 0; i < list.length; i++) {
      try {
        if (fi.family !== null && String(list[i].familyName) === fi.family && String(list[i].styleName) === fi.style) return list[i];
      } catch (e2) {}
    }
    return list[0];
  }

  // Sets fontObject when the font resolved and the document has it, else the PostScript name as before.
  function applyDocFont(doc, fi) {
    if (fi.checked && !fi.unresolved && hasMember(doc, "fontObject")) {
      var fo = rawFontObject(fi);
      if (fo) {
        try {
          doc.fontObject = fo;
          return "fontObject";
        } catch (eFo) {}
      }
    }
    doc.font = fi.postscript;
    return "font";
  }

  function fontSummary(fi) {
    return { postscript: fi.postscript, family: fi.family, style: fi.style, checked: fi.checked, unresolved: fi.unresolved === true };
  }

  // ---------- paragraphs: character styles per paragraph, as ranges ----------

  function paragraphSpans(plain) {
    var spans = [];
    var start = 0;
    for (var i = 0; i <= plain.length; i++) {
      if (i === plain.length || plain.charAt(i) === "\n") {
        spans.push({ start: start, end: i });
        start = i + 1;
      }
    }
    return spans;
  }

  // paragraphs: [{index | match, occurrence, style}] -> range specs on the final text.
  function paragraphRangeSpecs(paragraphs, finalText) {
    var out = [];
    var plain = normBreaks(finalText);
    var spans = paragraphSpans(plain);
    for (var i = 0; i < paragraphs.length; i++) {
      var pg = paragraphs[i];
      if (!pg || !pg.style || typeof pg.style !== "object") fail("bad_args", "Paragraph entry " + i + " has no style");
      var picked = [];
      var j;
      if (pg.index !== undefined && pg.index !== null) {
        if (typeof pg.index !== "number" || pg.index < 0 || Math.floor(pg.index) !== pg.index || pg.index >= spans.length) {
          fail("not_found", "Paragraph entry " + i + ": paragraph " + pg.index + " does not exist (the text has " + spans.length + ")");
        }
        picked.push(pg.index);
      } else if (pg.match !== undefined && pg.match !== null) {
        var needle = normBreaks(pg.match);
        if (needle.length === 0) fail("bad_args", "Paragraph entry " + i + " has an empty match");
        for (j = 0; j < spans.length; j++) {
          if (plain.substring(spans[j].start, spans[j].end).indexOf(needle) >= 0) {
            picked.push(j);
            if (pg.occurrence === "first") break;
          }
        }
        if (picked.length === 0) fail("not_found", "Paragraph entry " + i + ": no paragraph contains \"" + pg.match + "\"");
      } else {
        fail("bad_args", "Paragraph entry " + i + " needs index or match");
      }
      for (j = 0; j < picked.length; j++) {
        var sp = spans[picked[j]];
        if (sp.end <= sp.start) fail("bad_args", "Paragraph " + picked[j] + " is empty; there is nothing to style");
        out.push({ start: sp.start, end: sp.end, style: pg.style });
        if (out.length > MAX_MATCHES) fail("bad_args", "More than " + MAX_MATCHES + " styled paragraphs");
      }
    }
    out.count = spans.length;
    return out;
  }

  A.getTextDocument = function (args) {
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var srcProp = findSourceTextProp(l);
    var doc = srcProp.value;
    var out = {
      comp_id: c.id,
      layer_id: l.id,
      layer_index: l.index,
      layer_name: l.name,
      numKeys: srcProp.numKeys,
      document: serialiseTextDoc(doc)
    };
    // The full TextDocument read (w5core), added to the fields above: nothing here is renamed or dropped.
    if (typeof A.textDocSerialise === "function") {
      try {
        var full = A.textDocSerialise(doc, { full: true });
        var fk;
        for (fk in full) {
          if (full.hasOwnProperty(fk) && out.document[fk] === undefined) out.document[fk] = full[fk];
        }
      } catch (eFull) {}
    }
    if (args.typography === true) {
      var typed = readTypedState(doc);
      out.typography = typed.typography;
      out.paragraph = typed.paragraph;
      out.box = typed.box;
      out.mixed = typed.mixed;
    }
    if (args.measure === true) out.measure = measureText(c, l, doc);
    if (args.ranges) out.ranges = readRanges(doc, args.ranges);
    return out;
  };

  A.setText = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var srcProp = findSourceTextProp(l);

    // Everything that can fail is checked on a read of the document before the undo group opens.
    fontCache = {};
    var allowSub = args.allow_substitute === true;
    var st = args.style;
    var par = args.paragraph;
    var warnings = [];
    var probe = srcProp.value;
    var finalText = String(probe.text);
    if (args.text !== undefined && args.text !== null) finalText = String(args.text);

    var docFont = null;
    if (st && typeof st === "object" && st.font !== undefined && st.font !== null) {
      docFont = checkFontSpec(st.font, allowSub, "style.font");
    }
    // Glyph coverage of the new text in the font it will have (a warning, never a refusal).
    if (args.text !== undefined && args.text !== null && typeof A.fontsGlyphCheck === "function") {
      var glyphFont = null;
      if (docFont !== null) glyphFont = docFont.postscript;
      else {
        try { glyphFont = String(probe.font); } catch (eGf) { glyphFont = null; }
      }
      if (glyphFont) {
        var glyphs = null;
        try { glyphs = A.fontsGlyphCheck(glyphFont, finalText, 2000); } catch (eGc) { glyphs = null; }
        if (glyphs && glyphs.supported === false) {
          var gmsg = "The font " + glyphFont + " has no glyphs for: " + glyphs.missing.join(" ") + ".";
          if (glyphs.suggested_default && glyphs.suggested_default.length > 0) {
            gmsg += " After Effects' default for those scripts: " + glyphs.suggested_default[0].postscript + ".";
          }
          warnings.push(gmsg);
        }
      }
    }

    var parJustify = null;
    if (par && par.justify !== undefined && par.justify !== null) {
      if (st && st.justification !== undefined && st.justification !== null) {
        fail("bad_args", "style.justification and paragraph.justify both set the justification; give one of them");
      }
      var jr = enumValue(ENUMS.justify, String(par.justify));
      if (!jr.ok) fail("bad_args", "paragraph.justify: " + jr.why + "; nothing was written");
      parJustify = jr.value;
    }
    var typo = planTypography(probe, st, par, args.box);

    // Ranges and per-paragraph character styles, resolved against the final text.
    var rangeSpecs = [];
    var ri0;
    if (args.ranges && args.ranges.length) {
      if (args.ranges.length > MAX_RANGES) fail("bad_args", "At most " + MAX_RANGES + " ranges");
      for (ri0 = 0; ri0 < args.ranges.length; ri0++) rangeSpecs.push(args.ranges[ri0]);
    }
    if (args.paragraphs && args.paragraphs.length) {
      if (args.paragraphs.length > MAX_RANGES) fail("bad_args", "At most " + MAX_RANGES + " paragraph entries");
      var pspecs = paragraphRangeSpecs(args.paragraphs, finalText);
      for (ri0 = 0; ri0 < pspecs.length; ri0++) rangeSpecs.push(pspecs[ri0]);
      var liveCount = null;
      try { liveCount = probe.paragraphCount; } catch (ePc) { liveCount = null; }
      if (typeof liveCount === "number" && args.text === undefined && liveCount !== pspecs.count) {
        warnings.push("After Effects counts " + liveCount + " paragraphs where the text splits into " + pspecs.count + "; check which ones were styled.");
      }
    }
    var rangeFonts = [];
    var resolved = [];
    if (rangeSpecs.length > 0) {
      resolved = resolveRanges(rangeSpecs, finalText, probe, { maxSpecs: 2 * MAX_RANGES, allowSub: allowSub, fonts: rangeFonts });
    }

    return A.withUndo("Chroma AE MCP: set_text", function () {
      var doc = srcProp.value;
      var originalJust = null;
      try {
        originalJust = doc.justification;
      } catch (e0) {}

      var targetJust = originalJust;
      var applied = [];

      if (args.text !== undefined && args.text !== null) {
        doc.text = String(args.text);
        applied.push("text");
      }

      if (st && typeof st === "object") {
        if (docFont !== null) {
          applyDocFont(doc, docFont);
          applied.push("font");
        }
        if (st.fontSize !== undefined && st.fontSize !== null) {
          doc.fontSize = Number(st.fontSize);
          applied.push("fontSize");
        }
        if (st.tracking !== undefined && st.tracking !== null) {
          doc.tracking = Number(st.tracking);
          applied.push("tracking");
        }
        if (st.leading !== undefined && st.leading !== null) {
          doc.leading = Number(st.leading);
          applied.push("leading");
        }
        if (st.applyFill !== undefined && st.applyFill !== null) {
          doc.applyFill = Boolean(st.applyFill);
          applied.push("applyFill");
        }
        if (st.fillColor !== undefined && st.fillColor !== null) {
          if (st.applyFill !== false) {
            doc.applyFill = true;
          }
          doc.fillColor = st.fillColor;
          applied.push("fillColor");
        }
        if (st.applyStroke !== undefined && st.applyStroke !== null) {
          doc.applyStroke = Boolean(st.applyStroke);
          applied.push("applyStroke");
        }
        if (st.strokeColor !== undefined && st.strokeColor !== null) {
          if (st.applyStroke !== false) {
            doc.applyStroke = true;
          }
          doc.strokeColor = st.strokeColor;
          applied.push("strokeColor");
        }
        if (st.strokeWidth !== undefined && st.strokeWidth !== null) {
          doc.strokeWidth = Number(st.strokeWidth);
          applied.push("strokeWidth");
        }
        if (st.justification !== undefined && st.justification !== null) {
          targetJust = justificationToEnum(st.justification);
          doc.justification = targetJust;
          applied.push("justification");
        }
      }
      if (parJustify !== null) {
        targetJust = parJustify;
        doc.justification = targetJust;
        applied.push("justification");
      }
      // Typography, paragraph and box options, after the old style keys so a leading given with auto_leading
      // false ends up as asked.
      var typoApplied = applyOps(doc, typo.ops);
      for (var ta = 0; ta < typoApplied.length; ta++) applied.push(typoApplied[ta]);

      // The ranges go on this same document, after text and style, and the whole
      // thing is written once: a second read in this script could be stale, and a
      // second write could put the old text and style back.
      var rangeResults = [];
      if (resolved.length > 0) {
        var mode = rangeEndMode(doc);
        if (args.text !== undefined && args.text !== null) {
          // Nothing has been written yet (doc is a copy), so a refusal here leaves no trace.
          var first = resolved[0];
          var wantText = normBreaks(String(args.text)).substring(first.start, first.end);
          var gotText = null;
          try { gotText = normBreaks(rangeAt(doc, mode, first.start, first.end).text); } catch (eC) { gotText = null; }
          if (gotText !== wantText) {
            fail("runtime", "This After Effects build does not apply character ranges to text set in the same call; nothing was written. Set the text first, then style it with a second ae_set_text call.");
          }
        }
        for (var ri = 0; ri < resolved.length; ri++) {
          var rr = resolved[ri];
          var range = rangeAt(doc, mode, rr.start, rr.end);
          var rangeText = null;
          try { rangeText = boundString(normBreaks(range.text)); } catch (eRt) {}
          writeRange(range, rr.style);
          rangeResults.push({ start: rr.start, end: rr.end, text: rangeText, style: rr.style });
        }
        applied.push("ranges");
      }

      setSourceTextValue(c, srcProp, doc);
      var justCheck = verifyAndReassertJustification(c, srcProp, targetJust);

      var result = {
        comp_id: c.id,
        layer_id: l.id,
        layer_name: l.name,
        applied: applied,
        justification: justCheck.justification,
        justificationReasserted: justCheck.justificationReasserted
      };
      if (rangeResults.length > 0) result.ranges = rangeResults;
      if (resolved.matchesTruncated) result.matches_truncated = true;
      if (typo.ops.length > 0) result.set = typo.set;
      if (parJustify !== null) result.justify = par.justify;
      if (docFont !== null || rangeFonts.length > 0) {
        var docFontOut = null;
        if (docFont !== null) docFontOut = fontSummary(docFont);
        result.fonts = { document: docFontOut, ranges: rangeFonts };
      }
      if (typo.notes.length > 0) result.notes = typo.notes;
      if (warnings.length > 0) result.warnings = warnings;
      return result;
    });
  };

  // ---------- 3 & 4. Footage Import and Replace (credits: reference/engine-room footage.jsx, MIT) ----------

  function describeFootage(it) {
    var filePath = null;
    try {
      if (it.file) {
        filePath = it.file.fsName;
      }
    } catch (e1) {}
    if (!filePath) {
      try {
        if (it.mainSource && it.mainSource.file) {
          filePath = it.mainSource.file.fsName;
        }
      } catch (e2) {}
    }
    var missing = false;
    try {
      if (it.footageMissing !== undefined) {
        missing = Boolean(it.footageMissing);
      }
    } catch (e3) {}
    var parentId = null;
    try {
      if (it.parentFolder) {
        parentId = it.parentFolder.id;
      }
    } catch (e4) {}
    var out = {
      id: it.id,
      item_id: it.id,
      name: it.name,
      typeName: it.typeName,
      parentFolderId: parentId,
      file: filePath,
      footageMissing: missing,
      width: it.width,
      height: it.height,
      duration: it.duration,
      frameRate: it.frameRate
    };
    // SVG large-viewBox fabricated dimensions check (fragile-areas-ae.md issue #33: 15906x5654)
    if (filePath && String(filePath).toLowerCase().indexOf(".svg") !== -1) {
      if (it.width === 15906 && it.height === 5654) {
        out.svgViewBoxWarning =
          "Imported SVG has AE's fabricated 15906x5654 dimensions from an oversized viewBox and may fail to rasterize.";
      }
    }
    return out;
  }

  A.getFootageItems = function (args) {
    if (args && args.item_ids && args.item_ids.length) {
      var foundIds = [];
      var items = [];
      for (var i = 0; i < args.item_ids.length && items.length < MAX_LIST; i++) {
        var it = null;
        try {
          it = app.project.itemByID(args.item_ids[i]);
        } catch (e1) {
          it = null;
        }
        if (it) {
          foundIds.push(it.id);
          if (it instanceof FootageItem) {
            items.push(describeFootage(it));
          } else {
            items.push({
              id: it.id,
              item_id: it.id,
              name: it.name,
              typeName: it.typeName
            });
          }
        }
      }
      return {
        project_path: projectPath(),
        numItems: app.project.numItems,
        item_ids: foundIds,
        items: items
      };
    }

    var allIds = [];
    var total = app.project.numItems;
    var limit = total;
    if (limit > MAX_LIST) {
      limit = MAX_LIST;
    }
    for (var j = 1; j <= limit; j++) {
      try {
        allIds.push(app.project.item(j).id);
      } catch (e2) {}
    }
    var res = {
      project_path: projectPath(),
      numItems: total,
      item_ids: allIds
    };
    if (total > MAX_LIST) {
      res.truncated = true;
    }
    return res;
  };

  A.getFootageItem = function (args) {
    if (!args || args.item_id === undefined || args.item_id === null) {
      fail("bad_args", "getFootageItem requires item_id");
    }
    var it = requireFootage(args.item_id);
    return describeFootage(it);
  };

  // ---- import_as: footage (default), comp, comp_cropped_layers, project ----

  var IMPORT_AS = {
    footage: "FOOTAGE",
    comp: "COMP",
    comp_cropped_layers: "COMP_CROPPED_LAYERS",
    project: "PROJECT"
  };
  var IMPORT_AS_ORDER = ["footage", "comp", "comp_cropped_layers", "project"];

  function importAsValue(name) {
    var en = globalObject("ImportAsType");
    if (en === null) return { ok: false, why: "ImportAsType is not available in this After Effects" };
    var v = en[IMPORT_AS[name]];
    if (v === undefined) return { ok: false, why: "ImportAsType." + IMPORT_AS[name] + " is not available in this After Effects" };
    return { ok: true, value: v };
  }

  // Every project item id, to tell what an import created (a PSD as a comp makes a comp and a folder).
  function projectItemMap() {
    var map = {};
    var n = 0;
    try { n = app.project.numItems; } catch (e0) { n = 0; }
    for (var i = 1; i <= n && i <= 20000; i++) {
      try { map[app.project.item(i).id] = true; } catch (e1) {}
    }
    return map;
  }

  function newItemsSince(known) {
    var out = [];
    var n = 0;
    try { n = app.project.numItems; } catch (e0) { n = 0; }
    for (var i = 1; i <= n && i <= 20000; i++) {
      var it = null;
      try { it = app.project.item(i); } catch (e1) { it = null; }
      if (it && known[it.id] !== true) {
        out.push(it);
        known[it.id] = true;
      }
    }
    return out;
  }

  function describeImported(it) {
    if (it instanceof FootageItem) return describeFootage(it);
    var d = { id: it.id, item_id: it.id, name: it.name, typeName: it.typeName };
    if (it instanceof CompItem) {
      try { d.width = it.width; d.height = it.height; d.duration = it.duration; d.frameRate = it.frameRate; d.numLayers = it.numLayers; } catch (e) {}
    }
    return d;
  }

  function checkPlaceholder(ph, i) {
    var tag = "placeholders[" + i + "]: ";
    if (!ph || typeof ph !== "object") fail("bad_args", tag + "must be {name, width, height, fps, duration}");
    if (typeof ph.name !== "string" || ph.name.length === 0) fail("bad_args", tag + "name must be a non-empty string");
    if (!isNum(ph.width) || Math.floor(ph.width) !== ph.width || ph.width < 4 || ph.width > 30000) fail("bad_args", tag + "width must be a whole number from 4 to 30000");
    if (!isNum(ph.height) || Math.floor(ph.height) !== ph.height || ph.height < 4 || ph.height > 30000) fail("bad_args", tag + "height must be a whole number from 4 to 30000");
    if (!isNum(ph.fps) || ph.fps < 1 || ph.fps > 99) fail("bad_args", tag + "fps must be from 1 to 99");
    if (!isNum(ph.duration) || ph.duration < 0 || ph.duration > 10800) fail("bad_args", tag + "duration must be from 0 to 10800 seconds");
  }

  A.importFootage = function (args) {
    assertGuard(args.expect);
    var paths = args.paths;
    var placeholders = args.placeholders;
    var hasPlaceholders = placeholders instanceof Array && placeholders.length > 0;
    if (!paths || !(paths instanceof Array) || paths.length === 0) {
      if (!hasPlaceholders) fail("bad_args", "ae_import_footage requires a non-empty paths array");
      paths = [];
    }
    if (paths.length > MAX_LIST) {
      fail("bad_args", "ae_import_footage supports at most " + MAX_LIST + " paths per call");
    }

    var targetFolder = null;
    if (args.target_folder_id !== undefined && args.target_folder_id !== null) {
      var folderItem = null;
      try {
        folderItem = app.project.itemByID(args.target_folder_id);
      } catch (eFolder) {
        folderItem = null;
      }
      if (!folderItem || !(folderItem instanceof FolderItem)) {
        fail("not_found", "No FolderItem with id " + args.target_folder_id);
      }
      targetFolder = folderItem;
    }

    // Validate all files exist before importing anything (all-or-nothing precheck)
    var files = [];
    for (var i = 0; i < paths.length; i++) {
      var f = new File(paths[i]);
      if (!f.exists) {
        fail("not_found", "Footage file does not exist: " + paths[i]);
      }
      files.push(f);
    }

    var isSequence = Boolean(args.sequence);
    var fps = null;
    if (args.fps !== undefined && args.fps !== null) {
      fps = Number(args.fps);
      if (isNaN(fps) || !isFinite(fps) || fps <= 0) {
        fail("bad_args", "fps must be a positive number");
      }
    }

    // import_as: what AE builds from a layered file. canImportAs is asked first, since importFile throws otherwise.
    var importAs = "footage";
    if (args.import_as !== undefined && args.import_as !== null) importAs = String(args.import_as);
    if (IMPORT_AS[importAs] === undefined) {
      fail("bad_args", "import_as must be 'footage', 'comp', 'comp_cropped_layers' or 'project'");
    }
    var explicitAs = args.import_as !== undefined && args.import_as !== null;
    var asValue = null;
    if (explicitAs) {
      var av = importAsValue(importAs);
      if (!av.ok) {
        if (importAs !== "footage") fail("bad_args", av.why + "; nothing was imported");
      } else {
        asValue = av.value;
      }
    }
    if (importAs !== "footage" && isSequence) {
      fail("bad_args", "import_as '" + importAs + "' can't be combined with sequence: true");
    }
    var notes = [];
    for (var ci = 0; ci < files.length && explicitAs && asValue !== null; ci++) {
      var checkIo = new ImportOptions(files[ci]);
      if (typeof checkIo.canImportAs !== "function") break;
      var can = false;
      try { can = checkIo.canImportAs(asValue); } catch (eCan) { can = false; }
      if (can !== true) {
        var allowed = [];
        for (var ai = 0; ai < IMPORT_AS_ORDER.length; ai++) {
          var alt = importAsValue(IMPORT_AS_ORDER[ai]);
          var altOk = false;
          if (alt.ok) {
            try { altOk = checkIo.canImportAs(alt.value) === true; } catch (eAlt) { altOk = false; }
          }
          if (altOk) allowed.push(IMPORT_AS_ORDER[ai]);
        }
        var allowedText = "none of the four";
        if (allowed.length > 0) allowedText = allowed.join(", ");
        fail("bad_args", paths[ci] + " can't be imported as " + importAs + " (this file allows: " + allowedText + "); nothing was imported");
      }
    }

    // range: first and last frame number of a numbered sequence (rangeStart / rangeEnd are undocumented).
    var range = null;
    if (args.range !== undefined && args.range !== null) {
      range = args.range;
      if (!isSequence) fail("bad_args", "range goes with sequence: true");
      if (args.force_alphabetical === true) {
        fail("bad_args", "range can't be combined with force_alphabetical: true (After Effects throws on rangeStart / rangeEnd then)");
      }
      if (!isNum(range.start) || !isNum(range.end) || Math.floor(range.start) !== range.start || Math.floor(range.end) !== range.end || range.start < 0 || range.end < range.start) {
        fail("bad_args", "range needs whole numbers with 0 <= start <= end");
      }
      if (files.length > 0) {
        var rangeProbe = new ImportOptions(files[0]);
        try {
          rangeProbe.sequence = true;
          rangeProbe.forceAlphabetical = false;
          rangeProbe.rangeStart = range.start;
          rangeProbe.rangeEnd = range.end;
        } catch (eRange) {
          fail("bad_args", "This After Effects refused rangeStart / rangeEnd (" + String(eRange) + "); nothing was imported");
        }
      }
    }
    if (args.force_alphabetical !== undefined && args.force_alphabetical !== null && !isSequence) {
      fail("bad_args", "force_alphabetical goes with sequence: true");
    }

    // Placeholders for footage that is not there yet.
    if (hasPlaceholders) {
      if (placeholders.length > 100) fail("bad_args", "At most 100 placeholders per call");
      if (typeof app.project.importPlaceholder !== "function") {
        fail("bad_args", "Project.importPlaceholder is missing in this After Effects; nothing was imported");
      }
      for (var pi = 0; pi < placeholders.length; pi++) checkPlaceholder(placeholders[pi], pi);
    }

    var trackNew = importAs !== "footage";
    if (importAs === "project") {
      notes.push("Importing a project can raise After Effects dialogs (missing fonts, missing footage, conversion). Read them with ae_dialogs and answer with ae_dialog_respond; this tool never suppresses a dialog.");
    } else {
      for (var ni = 0; ni < paths.length; ni++) {
        if (/\.(aep|aet|aepx)$/i.test(String(paths[ni]))) {
          notes.push("Importing an After Effects project file can raise dialogs (missing fonts or footage, an older file version). Read them with ae_dialogs; this tool never suppresses a dialog.");
          break;
        }
      }
    }

    return A.withUndo("Chroma AE MCP: import_footage", function () {
      var newIds = [];
      var summaries = [];
      var known = null;
      if (trackNew) known = projectItemMap();
      var created = [];
      var placeholderIds = [];
      for (var j = 0; j < files.length; j++) {
        var io = new ImportOptions(files[j]);
        if (asValue !== null) {
          io.importAs = asValue;
        }
        if (isSequence) {
          io.sequence = true;
          // Numbered order with placeholders for gaps, as AE's Import dialog does by default.
          io.forceAlphabetical = args.force_alphabetical === true;
          if (range !== null) {
            io.rangeStart = range.start;
            io.rangeEnd = range.end;
          }
        } else {
          io.sequence = false;
        }
        var imported = app.project.importFile(io);
        if (targetFolder) {
          imported.parentFolder = targetFolder;
        }
        if (fps !== null && imported instanceof FootageItem) {
          try {
            if (imported.mainSource) {
              imported.mainSource.conformFrameRate = fps;
            }
          } catch (eFps) {}
        }
        newIds.push(imported.id);
        if (imported instanceof FootageItem) {
          summaries.push(describeFootage(imported));
        } else {
          summaries.push(describeImported(imported));
        }
        if (trackNew) {
          var fresh = newItemsSince(known);
          for (var fi = 0; fi < fresh.length; fi++) created.push(fresh[fi]);
        }
      }
      for (var q = 0; hasPlaceholders && q < placeholders.length; q++) {
        var ph = placeholders[q];
        var made = app.project.importPlaceholder(ph.name, ph.width, ph.height, ph.fps, ph.duration);
        if (targetFolder) made.parentFolder = targetFolder;
        newIds.push(made.id);
        placeholderIds.push(made.id);
        summaries.push(describeFootage(made));
      }
      var folderId = null;
      if (targetFolder) {
        folderId = targetFolder.id;
      }
      var result = {
        item_ids: newIds,
        items: summaries,
        sequence: isSequence,
        target_folder_id: folderId
      };
      if (explicitAs) result.import_as = importAs;
      if (placeholderIds.length > 0) result.placeholder_ids = placeholderIds;
      if (trackNew) {
        var compIds = [];
        var folderIds = [];
        var newMap = {};
        var compCount = 0;
        var folderCount = 0;
        var c2;
        for (c2 = 0; c2 < created.length; c2++) newMap[created[c2].id] = true;
        var mainComp = null;
        var topFolder = null;
        for (c2 = 0; c2 < created.length; c2++) {
          var ci2 = created[c2];
          var parentNew = false;
          try {
            if (ci2.parentFolder && newMap[ci2.parentFolder.id] === true) parentNew = true;
          } catch (ePn) { parentNew = false; }
          if (ci2 instanceof CompItem) {
            compCount++;
            if (compIds.length < MAX_LIST) compIds.push(ci2.id);
            if (mainComp === null && !parentNew) mainComp = ci2.id;
          } else if (ci2 instanceof FolderItem) {
            folderCount++;
            if (folderIds.length < MAX_LIST) folderIds.push(ci2.id);
            if (topFolder === null && !parentNew) topFolder = ci2.id;
          }
          // The top created items go to the target folder.
          if (targetFolder && !parentNew && ci2 !== targetFolder) {
            try { ci2.parentFolder = targetFolder; } catch (eMv) {}
          }
        }
        result.new_comp_ids = compIds;
        result.new_folder_ids = folderIds;
        result.main_comp_id = mainComp;
        result.created_folder_id = topFolder;
        result.created_item_count = created.length;
        result.new_comp_count = compCount;
        result.new_folder_count = folderCount;
        if (compCount > compIds.length || folderCount > folderIds.length) result.created_truncated = true;
      }
      if (notes.length > 0) result.notes = notes;
      return result;
    });
  };

  A.replaceFootage = function (args) {
    assertGuard(args.expect);
    if (args.item_id === undefined || args.item_id === null) {
      fail("bad_args", "ae_replace_footage requires item_id");
    }
    if (!args.path) {
      fail("bad_args", "ae_replace_footage requires path");
    }

    var it = requireFootage(args.item_id);
    var f = new File(args.path);
    if (!f.exists) {
      fail("not_found", "Replacement footage file does not exist: " + args.path);
    }

    var beforeInfo = describeFootage(it);
    var isSequence = Boolean(args.sequence);

    return A.withUndo("Chroma AE MCP: replace_footage", function () {
      if (isSequence) {
        it.replaceWithSequence(f, false);
      } else {
        it.replace(f);
      }
      return {
        item_id: it.id,
        name: it.name,
        sequence: isSequence,
        before_file: beforeInfo.file,
        before_footage_missing: beforeInfo.footageMissing,
        requested_path: f.fsName
      };
    });
  };

  // ---------- 5. Reload footage (FileSource.reload on the main source) ----------

  var MAX_FOLDER_SCAN = 5000;

  function isFileSource(src) {
    if (!src) return false;
    if (typeof FileSource === "undefined") return false;
    try { return src instanceof FileSource; } catch (e) { return false; }
  }

  // Why an item can't be reloaded, or "" when it can.
  function reloadBlocker(it) {
    var proxy = false;
    try { proxy = it.useProxy === true; } catch (e0) {}
    if (proxy) return "a proxy is in use (reload works on the main source only)";
    var src = null;
    try { src = it.mainSource; } catch (e1) { src = null; }
    if (!isFileSource(src)) return "its source is not a file (a solid, placeholder or other source)";
    if (typeof src.reload !== "function") return "FileSource.reload is missing in this After Effects";
    return "";
  }

  // Footage items named by item_ids, or found under folder_id (nested folders included).
  function reloadCandidates(args) {
    var out = { items: [], notFootage: [], truncated: false };
    var i;
    if (args.item_ids && args.item_ids.length) {
      for (i = 0; i < args.item_ids.length; i++) {
        var it = null;
        try { it = app.project.itemByID(args.item_ids[i]); } catch (e0) { it = null; }
        if (!it) fail("not_found", "No project item with id " + args.item_ids[i]);
        if (!(it instanceof FootageItem)) fail("bad_args", "Project item " + args.item_ids[i] + " (" + it.name + ") is not a FootageItem");
        out.items.push(it);
      }
      return out;
    }
    if (args.folder_id !== undefined && args.folder_id !== null) {
      var root = null;
      try { root = app.project.itemByID(args.folder_id); } catch (e1) { root = null; }
      if (!root || !(root instanceof FolderItem)) fail("not_found", "No FolderItem with id " + args.folder_id);
      var stack = [root];
      var scanned = 0;
      while (stack.length > 0) {
        var folder = stack.pop();
        var n = 0;
        try { n = folder.numItems; } catch (e2) { n = 0; }
        for (i = 1; i <= n; i++) {
          if (scanned >= MAX_FOLDER_SCAN) {
            out.truncated = true;
            return out;
          }
          scanned++;
          var child = null;
          try { child = folder.item(i); } catch (e3) { child = null; }
          if (!child) continue;
          if (child instanceof FolderItem) stack.push(child);
          else if (child instanceof FootageItem) out.items.push(child);
        }
      }
      return out;
    }
    fail("bad_args", "Give item_ids or folder_id");
    return out;
  }

  function reloadSummary(it) {
    var d = describeFootage(it);
    var blocker = reloadBlocker(it);
    d.reloadable = blocker === "";
    if (blocker !== "") d.reason = blocker;
    return d;
  }

  // Read: the items a reload would touch, with the size and duration to compare afterwards.
  A.animateReloadTargets = function (args) {
    var found = reloadCandidates(args);
    var items = [];
    var total = 0;
    for (var i = 0; i < found.items.length; i++) {
      // reloadable_only: the items a reload would really touch, so a capped folder list is not spent on skipped ones.
      if (args.reloadable_only === true && reloadBlocker(found.items[i]) !== "") continue;
      total++;
      if (items.length < MAX_LIST) items.push(reloadSummary(found.items[i]));
    }
    var out = { items: items, total: total };
    if (found.truncated || total > MAX_LIST) out.truncated = true;
    return out;
  };

  A.animateReloadFootage = function (args) {
    assertGuard(args.expect);
    var found = reloadCandidates(args);
    var explicit = args.item_ids && args.item_ids.length > 0;
    var todo = [];
    var skipped = [];
    for (var i = 0; i < found.items.length; i++) {
      var it = found.items[i];
      var why = reloadBlocker(it);
      if (why === "") {
        todo.push(it);
      } else if (explicit) {
        fail("bad_args", "Item " + it.id + " (" + it.name + ") can't be reloaded: " + why + "; nothing was reloaded");
      } else if (skipped.length < MAX_LIST) {
        skipped.push({ item_id: it.id, name: it.name, reason: why });
      }
    }
    if (todo.length > MAX_LIST) fail("bad_args", "At most " + MAX_LIST + " items per reload; reload the folder in parts");
    if (todo.length === 0) {
      return { no_op: true, item_ids: [], reloaded: [], skipped: skipped, truncated: found.truncated === true };
    }
    var ids = [];
    for (var t = 0; t < todo.length; t++) ids.push(todo[t].id);
    return A.withUndo("Chroma AE MCP: reload_footage", function () {
      var reloaded = [];
      var failed = [];
      for (var j = 0; j < todo.length; j++) {
        try {
          todo[j].mainSource.reload();
          reloaded.push(todo[j].id);
        } catch (eReload) {
          failed.push({ item_id: todo[j].id, name: todo[j].name, error: String(eReload) });
        }
      }
      var res = { item_ids: ids, reloaded: reloaded, skipped: skipped };
      if (failed.length > 0) res.failed = failed;
      if (found.truncated === true) res.truncated = true;
      return res;
    });
  };

})($.global);
