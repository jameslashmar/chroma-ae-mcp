// panel/host/ext/timeline.jsx
//
// Host functions for the timeline tools (prefix: timeline):
// - timelineSelection (read): the keys selected in the timeline, per property
// - timelineKeysRead (read): every field of the keys of a list of properties
//   (what the receipt compares before and after)
// - timelineKeysTransform (guarded write; dry_run plans only): shift, scale,
//   reverse, move or copy keys, with every attribute kept
// - timelineDetectCuts (read for mode "list", guarded write otherwise): After
//   Effects' Scene Edit Detection on a footage layer
//
// AE has no call that moves a key. A transform reads every key through the
// helpers ext/stagger.jsx exposes (A.__keys.snapshot / write: value,
// interpolation, ease per dimension, tangents, continuity, auto-bezier,
// roving, label, selection), works out the new times, and writes the whole
// property again. stagger.jsx must be loaded first (the service loads ext files in
// name order).
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first, validate everything that can
//   fail before A.withUndo, and change things inside it.
// - Before and after reads run in separate evalScript calls from the server.
// - Reads change nothing in AE (no selection, time or active item).

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_KEYS_TOTAL = 1000;
  var MAX_TARGETS = 50;
  var MAX_WARNINGS = 20;
  var TIME_LIMIT = 10800;
  var SAME_TIME = 0.000001;
  var KEY_NAME_RX = /(^|[^A-Za-z0-9_$])(key|nearestKey|numKeys)\b/;

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
      fail(
        "guard",
        "Target guard refused mutation: the open project or comp does not match expect. Stop and re-read state.",
        {
          expected: expect,
          actual: { project_path: g.project_path, comp_id: g.comp_id, comp_is_valid: g.comp_is_valid }
        }
      );
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

  function findLayer(comp, sel) {
    var i;
    if (!sel) fail("bad_args", "layer selector missing");
    if (sel.id !== undefined && sel.id !== null) {
      for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).id === sel.id) return comp.layer(i);
      }
      fail("not_found", "No layer with id " + sel.id + " in comp " + comp.id);
    }
    if (sel.index !== undefined && sel.index !== null) {
      if (sel.index < 1 || sel.index > comp.numLayers) fail("not_found", "Layer index " + sel.index + " out of range");
      return comp.layer(sel.index);
    }
    if (sel.name !== undefined && sel.name !== null) {
      var count = 0;
      var found = null;
      for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === sel.name) {
          count++;
          if (!found) found = comp.layer(i);
        }
      }
      if (count === 0) fail("not_found", "No layer named \"" + sel.name + "\"");
      if (count > 1) fail("bad_args", count + " layers are named \"" + sel.name + "\"; select by id or index");
      return found;
    }
    fail("bad_args", "layer selector needs id, index or name");
    return null;
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  function warn(warnings, message) {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
  }

  function keysApi() {
    var K = A.__keys;
    if (!K || !K.snapshot || !K.write || !K.describe) {
      fail("bad_args", "The key helpers from stagger.jsx are not loaded; reload the panel service so ext/stagger.jsx loads before ext/timeline.jsx");
    }
    return K;
  }

  function checkTime(t, what) {
    if (typeof t !== "number" || !isFinite(t)) fail("bad_args", what + " is not a number");
    if (t < -TIME_LIMIT || t > TIME_LIMIT) fail("bad_args", what + " (" + t + "s) is outside AE's range of +-" + TIME_LIMIT + "s");
  }

  function pathKey(path) {
    var parts = [];
    for (var i = 0; i < path.length; i++) parts.push(String(path[i]));
    return parts.join("\u0001");
  }

  function lockedLayer(layer) {
    try {
      return layer.locked === true;
    } catch (e) {
      return false;
    }
  }

  // ---------- resolving properties ----------

  // One property on one layer, by the path ae_set_property takes. A path that ends on a group is refused.
  function resolveEntry(comp, t) {
    if (!t || !isArray(t.path) || t.path.length < 1) fail("bad_args", "Every target needs a property path");
    var layer = findLayer(comp, t.layer);
    var p = A.resolvePropertyPath(layer, t.path);
    if (p.propertyType !== PropertyType.PROPERTY) fail("bad_args", "\"" + t.path.join(" > ") + "\" is a group, not a property");
    return { layer: layer, prop: p, path: t.path };
  }

  function isSeparated(p) {
    try {
      return p.dimensionsSeparated === true;
    } catch (e) {
      return false;
    }
  }

  // A separated Position (the leader) has no keys of its own: its X, Y and Z followers do.
  // `follower` picks one dimension (0-based); without it every follower is used.
  function expandEntry(entry, follower) {
    var out = [];
    var d;
    var f;
    var leader = entry.prop;
    if (follower !== undefined && follower !== null) {
      f = null;
      try {
        f = leader.getSeparationFollower(follower);
      } catch (eF) {
        f = null;
      }
      if (!f) fail("not_found", "\"" + leader.name + "\" has no separated follower " + follower);
      out.push({ layer: entry.layer, prop: f, path: entry.path, follower: follower });
      return out;
    }
    if (!isSeparated(leader)) {
      out.push({ layer: entry.layer, prop: leader, path: entry.path, follower: null });
      return out;
    }
    for (d = 0; d < 3; d++) {
      f = null;
      try {
        f = leader.getSeparationFollower(d);
      } catch (eD) {
        f = null;
      }
      if (!f) break;
      out.push({ layer: entry.layer, prop: f, path: entry.path, follower: d });
    }
    if (out.length === 0) fail("bad_args", "\"" + leader.name + "\" has separated dimensions but its X/Y/Z followers could not be read");
    return out;
  }

  function jobLabel(e) {
    var s = "\"" + e.layer.name + "\" > " + e.prop.name;
    return s;
  }

  function hasKeyExpression(p) {
    var text = "";
    try {
      if (p.expressionEnabled !== true) return false;
      text = String(p.expression);
    } catch (e) {
      return false;
    }
    return KEY_NAME_RX.test(text);
  }

  function selectedIndexes(p) {
    var idx = [];
    var viaList = false;
    var a;
    try {
      var list = p.selectedKeys;
      if (list && list.length !== undefined) {
        for (a = 0; a < list.length; a++) idx.push(list[a]);
        viaList = true;
      }
    } catch (eList) {
      viaList = false;
    }
    if (!viaList) {
      for (var k = 1; k <= p.numKeys; k++) {
        try {
          if (p.keySelected(k) === true) idx.push(k);
        } catch (eKey) {
          break;
        }
      }
    }
    idx.sort(function (x, y) { return x - y; });
    return idx;
  }

  // ---------- reads ----------

  // Each layer's selected properties that have selected keys. layer.selectedProperties also lists
  // selected groups and keyless properties; those are skipped.
  A.timelineSelection = function (args) {
    var comp = requireComp(args.comp_id);
    var out = {
      comp_id: comp.id,
      name: comp.name,
      frameDuration: comp.frameDuration,
      time: comp.time,
      targets: [],
      truncated: false,
      source: "Layer.selectedProperties"
    };
    var n = comp.numLayers;
    if (n > MAX_LIST) {
      n = MAX_LIST;
      out.truncated = true;
      out.truncated_reason = "layers";
    }
    for (var i = 1; i <= n; i++) {
      var layer = comp.layer(i);
      var sel = [];
      try {
        sel = layer.selectedProperties;
      } catch (e1) {
        sel = [];
      }
      if (!sel) continue;
      for (var s = 0; s < sel.length; s++) {
        var p = sel[s];
        var keyed = false;
        try {
          keyed = p.propertyType === PropertyType.PROPERTY && p.numKeys > 0;
        } catch (e2) {
          keyed = false;
        }
        if (!keyed) continue;
        var idx = selectedIndexes(p);
        if (idx.length === 0) continue;
        if (out.targets.length >= MAX_TARGETS) {
          out.truncated = true;
          out.truncated_reason = "properties";
          break;
        }
        var pp = A.propertyPath(p);
        var times = [];
        for (var t = 0; t < idx.length && t < MAX_LIST; t++) times.push(p.keyTime(idx[t]));
        out.targets.push({
          layer_id: layer.id,
          layer_index: layer.index,
          layer_name: layer.name,
          path: pp.path,
          property: p.name,
          num_keys: p.numKeys,
          indexes: idx,
          times: times
        });
      }
    }
    return out;
  };

  // Every field of the keys of each listed property, in the order given. targets: [{layer, path, follower?}].
  A.timelineKeysRead = function (args) {
    var comp = requireComp(args.comp_id);
    var K = keysApi();
    var targets = args.targets;
    if (!targets || !isArray(targets)) fail("bad_args", "targets must be a list");
    if (targets.length > MAX_TARGETS) fail("bad_args", "At most " + MAX_TARGETS + " properties per read");
    var out = { comp_id: comp.id, frameDuration: comp.frameDuration, properties: [] };
    var total = 0;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var layer = findLayer(comp, t.layer);
      var p = A.resolvePropertyPath(layer, t.path);
      if (t.follower !== undefined && t.follower !== null) {
        p = p.getSeparationFollower(t.follower);
        if (!p) fail("not_found", "No separated follower " + t.follower);
      }
      var e = {
        layer_id: layer.id,
        path: t.path,
        follower: t.follower === undefined ? null : t.follower,
        name: p.name,
        numKeys: p.numKeys,
        spatial: false,
        keys: []
      };
      try { e.spatial = p.isSpatial === true; } catch (e1) {}
      e.signed_speed = hasSignedSpeed(p);
      if (p.numKeys > MAX_LIST) e.truncated = true;
      if (total + Math.min(p.numKeys, MAX_LIST) > MAX_KEYS_TOTAL + MAX_LIST) {
        e.truncated = true;
      } else {
        e.keys = K.describe(K.snapshot(p, MAX_LIST));
        total += e.keys.length;
      }
      out.properties.push(e);
    }
    return out;
  };

  // ---------- planning a transform ----------

  function cloneKey(s) {
    var c = {};
    for (var k in s) {
      if (s.hasOwnProperty(k)) c[k] = s[k];
    }
    return c;
  }

  // Both sides of a key's ease with the sign of speed flipped: playing a curve backwards turns its
  // slope round. Only a OneD / TwoD / ThreeD property has a signed speed per dimension; a spatial
  // property's speed is along the path and Color, Shape and the like have one unsigned speed, so
  // those pass unsigned = true and keep it.
  function flippedEase(list, unsigned) {
    if (!list) return list;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var sp = list[i].speed;
      if (!unsigned) {
        if (sp !== 0) sp = -sp;
      }
      out.push({ speed: sp, influence: list[i].influence });
    }
    return out;
  }

  function scaledEase(list, factor) {
    if (!list) return list;
    var out = [];
    for (var i = 0; i < list.length; i++) out.push({ speed: list[i].speed / factor, influence: list[i].influence });
    return out;
  }

  function reverseKey(c, unsigned) {
    var tmp = c.inInterp;
    c.inInterp = c.outInterp;
    c.outInterp = tmp;
    var eIn = c.inEase;
    var eOut = c.outEase;
    c.inEase = flippedEase(eOut, unsigned);
    c.outEase = flippedEase(eIn, unsigned);
    tmp = c.inTan;
    c.inTan = c.outTan;
    c.outTan = tmp;
  }

  // Does each dimension of this property's ease have a signed speed? (OneD, TwoD, ThreeD that are not spatial.)
  function hasSignedSpeed(p) {
    try {
      if (p.isSpatial === true) return false;
      var pvt = p.propertyValueType;
      return pvt === PropertyValueType.OneD || pvt === PropertyValueType.TwoD || pvt === PropertyValueType.ThreeD;
    } catch (e) {
      return false;
    }
  }

  function isSpatialProp(p) {
    try {
      return p.isSpatial === true;
    } catch (e) {
      return false;
    }
  }

  // One property, loaded and checked. `t` is {layer, path, follower?, indexes?, num_keys?}.
  function loadJobs(comp, t, filter, warnings, K, seen) {
    var entry = resolveEntry(comp, t);
    var list = expandEntry(entry, t.follower);
    var jobs = [];
    for (var j = 0; j < list.length; j++) {
      var e = list[j];
      var p = e.prop;
      var label = jobLabel(e);
      var key = e.layer.id + "|" + pathKey(e.path) + "|" + (e.follower === null ? "" : e.follower);
      // A separated Position given as the leader: only the dimensions that have keys are edited.
      if (p.numKeys < 1 && e.follower !== null && (t.follower === undefined || t.follower === null)) {
        warn(warnings, label + " has no keys and was left alone");
        continue;
      }
      if (seen[key]) fail("bad_args", label + " is listed twice");
      seen[key] = true;
      if (lockedLayer(e.layer)) fail("bad_args", "Layer \"" + e.layer.name + "\" is locked; unlock it first");
      if (p.numKeys < 1) fail("bad_args", label + " has no keys");
      if (p.numKeys > MAX_LIST) fail("bad_args", label + " has " + p.numKeys + " keys; at most " + MAX_LIST + " are rebuilt at once");
      if (t.num_keys !== undefined && t.num_keys !== null && t.num_keys !== p.numKeys) {
        fail("bad_args", label + ": its keys changed since the selection was read (" + t.num_keys + " then, " + p.numKeys + " now). Read again.");
      }
      var snap = K.snapshot(p, MAX_LIST);
      var n = snap.length;
      var want = null;
      var i;
      var idx;
      if (t.indexes && isArray(t.indexes) && t.indexes.length > 0) {
        want = {};
        for (i = 0; i < t.indexes.length; i++) {
          idx = t.indexes[i];
          if (typeof idx !== "number" || idx < 1 || idx > n || Math.floor(idx) !== idx) fail("bad_args", label + ": key " + idx + " out of range (1.." + n + ")");
          want[idx] = true;
        }
      }
      var fwant = null;
      if (filter && filter.indexes && isArray(filter.indexes) && filter.indexes.length > 0) {
        fwant = {};
        for (i = 0; i < filter.indexes.length; i++) {
          idx = filter.indexes[i];
          if (typeof idx !== "number" || idx < 1 || idx > n || Math.floor(idx) !== idx) fail("bad_args", label + ": key " + idx + " out of range (1.." + n + ")");
          fwant[idx] = true;
        }
      }
      var picks = [];
      for (i = 0; i < n; i++) {
        var one = i + 1;
        if (want && !want[one]) continue;
        if (fwant && !fwant[one]) continue;
        if (filter && filter.from !== undefined && filter.from !== null && snap[i].time < filter.from - 0.0005) continue;
        if (filter && filter.to !== undefined && filter.to !== null && snap[i].time > filter.to + 0.0005) continue;
        picks.push(i);
      }
      var spatial = isSpatialProp(p);
      if (hasKeyExpression(p)) {
        warn(warnings, label + " has an expression that reads key(n), nearestKey or numKeys; the key it reads may change meaning after the move");
      }
      for (i = 0; i < n; i++) {
        if (snap[i].roving === true) {
          warn(warnings, label + " has roving keys; AE retimes them itself, so their times may differ from the plan");
          break;
        }
      }
      jobs.push({
        layer: e.layer,
        prop: p,
        path: e.path,
        follower: e.follower,
        label: label,
        snap: snap,
        original: snap,
        picks: picks,
        spatial: spatial,
        signed: hasSignedSpeed(p),
        role: "edited"
      });
    }
    if (jobs.length === 0) fail("bad_args", "\"" + entry.prop.name + "\" has no keys");
    return jobs;
  }

  function isPicked(job, i) {
    for (var k = 0; k < job.picks.length; k++) {
      if (job.picks[k] === i) return true;
    }
    return false;
  }

  function sameFrame(a, b, fd) {
    return Math.round(a / fd) === Math.round(b / fd);
  }

  // Two keys on one time (or, when snapping, one frame, and one of them moved) would merge into one: refuse.
  function checkCollisions(label, entries, fd, snapOn) {
    var sorted = entries.slice(0);
    sorted.sort(function (a, b) { return a.time - b.time; });
    for (var i = 1; i < sorted.length; i++) {
      var a = sorted[i - 1];
      var b = sorted[i];
      var clash = Math.abs(b.time - a.time) < SAME_TIME;
      if (!clash && snapOn && fd > 0 && (a.moved || b.moved) && sameFrame(a.time, b.time, fd)) clash = true;
      if (clash) {
        fail("bad_args", label + ": two keys would land on the same " + (snapOn ? "frame" : "time") + " (" + b.time + "s); use another offset, factor or frame snapping setting, or remove one of the keys first");
      }
    }
  }

  function applySnap(t, fd, snapOn) {
    if (snapOn && fd > 0) return Math.round(t / fd) * fd;
    return t;
  }

  function addValues(v, delta) {
    if (typeof v === "number") return v + delta;
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(v[i] + delta[i]);
    return out;
  }

  function numericValue(v) {
    if (typeof v === "number") return isFinite(v);
    if (!isArray(v) || v.length === 0) return false;
    for (var i = 0; i < v.length; i++) {
      if (typeof v[i] !== "number" || !isFinite(v[i])) return false;
    }
    return true;
  }

  function subValues(a, b) {
    if (typeof a === "number") return a - b;
    var out = [];
    for (var i = 0; i < a.length; i++) out.push(a[i] - b[i]);
    return out;
  }

  // Everything the transform will do, worked out and checked; changes nothing.
  function buildPlan(comp, args) {
    var K = keysApi();
    var op = args.operation;
    if (!op || typeof op.type !== "string") fail("bad_args", "operation is missing");
    var type = op.type;
    if (type !== "shift" && type !== "scale" && type !== "reverse" && type !== "move_to" && type !== "copy_to") fail("bad_args", "Unknown operation \"" + type + "\"");
    var targets = args.targets;
    if (!targets || !isArray(targets) || targets.length === 0) fail("bad_args", "No target properties");
    if (targets.length > MAX_TARGETS) fail("bad_args", "At most " + MAX_TARGETS + " properties per call");
    var snapOn = args.snap !== false;
    var fd = comp.frameDuration;
    var warnings = [];
    var seen = {};
    var jobs = [];
    var i;
    var j;
    var k;
    for (i = 0; i < targets.length; i++) {
      var made = loadJobs(comp, targets[i], args.filter, warnings, K, seen);
      for (j = 0; j < made.length; j++) jobs.push(made[j]);
    }
    // A property none of whose keys pass the filter is left alone (and not rebuilt).
    var kept = [];
    for (i = 0; i < jobs.length; i++) {
      if (jobs[i].picks.length > 0) {
        kept.push(jobs[i]);
      } else {
        warn(warnings, jobs[i].label + ": no key passes the filter; left alone");
      }
    }
    jobs = kept;
    var total = 0;
    var tmin = null;
    var tmax = null;
    var picked = 0;
    for (i = 0; i < jobs.length; i++) {
      total += jobs[i].snap.length;
      for (k = 0; k < jobs[i].picks.length; k++) {
        var pt = jobs[i].snap[jobs[i].picks[k]].time;
        if (tmin === null || pt < tmin) tmin = pt;
        if (tmax === null || pt > tmax) tmax = pt;
        picked++;
      }
    }
    if (picked === 0) fail("bad_args", "No keys match that selection");
    if (type === "copy_to") {
      if (jobs.length !== 1) fail("bad_args", "copy_to copies the keys of one property; this target resolves to " + jobs.length + " (a separated Position copies per dimension: target X Position or Y Position)");
    }
    var plan = {
      type: type,
      snap: snapOn,
      frame_duration: fd,
      span: { from: tmin, to: tmax },
      picked: picked,
      jobs: jobs,
      warnings: warnings,
      dest: null,
      changed: false
    };
    var mapTime = null;
    var factor = 1;
    var reverse = false;
    var by = 0;
    if (type === "shift") {
      if (typeof op.by === "number") {
        by = op.by;
      } else if (typeof op.frames === "number") {
        by = op.frames * fd;
      } else {
        fail("bad_args", "shift needs by (seconds) or frames");
      }
      if (!isFinite(by)) fail("bad_args", "The shift is not a number");
      plan.by = by;
      mapTime = function (t) { return t + by; };
    } else if (type === "move_to") {
      if (typeof op.time !== "number" || !isFinite(op.time)) fail("bad_args", "move_to needs a time");
      by = op.time - tmin;
      plan.by = by;
      plan.target_time = op.time;
      mapTime = function (t) { return t + by; };
    } else if (type === "scale") {
      factor = op.factor;
      if (typeof factor !== "number" || !isFinite(factor) || factor <= 0) fail("bad_args", "scale needs a factor above 0");
      var pivotName = op.pivot;
      if (pivotName === undefined || pivotName === null) pivotName = "first_key";
      var pivot = tmin;
      if (pivotName === "time") {
        if (typeof op.pivot_time !== "number" || !isFinite(op.pivot_time)) fail("bad_args", "pivot 'time' needs pivot_time");
        pivot = op.pivot_time;
      } else if (pivotName === "playhead") {
        pivot = comp.time;
      } else if (pivotName !== "first_key") {
        fail("bad_args", "Unknown pivot \"" + pivotName + "\"");
      }
      plan.factor = factor;
      plan.pivot = pivot;
      plan.pivot_mode = pivotName;
      mapTime = function (t) { return pivot + (t - pivot) * factor; };
    } else if (type === "reverse") {
      reverse = true;
      var sum = tmin + tmax;
      plan.reverse = true;
      mapTime = function (t) { return sum - t; };
    }

    if (type === "copy_to") {
      buildCopy(comp, args, op, plan, jobs[0], K, snapOn, fd);
      return plan;
    }

    var any = false;
    for (i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      var fresh = [];
      var entries = [];
      for (k = 0; k < job.snap.length; k++) {
        var c = cloneKey(job.snap[k]);
        c._old = k + 1;
        c._moved = false;
        if (isPicked(job, k)) {
          var nt = applySnap(mapTime(job.snap[k].time), fd, snapOn);
          checkTime(nt, "A key time on " + job.label);
          c._moved = true;
          c.time = nt;
          if (Math.abs(nt - job.snap[k].time) > 0.000000001) any = true;
          if (reverse) reverseKey(c, job.signed !== true);
          if (factor !== 1) {
            c.inEase = scaledEase(c.inEase, factor);
            c.outEase = scaledEase(c.outEase, factor);
          }
        }
        fresh.push(c);
        entries.push({ time: c.time, moved: c._moved });
      }
      checkCollisions(job.label, entries, fd, snapOn);
      fresh.sort(function (a, b) { return a.time - b.time; });
      var moves = [];
      for (k = 0; k < fresh.length; k++) {
        if (fresh[k]._moved) {
          moves.push({ from_index: fresh[k]._old, new_index: k + 1, from: job.snap[fresh[k]._old - 1].time, to: fresh[k].time });
        }
      }
      job.fresh = fresh;
      job.moves = moves;
      for (k = 0; k < moves.length; k++) {
        if (moves[k].to > comp.duration + 0.0005 || moves[k].to < -0.0005) {
          warn(warnings, job.label + ": a key lands outside the comp (" + moves[k].to + "s, the comp runs 0 to " + comp.duration + "s)");
          break;
        }
      }
    }
    if (reverse && picked >= 2) any = true;
    if (type === "scale" && factor !== 1) any = true;
    plan.changed = any;
    plan.total_keys = total;
    if (total > MAX_KEYS_TOTAL) {
      fail("bad_args", total + " keys would be rebuilt; at most " + MAX_KEYS_TOTAL + " per call. Split the properties into batches.");
    }
    return plan;
  }

  // copy_to: the picked keys of the one source property, added to another property.
  function buildCopy(comp, args, op, plan, src, K, snapOn, fd) {
    var warnings = plan.warnings;
    if (!op.layer || !isArray(op.path) || op.path.length < 1) fail("bad_args", "copy_to needs a destination layer and path");
    var entry = resolveEntry(comp, { layer: op.layer, path: op.path });
    if (isSeparated(entry.prop)) fail("bad_args", jobLabel(entry) + " has separated dimensions; copy to its X or Y Position property instead");
    var dp = entry.prop;
    var label = jobLabel(entry);
    if (lockedLayer(entry.layer)) fail("bad_args", "Layer \"" + entry.layer.name + "\" is locked; unlock it first");
    if (entry.layer.id === src.layer.id && pathKey(entry.path) === pathKey(src.path) && src.follower === null) {
      fail("bad_args", "The destination is the source property");
    }
    if (dp === src.prop) fail("bad_args", "The destination is the source property");
    if (dp.matchName !== src.prop.matchName || dp.propertyValueType !== src.prop.propertyValueType) {
      fail("bad_args", label + " is a different kind of property from the source (" + dp.matchName + " vs " + src.prop.matchName + ")");
    }
    try {
      if (dp.canVaryOverTime === false) fail("bad_args", label + " can't be keyframed");
    } catch (eCan) {
      if (eCan.__kind) throw eCan;
    }
    if (dp.numKeys > MAX_LIST) fail("bad_args", label + " has " + dp.numKeys + " keys; at most " + MAX_LIST + " are rebuilt at once");
    if (dp.numKeys + src.picks.length > MAX_LIST) fail("bad_args", "The destination would hold more than " + MAX_LIST + " keys");
    if (hasKeyExpression(dp)) warn(warnings, label + " has an expression that reads key(n), nearestKey or numKeys; copied keys change what it reads");
    var shiftBy = 0;
    var hasAt = false;
    if (op.at_time !== undefined && op.at_time !== null) {
      if (typeof op.at_time !== "number" || !isFinite(op.at_time)) fail("bad_args", "at_time is not a number");
      shiftBy = op.at_time - plan.span.from;
      hasAt = true;
    }
    var destSnap = K.snapshot(dp, MAX_LIST);
    var fresh = [];
    var entries = [];
    var i;
    for (i = 0; i < destSnap.length; i++) {
      var d = cloneKey(destSnap[i]);
      d._moved = false;
      d._old = 0;
      fresh.push(d);
      entries.push({ time: d.time, moved: false });
    }
    var relative = op.relative_value === true;
    var delta = null;
    var firstIdx = src.picks[0];
    var firstNew = applySnap(src.snap[firstIdx].time + shiftBy, fd, snapOn);
    if (relative) {
      var srcFirst = src.snap[firstIdx].value;
      var destNow = null;
      try {
        // Before any expression, with or without keys: the delta must not include a wiggle sample.
        if (dp.numKeys > 0) destNow = dp.valueAtTime(firstNew, true);
        else destNow = dp.valueAtTime(0, true);
      } catch (eNow) {
        destNow = null;
      }
      if (!numericValue(srcFirst) || destNow === null || !numericValue(destNow)) {
        fail("bad_args", "relative_value needs a numeric property (a number or a list of numbers)");
      }
      if (isArray(srcFirst) && (!isArray(destNow) || destNow.length !== srcFirst.length)) {
        fail("bad_args", "relative_value: the destination's value has another number of dimensions");
      }
      delta = subValues(destNow, srcFirst);
      plan.delta = delta;
    }
    var added = [];
    for (i = 0; i < src.picks.length; i++) {
      var s = src.snap[src.picks[i]];
      var c = cloneKey(s);
      c.time = applySnap(s.time + shiftBy, fd, snapOn);
      checkTime(c.time, "A key time on " + label);
      if (relative) {
        if (!numericValue(s.value)) fail("bad_args", "relative_value needs numeric keys");
        c.value = addValues(s.value, delta);
      }
      c.selected = false;
      c._moved = true;
      c._old = src.picks[i] + 1;
      c._src = src.picks[i] + 1;
      added.push(c);
      fresh.push(c);
      entries.push({ time: c.time, moved: true });
    }
    checkCollisions(label, entries, fd, snapOn);
    fresh.sort(function (a, b) { return a.time - b.time; });
    var moves = [];
    for (i = 0; i < fresh.length; i++) {
      if (fresh[i]._moved) {
        moves.push({ from_index: fresh[i]._src, new_index: i + 1, from: src.snap[fresh[i]._src - 1].time, to: fresh[i].time });
      }
    }
    var origValue = null;
    var hasOrig = false;
    if (dp.numKeys === 0) {
      try {
        origValue = dp.valueAtTime(0, true);
        hasOrig = true;
      } catch (eV) {
        hasOrig = false;
      }
    }
    src.role = "source";
    src.moves = [];
    src.fresh = null;
    plan.dest = {
      layer: entry.layer,
      prop: dp,
      path: entry.path,
      follower: null,
      label: label,
      snap: destSnap,
      original: destSnap,
      fresh: fresh,
      moves: moves,
      picks: [],
      spatial: isSpatialProp(dp),
      signed: hasSignedSpeed(dp),
      role: "destination",
      origValue: origValue,
      hasOrigValue: hasOrig
    };
    plan.changed = added.length > 0;
    plan.at_time = hasAt ? op.at_time : null;
    plan.total_keys = src.snap.length + destSnap.length + added.length;
    if (plan.total_keys > MAX_KEYS_TOTAL) fail("bad_args", plan.total_keys + " keys would be involved; at most " + MAX_KEYS_TOTAL + " per call");
  }

  // The plan as plain data (what the dry run returns and the receipt checks).
  function describePlan(plan, comp) {
    var out = {
      operation: plan.type,
      snap: plan.snap,
      frame_duration: plan.frame_duration,
      span: plan.span,
      keys_selected: plan.picked,
      changed: plan.changed,
      targets: [],
      warnings: plan.warnings
    };
    if (plan.by !== undefined) out.by = plan.by;
    if (plan.target_time !== undefined) out.target_time = plan.target_time;
    if (plan.factor !== undefined) {
      out.factor = plan.factor;
      out.pivot = plan.pivot;
      out.pivot_mode = plan.pivot_mode;
    }
    if (plan.reverse) out.reverse = true;
    if (plan.delta !== undefined) out.delta = plan.delta;
    if (plan.at_time !== undefined) out.at_time = plan.at_time;
    var list = plan.jobs.slice(0);
    if (plan.dest) list.push(plan.dest);
    for (var i = 0; i < list.length; i++) {
      var job = list[i];
      var picks = [];
      for (var k = 0; k < job.picks.length; k++) picks.push(job.picks[k] + 1);
      out.targets.push({
        role: job.role,
        layer_id: job.layer.id,
        layer_index: job.layer.index,
        layer_name: job.layer.name,
        path: job.path,
        follower: job.follower,
        property: job.prop.name,
        num_keys: job.snap.length,
        indexes: picks,
        moves: job.moves || []
      });
    }
    return out;
  }

  function restoreJobs(done, K) {
    var failures = [];
    for (var r = done.length - 1; r >= 0; r--) {
      try {
        K.write(done[r].prop, done[r].original, 0, [], done[r].label);
        if (done[r].hasOrigValue === true && done[r].original.length === 0) done[r].prop.setValue(done[r].origValue);
      } catch (eRs) {
        failures.push("the original keys of " + done[r].label + " could not be put back: " + eRs.message);
      }
    }
    return failures;
  }

  A.timelineKeysTransform = function (args) {
    var dry = args.dry_run === true;
    if (!dry) assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var plan = buildPlan(comp, args);
    var out = describePlan(plan, comp);
    if (dry) {
      out.dry_run = true;
      return out;
    }
    if (!plan.changed) {
      out.no_op = true;
      return out;
    }
    var K = keysApi();
    var writes = [];
    var i;
    for (i = 0; i < plan.jobs.length; i++) {
      if (plan.jobs[i].fresh) writes.push(plan.jobs[i]);
    }
    if (plan.dest) writes.push(plan.dest);
    var label = args.label || "Transform keyframes";
    var result = A.withUndo(label, function () {
      var done = [];
      var wrote = [];
      var failed = [];
      try {
        for (var w = 0; w < writes.length; w++) {
          var jb = writes[w];
          done.push(jb);
          K.write(jb.prop, jb.fresh, 0, wrote, jb.label);
        }
      } catch (ePost) {
        failed = restoreJobs(done, K);
        if (failed.length) {
          try {
            ePost.message = ePost.message + " (the rollback was incomplete, so After Effects was left changed: " + failed.join("; ") + "; inspect before retrying)";
          } catch (eMsg) {}
        }
        throw ePost;
      }
      return { write_warnings: wrote };
    });
    for (i = 0; i < result.write_warnings.length && out.warnings.length < MAX_WARNINGS; i++) out.warnings.push(result.write_warnings[i]);
    return out;
  };

  // ---------- scene edit detection ----------

  var CUT_MODES = { list: "NONE", markers: "MARKERS", split: "SPLIT", split_precomp: "SPLIT_PRECOMP" };

  function isAVLayer(layer) {
    try {
      if (typeof AVLayer !== "undefined") return layer instanceof AVLayer;
    } catch (e) {}
    try {
      return layer.hasVideo !== undefined && layer.source !== undefined;
    } catch (e2) {}
    return false;
  }

  function cutsChecks(layer, write) {
    if (!isAVLayer(layer)) fail("bad_args", "Layer \"" + layer.name + "\" is not a footage or pre-comp layer (Scene Edit Detection works on video AV layers)");
    var hasVideo = false;
    try {
      hasVideo = layer.hasVideo === true;
    } catch (e1) {
      hasVideo = false;
    }
    if (!hasVideo) fail("bad_args", "Layer \"" + layer.name + "\" has no video");
    var src = null;
    try {
      src = layer.source;
    } catch (e2) {
      src = null;
    }
    if (!src) fail("bad_args", "Layer \"" + layer.name + "\" has no source item");
    var solid = false;
    try {
      if (typeof SolidSource !== "undefined" && src.mainSource instanceof SolidSource) solid = true;
      if (typeof PlaceholderSource !== "undefined" && src.mainSource instanceof PlaceholderSource) solid = true;
    } catch (e3) {
      solid = false;
    }
    if (solid) fail("bad_args", "Layer \"" + layer.name + "\" is a solid or placeholder, not footage or a pre-comp");
    var remap = false;
    try {
      remap = layer.timeRemapEnabled === true;
    } catch (e4) {
      remap = false;
    }
    if (remap) fail("bad_args", "Layer \"" + layer.name + "\" has time remapping on, and Scene Edit Detection fails on time-remapped layers; turn it off first");
    if (typeof layer.doSceneEditDetection !== "function") {
      fail("bad_args", "This After Effects has no AVLayer.doSceneEditDetection (it needs AE 22.3 or newer)");
    }
    if (typeof SceneEditDetectionMode === "undefined") {
      fail("bad_args", "This After Effects has no SceneEditDetectionMode enum (it needs AE 22.3 or newer)");
    }
    if (write && lockedLayer(layer)) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first");
    return src;
  }

  function sceneMode(name) {
    var m = null;
    try {
      m = SceneEditDetectionMode[name];
    } catch (e) {
      m = null;
    }
    if (m === undefined || m === null) fail("bad_args", "This After Effects has no SceneEditDetectionMode." + name);
    return m;
  }

  function cutTimes(res) {
    var out = [];
    if (res && isArray(res)) {
      for (var i = 0; i < res.length && i < MAX_LIST; i++) {
        if (typeof res[i] === "number") out.push(res[i]);
      }
      return { times: out, count: res.length, known: true };
    }
    return { times: out, count: 0, known: false };
  }

  A.timelineDetectCuts = function (args) {
    var mode = args.mode;
    if (mode === undefined || mode === null) mode = "list";
    if (!CUT_MODES.hasOwnProperty(mode)) fail("bad_args", "Unknown mode \"" + mode + "\"");
    var write = mode !== "list";
    if (write) assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var src = cutsChecks(layer, write);
    var apply = sceneMode(CUT_MODES[mode]);
    var info = {
      mode: mode,
      layer_id: layer.id,
      layer_index: layer.index,
      layer_name: layer.name,
      source_name: "",
      clip_duration: null,
      layer_duration: layer.outPoint - layer.inPoint,
      in_point: layer.inPoint,
      out_point: layer.outPoint,
      frame_duration: comp.frameDuration,
      num_layers_before: comp.numLayers
    };
    try { info.source_name = String(src.name); } catch (e1) {}
    try { info.clip_duration = src.duration; } catch (e2) {}
    var res;
    var cuts;
    if (!write) {
      res = layer.doSceneEditDetection(apply);
      cuts = cutTimes(res);
      info.cuts = cuts.times;
      info.cut_count = cuts.count;
      info.cuts_truncated = cuts.count > cuts.times.length;
      info.cuts_known = cuts.known;
      info.time_base = "composition time (as the Scripting Guide states)";
      return info;
    }
    var out = A.withUndo(args.label || ("Scene edit detection: " + mode), function () {
      var r = layer.doSceneEditDetection(apply);
      return cutTimes(r);
    });
    info.cuts = out.times;
    info.cut_count = out.count;
    info.cuts_truncated = out.count > out.times.length;
    info.cuts_known = out.known;
    // No no_op here: the undo group was opened, and AE may have recorded a step of its own.
    if (out.known && out.count === 0) info.message = "No cuts were found; the layer was not changed.";
    return info;
  };
})($.global);
