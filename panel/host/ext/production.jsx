// panel/host/ext/production.jsx
//
// Host functions for the production tools:
// - egpRead (read): a comp's Essential Graphics template name and
//   controllers, and a precomp layer's overrides (Essential Properties)
// - egpEdit (guarded write): add a property to the template, rename a
//   controller, name the template, set overrides on a precomp layer
// - renderTemplates (read, or a guarded write with a temporary render-queue
//   item): render-settings and output-module template names
// - footageFiles (read): footage items with their files, for versioning
// - versionFootage (guarded write): replace several footage items' files
// - batchRead (read) / batchSet (guarded write): many property writes in
//   one undo group, checked before anything changes
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;

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

  function resolvePath(layer, path) {
    var p = layer;
    for (var i = 0; i < path.length; i++) {
      var next = null;
      try {
        next = p.property(path[i]);
      } catch (e) {
        next = null;
      }
      if (!next) fail("not_found", "Property path not found at \"" + path[i] + "\" (" + path.join(" > ") + ")");
      p = next;
    }
    return p;
  }

  function plain(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
    if (v instanceof Array) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push(plain(v[i]));
      return out;
    }
    try {
      if (v instanceof TextDocument) return { text: v.text };
    } catch (eT) {}
    return String(v);
  }

  // ---------- Essential Graphics ----------

  function overridesOf(layer) {
    var g = null;
    try { g = layer.property("ADBE Layer Overrides"); } catch (e) { g = null; }
    return g;
  }

  A.egpRead = function (args) {
    var comp = requireComp(args.comp_id);
    var out = { comp_id: comp.id, template_name: null, controllers: [], supported: true };
    var n = 0;
    try {
      n = comp.motionGraphicsTemplateControllerCount;
      out.template_name = comp.motionGraphicsTemplateName;
    } catch (e1) {
      out.supported = false;
    }
    for (var i = 1; i <= n && i <= MAX_LIST; i++) {
      var name = null;
      try { name = comp.getMotionGraphicsTemplateControllerName(i); } catch (e2) {}
      out.controllers.push({ index: i, name: name });
    }
    if (args.layer) {
      var layer = findLayer(comp, args.layer);
      var g = overridesOf(layer);
      var list = [];
      if (g) {
        for (var k = 1; k <= g.numProperties && list.length < MAX_LIST; k++) {
          var p = g.property(k);
          var entry = { index: k, name: p.name };
          try { if (p.propertyType === PropertyType.PROPERTY) entry.value = plain(p.value); } catch (e3) {}
          list.push(entry);
        }
      }
      out.layer = { index: layer.index, id: layer.id, name: layer.name, has_overrides: g !== null };
      out.overrides = list;
    }
    return out;
  };

  A.egpEdit = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var action = args.action;
    var target = null;
    var layer = null;
    if (action === "add") {
      layer = findLayer(comp, args.layer);
      target = resolvePath(layer, args.path);
      var can = true;
      try { can = target.canAddToMotionGraphicsTemplate(comp); } catch (eCan) { can = false; }
      if (!can) fail("bad_args", "AE won't add \"" + args.path.join(" > ") + "\" to the Essential Graphics template");
    } else if (action === "rename") {
      var count = 0;
      try { count = comp.motionGraphicsTemplateControllerCount; } catch (eCount) {}
      if (args.index < 1 || args.index > count) fail("not_found", "Controller " + args.index + " out of range (1.." + count + ")");
    } else if (action === "set_override") {
      layer = findLayer(comp, args.layer);
      var g = overridesOf(layer);
      if (!g) fail("bad_args", "\"" + layer.name + "\" has no Essential Properties (it must be a precomp layer of a comp with a template)");
      target = g.property(args.name);
      if (!target) fail("not_found", "No Essential Property \"" + args.name + "\" on \"" + layer.name + "\"");
    } else if (action !== "template_name") {
      fail("bad_args", "Unknown action \"" + action + "\"");
    }
    return A.withUndo(args.label || "Essential Graphics", function () {
      if (action === "add") {
        if (args.name) target.addToMotionGraphicsTemplateAs(comp, args.name);
        else target.addToMotionGraphicsTemplate(comp);
        return { action: action, count: comp.motionGraphicsTemplateControllerCount };
      }
      if (action === "rename") {
        comp.setMotionGraphicsControllerName(args.index, args.name);
        return { action: action, index: args.index };
      }
      if (action === "template_name") {
        comp.motionGraphicsTemplateName = args.name;
        return { action: action };
      }
      var v = args.value;
      try {
        if (target.propertyValueType === PropertyValueType.TEXT_DOCUMENT) {
          var doc = target.value;
          doc.text = String(v);
          v = doc;
        }
      } catch (eDoc) {}
      target.setValue(v);
      return { action: action, layer: { index: layer.index, id: layer.id, name: layer.name }, name: args.name };
    });
  };

  // ---------- render templates ----------

  function templatesOf(rqItem) {
    var rs = [];
    var om = [];
    var i;
    try {
      var t = rqItem.templates;
      for (i = 0; i < t.length && i < MAX_LIST; i++) rs.push(String(t[i]));
    } catch (e1) {}
    try {
      var o = rqItem.outputModule(1).templates;
      for (i = 0; i < o.length && i < MAX_LIST; i++) om.push(String(o[i]));
    } catch (e2) {}
    return { render_settings: rs, output_modules: om };
  }

  // Reads the template names from a render-queue item: an existing one when
  // there is one (nothing changes), otherwise, with allow_temp, a temporary
  // item that is removed again (that marks the project changed).
  A.renderTemplates = function (args) {
    var rq = app.project.renderQueue;
    if (rq.numItems > 0) {
      var t = templatesOf(rq.item(1));
      t.source = "existing_item";
      return t;
    }
    if (!args.allow_temp) {
      return { source: "none", needs_item: true, render_settings: [], output_modules: [] };
    }
    assertGuard(args.expect);
    var comp = null;
    if (args.comp_id !== undefined && args.comp_id !== null) comp = requireComp(args.comp_id);
    else {
      for (var i = 1; i <= app.project.numItems && !comp; i++) {
        if (app.project.item(i) instanceof CompItem) comp = app.project.item(i);
      }
    }
    if (!comp) fail("bad_args", "The project has no comp to make a temporary render-queue item from");
    return A.withUndo(args.label || "Read render templates", function () {
      var item = rq.items.add(comp);
      var out = templatesOf(item);
      item.remove();
      out.source = "temporary_item";
      return out;
    });
  };

  // ---------- footage files and versions ----------

  function fileOf(it) {
    try { if (it.file) return it.file.fsName; } catch (e1) {}
    try { if (it.mainSource && it.mainSource.file) return it.mainSource.file.fsName; } catch (e2) {}
    return null;
  }

  var STILL_EXT = { png: 1, jpg: 1, jpeg: 1, tif: 1, tiff: 1, exr: 1, dpx: 1, tga: 1, psd: 1, bmp: 1, cin: 1, hdr: 1, webp: 1 };

  function isSequence(it, path) {
    var still = true;
    try { still = it.mainSource.isStill === true; } catch (e) {}
    if (still) return false;
    var m = /\.([A-Za-z0-9]+)$/.exec(String(path));
    return m !== null && STILL_EXT[m[1].toLowerCase()] === 1;
  }

  A.footageFiles = function (args) {
    var want = null;
    if (args && args.item_ids) {
      want = {};
      for (var w = 0; w < args.item_ids.length; w++) want[args.item_ids[w]] = true;
    }
    var out = [];
    var truncated = false;
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (!(it instanceof FootageItem)) continue;
      if (want && !want[it.id]) continue;
      var path = fileOf(it);
      if (!path) continue;
      // Only a 501st match means something was left out.
      if (out.length >= MAX_LIST) { truncated = true; break; }
      var missing = false;
      try { missing = it.footageMissing === true; } catch (eM) {}
      var uses = 0;
      try { uses = it.usedIn.length; } catch (eU) {}
      out.push({ item_id: it.id, name: it.name, file: path, missing: missing, sequence: isSequence(it, path), used_in: uses });
    }
    var projectPath = "<unsaved>";
    try { if (app.project.file) projectPath = app.project.file.fsName; } catch (eP) {}
    return { project_path: projectPath, items: out, truncated: truncated };
  };

  A.versionFootage = function (args) {
    assertGuard(args.expect);
    var jobs = args.items || [];
    var resolved = [];
    for (var i = 0; i < jobs.length; i++) {
      var it = null;
      try { it = app.project.itemByID(jobs[i].item_id); } catch (e) { it = null; }
      if (!it || !(it instanceof FootageItem)) fail("not_found", "No footage item with id " + jobs[i].item_id);
      var f = new File(jobs[i].path);
      if (!f.exists) fail("not_found", "The new version does not exist: " + jobs[i].path);
      resolved.push({ item: it, file: f, sequence: jobs[i].sequence === true, from: fileOf(it) });
    }
    return A.withUndo(args.label || "Version up footage", function () {
      var done = [];
      for (var k = 0; k < resolved.length; k++) {
        var r = resolved[k];
        // false: numeric frame order with placeholders for gaps, as ae_import_assets imports a sequence.
        if (r.sequence) r.item.replaceWithSequence(r.file, false);
        else r.item.replace(r.file);
        done.push({ item_id: r.item.id, name: r.item.name, from: r.from, to: r.file.fsName });
      }
      return { replaced: done };
    });
  };

  // ---------- batch property writes ----------

  // Every op's layer and property, found before anything is written. base is
  // the number of ops in earlier chunks, so messages name the op's place in the whole batch.
  function resolveOps(comp, ops, base) {
    var out = [];
    var skip = base || 0;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      var n = skip + i + 1;
      var layer;
      var prop;
      try {
        layer = findLayer(comp, op.layer);
        prop = resolvePath(layer, op.path);
      } catch (e) {
        fail("bad_args", "Op " + n + ": " + e.message);
      }
      if (prop.propertyType !== PropertyType.PROPERTY) fail("bad_args", "Op " + n + ": " + op.path.join(" > ") + " is a group");
      if (op.expression !== undefined && op.expression !== null && !prop.canSetExpression) {
        fail("bad_args", "Op " + n + ": " + prop.name + " can't take an expression");
      }
      out.push({ layer: layer, prop: prop });
    }
    return out;
  }

  // Read-only: the same checks batchSet makes, so the server can run them on
  // every chunk before the first write. Reports the first bad op, changes nothing.
  A.batchValidate = function (args) {
    var comp = requireComp(args.comp_id);
    var ops = args.ops || [];
    if (ops.length > MAX_LIST) fail("bad_args", "At most " + MAX_LIST + " ops per check");
    try {
      resolveOps(comp, ops, args.base);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return { ok: true, checked: ops.length };
  };

  A.batchRead = function (args) {
    var comp = requireComp(args.comp_id);
    var ops = args.ops || [];
    var out = [];
    for (var i = 0; i < ops.length && i < MAX_LIST; i++) {
      var entry = { op: i + 1 };
      try {
        var p = resolvePath(findLayer(comp, ops[i].layer), ops[i].path);
        entry.numKeys = p.numKeys;
        if (p.numKeys > 0) entry.value = plain(p.valueAtTime(comp.time, true));
        else entry.value = plain(p.value);
        if (ops[i].times) {
          entry.keys = [];
          for (var t = 0; t < ops[i].times.length; t++) {
            var kt = ops[i].times[t];
            var idx = p.numKeys > 0 ? p.nearestKeyIndex(kt) : 0;
            if (idx > 0 && Math.abs(p.keyTime(idx) - kt) < 0.0005) entry.keys.push({ time: kt, value: plain(p.keyValue(idx)) });
            else entry.keys.push({ time: kt, value: null, missing: true });
          }
        }
        try { entry.expression = p.canSetExpression ? p.expression : ""; } catch (eE) {}
      } catch (e) {
        entry.error = e.message;
      }
      out.push(entry);
    }
    return { comp_id: comp.id, time: comp.time, results: out };
  };

  A.batchSet = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var ops = args.ops || [];
    if (ops.length > MAX_LIST) fail("bad_args", "At most " + MAX_LIST + " ops in one undo group");
    resolveOps(comp, ops, args.base);
    return A.withUndo(args.label || "Batch set", function () {
      var done = 0;
      for (var i = 0; i < ops.length; i++) {
        try {
          A.setProperty({
            comp_id: comp.id,
            layer: ops[i].layer,
            path: ops[i].path,
            value: ops[i].value,
            keyframes: ops[i].keyframes,
            expression: ops[i].expression,
            expect: args.expect
          });
        } catch (e) {
          return { done: done, failed_at: i + 1, error: e.message };
        }
        done++;
      }
      return { done: done };
    });
  };
})($.global);
