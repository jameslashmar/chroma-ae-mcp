// panel/host/ext/deliver.jsx
//
// Read-only host function for the delivery recipe tools (ae_deliver_recipe,
// ae_deliver_step, ae_deliver_status). The stages themselves are existing
// typed tools run from the server; this only tells the server what is open:
// - deliverRead: the project (path, saved, dirty), the comp being delivered
//   (size, rate, length, work area), optionally every comp, and the render
//   queue (comp, status, output files) so a recipe can be built from it
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Read only: nothing here changes the project, the selection, the time or
//   the render queue. When args.expect is given, the project is checked in
//   this same call so the ids returned belong to the project the caller meant.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_QUEUE = 100;
  var MAX_STRING = 20000;

  function clip(s) {
    var str = String(s);
    if (str.length > MAX_STRING) return str.substring(0, MAX_STRING);
    return str;
  }

  function itemById(id) {
    var item = null;
    try {
      item = app.project.itemByID(id);
    } catch (e) {
      item = null;
    }
    return item;
  }

  function folderName(comp) {
    try {
      if (comp.parentFolder) return clip(comp.parentFolder.name);
    } catch (e) {}
    return null;
  }

  function describeComp(c) {
    var out = {
      id: c.id,
      name: clip(c.name),
      folder: folderName(c),
      width: c.width,
      height: c.height,
      pixel_aspect: null,
      fps: c.frameRate,
      duration: c.duration,
      work_area_start: null,
      work_area_duration: null,
      num_layers: c.numLayers
    };
    try { out.pixel_aspect = c.pixelAspect; } catch (e1) {}
    try { out.work_area_start = c.workAreaStart; } catch (e2) {}
    try { out.work_area_duration = c.workAreaDuration; } catch (e3) {}
    return out;
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

  // Each render-queue item with its comp and the files its output modules
  // write. A module whose file can't be read (no output set yet) lists null.
  function readQueue() {
    var rq = null;
    var out = { num_items: 0, items: [], truncated: false };
    try {
      rq = app.project.renderQueue;
      out.num_items = rq.numItems;
    } catch (e0) {
      return { num_items: 0, items: [], truncated: false, unreadable: true };
    }
    var n = out.num_items;
    if (n > MAX_QUEUE) {
      out.truncated = true;
      n = MAX_QUEUE;
    }
    for (var i = 1; i <= n; i++) {
      var it = null;
      try {
        it = rq.item(i);
      } catch (e1) {
        it = null;
      }
      if (!it) continue;
      var entry = { index: i, comp_id: null, comp_name: null, status: null, outputs: [] };
      try {
        if (it.comp) {
          entry.comp_id = it.comp.id;
          entry.comp_name = clip(it.comp.name);
        }
      } catch (e2) {}
      try { entry.status = statusName(it.status); } catch (e3) {}
      var modules = 0;
      try { modules = it.numOutputModules; } catch (e4) { modules = 0; }
      if (modules > 10) modules = 10;
      for (var m = 1; m <= modules; m++) {
        var file = null;
        try {
          var om = it.outputModule(m);
          if (om && om.file) file = clip(om.file.fsName);
        } catch (e5) {
          file = null;
        }
        entry.outputs.push(file);
      }
      out.items.push(entry);
    }
    return out;
  }

  // args: expect {project_path} (checked in this call), comp_id (the comp to
  // describe), list_comps (also list every comp, 500 at most).
  A.deliverRead = function (args) {
    args = args || {};
    if (args.expect && args.expect.project_path !== undefined) {
      var g = A.checkGuard({ expect: { project_path: args.expect.project_path } });
      if (!g.ok) {
        return { guard_failed: true, project_path: g.project_path };
      }
    }
    var st = A.status();
    var out = {
      project_path: st.project_path,
      saved: st.project_path !== "<unsaved>",
      dirty: st.dirty === true,
      ae_version: st.aeVersion,
      comp: null,
      comp_found: null,
      comps: null,
      comps_total: null,
      truncated: false,
      render_queue: readQueue()
    };
    if (args.comp_id !== undefined && args.comp_id !== null) {
      var c = itemById(args.comp_id);
      if (c && c instanceof CompItem) {
        out.comp = describeComp(c);
        out.comp_found = true;
      } else {
        out.comp_found = false;
      }
    }
    if (args.list_comps === true) {
      var list = [];
      var total = 0;
      var n = app.project.numItems;
      for (var i = 1; i <= n; i++) {
        var it = null;
        try {
          it = app.project.item(i);
        } catch (e1) {
          it = null;
        }
        if (it && it instanceof CompItem) {
          total++;
          if (list.length < MAX_LIST) list.push(describeComp(it));
        }
      }
      out.comps = list;
      out.comps_total = total;
      out.truncated = total > MAX_LIST;
    }
    return out;
  };
})($.global);
