// panel/host/ext/inventory.jsx
//
// Read-only host functions for the project inventory tools:
// - compTree: which comps nest which, where a comp is used, unused comps
// - fontsInUse: the fonts text layers use (keyframed source text too), and
//   which are missing or substituted (AE 24+ font API; unknown before)
//
// - inventorySearchFonts / inventoryCheckFonts / inventoryUsedFonts / inventoryReplacePlan: reads for
//   ae_fonts search / check / replace (dry run)
// - inventoryReplaceFont: the one write (Project.replaceFont, AE 24.5, not undoable; the server checkpoints first)
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Reads change nothing in the project, the selection or the time; only inventoryReplaceFont writes.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_LAYER_VISITS = 50000;
  var MAX_USES = 20;
  var MAX_TEXT_KEYS = 20;

  function fail(kind, message, details) {
    var e = new Error(message);
    e.__kind = kind;
    if (details) {
      e.__expected = details.expected;
      e.__actual = details.actual;
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

  function allComps() {
    var out = [];
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it instanceof CompItem) out.push(it);
    }
    return out;
  }

  // ---------- comp tree ----------

  A.compTree = function (args) {
    var comps = allComps();
    var byId = {};
    var children = {};
    var parents = {};
    var visits = 0;
    var partial = false;
    var i;
    for (i = 0; i < comps.length; i++) {
      byId[comps[i].id] = comps[i];
      children[comps[i].id] = [];
      parents[comps[i].id] = [];
    }
    for (i = 0; i < comps.length && !partial; i++) {
      var c = comps[i];
      for (var j = 1; j <= c.numLayers; j++) {
        if (visits >= MAX_LAYER_VISITS) {
          partial = true;
          break;
        }
        visits++;
        var src = null;
        try { src = c.layer(j).source; } catch (eSrc) { src = null; }
        if (src && src instanceof CompItem) {
          var edge = { parent: c.id, child: src.id, layer_index: j, layer_name: c.layer(j).name };
          children[c.id].push(edge);
          if (parents[src.id]) parents[src.id].push(edge);
        }
      }
    }
    var queued = {};
    try {
      var rq = app.project.renderQueue;
      for (var q = 1; q <= rq.numItems; q++) {
        try { queued[rq.item(q).comp.id] = true; } catch (eQ) {}
      }
    } catch (eRq) {}

    var depthLimit = 10;
    if (args && args.depth) depthLimit = args.depth;
    var nodes = 0;

    function down(id, depth, seen) {
      var kids = children[id] || [];
      var grouped = {};
      var order = [];
      for (var k = 0; k < kids.length; k++) {
        var e = kids[k];
        if (!grouped[e.child]) {
          grouped[e.child] = [];
          order.push(e.child);
        }
        grouped[e.child].push({ index: e.layer_index, name: e.layer_name });
      }
      var out = [];
      for (var m = 0; m < order.length; m++) {
        if (nodes >= MAX_LIST) return out;
        nodes++;
        var cid = order[m];
        var node = { id: cid, name: byId[cid].name, layers: grouped[cid] };
        if (seen[cid]) node.repeated = true;
        else if (depth < depthLimit) {
          seen[cid] = true;
          node.contains = down(cid, depth + 1, seen);
          seen[cid] = false;
        } else if ((children[cid] || []).length) node.deeper = true;
        out.push(node);
      }
      return out;
    }

    // One node per parent comp, with the layers that hold this comp (as down() does).
    function up(id, depth, seen) {
      var ps = parents[id] || [];
      var grouped = {};
      var order = [];
      for (var k = 0; k < ps.length; k++) {
        var e = ps[k];
        if (!grouped[e.parent]) {
          grouped[e.parent] = [];
          order.push(e.parent);
        }
        grouped[e.parent].push({ index: e.layer_index, name: e.layer_name });
      }
      var out = [];
      for (var m = 0; m < order.length; m++) {
        if (nodes >= MAX_LIST) return out;
        nodes++;
        var pid = order[m];
        var node = { id: pid, name: byId[pid].name, layers: grouped[pid] };
        if (seen[pid]) node.repeated = true;
        else if (depth < depthLimit) {
          seen[pid] = true;
          node.used_in = up(pid, depth + 1, seen);
          seen[pid] = false;
        } else if ((parents[pid] || []).length) node.deeper = true;
        out.push(node);
      }
      return out;
    }

    if (args && args.comp_id !== undefined && args.comp_id !== null) {
      var root = requireComp(args.comp_id);
      var seenDown = {};
      seenDown[root.id] = true;
      var seenUp = {};
      seenUp[root.id] = true;
      return {
        comp: { id: root.id, name: root.name, in_render_queue: queued[root.id] === true },
        contains: down(root.id, 1, seenDown),
        used_in: up(root.id, 1, seenUp),
        truncated: nodes >= MAX_LIST,
        partial: partial
      };
    }

    // Overview: every comp with its nesting, top-level comps first.
    // Longest nesting below a comp, memoised so the whole overview costs
    // comps + edges (a path search is exponential on repeated precomps).
    // hActive keeps it safe against a cycle.
    var hMemo = {};
    var hActive = {};
    function height(id) {
      if (hMemo.hasOwnProperty(id)) return hMemo[id];
      hActive[id] = true;
      var kids = children[id] || [];
      var h = 0;
      for (var k = 0; k < kids.length; k++) {
        var cid = kids[k].child;
        if (hActive[cid]) continue;
        var sub = 1 + height(cid);
        if (sub > h) h = sub;
      }
      hActive[id] = false;
      hMemo[id] = h;
      return h;
    }
    var list = [];
    for (i = 0; i < comps.length && list.length < MAX_LIST; i++) {
      var cp = comps[i];
      var distinctKids = {};
      var nKids = 0;
      for (var x = 0; x < children[cp.id].length; x++) {
        if (!distinctKids[children[cp.id][x].child]) {
          distinctKids[children[cp.id][x].child] = true;
          nKids++;
        }
      }
      var distinctParents = {};
      var nParents = 0;
      for (var y = 0; y < parents[cp.id].length; y++) {
        if (!distinctParents[parents[cp.id][y].parent]) {
          distinctParents[parents[cp.id][y].parent] = true;
          nParents++;
        }
      }
      list.push({
        id: cp.id,
        name: cp.name,
        used_in: nParents,
        used_by_layers: parents[cp.id].length,
        contains: nKids,
        nesting_depth: height(cp.id),
        in_render_queue: queued[cp.id] === true
      });
    }
    var top = [];
    var unused = [];
    // A cut-short layer scan leaves comps without edges, so nothing can be
    // called top-level or unused from it.
    for (i = 0; i < list.length && !partial; i++) {
      if (list[i].used_in === 0) {
        if (list[i].in_render_queue || list[i].contains > 0) top.push({ id: list[i].id, name: list[i].name });
        else unused.push({ id: list[i].id, name: list[i].name });
      }
    }
    return {
      num_comps: comps.length,
      comps: list,
      top_level: partial ? null : top,
      unused: partial ? null : unused,
      truncated: comps.length > MAX_LIST,
      partial: partial
    };
  };

  // ---------- fonts ----------

  function fontInfo(td) {
    var f = { font: null, family: null, style: null, location: null, missing: null };
    try { f.font = td.font; } catch (e1) {}
    try { f.family = td.fontFamily; } catch (e2) {}
    try { f.style = td.fontStyle; } catch (e3) {}
    try { f.location = td.fontLocation; } catch (e4) {}
    // AE 24+: the font object knows whether AE substituted it.
    try {
      if (td.fontObject) f.missing = td.fontObject.isSubstitute === true;
    } catch (e5) {}
    return f;
  }

  A.fontsInUse = function (args) {
    var comps;
    if (args && args.comp_id !== undefined && args.comp_id !== null) comps = [requireComp(args.comp_id)];
    else comps = allComps();
    var fonts = {};
    var order = [];
    var textLayers = 0;
    var visits = 0;
    var partial = false;
    var skipped = 0;

    function note(td, comp, layer, key) {
      var f = fontInfo(td);
      if (!f.font) return;
      var entry = fonts[f.font];
      if (!entry) {
        entry = { font: f.font, family: f.family, style: f.style, location: f.location, missing: f.missing, uses: 0, layers: [] };
        fonts[f.font] = entry;
        order.push(f.font);
      }
      if (entry.missing === null && f.missing !== null) entry.missing = f.missing;
      entry.uses++;
      if (entry.layers.length < MAX_USES) {
        var use = { comp_id: comp.id, comp: comp.name, layer_index: layer.index, layer: layer.name };
        if (key) use.key = key;
        entry.layers.push(use);
      }
    }

    for (var i = 0; i < comps.length && !partial; i++) {
      var c = comps[i];
      for (var j = 1; j <= c.numLayers; j++) {
        if (visits >= MAX_LAYER_VISITS) {
          partial = true;
          break;
        }
        visits++;
        var l = null;
        var isText = false;
        try {
          l = c.layer(j);
          isText = String(l.reflect.name) === "TextLayer";
        } catch (eT) {}
        if (!isText) continue;
        textLayers++;
        // One odd text layer must not fail the whole read.
        var layerFailed = false;
        var st = null;
        try {
          st = l.property("ADBE Text Properties").property("ADBE Text Document");
        } catch (eLayer) {
          layerFailed = true;
        }
        // property() gives null rather than throwing for a missing property: that is unread too.
        if (!st) layerFailed = true;
        if (st) {
          var n = 1;
          var keyed = false;
          try {
            if (st.numKeys > 0) {
              keyed = true;
              n = st.numKeys;
              if (n > MAX_TEXT_KEYS) n = MAX_TEXT_KEYS;
            }
          } catch (eN) {
            layerFailed = true;
          }
          if (keyed) {
            for (var k = 1; k <= n; k++) {
              try { note(st.keyValue(k), c, l, k); } catch (eKey) { layerFailed = true; }
            }
          } else {
            try { note(st.value, c, l, null); } catch (eVal) { layerFailed = true; }
          }
        }
        if (layerFailed) skipped++;
      }
    }

    // AE's own list of missing or substituted fonts (AE 24+), for fonts the
    // text documents didn't settle.
    var appMissing = null;
    try {
      var mf = app.fonts.missingOrSubstitutedFonts;
      appMissing = [];
      for (var m = 0; m < mf.length && m < MAX_LIST; m++) {
        try { appMissing.push(mf[m].postScriptName); } catch (eName) {}
      }
    } catch (eApp) {
      appMissing = null;
    }
    var list = [];
    var missing = [];
    var known = true;
    for (var o = 0; o < order.length && list.length < MAX_LIST; o++) {
      var e = fonts[order[o]];
      if (e.missing === null && appMissing !== null) {
        e.missing = false;
        for (var a = 0; a < appMissing.length; a++) {
          if (appMissing[a] === e.font) e.missing = true;
        }
      }
      if (e.missing === null) known = false;
      if (e.missing === true) missing.push(e.font);
      list.push(e);
    }
    return {
      scope: (args && args.comp_id) ? "comp" : "project",
      text_layers: textLayers,
      fonts: list,
      missing: missing,
      missing_known: known,
      truncated: order.length > MAX_LIST,
      partial: partial,
      skipped_layers: skipped
    };
  };

  // ---------- font search, check and replace (AE 24.0+ app.fonts; members newer are feature-detected) ----------
  //
  // inventorySearchFonts  read   a bounded scan of app.fonts.allFonts, paged
  // inventoryCheckFonts   read   exists / substitute / duplicates / glyphs / variable axes / fallback for given fonts
  // inventoryUsedFonts    read   Project.usedFonts (24.5) resolved to layers; also the read-back of a replace
  // inventoryReplacePlan  read   the dry run of a replace
  // inventoryReplaceFont  WRITE  Project.replaceFont (24.5): NOT undoable, so the server checkpoints first

  var MAX_FONT_SCAN = 8000;
  var FONT_SCAN_MS = 2500;
  var MAX_PAGE = 100;
  var MAX_CHECK_FONTS = 50;
  var MAX_USED_LAYERS = 100;
  var MAX_PLAN_LAYERS = 100;
  var MAX_GLYPH_CHARS = 2000;
  var BIG_FLOAT = 1e30;

  function clipStr(s, n) {
    var t = String(s);
    if (t.length > n) return t.substring(0, n);
    return t;
  }

  function fontsApi() {
    var f = null;
    try { f = app.fonts; } catch (e) { f = null; }
    if (f === undefined) return null;
    return f;
  }

  function noFontsReason() {
    return "This After Effects has no app.fonts (it needs 24.0).";
  }

  function normF(s) {
    return String(s).toLowerCase().replace(/[\s\-_]+/g, "");
  }

  function readMember(obj, name) {
    try {
      var v = obj[name];
      if (v !== undefined && v !== null) return v;
    } catch (e) {}
    return undefined;
  }

  // The name of a CTScript enum value ("CT_ROMAN_SCRIPT"), or its string form.
  function ctScriptName(v) {
    try {
      if (typeof CTScript !== "undefined") {
        for (var k in CTScript) {
          if (CTScript[k] === v) return String(k);
        }
      }
    } catch (e) {}
    return String(v);
  }

  // Word-order variants of the CTScript names (the enum puts the qualifier first and joins words).
  var CT_SCRIPT_ALIASES = {
    CHINESESIMPLIFIED: "SIMPLIFIEDCHINESE",
    CHINESETRADITIONAL: "TRADITIONALCHINESE",
    ROMANEASTEUROPEAN: "EASTEUROPEANROMAN"
  };

  // Strip spaces, dashes and underscores so "chinese_simplified" and "CT_SIMPLIFIEDCHINESE_SCRIPT" compare equal.
  function ctScriptKey(s) {
    return String(s).toUpperCase().replace(/^CT_/, "").replace(/_SCRIPT$/, "").replace(/[\s\-_]+/g, "");
  }

  function ctScriptFromName(name) {
    var want = String(name);
    var upper = want.toUpperCase().replace(/[\s\-]+/g, "_");
    var tries = [want, upper, "CT_" + upper + "_SCRIPT", "CT_" + upper];
    try {
      if (typeof CTScript === "undefined") return undefined;
      for (var i = 0; i < tries.length; i++) {
        var v = CTScript[tries[i]];
        if (v !== undefined) return v;
      }
      var key = ctScriptKey(want);
      if (CT_SCRIPT_ALIASES[key] !== undefined) key = CT_SCRIPT_ALIASES[key];
      // The alias table gives the exact enum stem, so try it directly before relying on enumeration.
      var direct = CTScript["CT_" + key + "_SCRIPT"];
      if (direct !== undefined) return direct;
      for (var k in CTScript) {
        if (k.indexOf("CT_") === 0 && ctScriptKey(k) === key && CTScript[k] !== undefined) return CTScript[k];
      }
    } catch (e) {}
    return undefined;
  }

  // Line breaks and control characters have no glyph of their own; the glyph check must not see them.
  function glyphText(s) {
    return String(s).replace(/[\r\n\t\u0003\u2028\u2029]/g, "");
  }

  function writingScriptNames(f) {
    var out = [];
    try {
      var ws = f.writingScripts;
      for (var i = 0; ws && i < ws.length && i < 20; i++) out.push(ctScriptName(ws[i]));
    } catch (e) {}
    return out;
  }

  function axesOf(f) {
    var axes = [];
    try {
      var raw = f.designAxesData;
      for (var a = 0; raw && a < raw.length && a < 20; a++) {
        var ax = {};
        var tag = readMember(raw[a], "axisTag");
        if (tag === undefined) tag = readMember(raw[a], "tag");
        var nm = readMember(raw[a], "axisName");
        if (nm === undefined) nm = readMember(raw[a], "name");
        var mn = readMember(raw[a], "minValue");
        if (mn === undefined) mn = readMember(raw[a], "min");
        var mx = readMember(raw[a], "maxValue");
        if (mx === undefined) mx = readMember(raw[a], "max");
        var df = readMember(raw[a], "defaultValue");
        if (df === undefined) df = readMember(raw[a], "default");
        if (tag !== undefined) ax.tag = String(tag);
        if (nm !== undefined) ax.name = String(nm);
        if (mn !== undefined) ax.min = mn;
        if (mx !== undefined) ax.max = mx;
        if (df !== undefined) ax["default"] = df;
        axes.push(ax);
      }
    } catch (e) {}
    return axes;
  }

  function fontSummary(f, full) {
    var d = {};
    var map = [
      ["postscript", "postScriptName"], ["family", "familyName"], ["style", "styleName"], ["full_name", "fullName"],
      ["native_family", "nativeFamilyName"], ["native_style", "nativeStyleName"], ["native_full_name", "nativeFullName"],
      ["is_from_adobe_fonts", "isFromAdobeFonts"], ["is_substitute", "isSubstitute"], ["has_design_axes", "hasDesignAxes"],
      ["location", "location"], ["font_id", "fontID"]
    ];
    for (var i = 0; i < map.length; i++) {
      var v = readMember(f, map[i][1]);
      if (v === undefined) continue;
      if (typeof v === "string") d[map[i][0]] = clipStr(v, 400);
      else d[map[i][0]] = v;
    }
    if (full) {
      d.writing_scripts = writingScriptNames(f);
      if (d.has_design_axes === true) d.axes = axesOf(f);
    }
    return d;
  }

  // The raw FontObject for a spec: {postscript} or {family, style}. Prefers a font AE does not substitute.
  function rawFont(spec) {
    var fonts = fontsApi();
    if (!fonts) return null;
    var list = null;
    try {
      if (spec.postscript !== undefined && spec.postscript !== null && String(spec.postscript) !== "") {
        list = fonts.getFontsByPostScriptName(String(spec.postscript));
      } else if (spec.family !== undefined && spec.style !== undefined) {
        list = fonts.getFontsByFamilyNameAndStyleName(String(spec.family), String(spec.style));
      }
    } catch (e) {
      list = null;
    }
    if (list === null || list === undefined) return null;
    if (list.length === undefined) return list;
    if (list.length === 0) return null;
    for (var i = 0; i < list.length; i++) {
      var sub = false;
      try { sub = list[i].isSubstitute === true; } catch (e2) {}
      if (!sub) return list[i];
    }
    return list[0];
  }

  function specLabel(spec) {
    if (spec.postscript !== undefined && spec.postscript !== null && String(spec.postscript) !== "") return String(spec.postscript);
    return String(spec.family) + " " + String(spec.style);
  }

  // A font reference from the tool: a PostScript name, or { family, style }.
  function toSpec(ref, what) {
    if (typeof ref === "string") {
      if (ref.length < 1 || ref.length > 200) fail("bad_args", what + " must be a PostScript name of 1..200 characters");
      return { postscript: ref };
    }
    if (ref && typeof ref === "object") {
      if (typeof ref.postscript === "string" && ref.postscript.length > 0) return { postscript: ref.postscript };
      if (typeof ref.family === "string" && typeof ref.style === "string" && ref.family.length > 0 && ref.style.length > 0) {
        return { family: ref.family, style: ref.style };
      }
    }
    fail("bad_args", what + " must be a PostScript name, or { family, style }");
    return null;
  }

  // ----- search -----

  function matchesQuery(info, q) {
    var names = [info.postscript, info.family, info.style, info.full_name, info.native_family, info.native_style, info.native_full_name];
    for (var i = 0; i < names.length; i++) {
      if (names[i] !== undefined && normF(names[i]).indexOf(q) >= 0) return true;
    }
    return false;
  }

  A.inventorySearchFonts = function (args) {
    args = args || {};
    var fonts = fontsApi();
    if (!fonts) return { available: false, reason: noFontsReason(), fonts: [], total_matches: 0, scanned: 0 };
    var all = null;
    try { all = fonts.allFonts; } catch (e0) { all = null; }
    if (!all) return { available: false, reason: "app.fonts.allFonts could not be read.", fonts: [], total_matches: 0, scanned: 0 };
    var q = "";
    if (typeof args.query === "string") q = normF(args.query);
    var wantFamily = "";
    if (typeof args.family === "string") wantFamily = normF(args.family);
    var wantStyle = "";
    if (typeof args.style === "string") wantStyle = normF(args.style);
    var pageSize = 25;
    if (typeof args.page_size === "number" && isFinite(args.page_size)) pageSize = Math.floor(args.page_size);
    if (pageSize < 1) pageSize = 1;
    if (pageSize > MAX_PAGE) pageSize = MAX_PAGE;
    var page = 1;
    if (typeof args.page === "number" && isFinite(args.page)) page = Math.floor(args.page);
    if (page < 1) page = 1;
    var skip = (page - 1) * pageSize;
    var wantScript;
    var scriptGiven = typeof args.writing_script === "string" && args.writing_script.length > 0;
    if (scriptGiven) {
      wantScript = ctScriptFromName(args.writing_script);
      if (wantScript === undefined) fail("bad_args", "writing_script \"" + args.writing_script + "\" is not a CTScript name (for example roman, arabic, hebrew, cyrillic, greek, japanese, chinese_simplified).");
    }
    var variableOnly = args.variable_only === true;
    var adobeOnly = args.adobe_only === true;
    var started = new Date().getTime();
    var scanned = 0;
    var matches = 0;
    var out = [];
    var truncated = false;
    var stop = false;
    for (var i = 0; i < all.length && !stop; i++) {
      var fam = all[i];
      var famLen = 0;
      try { famLen = fam.length; } catch (e1) { famLen = 0; }
      for (var j = 0; j < famLen; j++) {
        if (scanned >= MAX_FONT_SCAN || (scanned % 50 === 0 && scanned > 0 && new Date().getTime() - started > FONT_SCAN_MS)) {
          truncated = true;
          stop = true;
          break;
        }
        scanned++;
        var f = fam[j];
        var info = fontSummary(f, false);
        if (q !== "" && !matchesQuery(info, q)) continue;
        if (wantFamily !== "") {
          var fam1 = "";
          if (info.family !== undefined) fam1 = normF(info.family);
          var fam2 = "";
          if (info.native_family !== undefined) fam2 = normF(info.native_family);
          if (fam1.indexOf(wantFamily) < 0 && fam2.indexOf(wantFamily) < 0) continue;
        }
        if (wantStyle !== "") {
          var sty = "";
          if (info.style !== undefined) sty = normF(info.style);
          if (sty.indexOf(wantStyle) < 0) continue;
        }
        if (variableOnly && info.has_design_axes !== true) continue;
        if (adobeOnly && info.is_from_adobe_fonts !== true) continue;
        if (scriptGiven) {
          var has = false;
          try {
            var ws = f.writingScripts;
            for (var w = 0; ws && w < ws.length; w++) {
              if (ws[w] === wantScript) has = true;
            }
          } catch (e2) {}
          if (!has) continue;
        }
        matches++;
        if (matches > skip && out.length < pageSize) out.push(fontSummary(f, true));
      }
    }
    var result = {
      available: true,
      fonts: out,
      page: page,
      page_size: pageSize,
      total_matches: matches,
      has_more: matches > skip + out.length,
      scanned: scanned,
      scan_truncated: truncated,
      font_ids_session_only: true
    };
    if (truncated) result.note = "The font list was only partly scanned (" + scanned + " fonts); narrow the search for a complete answer.";
    return result;
  };

  // ----- check -----

  function fallbackFor(text) {
    var fonts = fontsApi();
    var out = { scripts: [], suggested_default: [] };
    if (!fonts || typeof text !== "string" || text === "") return out;
    if (fonts.getCTScriptForString === undefined) return out;
    var preferred = null;
    try { preferred = CTScript.CT_ROMAN_SCRIPT; } catch (e0) {}
    try {
      var s = text;
      if (s.length > MAX_GLYPH_CHARS) s = s.substring(0, MAX_GLYPH_CHARS);
      var runs = fonts.getCTScriptForString(s, preferred);
      var done = {};
      for (var r = 0; runs && r < runs.length && r < 50; r++) {
        var name = ctScriptName(runs[r].ctScript);
        out.scripts.push({ chars: clipStr(runs[r].chars, 200), ct_script: name });
        if (done[name] !== true && fonts.getDefaultFontForCTScript !== undefined && out.suggested_default.length < 10) {
          done[name] = true;
          try {
            var def = fonts.getDefaultFontForCTScript(runs[r].ctScript);
            if (def) out.suggested_default.push({ ct_script: name, postscript: String(def.postScriptName) });
          } catch (e1) {}
        }
      }
    } catch (e2) {}
    return out;
  }

  function projectMissingList() {
    var fonts = fontsApi();
    if (!fonts) return null;
    var list = null;
    try { list = fonts.missingOrSubstitutedFonts; } catch (e) { list = null; }
    if (list === null || list === undefined) return null;
    var out = [];
    for (var i = 0; i < list.length && i < 500; i++) {
      var n = readMember(list[i], "postScriptName");
      if (n === undefined) n = readMember(list[i], "nativeFullName");
      if (n !== undefined) out.push(String(n));
    }
    return out;
  }

  function checkOne(ref, text) {
    var spec = toSpec(ref, "fonts[]");
    var r = A.fontsResolve(spec);
    var entry = { requested: specLabel(spec), exists: null, is_substitute: null, duplicates: 0, candidates: [] };
    if (r.unchecked) {
      entry.reason = r.reason;
      return entry;
    }
    if (r.candidates) entry.candidates = r.candidates;
    if (r.reason) entry.reason = r.reason;
    if (!r.font) {
      entry.exists = false;
      entry.is_substitute = null;
      if (text !== null) {
        var fb = fallbackFor(text);
        entry.fallback = fb;
      }
      return entry;
    }
    entry.exists = true;
    entry.font = r.font;
    entry.is_substitute = r.font.is_substitute === true;
    entry.duplicates = r.duplicates;
    var raw = rawFont(spec);
    if (raw) {
      var other = readMember(raw, "otherFontsWithSameDict");
      if (other !== undefined) {
        try { entry.other_fonts_with_same_dict = other.length; } catch (e1) {}
      }
      if (entry.font.has_design_axes === true) {
        var variable = { axes: entry.font.axes };
        var dv = readMember(raw, "designVector");
        if (dv !== undefined) {
          var vec = [];
          try {
            for (var v = 0; v < dv.length && v < 20; v++) vec.push(Number(dv[v]));
            variable.design_vector = vec;
            if (typeof raw.postScriptNameForDesignVector === "function") {
              variable.instance_postscript = String(raw.postScriptNameForDesignVector(dv));
            }
          } catch (e2) {}
        }
        var fonts = fontsApi();
        try {
          var defaults = fonts.fontsWithDefaultDesignAxes;
          if (defaults) {
            var fam = String(entry.font.family);
            for (var d = 0; d < defaults.length && d < 5000; d++) {
              if (String(defaults[d].familyName) === fam) {
                variable.default_instance_postscript = String(defaults[d].postScriptName);
                break;
              }
            }
          }
        } catch (e3) {}
        entry.variable = variable;
      }
    }
    if (text !== null) {
      var g = A.fontsGlyphCheck(r.font.postscript, glyphText(text), MAX_GLYPH_CHARS);
      entry.glyphs = {
        supported: g.supported,
        missing: g.missing,
        checked: g.checked,
        truncated: g.truncated,
        suggested_default: g.suggested_default
      };
      if (g.reason) entry.glyphs.reason = g.reason;
      if (g.scripts && g.scripts.length) entry.glyphs.scripts = g.scripts;
    }
    return entry;
  }

  A.inventoryCheckFonts = function (args) {
    args = args || {};
    var fonts = fontsApi();
    if (!fonts) return { available: false, reason: noFontsReason(), checked: [] };
    var list = args.fonts;
    if (!list || typeof list.length !== "number" || list.length < 1 || list.length > MAX_CHECK_FONTS) {
      fail("bad_args", "fonts must list 1.." + MAX_CHECK_FONTS + " fonts");
    }
    var text = null;
    if (typeof args.text === "string" && args.text.length > 0) text = args.text;
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(checkOne(list[i], text));
    var res = { available: true, checked: out, text_checked: text !== null };
    if (text !== null && text.length > MAX_GLYPH_CHARS) res.text_truncated_to = MAX_GLYPH_CHARS;
    var missing = projectMissingList();
    if (missing !== null) res.project_missing_or_substituted = missing;
    return res;
  };

  // ----- used fonts (AE 24.5) -----

  // Project.usedFonts entries are read defensively: the member names of the layer records are not pinned down.
  function locLayerId(loc) {
    if (typeof loc === "number") return loc;
    if (loc && typeof loc === "object") {
      var idv = readMember(loc, "layerID");
      if (idv === undefined) idv = readMember(loc, "layerId");
      if (idv === undefined) idv = readMember(loc, "id");
      if (typeof idv === "number") return idv;
    }
    return null;
  }

  function layerRecord(loc) {
    var id = locLayerId(loc);
    var times = [];
    if (id !== null && typeof loc === "object") {
      // layerTimeD is the documented member; the others are alternative spellings.
      var tv = readMember(loc, "layerTimeD");
      if (tv === undefined) tv = readMember(loc, "layerTimes");
      if (tv === undefined) tv = readMember(loc, "times");
      if (tv === undefined) tv = readMember(loc, "time");
      if (typeof tv === "number") {
        times.push(tv);
      } else if (tv && typeof tv.length === "number") {
        for (var t = 0; t < tv.length && t < 10; t++) {
          if (typeof tv[t] === "number") times.push(tv[t]);
        }
      }
    }
    if (id === null) return null;
    var rec = { layer_id: id, times: times };
    var layer = null;
    try { layer = app.project.layerByID(id); } catch (e1) { layer = null; }
    if (layer) {
      rec.layer = clipStr(layer.name, 200);
      try { rec.layer_index = layer.index; } catch (e2) {}
      try {
        var comp = layer.containingComp;
        if (comp) {
          rec.comp_id = comp.id;
          rec.comp = clipStr(comp.name, 200);
        }
      } catch (e3) {}
      rec.resolved = true;
    } else {
      rec.resolved = false;
    }
    return rec;
  }

  // -> { supported, reason?, entries: [ { font (raw), postscript, family, style, is_substitute, uses, layer_count, layers } ], truncated }
  // With specs, every used font is scanned and only the matching ones are kept (so a project with many fonts cannot cut
  // off the wanted ones); without, the listing stops at MAX_LIST and says truncated.
  // uses = layer-and-time uses (usedAt.length); layer_count = distinct layers; layers = per-use records (at most MAX_USED_LAYERS).
  function readUsedFonts(specs) {
    var uf;
    try { uf = app.project.usedFonts; } catch (e0) { uf = undefined; }
    if (uf === undefined || uf === null) {
      return { supported: false, reason: "Project.usedFonts needs After Effects 24.5.", entries: [], truncated: false };
    }
    var entries = [];
    var truncated = false;
    for (var i = 0; i < uf.length; i++) {
      if (entries.length >= MAX_LIST) {
        truncated = specs ? false : true;
        break;
      }
      var e = uf[i];
      var font = readMember(e, "fontObject");
      if (font === undefined) font = readMember(e, "font");
      if (font === undefined && readMember(e, "postScriptName") !== undefined) font = e;
      if (font === undefined) continue;
      var info = fontSummary(font, false);
      var entry = { font: font, postscript: info.postscript, family: info.family, style: info.style, is_substitute: info.is_substitute === true, uses: 0, layer_count: 0, layers: [] };
      if (specs) {
        var wanted = false;
        for (var w = 0; w < specs.length; w++) {
          if (entryMatches(entry, specs[w])) wanted = true;
        }
        if (!wanted) continue;
      }
      var locs = readMember(e, "usedAt");
      if (locs === undefined) locs = readMember(e, "layers");
      if (locs === undefined) locs = readMember(e, "locations");
      if (locs === undefined) locs = readMember(e, "layerIDs");
      if (locs === undefined) locs = readMember(e, "layerIds");
      if (locs && typeof locs.length === "number") {
        entry.uses = locs.length;
        var seen = {};
        var distinct = 0;
        for (var k = 0; k < locs.length; k++) {
          var lid = locLayerId(locs[k]);
          if (lid !== null && seen["i" + lid] !== true) {
            seen["i" + lid] = true;
            distinct++;
          }
          if (entry.layers.length < MAX_USED_LAYERS) {
            var rec = layerRecord(locs[k]);
            if (rec) entry.layers.push(rec);
          }
        }
        entry.layer_count = distinct;
      }
      entries.push(entry);
    }
    return { supported: true, entries: entries, truncated: truncated };
  }

  function publicEntry(en) {
    return {
      postscript: en.postscript,
      family: en.family,
      style: en.style,
      is_substitute: en.is_substitute,
      uses: en.uses,
      layer_count: en.layer_count,
      layers: en.layers
    };
  }

  function entryMatches(en, spec) {
    if (spec.postscript !== undefined) return en.postscript === spec.postscript;
    return normF(en.family) === normF(spec.family) && normF(en.style) === normF(spec.style);
  }

  // args: { fonts?: [spec...] }  ->  the used fonts, or just those named
  A.inventoryUsedFonts = function (args) {
    args = args || {};
    var specs = null;
    if (args.fonts && typeof args.fonts.length === "number") {
      specs = [];
      for (var s = 0; s < args.fonts.length && s < MAX_CHECK_FONTS; s++) specs.push(toSpec(args.fonts[s], "fonts[]"));
    }
    var used = readUsedFonts(specs);
    if (!used.supported) return { supported: false, reason: used.reason, fonts: [] };
    var out = [];
    for (var i = 0; i < used.entries.length; i++) out.push(publicEntry(used.entries[i]));
    return { supported: true, fonts: out, truncated: used.truncated };
  };

  // ----- replace: the dry run, then the write -----

  function textOfLayer(layer, time) {
    try {
      var tp = layer.property("ADBE Text Properties");
      if (!tp) return null;
      var st = tp.property("ADBE Text Document");
      if (!st) return null;
      // Project.usedFonts times are layer time; valueAtTime takes comp time.
      var td = null;
      if (st.numKeys > 0 && typeof time === "number") {
        try {
          var stretch = 100;
          try { stretch = layer.stretch; } catch (eS) {}
          if (typeof stretch !== "number" || !isFinite(stretch)) stretch = 100;
          td = st.valueAtTime(layer.startTime + time * (stretch / 100), false);
        } catch (eT) {
          td = null;
        }
      }
      if (td === null || td === undefined) td = st.value;
      return String(td.text);
    } catch (e) {
      return null;
    }
  }

  function describeSide(spec, used) {
    var r = A.fontsResolve(spec);
    if (r.unchecked) return { unchecked: true, reason: r.reason };
    var side = { requested: specLabel(spec), exists: !!r.font, candidates: r.candidates || [] };
    if (r.font) {
      side.font = r.font;
      side.is_substitute = r.font.is_substitute === true;
    }
    if (r.reason) side.reason = r.reason;
    side.used = null;
    for (var i = 0; used && i < used.entries.length; i++) {
      if (entryMatches(used.entries[i], spec)) side.used = publicEntry(used.entries[i]);
    }
    return side;
  }

  // args: { from, to }
  A.inventoryReplacePlan = function (args) {
    args = args || {};
    var fonts = fontsApi();
    if (!fonts) return { ok: false, error: "unsupported", reason: noFontsReason() };
    var fromSpec = toSpec(args.from, "from");
    var toSpecV = toSpec(args.to, "to");
    var used = readUsedFonts([fromSpec, toSpecV]);
    if (!used.supported) return { ok: false, error: "unsupported", reason: used.reason };
    var from = describeSide(fromSpec, used);
    var to = describeSide(toSpecV, used);
    var plan = { ok: true, from: from, to: to, used_fonts_truncated: used.truncated };
    // A missing "from" font is the usual case: it is found by what the project uses, not by the installed list.
    if (from.used === null) {
      plan.from_used = false;
      plan.affected_layers = 0;
      plan.layers = [];
      if (!from.exists) plan.reason = "\"" + from.requested + "\" is neither installed nor used by the project.";
      else plan.reason = "No layer uses \"" + from.requested + "\"; there is nothing to replace.";
    } else {
      plan.from_used = true;
      plan.affected_layers = from.used.layer_count;
      plan.uses = from.used.uses;
      plan.layers = from.used.layers;
      plan.layers_truncated = from.used.uses > from.used.layers.length;
    }
    if (!to.exists) {
      plan.ok = false;
      plan.error = "font_not_found";
      plan.reason = "The replacement font \"" + to.requested + "\" is not installed.";
      return plan;
    }
    if (to.is_substitute === true) {
      plan.ok = false;
      plan.error = "font_substituted";
      plan.reason = "The replacement font \"" + to.requested + "\" would itself be substituted by After Effects.";
      return plan;
    }
    // Glyph coverage of the new font for the text of the affected layers (25.1).
    var warnings = [];
    var checked = 0;
    var unchecked = 0;
    var glyphReason = null;
    var toRaw = rawFont(toSpecV);
    var layers = plan.layers;
    for (var i = 0; i < layers.length && i < MAX_PLAN_LAYERS; i++) {
      var rec = layers[i];
      if (rec.resolved !== true) {
        unchecked++;
        continue;
      }
      var layer = null;
      try { layer = app.project.layerByID(rec.layer_id); } catch (e1) { layer = null; }
      var t = null;
      if (rec.times && rec.times.length > 0) t = rec.times[0];
      var text = null;
      if (layer) text = textOfLayer(layer, t);
      if (text === null || !toRaw) {
        unchecked++;
        continue;
      }
      var g = A.fontsGlyphCheck(toRaw, glyphText(text), MAX_GLYPH_CHARS);
      if (g.supported === null) {
        unchecked++;
        if (g.reason) glyphReason = g.reason;
        continue;
      }
      checked++;
      if (g.supported === false && warnings.length < 100) {
        warnings.push({ layer_id: rec.layer_id, layer: rec.layer, comp_id: rec.comp_id, comp: rec.comp, missing: g.missing });
      }
    }
    plan.glyphs = { checked_layers: checked, unchecked_layers: unchecked, warnings: warnings };
    if (glyphReason) plan.glyphs.reason = glyphReason;
    plan.glyphs.note = "Checked against each layer's whole text, so a mixed-font layer may report characters the replaced ranges do not use.";
    return plan;
  };

  // args: { from, to, no_font_locking, expect }
  A.inventoryReplaceFont = function (args) {
    assertGuard(args.expect);
    var fromSpec = toSpec(args.from, "from");
    var toSpecV = toSpec(args.to, "to");
    var noLock = args.no_font_locking === true;
    var canReplace = false;
    try { canReplace = typeof app.project.replaceFont === "function"; } catch (e0) {}
    if (!canReplace) fail("unsupported", "Project.replaceFont needs After Effects 24.5.");
    // Everything that can fail is checked before the call: replaceFont is not undoable.
    var used = readUsedFonts([fromSpec]);
    if (!used.supported) fail("unsupported", used.reason);
    var fromEntry = null;
    for (var i = 0; i < used.entries.length; i++) {
      if (entryMatches(used.entries[i], fromSpec)) fromEntry = used.entries[i];
    }
    if (fromEntry === null) {
      return { no_op: true, replaced: false, reason: "No layer uses \"" + specLabel(fromSpec) + "\"; nothing was changed." };
    }
    var toFont = rawFont(toSpecV);
    if (!toFont) fail("not_found", "The replacement font \"" + specLabel(toSpecV) + "\" is not installed.");
    var toSub = false;
    try { toSub = toFont.isSubstitute === true; } catch (e1) {}
    if (toSub) fail("bad_args", "The replacement font \"" + specLabel(toSpecV) + "\" would itself be substituted by After Effects.");
    var toPs = "";
    try { toPs = String(toFont.postScriptName); } catch (e2) {}
    if (toPs !== "" && toPs === fromEntry.postscript) {
      return { no_op: true, replaced: false, reason: "The font to replace and the new font are the same; nothing was changed." };
    }
    // The checkpoint the server made holds the saved file only: a project that went dirty since would lose those edits.
    var dirty = false;
    try { dirty = app.project.dirty === true; } catch (e3) {}
    if (dirty) {
      fail("checkpoint_required", "The project has unsaved changes the checkpoint does not hold, and replacing a font cannot be undone. Save it with ae_save first.");
    }
    var fromFont = fromEntry.font;
    var affected = fromEntry.layer_count;
    var fromPs = fromEntry.postscript;
    return A.withUndo(args.label || "Replace font", function () {
      // Project.replaceFont returns true when at least one layer changed.
      var changed = app.project.replaceFont(fromFont, toFont, noLock);
      if (changed === false) {
        return {
          no_op: true,
          replaced: false,
          layers_changed: false,
          from: fromPs,
          to: toPs,
          warning: "After Effects reported that no layer changed (replaceFont returned false).",
          undoable: false
        };
      }
      return {
        replaced: true,
        from: fromPs,
        to: toPs,
        no_font_locking: noLock,
        layers_affected: affected,
        undoable: false
      };
    });
  };
})($.global);
