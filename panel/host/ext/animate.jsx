// panel/host/ext/animate.jsx
//
// Host functions for Task G3 "animate":
// - setKeyframeEase / getKeyframeEase
// - setText / getTextDocument
// - importFootage / getFootageItems
// - replaceFootage / getFootageItem
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
      // After the ends are eased, so AE retimes the roving keys against them.
      // A key AE won't rove (it may throw, or ignore the call) is reported, not
      // fatal: the eases above stay in this one undo group and the read-back
      // flags any key that didn't rove.
      var rovingFailed = [];
      for (var q = 0; q < rove.length; q++) {
        try { p.setRovingAtKey(rove[q], true); } catch (eRove) { rovingFailed.push(rove[q]); }
      }
      return {
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

    return A.withUndo("Chroma AE MCP: set_keyframe_ease (curve) " + args.path.join(" > "), function () {
      var updated = [];
      for (var j = 0; j < plan.length; j++) {
        var key = plan[j].key;
        var inType = KeyframeInterpolationType.BEZIER;
        var inArr = plan[j].easeIn;
        if (!inArr) {
          inType = p.keyInInterpolationType(key);
          inArr = copyEaseList(p.keyInTemporalEase(key));
        }
        var outType = KeyframeInterpolationType.BEZIER;
        var outArr = plan[j].easeOut;
        if (!outArr) {
          outType = p.keyOutInterpolationType(key);
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
      return {
        comp_id: c.id,
        layer_id: l.id,
        path: args.path,
        keysUpdated: updated,
        numKeys: p.numKeys,
        mode: "curve"
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
      try { t = normBreaks(r.text); } catch (eT) {}
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
  function resolveRanges(ranges, finalText, doc) {
    var out = [];
    if (!ranges || typeof ranges.length !== "number" || ranges.length === 0) return out;
    if (ranges.length > MAX_RANGES) fail("bad_args", "At most " + MAX_RANGES + " ranges");
    if (!hasRanges(doc)) fail("bad_args", "Per-range styling needs After Effects 24.3 or later (TextDocument.characterRange); nothing was written");
    var limit = rangeLength(finalText);
    var plain = normBreaks(finalText);
    out.matchesTruncated = false;
    for (var i = 0; i < ranges.length; i++) {
      var rg = ranges[i];
      var st = rg.style;
      if (!st || typeof st !== "object") fail("bad_args", "Range " + i + " has no style");
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
    if (args.ranges) out.ranges = readRanges(doc, args.ranges);
    return out;
  };

  A.setText = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var srcProp = findSourceTextProp(l);

    // Ranges are resolved against the final text and checked before anything is written.
    var resolved = [];
    if (args.ranges && args.ranges.length) {
      var probe = srcProp.value;
      var finalText = String(probe.text);
      if (args.text !== undefined && args.text !== null) finalText = String(args.text);
      resolved = resolveRanges(args.ranges, finalText, probe);
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

      var st = args.style;
      if (st && typeof st === "object") {
        if (st.font !== undefined && st.font !== null) {
          doc.font = String(st.font);
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
          try { rangeText = normBreaks(range.text); } catch (eRt) {}
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

  A.importFootage = function (args) {
    assertGuard(args.expect);
    if (!args.paths || !(args.paths instanceof Array) || args.paths.length === 0) {
      fail("bad_args", "ae_import_footage requires a non-empty paths array");
    }
    if (args.paths.length > MAX_LIST) {
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
    for (var i = 0; i < args.paths.length; i++) {
      var f = new File(args.paths[i]);
      if (!f.exists) {
        fail("not_found", "Footage file does not exist: " + args.paths[i]);
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

    return A.withUndo("Chroma AE MCP: import_footage", function () {
      var newIds = [];
      var summaries = [];
      for (var j = 0; j < files.length; j++) {
        var io = new ImportOptions(files[j]);
        if (isSequence) {
          io.sequence = true;
          // Numbered order with placeholders for gaps, as AE's Import dialog does by default.
          io.forceAlphabetical = false;
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
          summaries.push({
            id: imported.id,
            item_id: imported.id,
            name: imported.name,
            typeName: imported.typeName
          });
        }
      }
      var folderId = null;
      if (targetFolder) {
        folderId = targetFolder.id;
      }
      return {
        item_ids: newIds,
        items: summaries,
        sequence: isSequence,
        target_folder_id: folderId
      };
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
})($.global);
