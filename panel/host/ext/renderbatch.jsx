// panel/host/ext/renderbatch.jsx
//
// Host function for the render-batch tools:
// - renderbatchRead (read): for the comps a batch names, how many comps in
//   the project carry each name (aerender -comp selects by name, so two is
//   ambiguous), their frame rate, duration, work area and size, and the
//   render-settings and output-module template names when the render queue
//   already has an item to read them from, and, for each listed comp, its
//   first QUEUED render-queue item (aerender -comp renders that item and,
//   without -RStemplate/-OMtemplate, uses its settings and every output module).
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Changes nothing in After Effects: no time, selection, active item or undo step.
//   (With an empty render queue the templates are not read: adding a temporary
//   item would mark the project changed. The server says so and moves on.)
// - The renders themselves run in aerender child processes on the Node side.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_NAMES = 500;
  var MAX_LIST = 500;
  var MAX_STRING = 20000;

  function clip(s) {
    s = String(s);
    if (s.length > MAX_STRING) return s.substring(0, MAX_STRING);
    return s;
  }

  function templatesOf(rqItem) {
    var rs = [];
    var om = [];
    var i;
    try {
      var t = rqItem.templates;
      for (i = 0; i < t.length && i < MAX_LIST; i++) rs.push(clip(t[i]));
    } catch (e1) {}
    try {
      var o = rqItem.outputModule(1).templates;
      for (i = 0; i < o.length && i < MAX_LIST; i++) om.push(clip(o[i]));
    } catch (e2) {}
    return { render_settings: rs, output_modules: om };
  }

  // The first queued render-queue item of each wanted comp name: its output
  // modules and their files. Reads only; the queue is walked, never changed.
  function queuedItemsFor(want) {
    var found = {};
    var queued = null;
    try { queued = RQItemStatus.QUEUED; } catch (e0) { return found; }
    var rq = app.project.renderQueue;
    var n = rq.numItems;
    var i;
    var j;
    for (i = 1; i <= n && i <= MAX_LIST; i++) {
      try {
        var rqi = rq.item(i);
        if (rqi.status !== queued) continue;
        var key = "n:" + rqi.comp.name;
        if (want[key] === undefined || found[key] !== undefined) continue;
        var q = { item_index: i, num_output_modules: 0, output_files: [] };
        try { q.num_output_modules = rqi.numOutputModules; } catch (e1) {}
        for (j = 1; j <= q.num_output_modules && j <= 20; j++) {
          try { q.output_files.push(clip(rqi.outputModule(j).file.fsName)); } catch (e2) { q.output_files.push(null); }
        }
        found[key] = q;
      } catch (e3) {}
    }
    return found;
  }

  A.renderbatchRead = function (args) {
    var names = (args && args.comp_names) || [];
    var want = {};
    var counts = {};
    var infos = {};
    var i;
    for (i = 0; i < names.length && i < MAX_NAMES; i++) {
      want["n:" + names[i]] = names[i];
    }

    var st = A.status();
    var compTotal = 0;
    var numItems = app.project.numItems;
    for (i = 1; i <= numItems; i++) {
      var it = app.project.item(i);
      if (!(it instanceof CompItem)) continue;
      compTotal++;
      var key = "n:" + it.name;
      if (want[key] === undefined) continue;
      if (counts[key] === undefined) {
        counts[key] = 0;
        var info = {
          id: it.id,
          name: clip(it.name),
          width: it.width,
          height: it.height,
          frame_rate: it.frameRate,
          duration: it.duration,
          work_area_start: null,
          work_area_duration: null,
          display_start_time: null
        };
        try { info.work_area_start = it.workAreaStart; } catch (e1) {}
        try { info.work_area_duration = it.workAreaDuration; } catch (e2) {}
        try { info.display_start_time = it.displayStartTime; } catch (e3) {}
        infos[key] = info;
      }
      counts[key]++;
    }

    var queuedInfo = {};
    try { queuedInfo = queuedItemsFor(want); } catch (e5) {}
    var comps = [];
    for (i = 0; i < names.length && i < MAX_NAMES; i++) {
      var k = "n:" + names[i];
      if (counts[k] === undefined) {
        comps.push({ name: clip(names[i]), count: 0 });
      } else {
        var c = infos[k];
        c.count = counts[k];
        if (queuedInfo[k] !== undefined) c.queued_item = queuedInfo[k];
        comps.push(c);
      }
    }

    var templates = { source: "none", render_settings: [], output_modules: [] };
    try {
      if (app.project.renderQueue.numItems > 0) {
        templates = templatesOf(app.project.renderQueue.item(1));
        templates.source = "existing_item";
      }
    } catch (e4) {}

    return {
      ae_version: st.aeVersion,
      project_path: st.project_path,
      dirty: st.dirty,
      comp_total: compTotal,
      comps: comps,
      templates: templates,
      truncated: names.length > MAX_NAMES
    };
  };
})($.global);
