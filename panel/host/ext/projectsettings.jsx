// panel/host/ext/projectsettings.jsx
//
// Host functions for ae_project_settings (Project Settings dialog values):
// - projectsettingsRead (read): bit depth, working colour space (and the list of
//   profiles AE offers), gamma, linear blending, expression engine, time display,
//   frame counting, display start frame, feet+frames, footage timecode start,
//   transparency grid thumbnails, GPU acceleration (and the types this machine
//   offers), plus a probe for colour-management members the Guide does not list
// - projectsettingsApply (guarded write): sets any of them in one undo group
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - The write checks the target guard first and validates every value (type, exact
//   profile string, gamma rule, GPU availability, member exists in this AE) before
//   A.withUndo opens.
// - Enum members are resolved from the enum objects AE provides, never from a
//   hard-coded number table.
// - Reads change nothing. The read after a write runs in a separate evalScript.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_STRING = 20000;
  var ENGINES = ["extendscript", "javascript-1.0"];

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

  function msgOf(e) {
    try {
      return String(e && e.message ? e.message : e);
    } catch (e2) {
      return "unknown error";
    }
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function isInt(v) {
    return isNum(v) && Math.floor(v) === v;
  }

  function clip(s) {
    var t = String(s);
    if (t.length > MAX_STRING) return t.substring(0, MAX_STRING);
    return t;
  }

  // ---------- enums ----------

  // prefix: the part of a key that is dropped from the reported name
  // (FramesCountType.FC_START_0 is reported as "start_0"). candidates: keys tried
  // when the enum object can't be enumerated.
  var ENUMS = {
    time_display_type: { global: "TimeDisplayType", prefix: "", candidates: ["TIMECODE", "FRAMES"] },
    frames_count_type: {
      global: "FramesCountType",
      prefix: "FC_",
      candidates: ["FC_START_0", "FC_START_1", "FC_TIMECODE_CONVERSION"]
    },
    feet_frames_film_type: { global: "FeetFramesFilmType", prefix: "", candidates: ["MM16", "MM35"] },
    footage_timecode_display_start_type: {
      global: "FootageTimecodeDisplayStartType",
      prefix: "FTCS_",
      candidates: ["FTCS_START_0", "FTCS_USE_SOURCE_MEDIA"]
    },
    gpu_accel_type: {
      global: "GpuAccelType",
      prefix: "",
      candidates: ["CUDA", "METAL", "OPENCL", "SOFTWARE", "Software", "Metal", "OpenCL", "Cuda"]
    }
  };

  function nameOfKey(spec, key) {
    var n = String(key);
    if (spec.prefix && n.indexOf(spec.prefix) === 0) n = n.substring(spec.prefix.length);
    return n.toLowerCase();
  }

  // The enum as [{ key, name, value }]; empty when AE does not provide the object.
  function enumTable(enumKey) {
    var spec = ENUMS[enumKey];
    var table = [];
    var seen = {};
    var obj = null;
    try {
      obj = $.global[spec.global];
    } catch (e0) {
      obj = null;
    }
    if (obj === null || obj === undefined) return table;
    var keys = [];
    try {
      for (var k in obj) {
        keys.push(k);
      }
    } catch (e1) {}
    var ci;
    for (ci = 0; ci < spec.candidates.length; ci++) keys.push(spec.candidates[ci]);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (seen[key]) continue;
      var v;
      try {
        v = obj[key];
      } catch (e2) {
        continue;
      }
      if (v === undefined || v === null || typeof v === "function") continue;
      seen[key] = true;
      table.push({ key: key, name: nameOfKey(spec, key), value: v });
    }
    return table;
  }

  function enumName(enumKey, raw) {
    var table = enumTable(enumKey);
    for (var i = 0; i < table.length; i++) {
      if (table[i].value === raw) return table[i].name;
    }
    return null;
  }

  function enumValue(enumKey, name) {
    var table = enumTable(enumKey);
    var want = String(name).toLowerCase();
    for (var i = 0; i < table.length; i++) {
      if (table[i].name === want) return table[i].value;
    }
    return undefined;
  }

  function enumNames(enumKey) {
    var table = enumTable(enumKey);
    var out = [];
    var seen = {};
    for (var i = 0; i < table.length; i++) {
      if (!seen[table[i].name]) {
        seen[table[i].name] = true;
        out.push(table[i].name);
      }
    }
    return out;
  }

  // ---------- members ----------

  // Order is the order of the writes: the working space before gamma, the frame
  // counting before the start frame.
  var SPECS = [
    { key: "working_space", member: "workingSpace", kind: "string", since: "" },
    { key: "working_gamma", member: "workingGamma", kind: "number", since: "" },
    { key: "bits_per_channel", member: "bitsPerChannel", kind: "bits", since: "" },
    { key: "linear_blending", member: "linearBlending", kind: "bool", since: "" },
    { key: "linearize_working_space", member: "linearizeWorkingSpace", kind: "bool", since: "16.0" },
    { key: "compensate_for_scene_referred_profiles", member: "compensateForSceneReferredProfiles", kind: "bool", since: "16.0" },
    { key: "expression_engine", member: "expressionEngine", kind: "engine", since: "16.0" },
    { key: "time_display_type", member: "timeDisplayType", kind: "enum", since: "" },
    { key: "frames_count_type", member: "framesCountType", kind: "enum", since: "" },
    { key: "display_start_frame", member: "displayStartFrame", kind: "int", since: "" },
    { key: "frames_use_feet_frames", member: "framesUseFeetFrames", kind: "bool", since: "" },
    { key: "feet_frames_film_type", member: "feetFramesFilmType", kind: "enum", since: "" },
    { key: "footage_timecode_display_start_type", member: "footageTimecodeDisplayStartType", kind: "enum", since: "" },
    { key: "transparency_grid_thumbnails", member: "transparencyGridThumbnails", kind: "bool", since: "" },
    { key: "gpu_accel_type", member: "gpuAccelType", kind: "enum", since: "13.8" }
  ];

  function specFor(key) {
    for (var i = 0; i < SPECS.length; i++) {
      if (SPECS[i].key === key) return SPECS[i];
    }
    return null;
  }

  // Colour-management members the Guide does not document; probed, never assumed.
  var PROBE_NAMES = [
    "colorManagementSystem",
    "colourManagementSystem",
    "ocioConfigurationFile",
    "ocioConfigFile",
    "ocioConfig",
    "acesConfig",
    "displayColorSpace",
    "displayColourSpace",
    "colorDisplayTransform",
    "lutInterpolationMethod",
    "lutInterpolation",
    "workingColorSpace",
    "viewTransform",
    "colorEngine"
  ];

  function readRaw(spec) {
    var v;
    try {
      v = app.project[spec.member];
    } catch (e) {
      return { ok: false, error: msgOf(e) };
    }
    if (v === undefined || v === null) return { ok: false, error: "member not available" };
    return { ok: true, value: v };
  }

  // The reported (snake-case, enum-as-string) value of a member.
  function reported(spec, raw) {
    if (spec.kind === "enum") {
      var nm = enumName(spec.key, raw);
      if (nm === null) return "value_" + String(raw);
      return nm;
    }
    if (spec.kind === "string" || spec.kind === "engine") return String(raw);
    if (spec.kind === "bool") return raw === true;
    return raw;
  }

  function listProfiles(noCap) {
    var out = { ok: false, list: [], truncated: false };
    var p;
    try {
      if (typeof app.project.listColorProfiles !== "function") return out;
      p = app.project.listColorProfiles();
    } catch (e) {
      return out;
    }
    if (!p || typeof p.length !== "number") return out;
    out.ok = true;
    for (var i = 0; i < p.length; i++) {
      if (!noCap && out.list.length >= MAX_LIST) {
        out.truncated = true;
        break;
      }
      out.list.push(String(p[i]));
    }
    return out;
  }

  function availableGpu() {
    var out = { ok: false, names: [], raw: [] };
    var a;
    try {
      a = app.availableGPUAccelTypes;
    } catch (e) {
      return out;
    }
    if (a === undefined || a === null || typeof a.length !== "number") return out;
    out.ok = true;
    for (var i = 0; i < a.length && i < MAX_LIST; i++) {
      out.raw.push(a[i]);
      var nm = enumName("gpu_accel_type", a[i]);
      if (nm === null) nm = "value_" + String(a[i]);
      out.names.push(nm);
    }
    return out;
  }

  function probeMembers() {
    var found = {};
    var notFound = [];
    for (var i = 0; i < PROBE_NAMES.length; i++) {
      var n = PROBE_NAMES[i];
      var v;
      var has = false;
      try {
        v = app.project[n];
        has = typeof v !== "undefined";
      } catch (e) {
        has = false;
      }
      if (!has) {
        notFound.push(n);
        continue;
      }
      if (typeof v === "string") found[n] = clip(v).substring(0, 500);
      else if (typeof v === "number" || typeof v === "boolean") found[n] = v;
      else found[n] = "[" + typeof v + "]";
    }
    return { found: found, not_found: notFound };
  }

  function currentValues() {
    var cur = {};
    var unreadable = [];
    for (var i = 0; i < SPECS.length; i++) {
      var r = readRaw(SPECS[i]);
      if (r.ok) cur[SPECS[i].key] = reported(SPECS[i], r.value);
      else unreadable.push(SPECS[i].key);
    }
    return { values: cur, unreadable: unreadable };
  }

  // ---------- read ----------

  A.projectsettingsRead = function (args) {
    var a = args || {};
    var cv = currentValues();
    var out = {};
    for (var k in cv.values) {
      out[k] = cv.values[k];
    }
    var profiles = listProfiles();
    out.list_color_profiles = profiles.list;
    if (!profiles.ok) cv.unreadable.push("list_color_profiles");
    if (profiles.truncated) out.list_color_profiles_truncated = true;

    var gpu = availableGpu();
    out.available_gpu_types = gpu.names;
    if (!gpu.ok) cv.unreadable.push("available_gpu_types");

    try {
      out.project_path = String(A.checkGuard({ expect: {} }).project_path);
    } catch (eP) {
      out.project_path = "";
    }
    out.probed = probeMembers();
    out.unreadable = cv.unreadable;
    try {
      out.ae_version = String(app.version);
    } catch (e0) {
      out.ae_version = "";
    }

    if (a.comps === true) {
      var comps = [];
      var truncated = false;
      var n = 0;
      try {
        n = app.project.numItems;
      } catch (e1) {
        n = 0;
      }
      for (var i = 1; i <= n; i++) {
        var it = null;
        try {
          it = app.project.item(i);
        } catch (e2) {
          it = null;
        }
        if (it && it instanceof CompItem) {
          if (comps.length >= MAX_LIST) {
            truncated = true;
            break;
          }
          comps.push({ id: it.id, name: it.name });
        }
      }
      out.comps = comps;
      if (truncated) out.comps_truncated = true;
    }
    return out;
  };

  // ---------- write ----------

  function sameValue(a, b) {
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-4;
    return a === b;
  }

  function inList(list, v) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === v) return true;
    }
    return false;
  }

  // Checks one requested value; returns the raw value to write. Throws before any undo group.
  function validateOne(spec, v, ctxInfo) {
    var key = spec.key;
    if (spec.kind === "bool") {
      if (typeof v !== "boolean") fail("bad_args", key + " must be true or false.");
      return v;
    }
    if (spec.kind === "bits") {
      if (v !== 8 && v !== 16 && v !== 32) fail("bad_args", "bits_per_channel must be 8, 16 or 32 (got " + String(v) + ").");
      return v;
    }
    if (spec.kind === "int") {
      if (v !== 0 && v !== 1) fail("bad_args", key + " must be 0 or 1 (the same Frame Count menu as frames_count_type start_0 / start_1).");
      return v;
    }
    if (spec.kind === "number") {
      if (!isNum(v) || (Math.abs(v - 2.2) > 1e-9 && Math.abs(v - 2.4) > 1e-9)) {
        fail("bad_args", "working_gamma must be 2.2 or 2.4 (AE throws on any other value).");
      }
      if (ctxInfo.finalWorkingSpace !== "") {
        fail(
          "bad_args",
          "working_gamma is ignored once a working space is set (working space is '" + ctxInfo.finalWorkingSpace + "'). Set working_space to '' first, in the same or an earlier call."
        );
      }
      return v;
    }
    if (spec.kind === "string") {
      if (typeof v !== "string") fail("bad_args", key + " must be a string ('' for None).");
      if (v === "") return v;
      if (!ctxInfo.profiles.ok) fail("unsupported", "This After Effects build cannot list colour profiles, so working_space can't be checked; nothing was changed.");
      if (!inList(ctxInfo.profiles.list, v)) {
        fail("bad_args", "working_space must exactly match one of list_color_profiles (case and spacing included); '" + v + "' is not in the list.", {
          expected: ctxInfo.profiles.list.length > 40 ? ctxInfo.profiles.list.slice(0, 40) : ctxInfo.profiles.list
        });
      }
      return v;
    }
    if (spec.kind === "engine") {
      if (typeof v !== "string" || !inList(ENGINES, v)) {
        fail("bad_args", "expression_engine must be one of: " + ENGINES.join(", ") + ".");
      }
      return v;
    }
    // enum
    if (typeof v !== "string") fail("bad_args", key + " must be one of the names listed by the read (a string).");
    var names = enumNames(key);
    if (names.length === 0) fail("unsupported", "This After Effects build does not provide the " + ENUMS[key].global + " enum, so " + key + " can't be set.");
    var raw = enumValue(key, v);
    if (raw === undefined) fail("bad_args", key + " must be one of: " + names.join(", ") + " (got '" + v + "').", { expected: names });
    if (key === "gpu_accel_type") {
      var gpu = ctxInfo.gpu;
      var name = enumName(key, raw);
      if (!gpu.ok) fail("unsupported", "This After Effects build does not list available GPU types, so gpu_accel_type can't be checked; nothing was changed.");
      if (!inList(gpu.names, name)) {
        fail("bad_args", "gpu_accel_type '" + v + "' is not available on this machine. Available: " + (gpu.names.length ? gpu.names.join(", ") : "none") + ".", { expected: gpu.names });
      }
    }
    return raw;
  }

  A.projectsettingsApply = function (args) {
    if (!args) fail("bad_args", "projectsettingsApply requires args");
    assertGuard(args.expect);
    var set = args.set;
    if (set === null || set === undefined || typeof set !== "object") fail("bad_args", "set must be an object of settings.");

    // 1. Only known keys.
    var asked = [];
    var key;
    for (key in set) {
      if (set[key] === undefined) continue;
      if (!specFor(key)) fail("bad_args", "Unknown setting '" + key + "'.");
      asked.push(key);
    }
    if (asked.length === 0) fail("bad_args", "set has no settings.");

    // 2. Current state and what must be known to validate.
    var cv = currentValues();
    var finalWorkingSpace = "";
    if (set.working_space !== undefined) finalWorkingSpace = String(set.working_space);
    else if (cv.values.working_space !== undefined) finalWorkingSpace = String(cv.values.working_space);
    var ctxInfo = {
      finalWorkingSpace: finalWorkingSpace,
      profiles: set.working_space !== undefined && set.working_space !== "" ? listProfiles(true) : { ok: true, list: [] },
      gpu: set.gpu_accel_type !== undefined ? availableGpu() : { ok: true, names: [], raw: [] }
    };

    if (set.frames_count_type !== undefined && set.display_start_frame !== undefined && typeof set.frames_count_type === "string") {
      var fctRaw = enumValue("frames_count_type", set.frames_count_type);
      var fct = fctRaw === undefined ? null : enumName("frames_count_type", fctRaw);
      if (fct === "timecode_conversion") {
        fail("bad_args", "frames_count_type 'timecode_conversion' resets display_start_frame, so it can't be given in the same call. Leave display_start_frame out.");
      }
      if ((fct === "start_0" && set.display_start_frame !== 0) || (fct === "start_1" && set.display_start_frame !== 1)) {
        fail("bad_args", "frames_count_type '" + fct + "' and display_start_frame " + String(set.display_start_frame) + " set the same Frame Count menu and disagree. Give only one, or match them (start_0 with 0, start_1 with 1).");
      }
    }

    // 3. Validate everything, in write order, before the undo group.
    var plan = [];
    var unchanged = [];
    for (var i = 0; i < SPECS.length; i++) {
      var spec = SPECS[i];
      if (!inList(asked, spec.key)) continue;
      var cur = readRaw(spec);
      if (!cur.ok) {
        var since = spec.since ? " (needs After Effects " + spec.since + " or newer)" : "";
        fail("unsupported", spec.key + " is not available in this After Effects" + since + "; nothing was changed.");
      }
      var raw = validateOne(spec, set[spec.key], ctxInfo);
      var want = reported(spec, raw);
      var have = reported(spec, cur.value);
      var same = sameValue(want, have);
      if (same && spec.key === "display_start_frame") {
        // timecode_conversion reads displayStartFrame 0 but is not the start_0 menu entry.
        var curType = cv.values.frames_count_type;
        var needType = want === 1 ? "start_1" : "start_0";
        if (curType !== undefined && curType !== needType) same = false;
      }
      if (same) {
        unchanged.push(spec.key);
        continue;
      }
      plan.push({ spec: spec, raw: raw, from: have, to: want });
    }

    if (plan.length === 0) {
      return { no_op: true, changed: [], unchanged: unchanged, failed: [], display_start_frame_reset: false, expression_engine_changed: false };
    }

    // 4. The write: one undo group, assignments only.
    var changed = [];
    var failed = [];
    var pi;
    A.withUndo(args.label || "Project settings", function () {
      for (pi = 0; pi < plan.length; pi++) {
        try {
          app.project[plan[pi].spec.member] = plan[pi].raw;
          changed.push({ key: plan[pi].spec.key, from: plan[pi].from, to: plan[pi].to });
        } catch (eSet) {
          failed.push({ key: plan[pi].spec.key, message: msgOf(eSet) });
        }
      }
    });

    var reset = false;
    var engineChanged = false;
    for (var ci = 0; ci < changed.length; ci++) {
      if (changed[ci].key === "frames_count_type" && changed[ci].to === "timecode_conversion") reset = true;
      if (changed[ci].key === "expression_engine") engineChanged = true;
    }
    return {
      no_op: false,
      changed: changed,
      unchanged: unchanged,
      failed: failed,
      display_start_frame_reset: reset,
      expression_engine_changed: engineChanged
    };
  };
})($.global);
