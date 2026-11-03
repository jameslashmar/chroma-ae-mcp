// panel/host/ext/describe.jsx
//
// Host function for the describe tool:
// - describeRead (read): one pass over a comp's layers (a page of up to 500)
//   returning role flags, in/out points, parents and mattes, expression
//   presence and the layer names they mention, markers, and the keyframed
//   segments (start, end, from, to, overshoot) the server clusters into beats.
//   It also returns the comp's own markers and how precomps nest.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Read-only: nothing here sets a value, a time, a selection or a resolution.
// - Bounded: 500 layers, MAX_VISITED properties, MAX_SEGMENTS segments, MAX_SAMPLES
//   valueAtTime calls; whatever is cut short says so in the result.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var DEFAULT_PAGE = 200;
  var MAX_VISITED = 40000;
  var MAX_DEPTH = 16;
  var MAX_SEGMENTS = 1500;
  var SEGMENTS_PER_LAYER = 60;
  var MAX_SAMPLES = 4000;
  var SAMPLES_PER_SEGMENT = 6;
  var MAX_OVERSHOOT_KEYS = 40;
  var MAX_COMP_MARKERS = 100;
  var MAX_LAYER_MARKERS = 20;
  var MAX_MARKERS_TOTAL = 200;
  var MAX_EXPR_PROPS = 8;
  var MAX_EXPR_REFS = 50;
  var EXPR_SAMPLES = 8;
  var EXPR_MIN_CHANGE = 0.01;
  var MAX_XREF_LAYERS = 2000;
  var TRANSFORM_GROUP = "ADBE Transform Group";
  var MAX_EXPR_SCAN = 20000;
  var MAX_NEST_NODES = 100;
  var MAX_NEST_DEPTH = 4;
  var TEXT_PREVIEW = 120;
  var COMMENT_MAX = 200;

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

  function r2(x) {
    return Math.round(x * 100) / 100;
  }

  function r3(x) {
    return Math.round(x * 1000) / 1000;
  }

  function clip(s, n) {
    var str = String(s);
    if (str.length > n) return str.substring(0, n) + "...";
    return str;
  }

  // The same roles as layers.jsx: reflect.name for the special classes (an
  // AVLayer is everything else), then flags for null, adjustment, precomp,
  // solid and audio-only.
  function layerRole(l) {
    var reflectName = "";
    try {
      if (l.reflect && l.reflect.name) reflectName = String(l.reflect.name);
    } catch (e0) {}
    if (reflectName === "TextLayer") return "text";
    if (reflectName === "ShapeLayer") return "shape";
    if (reflectName === "CameraLayer") return "camera";
    if (reflectName === "LightLayer") return "light";
    try {
      if (l.nullLayer) return "null";
    } catch (e1) {}
    try {
      if (l.adjustmentLayer) return "adjustment";
    } catch (e2) {}
    try {
      if (l.source && l.source instanceof CompItem) return "precomp";
    } catch (e3) {}
    try {
      if (l.source && l.source.mainSource && l.source.mainSource instanceof SolidSource) return "solid";
    } catch (e4) {}
    try {
      if (l.hasAudio && !l.hasVideo) return "audio";
    } catch (e5) {}
    if (reflectName === "AVLayer") return "footage";
    return reflectName.toLowerCase();
  }

  function matteName(t) {
    if (t === TrackMatteType.ALPHA) return "alpha";
    if (t === TrackMatteType.ALPHA_INVERTED) return "alpha_inverted";
    if (t === TrackMatteType.LUMA) return "luma";
    if (t === TrackMatteType.LUMA_INVERTED) return "luma_inverted";
    return "none";
  }

  // How a property's keys are described; null for kinds with nothing to say.
  function valueKind(p) {
    var vt = null;
    try {
      vt = p.propertyValueType;
    } catch (e) {
      return null;
    }
    if (vt === PropertyValueType.OneD) return "1d";
    if (vt === PropertyValueType.TwoD) return "2d";
    if (vt === PropertyValueType.ThreeD) return "3d";
    if (vt === PropertyValueType.TwoD_SPATIAL) return "2d_spatial";
    if (vt === PropertyValueType.ThreeD_SPATIAL) return "3d_spatial";
    if (vt === PropertyValueType.COLOR) return "color";
    if (vt === PropertyValueType.SHAPE) return "shape";
    if (vt === PropertyValueType.TEXT_DOCUMENT) return "text";
    return null;
  }

  function isNumericKind(kind) {
    return kind === "1d" || kind === "2d" || kind === "3d" || kind === "2d_spatial" || kind === "3d_spatial" || kind === "color";
  }

  // A key value as up to four rounded numbers.
  function asNums(v) {
    var out = [];
    var i;
    if (typeof v === "number") {
      out.push(r2(v));
      return out;
    }
    if (v && typeof v === "object" && v.length !== undefined) {
      for (i = 0; i < v.length && i < 4; i++) {
        if (typeof v[i] === "number") out.push(r2(v[i]));
      }
    }
    return out;
  }

  function sameNums(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > 0.0005) return false;
    }
    return true;
  }

  function expressionActive(p) {
    try {
      if (p.canSetExpression && p.expressionEnabled && p.expression !== "") return true;
    } catch (e) {}
    return false;
  }

  // Names of the layers an expression mentions as layer("Name"). A heuristic:
  // expressions that build the name or use layer(index) are not seen.
  // expr is the layer's expressions record. refs_truncated says the list is
  // not complete (cap reached, text cut, too many matches), so the server
  // does not judge "unused" from it. Names are clipped like layer names (200).
  function addRefs(text, expr) {
    var re = /layer\(\s*(?:"([^"]*)"|'([^']*)')\s*\)/g;
    var m;
    var guard = 0;
    var s = text;
    if (s.length > MAX_EXPR_SCAN) {
      s = s.substring(0, MAX_EXPR_SCAN);
      expr.refs_truncated = true;
    }
    while ((m = re.exec(s)) !== null) {
      if (guard >= 200) {
        expr.refs_truncated = true;
        break;
      }
      guard++;
      var rawName = m[1];
      if (rawName === undefined || rawName === null || rawName === "") rawName = m[2];
      if (rawName === undefined || rawName === null) rawName = "";
      var name = clip(rawName, 200);
      var seen = false;
      for (var i = 0; i < expr.refs.length; i++) {
        if (expr.refs[i] === name) seen = true;
      }
      if (seen) continue;
      if (expr.refs.length < MAX_EXPR_REFS) {
        expr.refs.push(name);
      } else {
        expr.refs_truncated = true;
      }
    }
  }

  // A property's name path inside its layer, shortest useful form: Transform
  // properties (found by the group's matchName, not its localized name) by
  // their own name, everything else as "Group > Item > Prop".
  function propLabel(names, matches) {
    if (matches.length > 0 && matches[0] === TRANSFORM_GROUP) return names[names.length - 1];
    var start = names.length - 3;
    if (start < 0) start = 0;
    return names.slice(start).join(" > ");
  }

  // Reads one layer's keyframed segments, expressions and markers.
  // ctx carries the shared budgets.
  function readAnimation(l, rec, ctx) {
    var layerSegments = 0;

    // Expression-driven motion has no keys: sample valueAtTime (after the
    // expression) at EXPR_SAMPLES points of [t0, t1] and report one segment
    // marked expression + sampled when the value changes. Cost is counted in
    // the shared sample budget; running out sets samples_truncated.
    function sampleExpression(p, kind, label, mn, t0, t1) {
      if (!isNumericKind(kind) || t1 - t0 < 0.01) return;
      if (ctx.samples + EXPR_SAMPLES > MAX_SAMPLES) {
        ctx.samples_truncated = true;
        return;
      }
      if (ctx.segments.length >= MAX_SEGMENTS || layerSegments >= SEGMENTS_PER_LAYER) {
        rec.segments_truncated = true;
        ctx.segments_truncated = true;
        return;
      }
      var first = null;
      var last = null;
      var lo = [];
      var hi = [];
      for (var i = 0; i < EXPR_SAMPLES; i++) {
        var t = t0 + ((t1 - t0) * i) / (EXPR_SAMPLES - 1);
        var v = null;
        try {
          v = asNums(p.valueAtTime(t, false));
        } catch (eV) {
          return;
        }
        ctx.samples++;
        if (v.length === 0) return;
        if (first === null) {
          first = v;
          lo = v.slice(0);
          hi = v.slice(0);
        } else {
          for (var d = 0; d < v.length && d < lo.length; d++) {
            if (v[d] < lo[d]) lo[d] = v[d];
            if (v[d] > hi[d]) hi[d] = v[d];
          }
        }
        last = v;
      }
      var changed = false;
      for (var e = 0; e < lo.length; e++) {
        if (hi[e] - lo[e] > EXPR_MIN_CHANGE) changed = true;
      }
      if (!changed) return;
      var seg = { layer: rec.index, prop: label, kind: kind, start: r3(t0), end: r3(t1), from: first, to: last, expression: true, sampled: true };
      if (mn !== "") seg.match = mn;
      ctx.segments.push(seg);
      layerSegments++;
    }

    function leaf(p, names, matches) {
      var mn = "";
      try {
        mn = String(p.matchName);
      } catch (eM) {}
      if (mn === "ADBE Marker") return;

      var label = propLabel(names, matches);
      var exprOn = expressionActive(p);
      var exprBroken = false;
      if (exprOn) {
        rec.expressions.count++;
        if (rec.expressions.props.length < MAX_EXPR_PROPS) rec.expressions.props.push(label);
        try {
          addRefs(String(p.expression), rec.expressions);
        } catch (eX) {}
        try {
          if (p.expressionError !== undefined && p.expressionError !== "") {
            rec.expressions.errors++;
            exprBroken = true;
          }
        } catch (eE) {}
      }

      // A layer chosen by an effect's layer parameter (Displacement Map, Set
      // Matte ...) counts as used, even when it is switched off.
      var pvt = null;
      try {
        pvt = p.propertyValueType;
      } catch (eT) {
        pvt = null;
      }
      if (pvt === PropertyValueType.LAYER_INDEX) {
        try {
          var lv = p.value;
          if (typeof lv === "number" && lv > 0 && lv !== rec.index) ctx.layerRefs[lv] = true;
        } catch (eLv) {}
        return;
      }

      var nk = 0;
      try {
        nk = p.numKeys;
      } catch (eN) {
        nk = 0;
      }
      var kind = valueKind(p);
      if (kind === null) return;

      if (exprOn && !exprBroken) {
        var winStart = rec.in_point;
        if (winStart < 0) winStart = 0;
        var winEnd = rec.out_point;
        if (winEnd > ctx.compDuration) winEnd = ctx.compDuration;
        if (nk < 2) {
          sampleExpression(p, kind, label, mn, winStart, winEnd);
        } else {
          // Keys already give segments; look past them for loopOut / loopIn style motion.
          var firstKey = p.keyTime(1);
          var lastKey = p.keyTime(nk);
          if (lastKey < winEnd - 0.05) sampleExpression(p, kind, label, mn, lastKey, winEnd);
          if (firstKey > winStart + 0.05) sampleExpression(p, kind, label, mn, winStart, firstKey);
        }
      }

      if (nk < 2) return;
      rec.animated.props++;
      rec.animated.keys += nk;

      var numeric = isNumericKind(kind);
      var expr = exprOn;
      var sampleOk = (kind === "1d" || kind === "2d" || kind === "3d") && nk <= MAX_OVERSHOOT_KEYS && !expr;
      for (var k = 1; k < nk; k++) {
        if (layerSegments >= SEGMENTS_PER_LAYER || ctx.segments.length >= MAX_SEGMENTS) {
          rec.segments_truncated = true;
          ctx.segments_truncated = true;
          return;
        }
        var t0 = p.keyTime(k);
        var t1 = p.keyTime(k + 1);
        var seg = { layer: rec.index, prop: label, kind: kind, start: r3(t0), end: r3(t1) };
        if (mn !== "") seg.match = mn;
        if (numeric) {
          var a = asNums(p.keyValue(k));
          var b = asNums(p.keyValue(k + 1));
          // Nothing changes between two equal keys.
          if (sameNums(a, b)) continue;
          seg.from = a;
          seg.to = b;
          // The values between the keys, at SAMPLES_PER_SEGMENT evenly spaced
          // times strictly inside (t0, t1). The server runs them through
          // motion.ts's analyzeMotion to find overshoot, so this tool and
          // ae_motion_review use one rule.
          if (sampleOk && ctx.samples + SAMPLES_PER_SEGMENT <= MAX_SAMPLES && a.length === b.length && a.length > 0) {
            var between = [];
            for (var s = 1; s <= SAMPLES_PER_SEGMENT; s++) {
              var tv = t0 + ((t1 - t0) * s) / (SAMPLES_PER_SEGMENT + 1);
              var vv = asNums(p.valueAtTime(tv, false));
              ctx.samples++;
              if (vv.length === a.length) between.push(vv);
            }
            if (between.length === SAMPLES_PER_SEGMENT) seg.samples = between;
          } else if (sampleOk && ctx.samples + SAMPLES_PER_SEGMENT > MAX_SAMPLES) {
            ctx.samples_truncated = true;
          }
        }
        try {
          if (p.keyOutInterpolationType(k) === KeyframeInterpolationType.HOLD) seg.hold = true;
        } catch (eH) {}
        if (expr) seg.expression = true;
        ctx.segments.push(seg);
        layerSegments++;
      }
    }

    function walk(group, depth, names, matches) {
      var n = 0;
      try {
        n = group.numProperties;
      } catch (e0) {
        n = 0;
      }
      if (depth > MAX_DEPTH) {
        if (n > 0) ctx.walk_truncated = true;
        return;
      }
      for (var i = 1; i <= n; i++) {
        if (ctx.visited >= MAX_VISITED) {
          ctx.walk_truncated = true;
          return;
        }
        ctx.visited++;
        var p = null;
        try {
          p = group.property(i);
        } catch (e1) {
          p = null;
        }
        if (!p) continue;
        var nm = "";
        try {
          nm = String(p.name);
        } catch (e2) {}
        var pm = "";
        try {
          pm = String(p.matchName);
        } catch (e3) {}
        var path = names.concat([nm]);
        var mpath = matches.concat([pm]);
        if (p.propertyType === PropertyType.PROPERTY) {
          leaf(p, path, mpath);
        } else {
          walk(p, depth + 1, path, mpath);
        }
      }
    }

    walk(l, 0, [], []);
  }

  function readLayerMarkers(l, rec, ctx) {
    var pm = null;
    try {
      pm = l.property("ADBE Marker");
    } catch (e0) {
      pm = null;
    }
    if (!pm) return;
    var n = 0;
    try {
      n = pm.numKeys;
    } catch (e1) {
      n = 0;
    }
    if (n === 0) return;
    rec.marker_count = n;
    for (var i = 1; i <= n && i <= MAX_LAYER_MARKERS; i++) {
      if (ctx.markers_total >= MAX_MARKERS_TOTAL) {
        ctx.markers_truncated = true;
        return;
      }
      var mv = null;
      try {
        mv = pm.keyValue(i);
      } catch (e2) {
        mv = null;
      }
      var entry = { time: r3(pm.keyTime(i)), comment: "" };
      try {
        if (mv && mv.comment) entry.comment = clip(mv.comment, COMMENT_MAX);
      } catch (e3) {}
      try {
        if (mv && mv.duration > 0) entry.duration = r3(mv.duration);
      } catch (e4) {}
      rec.markers.push(entry);
      ctx.markers_total++;
    }
    if (n > MAX_LAYER_MARKERS) ctx.markers_truncated = true;
  }

  function readText(l) {
    try {
      var doc = l.property("ADBE Text Properties").property("ADBE Text Document").value;
      var t = String(doc.text).replace(/\r\n|\r|\n/g, " / ");
      return clip(t, TEXT_PREVIEW);
    } catch (e) {
      return null;
    }
  }

  function sourceInfo(l) {
    var src = null;
    try {
      src = l.source;
    } catch (e0) {
      src = null;
    }
    if (!src) return null;
    var info = {};
    try {
      info.name = clip(src.name, 200);
    } catch (e1) {}
    try {
      if (src instanceof CompItem) {
        info.kind = "comp";
        info.id = src.id;
        info.layers = src.numLayers;
        info.duration = r3(src.duration);
        return info;
      }
    } catch (e2) {}
    info.kind = "footage";
    try {
      if (src.mainSource instanceof SolidSource) info.kind = "solid";
    } catch (e3) {}
    try {
      if (src.mainSource && src.mainSource.isStill === true) info.still = true;
    } catch (e4) {}
    try {
      if (src.footageMissing === true) info.missing = true;
    } catch (e5) {}
    return info;
  }

  // Which precomps nest where: the comps this comp's layers use, and theirs in turn.
  function nestingOf(comp, depth, state) {
    var node = { id: comp.id, name: clip(comp.name, 200), layers: comp.numLayers, duration: r3(comp.duration), children: [] };
    state.count++;
    if (depth >= MAX_NEST_DEPTH) {
      return node;
    }
    var seen = {};
    var n = comp.numLayers;
    if (n > MAX_LAYERS) n = MAX_LAYERS;
    for (var i = 1; i <= n; i++) {
      var src = null;
      try {
        src = comp.layer(i).source;
      } catch (e0) {
        src = null;
      }
      var isComp = false;
      try {
        isComp = !!src && src instanceof CompItem;
      } catch (e1) {
        isComp = false;
      }
      if (!isComp || seen[src.id]) continue;
      seen[src.id] = true;
      if (state.count >= MAX_NEST_NODES) {
        state.truncated = true;
        return node;
      }
      if (state.path[src.id]) {
        node.children.push({ id: src.id, name: clip(src.name, 200), cycle: true });
        continue;
      }
      state.path[src.id] = true;
      node.children.push(nestingOf(src, depth + 1, state));
      state.path[src.id] = false;
    }
    return node;
  }

  // args: { comp_id, from_layer?, max_layers? }. Layers from_layer ..
  // from_layer + max_layers - 1 (default 200, at most 500 per call; from_layer
  // can be any layer of the comp) get the full read. The parent / matte
  // cross-references are a separate, cheaper pass over the first
  // MAX_XREF_LAYERS layers (layers_over_cap says when the comp is bigger).
  A.describeRead = function (args) {
    var c = requireComp(args.comp_id);
    var total = c.numLayers;
    var scan = total;
    if (scan > MAX_XREF_LAYERS) scan = MAX_XREF_LAYERS;

    var from = 1;
    if (args.from_layer !== undefined && args.from_layer !== null && args.from_layer > 0) from = Math.floor(args.from_layer);
    var page = DEFAULT_PAGE;
    if (args.max_layers !== undefined && args.max_layers !== null && args.max_layers > 0) page = Math.floor(args.max_layers);
    if (page > MAX_LAYERS) page = MAX_LAYERS;
    if (total > 0 && from > total) fail("bad_args", "from_layer " + from + " is past the last layer (" + total + ")");
    var to = from + page - 1;
    if (to > total) to = total;

    // Cross-references over every scanned layer: who is a parent, who is a matte.
    var isParent = {};
    var isMatte = {};
    var i;
    for (i = 1; i <= scan; i++) {
      var li = c.layer(i);
      var par = null;
      try {
        par = li.parent;
      } catch (eP) {
        par = null;
      }
      if (par) isParent[par.index] = true;
      var mt = "none";
      try {
        mt = matteName(li.trackMatteType);
      } catch (eT) {
        mt = "none";
      }
      if (mt !== "none") {
        var ml = null;
        try {
          ml = li.trackMatteLayer;
        } catch (eL) {
          ml = null;
        }
        if (ml) {
          isMatte[ml.index] = true;
        } else if (i > 1) {
          // Before AE 23 the matte is the layer above.
          isMatte[i - 1] = true;
        }
      }
    }

    var ctx = {
      visited: 0,
      samples: 0,
      markers_total: 0,
      segments: [],
      segments_truncated: false,
      samples_truncated: false,
      layerRefs: {},
      compDuration: c.duration,
      walk_truncated: false,
      markers_truncated: false
    };

    var layers = [];
    for (i = from; i <= to; i++) {
      var l = c.layer(i);
      var rec = {
        index: l.index,
        id: l.id,
        name: clip(l.name, 200),
        role: layerRole(l),
        enabled: true,
        in_point: 0,
        out_point: 0,
        parent: null,
        matte: null,
        is_parent: isParent[i] === true,
        is_matte: isMatte[i] === true,
        expressions: { count: 0, props: [], refs: [], errors: 0 },
        animated: { props: 0, keys: 0 },
        markers: []
      };
      try { rec.enabled = l.enabled !== false; } catch (e1) {}
      try { rec.in_point = r3(l.inPoint); } catch (e2) {}
      try { rec.out_point = r3(l.outPoint); } catch (e3) {}
      try { rec.start = r3(l.startTime); } catch (e3a) {}
      try { if (l.shy === true) rec.shy = true; } catch (e4) {}
      try { if (l.guideLayer === true) rec.guide = true; } catch (e5) {}
      try { if (l.solo === true) rec.solo = true; } catch (e6) {}
      try { if (l.threeDLayer === true) rec.three_d = true; } catch (e7) {}
      try { if (l.locked === true) rec.locked = true; } catch (e8) {}
      try { if (l.hasAudio === true && l.audioEnabled !== false) rec.audio = true; } catch (e9) {}
      try {
        var pr = l.parent;
        if (pr) rec.parent = pr.index;
      } catch (e10) {}
      try {
        var mtype = matteName(l.trackMatteType);
        if (mtype !== "none") {
          var mlayer = null;
          try { mlayer = l.trackMatteLayer; } catch (e11) { mlayer = null; }
          var mIndex = null;
          if (mlayer) {
            mIndex = mlayer.index;
          } else if (l.index > 1) {
            mIndex = l.index - 1;
          }
          rec.matte = { type: mtype, layer: mIndex };
        }
      } catch (e12) {}
      try {
        if (l.comment !== undefined && l.comment !== "") rec.comment = clip(l.comment, COMMENT_MAX);
      } catch (e13) {}
      if (rec.role === "text") {
        var tx = readText(l);
        if (tx !== null) rec.text = tx;
      }
      var si = sourceInfo(l);
      if (si) rec.source = si;
      readLayerMarkers(l, rec, ctx);
      readAnimation(l, rec, ctx);
      layers.push(rec);
    }
    for (i = 0; i < layers.length; i++) {
      if (ctx.layerRefs[layers[i].index] === true) layers[i].is_referenced = true;
    }

    var markers = [];
    var markerCount = 0;
    var markersTruncated = false;
    try {
      var mp = c.markerProperty;
      markerCount = mp.numKeys;
      for (i = 1; i <= markerCount; i++) {
        if (markers.length >= MAX_COMP_MARKERS) {
          markersTruncated = true;
          break;
        }
        var mv = null;
        try { mv = mp.keyValue(i); } catch (eK) { mv = null; }
        var m = { time: r3(mp.keyTime(i)), comment: "" };
        try { if (mv && mv.comment) m.comment = clip(mv.comment, COMMENT_MAX); } catch (eC) {}
        try { if (mv && mv.duration > 0) m.duration = r3(mv.duration); } catch (eD) {}
        markers.push(m);
      }
    } catch (eMp) {}

    var nest = { count: 0, truncated: false, path: {} };
    nest.path[c.id] = true;
    var nesting = nestingOf(c, 0, nest);

    var next = null;
    if (to < total) next = to + 1;

    return {
      comp: {
        id: c.id,
        name: clip(c.name, 200),
        width: c.width,
        height: c.height,
        pixel_aspect: c.pixelAspect,
        frame_rate: c.frameRate,
        duration: r3(c.duration),
        work_area: { start: r3(c.workAreaStart), duration: r3(c.workAreaDuration) },
        num_layers: total
      },
      range: {
        from: from,
        to: to,
        // True when every layer of the comp was read, so "unused" can be judged.
        complete: from === 1 && to === total,
        next_from_layer: next,
        layers_over_cap: total > MAX_XREF_LAYERS
      },
      layers: layers,
      segments: ctx.segments,
      segments_truncated: ctx.segments_truncated,
      samples_truncated: ctx.samples_truncated,
      walk_truncated: ctx.walk_truncated,
      markers: { count: markerCount, list: markers, truncated: markersTruncated || ctx.markers_truncated },
      nesting: nesting,
      nesting_truncated: nest.truncated,
      properties_visited: ctx.visited
    };
  };
})($.global);
