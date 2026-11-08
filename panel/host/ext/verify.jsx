// panel/host/ext/verify.jsx
//
// Host functions for ae_verify_render, which checks a render by importing it
// back into AE (no outside tools):
// - verifyImport (guarded write): import the file, or the image sequence it
//   starts, into the project
// - verifyRead (read): what AE reads from the imported item (length, frame
//   rate, size, audio), in its own evalScript after the import
// - verifyExists (read): whether the imported item is still there ({ exists }); never raises for a missing item
// - verifyRemove (guarded write): take the imported item out again
// - verifyCompInfo (read): the comp the render came from
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Reads after a write run in a separate evalScript call.

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

  A.verifyCompInfo = function (args) {
    var c = null;
    if (args.comp_id !== undefined && args.comp_id !== null) {
      try { c = app.project.itemByID(args.comp_id); } catch (e) { c = null; }
    } else if (args.comp_name) {
      var hits = 0;
      for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === args.comp_name) {
          c = it;
          hits++;
        }
      }
      if (hits > 1) fail("bad_args", hits + " comps are named \"" + args.comp_name + "\"");
    }
    if (!c || !(c instanceof CompItem)) fail("not_found", "No comp to compare with");
    var audio = false;
    for (var j = 1; j <= c.numLayers; j++) {
      try { if (c.layer(j).hasAudio && c.layer(j).audioEnabled) audio = true; } catch (eA) {}
    }
    return {
      comp_id: c.id,
      name: c.name,
      width: c.width,
      height: c.height,
      fps: c.frameRate,
      duration: c.duration,
      work_area_start: c.workAreaStart,
      work_area_duration: c.workAreaDuration,
      has_audio: audio
    };
  };

  A.verifyImport = function (args) {
    assertGuard(args.expect);
    var f = new File(args.path);
    if (!f.exists) fail("not_found", "No render at " + args.path);
    return A.withUndo(args.label || "Verify render: import", function () {
      var io = new ImportOptions(f);
      if (args.sequence === true) io.sequence = true;
      var item = app.project.importFile(io);
      if (!(item instanceof FootageItem)) {
        // roll the import back in this same call; verifyRemove only takes footage
        try { item.remove(); } catch (eR) {}
        fail("bad_args", "Not a footage file AE can verify: " + args.path);
      }
      // A sequence takes AE's Sequence Footage import rate (30 fps by default), not
      // the render's: conform our own temporary item to the comp's rate.
      if (args.sequence === true && typeof args.fps === "number" && args.fps > 0) {
        try { item.mainSource.conformFrameRate = args.fps; } catch (eC) {}
      }
      return { item_id: item.id, name: item.name };
    });
  };

  A.verifyRead = function (args) {
    var it = null;
    try { it = app.project.itemByID(args.item_id); } catch (e) { it = null; }
    if (!it || !(it instanceof FootageItem)) fail("not_found", "No imported item " + args.item_id);
    var out = {
      item_id: it.id,
      name: it.name,
      width: it.width,
      height: it.height,
      duration: it.duration,
      fps: it.frameRate,
      has_video: it.hasVideo,
      has_audio: it.hasAudio,
      still: false,
      frames: null
    };
    try { out.still = it.mainSource.isStill === true; } catch (eS) {}
    if (!out.still && it.frameRate > 0) out.frames = Math.round(it.duration * it.frameRate);
    try { if (it.file) out.file = it.file.fsName; } catch (eF) {}
    return out;
  };

  // Whether the imported item is still in the project. A read that never fails for a missing
  // item, so the bridge logs no error when the cleanup worked (verifyRead raises not_found).
  A.verifyExists = function (args) {
    var it = null;
    try { it = app.project.itemByID(args.item_id); } catch (e) { it = null; }
    return { item_id: args.item_id, exists: !!(it && it instanceof FootageItem) };
  };

  A.verifyRemove = function (args) {
    assertGuard(args.expect);
    var it = null;
    try { it = app.project.itemByID(args.item_id); } catch (e) { it = null; }
    if (!it || !(it instanceof FootageItem)) fail("not_found", "No imported item " + args.item_id);
    var used = 0;
    try { used = it.usedIn.length; } catch (eU) {}
    if (used > 0) fail("bad_args", "The imported render is used by a comp now; leaving it in the project");
    return A.withUndo(args.label || "Verify render: remove", function () {
      it.remove();
      return { removed: args.item_id };
    });
  };
})($.global);
