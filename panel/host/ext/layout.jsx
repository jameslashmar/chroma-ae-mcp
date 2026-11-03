// panel/host/ext/layout.jsx
//
// Host functions for layout and housekeeping:
// - boundsOf (read): layers' content boxes in comp pixels at a time
// - alignLayers (guarded write): align to the comp, the safe areas or the
//   layers' own box, or distribute their centres evenly
// - unusedItems (read) / purgeItems (guarded write): footage, solids and
//   placeholders no comp uses, and empty folders
// - exportMogrt (no undo group: it writes a file, not the project)
// - styleScan (read): fonts, sizes and colours used by text, shape and solid
//   layers, for the house style check
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Before and after reads run in separate evalScript calls from the server.
// - Never suppress dialogs: a popup is read and answered through ae_dialogs.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_DEPTH = 6;

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

  function copy(v) {
    if (v instanceof Array) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push(copy(v[i]));
      return out;
    }
    return v;
  }

  // ---------- bounds ----------

  // Layer to comp for an unparented 2D layer: position * rotation * scale * (-anchor).
  function boxAt(l, t) {
    var tr = l.property("ADBE Transform Group");
    var an = tr.property("ADBE Anchor Point").valueAtTime(t, false);
    var po = tr.property("ADBE Position").valueAtTime(t, false);
    var sc = tr.property("ADBE Scale").valueAtTime(t, false);
    var ro = tr.property("ADBE Rotate Z").valueAtTime(t, false);
    var rad = (ro * Math.PI) / 180;
    var cs = Math.cos(rad);
    var sn = Math.sin(rad);
    var a = cs * sc[0] / 100;
    var b = -sn * sc[1] / 100;
    var d = sn * sc[0] / 100;
    var e = cs * sc[1] / 100;
    var c = po[0] - (a * an[0] + b * an[1]);
    var f = po[1] - (d * an[0] + e * an[1]);
    var r = l.sourceRectAtTime(t, false);
    var xs = [r.left, r.left + r.width];
    var ys = [r.top, r.top + r.height];
    var box = [1e12, 1e12, -1e12, -1e12];
    for (var i = 0; i < 2; i++) {
      for (var j = 0; j < 2; j++) {
        var x = a * xs[i] + b * ys[j] + c;
        var y = d * xs[i] + e * ys[j] + f;
        if (x < box[0]) box[0] = x;
        if (y < box[1]) box[1] = y;
        if (x > box[2]) box[2] = x;
        if (y > box[3]) box[3] = y;
      }
    }
    return box;
  }

  function layoutLayer(comp, sel) {
    var l = findLayer(comp, sel);
    if (l.threeDLayer === true) fail("bad_args", "\"" + l.name + "\" is 3D; its screen box depends on the camera");
    if (l.parent) fail("bad_args", "\"" + l.name + "\" is parented; move its parent, or unparent it first");
    var kind = "";
    try { kind = String(l.reflect.name); } catch (e) {}
    if (kind === "CameraLayer" || kind === "LightLayer") fail("bad_args", "\"" + l.name + "\" has no picture to align");
    return l;
  }

  A.boundsOf = function (args) {
    var comp = requireComp(args.comp_id);
    var t = comp.time;
    if (args.time !== undefined && args.time !== null) t = args.time;
    var out = [];
    for (var i = 0; i < args.layers.length && i < MAX_LIST; i++) {
      var l = findLayer(comp, args.layers[i]);
      var entry = { index: l.index, id: l.id, name: l.name, rect: null };
      try { if (!l.threeDLayer && !l.parent) entry.rect = boxAt(l, t); } catch (e) { entry.error = e.message; }
      out.push(entry);
    }
    return { comp_id: comp.id, width: comp.width, height: comp.height, time: t, layers: out };
  };

  function targetBox(comp, to, rects) {
    var W = comp.width;
    var H = comp.height;
    if (to === "action_safe") return [W * 0.05, H * 0.05, W * 0.95, H * 0.95];
    if (to === "title_safe") return [W * 0.1, H * 0.1, W * 0.9, H * 0.9];
    if (to === "layers") {
      var u = [1e12, 1e12, -1e12, -1e12];
      for (var i = 0; i < rects.length; i++) {
        if (rects[i][0] < u[0]) u[0] = rects[i][0];
        if (rects[i][1] < u[1]) u[1] = rects[i][1];
        if (rects[i][2] > u[2]) u[2] = rects[i][2];
        if (rects[i][3] > u[3]) u[3] = rects[i][3];
      }
      return u;
    }
    return [0, 0, W, H];
  }

  function alignDelta(align, r, box) {
    if (align === "left") return [box[0] - r[0], 0];
    if (align === "right") return [box[2] - r[2], 0];
    if (align === "center_h") return [(box[0] + box[2]) / 2 - (r[0] + r[2]) / 2, 0];
    if (align === "top") return [0, box[1] - r[1]];
    if (align === "bottom") return [0, box[3] - r[3]];
    if (align === "center_v") return [0, (box[1] + box[3]) / 2 - (r[1] + r[3]) / 2];
    fail("bad_args", "Unknown align \"" + align + "\"");
    return null;
  }

  // Moves a layer by [dx, dy]: its static position, or with shift_keys every key.
  function moveBy(l, dx, dy, shiftKeys) {
    var tr = l.property("ADBE Transform Group");
    var pos = tr.property("ADBE Position");
    var separated = false;
    try { separated = pos.dimensionsSeparated === true; } catch (e) {}
    var targets = [];
    if (separated) {
      targets.push({ p: tr.property("ADBE Position_0"), d: dx, axis: -1 });
      targets.push({ p: tr.property("ADBE Position_1"), d: dy, axis: -1 });
    } else {
      targets.push({ p: pos, d: [dx, dy], axis: 0 });
    }
    for (var i = 0; i < targets.length; i++) {
      var tg = targets[i];
      if (tg.p.numKeys > 0) {
        if (!shiftKeys) fail("bad_args", "\"" + l.name + "\"'s position is animated; pass shift_keys to move every key");
        for (var k = 1; k <= tg.p.numKeys; k++) tg.p.setValueAtKey(k, shifted(tg.p.keyValue(k), tg));
      } else {
        tg.p.setValue(shifted(tg.p.value, tg));
      }
    }
  }

  function shifted(v, tg) {
    if (tg.axis === -1) return v + tg.d;
    var out = copy(v);
    out[0] = out[0] + tg.d[0];
    out[1] = out[1] + tg.d[1];
    return out;
  }

  A.alignLayers = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var t = comp.time;
    if (args.time !== undefined && args.time !== null) t = args.time;
    var layers = [];
    var rects = [];
    for (var i = 0; i < args.layers.length; i++) {
      var l = layoutLayer(comp, args.layers[i]);
      layers.push(l);
      rects.push(boxAt(l, t));
    }
    var box = targetBox(comp, args.to || "comp", rects);
    var deltas = [];
    var j;
    if (args.align) {
      for (j = 0; j < layers.length; j++) deltas.push(alignDelta(args.align, rects[j], box));
    } else if (args.distribute) {
      var horizontal = args.distribute === "horizontal";
      var order = [];
      for (j = 0; j < layers.length; j++) order.push(j);
      var centre = function (r) {
        if (horizontal) return (r[0] + r[2]) / 2;
        return (r[1] + r[3]) / 2;
      };
      order.sort(function (a, b) { return centre(rects[a]) - centre(rects[b]); });
      var n = order.length;
      var first = centre(rects[order[0]]);
      var last = centre(rects[order[n - 1]]);
      if (args.to && args.to !== "layers") {
        // Spread over the box: equal slots, a centre in each.
        var lo = box[0];
        var hi = box[2];
        if (!horizontal) {
          lo = box[1];
          hi = box[3];
        }
        first = lo + (hi - lo) / (2 * n);
        last = hi - (hi - lo) / (2 * n);
      }
      for (j = 0; j < n; j++) deltas.push([0, 0]);
      for (j = 0; j < n; j++) {
        var want = first;
        if (n > 1) want = first + ((last - first) * j) / (n - 1);
        var d = want - centre(rects[order[j]]);
        if (horizontal) deltas[order[j]] = [d, 0];
        else deltas[order[j]] = [0, d];
      }
    } else {
      fail("bad_args", "Give align or distribute");
    }
    return A.withUndo(args.label || "Align layers", function () {
      var moved = [];
      for (var k = 0; k < layers.length; k++) {
        moveBy(layers[k], deltas[k][0], deltas[k][1], args.shift_keys === true);
        moved.push({ index: layers[k].index, id: layers[k].id, name: layers[k].name, delta: deltas[k], before: rects[k] });
      }
      return { time: t, box: box, moved: moved };
    });
  };

  // ---------- unused items ----------

  function footageKind(it) {
    try { if (it.mainSource instanceof SolidSource) return "solid"; } catch (e1) {}
    try { if (it.mainSource instanceof PlaceholderSource) return "placeholder"; } catch (e2) {}
    return "footage";
  }

  function isUnused(it) {
    try { return it.usedIn.length === 0; } catch (e) { return false; }
  }

  A.unusedItems = function (args) {
    var kinds = {};
    var list = (args && args.kinds) || ["footage", "solid", "placeholder"];
    for (var k = 0; k < list.length; k++) kinds[list[k]] = true;
    var items = [];
    var folders = [];
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it instanceof FootageItem) {
        var kind = footageKind(it);
        if (!kinds[kind] || !isUnused(it)) continue;
        if (items.length >= MAX_LIST) continue;
        var e = { id: it.id, name: it.name, kind: kind, file: null };
        try { if (it.file) e.file = it.file.fsName; } catch (eF) {}
        items.push(e);
      } else if (it instanceof FolderItem && args && args.empty_folders && it.numItems === 0) {
        folders.push({ id: it.id, name: it.name, kind: "folder" });
      }
    }
    return { items: items, folders: folders, numItems: app.project.numItems };
  };

  A.purgeItems = function (args) {
    assertGuard(args.expect);
    var targets = [];
    for (var i = 0; i < args.ids.length; i++) {
      var it = null;
      try { it = app.project.itemByID(args.ids[i]); } catch (e) { it = null; }
      if (!it) fail("not_found", "No project item with id " + args.ids[i]);
      if (it instanceof FootageItem && !isUnused(it)) fail("bad_args", "\"" + it.name + "\" is used by a comp now; read the unused list again");
      if (it instanceof FolderItem && it.numItems > 0) fail("bad_args", "Folder \"" + it.name + "\" is not empty");
      if (it instanceof CompItem) fail("bad_args", "\"" + it.name + "\" is a comp; this removes footage, solids, placeholders and empty folders only");
      targets.push(it);
    }
    return A.withUndo(args.label || "Remove unused items", function () {
      var removed = [];
      for (var k = 0; k < targets.length; k++) {
        removed.push({ id: targets[k].id, name: targets[k].name });
        targets[k].remove();
      }
      return { removed: removed, numItems: app.project.numItems };
    });
  };

  // ---------- MOGRT ----------

  A.exportMogrt = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var n = 0;
    try { n = comp.motionGraphicsTemplateControllerCount; } catch (e1) {}
    if (n === 0) fail("bad_args", "\"" + comp.name + "\" has no Essential Graphics controllers to export (ae_set_essential_graphics adds them)");
    if (!app.project.file) fail("bad_args", "Save the project first: AE exports templates from a saved project");
    if (app.project.dirty) fail("bad_args", "The project has unsaved changes; ae_save first so the template matches what you see");
    var ok;
    if (args.path) ok = comp.exportAsMotionGraphicsTemplate(args.overwrite === true, args.path);
    else ok = comp.exportAsMotionGraphicsTemplate(args.overwrite === true);
    return { exported: ok === true, controllers: n, template_name: comp.motionGraphicsTemplateName };
  };

  // ---------- style scan ----------

  function rgb(c) {
    if (!c) return null;
    return [c[0], c[1], c[2]];
  }

  function shapeColours(group, path, out, depth) {
    if (depth > MAX_DEPTH) return;
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      var mn = p.matchName;
      if (mn === "ADBE Vector Graphic - Fill") {
        try { out.push({ where: path.concat([p.name]).join(" > "), role: "fill", rgb: rgb(p.property("ADBE Vector Fill Color").value) }); } catch (e1) {}
      } else if (mn === "ADBE Vector Graphic - Stroke") {
        try { out.push({ where: path.concat([p.name]).join(" > "), role: "stroke", rgb: rgb(p.property("ADBE Vector Stroke Color").value) }); } catch (e2) {}
      } else if (mn === "ADBE Vector Group") {
        try { shapeColours(p.property("ADBE Vectors Group"), path.concat([p.name]), out, depth + 1); } catch (e3) {}
      }
    }
  }

  A.styleScan = function (args) {
    var comp = requireComp(args.comp_id);
    var out = [];
    for (var i = 1; i <= comp.numLayers && out.length < MAX_LIST; i++) {
      var l = comp.layer(i);
      var kind = "";
      try { kind = String(l.reflect.name); } catch (e0) {}
      var entry = { index: l.index, id: l.id, name: l.name, kind: "other", enabled: l.enabled, colours: [] };
      if (kind === "TextLayer") {
        entry.kind = "text";
        try {
          var td = l.property("ADBE Text Properties").property("ADBE Text Document").value;
          entry.font = td.font;
          entry.family = td.fontFamily;
          entry.font_size = td.fontSize;
          try { if (td.fontObject) entry.font_missing = td.fontObject.isSubstitute === true; } catch (eM) {}
          if (td.applyFill) entry.colours.push({ where: "text fill", role: "fill", rgb: rgb(td.fillColor) });
          if (td.applyStroke) entry.colours.push({ where: "text stroke", role: "stroke", rgb: rgb(td.strokeColor) });
        } catch (e1) {}
      } else if (kind === "ShapeLayer") {
        entry.kind = "shape";
        try { shapeColours(l.property("ADBE Root Vectors Group"), [], entry.colours, 0); } catch (e2) {}
      } else {
        try {
          if (l.source && l.source.mainSource instanceof SolidSource && !l.adjustmentLayer && !l.nullLayer) {
            entry.kind = "solid";
            entry.colours.push({ where: "solid", role: "fill", rgb: rgb(l.source.mainSource.color) });
          }
        } catch (e3) {}
      }
      if (entry.kind !== "other") out.push(entry);
    }
    return { comp_id: comp.id, name: comp.name, width: comp.width, height: comp.height, time: comp.time, layers: out };
  };
})($.global);
