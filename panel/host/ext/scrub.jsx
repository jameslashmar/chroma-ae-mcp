// panel/host/ext/scrub.jsx
//
// Host functions for ae_scrub_check, which samples frame pairs across a comp's
// work area or a finished render and looks for black, frozen, popping or
// flickering stretches:
// - scrubInfo (read): the comp's size, frame rate, work area, markers and
//   layer in/out points (the intended cuts), changing nothing
// - scrubImport (guarded write): a render file goes in as footage, and a
//   temporary comp holding it is built, so frames can be grabbed from it
// - scrubState (read): whether the imported item and the temporary comp are
//   still in the project (the read-back after the import and after the removal)
// - scrubRemove (guarded write): takes the temporary comp and the item out
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Reads after a write run in a separate evalScript call.
// - The frames themselves come from the existing snapshotFrame (core.jsx).

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var TEMP_COMP_NAME = "Scrub check (temp)";

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

  function itemById(id) {
    var item = null;
    try {
      item = app.project.itemByID(id);
    } catch (e) {
      item = null;
    }
    return item;
  }

  function requireComp(id) {
    var item = itemById(id);
    if (!item || !(item instanceof CompItem)) fail("not_found", "No CompItem with id " + id);
    return item;
  }

  function round6(n) {
    return Math.round(n * 1000000) / 1000000;
  }

  function clip(s, n) {
    var t = String(s);
    if (t.length > n) t = t.substring(0, n) + " ...[truncated]";
    return t;
  }

  // A.scrubInfo: what the server needs to plan the samples and to tell a
  // deliberate cut from a pop. Reads only.
  A.scrubInfo = function (args) {
    var comp = requireComp(args.comp_id);
    var out = {
      comp_id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      pixelAspect: comp.pixelAspect,
      frameRate: comp.frameRate,
      frameDuration: comp.frameDuration,
      duration: comp.duration,
      workAreaStart: comp.workAreaStart,
      workAreaDuration: comp.workAreaDuration,
      numLayers: comp.numLayers,
      markers: [],
      markers_truncated: false,
      layer_edges: [],
      layer_edges_truncated: false
    };
    var i;
    // Comp markers (AE 14.0+): a missing markerProperty just means none.
    try {
      var mp = comp.markerProperty;
      if (mp) {
        var n = mp.numKeys;
        if (n > MAX_LIST) {
          n = MAX_LIST;
          out.markers_truncated = true;
        }
        for (i = 1; i <= n; i++) {
          var m = { time: round6(mp.keyTime(i)) };
          try {
            m.comment = clip(mp.keyValue(i).comment, 200);
          } catch (eC) {}
          out.markers.push(m);
        }
      }
    } catch (eM) {}
    // Where visible layers start and end: a change there is an intended cut.
    var count = comp.numLayers;
    for (i = 1; i <= count; i++) {
      if (out.layer_edges.length >= MAX_LIST) {
        out.layer_edges_truncated = true;
        break;
      }
      var l = comp.layer(i);
      var skip = false;
      try {
        if (l.enabled === false) skip = true;
        if (l.hasVideo === false) skip = true;
        if (l.nullLayer === true) skip = true;
        if (l.guideLayer === true) skip = true;
      } catch (eK) {}
      try {
        if (l instanceof CameraLayer) skip = true;
      } catch (eCam) {}
      try {
        if (l instanceof LightLayer) skip = true;
      } catch (eLit) {}
      if (skip) continue;
      out.layer_edges.push({ time: round6(l.inPoint), edge: "in", layer: clip(l.name, 80) });
      if (out.layer_edges.length < MAX_LIST) {
        out.layer_edges.push({ time: round6(l.outPoint), edge: "out", layer: clip(l.name, 80) });
      }
    }
    return out;
  };

  // A.scrubImport: the render goes in as footage and a temporary comp holds
  // it, in one undo group. Whatever fails after the import takes the import
  // (and a half-built comp) back out in the same group, so a failed call
  // leaves nothing behind.
  A.scrubImport = function (args) {
    assertGuard(args.expect);
    if (typeof args.path !== "string" || args.path.length === 0) fail("bad_args", "path must be a non-empty string");
    var f = new File(args.path);
    if (!f.exists) fail("not_found", "No render at " + args.path);
    var sequence = args.sequence === true;
    var seqFps = null;
    if (args.fps !== undefined && args.fps !== null) {
      if (typeof args.fps !== "number" || !isFinite(args.fps) || args.fps < 1 || args.fps > 999) fail("bad_args", "fps must be a number in 1..999");
      seqFps = args.fps;
    }
    return A.withUndo(args.label || "Scrub check: import", function () {
      var io = new ImportOptions(f);
      if (sequence) {
        io.sequence = true;
        // Numbered order with placeholders for missing frames, as AE's Import dialog does.
        io.forceAlphabetical = false;
      }
      var item = app.project.importFile(io);
      var comp = null;
      try {
        if (!(item instanceof FootageItem)) fail("bad_args", "Not a footage file AE can scrub: " + args.path);
        // Frames and rate as imported, read BEFORE the conform: a read after the write can be stale.
        var preFps = item.frameRate;
        var preDur = item.duration;
        var still = false;
        try {
          still = item.mainSource.isStill === true;
        } catch (eS) {}
        if (still) fail("bad_args", "A single still has no frames to compare; give a movie or an image sequence");
        if (item.hasVideo === false) fail("bad_args", "The file has no video");
        var w = item.width;
        var h = item.height;
        var fps = preFps;
        var dur = preDur;
        if (sequence && seqFps !== null && preFps > 0) {
          // The same frames at the new rate; the item is not re-read.
          dur = (preDur * preFps) / seqFps;
          fps = seqFps;
        }
        if (!(w >= 4 && w <= 30000 && h >= 4 && h <= 30000)) fail("bad_args", "AE can't build a comp of " + w + "x" + h);
        if (!(fps >= 1 && fps <= 999)) fail("bad_args", "The frame rate (" + fps + ") is outside the 1..999 a comp can have");
        if (!(dur > 0 && dur <= 10800)) fail("bad_args", "The length (" + dur + " s) is outside the 3 hours a comp can have");
        var par = 1;
        try {
          if (item.pixelAspect > 0) par = item.pixelAspect;
        } catch (eP) {}
        if (par < 0.01 || par > 100) par = 1;
        if (sequence && seqFps !== null) {
          try {
            item.mainSource.conformFrameRate = seqFps;
          } catch (eC) {}
        }
        comp = app.project.items.addComp(TEMP_COMP_NAME, w, h, par, dur, fps);
        comp.layers.add(item);
        return {
          item_id: item.id,
          comp_id: comp.id,
          name: item.name,
          width: w,
          height: h,
          pixelAspect: par,
          frameRate: fps,
          frameDuration: comp.frameDuration,
          duration: comp.duration,
          sequence: sequence
        };
      } catch (e) {
        try {
          if (comp) comp.remove();
        } catch (eRc) {}
        try {
          item.remove();
        } catch (eRi) {}
        throw e;
      }
    });
  };

  // A.scrubState: what is still in the project. Never throws for a missing item.
  A.scrubState = function (args) {
    var out = { item: null, comp: null };
    if (args.item_id !== undefined && args.item_id !== null) {
      var it = itemById(args.item_id);
      if (it && it instanceof FootageItem) {
        out.item = { id: it.id, name: it.name };
        try {
          out.item.frameRate = it.frameRate;
          out.item.duration = it.duration;
        } catch (eIt) {}
      }
    }
    if (args.comp_id !== undefined && args.comp_id !== null) {
      var c = itemById(args.comp_id);
      if (c && c instanceof CompItem) {
        out.comp = { id: c.id, name: c.name, numLayers: c.numLayers };
        try {
          out.comp.frameRate = c.frameRate;
          out.comp.duration = c.duration;
        } catch (eCp) {}
      }
    }
    return out;
  };

  // A.scrubRemove: only the temporary comp scrubImport built (one layer, our
  // item) and that item, never anything else in the project.
  A.scrubRemove = function (args) {
    assertGuard(args.expect);
    var comp = null;
    var item = null;
    if (args.comp_id !== undefined && args.comp_id !== null) {
      var c = itemById(args.comp_id);
      if (c && c instanceof CompItem) comp = c;
    }
    if (args.item_id !== undefined && args.item_id !== null) {
      var it = itemById(args.item_id);
      if (it && it instanceof FootageItem) item = it;
    }
    if (comp) {
      var ours = comp.name === TEMP_COMP_NAME && comp.numLayers === 1;
      if (ours && item) {
        try {
          ours = comp.layer(1).source.id === item.id;
        } catch (eS) {
          ours = false;
        }
      }
      if (!ours) fail("bad_args", "Comp " + args.comp_id + " is not the temporary comp this tool built; leaving it alone");
    }
    return A.withUndo(args.label || "Scrub check: remove", function () {
      var out = { removed_comp: null, removed_item: null, item_kept: false };
      if (comp) {
        out.removed_comp = comp.id;
        comp.remove();
      }
      if (item) {
        var used = 0;
        try {
          used = item.usedIn.length;
        } catch (eU) {}
        if (used > 0) {
          out.item_kept = true;
        } else {
          out.removed_item = item.id;
          item.remove();
        }
      }
      return out;
    });
  };
})($.global);
