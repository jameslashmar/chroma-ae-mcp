// panel/host/ext/compsettings.jsx
//
// Host functions for the comp settings tools:
// - compsettingsRead (read): the comp-level switches no other tool reaches:
//   motion blur (shutter angle, phase, samples, adaptive limit), frame
//   blending, renderer (and the installed renderers), draft 3D, resolution
//   factor, background colour, shy, preserve nested frame rate / resolution,
//   display start, work area, and the comp's guides
// - compsettingsApply (guarded write): sets any of them, and adds, moves or
//   removes guides, in one undo group. Also the Composition Settings dialog
//   edits: name, resize around an anchor (top-level layers, their keys and the
//   pixel guides move with it), pixel aspect, frame rate, drop frame, length
//   (optionally extending the layers that ran to the old end) and trim to the
//   work area. On AE 26.5+ guides take colour, pinned and a percentage position.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - The write checks the target guard first and validates every value (type,
//   range, renderer, work area, guide indexes) before A.withUndo opens.
// - Reads change nothing: no time, selection, resolution or active item.
// - The read after a write runs in a separate evalScript from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_GUIDES = 500;

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

  function isList(v) {
    return v !== null && v !== undefined && typeof v === "object" && typeof v.length === "number";
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function isInt(v) {
    return isNum(v) && Math.floor(v) === v;
  }

  function given(v) {
    return v !== undefined && v !== null;
  }

  // The comp attributes that are one number or switch each. `key` is the name
  // used in tool arguments and in the read; `prop` is the CompItem attribute.
  // Ranges are from the AE Scripting Guide.
  var SCALARS = [
    { key: "motion_blur", prop: "motionBlur", type: "bool" },
    { key: "shutter_angle", prop: "shutterAngle", type: "int", min: 0, max: 720 },
    { key: "shutter_phase", prop: "shutterPhase", type: "int", min: -360, max: 360 },
    { key: "motion_blur_samples", prop: "motionBlurSamplesPerFrame", type: "int", min: 2, max: 64 },
    { key: "motion_blur_adaptive_limit", prop: "motionBlurAdaptiveSampleLimit", type: "int", min: 16, max: 256 },
    { key: "frame_blending", prop: "frameBlending", type: "bool" },
    { key: "draft_3d", prop: "draft3d", type: "bool" },
    { key: "hide_shy_layers", prop: "hideShyLayers", type: "bool" },
    { key: "preserve_nested_frame_rate", prop: "preserveNestedFrameRate", type: "bool" },
    { key: "preserve_nested_resolution", prop: "preserveNestedResolution", type: "bool" },
    { key: "display_start_time", prop: "displayStartTime", type: "num", min: -10800, max: 86339 },
    { key: "display_start_frame", prop: "displayStartFrame", type: "int" }
  ];

  var KNOWN_KEYS = {
    renderer: 1, resolution_factor: 1, background_color: 1, work_area: 1,
    name: 1, size: 1, pixel_aspect: 1, frame_rate: 1, duration: 1, drop_frame: 1, trim_to_work_area: 1
  };
  var MAX_LAYER_STATE = 500;
  var MAX_REPORT = 500;
  var MAX_SCAN_PROPS = 50000;
  var ANCHORS = {
    center: [0.5, 0.5], top_left: [0, 0], top: [0.5, 0], top_right: [1, 0], left: [0, 0.5],
    right: [1, 0.5], bottom_left: [0, 1], bottom: [0.5, 1], bottom_right: [1, 1]
  };
  var si;
  for (si = 0; si < SCALARS.length; si++) KNOWN_KEYS[SCALARS[si].key] = 1;

  function rounded(n) {
    return Math.round(n * 1000000) / 1000000;
  }

  // ---------- guides ----------

  // The 16.1 API takes 0 for a horizontal guide and 1 for a vertical one; AE
  // 26.5 documents that these integers may differ between versions. On 26.5+
  // use an orientation enum constant when the DOM exposes one; otherwise keep
  // 0/1 and flag the result as unverified.
  function aeAtLeast(major, minor) {
    var v = "";
    try { v = String(app.version); } catch (e) { return false; }
    var m = /^(\d+)\.(\d+)/.exec(v);
    if (!m) return false;
    var ma = parseInt(m[1], 10);
    var mi = parseInt(m[2], 10);
    if (ma !== major) return ma > major;
    return mi >= minor;
  }

  function orientationEnumValue(name) {
    var E = null;
    try {
      if (typeof GuideOrientationType !== "undefined") E = GuideOrientationType;
    } catch (e1) { E = null; }
    if (!E) return null;
    var v = null;
    try {
      if (name === "horizontal") v = E.HORIZONTAL;
      else v = E.VERTICAL;
    } catch (e2) { v = null; }
    if (typeof v === "number") return v;
    return null;
  }

  // Returns { value, unverified }.
  function guideOrientation(name) {
    if (name !== "horizontal" && name !== "vertical") {
      fail("bad_args", "Unknown guide orientation \"" + name + "\" (horizontal or vertical)");
    }
    var legacy = 0;
    if (name === "vertical") legacy = 1;
    if (aeAtLeast(26, 5)) {
      var e = orientationEnumValue(name);
      if (e !== null) return { value: e, unverified: false };
      return { value: legacy, unverified: true };
    }
    return { value: legacy, unverified: false };
  }

  // The 26.5 enums (GuideOrientationType, GuidePositionType) number their members
  // differently from earlier builds, so a raw integer is read through the enum
  // when it exists. Without the enum the legacy meaning applies: orientation
  // 0 horizontal / 1 vertical, position type 0 pixel / 1 percentage.
  // The enum is looked up as a bare identifier, the way the write side does, and
  // then as a member of the global object.
  function enumObject(typeName) {
    var E = null;
    try {
      if (typeName === "GuideOrientationType") {
        if (typeof GuideOrientationType !== "undefined") E = GuideOrientationType;
      } else if (typeName === "GuidePositionType") {
        if (typeof GuidePositionType !== "undefined") E = GuidePositionType;
      }
    } catch (e0) { E = null; }
    if (E === null || E === undefined) {
      try { E = G[typeName]; } catch (e1) { E = null; }
    }
    return E;
  }

  function enumMember(typeName, memberNames) {
    var E = enumObject(typeName);
    if (E === null || E === undefined) return { exists: false, values: [] };
    var out = [];
    for (var i = 0; i < memberNames.length; i++) {
      var v = null;
      try { v = E[memberNames[i]]; } catch (e2) { v = null; }
      if (typeof v === "number") out.push(v);
      else out.push(null);
    }
    return { exists: true, values: out };
  }

  function orientationName(raw) {
    if (typeof raw === "string") {
      var low = raw.toLowerCase();
      if (low === "horizontal" || low === "vertical") return low;
      return null;
    }
    if (!isNum(raw)) return null;
    var en = enumMember("GuideOrientationType", ["HORIZONTAL", "VERTICAL"]);
    if (en.exists) {
      if (en.values[0] !== null && raw === en.values[0]) return "horizontal";
      if (en.values[1] !== null && raw === en.values[1]) return "vertical";
      return null;
    }
    if (raw === 0) return "horizontal";
    if (raw === 1) return "vertical";
    return null;
  }

  function positionKindName(raw) {
    if (typeof raw === "string") {
      var low = raw.toLowerCase();
      if (low === "pixel" || low === "pixels") return "pixel";
      if (low === "percentage" || low === "percent") return "percentage";
      return null;
    }
    if (!isNum(raw)) return null;
    var en = enumMember("GuidePositionType", ["PIXEL", "PERCENTAGE", "PERCENT"]);
    if (en.exists) {
      if (en.values[0] !== null && raw === en.values[0]) return "pixel";
      if ((en.values[1] !== null && raw === en.values[1]) || (en.values[2] !== null && raw === en.values[2])) return "percentage";
      return null;
    }
    if (raw === 0) return "pixel";
    if (raw === 1) return "percentage";
    return null;
  }

  function positionKindValue(kind) {
    var en = enumMember("GuidePositionType", ["PIXEL", "PERCENTAGE", "PERCENT"]);
    if (!en.exists) return null;
    if (kind === "pixel") return en.values[0];
    if (en.values[1] !== null) return en.values[1];
    return en.values[2];
  }

  // The guide as an object: getGuideAsObject (26.5) when the build has it.
  function guideSource(comp, list, i) {
    var o = null;
    if (typeof comp.getGuideAsObject === "function") {
      try { o = comp.getGuideAsObject(i); } catch (e1) { o = null; }
    }
    if (o === null || o === undefined || typeof o !== "object") o = list[i];
    return o;
  }

  function guideEntry(g, index) {
    var out = { index: index };
    var oRaw;
    var pRaw;
    try { oRaw = g.orientationType; if (oRaw === undefined) oRaw = g.orientation; } catch (e0) { oRaw = undefined; }
    try { pRaw = g.positionType; } catch (e00) { pRaw = undefined; }
    if (isNum(oRaw)) out.orientation_type = oRaw;
    if (isNum(pRaw)) out.position_type = pRaw;
    var oName = orientationName(oRaw);
    var pName = positionKindName(pRaw);
    if (oName !== null) out.orientation = oName;
    if (pName !== null) out.position_kind = pName;
    try { if (isNum(g.position)) out.position = rounded(g.position); } catch (e3) {}
    // AE 26.5 adds colour and pinned to each guide.
    try { if (g.pinned !== undefined) out.pinned = g.pinned === true; } catch (e4) {}
    try { if (isList(g.color)) out.color = [g.color[0], g.color[1], g.color[2]]; } catch (e5) {}
    return out;
  }

  function readGuides(comp) {
    var out = { guides: [], count: 0, truncated: false, readable: true };
    var list = null;
    try {
      list = comp.guides;
    } catch (e) {
      list = null;
    }
    if (!isList(list)) {
      out.readable = false;
      return out;
    }
    out.count = list.length;
    var n = list.length;
    if (n > MAX_GUIDES) {
      n = MAX_GUIDES;
      out.truncated = true;
    }
    // Guides are 0-based in AE (removeGuide(0) is the first).
    for (var i = 0; i < n; i++) out.guides.push(guideEntry(guideSource(comp, list, i), i));
    return out;
  }

  // ---------- read ----------

  function readScalar(comp, def, out, unreadable) {
    var v;
    try {
      v = comp[def.prop];
    } catch (e) {
      unreadable.push(def.key);
      return;
    }
    if (v === undefined || v === null) {
      unreadable.push(def.key);
      return;
    }
    if (def.type === "bool") out[def.key] = v === true;
    else out[def.key] = rounded(v);
  }

  function readSettings(comp) {
    var out = {
      comp_id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      fps: comp.frameRate,
      frame_duration: comp.frameDuration,
      duration: comp.duration
    };
    var unreadable = [];
    for (var i = 0; i < SCALARS.length; i++) readScalar(comp, SCALARS[i], out, unreadable);
    try {
      if (isNum(comp.pixelAspect)) out.pixel_aspect = rounded(comp.pixelAspect);
      else unreadable.push("pixel_aspect");
    } catch (ePa) { unreadable.push("pixel_aspect"); }
    try {
      if (typeof comp.dropFrame === "boolean") out.drop_frame = comp.dropFrame;
      else unreadable.push("drop_frame");
    } catch (eDf) { unreadable.push("drop_frame"); }
    try {
      if (typeof comp.renderer === "string") out.renderer = comp.renderer;
      else unreadable.push("renderer");
    } catch (e1) { unreadable.push("renderer"); }
    try {
      var rs = comp.renderers;
      if (isList(rs)) {
        var names = [];
        for (var r = 0; r < rs.length && r < 50; r++) names.push(String(rs[r]));
        out.renderers = names;
      }
    } catch (e2) {}
    try {
      var rf = comp.resolutionFactor;
      if (isList(rf) && rf.length >= 2) out.resolution_factor = [rf[0], rf[1]];
      else unreadable.push("resolution_factor");
    } catch (e3) { unreadable.push("resolution_factor"); }
    try {
      var bg = comp.bgColor;
      if (isList(bg) && bg.length >= 3) out.background_color = [rounded(bg[0]), rounded(bg[1]), rounded(bg[2])];
      else unreadable.push("background_color");
    } catch (e4) { unreadable.push("background_color"); }
    try {
      out.work_area = { start: rounded(comp.workAreaStart), duration: rounded(comp.workAreaDuration) };
    } catch (e5) { unreadable.push("work_area"); }
    var gd = readGuides(comp);
    out.guides = gd.guides;
    out.guide_count = gd.count;
    if (gd.truncated) out.guides_truncated = true;
    if (!gd.readable) unreadable.push("guides");
    if (unreadable.length > 0) out.unreadable = unreadable;
    try { out.ae_version = String(app.version); } catch (e6) {}
    return out;
  }

  // ---------- layer helpers (resize, extend, trim) ----------

  function transformGroup(l) {
    var tr = null;
    try { tr = l.property("ADBE Transform Group"); } catch (e) { tr = null; }
    return tr;
  }

  function subProp(group, matchName) {
    var p = null;
    if (!group) return null;
    try { p = group.property(matchName); } catch (e) { p = null; }
    if (p === undefined) return null;
    return p;
  }

  function hasExpression(p) {
    try { return p.expressionEnabled === true; } catch (e) { return false; }
  }

  function isSeparated(pos) {
    try { return pos.dimensionsSeparated === true; } catch (e) { return false; }
  }

  function layerMatchName(l) {
    var m = "";
    try { m = String(l.matchName); } catch (e) { m = ""; }
    return m;
  }

  function layerName(l) {
    var n = "";
    try { n = String(l.name); } catch (e) { n = ""; }
    return n;
  }

  // The layer's x/y Position at its first key (or its static value), for the read-back.
  function sampleOne(p) {
    var n = 0;
    try { n = p.numKeys; } catch (e1) { n = 0; }
    var v;
    try {
      if (n > 0) {
        v = p.keyValue(1);
      } else {
        // The value before any expression: a layer driven by an expression is not moved by the resize.
        v = undefined;
        try { v = p.valueAtTime(0, true); } catch (e3) { v = undefined; }
        if (v === undefined || v === null) v = p.value;
      }
    } catch (e2) { return null; }
    return v;
  }

  function positionSample(l) {
    var tr = transformGroup(l);
    var pos = subProp(tr, "ADBE Position");
    if (!pos) return null;
    var v;
    if (isSeparated(pos)) {
      var px = subProp(tr, "ADBE Position_0");
      var py = subProp(tr, "ADBE Position_1");
      if (!px || !py) return null;
      var vx = sampleOne(px);
      var vy = sampleOne(py);
      if (!isNum(vx) || !isNum(vy)) return null;
      return [rounded(vx), rounded(vy)];
    }
    v = sampleOne(pos);
    if (!isList(v) || v.length < 2) return null;
    return [rounded(v[0]), rounded(v[1])];
  }

  function readLayerState(comp) {
    var out = { states: [], truncated: false };
    var n = comp.numLayers;
    if (n > MAX_LAYER_STATE) {
      n = MAX_LAYER_STATE;
      out.truncated = true;
    }
    for (var i = 1; i <= n; i++) {
      var l = comp.layer(i);
      var e = { id: l.id, index: i };
      try { e["in"] = rounded(l.inPoint); } catch (e1) {}
      try { e.out = rounded(l.outPoint); } catch (e2) {}
      try { e.start = rounded(l.startTime); } catch (e3) {}
      var ps = positionSample(l);
      if (ps !== null) e.position = ps;
      out.states.push(e);
    }
    return out;
  }

  A.compsettingsRead = function (args) {
    var comp = requireComp(args.comp_id);
    var out = readSettings(comp);
    if (args.layer_state === true) {
      var ls = readLayerState(comp);
      out.layer_state = ls.states;
      if (ls.truncated) out.layer_state_truncated = true;
    }
    return out;
  };

  // ---------- write: validation ----------

  function checkScalar(def, v) {
    if (def.type === "bool") {
      if (typeof v !== "boolean") fail("bad_args", def.key + " must be true or false");
      return;
    }
    if (def.type === "int") {
      if (!isInt(v)) fail("bad_args", def.key + " must be an integer");
    } else if (!isNum(v)) {
      fail("bad_args", def.key + " must be a number");
    }
    if (def.min !== undefined && v < def.min) fail("bad_args", def.key + " must be at least " + def.min);
    if (def.max !== undefined && v > def.max) fail("bad_args", def.key + " must be at most " + def.max);
  }

  function hasProp(comp, prop) {
    try {
      return comp[prop] !== undefined && comp[prop] !== null;
    } catch (e) {
      return false;
    }
  }

  // The work area to write, after clamping a float-rounding overshoot. Fails
  // for anything AE would throw on in the middle of the undo group.
  function planWorkArea(comp, wa, endLimit, base) {
    if (typeof wa !== "object" || wa === null) fail("bad_args", "work_area must be { start, duration }");
    var start = comp.workAreaStart;
    var duration = comp.workAreaDuration;
    if (base) {
      start = base.start;
      duration = base.duration;
    }
    if (given(wa.start)) {
      if (!isNum(wa.start) || wa.start < 0) fail("bad_args", "work_area.start must be a number of seconds, 0 or more");
      start = wa.start;
    }
    if (given(wa.duration)) {
      if (!isNum(wa.duration) || wa.duration <= 0) fail("bad_args", "work_area.duration must be a positive number of seconds");
      duration = wa.duration;
    }
    if (!given(wa.start) && !given(wa.duration)) fail("bad_args", "work_area needs start or duration");
    var frame = comp.frameDuration;
    if (duration < frame * 0.99) fail("bad_args", "work_area.duration is shorter than one frame (" + rounded(frame) + "s)");
    if (start + duration > endLimit + frame * 0.01) {
      fail(
        "bad_args",
        "The work area would end at " + rounded(start + duration) + "s, past the comp's length of " + rounded(endLimit) + "s"
      );
    }
    if (start + duration > endLimit) duration = endLimit - start;
    return { start: start, duration: duration };
  }

  // Colour, pinned and a percentage position exist from AE 26.5 and are written
  // with a GuideOptions object only. Anything below that is refused here, before
  // the undo group, with the reason.
  function planGuideExtras(op, step, where) {
    var wantsColor = given(op.color);
    var wantsPinned = given(op.pinned);
    var wantsKind = given(op.position_type);
    if (!wantsColor && !wantsPinned && !wantsKind) return;
    var ver = "";
    try { ver = String(app.version); } catch (e0) { ver = "unknown"; }
    if (!aeAtLeast(26, 5)) {
      fail("bad_args", where + ": guide colour, pinned and a percentage position need After Effects 26.5 or later (this is " + ver + ")");
    }
    var haveOptions = false;
    try { haveOptions = typeof GuideOptions !== "undefined"; } catch (e1) { haveOptions = false; }
    if (!haveOptions) fail("bad_args", where + ": this build has no GuideOptions, so guide colour, pinned and position type can't be written");
    if (wantsColor) {
      var c = op.color;
      if (!isList(c) || c.length !== 3) fail("bad_args", where + ".color must be [r, g, b]");
      for (var i = 0; i < 3; i++) {
        if (!isNum(c[i]) || c[i] < 0 || c[i] > 1) fail("bad_args", where + ".color values must be numbers in 0..1");
      }
      step.color = [c[0], c[1], c[2]];
    }
    if (wantsPinned) {
      if (typeof op.pinned !== "boolean") fail("bad_args", where + ".pinned must be true or false");
      step.pinned = op.pinned;
    }
    if (wantsKind) {
      if (op.position_type !== "pixel" && op.position_type !== "percentage") fail("bad_args", where + ".position_type must be pixel or percentage");
      var kv = positionKindValue(op.position_type);
      if (kv === null) fail("bad_args", where + ": this build has no GuidePositionType, so the position type can't be written");
      step.position_kind = op.position_type;
      step.position_type_value = kv;
    }
    step.options_only = true;
  }

  // Walks the guide operations against the current count, so an index that
  // AE would reject (or one that shifted after a remove) is caught here.
  // What a guide holds now, as the build itself reports it (raw orientation and
  // position type, colour, pinned), so a set can give every field explicitly.
  function guideKeep(g) {
    var keep = {};
    var o;
    var p;
    try { o = g.orientationType; if (o === undefined) o = g.orientation; } catch (e0) { o = undefined; }
    try { p = g.positionType; } catch (e1) { p = undefined; }
    if (o !== undefined && o !== null) keep.orientation = o;
    if (p !== undefined && p !== null) keep.position_type = p;
    try { if (isList(g.color)) keep.color = [g.color[0], g.color[1], g.color[2]]; } catch (e2) {}
    try { if (g.pinned !== undefined) keep.pinned = g.pinned === true; } catch (e3) {}
    return keep;
  }

  function planGuides(comp, ops) {
    var plan = [];
    var count = 0;
    var list = null;
    try { list = comp.guides; } catch (e) { list = null; }
    if (isList(list)) count = list.length;
    else if (ops.length > 0) fail("bad_args", "This AE build does not expose Item.guides (16.1+)");
    // The guides as the later steps will find them (adds and removes shift the indexes).
    var sim = [];
    var si2;
    for (si2 = 0; si2 < count; si2++) sim.push(guideKeep(guideSource(comp, list, si2)));
    plan.unverified = false;
    var needAdd = false;
    var needSet = false;
    var needRemove = false;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (typeof op !== "object" || op === null) fail("bad_args", "guides[" + i + "] must be an object");
      var where = "guides[" + i + "]";
      if (op.action === "add") {
        if (!isNum(op.position) || Math.abs(op.position) > 100000) fail("bad_args", where + ".position must be a number within +-100000 px");
        var ori = guideOrientation(op.orientation);
        if (ori.unverified) plan.unverified = true;
        var addStep = { action: "add", orientation_type: ori.value, orientation: op.orientation, position: op.position };
        planGuideExtras(op, addStep, where);
        plan.push(addStep);
        var added = { orientation: addStep.orientation_type };
        if (addStep.position_type_value !== undefined) added.position_type = addStep.position_type_value;
        if (addStep.color !== undefined) added.color = addStep.color;
        if (addStep.pinned !== undefined) added.pinned = addStep.pinned;
        sim.push(added);
        needAdd = true;
        count++;
      } else if (op.action === "set") {
        if (!isInt(op.index) || op.index < 0 || op.index >= count) fail("bad_args", where + ".index must be 0.." + (count - 1) + " (the guide count at that step is " + count + ")");
        if (!isNum(op.position) || Math.abs(op.position) > 100000) fail("bad_args", where + ".position must be a number within +-100000 px");
        var setStep = { action: "set", index: op.index, position: op.position };
        planGuideExtras(op, setStep, where);
        // Every field a set leaves out is given as it is now, so the build can't fall back to a default.
        var cur = sim[op.index];
        setStep.keep = {};
        if (cur) {
          if (cur.orientation !== undefined) setStep.keep.orientation = cur.orientation;
          if (cur.position_type !== undefined) setStep.keep.position_type = cur.position_type;
          if (cur.color !== undefined) setStep.keep.color = cur.color;
          if (cur.pinned !== undefined) setStep.keep.pinned = cur.pinned;
          if (setStep.position_type_value !== undefined) cur.position_type = setStep.position_type_value;
          if (setStep.color !== undefined) cur.color = setStep.color;
          if (setStep.pinned !== undefined) cur.pinned = setStep.pinned;
        }
        plan.push(setStep);
        needSet = true;
      } else if (op.action === "remove") {
        if (given(op.color) || given(op.pinned) || given(op.position_type)) fail("bad_args", where + ": remove takes only an index");
        if (!isInt(op.index) || op.index < 0 || op.index >= count) fail("bad_args", where + ".index must be 0.." + (count - 1) + " (the guide count at that step is " + count + ")");
        plan.push({ action: "remove", index: op.index });
        sim.splice(op.index, 1);
        needRemove = true;
        count--;
      } else {
        fail("bad_args", where + ".action must be add, set or remove");
      }
    }
    // Fail early when the build lacks a guide method the batch needs.
    if (needAdd && typeof comp.addGuide !== "function") fail("bad_args", "This AE build has no addGuide method");
    if (needSet && typeof comp.setGuide !== "function") fail("bad_args", "This AE build has no setGuide method");
    if (needRemove && typeof comp.removeGuide !== "function") fail("bad_args", "This AE build has no removeGuide method");
    return plan;
  }

  // ---------- dialog edits: name, size, pixel aspect, frame rate, length, trim ----------

  var DROP_RATES = [29.97, 59.94];

  function isDropFrameRate(rate) {
    for (var i = 0; i < DROP_RATES.length; i++) {
      if (Math.abs(rate - DROP_RATES[i]) < 0.005) return true;
    }
    return false;
  }

  function keysOf(obj) {
    var out = [];
    var k;
    for (k in obj) {
      if (obj.hasOwnProperty(k)) out.push(k);
    }
    return out;
  }

  function skippedEntry(l, index, reason) {
    return { id: l.id, index: index, name: layerName(l), reason: reason };
  }

  // Runs fn with the layer unlocked, and locks it again whatever happens (same undo group).
  function runUnlocked(layer, fn) {
    var was = false;
    try { was = layer.locked === true; } catch (e0) { was = false; }
    if (was) layer.locked = false;
    try {
      fn();
    } finally {
      if (was) {
        try { layer.locked = true; } catch (eRelock) {}
      }
    }
  }

  function shiftedValue(v, dx, dy) {
    var o = [];
    for (var i = 0; i < v.length; i++) o.push(v[i]);
    o[0] = o[0] + dx;
    if (o.length > 1) o[1] = o[1] + dy;
    return o;
  }

  // Shifts a Position (or Point of Interest) by dx/dy, every key included.
  function shiftJoint(prop, dx, dy) {
    var n = prop.numKeys;
    var k;
    if (n > 0) {
      for (k = 1; k <= n; k++) prop.setValueAtKey(k, shiftedValue(prop.keyValue(k), dx, dy));
    } else {
      prop.setValue(shiftedValue(prop.value, dx, dy));
    }
  }

  function shiftScalar(prop, d) {
    var n = prop.numKeys;
    var k;
    if (n > 0) {
      for (k = 1; k <= n; k++) prop.setValueAtKey(k, prop.keyValue(k) + d);
    } else {
      prop.setValue(prop.value + d);
    }
  }

  // "ambient", "point", "spot", "parallel", or "" when the build can't say.
  function lightKind(l) {
    var t;
    try { t = l.lightType; } catch (e0) { return ""; }
    try {
      if (typeof LightType === "undefined") return "";
      if (t === LightType.AMBIENT) return "ambient";
      if (t === LightType.POINT) return "point";
      if (t === LightType.SPOT) return "spot";
      if (t === LightType.PARALLEL) return "parallel";
    } catch (e1) {}
    return "";
  }

  // A one-node camera or light hides Point of Interest, and so does a point or ambient
  // light, and AE refuses to set a hidden property. Only a layer that is known to be
  // one-node is left out; a build that can't say keeps the earlier behaviour.
  function hasPointOfInterest(l, kind) {
    if (kind === "ADBE Light Layer") {
      var lk = lightKind(l);
      if (lk === "point" || lk === "ambient") return false;
    }
    var ao;
    try {
      if (typeof AutoOrientType === "undefined") return true;
      ao = l.autoOrient;
    } catch (e0) { return true; }
    if (ao === undefined || ao === null) return true;
    try {
      return ao === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
    } catch (e1) { return true; }
  }

  // Which top-level layers an anchored resize moves, and what stops it moving one.
  // A scripted width/height change leaves every layer at the same pixel position
  // from the top-left (measured on AE 26 for ae_reframe); the shift makes up the
  // difference for the chosen anchor. Parented layers follow their parents.
  function planResize(comp, size) {
    var plan = { steps: [], skipped: [], parented: 0 };
    if (size.dx === 0 && size.dy === 0) return plan;
    var n = comp.numLayers;
    var i;
    var l;
    var par;
    var tr;
    var pos;
    var kind;
    var poi;
    var step;
    var px;
    var py;
    var hasVid;
    for (i = 1; i <= n; i++) {
      l = comp.layer(i);
      par = null;
      try { par = l.parent; } catch (eP) { par = null; }
      if (par) {
        plan.parented++;
        continue;
      }
      // An audio-only layer's Transform group is hidden: AE throws on any write to it.
      // Cameras and lights keep their Transform whatever hasVideo says, so they are exempt.
      hasVid = true;
      try { if (l.hasVideo === false) hasVid = false; } catch (eHv) { hasVid = true; }
      kind = layerMatchName(l);
      if (!hasVid && kind !== "ADBE Camera Layer" && kind !== "ADBE Light Layer") {
        plan.skipped.push(skippedEntry(l, i, "an audio-only layer has no visible Position"));
        continue;
      }
      tr = transformGroup(l);
      pos = subProp(tr, "ADBE Position");
      if (!pos) {
        plan.skipped.push(skippedEntry(l, i, "no Position property"));
        continue;
      }
      step = { index: i, id: l.id, name: layerName(l), sep: false, poi: false };
      if (isSeparated(pos)) {
        px = subProp(tr, "ADBE Position_0");
        py = subProp(tr, "ADBE Position_1");
        if (!px || !py) fail("bad_args", "Layer " + i + " (" + layerName(l) + ") has separated Position dimensions that can't be reached, so it can't move with the resize");
        if ((size.dx !== 0 && hasExpression(px)) || (size.dy !== 0 && hasExpression(py))) {
          plan.skipped.push(skippedEntry(l, i, "a Position expression drives it"));
          continue;
        }
        step.sep = true;
      } else if (hasExpression(pos)) {
        plan.skipped.push(skippedEntry(l, i, "a Position expression drives it"));
        continue;
      }
      if (kind === "ADBE Light Layer" && lightKind(l) === "ambient") {
        plan.skipped.push(skippedEntry(l, i, "an ambient light has no Position"));
        continue;
      }
      if ((kind === "ADBE Camera Layer" || kind === "ADBE Light Layer") && hasPointOfInterest(l, kind)) {
        poi = subProp(tr, "ADBE Anchor Point");
        if (poi) {
          if (hasExpression(poi)) {
            plan.skipped.push(skippedEntry(l, i, "an expression drives its Point of Interest"));
            continue;
          }
          step.poi = true;
        }
      }
      plan.steps.push(step);
    }
    return plan;
  }

  function applyLayerShift(l, step, dx, dy) {
    var tr = transformGroup(l);
    if (step.sep) {
      if (dx !== 0) shiftScalar(subProp(tr, "ADBE Position_0"), dx);
      if (dy !== 0) shiftScalar(subProp(tr, "ADBE Position_1"), dy);
    } else {
      shiftJoint(subProp(tr, "ADBE Position"), dx, dy);
    }
    if (step.poi) shiftJoint(subProp(tr, "ADBE Anchor Point"), dx, dy);
  }

  // Pixel guides keep their place relative to the content, so they move by the
  // same delta. Percentage guides are left to AE, and so are pinned guides the
  // user did not touch (AE keeps their distance from the far edge). The shifts
  // are planned on the guide list as it stands after the user's own guide steps
  // (those run first). A guide the user added or set in this call is not
  // shifted, since its position is given for the new size; if it ends up
  // pinned, though, AE moves it with the resize, so its position is written
  // again after the resize.
  function planGuideShifts(comp, size, guidePlan) {
    var shifts = [];
    var list = null;
    try { list = comp.guides; } catch (e) { list = null; }
    if (!isList(list)) return shifts;
    var sim = [];
    var src;
    var i;
    var k;
    for (i = 0; i < list.length; i++) {
      src = guideSource(comp, list, i);
      sim.push({ entry: guideEntry(src, i), keep: guideKeep(src), touched: false, userPos: null });
    }
    var st;
    var cur;
    for (i = 0; i < guidePlan.length; i++) {
      st = guidePlan[i];
      if (st.action === "add") {
        cur = { orientation: st.orientation_type };
        if (st.position_type_value !== undefined) cur.position_type = st.position_type_value;
        if (st.color !== undefined) cur.color = st.color;
        if (st.pinned !== undefined) cur.pinned = st.pinned;
        sim.push({ entry: {}, keep: cur, touched: true, userPos: st.position });
      } else if (st.action === "set") {
        if (sim[st.index]) {
          cur = {};
          for (k in sim[st.index].keep) {
            if (sim[st.index].keep.hasOwnProperty(k)) cur[k] = sim[st.index].keep[k];
          }
          if (st.position_type_value !== undefined) cur.position_type = st.position_type_value;
          if (st.color !== undefined) cur.color = st.color;
          if (st.pinned !== undefined) cur.pinned = st.pinned;
          sim[st.index].keep = cur;
          sim[st.index].touched = true;
          sim[st.index].userPos = st.position;
        }
      } else if (st.action === "remove") {
        sim.splice(st.index, 1);
      }
    }
    var g;
    var d;
    for (i = 0; i < sim.length; i++) {
      if (sim[i].touched) {
        if (sim[i].keep.pinned === true && sim[i].userPos !== null) {
          shifts.push({ action: "set", index: i, position: sim[i].userPos, keep: sim[i].keep });
        }
        continue;
      }
      g = sim[i].entry;
      if (g.position === undefined || g.orientation === undefined) continue;
      if (g.position_kind !== undefined && g.position_kind !== "pixel") continue;
      if (g.pinned === true) continue;
      d = size.dy;
      if (g.orientation === "vertical") d = size.dx;
      if (d === 0) continue;
      shifts.push({ action: "set", index: i, position: rounded(g.position + d), keep: sim[i].keep });
    }
    if (shifts.length > 0 && typeof comp.setGuide !== "function") {
      fail("bad_args", "This AE build has no setGuide method, so the comp's guides can't move with the resize");
    }
    return shifts;
  }

  // Returns null when the layer can reach `target`, else the time its footage ends.
  function sourceLimit(l, target, frame) {
    var src = null;
    try { src = l.source; } catch (e0) { src = null; }
    if (!src) return null;
    var remap = false;
    try { remap = l.timeRemapEnabled === true; } catch (e1) { remap = false; }
    if (remap) return null;
    var isComp = false;
    var isFootage = false;
    try { isComp = src instanceof CompItem; } catch (e2) { isComp = false; }
    try { isFootage = src instanceof FootageItem; } catch (e3) { isFootage = false; }
    if (!isComp && !isFootage) return null;
    if (isFootage) {
      var ms = null;
      try { ms = src.mainSource; } catch (e4) { ms = null; }
      if (ms) {
        var still = false;
        try { still = ms instanceof SolidSource || ms.isStill === true; } catch (e5) { still = false; }
        if (still) return null;
      }
    }
    var sd = 0;
    try { sd = src.duration; } catch (e6) { sd = 0; }
    if (!isNum(sd) || sd <= 0) return null;
    var st = 100;
    try { st = Math.abs(l.stretch); } catch (e7) { st = 100; }
    if (!isNum(st) || st === 0) st = 100;
    var avail = l.startTime + sd * st / 100;
    if (avail + frame * 0.5 >= target) return null;
    return avail;
  }

  // Layers that ran to the old end follow the new end, unless their footage ends sooner.
  function planExtend(comp, newDuration) {
    var plan = { extend: [], skipped: [] };
    var oldDuration = comp.duration;
    var frame = comp.frameDuration;
    var n = comp.numLayers;
    var l;
    var out;
    var avail;
    var sk;
    for (var i = 1; i <= n; i++) {
      l = comp.layer(i);
      out = l.outPoint;
      if (Math.abs(out - oldDuration) > frame * 0.5) continue;
      avail = sourceLimit(l, newDuration, frame);
      if (avail === null) {
        plan.extend.push({ index: i, id: l.id, name: layerName(l), from: rounded(out), to: rounded(newDuration) });
      } else {
        sk = skippedEntry(l, i, "its footage ends before the new end of the comp");
        sk.available_until = rounded(avail);
        plan.skipped.push(sk);
      }
    }
    return plan;
  }

  function planTrim(comp) {
    var start = comp.workAreaStart;
    var dur = comp.workAreaDuration;
    var frame = comp.frameDuration;
    if (Math.abs(start) < frame * 0.01 && Math.abs(dur - comp.duration) < frame * 0.5) return null;
    if (dur < frame * 0.99) fail("bad_args", "The work area is shorter than one frame, so the comp can't be trimmed to it");
    var plan = { start: start, duration: dur, displayStart: null, markers: [], keep: 0, drop: 0, outside: 0, layers: comp.numLayers };
    var ds = null;
    try { ds = comp.displayStartTime; } catch (eDs) { ds = null; }
    if (isNum(ds)) {
      plan.displayStart = ds + start;
      if (plan.displayStart > 86339 + frame * 0.01) {
        fail("bad_args", "Keeping the displayed timecode would put the comp's start time at " + rounded(plan.displayStart) + "s, past AE's limit of 86339s");
      }
    }
    var i;
    var l;
    for (i = 1; i <= plan.layers; i++) {
      l = comp.layer(i);
      if (l.outPoint - start <= 0 || l.inPoint - start >= dur) plan.outside++;
    }
    var mp = null;
    try { mp = comp.markerProperty; } catch (eMp) { mp = null; }
    if (mp && mp.numKeys > 0) {
      var k;
      var t;
      var shifted;
      for (k = 1; k <= mp.numKeys; k++) {
        t = mp.keyTime(k);
        shifted = t - start;
        if (shifted < -frame * 0.01 || shifted > dur + frame * 0.01) {
          plan.drop++;
          continue;
        }
        if (shifted < 0) shifted = 0;
        plan.markers.push({ time: shifted, value: mp.keyValue(k) });
        plan.keep++;
      }
    }
    return plan;
  }

  // Keys that fall between frames at the new rate. They are reported, never moved.
  function scanOffFrameKeys(comp, rate) {
    var res = { count: 0, samples: [], scanned: 0, truncated: false };
    var n = comp.numLayers;
    var stack;
    var i;
    var l;
    var cur;
    var p;
    var np;
    var isLeaf;
    var nk;
    var k;
    var t;
    var frames;
    var j;
    var child;
    var cn;
    for (i = 1; i <= n && !res.truncated; i++) {
      l = comp.layer(i);
      stack = [{ prop: l, path: layerName(l), depth: 0 }];
      while (stack.length > 0) {
        cur = stack.pop();
        res.scanned++;
        if (res.scanned > MAX_SCAN_PROPS) {
          res.truncated = true;
          break;
        }
        p = cur.prop;
        isLeaf = false;
        try { isLeaf = p.propertyType === PropertyType.PROPERTY; } catch (e1) { isLeaf = false; }
        if (isLeaf) {
          nk = 0;
          try { nk = p.numKeys; } catch (e2) { nk = 0; }
          for (k = 1; k <= nk; k++) {
            t = p.keyTime(k);
            frames = t * rate;
            if (Math.abs(frames - Math.round(frames)) > 0.02) {
              res.count++;
              if (res.samples.length < 50) res.samples.push({ layer: i, property: cur.path, key: k, time: rounded(t) });
            }
          }
          continue;
        }
        if (cur.depth >= 12) continue;
        np = 0;
        try { np = p.numProperties; } catch (e3) { np = 0; }
        for (j = 1; j <= np; j++) {
          child = null;
          try { child = p.property(j); } catch (e4) { child = null; }
          if (child) {
            cn = "";
            try { cn = String(child.name); } catch (e5) { cn = ""; }
            stack.push({ prop: child, path: cur.path + " > " + cn, depth: cur.depth + 1 });
          }
        }
      }
    }
    return res;
  }

  // When the comp gets shorter than its work area reaches, the work area is fitted into the
  // new length first. Returns null when it already fits.
  function planWorkAreaFit(comp, newLength, frame) {
    var start = comp.workAreaStart;
    var dur = comp.workAreaDuration;
    if (start + dur <= newLength + frame * 0.01) return null;
    var ns = start;
    if (ns > newLength - frame) ns = newLength - frame;
    if (ns < 0) ns = 0;
    var nd = dur;
    if (nd > newLength - ns) nd = newLength - ns;
    return { from: { start: rounded(start), duration: rounded(dur) }, start: ns, duration: nd };
  }

  // Validates and plans the dialog edits (name, size, pixel aspect, frame rate,
  // drop frame, duration, trim) before the undo group opens. Sets plan.* fields.
  function planDialogEdits(comp, s, plan) {
    plan.name = null;
    plan.size = null;
    plan.pixelAspect = null;
    plan.frameRate = null;
    plan.dropFrame = null;
    plan.duration = null;
    plan.trim = null;
    plan.requestedNew = false;
    plan.notes = [];

    if (given(s.name)) {
      plan.requestedNew = true;
      if (typeof s.name !== "string" || s.name.length === 0 || s.name.length > 255) fail("bad_args", "name must be 1..255 characters");
      if (s.name !== comp.name) plan.name = s.name;
    }
    if (given(s.pixel_aspect)) {
      plan.requestedNew = true;
      if (!isNum(s.pixel_aspect) || s.pixel_aspect < 0.01 || s.pixel_aspect > 100) fail("bad_args", "pixel_aspect must be a number in 0.01..100");
      if (!hasProp(comp, "pixelAspect")) fail("bad_args", "pixel_aspect is not available on this After Effects build");
      if (Math.abs(comp.pixelAspect - s.pixel_aspect) > 0.000001) plan.pixelAspect = s.pixel_aspect;
    }
    if (given(s.frame_rate)) {
      plan.requestedNew = true;
      if (!isNum(s.frame_rate) || s.frame_rate < 1 || s.frame_rate > 99) fail("bad_args", "frame_rate must be a number in 1..99");
      if (Math.abs(comp.frameRate - s.frame_rate) > 0.000001) plan.frameRate = s.frame_rate;
    }
    var effRate = comp.frameRate;
    if (given(s.frame_rate)) effRate = s.frame_rate;
    var effFrame = 1 / effRate;

    if (given(s.drop_frame)) {
      plan.requestedNew = true;
      if (typeof s.drop_frame !== "boolean") fail("bad_args", "drop_frame must be true or false");
      if (!hasProp(comp, "dropFrame")) fail("bad_args", "drop_frame is not available on this After Effects build");
      if (s.drop_frame === true && !isDropFrameRate(effRate)) {
        fail("bad_args", "drop_frame only applies to 29.97 and 59.94 fps; this comp would run at " + rounded(effRate) + " fps");
      }
      if (comp.dropFrame !== s.drop_frame) plan.dropFrame = s.drop_frame;
    }

    if (given(s.size)) {
      plan.requestedNew = true;
      var sz = s.size;
      if (typeof sz !== "object") fail("bad_args", "size must be { width, height, anchor }");
      if (!isInt(sz.width) || sz.width < 4 || sz.width > 30000 || !isInt(sz.height) || sz.height < 4 || sz.height > 30000) {
        fail("bad_args", "size.width and size.height must be integers in 4..30000");
      }
      var anchor = "center";
      if (given(sz.anchor)) anchor = sz.anchor;
      if (typeof anchor !== "string" || !ANCHORS.hasOwnProperty(anchor)) fail("bad_args", "size.anchor must be one of " + keysOf(ANCHORS).join(", "));
      if (sz.width !== comp.width || sz.height !== comp.height) {
        var fr = ANCHORS[anchor];
        plan.size = {
          width: sz.width,
          height: sz.height,
          anchor: anchor,
          from: [comp.width, comp.height],
          dx: (sz.width - comp.width) * fr[0],
          dy: (sz.height - comp.height) * fr[1]
        };
        plan.resize = planResize(comp, plan.size);
      }
    }

    if (given(s.duration)) {
      plan.requestedNew = true;
      var d = s.duration;
      if (typeof d !== "object") fail("bad_args", "duration must be { seconds | frames, extend_layers }");
      if (given(d.seconds) === given(d.frames)) fail("bad_args", "duration needs seconds or frames, and not both");
      var secs;
      if (given(d.seconds)) {
        if (!isNum(d.seconds)) fail("bad_args", "duration.seconds must be a number");
        secs = d.seconds;
      } else {
        if (!isInt(d.frames) || d.frames < 1) fail("bad_args", "duration.frames must be a whole number, 1 or more");
        secs = d.frames / effRate;
      }
      if (secs < effFrame * 0.99) fail("bad_args", "duration is shorter than one frame (" + rounded(effFrame) + "s)");
      if (secs > 10800) fail("bad_args", "duration can be at most 10800 s (3 hours)");
      var extendLayers = true;
      if (given(d.extend_layers)) {
        if (typeof d.extend_layers !== "boolean") fail("bad_args", "duration.extend_layers must be true or false");
        extendLayers = d.extend_layers;
      }
      if (Math.abs(secs - comp.duration) > effFrame * 0.5) {
        plan.duration = { seconds: secs, extend: extendLayers, from: comp.duration, extension: null, fit: null };
        if (extendLayers && secs > comp.duration) plan.duration.extension = planExtend(comp, secs);
        if (secs < comp.duration) plan.duration.fit = planWorkAreaFit(comp, secs, effFrame);
      }
    }

    if (given(s.trim_to_work_area)) {
      plan.requestedNew = true;
      if (s.trim_to_work_area !== true) fail("bad_args", "trim_to_work_area must be true");
      if (given(s.duration) || given(s.work_area) || given(s.display_start_time) || given(s.display_start_frame)) {
        fail("bad_args", "trim_to_work_area can't be combined with duration, work_area or display_start_*");
      }
      plan.trim = planTrim(comp);
      if (plan.trim === null) plan.notes.push("trim_to_work_area changed nothing: the work area already covers the whole comp");
    }

    if (plan.frameRate !== null) plan.offFrame = scanOffFrameKeys(comp, plan.frameRate);
    plan.hasNew = plan.name !== null || plan.size !== null || plan.pixelAspect !== null || plan.frameRate !== null ||
      plan.dropFrame !== null || plan.duration !== null || plan.trim !== null;
    return plan;
  }

  function applyDialogEdits(comp, plan, out) {
    var i;
    var l;
    var step;
    var dx = 0;
    var dy = 0;
    var shiftBy = 0;
    if (plan.name !== null) {
      comp.name = plan.name;
      out.changed.push("name");
    }
    if (plan.size !== null) {
      dx = plan.size.dx;
      dy = plan.size.dy;
      comp.width = plan.size.width;
      comp.height = plan.size.height;
      var moved = [];
      var steps = plan.resize.steps;
      for (i = 0; i < steps.length; i++) {
        step = steps[i];
        l = comp.layer(step.index);
        runUnlocked(l, function () { applyLayerShift(l, step, dx, dy); });
        moved.push({ id: step.id, dx: dx, dy: dy });
      }
      var gs = plan.guideShifts;
      for (i = 0; i < gs.length; i++) setGuide(comp, gs[i]);
      out.guide_shifts = gs;
      out.moved_layers = moved.slice(0, MAX_REPORT);
      if (moved.length > MAX_REPORT) out.moved_layers_truncated = true;
      out.resize = {
        from: plan.size.from,
        to: [plan.size.width, plan.size.height],
        anchor: plan.size.anchor,
        delta: [dx, dy],
        layers_moved: moved.length,
        layers_parented: plan.resize.parented,
        layers_skipped: plan.resize.skipped.slice(0, MAX_REPORT),
        guides_shifted: gs.length
      };
      out.changed.push("size");
    }
    if (plan.pixelAspect !== null) {
      comp.pixelAspect = plan.pixelAspect;
      out.changed.push("pixel_aspect");
    }
    if (plan.frameRate !== null) {
      comp.frameRate = plan.frameRate;
      out.changed.push("frame_rate");
      out.keys_off_frame = {
        count: plan.offFrame.count,
        samples: plan.offFrame.samples,
        truncated: plan.offFrame.truncated,
        note: "These keys now fall between frames; they were not moved."
      };
    }
    if (plan.dropFrame !== null) {
      comp.dropFrame = plan.dropFrame;
      out.changed.push("drop_frame");
    }
    if (plan.duration !== null) {
      var fit = plan.duration.fit;
      if (fit !== null) {
        // Shrink, then move, so the area never passes the comp's current end.
        if (fit.duration < comp.workAreaDuration) comp.workAreaDuration = fit.duration;
        comp.workAreaStart = fit.start;
        comp.workAreaDuration = fit.duration;
      }
      comp.duration = plan.duration.seconds;
      var ext = plan.duration.extension;
      var extended = [];
      var skipped = [];
      if (ext !== null) {
        skipped = ext.skipped;
        for (i = 0; i < ext.extend.length; i++) {
          step = ext.extend[i];
          l = comp.layer(step.index);
          runUnlocked(l, function () { l.outPoint = step.to; });
          extended.push(step);
        }
      }
      out.duration_change = {
        from: rounded(plan.duration.from),
        to: rounded(plan.duration.seconds),
        extend_layers: plan.duration.extend,
        extended: extended.slice(0, MAX_REPORT),
        extended_count: extended.length,
        skipped: skipped.slice(0, MAX_REPORT),
        skipped_count: skipped.length
      };
      if (fit !== null) {
        out.duration_change.work_area_clamped = {
          from: fit.from,
          to: { start: rounded(fit.start), duration: rounded(fit.duration) }
        };
      }
      out.changed.push("duration");
    }
    if (plan.trim !== null) {
      var t = plan.trim;
      var n = comp.numLayers;
      shiftBy = t.start;
      for (i = 1; i <= n; i++) {
        l = comp.layer(i);
        runUnlocked(l, function () { l.startTime = l.startTime - shiftBy; });
      }
      // Work area first, so the area never passes the comp's end at any step.
      comp.workAreaStart = 0;
      comp.workAreaDuration = t.duration;
      comp.duration = t.duration;
      var shownStart = null;
      if (t.displayStart !== null) {
        comp.displayStartTime = t.displayStart;
        shownStart = rounded(t.displayStart);
      }
      var mp = null;
      try { mp = comp.markerProperty; } catch (eMk) { mp = null; }
      if (mp) {
        for (i = mp.numKeys; i >= 1; i--) mp.removeKey(i);
        for (i = 0; i < t.markers.length; i++) mp.setValueAtTime(t.markers[i].time, t.markers[i].value);
      }
      out.trim = {
        shifted_by: rounded(shiftBy),
        new_duration: rounded(t.duration),
        layers_shifted: n,
        layers_outside: t.outside,
        markers_kept: t.keep,
        markers_dropped: t.drop,
        display_start_time: shownStart
      };
      out.work_area = { start: 0, duration: rounded(t.duration) };
      out.changed.push("trim_to_work_area");
    }
  }

  function validateSettings(comp, s) {
    var key;
    for (key in s) {
      if (s.hasOwnProperty(key) && given(s[key]) && KNOWN_KEYS[key] !== 1) fail("bad_args", "Unknown setting \"" + key + "\"");
    }
    var plan = { scalars: [], renderer: null, resolution: null, background: null, workArea: null };
    var i;
    for (i = 0; i < SCALARS.length; i++) {
      var def = SCALARS[i];
      if (!given(s[def.key])) continue;
      checkScalar(def, s[def.key]);
      if (!hasProp(comp, def.prop)) fail("bad_args", def.key + " is not available on this After Effects build");
      plan.scalars.push({ def: def, value: s[def.key] });
    }
    if (given(s.motion_blur_samples) || given(s.motion_blur_adaptive_limit)) {
      // Samples can never exceed the adaptive limit; judge the pair AE would end up with.
      var effSamples = s.motion_blur_samples;
      var effLimit = s.motion_blur_adaptive_limit;
      if (!given(effSamples)) {
        try { effSamples = comp.motionBlurSamplesPerFrame; } catch (eS) { effSamples = null; }
      }
      if (!given(effLimit)) {
        try { effLimit = comp.motionBlurAdaptiveSampleLimit; } catch (eL) { effLimit = null; }
      }
      if (isNum(effSamples) && isNum(effLimit) && effSamples > effLimit) {
        fail(
          "bad_args",
          "motion_blur_samples (" + effSamples + ") cannot be above motion_blur_adaptive_limit (" + effLimit + "); " +
            (given(s.motion_blur_adaptive_limit) ? "raise the limit or lower the samples" : "raise motion_blur_adaptive_limit too, or lower the samples")
        );
      }
    }
    if (given(s.display_start_time) && given(s.display_start_frame)) {
      fail("bad_args", "Give display_start_time or display_start_frame, not both (they set the same value)");
    }
    if (given(s.display_start_frame)) {
      // AE bounds the start time to -10800..86339 s; the frame number maps
      // through the comp's frame duration, so check it here and not mid-write.
      var fdur = comp.frameDuration;
      var startSecs = s.display_start_frame * fdur;
      if (startSecs < -10800 - fdur * 0.01 || startSecs > 86339 + fdur * 0.01) {
        fail(
          "bad_args",
          "display_start_frame " + s.display_start_frame + " is " + rounded(startSecs) + "s at this comp's rate; AE accepts -10800..86339s"
        );
      }
    }
    if (given(s.renderer)) {
      if (typeof s.renderer !== "string" || s.renderer.length === 0) fail("bad_args", "renderer must be one of the comp's installed renderers");
      var rs = null;
      try { rs = comp.renderers; } catch (eR) { rs = null; }
      if (isList(rs)) {
        var found = false;
        var names = [];
        for (i = 0; i < rs.length; i++) {
          names.push(String(rs[i]));
          if (String(rs[i]) === s.renderer) found = true;
        }
        if (!found) fail("bad_args", "Renderer \"" + s.renderer + "\" is not installed; this comp offers: " + names.join(", "));
      } else {
        fail("bad_args", "The renderers list is unavailable on this build, so the renderer can't be validated and was not written");
      }
      plan.renderer = s.renderer;
    }
    if (given(s.resolution_factor)) {
      var rf = s.resolution_factor;
      if (!isList(rf) || rf.length !== 2 || !isInt(rf[0]) || !isInt(rf[1]) || rf[0] < 1 || rf[0] > 99 || rf[1] < 1 || rf[1] > 99) {
        fail("bad_args", "resolution_factor must be [x, y], integers in 1..99");
      }
      plan.resolution = [rf[0], rf[1]];
    }
    if (given(s.background_color)) {
      var bc = s.background_color;
      if (!isList(bc) || bc.length !== 3) fail("bad_args", "background_color must be [r, g, b]");
      for (i = 0; i < 3; i++) {
        if (!isNum(bc[i]) || bc[i] < 0 || bc[i] > 1) fail("bad_args", "background_color values must be numbers in 0..1");
      }
      plan.background = [bc[0], bc[1], bc[2]];
    }
    planDialogEdits(comp, s, plan);
    var endLimit = comp.duration;
    var waBase = null;
    if (plan.duration !== null) {
      endLimit = plan.duration.seconds;
      if (plan.duration.fit !== null) waBase = { start: plan.duration.fit.start, duration: plan.duration.fit.duration };
    }
    if (given(s.work_area)) plan.workArea = planWorkArea(comp, s.work_area, endLimit, waBase);
    return plan;
  }

  // ---------- write ----------

  // AE 26.5's form takes a GuideOptions object made with new GuideOptions() (attribute
  // `orientation`); a plain object stands in where the class does not exist.
  function guideOptions(orientation, position, step) {
    var o = null;
    try {
      if (typeof GuideOptions !== "undefined") o = new GuideOptions();
    } catch (eG) {
      o = null;
    }
    if (!o) o = {};
    if (step && step.keep) {
      if (step.keep.orientation !== undefined) o.orientation = step.keep.orientation;
      if (step.keep.position_type !== undefined) o.positionType = step.keep.position_type;
      if (step.keep.color !== undefined) o.color = step.keep.color;
      if (step.keep.pinned !== undefined) o.pinned = step.keep.pinned;
    }
    if (orientation !== null && orientation !== undefined) o.orientation = orientation;
    o.position = position;
    if (step) {
      if (step.position_type_value !== undefined) o.positionType = step.position_type_value;
      if (step.color !== undefined) o.color = step.color;
      if (step.pinned !== undefined) o.pinned = step.pinned;
    }
    return o;
  }

  function addGuide(comp, step) {
    if (step.options_only === true) {
      comp.addGuide(guideOptions(step.orientation_type, step.position, step));
      return "options";
    }
    try {
      comp.addGuide(step.orientation_type, step.position);
      return "legacy";
    } catch (eLegacy) {
      // AE 26.5 added a GuideOptions form; try it before giving up.
      try {
        comp.addGuide(guideOptions(step.orientation_type, step.position));
        return "options";
      } catch (eOptions) {
        throw eLegacy;
      }
    }
  }

  function setGuide(comp, step) {
    if (step.options_only === true) {
      comp.setGuide(step.index, guideOptions(null, step.position, step));
      return "options";
    }
    try {
      comp.setGuide(step.position, step.index);
      return "legacy";
    } catch (eLegacy) {
      // From 26.5 the arguments come the other way round, with GuideOptions.
      try {
        comp.setGuide(step.index, guideOptions(null, step.position, step));
        return "options";
      } catch (eOptions) {
        throw eLegacy;
      }
    }
  }

  A.compsettingsApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var s = args.settings;
    if (!given(s)) s = {};
    if (typeof s !== "object") fail("bad_args", "settings must be an object");
    var ops = args.guides;
    if (!given(ops)) ops = [];
    if (!isList(ops)) fail("bad_args", "guides must be a list");
    if (ops.length > 100) fail("bad_args", "At most 100 guide operations per call");
    // Everything that can fail is checked here, before the undo group opens.
    var plan = validateSettings(comp, s);
    var guidePlan = planGuides(comp, ops);
    if (plan.size !== null) plan.guideShifts = planGuideShifts(comp, plan.size, guidePlan);
    if (plan.scalars.length === 0 && plan.renderer === null && plan.resolution === null && plan.background === null && plan.workArea === null && guidePlan.length === 0 && !plan.hasNew) {
      if (!plan.requestedNew) fail("bad_args", "Nothing to change: give settings or guides");
      // Everything asked for is already set: no undo group, nothing to undo.
      return { comp_id: comp.id, changed: [], guide_api: null, guides_applied: [], no_op: true, notes: plan.notes.concat(["Everything asked for was already set"]) };
    }

    return A.withUndo(args.label || "Comp settings", function () {
      var out = { comp_id: comp.id, changed: [], guide_api: null, guides_applied: [] };
      var i;
      // Guides first: their API differs between AE versions, so they are the
      // likeliest to throw, and nothing else has been touched yet. Positions the
      // user gives are in the comp's new size; the resize then shifts the others.
      for (i = 0; i < guidePlan.length; i++) {
        var step = guidePlan[i];
        var api = null;
        if (step.action === "add") {
          api = addGuide(comp, step);
        } else if (step.action === "set") {
          api = setGuide(comp, step);
        } else {
          comp.removeGuide(step.index);
        }
        if (api !== null) out.guide_api = api;
        out.guides_applied.push(step);
      }
      if (guidePlan.length > 0) out.changed.push("guides");
      if (guidePlan.unverified) out.guide_orientation_unverified = true;
      applyDialogEdits(comp, plan, out);
      if (plan.notes.length > 0) out.notes = plan.notes;
      // The renderer first: it decides which other switches apply.
      if (plan.renderer !== null) {
        comp.renderer = plan.renderer;
        out.changed.push("renderer");
      }
      // AE may clamp samples to the adaptive limit. When both are given, write
      // limit, samples, limit again: the result is right whichever way AE clamps.
      var limitStep = null;
      var samplesStep = null;
      for (i = 0; i < plan.scalars.length; i++) {
        if (plan.scalars[i].def.key === "motion_blur_adaptive_limit") limitStep = plan.scalars[i];
        if (plan.scalars[i].def.key === "motion_blur_samples") samplesStep = plan.scalars[i];
      }
      var linked = limitStep !== null && samplesStep !== null;
      if (linked) comp[limitStep.def.prop] = limitStep.value;
      for (i = 0; i < plan.scalars.length; i++) {
        comp[plan.scalars[i].def.prop] = plan.scalars[i].value;
        out.changed.push(plan.scalars[i].def.key);
      }
      if (linked) comp[limitStep.def.prop] = limitStep.value;
      if (plan.resolution !== null) {
        comp.resolutionFactor = plan.resolution;
        out.changed.push("resolution_factor");
        out.resolution_factor_written = true;
      }
      if (plan.background !== null) {
        comp.bgColor = plan.background;
        out.changed.push("background_color");
      }
      if (plan.workArea !== null) {
        // Shrink first, then move, then widen: start + duration never passes the
        // comp's length at any step, whichever way the area moves.
        var cur = comp.workAreaDuration;
        if (plan.workArea.duration < cur) cur = plan.workArea.duration;
        comp.workAreaDuration = cur;
        comp.workAreaStart = plan.workArea.start;
        comp.workAreaDuration = plan.workArea.duration;
        out.changed.push("work_area");
        out.work_area = { start: plan.workArea.start, duration: plan.workArea.duration };
      }
      return out;
    });
  };
})($.global);
