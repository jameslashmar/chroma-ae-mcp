// panel/host/ext/collect.jsx
//
// Host functions for the collect tools (Collect Files without AE's dialog).
// The files themselves are copied by the server's Node code; AE is asked only
// what the project holds, and, in the explicit relink step, to relink a copy:
// - collectState (read): the open project's path, dirty flag, size and AE build
// - collectFootage (read): footage items, a page at a time, with their files,
//   proxies, bins and uses
// - collectInfo (read): comps, effects, expressions and render-queue outputs
//   for the version report
// - collectSwitch (guarded): close the open project (never prompting) and open
//   another, optionally saving the open one first
// - collectRelink (guarded write): point a copy's footage at the collected files
// - collectVerify (read): which footage items point at the collected files
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Writes check the target guard first, validate before changing anything and
//   wrap changes in A.withUndo.
// - Reads change nothing: no time, selection, active item or proxy switch.
// - Read-backs run in separate evalScript calls from the server.
// - No dialogs are suppressed. A modal AE raises is read with ae_dialogs.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_MAP = 20000;
  var MAX_PROPS = 20000;
  var MAX_LAYER_VISITS = 5000;
  var IS_WIN = false;
  try {
    IS_WIN = String($.os).indexOf("Windows") >= 0;
  } catch (eOs) {}

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

  function projectPath() {
    try {
      if (app.project && app.project.file) return app.project.file.fsName;
    } catch (e) {}
    return "<unsaved>";
  }

  // true, false, or null when AE would not say: callers treat only false as clean.
  function isDirty() {
    try {
      var d = app.project.dirty;
      if (d === true) return true;
      if (d === false) return false;
    } catch (e) {}
    return null;
  }

  function normPath(p) {
    var s = String(p).split("\\").join("/");
    if (IS_WIN) s = s.toLowerCase();
    return s;
  }

  function fileOf(file) {
    try {
      if (file) return file.fsName;
    } catch (e) {}
    return null;
  }

  // A footage item's file: the item first, then its main source.
  function itemFile(it) {
    var f = null;
    try {
      f = fileOf(it.file);
    } catch (e1) {}
    if (f) return f;
    try {
      f = fileOf(it.mainSource.file);
    } catch (e2) {}
    return f;
  }

  // A missing item has no file: AE keeps the path it could not find on the source.
  function missingPathOf(it) {
    var p = null;
    try {
      if (it.footageMissing === true && it.mainSource) p = it.mainSource.missingFootagePath;
    } catch (e1) {
      p = null;
    }
    if (!p) return null;
    var s = null;
    try {
      if (typeof p === "string") s = p;
      else if (p.fsName) s = p.fsName;
      else s = String(p);
    } catch (e2) {
      s = null;
    }
    return s ? s : null;
  }

  var RQ_STATUS = ["WILL_CONTINUE", "NEEDS_OUTPUT", "UNQUEUED", "QUEUED", "RENDERING", "USER_STOPPED", "ERR_STOPPED", "DONE"];

  // RenderQueueItem.status is an enum number: name it, or fall back to the value.
  function rqStatusName(status) {
    try {
      if (typeof RQItemStatus !== "undefined") {
        for (var i = 0; i < RQ_STATUS.length; i++) {
          if (status === RQItemStatus[RQ_STATUS[i]]) return RQ_STATUS[i];
        }
      }
    } catch (e) {}
    return String(status);
  }

  // A moving source is a movie or audio file, an image sequence, or unknown.
  // Known single-file containers are never sequences; known image formats are.
  // Any other extension counts as a sequence only when the file name ends in a
  // frame number. A .gif is treated as one animated file.
  var MOVIE_EXT = {
    mov: 1, mp4: 1, m4v: 1, mxf: 1, avi: 1, mkv: 1, webm: 1, wmv: 1, flv: 1, f4v: 1, mpg: 1, mpeg: 1, mpe: 1, mpv: 1, m1v: 1, m2v: 1,
    m2p: 1, m2t: 1, m2ts: 1, mts: 1, ts: 1, vob: 1, dv: 1, mod: 1, tod: 1, "3gp": 1, "3g2": 1, mj2: 1, r3d: 1, braw: 1, crm: 1,
    amc: 1, c4d: 1, gif: 1, swf: 1, glb: 1, gltf: 1, obj: 1,
    wav: 1, aif: 1, aiff: 1, mp3: 1, aac: 1, m4a: 1, flac: 1, ogg: 1, wma: 1, ac3: 1, bwf: 1, m2a: 1, mpa: 1, mp2: 1
  };
  var SEQUENCE_EXT = {
    png: 1, jpg: 1, jpeg: 1, tif: 1, tiff: 1, tga: 1, bmp: 1, exr: 1, dpx: 1, cin: 1, hdr: 1, sgi: 1, rgb: 1, bw: 1, iff: 1,
    rla: 1, rpf: 1, pct: 1, pict: 1, pxr: 1, dng: 1, cr2: 1, nef: 1, arw: 1, jp2: 1, j2k: 1, ari: 1, psd: 1, webp: 1
  };

  function looksLikeSequence(source, path) {
    var still = true;
    try {
      still = source.isStill === true;
    } catch (e) {}
    if (still) return false;
    var m = /\.([A-Za-z0-9]+)$/.exec(String(path));
    if (m === null) return false;
    var ext = m[1].toLowerCase();
    if (MOVIE_EXT[ext] === 1) return false;
    if (SEQUENCE_EXT[ext] === 1) return true;
    return /[0-9]\.[A-Za-z0-9]+$/.test(String(path));
  }

  var LAYERED_EXT = { psd: 1, psb: 1, ai: 1, eps: 1, pdf: 1 };

  function extOf(p) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(p));
    if (m === null) return "";
    return m[1].toLowerCase();
  }

  function baseOf(p) {
    var s = String(p).split("\\").join("/");
    return s.substring(s.lastIndexOf("/") + 1);
  }

  // A layered file imported as a comp or as one chosen layer: its items are
  // named "Layer/file.psd", or several items share one file. FootageItem.replace
  // has no layer argument and would turn each of them into the merged image.
  function isLayeredItem(it, file, counts) {
    if (!file || LAYERED_EXT[extOf(file)] !== 1) return false;
    if (counts[normPath(file)] > 1) return true;
    var nm = String(it.name);
    var cut = nm.lastIndexOf("/");
    if (cut > 0 && nm.substring(cut + 1).toLowerCase() === baseOf(file).toLowerCase()) return true;
    return false;
  }

  function buildInfo() {
    var out = { version: null, build_name: null, build_number: null, os: null };
    try { out.version = String(app.version); } catch (e1) {}
    try { out.build_name = String(app.buildName); } catch (e2) {}
    try { out.build_number = app.buildNumber; } catch (e3) {}
    try { out.os = String($.os); } catch (e4) {}
    return out;
  }

  function binPath(it) {
    var names = [];
    var root = app.project.rootFolder;
    var f = null;
    try { f = it.parentFolder; } catch (e) { f = null; }
    var guard = 0;
    while (f && f !== root && guard < 50) {
      names.unshift(String(f.name));
      try { f = f.parentFolder; } catch (e2) { f = null; }
      guard++;
    }
    return names;
  }

  A.collectState = function () {
    var path = projectPath();
    return {
      project_path: path,
      saved: path !== "<unsaved>",
      dirty: isDirty(),
      num_items: app.project.numItems,
      ae: buildInfo()
    };
  };

  // Footage items by ordinal, a page at a time (limit at most 500). Items with
  // no file (solids, placeholders) are counted and named in no_file.
  A.collectFootage = function (args) {
    var offset = 0;
    if (args && typeof args.offset === "number" && args.offset > 0) offset = Math.floor(args.offset);
    var limit = MAX_LIST;
    if (args && typeof args.limit === "number" && args.limit > 0 && args.limit < MAX_LIST) limit = Math.floor(args.limit);
    var items = [];
    var noFile = [];
    var total = 0;
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      var isComp = it instanceof CompItem;
      if (!(it instanceof FootageItem) && !isComp) continue;
      var compProxy = null;
      if (isComp) {
        // A comp has no file of its own: only one with a proxy file is listed, as a proxy-only entry.
        try { compProxy = fileOf(it.proxySource ? it.proxySource.file : null); } catch (eCp) { compProxy = null; }
        if (!compProxy) continue;
      }
      var ordinal = total;
      total++;
      if (ordinal < offset || ordinal >= offset + limit) continue;
      if (isComp) {
        var cuses = 0;
        try { cuses = it.usedIn.length; } catch (eCu) {}
        var cseq = looksLikeSequence(it.proxySource, compProxy);
        var cuse = false;
        try { cuse = it.useProxy === true; } catch (eCuse) {}
        items.push({
          item_id: it.id,
          name: String(it.name),
          file: compProxy,
          sequence: cseq,
          missing: false,
          used_in: cuses,
          bin: binPath(it),
          proxy_only: true,
          proxy: { file: compProxy, sequence: cseq, in_use: cuse }
        });
        continue;
      }
      var path = itemFile(it);
      var missing = false;
      try { missing = it.footageMissing === true; } catch (eM) {}
      if (!path) {
        var kind = "none";
        try {
          if (it.mainSource instanceof SolidSource) kind = "solid";
          else if (it.mainSource instanceof PlaceholderSource) kind = "placeholder";
        } catch (eK) {}
        if (kind === "none") {
          // A missing file: AE reports it through missingFootagePath, not file.
          var mp = missingPathOf(it);
          if (mp) {
            path = mp;
            missing = true;
          }
        }
        if (!path) {
          noFile.push({ item_id: it.id, name: String(it.name), kind: kind });
          continue;
        }
      }
      var uses = 0;
      try { uses = it.usedIn.length; } catch (eU) {}
      var entry = {
        item_id: it.id,
        name: String(it.name),
        file: path,
        sequence: looksLikeSequence(it.mainSource, path),
        missing: missing,
        used_in: uses,
        bin: binPath(it),
        proxy: null
      };
      // Reading the proxy does not switch it on or off.
      try {
        var pf = fileOf(it.proxySource ? it.proxySource.file : null);
        if (pf) {
          entry.proxy = {
            file: pf,
            sequence: looksLikeSequence(it.proxySource, pf),
            in_use: it.useProxy === true
          };
        }
      } catch (eP) {}
      items.push(entry);
    }
    return {
      project_path: projectPath(),
      dirty: isDirty(),
      offset: offset,
      limit: limit,
      total: total,
      next_offset: offset + limit < total ? offset + limit : null,
      items: items,
      no_file: noFile
    };
  };

  function countExpressions(group, budget) {
    var n = 0;
    var n2 = 0;
    try { n2 = group.numProperties; } catch (e) { return 0; }
    for (var i = 1; i <= n2; i++) {
      if (budget.left <= 0) {
        budget.truncated = true;
        return n;
      }
      var p = null;
      try { p = group.property(i); } catch (e1) { p = null; }
      if (!p) continue;
      budget.left--;
      var isGroup = false;
      try { isGroup = p.propertyType !== PropertyType.PROPERTY; } catch (e2) {}
      if (isGroup) {
        n += countExpressions(p, budget);
      } else {
        try { if (p.expressionEnabled === true && p.expression !== "") n++; } catch (e3) {}
      }
    }
    return n;
  }

  // Comps, effects, expressions and render outputs for the version report.
  // scan false skips the layer walk (the comps are still listed).
  A.collectInfo = function (args) {
    var scan = !(args && args.scan === false);
    var comps = [];
    var compsTruncated = false;
    var effects = {};
    var effectOrder = [];
    var expressions = 0;
    var budget = { left: MAX_PROPS, truncated: false };
    var visits = 0;
    var layersCapped = false;
    var numComps = 0;
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (!(it instanceof CompItem)) continue;
      numComps++;
      if (comps.length >= MAX_LIST) {
        compsTruncated = true;
        continue;
      }
      comps.push({
        id: it.id,
        name: String(it.name),
        width: it.width,
        height: it.height,
        fps: it.frameRate,
        duration: it.duration,
        num_layers: it.numLayers
      });
      if (!scan) continue;
      for (var j = 1; j <= it.numLayers; j++) {
        if (visits >= MAX_LAYER_VISITS) {
          layersCapped = true;
          break;
        }
        visits++;
        var layer = null;
        try { layer = it.layer(j); } catch (eL) { layer = null; }
        if (!layer) continue;
        var parade = null;
        try { parade = layer.property("ADBE Effect Parade"); } catch (eE) { parade = null; }
        if (parade) {
          var np = 0;
          try { np = parade.numProperties; } catch (eN) {}
          for (var k = 1; k <= np; k++) {
            var fx = null;
            try { fx = parade.property(k); } catch (eF) { fx = null; }
            if (!fx) continue;
            var mn = String(fx.matchName);
            if (!effects[mn]) {
              effects[mn] = { match_name: mn, name: String(fx.name), count: 0 };
              effectOrder.push(mn);
            }
            effects[mn].count++;
          }
        }
        expressions += countExpressions(layer, budget);
      }
    }
    var effectList = [];
    for (var e = 0; e < effectOrder.length && e < MAX_LIST; e++) effectList.push(effects[effectOrder[e]]);
    var effectsTruncated = effectOrder.length > MAX_LIST;

    var outputs = [];
    var rqTruncated = false;
    try {
      var rq = app.project.renderQueue;
      for (var r = 1; r <= rq.numItems; r++) {
        var rqi = rq.item(r);
        var compName = null;
        try { compName = String(rqi.comp.name); } catch (eC) {}
        var status = null;
        try { if (rqi.status !== undefined) status = rqStatusName(rqi.status); } catch (eS) {}
        var nOut = 0;
        try { nOut = rqi.numOutputModules; } catch (eO) {}
        for (var o = 1; o <= nOut; o++) {
          if (outputs.length >= MAX_LIST) {
            rqTruncated = true;
            break;
          }
          var om = null;
          var file = null;
          var omName = null;
          try { om = rqi.outputModule(o); } catch (eM) { om = null; }
          if (om) {
            try { file = fileOf(om.file); } catch (eFile) {}
            try { omName = String(om.name); } catch (eName) {}
          }
          outputs.push({ item: r, comp: compName, status: status, output_module: omName, file: file });
        }
      }
    } catch (eRq) {}

    return {
      project_path: projectPath(),
      dirty: isDirty(),
      ae: buildInfo(),
      num_items: app.project.numItems,
      num_comps: numComps,
      comps: comps,
      comps_truncated: compsTruncated,
      scanned: scan,
      layers_scanned: visits,
      layers_capped: layersCapped,
      effects: effectList,
      effects_total: effectOrder.length,
      effects_truncated: effectsTruncated,
      expressions: { count: expressions, truncated: budget.truncated || layersCapped },
      render_outputs: outputs,
      render_outputs_truncated: rqTruncated
    };
  };

  // Close the open project and open another. The open one must be one of
  // expect_open (so a save or a close never hits a project the caller did not
  // mean). A project with unsaved changes is refused unless discard_changes
  // is true or save_first saves it. CloseOptions.DO_NOT_SAVE_CHANGES always:
  // PROMPT_TO_SAVE_CHANGES would raise a modal that blocks the bridge.
  A.collectSwitch = function (args) {
    if (!args || !args.to_path) fail("bad_args", "collectSwitch needs to_path");
    var open = projectPath();
    var allowed = args.expect_open;
    if (!allowed || allowed.length === undefined || allowed.length === 0) {
      fail("bad_args", "collectSwitch needs expect_open (the project paths it may close)");
    }
    var ok = false;
    for (var a = 0; a < allowed.length; a++) {
      if (normPath(allowed[a]) === normPath(open)) ok = true;
    }
    if (!ok) {
      fail("guard", "The open project is not the one this switch expects. Stop and re-read state.", {
        expected: { project_path: allowed },
        actual: { project_path: open }
      });
    }
    var target = new File(args.to_path);
    if (!target.exists) fail("not_found", "Project file does not exist: " + String(args.to_path));
    var dirty = isDirty();
    if (dirty !== false && args.save_first !== true && args.discard_changes !== true) {
      fail("guard", "Refusing to close a project with unsaved changes (pass save_first or discard_changes). If AE would not say whether there are unsaved changes, that counts as unsaved.", {
        expected: { dirty: false },
        actual: { project_path: open, dirty: dirty }
      });
    }
    var saved = false;
    if (args.save_first === true && open !== "<unsaved>") {
      app.project.save();
      saved = true;
    }
    app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    app.open(target);
    return {
      closed: open,
      saved: saved,
      project_path: projectPath(),
      dirty: isDirty(),
      num_items: app.project.numItems
    };
  };

  function pathKeyOf(file, sequence) {
    var tag = "0";
    if (sequence) tag = "1";
    return normPath(file) + "|" + tag;
  }

  // A role's mappings, two ways: by item id (stored in the .aep, so it survives
  // the copy whatever path AE reports there) and by path plus sequence flag (the
  // same disk file can be one item's sequence frame and another's still).
  function mappingTable(list, role) {
    var t = { byId: {}, byPath: {} };
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.role !== role) continue;
      t.byPath[pathKeyOf(m.from, m.sequence === true)] = m;
      if (m.item_ids && m.item_ids.length !== undefined) {
        for (var k = 0; k < m.item_ids.length; k++) t.byId["i" + m.item_ids[k]] = m;
      }
    }
    return t;
  }

  // The id first; the path only for an item no mapping names by id.
  function findMapping(table, it, file, source) {
    var byId = table.byId["i" + it.id];
    if (byId) return byId;
    if (!file) return null;
    // The flag as the item reads now first; the other one only when nothing else names this path.
    var seq = looksLikeSequence(source, file);
    var hit = table.byPath[pathKeyOf(file, seq)];
    if (hit) return hit;
    hit = table.byPath[pathKeyOf(file, !seq)];
    if (hit) return hit;
    return null;
  }

  function checkMappings(list) {
    if (!list || list.length === undefined) fail("bad_args", "mappings must be an array");
    if (list.length > MAX_MAP) fail("bad_args", "At most " + MAX_MAP + " mappings per call");
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || typeof m.from !== "string" || typeof m.to !== "string") fail("bad_args", "Mapping " + (i + 1) + " needs from and to");
      if (m.role !== "main" && m.role !== "proxy") fail("bad_args", "Mapping " + (i + 1) + ": role must be main or proxy");
      if (!new File(m.to).exists) fail("not_found", "Collected file does not exist: " + m.to);
    }
  }

  // Points the open project (the collected copy) at the collected files.
  // Everything that can fail is checked first; per-item AE errors are
  // collected, not thrown, so one odd item doesn't stop the rest.
  A.collectRelink = function (args) {
    assertGuard(args.expect);
    var mappings = args.mappings || [];
    checkMappings(mappings);
    var trim = [];
    var reduceTo = args.reduce_to || [];
    var r;
    for (r = 0; r < reduceTo.length; r++) {
      var want = null;
      try { want = app.project.itemByID(reduceTo[r].id); } catch (eR) { want = null; }
      if (!want || !(want instanceof CompItem) || String(want.name) !== String(reduceTo[r].name)) {
        fail("not_found", "The copy has no comp " + reduceTo[r].id + " named \"" + reduceTo[r].name + "\"");
      }
      trim.push(want);
    }
    var mains = mappingTable(mappings, "main");
    var proxies = mappingTable(mappings, "proxy");

    return A.withUndo(args.label || "Relink collected footage", function () {
      var relinked = 0;
      var proxiesRelinked = 0;
      var errors = [];
      // What each relinked item should read back as: the verify step compares.
      var items = [];
      var itemsTruncated = false;
      // Items per layered file, to tell an imported-as-comp PSD from a flat one.
      var perFile = {};
      var n;
      for (n = 1; n <= app.project.numItems; n++) {
        var cnt = app.project.item(n);
        if (!(cnt instanceof FootageItem)) continue;
        var cf = itemFile(cnt);
        if (cf && LAYERED_EXT[extOf(cf)] === 1) {
          var ck = normPath(cf);
          if (perFile[ck] === undefined) perFile[ck] = 0;
          perFile[ck]++;
        }
      }
      for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        var isFootage = it instanceof FootageItem;
        // A comp can have a proxy too: only its proxy is looked at.
        if (!isFootage && !(it instanceof CompItem)) continue;
        var key = null;
        if (isFootage) key = itemFile(it);
        var oldName = String(it.name);
        var hit = null;
        if (isFootage) hit = findMapping(mains, it, key, it.mainSource);
        var rec = null;
        var wasOnBefore = false;
        try { wasOnBefore = it.useProxy === true; } catch (eW) {}
        if (hit && isLayeredItem(it, key, perFile)) {
          errors.push({ item_id: it.id, name: oldName, role: "layered", message: "layered file (" + baseOf(key) + "): relink by hand, replace() would turn the layer into the merged image" });
          hit = null;
        }
        if (hit) {
          try {
            // false: numeric frame order with placeholders for gaps, as AE's Import dialog does by default.
            if (hit.sequence === true) it.replaceWithSequence(new File(hit.to), false);
            else it.replace(new File(hit.to));
            // replace() reads the name from the new file: put the old one back.
            if (String(it.name) !== oldName) it.name = oldName;
            relinked++;
            if (items.length < MAX_MAP) {
              rec = { item_id: it.id, name: oldName, to: hit.to, sequence: hit.sequence === true, proxy_to: null, proxy_sequence: false, use_proxy: wasOnBefore };
              items.push(rec);
            } else {
              itemsTruncated = true;
            }
          } catch (eRep) {
            errors.push({ item_id: it.id, name: oldName, role: "main", message: String(eRep.message || eRep) });
          }
        }
        var pkey = null;
        try { pkey = fileOf(it.proxySource ? it.proxySource.file : null); } catch (eK) {}
        var phit = null;
        var psrc = null;
        try { psrc = it.proxySource; } catch (eS) {}
        if (pkey) phit = findMapping(proxies, it, pkey, psrc);
        if (phit) {
          try {
            // setProxy switches the proxy on: put the old setting back.
            var wasOn = wasOnBefore;
            if (phit.sequence === true) it.setProxyWithSequence(new File(phit.to), false);
            else it.setProxy(new File(phit.to));
            it.useProxy = wasOn;
            proxiesRelinked++;
            if (!rec && items.length < MAX_MAP) {
              rec = { item_id: it.id, name: oldName, to: null, sequence: false, proxy_to: null, proxy_sequence: false, use_proxy: wasOn };
              items.push(rec);
            } else if (!rec) {
              itemsTruncated = true;
            }
            if (rec) {
              rec.proxy_to = phit.to;
              rec.proxy_sequence = phit.sequence === true;
              rec.use_proxy = wasOn;
            }
          } catch (eProxy) {
            errors.push({ item_id: it.id, name: oldName, role: "proxy", message: String(eProxy.message || eProxy) });
          }
        }
      }
      var removedUnused = null;
      if (args.remove_unused === true) {
        try { removedUnused = app.project.removeUnusedFootage(); } catch (eU) {
          errors.push({ item_id: null, name: null, role: "trim", message: "removeUnusedFootage: " + String(eU.message || eU) });
        }
      }
      var reduced = null;
      if (trim.length > 0) {
        try { reduced = app.project.reduceProject(trim); } catch (eRd) {
          errors.push({ item_id: null, name: null, role: "trim", message: "reduceProject: " + String(eRd.message || eRd) });
        }
      }
      return {
        project_path: projectPath(),
        relinked: relinked,
        proxies_relinked: proxiesRelinked,
        removed_unused: removedUnused,
        reduced: reduced,
        errors: errors.slice(0, MAX_LIST),
        errors_total: errors.length,
        items: items,
        items_truncated: itemsTruncated
      };
    });
  };

  // Read-only: which footage items in the open project point at a collected
  // file (matching `to` for a still or movie, the same folder for a sequence).
  A.collectVerify = function (args) {
    var mappings = args.mappings || [];
    var byTo = {};
    var byFolder = {};
    var i;
    for (i = 0; i < mappings.length; i++) {
      var m = mappings[i];
      if (m.role !== "main") continue;
      byTo[normPath(m.to)] = true;
      var d = normPath(m.to).replace(/\/[^\/]*$/, "");
      byFolder[d] = true;
    }
    var checked = 0;
    var pointing = 0;
    var elsewhere = [];
    var elsewhereTotal = 0;
    for (i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (!(it instanceof FootageItem)) continue;
      var f = itemFile(it);
      if (!f) continue;
      checked++;
      var n = normPath(f);
      var ok = byTo[n] === true;
      if (!ok && looksLikeSequence(it.mainSource, f)) ok = byFolder[n.replace(/\/[^\/]*$/, "")] === true;
      if (ok) {
        pointing++;
      } else {
        elsewhereTotal++;
        if (elsewhere.length < MAX_LIST) elsewhere.push({ item_id: it.id, name: String(it.name), file: f });
      }
    }
    // The relinked items, as they read now: name, file, proxy file and proxy switch.
    var wanted = args.items || [];
    var itemChecks = [];
    for (i = 0; i < wanted.length && i < MAX_MAP; i++) {
      var w = wanted[i];
      var row = { item_id: w.item_id, found: false, name: null, file: null, proxy_file: null, use_proxy: null };
      var target = null;
      try { target = app.project.itemByID(w.item_id); } catch (eId) { target = null; }
      if (target && (target instanceof FootageItem || target instanceof CompItem)) {
        row.found = true;
        try { row.name = String(target.name); } catch (eN) {}
        row.file = itemFile(target);
        try { row.proxy_file = fileOf(target.proxySource ? target.proxySource.file : null); } catch (eP) {}
        try { row.use_proxy = target.useProxy === true; } catch (eUse) {}
      }
      itemChecks.push(row);
    }
    return {
      project_path: projectPath(),
      dirty: isDirty(),
      checked: checked,
      pointing_at_collected: pointing,
      elsewhere: elsewhere,
      elsewhere_total: elsewhereTotal,
      elsewhere_truncated: elsewhereTotal > elsewhere.length,
      item_checks: itemChecks
    };
  };
})($.global);
