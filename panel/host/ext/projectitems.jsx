// panel/host/ext/projectitems.jsx
//
// Host functions for the project item tools (ae_create_comp, ae_project_items):
// - projectitemsReadItems (read): summaries of project items by id, and on
//   request the project's (or some comps') expressions that mention comp( or
//   footage( together with the names every comp and footage item carries
// - projectitemsCreateCompPlan (read): what a create/from-footage/duplicate
//   call would make, with every refusal
// - projectitemsCreateComp (guarded write): makes the comps in one undo group
// - projectitemsPlan (read): what a list of project panel operations would do,
//   with every refusal, computed on a copy of the project tree
// - projectitemsApply (guarded write): replays the same plan in one undo group
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Writes check the target guard first, validate everything before the undo
//   group and wrap the change in A.withUndo.
// - Reads change nothing: no selection, no active item, no time.
// - Read-backs run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_STRING = 20000;
  var MAX_SNAPSHOT = 20000;
  var MAX_ORGANIZE = 1000;
  var MAX_EXPR = 500;
  var MAX_PROPS = 50000;
  var MAX_SCAN_COMPS = 300;
  var MAX_NAMES = 2000;

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

  function clip(s, n) {
    var t = "";
    try { t = String(s); } catch (e) { t = ""; }
    if (t.length > n) return t.substring(0, n);
    return t;
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function itemById(id) {
    var it = null;
    try { it = app.project.itemByID(id); } catch (e) { it = null; }
    return it;
  }

  function rootFolder() {
    return app.project.rootFolder;
  }

  function itemKind(it) {
    if (it instanceof FolderItem) return "folder";
    if (it instanceof CompItem) return "comp";
    if (it instanceof FootageItem) return "footage";
    return "other";
  }

  // solid, placeholder, audio, still or footage (video and sequences).
  function footageKind(it) {
    var src = null;
    try { src = it.mainSource; } catch (e0) { src = null; }
    try { if (src instanceof SolidSource) return "solid"; } catch (e1) {}
    try { if (src instanceof PlaceholderSource) return "placeholder"; } catch (e2) {}
    var hasV = true;
    var hasA = false;
    try { if (it.hasVideo === false) hasV = false; } catch (e3) {}
    try { if (it.hasAudio === true) hasA = true; } catch (e4) {}
    if (!hasV && hasA) return "audio";
    try { if (src && src.isStill === true) return "still"; } catch (e5) {}
    return "footage";
  }

  function readLabel(it) {
    try {
      if (typeof it.label === "number") return it.label;
    } catch (e) {}
    return null;
  }

  function readComment(it) {
    try {
      if (typeof it.comment === "string") return clip(it.comment, MAX_STRING);
    } catch (e) {}
    return null;
  }

  function parentIdOf(it) {
    try {
      if (it.parentFolder) return it.parentFolder.id;
    } catch (e) {}
    return null;
  }

  function usedInOf(it) {
    var out = [];
    var u = null;
    try { u = it.usedIn; } catch (e) { return null; }
    if (u === undefined || u === null || typeof u.length !== "number") return null;
    for (var i = 0; i < u.length; i++) {
      try { out.push({ id: u[i].id, name: clip(u[i].name, 255) }); } catch (e2) {}
    }
    return out;
  }

  // ---------- item summaries ----------

  function summarise(it) {
    var kind = itemKind(it);
    var o = { id: it.id, kind: kind, name: clip(it.name, 255), parent_id: parentIdOf(it) };
    o.label = readLabel(it);
    o.comment = readComment(it);
    if (kind === "comp") {
      o.width = it.width;
      o.height = it.height;
      o.pixel_aspect = it.pixelAspect;
      o.fps = it.frameRate;
      o.duration = it.duration;
      try { o.bg_color = [it.bgColor[0], it.bgColor[1], it.bgColor[2]]; } catch (e0) {}
      o.num_layers = it.numLayers;
    } else if (kind === "footage") {
      o.subkind = footageKind(it);
      try { o.width = it.width; o.height = it.height; } catch (e1) {}
      try { o.duration = it.duration; } catch (e2) {}
      try { o.fps = it.frameRate; } catch (e3) {}
    } else if (kind === "folder") {
      try { o.num_items = it.numItems; } catch (e4) {}
    }
    if (kind === "comp" || kind === "footage") {
      var u = usedInOf(it);
      if (u !== null) o.used_in_count = u.length;
    }
    return o;
  }

  // ---------- expression scan ----------

  function walkExpressions(group, path, layer, comp, out, state, depth) {
    var n = 0;
    try { n = group.numProperties; } catch (e0) { return; }
    for (var i = 1; i <= n; i++) {
      if (state.visited >= MAX_PROPS || out.length >= MAX_EXPR) {
        state.truncated = true;
        return;
      }
      var p = null;
      try { p = group.property(i); } catch (e1) { p = null; }
      if (!p) continue;
      state.visited++;
      var pname = "";
      try { pname = String(p.name); } catch (e2) {}
      var here = pname;
      if (path !== "") here = path + " > " + pname;
      var type = null;
      try { type = p.propertyType; } catch (e3) {}
      if (type === PropertyType.PROPERTY) {
        var text = "";
        try {
          if (p.canSetExpression) text = p.expression;
        } catch (e4) { text = ""; }
        if (typeof text === "string" && text.length > 0) {
          var cut = false;
          var fullLength = text.length;
          if (text.length > MAX_STRING) {
            text = text.substring(0, MAX_STRING);
            cut = true;
          }
          if (cut || text.indexOf("comp") !== -1 || text.indexOf("footage") !== -1) {
            var enabled = true;
            try { enabled = p.expressionEnabled === true; } catch (e5) {}
            var item = {
              comp_id: comp.id,
              comp_name: clip(comp.name, 255),
              layer_id: layer.id,
              layer_index: layer.index,
              layer_name: clip(layer.name, 255),
              path: here,
              text: text,
              enabled: enabled
            };
            if (cut) {
              item.text_truncated = true;
              item.text_length = fullLength;
            }
            out.push(item);
          }
        }
      } else if (depth < 12) {
        walkExpressions(p, here, layer, comp, out, state, depth + 1);
      }
    }
  }

  function scanComp(comp, out, state) {
    var n = 0;
    try { n = comp.numLayers; } catch (e) { return; }
    if (n > MAX_LIST) {
      n = MAX_LIST;
      state.truncated = true;
    }
    for (var i = 1; i <= n; i++) {
      if (state.truncated && (out.length >= MAX_EXPR || state.visited >= MAX_PROPS)) return;
      var l = null;
      try { l = comp.layer(i); } catch (e1) { l = null; }
      if (l) walkExpressions(l, "", l, comp, out, state, 0);
    }
  }

  // ---------- A.projectitemsReadItems ----------

  A.projectitemsReadItems = function (args) {
    args = args || {};
    var ids = args.ids;
    var out = { items: [], count: 0, truncated: false };
    var i;
    try { out.root_id = rootFolder().id; } catch (eRoot) {}
    try { out.num_items = app.project.numItems; } catch (eNum) {}
    if (ids && typeof ids.length === "number") {
      var seen = {};
      for (i = 0; i < ids.length; i++) {
        if (!isNum(ids[i]) || seen[ids[i]]) continue;
        if (out.items.length >= MAX_LIST) {
          out.truncated = true;
          break;
        }
        seen[ids[i]] = true;
        var it = null;
        if (out.root_id !== undefined && ids[i] === out.root_id) it = rootFolder();
        else it = itemById(ids[i]);
        if (it) {
          var rec = summarise(it);
          if (out.root_id !== undefined && it.id === out.root_id) rec.is_root = true;
          out.items.push(rec);
        } else {
          out.items.push({ id: ids[i], missing: true });
        }
      }
    }
    out.count = out.items.length;
    if (args.scan_expressions === true) {
      var exprs = [];
      var state = { visited: 0, truncated: false };
      var comps = [];
      var compNames = [];
      var footageNames = [];
      var n = app.project.numItems;
      var namesTruncated = false;
      var only = null;
      if (args.expression_comp_ids && typeof args.expression_comp_ids.length === "number") {
        only = {};
        for (i = 0; i < args.expression_comp_ids.length; i++) only[args.expression_comp_ids[i]] = true;
      }
      for (i = 1; i <= n; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem) {
          if (compNames.length < MAX_NAMES) compNames.push(clip(item.name, 255));
          else namesTruncated = true;
          if (only === null || only[item.id] === true) comps.push(item);
        } else if (item instanceof FootageItem) {
          if (footageNames.length < MAX_NAMES) footageNames.push(clip(item.name, 255));
          else namesTruncated = true;
        }
      }
      var scanned = 0;
      for (i = 0; i < comps.length; i++) {
        if (scanned >= MAX_SCAN_COMPS) {
          state.truncated = true;
          break;
        }
        scanned++;
        scanComp(comps[i], exprs, state);
        if (state.truncated && exprs.length >= MAX_EXPR) break;
      }
      out.expressions = exprs;
      out.expressions_truncated = state.truncated;
      out.comps_scanned = scanned;
      out.item_names = { comp: compNames, footage: footageNames, truncated: namesTruncated };
    }
    return out;
  };

  // ---------- name helpers ----------

  function takenNames() {
    var taken = {};
    var n = app.project.numItems;
    for (var i = 1; i <= n; i++) taken["k:" + app.project.item(i).name] = true;
    return taken;
  }

  function uniqueName(taken, base) {
    if (!taken["k:" + base]) {
      taken["k:" + base] = true;
      return base;
    }
    for (var n = 2; n < 10000; n++) {
      var c = base + " " + n;
      if (!taken["k:" + c]) {
        taken["k:" + c] = true;
        return c;
      }
    }
    return base;
  }

  function stripExtension(name) {
    var m = /^(.+)\.[A-Za-z0-9]{2,5}$/.exec(name);
    if (m) return m[1];
    return name;
  }

  // ---------- ae_create_comp ----------

  function checkSettings(P, s) {
    if (!isNum(s.width) || s.width !== Math.floor(s.width) || s.width < 4 || s.width > 30000) P.refusals.push("width must be an integer in 4..30000 (got " + s.width + ")");
    if (!isNum(s.height) || s.height !== Math.floor(s.height) || s.height < 4 || s.height > 30000) P.refusals.push("height must be an integer in 4..30000 (got " + s.height + ")");
    if (!isNum(s.pixel_aspect) || s.pixel_aspect < 0.01 || s.pixel_aspect > 100) P.refusals.push("pixel_aspect must be in 0.01..100 (got " + s.pixel_aspect + ")");
    if (!isNum(s.fps) || s.fps < 1 || s.fps > 99) P.refusals.push("fps must be in 1..99 (got " + s.fps + ")");
    if (!isNum(s.duration) || s.duration <= 0 || s.duration > 10800) P.refusals.push("duration must be above 0 and at most 10800 seconds (got " + s.duration + ")");
    if (s.bg_color !== undefined && s.bg_color !== null) {
      var okc = typeof s.bg_color.length === "number" && s.bg_color.length === 3;
      if (okc) {
        for (var i = 0; i < 3; i++) {
          if (!isNum(s.bg_color[i]) || s.bg_color[i] < 0 || s.bg_color[i] > 1) okc = false;
        }
      }
      if (!okc) P.refusals.push("bg_color must be [r, g, b] with values in 0..1");
    }
  }

  // The comps a deep copy needs: the comp and every comp nested in it, once each.
  function collectTree(root, max, P) {
    var order = [];
    var seen = {};
    function visit(c) {
      if (seen[c.id] || order.length > max) return;
      seen[c.id] = true;
      order.push(c);
      var n = c.numLayers;
      for (var i = 1; i <= n; i++) {
        var l = c.layer(i);
        var src = null;
        try { src = l.source; } catch (e) { src = null; }
        if (src && src instanceof CompItem) visit(src);
      }
    }
    visit(root);
    if (order.length > max) {
      P.refusals.push("The comp nests more than " + max + " comps; raise max_comps (up to 500) or copy a smaller branch");
    }
    return order;
  }

  function relinksOf(c, P) {
    var out = [];
    var n = c.numLayers;
    for (var i = 1; i <= n; i++) {
      var l = c.layer(i);
      var src = null;
      try { src = l.source; } catch (e) { src = null; }
      if (src && src instanceof CompItem) {
        var locked = false;
        try { locked = l.locked === true; } catch (eL) {}
        if (locked) P.refusals.push("Layer " + i + " \"" + clip(l.name, 255) + "\" in \"" + clip(c.name, 255) + "\" is locked, so its source can't be swapped for the copy; unlock it first");
        out.push({ layer_index: i, layer_name: clip(l.name, 255), source_id: src.id });
      }
    }
    return out;
  }

  function planCreate(args) {
    var P = { mode: args.mode, refusals: [], warnings: [], entries: [], add_layer: false };
    var mode = args.mode;
    var folderOverride = null;
    var taken = takenNames();
    if (args.target_folder_id !== undefined && args.target_folder_id !== null) {
      var tf = null;
      if (args.target_folder_id === rootFolder().id) tf = rootFolder();
      else tf = itemById(args.target_folder_id);
      if (!tf || !(tf instanceof FolderItem)) P.refusals.push("target_folder_id " + args.target_folder_id + " is not a folder in this project");
      else folderOverride = tf;
    }
    var unique = args.unique_name === true;
    var s;
    if (mode === "new") {
      var name = args.name;
      if (typeof name !== "string" || name.length === 0) {
        name = "Comp";
        unique = true;
      }
      if (name.length > 255) P.refusals.push("name is longer than 255 characters");
      s = { width: args.width, height: args.height, pixel_aspect: args.pixel_aspect, fps: args.fps, duration: args.duration, bg_color: args.bg_color };
      if (s.pixel_aspect === undefined || s.pixel_aspect === null) s.pixel_aspect = 1;
      if ((s.duration === undefined || s.duration === null) && isNum(args.duration_frames) && isNum(s.fps) && s.fps > 0) {
        s.duration = args.duration_frames / s.fps;
      }
      checkSettings(P, s);
      if (unique) name = uniqueName(taken, name);
      P.entries.push({ role: "new", name: name, settings: s, folder: folderOverride });
    } else if (mode === "from_footage") {
      var item = null;
      if (isNum(args.item_id)) item = itemById(args.item_id);
      if (!item || !(item instanceof FootageItem)) {
        P.refusals.push("item_id " + args.item_id + " is not a footage item");
      } else {
        var hasVideo = true;
        try { if (item.hasVideo === false) hasVideo = false; } catch (eHv) {}
        var w = item.width;
        var h = item.height;
        if (args.width !== undefined && args.width !== null) w = args.width;
        if (args.height !== undefined && args.height !== null) h = args.height;
        if (!hasVideo && !(isNum(args.width) && isNum(args.height))) {
          P.refusals.push("\"" + clip(item.name, 255) + "\" has no video; give width and height to make a comp from audio");
        }
        var par = 1;
        try { if (isNum(item.pixelAspect) && item.pixelAspect > 0) par = item.pixelAspect; } catch (ePar) {}
        if (args.pixel_aspect !== undefined && args.pixel_aspect !== null) par = args.pixel_aspect;
        var fps = 0;
        try { if (isNum(item.frameRate)) fps = item.frameRate; } catch (eFps) {}
        if (args.fps !== undefined && args.fps !== null) fps = args.fps;
        if (!(fps > 0)) P.refusals.push("\"" + clip(item.name, 255) + "\" has no frame rate (a still); give fps");
        var dur = 0;
        try { if (isNum(item.duration)) dur = item.duration; } catch (eDur) {}
        if (args.duration !== undefined && args.duration !== null) dur = args.duration;
        else if (isNum(args.duration_frames) && fps > 0) dur = args.duration_frames / fps;
        if (!(dur > 0)) P.refusals.push("\"" + clip(item.name, 255) + "\" is a still or has no length; give duration (seconds) or duration_frames");
        s = { width: w, height: h, pixel_aspect: par, fps: fps, duration: dur, bg_color: args.bg_color };
        checkSettings(P, s);
        var nm = args.name;
        if (typeof nm !== "string" || nm.length === 0) {
          nm = stripExtension(clip(item.name, 255));
          unique = true;
        }
        if (unique) nm = uniqueName(taken, nm);
        P.add_layer = args.add_layer !== false;
        P.entries.push({ role: "from_footage", name: nm, settings: s, folder: folderOverride, source: item });
      }
    } else if (mode === "duplicate") {
      var src = null;
      if (isNum(args.comp_id)) src = itemById(args.comp_id);
      if (!src || !(src instanceof CompItem)) {
        P.refusals.push("comp_id " + args.comp_id + " is not a composition");
      } else {
        var deep = args.deep === true;
        var suffix = " copy";
        if (typeof args.name_suffix === "string") suffix = args.name_suffix;
        var order = [src];
        if (deep) {
          var max = 50;
          if (isNum(args.max_comps)) max = args.max_comps;
          order = collectTree(src, max, P);
        }
        P.deep = deep;
        for (var i = 0; i < order.length; i++) {
          var c = order[i];
          var nn = null;
          if (i === 0 && typeof args.name === "string" && args.name.length > 0) {
            nn = args.name;
          } else if (typeof args.name_suffix === "string" || deep) {
            nn = clip(c.name, 255) + suffix;
          }
          if (nn !== null && nn.length > 255) P.refusals.push("a copy's name would be longer than 255 characters");
          if (nn !== null && (deep || unique)) nn = uniqueName(taken, nn);
          var folder = folderOverride;
          if (!folder) {
            try { folder = c.parentFolder; } catch (eP) { folder = null; }
          }
          var entry = { role: "root", name: nn, folder: folder, source: c, relinks: [] };
          if (i > 0) entry.role = "nested";
          if (deep) entry.relinks = relinksOf(c, P);
          P.entries.push(entry);
        }
      }
    } else {
      P.refusals.push("Unknown mode \"" + mode + "\"");
    }
    return P;
  }

  function trimPlan(P) {
    var out = {
      mode: P.mode,
      refusals: P.refusals,
      warnings: P.warnings,
      would_create: [],
      add_layer: P.add_layer,
      deep: P.deep === true
    };
    for (var i = 0; i < P.entries.length && i < MAX_LIST; i++) {
      var e = P.entries[i];
      var o = { role: e.role, name: e.name };
      if (e.settings) o.settings = e.settings;
      if (e.source) {
        o.source_id = e.source.id;
        o.source_name = clip(e.source.name, 255);
      }
      if (e.folder) o.folder_id = e.folder.id;
      if (e.relinks) o.layers_to_relink = e.relinks.length;
      out.would_create.push(o);
    }
    out.would_create_total = P.entries.length;
    return out;
  }

  A.projectitemsCreateCompPlan = function (args) {
    var P = planCreate(args || {});
    var out = trimPlan(P);
    if (P.deep === true && P.refusals.length === 0) {
      // The expressions of the comps a deep copy would copy, for the server's comp("Name") scan.
      var exprs = [];
      var state = { visited: 0, truncated: false };
      for (var i = 0; i < P.entries.length; i++) scanComp(P.entries[i].source, exprs, state);
      out.expressions = exprs;
      out.expressions_truncated = state.truncated;
    }
    return out;
  };

  A.projectitemsCreateComp = function (args) {
    assertGuard(args.expect);
    var P = planCreate(args);
    if (P.refusals.length > 0) {
      fail("bad_args", "Refused: " + P.refusals.join("; "));
    }
    var label = args.label || "Create comp";
    return A.withUndo(label, function () {
      var created = [];
      var copies = {};
      var made = [];
      var i;
      var relinked = 0;
      var layerAdded = false;
      try {
        var e;
        var c;
        if (P.mode === "duplicate") {
          for (i = 0; i < P.entries.length; i++) {
            e = P.entries[i];
            c = e.source.duplicate();
            made.push(c);
            copies[e.source.id] = c;
          }
          for (i = 0; i < P.entries.length; i++) {
            e = P.entries[i];
            c = copies[e.source.id];
            if (e.name !== null) c.name = e.name;
            if (e.folder) c.parentFolder = e.folder;
          }
          for (i = 0; i < P.entries.length; i++) {
            e = P.entries[i];
            c = copies[e.source.id];
            for (var r = 0; r < e.relinks.length; r++) {
              var rl = e.relinks[r];
              var layer = c.layer(rl.layer_index);
              var keep = layer.name;
              layer.replaceSource(copies[rl.source_id], false);
              layer = c.layer(rl.layer_index);
              // The layer tracked its source's name; keep the name so layer("Name") expressions still find it.
              if (layer.name !== keep) layer.name = keep;
              relinked++;
            }
          }
          for (i = 0; i < P.entries.length; i++) {
            c = copies[P.entries[i].source.id];
            created.push({ id: c.id, name: c.name, source_id: P.entries[i].source.id, source_name: clip(P.entries[i].source.name, 255), role: P.entries[i].role });
          }
        } else {
          e = P.entries[0];
          var s = e.settings;
          c = app.project.items.addComp(e.name, s.width, s.height, s.pixel_aspect, s.duration, s.fps);
          made.push(c);
          if (s.bg_color !== undefined && s.bg_color !== null) c.bgColor = [s.bg_color[0], s.bg_color[1], s.bg_color[2]];
          if (e.folder) c.parentFolder = e.folder;
          if (P.mode === "from_footage" && P.add_layer) {
            c.layers.add(e.source);
            layerAdded = true;
          }
          var rec = { id: c.id, name: c.name, role: e.role };
          if (e.source) {
            rec.source_id = e.source.id;
            rec.source_name = clip(e.source.name, 255);
          }
          created.push(rec);
        }
      } catch (err) {
        // Take back what was made, in this same undo group, so a failed call leaves nothing half-built.
        for (var k = made.length - 1; k >= 0; k--) {
          try { made[k].remove(); } catch (eRm) {}
        }
        throw err;
      }
      return {
        mode: P.mode,
        deep: P.deep === true,
        created: created,
        created_ids: (function () {
          var ids = [];
          for (var z = 0; z < created.length; z++) ids.push(created[z].id);
          return ids;
        })(),
        layers_relinked: relinked,
        layer_added: layerAdded,
        warnings: P.warnings
      };
    });
  };

  // ---------- ae_project_items: the model ----------

  function newRec(it) {
    var kind = itemKind(it);
    var r = {
      id: it.id,
      obj: it,
      kind: kind,
      name: clip(it.name, 255),
      parent_id: parentIdOf(it),
      label: readLabel(it),
      comment: readComment(it),
      deleted: false,
      virtual: false,
      isRoot: false,
      used: undefined
    };
    if (kind === "footage") r.subkind = footageKind(it);
    return r;
  }

  function addKid(s, parentId, id) {
    if (!s.kids[parentId]) s.kids[parentId] = [];
    s.kids[parentId].push(id);
  }

  function dropKid(s, parentId, id) {
    var list = s.kids[parentId];
    if (!list) return;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] !== id) out.push(list[i]);
    }
    s.kids[parentId] = out;
  }

  function snapshot() {
    var s = { byId: {}, kids: {}, rootId: rootFolder().id, truncated: false, nextVirtual: -1, hasLabel: false, hasComment: false };
    var root = rootFolder();
    var rr = { id: root.id, obj: root, kind: "folder", name: "(project root)", parent_id: null, label: null, comment: null, deleted: false, virtual: false, isRoot: true };
    s.byId[root.id] = rr;
    var n = app.project.numItems;
    if (n > MAX_SNAPSHOT) {
      n = MAX_SNAPSHOT;
      s.truncated = true;
    }
    for (var i = 1; i <= n; i++) {
      var it = app.project.item(i);
      var r = newRec(it);
      if (r.label !== null) s.hasLabel = true;
      if (r.comment !== null) s.hasComment = true;
      s.byId[r.id] = r;
      if (r.parent_id !== null) addKid(s, r.parent_id, r.id);
    }
    if (n === 0) {
      // No items to probe: the root folder can't tell either.
      s.hasLabel = true;
      s.hasComment = true;
    }
    return s;
  }

  function isInside(s, folderId, ancestorId) {
    // True when folderId is ancestorId or sits below it.
    var cur = folderId;
    var guard = 0;
    while (cur !== null && cur !== undefined && guard < 10000) {
      if (cur === ancestorId) return true;
      var r = s.byId[cur];
      if (!r) return false;
      cur = r.parent_id;
      guard++;
    }
    return false;
  }

  function usedList(rec) {
    if (rec.used === undefined) {
      if (rec.kind === "folder" || rec.virtual) rec.used = [];
      else rec.used = usedInOf(rec.obj);
    }
    return rec.used;
  }

  function kidsOf(s, id) {
    var list = s.kids[id];
    if (!list) return [];
    return list;
  }

  function addVirtualFolder(s, name, parentId) {
    var id = s.nextVirtual;
    s.nextVirtual--;
    var r = { id: id, obj: null, kind: "folder", name: name, parent_id: parentId, label: 0, comment: "", deleted: false, virtual: true, isRoot: false };
    s.byId[id] = r;
    addKid(s, parentId, id);
    return r;
  }

  function folderChildByName(s, parentId, name) {
    var kids = kidsOf(s, parentId);
    var found = [];
    for (var i = 0; i < kids.length; i++) {
      var r = s.byId[kids[i]];
      if (r && !r.deleted && r.kind === "folder" && r.name === name) found.push(r);
    }
    return found;
  }

  function describeRec(r) {
    return "\"" + r.name + "\" (id " + r.id + ")";
  }

  function refuse(P, msg) {
    P.refusals.push({ op: P.opIndex, action: P.opAction, message: msg });
  }

  function skip(P, msg) {
    P.skipped.push({ op: P.opIndex, action: P.opAction, message: msg });
  }

  function need(P, id) {
    var r = null;
    if (isNum(id)) r = P.s.byId[id];
    if (!r || r.deleted) {
      refuse(P, "No item with id " + id + " in the project");
      return null;
    }
    return r;
  }

  // A target (the item an op acts on): a folder this call only plans to create has no real item yet.
  function needItem(P, id) {
    var r = need(P, id);
    if (r && r.virtual) {
      refuse(P, "item " + id + " is a folder this call creates; act on it in a later call");
      return null;
    }
    return r;
  }

  function validName(P, name, what) {
    if (typeof name !== "string" || name.length === 0) {
      refuse(P, what + " must be a non-empty string");
      return false;
    }
    if (name.length > 255) {
      refuse(P, what + " is longer than 255 characters");
      return false;
    }
    return true;
  }

  function uniqueIds(list) {
    var out = [];
    var seen = {};
    if (!list || typeof list.length !== "number") return out;
    for (var i = 0; i < list.length; i++) {
      if (!isNum(list[i]) || seen[list[i]]) continue;
      seen[list[i]] = true;
      out.push(list[i]);
    }
    return out;
  }

  function folderTarget(P, op) {
    // The destination folder of a move: folder_id, a folder_path under the root (made when missing), or the root.
    var s = P.s;
    if (op.folder_id !== undefined && op.folder_id !== null) {
      var f = need(P, op.folder_id);
      if (!f) return null;
      if (f.kind !== "folder") {
        refuse(P, describeRec(f) + " is not a folder");
        return null;
      }
      return f;
    }
    if (typeof op.folder_path === "string" && op.folder_path.length > 0) {
      var parts = op.folder_path.split("/");
      var cur = s.byId[s.rootId];
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].length === 0) continue;
        var hits = folderChildByName(s, cur.id, parts[i]);
        if (hits.length > 1) {
          refuse(P, hits.length + " folders named \"" + parts[i] + "\" sit in " + describeRec(cur) + "; use folder_id");
          return null;
        }
        if (hits.length === 1) {
          cur = hits[0];
        } else {
          if (parts[i].length > 255) {
            refuse(P, "A folder name in folder_path is longer than 255 characters");
            return null;
          }
          var v = addVirtualFolder(s, parts[i], cur.id);
          P.actions.push({ type: "create_folder", id: v.id, name: v.name, parent_id: cur.id, op: P.opIndex });
          cur = v;
        }
      }
      return cur;
    }
    return s.byId[s.rootId];
  }

  function planMove(P, op) {
    var s = P.s;
    var target = folderTarget(P, op);
    if (!target) return;
    var ids = uniqueIds(op.item_ids);
    if (ids.length === 0) {
      refuse(P, "move needs item_ids");
      return;
    }
    var moving = [];
    for (var i = 0; i < ids.length; i++) {
      var r = needItem(P, ids[i]);
      if (!r) continue;
      if (r.isRoot) {
        refuse(P, "The project root can't be moved");
        continue;
      }
      if (r.id === target.id) {
        refuse(P, "Can't move " + describeRec(r) + " into itself");
        continue;
      }
      if (r.kind === "folder" && isInside(s, target.id, r.id)) {
        refuse(P, "Can't move folder " + describeRec(r) + " into " + describeRec(target) + ": that is inside it");
        continue;
      }
      if (r.parent_id === target.id) {
        skip(P, describeRec(r) + " is already in " + describeRec(target));
        continue;
      }
      moving.push(r);
    }
    if (moving.length === 0) return;
    var moved = [];
    for (var j = 0; j < moving.length; j++) {
      var m = moving[j];
      dropKid(s, m.parent_id, m.id);
      m.parent_id = target.id;
      addKid(s, target.id, m.id);
      moved.push(m.id);
    }
    P.actions.push({ type: "move", ids: moved, folder_id: target.id, op: P.opIndex });
  }

  function planRename(P, op) {
    var s = P.s;
    var refBefore = P.refusals.length;
    var pairs = [];
    var r;
    var i;
    if (isNum(op.item_id) && typeof op.name === "string") {
      r = needItem(P, op.item_id);
      if (!r) return;
      if (r.isRoot) {
        refuse(P, "The project root can't be renamed");
        return;
      }
      if (!validName(P, op.name, "name")) return;
      if (op.name === r.name) {
        skip(P, describeRec(r) + " already has that name");
        return;
      }
      pairs.push({ rec: r, to: op.name });
    } else {
      var ids = uniqueIds(op.item_ids);
      if (ids.length === 0 || typeof op.find !== "string" || op.find.length === 0 || typeof op.replace !== "string") {
        refuse(P, "rename needs item_id and name, or item_ids, find and replace");
        return;
      }
      var re = null;
      if (op.regex === true) {
        try {
          re = new RegExp(op.find, "g");
        } catch (eRe) {
          refuse(P, "find is not a valid regular expression: " + eRe.message);
          return;
        }
      }
      for (i = 0; i < ids.length; i++) {
        r = needItem(P, ids[i]);
        if (!r) continue;
        if (r.isRoot) {
          refuse(P, "The project root can't be renamed");
          continue;
        }
        var to = r.name;
        if (re !== null) {
          re.lastIndex = 0;
          to = r.name.replace(re, op.replace);
        } else {
          to = r.name.split(op.find).join(op.replace);
        }
        if (to === r.name) continue;
        if (!validName(P, to, "the new name of " + describeRec(r))) continue;
        pairs.push({ rec: r, to: to });
      }
      if (pairs.length === 0 && P.refusals.length === refBefore) {
        skip(P, "No selected item's name contains the text to replace");
        return;
      }
    }
    for (i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      P.actions.push({ type: "rename", id: p.rec.id, from: p.rec.name, to: p.to, kind: p.rec.kind, op: P.opIndex });
      if (p.rec.kind === "comp" || p.rec.kind === "footage") P.renames.push({ id: p.rec.id, kind: p.rec.kind, from: p.rec.name, to: p.to });
      p.rec.name = p.to;
    }
    void s;
  }

  function planLabel(P, op) {
    var refBefore = P.refusals.length;
    var ids = uniqueIds(op.item_ids);
    if (ids.length === 0) {
      refuse(P, "label needs item_ids");
      return;
    }
    if (!isNum(op.label) || op.label !== Math.floor(op.label) || op.label < 0 || op.label > 16) {
      refuse(P, "label must be an integer in 0..16");
      return;
    }
    if (!P.s.hasLabel) {
      refuse(P, "This AE has no Item.label, so labels can't be set");
      return;
    }
    var changed = [];
    for (var i = 0; i < ids.length; i++) {
      var r = needItem(P, ids[i]);
      if (!r) continue;
      if (r.isRoot) {
        refuse(P, "The project root has no label");
        continue;
      }
      if (r.label === op.label) continue;
      r.label = op.label;
      changed.push(r.id);
    }
    if (changed.length === 0) {
      if (P.refusals.length === refBefore) skip(P, "Every selected item already has label " + op.label);
      return;
    }
    P.actions.push({ type: "label", ids: changed, label: op.label, op: P.opIndex });
  }

  function planComment(P, op) {
    var refBefore = P.refusals.length;
    var ids = uniqueIds(op.item_ids);
    if (ids.length === 0) {
      refuse(P, "comment needs item_ids");
      return;
    }
    if (typeof op.text !== "string" || op.text.length > MAX_STRING) {
      refuse(P, "text must be a string of at most 20000 characters");
      return;
    }
    if (!P.s.hasComment) {
      refuse(P, "This AE has no Item.comment, so comments can't be set");
      return;
    }
    var changed = [];
    for (var i = 0; i < ids.length; i++) {
      var r = needItem(P, ids[i]);
      if (!r) continue;
      if (r.isRoot) {
        refuse(P, "The project root has no comment");
        continue;
      }
      if (r.comment === op.text) continue;
      r.comment = op.text;
      changed.push(r.id);
    }
    if (changed.length === 0) {
      if (P.refusals.length === refBefore) skip(P, "Every selected item already has that comment");
      return;
    }
    P.actions.push({ type: "comment", ids: changed, text: op.text, op: P.opIndex });
  }

  function gatherClosure(s, rec, out) {
    out.push(rec);
    if (rec.kind === "folder") {
      var kids = kidsOf(s, rec.id);
      for (var i = 0; i < kids.length; i++) {
        var k = s.byId[kids[i]];
        if (k && !k.deleted) gatherClosure(s, k, out);
      }
    }
  }

  function renderQueueUses() {
    // comp id -> [{rq_index, status}] for the queue items a deleted comp would take with it.
    var out = {};
    try {
      var rq = app.project.renderQueue;
      var n = rq.numItems;
      for (var j = 1; j <= n; j++) {
        var qi = rq.item(j);
        var cid = qi.comp.id;
        var st = null;
        try { st = String(qi.status); } catch (eSt) {}
        if (!out[cid]) out[cid] = [];
        out[cid].push({ rq_index: j, status: st });
      }
    } catch (e) {}
    return out;
  }

  function markDeleted(s, rec) {
    rec.deleted = true;
    if (rec.parent_id !== null) dropKid(s, rec.parent_id, rec.id);
  }

  function planDelete(P, op) {
    var s = P.s;
    var ids = uniqueIds(op.item_ids);
    if (ids.length === 0) {
      refuse(P, "delete needs item_ids");
      return;
    }
    var force = op.force === true;
    var targets = [];
    var inTargets = {};
    var i;
    for (i = 0; i < ids.length; i++) {
      var r = needItem(P, ids[i]);
      if (!r) continue;
      if (r.isRoot) {
        refuse(P, "The project root can't be deleted");
        continue;
      }
      targets.push(r);
      inTargets[r.id] = true;
    }
    // A target inside another target goes with it.
    var top = [];
    for (i = 0; i < targets.length; i++) {
      var t = targets[i];
      var nested = false;
      var cur = t.parent_id;
      var guard = 0;
      while (cur !== null && cur !== undefined && guard < 10000) {
        if (inTargets[cur]) {
          nested = true;
          break;
        }
        var pr = s.byId[cur];
        if (!pr) break;
        cur = pr.parent_id;
        guard++;
      }
      if (!nested) top.push(t);
    }
    var closure = [];
    var inClosure = {};
    for (i = 0; i < top.length; i++) {
      var tr = top[i];
      if (tr.kind === "folder" && kidsOf(s, tr.id).length > 0) {
        if (!force) {
          refuse(P, "Folder " + describeRec(tr) + " holds " + kidsOf(s, tr.id).length + " item(s); pass force: true to delete it with its contents");
          closure.push(tr);
          inClosure[tr.id] = true;
          continue;
        }
        var part = [];
        gatherClosure(s, tr, part);
        for (var q = 0; q < part.length; q++) {
          closure.push(part[q]);
          inClosure[part[q].id] = true;
        }
      } else {
        closure.push(tr);
        inClosure[tr.id] = true;
      }
    }
    var rqUses = renderQueueUses();
    for (i = 0; i < closure.length; i++) {
      var c = closure[i];
      if (c.kind !== "comp" && c.kind !== "footage") continue;
      var used = usedList(c);
      if (used === null) {
        refuse(P, "Can't tell whether " + describeRec(c) + " is used in a comp (usedIn is unreadable), so it is not deleted");
        continue;
      }
      var outside = [];
      for (var u = 0; u < used.length; u++) {
        if (!inClosure[used[u].id]) outside.push(used[u]);
      }
      if (outside.length > 0) {
        var names = [];
        for (var w = 0; w < outside.length && w < 10; w++) names.push("\"" + outside[w].name + "\"");
        refuse(P, describeRec(c) + " is used in " + outside.length + " comp(s) (" + names.join(", ") + "); deleting it would remove those layers. Remove the layers or replace the source first");
        P.used.push({ id: c.id, name: c.name, used_in: outside.slice(0, 20) });
      }
      if (c.kind === "comp" && rqUses[c.id]) {
        for (var x = 0; x < rqUses[c.id].length; x++) {
          P.rqRemoved.push({ rq_index: rqUses[c.id][x].rq_index, status: rqUses[c.id][x].status, comp_id: c.id, comp_name: c.name });
        }
      }
    }
    for (i = 0; i < top.length; i++) {
      var d = top[i];
      var group = [];
      if (inClosure[d.id] && d.kind === "folder" && kidsOf(s, d.id).length > 0 && force) gatherClosure(s, d, group);
      else group.push(d);
      var containedIds = [];
      for (var gi = 1; gi < group.length && containedIds.length < MAX_LIST; gi++) containedIds.push(group[gi].id);
      P.actions.push({ type: "delete", id: d.id, name: d.name, kind: d.kind, contained: group.length - 1, contained_ids: containedIds, op: P.opIndex });
      for (var g = 0; g < group.length; g++) markDeleted(s, group[g]);
    }
  }

  function classify(P, r) {
    if (r.kind === "comp") {
      var used = usedList(r);
      if (used !== null && used.length > 0) return "precomps";
      return "comps";
    }
    if (r.kind === "footage") {
      if (r.subkind === "solid") return "solids";
      if (r.subkind === "still") return "stills";
      if (r.subkind === "audio") return "audio";
      return "footage";
    }
    return null;
  }

  function planOrganize(P, op) {
    var s = P.s;
    if (s.truncated) {
      refuse(P, "The project has more than " + MAX_SNAPSHOT + " items; organize can't see all of them");
      return;
    }
    var defaults = { comps: "Comps", precomps: "Precomps", footage: "Footage", stills: "Stills", audio: "Audio", solids: "Solids" };
    var bins = {};
    var key;
    for (key in defaults) {
      if (defaults.hasOwnProperty(key)) bins[key] = defaults[key];
    }
    if (op.bins) {
      for (key in defaults) {
        if (defaults.hasOwnProperty(key) && typeof op.bins[key] === "string") bins[key] = op.bins[key];
      }
    }
    var parent = s.byId[s.rootId];
    if (isNum(op.parent_id)) {
      parent = need(P, op.parent_id);
      if (!parent) return;
      if (parent.kind !== "folder") {
        refuse(P, describeRec(parent) + " is not a folder");
        return;
      }
    }
    var onlyLoose = op.skip_items_already_in_folders !== false;
    var buckets = {};
    var order = [];
    var total = 0;
    var ids = [];
    var id;
    for (id in s.byId) {
      if (s.byId.hasOwnProperty(id)) ids.push(Number(id));
    }
    ids.sort(function (a, b) { return a - b; });
    var i;
    for (i = 0; i < ids.length; i++) {
      var r = s.byId[ids[i]];
      if (r.deleted || r.isRoot || r.kind === "folder" || r.kind === "other") continue;
      if (onlyLoose) {
        if (r.parent_id !== parent.id) continue;
      } else if (parent.id !== s.rootId && !isInside(s, r.parent_id, parent.id)) {
        continue;
      }
      var bucket = classify(P, r);
      if (bucket === null) continue;
      var binName = bins[bucket];
      if (typeof binName !== "string" || binName.length === 0) continue;
      if (binName.length > 255) {
        refuse(P, "A bin name is longer than 255 characters");
        return;
      }
      if (!buckets[bucket]) {
        buckets[bucket] = [];
        order.push(bucket);
      }
      buckets[bucket].push(r);
      total++;
    }
    if (total === 0) {
      skip(P, "Nothing to organize: no loose items of the kinds with a bin");
      return;
    }
    if (total > MAX_ORGANIZE) {
      refuse(P, "organize would move " + total + " items; the limit is " + MAX_ORGANIZE + " per call. Move some by hand with the move action first");
      return;
    }
    for (i = 0; i < order.length; i++) {
      var bk = order[i];
      var name = bins[bk];
      var hits = folderChildByName(s, parent.id, name);
      var bin = null;
      if (hits.length > 1) {
        refuse(P, hits.length + " folders named \"" + name + "\" sit in " + describeRec(parent) + "; rename one or pass other bin names");
        continue;
      }
      if (hits.length === 1) {
        bin = hits[0];
      } else {
        bin = addVirtualFolder(s, name, parent.id);
        P.actions.push({ type: "create_folder", id: bin.id, name: bin.name, parent_id: parent.id, op: P.opIndex });
      }
      var moved = [];
      for (var j = 0; j < buckets[bk].length; j++) {
        var m = buckets[bk][j];
        if (m.parent_id === bin.id) continue;
        dropKid(s, m.parent_id, m.id);
        m.parent_id = bin.id;
        addKid(s, bin.id, m.id);
        moved.push(m.id);
      }
      if (moved.length > 0) P.actions.push({ type: "move", ids: moved, folder_id: bin.id, op: P.opIndex, bin: bk });
    }
  }

  function planRemoveEmpty(P, op) {
    var s = P.s;
    if (s.truncated) {
      refuse(P, "The project has more than " + MAX_SNAPSHOT + " items; remove_empty_folders can't see all of them");
      return;
    }
    var scope = s.byId[s.rootId];
    if (isNum(op.parent_id)) {
      scope = need(P, op.parent_id);
      if (!scope) return;
      if (scope.kind !== "folder") {
        refuse(P, describeRec(scope) + " is not a folder");
        return;
      }
    }
    var removed = 0;
    var changed = true;
    var rounds = 0;
    while (changed && rounds < 1000) {
      changed = false;
      rounds++;
      var ids = [];
      var id;
      for (id in s.byId) {
        if (s.byId.hasOwnProperty(id)) ids.push(Number(id));
      }
      ids.sort(function (a, b) { return a - b; });
      for (var i = 0; i < ids.length; i++) {
        var r = s.byId[ids[i]];
        if (r.deleted || r.isRoot || r.virtual || r.kind !== "folder") continue;
        if (r.id === scope.id || !isInside(s, r.id, scope.id)) continue;
        if (kidsOf(s, r.id).length > 0) continue;
        P.actions.push({ type: "delete", id: r.id, name: r.name, kind: "folder", contained: 0, op: P.opIndex });
        markDeleted(s, r);
        removed++;
        changed = true;
      }
    }
    if (removed === 0) skip(P, "No empty folders under " + describeRec(scope));
  }

  function makePlan(args) {
    var P = {
      s: snapshot(),
      actions: [],
      refusals: [],
      skipped: [],
      warnings: [],
      renames: [],
      used: [],
      rqRemoved: [],
      opIndex: 0,
      opAction: ""
    };
    var ops = args.ops;
    if (!ops || typeof ops.length !== "number" || ops.length === 0) {
      fail("bad_args", "ops must be a non-empty list");
    }
    if (P.s.truncated) {
      refuse(P, "The project has more than " + MAX_SNAPSHOT + " items; it is too large to plan on");
      return P;
    }
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      P.opIndex = i + 1;
      P.opAction = String(op.action);
      if (op.action === "create_folder") {
        var parent = P.s.byId[P.s.rootId];
        var okParent = true;
        if (isNum(op.parent_id)) {
          parent = need(P, op.parent_id);
          if (!parent) okParent = false;
          else if (parent.kind !== "folder") {
            refuse(P, describeRec(parent) + " is not a folder");
            okParent = false;
          }
        }
        if (okParent && validName(P, op.name, "name")) {
          if (folderChildByName(P.s, parent.id, op.name).length > 0) P.warnings.push("A folder named \"" + op.name + "\" already exists in " + describeRec(parent) + "; another is created");
          var v = addVirtualFolder(P.s, op.name, parent.id);
          P.actions.push({ type: "create_folder", id: v.id, name: v.name, parent_id: parent.id, op: P.opIndex });
        }
      } else if (op.action === "move") {
        planMove(P, op);
      } else if (op.action === "rename") {
        planRename(P, op);
      } else if (op.action === "label") {
        planLabel(P, op);
      } else if (op.action === "comment") {
        planComment(P, op);
      } else if (op.action === "delete") {
        planDelete(P, op);
      } else if (op.action === "organize") {
        planOrganize(P, op);
      } else if (op.action === "remove_empty_folders") {
        planRemoveEmpty(P, op);
      } else {
        refuse(P, "Unknown action \"" + op.action + "\"");
      }
    }
    return P;
  }

  function planSummary(P, args) {
    var counts = { create_folder: 0, move: 0, rename: 0, label: 0, comment: 0, "delete": 0 };
    var shown = [];
    for (var i = 0; i < P.actions.length; i++) {
      var a = P.actions[i];
      if (a.type === "move" || a.type === "label" || a.type === "comment") counts[a.type] += a.ids.length;
      else if (a.type === "delete") counts["delete"] += 1 + (a.contained || 0);
      else counts[a.type] += 1;
      if (shown.length < MAX_LIST) {
        var copy = {};
        for (var k in a) {
          if (a.hasOwnProperty(k)) copy[k] = a[k];
        }
        delete copy.contained_ids;
        if (copy.ids && copy.ids.length > MAX_LIST) {
          copy.ids = copy.ids.slice(0, MAX_LIST);
          copy.ids_truncated = true;
        }
        shown.push(copy);
      }
    }
    var fixAvailable = typeof app.project.autoFixExpressions === "function";
    var out = {
      actions: shown,
      actions_total: P.actions.length,
      actions_truncated: P.actions.length > MAX_LIST,
      counts: counts,
      refusals: P.refusals.slice(0, MAX_LIST),
      skipped: P.skipped.slice(0, MAX_LIST),
      warnings: P.warnings,
      renames: P.renames.slice(0, MAX_LIST),
      renames_total: P.renames.length,
      used_items: P.used.slice(0, MAX_LIST),
      render_queue_items_removed: P.rqRemoved.slice(0, MAX_LIST),
      fix_expressions: args.fix_expressions !== false,
      fix_expressions_available: fixAvailable
    };
    if (P.renames.length > 0 && args.fix_expressions !== false && !fixAvailable) {
      out.warnings = out.warnings.concat(["This AE has no Project.autoFixExpressions; comp(\"Name\") and footage(\"Name\") expressions are not repaired after the rename"]);
    }
    return out;
  }

  A.projectitemsPlan = function (args) {
    args = args || {};
    var P = makePlan(args);
    return planSummary(P, args);
  };

  function resolveReal(real, id) {
    if (id < 0) {
      if (real[id] === undefined) return null;
      return itemById(real[id]);
    }
    if (id === rootFolder().id) return rootFolder();
    return itemById(id);
  }

  function pushFailed(out, action, message) {
    out.failed.push({ op: action.op, type: action.type, id: action.id, message: clip(message, 500) });
  }

  A.projectitemsApply = function (args) {
    assertGuard(args.expect);
    var P = makePlan(args);
    var plan = planSummary(P, args);
    if (P.refusals.length > 0) {
      return { no_op: true, refused: true, refusals: plan.refusals, skipped: plan.skipped, plan_counts: plan.counts };
    }
    if (P.actions.length === 0) {
      return { no_op: true, refused: false, refusals: [], skipped: plan.skipped, plan_counts: plan.counts };
    }
    var fixOn = args.fix_expressions !== false;
    var fixAvailable = typeof app.project.autoFixExpressions === "function";
    return A.withUndo(args.label || "Project items", function () {
      var real = {};
      var out = {
        no_op: false,
        created_folders: [],
        moved: [],
        renamed: [],
        labelled: [],
        commented: [],
        deleted: [],
        failed: [],
        skipped: plan.skipped,
        plan_counts: plan.counts,
        render_queue_items_removed: plan.render_queue_items_removed,
        fix_expressions: fixOn,
        fix_expressions_available: fixAvailable,
        name_fixes_attempted: 0,
        warnings: plan.warnings
      };
      var i;
      var j;
      for (i = 0; i < P.actions.length; i++) {
        var a = P.actions[i];
        try {
          if (a.type === "create_folder") {
            var parent = resolveReal(real, a.parent_id);
            if (!parent) throw new Error("the parent folder is gone");
            var f = app.project.items.addFolder(a.name);
            if (parent.id !== rootFolder().id) f.parentFolder = parent;
            real[a.id] = f.id;
            out.created_folders.push({ virtual_id: a.id, id: f.id, name: a.name, parent_id: parent.id });
          } else if (a.type === "move") {
            var target = resolveReal(real, a.folder_id);
            if (!target) throw new Error("the destination folder is gone");
            for (j = 0; j < a.ids.length; j++) {
              var mv = itemById(a.ids[j]);
              if (!mv) {
                out.failed.push({ op: a.op, type: "move", id: a.ids[j], message: "item not found" });
                continue;
              }
              try {
                mv.parentFolder = target;
                out.moved.push({ id: mv.id, folder_id: target.id });
              } catch (eMv) {
                out.failed.push({ op: a.op, type: "move", id: a.ids[j], message: clip(eMv.message, 500) });
              }
            }
          } else if (a.type === "rename") {
            var rn = itemById(a.id);
            if (!rn) throw new Error("item not found");
            rn.name = a.to;
            out.renamed.push({ id: a.id, from: a.from, to: a.to, kind: a.kind });
          } else if (a.type === "label") {
            for (j = 0; j < a.ids.length; j++) {
              var lb = itemById(a.ids[j]);
              if (!lb) {
                out.failed.push({ op: a.op, type: "label", id: a.ids[j], message: "item not found" });
                continue;
              }
              try {
                lb.label = a.label;
                out.labelled.push({ id: lb.id, label: a.label });
              } catch (eLb) {
                out.failed.push({ op: a.op, type: "label", id: a.ids[j], message: clip(eLb.message, 500) });
              }
            }
          } else if (a.type === "comment") {
            for (j = 0; j < a.ids.length; j++) {
              var cm = itemById(a.ids[j]);
              if (!cm) {
                out.failed.push({ op: a.op, type: "comment", id: a.ids[j], message: "item not found" });
                continue;
              }
              try {
                cm.comment = a.text;
                out.commented.push({ id: cm.id });
              } catch (eCm) {
                out.failed.push({ op: a.op, type: "comment", id: a.ids[j], message: clip(eCm.message, 500) });
              }
            }
          } else if (a.type === "delete") {
            var dl = itemById(a.id);
            if (!dl) throw new Error("item not found");
            dl.remove();
            out.deleted.push({ id: a.id, name: a.name, kind: a.kind, contained: a.contained, contained_ids: a.contained_ids });
          }
        } catch (eAct) {
          pushFailed(out, a, eAct.message);
        }
      }
      // Rename first, then repair: autoFixExpressions only rewrites expressions that are broken
      // (and evaluate without error after the replace), project-wide.
      if (fixOn && fixAvailable) {
        for (i = 0; i < out.renamed.length; i++) {
          var rr = out.renamed[i];
          if (rr.kind !== "comp" && rr.kind !== "footage") continue;
          try {
            app.project.autoFixExpressions("\"" + jsString(rr.from) + "\"", "\"" + jsString(rr.to) + "\"");
            app.project.autoFixExpressions("'" + jsStringSingle(rr.from) + "'", "'" + jsStringSingle(rr.to) + "'");
            out.name_fixes_attempted++;
          } catch (eFix) {
            out.failed.push({ op: 0, type: "fix_expressions", id: rr.id, message: clip(eFix.message, 500) });
          }
        }
      }
      return boundResult(out);
    });
  };

  // Every list in the write's result is bounded: the first MAX_LIST entries, a <name>_total count and truncated.
  // The ids inside deleted folders (contained_ids) share one budget of MAX_LIST across the whole result.
  function boundResult(out) {
    var names = ["created_folders", "moved", "renamed", "labelled", "commented", "deleted", "failed"];
    var i;
    for (i = 0; i < names.length; i++) {
      var list = out[names[i]];
      if (list && list.length > MAX_LIST) {
        out[names[i] + "_total"] = list.length;
        out[names[i]] = list.slice(0, MAX_LIST);
        out.truncated = true;
      }
    }
    var budget = MAX_LIST;
    for (i = 0; i < out.deleted.length; i++) {
      var ci = out.deleted[i].contained_ids;
      if (!ci) continue;
      if (ci.length > budget) {
        out.deleted[i].contained_ids = ci.slice(0, budget);
        out.deleted[i].contained_ids_truncated = true;
        out.truncated = true;
      }
      budget -= out.deleted[i].contained_ids.length;
    }
    for (i = 0; i < out.failed.length; i++) out.failed[i].message = clip(out.failed[i].message, 500);
    return out;
  }

  function jsStringSingle(s) {
    var t = String(s);
    t = t.split("\\").join("\\\\");
    t = t.split("'").join("\\'");
    t = t.split("\r").join("\\r");
    t = t.split("\n").join("\\n");
    return t;
  }

  function jsString(s) {
    var t = String(s);
    t = t.split("\\").join("\\\\");
    t = t.split("\"").join("\\\"");
    t = t.split("\r").join("\\r");
    t = t.split("\n").join("\\n");
    return t;
  }
})($.global);
