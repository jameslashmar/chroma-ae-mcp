// panel/host/ext/projectsession.jsx
//
// Host functions for ae_project_session:
// - projectsessionRead (read): project path, dirty flag, item count, missing
//   footage, active item, and the project's crash-save flag
// - projectsessionOpen / projectsessionNew / projectsessionClose (writes):
//   open, create or close a project. They never hide AE's save prompt: a
//   project with unsaved changes needs an explicit answer (save or discard)
//   or the call returns needs_user and touches nothing
// - projectsessionPrefs (read): AE's Auto-Save preferences, found by probing
//   candidate section/key names (the real names are not documented)
// - projectsessionPrefsSet (write): changes only the Auto-Save keys that
//   projectsessionPrefs found
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Writes check the target guard first and validate everything before the project is touched.
// - Opening, closing and creating projects, and preference writes, are not
//   undoable, so they run outside an undo group.
// - Read-backs run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_STR = 20000;
  var MAX_SCAN = 20000;
  var MAX_MISSING_PATHS = 20;
  var MAX_PROBES = 20;

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

  function bound(s) {
    var t = String(s);
    if (t.length > MAX_STR) return t.substring(0, MAX_STR);
    return t;
  }

  function projectPath() {
    var f = null;
    try { f = app.project.file; } catch (e) { f = null; }
    if (!f) return "<unsaved>";
    return f.fsName;
  }

  // Project.dirty is undocumented (found by research): null when AE won't say.
  function readDirty() {
    try {
      var d = app.project.dirty;
      if (d === true) return true;
      if (d === false) return false;
    } catch (e) {}
    return null;
  }

  // ---------- read ----------

  // Missing footage is counted by looping over the items: the DOM has no count.
  // A placeholder also reports footageMissing; it is counted apart.
  function scanMissing() {
    var out = { count: 0, placeholders: 0, scanned: 0, truncated: false, paths: [] };
    var n = 0;
    try { n = app.project.numItems; } catch (e0) { n = 0; }
    var i;
    for (i = 1; i <= n; i++) {
      if (i > MAX_SCAN) {
        out.truncated = true;
        break;
      }
      var it = null;
      try { it = app.project.item(i); } catch (e1) { it = null; }
      if (!it) continue;
      out.scanned++;
      if (!(it instanceof FootageItem)) continue;
      var missing = false;
      try { missing = it.footageMissing === true; } catch (e2) { missing = false; }
      if (!missing) continue;
      var isPlaceholder = false;
      try { isPlaceholder = (it.mainSource instanceof PlaceholderSource); } catch (e3) { isPlaceholder = false; }
      if (isPlaceholder) {
        out.placeholders++;
        continue;
      }
      out.count++;
      if (out.paths.length < MAX_MISSING_PATHS) {
        var p = null;
        try { p = it.mainSource.missingFootagePath; } catch (e4) { p = null; }
        if (!p) {
          try { if (it.file) p = it.file.fsName; } catch (e5) { p = null; }
        }
        out.paths.push({ id: it.id, name: bound(it.name), path: p ? bound(p) : null });
      }
    }
    return out;
  }

  // The light read for the timed-save policy: path and dirty flag only.
  A.projectsessionState = function () {
    return { project_path: projectPath(), dirty: readDirty() };
  };

  A.projectsessionRead = function () {
    var out = {
      project_path: projectPath(),
      dirty: readDirty(),
      num_items: 0,
      missing_footage: null,
      active_item: null,
      save_project_on_crash: null,
      ae_version: null
    };
    try { out.num_items = app.project.numItems; } catch (e0) {}
    try { out.ae_version = String(app.version); } catch (e1) {}
    try { out.save_project_on_crash = app.saveProjectOnCrash === true; } catch (e2) {}
    out.missing_footage = scanMissing();
    try {
      var ai = app.project.activeItem;
      if (ai) out.active_item = { id: ai.id, name: bound(ai.name), kind: (ai instanceof CompItem) ? "comp" : "item" };
    } catch (e3) {}
    return out;
  };

  // ---------- open, new, close ----------

  function needsUser(reason, dirty, extra) {
    var out = {
      applied: false,
      no_op: true,
      needs_user: true,
      reason: reason,
      dirty: dirty,
      project_path: projectPath(),
      options: ["save", "discard", "cancel"],
      message:
        "The open project has unsaved changes (or After Effects would not say). Ask the user: save them, discard them, or cancel. " +
        "Then call again with if_dirty: 'save' or 'discard', or stop for 'cancel'."
    };
    if (extra) {
      for (var k in extra) {
        if (extra.hasOwnProperty(k)) out[k] = extra[k];
      }
    }
    return out;
  }

  // What to do with the open project before leaving it. Returns
  // { needs_user: {...} } when the user has to answer first, else { mode: CloseOptions }.
  // A clean project closes with PROMPT_TO_SAVE_CHANGES, which raises no prompt.
  // DO_NOT_SAVE_CHANGES is used only for an explicit if_dirty: "discard".
  // SAVE_CHANGES overwrites the file: the server copies it to _mcp_backups first.
  function leaveDecision(ifDirty, backupTaken) {
    var policy = ifDirty;
    if (policy === undefined || policy === null) policy = "ask";
    if (policy !== "ask" && policy !== "save" && policy !== "discard") {
      fail("bad_args", "if_dirty must be ask, save or discard");
    }
    var dirty = readDirty();
    if (dirty === false) {
      return { mode: CloseOptions.PROMPT_TO_SAVE_CHANGES, dirty: false, discarded: false, saved: false };
    }
    if (policy === "discard") {
      return { mode: CloseOptions.DO_NOT_SAVE_CHANGES, dirty: dirty, discarded: true, saved: false };
    }
    if (policy === "save") {
      var f = null;
      try { f = app.project.file; } catch (e0) { f = null; }
      if (!f) {
        return { needs_user: needsUser("The project has never been saved, so it has no file to save to. Save it once in After Effects (File > Save As), or discard it.", dirty) };
      }
      if (backupTaken !== true) {
        // The server copies the file before a save. If it did not (the project became
        // dirty after the server's read), SAVE_CHANGES would overwrite the file unbacked.
        return { needs_user: needsUser("The project changed after the backup check, so the file was not copied to _mcp_backups before saving. Nothing was changed: call again to retry with a backup, or ask the user.", dirty) };
      }
      return { mode: CloseOptions.SAVE_CHANGES, dirty: dirty, discarded: false, saved: true };
    }
    var why = "The open project has unsaved changes.";
    if (dirty === null) why = "After Effects would not say whether the open project has unsaved changes.";
    return { needs_user: needsUser(why, dirty) };
  }

  // Project.close returns false when the user cancels AE's own prompt.
  function closeProject(mode) {
    var r = true;
    try {
      r = app.project.close(mode);
    } catch (e) {
      return { ok: false, error: bound(e.message || String(e)) };
    }
    if (r === false) return { ok: false, cancelled: true };
    return { ok: true };
  }

  function state() {
    return { project_path: projectPath(), dirty: readDirty() };
  }

  // Opening, closing and creating projects open no undo group: no_op keeps the
  // server from recording a Ctrl+Z step for them.
  function withState(out) {
    out.no_op = true;
    var s = state();
    out.project_path = s.project_path;
    out.dirty = s.dirty;
    return out;
  }

  A.projectsessionOpen = function (args) {
    assertGuard(args ? args.expect : undefined);
    if (!args || typeof args.path !== "string" || args.path.length === 0) {
      fail("bad_args", "projectsessionOpen requires path");
    }
    if (!/\.aepx?$/i.test(args.path)) {
      fail("bad_args", "Only .aep and .aepx projects can be opened: " + args.path);
    }
    var target = new File(args.path);
    if (!target.exists) fail("not_found", "Project file does not exist: " + args.path);

    var decision = leaveDecision(args.if_dirty, args.backup_taken);
    if (decision.needs_user) return decision.needs_user;

    var previousFile = null;
    try { previousFile = app.project.file; } catch (ePrev) { previousFile = null; }
    var closed = closeProject(decision.mode);
    if (!closed.ok) {
      // Nothing was closed: AE's own prompt was cancelled, or close threw.
      return withState({
        applied: false,
        opened: false,
        cancelled: closed.cancelled === true,
        error: closed.error ? closed.error : null,
        message: "The open project was not closed, so nothing was opened."
      });
    }
    var proj = null;
    var err = null;
    try {
      proj = app.open(target);
    } catch (e) {
      err = bound(e.message || String(e));
    }
    var out = {
      applied: true,
      opened: !!proj,
      closed_previous: true,
      saved_previous: decision.saved,
      discarded_previous: decision.discarded,
      error: err
    };
    if (!proj && !err) {
      // app.open returns null when the user cancels a dialog it raised.
      out.cancelled = true;
    }
    if (!proj && previousFile && decision.discarded !== true) {
      // The old project is closed and its file is current (clean, or just saved): put it back.
      var restored = false;
      try {
        if (previousFile.exists) restored = !!app.open(previousFile);
      } catch (eRestore) {
        restored = false;
      }
      out.restored_previous = restored;
    }
    return withState(out);
  };

  A.projectsessionNew = function (args) {
    if (!args) args = {};
    assertGuard(args.expect);
    var decision = leaveDecision(args.if_dirty, args.backup_taken);
    if (decision.needs_user) return decision.needs_user;

    var closed = closeProject(decision.mode);
    if (!closed.ok) {
      return withState({
        applied: false,
        created: false,
        cancelled: closed.cancelled === true,
        error: closed.error ? closed.error : null,
        message: "The open project was not closed, so no new project was created."
      });
    }
    var proj = null;
    var err = null;
    try {
      proj = app.newProject();
    } catch (e) {
      err = bound(e.message || String(e));
    }
    return withState({
      applied: true,
      created: !!proj,
      closed_previous: true,
      saved_previous: decision.saved,
      discarded_previous: decision.discarded,
      error: err
    });
  };

  A.projectsessionClose = function (args) {
    if (!args) args = {};
    assertGuard(args.expect);
    var decision = leaveDecision(args.if_dirty, args.backup_taken);
    if (decision.needs_user) return decision.needs_user;

    var closed = closeProject(decision.mode);
    if (!closed.ok) {
      return withState({
        applied: false,
        closed: false,
        cancelled: closed.cancelled === true,
        error: closed.error ? closed.error : null,
        message: "The project was not closed."
      });
    }
    return withState({
      applied: true,
      closed: true,
      saved_previous: decision.saved,
      discarded_previous: decision.discarded
    });
  };

  // ---------- Auto-Save preferences ----------

  // The Auto-Save section and key names are not in the Scripting Guide. These
  // are the likely spellings; a field counts as found only when havePref says
  // so, and only found keys are ever written.
  // Pairs of section and key. The generic keys ("Enabled", "Interval",
  // "Maximum Versions") are tried only under the Auto-Save sections: under the
  // general "Main Pref Section" an unrelated preference could share the name,
  // and the set action would overwrite it. There only the prefixed keys count.
  var AUTO_SAVE_SECTIONS = ["Auto-Save", "Auto Save"];
  var GENERAL_SECTIONS = ["Main Pref Section"];
  var PREF_FIELDS = [
    { field: "enabled", prefixed: ["Auto-Save Enabled", "Auto Save Enabled"], generic: ["Enabled"], types: ["bool", "long"] },
    { field: "interval_minutes", prefixed: ["Auto-Save Interval", "Auto Save Interval"], generic: ["Interval"], types: ["long"] },
    { field: "max_versions", prefixed: ["Auto-Save Maximum Versions", "Auto Save Maximum Versions"], generic: ["Maximum Versions"], types: ["long"] }
  ];

  function fieldPairs(f) {
    var out = [];
    var s, k;
    for (s = 0; s < AUTO_SAVE_SECTIONS.length; s++) {
      for (k = 0; k < f.prefixed.length; k++) out.push({ section: AUTO_SAVE_SECTIONS[s], key: f.prefixed[k] });
      for (k = 0; k < f.generic.length; k++) out.push({ section: AUTO_SAVE_SECTIONS[s], key: f.generic[k] });
    }
    for (s = 0; s < GENERAL_SECTIONS.length; s++) {
      for (k = 0; k < f.prefixed.length; k++) out.push({ section: GENERAL_SECTIONS[s], key: f.prefixed[k] });
    }
    return out;
  }

  function prefTypes() {
    var out = [];
    var hasEnum = false;
    try { hasEnum = (typeof PREFType !== "undefined" && PREFType); } catch (e0) { hasEnum = false; }
    if (hasEnum) {
      try { out.push({ label: "independent", value: PREFType.PREF_Type_MACHINE_INDEPENDENT }); } catch (e1) {}
      try { out.push({ label: "specific", value: PREFType.PREF_Type_MACHINE_SPECIFIC }); } catch (e2) {}
    }
    if (out.length === 0) out.push({ label: "default", value: undefined });
    return out;
  }

  function prefHave(section, key, t) {
    try {
      if (t === undefined) return app.preferences.havePref(section, key) === true;
      return app.preferences.havePref(section, key, t) === true;
    } catch (e) {
      return false;
    }
  }

  function prefGet(kind, section, key, t) {
    var p = app.preferences;
    if (kind === "bool") {
      if (t === undefined) return p.getPrefAsBool(section, key);
      return p.getPrefAsBool(section, key, t);
    }
    if (kind === "long") {
      if (t === undefined) return p.getPrefAsLong(section, key);
      return p.getPrefAsLong(section, key, t);
    }
    if (kind === "float") {
      if (t === undefined) return p.getPrefAsFloat(section, key);
      return p.getPrefAsFloat(section, key, t);
    }
    if (t === undefined) return p.getPrefAsString(section, key);
    return p.getPrefAsString(section, key, t);
  }

  function prefSave(kind, section, key, value, t) {
    var p = app.preferences;
    if (kind === "bool") {
      if (t === undefined) p.savePrefAsBool(section, key, value);
      else p.savePrefAsBool(section, key, value, t);
    } else {
      if (t === undefined) p.savePrefAsLong(section, key, value);
      else p.savePrefAsLong(section, key, value, t);
    }
  }

  // The first candidate (or probe) whose key exists, with its current value.
  // String values are bounded; truncated is set when one was cut.
  function findPref(pairs, kinds) {
    var types = prefTypes();
    var p, d, ti;
    for (p = 0; p < pairs.length; p++) {
      for (ti = 0; ti < types.length; ti++) {
        if (!prefHave(pairs[p].section, pairs[p].key, types[ti].value)) continue;
        for (d = 0; d < kinds.length; d++) {
          var v;
          try {
            v = prefGet(kinds[d], pairs[p].section, pairs[p].key, types[ti].value);
          } catch (eGet) {
            continue;
          }
          var hit = { section: pairs[p].section, key: pairs[p].key, type: kinds[d], pref_type: types[ti].label, value: v };
          if (typeof v === "string" && v.length > MAX_STR) {
            hit.value = bound(v);
            hit.truncated = true;
          }
          return hit;
        }
      }
    }
    return null;
  }

  A.projectsessionPrefs = function (args) {
    var out = { fields: {}, probed: [], save_project_on_crash: null, prefs_available: true };
    try { out.save_project_on_crash = app.saveProjectOnCrash === true; } catch (e0) {}
    var havePrefs = false;
    try { havePrefs = !!(app.preferences && app.preferences.havePref); } catch (e1) { havePrefs = false; }
    if (!havePrefs) {
      out.prefs_available = false;
      return out;
    }
    var i;
    for (i = 0; i < PREF_FIELDS.length; i++) {
      var f = PREF_FIELDS[i];
      out.fields[f.field] = findPref(fieldPairs(f), f.types);
    }
    var probes = (args && args.probe) ? args.probe : [];
    for (i = 0; i < probes.length && i < MAX_PROBES; i++) {
      var pr = probes[i];
      if (!pr || typeof pr.section !== "string" || typeof pr.key !== "string") continue;
      var kind = pr.type;
      if (kind !== "bool" && kind !== "long" && kind !== "float" && kind !== "string") kind = "long";
      var hit = findPref([{ section: pr.section, key: pr.key }], [kind]);
      out.probed.push({ section: pr.section, key: pr.key, requested_type: kind, found: hit !== null, value: hit ? hit.value : null, pref_type: hit ? hit.pref_type : null, truncated: hit ? hit.truncated === true : false });
    }
    return out;
  };

  function prefTypeValue(label) {
    var types = prefTypes();
    var i;
    for (i = 0; i < types.length; i++) {
      if (types[i].label === label) return types[i].value;
    }
    return undefined;
  }

  // Writes only keys projectsessionPrefs found. A running AE may re-read them
  // only at its next launch; the read-back shows what the preferences hold.
  A.projectsessionPrefsSet = function (args) {
    assertGuard(args ? args.expect : undefined);
    if (!args || !args.set || typeof args.set !== "object") {
      fail("bad_args", "projectsessionPrefsSet requires set");
    }
    var set = args.set;
    var wanted = [];
    var i;
    if (set.enabled !== undefined) {
      if (set.enabled !== true && set.enabled !== false) fail("bad_args", "set.enabled must be true or false");
      wanted.push("enabled");
    }
    if (set.interval_minutes !== undefined) {
      if (typeof set.interval_minutes !== "number" || set.interval_minutes < 1 || set.interval_minutes > 1440 || Math.floor(set.interval_minutes) !== set.interval_minutes) {
        fail("bad_args", "set.interval_minutes must be a whole number from 1 to 1440");
      }
      wanted.push("interval_minutes");
    }
    if (set.max_versions !== undefined) {
      if (typeof set.max_versions !== "number" || set.max_versions < 1 || set.max_versions > 1000 || Math.floor(set.max_versions) !== set.max_versions) {
        fail("bad_args", "set.max_versions must be a whole number from 1 to 1000");
      }
      wanted.push("max_versions");
    }
    if (wanted.length === 0) fail("bad_args", "set has nothing to change");

    var found = A.projectsessionPrefs({});
    if (!found.prefs_available) {
      return { applied: false, no_op: true, not_found: wanted, message: "app.preferences is not available." };
    }
    var missing = [];
    for (i = 0; i < wanted.length; i++) {
      if (!found.fields[wanted[i]]) missing.push(wanted[i]);
    }
    if (missing.length > 0) {
      // All or nothing: no key is written when one of them can't be located.
      return {
        applied: false,
        no_op: true,
        not_found: missing,
        message:
          "The Auto-Save preference key for " + missing.join(", ") +
          " was not found under the names probed. Nothing was changed. Ask the user to set it in Edit > Preferences > Auto-Save, or probe other names."
      };
    }

    var written = [];
    var failed = [];
    for (i = 0; i < wanted.length; i++) {
      var name = wanted[i];
      var hit = found.fields[name];
      var value = set[name];
      var t = prefTypeValue(hit.pref_type);
      if (name === "enabled" && hit.type === "long") {
        if (value === true) value = 1;
        else value = 0;
      }
      try {
        prefSave(hit.type, hit.section, hit.key, value, t);
        written.push({ field: name, section: hit.section, key: hit.key, type: hit.type, value: value });
      } catch (eWrite) {
        failed.push({ field: name, section: hit.section, key: hit.key, error: bound(eWrite.message || String(eWrite)) });
      }
    }
    if (written.length === 0) {
      return { applied: false, no_op: true, written: written, failed: failed, message: "After Effects refused every preference write. Nothing was changed." };
    }
    // What was written stays in memory even when a later key failed: save it
    // and let the read-back report the difference, instead of throwing.
    try { app.preferences.saveToDisk(); } catch (eSave) {
      return { applied: true, no_op: true, written: written, failed: failed, saved_to_disk: false, error: bound(eSave.message || String(eSave)) };
    }
    return { applied: true, no_op: true, written: written, failed: failed, saved_to_disk: true };
  };
})($.global);
