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

  function serialiseValue(v) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === "number" || t === "string" || t === "boolean") return v;
    if (isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(serialiseValue(v[i]));
      return a;
    }
    if (v instanceof TextDocument) {
      var td = { text: v.text };
      try { td.font = v.font; } catch (e1) {}
      try { td.fontSize = v.fontSize; } catch (e2) {}
      try { td.fillColor = v.fillColor; } catch (e3) {}
      try { td.justification = String(v.justification); } catch (e4) {}
      return td;
    }
    try { return "[" + v.reflect.name + "]"; } catch (e5) {}
    return String(v);
  }

  function describeProp(p, depth) {
    var d = { name: p.name, matchName: p.matchName, propertyIndex: p.propertyIndex };
    if (p.propertyType === PropertyType.PROPERTY) {
      d.kind = "property";
      try { d.value = serialiseValue(p.value); } catch (e1) { d.value = null; d.valueError = String(e1.message); }
      d.numKeys = p.numKeys;
      try {
        d.expression = p.canSetExpression ? p.expression : "";
        d.expressionEnabled = p.canSetExpression ? p.expressionEnabled : false;
      } catch (e2) {}
      if (p.numKeys > 0) {
        var keys = [];
        var n = p.numKeys;
        if (n > MAX_LIST) n = MAX_LIST;
        for (var k = 1; k <= n; k++) {
          var kv = null;
          try { kv = serialiseValue(p.keyValue(k)); } catch (e3) {}
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
        try { kids.push(describeProp(p.property(i), depth - 1)); } catch (e4) {}
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
    }
    return s;
  }

  A.getProject = function (args) {
    var depth = (args && args.depth) ? args.depth : 3;
    var root = app.project.rootFolder;
    if (args && args.folder_id !== undefined && args.folder_id !== null) {
      var f = app.project.itemByID(args.folder_id);
      if (!f || !(f instanceof FolderItem)) fail("not_found", "No FolderItem with id " + args.folder_id);
      root = f;
    }
    var items = [];
    var truncated = false;
    function walk(folder, d) {
      for (var i = 1; i <= folder.numItems; i++) {
        if (items.length >= MAX_LIST) {
          truncated = true;
          return;
        }
        var it = folder.item(i);
        items.push(itemSummary(it));
        if (it instanceof FolderItem && d > 1) walk(it, d - 1);
      }
    }
    walk(root, depth);
    return {
      project_path: projectPath(),
      numItems: app.project.numItems,
      root_id: root.id,
      items: items,
      truncated: truncated
    };
  };

  A.getComp = function (args) {
    var c = requireComp(args.comp_id);
    var layers = [];
    var n = c.numLayers;
    if (n > MAX_LIST) n = MAX_LIST;
    for (var i = 1; i <= n; i++) layers.push(layerSummary(c.layer(i)));
    return {
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
      truncated: c.numLayers > MAX_LIST
    };
  };

  A.getLayerProps = function (args) {
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var depth = (args.depth !== undefined && args.depth !== null) ? args.depth : 2;
    var out = { comp_id: c.id, layer: layerSummary(l) };
    if (args.path && args.path.length) {
      out.property = describeProp(resolvePath(l, args.path), depth);
    } else {
      var props = [];
      for (var i = 1; i <= l.numProperties; i++) {
        try { props.push(describeProp(l.property(i), depth - 1)); } catch (e) {}
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
    var isText = false;
    try { isText = (p.propertyValueType === PropertyValueType.TEXT_DOCUMENT); } catch (e1) {}
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

  A.setProperty = function (args) {
    assertGuard(args.expect);
    var c = requireComp(args.comp_id);
    var l = findLayer(c, args.layer);
    var p = resolvePath(l, args.path);
    if (p.propertyType !== PropertyType.PROPERTY) fail("bad_args", "Path resolves to a group, not a property");
    return A.withUndo("Chroma AE MCP: set " + args.path.join(" > "), function () {
      var done = [];
      if (args.expression !== undefined && args.expression !== null) {
        if (!p.canSetExpression) fail("bad_args", "Property cannot take an expression");
        p.expression = args.expression;
        done.push("expression");
      }
      if (args.keyframes && args.keyframes.length) {
        for (var i = 0; i < args.keyframes.length; i++) {
          var kf = args.keyframes[i];
          p.setValueAtTime(kf.time, toPropValue(p, kf.value));
          if (kf.interp) {
            var ki = p.nearestKeyIndex(kf.time);
            var it = interpType(kf.interp);
            p.setInterpolationTypeAtKey(ki, it, it);
          }
        }
        done.push("keyframes");
      }
      if (args.value !== undefined && args.value !== null) {
        if (p.numKeys > 0) {
          p.setValueAtTime(c.time, toPropValue(p, args.value));
          done.push("value_at_current_time");
        } else {
          p.setValue(toPropValue(p, args.value));
          done.push("value");
        }
      }
      return { applied: done, numKeys: p.numKeys };
    });
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

  A.save = function (args) {
    assertGuard(args.expect);
    if (!app.project.file) fail("guard", "Project is unsaved; save it once in After Effects first.");
    app.project.save();
    return { project_path: projectPath(), dirty: app.project.dirty };
  };

  G.__chromaAe = A;
})($.global);
