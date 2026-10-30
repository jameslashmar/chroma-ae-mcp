// panel/host/ext/assets.jsx
//
// Host functions for ae_import_assets and the asset watcher:
// - footagePaths: the file of every footage item in the project (read-only)
// - importAssets: imports files and sequences into a bin whose subfolders
//   mirror the asset folder's (guarded, one undo group; a file AE refuses is
//   reported and the rest still import)
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

  A.importAssets = function (args) {
    assertGuard(args.expect);
    return A.withUndo("Chroma AE MCP: import assets", function () {
      var root = childFolder(app.project.rootFolder, args.bin);
      var imported = [];
      var failed = [];
      for (var i = 0; i < args.items.length; i++) {
        var it = args.items[i];
        var f = new File(it.path);
        if (!f.exists) {
          failed.push({ path: it.path, error: "file not found" });
          continue;
        }
        try {
          var opts = new ImportOptions(f);
          if (it.sequence) {
            if (!opts.canImportAs(ImportAsType.FOOTAGE)) fail("bad_args", "AE can't import this as footage");
            opts.sequence = true;
            opts.forceAlphabetical = false;
          }
          var item = app.project.importFile(opts);
          var rec = { path: it.path, item_id: item.id, name: item.name, type: item.typeName, sequence: it.sequence === true };
          try {
            item.parentFolder = binPath(root, it.subfolder);
          } catch (moveErr) {
            rec.note = "imported but left at the project root: " + String(moveErr.message);
          }
          imported.push(rec);
        } catch (e) {
          failed.push({ path: it.path, error: String(e.message) });
        }
      }
      return { bin_id: root.id, imported: imported, failed: failed };
    });
  };

  function collect(folder, prefix, out) {
    for (var i = 1; i <= folder.numItems; i++) {
      var it = folder.item(i);
      if (it instanceof FolderItem) {
        collect(it, prefix + it.name + "/", out);
      } else {
        out.push({ item_id: it.id, bin: prefix, name: it.name, path: footageFile(it) });
      }
    }
  }

  A.assetBinContents = function (args) {
    var out = [];
    var root = app.project.rootFolder;
    for (var i = 1; i <= root.numItems; i++) {
      var it = root.item(i);
      if (it instanceof FolderItem && it.name === args.bin) collect(it, args.bin + "/", out);
    }
    return { items: out };
  };
})($.global);
