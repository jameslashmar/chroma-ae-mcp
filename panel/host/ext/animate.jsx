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

  function readPropertyKeyframes(p) {
    var keys = [];
    var n = p.numKeys;
    var limit = n;
    if (limit > MAX_LIST) {
      limit = MAX_LIST;
    }
    for (var k = 1; k <= limit; k++) {
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
      keys.push({
        keyIndex: k,
        time: p.keyTime(k),
        value: kv,
        inInterp: inIt,
        outInterp: outIt,
        easeIn: easeIn,
        easeOut: easeOut
      });
    }
    var out = {
      name: p.name,
      matchName: p.matchName,
      numKeys: n,
      keyframes: keys
    };
    if (n > MAX_LIST) {
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
    var info = readPropertyKeyframes(p);
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
      return {
        comp_id: c.id,
        layer_id: l.id,
        path: args.path,
        keysUpdated: keyIndices,
        numKeys: p.numKeys,
        easeDimensions: usedDims,
        mode: modeName
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

  A.getTextDocument = function (args) {
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var srcProp = findSourceTextProp(l);
    var doc = srcProp.value;
    return {
      comp_id: c.id,
      layer_id: l.id,
      layer_index: l.index,
      layer_name: l.name,
      numKeys: srcProp.numKeys,
      document: serialiseTextDoc(doc)
    };
  };

  A.setText = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var srcProp = findSourceTextProp(l);

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

      setSourceTextValue(c, srcProp, doc);
      var justCheck = verifyAndReassertJustification(c, srcProp, targetJust);

      return {
        comp_id: c.id,
        layer_id: l.id,
        layer_name: l.name,
        applied: applied,
        justification: justCheck.justification,
        justificationReasserted: justCheck.justificationReasserted
      };
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
          io.forceAlphabetical = true;
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
        it.replaceWithSequence(f, true);
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
