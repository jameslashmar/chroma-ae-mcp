// panel/host/ext/timing.jsx
//
// Host function for ae_timing_check (read only):
// - timingRead: one pass over a comp's layers returning what the timeline
//   checks need, and nothing else: per layer its kind, in and out points,
//   switches, audio, the text on screen (one entry per Source Text key), the
//   Opacity value or keys, the time spans in which any property keyframe
//   changes value (merged), single change times (hold keys, text changes),
//   whether an expression is on (an enabled expression marks the layer as changing), and whether footage or a precomp plays.
//   The judging (reading time, dead stretches, facts) is done on the Node side.
//
// Not covered (said in the tool's notes): text inside precomps (a precomp only
// counts as playing or not), hold keys on Opacity, effects that animate by
// themselves (a noise effect with no keys), time remapping.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Read only: no undo group, no time change, no selection change.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var MAX_PROPS = 3000;
  var MAX_SPANS = 200;
  var MAX_KEYS_TOTAL = 20000;
  var MAX_KEYS_PER_PROP = 500;
  var MAX_TEXT_KEYS = 200;
  var MAX_OPACITY_KEYS = 200;
  var MAX_TEXT = 300;
  var MAX_NAME = 200;
  var MAX_PRECOMP_DEPTH = 4;
  var MAX_PRECOMP_LAYERS = 400;

  function fail(kind, message) {
    var e = new Error(message);
    e.__kind = kind;
    throw e;
  }

  function num(v, fill) {
    if (typeof v === "number" && v === v) return v;
    return fill;
  }

  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  function clip(s, n) {
    s = String(s);
    if (s.length > n) return s.substring(0, n);
    return s;
  }

  function requireComp(id) {
    var item = null;
    if (id === undefined || id === null) {
      try {
        item = app.project.activeItem;
      } catch (e0) {
        item = null;
      }
      if (!item || !(item instanceof CompItem)) fail("not_found", "No comp_id given and the active item is not a comp");
      return item;
    }
    try {
      item = app.project.itemByID(id);
    } catch (e) {
      item = null;
    }
    if (!item || !(item instanceof CompItem)) fail("not_found", "No CompItem with id " + id);
    return item;
  }

  function child(group, matchName) {
    if (!group) return null;
    var p = null;
    try {
      p = group.property(matchName);
    } catch (e) {
      p = null;
    }
    return p || null;
  }

  function isTextLayer(l) {
    try {
      return !!l.reflect && String(l.reflect.name) === "TextLayer";
    } catch (e) {
      return false;
    }
  }

  function same(a, b) {
    var i;
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (typeof a.length === "number" && typeof b.length === "number") {
      if (a.length !== b.length) return false;
      for (i = 0; i < a.length; i++) {
        if (!same(a[i], b[i])) return false;
      }
      return true;
    }
    // Shape (mask or path): vertices, tangents and closed.
    if (a.vertices !== undefined && b.vertices !== undefined) {
      if (!same(a.vertices, b.vertices)) return false;
      if (!same(a.inTangents, b.inTangents)) return false;
      if (!same(a.outTangents, b.outTangents)) return false;
      return a.closed === b.closed;
    }
    // TextDocument: text, and size and fill colour when they can be read.
    if (typeof a.text === "string" && typeof b.text === "string") {
      if (a.text !== b.text) return false;
      try {
        if (a.fontSize !== b.fontSize) return false;
        if (!same(a.fillColor, b.fillColor)) return false;
      } catch (e) {
        return false;
      }
      return true;
    }
    // Any other object: treat as different (moving) rather than guess.
    return false;
  }

  function isHold(p, i) {
    try {
      return p.keyOutInterpolationType(i) === KeyframeInterpolationType.HOLD;
    } catch (e) {
      return false;
    }
  }

  // acc: { spans: [[a, b]], points: [t], expr: bool, props: n, truncated: bool,
  //         tailFrom: time or null, budget: { keys: n } }
  // truncated means some properties or keys were not read; tailFrom is the time
  // from which the layer must then be treated as changing (a very early time
  // when not known, so the layer counts from its in point).
  function markTruncated(acc, from) {
    acc.truncated = true;
    if (from === null || from === undefined) from = -1e9;
    if (acc.tailFrom === null || from < acc.tailFrom) acc.tailFrom = from;
  }

  function scanProps(group, acc, skipText) {
    var n = 0;
    var i;
    try {
      n = group.numProperties;
    } catch (e0) {
      return;
    }
    for (i = 1; i <= n; i++) {
      if (acc.props >= MAX_PROPS || acc.budget.keys <= 0) {
        markTruncated(acc, null);
        return;
      }
      var p = null;
      try {
        p = group.property(i);
      } catch (e1) {
        p = null;
      }
      if (!p) continue;
      acc.props++;
      var mn = "";
      try {
        mn = String(p.matchName);
      } catch (e2) {}
      if (mn === "ADBE Marker" || mn === "ADBE Audio Group" || mn === "ADBE Time Remapping") continue;
      if (skipText && mn === "ADBE Text Document") continue;
      if (typeof p.numKeys === "number") {
        try {
          if (p.expressionEnabled === true) acc.expr = true;
        } catch (e3) {}
        var k = p.numKeys;
        var j;
        var lastT = null;
        for (j = 1; j < k; j++) {
          if (j > MAX_KEYS_PER_PROP || acc.budget.keys <= 0) {
            markTruncated(acc, lastT);
            break;
          }
          acc.budget.keys--;
          var a = null;
          var b = null;
          var ta = 0;
          var tb = 0;
          try {
            ta = p.keyTime(j);
            tb = p.keyTime(j + 1);
            a = p.keyValue(j);
            b = p.keyValue(j + 1);
          } catch (e4) {
            continue;
          }
          lastT = round4(tb);
          if (same(a, b)) continue;
          if (isHold(p, j)) acc.points.push(round4(tb));
          else acc.spans.push([round4(ta), round4(tb)]);
        }
      } else if (typeof p.numProperties === "number") {
        scanProps(p, acc, skipText);
      }
    }
  }

  function mergeSpans(spans) {
    if (spans.length < 2) return spans;
    spans.sort(function (x, y) {
      return x[0] - y[0];
    });
    var out = [spans[0]];
    var i;
    for (i = 1; i < spans.length; i++) {
      var last = out[out.length - 1];
      if (spans[i][0] <= last[1] + 1e-6) {
        if (spans[i][1] > last[1]) last[1] = spans[i][1];
      } else {
        out.push([spans[i][0], spans[i][1]]);
      }
    }
    return out;
  }

  function footageKind(src) {
    // "solid", "placeholder", "still", "video" or "other"
    try {
      if (src.mainSource instanceof SolidSource) return "solid";
    } catch (e1) {}
    try {
      if (src.mainSource instanceof PlaceholderSource) return "placeholder";
    } catch (e2) {}
    try {
      if (src.mainSource && src.mainSource.isStill === true) return "still";
    } catch (e3) {}
    try {
      if (typeof src.duration === "number" && src.duration === 0) return "still";
    } catch (e4) {}
    return "video";
  }

  // True when a nested comp changes over time: moving keys, an expression,
  // moving footage, or a precomp that does. Bounded in depth and size.
  function compAnimates(comp, depth, budget) {
    var n = 0;
    var i;
    try {
      n = comp.numLayers;
    } catch (e0) {
      return false;
    }
    for (i = 1; i <= n; i++) {
      if (budget.left <= 0) return false;
      budget.left--;
      var l = null;
      try {
        l = comp.layer(i);
      } catch (e1) {
        continue;
      }
      var acc = { spans: [], points: [], expr: false, props: 0, truncated: false, tailFrom: null, budget: budget };
      scanProps(l, acc, false);
      // Not fully read: assume it animates rather than report a false dead stretch.
      if (acc.spans.length > 0 || acc.points.length > 0 || acc.expr || acc.truncated) return true;
      var src = null;
      try {
        src = l.source;
      } catch (e2) {
        src = null;
      }
      if (src && src instanceof CompItem && depth < MAX_PRECOMP_DEPTH) {
        if (compAnimates(src, depth + 1, budget)) return true;
      } else if (src && src instanceof FootageItem) {
        var hv = true;
        try {
          hv = l.hasVideo === true;
        } catch (e3) {}
        if (hv && footageKind(src) === "video") return true;
      }
    }
    return false;
  }

  function layerKind(l) {
    var rn = "";
    try {
      rn = String(l.reflect.name);
    } catch (e0) {}
    if (rn === "TextLayer") return "text";
    if (rn === "ShapeLayer") return "shape";
    if (rn === "CameraLayer") return "camera";
    if (rn === "LightLayer") return "light";
    try {
      if (l.nullLayer) return "null";
    } catch (e1) {}
    try {
      if (l.adjustmentLayer) return "adjustment";
    } catch (e2) {}
    var src = null;
    try {
      src = l.source;
    } catch (e3) {}
    if (src && src instanceof CompItem) return "precomp";
    if (src && src instanceof FootageItem) {
      var fk = footageKind(src);
      if (fk === "solid") return "solid";
      var hv = true;
      try {
        hv = l.hasVideo === true;
      } catch (e4) {}
      if (!hv) return "audio";
      return "footage";
    }
    return "other";
  }

  function audioMuted(l) {
    var g = child(l, "ADBE Audio Group");
    var lv = child(g, "ADBE Audio Levels");
    if (!lv) return false;
    try {
      if (lv.numKeys > 0) return false;
      var v = lv.value;
      if (v && typeof v.length === "number") return num(v[0], 0) <= -48 && num(v[1], num(v[0], 0)) <= -48;
      return num(v, 0) <= -48;
    } catch (e) {
      return false;
    }
  }

  function readTextKeys(l) {
    var tp = child(l, "ADBE Text Properties");
    var doc = child(tp, "ADBE Text Document");
    var out = { text: null, keys: null };
    if (!doc) return out;
    var n = 0;
    try {
      n = doc.numKeys;
    } catch (e0) {}
    var i;
    if (n > 0) {
      out.keys = [];
      for (i = 1; i <= n && i <= MAX_TEXT_KEYS; i++) {
        var td = null;
        var t = 0;
        try {
          t = doc.keyTime(i);
          td = doc.keyValue(i);
        } catch (e1) {
          continue;
        }
        out.keys.push({ t: round4(t), text: td ? clip(td.text, MAX_TEXT) : "" });
      }
      if (out.keys.length > 0) out.text = out.keys[0].text;
      return out;
    }
    try {
      var v = doc.value;
      out.text = v ? clip(v.text, MAX_TEXT) : "";
    } catch (e2) {
      out.text = "";
    }
    return out;
  }

  function readOpacity(l) {
    var tg = child(l, "ADBE Transform Group");
    var op = child(tg, "ADBE Opacity");
    var out = { value: 100, keys: null };
    if (!op) return out;
    var n = 0;
    try {
      n = op.numKeys;
    } catch (e0) {}
    var i;
    if (n > 0) {
      out.keys = [];
      for (i = 1; i <= n && i <= MAX_OPACITY_KEYS; i++) {
        try {
          out.keys.push({ t: round4(op.keyTime(i)), v: num(op.keyValue(i), 100) });
        } catch (e1) {}
      }
      return out;
    }
    try {
      out.value = num(op.value, 100);
    } catch (e2) {}
    return out;
  }

  // args: { comp_id? } (the active comp when omitted)
  A.timingRead = function (args) {
    var c = requireComp(args ? args.comp_id : undefined);
    var n = c.numLayers;
    var layers = [];
    var soloAny = false;
    var truncated = false;
    var keysTruncated = false;
    var keyBudget = { keys: MAX_KEYS_TOTAL };
    var i;
    for (i = 1; i <= n; i++) {
      var l = c.layer(i);
      try {
        if (l.solo === true && l.hasVideo === true) soloAny = true;
      } catch (e0) {}
    }
    for (i = 1; i <= n; i++) {
      if (layers.length >= MAX_LAYERS) {
        truncated = true;
        break;
      }
      var lay = c.layer(i);
      var kind = layerKind(lay);
      var entry = {
        id: lay.id,
        index: lay.index,
        name: clip(lay.name, MAX_NAME),
        kind: kind,
        enabled: lay.enabled === true,
        solo: false,
        guide: false,
        in_s: round4(num(lay.inPoint, 0)),
        out_s: round4(num(lay.outPoint, 0)),
        has_audio: false,
        audio_enabled: false,
        audio_muted: false,
        video_playing: false,
        expression: false,
        change_from_s: null,
        spans: [],
        points: [],
        opacity: { value: 100, keys: null },
        text: null,
        text_keys: null,
        truncated: false
      };
      try {
        entry.solo = lay.solo === true;
      } catch (e1) {}
      try {
        entry.guide = lay.guideLayer === true;
      } catch (e2) {}
      try {
        entry.has_audio = lay.hasAudio === true;
        entry.audio_enabled = lay.audioEnabled === true;
      } catch (e3) {}
      if (entry.has_audio && entry.audio_enabled) entry.audio_muted = audioMuted(lay);

      var acc = { spans: [], points: [], expr: false, props: 0, truncated: false, tailFrom: null, budget: keyBudget };
      scanProps(lay, acc, true);
      entry.expression = acc.expr;
      var spans = mergeSpans(acc.spans);
      if (spans.length > MAX_SPANS) {
        spans = spans.slice(0, MAX_SPANS);
        markTruncated(acc, spans[spans.length - 1][1]);
      }
      entry.spans = spans;
      acc.points.sort(function (x, y) {
        return x - y;
      });
      if (acc.points.length > MAX_SPANS) {
        entry.points = acc.points.slice(0, MAX_SPANS);
        markTruncated(acc, entry.points[entry.points.length - 1]);
      } else {
        entry.points = acc.points;
      }
      entry.truncated = acc.truncated;
      if (acc.truncated) {
        if (acc.tailFrom !== null && acc.tailFrom > -1e8) entry.change_from_s = acc.tailFrom;
        else entry.change_from_s = entry.in_s;
        if (keyBudget.keys <= 0) keysTruncated = true;
      }
      entry.opacity = readOpacity(lay);

      if (kind === "text") {
        var tk = readTextKeys(lay);
        entry.text = tk.text;
        entry.text_keys = tk.keys;
      }
      if (kind === "footage") {
        entry.video_playing = footageKind(lay.source) === "video";
      } else if (kind === "precomp") {
        var budget = { left: MAX_PRECOMP_LAYERS, keys: keyBudget.keys };
        entry.video_playing = compAnimates(lay.source, 1, budget);
        keyBudget.keys = budget.keys;
      }
      layers.push(entry);
    }
    var fr = num(c.frameRate, 25);
    return {
      comp: {
        id: c.id,
        name: clip(c.name, MAX_NAME),
        duration_s: round4(num(c.duration, 0)),
        frame_rate: fr,
        width: c.width,
        height: c.height,
        work_area_start_s: round4(num(c.workAreaStart, 0)),
        work_area_duration_s: round4(num(c.workAreaDuration, num(c.duration, 0)))
      },
      solo_any: soloAny,
      layer_count: n,
      layers: layers,
      truncated: truncated,
      keys_truncated: keysTruncated
    };
  };
})($.global);
