// core.jsx: the __chromaAe host library, loaded once per AE session by panel/client/main.js.
//
// Rules (see SPEC.md and reference/engine-room/docs/fragile-areas-ae.md):
// - ES3 only. No chained ternaries: ExtendScript parses them left-associatively.
// - $.evalFile evaluates into the CALLER's scope, so everything hangs off $.global.
// - An undo group must begin and end inside the same evalScript.
// - Mutating functions check the target guard before touching anything.
// - Read-back happens in a separate evalScript (the server does that), never here.

(function (G) {
  if (G.__chromaAe && G.__chromaAe.__version) {
    return;
  }

  var A = {};
  A.__version = "0.1.0";

  var MAX_LIST = 500;
  var MAX_STRING = 20000;
  var IS_WIN = String($.os).indexOf("Windows") !== -1;

  // ---------- errors ----------

  function fail(kind, message, extra) {
    var e = new Error(message);
    e.__kind = kind;
    if (extra) {
      if (extra.actual !== undefined) e.__actual = extra.actual;
      if (extra.expected !== undefined) e.__expected = extra.expected;
      if (extra.line !== undefined) e.__line = extra.line;
      if (extra.sourceText !== undefined) e.__sourceText = extra.sourceText;
    }
    throw e;
  }

  A.formatError = function (e) {
    var out = { message: "ExtendScript error", kind: "runtime" };
    try {
      if (e && e.message) {
        out.message = String(e.message);
      } else {
        out.message = String(e);
      }
    } catch (e1) {}
    try { if (e && e.__kind) out.kind = e.__kind; } catch (e2) {}
    try {
      if (e && e.__line !== undefined) {
        out.line = e.__line;
      } else if (e && typeof e.line === "number") {
        out.line = e.line;
      }
    } catch (e3) {}
    try { if (e && e.__actual !== undefined) out.actual = e.__actual; } catch (e4) {}
    try { if (e && e.__expected !== undefined) out.expected = e.__expected; } catch (e5) {}
    try { if (e && e.__sourceText !== undefined) out.sourceText = e.__sourceText; } catch (e6) {}
    return out;
  };

  // ---------- JSON ----------

  function quote(s) {
    var out = "\"";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === "\"") {
        out += "\\\"";
      } else if (c === "\\") {
        out += "\\\\";
      } else if (c === "\n") {
        out += "\\n";
      } else if (c === "\r") {
        out += "\\r";
      } else if (c === "\t") {
        out += "\\t";
      } else if (code < 0x20 || code === 0x2028 || code === 0x2029 || code > 0x7e) {
        var h = code.toString(16);
        while (h.length < 4) h = "0" + h;
        out += "\\u" + h;
      } else {
        out += c;
      }
    }
    return out + "\"";
  }

  function isArray(v) {
    return v instanceof Array;
  }

  function str(v, stack) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "boolean") return v ? "true" : "false";
    if (t === "number") {
      if (isNaN(v) || !isFinite(v)) return "null";
      return String(v);
    }
    if (t === "string") {
      if (v.length > MAX_STRING) v = v.substring(0, MAX_STRING) + " ...[truncated]";
      return quote(v);
    }
    if (t === "function") return "null";
    if (v instanceof Date) return quote(String(v));
    for (var s = 0; s < stack.length; s++) {
      if (stack[s] === v) return quote("[circular]");
    }
    stack.push(v);
    var parts = [];
    var k;
    try {
      if (isArray(v)) {
        for (k = 0; k < v.length; k++) parts.push(str(v[k], stack));
        return "[" + parts.join(",") + "]";
      }
      for (k in v) {
        if (!v.hasOwnProperty(k)) continue;
        var val;
        try { val = v[k]; } catch (eg) { val = "[threw]"; }
        if (val === undefined || typeof val === "function") continue;
        parts.push(quote(String(k)) + ":" + str(val, stack));
      }
      return "{" + parts.join(",") + "}";
    } finally {
      stack.pop();
    }
  }

  A.stringify = function (v) {
    return str(v, []);
  };

  // ---------- undo ----------

  var undoDepth = 0;

  // Begin and end in the same call. Nested calls join the outer group.
  A.withUndo = function (label, fn) {
    if (undoDepth > 0) {
      undoDepth++;
      try { return fn(); } finally { undoDepth--; }
    }
    app.beginUndoGroup(label || "Chroma AE MCP");
    undoDepth = 1;
    try {
      return fn();
    } finally {
      undoDepth = 0;
      app.endUndoGroup();
    }
  };

  // ---------- guard ----------

  function projectPath() {
    var f = app.project.file;
    if (!f) return "<unsaved>";
    return f.fsName;
  }

  function normPath(p) {
    var s = String(p);
    if (s === "<unsaved>") return s;
    s = s.split("\\").join("/");
    if (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.substring(0, s.length - 1);
    if (IS_WIN) s = s.toLowerCase();
    return s;
  }

  function compById(id) {
    var item = null;
    try { item = app.project.itemByID(id); } catch (e) { item = null; }
    if (item && item instanceof CompItem) return item;
    return null;
  }

  // Reports what is open; never throws. The server compares too.
  A.checkGuard = function (args) {
    var expect = (args && args.expect) ? args.expect : {};
    var actual = projectPath();
    var out = {
      ok: true,
      project_path: actual,
      comp_id: null,
      comp_is_valid: true,
      dirty: null
    };
    // Auto checkpoints copy the saved .aep, so the server reports whether
    // unsaved changes are left out of it.
    try { out.dirty = app.project.dirty === true; } catch (eDirty) { out.dirty = null; }
    if (expect.project_path !== undefined && normPath(expect.project_path) !== normPath(actual)) {
      out.ok = false;
    }
    if (expect.comp_id !== undefined && expect.comp_id !== null) {
      out.comp_id = expect.comp_id;
      if (!compById(expect.comp_id)) {
        out.comp_is_valid = false;
        out.ok = false;
      }
    }
    return out;
  };

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
    var c = compById(id);
    if (!c) fail("not_found", "No CompItem with id " + id);
    return c;
  }

  // ---------- values ----------

  // opts is optional and only ever adds: {shape_values, text_full} give Shape, MarkerValue and the full
  // TextDocument as data. Without it the output is what it has always been.
  function serialiseValue(v, opts) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === "number" || t === "string" || t === "boolean") return v;
    if (isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(serialiseValue(v[i], opts));
      return a;
    }
    if (v instanceof TextDocument) {
      return A.textDocSerialise(v, { full: !!(opts && opts.text_full) });
    }
    if (opts && opts.shape_values) {
      if (typeof Shape !== "undefined" && v instanceof Shape) return A.serialiseShape(v);
      if (typeof MarkerValue !== "undefined" && v instanceof MarkerValue) return A.serialiseMarker(v);
    }
    try { return "[" + v.reflect.name + "]"; } catch (e5) {}
    return String(v);
  }

  var MAX_SHAPE_KEYS = 50;

  // opts (optional, from getLayerProps): meta, shape_values, text_full, expression_error, time.
  function describeProp(p, depth, opts) {
    var d = { name: p.name, matchName: p.matchName, propertyIndex: p.propertyIndex };
    if (p.propertyType === PropertyType.PROPERTY) {
      d.kind = "property";
      try { d.value = serialiseValue(p.value, opts); } catch (e1) { d.value = null; d.valueError = String(e1.message); }
      d.numKeys = p.numKeys;
      try {
        d.expression = p.canSetExpression ? p.expression : "";
        d.expressionEnabled = p.canSetExpression ? p.expressionEnabled : false;
      } catch (e2) {}
      if (opts && opts.expression_error) {
        // Evaluate once (only while the expression is on), so expressionError is current. A bad expression
        // switches itself off in AE but keeps its error text, so the error is read either way.
        if (d.expressionEnabled === true) {
          try { p.valueAtTime(opts.time, false); } catch (eEval) {}
        }
        try { d.expressionError = String(p.expressionError); } catch (eErr) {}
      }
      if (opts && opts.meta) {
        d.meta = A.propMeta(p);
      }
      if (p.numKeys > 0) {
        var keys = [];
        var n = p.numKeys;
        if (n > MAX_LIST) n = MAX_LIST;
        for (var k = 1; k <= n; k++) {
          var kv = null;
          var keyOpts = opts;
          // Path keys can be hundreds of vertices each: only the first few are given as data.
          if (opts && opts.value_only) keyOpts = {};
          else if (opts && opts.shape_values && k > MAX_SHAPE_KEYS) keyOpts = { text_full: opts.text_full };
          try { kv = serialiseValue(p.keyValue(k), keyOpts); } catch (e3) {}
          keys.push({ time: p.keyTime(k), value: kv });
        }
        d.keyframes = keys;
        if (p.numKeys > MAX_LIST) d.truncated = true;
      }
      return d;
    }
    d.kind = "group";
    d.numProperties = p.numProperties;
    if (depth > 0) {
      var kids = [];
      var m = p.numProperties;
      if (m > MAX_LIST) m = MAX_LIST;
      for (var i = 1; i <= m; i++) {
        try { kids.push(describeProp(p.property(i), depth - 1, opts)); } catch (e4) {}
      }
      d.properties = kids;
      if (p.numProperties > MAX_LIST) d.truncated = true;
    }
    return d;
  }

  function findLayer(comp, sel) {
    var i;
    if (!sel) fail("bad_args", "layer selector missing");
    if (sel.id !== undefined && sel.id !== null) {
      for (i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        if (l.id === sel.id) return l;
      }
      fail("not_found", "No layer with id " + sel.id + " in comp " + comp.id);
    }
    if (sel.index !== undefined && sel.index !== null) {
      if (sel.index < 1 || sel.index > comp.numLayers) fail("not_found", "Layer index " + sel.index + " out of range");
      return comp.layer(sel.index);
    }
    if (sel.name !== undefined && sel.name !== null) {
      var byName = comp.layer(sel.name);
      if (!byName) fail("not_found", "No layer named \"" + sel.name + "\"");
      return byName;
    }
    fail("bad_args", "layer selector needs id, index or name");
    return null;
  }

  function resolvePath(layer, path) {
    var p = layer;
    for (var i = 0; i < path.length; i++) {
      var next = null;
      try { next = p.property(path[i]); } catch (e) { next = null; }
      if (!next) fail("not_found", "Property path not found at \"" + path[i] + "\" (" + path.join(" > ") + ")");
      p = next;
    }
    return p;
  }

  function layerSummary(l) {
    var s = {
      index: l.index,
      id: l.id,
      name: l.name,
      type: l.reflect ? String(l.reflect.name) : "Layer",
      inPoint: l.inPoint,
      outPoint: l.outPoint,
      startTime: l.startTime,
      enabled: l.enabled,
      locked: l.locked,
      label: l.label,
      parent: null
    };
    try { if (l.parent) s.parent = l.parent.index; } catch (e1) {}
    try { s.solo = l.solo; } catch (e2) {}
    try { s.threeDLayer = l.threeDLayer; } catch (e3) {}
    try { s.blendingMode = String(l.blendingMode); } catch (e4) {}
    try { s.trackMatteType = String(l.trackMatteType); } catch (e5) {}
    try { if (l.source) s.sourceId = l.source.id; } catch (e6) {}
    // AE 23+: the matte is a layer reference, not always the layer above.
    try { if (l.trackMatteLayer) s.trackMatteLayer = l.trackMatteLayer.index; } catch (e7) {}
    return s;
  }

  // ---------- reads ----------

  A.status = function () {
    var out = {
      aeVersion: app.version,
      project_path: projectPath(),
      dirty: false,
      active_comp: null,
      selected_layers: []
    };
    try { out.dirty = app.project.dirty; } catch (e1) {}
    var ai = app.project.activeItem;
    if (ai && ai instanceof CompItem) {
      out.active_comp = { id: ai.id, name: ai.name };
      var sel = ai.selectedLayers;
      for (var i = 0; i < sel.length && i < MAX_LIST; i++) {
        out.selected_layers.push({ index: sel[i].index, id: sel[i].id, name: sel[i].name });
      }
    }
    return out;
  };

  function itemSummary(it) {
    var s = { id: it.id, name: it.name, typeName: it.typeName, parentFolderId: null };
    try { if (it.parentFolder) s.parentFolderId = it.parentFolder.id; } catch (e1) {}
    if (it instanceof CompItem) {
      s.width = it.width;
      s.height = it.height;
      s.fps = it.frameRate;
      s.duration = it.duration;
      s.numLayers = it.numLayers;
    } else if (it instanceof FootageItem) {
      try { if (it.file) s.file = it.file.fsName; } catch (e2) {}
      s.width = it.width;
      s.height = it.height;
      s.duration = it.duration;
      // footageMissing is also true for placeholders; keep them apart from lost files.
      try {
        if (it.footageMissing) {
          if (itemKind(it) === "placeholder") s.placeholder = true;
          else s.missing = true;
        }
      } catch (e3) {}
    }
    return s;
  }

  // typeName is in AE's language, so filter by class.
  function itemKind(it) {
    if (it instanceof CompItem) return "comp";
    if (it instanceof FolderItem) return "folder";
    if (it instanceof FootageItem) {
      try { if (it.mainSource instanceof SolidSource) return "solid"; } catch (e1) {}
      try { if (it.mainSource instanceof PlaceholderSource) return "placeholder"; } catch (e2) {}
      return "footage";
    }
    return "other";
  }

  // Paging: an offset and a limit (at most MAX_LIST) over the matching
  // entries, with the total so the caller knows where the end is.
  function page(list, args) {
    var offset = 0;
    var limit = MAX_LIST;
    if (args && args.offset) offset = args.offset;
    if (args && args.limit && args.limit < MAX_LIST) limit = args.limit;
    var out = list.slice(offset, offset + limit);
    var next = null;
    if (offset + out.length < list.length) next = offset + out.length;
    return { items: out, offset: offset, next_offset: next };
  }

  var MAX_VISIT = 20000;

  A.getProject = function (args) {
    // Any filter, sort or paging asks for the flat, paged list; offset 0 counts.
    var filtered = args && (args.type || args.name_contains || args.missing_only || args.sort || (args.offset !== undefined && args.offset !== null) || args.limit);
    var depth = 3;
    if (args && args.depth) depth = args.depth;
    else if (filtered) depth = 20;
    var root = app.project.rootFolder;
    if (args && args.folder_id !== undefined && args.folder_id !== null) {
      var f = app.project.itemByID(args.folder_id);
      if (!f || !(f instanceof FolderItem)) fail("not_found", "No FolderItem with id " + args.folder_id);
      root = f;
    }
    if (!filtered) {
      // The original shape: the tree walk, cut at MAX_LIST.
      var items = [];
      var truncated = false;
      var walk = function (folder, d) {
        for (var i = 1; i <= folder.numItems; i++) {
          if (items.length >= MAX_LIST) {
            truncated = true;
            return;
          }
          var it = folder.item(i);
          items.push(itemSummary(it));
          if (it instanceof FolderItem && d > 1) walk(it, d - 1);
        }
      };
      walk(root, depth);
      var legacy = {
        project_path: projectPath(),
        numItems: app.project.numItems,
        root_id: root.id,
        items: items,
        truncated: truncated
      };
      // The paged list is a different order, so offset 500 would not continue this page.
      if (truncated) legacy.next = "Cut at " + MAX_LIST + ". Call again with offset:0 (and limit) for the full paged list; do not continue this page at offset " + MAX_LIST + ".";
      return legacy;
    }
    var needle = null;
    if (args.name_contains) needle = String(args.name_contains).toLowerCase();
    var matched = [];
    var visited = 0;
    var stopped = false;
    var walkAll = function (folder, d) {
      for (var j = 1; j <= folder.numItems; j++) {
        if (visited >= MAX_VISIT) {
          stopped = true;
          return;
        }
        visited++;
        var item = folder.item(j);
        var ok = true;
        if (args.type && itemKind(item) !== args.type) ok = false;
        if (ok && needle !== null && String(item.name).toLowerCase().indexOf(needle) < 0) ok = false;
        if (ok && args.missing_only === true) {
          var missing = false;
          try { missing = itemKind(item) === "footage" && item.footageMissing === true; } catch (eM) {}
          if (!missing) ok = false;
        }
        if (ok) matched.push(item);
        if (item instanceof FolderItem && d > 1) walkAll(item, d - 1);
      }
    };
    walkAll(root, depth);
    if (args.sort === "name") {
      matched.sort(function (a, b) {
        var x = String(a.name).toLowerCase();
        var y = String(b.name).toLowerCase();
        if (x < y) return -1;
        if (x > y) return 1;
        return a.id - b.id;
      });
    } else if (args.sort === "id") {
      matched.sort(function (a, b) { return a.id - b.id; });
    }
    var pg = page(matched, args);
    var summaries = [];
    for (var k = 0; k < pg.items.length; k++) {
      var sum = itemSummary(pg.items[k]);
      sum.kind = itemKind(pg.items[k]);
      summaries.push(sum);
    }
    return {
      project_path: projectPath(),
      numItems: app.project.numItems,
      root_id: root.id,
      total: matched.length,
      offset: pg.offset,
      next_offset: pg.next_offset,
      items: summaries,
      truncated: pg.next_offset !== null || stopped,
      visit_limit_hit: stopped
    };
  };

  // The comp-level switches ae_comp_settings writes (motion blur, renderer,
  // frame blending, resolution factor, ...), so a read of the comp shows them.
  // Each one is read on its own: an attribute an AE build lacks is left out.
  var COMP_SWITCHES = [
    "motionBlur", "shutterAngle", "shutterPhase", "motionBlurSamplesPerFrame", "motionBlurAdaptiveSampleLimit",
    "frameBlending", "renderer", "draft3d", "resolutionFactor", "hideShyLayers",
    "preserveNestedFrameRate", "preserveNestedResolution", "displayStartTime", "displayStartFrame", "dropFrame"
  ];

  function addCompSwitches(c, out) {
    for (var i = 0; i < COMP_SWITCHES.length; i++) {
      try {
        var v = c[COMP_SWITCHES[i]];
        if (v !== undefined && v !== null) out[COMP_SWITCHES[i]] = serialiseValue(v);
      } catch (e) {}
    }
  }

  A.getComp = function (args) {
    var c = requireComp(args.comp_id);
    var all = [];
    var needle = null;
    if (args.name_contains) needle = String(args.name_contains).toLowerCase();
    for (var i = 1; i <= c.numLayers; i++) {
      var l = c.layer(i);
      if (needle !== null && String(l.name).toLowerCase().indexOf(needle) < 0) continue;
      all.push(l);
    }
    var pg = page(all, args);
    var layers = [];
    for (var j = 0; j < pg.items.length; j++) layers.push(layerSummary(pg.items[j]));
    var out = {
      id: c.id,
      name: c.name,
      width: c.width,
      height: c.height,
      pixelAspect: c.pixelAspect,
      fps: c.frameRate,
      duration: c.duration,
      time: c.time,
      workAreaStart: c.workAreaStart,
      workAreaDuration: c.workAreaDuration,
      bgColor: c.bgColor,
      numLayers: c.numLayers,
      layers: layers,
      truncated: pg.next_offset !== null
    };
    addCompSwitches(c, out);
    if (needle !== null || args.offset || args.limit) {
      out.matched = all.length;
      out.offset = pg.offset;
      out.next_offset = pg.next_offset;
    }
    return out;
  };

  A.getLayerProps = function (args) {
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var depth = (args.depth !== undefined && args.depth !== null) ? args.depth : 2;
    var out = { comp_id: c.id, layer: layerSummary(l) };
    // Opt-in extras. Without any of them the output is exactly what it has always been.
    var opts = null;
    if (args.meta || args.shape_values || args.text_full || args.expression_error) {
      opts = {
        meta: !!args.meta,
        shape_values: !!(args.meta || args.shape_values),
        text_full: !!(args.meta || args.text_full),
        expression_error: !!args.expression_error,
        value_only: !!args.value_only,
        time: c.time
      };
    }
    if (args.path && args.path.length) {
      out.property = describeProp(resolvePath(l, args.path), depth, opts);
    } else {
      var props = [];
      for (var i = 1; i <= l.numProperties; i++) {
        try { props.push(describeProp(l.property(i), depth - 1, opts)); } catch (e) {}
      }
      out.properties = props;
    }
    return out;
  };

  // A compact picture for before/after receipts.
  A.snapshotForReceipt = function (args) {
    if (args && args.comp_id !== undefined && args.comp_id !== null) {
      var c = requireComp(args.comp_id);
      var layers = [];
      var n = c.numLayers;
      if (n > MAX_LIST) n = MAX_LIST;
      for (var i = 1; i <= n; i++) {
        var l = c.layer(i);
        var s = layerSummary(l);
        try {
          var tr = l.property("ADBE Transform Group");
          s.position = serialiseValue(tr.property("ADBE Position").value);
          s.scale = serialiseValue(tr.property("ADBE Scale").value);
          s.opacity = tr.property("ADBE Opacity").value;
        } catch (e1) {}
        layers.push(s);
      }
      return {
        comp_id: c.id,
        name: c.name,
        duration: c.duration,
        workAreaStart: c.workAreaStart,
        workAreaDuration: c.workAreaDuration,
        numLayers: c.numLayers,
        layers: layers
      };
    }
    var names = [];
    var m = app.project.numItems;
    if (m > MAX_LIST) m = MAX_LIST;
    for (var j = 1; j <= m; j++) {
      var it = app.project.item(j);
      names.push({ id: it.id, name: it.name, typeName: it.typeName });
    }
    return { project_path: projectPath(), numItems: app.project.numItems, items: names };
  };

  A.rqStatus = function () {
    var rq = app.project.renderQueue;
    var items = [];
    for (var i = 1; i <= rq.numItems && items.length < MAX_LIST; i++) {
      var it = rq.item(i);
      var outs = [];
      for (var o = 1; o <= it.numOutputModules; o++) {
        try {
          var om = it.outputModule(o);
          outs.push(om.file ? om.file.fsName : null);
        } catch (e1) {}
      }
      items.push({
        index: i,
        comp_id: it.comp.id,
        comp_name: it.comp.name,
        status: String(it.status),
        render: it.render,
        outputs: outs
      });
    }
    return { numItems: rq.numItems, rendering: rq.rendering, items: items };
  };

  // ---------- shared kits for the wave 5 groups ----------
  //
  // Other host files (ext/*.jsx) build on these, so the names and return shapes
  // are a contract: add fields, never rename or drop one.
  //
  //   A.resolvePropertyPath(layer, path)   the path resolver ae_set_property uses (names, match names, or an index number).
  //   A.propertyPath(prop)                 {path, names, indexed}: the path of a Property or PropertyGroup from its layer,
  //                                        in the format A.resolvePropertyPath accepts. Match names, except under an
  //                                        indexed group (effects, masks, shape contents), which use the child's name,
  //                                        or its index number when two siblings share the name.
  //   A.fontsResolve({postscript} | {family, style})
  //                                        -> {ok, unchecked?, font?, duplicates, candidates, reason?}
  //   A.fontsGlyphCheck(font | postscript, text, maxChars)
  //                                        -> {supported: true|false|null, missing, checked, truncated, scripts, suggested_default}
  //   A.textDocSerialise(doc, {full})      -> the TextDocument as plain data; {full:false} is the five fields core has
  //                                        always returned, {full:true} adds every attribute AE gives, with `mixed`.
  //   A.propMeta(prop)                     -> what the property accepts (value type, units, min, max, ...).
  //   A.toShapeValue(spec) / A.serialiseShape(shape) / A.serialiseMarker(marker) / A.toMarkerValue(spec)
  //
  // Every member newer than AE 22 is read inside try/catch and feature-detected (typeof or `in`), never by a
  // version compare, so an older AE answers with less instead of failing.

  var MAX_FONT_SCAN = 6000;
  var FONT_SCAN_MS = 1500;
  var MAX_VERTICES = 500;

  function round4(n) {
    if (typeof n !== "number" || isNaN(n) || !isFinite(n)) return null;
    return Math.round(n * 10000) / 10000;
  }

  function shortError(e) {
    var m = "";
    try { m = String(e && e.message ? e.message : e); } catch (e1) { m = "error"; }
    if (m.length > 120) m = m.substring(0, 120);
    return m;
  }

  A.resolvePropertyPath = function (layer, path) {
    return resolvePath(layer, path);
  };

  // The entries of a path from the layer down to `prop`, in the format resolvePath takes.
  A.propertyPath = function (prop) {
    var chain = [];
    var node = prop;
    var guardCount = 0;
    while (node && guardCount < 60) {
      // The layer itself has propertyDepth 0 and is the parentProperty of a top-level group: stop before it.
      var depth = -1;
      try { depth = node.propertyDepth; } catch (e00) { depth = -1; }
      if (depth === 0) break;
      chain.unshift(node);
      var up = null;
      try { up = node.parentProperty; } catch (e0) { up = null; }
      node = up;
      guardCount++;
    }
    var path = [];
    var names = [];
    var indexed = false;
    for (var i = 0; i < chain.length; i++) {
      var cur = chain[i];
      var parent = null;
      if (i > 0) parent = chain[i - 1];
      var name = "";
      var matchName = "";
      try { name = String(cur.name); } catch (e1) {}
      try { matchName = String(cur.matchName); } catch (e2) {}
      names.push(name);
      var underIndexed = false;
      try { underIndexed = parent !== null && parent.propertyType === PropertyType.INDEXED_GROUP; } catch (e3) {}
      if (underIndexed) {
        var same = 0;
        try {
          for (var s = 1; s <= parent.numProperties; s++) {
            if (String(parent.property(s).name) === name) same++;
          }
        } catch (e4) { same = 2; }
        if (name !== "" && same === 1) {
          path.push(name);
        } else {
          var idx = 0;
          try { idx = cur.propertyIndex; } catch (e5) {}
          path.push(idx);
          indexed = true;
        }
      } else {
        path.push(matchName);
      }
    }
    return { path: path, names: names, indexed: indexed };
  };

  // ----- property metadata -----

  var VALUE_TYPE_NAMES = ["NO_VALUE", "ThreeD_SPATIAL", "ThreeD", "TwoD_SPATIAL", "TwoD", "OneD", "COLOR", "CUSTOM_VALUE", "MARKER", "LAYER_INDEX", "MASK_INDEX", "SHAPE", "TEXT_DOCUMENT"];

  function valueTypeName(t) {
    for (var i = 0; i < VALUE_TYPE_NAMES.length; i++) {
      try { if (PropertyValueType[VALUE_TYPE_NAMES[i]] === t) return VALUE_TYPE_NAMES[i]; } catch (e) {}
    }
    return String(t);
  }

  A.propMeta = function (p) {
    var m = {};
    try { m.value_type = valueTypeName(p.propertyValueType); } catch (e1) {}
    try { if (p.unitsText !== undefined && p.unitsText !== "") m.units = String(p.unitsText); } catch (e2) {}
    try { if (p.hasMin === true) m.min = p.minValue; } catch (e3) {}
    try { if (p.hasMax === true) m.max = p.maxValue; } catch (e4) {}
    try { if (p.isSpatial !== undefined) m.spatial = p.isSpatial === true; } catch (e5) {}
    try { if (p.canVaryOverTime !== undefined) m.can_vary = p.canVaryOverTime === true; } catch (e6) {}
    try { if (p.canSetExpression !== undefined) m.can_expression = p.canSetExpression === true; } catch (e7) {}
    try { if (p.isModified !== undefined) m.is_modified = p.isModified === true; } catch (e8) {}

    var sep = {};
    var hasSep = false;
    try { if (p.isSeparationLeader !== undefined) { sep.is_leader = p.isSeparationLeader === true; hasSep = true; } } catch (e9) {}
    try { if (p.dimensionsSeparated !== undefined) { sep.dimensions_separated = p.dimensionsSeparated === true; hasSep = true; } } catch (e10) {}
    try { if (p.isSeparationFollower !== undefined) { sep.is_follower = p.isSeparationFollower === true; hasSep = true; } } catch (e11) {}
    if (hasSep && sep.is_leader === true && sep.dimensions_separated === true) {
      var followers = [];
      for (var d = 0; d < 3; d++) {
        try {
          var f = p.getSeparationFollower(d);
          if (!f) break;
          followers.push({ dimension: d, name: String(f.name), match_name: String(f.matchName) });
        } catch (e12) { break; }
      }
      sep.followers = followers;
    }
    if (hasSep) m.separation = sep;

    // AE 26.0: dropdown (popup) properties list their items.
    try {
      var items = p.propertyParameters;
      if (items !== undefined && items !== null && items.length > 0) {
        var list = [];
        for (var k = 0; k < items.length && k < MAX_LIST; k++) list.push(String(items[k]));
        var dd = { items: list };
        try { if (p.valueText !== undefined) dd.value_text = String(p.valueText); } catch (e13) {}
        m.dropdown = dd;
      }
    } catch (e14) {}
    return m;
  };

  // ----- shape and marker values -----

  function pointList(src, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var pt = src[i];
      out.push([pt[0], pt[1]]);
    }
    return out;
  }

  A.serialiseShape = function (shape) {
    var out = { vertices: [], inTangents: [], outTangents: [], closed: true };
    var n = 0;
    try { n = shape.vertices.length; } catch (e0) { n = 0; }
    var cap = n;
    if (cap > MAX_VERTICES) cap = MAX_VERTICES;
    try { out.vertices = pointList(shape.vertices, cap); } catch (e1) {}
    try { out.inTangents = pointList(shape.inTangents, cap); } catch (e2) {}
    try { out.outTangents = pointList(shape.outTangents, cap); } catch (e3) {}
    try { out.closed = shape.closed === true; } catch (e4) {}
    out.num_vertices = n;
    if (n > cap) out.truncated = true;
    try {
      if (shape.featherSegLocs !== undefined) out.feather_points = shape.featherSegLocs.length;
    } catch (e5) {}
    return out;
  };

  function numberPoint(pt, what, i) {
    if (!isArray(pt) || pt.length < 2 || typeof pt[0] !== "number" || typeof pt[1] !== "number" || isNaN(pt[0]) || isNaN(pt[1])) {
      fail("bad_args", what + "[" + i + "] must be a 2-D point [x, y] of numbers.");
    }
    return [pt[0], pt[1]];
  }

  // A Shape from {vertices, inTangents?, outTangents?, closed?}. Missing tangents are zeros. Throws before anything is written.
  A.toShapeValue = function (spec) {
    if (!spec || typeof spec !== "object") fail("bad_args", "A path value must be an object {vertices, inTangents?, outTangents?, closed?}.");
    if (!isArray(spec.vertices) || spec.vertices.length < 1) fail("bad_args", "A path needs vertices: a list of at least one [x, y] point.");
    var n = spec.vertices.length;
    var vs = [];
    var ins = [];
    var outs = [];
    var i;
    for (i = 0; i < n; i++) vs.push(numberPoint(spec.vertices[i], "vertices", i));
    if (spec.inTangents !== undefined && spec.inTangents !== null) {
      if (!isArray(spec.inTangents) || spec.inTangents.length !== n) fail("bad_args", "inTangents must have one [x, y] per vertex (" + n + ").");
      for (i = 0; i < n; i++) ins.push(numberPoint(spec.inTangents[i], "inTangents", i));
    } else {
      for (i = 0; i < n; i++) ins.push([0, 0]);
    }
    if (spec.outTangents !== undefined && spec.outTangents !== null) {
      if (!isArray(spec.outTangents) || spec.outTangents.length !== n) fail("bad_args", "outTangents must have one [x, y] per vertex (" + n + ").");
      for (i = 0; i < n; i++) outs.push(numberPoint(spec.outTangents[i], "outTangents", i));
    } else {
      for (i = 0; i < n; i++) outs.push([0, 0]);
    }
    var shape = new Shape();
    shape.vertices = vs;
    shape.inTangents = ins;
    shape.outTangents = outs;
    shape.closed = spec.closed !== false;
    return shape;
  };

  var MARKER_FIELDS = ["comment", "duration", "chapter", "url", "frameTarget", "cuePointName", "eventCuePoint", "label", "protectedRegion"];

  A.serialiseMarker = function (marker) {
    var out = {};
    for (var i = 0; i < MARKER_FIELDS.length; i++) {
      try {
        var v = marker[MARKER_FIELDS[i]];
        if (v !== undefined) out[MARKER_FIELDS[i]] = v;
      } catch (e1) {}
    }
    try {
      if (marker.getParameters !== undefined) {
        var params = marker.getParameters();
        var plain = {};
        for (var k in params) {
          if (params.hasOwnProperty(k)) plain[k] = String(params[k]);
        }
        out.params = plain;
      }
    } catch (e2) {}
    return out;
  };

  // A MarkerValue from {comment, duration, chapter, url, frameTarget, cuePointName, label, protectedRegion, params}.
  A.toMarkerValue = function (spec) {
    if (!spec || typeof spec !== "object") {
      if (typeof spec === "string") spec = { comment: spec };
      else fail("bad_args", "A marker value must be an object {comment, duration?, ...} or a string.");
    }
    var m = new MarkerValue(spec.comment !== undefined && spec.comment !== null ? String(spec.comment) : "");
    var fields = ["duration", "chapter", "url", "frameTarget", "cuePointName", "label", "protectedRegion"];
    for (var i = 0; i < fields.length; i++) {
      if (spec[fields[i]] !== undefined && spec[fields[i]] !== null) {
        try { m[fields[i]] = spec[fields[i]]; } catch (e1) {}
      }
    }
    if (spec.params && typeof spec.params === "object") {
      try { m.setParameters(spec.params); } catch (e2) {}
    }
    return m;
  };

  // ----- fonts -----

  function fontsObject() {
    var fonts = null;
    try { fonts = app.fonts; } catch (e) { fonts = null; }
    if (fonts === undefined) return null;
    return fonts;
  }

  function firstOf(obj, names) {
    for (var i = 0; i < names.length; i++) {
      try {
        var v = obj[names[i]];
        if (v !== undefined && v !== null) return v;
      } catch (e) {}
    }
    return undefined;
  }

  function describeFont(f, withAxes) {
    var d = {};
    var map = [
      ["postscript", "postScriptName"], ["family", "familyName"], ["style", "styleName"], ["full_name", "fullName"],
      ["native_family", "nativeFamilyName"], ["is_substitute", "isSubstitute"], ["is_from_adobe_fonts", "isFromAdobeFonts"],
      ["has_design_axes", "hasDesignAxes"], ["font_id", "fontID"]
    ];
    for (var i = 0; i < map.length; i++) {
      try {
        var v = f[map[i][1]];
        if (v !== undefined && v !== null) d[map[i][0]] = v;
      } catch (e1) {}
    }
    if (withAxes) {
      var axes = [];
      if (d.has_design_axes === true) {
        try {
          var raw = f.designAxesData;
          for (var a = 0; raw && a < raw.length && a < 20; a++) {
            var ax = {};
            var tag = firstOf(raw[a], ["axisTag", "tag"]);
            var nm = firstOf(raw[a], ["axisName", "name"]);
            var mn = firstOf(raw[a], ["minValue", "min"]);
            var mx = firstOf(raw[a], ["maxValue", "max"]);
            var df = firstOf(raw[a], ["defaultValue", "default"]);
            if (tag !== undefined) ax.tag = String(tag);
            if (nm !== undefined) ax.name = String(nm);
            if (mn !== undefined) ax.min = mn;
            if (mx !== undefined) ax.max = mx;
            if (df !== undefined) ax["default"] = df;
            axes.push(ax);
          }
        } catch (e2) {}
      }
      d.axes = axes;
    }
    return d;
  }

  function normFont(s) {
    return String(s).toLowerCase().replace(/[\s\-_]+/g, "");
  }

  // The primary of several fonts with the same PostScript name: AE's own pick (24.6), else a real one over a substitute.
  function pickFont(list, postscript) {
    var i;
    var fonts = fontsObject();
    if (postscript !== "" && fonts) {
      try {
        var dups = fonts.fontsDuplicateByPostScriptName;
        for (i = 0; dups && i < dups.length && i < 5000; i++) {
          var inner = dups[i];
          if (inner && inner.length && String(inner[0].postScriptName) === postscript) {
            return { font: inner[0], duplicates: inner.length - 1 };
          }
        }
      } catch (e1) {}
    }
    var chosen = list[0];
    for (i = 0; i < list.length; i++) {
      var sub = false;
      try { sub = list[i].isSubstitute === true; } catch (e2) {}
      if (!sub) {
        chosen = list[i];
        break;
      }
    }
    var dupCount = 0;
    if (list.length > 1) dupCount = list.length - 1;
    return { font: chosen, duplicates: dupCount };
  }

  // Near matches by family, style and PostScript name over app.fonts.allFonts, bounded by count and time.
  function fontCandidates(wantPs, wantFamily, wantStyle) {
    var out = [];
    var fonts = fontsObject();
    var all = null;
    try { all = fonts.allFonts; } catch (e0) { all = null; }
    var info = { list: out, scanned: 0, truncated: false };
    if (!all) return info;
    var wants = [];
    if (wantPs) wants.push(normFont(wantPs));
    if (wantFamily) wants.push(normFont(wantFamily));
    if (wants.length === 0) return info;
    var wantStyleN = "";
    if (wantStyle) wantStyleN = normFont(wantStyle);
    var started = new Date().getTime();
    var stop = false;
    for (var i = 0; i < all.length && !stop; i++) {
      var fam = all[i];
      var famLen = 0;
      try { famLen = fam.length; } catch (e1) { famLen = 0; }
      for (var j = 0; j < famLen; j++) {
        if (info.scanned >= MAX_FONT_SCAN || (info.scanned % 50 === 0 && new Date().getTime() - started > FONT_SCAN_MS)) {
          info.truncated = true;
          stop = true;
          break;
        }
        info.scanned++;
        var f = fam[j];
        var ps = "";
        var family = "";
        var style = "";
        var names = [];
        try { ps = String(f.postScriptName); names.push(normFont(ps)); } catch (e2) {}
        try { family = String(f.familyName); names.push(normFont(family)); } catch (e3) {}
        try { style = String(f.styleName); } catch (e4) {}
        try { names.push(normFont(f.nativeFamilyName)); } catch (e5) {}
        try { names.push(normFont(f.fullName)); } catch (e6) {}
        var score = 0;
        for (var w = 0; w < wants.length; w++) {
          for (var n = 0; n < names.length; n++) {
            if (names[n] === wants[w]) {
              if (score < 100) score = 100;
            } else if (wants[w].length >= 3 && names[n].length >= 3 && (names[n].indexOf(wants[w]) >= 0 || wants[w].indexOf(names[n]) >= 0)) {
              if (score < 50) score = 50;
            }
          }
        }
        if (score > 0) {
          if (wantStyleN !== "" && normFont(style) === wantStyleN) score += 10;
          out.push({ score: score, postscript: ps, family: family, style: style });
          if (out.length > 200) {
            out.sort(function (x, y) { return y.score - x.score; });
            out.length = 40;
          }
        }
      }
    }
    out.sort(function (x, y) { return y.score - x.score; });
    if (out.length > 10) out.length = 10;
    for (var c = 0; c < out.length; c++) delete out[c].score;
    return info;
  }

  // Looks a font up. Side effect to know: getFontsByPostScriptName can create a variable-font instance in AE's font list.
  function findFont(spec) {
    spec = spec || {};
    var fonts = fontsObject();
    if (!fonts || (fonts.getFontsByPostScriptName === undefined && fonts.getFontsByFamilyNameAndStyleName === undefined)) {
      return { unchecked: true, reason: "This After Effects has no app.fonts (it needs 24.0); the font name was not checked." };
    }
    var ps = "";
    var family = "";
    var style = "";
    if (spec.postscript !== undefined && spec.postscript !== null) ps = String(spec.postscript);
    if (spec.family !== undefined && spec.family !== null) family = String(spec.family);
    if (spec.style !== undefined && spec.style !== null) style = String(spec.style);
    var list = null;
    var lookupError = "";
    if (ps === "" && (family === "" || style === "")) {
      return { bad: true, reason: "A font lookup needs postscript, or family and style." };
    }
    try {
      if (ps !== "") list = fonts.getFontsByPostScriptName(ps);
      else list = fonts.getFontsByFamilyNameAndStyleName(family, style);
    } catch (e1) {
      list = null;
      lookupError = shortError(e1);
    }
    if (list !== null && list !== undefined && list.length === undefined) list = [list];
    if (!list || list.length === 0) {
      var cand = fontCandidates(ps, family, style);
      var label = ps;
      if (label === "") label = family + " " + style;
      var reason = "No installed font matches \"" + label + "\"";
      if (lookupError !== "") reason += " (" + lookupError + ")";
      reason += ".";
      if (cand.list.length > 0) {
        var shown = [];
        for (var c = 0; c < cand.list.length && c < 5; c++) shown.push(cand.list[c].postscript + " (" + cand.list[c].family + " " + cand.list[c].style + ")");
        reason += " Near matches: " + shown.join(", ") + ".";
      }
      if (cand.truncated) reason += " (The font list was only partly searched.)";
      return { notFound: true, candidates: cand.list, reason: reason };
    }
    var picked = pickFont(list, ps);
    return { font: picked.font, duplicates: picked.duplicates };
  }

  A.fontsResolve = function (spec) {
    var r = findFont(spec);
    if (r.unchecked) return { ok: true, unchecked: true, duplicates: 0, candidates: [], reason: r.reason };
    if (r.bad) return { ok: false, duplicates: 0, candidates: [], reason: r.reason };
    if (r.notFound) return { ok: false, duplicates: 0, candidates: r.candidates, reason: r.reason };
    var d = describeFont(r.font, true);
    var out = { ok: true, font: d, duplicates: r.duplicates, candidates: [] };
    if (d.is_substitute === true) {
      out.ok = false;
      out.reason = "After Effects would substitute this font (it is not installed).";
    }
    return out;
  };

  var GLYPH_SKIP = { "\r": true, "\n": true, "\t": true, "\u0003": true, "\u2028": true, "\u2029": true };

  A.fontsGlyphCheck = function (fontOrPostscript, text, maxChars) {
    var limit = 2000;
    if (typeof maxChars === "number" && maxChars > 0) limit = maxChars;
    var s = "";
    if (text !== undefined && text !== null) s = String(text);
    var out = { supported: null, missing: [], checked: 0, truncated: false, scripts: [], suggested_default: [] };
    if (s.length > limit) {
      s = s.substring(0, limit);
      out.truncated = true;
    }
    var font = null;
    if (typeof fontOrPostscript === "string") {
      var found = findFont({ postscript: fontOrPostscript });
      if (found.font) font = found.font;
    } else if (fontOrPostscript && typeof fontOrPostscript === "object") {
      var hasName = false;
      try { hasName = fontOrPostscript.postScriptName !== undefined; } catch (e0) {}
      if (hasName) {
        font = fontOrPostscript;
      } else if (fontOrPostscript.postscript !== undefined) {
        var found2 = findFont({ postscript: fontOrPostscript.postscript });
        if (found2.font) font = found2.font;
      }
    }
    if (!font) {
      out.reason = "The font was not found, so its glyphs were not checked.";
      return out;
    }
    var hasGlyphs = false;
    try { hasGlyphs = font.hasGlyphsFor !== undefined; } catch (e1) {}
    if (!hasGlyphs) {
      out.reason = "This After Effects cannot check glyph coverage (font.hasGlyphsFor needs 25.1).";
      return out;
    }
    // Line breaks and other control characters are not glyphs: they are left out of the whole-string check too.
    var visible = "";
    for (var vi = 0; vi < s.length; vi++) {
      if (GLYPH_SKIP[s.charAt(vi)] !== true) visible += s.charAt(vi);
    }
    var whole = null;
    if (visible.length === 0) {
      out.supported = true;
      return out;
    }
    try { whole = font.hasGlyphsFor(visible); } catch (e2) { whole = null; }
    if (whole === true) {
      out.supported = true;
      out.checked = visible.length;
      return out;
    }
    // Per character (by code point), only because the whole string failed.
    var seen = {};
    var i = 0;
    while (i < s.length) {
      var ch = s.charAt(i);
      var code = s.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
        ch = s.substring(i, i + 2);
        i += 2;
      } else {
        i += 1;
      }
      if (GLYPH_SKIP[ch] === true || seen[ch] === true) continue;
      seen[ch] = true;
      out.checked++;
      var has = true;
      try { has = font.hasGlyphsFor(ch); } catch (e3) { has = true; }
      if (has === false && out.missing.length < 50) out.missing.push(ch);
    }
    out.supported = out.missing.length === 0;

    // Which scripts the text uses, and AE's default font for the scripts the font lacks.
    var fonts = fontsObject();
    if (fonts && fonts.getCTScriptForString !== undefined) {
      var preferred = null;
      try {
        var ws = font.writingScripts;
        if (ws && ws.length > 0) preferred = ws[0];
      } catch (e4) {}
      if (preferred === null) {
        try { preferred = CTScript.CT_ROMAN_SCRIPT; } catch (e5) {}
      }
      try {
        var runs = fonts.getCTScriptForString(s, preferred);
        var doneScripts = {};
        for (var r = 0; runs && r < runs.length && r < 50; r++) {
          var chars = String(runs[r].chars);
          var script = String(runs[r].ctScript);
          out.scripts.push({ chars: chars.length > 200 ? chars.substring(0, 200) : chars, ct_script: script });
          var lacks = false;
          for (var m = 0; m < out.missing.length; m++) {
            if (chars.indexOf(out.missing[m]) >= 0) lacks = true;
          }
          if (lacks && doneScripts[script] !== true && out.suggested_default.length < 10 && fonts.getDefaultFontForCTScript !== undefined) {
            doneScripts[script] = true;
            try {
              var def = fonts.getDefaultFontForCTScript(runs[r].ctScript);
              if (def) out.suggested_default.push({ ct_script: script, postscript: String(def.postScriptName) });
            } catch (e6) {}
          }
        }
      } catch (e7) {}
    }
    return out;
  };

  // ----- TextDocument -----

  var TEXT_ENUM_FIELDS = {
    justification: true, fontCapsOption: true, fontBaselineOption: true, autoKernType: true, lineJoinType: true, digitSet: true,
    direction: true, baselineDirection: true, lineOrientation: true, leadingType: true, composerEngine: true,
    boxVerticalAlignment: true, boxAutoFitPolicy: true, boxFirstBaselineAlignment: true
  };

  var TEXT_FULL_FIELDS = [
    "applyFill", "applyStroke", "strokeWidth", "tracking", "leading", "fontCapsOption", "fontBaselineOption",
    "autoKernType", "ligature", "noBreak", "horizontalScale", "verticalScale", "tsume", "strokeOverFill", "lineJoinType",
    "autoLeading", "digitSet", "direction", "baselineDirection", "lineOrientation", "spaceBefore", "spaceAfter",
    "firstLineIndent", "startIndent", "endIndent", "everyLineComposer", "hangingRoman", "autoHyphenate", "leadingType",
    "composerEngine", "pointText", "boxText", "boxTextSize", "boxTextPos", "boxVerticalAlignment", "boxAutoFitPolicy",
    "boxInsetSpacing", "boxFirstBaselineAlignment", "boxFirstBaselineAlignmentMinimum", "paragraphCount", "composedLineCount"
  ];

  function textField(doc, name) {
    var v = doc[name];
    if (TEXT_ENUM_FIELDS[name] === true && v !== undefined && v !== null) return String(v);
    if (isArray(v)) return serialiseValue(v);
    return v;
  }

  A.textDocSerialise = function (doc, opts) {
    var full = !!(opts && opts.full);
    // The five fields core has always returned, in this order.
    var td = { text: doc.text };
    try { td.font = doc.font; } catch (e1) {}
    try { td.fontSize = doc.fontSize; } catch (e2) {}
    try { td.fillColor = doc.fillColor; } catch (e3) {}
    try { td.justification = String(doc.justification); } catch (e4) {}
    if (!full) return td;

    var mixed = [];
    var i;
    var applyFill = true;
    var applyStroke = false;
    try { applyFill = doc.applyFill !== false; } catch (e5) {}
    try { applyStroke = doc.applyStroke === true; } catch (e6) {}
    // Fill and stroke colours only mean something while they are applied.
    if (!applyFill) delete td.fillColor;
    if (applyStroke) {
      try { td.strokeColor = doc.strokeColor; } catch (e7) { mixed.push("strokeColor"); }
    }
    for (i = 0; i < TEXT_FULL_FIELDS.length; i++) {
      var name = TEXT_FULL_FIELDS[i];
      var v;
      var threw = false;
      try { v = textField(doc, name); } catch (e8) { threw = true; v = undefined; }
      if (threw) {
        mixed.push(name);
      } else if (v === undefined) {
        // Mixed values read undefined; a field this AE lacks is simply absent.
        var present = false;
        try { present = name in doc; } catch (e9) { present = false; }
        if (present) mixed.push(name);
      } else {
        td[name] = v;
      }
    }
    // Fields core already read: a read that came back undefined is mixed too.
    if (td.font === undefined) mixed.push("font");
    if (td.fontSize === undefined) mixed.push("fontSize");
    try {
      var fo = doc.fontObject;
      if (fo) {
        var fd = describeFont(fo, false);
        td.fontObject = { postscript: fd.postscript, family: fd.family, style: fd.style, is_substitute: fd.is_substitute };
      }
    } catch (e10) {}
    td.mixed = mixed;
    return td;
  };

  // ---------- status detail ----------

  var MAX_SELECTED_PROPS = 100;
  var MAX_SELECTED_KEYS = 200;
  var MAX_PROJECT_SELECTION = 50;

  // Selected properties with the layer each belongs to. CompItem.selectedProperties
  // has no layer, so selected layers are scanned first and the rest only while
  // the count is short.
  function selectedPropertyEntries(comp) {
    var out = { items: [], total: 0, truncated: false, keys_truncated: false };
    var total = 0;
    try { total = comp.selectedProperties.length; } catch (e0) { total = 0; }
    out.total = total;
    if (total === 0) return out;
    var order = [];
    var seen = {};
    var i;
    try {
      var sl = comp.selectedLayers;
      for (i = 0; i < sl.length; i++) {
        order.push(sl[i]);
        seen[sl[i].index] = true;
      }
    } catch (e1) {}
    var n = comp.numLayers;
    for (i = 1; i <= n && order.length < MAX_LIST; i++) {
      if (seen[i] !== true) order.push(comp.layer(i));
    }
    var found = 0;
    var keysUsed = 0;
    for (var j = 0; j < order.length && found < total; j++) {
      var layer = order[j];
      var lp = null;
      try { lp = layer.selectedProperties; } catch (e2) { lp = null; }
      if (!lp) continue;
      for (var k = 0; k < lp.length; k++) {
        found++;
        if (out.items.length >= MAX_SELECTED_PROPS) {
          out.truncated = true;
          continue;
        }
        var prop = lp[k];
        var entry = { layer_id: layer.id, layer_index: layer.index, path: [], name: "", match_name: "", is_group: false, selected_keys: [] };
        try { entry.path = A.propertyPath(prop).path; } catch (e3) {}
        try { entry.name = String(prop.name); } catch (e4) {}
        try { entry.match_name = String(prop.matchName); } catch (e5) {}
        try { entry.is_group = prop.propertyType !== PropertyType.PROPERTY; } catch (e6) {}
        if (!entry.is_group) {
          try {
            var keys = prop.selectedKeys;
            for (var q = 0; keys && q < keys.length; q++) {
              if (keysUsed >= MAX_SELECTED_KEYS) {
                out.keys_truncated = true;
                break;
              }
              keysUsed++;
              entry.selected_keys.push({ index: keys[q], time: round4(prop.keyTime(keys[q])) });
            }
          } catch (e7) {}
        }
        out.items.push(entry);
      }
    }
    return out;
  }

  // The name of an AE enum constant (they are numbers): looks the value up in the global enum object,
  // and falls back to String(v) when the object or the value is not there.
  function enumNameOf(globalName, v, candidates) {
    var obj = null;
    try { obj = $.global[globalName]; } catch (e0) { obj = null; }
    if (obj !== null && obj !== undefined) {
      var keys = [];
      try { for (var k in obj) keys.push(k); } catch (e1) {}
      if (candidates) {
        for (var c = 0; c < candidates.length; c++) keys.push(candidates[c]);
      }
      for (var i = 0; i < keys.length; i++) {
        try {
          var val = obj[keys[i]];
          if (typeof val !== "function" && val === v) return String(keys[i]);
        } catch (e2) {}
      }
    }
    return String(v);
  }

  function viewerKind(t) {
    if (typeof ViewerType === "undefined") return "unknown";
    try {
      if (t === ViewerType.VIEWER_COMPOSITION) return "comp";
      if (t === ViewerType.VIEWER_LAYER) return "layer";
      if (t === ViewerType.VIEWER_FOOTAGE) return "footage";
    } catch (e) {}
    return "unknown";
  }

  // Everything an agent wants to know about what the user is looking at and
  // working with, and the environment. A read: no setActive, no openInViewer,
  // nothing that moves focus, selection or time. Never userName or machineName.
  // args.environment_only skips the selection and viewer parts.
  A.statusDetail = function (args) {
    var envOnly = !!(args && args.environment_only);
    var out = { warnings: [], hints: [], missing: [] };
    var i;

    if (!envOnly) {
      var ai = null;
      try { ai = app.project.activeItem; } catch (e0) { ai = null; }
      out.active_item = null;
      if (ai) {
        out.active_item = { id: ai.id, name: ai.name, kind: itemKind(ai) };
      }
      out.project_selection = [];
      try {
        var psel = app.project.selection;
        out.project_selection_count = psel.length;
        for (i = 0; i < psel.length && i < MAX_PROJECT_SELECTION; i++) {
          var it = psel[i];
          var parentId = null;
          try { if (it.parentFolder) parentId = it.parentFolder.id; } catch (e1) {}
          out.project_selection.push({ id: it.id, name: it.name, kind: itemKind(it), parent_folder_id: parentId });
        }
        if (psel.length > MAX_PROJECT_SELECTION) out.project_selection_truncated = true;
      } catch (e2) {
        out.missing.push("app.project.selection");
      }
      if (ai === null && out.project_selection_count > 1) {
        out.hints.push("Several Project items are selected, so there is no single active item.");
      }

      out.active_comp = null;
      out.selected_properties = [];
      if (ai && ai instanceof CompItem) {
        var ac = { id: ai.id, name: ai.name, time: null, frame: null, frame_rate: null, work_area_start: null, work_area_duration: null };
        try { ac.time = round4(ai.time); } catch (e3) {}
        try {
          ac.frame_rate = ai.frameRate;
          ac.frame = Math.round(ai.time / ai.frameDuration);
        } catch (e4) {}
        try { ac.work_area_start = round4(ai.workAreaStart); } catch (e5) {}
        try { ac.work_area_duration = round4(ai.workAreaDuration); } catch (e6) {}
        out.active_comp = ac;
        try {
          var sp = selectedPropertyEntries(ai);
          out.selected_properties = sp.items;
          out.selected_properties_count = sp.total;
          if (sp.truncated) out.selected_properties_truncated = true;
          if (sp.keys_truncated) out.selected_keys_truncated = true;
        } catch (e7) {
          out.missing.push("CompItem.selectedProperties");
        }
      }

      out.viewer = null;
      var viewer = null;
      try { viewer = app.activeViewer; } catch (e8) { viewer = null; out.missing.push("app.activeViewer"); }
      if (viewer) {
        var vw = { type: "unknown", maximized: null, view_count: null, active_view_index: null };
        try { vw.type = viewerKind(viewer.type); } catch (e9) {}
        try { vw.maximized = viewer.maximized === true; } catch (e10) {}
        try { vw.view_count = viewer.views.length; } catch (e11) {}
        try { vw.active_view_index = viewer.activeViewIndex; } catch (e12) {}
        out.viewer = vw;
      } else {
        out.hints.push("There is no active viewer (the panel may have focus). active_item is reported on its own and may not be what the viewer shows.");
      }

      try {
        var tt = app.project.toolType;
        if (tt !== undefined) out.tool_type = enumNameOf("ToolType", tt, ["Tool_Arrow", "Tool_Rotate", "Tool_CameraMaya", "Tool_CameraOrbit", "Tool_CameraTrackXY", "Tool_CameraTrackZ", "Tool_Paintbrush", "Tool_CloneStamp", "Tool_Eraser", "Tool_Hand", "Tool_Magnify", "Tool_PanBehind", "Tool_Rect", "Tool_RoundedRect", "Tool_Oval", "Tool_Polygon", "Tool_Star", "Tool_TextH", "Tool_TextV", "Tool_Pen", "Tool_Feather", "Tool_PenPlus", "Tool_PenMinus", "Tool_PenConvert", "Tool_Pin", "Tool_PinStarch", "Tool_PinBend", "Tool_PinAdvanced", "Tool_PinDepth", "Tool_Quickselect", "Tool_Hairbrush", "Tool_RotoBrush", "Tool_RefineEdge"]);
        else out.missing.push("Project.toolType (AE 14.0)");
      } catch (e13) {
        out.missing.push("Project.toolType (AE 14.0)");
      }
    }

    // Environment
    try {
      var dr = app.disableRendering;
      if (dr === undefined) {
        out.missing.push("app.disableRendering (AE 16.0)");
      } else {
        out.rendering_disabled = dr === true;
        if (dr === true) {
          out.warnings.push("Rendering is disabled (app.disableRendering): ae_snapshot_frame, ae_contact_sheet and ae_ui_screenshot show stale or blank frames.");
        }
      }
    } catch (e14) {
      out.missing.push("app.disableRendering (AE 16.0)");
    }
    var build = {};
    try { if (app.buildName !== undefined) build.name = String(app.buildName); } catch (e15) {}
    try { if (app.buildNumber !== undefined) build.number = app.buildNumber; } catch (e16) {}
    out.build = build;
    try {
      var iso = app.isoLanguage;
      if (iso !== undefined) {
        out.iso_language = String(iso);
        if (String(iso) !== "en_US") {
          out.hints.push("The UI language is " + String(iso) + ": property and effect names are translated, so address properties by match name.");
        }
      } else {
        out.missing.push("app.isoLanguage");
      }
    } catch (e17) {
      out.missing.push("app.isoLanguage");
    }
    var gpu = {};
    try {
      var avail = app.availableGPUAccelTypes;
      if (avail !== undefined) {
        gpu.available = [];
        for (i = 0; avail && i < avail.length && i < 20; i++) gpu.available.push(enumNameOf("GpuAccelType", avail[i], ["CUDA", "METAL", "OPENCL", "SOFTWARE"]));
      } else {
        out.missing.push("app.availableGPUAccelTypes (AE 14.0)");
      }
    } catch (e18) {
      out.missing.push("app.availableGPUAccelTypes (AE 14.0)");
    }
    try {
      var pg = app.project.gpuAccelType;
      if (pg !== undefined) gpu.project = enumNameOf("GpuAccelType", pg, ["CUDA", "METAL", "OPENCL", "SOFTWARE"]);
      else out.missing.push("Project.gpuAccelType (AE 13.8)");
    } catch (e19) {
      out.missing.push("Project.gpuAccelType (AE 13.8)");
    }
    out.gpu = gpu;
    try { out.os = String($.os); } catch (e20) {}
    try {
      var rev = app.project.revision;
      if (typeof rev === "number") out.revision = rev;
      else out.missing.push("Project.revision");
    } catch (e21) {
      out.missing.push("Project.revision");
    }
    return out;
  };

  // ---------- user JSX ----------

  // The wrapper opener has no newline, so AE's error line is the caller's line.
  var WRAP_PREFIX = "(function(){ ";
  var WRAP_SUFFIX = "\n})()";

  function splitLines(s) {
    return String(s).split("\r\n").join("\n").split("\r").join("\n").split("\n");
  }

  function runWrapped(code) {
    try {
      return eval(WRAP_PREFIX + code + WRAP_SUFFIX);
    } catch (e) {
      var line = null;
      try { if (typeof e.line === "number") line = e.line; } catch (e1) {}
      var lines = splitLines(code);
      var extra = {};
      if (line !== null && line >= 1 && line <= lines.length) {
        extra.line = line;
        extra.sourceText = lines[line - 1].substring(0, 200);
      }
      var msg = "ExtendScript error";
      try { msg = String(e.message ? e.message : e); } catch (e2) {}
      fail("runtime", msg, extra);
    }
    return undefined;
  }

  // ext/*.jsx use this so code compiles in core's scope, like ae_run_jsx code.
  A.compileInCore = function (src) { return eval(src); };

  function plainResult(v, depth) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === "number" || t === "string" || t === "boolean") return v;
    if (t === "function") return "[function]";
    if (depth > 12) return "[max depth]";
    if (isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length && i < MAX_LIST * 10; i++) a.push(plainResult(v[i], depth + 1));
      return a;
    }
    var isPlain = false;
    try { if (v.constructor === Object) isPlain = true; } catch (e1) {}
    if (!isPlain) {
      var tag = "[object]";
      try { tag = "[" + v.reflect.name; } catch (e2) {}
      try { if (typeof v.name === "string") tag += " \"" + v.name + "\""; } catch (e3) {}
      try { if (typeof v.id === "number") tag += " #" + v.id; } catch (e4) {}
      if (tag.charAt(tag.length - 1) !== "]") tag += "]";
      return tag;
    }
    var o = {};
    for (var k in v) {
      if (!v.hasOwnProperty(k)) continue;
      try { o[k] = plainResult(v[k], depth + 1); } catch (e5) { o[k] = "[threw]"; }
    }
    return o;
  }

  // Plain copy of a script's return value (AE objects become summaries), for ext/*.jsx.
  A.plainResult = function (v) {
    return plainResult(v, 0);
  };

  A.runUserJsx = function (args) {
    var code = args.code;
    if (!code) fail("bad_args", "ae_run_jsx needs code");
    var value;
    if (args.mutates) {
      assertGuard(args.expect);
      value = A.withUndo(args.label || "Chroma AE MCP: run_jsx", function () {
        return runWrapped(code);
      });
    } else {
      value = runWrapped(code);
    }
    if (value === undefined || value === null) {
      return {
        returned: null,
        note: "Completed with no return value. This is not a failure; anything the script changed is applied. Read state back rather than re-running it."
      };
    }
    return plainResult(value, 0);
  };

  // ---------- writes ----------

  function toPropValue(p, v) {
    var vt = null;
    try { vt = p.propertyValueType; } catch (e0) {}
    if (vt === PropertyValueType.SHAPE && v && typeof v === "object" && !(typeof Shape !== "undefined" && v instanceof Shape)) {
      return A.toShapeValue(v);
    }
    if (vt === PropertyValueType.MARKER && v !== null && v !== undefined) {
      return A.toMarkerValue(v);
    }
    var isText = false;
    try { isText = (vt === PropertyValueType.TEXT_DOCUMENT); } catch (e1) {}
    if (!isText) return v;
    var doc = p.value;
    if (typeof v === "string") {
      doc.text = v;
      return doc;
    }
    if (v && typeof v === "object") {
      if (v.text !== undefined) doc.text = v.text;
      if (v.fontSize !== undefined) doc.fontSize = v.fontSize;
      if (v.font !== undefined) doc.font = v.font;
      if (v.fillColor !== undefined) doc.fillColor = v.fillColor;
      return doc;
    }
    return v;
  }

  function interpType(name) {
    if (name === "linear") return KeyframeInterpolationType.LINEAR;
    if (name === "hold") return KeyframeInterpolationType.HOLD;
    return KeyframeInterpolationType.BEZIER;
  }

  // How many numbers a property takes: [fewest, most], or null when it is not a plain numeric property.
  // Position, Scale and Anchor Point keep three dimensions on a 2D layer, so two are accepted.
  function valueDims(p) {
    var t = null;
    try { t = p.propertyValueType; } catch (e) { return null; }
    if (t === PropertyValueType.OneD) return [1, 1];
    if (t === PropertyValueType.TwoD || t === PropertyValueType.TwoD_SPATIAL) return [2, 2];
    if (t === PropertyValueType.ThreeD || t === PropertyValueType.ThreeD_SPATIAL) return [2, 3];
    if (t === PropertyValueType.COLOR) return [3, 4];
    return null;
  }

  // Refuses a value the property cannot take (wrong count, not numbers, outside its min and max) with a clear
  // message, before the undo group opens. AE would throw "out of range" half way through otherwise.
  function checkNumericValue(p, v, what) {
    var dims = valueDims(p);
    if (dims === null) return;
    var name = "";
    try { name = String(p.name); } catch (e0) {}
    var isNum = typeof v === "number";
    if (dims[1] === 1) {
      if (!isNum) fail("bad_args", what + " for \"" + name + "\" must be one number.");
    } else if (!isArray(v) || v.length < dims[0] || v.length > dims[1]) {
      var want = String(dims[0]);
      if (dims[1] !== dims[0]) want = dims[0] + " or " + dims[1];
      fail("bad_args", what + " for \"" + name + "\" must be an array of " + want + " numbers" + (isArray(v) ? ", got " + v.length : "") + ".");
    }
    var list = isNum ? [v] : v;
    var hasMin = false;
    var hasMax = false;
    try { hasMin = p.hasMin === true; } catch (e1) {}
    try { hasMax = p.hasMax === true; } catch (e2) {}
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (typeof x !== "number" || isNaN(x)) fail("bad_args", what + " for \"" + name + "\" must be numbers.");
      if (hasMin && x < p.minValue) fail("bad_args", "\"" + name + "\" accepts " + p.minValue + " at the lowest, got " + x + ".", { expected: { min: p.minValue }, actual: x });
      if (hasMax && x > p.maxValue) fail("bad_args", "\"" + name + "\" accepts " + p.maxValue + " at the highest, got " + x + ".", { expected: { max: p.maxValue }, actual: x });
    }
  }

  // A font name that is not installed would be substituted without a word: refuse it, with near matches.
  function checkTextFont(p, v, args) {
    if (args.allow_substitute === true) return;
    if (!v || typeof v !== "object" || v.font === undefined || v.font === null) return;
    var isText = false;
    try { isText = p.propertyValueType === PropertyValueType.TEXT_DOCUMENT; } catch (e) {}
    if (!isText) return;
    var r = A.fontsResolve({ postscript: String(v.font) });
    if (r.ok || r.unchecked) return;
    fail("bad_args", "Font \"" + v.font + "\" is not available. " + (r.reason ? r.reason + " " : "") + "Pick one of the candidates, or pass allow_substitute: true to write the name as it is (After Effects then substitutes).", {
      actual: { font: String(v.font), candidates: r.candidates }
    });
  }

  function shapeVertexCount(v) {
    try { return v.vertices.length; } catch (e) { return -1; }
  }

  A.setProperty = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var p = resolvePath(l, args.path);
    if (p.propertyType !== PropertyType.PROPERTY) fail("bad_args", "Path resolves to a group, not a property");

    var hasExpr = args.expression !== undefined && args.expression !== null;
    var hasKeys = !!(args.keyframes && args.keyframes.length);
    var hasValue = args.value !== undefined && args.value !== null;
    var hasEnabled = args.expression_enabled === true || args.expression_enabled === false;
    var warnings = [];
    var i;

    // ---- everything that can fail, before the undo group ----
    if (hasExpr && !p.canSetExpression) fail("bad_args", "Property cannot take an expression");
    if (hasEnabled && !hasExpr) {
      if (!p.canSetExpression) fail("bad_args", "Property cannot take an expression");
      if (args.expression_enabled === true && String(p.expression) === "") {
        fail("bad_args", "There is no expression on this property to switch on; pass `expression` as well.");
      }
    }
    if (!hasExpr && !hasKeys && !hasValue && hasEnabled && p.expressionEnabled === args.expression_enabled) {
      return { applied: [], numKeys: p.numKeys, no_op: true };
    }
    var vt = null;
    try { vt = p.propertyValueType; } catch (eVt) {}
    if (vt === PropertyValueType.CUSTOM_VALUE || vt === PropertyValueType.NO_VALUE) {
      if (hasKeys || hasValue) fail("bad_args", "This property has no value a script can set (custom or valueless parameter). Use an expression or a preset.");
    }
    if (hasKeys || hasValue) {
      var separated = false;
      try { separated = p.dimensionsSeparated === true; } catch (eSep) {}
      if (separated) {
        fail("bad_args", "This property's dimensions are separated: write its X, Y (and Z) Position followers instead (see ae_get_layer_props meta, separation.followers).");
      }
    }
    if (vt === PropertyValueType.MARKER && hasValue && !hasKeys) {
      fail("bad_args", "Markers are keys: pass keyframes: [{ time, value: { comment, duration, ... } }].");
    }

    var preparedKeys = [];
    var preparedValue = null;
    if (hasKeys) {
      for (i = 0; i < args.keyframes.length; i++) {
        var kf = args.keyframes[i];
        if (typeof kf.time !== "number" || isNaN(kf.time)) fail("bad_args", "keyframes[" + i + "].time must be a number of seconds.");
        checkNumericValue(p, kf.value, "keyframes[" + i + "].value");
        checkTextFont(p, kf.value, args);
        preparedKeys.push(toPropValue(p, kf.value));
      }
    }
    if (hasValue) {
      checkNumericValue(p, args.value, "value");
      checkTextFont(p, args.value, args);
      preparedValue = toPropValue(p, args.value);
    }
    if (vt === PropertyValueType.SHAPE && (hasKeys || hasValue)) {
      var fresh = [];
      for (i = 0; i < preparedKeys.length; i++) fresh.push(shapeVertexCount(preparedKeys[i]));
      if (hasValue) fresh.push(shapeVertexCount(preparedValue));
      for (i = 1; i < fresh.length; i++) {
        if (fresh[i] !== fresh[0]) fail("bad_args", "Path keyframes must all have the same number of vertices (" + fresh[0] + " and " + fresh[i] + " given). Use ae_path_write to change the vertex count.");
      }
      var existing = -1;
      var feathered = false;
      try {
        if (p.numKeys > 0) existing = shapeVertexCount(p.keyValue(1));
        else existing = shapeVertexCount(p.value);
        feathered = p.value.featherSegLocs.length > 0;
      } catch (eEx) {}
      if (existing > 0 && fresh.length > 0 && fresh[0] !== existing) {
        if (p.numKeys > 0) {
          fail("bad_args", "This path is keyframed with " + existing + " vertices; the new shape has " + fresh[0] + ". All path keys need the same vertex count: use ae_path_write.");
        }
        warnings.push("The path went from " + existing + " to " + fresh[0] + " vertices." + (feathered ? " Its feather points are lost: ae_path_write keeps them." : ""));
      } else if (feathered && fresh.length > 0) {
        warnings.push("This path has feather points and a written path carries none: they are lost. ae_path_write keeps them.");
      }
    }

    var result = A.withUndo("Chroma AE MCP: set " + args.path.join(" > "), function () {
      var done = [];
      if (hasExpr) {
        p.expression = args.expression;
        done.push("expression");
      }
      if (hasEnabled) {
        p.expressionEnabled = args.expression_enabled;
        done.push("expression_enabled");
      }
      if (hasKeys) {
        for (var k = 0; k < args.keyframes.length; k++) {
          var key = args.keyframes[k];
          p.setValueAtTime(key.time, preparedKeys[k]);
          if (key.interp) {
            var ki = p.nearestKeyIndex(key.time);
            var it = interpType(key.interp);
            p.setInterpolationTypeAtKey(ki, it, it);
          }
        }
        done.push("keyframes");
      }
      if (hasValue) {
        if (p.numKeys > 0) {
          p.setValueAtTime(c.time, preparedValue);
          done.push("value_at_current_time");
        } else {
          p.setValue(preparedValue);
          done.push("value");
        }
      }
      return { applied: done, numKeys: p.numKeys };
    });
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  };

  // saveFrameToPng into the server-allocated path, at full resolution. It must
  // not touch the comp: changing resolutionFactor, even temporarily, put steps
  // on Jay's undo stack (measured 2026-10-27). saveFrameToPng writes the file
  // asynchronously; the server waits for it.
  A.snapshotFrame = function (args) {
    var c = requireComp(args.comp_id);
    var f = new File(args.output_path);
    var dir = f.parent;
    if (dir && !dir.exists) dir.create();
    var t = args.time;
    if (t < 0) t = 0;
    if (t > c.duration) t = c.duration;
    c.saveFrameToPng(t, f);
    return { path: f.fsName, time: t, width: c.width, height: c.height };
  };

  A.rqAdd = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var rq = app.project.renderQueue;
    var item = rq.items.add(c);
    if (args.render_settings_template) item.applyTemplate(args.render_settings_template);
    var om = item.outputModule(1);
    if (args.output_module_template) om.applyTemplate(args.output_module_template);
    om.file = new File(args.output_path);
    return { index: rq.numItems, comp_id: c.id, output: om.file.fsName };
  };

  // A plain save needs a project that already has a file (save() on an untitled project opens a dialog:
  // never). args.save_as_path saves under a new name instead (Save As) and works for an untitled project;
  // the server has checked the path, the folder and the overwrite.
  A.save = function (args) {
    assertGuard(args.expect);
    if (args.save_as_path !== undefined && args.save_as_path !== null && args.save_as_path !== "") {
      var target = new File(args.save_as_path);
      var folder = null;
      try { folder = target.parent; } catch (eParent) { folder = null; }
      if (folder && folder.exists === false) fail("bad_args", "The folder for " + args.save_as_path + " does not exist.");
      app.project.save(target);
      return { project_path: projectPath(), dirty: app.project.dirty, saved_as: args.save_as_path };
    }
    if (!app.project.file) fail("guard", "Project is unsaved; use ae_save with save_as: { path } to give it a name.");
    app.project.save();
    return { project_path: projectPath(), dirty: app.project.dirty };
  };

  G.__chromaAe = A;
})($.global);
