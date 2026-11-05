// fingerprint.jsx: deep bounded composition fingerprinting and safe project reopen.
//
// Approach adapted from Engine-Room-Games/after-effects-mcp
// (reference/engine-room/packages/jsx/snapshot.jsx), MIT License.
//
// Rules (see docs/BUILDERS.md):
// - ES3 only: no let/const/arrows/template strings/classes, no chained ternaries.
// - Read functions must not mutate project/comp state or touch the undo stack.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_STRING = 20000;
  var DEFAULT_MAX_DEPTH = 6;
  var DEFAULT_MAX_PROPS = 5000;
  var FP_PRECISION = 1000000;
  var IS_WIN = String($.os).indexOf("Windows") !== -1;

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

  function fpRound(n) {
    if (typeof n !== "number") return n;
    if (isNaN(n) || !isFinite(n)) return null;
    return Math.round(n * FP_PRECISION) / FP_PRECISION;
  }

  function projectPath() {
    if (!app.project || !app.project.file) return "<unsaved>";
    return app.project.file.fsName;
  }

  function normPath(p) {
    var s = String(p);
    if (s === "<unsaved>") return s;
    s = s.split("\\").join("/");
    if (s.length > 1 && s.charAt(s.length - 1) === "/") {
      s = s.substring(0, s.length - 1);
    }
    if (IS_WIN) s = s.toLowerCase();
    return s;
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
    if (id === undefined || id === null) {
      fail("bad_args", "comp_id is required");
    }
    var c = compById(id);
    if (!c) fail("not_found", "No CompItem with id " + id);
    return c;
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

  function serialiseValue(v) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === "number") return fpRound(v);
    if (t === "boolean") return v;
    if (t === "string") {
      if (v.length > MAX_STRING) {
        return v.substring(0, MAX_STRING) + " ...[truncated]";
      }
      return v;
    }
    if (isArray(v)) {
      var a = [];
      var limit = v.length;
      if (limit > MAX_LIST) limit = MAX_LIST;
      for (var i = 0; i < limit; i++) {
        a.push(serialiseValue(v[i]));
      }
      return a;
    }
    if (v instanceof TextDocument) {
      var td = { text: v.text };
      try { td.font = v.font; } catch (e1) {}
      try { td.fontSize = fpRound(v.fontSize); } catch (e2) {}
      try { td.fillColor = serialiseValue(v.fillColor); } catch (e3) {}
      try { td.strokeColor = serialiseValue(v.strokeColor); } catch (e4) {}
      try { td.tracking = fpRound(v.tracking); } catch (e5) {}
      try { td.leading = fpRound(v.leading); } catch (e6) {}
      try { td.justification = String(v.justification); } catch (e7) {}
      return td;
    }
    try {
      if (v.vertices && v.inTangents && v.outTangents) {
        return {
          closed: Boolean(v.closed),
          vertices: serialiseValue(v.vertices),
          inTangents: serialiseValue(v.inTangents),
          outTangents: serialiseValue(v.outTangents)
        };
      }
    } catch (eShape) {}
    try {
      if (v.comment !== undefined && v.duration !== undefined) {
        return {
          comment: String(v.comment),
          duration: fpRound(v.duration),
          chapter: String(v.chapter || "")
        };
      }
    } catch (eMarker) {}
    try {
      return "[" + v.reflect.name + "]";
    } catch (eRef) {}
    return String(v);
  }

  function fpCompMarkers(c) {
    var out = [];
    var mp = null;
    try {
      mp = c.markerProperty;
    } catch (e1) {
      return out;
    }
    if (!mp) return out;
    var n = 0;
    try {
      n = mp.numKeys;
    } catch (e2) {
      return out;
    }
    var limit = n;
    if (limit > MAX_LIST) limit = MAX_LIST;
    for (var i = 1; i <= limit; i++) {
      try {
        var mv = mp.keyValue(i);
        out.push({
          time: fpRound(mp.keyTime(i)),
          comment: String(mv.comment || ""),
          duration: fpRound(mv.duration)
        });
      } catch (e3) {}
    }
    return out;
  }

  function walkProperty(prop, depth, pathPrefix, state) {
    if (!prop) return null;
    if (state.propCount >= state.maxProps) {
      state.truncated = true;
      return null;
    }

    state.propCount += 1;

    var pName = "";
    var pMatch = "";
    var pIndex = 0;
    try { pName = String(prop.name); } catch (e0) {}
    try { pMatch = String(prop.matchName); } catch (e1) {}
    try { pIndex = prop.propertyIndex; } catch (e2) {}

    var seg = pMatch || pName || String(pIndex);
    var curPath = pathPrefix + "/" + seg;

    var pType = null;
    try {
      pType = prop.propertyType;
    } catch (eType) {
      pType = PropertyType.PROPERTY;
    }

    if (pType === PropertyType.PROPERTY) {
      var leaf = {
        kind: "property",
        name: pName,
        matchName: pMatch,
        propertyIndex: pIndex,
        path: curPath,
        value: null,
        numKeys: 0,
        keyframes: [],
        expression: "",
        expressionEnabled: false
      };

      try {
        leaf.value = serialiseValue(prop.value);
      } catch (eVal) {
        leaf.value = null;
      }

      var nk = 0;
      try {
        if (typeof prop.numKeys === "number") nk = prop.numKeys;
      } catch (eNk) {
        nk = 0;
      }
      leaf.numKeys = nk;

      if (nk > 0) {
        var kLimit = nk;
        if (kLimit > MAX_LIST) {
          kLimit = MAX_LIST;
          leaf.truncated = true;
          state.truncated = true;
        }
        var keys = [];
        for (var k = 1; k <= kLimit; k++) {
          var kt = 0;
          var kv = null;
          try { kt = fpRound(prop.keyTime(k)); } catch (eKt) {}
          try { kv = serialiseValue(prop.keyValue(k)); } catch (eKv) {}
          keys.push({ time: kt, value: kv });
        }
        leaf.keyframes = keys;
      }

      try {
        if (prop.canSetExpression) {
          if (prop.expression) {
            leaf.expression = String(prop.expression);
          }
          leaf.expressionEnabled = Boolean(prop.expressionEnabled);
        }
      } catch (eExpr) {}

      return leaf;
    }

    // Property group (NAMED_GROUP or INDEXED_GROUP)
    var numChildren = 0;
    try {
      if (typeof prop.numProperties === "number") {
        numChildren = prop.numProperties;
      }
    } catch (eNum) {
      numChildren = 0;
    }

    var group = {
      kind: "group",
      name: pName,
      matchName: pMatch,
      propertyIndex: pIndex,
      path: curPath,
      numProperties: numChildren,
      properties: []
    };

    if (numChildren === 0) {
      return group;
    }

    if (depth >= state.maxDepth) {
      group.truncated = true;
      state.truncated = true;
      return group;
    }

    var childLimit = numChildren;
    if (childLimit > MAX_LIST) {
      childLimit = MAX_LIST;
      group.truncated = true;
      state.truncated = true;
    }

    for (var i = 1; i <= childLimit; i++) {
      if (state.propCount >= state.maxProps) {
        group.truncated = true;
        state.truncated = true;
        break;
      }
      var child = null;
      try {
        child = prop.property(i);
      } catch (eChild) {
        child = null;
      }
      if (child) {
        var desc = walkProperty(child, depth + 1, curPath, state);
        if (desc) {
          group.properties.push(desc);
        }
      }
    }

    return group;
  }

  function fpLayer(l, state) {
    var lType = "Layer";
    if (l.reflect && l.reflect.name) {
      lType = String(l.reflect.name);
    }

    var out = {
      index: l.index,
      id: l.id,
      name: l.name,
      type: lType,
      inPoint: fpRound(l.inPoint),
      outPoint: fpRound(l.outPoint),
      startTime: fpRound(l.startTime),
      enabled: Boolean(l.enabled),
      locked: Boolean(l.locked),
      label: l.label,
      parent: null,
      parentId: null,
      solo: false,
      threeDLayer: false,
      blendingMode: null,
      trackMatteType: null,
      sourceId: null,
      properties: []
    };

    try {
      if (l.parent) {
        out.parent = l.parent.index;
        out.parentId = l.parent.id;
      }
    } catch (e1) {}
    try { out.solo = Boolean(l.solo); } catch (e2) {}
    try { out.threeDLayer = Boolean(l.threeDLayer); } catch (e3) {}
    try { out.blendingMode = String(l.blendingMode); } catch (e4) {}
    try { out.trackMatteType = String(l.trackMatteType); } catch (e5) {}
    try {
      if (l.source) out.sourceId = l.source.id;
    } catch (e6) {}

    var topCount = 0;
    try {
      if (typeof l.numProperties === "number") topCount = l.numProperties;
    } catch (e7) {
      topCount = 0;
    }

    var topLimit = topCount;
    if (topLimit > MAX_LIST) {
      topLimit = MAX_LIST;
      out.truncated = true;
      state.truncated = true;
    }

    var layerPrefix = "layer[" + l.id + "]";
    for (var i = 1; i <= topLimit; i++) {
      if (state.propCount >= state.maxProps) {
        out.truncated = true;
        state.truncated = true;
        break;
      }
      var topProp = null;
      try {
        topProp = l.property(i);
      } catch (eProp) {
        topProp = null;
      }
      if (topProp) {
        var walked = walkProperty(topProp, 1, layerPrefix, state);
        if (walked) {
          out.properties.push(walked);
        }
      }
    }

    return out;
  }

  // The comp-level switches ae_comp_settings writes, so ae_comp_diff sees a
  // change to them. An attribute an AE build lacks is left out.
  var COMP_SWITCHES = [
    "motionBlur", "shutterAngle", "shutterPhase", "motionBlurSamplesPerFrame", "motionBlurAdaptiveSampleLimit",
    "frameBlending", "renderer", "draft3d", "resolutionFactor", "hideShyLayers",
    "preserveNestedFrameRate", "preserveNestedResolution", "displayStartTime", "displayStartFrame", "dropFrame"
  ];

  // Guide orientation and position type as stable words. The raw integers differ
  // between AE versions (26.5 renumbered them), so they are mapped through the
  // enum constants when the build has them; without the enum the legacy meaning
  // (0 horizontal / 1 vertical, 0 pixel / 1 percentage) applies. A value that maps
  // to nothing falls back to the raw number under the old key.
  function fpEnumValues(typeName, memberNames) {
    var E = null;
    try {
      if (typeName === "GuideOrientationType") {
        if (typeof GuideOrientationType !== "undefined") E = GuideOrientationType;
      } else if (typeName === "GuidePositionType") {
        if (typeof GuidePositionType !== "undefined") E = GuidePositionType;
      }
    } catch (e0) { E = null; }
    if (E === null || E === undefined) {
      try { E = $.global[typeName]; } catch (e1) { E = null; }
    }
    if (E === null || E === undefined) return null;
    var out = [];
    for (var i = 0; i < memberNames.length; i++) {
      var v = null;
      try { v = E[memberNames[i]]; } catch (e2) { v = null; }
      if (typeof v === "number") out.push(v);
      else out.push(null);
    }
    return out;
  }

  function fpGuideOrientation(raw) {
    if (typeof raw !== "number") return null;
    var en = fpEnumValues("GuideOrientationType", ["HORIZONTAL", "VERTICAL"]);
    if (en) {
      if (en[0] !== null && raw === en[0]) return "horizontal";
      if (en[1] !== null && raw === en[1]) return "vertical";
      return null;
    }
    if (raw === 0) return "horizontal";
    if (raw === 1) return "vertical";
    return null;
  }

  function fpGuidePositionKind(raw) {
    if (typeof raw !== "number") return null;
    var en = fpEnumValues("GuidePositionType", ["PIXEL", "PERCENTAGE", "PERCENT"]);
    if (en) {
      if (en[0] !== null && raw === en[0]) return "pixel";
      if ((en[1] !== null && raw === en[1]) || (en[2] !== null && raw === en[2])) return "percentage";
      return null;
    }
    if (raw === 0) return "pixel";
    if (raw === 1) return "percentage";
    return null;
  }

  function fpGuide(c, list, i) {
    var g = null;
    if (typeof c.getGuideAsObject === "function") {
      try { g = c.getGuideAsObject(i); } catch (e0) { g = null; }
    }
    if (g === null || g === undefined || typeof g !== "object") g = list[i];
    var oRaw;
    var pRaw;
    try { oRaw = g.orientationType; if (oRaw === undefined) oRaw = g.orientation; } catch (e1) { oRaw = undefined; }
    try { pRaw = g.positionType; } catch (e2) { pRaw = undefined; }
    var entry = {};
    var oName = fpGuideOrientation(oRaw);
    if (oName !== null) entry.orientation = oName;
    else if (oRaw !== undefined) entry.orientationType = serialiseValue(oRaw);
    try { entry.position = serialiseValue(g.position); } catch (e3) {}
    var pName = fpGuidePositionKind(pRaw);
    if (pName !== null) entry.position_kind = pName;
    return entry;
  }

  function fpCompSwitches(c, out) {
    for (var i = 0; i < COMP_SWITCHES.length; i++) {
      try {
        var v = c[COMP_SWITCHES[i]];
        if (v !== undefined && v !== null) out[COMP_SWITCHES[i]] = serialiseValue(v);
      } catch (e) {}
    }
    // Item guides: orientation, position and position type of each, bounded.
    try {
      var gl = c.guides;
      if (gl && typeof gl.length === "number" && gl.length > 0) {
        var guides = [];
        if (gl.length > MAX_LIST) out.guides_truncated = true;
        for (var g = 0; g < gl.length && g < MAX_LIST; g++) {
          guides.push(fpGuide(c, gl, g));
        }
        out.guides = guides;
      }
    } catch (eG) {}
  }

  A.compFingerprint = function (args) {
    var compId = null;
    if (args && args.comp_id !== undefined) {
      compId = args.comp_id;
    }
    var c = requireComp(compId);

    var maxDepth = DEFAULT_MAX_DEPTH;
    if (args && typeof args.max_depth === "number" && args.max_depth > 0) {
      maxDepth = args.max_depth;
    }
    var maxProps = DEFAULT_MAX_PROPS;
    if (args && typeof args.max_props === "number" && args.max_props > 0) {
      maxProps = args.max_props;
    }

    var state = {
      propCount: 0,
      maxDepth: maxDepth,
      maxProps: maxProps,
      truncated: false
    };

    var layers = [];
    var nLayers = c.numLayers;
    if (nLayers > MAX_LIST) {
      nLayers = MAX_LIST;
      state.truncated = true;
    }

    for (var i = 1; i <= nLayers; i++) {
      layers.push(fpLayer(c.layer(i), state));
    }

    var result = {
      comp_id: c.id,
      name: c.name,
      width: c.width,
      height: c.height,
      pixelAspect: fpRound(c.pixelAspect),
      fps: fpRound(c.frameRate),
      duration: fpRound(c.duration),
      workAreaStart: fpRound(c.workAreaStart),
      workAreaDuration: fpRound(c.workAreaDuration),
      bgColor: serialiseValue(c.bgColor),
      numLayers: c.numLayers,
      markers: fpCompMarkers(c),
      propertyCount: state.propCount,
      truncated: state.truncated,
      layers: layers
    };
    fpCompSwitches(c, result);
    return result;
  };

  A.openProject = function (args) {
    if (!args || !args.path) {
      fail("bad_args", "openProject requires path");
    }
    if (args.expect) {
      assertGuard(args.expect);
    }

    var targetFile = new File(args.path);
    if (!targetFile.exists) {
      fail("not_found", "Project file does not exist: " + String(args.path));
    }

    var isDirty = false;
    try {
      if (app.project && app.project.dirty) {
        isDirty = true;
      }
    } catch (eDirty) {}

    var allowDiscard = false;
    if (args.discard_changes === true) {
      allowDiscard = true;
    }

    if (isDirty && !allowDiscard) {
      fail(
        "guard",
        "Refusing to close dirty project without discard_changes: true.",
        {
          expected: { dirty: false, discard_changes: true },
          actual: { project_path: projectPath(), dirty: true }
        }
      );
    }

    if (app.project) {
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    }

    app.open(targetFile);

    var newDirty = false;
    try {
      if (app.project && app.project.dirty) {
        newDirty = true;
      }
    } catch (eAfter) {}

    return {
      project_path: projectPath(),
      dirty: newDirty
    };
  };
})($.global);
