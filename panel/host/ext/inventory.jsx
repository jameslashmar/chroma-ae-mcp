// panel/host/ext/inventory.jsx
//
// Read-only host functions for the project inventory tools:
// - compTree: which comps nest which, where a comp is used, unused comps
// - fontsInUse: the fonts text layers use (keyframed source text too), and
//   which are missing or substituted (AE 24+ font API; unknown before)
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Read only: nothing here changes the project, the selection or the time.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_LAYER_VISITS = 50000;
  var MAX_USES = 20;
  var MAX_TEXT_KEYS = 20;

  function fail(kind, message) {
    var e = new Error(message);
    e.__kind = kind;
    throw e;
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

    function up(id, depth, seen) {
      var ps = parents[id] || [];
      var out = [];
      for (var k = 0; k < ps.length; k++) {
        if (nodes >= MAX_LIST) return out;
        nodes++;
        var e = ps[k];
        var node = { id: e.parent, name: byId[e.parent].name, layer: { index: e.layer_index, name: e.layer_name } };
        if (seen[e.parent]) node.repeated = true;
        else if (depth < depthLimit) {
          seen[e.parent] = true;
          node.used_in = up(e.parent, depth + 1, seen);
          seen[e.parent] = false;
        } else if ((parents[e.parent] || []).length) node.deeper = true;
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
    function height(id, seen) {
      var kids = children[id] || [];
      var h = 0;
      for (var k = 0; k < kids.length; k++) {
        var cid = kids[k].child;
        if (seen[cid]) continue;
        seen[cid] = true;
        var sub = 1 + height(cid, seen);
        seen[cid] = false;
        if (sub > h) h = sub;
        if (h > 50) return h;
      }
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
      var seenH = {};
      seenH[cp.id] = true;
      list.push({
        id: cp.id,
        name: cp.name,
        used_in: parents[cp.id].length,
        contains: nKids,
        nesting_depth: height(cp.id, seenH),
        in_render_queue: queued[cp.id] === true
      });
    }
    var top = [];
    var unused = [];
    for (i = 0; i < list.length; i++) {
      if (list[i].used_in === 0) {
        if (list[i].in_render_queue || list[i].contains > 0) top.push({ id: list[i].id, name: list[i].name });
        else unused.push({ id: list[i].id, name: list[i].name });
      }
    }
    return {
      num_comps: comps.length,
      comps: list,
      top_level: top,
      unused: unused,
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
        var l = c.layer(j);
        var isText = false;
        try { isText = String(l.reflect.name) === "TextLayer"; } catch (eT) {}
        if (!isText) continue;
        textLayers++;
        var st = l.property("ADBE Text Properties").property("ADBE Text Document");
        if (st.numKeys > 0) {
          var n = st.numKeys;
          if (n > MAX_TEXT_KEYS) n = MAX_TEXT_KEYS;
          for (var k = 1; k <= n; k++) note(st.keyValue(k), c, l, k);
        } else {
          note(st.value, c, l, null);
        }
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
      partial: partial
    };
  };
})($.global);
