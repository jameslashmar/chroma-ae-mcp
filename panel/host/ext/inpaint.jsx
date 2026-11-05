// panel/host/ext/inpaint.jsx
//
// Host functions for ae_inpaint_plate (a clean plate made in Node from other
// frames of the shot). The pixels are made by the server; AE only answers
// questions and imports the result:
// - inpaintRead (read): the comp, the plate layer, the comp the fill goes into
//   and the project's colour settings. Changes nothing.
// - inpaintState (read): the project's footage items for one file path and the
//   top layers of the target comp, for the receipt's before and after.
// - inpaintApply (guarded write): imports the PNG as a still and, optionally,
//   puts it on top of a comp, unmasked or with a feathered mask per hole region.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - The write checks the target guard first, validates everything that can
//   fail before A.withUndo, and does the import and the placement inside one
//   A.withUndo. Reads run in separate evalScript calls from the server.
// - Nothing here changes time, selection, resolution or the active item.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_REGIONS = 16;
  var MAX_POINTS = 200;
  var MAX_ITEMS_SCANNED = 20000;
  var MAX_TOP_LAYERS = 5;

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
      fail("guard", "Target guard refused mutation: the open project or comp does not match expect. Stop and re-read state.", {
        expected: expect,
        actual: { project_path: g.project_path, comp_id: g.comp_id, comp_is_valid: g.comp_is_valid }
      });
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

  // By id, index, or a name only one layer has.
  function findLayer(comp, sel) {
    var i;
    if (!sel) fail("bad_args", "layer selector missing");
    if (sel.id !== undefined && sel.id !== null) {
      for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).id === sel.id) return comp.layer(i);
      }
      fail("not_found", "No layer with id " + sel.id + " in comp " + comp.id);
    }
    if (sel.index !== undefined && sel.index !== null) {
      if (sel.index < 1 || sel.index > comp.numLayers) fail("not_found", "Layer index " + sel.index + " out of range");
      return comp.layer(sel.index);
    }
    if (sel.name !== undefined && sel.name !== null) {
      var count = 0;
      var found = null;
      for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === sel.name) {
          count++;
          if (!found) found = comp.layer(i);
        }
      }
      if (count === 0) fail("not_found", "No layer named \"" + sel.name + "\"");
      if (count > 1) fail("bad_args", count + " layers are named \"" + sel.name + "\"; select by id or index");
      return found;
    }
    fail("bad_args", "layer selector needs id, index or name");
    return null;
  }

  function isArr(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function compBrief(c) {
    return {
      id: c.id,
      name: c.name,
      width: c.width,
      height: c.height,
      pixel_aspect: c.pixelAspect,
      fps: c.frameRate,
      frame_duration: c.frameDuration,
      duration: c.duration,
      time: c.time,
      work_area_start: c.workAreaStart,
      work_area_duration: c.workAreaDuration,
      num_layers: c.numLayers
    };
  }

  function normPath(p) {
    return String(p).replace(/\\/g, "/").toLowerCase();
  }

  // ---------- reads ----------

  function errKind(e, fallback) {
    var k = fallback;
    try {
      if (e && e.__kind) k = e.__kind;
    } catch (e0) {}
    return k;
  }

  function errText(e) {
    var m = "";
    try {
      m = String(e && e.message ? e.message : e);
    } catch (e0) {
      m = "unknown error";
    }
    return m;
  }

  // args: { comp_id, plate: { id | index | name } | null, place_comp_id: number | null, at_time?: number }
  // A plate or target comp that cannot be found comes back as plate: null / place: null with
  // plate_error / place_error ({ kind, message }), so the server can refuse by name instead of failing.
  // With at_time, the plate's opacity at that comp time comes back as plate.opacity_at.
  A.inpaintRead = function (args) {
    var comp = requireComp(args.comp_id);
    var out = { comp: compBrief(comp), plate: null, place: null, project: {} };
    if (args.plate) {
      var l = null;
      try {
        l = findLayer(comp, args.plate);
      } catch (ePlate) {
        out.plate_error = { kind: errKind(ePlate, "not_found"), message: errText(ePlate) };
      }
    }
    if (args.plate && l) {
      var hasVideo = true;
      var threeD = false;
      var locked = false;
      try {
        if (l.hasVideo === false) hasVideo = false;
      } catch (e0) {}
      try {
        threeD = l.threeDLayer === true;
      } catch (e1) {}
      try {
        locked = l.locked === true;
      } catch (e2) {}
      out.plate = {
        index: l.index,
        id: l.id,
        name: l.name,
        enabled: l.enabled === true,
        locked: locked,
        has_video: hasVideo,
        three_d: threeD,
        opacity_at: null
      };
      if (isNum(args.at_time)) {
        try {
          out.plate.opacity_at = l.property("ADBE Transform Group").property("ADBE Opacity").valueAtTime(args.at_time, false);
        } catch (eOp) {}
      }
    }
    if (args.place_comp_id !== undefined && args.place_comp_id !== null) {
      var pc = null;
      try {
        pc = requireComp(args.place_comp_id);
      } catch (ePlace) {
        out.place_error = { kind: errKind(ePlace, "not_found"), message: errText(ePlace) };
      }
      if (pc) out.place = { id: pc.id, name: pc.name, width: pc.width, height: pc.height, duration: pc.duration, num_layers: pc.numLayers };
    }
    var proj = { path: null, bits_per_channel: null, linear_blending: null };
    try {
      if (app.project.file) proj.path = app.project.file.fsName;
    } catch (e3) {}
    try {
      proj.bits_per_channel = app.project.bitsPerChannel;
    } catch (e4) {}
    try {
      proj.linear_blending = app.project.linearBlending;
    } catch (e5) {}
    out.project = proj;
    return out;
  };

  function layerState(l) {
    var s = { index: l.index, id: l.id, name: l.name, enabled: l.enabled === true, source_id: null, mask_count: 0 };
    try {
      if (l.source && l.source.id !== undefined) s.source_id = l.source.id;
    } catch (e0) {}
    s.position = null;
    s.masks = [];
    try {
      var masks = l.property("ADBE Mask Parade");
      if (masks) {
        s.mask_count = masks.numProperties;
        for (var m = 1; m <= masks.numProperties && m <= MAX_REGIONS; m++) {
          try {
            var mk = masks.property(m);
            s.masks.push({ feather: mk.property("ADBE Mask Feather").value[0], expansion: mk.property("ADBE Mask Offset").value });
          } catch (eM) {}
        }
      }
    } catch (e1) {}
    try {
      var pv = l.property("ADBE Transform Group").property("ADBE Position").value;
      s.position = [pv[0], pv[1]];
    } catch (e2) {}
    return s;
  }

  // args: { png_path, place_comp_id: number | null }
  A.inpaintState = function (args) {
    var want = normPath(args.png_path);
    var imported = [];
    var n = app.project.numItems;
    var scanned = n;
    if (scanned > MAX_ITEMS_SCANNED) scanned = MAX_ITEMS_SCANNED;
    for (var i = 1; i <= scanned; i++) {
      var it = null;
      try {
        it = app.project.item(i);
      } catch (e0) {
        it = null;
      }
      if (!it || !(it instanceof FootageItem)) continue;
      var f = null;
      try {
        f = it.file;
      } catch (e1) {
        f = null;
      }
      if (f && normPath(f.fsName) === want) imported.push({ id: it.id, name: it.name, width: it.width, height: it.height });
    }
    var out = { num_items: n, scanned: scanned, imported: imported, place: null };
    if (args.place_comp_id !== undefined && args.place_comp_id !== null) {
      var pc = requireComp(args.place_comp_id);
      var top = [];
      for (var k = 1; k <= pc.numLayers && k <= MAX_TOP_LAYERS; k++) top.push(layerState(pc.layer(k)));
      out.place = { id: pc.id, num_layers: pc.numLayers, top: top };
    }
    return out;
  };

  // ---------- the write ----------

  // A polygon is an array of [x, y] in the still's pixels (the layer's own space).
  function checkPolygons(regions) {
    if (!isArr(regions) || regions.length < 1) fail("bad_args", "A masked placement needs at least one region polygon.");
    if (regions.length > MAX_REGIONS) fail("bad_args", "At most " + MAX_REGIONS + " region polygons.");
    for (var i = 0; i < regions.length; i++) {
      var poly = regions[i];
      if (!isArr(poly) || poly.length < 3 || poly.length > MAX_POINTS) fail("bad_args", "Region " + (i + 1) + " needs 3 to " + MAX_POINTS + " points.");
      for (var j = 0; j < poly.length; j++) {
        if (!isArr(poly[j]) || poly[j].length !== 2 || !isNum(poly[j][0]) || !isNum(poly[j][1])) {
          fail("bad_args", "Region " + (i + 1) + " point " + (j + 1) + " is not a finite [x, y].");
        }
      }
    }
  }

  function addMask(layer, poly, feather, expansion, index) {
    var parade = layer.property("ADBE Mask Parade");
    if (!parade) fail("not_found", "The layer has no mask group.");
    var mask = parade.addProperty("ADBE Mask Atom");
    // Re-resolve by index: a reference to a sibling may go stale after addProperty.
    mask = parade.property(parade.numProperties);
    var shape = new Shape();
    var verts = [];
    for (var i = 0; i < poly.length; i++) verts.push([poly[i][0], poly[i][1]]);
    shape.vertices = verts;
    shape.closed = true;
    mask.property("ADBE Mask Shape").setValue(shape);
    mask.property("ADBE Mask Feather").setValue([feather, feather]);
    mask.property("ADBE Mask Offset").setValue(expansion);
    try {
      mask.maskMode = MaskMode.ADD;
    } catch (e0) {}
    try {
      mask.name = "Inpaint " + (index + 1);
    } catch (e1) {}
  }

  // args: { png_path, place: null | { comp_id, mode: "unmasked" | "masked", offset: [x, y] | null,
  //   regions: [[[x, y], ...], ...], feather_px, expansion_px, layer_name | null }, expect }
  // Imports the PNG as a still. With `place`, adds it on top of that comp: unmasked,
  // or masked to the hole regions (given in the still's pixels) with a feather and
  // an expansion, and positioned so the still's top-left corner lands at `offset`
  // (default: centred, as AE adds a layer).
  A.inpaintApply = function (args) {
    assertGuard(args.expect);
    if (typeof args.png_path !== "string" || args.png_path.length < 1) fail("bad_args", "png_path is required.");
    var file = new File(args.png_path);
    if (!file.exists) fail("not_found", "The fill image is not on disk: " + args.png_path);
    var place = args.place;
    var comp = null;
    var offset = null;
    var feather = 0;
    var expansion = 0;
    if (place) {
      comp = requireComp(place.comp_id);
      if (place.mode !== "unmasked" && place.mode !== "masked") fail("bad_args", "place.mode must be unmasked or masked.");
      if (place.offset !== undefined && place.offset !== null) {
        if (!isArr(place.offset) || place.offset.length !== 2 || !isNum(place.offset[0]) || !isNum(place.offset[1])) {
          fail("bad_args", "place.offset must be [x, y].");
        }
        offset = place.offset;
      }
      if (place.mode === "masked") {
        checkPolygons(place.regions);
        feather = Number(place.feather_px);
        expansion = Number(place.expansion_px);
        // The hard limits of the mask properties: AE throws "out of range" mid-write.
        if (!isNum(feather) || feather < 0 || feather > 500) fail("bad_args", "place.feather_px must be 0..500.");
        if (!isNum(expansion) || expansion < -1000 || expansion > 1000) fail("bad_args", "place.expansion_px must be -1000..1000.");
      }
    }

    return A.withUndo("Chroma AE MCP: inpaint plate", function () {
      var io = new ImportOptions(file);
      try {
        io.sequence = false;
      } catch (eSeq) {}
      var item = app.project.importFile(io);
      var out = {
        item: { id: item.id, name: item.name, width: item.width, height: item.height },
        layer: null,
        placed_in: null,
        mode: null,
        masks: 0,
        png_path: args.png_path
      };
      if (!comp) return out;
      try {
        var layer = comp.layers.add(item, comp.duration);
        layer.startTime = 0;
        if (place.layer_name) layer.name = String(place.layer_name);
        if (offset) {
          layer.property("ADBE Transform Group").property("ADBE Position").setValue([offset[0] + item.width / 2, offset[1] + item.height / 2]);
        }
        if (place.mode === "masked") {
          for (var i = 0; i < place.regions.length; i++) addMask(layer, place.regions[i], feather, expansion, i);
          out.masks = place.regions.length;
        }
        out.layer = { index: layer.index, id: layer.id, name: layer.name };
        out.placed_in = comp.id;
        out.mode = place.mode;
      } catch (ePlace) {
        // Never leave a half-placed fill: the layer goes with the item.
        try {
          item.remove();
        } catch (eRm) {}
        throw ePlace;
      }
      return out;
    });
  };
})($.global);
