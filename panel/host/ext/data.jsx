// panel/host/ext/data.jsx
//
// Host functions for ae_build_from_data:
// - buildFromData: one copy of a template comp per data row (or the template
//   itself, in place), with text, values, colours and footage set from the
//   row (guarded, one undo group)
// - readDataBuild: reads the mapped values back, plus text bounds, for the
//   server's check (a separate evalScript)
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

  function layerIndex(comp, sel) {
    var i;
    if (!sel) fail("bad_args", "layer selector missing");
    if (sel.id !== undefined && sel.id !== null) {
      for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).id === sel.id) return i;
      }
      fail("not_found", "No layer with id " + sel.id + " in the template comp");
    }
    if (sel.index !== undefined && sel.index !== null) {
      if (sel.index < 1 || sel.index > comp.numLayers) fail("not_found", "Layer index " + sel.index + " out of range");
      return sel.index;
    }
    if (sel.name !== undefined && sel.name !== null) {
      var count = 0;
      var found = 0;
      for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === sel.name) {
          count++;
          if (found === 0) found = i;
        }
      }
      if (count === 0) fail("not_found", "No layer named \"" + sel.name + "\" in the template comp");
      if (count > 1) fail("bad_args", count + " layers are named \"" + sel.name + "\" in the template comp; select by index");
      return found;
    }
    fail("bad_args", "layer selector needs id, index or name");
    return 0;
  }

  function resolvePath(layer, path) {
    var p = layer;
    for (var i = 0; i < path.length; i++) {
      var next = null;
      try { next = p.property(path[i]); } catch (e) { next = null; }
      if (!next) fail("not_found", "Property path not found at \"" + path[i] + "\" (" + path.join(" > ") + ") on layer \"" + layer.name + "\"");
      p = next;
    }
    if (p.propertyType !== PropertyType.PROPERTY) fail("bad_args", "Path " + path.join(" > ") + " is a group, not a property");
    return p;
  }

  function textProp(layer) {
    var p = null;
    try { p = layer.property("ADBE Text Properties").property("ADBE Text Document"); } catch (e) { p = null; }
    if (!p) fail("bad_args", "Layer \"" + layer.name + "\" is not a text layer");
    return p;
  }

  // The keys a value goes on: none for a static property, else the chosen ones.
  function targetKeys(p, which) {
    var keys = [];
    var n = p.numKeys;
    if (n === 0) return keys;
    if (which === "all") {
      for (var k = 1; k <= n; k++) keys.push(k);
    } else if (which === "first") {
      keys.push(1);
    } else if (typeof which === "number") {
      if (which < 1 || which > n) fail("bad_args", "Keyframe " + which + " out of range (1.." + n + ") on " + p.name);
      keys.push(which);
    } else {
      keys.push(n);
    }
    return keys;
  }

  function sameFile(item, fsName) {
    try {
      if (!(item instanceof FootageItem) || !item.mainSource || !item.mainSource.file) return false;
      return String(item.mainSource.file.fsName).toLowerCase() === String(fsName).toLowerCase();
    } catch (e) {
      return false;
    }
  }

  function footageFor(path, cache, folder) {
    if (cache[path]) return cache[path];
    var f = new File(path);
    if (!f.exists) fail("not_found", "Footage file not found: " + path);
    var i;
    for (i = 1; i <= app.project.numItems; i++) {
      if (sameFile(app.project.item(i), f.fsName)) {
        cache[path] = app.project.item(i);
        return cache[path];
      }
    }
    var item = app.project.importFile(new ImportOptions(f));
    if (folder) item.parentFolder = folder;
    cache[path] = item;
    return item;
  }

  function applyOne(comp, m, value, cache, folder, notes) {
    var layer = comp.layer(m.index);
    var p;
    var keys;
    var k;
    if (m.target === "text") {
      p = textProp(layer);
      keys = targetKeys(p, "all");
      if (keys.length === 0) {
        var doc = p.value;
        doc.text = value;
        p.setValue(doc);
      } else {
        for (k = 0; k < keys.length; k++) {
          var kdoc = p.keyValue(keys[k]);
          kdoc.text = value;
          p.setValueAtKey(keys[k], kdoc);
        }
      }
      return;
    }
    if (m.target === "footage") {
      var item = footageFor(value, cache, folder);
      try {
        layer.replaceSource(item, false);
      } catch (e) {
        fail("bad_args", "Layer \"" + layer.name + "\" can't take footage: " + e.message);
      }
      return;
    }
    p = resolvePath(layer, m.path);
    if (p.expressionEnabled && p.expression) {
      notes.push(layer.name + " > " + p.name + " has an expression, which overrides the value");
    }
    keys = targetKeys(p, m.keyframe);
    if (keys.length === 0) {
      p.setValue(value);
    } else {
      for (k = 0; k < keys.length; k++) p.setValueAtKey(keys[k], value);
    }
  }

  function findOrMakeFolder(name) {
    if (!name) return null;
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it instanceof FolderItem && it.name === name && it.parentFolder === app.project.rootFolder) return it;
    }
    return app.project.items.addFolder(name);
  }

  function resolveMappings(template, mapping) {
    var out = [];
    for (var i = 0; i < mapping.length; i++) {
      var m = mapping[i];
      var idx = layerIndex(template, m.layer);
      var layer = template.layer(idx);
      if (m.target === "text") {
        textProp(layer);
      } else if (m.target !== "footage") {
        resolvePath(layer, m.path);
      }
      out.push({ index: idx, layer_name: layer.name, target: m.target, path: m.path, keyframe: m.keyframe });
    }
    return out;
  }

  // Numbers a property takes: 1, 2, 3, 4 for a colour, 0 when it takes none.
  function valueDims(p) {
    var t = p.propertyValueType;
    if (t === PropertyValueType.COLOR) return 4;
    if (t === PropertyValueType.ThreeD || t === PropertyValueType.ThreeD_SPATIAL) return 3;
    if (t === PropertyValueType.TwoD || t === PropertyValueType.TwoD_SPATIAL) return 2;
    if (t === PropertyValueType.OneD || t === PropertyValueType.LAYER_INDEX || t === PropertyValueType.MASK_INDEX) return 1;
    return 0;
  }

  function canTakeFootage(layer) {
    if (!(layer instanceof AVLayer)) return false;
    if ((layer instanceof TextLayer) || (layer instanceof ShapeLayer)) return false;
    try {
      if (layer.nullLayer === true || layer.adjustmentLayer === true) return false;
    } catch (e0) {}
    var src = null;
    try { src = layer.source; } catch (e1) { src = null; }
    if (!src) return false;
    return true;
  }

  // Read-only: what each mapped layer or property in the template takes, so
  // the server can refuse a wrong shape of cell before anything is written.
  A.inspectDataMapping = function (args) {
    var template = requireComp(args.template_comp_id);
    var out = [];
    for (var i = 0; i < args.mapping.length; i++) {
      var m = args.mapping[i];
      var item = {};
      try {
        var layer = template.layer(layerIndex(template, m.layer));
        if (m.target === "text") {
          var tp = textProp(layer);
          item = { kind: "text", dims: 0, is_color: false, num_keys: tp.numKeys, can_take_footage: false };
        } else if (m.target === "footage") {
          item = { kind: "footage", dims: 0, is_color: false, num_keys: 0, can_take_footage: canTakeFootage(layer) };
        } else {
          var prop = resolvePath(layer, m.path);
          var dims = valueDims(prop);
          item = { kind: "property", dims: dims, is_color: dims === 4 && prop.propertyValueType === PropertyValueType.COLOR, num_keys: prop.numKeys, can_take_footage: false };
        }
      } catch (e) {
        var why = String(e);
        if (e && e.message) why = e.message;
        item = { error: why };
      }
      out.push(item);
    }
    return { mappings: out };
  };

  A.buildFromData = function (args) {
    assertGuard(args.expect);
    var template = requireComp(args.template_comp_id);
    var maps = resolveMappings(template, args.mapping);
    var rows = args.rows;
    if (args.in_place && rows.length !== 1) fail("bad_args", "in_place takes exactly one row");
    var label = "Chroma AE MCP: build " + rows.length + " from data";
    if (args.in_place) label = "Chroma AE MCP: set " + template.name + " from data";
    return A.withUndo(label, function () {
      var folder = null;
      if (!args.in_place) folder = findOrMakeFolder(args.folder_name);
      var cache = {};
      var comps = [];
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var comp = template;
        var notes = [];
        var copied = false;
        try {
          if (!args.in_place) {
            comp = template.duplicate();
            copied = true;
            comp.name = row.name;
            if (folder) comp.parentFolder = folder;
          }
          for (var m = 0; m < maps.length; m++) {
            var v = row.values[m];
            if (v === null || v === undefined) continue;
            applyOne(comp, maps[m], v, cache, folder, notes);
          }
        } catch (rowErr) {
          var why = String(rowErr);
          if (rowErr && rowErr.message) why = rowErr.message;
          var msg = "Row " + row.row + " (\"" + row.name + "\") failed: " + why + ".";
          if (args.in_place) {
            msg += " The template was partly changed; Edit > Undo reverts it.";
          } else {
            if (comps.length > 0) {
              msg += " The " + comps.length + " row(s) before it were built inside the same undo step; Edit > Undo removes them.";
            }
            if (copied) {
              msg += " Its partly built copy \"" + comp.name + "\" is in the project too (the same Undo removes it).";
            }
          }
          var kind = "build_failed";
          if (rowErr && rowErr.__kind) kind = rowErr.__kind;
          fail(kind, msg, { actual: { failed_row: row.row, built: comps } });
        }
        comps.push({ comp_id: comp.id, name: comp.name, row: row.row, notes: notes });
      }
      var folderId = null;
      if (folder) folderId = folder.id;
      return { folder_id: folderId, mapping: maps, comps: comps };
    });
  };

  function insideArea(box, w, h) {
    var iw = Math.min(box.right, w) - Math.max(box.left, 0);
    var ih = Math.min(box.bottom, h) - Math.max(box.top, 0);
    if (iw <= 0 || ih <= 0) return 0;
    return iw * ih;
  }

  // Comp-space extent of a text layer (ignoring rotation) at its rest time:
  // of nine times across the layer's span, the one where most of it is inside
  // the frame (ties go to the time nearest the middle). Enough to tell when a
  // longer string runs off the frame, without flagging text that slides in.
  function textExtent(comp, layer) {
    var tr = layer.property("ADBE Transform Group");
    var t0 = layer.inPoint;
    if (t0 < 0) t0 = 0;
    var t1 = layer.outPoint;
    if (t1 > comp.duration) t1 = comp.duration;
    t1 = t1 - comp.frameDuration;
    if (t1 < t0) t1 = t0;
    var mid = (t0 + t1) / 2;
    var best = null;
    var bestArea = -1;
    var bestDist = 0;
    for (var i = 0; i < 9; i++) {
      var t = t0 + (t1 - t0) * i / 8;
      var r = layer.sourceRectAtTime(t, false);
      var pos = tr.property("ADBE Position").valueAtTime(t, false);
      var anc = tr.property("ADBE Anchor Point").valueAtTime(t, false);
      var sc = tr.property("ADBE Scale").valueAtTime(t, false);
      var left = pos[0] + (r.left - anc[0]) * sc[0] / 100;
      var top = pos[1] + (r.top - anc[1]) * sc[1] / 100;
      var right = left + r.width * sc[0] / 100;
      var bottom = top + r.height * sc[1] / 100;
      if (right < left) { var sw = left; left = right; right = sw; }
      if (bottom < top) { var st = top; top = bottom; bottom = st; }
      var box = { left: left, top: top, right: right, bottom: bottom };
      var area = insideArea(box, comp.width, comp.height);
      var dist = Math.abs(t - mid);
      var take = false;
      if (best === null) {
        take = true;
      } else if (area > bestArea + 0.5) {
        take = true;
      } else if (area >= bestArea - 0.5 && dist < bestDist) {
        take = true;
      }
      if (take) {
        best = box;
        if (area > bestArea) bestArea = area;
        bestDist = dist;
      }
    }
    return best;
  }

  function plainValue(v) {
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(v[i]);
      return a;
    }
    return v;
  }

  function readOne(comp, m) {
    var layer = comp.layer(m.index);
    if (m.target === "text") {
      var p = textProp(layer);
      var out = { text: String(p.value.text) };
      var parented = false;
      try { parented = layer.parent !== null; } catch (e1) {}
      if (!parented) {
        try { out.bounds = textExtent(comp, layer); } catch (e2) {}
      }
      return out;
    }
    if (m.target === "footage") {
      var path = null;
      try { path = layer.source.mainSource.file.fsName; } catch (e3) {}
      return { footage: path };
    }
    var prop = resolvePath(layer, m.path);
    var keys = targetKeys(prop, m.keyframe);
    if (keys.length === 0) return { value: plainValue(prop.value) };
    var vals = [];
    for (var k = 0; k < keys.length; k++) vals.push(plainValue(prop.keyValue(keys[k])));
    return { value: vals[0], keys: keys, key_values: vals };
  }

  A.readDataBuild = function (args) {
    var out = [];
    for (var i = 0; i < args.comp_ids.length; i++) {
      var c = requireComp(args.comp_ids[i]);
      var vals = [];
      for (var m = 0; m < args.mapping.length; m++) vals.push(readOne(c, args.mapping[m]));
      out.push({ comp_id: c.id, name: c.name, width: c.width, height: c.height, values: vals });
    }
    return { comps: out };
  };
})($.global);
