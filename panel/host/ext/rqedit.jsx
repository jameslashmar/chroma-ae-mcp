// panel/host/ext/rqedit.jsx
//
// Host functions for editing items that are already in the Render Queue:
// - rqeditRead (read): queue items with time span, render settings and output
//   modules (settings from getSettings(STRING_SETTABLE)), optionally templates
// - rqeditEdit (guarded write): render settings template, time span, skip
//   frames, log type, render settings, the queued (Render checkbox) flag; per
//   output module: template, settings, file, post-render action, XMP; add and
//   remove output modules
// - rqeditRemove (guarded write): take items out of the queue, by index (each
//   guarded by its comp id) or by status filter, highest index first in one undo
//   group; dry_run lists what would go and changes nothing
// - rqeditDuplicate (guarded write): RenderQueueItem.duplicate() N times, each
//   copy with its own output module template, file and settings
// - rqeditApplySpec (guarded write): a delivery spec (template picked from the
//   installed ones, size, channels, audio, file name) on the item and/or on
//   duplicates of it, one spec per item
// - rqeditSpecs (read): which specs of a library this AE can meet
// - rqeditRender: RenderQueue.render(), AE's own render of the queued items (no undo
//   group: not undoable). It returns only when the render ends, so the server sends it in
//   one long evalScript (ae_render_queue_render) and reads the result separately:
// - rqeditRenderResult (read): item status, elapsed time and output files after a render
// - rqeditAmeState (read) / rqeditQueueInAme: opt-in hand-over of the queue to Adobe Media Encoder (queueInAME(false) or (true))
// - rqeditHold / rqeditRelease (guarded writes, one undo group each): uncheck the Render box of the other
//   QUEUED items so that only chosen ones render, and check it again afterwards on the items that still match
//
// What AE allows: the output module Format (and so the codec) is readable but
// not settable; it changes only through OutputModule.applyTemplate with a
// template installed on this machine. Settings keys are not documented beyond
// "Output File Info" and "Crop", so every key is checked against the item's
// own getSettings(STRING_SETTABLE) dump, and values take the type of the dump's
// value (a boolean stays a boolean, "On"/"Off" stays text, a size stays an
// array or becomes "W x H" text).
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Everything that can fail is checked before A.withUndo; inside it a failing
//   step is recorded in `errors` and the rest still runs (a throw would leave
//   half a change behind).
// - An output module is fetched again by index before each use: setSettings
//   can invalidate the object.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_ITEMS = 500;
  var MAX_STR = 20000;
  var MAX_KEYS = 200;
  var MAX_TEMPLATES = 500;
  var MAX_MODULES = 20;
  var MAX_COPIES = 20;
  var EPS = 0.0001;
  var MEDIA_EXTS = ["mp4", "mov", "m4v", "avi", "mxf", "png", "jpg", "jpeg", "tif", "tiff", "gif", "wav", "aif", "aiff", "mp3", "aac", "webm", "exr", "dpx", "psd", "tga", "bmp"];

  var STATUS_NAMES = ["WILL_CONTINUE", "NEEDS_OUTPUT", "UNQUEUED", "QUEUED", "RENDERING", "USER_STOPPED", "ERR_STOPPED", "DONE"];
  var POST_NAMES = ["NONE", "IMPORT", "IMPORT_AND_REPLACE_USAGE", "SET_PROXY"];
  var LOG_NAMES = ["ERRORS_ONLY", "ERRORS_AND_SETTINGS", "ERRORS_AND_PER_FRAME_INFO"];

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

  function isArr(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function lc(s) {
    return String(s).toLowerCase();
  }

  function msgOf(e) {
    try {
      if (e && e.message) return String(e.message);
    } catch (e1) {}
    try {
      return String(e);
    } catch (e2) {}
    return "unknown error";
  }

  function keysOf(o) {
    var out = [];
    var k;
    for (k in o) {
      if (hasOwn(o, k)) out.push(k);
    }
    return out;
  }

  // ---------- enums ----------

  function enumName(E, names, v) {
    var i;
    if (E === null) return String(v);
    for (i = 0; i < names.length; i++) {
      try {
        if (E[names[i]] === v) return lc(names[i]);
      } catch (e1) {}
    }
    return String(v);
  }

  function enumValue(E, names, wanted) {
    var i;
    if (E === null) return null;
    for (i = 0; i < names.length; i++) {
      if (lc(names[i]) === lc(wanted)) {
        try {
          return E[names[i]];
        } catch (e1) {}
      }
    }
    return null;
  }

  function statusEnum() {
    if (typeof RQItemStatus !== "undefined") return RQItemStatus;
    return null;
  }

  function postEnum() {
    if (typeof PostRenderAction !== "undefined") return PostRenderAction;
    return null;
  }

  function logEnum() {
    if (typeof LogType !== "undefined") return LogType;
    return null;
  }

  function statusName(v) {
    return enumName(statusEnum(), STATUS_NAMES, v);
  }

  // ---------- plain copies of AE values ----------

  // Set when plain() leaves something out (keys past MAX_KEYS, array entries past 50, depth).
  var plainCut = false;

  function plain(v, depth) {
    var t = typeof v;
    var out;
    var i;
    var k;
    var n;
    if (v === null || v === undefined) return null;
    if (t === "number") {
      if (isFinite(v)) return v;
      return null;
    }
    if (t === "boolean") return v;
    if (t === "string") {
      if (v.length > MAX_STR) return v.substring(0, MAX_STR);
      return v;
    }
    if (t === "function") return null;
    if (depth > 3) return null;
    if (isArr(v)) {
      out = [];
      if (v.length > 50) plainCut = true;
      for (i = 0; i < v.length && i < 50; i++) out.push(plain(v[i], depth + 1));
      return out;
    }
    out = {};
    n = 0;
    for (k in v) {
      if (n >= MAX_KEYS) {
        plainCut = true;
        break;
      }
      try {
        if (!hasOwn(v, k)) continue;
        out[k] = plain(v[k], depth + 1);
        n++;
      } catch (e1) {}
    }
    return out;
  }

  // getSettings(STRING_SETTABLE): the keys setSettings accepts, with their
  // current values. Null when AE can't give it.
  function dumpSettings(target) {
    if (typeof GetSettingsFormat === "undefined") {
      return { settings: null, error: "GetSettingsFormat is not available in this AE", truncated: false };
    }
    plainCut = false;
    try {
      var got = plain(target.getSettings(GetSettingsFormat.STRING_SETTABLE), 0);
      return { settings: got, error: null, truncated: plainCut };
    } catch (e1) {
      return { settings: null, error: msgOf(e1), truncated: false };
    }
  }

  function templatesOf(target) {
    var out = [];
    var i;
    try {
      var t = target.templates;
      for (i = 0; i < t.length && i < MAX_TEMPLATES; i++) out.push(String(t[i]));
    } catch (e1) {}
    return out;
  }

  function inList(list, name) {
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i] === name) return true;
    }
    return false;
  }

  // ---------- paths ----------

  function pathKey(p) {
    return lc(String(p).replace(/\\/g, "/"));
  }

  function isAbsolute(p) {
    return /^([A-Za-z]:[\\\/]|\/|\\\\)/.test(String(p));
  }

  function hasSeqToken(p) {
    return /\[#+\]/.test(String(p));
  }

  // A sequence path ("dir/name_[#####].png") exists when the folder holds
  // frames that fit "name_" + digits + ".png".
  function sequenceExists(p) {
    var s = String(p).replace(/\\/g, "/");
    var slash = s.lastIndexOf("/");
    var dir = s.substring(0, slash);
    var leaf = s.substring(slash + 1);
    var ti = leaf.search(/\[#+\]/);
    if (ti < 0 || slash < 0) return false;
    var stem = leaf.substring(0, ti);
    var tail = leaf.substring(leaf.indexOf("]", ti) + 1);
    try {
      if (typeof Folder === "undefined") return false;
      var folder = new Folder(dir);
      if (folder.exists !== true) return false;
      var found = folder.getFiles(stem + "*" + tail);
      var i;
      if (!found) return false;
      for (i = 0; i < found.length; i++) {
        var nm = decodeURI(String(found[i].name));
        if (nm.length > stem.length + tail.length && nm.substring(0, stem.length) === stem && nm.substring(nm.length - tail.length) === tail) {
          if (/^\d+$/.test(nm.substring(stem.length, nm.length - tail.length))) return true;
        }
      }
    } catch (e1) {}
    return false;
  }

  function fileExists(p) {
    if (hasSeqToken(p)) return sequenceExists(p);
    try {
      return new File(p).exists === true;
    } catch (e1) {}
    return false;
  }

  function fsNameOf(o) {
    try {
      if (o.file) return o.file.fsName;
    } catch (e1) {}
    return null;
  }

  // "out/clip.mp4" + "_copy2" -> "out/clip_copy2.mp4"; "out/seq_[#####].png"
  // + "_copy2" -> "out/seq_copy2_[#####].png" (the frame number stays last).
  function suffixPath(p, suffix) {
    var s = String(p);
    var slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    var dot = s.lastIndexOf(".");
    var stem = s;
    var ext = "";
    if (dot > slash) {
      stem = s.substring(0, dot);
      ext = s.substring(dot);
    }
    var m = /([_\-\. ]?\[#+\])$/.exec(stem);
    if (m) {
      return stem.substring(0, stem.length - m[1].length) + suffix + m[1] + ext;
    }
    return stem + suffix + ext;
  }

  function safeName(s) {
    return String(s).replace(/[\\\/:*?"<>|]/g, "_");
  }

  function pad2(n) {
    if (n < 10) return "0" + n;
    return String(n);
  }

  // [compName], [spec], [width], [height], [date], [copy]; other [..] text
  // (AE's own [#####]) stays as it is.
  function expandName(tpl, vars) {
    return String(tpl).replace(/\[([A-Za-z]+)\]/g, function (whole, name) {
      if (hasOwn(vars, name)) return String(vars[name]);
      return whole;
    });
  }

  // ---------- value shapes ----------

  function numbersIn(s) {
    var m = String(s).match(/-?\d+(\.\d+)?/g);
    var out = [];
    var i;
    if (!m) return out;
    for (i = 0; i < m.length; i++) out.push(Number(m[i]));
    return out;
  }

  // The value to hand setSettings, in the type the dump shows for that key.
  function mirror(current, want) {
    var t = typeof want;
    var c = typeof current;
    if (t === "boolean") {
      if (c === "boolean") return want;
      if (c === "string") {
        if (/^(on|off)$/i.test(current)) {
            if (want) return "On";
            return "Off";
        }
        if (/^(true|false)$/i.test(current)) {
          if (want) return "true";
          return "false";
        }
        if (/^(yes|no)$/i.test(current)) {
          if (want) return "Yes";
          return "No";
        }
        if (/^[01]$/.test(current)) {
          if (want) return "1";
          return "0";
        }
      }
      if (c === "number") {
        if (want) return 1;
        return 0;
      }
      return want;
    }
    if (t === "number") {
      if (c === "string") return String(want);
      return want;
    }
    if (isArr(want) && want.length === 2 && typeof want[0] === "number") {
      if (c === "string") return want[0] + " x " + want[1];
      if (current && c === "object" && !isArr(current)) {
        if (hasOwn(current, "x")) return { x: want[0], y: want[1] };
        if (hasOwn(current, "width")) return { width: want[0], height: want[1] };
      }
      return want;
    }
    return want;
  }

  // ---------- reading ----------

  function readModule(item, o, withSettings) {
    var om = item.outputModule(o);
    var out = { index: o, name: null, file: fsNameOf(om), post_render_action: null, include_source_xmp: null };
    try {
      out.name = String(om.name);
    } catch (e1) {}
    try {
      out.post_render_action = enumName(postEnum(), POST_NAMES, om.postRenderAction);
    } catch (e2) {}
    try {
      out.include_source_xmp = om.includeSourceXMP === true;
    } catch (e3) {}
    if (withSettings) {
      var d = dumpSettings(om);
      out.settings = d.settings;
      if (d.error) out.settings_error = d.error;
      if (d.truncated) out.settings_truncated = true;
    }
    return out;
  }

  function readItem(rq, i, withSettings) {
    var it = rq.item(i);
    var comp = it.comp;
    var out = {
      index: i,
      comp_id: comp.id,
      comp_name: comp.name,
      comp_width: comp.width,
      comp_height: comp.height,
      comp_duration: comp.duration,
      comp_frame_rate: comp.frameRate,
      work_area_start: comp.workAreaStart,
      work_area_duration: comp.workAreaDuration,
      status: statusName(it.status),
      render: it.render === true
    };
    try {
      out.time_span_start = it.timeSpanStart;
      out.time_span_duration = it.timeSpanDuration;
    } catch (e1) {}
    try {
      out.skip_frames = it.skipFrames;
    } catch (e2) {}
    try {
      out.log_type = enumName(logEnum(), LOG_NAMES, it.logType);
    } catch (e3) {}
    out.num_output_modules = it.numOutputModules;
    var mods = [];
    var o;
    for (o = 1; o <= it.numOutputModules && o <= MAX_MODULES; o++) {
      try {
        mods.push(readModule(it, o, withSettings));
      } catch (e4) {
        mods.push({ index: o, error: msgOf(e4) });
      }
    }
    out.output_modules = mods;
    if (it.numOutputModules > MAX_MODULES) out.output_modules_truncated = true;
    if (withSettings) {
      var d = dumpSettings(it);
      out.render_settings = d.settings;
      if (d.error) out.render_settings_error = d.error;
      if (d.truncated) out.render_settings_truncated = true;
    }
    return out;
  }

  // args: item_indexes (default all), settings (dump the settings for every item read), settings_indexes (dump them only for these), include_templates.
  A.rqeditRead = function (args) {
    args = args || {};
    var rq = app.project.renderQueue;
    var total = rq.numItems;
    var wanted = [];
    var i;
    if (args.item_indexes && args.item_indexes.length) {
      for (i = 0; i < args.item_indexes.length; i++) {
        var n = args.item_indexes[i];
        if (typeof n !== "number" || n < 1 || n > total || n !== Math.floor(n)) {
          fail("not_found", "No render queue item " + n + " (the queue has " + total + ")");
        }
        wanted.push(n);
      }
    } else {
      for (i = 1; i <= total && i <= MAX_ITEMS; i++) wanted.push(i);
    }
    var items = [];
    var withSet = {};
    var si;
    if (args.settings_indexes && args.settings_indexes.length) {
      for (si = 0; si < args.settings_indexes.length; si++) withSet[args.settings_indexes[si]] = true;
    }
    for (i = 0; i < wanted.length; i++) {
      items.push(readItem(rq, wanted[i], args.settings === true || withSet[wanted[i]] === true));
    }
    var res = {
      numItems: total,
      rendering: rq.rendering === true,
      truncated: !(args.item_indexes && args.item_indexes.length) && total > MAX_ITEMS,
      items: items
    };
    // Templates are installed application-wide: listed once, from the first item read.
    if (args.include_templates === true && wanted.length > 0) {
      var first = rq.item(wanted[0]);
      res.render_settings_templates = templatesOf(first);
      res.output_module_templates = templatesOf(first.outputModule(1));
    }
    return res;
  };

  // ---------- checks before the write ----------

  function itemAt(rq, index, compId) {
    if (typeof index !== "number" || index < 1 || index > rq.numItems || index !== Math.floor(index)) {
      fail("not_found", "No render queue item " + index + " (the queue has " + rq.numItems + ")");
    }
    var it = rq.item(index);
    if (compId !== undefined && compId !== null && it.comp.id !== compId) {
      fail("guard", "Render queue item " + index + " is comp " + it.comp.id + " (\"" + it.comp.name + "\"), not " + compId + ". The queue changed; read it again.", {
        expected: compId,
        actual: it.comp.id
      });
    }
    return it;
  }

  function requireIdle(rq) {
    if (rq.rendering === true) {
      fail("busy", "The Render Queue is rendering. Wait for it to finish or stop it first.");
    }
  }

  function requireNotRendering(it, index) {
    var running = statusEnumValue("RENDERING");
    if (running !== undefined && it.status === running) {
      fail("busy", "Render queue item " + index + " is rendering.");
    }
  }

  function statusEnumValue(name) {
    var E = statusEnum();
    if (E === null) return undefined;
    try {
      return E[name];
    } catch (e1) {}
    return undefined;
  }

  function isDone(it) {
    var d = statusEnumValue("DONE");
    return d !== undefined && it.status === d;
  }

  // Output paths of the queue's items that haven't rendered yet, as
  // { key: "item 2 module 1" }, leaving out `skipItem`'s own modules named in `skipModules` (null: all of that item's).
  function queuePaths(rq, skipItem, skipModules) {
    var taken = {};
    var i;
    var o;
    for (i = 1; i <= rq.numItems; i++) {
      var it = rq.item(i);
      if (isDone(it)) continue;
      for (o = 1; o <= it.numOutputModules; o++) {
        if (i === skipItem && (skipModules === null || skipModules[o] === true)) continue;
        var p = null;
        try {
          p = fsNameOf(it.outputModule(o));
        } catch (e1) {}
        if (p) taken[pathKey(p)] = "queue item " + i + " output " + o;
      }
    }
    return taken;
  }

  // A file the plan wants to set: absolute, not another queued item's, not
  // already on disk (unless allowed), not twice in the plan.
  function checkFile(p, currentPath, taken, allowOverwrite, where) {
    var key = pathKey(p);
    if (!isAbsolute(p)) fail("bad_args", where + ": the output file must be an absolute path, got \"" + p + "\"");
    if (hasOwn(taken, key)) {
      fail("bad_args", where + ": \"" + p + "\" is already the output of " + taken[key] + ". Two renders to one file overwrite each other.");
    }
    if (!allowOverwrite && !(currentPath && pathKey(currentPath) === key) && fileExists(p)) {
      fail("bad_args", where + ": \"" + p + "\" already exists on disk. Pick another name or pass allow_overwrite: true.");
    }
    taken[key] = where;
  }

  function checkKeys(dump, map, where, strict) {
    var bad = [];
    var k;
    for (k in map) {
      if (!hasOwn(map, k)) continue;
      if (lc(k) === "format") {
        fail("bad_args", where + ": \"Format\" is read-only in After Effects. Switch format with an output module template.");
      }
      if (dump.settings !== null && !hasOwn(dump.settings, k)) bad.push(k);
    }
    // A capped dump (settings_truncated) can lack a valid key: don't refuse on it.
    if (bad.length > 0 && strict && !dump.truncated) {
      fail(
        "bad_args",
        where + ": AE does not offer the setting(s) " + bad.join(", ") + " here. Settable keys: " + keysOf(dump.settings).slice(0, 60).join(", ") + ". Read them with ae_render_queue_inspect."
      );
    }
  }

  // Checks one plan against the queue and resolves it. `taken` holds the paths
  // already spoken for and gains this plan's.
  function validatePlan(rq, item, itemIndex, plan, taken, label) {
    var r = { time_span: null, log_type: null, post: {}, warnings: [] };
    var i;
    var t;
    var comp = item.comp;
    var count = item.numOutputModules;

    if (plan.item_template !== undefined && plan.item_template !== null) {
      if (!inList(templatesOf(item), plan.item_template)) {
        fail("bad_args", label + ": no render settings template named \"" + plan.item_template + "\". Installed: " + templatesOf(item).slice(0, 40).join(", "));
      }
    }
    if (plan.time_span !== undefined && plan.time_span !== null) {
      var s = 0;
      var d = comp.duration;
      if (plan.time_span === "work_area") {
        s = comp.workAreaStart;
        d = comp.workAreaDuration;
      } else if (plan.time_span !== "comp") {
        s = plan.time_span.start;
        d = plan.time_span.duration;
      }
      if (typeof s !== "number" || typeof d !== "number" || s < 0 || d <= 0) {
        fail("bad_args", label + ": the time span needs start >= 0 and duration > 0");
      }
      if (s + d > comp.duration + EPS) {
        fail("bad_args", label + ": the time span ends at " + (s + d) + " s, past the comp's end at " + comp.duration + " s");
      }
      r.time_span = { start: s, duration: d };
    }
    if (plan.skip_frames !== undefined && plan.skip_frames !== null) {
      if (typeof plan.skip_frames !== "number" || plan.skip_frames < 0 || plan.skip_frames > 99 || plan.skip_frames !== Math.floor(plan.skip_frames)) {
        fail("bad_args", label + ": skip_frames is a whole number from 0 to 99");
      }
    }
    if (plan.queued !== undefined && plan.queued !== null && typeof plan.queued !== "boolean") {
      fail("bad_args", label + ": queued is true or false");
    }
    if (plan.log_type !== undefined && plan.log_type !== null) {
      r.log_type = enumValue(logEnum(), LOG_NAMES, plan.log_type);
      if (r.log_type === null) fail("bad_args", label + ": log_type \"" + plan.log_type + "\" is not available in this AE");
    }
    if (plan.render_settings) {
      checkKeys(dumpSettings(item), plan.render_settings, label + " render settings", !plan.item_template && !plan.lenient);
    }

    var edited = {};
    var mods = plan.modules || [];
    for (i = 0; i < mods.length; i++) {
      var m = mods[i];
      var where = label + " output module " + m.index;
      if (typeof m.index !== "number" || m.index < 1 || m.index > count || m.index !== Math.floor(m.index)) {
        fail("bad_args", where + ": the item has " + count + " output module(s)");
      }
      if (edited[m.index] === true) fail("bad_args", where + " is listed twice");
      edited[m.index] = true;
      var om = item.outputModule(m.index);
      if (m.template !== undefined && m.template !== null && !inList(templatesOf(om), m.template)) {
        fail("bad_args", where + ": no output module template named \"" + m.template + "\". Installed: " + templatesOf(om).slice(0, 40).join(", "));
      }
      if (m.settings) {
        checkKeys(dumpSettings(om), m.settings, where, !m.template && !plan.lenient);
      }
      if (m.post_render_action !== undefined && m.post_render_action !== null) {
        t = enumValue(postEnum(), POST_NAMES, m.post_render_action);
        if (t === null) fail("bad_args", where + ": post_render_action \"" + m.post_render_action + "\" is not available in this AE");
        r.post[m.index] = t;
      }
    }

    var adds = plan.add_modules || [];
    var removes = plan.remove_modules || [];
    if (count + adds.length - removes.length < 1) {
      fail("bad_args", label + ": the item would be left with no output module");
    }
    if (count + adds.length > MAX_MODULES) fail("bad_args", label + ": at most " + MAX_MODULES + " output modules per item");
    var seen = {};
    for (i = 0; i < removes.length; i++) {
      var rm = removes[i];
      if (typeof rm !== "number" || rm < 1 || rm > count || rm !== Math.floor(rm)) {
        fail("bad_args", label + ": cannot remove output module " + rm + "; the item has " + count);
      }
      if (seen[rm] === true) fail("bad_args", label + ": output module " + rm + " is listed twice for removal");
      if (edited[rm] === true) fail("bad_args", label + ": output module " + rm + " is both edited and removed");
      seen[rm] = true;
    }
    for (i = 0; i < adds.length; i++) {
      var a = adds[i];
      var whereAdd = label + " new output module " + (i + 1);
      if (a.template !== undefined && a.template !== null && !inList(templatesOf(item.outputModule(1)), a.template)) {
        fail("bad_args", whereAdd + ": no output module template named \"" + a.template + "\"");
      }
      if (a.post_render_action !== undefined && a.post_render_action !== null && enumValue(postEnum(), POST_NAMES, a.post_render_action) === null) {
        fail("bad_args", whereAdd + ": post_render_action \"" + a.post_render_action + "\" is not available in this AE");
      }
      if (a.settings) {
        var k;
        for (k in a.settings) {
          if (hasOwn(a.settings, k) && lc(k) === "format") {
            fail("bad_args", whereAdd + ": \"Format\" is read-only in After Effects. Switch format with an output module template.");
          }
        }
      }
    }

    // Files: the modules this plan replaces free their old paths; the rest stay taken.
    var own = {};
    var o;
    for (o = 1; o <= count; o++) {
      var cur = fsNameOf(item.outputModule(o));
      own[o] = cur;
      if (cur && !(edited[o] === true && mods.length > 0 && fileOf(mods, o))) {
        if (!isDone(item)) taken[pathKey(cur)] = label + " output " + o;
      }
    }
    for (i = 0; i < mods.length; i++) {
      if (mods[i].file) checkFile(mods[i].file, own[mods[i].index], taken, plan.allow_overwrite === true, label + " output module " + mods[i].index);
    }
    for (i = 0; i < adds.length; i++) {
      if (adds[i].file) checkFile(adds[i].file, null, taken, plan.allow_overwrite === true, label + " new output module " + (i + 1));
    }
    return r;
  }

  function fileOf(mods, index) {
    var i;
    for (i = 0; i < mods.length; i++) {
      if (mods[i].index === index && mods[i].file) return mods[i].file;
    }
    return null;
  }

  // ---------- doing the plan (inside A.withUndo) ----------

  function newReport() {
    return { applied: [], skipped: [], errors: [], warnings: [] };
  }

  function step(rep, label, fn) {
    try {
      fn();
      rep.applied.push(label);
    } catch (e1) {
      rep.errors.push({ step: label, message: msgOf(e1) });
    }
  }

  // One key at a time, with a fresh dump each time: a key can appear once
  // another is set (Resize to after Resize), and a failing key leaves the rest alone.
  // `optional` names keys the plan only asks for by default (a delivery spec's channels or audio
  // rate): when AE does not offer one for the format, the skip is a note (optional: true), not a failure.
  function applySettings(rep, label, getTarget, map, optional) {
    var k;
    for (k in map) {
      if (!hasOwn(map, k)) continue;
      var dump = null;
      try {
        dump = dumpSettings(getTarget());
      } catch (eT) {
        rep.errors.push({ step: label + ": " + k, message: msgOf(eT) });
        continue;
      }
      if (dump.settings !== null && !dump.truncated && !hasOwn(dump.settings, k)) {
        var note = { where: label, key: k, reason: "AE does not offer this setting for the current format" };
        if (inList(optional || [], k)) {
          note.optional = true;
          note.reason = "AE does not offer this setting for the current format; the spec's value does not change the result there, so nothing was set";
        }
        rep.skipped.push(note);
        continue;
      }
      var val = mirror(dump.settings === null ? undefined : dump.settings[k], map[k]);
      var one = {};
      one[k] = val;
      try {
        getTarget().setSettings(one);
        rep.applied.push(label + ": " + k);
      } catch (e1) {
        rep.errors.push({ step: label + ": " + k, message: msgOf(e1) });
      }
    }
  }

  function warnFolder(rep, p) {
    try {
      var f = new File(p);
      if (f.parent && f.parent.exists === false) rep.warnings.push("The folder of " + p + " does not exist; create it before rendering.");
    } catch (e1) {}
  }

  function doModule(rep, getItem, idx, m, resolvedPost, label) {
    var getOm = function () {
      return getItem().outputModule(idx);
    };
    if (m.template) {
      step(rep, label + ": template " + m.template, function () {
        getOm().applyTemplate(m.template);
      });
    }
    if (m.settings) applySettings(rep, label, getOm, m.settings, m.optional_keys);
    if (m.file) {
      step(rep, label + ": file", function () {
        getOm().file = new File(m.file);
      });
      warnFolder(rep, m.file);
    }
    if (resolvedPost !== undefined && resolvedPost !== null) {
      step(rep, label + ": post-render action " + m.post_render_action, function () {
        getOm().postRenderAction = resolvedPost;
      });
    }
    if (m.include_source_xmp !== undefined && m.include_source_xmp !== null) {
      step(rep, label + ": include source XMP", function () {
        getOm().includeSourceXMP = m.include_source_xmp === true;
      });
    }
  }

  function doPlan(rq, itemIndex, plan, r, rep, label) {
    var getItem = function () {
      return rq.item(itemIndex);
    };
    var i;
    if (plan.item_template) {
      step(rep, label + ": render settings template " + plan.item_template, function () {
        getItem().applyTemplate(plan.item_template);
      });
    }
    if (r.time_span !== null) {
      step(rep, label + ": time span", function () {
        var it = getItem();
        // Moving the start later first shortens the span, so AE doesn't clamp it.
        if (r.time_span.start <= it.timeSpanStart) {
          it.timeSpanStart = r.time_span.start;
          it.timeSpanDuration = r.time_span.duration;
        } else {
          it.timeSpanDuration = r.time_span.duration;
          it.timeSpanStart = r.time_span.start;
        }
      });
    }
    if (plan.skip_frames !== undefined && plan.skip_frames !== null) {
      step(rep, label + ": skip frames", function () {
        getItem().skipFrames = plan.skip_frames;
      });
    }
    if (r.log_type !== null) {
      step(rep, label + ": log type", function () {
        getItem().logType = r.log_type;
      });
    }
    if (plan.render_settings) applySettings(rep, label + " render settings", getItem, plan.render_settings);

    var mods = plan.modules || [];
    for (i = 0; i < mods.length; i++) {
      doModule(rep, getItem, mods[i].index, mods[i], r.post[mods[i].index], label + " output module " + mods[i].index);
    }
    var adds = plan.add_modules || [];
    var added = [];
    for (i = 0; i < adds.length; i++) {
      var made = null;
      try {
        getItem().outputModules.add();
        made = getItem().numOutputModules;
        added.push(made);
        rep.applied.push(label + ": output module " + made + " added");
      } catch (e1) {
        rep.errors.push({ step: label + ": add output module", message: msgOf(e1) });
      }
      if (made !== null) {
        var post = null;
        if (adds[i].post_render_action) post = enumValue(postEnum(), POST_NAMES, adds[i].post_render_action);
        doModule(rep, getItem, made, adds[i], post, label + " output module " + made);
      }
    }
    // Highest index first, so the numbers of the rest hold.
    var removes = (plan.remove_modules || []).slice(0);
    removes.sort(function (a, b) {
      return b - a;
    });
    for (i = 0; i < removes.length; i++) {
      (function (idx) {
        step(rep, label + ": output module " + idx + " removed", function () {
          getItem().outputModule(idx).remove();
        });
      })(removes[i]);
    }
    // The Render checkbox last: with the output files set above, a QUEUED item
    // keeps a valid output (an item without one reads back NEEDS_OUTPUT).
    if (plan.queued !== undefined && plan.queued !== null) {
      step(rep, label + ": queued " + (plan.queued === true), function () {
        getItem().render = plan.queued === true;
      });
    }
    return added;
  }

  // What the item should read back as after the plan, for the server's receipt.
  function moduleEcho(index, m, planIndex) {
    var e = { index: index, plan_index: planIndex };
    if (m.file) e.file = m.file;
    if (m.settings) e.settings = m.settings;
    if (m.post_render_action) e.post_render_action = m.post_render_action;
    if (m.include_source_xmp !== undefined && m.include_source_xmp !== null) e.include_source_xmp = m.include_source_xmp === true;
    return e;
  }

  // Removals run last and the modules above a removed one move down: the
  // index a module has once the plan is done.
  function finalIndex(plan, index) {
    var removes = plan.remove_modules || [];
    var n = 0;
    var i;
    for (i = 0; i < removes.length; i++) {
      if (removes[i] < index) n++;
    }
    return index - n;
  }

  function finalAdded(plan, added) {
    var out = [];
    var i;
    for (i = 0; i < added.length; i++) out.push(finalIndex(plan, added[i]));
    return out;
  }

  function planEcho(plan, r, added, baseCount) {
    var out = { modules: [], num_output_modules: baseCount + added.length - (plan.remove_modules || []).length };
    var i;
    if (r.time_span !== null) out.time_span = r.time_span;
    if (plan.skip_frames !== undefined && plan.skip_frames !== null) out.skip_frames = plan.skip_frames;
    if (plan.log_type) out.log_type = lc(plan.log_type);
    if (plan.queued !== undefined && plan.queued !== null) out.queued = plan.queued === true;
    if (plan.render_settings) out.render_settings = plan.render_settings;
    var mods = plan.modules || [];
    for (i = 0; i < mods.length; i++) out.modules.push(moduleEcho(finalIndex(plan, mods[i].index), mods[i], mods[i].index));
    var adds = plan.add_modules || [];
    for (i = 0; i < adds.length && i < added.length; i++) out.modules.push(moduleEcho(finalIndex(plan, added[i]), adds[i], added[i]));
    return out;
  }

  // ---------- rqeditEdit ----------

  function unset(v) {
    return v === undefined || v === null;
  }

  function nonEmpty(v) {
    return isArr(v) && v.length > 0;
  }

  // True when the queued flag is the only change asked for.
  function onlyQueued(plan) {
    if (unset(plan.queued)) return false;
    if (!unset(plan.item_template) || !unset(plan.time_span) || !unset(plan.skip_frames) || !unset(plan.log_type) || !unset(plan.render_settings)) return false;
    return !nonEmpty(plan.modules) && !nonEmpty(plan.add_modules) && !nonEmpty(plan.remove_modules);
  }

  A.rqeditEdit = function (args) {
    assertGuard(args.expect);
    var rq = app.project.renderQueue;
    requireIdle(rq);
    var item = itemAt(rq, args.item_index, args.item_comp_id);
    requireNotRendering(item, args.item_index);
    var label = "Render queue item " + args.item_index;
    // AE locks a finished item's render settings and output modules.
    if (isDone(item)) {
      fail("bad_args", label + " is DONE: After Effects locks the render settings and output modules of a finished item. Duplicate it with ae_render_queue_duplicate to get a new render you can edit.");
    }
    var taken = queuePaths(rq, args.item_index, null);
    var r = validatePlan(rq, item, args.item_index, args, taken, label);
    var rep = newReport();
    var added = [];
    var baseCount = item.numOutputModules;
    // Read before the write: setSettings can invalidate the item object.
    var compId = item.comp.id;
    // Only the queued flag asked for, and the item already has it: nothing to write, no undo group.
    if (onlyQueued(args) && item.render === (args.queued === true)) {
      return {
        item_index: args.item_index,
        comp_id: compId,
        steps_done: [],
        skipped: [],
        errors: [],
        warnings: [label + " is already " + (args.queued === true ? "queued" : "unqueued") + "; nothing changed."],
        added_modules: [],
        removed_modules: [],
        no_op: true,
        expect: planEcho(args, r, added, baseCount)
      };
    }
    A.withUndo(args.label || "Chroma AE MCP: edit render queue item", function () {
      added = doPlan(rq, args.item_index, args, r, rep, label);
    });
    // Not named `applied`: the server's receipt envelope has its own.
    return {
      item_index: args.item_index,
      comp_id: compId,
      steps_done: rep.applied,
      skipped: rep.skipped,
      errors: rep.errors,
      warnings: rep.warnings,
      added_modules: finalAdded(args, added),
      removed_modules: args.remove_modules || [],
      expect: planEcho(args, r, added, baseCount)
    };
  };

  // ---------- rqeditRemove ----------

  var REMOVE_STATUSES = ["done", "user_stopped", "err_stopped", "unqueued", "queued", "needs_output"];

  function removalRow(it, index) {
    return { index: index, comp_id: it.comp.id, comp_name: String(it.comp.name), status: statusName(it.status) };
  }

  // args: remove ([{ index, comp_id }]) or remove_filter ({ status, comp_id? }),
  // dry_run, expect. Every index is resolved against the queue as it is now and
  // the items are removed highest index first, so the numbers of the rest hold.
  A.rqeditRemove = function (args) {
    assertGuard(args.expect);
    var rq = app.project.renderQueue;
    requireIdle(rq);
    var hasList = nonEmpty(args.remove);
    var hasFilter = !unset(args.remove_filter);
    if (hasList === hasFilter) {
      fail("bad_args", "Give either remove (a list of { index, comp_id }) or remove_filter, not both and not neither.");
    }
    var total = rq.numItems;
    var targets = [];
    var isTarget = {};
    var i;
    if (hasList) {
      if (args.remove.length > MAX_ITEMS) fail("bad_args", "At most " + MAX_ITEMS + " items can be removed at once");
      for (i = 0; i < args.remove.length; i++) {
        var r = args.remove[i];
        if (!r || typeof r.comp_id !== "number") {
          fail("bad_args", "Removal " + (i + 1) + ": give comp_id with index, so a queue that shifted cannot remove the wrong item");
        }
        var it = itemAt(rq, r.index, r.comp_id);
        if (isTarget[r.index] === true) fail("bad_args", "Render queue item " + r.index + " is listed twice");
        requireNotRendering(it, r.index);
        isTarget[r.index] = true;
        targets.push(removalRow(it, r.index));
      }
    } else {
      var f = args.remove_filter;
      var want = lc(f.status);
      if (!inList(REMOVE_STATUSES, want)) {
        fail("bad_args", "remove_filter.status \"" + f.status + "\" is not one of " + REMOVE_STATUSES.join(", "));
      }
      // The filter reads every item (a status read is cheap), so items past MAX_ITEMS are not skipped silently.
      for (i = 1; i <= total; i++) {
        var cand = rq.item(i);
        if (statusName(cand.status) !== want) continue;
        if (!unset(f.comp_id) && cand.comp.id !== f.comp_id) continue;
        isTarget[i] = true;
        targets.push(removalRow(cand, i));
      }
      if (targets.length > MAX_ITEMS) {
        fail("bad_args", "remove_filter matches " + targets.length + " items; at most " + MAX_ITEMS + " can be removed at once. Narrow the filter (comp_id) or remove in steps.");
      }
    }
    var survivors = [];
    for (i = 1; i <= total && i <= MAX_ITEMS; i++) {
      if (isTarget[i] !== true) survivors.push(rq.item(i).comp.id);
    }
    if (args.dry_run === true) {
      return {
        dry_run: true,
        no_op: true,
        would_remove: targets,
        num_items: total,
        num_items_after: total - targets.length,
        removed: [],
        errors: []
      };
    }
    if (targets.length === 0) {
      return {
        no_op: true,
        removed: [],
        errors: [],
        num_items_before: total,
        warnings: ["No render queue item matched; nothing changed."],
        expect: { num_items: total, survivor_comp_ids: survivors }
      };
    }
    var order = targets.slice(0);
    order.sort(function (a, b) {
      return b.index - a.index;
    });
    var done = [];
    var errors = [];
    A.withUndo(args.label || "Chroma AE MCP: remove render queue items", function () {
      var n;
      for (n = 0; n < order.length; n++) {
        try {
          rq.item(order[n].index).remove();
          done.push(order[n]);
        } catch (e1) {
          errors.push({ step: "Remove render queue item " + order[n].index, message: msgOf(e1) });
        }
      }
    });
    done.sort(function (a, b) {
      return a.index - b.index;
    });
    // The surviving comps in order are only known exactly when every removal worked (a failed one stays in the queue).
    var exactSurvivors = null;
    if (errors.length === 0 && total <= MAX_ITEMS) exactSurvivors = survivors;
    return {
      removed: done,
      errors: errors,
      num_items_before: total,
      expect: { num_items: total - done.length, survivor_comp_ids: exactSurvivors }
    };
  };

  // ---------- rqeditDuplicate ----------

  function sigsOf(rq) {
    var out = [];
    var i;
    for (i = 1; i <= rq.numItems; i++) {
      var p = "";
      var cid = "";
      var st = "";
      try {
        var it = rq.item(i);
        cid = String(it.comp.id);
        st = String(it.status);
        p = fsNameOf(it.outputModule(1)) || "";
      } catch (e1) {}
      out.push(cid + "|" + p + "|" + st);
    }
    return out;
  }

  // Where duplicate() put the copy, by the queue's signatures: the first place
  // it differs from before (the end when nothing before changed). 0 when the
  // copy looks exactly like its neighbour and the place can't be told.
  function insertedAt(before, after) {
    var i;
    for (i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) return i + 1;
    }
    if (before.length > 0 && before[before.length - 1] === after[after.length - 1]) return 0;
    return after.length;
  }

  // Where the copy is: it is tagged through its comment (the original comment
  // is put back), so identical-looking items can't be mixed up. Falls back to
  // the signatures when the comment can't be written. 0: not found.
  function locateCopy(rq, dup, before, tag) {
    var marked = false;
    var old = "";
    var found = 0;
    var i;
    try {
      old = dup.comment;
      dup.comment = tag;
      marked = true;
    } catch (e1) {
      marked = false;
    }
    if (marked) {
      try {
        for (i = 1; i <= rq.numItems; i++) {
          if (rq.item(i).comment === tag) {
            found = i;
            break;
          }
        }
      } catch (e2) {
        found = 0;
      }
      try {
        if (found > 0) rq.item(found).comment = old;
        else dup.comment = old;
      } catch (e3) {}
      if (found > 0) return found;
    }
    return insertedAt(before, sigsOf(rq));
  }

  function shiftIndexes(entries, at) {
    var i;
    for (i = 0; i < entries.length; i++) {
      if (typeof entries[i].item_index === "number" && entries[i].item_index >= at) entries[i].item_index++;
    }
  }

  // The first _copyN (from `start`) whose derived paths are free in the queue and on disk, for the modules that don't get an explicit file.
  function freeCopyNumber(srcFiles, taken, firstExplicit, start) {
    var n;
    var o;
    var ok;
    var p;
    for (n = start; n <= start + 999; n++) {
      ok = true;
      for (o = 0; o < srcFiles.length; o++) {
        if (!srcFiles[o]) continue;
        if (o === 0 && firstExplicit) continue;
        p = suffixPath(srcFiles[o], "_copy" + n);
        if (hasOwn(taken, pathKey(p)) || fileExists(p)) {
          ok = false;
          break;
        }
      }
      if (ok) return n;
    }
    return start;
  }

  A.rqeditDuplicate = function (args) {
    assertGuard(args.expect);
    var rq = app.project.renderQueue;
    requireIdle(rq);
    var src = itemAt(rq, args.item_index, args.item_comp_id);
    requireNotRendering(src, args.item_index);
    var copies = args.copies || [];
    if (copies.length < 1 || copies.length > MAX_COPIES) fail("bad_args", "copies takes 1 to " + MAX_COPIES + " entries");
    if (rq.numItems + copies.length > MAX_ITEMS) fail("bad_args", "The queue would pass " + MAX_ITEMS + " items");
    var count = src.numOutputModules;
    var srcCompId = src.comp.id;
    var srcFiles = [];
    var o;
    for (o = 1; o <= count; o++) srcFiles.push(fsNameOf(src.outputModule(o)));
    var taken = queuePaths(rq, -1, null);
    var plans = [];
    var i;
    for (i = 0; i < copies.length; i++) {
      var c = copies[i];
      var label = "Copy " + (i + 1);
      // A template can change the container; the source's path would keep its old extension (or lack the frame number).
      if (c.output_module_template && !c.file) {
        fail("bad_args", label + ": give a file together with output_module_template (the format decides the extension and a PNG sequence needs [#####]).");
      }
      var copyNo = freeCopyNumber(srcFiles, taken, !!c.file, i + 1);
      var plan = {
        item_template: c.render_settings_template,
        render_settings: c.render_settings,
        time_span: c.time_span,
        skip_frames: c.skip_frames,
        log_type: c.log_type,
        modules: [],
        allow_overwrite: args.allow_overwrite === true
      };
      // Module 1 takes the copy's own template, file and settings; every module gets its own path.
      for (o = 1; o <= count; o++) {
        var file = null;
        if (o === 1 && c.file) file = c.file;
        else if (srcFiles[o - 1]) file = suffixPath(srcFiles[o - 1], "_copy" + copyNo);
        var mod = { index: o, file: file };
        if (o === 1) {
          mod.template = c.output_module_template;
          mod.settings = c.settings;
          mod.post_render_action = c.post_render_action;
        }
        plan.modules.push(mod);
      }
      // The copy starts with the source's modules, so its own paths replace those.
      var scratch = {};
      var k;
      for (k in taken) {
        if (hasOwn(taken, k)) scratch[k] = taken[k];
      }
      var res = validateCopy(rq, src, plan, scratch, label);
      taken = scratch;
      plans.push({ plan: plan, resolved: res });
    }

    var written = [];
    var topLevelErrors = [];
    A.withUndo(args.label || "Chroma AE MCP: duplicate render queue item", function () {
      var srcIdx = args.item_index;
      var n;
      for (n = 0; n < plans.length; n++) {
        var rep = newReport();
        var entry = { copy: n + 1, item_index: null };
        var before = sigsOf(rq);
        var dup = null;
        try {
          dup = rq.item(srcIdx).duplicate();
        } catch (e1) {
          topLevelErrors.push({ step: "Copy " + (n + 1) + ": duplicate", message: msgOf(e1) });
        }
        if (dup === null) {
          written.push(entry);
          continue;
        }
        var at = locateCopy(rq, dup, before, "chroma-ae-mcp-copy-" + (n + 1) + "-" + String(new Date().getTime()));
        if (at < 1) {
          topLevelErrors.push({ step: "Copy " + (n + 1) + ": locate the copy", message: "The copy was made but its place in the queue could not be told from its neighbours, so its settings were not applied. Read the queue and edit it." });
          written.push(entry);
          continue;
        }
        // Copies already made at or after this place move down by one.
        shiftIndexes(written, at);
        entry.item_index = at;
        // A copy that lands at or before the source pushes the source down.
        if (at <= srcIdx) srcIdx++;
        var addedCopy = doPlan(rq, at, plans[n].plan, plans[n].resolved, rep, "Copy " + (n + 1));
        entry.expect = planEcho(plans[n].plan, plans[n].resolved, addedCopy, count);
        entry.applied = rep.applied;
        entry.skipped = rep.skipped;
        entry.errors = rep.errors;
        entry.warnings = rep.warnings;
        written.push(entry);
      }
    });
    return { source_index: args.item_index, comp_id: srcCompId, copies: written, errors: topLevelErrors };
  };

  // validatePlan for a copy that doesn't exist yet: the source stands in
  // (same templates, same modules), and its own paths are not "taken" by the copy.
  function validateCopy(rq, src, plan, taken, label) {
    return validatePlan(rq, src, -1, plan, taken, label);
  }

  // ---------- delivery specs ----------

  function matchTemplate(candidates, installed) {
    var c;
    var i;
    for (c = 0; c < candidates.length; c++) {
      var re = null;
      try {
        re = new RegExp(candidates[c].pattern, candidates[c].flags || "");
      } catch (e1) {
        re = null;
      }
      if (re === null) continue;
      for (i = 0; i < installed.length; i++) {
        if (re.test(installed[i])) return { name: installed[i], rank: c };
      }
    }
    return null;
  }

  // Why a spec can't be applied to a comp on this AE, or null; plus the template it would use.
  function specVerdict(spec, installed, comp, allowStretch) {
    var v = { refusal: null, template: null, template_rank: null, warnings: [] };
    if (spec.refuse) {
      v.refusal = spec.refuse;
      return v;
    }
    if (installed === null) {
      v.warnings.push("The output module templates can't be read (the Render Queue is empty), so the template is not checked.");
    } else {
      var hit = matchTemplate(spec.template_candidates || [], installed);
      if (hit === null) {
        v.refusal = "No installed output module template fits " + spec.label + ". Installed: " + installed.slice(0, 40).join(", ");
        return v;
      }
      v.template = hit.name;
      v.template_rank = hit.rank;
      if (hit.rank > 0) v.warnings.push("The preferred template for " + spec.label + " is not installed; using \"" + hit.name + "\".");
    }
    if (spec.resize && comp) {
      var want = spec.resize.width / spec.resize.height;
      var have = comp.width / comp.height;
      if (Math.abs(have - want) / want > 0.01) {
        if (!allowStretch) {
          v.refusal =
            "The comp is " + comp.width + "x" + comp.height + " and " + spec.label + " is " + spec.resize.width + "x" + spec.resize.height +
            ": resizing would stretch the picture. Reframe the comp first (ae_reframe) or pass allow_stretch: true.";
          return v;
        }
        v.warnings.push("The comp's aspect ratio differs from " + spec.resize.width + "x" + spec.resize.height + "; the picture will stretch.");
      } else if (comp.width < spec.resize.width) {
        v.warnings.push("The comp is smaller than " + spec.resize.width + "x" + spec.resize.height + "; the output is scaled up.");
      }
    }
    return v;
  }

  // args: specs (library entries), item_index (whose templates to use), comp_id.
  A.rqeditSpecs = function (args) {
    var rq = app.project.renderQueue;
    var installed = null;
    var comp = null;
    var source = "none";
    if (args.item_index !== undefined && args.item_index !== null) {
      var it = itemAt(rq, args.item_index, undefined);
      installed = templatesOf(it.outputModule(1));
      comp = it.comp;
      source = "queue item " + args.item_index;
    } else if (rq.numItems > 0) {
      installed = templatesOf(rq.item(1).outputModule(1));
      comp = rq.item(1).comp;
      source = "queue item 1";
    }
    if (args.comp_id !== undefined && args.comp_id !== null) {
      var found = null;
      try {
        found = app.project.itemByID(args.comp_id);
      } catch (e1) {
        found = null;
      }
      if (!found || !(found instanceof CompItem)) fail("not_found", "No CompItem with id " + args.comp_id);
      comp = found;
    }
    var out = [];
    var i;
    for (i = 0; i < (args.specs || []).length; i++) {
      var spec = args.specs[i];
      var v = specVerdict(spec, installed, comp, false);
      out.push({
        id: spec.id,
        feasible: v.refusal === null,
        refusal: v.refusal,
        template: v.template,
        template_is_preferred: v.template_rank === 0,
        warnings: v.warnings
      });
    }
    return {
      templates_known: installed !== null,
      templates_from: source,
      output_module_templates: installed,
      comp: comp ? { id: comp.id, name: comp.name, width: comp.width, height: comp.height } : null,
      specs: out
    };
  };

  // ---------- rqeditApplySpec ----------

  function dateStamp() {
    var d = new Date();
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  function specFile(spec, comp, folder, nameTemplate, copyNo) {
    var tpl = nameTemplate;
    if (!tpl) tpl = spec.name_template;
    var w = comp.width;
    var h = comp.height;
    if (spec.resize) {
      w = spec.resize.width;
      h = spec.resize.height;
    }
    var name = expandName(tpl, { compName: safeName(comp.name), spec: spec.id, width: w, height: h, date: dateStamp(), copy: copyNo });
    // The spec's container decides the extension: another media extension is swapped for it.
    var em = /\.([A-Za-z0-9]{2,5})$/.exec(name);
    if (em && lc(em[1]) !== lc(spec.ext) && inList(MEDIA_EXTS, lc(em[1]))) {
      name = name.substring(0, name.length - em[0].length);
    }
    em = /\.([A-Za-z0-9]{2,5})$/.exec(name);
    var hasExt = em !== null && lc(em[1]) === lc(spec.ext);
    // A sequence always carries the frame token, before the extension.
    if (spec.sequence === true && !hasSeqToken(name)) {
      if (hasExt) name = name.replace(/(\.[A-Za-z0-9]{2,5})$/, "_[#####]$1");
      else name = name + "_[#####]";
    }
    if (!hasExt) name = name + "." + spec.ext;
    var base = String(folder).replace(/[\\\/]+$/, "");
    return base + "/" + name;
  }

  function specSettings(spec, comp) {
    var s = {};
    var any = false;
    if (spec.resize && !(comp.width === spec.resize.width && comp.height === spec.resize.height)) {
      s["Resize"] = true;
      s["Resize to"] = [spec.resize.width, spec.resize.height];
      any = true;
    } else if (spec.video_output !== false) {
      // Written explicitly: an earlier spec (or the item's own module) may have left Resize on.
      s["Resize"] = false;
      any = true;
    }
    if (spec.video_output !== undefined && spec.video_output !== null) {
      s["Video Output"] = spec.video_output === true;
      any = true;
    }
    if (spec.channels) {
      s["Channels"] = spec.channels;
      any = true;
    }
    if (spec.audio_sample_rate) {
      s["Audio Sample Rate"] = spec.audio_sample_rate;
      any = true;
    }
    if (spec.output_audio) {
      s["Output Audio"] = spec.output_audio;
      any = true;
    }
    if (!any) return null;
    return s;
  }

  // The spec keys AE may leave unset for the spec's format without changing what the spec promises:
  // plain RGB Channels (an H.264 template has no Channels key and is RGB anyway) and Resize: false (no
  // Resize key means nothing resizes). Everything else defines the delivery and stays a real mismatch
  // when AE does not offer it: Channels "RGB + Alpha", Output Audio, Audio Sample Rate, Video Output,
  // Resize on and Resize to. A key the caller passed in settings is never optional.
  // One more case, measured live in AE 26.2.1: no PNG template lists a Channels key at all, so an alpha
  // PNG is only reachable through a template whose name says alpha ("PNG + ALPHA"); for such a template
  // "RGB + Alpha" is carried by the template and is optional. A template without alpha in its name
  // (plain "PNG") cannot promise it, so there it stays a real mismatch.
  function specOptionalKeys(spec, comp, extra, template) {
    var base = specSettings(spec, comp);
    var out = [];
    var k;
    if (!base) return out;
    for (k in base) {
      if (!hasOwn(base, k)) continue;
      if (extra && hasOwn(extra, k)) continue;
      if (k === "Channels" && base[k] === "RGB") out.push(k);
      else if (k === "Channels" && base[k] === "RGB + Alpha" && template && /alpha/i.test(String(template))) out.push(k);
      else if (k === "Resize" && base[k] === false) out.push(k);
    }
    return out;
  }

  function mergeSettings(base, extra) {
    var out = {};
    var k;
    var any = false;
    if (base) {
      for (k in base) {
        if (hasOwn(base, k)) {
          out[k] = base[k];
          any = true;
        }
      }
    }
    if (extra) {
      for (k in extra) {
        if (hasOwn(extra, k)) {
          out[k] = extra[k];
          any = true;
        }
      }
    }
    if (!any) return null;
    return out;
  }

  // args: item_index, item_comp_id, specs (library entries, one per output),
  // in_place (the first spec edits the item itself, the rest duplicates; false:
  // every spec gets a duplicate and the item is left alone), output_folder,
  // file_name, allow_stretch, allow_overwrite, settings (extra output module settings for all).
  A.rqeditApplySpec = function (args) {
    assertGuard(args.expect);
    var rq = app.project.renderQueue;
    requireIdle(rq);
    var src = itemAt(rq, args.item_index, args.item_comp_id);
    requireNotRendering(src, args.item_index);
    var specs = args.specs || [];
    if (specs.length < 1 || specs.length > MAX_COPIES) fail("bad_args", "specs takes 1 to " + MAX_COPIES + " entries");
    if (src.numOutputModules !== 1) {
      fail("bad_args", "Render queue item " + args.item_index + " has " + src.numOutputModules + " output modules; a delivery spec needs exactly one. Remove the others with ae_render_queue_edit first.");
    }
    if (!args.output_folder || !isAbsolute(args.output_folder)) fail("bad_args", "output_folder must be an absolute path");
    // AE locks a finished item's settings: its specs go on duplicates.
    var srcDone = isDone(src);
    if (srcDone && args.in_place === true) {
      fail("bad_args", "Render queue item " + args.item_index + " is DONE and After Effects locks its render settings and output modules, so in_place: true cannot edit it. Leave in_place out (or false) to put every spec on a duplicate.");
    }
    var inPlace = args.in_place !== false && !srcDone;
    var comp = src.comp;
    var compIdNow = comp.id;
    var installed = templatesOf(src.outputModule(1));
    var currentFile = fsNameOf(src.outputModule(1));
    var taken = queuePaths(rq, args.item_index, inPlace ? null : {});
    if (!inPlace && currentFile && !isDone(src)) taken[pathKey(currentFile)] = "queue item " + args.item_index + " output 1";
    var prepared = [];
    var seen = {};
    var i;
    for (i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var label = "Spec " + spec.id;
      if (seen[spec.id] === true) fail("bad_args", label + " is listed twice");
      seen[spec.id] = true;
      var v = specVerdict(spec, installed, comp, args.allow_stretch === true);
      if (v.refusal !== null) fail("bad_args", label + ": " + v.refusal);
      var file = specFile(spec, comp, args.output_folder, args.file_name, i + 1);
      var plan = {
        modules: [
          {
            index: 1,
            template: v.template,
            settings: mergeSettings(specSettings(spec, comp), args.settings),
            optional_keys: specOptionalKeys(spec, comp, args.settings, v.template),
            file: file,
            post_render_action: args.post_render_action
          }
        ],
        lenient: true,
        allow_overwrite: args.allow_overwrite === true
      };
      var scratch = {};
      var k;
      for (k in taken) {
        if (hasOwn(taken, k)) scratch[k] = taken[k];
      }
      var res = validatePlan(rq, src, inPlace && i === 0 ? args.item_index : -1, plan, scratch, label);
      taken = scratch;
      prepared.push({ spec: spec, plan: plan, resolved: res, verdict: v, file: file });
    }

    var results = [];
    A.withUndo(args.label || "Chroma AE MCP: apply delivery specs", function () {
      var srcIdx = args.item_index;
      var n;
      for (n = 0; n < prepared.length; n++) {
        var p = prepared[n];
        var rep = newReport();
        var target = args.item_index;
        var entry = { spec_id: p.spec.id, item_index: null, in_place: false, template: p.verdict.template, file: p.file, warnings: p.verdict.warnings.slice(0) };
        if (!(inPlace && n === 0)) {
          var before = sigsOf(rq);
          var dup = null;
          try {
            dup = rq.item(srcIdx).duplicate();
          } catch (e1) {
            rep.errors.push({ step: "Spec " + p.spec.id + ": duplicate", message: msgOf(e1) });
          }
          if (dup === null) {
            entry.errors = rep.errors;
            entry.applied = [];
            entry.skipped = [];
            results.push(entry);
            continue;
          }
          target = locateCopy(rq, dup, before, "chroma-ae-mcp-spec-" + (n + 1) + "-" + String(new Date().getTime()));
          if (target < 1) {
            rep.errors.push({ step: "Spec " + p.spec.id + ": locate the copy", message: "The copy was made but its place in the queue could not be told from its neighbours, so the spec was not applied. Read the queue and edit it." });
            entry.errors = rep.errors;
            entry.applied = [];
            entry.skipped = [];
            results.push(entry);
            continue;
          }
          shiftIndexes(results, target);
          if (target <= srcIdx) srcIdx++;
        } else {
          entry.in_place = true;
        }
        entry.item_index = target;
        var addedSpec = doPlan(rq, target, p.plan, p.resolved, rep, "Spec " + p.spec.id);
        entry.expect = planEcho(p.plan, p.resolved, addedSpec, 1);
        entry.applied = rep.applied;
        entry.skipped = rep.skipped;
        entry.errors = rep.errors;
        entry.warnings = entry.warnings.concat(rep.warnings);
        results.push(entry);
      }
    });
    return { source_index: args.item_index, comp_id: compIdNow, in_place: inPlace, results: results };
  };

  // ---------- render (ae_render_queue_render) ----------

  function countStatus(rq, wanted) {
    var n = 0;
    var i;
    var want = statusEnumValue(wanted);
    if (want === undefined) return -1;
    for (i = 1; i <= rq.numItems; i++) {
      try {
        if (rq.item(i).status === want) n++;
      } catch (e1) {}
    }
    return n;
  }

  // ---------- render only chosen items: hold the others back, release them after ----------

  function filesOf(it) {
    var out = [];
    var o;
    for (o = 1; o <= it.numOutputModules && o <= MAX_MODULES; o++) {
      var f = null;
      try {
        f = fsNameOf(it.outputModule(o));
      } catch (e1) {}
      if (f === null || f === undefined) f = "";
      out.push(String(f));
    }
    return out;
  }

  function sameFiles(a, b) {
    var i;
    if (!isArr(a) || !isArr(b) || a.length !== b.length) return false;
    for (i = 0; i < a.length; i++) {
      if (String(a[i]) !== String(b[i])) return false;
    }
    return true;
  }

  function isStatus(it, name) {
    var v = statusEnumValue(name);
    return v !== undefined && it.status === v;
  }

  // Unchecks the Render box of the QUEUED items the caller listed in `hold` so that RenderQueue.render()
  // renders only the `keep` items. Everything is checked first (no write on a mismatch): not rendering, each kept
  // item QUEUED and holding its comp, each held item QUEUED at its index with its comp and output files, and no
  // QUEUED item outside both lists. One undo group. args: keep ([{ index, comp_id }]), hold ([{ index, comp_id, files }]).
  A.rqeditHold = function (args) {
    args = args || {};
    var rq = app.project.renderQueue;
    requireIdle(rq);
    var keep = args.keep || [];
    var hold = args.hold || [];
    var kept = {};
    var held = {};
    var i;
    var it;
    for (i = 0; i < keep.length; i++) {
      it = itemAt(rq, keep[i].index, keep[i].comp_id);
      if (!isStatus(it, "QUEUED")) {
        fail("bad_args", "Render queue item " + keep[i].index + " is not QUEUED, so it cannot be the one to render.");
      }
      kept[keep[i].index] = true;
    }
    for (i = 0; i < hold.length; i++) {
      var h = hold[i];
      if (kept[h.index] === true) {
        fail("bad_args", "Render queue item " + h.index + " is both to be rendered and to be held back.");
      }
      it = itemAt(rq, h.index, h.comp_id);
      if (!isStatus(it, "QUEUED")) {
        fail("guard", "Render queue item " + h.index + " is no longer QUEUED. The queue changed; read it again.");
      }
      if (!sameFiles(filesOf(it), h.files)) {
        fail("guard", "Render queue item " + h.index + " has other output files than when it was read. The queue changed; read it again.");
      }
      held[h.index] = true;
    }
    var n;
    for (n = 1; n <= rq.numItems; n++) {
      if (kept[n] !== true && held[n] !== true && isStatus(rq.item(n), "QUEUED")) {
        fail("guard", "Render queue item " + n + " became QUEUED after the queue was read. The queue changed; read it again.");
      }
    }
    if (hold.length === 0) {
      return { held: [], errors: [], no_op: true };
    }
    var done = [];
    var errors = [];
    A.withUndo("Chroma AE MCP: render only chosen queue items", function () {
      var k;
      for (k = 0; k < hold.length; k++) {
        try {
          rq.item(hold[k].index).render = false;
          done.push({ index: hold[k].index, comp_id: hold[k].comp_id, files: hold[k].files });
        } catch (e1) {
          errors.push("item " + hold[k].index + ": " + msgOf(e1));
        }
      }
    });
    return { held: done, errors: errors };
  };

  // Checks the Render box again on the items rqeditHold unchecked, but only those that still sit at their
  // index with the same comp and output files and are UNQUEUED. Anything else is left alone and reported.
  // Checks first, one undo group, no throw once it has written. args: items ([{ index, comp_id, files }]).
  A.rqeditRelease = function (args) {
    args = args || {};
    var rq = app.project.renderQueue;
    requireIdle(rq);
    var items = args.items || [];
    var restore = [];
    var skipped = [];
    var i;
    var n;
    for (i = 0; i < items.length; i++) {
      var h = items[i];
      var row = { index: h.index, comp_id: h.comp_id, files: h.files };
      var it = null;
      if (typeof h.index === "number" && h.index >= 1 && h.index <= rq.numItems) {
        it = rq.item(h.index);
      }
      var sameComp = false;
      if (it !== null) {
        try {
          sameComp = it.comp.id === h.comp_id;
        } catch (e1) {}
      }
      if (it !== null && sameComp) {
        if (isStatus(it, "QUEUED")) {
          // Queued again already (by the user, whatever its files are now): nothing to put back.
          row.code = "already_queued";
          row.reason = "it is already queued";
          skipped.push(row);
        } else if (!sameFiles(filesOf(it), h.files)) {
          row.code = "changed";
          row.reason = "its output file(s) changed";
          skipped.push(row);
        } else if (isStatus(it, "UNQUEUED")) {
          restore.push(row);
        } else {
          row.code = "changed";
          row.reason = "its status is now " + statusName(it.status);
          skipped.push(row);
        }
        continue;
      }
      // Not at its index with its comp: say whether the same item sits elsewhere.
      var now = 0;
      for (n = 1; n <= rq.numItems && now === 0; n++) {
        var other = rq.item(n);
        var match = false;
        try {
          match = other.comp.id === h.comp_id && sameFiles(filesOf(other), h.files) && isStatus(other, "UNQUEUED");
        } catch (e2) {}
        if (match) now = n;
      }
      if (now > 0) {
        row.code = "moved";
        row.reason = "it is now at index " + now;
        row.now_at = now;
      } else {
        row.code = "gone";
        row.reason = "no item with that comp and output file is left";
      }
      skipped.push(row);
    }
    var restored = [];
    var errors = [];
    if (restore.length === 0) {
      return { restored: restored, not_restored: skipped, errors: errors, no_op: true };
    }
    A.withUndo("Chroma AE MCP: queue the items held back from a render", function () {
      var k;
      for (k = 0; k < restore.length; k++) {
        try {
          rq.item(restore[k].index).render = true;
          restored.push(restore[k]);
        } catch (e3) {
          restore[k].code = "error";
          restore[k].reason = msgOf(e3);
          skipped.push(restore[k]);
          errors.push("item " + restore[k].index + ": " + msgOf(e3));
        }
      }
    });
    return { restored: restored, not_restored: skipped, errors: errors };
  };

  // Starts AE's own render of the queued items, the same as pressing Render.
  // RenderQueue.render() returns only when the render has ended (done, stopped
  // by the user, or an error), so the server calls this in one long evalScript
  // and reads the result in a separate one (rqeditRenderResult). No undo group:
  // a render is not undoable. Nothing here changes the project; the server has
  // already checked the queue and the output files.
  A.rqeditRender = function (args) {
    args = args || {};
    var rq = app.project.renderQueue;
    if (rq.rendering === true) {
      fail("busy", "The Render Queue is already rendering.");
    }
    var queued = countStatus(rq, "QUEUED");
    if (queued === 0) {
      fail("nothing_queued", "No Render Queue item is QUEUED.");
    }
    if (typeof args.expected_queued === "number" && queued !== args.expected_queued) {
      fail("guard", "Expected " + args.expected_queued + " QUEUED Render Queue item(s) but " + queued + " are QUEUED, so nothing was rendered. The queue changed after the others were held back.");
    }
    var started = new Date().getTime();
    rq.render();
    return { returned: true, queued_items: queued, elapsed_ms: new Date().getTime() - started };
  };

  // Read: can this AE hand the queue to Adobe Media Encoder? canQueueInAME is true only when queued items exist
  // and the AME command is available (AE Scripting Guide, RenderQueue.canQueueInAME, AE 14.0+). null = property missing.
  // app_path: Folder.appPackage.fsName (JavaScript Tools Guide: the folder holding the running application's executable), so the
  // server can look for an "Adobe Media Encoder*" folder beside After Effects' own install folder; null when it cannot be read.
  A.rqeditAmeState = function (args) {
    var rq = app.project.renderQueue;
    var can = null;
    var hasFn = false;
    var appPath = null;
    try {
      appPath = String(Folder.appPackage.fsName);
    } catch (e0) {
      appPath = null;
    }
    try {
      if (typeof rq.canQueueInAME !== "undefined") {
        can = rq.canQueueInAME === true;
      }
    } catch (e1) {}
    try {
      hasFn = typeof rq.queueInAME === "function" || typeof rq.queueInAME === "object";
    } catch (e2) {}
    return {
      can_queue_in_ame: can,
      has_queue_in_ame: hasFn,
      app_path: appPath,
      rendering: rq.rendering === true,
      queued: countStatus(rq, "QUEUED")
    };
  };

  // Hands the QUEUED items to Adobe Media Encoder (RenderQueue.queueInAME(args.start_now === true): false only queues them, true also starts AME's queue). It returns at
  // once: AME renders on its own and After Effects stays free. No undo group (the project is not changed by this call);
  // everything is checked before the call and nothing is thrown after it. args: start_now (boolean, default false), expected_queued (number, optional).
  A.rqeditQueueInAme = function (args) {
    args = args || {};
    var rq = app.project.renderQueue;
    if (rq.rendering === true) {
      fail("busy", "The Render Queue is already rendering.");
    }
    var can = false;
    try {
      can = rq.canQueueInAME === true;
    } catch (e1) {}
    if (can !== true) {
      fail("ame_unavailable", "canQueueInAME is not true (no QUEUED item, or Adobe Media Encoder is not available to this After Effects), so nothing was handed over.");
    }
    var queued = countStatus(rq, "QUEUED");
    if (typeof args.expected_queued === "number" && queued !== args.expected_queued) {
      fail("guard", "Expected " + args.expected_queued + " QUEUED Render Queue item(s) but " + queued + " are QUEUED, so nothing was handed over. The queue changed after the others were held back.");
    }
    var started = new Date().getTime();
    rq.queueInAME(args.start_now === true);
    return { called: true, start_now: args.start_now === true, queued_items: queued, elapsed_ms: new Date().getTime() - started };
  };

  // Item status, elapsed time and output files after a render. args: indexes (1-based queue indexes), comp_ids (the comp each index held when the render started).
  A.rqeditRenderResult = function (args) {
    args = args || {};
    var rq = app.project.renderQueue;
    var idx = args.indexes || [];
    var comps = args.comp_ids || [];
    var items = [];
    var i;
    for (i = 0; i < idx.length && i < MAX_ITEMS; i++) {
      var n = idx[i];
      var row = { index: n, comp_id: null, status: null, comp_matches: false };
      try {
        if (n < 1 || n > rq.numItems) {
          row.error = "No render queue item " + n + " (the queue has " + rq.numItems + ")";
          items.push(row);
          continue;
        }
        var it = rq.item(n);
        row.comp_id = it.comp.id;
        row.comp_name = String(it.comp.name);
        row.comp_matches = comps[i] === undefined || comps[i] === null || comps[i] === it.comp.id;
        row.status = statusName(it.status);
        try {
          row.elapsed_seconds = it.elapsedSeconds;
        } catch (e1) {}
        try {
          if (it.startTime) row.start_time_ms = it.startTime.getTime();
        } catch (e2) {}
        var mods = [];
        var o;
        for (o = 1; o <= it.numOutputModules && o <= MAX_MODULES; o++) {
          try {
            mods.push({ index: o, file: fsNameOf(it.outputModule(o)) });
          } catch (e3) {
            mods.push({ index: o, error: msgOf(e3) });
          }
        }
        row.output_modules = mods;
      } catch (e4) {
        row.error = msgOf(e4);
      }
      items.push(row);
    }
    return { rendering: rq.rendering === true, numItems: rq.numItems, items: items };
  };

  G.__chromaAe = A;
})($.global);
