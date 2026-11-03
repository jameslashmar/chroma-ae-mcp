// panel/host/ext/preflight.jsx
//
// Host functions for ae_preflight (all read-only; nothing here opens an undo
// group, moves the time indicator or changes the selection):
// - preflightProject: project settings, unsaved state, the render queue with
//   its output files and folders, fonts AE reports missing, and the installed
//   effects (cached for the layer reads that follow)
// - preflightItems: a slice of the project panel: comps (size, renderer,
//   usage) and footage (missing file, placeholder, proxy, usage)
// - preflightLayers: a slice of one comp's layers: counts of effects,
//   expressions and keys, expressions in error, effects that are not
//   installed, missing fonts, and the nested comps the layers use
//
// The server calls these in slices so no single evalScript runs long, and
// does the ranking, naming rules and severity in Node.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Reads only. Forcing an expression to evaluate (valueAtTime) does not move time.
// - Every list is bounded (500) and every string clipped.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var ITEMS_DEFAULT = 150;
  var ITEMS_MAX = 300;
  var LAYERS_DEFAULT = 30;
  var LAYERS_MAX = 100;
  // Properties visited per layer, expressions forced per slice, issues kept per slice.
  var MAX_PROPS = 3000;
  var MAX_FORCE = 200;
  var HIDDEN_BUILTIN = {
    "ADBE Paint": true,
    "ADBE FreePin3": true,
    "ADBE Samurai": true,
    "ADBE Roto Brush & Refine Edge": true,
    "ADBE Vector Blend Mode": true,
    "ADBE Mocha Shape": true,
    "ADBE Geometry2": true,
    "ADBE Ripple": true
  };
  var MAX_ISSUES = 200;
  var MAX_DEPTH = 14;
  var MAX_USED_IN = 10;

  // app.effects does not change while AE runs; read once per scan.
  var installedCache = null;

  function fail(kind, message) {
    var e = new Error(message);
    e.__kind = kind;
    throw e;
  }

  function clip(s, n) {
    var t = String(s);
    if (t.length > n) return t.substring(0, n);
    return t;
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

  function wholeNumber(v, dflt, min, max) {
    if (v === undefined || v === null) return dflt;
    var n = Math.floor(Number(v));
    if (isNaN(n)) return dflt;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  // typeName is in AE's language, so tell kinds apart by class.
  function footageKind(it) {
    try { if (it.mainSource instanceof SolidSource) return "solid"; } catch (e1) {}
    try { if (it.mainSource instanceof PlaceholderSource) return "placeholder"; } catch (e2) {}
    return "footage";
  }

  function layerKind(l) {
    var reflectName = "";
    try {
      if (l.reflect && l.reflect.name) reflectName = String(l.reflect.name);
    } catch (e0) {}
    if (reflectName === "TextLayer") return "text";
    if (reflectName === "ShapeLayer") return "shape";
    if (reflectName === "CameraLayer") return "camera";
    if (reflectName === "LightLayer") return "light";
    try { if (l.nullLayer) return "null"; } catch (e1) {}
    try { if (l.adjustmentLayer) return "adjustment"; } catch (e2) {}
    try { if (l.source && l.source instanceof CompItem) return "precomp"; } catch (e3) {}
    try { if (l.source && l.source.mainSource && l.source.mainSource instanceof SolidSource) return "solid"; } catch (e4) {}
    try { if (l.hasAudio && !l.hasVideo) return "audio"; } catch (e5) {}
    if (reflectName === "AVLayer") return "footage";
    return reflectName.toLowerCase();
  }

  function loadInstalledEffects() {
    var map = {};
    var count = 0;
    try {
      var list = app.effects;
      if (list) {
        for (var i = 0; i < list.length; i++) {
          var mn = "";
          try { mn = String(list[i].matchName); } catch (e1) {}
          if (mn.length > 0) {
            map["m:" + mn] = true;
            count++;
          }
        }
      }
    } catch (e2) {}
    // An empty list means the read failed, not that no effect is installed.
    return { map: map, count: count, ok: count > 0 };
  }

  function statusName(s) {
    if (typeof RQItemStatus === "undefined") return String(s);
    if (s === RQItemStatus.WILL_CONTINUE) return "will_continue";
    if (s === RQItemStatus.NEEDS_OUTPUT) return "needs_output";
    if (s === RQItemStatus.UNQUEUED) return "unqueued";
    if (s === RQItemStatus.QUEUED) return "queued";
    if (s === RQItemStatus.RENDERING) return "rendering";
    if (s === RQItemStatus.USER_STOPPED) return "user_stopped";
    if (s === RQItemStatus.ERR_STOPPED) return "err_stopped";
    if (s === RQItemStatus.DONE) return "done";
    return String(s);
  }

  // ---------- project ----------

  A.preflightProject = function () {
    installedCache = loadInstalledEffects();
    var out = {
      aeVersion: String(app.version),
      project_path: "<unsaved>",
      saved: false,
      dirty: null,
      numItems: app.project.numItems,
      bits_per_channel: null,
      working_space: null,
      linear_blending: null,
      expression_engine: null,
      installed_effects: installedCache.count,
      effects_check: installedCache.ok ? "available" : "unavailable",
      missing_fonts: [],
      fonts_check: "unavailable",
      render_queue: { numItems: 0, rendering: false, items: [], truncated: false }
    };
    var f = app.project.file;
    if (f) {
      out.project_path = f.fsName;
      out.saved = true;
    }
    try { out.dirty = app.project.dirty === true; } catch (e1) {}
    try { out.bits_per_channel = app.project.bitsPerChannel; } catch (e2) {}
    try { out.working_space = String(app.project.workingSpace); } catch (e3) {}
    try { out.linear_blending = app.project.linearBlending === true; } catch (e4) {}
    try { out.expression_engine = String(app.project.expressionEngine); } catch (e5) {}

    // AE 24+: the fonts the project uses that are missing or substituted.
    try {
      var mf = app.fonts.missingOrSubstitutedFonts;
      if (mf) {
        out.fonts_check = "available";
        for (var m = 0; m < mf.length && out.missing_fonts.length < MAX_LIST; m++) {
          var fname = "";
          try { fname = String(mf[m].postScriptName); } catch (e6) {}
          if (fname.length === 0) {
            try { fname = String(mf[m].nativeName); } catch (e7) {}
          }
          if (fname.length > 0) out.missing_fonts.push(clip(fname, 200));
        }
      }
    } catch (e8) {}

    var rq = app.project.renderQueue;
    out.render_queue.numItems = rq.numItems;
    try { out.render_queue.rendering = rq.rendering === true; } catch (e9) {}
    for (var i = 1; i <= rq.numItems; i++) {
      if (out.render_queue.items.length >= MAX_LIST) {
        out.render_queue.truncated = true;
        break;
      }
      var it = rq.item(i);
      var entry = { index: i, comp_id: null, comp_name: null, status: "", render: false, outputs: [] };
      try {
        entry.comp_id = it.comp.id;
        entry.comp_name = clip(it.comp.name, 200);
      } catch (e10) {}
      try { entry.status = statusName(it.status); } catch (e11) {}
      try { entry.render = it.render === true; } catch (e12) {}
      var nOut = 0;
      try { nOut = it.numOutputModules; } catch (e13) {}
      for (var o = 1; o <= nOut && o <= 20; o++) {
        var rec = { file: null, folder: null, folder_exists: null };
        try {
          var of = it.outputModule(o).file;
          if (of) {
            rec.file = of.fsName;
            try {
              var pf = of.parent;
              if (pf) {
                rec.folder = pf.fsName;
                rec.folder_exists = pf.exists === true;
              }
            } catch (e14) {}
          }
        } catch (e15) {}
        entry.outputs.push(rec);
      }
      out.render_queue.items.push(entry);
    }
    return out;
  };

  // ---------- items ----------

  // args: { offset, limit }
  A.preflightItems = function (args) {
    var offset = wholeNumber(args && args.offset, 0, 0, 100000000);
    var limit = wholeNumber(args && args.limit, ITEMS_DEFAULT, 1, ITEMS_MAX);
    var total = app.project.numItems;
    var end = offset + limit;
    if (end > total) end = total;
    var comps = [];
    var footage = [];
    var folders = 0;
    for (var i = offset + 1; i <= end; i++) {
      var it = app.project.item(i);
      var used = 0;
      var usedIn = [];
      try {
        var u = it.usedIn;
        used = u.length;
        for (var j = 0; j < u.length && j < MAX_USED_IN; j++) usedIn.push(u[j].id);
      } catch (e0) {}
      if (it instanceof CompItem) {
        var c = { id: it.id, name: clip(it.name, 200), width: it.width, height: it.height, fps: it.frameRate, duration: it.duration, layers: it.numLayers, renderer: null, used_n: used, used_in: usedIn };
        try { c.renderer = String(it.renderer); } catch (e1) {}
        try {
          var cps = it.proxySource;
          if (cps) {
            var cpx = { use: false, file: null, missing: false };
            try { cpx.use = it.useProxy === true; } catch (e1a) {}
            try { if (cps.file) cpx.file = cps.file.fsName; } catch (e1b) {}
            try { if (cps.missingFootagePath) cpx.missing = true; } catch (e1c) {}
            c.proxy = cpx;
          }
        } catch (e1d) {}
        comps.push(c);
      } else if (it instanceof FootageItem) {
        var kind = footageKind(it);
        var e = { id: it.id, name: clip(it.name, 200), kind: kind, file: null, missing: false, width: it.width, height: it.height, used_n: used, used_in: usedIn, proxy: null };
        try { if (it.file) e.file = it.file.fsName; } catch (e2) {}
        if (!e.file) {
          try {
            if (it.mainSource instanceof FileSource && it.mainSource.missingFootagePath) e.file = String(it.mainSource.missingFootagePath);
          } catch (e3) {}
        }
        try { e.missing = it.footageMissing === true; } catch (e4) {}
        try {
          var ps = it.proxySource;
          if (ps) {
            var px = { use: false, file: null, missing: false };
            try { px.use = it.useProxy === true; } catch (e5) {}
            try { if (ps.file) px.file = ps.file.fsName; } catch (e6) {}
            try { if (ps.missingFootagePath) px.missing = true; } catch (e7) {}
            e.proxy = px;
          }
        } catch (e8) {}
        footage.push(e);
      } else if (it instanceof FolderItem) {
        folders++;
      }
    }
    var next = null;
    if (end < total) next = end;
    return { offset: offset, total: total, next_offset: next, comps: comps, footage: footage, folders: folders };
  };

  // ---------- layers ----------

  function addIssue(S, issue) {
    if (S.issues.length >= MAX_ISSUES) {
      S.overflow++;
      return;
    }
    S.issues.push(issue);
  }

  function issueFor(li, type, path, detail) {
    var out = { type: type, index: li.index, layer_id: li.id, layer: li.name, kind: li.kind };
    if (path) out.path = clip(path, 400);
    if (detail !== undefined && detail !== null) out.detail = clip(detail, 400);
    return out;
  }

  function forceable(p) {
    try {
      var t = p.propertyValueType;
      if (typeof PropertyValueType !== "undefined") {
        if (t === PropertyValueType.CUSTOM_VALUE || t === PropertyValueType.NO_VALUE) return false;
      }
    } catch (e0) {}
    return true;
  }

  function checkProperty(p, path, li, S) {
    var nk = 0;
    try { nk = p.numKeys; } catch (e0) { nk = 0; }
    if (nk > 0) S.counts.keys += nk;
    var can = false;
    try { can = p.canSetExpression === true; } catch (e1) {}
    if (!can) return;
    var ex = "";
    try {
      ex = p.expression;
      if (ex === undefined || ex === null) ex = "";
      ex = String(ex);
    } catch (e2) { ex = ""; }
    if (ex.length === 0) return;
    S.counts.expressions++;
    var enabled = true;
    try { enabled = p.expressionEnabled !== false; } catch (e3) {}
    var errText = "";
    var thrown = "";
    // Forcing evaluation is what makes AE fill in expressionError for an
    // expression it has not run yet; valueAtTime does not move time.
    // CUSTOM_VALUE and NO_VALUE properties (e.g. Colorama's Output Cycle) throw
    // "has not been implemented" when read, even with a working expression.
    if (S.force && enabled && forceable(p)) {
      if (S.forced < MAX_FORCE) {
        S.forced++;
        try {
          p.valueAtTime(S.time, false);
        } catch (e4) {
          try { thrown = clip(e4.message ? e4.message : e4, 300); } catch (e5) { thrown = "Expression evaluation threw an error"; }
          if (thrown.length === 0) thrown = "Expression evaluation threw an error";
        }
      } else {
        S.capped++;
      }
    }
    try {
      var pe = p.expressionError;
      if (pe && String(pe).length > 0) errText = clip(pe, 300);
    } catch (e6) {}
    if (errText.length > 0) {
      addIssue(S, issueFor(li, "expression_error", path.join(" > "), errText));
    } else if (thrown.length > 0) {
      // The read threw but AE holds no error for the expression: it could not be checked, not broken.
      addIssue(S, issueFor(li, "expression_unchecked", path.join(" > "), thrown));
    } else if (!enabled) {
      addIssue(S, issueFor(li, "expression_disabled", path.join(" > "), null));
    }
  }

  function checkEffect(p, path, li, S) {
    S.counts.effects++;
    if (!S.installed.ok) return;
    var mn = "";
    try { mn = String(p.matchName); } catch (e0) {}
    if (mn.length === 0) return;
    // Pseudo effects (presets, Essential Properties helpers) are not in app.effects.
    if (mn.indexOf("Pseudo/") === 0) return;
    // Built-in effects AE hides from the Effect menu may be missing from app.effects (not measured).
    if (HIDDEN_BUILTIN[mn] === true) return;
    if (S.installed.map["m:" + mn] === true) return;
    var issue = issueFor(li, "effect_unavailable", path.join(" > "), null);
    issue.effect = clip(p.name, 100);
    issue.match_name = clip(mn, 100);
    addIssue(S, issue);
  }

  function walk(group, path, depth, li, S) {
    if (depth > MAX_DEPTH) return;
    var n = 0;
    try { n = group.numProperties || 0; } catch (e0) { n = 0; }
    var parade = false;
    try { parade = group.matchName === "ADBE Effect Parade"; } catch (e1) {}
    for (var i = 1; i <= n; i++) {
      if (S.visited >= MAX_PROPS) {
        S.props_truncated = true;
        return;
      }
      var p = null;
      try { p = group.property(i); } catch (e2) { p = null; }
      if (!p) continue;
      S.visited++;
      var nm = "";
      try { nm = String(p.name); } catch (e3) {}
      var here = path.concat([nm]);
      var pt = null;
      try { pt = p.propertyType; } catch (e4) {}
      if (pt === PropertyType.PROPERTY) {
        checkProperty(p, here, li, S);
      } else {
        if (parade) checkEffect(p, here, li, S);
        walk(p, here, depth + 1, li, S);
      }
    }
  }

  // Source Text can be keyed: look at the value and the first few keys.
  function checkText(l, li, S) {
    var st = null;
    try {
      var tp = l.property("ADBE Text Properties");
      if (tp) st = tp.property("ADBE Text Document");
    } catch (e0) { st = null; }
    if (!st) return;
    var docs = [];
    try {
      var nk = st.numKeys;
      if (nk > 0) {
        if (nk > 5) nk = 5;
        for (var k = 1; k <= nk; k++) docs.push(st.keyValue(k));
      } else {
        docs.push(st.value);
      }
    } catch (e1) {}
    var seen = {};
    for (var d = 0; d < docs.length; d++) {
      var td = docs[d];
      var font = "";
      var substitute = null;
      try { font = String(td.font); } catch (e2) {}
      try {
        if (td.fontObject) substitute = td.fontObject.isSubstitute === true;
      } catch (e3) {}
      if (substitute === null) {
        S.fonts_unchecked++;
        continue;
      }
      if (substitute && font.length > 0 && seen["f:" + font] !== true) {
        seen["f:" + font] = true;
        addIssue(S, issueFor(li, "font_missing", null, font));
      }
    }
  }

  // args: { comp_id, from, limit, force_eval, time, text_candidates }
  A.preflightLayers = function (args) {
    if (!args) fail("bad_args", "preflightLayers needs args");
    var comp = requireComp(args.comp_id);
    var total = comp.numLayers;
    var from = wholeNumber(args.from, 1, 1, 100000000);
    var limit = wholeNumber(args.limit, LAYERS_DEFAULT, 1, LAYERS_MAX);
    var to = from + limit - 1;
    if (to > total) to = total;
    var t = comp.time;
    if (args.time !== undefined && args.time !== null) {
      t = Number(args.time);
      if (isNaN(t)) t = comp.time;
    }
    if (!installedCache) installedCache = loadInstalledEffects();
    var S = {
      installed: installedCache,
      force: args.force_eval === true,
      time: t,
      forced: 0,
      capped: 0,
      visited: 0,
      props_truncated: false,
      issues: [],
      overflow: 0,
      fonts_unchecked: 0,
      counts: { layers: 0, effects: 0, expressions: 0, keys: 0, three_d: 0, text: 0, precomp: 0 }
    };
    var layers = [];
    var precompIds = [];
    var seenPre = {};
    var texts = [];
    var out = {
      comp_id: comp.id,
      name: clip(comp.name, 200),
      width: comp.width,
      height: comp.height,
      time: t,
      renderer: null,
      num_layers: total,
      from: from,
      to: to,
      next_from: null,
      layers: layers,
      counts: S.counts,
      precomp_ids: precompIds,
      texts: texts
    };
    try { out.renderer = String(comp.renderer); } catch (e0) {}
    for (var i = from; i <= to; i++) {
      var l = comp.layer(i);
      var kind = layerKind(l);
      var enabled = true;
      try { enabled = l.enabled === true; } catch (e1) {}
      var li = { index: i, id: l.id, name: clip(l.name, 200), kind: kind };
      layers.push({ index: i, name: li.name, kind: kind, enabled: enabled });
      S.counts.layers++;
      var threeD = false;
      try { threeD = l.threeDLayer === true; } catch (e2) {}
      if (threeD) S.counts.three_d++;
      if (kind === "precomp") {
        S.counts.precomp++;
        try {
          var sid = l.source.id;
          if (seenPre["c:" + sid] !== true) {
            seenPre["c:" + sid] = true;
            precompIds.push(sid);
          }
        } catch (e3) {}
      }
      if (kind === "text") {
        S.counts.text++;
        checkText(l, li, S);
        if (args.text_candidates === true && enabled && !threeD && texts.length < MAX_LIST) texts.push({ index: i, id: l.id, name: li.name });
      }
      S.visited = 0;
      walk(l, [], 0, li, S);
      if (S.props_truncated) {
        // The layer's own property tree was cut at MAX_PROPS; say so once per layer.
        addIssue(S, issueFor(li, "properties_truncated", null, "More than " + MAX_PROPS + " properties; the rest were not checked."));
        S.props_truncated = false;
      }
    }
    if (to < total) out.next_from = to + 1;
    out.issues = S.issues;
    out.issues_overflow = S.overflow;
    out.forced_evals = S.forced;
    out.force_capped = S.capped;
    out.fonts_unchecked = S.fonts_unchecked;
    out.effects_check = S.installed.ok ? "available" : "unavailable";
    return out;
  };
})($.global);
