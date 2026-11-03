// panel/host/ext/session.jsx
//
// Host function for the session tools:
// - sessionSnapshot (read): a compact picture of the open project (path, dirty
//   flag, revision, item ids, active item, render queue) and, for the comps
//   asked for plus the active comp, the layer count, selection, work area,
//   current time and a hash over layer ids, indexes, names and in/out points.
//   The server keeps one after each of its own writes and diffs the live state
//   against it, to tell what the user changed in between.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - A read: nothing is changed (not time, selection, active item or solo), so
//   nothing lands on Jay's undo stack. It only reads properties.
// - Project.revision is documented but its behaviour is unmeasured; it is
//   reported as a hint (null when AE does not give it), never relied on.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_ITEMS = 2000;
  // Layers hashed across ALL comps in one snapshot. A comp that does not fit whole is
  // skipped (hash empty, hash_truncated true), never hashed in part, so two snapshots
  // stay comparable. The layer count and the selection are still read.
  var HASH_BUDGET = 5000;
  var MAX_COMPS = 50;
  var TIME_PRECISION = 10000;

  function round4(n) {
    if (typeof n !== "number" || isNaN(n) || !isFinite(n)) return null;
    return Math.round(n * TIME_PRECISION) / TIME_PRECISION;
  }

  function projectPath() {
    var f = null;
    try { f = app.project.file; } catch (e0) { f = null; }
    if (!f) return "<unsaved>";
    return f.fsName;
  }

  // 32-bit string hash (Java style), folded into a running value.
  function mix(h, s) {
    var str = String(s);
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h;
  }

  function hex(h) {
    var s = (h >>> 0).toString(16);
    while (s.length < 8) s = "0" + s;
    return s;
  }

  function compById(id) {
    var item = null;
    try { item = app.project.itemByID(id); } catch (e) { item = null; }
    if (item && item instanceof CompItem) return item;
    return null;
  }

  function compState(comp, budget) {
    var out = {
      id: comp.id,
      name: comp.name,
      num_layers: comp.numLayers,
      selected: [],
      selected_truncated: false,
      work_area_start: null,
      work_area_duration: null,
      time: null,
      hash: "",
      hash_truncated: false
    };
    try { out.work_area_start = round4(comp.workAreaStart); } catch (e1) {}
    try { out.work_area_duration = round4(comp.workAreaDuration); } catch (e2) {}
    try { out.time = round4(comp.time); } catch (e3) {}
    var i;
    try {
      var sel = comp.selectedLayers;
      for (i = 0; i < sel.length; i++) {
        if (i >= MAX_LIST) {
          out.selected_truncated = true;
          break;
        }
        out.selected.push(sel[i].id);
      }
    } catch (e4) {}
    var h = 5381;
    var n = comp.numLayers;
    if (n > budget.left) {
      out.hash = "";
      out.hash_truncated = true;
      return out;
    }
    budget.left -= n;
    for (i = 1; i <= n; i++) {
      var l = comp.layer(i);
      var inP = null;
      var outP = null;
      try { inP = round4(l.inPoint); } catch (e5) {}
      try { outP = round4(l.outPoint); } catch (e6) {}
      h = mix(h, l.id + "|" + i + "|" + l.name + "|" + inP + "|" + outP + ";");
    }
    out.hash = hex(h);
    return out;
  }

  A.sessionSnapshot = function (args) {
    var wanted = [];
    var i;
    if (args && args.comp_ids) {
      for (i = 0; i < args.comp_ids.length && wanted.length < MAX_COMPS; i++) {
        if (typeof args.comp_ids[i] === "number") wanted.push(args.comp_ids[i]);
      }
    }

    var out = {
      project_path: projectPath(),
      dirty: null,
      revision: null,
      num_items: 0,
      item_ids: [],
      items_truncated: false,
      active_item: null,
      ae_version: null,
      build: null,
      render_queue: null,
      comps: []
    };
    try { out.dirty = app.project.dirty === true; } catch (e1) {}
    try {
      var rev = app.project.revision;
      if (typeof rev === "number") out.revision = rev;
    } catch (e2) {}
    try { if (app.version !== undefined) out.ae_version = String(app.version); } catch (e3) {}
    try { if (app.buildNumber !== undefined) out.build = String(app.buildNumber); } catch (e4) {}

    out.num_items = app.project.numItems;
    var count = out.num_items;
    if (count > MAX_ITEMS) {
      count = MAX_ITEMS;
      out.items_truncated = true;
    }
    for (i = 1; i <= count; i++) {
      try { out.item_ids.push(app.project.item(i).id); } catch (e5) {}
    }

    var active = null;
    try { active = app.project.activeItem; } catch (e6) { active = null; }
    if (active) {
      var kind = "other";
      if (active instanceof CompItem) kind = "comp";
      else if (active instanceof FolderItem) kind = "folder";
      else if (active instanceof FootageItem) kind = "footage";
      out.active_item = { id: active.id, name: active.name, kind: kind };
      if (kind === "comp") {
        var seen = false;
        for (i = 0; i < wanted.length; i++) {
          if (wanted[i] === active.id) seen = true;
        }
        if (!seen && wanted.length < MAX_COMPS) wanted.push(active.id);
      }
    }

    try {
      var rq = app.project.renderQueue;
      var info = { num_items: rq.numItems, queued: 0, rendering: 0 };
      if (typeof RQItemStatus !== "undefined") {
        for (i = 1; i <= rq.numItems && i <= MAX_LIST; i++) {
          var st = rq.item(i).status;
          if (st === RQItemStatus.QUEUED) info.queued++;
          if (st === RQItemStatus.RENDERING) info.rendering++;
        }
      }
      out.render_queue = info;
    } catch (e7) {}

    var budget = { left: HASH_BUDGET };
    for (i = 0; i < wanted.length; i++) {
      var comp = compById(wanted[i]);
      if (comp) {
        out.comps.push(compState(comp, budget));
      } else {
        out.comps.push({ id: wanted[i], missing: true });
      }
    }
    return out;
  };
})($.global);
