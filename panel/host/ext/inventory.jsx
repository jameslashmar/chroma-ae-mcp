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
})($.global);
