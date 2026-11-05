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
//   With rq_items ([{ rq_index }]) it also reads those Render Queue items for
//   aerender -rqindex: status, comp, time span, frame rate and every output
//   module (name, file), so the plan can count each output.
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

  var STATUS_NAMES = ["WILL_CONTINUE", "NEEDS_OUTPUT", "UNQUEUED", "QUEUED", "RENDERING", "USER_STOPPED", "ERR_STOPPED", "DONE"];

  function statusNameOf(v) {
    var i;
    if (typeof RQItemStatus === "undefined") return String(v);
    for (i = 0; i < STATUS_NAMES.length; i++) {
      try {
        if (RQItemStatus[STATUS_NAMES[i]] === v) return STATUS_NAMES[i].toLowerCase();
      } catch (e0) {}
    }
    return String(v);
  }

  // The Render Queue items a batch names by index (aerender -rqindex): what the
  // plan needs to count every output module. Reads only.
  function queueItemReads(wanted) {
    var out = [];
    var rq = app.project.renderQueue;
    var total = rq.numItems;
    var i;
    var j;
    for (i = 0; i < wanted.length && i < MAX_NAMES; i++) {
      var n = wanted[i];
      var row = { index: n, found: false };
      if (typeof n === "number" && n >= 1 && n <= total && n === Math.floor(n)) {
        try {
          var it = rq.item(n);
          var comp = it.comp;
          row.found = true;
          row.comp_id = comp.id;
          row.comp_name = clip(comp.name);
          row.comp_duration = comp.duration;
          row.comp_frame_rate = comp.frameRate;
          row.status = statusNameOf(it.status);
          row.render = it.render === true;
          try { row.time_span_start = it.timeSpanStart; } catch (e1) {}
          try { row.time_span_duration = it.timeSpanDuration; } catch (e2) {}
          try { row.skip_frames = it.skipFrames; } catch (e3) {}
          row.num_output_modules = it.numOutputModules;
          row.output_modules = [];
          for (j = 1; j <= it.numOutputModules && j <= 20; j++) {
            var om = { index: j, name: null, file: null };
            try { om.name = clip(it.outputModule(j).name); } catch (e4) {}
            try { om.file = clip(it.outputModule(j).file.fsName); } catch (e5) {}
            row.output_modules.push(om);
          }
          if (it.numOutputModules > 20) row.output_modules_truncated = true;
        } catch (e6) {
          row.found = false;
          row.error = String(e6);
        }
      }
      out.push(row);
    }
    return out;
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

    var res = {
      ae_version: st.aeVersion,
      project_path: st.project_path,
      dirty: st.dirty,
      comp_total: compTotal,
      comps: comps,
      templates: templates,
      truncated: names.length > MAX_NAMES
    };
    var rqWanted = [];
    var q;
    if (args && args.rq_items && args.rq_items.length) {
      for (q = 0; q < args.rq_items.length; q++) rqWanted.push(args.rq_items[q].rq_index);
      try {
        res.queue_total = app.project.renderQueue.numItems;
        res.queue_items = queueItemReads(rqWanted);
      } catch (e7) {
        res.queue_items = [];
        res.queue_error = String(e7);
      }
    }
    return res;
  };
})($.global);
