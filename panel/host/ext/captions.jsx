// panel/host/ext/captions.jsx
//
// Host functions for the caption tools:
// - captionsRead (read): the caption layers (or the one hold-keyed layer) a name
//   prefix finds, with text, timing, style, highlight keys, the text's extents
//   against the safe area, and the background boxes' expression errors
// - captionsApply (guarded write): creates or updates the captions by name,
//   one text layer per caption ("layers") or one layer whose Source Text is
//   keyed per caption ("single"), with an optional word highlight (a text
//   animator whose range selector is keyed per word in Index units, Based On
//   Words) and an optional background box (a shape layer whose rectangle
//   follows the text through sourceRectAtTime)
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Everything that can fail is checked before the undo group opens.
// - Before and after reads run in separate evalScript calls from the server.
// - The read changes nothing: no time, selection or active item.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_CAPTIONS = 500;
  var MAX_LIST = 500;
  var MAX_TEXT = 20000;
  var HIGHLIGHT_NAME = "Caption Highlight";

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

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function boundString(s) {
    var t = String(s);
    if (t.length > MAX_TEXT) return t.substring(0, MAX_TEXT) + " ...[truncated]";
    return t;
  }

  function isTextLayer(l) {
    try {
      return l.reflect && l.reflect.name === "TextLayer";
    } catch (e) {
      return false;
    }
  }

  function isShapeLayer(l) {
    try {
      return l.reflect && l.reflect.name === "ShapeLayer";
    } catch (e) {
      return false;
    }
  }

  function sourceTextProp(layer) {
    var g = layer.property("ADBE Text Properties");
    var p = null;
    if (g) p = g.property("ADBE Text Document");
    if (!p) fail("bad_args", "Layer \"" + layer.name + "\" has no Source Text property");
    return p;
  }

  function animatorsOf(layer) {
    return layer.property("ADBE Text Properties").property("ADBE Text Animators");
  }

  function justificationName(v) {
    try {
      if (v === ParagraphJustification.LEFT_JUSTIFY) return "left";
      if (v === ParagraphJustification.CENTER_JUSTIFY) return "center";
      if (v === ParagraphJustification.RIGHT_JUSTIFY) return "right";
    } catch (e) {}
    return String(v);
  }

  function justificationValue(name) {
    if (name === "left") return ParagraphJustification.LEFT_JUSTIFY;
    if (name === "center") return ParagraphJustification.CENTER_JUSTIFY;
    if (name === "right") return ParagraphJustification.RIGHT_JUSTIFY;
    fail("bad_args", "Unknown justification \"" + name + "\" (left, center or right)");
    return null;
  }

  // The number of whitespace-separated words, as AE counts them.
  function wordCount(text) {
    var parts = String(text).split(/\s+/);
    var n = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] !== "") n++;
    }
    return n;
  }

  function allDigits(s) {
    return s.length > 0 && /^[0-9]+$/.test(s);
  }

  function quoteJs(s) {
    var t = String(s);
    t = t.split("\\").join("\\\\");
    t = t.split("\"").join("\\\"");
    t = t.split("\r").join("\\r");
    t = t.split("\n").join("\\n");
    return "\"" + t + "\"";
  }

  // ---------- safe area ----------

  function parseAspect(key) {
    var parts = String(key).split(":");
    if (parts.length !== 2) return 0;
    var a = Number(parts[0]);
    var b = Number(parts[1]);
    if (!isNum(a) || !isNum(b) || a <= 0 || b <= 0) return 0;
    return a / b;
  }

  // The default margins of the aspect the comp is within 1% of, else 5% all round;
  // the layout's own margins win key by key.
  function safeArea(comp, layout, defaults) {
    var w = comp.width;
    var h = comp.height;
    var m = { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 };
    var ratio = w / h;
    if (defaults) {
      for (var key in defaults) {
        if (!defaults.hasOwnProperty(key)) continue;
        var r = parseAspect(key);
        if (r > 0 && Math.abs(r - ratio) / ratio < 0.01) {
          m = { top: defaults[key].top, bottom: defaults[key].bottom, left: defaults[key].left, right: defaults[key].right };
        }
      }
    }
    var over = layout && layout.margins ? layout.margins : null;
    if (over) {
      if (isNum(over.top)) m.top = over.top;
      if (isNum(over.bottom)) m.bottom = over.bottom;
      if (isNum(over.left)) m.left = over.left;
      if (isNum(over.right)) m.right = over.right;
    }
    return {
      left: w * m.left,
      right: w * m.right,
      top: h * m.top,
      bottom: h * m.bottom,
      width: w * (1 - m.left - m.right),
      bottomY: h * (1 - m.bottom),
      topY: h * m.top
    };
  }

  // ---------- layer lookup by caption name ----------

  // Splits "<prefix> <digits>" or "<prefix> <digits> Box" into its number and kind.
  function captionName(name, prefix) {
    var head = prefix + " ";
    if (name.length <= head.length || name.substring(0, head.length) !== head) return null;
    var rest = name.substring(head.length);
    var kind = "caption";
    if (rest.length > 4 && rest.substring(rest.length - 4) === " Box") {
      kind = "box";
      rest = rest.substring(0, rest.length - 4);
    }
    if (!allDigits(rest)) return null;
    return { number: parseInt(rest, 10), kind: kind };
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = "0" + s;
    return s;
  }

  // The caption and box layers a prefix finds, by number (layers mode) or by exact name (single).
  function scanCaptions(comp, prefix, mode) {
    var found = { caps: {}, boxes: {}, list: [] };
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      var parsed = null;
      if (mode === "single") {
        if (l.name === prefix) parsed = { number: 1, kind: "caption" };
        else if (l.name === prefix + " Box") parsed = { number: 1, kind: "box" };
      } else {
        parsed = captionName(l.name, prefix);
      }
      if (!parsed) continue;
      var bucket = found.caps;
      if (parsed.kind === "box") bucket = found.boxes;
      if (bucket[parsed.number]) {
        fail("bad_args", "Two layers answer to caption " + parsed.number + " (\"" + bucket[parsed.number].name + "\" and \"" + l.name + "\"); rename or remove one");
      }
      bucket[parsed.number] = l;
      found.list.push({ number: parsed.number, kind: parsed.kind, layer: l });
    }
    return found;
  }

  // ---------- read ----------

  function highlightInfo(layer) {
    var info = { present: false };
    try {
      var anims = animatorsOf(layer);
      for (var i = 1; i <= anims.numProperties; i++) {
        var a = anims.property(i);
        if (a.name !== HIGHLIGHT_NAME) continue;
        info.present = true;
        var sel = a.property("ADBE Text Selectors").property(1);
        if (sel) {
          var s = sel.property("ADBE Text Index Start");
          var e = sel.property("ADBE Text Index End");
          if (s) info.start_keys = s.numKeys;
          if (e) info.end_keys = e.numKeys;
          var adv = sel.property("ADBE Text Range Advanced");
          if (adv) {
            var u = adv.property("ADBE Text Range Units");
            var b = adv.property("ADBE Text Range Type2");
            if (u) info.units = u.value;
            if (b) info.based_on = b.value;
          }
        }
        break;
      }
    } catch (eH) {}
    return info;
  }

  // The padding a caption box was made with, read back from its Size expression ("r.width + 2 * padding"); 0 when unknown.
  function boxPadding(boxLayer) {
    if (!boxLayer) return 0;
    try {
      var rect = boxLayer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group").property("ADBE Vector Shape - Rect");
      var ex = String(rect.property("ADBE Vector Rect Size").expression);
      var mt = ex.match(/r\.width \+ ([0-9.]+)/);
      if (mt) return Number(mt[1]) / 2;
    } catch (e) {}
    return 0;
  }

  function rectInfo(layer, t, safe, comp, boxLayer) {
    var out = {};
    try {
      var r = layer.sourceRectAtTime(t, false);
      out.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      var pos = layer.property("ADBE Transform Group").property("ADBE Position").value;
      var anc = layer.property("ADBE Transform Group").property("ADBE Anchor Point").value;
      out.position = [pos[0], pos[1]];
      var x0 = pos[0] + r.left - anc[0];
      var y0 = pos[1] + r.top - anc[1];
      var x1 = x0 + r.width;
      var y1 = y0 + r.height;
      // The background box reaches padding px past the text: it is what the viewer sees against the safe area.
      var bpad = boxPadding(boxLayer);
      if (r.width > 0 && bpad > 0) {
        x0 -= bpad;
        y0 -= bpad;
        x1 += bpad;
        y1 += bpad;
        out.box_padding = bpad;
      }
      out.bounds = [x0, y0, x1, y1];
      if (r.width > 0) {
        out.outside_safe = x0 < safe.left - 0.5 || x1 > comp.width - safe.right + 0.5 || y0 < safe.top - 0.5 || y1 > safe.bottomY + 0.5;
      } else {
        out.outside_safe = false;
      }
    } catch (e) {
      out.rect_error = A.formatError(e);
    }
    return out;
  }

  // The height the hard line breaks alone need; does not rely on AE counting hidden lines in sourceRectAtTime.
  function hardLinesHeight(doc, text) {
    var n = String(text).split("\r").length;
    var lead = null;
    try {
      if (doc.autoLeading === false && isNum(doc.leading)) lead = doc.leading;
    } catch (e1) {}
    if (lead === null) {
      var fs = 0;
      try { fs = Number(doc.fontSize); } catch (e2) {}
      lead = fs * 1.2;
    }
    return n * lead;
  }

  function captionEntry(l, number, mode, safe, comp, boxLayer) {
    var entry = {
      number: number,
      name: l.name,
      id: l.id,
      index: l.index,
      inPoint: l.inPoint,
      outPoint: l.outPoint,
      startTime: l.startTime
    };
    if (!isTextLayer(l)) {
      entry.kind = "other";
      return entry;
    }
    entry.kind = "text";
    var src = sourceTextProp(l);
    entry.numKeys = src.numKeys;
    var doc = src.value;
    entry.text = boundString(doc.text);
    try { entry.font = String(doc.font); } catch (e1) {}
    try { entry.fontSize = Number(doc.fontSize); } catch (e2) {}
    try { entry.justification = justificationName(doc.justification); } catch (e3) {}
    try {
      if (doc.fontObject && doc.fontObject.isSubstitute === true) entry.font_substituted = true;
    } catch (e4) {}
    entry.highlight = highlightInfo(l);
    if (mode === "single") {
      var keys = [];
      var worst = null;
      var bts1 = null;
      try {
        if (doc.boxText === true) {
          entry.box_text = true;
          var b1 = doc.boxTextSize;
          if (b1 && b1.length >= 2) {
            bts1 = [b1[0], b1[1]];
            entry.boxTextSize = bts1;
          }
        }
      } catch (eB1) {}
      for (var k = 1; k <= src.numKeys && keys.length < MAX_LIST; k++) {
        var kd = src.keyValue(k);
        var t = src.keyTime(k);
        var item = { time: t, text: boundString(kd.text) };
        if (String(kd.text) !== "") {
          var ri = rectInfo(l, t, safe, comp, boxLayer);
          if (ri.rect) {
            item.width = ri.rect.width;
            item.outside_safe = ri.outside_safe;
          }
          if (bts1) {
            var over = (ri.rect && ri.rect.height > bts1[1] + 1) || hardLinesHeight(kd, kd.text) > bts1[1] + 1;
            if (over) {
              item.box_overflow = true;
              entry.box_overflow = true;
            }
          }
        }
        keys.push(item);
      }
      entry.keys = keys;
      entry.truncated_keys = src.numKeys > keys.length;
      worst = null;
      for (var q = 0; q < keys.length; q++) {
        if (keys[q].outside_safe === true) {
          worst = keys[q].time;
          break;
        }
      }
      if (worst !== null) entry.first_outside_safe = worst;
    } else {
      var t0 = l.inPoint;
      var ri2 = rectInfo(l, t0, safe, comp, boxLayer);
      entry.rect = ri2.rect;
      // Paragraph text hides the lines that overflow its box.
      try {
        if (doc.boxText === true) {
          var bts = doc.boxTextSize;
          entry.box_text = true;
          if (bts && bts.length >= 2) {
            entry.boxTextSize = [bts[0], bts[1]];
            if (ri2.rect && ri2.rect.height > bts[1] + 1) entry.box_overflow = true;
            if (hardLinesHeight(doc, doc.text) > bts[1] + 1) entry.box_overflow = true;
          }
        }
      } catch (eBt) {}
      entry.position = ri2.position;
      entry.outside_safe = ri2.outside_safe === true;
      if (ri2.rect_error) entry.rect_error = ri2.rect_error;
    }
    return entry;
  }

  function expressionErrors(boxLayer) {
    var errors = [];
    try {
      var group = boxLayer.property("ADBE Root Vectors Group").property(1);
      var rect = group.property("ADBE Vectors Group").property("ADBE Vector Shape - Rect");
      var names = ["ADBE Vector Rect Size", "ADBE Vector Rect Position"];
      for (var i = 0; i < names.length; i++) {
        var p = rect.property(names[i]);
        // AE turns an expression with an error off and keeps the message.
        if (p && p.expressionError) {
          errors.push(names[i] + ": " + String(p.expressionError));
        }
      }
    } catch (e) {
      errors.push("could not read the box's expressions: " + A.formatError(e));
    }
    return errors;
  }

  A.captionsRead = function (args) {
    var comp = requireComp(args.comp_id);
    var prefix = String(args.name_prefix);
    var mode = args.mode === "single" ? "single" : "layers";
    var safe = safeArea(comp, args.layout, args.default_margins);
    var found = scanCaptions(comp, prefix, mode);
    var out = {
      comp_id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      frameDuration: comp.frameDuration,
      safe: { left: safe.left, right: safe.right, top: safe.top, bottom: comp.height - safe.bottomY, width: safe.width },
      mode: mode,
      captions: [],
      boxes: [],
      total_captions: 0,
      total_boxes: 0,
      truncated: false
    };
    var numbers = [];
    for (var key in found.caps) {
      if (found.caps.hasOwnProperty(key)) numbers.push(Number(key));
    }
    numbers.sort(function (a, b) { return a - b; });
    // An optional number range pages past 500 captions: only [from_number, to_number] is listed,
    // and beyond_count says how many captions are numbered above to_number.
    var fromN = null;
    var toN = null;
    if (isNum(args.from_number)) fromN = args.from_number;
    if (isNum(args.to_number)) toN = args.to_number;
    if (fromN !== null || toN !== null) {
      var inRange = [];
      var beyond = 0;
      for (var ni = 0; ni < numbers.length; ni++) {
        if (toN !== null && numbers[ni] > toN) {
          beyond++;
          continue;
        }
        if (fromN !== null && numbers[ni] < fromN) continue;
        inRange.push(numbers[ni]);
      }
      numbers = inRange;
      out.beyond_count = beyond;
      out.from_number = fromN;
      out.to_number = toN;
    }
    out.total_captions = numbers.length;
    for (var i = 0; i < numbers.length; i++) {
      if (out.captions.length >= MAX_LIST) {
        out.truncated = true;
        break;
      }
      out.captions.push(captionEntry(found.caps[numbers[i]], numbers[i], mode, safe, comp, found.boxes[numbers[i]] || null));
    }
    var boxNumbers = [];
    for (var bk in found.boxes) {
      if (found.boxes.hasOwnProperty(bk)) boxNumbers.push(Number(bk));
    }
    boxNumbers.sort(function (a, b) { return a - b; });
    if (fromN !== null || toN !== null) {
      var boxIn = [];
      for (var bi = 0; bi < boxNumbers.length; bi++) {
        if (fromN !== null && boxNumbers[bi] < fromN) continue;
        if (toN !== null && boxNumbers[bi] > toN) continue;
        boxIn.push(boxNumbers[bi]);
      }
      boxNumbers = boxIn;
    }
    out.total_boxes = boxNumbers.length;
    for (var j = 0; j < boxNumbers.length; j++) {
      if (out.boxes.length >= MAX_LIST) {
        out.truncated = true;
        break;
      }
      var bl = found.boxes[boxNumbers[j]];
      out.boxes.push({ number: boxNumbers[j], name: bl.name, id: bl.id, index: bl.index, inPoint: bl.inPoint, outPoint: bl.outPoint, expression_errors: expressionErrors(bl) });
    }
    return out;
  };

  // ---------- write ----------

  function checkColor(c, what) {
    if (!c || typeof c.length !== "number" || c.length !== 3) fail("bad_args", what + " must be [r, g, b]");
    for (var i = 0; i < 3; i++) {
      if (!isNum(c[i]) || c[i] < 0 || c[i] > 1) fail("bad_args", what + " values must be numbers in 0..1");
    }
  }

  function checkRange(v, lo, hi, what) {
    if (!isNum(v) || v < lo || v > hi) fail("bad_args", what + " must be a number in " + lo + ".." + hi);
  }

  // Times to whole frames, in order and without overlap, checked against the comp.
  function normaliseCaptions(comp, caps, warnings, mode) {
    var fd = comp.frameDuration;
    var out = [];
    var i;
    for (i = 0; i < caps.length; i++) {
      var c = caps[i];
      if (!c || typeof c !== "object") fail("bad_args", "caption " + (i + 1) + " is not an object");
      if (!isNum(c.start) || !isNum(c.end)) fail("bad_args", "caption " + (i + 1) + " needs numeric start and end");
      if (c.start < 0) fail("bad_args", "caption " + (i + 1) + " starts before 0 s (" + c.start + ")");
      if (!c.lines || typeof c.lines.length !== "number" || c.lines.length === 0) fail("bad_args", "caption " + (i + 1) + " has no lines");
      var lines = [];
      for (var li = 0; li < c.lines.length; li++) {
        var ln = String(c.lines[li]).split("\r").join(" ").split("\n").join(" ");
        if (wordCount(ln) === 0) fail("bad_args", "caption " + (i + 1) + " has an empty line");
        lines.push(ln);
      }
      var s = Math.round(c.start / fd) * fd;
      var e = Math.round(c.end / fd) * fd;
      if (e <= s) e = s + fd;
      if (s >= comp.duration) {
        fail("bad_args", "caption " + (i + 1) + " starts at " + s + " s, past the comp's length (" + comp.duration + " s); shorten the transcript or use offset");
      }
      out.push({ start: s, end: e, lines: lines, text: lines.join("\r"), words: [] });
      if (c.words && typeof c.words.length === "number") {
        for (var wi = 0; wi < c.words.length; wi++) {
          if (!c.words[wi] || !isNum(c.words[wi].start)) fail("bad_args", "caption " + (i + 1) + " word " + (wi + 1) + " needs a numeric start");
          out[i].words.push({ start: Math.round(c.words[wi].start / fd) * fd });
        }
      }
    }
    // One layer, one key per start time: a caption that rounds onto the previous caption's frame would replace its key.
    // Move it one frame on (in order) and say so, rather than lose a caption.
    if (mode === "single") {
      for (i = 1; i < out.length; i++) {
        // At or before the previous (already moved) start, while the raw starts are in order: a run of captions inside one frame steps on one frame each.
        if (out[i].start <= out[i - 1].start + 1e-6 && caps[i].start >= caps[i - 1].start) {
          out[i].start = out[i - 1].start + fd;
          if (out[i].end <= out[i].start) out[i].end = out[i].start + fd;
          if (out[i].start >= comp.duration) {
            fail("bad_args", "caption " + (i + 1) + " shares a frame with caption " + i + " and would start past the comp's length (" + comp.duration + " s); merge the two captions");
          }
          for (var nw = 0; nw < out[i].words.length; nw++) {
            if (out[i].words[nw].start < out[i].start) out[i].words[nw].start = out[i].start;
          }
          if (warnings) warnings.push("caption " + (i + 1) + " rounded onto the same frame as caption " + i + "; it was moved one frame later so neither key is lost");
        }
      }
    }
    for (i = 0; i < out.length; i++) {
      if (i > 0 && out[i].start < out[i - 1].start) fail("bad_args", "captions must be in time order (caption " + (i + 1) + " starts before caption " + i + ")");
      if (i + 1 < out.length && out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start + fd, out[i + 1].start);
      var prev = out[i].start;
      // A word may not start at or after the caption's end: in single mode it would override the next caption's keys.
      var lastStart = Math.max(out[i].start, out[i].end - fd);
      var clamped = 0;
      for (var w = 0; w < out[i].words.length; w++) {
        if (out[i].words[w].start < prev) out[i].words[w].start = prev;
        if (out[i].words[w].start > lastStart + 1e-6) {
          out[i].words[w].start = lastStart;
          clamped++;
        }
        prev = out[i].words[w].start + fd;
      }
      if (clamped > 0 && warnings) {
        warnings.push("caption " + (i + 1) + ": " + clamped + " word time" + (clamped === 1 ? "" : "s") + " fell after the caption's end and were moved to its last frame (fast speech)");
      }
    }
    return out;
  }

  function setSpan(layer, s, e) {
    if (s > layer.outPoint) {
      layer.outPoint = e;
      layer.inPoint = s;
    } else {
      layer.inPoint = s;
      layer.outPoint = e;
    }
  }

  // Index of the point-text first baseline for a block of n lines, from the layout position.
  function pointPosition(comp, safe, fontSize, n, justification, position) {
    var lh = fontSize * 1.2;
    var x = comp.width / 2;
    if (justification === "left") x = safe.left;
    else if (justification === "right") x = comp.width - safe.right;
    var y = safe.bottomY - fontSize * 0.25 - (n - 1) * lh;
    if (position === "top") y = safe.topY + fontSize * 0.8;
    else if (position === "middle") y = comp.height / 2 + fontSize * 0.35 - ((n - 1) * lh) / 2;
    return [x, y];
  }

  // A paragraph box's top-left corner (assumed to be the layer's position), the box sitting in the safe area.
  function boxPosition(comp, safe, bw, bh, justification, position) {
    var x = (comp.width - bw) / 2;
    if (justification === "left") x = safe.left;
    else if (justification === "right") x = comp.width - safe.right - bw;
    var y = safe.bottomY - bh;
    if (position === "top") y = safe.topY;
    else if (position === "middle") y = (comp.height - bh) / 2;
    return [x, y];
  }

  function holdKeys(prop) {
    for (var k = 1; k <= prop.numKeys; k++) {
      try {
        if (typeof prop.isInterpolationTypeValid === "function" && !prop.isInterpolationTypeValid(KeyframeInterpolationType.HOLD)) continue;
        prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
      } catch (e) {}
    }
  }

  function clearKeys(prop) {
    while (prop.numKeys > 0) prop.removeKey(prop.numKeys);
  }

  function styleDoc(doc, st, isNew) {
    if (st.font) doc.font = st.font;
    doc.fontSize = st.fontSize;
    doc.applyFill = true;
    doc.fillColor = [st.fill[0], st.fill[1], st.fill[2]];
    if (st.stroke) {
      doc.applyStroke = true;
      doc.strokeColor = [st.stroke[0], st.stroke[1], st.stroke[2]];
      doc.strokeWidth = st.strokeWidth;
    } else if (isNew) {
      doc.applyStroke = false;
    }
    doc.justification = justificationValue(st.justification);
  }

  function setPosition(layer, pos) {
    layer.property("ADBE Transform Group").property("ADBE Position").setValue([pos[0], pos[1]]);
  }

  // The highlight animator: Fill Color on a range selector in Index units, Based On Words,
  // Start and End hold-keyed per word. Re-keys an existing one.
  function applyHighlight(layer, color, keys) {
    var anims = animatorsOf(layer);
    var ai = 0;
    var i;
    for (i = 1; i <= anims.numProperties; i++) {
      if (anims.property(i).name === HIGHLIGHT_NAME) {
        ai = i;
        break;
      }
    }
    // addProperty invalidates references to the layer's other properties: every step walks down from the layer again.
    var anim = function () { return animatorsOf(layer).property(ai); };
    var selector = function () { return anim().property("ADBE Text Selectors").property(1); };
    if (ai === 0) {
      animatorsOf(layer).addProperty("ADBE Text Animator");
      ai = animatorsOf(layer).numProperties;
      anim().name = HIGHLIGHT_NAME;
      anim().property("ADBE Text Animator Properties").addProperty("ADBE Text Fill Color");
      anim().property("ADBE Text Selectors").addProperty("ADBE Text Selector");
    }
    var fill = anim().property("ADBE Text Animator Properties").property("ADBE Text Fill Color");
    if (fill) fill.setValue([color[0], color[1], color[2]]);
    if (!selector()) fail("runtime", "The highlight animator has no range selector");
    var adv = function () { return selector().property("ADBE Text Range Advanced"); };
    adv().property("ADBE Text Range Units").setValue(2);
    adv().property("ADBE Text Range Type2").setValue(3);
    var startProp = function () { return selector().property("ADBE Text Index Start"); };
    var endProp = function () { return selector().property("ADBE Text Index End"); };
    if (!startProp() || !endProp()) fail("runtime", "The range selector has no Index Start/End (Units did not switch to Index)");
    clearKeys(startProp());
    clearKeys(endProp());
    for (i = 0; i < keys.length; i++) {
      startProp().setValueAtTime(keys[i].t, keys[i].a);
      endProp().setValueAtTime(keys[i].t, keys[i].b);
    }
    holdKeys(startProp());
    holdKeys(endProp());
    return startProp().numKeys;
  }

  // Takes a leftover highlight animator off a layer; true when one was removed.
  function removeHighlight(layer) {
    var anims = animatorsOf(layer);
    for (var i = 1; i <= anims.numProperties; i++) {
      if (anims.property(i).name === HIGHLIGHT_NAME) {
        animatorsOf(layer).property(i).remove();
        return true;
      }
    }
    return false;
  }

  // Index-unit keys for the captions one layer shows: nothing selected until a word starts,
  // then word i (Start i, End i+1); later keys replace earlier ones at the same time.
  function highlightKeys(caps, single) {
    var raw = [];
    var i;
    for (i = 0; i < caps.length; i++) {
      var c = caps[i];
      if (c.words.length === 0) continue;
      if (c.words[0].start > c.start + 1e-6) raw.push({ t: c.start, a: 0, b: 0 });
      for (var w = 0; w < c.words.length; w++) raw.push({ t: c.words[w].start, a: w, b: w + 1 });
      if (single) raw.push({ t: c.end, a: 0, b: 0 });
    }
    var keys = [];
    for (i = 0; i < raw.length; i++) {
      if (keys.length > 0 && Math.abs(keys[keys.length - 1].t - raw[i].t) < 1e-6) keys[keys.length - 1] = raw[i];
      else keys.push(raw[i]);
    }
    return keys;
  }

  // Writes a box's look (size and opacity expressions, roundness, fill) from the validated box args.
  // Every property is looked up again from the layer; nothing is added here.
  function styleBox(layer, textLayer, box) {
    var tg = function () { return layer.property("ADBE Transform Group"); };
    var contents = function () { return layer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group"); };
    var ref = "var t = thisComp.layer(" + quoteJs(textLayer.name) + "); var r = t.sourceRectAtTime(time, false);\n";
    var pad2 = box.padding * 2;
    var rect = function () { return contents().property("ADBE Vector Shape - Rect"); };
    rect().property("ADBE Vector Rect Size").expression = ref + "[r.width + " + pad2 + ", r.height + " + pad2 + "];";
    rect().property("ADBE Vector Rect Position").expression = ref + "t.toComp([r.left + r.width / 2, r.top + r.height / 2]);";
    rect().property("ADBE Vector Rect Roundness").setValue(box.roundness);
    contents().property("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue([box.color[0], box.color[1], box.color[2], 1]);
    // An empty gap in a hold-keyed layer would leave a padded square behind: hide the box while the text is empty.
    // sourceRectAtTime still answers outside the text layer's span: test the span too.
    tg().property("ADBE Opacity").expression = ref + "var o = 0; if (r.width > 0 && time >= t.inPoint && time < t.outPoint) o = " + box.opacity + "; o;";
  }

  // Whether styleBox can rewrite this box without throwing; null when it can, else the reason.
  function boxProblem(layer) {
    var notBox = "is not a caption box made by this tool; remove it or use another name_prefix";
    try {
      var g = layer.property("ADBE Root Vectors Group").property(1);
      var c = g ? g.property("ADBE Vectors Group") : null;
      if (!c) return notBox;
      var rect = c.property("ADBE Vector Shape - Rect");
      var fill = c.property("ADBE Vector Graphic - Fill");
      if (!rect || !fill) return notBox;
      var sz = rect.property("ADBE Vector Rect Size");
      var ps = rect.property("ADBE Vector Rect Position");
      var rd = rect.property("ADBE Vector Rect Roundness");
      var fc = fill.property("ADBE Vector Fill Color");
      var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
      if (!sz || !ps || !rd || !fc || !op) return notBox;
      if (rd.numKeys > 0 || fc.numKeys > 0) return "has keyframes on Roundness/Fill Color; remove them or leave restyle off";
    } catch (e) {
      return notBox;
    }
    return null;
  }

  // A shape layer under the text whose rectangle follows the text's extents.
  function makeBox(comp, textLayer, name, box) {
    var layer = comp.layers.addShape();
    layer.name = name;
    layer.moveAfter(textLayer);
    var tg = function () { return layer.property("ADBE Transform Group"); };
    tg().property("ADBE Position").setValue([0, 0]);
    tg().property("ADBE Anchor Point").setValue([0, 0]);
    var root = layer.property("ADBE Root Vectors Group");
    root.addProperty("ADBE Vector Group");
    var contents = function () { return layer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group"); };
    contents().addProperty("ADBE Vector Shape - Rect");
    contents().addProperty("ADBE Vector Graphic - Fill");
    styleBox(layer, textLayer, box);
    return layer;
  }

  A.captionsApply = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var mode = args.mode;
    if (mode !== "layers" && mode !== "single") fail("bad_args", "mode must be 'layers' or 'single'");
    var prefix = args.name_prefix;
    if (typeof prefix !== "string" || prefix.length < 1 || prefix.length > 100) fail("bad_args", "name_prefix must be a string of 1..100 characters");
    var first = args.first_number === undefined || args.first_number === null ? 1 : args.first_number;
    if (!isNum(first) || first < 1 || Math.floor(first) !== first) fail("bad_args", "first_number must be a whole number of 1 or more");
    var raw = args.captions;
    if (!raw || typeof raw.length !== "number" || raw.length < 1 || raw.length > MAX_CAPTIONS) fail("bad_args", "give 1.." + MAX_CAPTIONS + " captions");
    var warnings = [];
    var caps = normaliseCaptions(comp, raw, warnings, mode);

    var hl = args.highlight;
    if (hl) {
      checkColor(hl.color, "highlight.color");
      for (var hi = 0; hi < caps.length; hi++) {
        if (caps[hi].words.length !== wordCount(caps[hi].text)) {
          fail("bad_args", "caption " + (hi + 1) + " has " + wordCount(caps[hi].text) + " words but " + caps[hi].words.length + " word times; the highlight needs one per word");
        }
      }
    }
    var box = args.box;
    if (box) {
      checkColor(box.color, "box.color");
      checkRange(box.opacity, 0, 100, "box.opacity");
      checkRange(box.padding, 0, 1000, "box.padding");
      checkRange(box.roundness, 0, 1000, "box.roundness");
    }

    // Style: the comp's short side sets the default size.
    var s = args.style || {};
    var short = Math.min(comp.width, comp.height);
    var st = {
      font: s.font,
      fontSize: s.font_size,
      fill: s.fill_color || [1, 1, 1],
      stroke: s.stroke_color || null,
      strokeWidth: s.stroke_width,
      justification: s.justification || "center"
    };
    if (st.font !== undefined && st.font !== null && (typeof st.font !== "string" || st.font.length < 1 || st.font.length > 200)) fail("bad_args", "style.font must be a PostScript font name of 1..200 characters");
    if (st.fontSize === undefined || st.fontSize === null) st.fontSize = Math.round(short * 0.06);
    checkRange(st.fontSize, 1, 1296, "style.font_size");
    checkColor(st.fill, "style.fill_color");
    if (st.stroke) {
      checkColor(st.stroke, "style.stroke_color");
      if (st.strokeWidth === undefined || st.strokeWidth === null) st.strokeWidth = Math.max(1, Math.round(st.fontSize / 12));
      checkRange(st.strokeWidth, 0, 200, "style.stroke_width");
    }
    justificationValue(st.justification);
    var textBox = s.text_box || null;
    if (textBox) {
      if (textBox.width !== undefined && textBox.width !== null) checkRange(textBox.width, 1, 30000, "style.text_box.width");
      if (textBox.height !== undefined && textBox.height !== null) checkRange(textBox.height, 1, 30000, "style.text_box.height");
    }
    var layout = args.layout || {};
    var position = layout.position || "bottom";
    if (position !== "bottom" && position !== "middle" && position !== "top") fail("bad_args", "layout.position must be bottom, middle or top");
    var safe = safeArea(comp, layout, args.default_margins);
    // With a background box, the text is placed padding px inside the safe area so the box itself stays inside it.
    var place = safe;
    if (box) {
      place = { left: safe.left + box.padding, right: safe.right + box.padding, topY: safe.topY + box.padding, bottomY: safe.bottomY - box.padding, width: safe.width - box.padding * 2 };
      if (place.width < 1 || place.bottomY - place.topY < 1) fail("bad_args", "box.padding (" + box.padding + ") leaves no room inside the safe area; use a smaller padding or smaller margins");
    }
    var restyle = args.restyle === true;
    var removeStale = args.remove_stale !== false;

    // What exists already, by name; nothing is touched yet.
    var found = scanCaptions(comp, prefix, mode);
    var numberOf = function (i) {
      if (mode === "single") return 1;
      return first + i;
    };
    var count = caps.length;
    if (mode === "single") count = 1;
    var existingCaps = [];
    var i;
    for (i = 0; i < count; i++) {
      var ex = found.caps[numberOf(i)];
      existingCaps.push(ex || null);
      if (ex) {
        if (!isTextLayer(ex)) fail("bad_args", "Layer \"" + ex.name + "\" has a caption's name but is not a text layer");
        if (mode === "layers" && sourceTextProp(ex).numKeys > 0) {
          fail("bad_args", "Layer \"" + ex.name + "\" has Source Text keyframes; remove them or use another name_prefix");
        }
        if (ex.locked === true) fail("bad_args", "Layer \"" + ex.name + "\" is locked; unlock it first");
        if (ex.startTime !== 0) warnings.push("\"" + ex.name + "\" starts at " + ex.startTime + " s, not 0: its keys are written in comp time");
      }
      var exBox = found.boxes[numberOf(i)];
      if (exBox && !isShapeLayer(exBox)) fail("bad_args", "Layer \"" + exBox.name + "\" has a box's name but is not a shape layer");
      if (exBox && exBox.locked === true) fail("bad_args", "Layer \"" + exBox.name + "\" is locked; unlock it first");
      if (exBox && box && restyle) {
        var bProblem = boxProblem(exBox);
        if (bProblem) fail("bad_args", "Layer \"" + exBox.name + "\" " + bProblem);
      }
    }
    // Names pad to three digits and grow only when a number needs more ("Caption 501", "Caption 1000"),
    // so chunks of one transcript named in separate calls agree.
    var width = 3;
    var lastNumber = first + count - 1;
    var stale = [];
    if (removeStale && mode === "layers") {
      for (i = 0; i < found.list.length; i++) {
        var f = found.list[i];
        if (f.number > lastNumber) stale.push(f.layer);
      }
      for (i = 0; i < stale.length; i++) {
        if (stale[i].locked === true) fail("bad_args", "Layer \"" + stale[i].name + "\" is locked and would be removed as stale; unlock it first or set remove_stale to false");
      }
    }

    var maxLines = 1;
    for (i = 0; i < caps.length; i++) {
      if (caps[i].lines.length > maxLines) maxLines = caps[i].lines.length;
    }

    return A.withUndo(args.label || "Captions", function () {
      var created = [];
      var updated = [];
      var removed = [];
      var madeLayers = [];
      var highlightKeyCount = 0;
      var boxCount = 0;
      var boxKept = 0;

      try {
        // The paragraph box this caption needs: wide as asked (or the safe width on a new/restyled layer), tall for its lines.
        var wantSize = function (curW, fsz, nLines, fresh) {
          var bw = null;
          if (textBox && isNum(textBox.width)) bw = textBox.width;
          if (bw === null) {
            if (curW !== null && !fresh) bw = curW;
            else bw = place.width;
          }
          var bh = fsz * 1.2 * nLines;
          if (textBox && isNum(textBox.height)) bh = textBox.height;
          return [bw, bh];
        };
        // An existing paragraph caption: a new text can have more lines than the old box holds, and AE hides the overflow.
        var fitBox = function (d, nLines, fresh) {
          var boxed = false;
          try { boxed = d.boxText === true; } catch (eB) {}
          if (!boxed) return null;
          var curW = null;
          try {
            if (d.boxTextSize && isNum(d.boxTextSize[0])) curW = d.boxTextSize[0];
          } catch (eW) {}
          var curH = null;
          try {
            if (d.boxTextSize && isNum(d.boxTextSize[1])) curH = d.boxTextSize[1];
          } catch (eH) {}
          var sz = wantSize(curW, d.fontSize, nLines, fresh);
          if (!(textBox && isNum(textBox.height))) {
            // The height the lines need at the layer's own leading; a plain update never shrinks a box the user made taller.
            var lead = d.fontSize * 1.2;
            try {
              if (d.autoLeading === false && isNum(d.leading)) lead = d.leading;
            } catch (eL) {}
            var needed = lead * nLines;
            if (!fresh && curH !== null && curH > needed) needed = curH;
            sz[1] = needed;
          }
          try {
            d.boxTextSize = [sz[0], sz[1]];
          } catch (eS) {
            warnings.push("could not resize the paragraph box: " + A.formatError(eS) + "; lines past the box may be hidden");
            return null;
          }
          return [sz[0], sz[1]];
        };
        var applyOne = function (idx, capsOnLayer, nLines, existing, name, boxName, existingBox, srcCaps) {
          var layer = existing;
          var isNew = false;
          var fitted = null;
          var first0 = capsOnLayer[0];
          var last0 = capsOnLayer[capsOnLayer.length - 1];
          var src;
          var doc;
          if (!layer) {
            isNew = true;
            if (textBox) {
              layer = comp.layers.addBoxText(wantSize(null, st.fontSize, nLines, true), first0.text);
            } else {
              layer = comp.layers.addText(first0.text);
            }
            madeLayers.push(layer);
            layer.name = name;
            created.push(name);
          } else {
            updated.push(layer.name);
          }
          src = sourceTextProp(layer);
          if (mode === "single") {
            // The style comes from the first key when there are keys: the value at the playhead may be a blank gap key.
            if (!isNew && src.numKeys > 0) doc = src.keyValue(1);
            else doc = src.value;
            if (isNew || restyle) styleDoc(doc, st, isNew);
            if (!isNew) fitted = fitBox(doc, nLines, restyle);
            clearKeys(src);
            // A fresh static value first, so the keys below start from the layer's own style.
            doc.text = first0.text;
            src.setValue(doc);
            for (var c = 0; c < srcCaps.length; c++) {
              doc.text = srcCaps[c].text;
              src.setValueAtTime(srcCaps[c].start, doc);
              var gapAfter = c + 1 >= srcCaps.length || srcCaps[c + 1].start > srcCaps[c].end + 1e-6;
              if (gapAfter) {
                doc.text = "";
                src.setValueAtTime(srcCaps[c].end, doc);
              }
            }
          } else {
            doc = src.value;
            doc.text = first0.text;
            if (isNew || restyle) styleDoc(doc, st, isNew);
            if (!isNew) fitted = fitBox(doc, nLines, restyle);
            src.setValue(doc);
          }
          if (isNew || restyle) {
            var pos;
            // An existing point-text caption stays point text: placing it as a box would put its baseline a box height too high.
            var placeAsBox = !!textBox;
            if (placeAsBox && !isNew) {
              var wasBoxed = false;
              try { wasBoxed = doc.boxText === true; } catch (eWb) {}
              if (!wasBoxed) {
                placeAsBox = false;
                warnings.push("\"" + layer.name + "\" is point text, so text_box does not apply to it; it was placed as point text (remove it to make it again as a box)");
              }
            }
            if (placeAsBox) {
              var sz2 = wantSize(null, st.fontSize, nLines, true);
              var bw2 = sz2[0];
              var bh2 = sz2[1];
              if (!isNew && fitted) {
                bw2 = fitted[0];
                bh2 = fitted[1];
              }
              pos = boxPosition(comp, place, bw2, bh2, st.justification, position);
              // Position is where the box's origin sits, not necessarily its top-left corner: subtract boxTextPos when AE reports it.
              var offset = false;
              try {
                var cur = sourceTextProp(layer).value;
                var btp = cur.boxTextPos;
                if (cur.boxText !== false && btp && btp.length >= 2 && isNum(btp[0]) && isNum(btp[1])) {
                  pos = [pos[0] - btp[0], pos[1] - btp[1]];
                  offset = true;
                }
              } catch (eBtp) {}
              // Without boxTextPos: when the layer's own extents are the box, the offset is where its top-left sits from the origin.
              if (!offset) {
                try {
                  var rr = layer.sourceRectAtTime(layer.inPoint, false);
                  var anc2 = layer.property("ADBE Transform Group").property("ADBE Anchor Point").value;
                  if (Math.abs(rr.width - bw2) < 1 && Math.abs(rr.height - bh2) < 1) {
                    pos = [pos[0] - (rr.left - anc2[0]), pos[1] - (rr.top - anc2[1])];
                  }
                } catch (eRr) {}
              }
            } else {
              pos = pointPosition(comp, place, st.fontSize, nLines, st.justification, position);
            }
            setPosition(layer, pos);
          }
          setSpan(layer, first0.start, last0.end);
          if (hl) {
            highlightKeyCount += applyHighlight(layer, hl.color, highlightKeys(capsOnLayer, mode === "single"));
          } else if (!isNew) {
            // An earlier run's word keys no longer match the new text.
            var hadHl = false;
            try {
              hadHl = removeHighlight(layer);
            } catch (eHl) {
              warnings.push("\"" + layer.name + "\" still has the Caption Highlight animator from an earlier run (could not remove it: " + A.formatError(eHl) + "); its word keys are stale");
            }
            if (hadHl) warnings.push("removed the old Caption Highlight animator from \"" + layer.name + "\" (no highlight given this run)");
          }
          if (box) {
            var bl = existingBox;
            if (!bl) {
              bl = makeBox(comp, layer, boxName, box);
              madeLayers.push(bl);
              created.push(boxName);
            } else {
              updated.push(bl.name);
              // The box's look comes from the box options when the style is reset; otherwise it is kept.
              if (restyle) styleBox(bl, layer, box);
              else boxKept++;
            }
            setSpan(bl, first0.start, last0.end);
            boxCount++;
          } else if (existingBox) {
            // No box given: an earlier run's box still follows the text, so its span follows too.
            setSpan(existingBox, first0.start, last0.end);
            warnings.push("\"" + existingBox.name + "\" is from an earlier run; only its in and out were moved to the caption's");
          }
          return layer;
        };

        if (mode === "single") {
          applyOne(0, caps, maxLines, existingCaps[0], prefix, prefix + " Box", found.boxes[1] || null, caps);
        } else {
          for (i = 0; i < caps.length; i++) {
            var n = numberOf(i);
            var nm = prefix + " " + pad(n, width);
            applyOne(i, [caps[i]], caps[i].lines.length, existingCaps[i], nm, nm + " Box", found.boxes[n] || null, null);
          }
        }
        if (boxKept > 0) warnings.push(boxKept + " existing box" + (boxKept === 1 ? "" : "es") + " kept the earlier look (color, opacity, padding, roundness); pass restyle: true to apply the box options");
        // Stale layers go last, so a failure above leaves the old captions in place.
        for (i = 0; i < stale.length; i++) {
          removed.push(stale[i].name);
          stale[i].remove();
        }
      } catch (e) {
        // Take back what this call added; edits to existing layers stay in the undo group.
        for (var r = madeLayers.length - 1; r >= 0; r--) {
          try { madeLayers[r].remove(); } catch (eRm) {}
        }
        throw e;
      }

      var timings = [];
      for (i = 0; i < caps.length; i++) timings.push([caps[i].start, caps[i].end]);
      return {
        comp_id: comp.id,
        mode: mode,
        name_prefix: prefix,
        first_number: first,
        count: caps.length,
        created: created,
        updated: updated,
        removed: removed,
        timings: timings,
        highlight_keys: highlightKeyCount,
        boxes: boxCount,
        font_size: st.fontSize,
        justification: st.justification,
        safe: { left: safe.left, right: safe.right, top: safe.top, bottom: comp.height - safe.bottomY, width: safe.width },
        warnings: warnings
      };
    });
  };
})($.global);
