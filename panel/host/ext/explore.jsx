// explore.jsx: Read-only exploration and expression validation host functions for __chromaAe.
//
// Credits:
// - get_layer_full and find_layers ideas adapted from reference/engine-room/packages/jsx/explore.jsx
//   (Engine-Room-Games/after-effects-mcp, MIT License).
//
// Rules (see docs/BUILDERS.md):
// - ES3 only: no let, const, arrow functions, template strings, or classes.
// - Never use chained ternaries (ExtendScript parses them left-associatively). Use if/else.
// - Strictly READ-ONLY: must not change any project, comp, or layer state (never touch comp.time,
//   resolutionFactor, selection, solo, or expressionEnabled).

(function (G) {
  if (!G.__chromaAe) {
    G.__chromaAe = {};
  }
  var A = G.__chromaAe;

  var MAX_LIST = 500;
  var MAX_STRING = 20000;
  var MAX_EXPR_PREVIEW = 500;

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

  function isArray(v) {
    return v instanceof Array;
  }

  function truncateString(s, maxLen) {
    var str = String(s);
    var limit = maxLen || MAX_STRING;
    if (str.length > limit) {
      return str.substring(0, limit) + " ...[truncated]";
    }
    return str;
  }

  function compById(id) {
    var item = null;
    try {
      item = app.project.itemByID(id);
    } catch (e) {
      item = null;
    }
    if (item && item instanceof CompItem) {
      return item;
    }
    return null;
  }

  function requireComp(id) {
    var c = compById(id);
    if (!c) {
      fail("not_found", "No CompItem with id " + id);
    }
    return c;
  }

  function findLayer(comp, sel) {
    var i;
    if (!sel) {
      fail("bad_args", "layer selector missing");
    }
    if (sel.id !== undefined && sel.id !== null) {
      for (i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        if (l.id === sel.id) {
          return l;
        }
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
      if (!byName) {
        fail("not_found", "No layer named \"" + sel.name + "\"");
      }
      return byName;
    }
    fail("bad_args", "layer selector needs id, index or name");
    return null;
  }

  function serialiseShape(shapeVal) {
    if (!shapeVal) return null;
    var out = { closed: false, vertices: [], inTangents: [], outTangents: [], truncated: false };
    try { out.closed = Boolean(shapeVal.closed); } catch (e1) {}
    try {
      var verts = shapeVal.vertices;
      if (verts && verts.length !== undefined) {
        var n = verts.length;
        if (n > MAX_LIST) {
          n = MAX_LIST;
          out.truncated = true;
        }
        for (var i = 0; i < n; i++) {
          out.vertices.push([verts[i][0], verts[i][1]]);
        }
      }
    } catch (e2) {}
    try {
      var inT = shapeVal.inTangents;
      if (inT && inT.length !== undefined) {
        var ni = inT.length;
        if (ni > MAX_LIST) ni = MAX_LIST;
        for (var j = 0; j < ni; j++) {
          out.inTangents.push([inT[j][0], inT[j][1]]);
        }
      }
    } catch (e3) {}
    try {
      var outT = shapeVal.outTangents;
      if (outT && outT.length !== undefined) {
        var no = outT.length;
        if (no > MAX_LIST) no = MAX_LIST;
        for (var k = 0; k < no; k++) {
          out.outTangents.push([outT[k][0], outT[k][1]]);
        }
      }
    } catch (e4) {}
    return out;
  }

  function serialiseTextDocument(v) {
    var td = { text: "" };
    try { td.text = truncateString(v.text, MAX_STRING); } catch (e0) {}
    try { td.font = v.font; } catch (e1) {}
    try { td.fontSize = v.fontSize; } catch (e2) {}
    try { td.fillColor = v.fillColor; } catch (e3) {}
    try { td.strokeColor = v.strokeColor; } catch (e4) {}
    try { td.strokeWidth = v.strokeWidth; } catch (e5) {}
    try { td.applyFill = v.applyFill; } catch (e6) {}
    try { td.applyStroke = v.applyStroke; } catch (e7) {}
    try { td.justification = String(v.justification); } catch (e8) {}
    try { td.tracking = v.tracking; } catch (e9) {}
    try { td.leading = v.leading; } catch (e10) {}
    try { td.baselineShift = v.baselineShift; } catch (e11) {}
    try { td.boxText = v.boxText; } catch (e12) {}
    try { if (v.boxText) td.boxTextSize = v.boxTextSize; } catch (e13) {}
    try { if (v.boxText) td.boxTextPos = v.boxTextPos; } catch (e14) {}
    return td;
  }

  function serialiseMarker(mv) {
    if (!mv) return null;
    var m = {};
    try { m.comment = truncateString(mv.comment || "", MAX_STRING); } catch (e1) {}
    try { m.duration = mv.duration; } catch (e2) {}
    try { m.chapter = mv.chapter; } catch (e3) {}
    try { m.url = mv.url; } catch (e4) {}
    try { m.frameTarget = mv.frameTarget; } catch (e5) {}
    try { m.cuePointName = mv.cuePointName; } catch (e6) {}
    try { m.protectedRegion = mv.protectedRegion; } catch (e7) {}
    try { m.label = mv.label; } catch (e8) {}
    try {
      if (mv.getParameters) {
        var params = mv.getParameters();
        if (params) {
          var cleanParams = {};
          for (var k in params) {
            if (params.hasOwnProperty(k)) {
              cleanParams[k] = String(params[k]);
            }
          }
          m.params = cleanParams;
        }
      }
    } catch (e9) {}
    return m;
  }

  function serialiseValue(v) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === "number") {
      if (isNaN(v) || !isFinite(v)) return null;
      return v;
    }
    if (t === "boolean") return v;
    if (t === "string") return truncateString(v, MAX_STRING);
    if (isArray(v)) {
      var a = [];
      var n = v.length;
      if (n > MAX_LIST) n = MAX_LIST;
      for (var i = 0; i < n; i++) {
        a.push(serialiseValue(v[i]));
      }
      return a;
    }
    try {
      if (v instanceof TextDocument) {
        return serialiseTextDocument(v);
      }
    } catch (e1) {}
    try {
      if (v instanceof Shape) {
        return serialiseShape(v);
      }
    } catch (e2) {}
    try {
      if (v instanceof MarkerValue) {
        return serialiseMarker(v);
      }
    } catch (e3) {}
    try {
      if (v.vertices !== undefined && v.inTangents !== undefined && v.outTangents !== undefined) {
        return serialiseShape(v);
      }
    } catch (e4) {}
    try {
      return "[" + v.reflect.name + "]";
    } catch (e5) {}
    return truncateString(String(v), MAX_STRING);
  }

  function classifyLayerKind(l) {
    var reflectName = "Layer";
    try {
      if (l.reflect && l.reflect.name) {
        reflectName = String(l.reflect.name);
      }
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
      if (l.source && (l.source instanceof CompItem)) return "precomp";
    } catch (e3) {}
    try {
      if (l.source && l.source.mainSource && (l.source.mainSource instanceof SolidSource)) {
        return "solid";
      }
    } catch (e4) {}
    try {
      if (l.hasAudio && !l.hasVideo) return "audio";
    } catch (e5) {}
    if (reflectName === "AVLayer") return "av";
    return reflectName.toLowerCase();
  }

  function layerSummary(l) {
    var reflectType = "Layer";
    if (l.reflect && l.reflect.name) {
      reflectType = String(l.reflect.name);
    }
    var s = {
      index: l.index,
      id: l.id,
      name: l.name,
      type: reflectType,
      kind: classifyLayerKind(l),
      inPoint: l.inPoint,
      outPoint: l.outPoint,
      startTime: l.startTime,
      stretch: l.stretch,
      enabled: l.enabled,
      locked: l.locked,
      label: l.label,
      parent: null
    };
    try { if (l.parent) s.parent = l.parent.index; } catch (e1) {}
    try { s.shy = l.shy; } catch (e2) {}
    try { s.solo = l.solo; } catch (e3) {}
    try { s.nullLayer = l.nullLayer; } catch (e4) {}
    try { s.adjustmentLayer = l.adjustmentLayer; } catch (e5) {}
    try { s.threeDLayer = l.threeDLayer; } catch (e6) {}
    try { s.motionBlur = l.motionBlur; } catch (e7) {}
    try { s.effectsActive = l.effectsActive; } catch (e8) {}
    try { s.blendingMode = String(l.blendingMode); } catch (e9) {}
    try { s.trackMatteType = String(l.trackMatteType); } catch (e10) {}
    try {
      if (l.source) {
        s.sourceId = l.source.id;
        s.sourceName = l.source.name;
      }
    } catch (e11) {}
    try { if (l.comment) s.comment = truncateString(l.comment, MAX_STRING); } catch (e12) {}
    return s;
  }

  function interpName(interpVal) {
    try {
      if (interpVal === KeyframeInterpolationType.LINEAR) return "linear";
      if (interpVal === KeyframeInterpolationType.BEZIER) return "bezier";
      if (interpVal === KeyframeInterpolationType.HOLD) return "hold";
    } catch (e) {}
    return String(interpVal);
  }

  function serialiseEaseList(easeArr) {
    if (!easeArr || !easeArr.length) return [];
    var out = [];
    for (var i = 0; i < easeArr.length; i++) {
      out.push({
        speed: easeArr[i].speed,
        influence: easeArr[i].influence
      });
    }
    return out;
  }

  function readPropertyKeyframes(p, maxKeyframes) {
    var total = 0;
    try { total = p.numKeys || 0; } catch (e0) { total = 0; }
    var limit = maxKeyframes;
    if (limit === undefined || limit === null || limit <= 0) limit = 100;
    if (limit > MAX_LIST) limit = MAX_LIST;

    var count = total;
    var truncated = false;
    if (count > limit) {
      count = limit;
      truncated = true;
    }

    var keys = [];
    for (var k = 1; k <= count; k++) {
      var kf = { index: k, time: p.keyTime(k), value: null };
      try { kf.value = serialiseValue(p.keyValue(k)); } catch (e1) {}
      try { kf.inInterp = interpName(p.keyInInterpolationType(k)); } catch (e2) {}
      try { kf.outInterp = interpName(p.keyOutInterpolationType(k)); } catch (e3) {}
      try { kf.inTemporalEase = serialiseEaseList(p.keyInTemporalEase(k)); } catch (e4) {}
      try { kf.outTemporalEase = serialiseEaseList(p.keyOutTemporalEase(k)); } catch (e5) {}
      try { kf.inSpatialTangent = serialiseValue(p.keyInSpatialTangent(k)); } catch (e6) {}
      try { kf.outSpatialTangent = serialiseValue(p.keyOutSpatialTangent(k)); } catch (e7) {}
      try { kf.temporalContinuous = p.keyTemporalContinuous(k); } catch (e8) {}
      try { kf.temporalAutoBezier = p.keyTemporalAutoBezier(k); } catch (e9) {}
      try { kf.roving = p.keyRoving(k); } catch (e10) {}
      keys.push(kf);
    }
    return {
      numKeys: total,
      keyframes: keys,
      truncated: truncated
    };
  }

  function describeLeafProp(p, includeKeyframes, maxKeyframes) {
    var d = {
      name: p.name,
      matchName: p.matchName,
      propertyIndex: p.propertyIndex
    };
    try {
      d.value = serialiseValue(p.value);
    } catch (e1) {
      d.value = null;
      d.valueError = String(e1.message ? e1.message : e1);
    }
    var nk = 0;
    try { nk = p.numKeys || 0; } catch (e2) { nk = 0; }
    d.numKeys = nk;
    try {
      if (p.canSetExpression) {
        d.expression = truncateString(p.expression || "", MAX_STRING);
        d.expressionEnabled = Boolean(p.expressionEnabled);
        if (p.expressionError) {
          d.expressionError = truncateString(p.expressionError, MAX_STRING);
        }
      } else {
        d.expression = "";
        d.expressionEnabled = false;
      }
    } catch (e3) {}
    try {
      if (p.isSeparationLeader) {
        d.dimensionsSeparated = Boolean(p.dimensionsSeparated);
      }
    } catch (e4) {}
    if (includeKeyframes && nk > 0) {
      var kfInfo = readPropertyKeyframes(p, maxKeyframes);
      d.keyframes = kfInfo.keyframes;
      if (kfInfo.truncated) d.keyframesTruncated = true;
    }
    return d;
  }

  function readTransformSection(l, includeKeyframes, maxKeyframes) {
    var tr = null;
    try { tr = l.property("ADBE Transform Group"); } catch (e0) { tr = null; }
    if (!tr) return null;
    var props = [];
    var n = tr.numProperties || 0;
    var truncated = false;
    if (n > MAX_LIST) {
      n = MAX_LIST;
      truncated = true;
    }
    for (var i = 1; i <= n; i++) {
      try {
        var p = tr.property(i);
        if (p && p.propertyType === PropertyType.PROPERTY) {
          props.push(describeLeafProp(p, includeKeyframes, maxKeyframes));
        }
      } catch (e1) {}
    }
    return {
      numProperties: tr.numProperties || 0,
      properties: props,
      truncated: truncated
    };
  }

  function readEffectsSection(l, includeKeyframes, maxKeyframes) {
    var fxGroup = null;
    try { fxGroup = l.property("ADBE Effect Parade"); } catch (e0) { fxGroup = null; }
    if (!fxGroup) {
      return { numEffects: 0, effects: [], truncated: false };
    }
    var total = fxGroup.numProperties || 0;
    var count = total;
    var truncated = false;
    if (count > MAX_LIST) {
      count = MAX_LIST;
      truncated = true;
    }
    var effects = [];
    for (var i = 1; i <= count; i++) {
      try {
        var fx = fxGroup.property(i);
        if (!fx) continue;
        var fxEnabled = true;
        try { fxEnabled = Boolean(fx.enabled); } catch (e1) {}
        var numParams = fx.numProperties || 0;
        var pLimit = numParams;
        var pTrunc = false;
        if (pLimit > MAX_LIST) {
          pLimit = MAX_LIST;
          pTrunc = true;
        }
        var params = [];
        for (var j = 1; j <= pLimit; j++) {
          try {
            var prm = fx.property(j);
            if (!prm) continue;
            if (prm.propertyType === PropertyType.PROPERTY) {
              params.push(describeLeafProp(prm, includeKeyframes, maxKeyframes));
            } else {
              params.push({
                name: prm.name,
                matchName: prm.matchName,
                propertyIndex: prm.propertyIndex,
                kind: "group",
                numProperties: prm.numProperties || 0
              });
            }
          } catch (e2) {}
        }
        effects.push({
          index: i,
          name: fx.name,
          matchName: fx.matchName,
          enabled: fxEnabled,
          numProperties: numParams,
          params: params,
          truncated: pTrunc
        });
      } catch (e3) {}
    }
    return {
      numEffects: total,
      effects: effects,
      truncated: truncated
    };
  }

  function readMasksSection(l, includeKeyframes, maxKeyframes) {
    var maskGroup = null;
    try { maskGroup = l.property("ADBE Mask Parade"); } catch (e0) { maskGroup = null; }
    if (!maskGroup) {
      return { numMasks: 0, masks: [], truncated: false };
    }
    var total = maskGroup.numProperties || 0;
    var count = total;
    var truncated = false;
    if (count > MAX_LIST) {
      count = MAX_LIST;
      truncated = true;
    }
    var masks = [];
    for (var i = 1; i <= count; i++) {
      try {
        var m = maskGroup.property(i);
        if (!m) continue;
        var entry = {
          index: i,
          name: m.name,
          matchName: m.matchName,
          enabled: true,
          inverted: false,
          rotoBezier: false,
          maskMode: null
        };
        try { entry.enabled = Boolean(m.enabled); } catch (e1) {}
        try { entry.inverted = Boolean(m.inverted); } catch (e2) {}
        try { entry.rotoBezier = Boolean(m.rotoBezier); } catch (e3) {}
        try { entry.maskMode = String(m.maskMode); } catch (e4) {}
        try {
          var pathProp = m.property("ADBE Mask Shape");
          if (pathProp) entry.maskPath = describeLeafProp(pathProp, includeKeyframes, maxKeyframes);
        } catch (e5) {}
        try {
          var featherProp = m.property("ADBE Mask Feather");
          if (featherProp) entry.maskFeather = describeLeafProp(featherProp, includeKeyframes, maxKeyframes);
        } catch (e6) {}
        try {
          var opacityProp = m.property("ADBE Mask Opacity");
          if (opacityProp) entry.maskOpacity = describeLeafProp(opacityProp, includeKeyframes, maxKeyframes);
        } catch (e7) {}
        try {
          var expProp = m.property("ADBE Mask Offset");
          if (expProp) entry.maskExpansion = describeLeafProp(expProp, includeKeyframes, maxKeyframes);
        } catch (e8) {}
        masks.push(entry);
      } catch (e9) {}
    }
    return {
      numMasks: total,
      masks: masks,
      truncated: truncated
    };
  }

  function readTextSection(l, includeKeyframes, maxKeyframes) {
    var textGroup = null;
    try { textGroup = l.property("ADBE Text Properties"); } catch (e0) { textGroup = null; }
    if (!textGroup) return null;
    var out = {
      sourceText: null,
      pathOptions: null,
      moreOptions: null,
      animators: [],
      truncated: false
    };
    try {
      var st = textGroup.property("ADBE Text Document");
      if (st) out.sourceText = describeLeafProp(st, includeKeyframes, maxKeyframes);
    } catch (e1) {}
    try {
      var animGroup = textGroup.property("ADBE Text Animators");
      if (animGroup) {
        var nAnim = animGroup.numProperties || 0;
        var limit = nAnim;
        if (limit > MAX_LIST) {
          limit = MAX_LIST;
          out.truncated = true;
        }
        for (var i = 1; i <= limit; i++) {
          var anim = animGroup.property(i);
          if (anim) {
            out.animators.push({
              index: i,
              name: anim.name,
              matchName: anim.matchName,
              numProperties: anim.numProperties || 0
            });
          }
        }
      }
    } catch (e2) {}
    return out;
  }

  function readShapeNode(prop, depthLeft, includeKeyframes, maxKeyframes) {
    if (prop.propertyType === PropertyType.PROPERTY) {
      var leaf = describeLeafProp(prop, includeKeyframes, maxKeyframes);
      leaf.kind = "property";
      return leaf;
    }
    var grp = {
      name: prop.name,
      matchName: prop.matchName,
      propertyIndex: prop.propertyIndex,
      kind: "group",
      numProperties: prop.numProperties || 0
    };
    try { grp.enabled = Boolean(prop.enabled); } catch (e0) {}
    if (depthLeft > 0) {
      var total = prop.numProperties || 0;
      var count = total;
      if (count > MAX_LIST) {
        count = MAX_LIST;
        grp.truncated = true;
      }
      var children = [];
      for (var i = 1; i <= count; i++) {
        try {
          var child = prop.property(i);
          if (child) {
            children.push(readShapeNode(child, depthLeft - 1, includeKeyframes, maxKeyframes));
          }
        } catch (e1) {}
      }
      grp.properties = children;
    } else if ((prop.numProperties || 0) > 0) {
      grp.depthTruncated = true;
    }
    return grp;
  }

  function readShapesSection(l, shapeDepth, includeKeyframes, maxKeyframes) {
    var rootVectors = null;
    try { rootVectors = l.property("ADBE Root Vectors Group"); } catch (e0) { rootVectors = null; }
    if (!rootVectors) return null;
    var depth = shapeDepth;
    if (depth === undefined || depth === null || depth < 1) depth = 4;
    if (depth > 12) depth = 12;
    return readShapeNode(rootVectors, depth, includeKeyframes, maxKeyframes);
  }

  function collectExpressionsAndKeyframes(l, wantExpressions, wantKeyframes, maxKeyframes) {
    var exprItems = [];
    var exprTruncated = false;
    var kfItems = [];
    var kfTruncated = false;

    function walk(group, pathPrefix, depth) {
      if (depth > 14) return;
      var n = 0;
      try { n = group.numProperties || 0; } catch (e0) { n = 0; }
      for (var i = 1; i <= n; i++) {
        if (( !wantExpressions || exprTruncated ) && ( !wantKeyframes || kfTruncated )) {
          return;
        }
        var p = null;
        try { p = group.property(i); } catch (e1) { p = null; }
        if (!p) continue;
        var seg = p.name || p.matchName || String(i);
        var curPath = pathPrefix.concat([seg]);

        if (p.propertyType === PropertyType.PROPERTY) {
          if (wantExpressions && !exprTruncated) {
            var hasExpr = false;
            var exprStr = "";
            var exprErr = "";
            try {
              if (p.canSetExpression) {
                exprStr = p.expression ? String(p.expression) : "";
                exprErr = p.expressionError ? String(p.expressionError) : "";
                if (exprStr.length > 0 || exprErr.length > 0) {
                  hasExpr = true;
                }
              }
            } catch (e2) {}
            if (hasExpr) {
              if (exprItems.length >= MAX_LIST) {
                exprTruncated = true;
              } else {
                var enabled = false;
                try { enabled = Boolean(p.expressionEnabled); } catch (e3) {}
                exprItems.push({
                  path: curPath,
                  name: p.name,
                  matchName: p.matchName,
                  expression: truncateString(exprStr, MAX_STRING),
                  expressionEnabled: enabled,
                  expressionError: exprErr.length > 0 ? truncateString(exprErr, MAX_STRING) : null
                });
              }
            }
          }

          if (wantKeyframes && !kfTruncated) {
            var nk = 0;
            try { nk = p.numKeys || 0; } catch (e4) { nk = 0; }
            if (nk > 0) {
              if (kfItems.length >= MAX_LIST) {
                kfTruncated = true;
              } else {
                var kfData = readPropertyKeyframes(p, maxKeyframes);
                kfItems.push({
                  path: curPath,
                  name: p.name,
                  matchName: p.matchName,
                  numKeys: kfData.numKeys,
                  keyframes: kfData.keyframes,
                  truncated: kfData.truncated
                });
              }
            }
          }
        } else {
          walk(p, curPath, depth + 1);
        }
      }
    }

    walk(l, [], 0);
    return {
      expressions: {
        count: exprItems.length,
        items: exprItems,
        truncated: exprTruncated
      },
      keyframes: {
        count: kfItems.length,
        properties: kfItems,
        truncated: kfTruncated
      }
    };
  }

  function readMarkersSection(l, maxKeyframes) {
    var markerProp = null;
    try { markerProp = l.property("ADBE Marker"); } catch (e0) { markerProp = null; }
    if (!markerProp) {
      try { markerProp = l.marker; } catch (e1) { markerProp = null; }
    }
    if (!markerProp) {
      return { numKeys: 0, markers: [], truncated: false };
    }
    var total = 0;
    try { total = markerProp.numKeys || 0; } catch (e2) { total = 0; }
    var limit = maxKeyframes;
    if (limit === undefined || limit === null || limit <= 0) limit = 100;
    if (limit > MAX_LIST) limit = MAX_LIST;

    var count = total;
    var truncated = false;
    if (count > limit) {
      count = limit;
      truncated = true;
    }

    var markers = [];
    for (var k = 1; k <= count; k++) {
      try {
        var mv = markerProp.keyValue(k);
        var info = serialiseMarker(mv) || {};
        info.index = k;
        info.time = markerProp.keyTime(k);
        markers.push(info);
      } catch (e3) {}
    }
    return {
      numKeys: total,
      markers: markers,
      truncated: truncated
    };
  }

  function hasIncludeSection(includeList, sectionName) {
    if (!includeList || !includeList.length) return true;
    for (var i = 0; i < includeList.length; i++) {
      if (includeList[i] === sectionName) return true;
    }
    return false;
  }

  // ---------- 1. getLayerFull ----------

  A.getLayerFull = function (args) {
    if (!args) fail("bad_args", "getLayerFull requires args");
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var include = args.include;
    var maxKeyframes = (args.max_keyframes !== undefined && args.max_keyframes !== null) ? Number(args.max_keyframes) : 100;
    if (isNaN(maxKeyframes) || maxKeyframes < 1) maxKeyframes = 100;
    if (maxKeyframes > MAX_LIST) maxKeyframes = MAX_LIST;

    var shapeDepth = (args.shape_depth !== undefined && args.shape_depth !== null) ? Number(args.shape_depth) : 4;
    if (isNaN(shapeDepth) || shapeDepth < 1) shapeDepth = 4;
    if (shapeDepth > 12) shapeDepth = 12;

    var wantTransform = hasIncludeSection(include, "transform");
    var wantEffects = hasIncludeSection(include, "effects");
    var wantMasks = hasIncludeSection(include, "masks");
    var wantText = hasIncludeSection(include, "text");
    var wantShapes = hasIncludeSection(include, "shapes");
    var wantExpressions = hasIncludeSection(include, "expressions");
    var wantKeyframes = hasIncludeSection(include, "keyframes");
    var wantMarkers = hasIncludeSection(include, "markers");

    var out = {
      comp_id: c.id,
      comp_name: c.name,
      layer: layerSummary(l)
    };

    if (wantTransform) {
      out.transform = readTransformSection(l, wantKeyframes, maxKeyframes);
    }
    if (wantEffects) {
      out.effects = readEffectsSection(l, wantKeyframes, maxKeyframes);
    }
    if (wantMasks) {
      out.masks = readMasksSection(l, wantKeyframes, maxKeyframes);
    }
    if (wantText) {
      out.text = readTextSection(l, wantKeyframes, maxKeyframes);
    }
    if (wantShapes) {
      out.shapes = readShapesSection(l, shapeDepth, wantKeyframes, maxKeyframes);
    }
    if (wantExpressions || wantKeyframes) {
      var walked = collectExpressionsAndKeyframes(l, wantExpressions, wantKeyframes, maxKeyframes);
      if (wantExpressions) out.expressions = walked.expressions;
      if (wantKeyframes) out.keyframes = walked.keyframes;
    }
    if (wantMarkers) {
      out.markers = readMarkersSection(l, maxKeyframes);
    }

    return out;
  };

  // ---------- 2. findLayers ----------

  function layerHasEffectMatch(l, matchTarget) {
    var fxGroup = null;
    try { fxGroup = l.property("ADBE Effect Parade"); } catch (e0) { fxGroup = null; }
    if (!fxGroup) return false;
    var targetLower = String(matchTarget).toLowerCase();
    var n = fxGroup.numProperties || 0;
    for (var i = 1; i <= n; i++) {
      try {
        var fx = fxGroup.property(i);
        if (!fx) continue;
        if (fx.matchName && String(fx.matchName).toLowerCase() === targetLower) return true;
        if (fx.name && String(fx.name).toLowerCase() === targetLower) return true;
      } catch (e1) {}
    }
    return false;
  }

  function layerHasAnyExpression(group, depth) {
    if (depth > 14) return false;
    var n = 0;
    try { n = group.numProperties || 0; } catch (e0) { n = 0; }
    for (var i = 1; i <= n; i++) {
      var p = null;
      try { p = group.property(i); } catch (e1) { p = null; }
      if (!p) continue;
      if (p.propertyType === PropertyType.PROPERTY) {
        try {
          if (p.canSetExpression && p.expression && String(p.expression).length > 0) {
            return true;
          }
        } catch (e2) {}
      } else {
        if (layerHasAnyExpression(p, depth + 1)) return true;
      }
    }
    return false;
  }

  function layerMatchesType(l, typeFilter) {
    var target = String(typeFilter).toLowerCase();
    var reflectName = "";
    try {
      if (l.reflect && l.reflect.name) reflectName = String(l.reflect.name).toLowerCase();
    } catch (e0) {}
    if (reflectName === target) return true;
    var kind = classifyLayerKind(l).toLowerCase();
    if (kind === target) return true;
    if (target === "layer") return true;
    if (target === "avlayer" && reflectName === "avlayer") return true;
    if (target === "textlayer" && reflectName === "textlayer") return true;
    if (target === "shapelayer" && reflectName === "shapelayer") return true;
    if (target === "cameralayer" && reflectName === "cameralayer") return true;
    if (target === "lightlayer" && reflectName === "lightlayer") return true;
    if (target === "footage" && kind === "av") return true;
    return false;
  }

  A.findLayers = function (args) {
    var opts = args || {};
    var limit = (opts.limit !== undefined && opts.limit !== null) ? Number(opts.limit) : 200;
    if (isNaN(limit) || limit < 1) limit = 200;
    if (limit > MAX_LIST) limit = MAX_LIST;

    var comps = [];
    if (opts.comp_id !== undefined && opts.comp_id !== null) {
      comps.push(requireComp(opts.comp_id));
    } else {
      var totalItems = app.project.numItems || 0;
      for (var cIdx = 1; cIdx <= totalItems; cIdx++) {
        var it = app.project.item(cIdx);
        if (it && (it instanceof CompItem)) {
          comps.push(it);
        }
      }
    }

    var nameSub = null;
    if (opts.name_contains !== undefined && opts.name_contains !== null && String(opts.name_contains).length > 0) {
      nameSub = String(opts.name_contains).toLowerCase();
    }
    var typeFilter = null;
    if (opts.type !== undefined && opts.type !== null && String(opts.type).length > 0) {
      typeFilter = String(opts.type);
    }
    var effectFilter = null;
    if (opts.has_effect_match_name !== undefined && opts.has_effect_match_name !== null && String(opts.has_effect_match_name).length > 0) {
      effectFilter = String(opts.has_effect_match_name);
    }
    var checkExpr = (opts.has_expression !== undefined && opts.has_expression !== null);
    var wantExpr = Boolean(opts.has_expression);
    var checkSource = (opts.source_id !== undefined && opts.source_id !== null);
    var wantSourceId = Number(opts.source_id);

    var matches = [];
    var totalMatched = 0;
    var truncated = false;

    for (var i = 0; i < comps.length; i++) {
      var comp = comps[i];
      var numL = comp.numLayers || 0;
      for (var li = 1; li <= numL; li++) {
        var l = comp.layer(li);
        if (!l) continue;

        if (nameSub !== null) {
          var lname = l.name ? String(l.name).toLowerCase() : "";
          if (lname.indexOf(nameSub) === -1) continue;
        }
        if (typeFilter !== null) {
          if (!layerMatchesType(l, typeFilter)) continue;
        }
        if (checkSource) {
          var srcId = null;
          try { if (l.source) srcId = l.source.id; } catch (e1) {}
          if (srcId !== wantSourceId) continue;
        }
        if (effectFilter !== null) {
          if (!layerHasEffectMatch(l, effectFilter)) continue;
        }
        if (checkExpr) {
          var hasE = layerHasAnyExpression(l, 0);
          if (hasE !== wantExpr) continue;
        }

        totalMatched++;
        if (matches.length < limit) {
          var sum = layerSummary(l);
          matches.push({
            comp_id: comp.id,
            comp_name: comp.name,
            layer: sum
          });
        } else {
          truncated = true;
        }
      }
    }

    return {
      total_matched: totalMatched,
      limit: limit,
      truncated: truncated,
      matches: matches
    };
  };

  // ---------- 3. listEffects ----------

  A.listEffects = function (args) {
    var filterStr = null;
    if (args && args.filter !== undefined && args.filter !== null && String(args.filter).length > 0) {
      filterStr = String(args.filter).toLowerCase();
    }

    var fxList = [];
    try { fxList = app.effects || []; } catch (e0) { fxList = []; }
    var totalInstalled = fxList.length || 0;

    var out = [];
    var truncated = false;

    for (var i = 0; i < totalInstalled; i++) {
      var fx = fxList[i];
      if (!fx) continue;
      var dName = "";
      var mName = "";
      var cat = "";
      var ver = "";
      try { dName = fx.displayName ? String(fx.displayName) : ""; } catch (e1) {}
      try { mName = fx.matchName ? String(fx.matchName) : ""; } catch (e2) {}
      try { cat = fx.category ? String(fx.category) : ""; } catch (e3) {}
      try { ver = fx.version ? String(fx.version) : ""; } catch (e4) {}

      if (filterStr !== null) {
        var matched = false;
        if (dName.toLowerCase().indexOf(filterStr) !== -1) matched = true;
        if (!matched && mName.toLowerCase().indexOf(filterStr) !== -1) matched = true;
        if (!matched && cat.toLowerCase().indexOf(filterStr) !== -1) matched = true;
        if (!matched) continue;
      }

      if (out.length >= MAX_LIST) {
        truncated = true;
        break;
      }

      out.push({
        displayName: dName,
        matchName: mName,
        category: cat,
        version: ver
      });
    }

    return {
      total_installed: totalInstalled,
      count: out.length,
      truncated: truncated,
      effects: out
    };
  };

  // ---------- 4. validateExpressions ----------

  // Strictly read-only: forces evaluation via prop.valueAtTime(t, false) inside
  // try/catch, then reads prop.expressionError. NEVER toggles expressionEnabled
  // or changes comp.time.
  A.validateExpressions = function (args) {
    if (!args) fail("bad_args", "validateExpressions requires args");
    var c = requireComp(args.comp_id);
    var evalTime = c.time;
    if (args.time !== undefined && args.time !== null) {
      evalTime = Number(args.time);
      if (isNaN(evalTime)) evalTime = c.time;
    }

    var layers = [];
    if (args.layer !== undefined && args.layer !== null) {
      layers.push(findLayer(c, args.layer));
    } else {
      for (var li = 1; li <= c.numLayers; li++) {
        layers.push(c.layer(li));
      }
    }

    var results = [];
    var errorCount = 0;
    var truncated = false;

    function walkProps(group, lInfo, pathPrefix, depth) {
      if (depth > 14 || truncated) return;
      var n = 0;
      try { n = group.numProperties || 0; } catch (e0) { n = 0; }
      for (var i = 1; i <= n; i++) {
        if (truncated) return;
        var p = null;
        try { p = group.property(i); } catch (e1) { p = null; }
        if (!p) continue;
        var seg = p.name || p.matchName || String(i);
        var curPath = pathPrefix.concat([seg]);

        if (p.propertyType === PropertyType.PROPERTY) {
          var canExpr = false;
          var exprStr = "";
          try {
            canExpr = Boolean(p.canSetExpression);
            if (canExpr && p.expression) {
              exprStr = String(p.expression);
            }
          } catch (e2) {}

          if (canExpr && exprStr.length > 0) {
            if (results.length >= MAX_LIST) {
              truncated = true;
              return;
            }
            var caughtMsg = "";
            try {
              p.valueAtTime(evalTime, false);
            } catch (evalErr) {
              try {
                caughtMsg = String(evalErr.message ? evalErr.message : evalErr);
              } catch (e3) {
                caughtMsg = "Expression evaluation threw an error";
              }
            }

            var propErr = "";
            try {
              if (p.expressionError && String(p.expressionError).length > 0) {
                propErr = String(p.expressionError);
              }
            } catch (e4) {}

            var finalErr = "";
            if (propErr.length > 0) {
              finalErr = propErr;
            } else if (caughtMsg.length > 0) {
              finalErr = caughtMsg;
            }

            var enabled = false;
            try { enabled = Boolean(p.expressionEnabled); } catch (e5) {}

            if (finalErr.length > 0) {
              errorCount++;
            }

            results.push({
              layer: lInfo,
              path: curPath,
              expression: truncateString(exprStr, MAX_EXPR_PREVIEW),
              expressionEnabled: enabled,
              error: finalErr.length > 0 ? truncateString(finalErr, MAX_STRING) : ""
            });
          }
        } else {
          walkProps(p, lInfo, curPath, depth + 1);
        }
      }
    }

    for (var j = 0; j < layers.length; j++) {
      if (truncated) break;
      var l = layers[j];
      var lRef = {
        index: l.index,
        id: l.id,
        name: l.name
      };
      walkProps(l, lRef, [], 0);
    }

    return {
      comp_id: c.id,
      comp_name: c.name,
      time: evalTime,
      total_expressions: results.length,
      error_count: errorCount,
      truncated: truncated,
      results: results
    };
  };
})($.global);
