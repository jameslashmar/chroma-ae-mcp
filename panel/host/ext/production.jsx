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
//   one undo group, checked before anything changes (Shape and Marker values,
//   expression_enabled; the read-back reports expression errors)
// - exploreRqTemplates (read) / exploreSaveTemplate (guarded write): save a
//   render queue item's render settings or output module as a named template
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo (exploreSaveTemplate has no undo group:
//   a saved template is a machine-wide preference, not a project change).
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
    try {
      if (typeof Shape !== "undefined" && v instanceof Shape && typeof A.serialiseShape === "function") return A.serialiseShape(v);
    } catch (eS) {}
    try {
      if (typeof MarkerValue !== "undefined" && v instanceof MarkerValue && typeof A.serialiseMarker === "function") return A.serialiseMarker(v);
    } catch (eM) {}
    return String(v);
  }

  // ---------- Essential Graphics ----------

  function overridesOf(layer) {
    var g = null;
    try { g = layer.property("ADBE Layer Overrides"); } catch (e) { g = null; }
    return g;
  }

  var MAX_OVERRIDE_DEPTH = 6;

  // Where an Essential Property's value comes from. essentialPropertySource (AE 22) can be a Property, an AVLayer or
  // null: it is described, never returned raw. undefined means this AE has no such member.
  function describeEssentialSource(p) {
    var src;
    try { src = p.essentialPropertySource; } catch (e0) { return undefined; }
    if (src === undefined) return undefined;
    if (src === null) return null;
    var out = {};
    // A Layer is a PropertyGroup too, so it has propertyType: test for a layer (depth 0 or a containing comp) first.
    var isLayer = false;
    try { isLayer = src.propertyDepth === 0; } catch (eL0) {}
    if (!isLayer) {
      try { isLayer = typeof src.containingComp !== "undefined"; } catch (eL1) {}
    }
    if (!isLayer) {
      try { isLayer = src instanceof AVLayer; } catch (eL2) {}
    }
    var isProp = false;
    if (!isLayer) {
      try { isProp = src.propertyType !== undefined; } catch (e1) {}
    }
    if (isProp) {
      out.kind = "property";
      try { out.name = String(src.name); } catch (e2) {}
      try { out.match_name = String(src.matchName); } catch (e3) {}
      try {
        var lay = src.propertyGroup(src.propertyDepth);
        if (lay) {
          out.layer_id = lay.id;
          out.layer_name = String(lay.name);
        }
      } catch (e4) {}
      try {
        if (typeof A.propertyPath === "function") out.path = A.propertyPath(src).path;
      } catch (e5) {}
    } else {
      out.kind = "layer";
      try { out.layer_id = src.id; } catch (e6) {}
      try { out.layer_name = String(src.name); } catch (e7) {}
    }
    return out;
  }

  function overrideEntries(g, depth, counter) {
    var list = [];
    for (var k = 1; k <= g.numProperties; k++) {
      if (counter.n >= MAX_LIST) {
        counter.truncated = true;
        break;
      }
      var p = g.property(k);
      if (!p) continue;
      counter.n++;
      var entry = { index: k, name: p.name };
      var isLeaf = false;
      try { isLeaf = p.propertyType === PropertyType.PROPERTY; } catch (eT) {}
      if (isLeaf) {
        // A property keeps the shape it has always had ({index, name, value}); only groups say what they are.
        try { entry.value = plain(p.value); } catch (e3) {}
        var src = describeEssentialSource(p);
        if (src !== undefined) entry.source = src;
        try {
          if (p.canSetAlternateSource === true) {
            entry.can_set_alternate_source = true;
          }
        } catch (eC) {}
        try {
          if (p.alternateSource) entry.alternate_source_id = p.alternateSource.id;
        } catch (eA) {}
      } else {
        entry.kind = "group";
        if (depth < MAX_OVERRIDE_DEPTH) {
          try { entry.children = overrideEntries(p, depth + 1, counter); } catch (eG) {}
        }
      }
      list.push(entry);
    }
    return list;
  }

  // An Essential Property by name: the layer's own list first (what set_override has always searched), then groups.
  function findOverride(g, name, depth) {
    var direct = null;
    try { direct = g.property(name); } catch (e0) { direct = null; }
    if (direct) return direct;
    if (depth >= MAX_OVERRIDE_DEPTH) return null;
    for (var k = 1; k <= g.numProperties; k++) {
      var child = null;
      try { child = g.property(k); } catch (e1) { child = null; }
      if (!child) continue;
      var isGroup = false;
      try { isGroup = child.propertyType !== PropertyType.PROPERTY; } catch (e2) {}
      if (!isGroup) continue;
      var hit = findOverride(child, name, depth + 1);
      if (hit) return hit;
    }
    return null;
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
      var counter = { n: 0, truncated: false };
      if (g) list = overrideEntries(g, 0, counter);
      out.layer = { index: layer.index, id: layer.id, name: layer.name, has_overrides: g !== null };
      out.overrides = list;
      if (counter.truncated) out.overrides_truncated = true;
    }
    return out;
  };

  A.egpEdit = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var action = args.action;
    var target = null;
    var layer = null;
    var itemForMedia = null;
    var mediaNote = null;
    if (action === "add") {
      layer = findLayer(comp, args.layer);
      var addWhat = "the layer";
      if (args.path && args.path.length > 0) {
        target = resolvePath(layer, args.path);
        addWhat = "\"" + args.path.join(" > ") + "\"";
      } else {
        // No path: the layer's own media slot (media replacement), when this AE offers it on layers.
        target = layer;
        if (typeof layer.canAddToMotionGraphicsTemplate !== "function") {
          fail("bad_args", "This After Effects cannot add a layer's media to the template (Layer.canAddToMotionGraphicsTemplate is missing); give the property's path.");
        }
      }
      var can = true;
      try { can = target.canAddToMotionGraphicsTemplate(comp); } catch (eCan) { can = false; }
      if (!can) fail("bad_args", "AE won't add " + addWhat + " to the Essential Graphics template");
    } else if (action === "set_media") {
      layer = findLayer(comp, args.layer);
      var gm = overridesOf(layer);
      if (!gm) fail("bad_args", "\"" + layer.name + "\" has no Essential Properties (it must be a precomp layer of a comp with a template)");
      target = findOverride(gm, args.name, 0);
      if (!target) fail("not_found", "No Essential Property \"" + args.name + "\" on \"" + layer.name + "\"");
      if (typeof target.setAlternateSource !== "function" || typeof target.canSetAlternateSource === "undefined") {
        fail("bad_args", "This After Effects has no Property.setAlternateSource (media replacement needs AE 18 or later).");
      }
      if (target.canSetAlternateSource !== true) {
        fail("bad_args", "\"" + args.name + "\" is not a media-replacement slot (canSetAlternateSource is false). Use set_override for values.");
      }
      try { itemForMedia = app.project.itemByID(args.item_id); } catch (eIt) { itemForMedia = null; }
      if (!itemForMedia) fail("not_found", "No project item with id " + args.item_id);
      if (!(itemForMedia instanceof FootageItem) && !(itemForMedia instanceof CompItem)) {
        fail("bad_args", "Item " + args.item_id + " is a folder; a media slot takes footage or a comp");
      }
      // AVItem.isMediaReplacementCompatible (AE 18) is a Boolean attribute of the candidate item itself.
      var compatible;
      try { compatible = itemForMedia.isMediaReplacementCompatible; } catch (eCmp) { compatible = undefined; }
      if (compatible === false) {
        fail("bad_args", "\"" + itemForMedia.name + "\" is not compatible with media replacement (isMediaReplacementCompatible is false).");
      }
      if (compatible === undefined) mediaNote = "Compatibility was not checked: this After Effects has no AVItem.isMediaReplacementCompatible.";
    } else if (action === "rename") {
      var count = 0;
      try { count = comp.motionGraphicsTemplateControllerCount; } catch (eCount) {}
      if (args.index < 1 || args.index > count) fail("not_found", "Controller " + args.index + " out of range (1.." + count + ")");
    } else if (action === "set_override") {
      layer = findLayer(comp, args.layer);
      var g = overridesOf(layer);
      if (!g) fail("bad_args", "\"" + layer.name + "\" has no Essential Properties (it must be a precomp layer of a comp with a template)");
      target = findOverride(g, args.name, 0);
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
      if (action === "set_media") {
        target.setAlternateSource(itemForMedia);
        var mediaOut = { action: action, layer: { index: layer.index, id: layer.id, name: layer.name }, name: args.name, item_id: itemForMedia.id };
        if (mediaNote) mediaOut.note = mediaNote;
        return mediaOut;
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

  // ---------- saving render templates ----------

  function rqTarget(args) {
    var rq = app.project.renderQueue;
    var n = rq.numItems;
    if (typeof args.item_index !== "number" || args.item_index < 1 || args.item_index > n) {
      fail("not_found", "Render queue item " + args.item_index + " is out of range (the queue has " + n + ")");
    }
    var item = rq.item(args.item_index);
    var cid = null;
    var cname = null;
    try { cid = item.comp.id; cname = String(item.comp.name); } catch (e0) {}
    if (cid !== args.item_comp_id) {
      fail("guard", "Render queue item " + args.item_index + " renders comp " + cid + ", not " + args.item_comp_id + ": the queue changed. Read it again.", {
        expected: { item_index: args.item_index, comp_id: args.item_comp_id },
        actual: { item_index: args.item_index, comp_id: cid }
      });
    }
    var status = null;
    try { status = String(item.status); } catch (e1) {}
    var rendering = false;
    try { rendering = typeof RQItemStatus !== "undefined" && item.status === RQItemStatus.RENDERING; } catch (e2) {}
    var target = item;
    var om = 0;
    if (args.kind === "output_module") {
      var count = 0;
      try { count = item.numOutputModules; } catch (e3) {}
      om = args.om_index;
      if (typeof om !== "number" || om < 1 || om > count) fail("not_found", "Output module " + om + " is out of range (the item has " + count + ")");
      target = item.outputModule(om);
    } else if (args.kind !== "render_settings") {
      fail("bad_args", "kind must be render_settings or output_module");
    }
    return { item: item, target: target, comp_id: cid, comp_name: cname, status: status, rendering: rendering, om_index: om };
  }

  function templateNames(target) {
    var names = [];
    var truncated = false;
    try {
      var t = target.templates;
      for (var i = 0; i < t.length; i++) {
        if (names.length >= MAX_LIST) {
          truncated = true;
          break;
        }
        names.push(String(t[i]));
      }
    } catch (e) {}
    return { names: names, truncated: truncated };
  }

  function lowerIndex(names, name) {
    var want = name.toLowerCase();
    for (var i = 0; i < names.length; i++) {
      if (names[i].toLowerCase() === want) return i;
    }
    return -1;
  }

  // Read-only: the template names a queue item's render settings or output module offers, and whether `name` is one.
  A.exploreRqTemplates = function (args) {
    var t = rqTarget(args);
    var list = templateNames(t.target);
    var out = {
      item: { index: args.item_index, comp_id: t.comp_id, comp_name: t.comp_name, status: t.status },
      kind: args.kind,
      templates: list.names,
      count: list.names.length,
      truncated: list.truncated
    };
    if (t.om_index > 0) out.om_index = t.om_index;
    if (typeof args.name === "string") {
      out.name = args.name;
      out.exists = lowerIndex(list.names, args.name) !== -1;
    }
    return out;
  };

  // RenderQueueItem.saveAsTemplate / OutputModule.saveAsTemplate: templates are machine-wide preferences, not part of
  // the project. Everything that can fail is checked before the save; there is no undo group (Ctrl+Z cannot undo it).
  A.exploreSaveTemplate = function (args) {
    assertGuard(args.expect);
    var name = args.name;
    if (typeof name !== "string" || name.replace(/^\s+|\s+$/g, "").length === 0) fail("bad_args", "The template name can't be empty.");
    if (name.length > 255) fail("bad_args", "The template name is limited to 255 characters.");
    if (/[\u0000-\u001f]/.test(name)) fail("bad_args", "The template name can't contain control characters.");
    var t = rqTarget(args);
    if (t.rendering) fail("bad_args", "Render queue item " + args.item_index + " is rendering; wait for it to finish.");
    if (typeof t.target.saveAsTemplate !== "function") {
      fail("bad_args", "This After Effects has no saveAsTemplate on " + (args.kind === "output_module" ? "output modules" : "render queue items") + ".");
    }
    // The collision check scans every template; only the returned list is capped.
    var all = [];
    try {
      var tl = t.target.templates;
      for (var ti = 0; ti < tl.length; ti++) all.push(String(tl[ti]));
    } catch (eTl) {}
    var hit = lowerIndex(all, name);
    if (hit !== -1 && args.allow_replace !== true) {
      fail("bad_args", "A " + (args.kind === "output_module" ? "output module" : "render settings") + " template named \"" + all[hit] + "\" already exists. Pick another name, or pass allow_replace to overwrite it (templates cannot be deleted or restored by script).");
    }
    // A machine-wide preference, not a project change: no undo group (it would be empty and Ctrl+Z cannot reach the template).
    t.target.saveAsTemplate(name);
    return { saved: name, kind: args.kind, replaced: hit !== -1, item_index: args.item_index, comp_id: t.comp_id };
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
  function isNumberList(v) {
    if (!(v instanceof Array)) return false;
    for (var i = 0; i < v.length; i++) {
      if (typeof v[i] !== "number" || isNaN(v[i])) return false;
    }
    return true;
  }

  // Refuses, before anything is written, what AE would throw on half way through a chunk: a value of the wrong kind,
  // an array of the wrong length, a number outside the property's own min and max, a separated Position, a path or
  // marker value the core builders refuse.
  function checkOpValue(op, prop, n, allowSub) {
    var hasValue = op.value !== undefined && op.value !== null;
    var hasKeys = op.keyframes && op.keyframes.length > 0;
    var hasEnabled = op.expression_enabled === true || op.expression_enabled === false;
    var name = String(prop.name);
    // The batch-level flag (resolveOps) or the op's own flag lets a font that is not installed through.
    if (op.allow_substitute === true) allowSub = true;
    if (hasEnabled && !prop.canSetExpression) fail("bad_args", "Op " + n + ": " + name + " can't take an expression");
    if (op.expression_enabled === true && (op.expression === undefined || op.expression === null) && String(prop.expression) === "") {
      fail("bad_args", "Op " + n + ": " + name + " has no expression to switch on; give `expression` too");
    }
    if (!hasValue && !hasKeys) return;
    var vt = null;
    try { vt = prop.propertyValueType; } catch (e0) {}
    var separated = false;
    try { separated = prop.dimensionsSeparated === true; } catch (e1) {}
    if (separated) fail("bad_args", "Op " + n + ": " + name + " has separated dimensions; write its X / Y / Z followers instead");
    if (vt === PropertyValueType.CUSTOM_VALUE || vt === PropertyValueType.NO_VALUE) {
      fail("bad_args", "Op " + n + ": " + name + " has no value a script can set; use an expression or a preset");
    }
    var values = [];
    var i;
    if (hasValue) values.push({ v: op.value, what: "value" });
    if (hasKeys) {
      for (i = 0; i < op.keyframes.length; i++) values.push({ v: op.keyframes[i].value, what: "keyframes[" + i + "].value" });
    }
    if (vt === PropertyValueType.MARKER && hasValue && !hasKeys) {
      fail("bad_args", "Op " + n + ": markers are keys; pass keyframes: [{ time, value: { comment, duration, ... } }]");
    }
    var dims = null;
    if (vt === PropertyValueType.OneD) dims = [1, 1];
    else if (vt === PropertyValueType.TwoD || vt === PropertyValueType.TwoD_SPATIAL) dims = [2, 2];
    else if (vt === PropertyValueType.ThreeD || vt === PropertyValueType.ThreeD_SPATIAL) dims = [2, 3];
    else if (vt === PropertyValueType.COLOR) dims = [3, 4];
    var shapeCounts = [];
    for (i = 0; i < values.length; i++) {
      var v = values[i].v;
      if (vt === PropertyValueType.TEXT_DOCUMENT) {
        // A font that is not installed would be substituted silently: setProperty refuses it, so refuse it here too.
        if (allowSub !== true && v && typeof v === "object" && v.font !== undefined && v.font !== null && typeof A.fontsResolve === "function") {
          var fr = A.fontsResolve({ postscript: String(v.font) });
          if (!fr.ok && !fr.unchecked) {
            fail("bad_args", "Op " + n + ": " + values[i].what + ": font \"" + v.font + "\" is not available. " + (fr.reason ? fr.reason + " " : "") + "Pick an installed font, or pass allow_substitute: true to write the name as it is (After Effects then substitutes).");
          }
        }
      }
      if (vt === PropertyValueType.SHAPE) {
        // The core builder throws a clear message for a bad vertex list; the Shape is thrown away here.
        var built = null;
        try {
          built = A.toShapeValue(v);
        } catch (eShape) {
          fail("bad_args", "Op " + n + ": " + values[i].what + ": " + String(eShape.message ? eShape.message : eShape));
        }
        var cnt = -1;
        try { cnt = built.vertices.length; } catch (eCnt) {}
        shapeCounts.push(cnt);
      } else if (vt === PropertyValueType.MARKER) {
        try {
          A.toMarkerValue(v);
        } catch (eMark) {
          fail("bad_args", "Op " + n + ": " + values[i].what + ": " + String(eMark.message ? eMark.message : eMark));
        }
      } else if (dims !== null) {
        var list;
        if (dims[1] === 1) {
          if (typeof v !== "number" || isNaN(v)) fail("bad_args", "Op " + n + ": " + values[i].what + " for " + name + " must be one number");
          list = [v];
        } else {
          if (!isNumberList(v) || v.length < dims[0] || v.length > dims[1]) {
            fail("bad_args", "Op " + n + ": " + values[i].what + " for " + name + " must be an array of " + (dims[0] === dims[1] ? String(dims[0]) : dims[0] + " or " + dims[1]) + " numbers");
          }
          list = v;
        }
        var hasMin = false;
        var hasMax = false;
        try { hasMin = prop.hasMin === true; } catch (e2) {}
        try { hasMax = prop.hasMax === true; } catch (e3) {}
        for (var j = 0; j < list.length; j++) {
          if (hasMin && list[j] < prop.minValue) fail("bad_args", "Op " + n + ": " + name + " accepts " + prop.minValue + " at the lowest, got " + list[j]);
          if (hasMax && list[j] > prop.maxValue) fail("bad_args", "Op " + n + ": " + name + " accepts " + prop.maxValue + " at the highest, got " + list[j]);
        }
      }
    }
    if (vt === PropertyValueType.SHAPE && shapeCounts.length > 0) {
      for (i = 1; i < shapeCounts.length; i++) {
        if (shapeCounts[i] !== shapeCounts[0]) {
          fail("bad_args", "Op " + n + ": path keyframes must all have the same number of vertices (" + shapeCounts[0] + " and " + shapeCounts[i] + " given). Use ae_path_write to change the vertex count.");
        }
      }
      var existing = -1;
      try {
        if (prop.numKeys > 0) existing = prop.keyValue(1).vertices.length;
      } catch (eEx) {}
      if (existing > 0 && shapeCounts[0] !== existing) {
        fail("bad_args", "Op " + n + ": this path is keyframed with " + existing + " vertices; the new shape has " + shapeCounts[0] + ". All path keys need the same vertex count: use ae_path_write.");
      }
    }
  }

  function resolveOps(comp, ops, base, allowSub) {
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
      checkOpValue(op, prop, n, allowSub);
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
      resolveOps(comp, ops, args.base, args.allow_substitute === true);
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
        // A marker property has no value at a time: its keys are read below.
        try {
          if (p.numKeys > 0) entry.value = plain(p.valueAtTime(comp.time, true));
          else entry.value = plain(p.value);
        } catch (eVal) {
          if (ops[i].times === undefined) throw eVal;
        }
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
        if (ops[i].check_expression === true) {
          // Only the properties this batch wrote an expression on: one evaluation (valueAtTime(t, false) changes
          // nothing), then the error AE keeps. A broken expression reads back as applied otherwise.
          try { entry.expression_enabled = p.canSetExpression ? p.expressionEnabled === true : false; } catch (eEn) {}
          var caught = "";
          try {
            if (p.canSetExpression && String(p.expression) !== "") p.valueAtTime(comp.time, false);
          } catch (eEv) {
            try { caught = String(eEv.message ? eEv.message : eEv); } catch (eMsg) { caught = "The expression threw an error"; }
          }
          var perr = "";
          try { if (p.canSetExpression && p.expressionError) perr = String(p.expressionError); } catch (eEr) {}
          if (perr !== "") entry.expression_error = perr.length > 2000 ? perr.substring(0, 2000) : perr;
          else if (caught !== "") entry.expression_error = caught;
        }
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
    resolveOps(comp, ops, args.base, args.allow_substitute === true);
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
            expression_enabled: ops[i].expression_enabled,
            allow_substitute: args.allow_substitute === true || ops[i].allow_substitute === true,
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
