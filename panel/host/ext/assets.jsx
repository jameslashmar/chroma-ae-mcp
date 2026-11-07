// panel/host/ext/assets.jsx
//
// Host functions for ae_import_assets and the asset watcher:
// - footagePaths: the file of every footage item in the project (read-only)
// - importAssets: imports files and sequences into a bin (or a project folder
//   by id) whose subfolders mirror the asset folder's, and sets each item's
//   interpretation when asked (guarded, one undo group; a file AE refuses is
//   reported and the rest still import; a time budget stops between files)
// - assetBinContents: what the bin holds, for the server's read-back
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

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

  function footageFile(item) {
    try {
      if (item instanceof FootageItem && item.mainSource && item.mainSource.file) return item.mainSource.file.fsName;
    } catch (e) {}
    return null;
  }

  A.footagePaths = function () {
    var paths = [];
    for (var i = 1; i <= app.project.numItems; i++) {
      var p = footageFile(app.project.item(i));
      if (p !== null) paths.push(p);
    }
    return { project_path: A.status().project_path, paths: paths };
  };

  function childFolder(parent, name) {
    for (var i = 1; i <= parent.numItems; i++) {
      var it = parent.item(i);
      if (it instanceof FolderItem && it.name === name) return it;
    }
    var f = app.project.items.addFolder(name);
    f.parentFolder = parent;
    return f;
  }

  function binPath(root, parts) {
    var f = root;
    for (var i = 0; i < parts.length; i++) f = childFolder(f, parts[i]);
    return f;
  }

  var MAX_ITEMS = 200;
  // The 500-entry rule. The watcher's own read-back asks for only the files it just imported
  // (only_paths, at most 200), so the cap never hides one of them.
  var MAX_ROWS = 500;
  var MAX_PATHS = 20;

  function hasVal(v) {
    return v !== undefined && v !== null;
  }

  function hasKeys(o) {
    var k;
    for (k in o) {
      if (o.hasOwnProperty(k)) return true;
    }
    return false;
  }

  function folderById(id) {
    var f = null;
    try {
      f = app.project.itemByID(id);
    } catch (e) {
      f = null;
    }
    if (!f || !(f instanceof FolderItem)) return null;
    return f;
  }

  // Imports files and sequences into a bin (or a project folder by id), and
  // sets their interpretation when asked. Everything is checked before the
  // undo group opens. Inside it each file is tried on its own: a file AE
  // refuses is reported and the rest still import. The time budget is checked
  // between files, never inside one: what is left goes to not_attempted.
  A.importAssets = function (args) {
    assertGuard(args.expect);
    var items = args.items;
    if (!items || typeof items.length !== "number") fail("bad_args", "items must be an array");
    if (items.length > MAX_ITEMS) fail("bad_args", "At most " + MAX_ITEMS + " files per call");
    var maxMs = 45000;
    if (hasVal(args.max_seconds)) {
      if (typeof args.max_seconds !== "number" || !isFinite(args.max_seconds) || args.max_seconds < 5 || args.max_seconds > 110) {
        fail("bad_args", "max_seconds must be a number in 5..110");
      }
      maxMs = args.max_seconds * 1000;
    }
    var i;
    var row;
    for (i = 0; i < items.length; i++) {
      row = items[i];
      if (!row || typeof row.path !== "string" || row.path.length < 1) fail("bad_args", "Every item needs a path");
      if (hasVal(row.interpret)) {
        if (typeof A.interpretCheckSettings !== "function") fail("bad_args", "Interpretation is not available in this panel build");
        A.interpretCheckSettings(row.interpret);
      }
    }
    var targetFolder = null;
    if (hasVal(args.target_folder_id)) {
      targetFolder = folderById(args.target_folder_id);
      if (!targetFolder) fail("not_found", "No project folder with id " + args.target_folder_id);
    } else if (typeof args.bin !== "string" || args.bin.length < 1) {
      fail("bad_args", "Give bin or target_folder_id");
    }

    return A.withUndo("Chroma AE MCP: import assets", function () {
      var root = targetFolder;
      if (!root) root = childFolder(app.project.rootFolder, args.bin);
      var imported = [];
      var failed = [];
      var notAttempted = [];
      var start = new Date().getTime();
      var n;
      var j;
      var it;
      var f;
      var opts;
      var item;
      var rec;
      var fresh;
      var ap;
      var res;
      var interp;
      for (n = 0; n < items.length; n++) {
        if (n > 0 && new Date().getTime() - start > maxMs) {
          for (j = n; j < items.length; j++) notAttempted.push(items[j].path);
          break;
        }
        it = items[n];
        f = new File(it.path);
        if (!f.exists) {
          failed.push({ path: it.path, stage: "import", error: "file not found" });
          continue;
        }
        try {
          opts = new ImportOptions(f);
          if (typeof ImportAsType !== "undefined" && typeof opts.canImportAs === "function" && !opts.canImportAs(ImportAsType.FOOTAGE)) {
            fail("bad_args", "AE can't import this as footage");
          }
          if (it.sequence) {
            opts.sequence = true;
            opts.forceAlphabetical = false;
          } else {
            opts.sequence = false;
          }
          item = app.project.importFile(opts);
          rec = { path: it.path, item_id: item.id, name: item.name, type: item.typeName, sequence: it.sequence === true };
          try {
            item.parentFolder = binPath(root, it.subfolder || []);
          } catch (moveErr) {
            rec.note = "imported but left at the project root: " + String(moveErr.message);
          }
          // The object importFile returned may be stale after the move: find the item again by id.
          fresh = null;
          try {
            fresh = app.project.itemByID(rec.item_id);
          } catch (eFind) {
            fresh = null;
          }
          if (hasVal(it.interpret)) {
            interp = { applied: [], skipped: [] };
            if (!fresh) {
              interp.error = "item not found after import";
              failed.push({ path: it.path, item_id: rec.item_id, stage: "interpret", error: interp.error });
            } else {
              ap = A.interpretApplicable(fresh, it.interpret);
              interp.skipped = ap.skipped;
              if (hasKeys(ap.use)) {
                try {
                  res = A.interpretApplyPlanned(fresh, ap.use, "Chroma AE MCP: import assets");
                  interp.applied = res.changed;
                  interp.use = ap.use;
                } catch (eInterp) {
                  interp.error = String(eInterp.message);
                  failed.push({ path: it.path, item_id: rec.item_id, stage: "interpret", error: interp.error });
                }
              }
            }
            rec.interpretation = interp;
          }
          imported.push(rec);
        } catch (e) {
          failed.push({ path: it.path, stage: "import", error: String(e.message) });
        }
      }
      return {
        bin_id: root.id,
        folder_id: root.id,
        imported: imported,
        failed: failed,
        not_attempted: notAttempted.length,
        not_attempted_paths: notAttempted.slice(0, MAX_PATHS),
        elapsed_ms: new Date().getTime() - start
      };
    });
  };

  function normFile(p) {
    return String(p).replace(/\\/g, "/").toLowerCase();
  }

  function collect(folder, prefix, out, only) {
    for (var i = 1; i <= folder.numItems; i++) {
      if (out.length >= MAX_ROWS) {
        out.truncated = true;
        return;
      }
      var it = folder.item(i);
      if (it instanceof FolderItem) {
        collect(it, prefix + it.name + "/", out, only);
      } else {
        var fp = footageFile(it);
        if (only && (fp === null || only[normFile(fp)] !== true)) continue;
        out.push({ item_id: it.id, bin: prefix, name: it.name, path: fp });
      }
    }
  }

  A.assetBinContents = function (args) {
    var out = [];
    var root = app.project.rootFolder;
    var i;
    var it;
    var only = null;
    if (args.only_paths && typeof args.only_paths.length === "number") {
      only = {};
      for (i = 0; i < args.only_paths.length && i < 200; i++) only[normFile(args.only_paths[i])] = true;
    }
    if (hasVal(args.folder_id)) {
      var tf = folderById(args.folder_id);
      if (tf) collect(tf, tf.name + "/", out, only);
    } else {
      for (i = 1; i <= root.numItems; i++) {
        it = root.item(i);
        if (it instanceof FolderItem && it.name === args.bin) collect(it, args.bin + "/", out, only);
      }
    }
    return { items: out, truncated: out.truncated === true };
  };
})($.global);
