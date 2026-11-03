// panel/host/ext/compsettings.jsx
//
// Host functions for the comp settings tools:
// - compsettingsRead (read): the comp-level switches no other tool reaches:
//   motion blur (shutter angle, phase, samples, adaptive limit), frame
//   blending, renderer (and the installed renderers), draft 3D, resolution
//   factor, background colour, shy, preserve nested frame rate / resolution,
//   display start, work area, and the comp's guides
// - compsettingsApply (guarded write): sets any of them, and adds, moves or
//   removes guides, in one undo group
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

  var KNOWN_KEYS = { renderer: 1, resolution_factor: 1, background_color: 1, work_area: 1 };
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

  function guideEntry(g, index) {
    var out = { index: index };
    try { if (isNum(g.orientationType)) out.orientation_type = g.orientationType; } catch (e1) {}
    try { if (isNum(g.positionType)) out.position_type = g.positionType; } catch (e2) {}
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
    for (var i = 0; i < n; i++) out.guides.push(guideEntry(list[i], i));
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

  A.compsettingsRead = function (args) {
    return readSettings(requireComp(args.comp_id));
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
  function planWorkArea(comp, wa) {
    if (typeof wa !== "object" || wa === null) fail("bad_args", "work_area must be { start, duration }");
    var start = comp.workAreaStart;
    var duration = comp.workAreaDuration;
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
    if (start + duration > comp.duration + frame * 0.01) {
      fail(
        "bad_args",
        "The work area would end at " + rounded(start + duration) + "s, past the comp's length of " + rounded(comp.duration) + "s"
      );
    }
    if (start + duration > comp.duration) duration = comp.duration - start;
    return { start: start, duration: duration };
  }

  // Walks the guide operations against the current count, so an index that
  // AE would reject (or one that shifted after a remove) is caught here.
  function planGuides(comp, ops) {
    var plan = [];
    var count = 0;
    var list = null;
    try { list = comp.guides; } catch (e) { list = null; }
    if (isList(list)) count = list.length;
    else if (ops.length > 0) fail("bad_args", "This AE build does not expose Item.guides (16.1+)");
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
        plan.push({ action: "add", orientation_type: ori.value, position: op.position });
        needAdd = true;
        count++;
      } else if (op.action === "set") {
        if (!isInt(op.index) || op.index < 0 || op.index >= count) fail("bad_args", where + ".index must be 0.." + (count - 1) + " (the guide count at that step is " + count + ")");
        if (!isNum(op.position) || Math.abs(op.position) > 100000) fail("bad_args", where + ".position must be a number within +-100000 px");
        plan.push({ action: "set", index: op.index, position: op.position });
        needSet = true;
      } else if (op.action === "remove") {
        if (!isInt(op.index) || op.index < 0 || op.index >= count) fail("bad_args", where + ".index must be 0.." + (count - 1) + " (the guide count at that step is " + count + ")");
        plan.push({ action: "remove", index: op.index });
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
    if (given(s.work_area)) plan.workArea = planWorkArea(comp, s.work_area);
    return plan;
  }

  // ---------- write ----------

  function addGuide(comp, step) {
    try {
      comp.addGuide(step.orientation_type, step.position);
      return "legacy";
    } catch (eLegacy) {
      // AE 26.5 added a GuideOptions form; try it before giving up.
      try {
        comp.addGuide({ orientationType: step.orientation_type, position: step.position });
        return "options";
      } catch (eOptions) {
        throw eLegacy;
      }
    }
  }

  function setGuide(comp, step) {
    try {
      comp.setGuide(step.position, step.index);
      return "legacy";
    } catch (eLegacy) {
      // From 26.5 the arguments come the other way round, with GuideOptions.
      try {
        comp.setGuide(step.index, { position: step.position });
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
    if (plan.scalars.length === 0 && plan.renderer === null && plan.resolution === null && plan.background === null && plan.workArea === null && guidePlan.length === 0) {
      fail("bad_args", "Nothing to change: give settings or guides");
    }

    return A.withUndo(args.label || "Comp settings", function () {
      var out = { comp_id: comp.id, changed: [], guide_api: null, guides_applied: [] };
      var i;
      // Guides first: their API differs between AE versions, so they are the
      // likeliest to throw, and nothing else has been touched yet.
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
