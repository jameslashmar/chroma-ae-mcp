// panel/host/ext/memory.jsx
//
// Host functions for the memory tools:
// - memoryRead (read): app.memoryInUse, which purge targets this AE has, the
//   saved/dirty state, and best-effort preference values the caller names
// - memoryPurge (guarded write): app.purge for the image cache, the snapshot
//   cache, all RAM caches (ALL_MEMORY_CACHES, AE 24.3+), the undo history or
//   all caches (ALL_CACHES, which also wipes the disk cache since AE 24.3)
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - A purge is not a project change, so it is never undo-grouped.
// - memoryPurge checks the target guard first and validates everything before it purges.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_PREFS = 20;
  var MAX_STRING = 20000;

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

  function projectPath() {
    var f = null;
    try { f = app.project.file; } catch (e0) { f = null; }
    if (!f) return "<unsaved>";
    return f.fsName;
  }

  // true / false, or null when AE can't say.
  function projectDirty() {
    try {
      var d = app.project.dirty;
      if (d === true) return true;
      if (d === false) return false;
      return null;
    } catch (e0) {
      return null;
    }
  }

  // The PurgeTarget constant behind a tool-level name, or null when this AE
  // doesn't have it (ALL_MEMORY_CACHES is new in 24.3).
  var TARGET_CONSTANTS = {
    image: "IMAGE_CACHES",
    snapshot: "SNAPSHOT_CACHES",
    ram: "ALL_MEMORY_CACHES",
    undo: "UNDO_CACHES",
    all: "ALL_CACHES"
  };

  function purgeConstantName(target) {
    if (TARGET_CONSTANTS.hasOwnProperty(target)) return TARGET_CONSTANTS[target];
    return null;
  }

  function purgeValue(target) {
    var name = purgeConstantName(target);
    if (name === null) return null;
    try {
      if (typeof PurgeTarget === "undefined" || PurgeTarget === null) return null;
      var v = PurgeTarget[name];
      if (v === undefined) return null;
      return v;
    } catch (e0) {
      return null;
    }
  }

  function readMemoryInUse() {
    try {
      var m = app.memoryInUse;
      if (typeof m === "number" && isFinite(m)) return m;
    } catch (e0) {}
    return null;
  }

  function capString(s) {
    var t = String(s);
    if (t.length > MAX_STRING) return t.substring(0, MAX_STRING);
    return t;
  }

  var PREF_TYPES = { "long": 1, "string": 1, "bool": 1, "float": 1 };

  // Which preference file a key lives in is unmeasured for the cache keys, so
  // the caller can name it. Tool-level name -> PREFType constant.
  var PREF_FILES = {
    machine_specific: "PREF_Type_MACHINE_SPECIFIC",
    machine_independent: "PREF_Type_MACHINE_INDEPENDENT",
    machine_independent_render: "PREF_Type_MACHINE_INDEPENDENT_RENDER",
    machine_independent_output: "PREF_Type_MACHINE_INDEPENDENT_OUTPUT",
    machine_independent_composition: "PREF_Type_MACHINE_INDEPENDENT_COMPOSITION",
    machine_specific_text: "PREF_Type_MACHINE_SPECIFIC_TEXT",
    machine_specific_paint: "PREF_Type_MACHINE_SPECIFIC_PAINT"
  };

  // The PREFType value, or undefined when this AE lacks it.
  function prefFileValue(name) {
    try {
      if (typeof PREFType === "undefined" || PREFType === null) return undefined;
      return PREFType[PREF_FILES[name]];
    } catch (e0) {
      return undefined;
    }
  }

  // Checks the names a caller asked for; the host reads nothing until all pass.
  function checkPrefRequests(list) {
    if (list === undefined || list === null) return [];
    if (typeof list.length !== "number") fail("bad_args", "prefs must be a list of { section, key, type }");
    if (list.length > MAX_PREFS) fail("bad_args", "prefs takes at most " + MAX_PREFS + " entries");
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || typeof p.section !== "string" || typeof p.key !== "string" || p.section.length < 1 || p.key.length < 1 || p.section.length > 200 || p.key.length > 200) {
        fail("bad_args", "prefs[" + i + "] needs a section and a key (strings of 1..200 characters)");
      }
      var type = "long";
      if (p.type !== undefined && p.type !== null) type = p.type;
      if (PREF_TYPES[type] !== 1) fail("bad_args", "prefs[" + i + "].type must be long, string, bool or float");
      var prefFile = null;
      if (p.pref_file !== undefined && p.pref_file !== null) {
        if (typeof p.pref_file !== "string" || !PREF_FILES.hasOwnProperty(p.pref_file)) {
          fail("bad_args", "prefs[" + i + "].pref_file must be one of machine_specific, machine_independent, machine_independent_render, machine_independent_output, machine_independent_composition, machine_specific_text, machine_specific_paint");
        }
        prefFile = p.pref_file;
      }
      out.push({ section: p.section, key: p.key, type: type, pref_file: prefFile });
    }
    return out;
  }

  // One preference, read without changing anything. null value with exists
  // false when AE has no such key (the cache keys are undocumented).
  function readPref(req) {
    var entry = { section: req.section, key: req.key, type: req.type, pref_file: req.pref_file, exists: false, value: null };
    // Third argument of havePref / getPrefAs*; left off for the default file.
    var extra = [];
    if (req.pref_file) {
      var pf = prefFileValue(req.pref_file);
      if (pf === undefined) {
        entry.error = "This After Effects has no PREFType." + PREF_FILES[req.pref_file];
        return entry;
      }
      extra = [pf];
    }
    var prefs = null;
    try { prefs = app.preferences; } catch (e0) { prefs = null; }
    if (!prefs) {
      entry.error = "app.preferences is not available";
      return entry;
    }
    try {
      entry.exists = prefs.havePref.apply(prefs, [req.section, req.key].concat(extra)) === true;
    } catch (e1) {
      entry.error = String(e1.message || e1);
      return entry;
    }
    if (!entry.exists) return entry;
    try {
      if (req.type === "string") {
        entry.value = capString(prefs.getPrefAsString.apply(prefs, [req.section, req.key].concat(extra)));
      } else if (req.type === "bool") {
        entry.value = prefs.getPrefAsBool.apply(prefs, [req.section, req.key].concat(extra)) === true;
      } else if (req.type === "float") {
        entry.value = prefs.getPrefAsFloat.apply(prefs, [req.section, req.key].concat(extra));
      } else {
        entry.value = prefs.getPrefAsLong.apply(prefs, [req.section, req.key].concat(extra));
      }
    } catch (e2) {
      entry.error = String(e2.message || e2);
    }
    return entry;
  }

  // ---------- memoryRead ----------

  A.memoryRead = function (args) {
    args = args || {};
    var requests = checkPrefRequests(args.prefs);
    var version = null;
    try { version = String(app.version); } catch (e0) {}
    var targets = {};
    var names = ["image", "snapshot", "ram", "undo", "all"];
    for (var i = 0; i < names.length; i++) {
      targets[names[i]] = purgeValue(names[i]) !== null;
    }
    var prefs = [];
    for (var j = 0; j < requests.length; j++) {
      prefs.push(readPref(requests[j]));
    }
    return {
      ae_version: version,
      memory_in_use_bytes: readMemoryInUse(),
      project_path: projectPath(),
      dirty: projectDirty(),
      purge_targets_available: targets,
      prefs: prefs
    };
  };

  // ---------- memoryPurge ----------

  A.memoryPurge = function (args) {
    assertGuard(args.expect);
    var target = args.target;
    if (typeof target !== "string" || purgeConstantName(target) === null) {
      fail("bad_args", "target must be image, snapshot, ram, undo or all");
    }
    var value = purgeValue(target);
    if (value === null) {
      fail("bad_args", "This After Effects has no PurgeTarget." + purgeConstantName(target) + (target === "ram" ? " (AE 24.3+). Use image or snapshot." : ""));
    }
    var onlyAbove = null;
    if (args.only_above_mb !== undefined && args.only_above_mb !== null) {
      if (typeof args.only_above_mb !== "number" || !isFinite(args.only_above_mb) || args.only_above_mb < 0) {
        fail("bad_args", "only_above_mb must be a number of megabytes, 0 or more");
      }
      onlyAbove = args.only_above_mb;
    }
    var clearsUndo = target === "undo";
    var clearsDisk = target === "all";
    if (clearsUndo || clearsDisk) {
      // The undo history can't come back and the disk cache can take hours to
      // rebuild, so both need a saved project and a yes the caller got from the user.
      if (clearsUndo && args.confirm_undo_purge !== true) {
        fail("bad_args", "Purging undo needs confirm_undo_purge: true, after the user said yes (it removes the whole Edit > Undo history).");
      }
      if (clearsDisk && args.confirm_disk_cache_wipe !== true) {
        fail("bad_args", "Purging all caches needs confirm_disk_cache_wipe: true, after the user said yes (since AE 24.3 it also wipes the disk cache). Use ram to keep it.");
      }
      if (projectPath() === "<unsaved>") {
        fail("bad_args", "The project has never been saved; ae_save it before purging " + target + ".");
      }
      if (projectDirty() !== false) {
        fail("bad_args", "The project has unsaved changes (or AE can't say); ae_save first, then purge " + target + ".");
      }
    }

    var seen = readMemoryInUse();
    // Watchdog use: below the threshold nothing is thrown away. A memory
    // reading AE can't give counts as below, so a missing number never purges.
    if (onlyAbove !== null && (seen === null || seen <= onlyAbove * 1048576)) {
      return {
        target: target,
        purge_constant: purgeConstantName(target),
        purged: false,
        skipped_reason: seen === null ? "memory_unavailable" : "below_threshold",
        memory_seen_bytes: seen,
        only_above_mb: onlyAbove,
        undo_history_cleared: false,
        undo_history_may_be_cleared: false,
        disk_cache_cleared: false
      };
    }

    // Not wrapped in an undo group for any target: a purge is not a project
    // change, so there is nothing for a group to record, and for undo, ram and
    // all the purge may empty the history the group would be closed around.
    app.purge(value);
    // ram (ALL_MEMORY_CACHES) and all may also drop Edit > Undo levels; that is
    // unmeasured, so the result says "unknown" instead of claiming it is intact.
    var mayClearUndo = target === "ram" || target === "all";
    var undoCleared = false;
    if (clearsUndo) {
      undoCleared = true;
    } else if (mayClearUndo) {
      undoCleared = null;
    }
    return {
      target: target,
      purge_constant: purgeConstantName(target),
      purged: true,
      skipped_reason: null,
      memory_seen_bytes: seen,
      only_above_mb: onlyAbove,
      undo_history_cleared: undoCleared,
      undo_history_may_be_cleared: mayClearUndo,
      disk_cache_cleared: clearsDisk
    };
  };
})($.global);
