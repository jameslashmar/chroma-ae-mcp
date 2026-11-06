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
//   follows the text through sourceRectAtTime). Two more modes: "words" (one
//   text layer per word, named "<prefix> 001.02", laid out by measuring each
//   word with sourceRectAtTime, each visible from its word's time to the
//   caption's end) and "template" (one precomp layer of a template comp per
//   caption, with the comp's Essential Properties set to the caption's text).
//   Options on top: parent_to_null, precompose, and match "time" (an explicit
//   old-layer -> new-number mapping from Node). A caption may carry a colour
//   (speaker) and italic (lyric); a "look" (pop, pill_slide, fill_sweep) adds
//   word-timed text animators, layer keys or a sliding pill shape.
// - captionsTemplate (guarded write): a new comp holding one styled caption layer
//   with its Source Text, fill colour and box colour and opacity in Essential
//   Graphics, ready for ae_export_mogrt (a caption template for Premiere);
//   captionsTemplateRead (read) lists its controllers
//   captionsTemplateMeasure (read; a temporary text layer, taken out again) the widest line of each caption in the template's style
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
  // Look animators are all named "Caption Look..."; the main one is exactly "Caption Look".
  var LOOK_NAME = "Caption Look";
  var LOOK_SCALE_NAME = "Caption Look Scale";
  var LOOK_OVERSHOOT_NAME = "Caption Look Overshoot";
  // Word layers (words mode) carry this in their comment when a look keyed their Transform.
  var LOOK_MARK = "chroma-ae caption look:";

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
  // a platform's margins (fractions, from Node) replace them, and the layout's own
  // margins win key by key.
  function safeArea(comp, layout, defaults, platform) {
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
    if (platform) {
      if (isNum(platform.top)) m.top = platform.top;
      if (isNum(platform.bottom)) m.bottom = platform.bottom;
      if (isNum(platform.left)) m.left = platform.left;
      if (isNum(platform.right)) m.right = platform.right;
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
    } else if (rest.length > 5 && rest.substring(rest.length - 5) === " Look") {
      kind = "look";
      rest = rest.substring(0, rest.length - 5);
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
    var found = { caps: {}, boxes: {}, looks: {}, list: [] };
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
      else if (parsed.kind === "look") bucket = found.looks;
      if (bucket[parsed.number]) {
        fail("bad_args", "Two layers answer to caption " + parsed.number + " (\"" + bucket[parsed.number].name + "\" and \"" + l.name + "\"); rename or remove one");
      }
      bucket[parsed.number] = l;
      found.list.push({ number: parsed.number, kind: parsed.kind, layer: l });
    }
    return found;
  }

  // A layer by exact name (the first), or null.
  function findNamedLayer(comp, name) {
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      if (l.name === name) return l;
    }
    return null;
  }

  // Splits "<prefix> <digits>.<digits>" into caption and word numbers (words mode).
  function wordLayerName(name, prefix) {
    var head = prefix + " ";
    if (name.length <= head.length || name.substring(0, head.length) !== head) return null;
    var rest = name.substring(head.length);
    var dot = rest.indexOf(".");
    if (dot < 1) return null;
    var a = rest.substring(0, dot);
    var b = rest.substring(dot + 1);
    if (!allDigits(a) || !allDigits(b)) return null;
    return { number: parseInt(a, 10), word: parseInt(b, 10) };
  }

  // The word layers a prefix finds: caps[number][word] = layer. list has {number, word, layer, kind}.
  function scanWordLayers(comp, prefix) {
    var found = { caps: {}, boxes: {}, looks: {}, list: [] };
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      var parsed = wordLayerName(l.name, prefix);
      if (!parsed) {
        // A pill look layer, "<prefix> 001 Look".
        var lk = captionName(l.name, prefix);
        if (lk && lk.kind === "look") {
          found.looks[lk.number] = l;
          found.list.push({ number: lk.number, word: 0, kind: "look", layer: l });
        }
        continue;
      }
      if (!found.caps[parsed.number]) found.caps[parsed.number] = {};
      if (found.caps[parsed.number][parsed.word]) {
        fail("bad_args", "Two layers answer to word " + parsed.word + " of caption " + parsed.number + " (\"" + found.caps[parsed.number][parsed.word].name + "\" and \"" + l.name + "\"); rename or remove one");
      }
      found.caps[parsed.number][parsed.word] = l;
      found.list.push({ number: parsed.number, word: parsed.word, kind: "caption", layer: l });
    }
    return found;
  }

  function sortedNumbers(map) {
    var out = [];
    for (var k in map) {
      if (map.hasOwnProperty(k)) out.push(Number(k));
    }
    out.sort(function (a, b) { return a - b; });
    return out;
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

  // A property of a range selector: its own children first, then the Advanced group's.
  function selProp(sel, matchName) {
    var p = null;
    try { p = sel.property(matchName); } catch (e0) { p = null; }
    if (p) return p;
    var adv = null;
    try { adv = sel.property("ADBE Text Range Advanced"); } catch (e1) { adv = null; }
    if (adv) {
      try { p = adv.property(matchName); } catch (e2) { p = null; }
    }
    return p;
  }

  // The tool's marks in a layer's comment, ";"-separated, any other text kept: the line a word layer was laid out on
  // (so a re-run with the same words on other lines is laid out again), the style the tool wrote ("c" a speaker colour,
  // "i" faux italic, so a re-run without them can put the layer back), and the look whose Transform keys are the tool's.
  var LINE_MARK = "chroma-ae caption line:";
  var STYLE_MARK = "chroma-ae caption style:";
  function readMarks(layer) {
    var c = "";
    try { c = String(layer.comment || ""); } catch (e) { c = ""; }
    var m = { line: -1, look: "", style: "", other: [] };
    if (c === "") return m;
    var parts = c.split(";");
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part.indexOf(LINE_MARK) === 0) {
        var n = parseInt(part.substring(LINE_MARK.length), 10);
        if (!isNaN(n)) m.line = n;
      } else if (part.indexOf(LOOK_MARK) === 0) {
        m.look = part.substring(LOOK_MARK.length);
      } else if (part.indexOf(STYLE_MARK) === 0) {
        m.style = part.substring(STYLE_MARK.length);
      } else {
        m.other.push(part);
      }
    }
    return m;
  }
  function writeMarks(layer, m) {
    var parts = m.other.slice(0);
    if (m.line >= 0) parts.push(LINE_MARK + m.line);
    if (m.style !== "") parts.push(STYLE_MARK + m.style);
    if (m.look !== "") parts.push(LOOK_MARK + m.look);
    var out = parts.join(";");
    var cur = "";
    try { cur = String(layer.comment || ""); } catch (e) { cur = ""; }
    if (cur !== out) layer.comment = out;
  }
  function lookMarkOf(layer) {
    return readMarks(layer).look;
  }
  function lineMarkOf(layer) {
    return readMarks(layer).line;
  }

  // The look a text layer's animators (or its pill layer) carry: { present, kind?, keys? }.
  function lookInfo(layer, pillLayer) {
    var info = { present: false };
    try {
      var anims = animatorsOf(layer);
      for (var i = 1; i <= anims.numProperties; i++) {
        var a = anims.property(i);
        if (a.name.indexOf(LOOK_NAME) !== 0) continue;
        info.present = true;
        if (a.name !== LOOK_NAME) continue;
        var props = a.property("ADBE Text Animator Properties");
        var sel = a.property("ADBE Text Selectors").property(1);
        if (props && props.property("ADBE Text Fill Color")) {
          info.kind = "fill_sweep";
          // Layers mode keys End in index units, words mode in percent.
          var se = sel ? selProp(sel, "ADBE Text Index End") : null;
          var sp = sel ? selProp(sel, "ADBE Text Percent End") : null;
          var kn = 0;
          if (se && se.numKeys > kn) kn = se.numKeys;
          if (sp && sp.numKeys > kn) kn = sp.numKeys;
          info.keys = kn;
        } else if (props && props.property("ADBE Text Opacity")) {
          info.kind = "pop";
          var ss = sel ? selProp(sel, "ADBE Text Index Start") : null;
          if (ss) info.keys = ss.numKeys;
        }
      }
    } catch (eL) {}
    if (!info.present && pillLayer) {
      info.present = true;
      info.kind = "pill_slide";
      try {
        info.keys = pillLayer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group").property("ADBE Vector Shape - Rect").property("ADBE Vector Rect Position").numKeys;
      } catch (eP) {}
    }
    return info;
  }

  // The fill colour and faux italic of a TextDocument, for the read-back.
  function docStyle(doc, into) {
    try {
      var fc = doc.fillColor;
      if (fc && fc.length >= 3) into.fill = [fc[0], fc[1], fc[2]];
    } catch (e1) {}
    try { into.faux_italic = doc.fauxItalic === true; } catch (e2) {}
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
      // TikTok's lower-right rail (likes, comments, share) is wider than the rest of the right margin.
      if (r.width > 0 && safe.rail === true && x1 > comp.width * (780 / 1080) + 0.5 && y1 > comp.height * (840 / 1920) + 0.5) out.rail_overlap = true;
      if (r.width > 0) {
        // Captions are placed by baseline, so descenders (commas, g, p, y) may hang below the safe bottom by design.
        var descent = 0;
        try {
          var dsz = Number(layer.property("ADBE Text Properties").property("ADBE Text Document").value.fontSize);
          if (dsz > 0) descent = 0.3 * dsz;
        } catch (eD) {}
        out.outside_safe = x0 < safe.left - 0.5 || x1 > comp.width - safe.right + 0.5 || y0 < safe.top - 0.5 || y1 > safe.bottomY + descent + 0.5;
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

  function captionEntry(l, number, mode, safe, comp, boxLayer, pillLayer) {
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
    docStyle(doc, entry);
    entry.look = lookInfo(l, pillLayer || null);
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
        docStyle(kd, item);
        if (String(kd.text) !== "") {
          var ri = rectInfo(l, t, safe, comp, boxLayer);
          if (ri.rect) {
            item.width = ri.rect.width;
            item.outside_safe = ri.outside_safe;
            if (ri.rail_overlap === true) {
              item.rail_overlap = true;
              entry.rail_overlap = true;
            }
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
      if (ri2.rail_overlap === true) entry.rail_overlap = true;
      if (ri2.rect_error) entry.rect_error = ri2.rect_error;
    }
    return entry;
  }

  // One words-mode caption: its word layers in word order, with the union of their extents (comp space).
  function wordsEntry(prefix, number, byWord, safe, comp, pillLayer) {
    var nums = sortedNumbers(byWord);
    var words = [];
    var texts = [];
    var inP = null;
    var outP = null;
    var firstLayer = byWord[nums[0]];
    var box = null;
    var rail = false;
    var descent = 0;
    var look = { present: false };
    var looked = 0;
    for (var i = 0; i < nums.length; i++) {
      var l = byWord[nums[i]];
      var text = "";
      var wstyle = {};
      if (isTextLayer(l)) {
        try { text = String(sourceTextProp(l).value.text); } catch (eT) {}
        // Captions are placed by baseline, so descenders may hang below the safe bottom by design (as in rectInfo).
        try {
          var wfs = Number(sourceTextProp(l).value.fontSize);
          if (wfs > 0 && 0.3 * wfs > descent) descent = 0.3 * wfs;
        } catch (eFs) {}
        try { docStyle(sourceTextProp(l).value, wstyle); } catch (eS) {}
        var wl = lookInfo(l, null);
        var mark = lookMarkOf(l);
        if (mark !== "") {
          wl.present = true;
          wl.kind = mark;
          try { wl.keys = l.property("ADBE Transform Group").property("ADBE Scale").numKeys; } catch (eK) {}
        }
        if (wl.present) {
          looked++;
          if (!look.present) look = { present: true, kind: wl.kind, keys: 0 };
          if (wl.keys) look.keys += wl.keys;
        }
        var ri = rectInfo(l, l.inPoint, safe, comp, null);
        if (ri.bounds && ri.rect && ri.rect.width > 0) {
          if (box === null) {
            box = [ri.bounds[0], ri.bounds[1], ri.bounds[2], ri.bounds[3]];
          } else {
            if (ri.bounds[0] < box[0]) box[0] = ri.bounds[0];
            if (ri.bounds[1] < box[1]) box[1] = ri.bounds[1];
            if (ri.bounds[2] > box[2]) box[2] = ri.bounds[2];
            if (ri.bounds[3] > box[3]) box[3] = ri.bounds[3];
          }
          if (ri.rail_overlap === true) rail = true;
        }
      }
      texts.push(text);
      if (inP === null || l.inPoint < inP) inP = l.inPoint;
      if (outP === null || l.outPoint > outP) outP = l.outPoint;
      if (words.length < 100) {
        var wi = { word: nums[i], name: l.name, id: l.id, inPoint: l.inPoint, outPoint: l.outPoint, text: boundString(text) };
        if (wstyle.fill) wi.fill = wstyle.fill;
        if (wstyle.faux_italic !== undefined) wi.faux_italic = wstyle.faux_italic;
        words.push(wi);
      }
    }
    if (pillLayer) {
      var pl = lookInfo(pillLayer, pillLayer);
      look = { present: true, kind: "pill_slide", keys: pl.keys };
    } else if (look.present) {
      look.layers = looked;
    }
    var entry = {
      number: number,
      name: prefix + " " + pad(number, 3),
      id: firstLayer.id,
      index: firstLayer.index,
      kind: "words",
      inPoint: inP,
      outPoint: outP,
      text: boundString(texts.join(" ")),
      word_layers: nums.length,
      words: words,
      look: look
    };
    if (isTextLayer(firstLayer)) {
      var d = sourceTextProp(firstLayer).value;
      try { entry.font = String(d.font); } catch (e1) {}
      try { entry.fontSize = Number(d.fontSize); } catch (e2) {}
      try {
        if (d.fontObject && d.fontObject.isSubstitute === true) entry.font_substituted = true;
      } catch (e3) {}
      docStyle(d, entry);
    }
    if (box !== null) {
      entry.rect = { left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1] };
      entry.outside_safe = box[0] < safe.left - 0.5 || box[2] > comp.width - safe.right + 0.5 || box[1] < safe.top - 0.5 || box[3] > safe.bottomY + descent + 0.5;
      if (rail) entry.rail_overlap = true;
    } else {
      entry.outside_safe = false;
    }
    return entry;
  }

  function essentialValue(p) {
    var v;
    try { v = p.value; } catch (e) { return null; }
    if (v && typeof v === "object" && v.text !== undefined) return boundString(v.text);
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
    if (v && typeof v.length === "number") {
      var arr = [];
      for (var i = 0; i < v.length && i < 4; i++) arr.push(v[i]);
      return arr;
    }
    return String(v);
  }

  function collectEssential(g, out, depth, counter) {
    for (var i = 1; i <= g.numProperties && counter.n < 60; i++) {
      var p = g.property(i);
      if (!p) continue;
      var leaf = false;
      try { leaf = p.propertyType === PropertyType.PROPERTY; } catch (e0) {}
      if (leaf) {
        counter.n++;
        out[p.name] = essentialValue(p);
      } else if (depth < 4) {
        collectEssential(p, out, depth + 1, counter);
      }
    }
  }

  // A template-mode caption: a precomp layer, and the values of its Essential Properties.
  function templateEntry(l, number) {
    var entry = { number: number, name: l.name, id: l.id, index: l.index, inPoint: l.inPoint, outPoint: l.outPoint, startTime: l.startTime, kind: "template" };
    var src = null;
    try { src = l.source; } catch (e0) {}
    if (!src || !(src instanceof CompItem)) {
      entry.kind = "other";
      return entry;
    }
    entry.source_comp_id = src.id;
    entry.source_comp_name = src.name;
    entry.essential = {};
    var g = null;
    try { g = l.property("ADBE Layer Overrides"); } catch (e1) { g = null; }
    if (g) collectEssential(g, entry.essential, 0, { n: 0 });
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
    var mode = "layers";
    if (args.mode === "single" || args.mode === "words" || args.mode === "template") mode = args.mode;
    // Captions that were precomposed live in "<prefix> Captions"; with through_precomp the read follows them in.
    if (args.through_precomp === true) {
      var pl = findNamedLayer(comp, prefix + " Captions");
      if (pl && pl.source instanceof CompItem) comp = pl.source;
    }
    var safe = safeArea(comp, args.layout, args.default_margins, args.platform_margins);
    // The lower-right rail check: on for TikTok-like presets, "auto" when the comp is 9:16.
    safe.rail = args.rail === true || (args.rail === "auto" && Math.abs(comp.width / comp.height - 9 / 16) / (9 / 16) < 0.01);
    var found;
    if (mode === "words") found = scanWordLayers(comp, prefix);
    else found = scanCaptions(comp, prefix, mode);
    var out = {
      comp_id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      frameDuration: comp.frameDuration,
      safe: { left: safe.left, right: safe.right, top: safe.top, bottom: comp.height - safe.bottomY, width: safe.width, rail: safe.rail },
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
      if (mode === "words") out.captions.push(wordsEntry(prefix, numbers[i], found.caps[numbers[i]], safe, comp, found.looks[numbers[i]] || null));
      else if (mode === "template") out.captions.push(templateEntry(found.caps[numbers[i]], numbers[i]));
      else out.captions.push(captionEntry(found.caps[numbers[i]], numbers[i], mode, safe, comp, found.boxes[numbers[i]] || null, found.looks[numbers[i]] || null));
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
      var ccolor = null;
      if (c.color !== undefined && c.color !== null) {
        checkColor(c.color, "caption " + (i + 1) + " color");
        ccolor = [c.color[0], c.color[1], c.color[2]];
      }
      out.push({ start: s, end: e, lines: lines, text: lines.join("\r"), words: [], color: ccolor, italic: c.italic === true, italic_given: c.italic === true || c.italic === false, kind: c.kind ? String(c.kind) : "speech" });
      if (c.words && typeof c.words.length === "number") {
        for (var wi = 0; wi < c.words.length; wi++) {
          if (!c.words[wi] || !isNum(c.words[wi].start)) fail("bad_args", "caption " + (i + 1) + " word " + (wi + 1) + " needs a numeric start");
          var wend = null;
          if (isNum(c.words[wi].end)) wend = Math.round(c.words[wi].end / fd) * fd;
          out[i].words.push({ start: Math.round(c.words[wi].start / fd) * fd, end: wend });
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
    try { doc.fauxItalic = false; } catch (eFi) {}
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
    // Every read walks down from the layer: a removal invalidates the references held into the group.
    for (var i = 1; i <= animatorsOf(layer).numProperties; i++) {
      if (animatorsOf(layer).property(i).name === HIGHLIGHT_NAME) {
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
  function styleBox(layer, textLayer, box, staticOpacity) {
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
    // A template exposes the opacity as a control, and a property with an expression cannot be one: a plain value there.
    if (staticOpacity === true) {
      tg().property("ADBE Opacity").setValue(box.opacity);
      return;
    }
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
  function makeBox(comp, textLayer, name, box, staticOpacity) {
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
    styleBox(layer, textLayer, box, staticOpacity);
    return layer;
  }

  // The words of each line, as arrays of tokens (words mode lays these out one layer per token).
  function tokensOf(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var parts = String(lines[i]).split(/\s+/);
      var line = [];
      for (var j = 0; j < parts.length; j++) {
        if (parts[j] !== "") line.push(parts[j]);
      }
      out.push(line);
    }
    return out;
  }

  // The names of a comp's Essential Graphics controllers (AE 22+); null when this AE has no such API.
  function controllerNames(comp) {
    var n;
    try {
      n = comp.motionGraphicsTemplateControllerCount;
    } catch (e0) {
      return null;
    }
    if (typeof n !== "number") return null;
    var names = [];
    for (var i = 1; i <= n && i <= MAX_LIST; i++) {
      try { names.push(String(comp.getMotionGraphicsTemplateControllerName(i))); } catch (e1) {}
    }
    return names;
  }

  // Whether `inner` holds `target` (or a comp that does), through layer sources; visited stops loops.
  function compContains(inner, target, visited) {
    if (inner.id === target.id) return true;
    if (visited[inner.id]) return false;
    visited[inner.id] = true;
    for (var i = 1; i <= inner.numLayers; i++) {
      var src = null;
      try { src = inner.layer(i).source; } catch (e) { src = null; }
      if (src && src instanceof CompItem && compContains(src, target, visited)) return true;
    }
    return false;
  }

  // An Essential Property by name, in the layer's own list first and then in its groups.
  function findOverride(g, name, depth) {
    var direct = null;
    try { direct = g.property(name); } catch (e0) { direct = null; }
    if (direct) return direct;
    if (depth >= 6) return null;
    for (var k = 1; k <= g.numProperties; k++) {
      var child = null;
      try { child = g.property(k); } catch (e1) { child = null; }
      if (!child) continue;
      var isGroup = false;
      try { isGroup = child.propertyType !== PropertyType.PROPERTY; } catch (e2) {}
      if (!isGroup) continue;
      var hit = findOverride(child, name, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  // Points a caption box's expressions at its text layer's new name, keeping the box's look.
  function retargetBox(layer, oldName, newName) {
    var oldQ = quoteJs(oldName);
    var newQ = quoteJs(newName);
    var rect = layer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group").property("ADBE Vector Shape - Rect");
    var props = [rect.property("ADBE Vector Rect Size"), rect.property("ADBE Vector Rect Position"), layer.property("ADBE Transform Group").property("ADBE Opacity")];
    for (var i = 0; i < props.length; i++) {
      var ex = String(props[i].expression);
      if (ex.indexOf(oldQ) >= 0) props[i].expression = ex.split(oldQ).join(newQ);
    }
  }

  // The width and left edge of a layer's text extents at its in point.
  function measureText(layer) {
    var r = layer.sourceRectAtTime(layer.inPoint, false);
    return { width: r.width, left: r.left };
  }

  // A space's advance in this layer's style: the width of "a a" less that of "aa", in the layer itself.
  // Returns null when the extents can't be told apart.
  function measureSpace(layer, restoreText) {
    var src = sourceTextProp(layer);
    var d = src.value;
    d.text = "a a";
    src.setValue(d);
    var w1 = measureText(layer).width;
    d = src.value;
    d.text = "aa";
    src.setValue(d);
    var w2 = measureText(layer).width;
    d = src.value;
    d.text = restoreText;
    src.setValue(d);
    if (isNum(w1) && isNum(w2) && w1 - w2 > 0) return w1 - w2;
    return null;
  }

  // Where each word of a line starts, measured in one layer (its text and justification are put back): the typeset ADVANCE of
  // the words before it, trailing spaces included. sourceRectAtTime measures ink, which ignores trailing whitespace and starts at
  // the first glyph's left side bearing, so a prefix is measured with a sentinel glyph after it: "Jones directed |" less the
  // width of "|" alone is the advance of "Jones directed " (plus the sentinel's bearing C and the first glyph's bearing, both
  // cancelled below). Every number comes from the same layer, style and time, left justified, so the bearings of the words
  // themselves never enter the gaps.
  // Returns { origins: [x of each word's text origin from the line's origin], adv: the line's advance width,
  // lsb: [each word's left side bearing], ink: [each word's ink width] }, or null when the widths can't be told apart.
  function measureLineAdvances(layer, words, space, restoreText) {
    var src = sourceTextProp(layer);
    var saved = src.value;
    var keepJust = saved.justification;
    var ok = true;
    var res = null;
    var setText = function (t) {
      var d = src.value;
      d.text = t;
      d.justification = justificationValue("left");
      src.setValue(d);
      return layer.sourceRectAtTime(layer.inPoint, false);
    };
    try {
      var sentinel = setText("|");
      var bw = sentinel.width;
      var sentLeft = sentinel.left;
      var lsb = [];
      var ink = [];
      for (var k = 0; k < words.length; k++) {
        var wr = setText(words[k]);
        if (!isNum(wr.width) || wr.width <= 0 || !isNum(wr.left)) ok = false;
        lsb.push(wr.left);
        ink.push(wr.width);
      }
      if (!isNum(bw) || bw <= 0 || !isNum(sentLeft)) ok = false;
      var origins = [0];
      var adv = 0;
      if (ok) {
        for (var j = 1; j <= words.length; j++) {
          var pr = setText(words.slice(0, j).join(" ") + " |");
          if (!isNum(pr.width) || pr.width <= 0) {
            ok = false;
            break;
          }
          // The advance of the words and spaces before the sentinel.
          var a = pr.width - bw - sentLeft + lsb[0];
          if (a <= origins[j - 1]) {
            ok = false;
            break;
          }
          origins.push(a);
        }
        if (ok) {
          adv = origins[words.length] - space;
          origins.pop();
          if (adv <= origins[words.length - 1]) ok = false;
        }
      }
      if (ok) res = { origins: origins, adv: adv, lsb: lsb, ink: ink };
    } finally {
      var back = src.value;
      back.text = restoreText;
      back.justification = keepJust;
      src.setValue(back);
    }
    return res;
  }

  // The font of style.font against what AE has installed (AE 24+) and the glyphs the caption text needs (AE 25.1+).
  // Refuses an unknown font unless allowSubstitute; a missing glyph is a warning. Runs before the undo group.
  function checkStyleFont(ps, caps, allowSubstitute, warnings) {
    var info = { name: ps, checked: false };
    if (typeof A.fontsResolve !== "function") {
      info.reason = "This host cannot look fonts up.";
      return info;
    }
    var r = A.fontsResolve({ postscript: ps });
    if (r.unchecked) {
      info.reason = r.reason;
      warnings.push("The font \"" + ps + "\" was not checked: " + r.reason);
      return info;
    }
    info.checked = true;
    info.exists = !!r.font;
    if (!r.font || r.ok === false) {
      var why = r.reason || ("No installed font matches \"" + ps + "\".");
      if (!allowSubstitute) {
        fail("bad_args", why + " Pick an installed font (ae_fonts action search), or pass allow_substitute: true to write the name anyway; After Effects would substitute it silently.");
      }
      info.substitute = true;
      warnings.push(why + " It is written anyway (allow_substitute); After Effects substitutes it.");
      if (!r.font) return info;
    }
    if (typeof A.fontsGlyphCheck !== "function") return info;
    var all = [];
    var total = 0;
    for (var i = 0; i < caps.length && total < 20000; i++) {
      all.push(String(caps[i].text).replace(/[\r\n\t\u0003\u2028\u2029]+/g, " "));
      total += String(caps[i].text).length + 1;
    }
    var g = A.fontsGlyphCheck(r.font.postscript, all.join(" "), 20000);
    info.glyphs_checked = g.supported !== null;
    if (g.supported === false) {
      info.glyphs_missing = g.missing;
      var msg = "The font \"" + ps + "\" has no glyph for: " + g.missing.join(" ") + " (in the caption text). After Effects will draw a fallback or an empty box.";
      if (g.suggested_default && g.suggested_default.length > 0) {
        var names = [];
        for (var d = 0; d < g.suggested_default.length; d++) names.push(g.suggested_default[d].postscript);
        msg += " AE's default for that script: " + names.join(", ") + ".";
      }
      warnings.push(msg);
    } else if (g.supported === null && g.reason) {
      info.glyphs_reason = g.reason;
    }
    return info;
  }

  // ---------- per-caption style and looks ----------
  // The three looks (pop, pill_slide, fill_sweep) are guided by the vargHQ/skills caption-styles ideas (MIT); the numbers are our own.

  // Per-caption colour (speaker) and faux italic (lyric) on top of the base style. When a call colours any caption,
  // the others get the style's own fill, so a re-run with fewer speakers does not keep stale colours. A layer an earlier
  // run coloured (its style mark says so) is put back to the style's fill on a run without colours; a layer the tool
  // never coloured keeps whatever fill it has.
  function stylePlan(layer, base) {
    var m = readMarks(layer);
    return {
      color: base.anyColor || m.style.indexOf("c") >= 0,
      italic: base.anyItalic || m.style.indexOf("i") >= 0,
      none: m.style === ""
    };
  }

  function applyCapStyle(doc, cap, base, plan) {
    if (plan.color) {
      var c = cap.color ? cap.color : base.fill;
      doc.fillColor = [c[0], c[1], c[2]];
    }
    if (plan.italic) {
      try { doc.fauxItalic = cap.italic === true; } catch (eI) {}
    }
  }

  // Records what the run just wrote, so the next run knows whether there is anything of the tool's to put back.
  function markStyle(layer, base) {
    var style = "";
    if (base.anyColor) style += "c";
    if (base.anyItalic) style += "i";
    var m = readMarks(layer);
    if (m.style !== style) {
      m.style = style;
      writeMarks(layer, m);
    }
  }

  // A keyframe list entry: a key at the same instant replaces the last, and times only move forward.
  function pushKey(list, t, v) {
    if (list.length > 0) {
      var last = list[list.length - 1].t;
      if (Math.abs(t - last) < 1e-6) {
        list[list.length - 1].v = v;
        return;
      }
      if (t < last) t = last + 1e-4;
    }
    list.push({ t: t, v: v });
  }

  // Writes a key list on the property `get()` finds each time (addProperty and key edits invalidate references).
  function setKeyList(get, keys) {
    clearKeys(get());
    for (var i = 0; i < keys.length; i++) get().setValueAtTime(keys[i].t, keys[i].v);
  }

  // Easy ease on every key of a property; AE wants one ease per dimension of a non-spatial property. A refusal is not an error.
  function easeAll(get, dims) {
    var n = get().numKeys;
    for (var k = 1; k <= n; k++) {
      var set = false;
      var tries = [dims, 1];
      for (var ti = 0; ti < tries.length && !set; ti++) {
        var arr = [];
        for (var d = 0; d < tries[ti]; d++) arr.push(new KeyframeEase(0, 60));
        try {
          get().setTemporalEaseAtKey(k, arr, arr);
          set = true;
        } catch (eE) {}
      }
    }
  }

  // Takes every look animator ("Caption Look...") off a text layer; the number removed.
  function removeLookAnimators(layer) {
    var n = 0;
    // Nothing is held across a remove(): each read walks down from the layer again.
    for (var i = animatorsOf(layer).numProperties; i >= 1; i--) {
      if (animatorsOf(layer).property(i).name.indexOf(LOOK_NAME) === 0) {
        animatorsOf(layer).property(i).remove();
        n++;
      }
    }
    return n;
  }

  // Adds an animator `name` holding one property (set to `value`) and one range selector, and returns a getter for the
  // selector. units: 1 percent, 2 index. basedOn: 1 characters, 2 characters excluding spaces, 3 words.
  function addLookAnimator(layer, name, propMatch, value, units, basedOn) {
    animatorsOf(layer).addProperty("ADBE Text Animator");
    var ai = animatorsOf(layer).numProperties;
    var anim = function () { return animatorsOf(layer).property(ai); };
    anim().name = name;
    anim().property("ADBE Text Animator Properties").addProperty(propMatch);
    anim().property("ADBE Text Selectors").addProperty("ADBE Text Selector");
    var prop = anim().property("ADBE Text Animator Properties").property(propMatch);
    if (!prop) fail("runtime", "The look animator could not take " + propMatch);
    prop.setValue(value);
    var selector = function () { return anim().property("ADBE Text Selectors").property(1); };
    if (!selector()) fail("runtime", "The look animator has no range selector");
    var adv = function () { return selector().property("ADBE Text Range Advanced"); };
    adv().property("ADBE Text Range Units").setValue(units);
    adv().property("ADBE Text Range Type2").setValue(basedOn);
    return selector;
  }

  function needSelProp(selector, matchName) {
    if (!selProp(selector(), matchName)) fail("runtime", "The range selector has no " + matchName + " (Units did not switch)");
    return function () { return selProp(selector(), matchName); };
  }

  // Index-unit keys that reveal word j at starts[j] over `ramp` seconds: Start counts the words released so far.
  function revealKeys(starts, capStart, ramp) {
    var keys = [];
    var n = starts.length;
    if (starts[0] > capStart + 1e-6) pushKey(keys, capStart, 0);
    for (var j = 0; j < n; j++) {
      pushKey(keys, starts[j], j);
      var e = starts[j] + ramp;
      if (j + 1 < n && starts[j + 1] < e) e = starts[j + 1];
      if (e <= starts[j] + 1e-6) e = starts[j] + 1e-4;
      pushKey(keys, e, j + 1);
    }
    return keys;
  }

  // The pop: words hidden and small until their time, then Opacity over a third of the duration, Scale over 60% of it,
  // and a short overshoot (a third animator whose selector window sits on the active word and whose Amount rises and falls).
  // Returns the number of keys written on the main selector.
  function applyPopLayer(layer, starts, capStart, dur, sf) {
    var n = starts.length;
    var peak = 100 + 0.3 * (100 - sf);
    var sel = addLookAnimator(layer, LOOK_NAME, "ADBE Text Opacity", 0, 2, 3);
    var st1 = needSelProp(sel, "ADBE Text Index Start");
    var en1 = needSelProp(sel, "ADBE Text Index End");
    en1().setValue(n);
    setKeyList(st1, revealKeys(starts, capStart, dur / 3));
    easeAll(st1, 1);
    var sel2 = addLookAnimator(layer, LOOK_SCALE_NAME, "ADBE Text Scale 3D", [sf, sf, sf], 2, 3);
    var st2 = needSelProp(sel2, "ADBE Text Index Start");
    var en2 = needSelProp(sel2, "ADBE Text Index End");
    en2().setValue(n);
    setKeyList(st2, revealKeys(starts, capStart, dur * 0.6));
    easeAll(st2, 1);
    if (Math.abs(peak - 100) > 1e-6) {
      var sel3 = addLookAnimator(layer, LOOK_OVERSHOOT_NAME, "ADBE Text Scale 3D", [peak, peak, peak], 2, 3);
      var st3 = needSelProp(sel3, "ADBE Text Index Start");
      var en3 = needSelProp(sel3, "ADBE Text Index End");
      var am3 = needSelProp(sel3, "ADBE Text Selector Max Amount");
      var winS = [];
      var winE = [];
      var amt = [];
      for (var j = 0; j < n; j++) {
        var dc = dur;
        if (j + 1 < n && starts[j + 1] - starts[j] < dc) dc = starts[j + 1] - starts[j];
        if (dc <= 1e-6) dc = 1e-3;
        pushKey(winS, starts[j], j);
        pushKey(winE, starts[j], j + 1);
        pushKey(amt, starts[j], 0);
        pushKey(amt, starts[j] + dc * 0.6, 100);
        pushKey(amt, starts[j] + dc, 0);
      }
      setKeyList(st3, winS);
      setKeyList(en3, winE);
      setKeyList(am3, amt);
      holdKeys(st3());
      holdKeys(en3());
    }
    return st1().numKeys;
  }

  // The sweep: the fill colour spreads across the characters of each word between its show time and its end
  // (Index units, Based On Characters Excluding Spaces, End keyed in characters).
  function applySweepLayer(layer, starts, ends, counts, capStart, color) {
    var sel = addLookAnimator(layer, LOOK_NAME, "ADBE Text Fill Color", [color[0], color[1], color[2]], 2, 2);
    var st = needSelProp(sel, "ADBE Text Index Start");
    var en = needSelProp(sel, "ADBE Text Index End");
    st().setValue(0);
    var keys = [];
    var a = 0;
    var n = starts.length;
    if (starts[0] > capStart + 1e-6) pushKey(keys, capStart, 0);
    for (var j = 0; j < n; j++) {
      pushKey(keys, starts[j], a);
      var e = ends[j];
      if (j + 1 < n && starts[j + 1] < e) e = starts[j + 1];
      if (e <= starts[j] + 1e-6) e = starts[j] + 1e-4;
      a += counts[j];
      pushKey(keys, e, a);
    }
    setKeyList(en, keys);
    return en().numKeys;
  }

  // A words-mode layer: the sweep across the characters of its one word (percent units).
  function applySweepWord(layer, s, e, color) {
    var sel = addLookAnimator(layer, LOOK_NAME, "ADBE Text Fill Color", [color[0], color[1], color[2]], 1, 1);
    var st = needSelProp(sel, "ADBE Text Percent Start");
    var en = needSelProp(sel, "ADBE Text Percent End");
    st().setValue(0);
    var keys = [];
    pushKey(keys, s, 0);
    pushKey(keys, e <= s + 1e-6 ? s + 1e-4 : e, 100);
    setKeyList(en, keys);
    return en().numKeys;
  }

  // Moves a layer's anchor to the middle of its text, keeping the text where it is, so it scales from its centre.
  function centreAnchor(layer) {
    var r = layer.sourceRectAtTime(layer.inPoint, false);
    var tg = function () { return layer.property("ADBE Transform Group"); };
    var oa = tg().property("ADBE Anchor Point").value;
    var op = tg().property("ADBE Position").value;
    var na = [r.left + r.width / 2, r.top + r.height / 2];
    var dx = na[0] - oa[0];
    var dy = na[1] - oa[1];
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
    tg().property("ADBE Anchor Point").setValue([na[0], na[1], oa.length > 2 ? oa[2] : 0]);
    tg().property("ADBE Position").setValue([op[0] + dx, op[1] + dy, op.length > 2 ? op[2] : 0]);
  }

  // A word layer's pop, in plain Transform keys: Scale and Opacity from its in point. The comment marks the keys as the tool's.
  function applyPopWord(layer, s, dur, sf) {
    centreAnchor(layer);
    var peak = 100 + 0.3 * (100 - sf);
    var tg = function () { return layer.property("ADBE Transform Group"); };
    var sc = function () { return tg().property("ADBE Scale"); };
    var op = function () { return tg().property("ADBE Opacity"); };
    var sk = [];
    pushKey(sk, s, [sf, sf, 100]);
    if (Math.abs(peak - 100) > 1e-6) pushKey(sk, s + dur * 0.6, [peak, peak, 100]);
    pushKey(sk, s + dur, [100, 100, 100]);
    setKeyList(sc, sk);
    easeAll(sc, 3);
    var ok = [];
    pushKey(ok, s, 0);
    pushKey(ok, s + dur / 3, 100);
    setKeyList(op, ok);
    easeAll(op, 1);
    var pm = readMarks(layer);
    pm.look = "pop";
    writeMarks(layer, pm);
    return sc().numKeys;
  }

  // Takes a word layer's look off: animators, and the Transform keys when the tool made them. The number of things removed.
  function clearWordLook(layer) {
    var n = removeLookAnimators(layer);
    if (lookMarkOf(layer) !== "") {
      var tg = function () { return layer.property("ADBE Transform Group"); };
      clearKeys(tg().property("ADBE Scale"));
      clearKeys(tg().property("ADBE Opacity"));
      tg().property("ADBE Scale").setValue([100, 100, 100]);
      tg().property("ADBE Opacity").setValue(100);
      var cm = readMarks(layer);
      cm.look = "";
      writeMarks(layer, cm);
      n++;
    }
    return n;
  }

  // The extents of each word of a caption layer, measured in the layer itself (its text is set to each word in turn
  // and put back). Rects are in layer space, relative to the justification origin: { cx, cy, w, h } per word.
  function measureWordRects(layer, lines, fontSize, lead, justification) {
    var tok = tokensOf(lines);
    var src = sourceTextProp(layer);
    var full = String(src.value.text);
    var space = null;
    try { space = measureSpace(layer, full); } catch (eS) { space = null; }
    if (space === null) space = fontSize * 0.28;
    var flat = [];
    var li;
    var wd;
    for (li = 0; li < tok.length; li++) {
      for (wd = 0; wd < tok[li].length; wd++) flat.push(tok[li][wd]);
    }
    var ws = [];
    var topMin = null;
    var botMax = null;
    for (var k = 0; k < flat.length; k++) {
      var d = src.value;
      d.text = flat[k];
      src.setValue(d);
      var r = layer.sourceRectAtTime(layer.inPoint, false);
      var w = r.width;
      if (!isNum(w) || w <= 0) w = fontSize * 0.3;
      ws.push(w);
      if (isNum(r.top) && isNum(r.height)) {
        if (topMin === null || r.top < topMin) topMin = r.top;
        if (botMax === null || r.top + r.height > botMax) botMax = r.top + r.height;
      }
    }
    var back = src.value;
    back.text = full;
    src.setValue(back);
    if (topMin === null) {
      topMin = -fontSize * 0.8;
      botMax = fontSize * 0.2;
    }
    var rects = [];
    var idx = 0;
    for (li = 0; li < tok.length; li++) {
      var lineW = space * (tok[li].length - 1);
      for (wd = 0; wd < tok[li].length; wd++) lineW += ws[idx + wd];
      // The line's own advances say where each word really sits (bearings and spaces included).
      var pre = null;
      try { pre = measureLineAdvances(layer, tok[li], space, full); } catch (eP) { pre = null; }
      if (pre !== null) lineW = pre.adv;
      var x = 0;
      if (justification === "center") x = -lineW / 2;
      else if (justification === "right") x = -lineW;
      var lineX0 = x;
      for (wd = 0; wd < tok[li].length; wd++) {
        var wid = ws[idx];
        var wx = x;
        if (pre !== null) wx = lineX0 + pre.origins[wd] + pre.lsb[wd];
        rects.push({ cx: wx + wid / 2, cy: topMin + li * lead + (botMax - topMin) / 2, w: wid, h: botMax - topMin });
        x = wx + wid + space;
        idx++;
      }
    }
    return rects;
  }

  // A rounded-rectangle shape layer behind a caption; keyPill gives it its Size and Position keys.
  function makePill(comp, afterLayer, name, spec) {
    var layer = comp.layers.addShape();
    layer.name = name;
    layer.moveAfter(afterLayer);
    var tg = function () { return layer.property("ADBE Transform Group"); };
    tg().property("ADBE Position").setValue([0, 0]);
    tg().property("ADBE Anchor Point").setValue([0, 0]);
    layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
    var contents = function () { return layer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group"); };
    contents().addProperty("ADBE Vector Shape - Rect");
    contents().addProperty("ADBE Vector Graphic - Fill");
    var rect = function () { return contents().property("ADBE Vector Shape - Rect"); };
    rect().property("ADBE Vector Rect Roundness").setValue(spec.roundness);
    contents().property("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue([spec.color[0], spec.color[1], spec.color[2], 1]);
    return layer;
  }

  // rects: one { cx, cy, w, h } per word. The pill sits on word 0 from capStart, then slides to each word over `ease`
  // seconds, arriving at the word's time. Returns the number of position keys.
  function keyPill(layer, rects, starts, capStart, ease, padding) {
    var keys = [];
    pushKey(keys, capStart, rects[0]);
    for (var j = 1; j < rects.length; j++) {
      var depart = starts[j] - ease;
      if (depart > keys[keys.length - 1].t + 1e-6) pushKey(keys, depart, rects[j - 1]);
      pushKey(keys, starts[j], rects[j]);
    }
    var rect = function () { return layer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group").property("ADBE Vector Shape - Rect"); };
    var sz = [];
    var ps = [];
    for (var i = 0; i < keys.length; i++) {
      var r = keys[i].v;
      sz.push({ t: keys[i].t, v: [r.w + padding * 2, r.h + padding * 2] });
      ps.push({ t: keys[i].t, v: [r.cx, r.cy] });
    }
    setKeyList(function () { return rect().property("ADBE Vector Rect Size"); }, sz);
    setKeyList(function () { return rect().property("ADBE Vector Rect Position"); }, ps);
    easeAll(function () { return rect().property("ADBE Vector Rect Size"); }, 2);
    easeAll(function () { return rect().property("ADBE Vector Rect Position"); }, 1);
    return rect().property("ADBE Vector Rect Position").numKeys;
  }

  // The look options with their defaults, checked. Nothing is written.
  function lookSpec(kind, o, fontSize, fd) {
    var spec = { kind: kind, frames: 6, sf: 80, color: [1, 0.85, 0], padding: Math.round(fontSize * 0.12), roundness: 1000 };
    if (kind === "pill_slide") {
      spec.frames = 4;
      spec.color = [1, 0.8, 0];
    }
    if (o) {
      if (o.duration_frames !== undefined && o.duration_frames !== null) {
        if (!isNum(o.duration_frames) || Math.floor(o.duration_frames) !== o.duration_frames || o.duration_frames < 1 || o.duration_frames > 30) fail("bad_args", "look_options.duration_frames must be a whole number in 1..30");
        spec.frames = o.duration_frames;
      }
      if (o.scale_from !== undefined && o.scale_from !== null) {
        checkRange(o.scale_from, 0, 200, "look_options.scale_from");
        spec.sf = o.scale_from;
      }
      if (o.color !== undefined && o.color !== null) {
        checkColor(o.color, "look_options.color");
        spec.color = [o.color[0], o.color[1], o.color[2]];
      }
      if (o.pill_padding !== undefined && o.pill_padding !== null) {
        checkRange(o.pill_padding, 0, 500, "look_options.pill_padding");
        spec.padding = o.pill_padding;
      }
      if (o.pill_roundness !== undefined && o.pill_roundness !== null) {
        checkRange(o.pill_roundness, 0, 1000, "look_options.pill_roundness");
        spec.roundness = o.pill_roundness;
      }
    }
    spec.dur = spec.frames * fd;
    return spec;
  }

  // A word's end for the sweep: its own end, else the next word's start, else the caption's end.
  function wordEnd(cap, w) {
    var e = cap.words[w].end;
    if (!isNum(e) || e <= cap.words[w].start + 1e-6) {
      if (w + 1 < cap.words.length) e = cap.words[w + 1].start;
      else e = cap.end;
    }
    if (e > cap.end) e = cap.end;
    return e;
  }

  // The non-space characters in each word of a caption's lines (what Characters Excluding Spaces counts).
  function charCounts(lines) {
    var tk = tokensOf(lines);
    var out = [];
    for (var li = 0; li < tk.length; li++) {
      for (var wd = 0; wd < tk[li].length; wd++) out.push(tk[li][wd].length);
    }
    return out;
  }

  // Why a control null is not at its identity transform (anchor and position at the origin, scale 100, no rotation, no
  // keys on those), or "" when it is. Captions are placed in comp space; a moved control would shift every new or restyled one.
  function controlProblem(ctl) {
    var tg = ctl.property("ADBE Transform Group");
    var checks = [
      ["ADBE Anchor Point", "anchor point", 0],
      ["ADBE Position", "position", 0],
      ["ADBE Scale", "scale", 100],
      ["ADBE Rotate Z", "rotation", 0],
      ["ADBE Rotate X", "X rotation", 0],
      ["ADBE Rotate Y", "Y rotation", 0],
      ["ADBE Orientation", "orientation", 0]
    ];
    for (var i = 0; i < checks.length; i++) {
      var p = null;
      try { p = tg.property(checks[i][0]); } catch (e0) { p = null; }
      if (!p) continue;
      if (p.numKeys > 0) return "has keyframes on its " + checks[i][1];
      var v = p.value;
      if (typeof v === "number") v = [v];
      for (var k = 0; k < v.length; k++) {
        if (Math.abs(v[k] - checks[i][2]) > 1e-6) return "has its " + checks[i][1] + " changed";
      }
    }
    return "";
  }

  // Reads only: the layer has Essential Properties, every mapped one is on it and holds text. Fails with the reason.
  function checkEssentialFields(layer, fields) {
    var g = layer.property("ADBE Layer Overrides");
    if (!g) fail("runtime", "\"" + layer.name + "\" has no Essential Properties (the template comp's controllers did not reach the layer)");
    for (var fi1 = 0; fi1 < fields.length; fi1++) {
      var target1 = findOverride(g, fields[fi1].name, 0);
      if (!target1) fail("not_found", "No Essential Property \"" + fields[fi1].name + "\" on \"" + layer.name + "\"");
      var isText1 = false;
      try { isText1 = target1.propertyValueType === PropertyValueType.TEXT_DOCUMENT; } catch (eV1) {}
      if (!isText1) fail("bad_args", "The Essential Property \"" + fields[fi1].name + "\" is not a text property, so it cannot hold a caption's " + fields[fi1].kind);
    }
  }

  A.captionsApply = function (args) {
    assertGuard(args.expect);
    var outerComp = requireComp(args.comp_id);
    var comp = outerComp;
    var mode = args.mode;
    if (mode !== "layers" && mode !== "single" && mode !== "words" && mode !== "template") fail("bad_args", "mode must be 'layers', 'single', 'words' or 'template'");
    var prefix = args.name_prefix;
    if (typeof prefix !== "string" || prefix.length < 1 || prefix.length > 100) fail("bad_args", "name_prefix must be a string of 1..100 characters");
    var first = args.first_number === undefined || args.first_number === null ? 1 : args.first_number;
    if (!isNum(first) || first < 1 || Math.floor(first) !== first) fail("bad_args", "first_number must be a whole number of 1 or more");
    var raw = args.captions;
    if (!raw || typeof raw.length !== "number" || raw.length < 1 || raw.length > MAX_CAPTIONS) fail("bad_args", "give 1.." + MAX_CAPTIONS + " captions");
    var warnings = [];

    // Captions already precomposed by an earlier run live in "<prefix> Captions": update them there.
    var precomposeOn = args.precompose === true;
    var parentOn = args.parent_to_null === true;
    var precompLayer = null;
    var precompExisted = false;
    if (precomposeOn) {
      precompLayer = findNamedLayer(outerComp, prefix + " Captions");
      if (precompLayer) {
        var psrc = null;
        try { psrc = precompLayer.source; } catch (eP) { psrc = null; }
        if (!psrc || !(psrc instanceof CompItem)) fail("bad_args", "Layer \"" + precompLayer.name + "\" has the precomp's name but is not a precomp layer; rename or remove it");
        comp = psrc;
        precompExisted = true;
      }
    }

    var caps = normaliseCaptions(comp, raw, warnings, mode);

    var hl = args.highlight;
    if ((mode === "words" || mode === "template") && (hl || args.box)) {
      fail("bad_args", "highlight and box apply to layers and single mode; in words mode the words already build on, and a template sets its own look");
    }
    if (mode === "single" && (args.mapping || args.match === "time")) fail("bad_args", "match 'time' applies to layers, words and template modes");
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
    if (mode === "words") {
      for (var wi2 = 0; wi2 < caps.length; wi2++) {
        var nTok = 0;
        var tk = tokensOf(caps[wi2].lines);
        for (var tl = 0; tl < tk.length; tl++) nTok += tk[tl].length;
        if (caps[wi2].words.length !== nTok) {
          fail("bad_args", "caption " + (wi2 + 1) + " has " + nTok + " words but " + caps[wi2].words.length + " word times; words mode needs one time per word");
        }
      }
    }

    // Template mode: the template comp, its Essential Property names and the fields to fill. Nothing is touched yet.
    var tplComp = null;
    var tplFields = null;
    if (mode === "template") {
      var tpl = args.template;
      if (!tpl || !isNum(tpl.comp_id) || !tpl.fields || typeof tpl.fields !== "object") fail("bad_args", "template mode needs template: { comp_id, fields }");
      tplComp = requireComp(tpl.comp_id);
      if (tplComp.id === comp.id || tplComp.id === outerComp.id) fail("bad_args", "The template comp \"" + tplComp.name + "\" is the comp the captions go into; pick another comp as the template");
      if (compContains(tplComp, comp, {}) || compContains(tplComp, outerComp, {})) {
        fail("bad_args", "The template comp \"" + tplComp.name + "\" contains \"" + comp.name + "\" (directly or through other comps), so an instance of it there would be a circular reference");
      }
      var have = controllerNames(tplComp);
      if (have === null) fail("bad_args", "This After Effects has no Essential Graphics API (AE 22 or later is needed for template mode)");
      tplFields = [];
      for (var fname in tpl.fields) {
        if (!tpl.fields.hasOwnProperty(fname)) continue;
        var kindOf = tpl.fields[fname];
        if (kindOf !== "line1" && kindOf !== "line2" && kindOf !== "line3" && kindOf !== "text" && kindOf !== "speaker") {
          fail("bad_args", "template.fields[\"" + fname + "\"] must be line1, line2, line3, text or speaker");
        }
        var found1 = false;
        for (var hn = 0; hn < have.length; hn++) {
          if (have[hn] === fname) found1 = true;
        }
        if (!found1) {
          fail("bad_args", "The template comp \"" + tplComp.name + "\" has no Essential Property named \"" + fname + "\". It has: " + (have.length ? have.join(", ") : "(none; add properties to Essential Graphics first)"));
        }
        tplFields.push({ name: fname, kind: kindOf });
      }
      if (tplFields.length === 0) fail("bad_args", "template.fields is empty; map at least one Essential Property to line1, line2, line3, text or speaker");
      var longest = 0;
      for (var lc = 0; lc < caps.length; lc++) {
        if (caps[lc].end - caps[lc].start > longest) longest = caps[lc].end - caps[lc].start;
      }
      if (tplComp.duration + 1e-6 < longest) {
        warnings.push("the template comp is " + tplComp.duration + " s long and the longest caption " + longest + " s; instances end when the template does");
      }
      for (var sp = 0; sp < caps.length; sp++) {
        caps[sp].speaker = raw[sp] && raw[sp].speaker !== undefined && raw[sp].speaker !== null ? String(raw[sp].speaker) : "";
      }
    }

    // Style: the comp's short side sets the default size.
    var s = args.style || {};
    var shortSide = Math.min(comp.width, comp.height);
    var st = {
      font: s.font,
      fontSize: s.font_size,
      fill: s.fill_color || [1, 1, 1],
      stroke: s.stroke_color || null,
      strokeWidth: s.stroke_width,
      justification: s.justification || "center"
    };
    if (st.font !== undefined && st.font !== null && (typeof st.font !== "string" || st.font.length < 1 || st.font.length > 200)) fail("bad_args", "style.font must be a PostScript font name of 1..200 characters");
    if (st.fontSize === undefined || st.fontSize === null) st.fontSize = Math.round(shortSide * 0.06);
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
    var safe = safeArea(comp, layout, args.default_margins, args.platform_margins);
    // With a background box, the text is placed padding px inside the safe area so the box itself stays inside it.
    var place = safe;
    if (box) {
      place = { left: safe.left + box.padding, right: safe.right + box.padding, topY: safe.topY + box.padding, bottomY: safe.bottomY - box.padding, width: safe.width - box.padding * 2 };
      if (place.width < 1 || place.bottomY - place.topY < 1) fail("bad_args", "box.padding (" + box.padding + ") leaves no room inside the safe area; use a smaller padding or smaller margins");
    }
    var fontCheck = null;
    if (mode === "template") {
      if (args.style) warnings.push("style is not used in template mode; the template comp has its own look");
    } else if (st.font) {
      fontCheck = checkStyleFont(st.font, caps, args.allow_substitute === true, warnings);
    }
    var restyle = args.restyle === true;
    var removeStale = args.remove_stale !== false;

    // Per-caption colour and italic, and the look: all checked before anything is written.
    var base = { anyColor: false, anyItalic: false, fill: st.fill };
    for (var ci0 = 0; ci0 < caps.length; ci0++) {
      if (caps[ci0].color) base.anyColor = true;
      if (caps[ci0].italic_given) base.anyItalic = true;
    }
    if (mode === "template" && (base.anyColor || base.anyItalic)) warnings.push("speaker colours and italics are not applied in template mode; the template sets its own look");
    var lookKind = args.look === undefined || args.look === null ? "none" : args.look;
    if (lookKind !== "none" && lookKind !== "pop" && lookKind !== "pill_slide" && lookKind !== "fill_sweep") fail("bad_args", "look must be none, pop, pill_slide or fill_sweep");
    var lookSp = null;
    if (lookKind !== "none") {
      if (mode !== "layers" && mode !== "words") fail("bad_args", "look applies to layers and words modes, not " + mode + " (single keys one layer's text; a template sets its own look)");
      if (lookKind === "fill_sweep" && hl) fail("bad_args", "look fill_sweep and highlight both colour the spoken words; use one of them");
      if (lookKind === "pill_slide" && textBox) fail("bad_args", "look pill_slide measures point text; it cannot follow paragraph (text_box) text");
      for (var lk0 = 0; lk0 < caps.length; lk0++) {
        if (caps[lk0].words.length !== wordCount(caps[lk0].text)) {
          fail("bad_args", "caption " + (lk0 + 1) + " has " + wordCount(caps[lk0].text) + " words but " + caps[lk0].words.length + " word times; look " + lookKind + " needs one per word");
        }
      }
      lookSp = lookSpec(lookKind, args.look_options, st.fontSize, comp.frameDuration);
    } else if (args.look_options) {
      fail("bad_args", "look_options need a look (pop, pill_slide or fill_sweep)");
    }
    var existingLooks = [];

    // What exists already, by name; nothing is touched yet.
    var found;
    if (mode === "words") found = scanWordLayers(comp, prefix);
    else found = scanCaptions(comp, prefix, mode);
    var numberOf = function (i) {
      if (mode === "single") return 1;
      return first + i;
    };
    var count = caps.length;
    if (mode === "single") count = 1;
    var lastNumber = first + count - 1;

    // match 'time': Node paired existing layers (by id) with the new numbers; those layers are renamed and updated.
    var oldOf = null;
    var usedOld = {};
    var mapping = args.mapping;
    if (mapping) {
      if (typeof mapping.length !== "number") fail("bad_args", "mapping must be a list of { layer_id, number }");
      oldOf = {};
      for (var mi = 0; mi < mapping.length; mi++) {
        var me = mapping[mi];
        if (!me || !isNum(me.layer_id) || !isNum(me.number) || Math.floor(me.number) !== me.number) fail("bad_args", "mapping entry " + (mi + 1) + " needs a layer_id and a whole number");
        if (me.number < first || me.number > lastNumber) fail("bad_args", "mapping entry " + (mi + 1) + " names caption " + me.number + ", outside " + first + ".." + lastNumber);
        var oldN = null;
        for (var fi = 0; fi < found.list.length; fi++) {
          if (found.list[fi].kind === "caption" && found.list[fi].layer.id === me.layer_id) {
            oldN = found.list[fi].number;
            break;
          }
        }
        if (oldN === null) fail("bad_args", "mapping entry " + (mi + 1) + ": no caption layer with id " + me.layer_id + " under the prefix \"" + prefix + "\"");
        if (oldOf[me.number] !== undefined) fail("bad_args", "mapping gives caption " + me.number + " two layers");
        if (usedOld[oldN]) fail("bad_args", "mapping uses the layer of caption " + oldN + " twice");
        oldOf[me.number] = oldN;
        usedOld[oldN] = true;
      }
    }
    var oldNumberFor = function (n) {
      if (!oldOf) return n;
      if (oldOf[n] !== undefined) return oldOf[n];
      return null;
    };

    var existingCaps = [];
    var i;
    for (i = 0; i < count; i++) {
      var oldNum = oldNumberFor(numberOf(i));
      var ex = null;
      if (oldNum !== null) ex = found.caps[oldNum] || null;
      existingCaps.push(ex);
      if (ex && mode === "words") {
        for (var wk in ex) {
          if (!ex.hasOwnProperty(wk)) continue;
          var wex = ex[wk];
          if (!isTextLayer(wex)) fail("bad_args", "Layer \"" + wex.name + "\" has a word layer's name but is not a text layer");
          if (sourceTextProp(wex).numKeys > 0) fail("bad_args", "Layer \"" + wex.name + "\" has Source Text keyframes; remove them or use another name_prefix");
          if (wex.locked === true) fail("bad_args", "Layer \"" + wex.name + "\" is locked; unlock it first");
          // The tool writes Position and Anchor Point as plain values and rebuilds Scale and Opacity keys only where
          // they are its own (the look mark); keys the user made would be thrown on or wiped mid-write.
          var wtg = wex.property("ADBE Transform Group");
          var wOwn = lookMarkOf(wex) !== "";
          var wGuard = [["ADBE Position", "Position", false], ["ADBE Anchor Point", "Anchor Point", false], ["ADBE Scale", "Scale", true], ["ADBE Opacity", "Opacity", true]];
          for (var wg = 0; wg < wGuard.length; wg++) {
            if (wGuard[wg][2] && (wOwn || lookKind !== "pop")) continue;
            var wprop = wtg.property(wGuard[wg][0]);
            if (wprop && wprop.numKeys > 0) {
              fail("bad_args", "Layer \"" + wex.name + "\" has keyframes on " + wGuard[wg][1] + " that this tool did not make; remove them or use another name_prefix");
            }
          }
        }
      } else if (ex && mode === "template") {
        var tsrc = null;
        try { tsrc = ex.source; } catch (eTs) { tsrc = null; }
        if (!tsrc || !(tsrc instanceof CompItem)) fail("bad_args", "Layer \"" + ex.name + "\" has a caption's name but is not a precomp layer; remove it or use another name_prefix");
        if (tsrc.id !== tplComp.id) fail("bad_args", "Layer \"" + ex.name + "\" is an instance of \"" + tsrc.name + "\", not of the template \"" + tplComp.name + "\"; remove it or use another name_prefix");
        if (ex.locked === true) fail("bad_args", "Layer \"" + ex.name + "\" is locked; unlock it first");
        // Before the undo group, so a wrong mapping stops with nothing changed.
        checkEssentialFields(ex, tplFields);
      } else if (ex) {
        if (!isTextLayer(ex)) fail("bad_args", "Layer \"" + ex.name + "\" has a caption's name but is not a text layer");
        if (mode === "layers" && sourceTextProp(ex).numKeys > 0) {
          fail("bad_args", "Layer \"" + ex.name + "\" has Source Text keyframes; remove them or use another name_prefix");
        }
        if (ex.locked === true) fail("bad_args", "Layer \"" + ex.name + "\" is locked; unlock it first");
        if (ex.startTime !== 0) warnings.push("\"" + ex.name + "\" starts at " + ex.startTime + " s, not 0: its keys are written in comp time");
      }
      var exLook = null;
      if (oldNum !== null) exLook = found.looks[oldNum] || null;
      if (exLook && !isShapeLayer(exLook)) fail("bad_args", "Layer \"" + exLook.name + "\" has a look layer's name but is not a shape layer");
      if (exLook && exLook.locked === true) fail("bad_args", "Layer \"" + exLook.name + "\" is locked; unlock it first");
      existingLooks.push(exLook);
      if (lookKind === "pill_slide" && ex && mode === "layers") {
        var wasBox = false;
        try { wasBox = sourceTextProp(ex).value.boxText === true; } catch (eBx) {}
        if (wasBox) fail("bad_args", "Layer \"" + ex.name + "\" is paragraph text; look pill_slide measures point text");
      }
      var exBox = null;
      if (oldNum !== null) exBox = found.boxes[oldNum] || null;
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
    var stale = [];
    if (removeStale && mode !== "single") {
      for (i = 0; i < found.list.length; i++) {
        var f = found.list[i];
        var isStale = false;
        if (oldOf) isStale = !usedOld[f.number] && f.number >= first;
        else isStale = f.number > lastNumber;
        if (isStale) stale.push(f.layer);
      }
      for (i = 0; i < stale.length; i++) {
        if (stale[i].locked === true) fail("bad_args", "Layer \"" + stale[i].name + "\" is locked and would be removed as stale; unlock it first or set remove_stale to false");
      }
    } else if (oldOf && mode !== "single") {
      // Unmatched layers that stay would share a name with a new caption.
      for (i = 0; i < found.list.length; i++) {
        var g1 = found.list[i];
        if (!usedOld[g1.number] && g1.number >= first && g1.number <= lastNumber) {
          fail("bad_args", "Layer \"" + g1.layer.name + "\" matches no new caption but its number is one the new captions use; set remove_stale to true or use another name_prefix");
        }
      }
    }

    // parent_to_null: the control null, found by name (it must be a null) or made in the undo group.
    var controlName = prefix + " Control";
    var control = null;
    var existingControl = findNamedLayer(comp, controlName);
    if (parentOn) {
      control = existingControl;
      if (control && control.nullLayer !== true) fail("bad_args", "Layer \"" + controlName + "\" exists but is not a null layer; rename it or use another name_prefix");
      if (control && control.locked === true) fail("bad_args", "Layer \"" + controlName + "\" is locked; unlock it first");
    }
    // New or restyled captions are placed in comp space. A control the user has moved would shift them, so it must be
    // back at identity first (this also covers captions parented to it by an earlier run when parent_to_null is off).
    if (existingControl && existingControl.nullLayer === true) {
      var anyNew = false;
      var anyParented = false;
      for (i = 0; i < existingCaps.length; i++) {
        if (!existingCaps[i]) {
          anyNew = true;
          continue;
        }
        var exLayers = [];
        if (mode === "words") {
          for (var ek in existingCaps[i]) {
            if (existingCaps[i].hasOwnProperty(ek)) exLayers.push(existingCaps[i][ek]);
          }
        } else {
          exLayers.push(existingCaps[i]);
        }
        for (var el = 0; el < exLayers.length; el++) {
          var elp = null;
          try { elp = exLayers[el].parent; } catch (eEp) { elp = null; }
          if (elp && elp.id === existingControl.id) anyParented = true;
        }
      }
      if (parentOn || ((restyle || anyNew) && anyParented)) {
        var cProblem = controlProblem(existingControl);
        if (cProblem) {
          fail("bad_args", "Layer \"" + controlName + "\" " + cProblem + ", so captions placed or restyled now would land in the wrong place. Move it back to the origin (anchor and position 0, scale 100, rotation 0, no keyframes) or remove it, then run again");
        }
      }
    }
    if (precomposeOn && !precompExisted && findNamedLayer(comp, prefix + " Captions")) {
      fail("bad_args", "A layer named \"" + prefix + " Captions\" is already in the comp");
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
      var touched = [];
      var renamed = 0;
      var wordLayerCount = 0;
      var timingsOut = [];
      var extraWords = [];
      var controlMade = false;
      var controlId = null;
      var lookKeys = 0;
      var lookLayers = 0;
      var looksRemoved = 0;
      var oldLooks = [];
      var pillKids = [];
      var precompOut = null;
      var targetCompId = comp.id;

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
        var applyOne = function (idx, capsOnLayer, nLines, existing, name, boxName, existingBox, srcCaps, lookName, existingLook) {
          var layer = existing;
          var isNew = false;
          var fitted = null;
          var first0 = capsOnLayer[0];
          var last0 = capsOnLayer[capsOnLayer.length - 1];
          var renameFrom = null;
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
            // match 'time': the layer takes the new caption's number.
            if (oldOf && layer.name !== name) {
              renameFrom = layer.name;
              layer.name = name;
              renamed++;
            }
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
            var plan = stylePlan(layer, base);
            applyCapStyle(doc, srcCaps[0], base, plan);
            src.setValue(doc);
            for (var c = 0; c < srcCaps.length; c++) {
              doc.text = srcCaps[c].text;
              applyCapStyle(doc, srcCaps[c], base, plan);
              src.setValueAtTime(srcCaps[c].start, doc);
              var gapAfter = c + 1 >= srcCaps.length || srcCaps[c + 1].start > srcCaps[c].end + 1e-6;
              if (gapAfter) {
                doc.text = "";
                src.setValueAtTime(srcCaps[c].end, doc);
              }
            }
            markStyle(layer, base);
          } else {
            doc = src.value;
            doc.text = first0.text;
            if (isNew || restyle) styleDoc(doc, st, isNew);
            applyCapStyle(doc, first0, base, stylePlan(layer, base));
            if (!isNew) fitted = fitBox(doc, nLines, restyle);
            src.setValue(doc);
            markStyle(layer, base);
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
              if (renameFrom !== null) {
                retargetBox(bl, renameFrom, name);
                bl.name = boxName;
              }
              // The box's look comes from the box options when the style is reset; otherwise it is kept.
              if (restyle) styleBox(bl, layer, box);
              else boxKept++;
            }
            setSpan(bl, first0.start, last0.end);
            touched.push(bl);
            boxCount++;
          } else if (existingBox) {
            // No box given: an earlier run's box still follows the text, so its span follows too.
            if (renameFrom !== null) {
              retargetBox(existingBox, renameFrom, name);
              existingBox.name = boxName;
            }
            touched.push(existingBox);
            setSpan(existingBox, first0.start, last0.end);
            warnings.push("\"" + existingBox.name + "\" is from an earlier run; only its in and out were moved to the caption's");
          }
          // The look: animators are rebuilt each run; a pill is a layer of its own, made again each run.
          if (mode === "layers") {
            var hadLook = 0;
            if (!isNew) {
              try {
                hadLook = removeLookAnimators(layer);
              } catch (eLk) {
                warnings.push("\"" + layer.name + "\" still has Caption Look animators from an earlier run (could not remove them: " + A.formatError(eLk) + ")");
              }
            }
            var wStarts = [];
            var wEnds = [];
            for (var wq = 0; wq < first0.words.length; wq++) {
              wStarts.push(first0.words[wq].start);
              wEnds.push(wordEnd(first0, wq));
            }
            if (existingLook) {
              oldLooks.push(existingLook);
              if (lookKind !== "pill_slide") {
                removed.push(existingLook.name);
                looksRemoved++;
              }
            }
            if (lookKind === "none" && hadLook > 0) looksRemoved++;
            if (lookKind === "pop") {
              lookKeys += applyPopLayer(layer, wStarts, first0.start, lookSp.dur, lookSp.sf);
              lookLayers++;
            } else if (lookKind === "fill_sweep") {
              lookKeys += applySweepLayer(layer, wStarts, wEnds, charCounts(first0.lines), first0.start, lookSp.color);
              lookLayers++;
            } else if (lookKind === "pill_slide") {
              var dnow = sourceTextProp(layer).value;
              var fs2 = Number(dnow.fontSize);
              var lead2 = fs2 * 1.2;
              try {
                if (dnow.autoLeading === false && isNum(dnow.leading)) lead2 = dnow.leading;
              } catch (eLd) {}
              var rects = measureWordRects(layer, first0.lines, fs2, lead2, justificationName(dnow.justification));
              var pl = makePill(comp, layer, lookName, lookSp);
              madeLayers.push(pl);
              pl.parent = layer;
              lookKeys += keyPill(pl, rects, wStarts, first0.start, lookSp.dur, lookSp.padding);
              setSpan(pl, first0.start, last0.end);
              pillKids.push(pl);
              if (existingLook) updated.push(lookName);
              else created.push(lookName);
              lookLayers++;
            }
          }
          touched.push(layer);
          return layer;
        };

        // Words mode: one text layer per word, laid out by measuring each word's extents in AE.
        var runWords = function () {
          var wst = { font: st.font, fontSize: st.fontSize, fill: st.fill, stroke: st.stroke, strokeWidth: st.strokeWidth, justification: "left" };
          var lh = st.fontSize * 1.2;
          for (var ci = 0; ci < caps.length; ci++) {
            var n = numberOf(ci);
            var byWord = existingCaps[ci] || {};
            var lineTokens = tokensOf(caps[ci].lines);
            var flat = [];
            var lineStart = [];
            var li;
            var wd;
            for (li = 0; li < lineTokens.length; li++) {
              lineStart.push(flat.length);
              for (wd = 0; wd < lineTokens[li].length; wd++) flat.push(lineTokens[li][wd]);
            }
            // A caption whose words changed gets new word layers: AE answers sourceRectAtTime with the previous text's
            // rectangle in the script that changed the text, so reused layers would be laid out from stale widths (and
            // would keep the timing and look keys of another caption). The old ones are removed at the end.
            var sameWords = true;
            var oldCount = 0;
            for (var okey in byWord) {
              if (!byWord.hasOwnProperty(okey)) continue;
              oldCount++;
              var oi = Number(okey);
              if (oi < 1 || oi > flat.length || String(sourceTextProp(byWord[okey]).value.text) !== flat[oi - 1]) sameWords = false;
            }
            if (oldCount !== flat.length) sameWords = false;
            if (!sameWords && oldCount > 0) {
              for (var dk in byWord) {
                if (byWord.hasOwnProperty(dk)) extraWords.push(byWord[dk]);
              }
              byWord = {};
            }
            var layers = [];
            var lineOfWord = [];
            for (li = 0; li < lineTokens.length; li++) {
              for (wd = 0; wd < lineTokens[li].length; wd++) lineOfWord.push(li);
            }
            var relayout = restyle;
            for (wd = 0; wd < flat.length; wd++) {
              var wname = prefix + " " + pad(n, width) + "." + pad(wd + 1, 2);
              var wl = byWord[wd + 1] || null;
              var fresh = false;
              if (!wl) {
                wl = comp.layers.addText(flat[wd]);
                madeLayers.push(wl);
                wl.name = wname;
                created.push(wname);
                fresh = true;
              } else {
                updated.push(wl.name);
                if (wl.name !== wname) {
                  wl.name = wname;
                  renamed++;
                }
              }
              var wsrc = sourceTextProp(wl);
              var wdoc = wsrc.value;
              var textChanged = String(wdoc.text) !== flat[wd];
              wdoc.text = flat[wd];
              if (fresh || restyle) styleDoc(wdoc, wst, fresh);
              applyCapStyle(wdoc, caps[ci], base, stylePlan(wl, base));
              wsrc.setValue(wdoc);
              markStyle(wl, base);
              setSpan(wl, caps[ci].words[wd].start, caps[ci].end);
              if (fresh || textChanged) relayout = true;
              // The same words on different lines need a new layout; a word moved by hand on the same line is left alone.
              if (lineMarkOf(wl) !== lineOfWord[wd]) relayout = true;
              var wm = readMarks(wl);
              wm.line = lineOfWord[wd];
              writeMarks(wl, wm);
              layers.push(wl);
              touched.push(wl);
            }
            // Words past the new count are stale, and the words that remain move to their new places.
            for (var xk in byWord) {
              if (byWord.hasOwnProperty(xk) && Number(xk) > flat.length) {
                extraWords.push(byWord[xk]);
                relayout = true;
              }
            }
            if (relayout) {
              var spaceW = null;
              try { spaceW = measureSpace(layers[0], flat[0]); } catch (eSp) { spaceW = null; }
              if (spaceW === null) {
                spaceW = st.fontSize * 0.28;
                warnings.push("caption " + n + ": could not measure a space in the font; used " + Math.round(spaceW) + " px");
              }
              var widths = [];
              var lefts = [];
              for (wd = 0; wd < layers.length; wd++) {
                var mt = measureText(layers[wd]);
                var mw = mt.width;
                if (!isNum(mw) || mw <= 0) mw = st.fontSize * 0.3;
                widths.push(mw);
                lefts.push(isNum(mt.left) ? mt.left : 0);
              }
              var basePos = pointPosition(comp, place, st.fontSize, lineTokens.length, st.justification, position);
              for (li = 0; li < lineTokens.length; li++) {
                var from = lineStart[li];
                var to = from + lineTokens[li].length;
                var lineW = spaceW * (lineTokens[li].length - 1);
                for (wd = from; wd < to; wd++) lineW += widths[wd];
                // Measured in one layer by advance (a sentinel glyph makes the trailing spaces count): a word's text origin is the
                // advance of the words before it, so side bearings and the real space between the inks are kept
                // (ink widths plus one space run tight).
                var pre = null;
                try { pre = measureLineAdvances(layers[from], lineTokens[li], spaceW, flat[from]); } catch (ePre) { pre = null; }
                if (pre !== null) lineW = pre.adv;
                else warnings.push("caption " + n + " line " + (li + 1) + ": could not measure the line's word positions; used one measured space between the words");
                var lineLeft = (comp.width - lineW) / 2;
                if (st.justification === "left") lineLeft = place.left;
                else if (st.justification === "right") lineLeft = comp.width - place.right - lineW;
                var cursor = lineLeft;
                for (wd = from; wd < to; wd++) {
                  // The layer's position is where its anchor sits: the text's origin plus the anchor (a pop look moves it to the word's middle).
                  var an = layers[wd].property("ADBE Transform Group").property("ADBE Anchor Point").value;
                  var px;
                  if (pre !== null) px = lineLeft + pre.origins[wd - from] + an[0];
                  else px = cursor - lefts[wd] + an[0];
                  setPosition(layers[wd], [px, basePos[1] + li * lh + an[1]]);
                  cursor += widths[wd] + spaceW;
                }
              }
            }
            // The look: word layers take theirs off and get it again; a pill is a layer of its own per caption.
            var wasLooked = 0;
            for (wd = 0; wd < layers.length; wd++) wasLooked += clearWordLook(layers[wd]);
            var oldPill = existingLooks[ci];
            if (oldPill) {
              oldLooks.push(oldPill);
              if (lookKind !== "pill_slide") {
                removed.push(oldPill.name);
                looksRemoved++;
              }
            }
            if (lookKind === "none" && wasLooked > 0) looksRemoved++;
            if (lookKind === "pop") {
              for (wd = 0; wd < layers.length; wd++) lookKeys += applyPopWord(layers[wd], caps[ci].words[wd].start, lookSp.dur, lookSp.sf);
              lookLayers++;
            } else if (lookKind === "fill_sweep") {
              for (wd = 0; wd < layers.length; wd++) lookKeys += applySweepWord(layers[wd], caps[ci].words[wd].start, wordEnd(caps[ci], wd), lookSp.color);
              lookLayers++;
            } else if (lookKind === "pill_slide") {
              var infos = [];
              var topOff = null;
              var botOff = null;
              var lowest = layers[0];
              for (wd = 0; wd < layers.length; wd++) {
                var rw = layers[wd].sourceRectAtTime(layers[wd].inPoint, false);
                var tgw = layers[wd].property("ADBE Transform Group");
                var pw = tgw.property("ADBE Position").value;
                var aw = tgw.property("ADBE Anchor Point").value;
                var ww = rw.width;
                if (!isNum(ww) || ww <= 0) ww = st.fontSize * 0.3;
                infos.push({ x: pw[0] - aw[0] + rw.left, y: pw[1] - aw[1], w: ww });
                if (topOff === null || rw.top < topOff) topOff = rw.top;
                if (botOff === null || rw.top + rw.height > botOff) botOff = rw.top + rw.height;
                if (layers[wd].index > lowest.index) lowest = layers[wd];
              }
              var prects = [];
              var wstarts = [];
              for (wd = 0; wd < infos.length; wd++) {
                prects.push({ cx: infos[wd].x + infos[wd].w / 2, cy: infos[wd].y + topOff + (botOff - topOff) / 2, w: infos[wd].w, h: botOff - topOff });
                wstarts.push(caps[ci].words[wd].start);
              }
              var pillName = prefix + " " + pad(n, width) + " Look";
              var pill = makePill(comp, lowest, pillName, lookSp);
              madeLayers.push(pill);
              lookKeys += keyPill(pill, prects, wstarts, wstarts[0], lookSp.dur, lookSp.padding);
              setSpan(pill, wstarts[0], caps[ci].end);
              touched.push(pill);
              if (oldPill) updated.push(pillName);
              else created.push(pillName);
              lookLayers++;
            }
            wordLayerCount += flat.length;
            timingsOut.push([caps[ci].words[0].start, caps[ci].end]);
          }
        };

        // Template mode: one precomp layer of the template per caption, its Essential Properties set to the caption's text.
        // Reads only: the group exists, every mapped property is on it and holds text.
        var checkEssential = function (layer) {
          checkEssentialFields(layer, tplFields);
        };
        var setEssential = function (layer, cap) {
          var g = layer.property("ADBE Layer Overrides");
          for (var fi2 = 0; fi2 < tplFields.length; fi2++) {
            var fld = tplFields[fi2];
            var target = findOverride(g, fld.name, 0);
            var v = "";
            if (fld.kind === "line1") v = cap.lines[0];
            else if (fld.kind === "line2") v = cap.lines.length > 1 ? cap.lines[1] : "";
            else if (fld.kind === "line3") v = cap.lines.length > 2 ? cap.lines[2] : "";
            else if (fld.kind === "text") v = cap.text;
            else v = cap.speaker;
            var tdoc = target.value;
            // AE's line break in Source Text is \r; a \n would show as one line.
            tdoc.text = String(v).split("\r\n").join("\r").split("\n").join("\r");
            target.setValue(tdoc);
          }
        };
        // The template's caption text layer: where its first baseline sits and how big it is. Read once, before the instances move.
        var tplCaption = null;
        var tplPlace = safe;
        var tplClipWarned = false;
        var readTplCaption = function () {
          var cl = findNamedLayer(tplComp, "Caption");
          if (!cl || !isTextLayer(cl)) {
            for (var q = 1; q <= tplComp.numLayers; q++) {
              if (isTextLayer(tplComp.layer(q))) {
                cl = tplComp.layer(q);
                break;
              }
            }
          }
          if (!cl || !isTextLayer(cl)) {
            warnings.push("the template comp has no text layer, so the instances are moved only when layout.position is given (by the template's extents)");
            return;
          }
          var cd = sourceTextProp(cl).value;
          var ctg = cl.property("ADBE Transform Group");
          var cpos = ctg.property("ADBE Position").value;
          var canc = ctg.property("ADBE Anchor Point").value;
          var csc = ctg.property("ADBE Scale").value;
          var cfs = Number(cd.fontSize) * (isNum(csc[1]) ? csc[1] / 100 : 1);
          var clead = cfs * 1.2;
          try {
            if (cd.autoLeading === false && isNum(cd.leading)) clead = cd.leading * (isNum(csc[1]) ? csc[1] / 100 : 1);
          } catch (eLead) {}
          var cj = "center";
          try { cj = justificationName(cd.justification); } catch (eJ) {}
          var boxed = false;
          try { boxed = cd.boxText === true; } catch (eBt2) {}
          if (boxed) {
            var bsz = null;
            try { bsz = cd.boxTextSize; } catch (eBs) {}
            if (bsz && bsz.length >= 2 && bsz[1] < clead * 2 - 1) warnings.push("the template's caption is paragraph text only " + Math.round(bsz[1]) + " px tall; a two-line caption needs " + Math.round(clead * 2) + " px or the second line is hidden");
            warnings.push("the template's caption is paragraph text, so it is placed by its first baseline as if it were point text");
          }
          // A caption of n lines is moved so its first baseline lands where layers mode puts it (its last line on the safe area's bottom).
          var padT = 0;
          var bl = findNamedLayer(tplComp, "Caption Box");
          if (bl && isShapeLayer(bl)) padT = boxPadding(bl);
          if (padT > 0) tplPlace = { left: safe.left + padT, right: safe.right + padT, topY: safe.topY + padT, bottomY: safe.bottomY - padT, width: safe.width - padT * 2 };
          var x0 = cpos[0] - canc[0];
          var y0 = cpos[1] - canc[1];
          tplCaption = {
            fontSize: cfs,
            lead: clead,
            justification: cj,
            x: x0,
            y: y0,
            bottomLine: y0 + cfs * 0.25
          };
        };
        var runTemplate = function () {
          readTplCaption();
          // Pass 1 changes nothing that exists: new instances are added (and taken back on a failure) and every
          // instance is checked, so a bad template mapping stops before the first earlier caption is touched.
          var inst = [];
          var ti;
          for (ti = 0; ti < caps.length; ti++) {
            var tl0 = existingCaps[ti];
            var made0 = false;
            if (!tl0) {
              tl0 = comp.layers.add(tplComp);
              madeLayers.push(tl0);
              made0 = true;
            }
            checkEssential(tl0);
            inst.push({ layer: tl0, fresh: made0 });
          }
          for (ti = 0; ti < caps.length; ti++) {
            var n = numberOf(ti);
            var nm = prefix + " " + pad(n, width);
            var tl = inst[ti].layer;
            var fresh = inst[ti].fresh;
            if (fresh) {
              tl.name = nm;
              created.push(nm);
            } else {
              updated.push(tl.name);
              if (tl.name !== nm) {
                tl.name = nm;
                renamed++;
              }
            }
            // The template's own time 0 is the caption's in point, so its intro plays when the caption appears.
            tl.startTime = caps[ti].start;
            setSpan(tl, caps[ti].start, caps[ti].end);
            setEssential(tl, caps[ti]);
            // Placed like layers mode: the template's caption on the safe area's bottom (or layout.position), by its line count.
            if ((fresh || restyle) && tplCaption) {
              var tg = tl.property("ADBE Transform Group");
              var ia = tg.property("ADBE Anchor Point").value;
              var want = pointPosition(comp, tplPlace, tplCaption.fontSize, caps[ti].lines.length, tplCaption.justification, position);
              // A template point p lands at position - anchor + p in the comp, so the position that puts the baseline on `want`:
              setPosition(tl, [want[0] - tplCaption.x + ia[0], want[1] - tplCaption.y + ia[1]]);
              if (tplCaption.bottomLine + (caps[ti].lines.length - 1) * tplCaption.lead > tplComp.height + 0.5 && !tplClipWarned) {
                tplClipWarned = true;
                warnings.push("the template comp is " + tplComp.height + " px tall, so a " + caps[ti].lines.length + "-line caption runs past its bottom edge and the lines below the frame are cut off; make the template taller (ae_captions make_template sizes it for its lines)");
              }
            } else if ((fresh || restyle) && args.layout && args.layout.position) {
              // No text layer to place by: move the whole instance by its extents.
              var rr = tl.sourceRectAtTime(tl.inPoint, false);
              var pp2 = tl.property("ADBE Transform Group").property("ADBE Position").value;
              var aa = tl.property("ADBE Transform Group").property("ADBE Anchor Point").value;
              var topY = pp2[1] + rr.top - aa[1];
              var dy = 0;
              if (position === "top") dy = safe.topY - topY;
              else if (position === "middle") dy = comp.height / 2 - (topY + rr.height / 2);
              else dy = safe.bottomY - (topY + rr.height);
              setPosition(tl, [pp2[0], pp2[1] + dy]);
            }
            touched.push(tl);
            timingsOut.push([caps[ti].start, caps[ti].end]);
          }
        };

        if (mode === "words") {
          runWords();
        } else if (mode === "template") {
          runTemplate();
        } else if (mode === "single") {
          applyOne(0, caps, maxLines, existingCaps[0], prefix, prefix + " Box", found.boxes[1] || null, caps, null, null);
        } else {
          for (i = 0; i < caps.length; i++) {
            var n = numberOf(i);
            var nm = prefix + " " + pad(n, width);
            var oldBoxN = oldNumberFor(n);
            var oldBox = null;
            if (oldBoxN !== null) oldBox = found.boxes[oldBoxN] || null;
            applyOne(i, [caps[i]], caps[i].lines.length, existingCaps[i], nm, nm + " Box", oldBox, null, nm + " Look", existingLooks[i]);
          }
        }
        if (boxKept > 0) warnings.push(boxKept + " existing box" + (boxKept === 1 ? "" : "es") + " kept the earlier look (color, opacity, padding, roundness); pass restyle: true to apply the box options");
        // Stale layers go last, so a failure above leaves the old captions in place.
        for (i = 0; i < stale.length; i++) {
          removed.push(stale[i].name);
          stale[i].remove();
        }
        for (i = 0; i < extraWords.length; i++) {
          removed.push(extraWords[i].name);
          extraWords[i].remove();
        }
        for (i = 0; i < oldLooks.length; i++) oldLooks[i].remove();
        // parent_to_null: every caption (and box) layer follows the control null; positions are kept.
        if (parentOn) {
          if (!control) {
            control = comp.layers.addNull(comp.duration);
            madeLayers.push(control);
            control.name = controlName;
            controlMade = true;
            // An identity null: moving it moves every caption, and parenting changes no local values.
            control.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
            control.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0]);
          }
          for (i = 0; i < touched.length; i++) {
            var child = touched[i];
            if (child.parent && child.parent.id === control.id) continue;
            child.parent = control;
          }
          touched.push(control);
          // Read now: precompose makes the control layer a new object, and this one becomes invalid.
          controlId = control.id;
        }
        // precompose: all caption layers (and the null) into "<prefix> Captions", unless an earlier run already did.
        if (precomposeOn && !precompExisted) {
          var idx = [];
          for (i = 0; i < touched.length; i++) idx.push(touched[i].index);
          for (i = 0; i < pillKids.length; i++) idx.push(pillKids[i].index);
          idx.sort(function (a1, b1) { return a1 - b1; });
          var inner = comp.layers.precompose(idx, prefix + " Captions", true);
          targetCompId = inner.id;
          var plId = null;
          for (i = 1; i <= comp.numLayers; i++) {
            var cand = comp.layer(i);
            var csrc = null;
            try { csrc = cand.source; } catch (eC) { csrc = null; }
            if (csrc && csrc.id === inner.id) {
              plId = cand.id;
              break;
            }
          }
          precompOut = { comp_id: inner.id, layer_id: plId, name: prefix + " Captions", created: true };
        } else if (precomposeOn) {
          precompOut = { comp_id: comp.id, layer_id: precompLayer.id, name: precompLayer.name, created: false };
        }
      } catch (e) {
        // Take back what this call added; edits to existing layers stay in the undo group.
        for (var r = madeLayers.length - 1; r >= 0; r--) {
          try { madeLayers[r].remove(); } catch (eRm) {}
        }
        throw e;
      }

      var timings = timingsOut;
      if (timings.length === 0) {
        for (i = 0; i < caps.length; i++) timings.push([caps[i].start, caps[i].end]);
      }
      var result = {
        comp_id: outerComp.id,
        target_comp_id: targetCompId,
        mode: mode,
        name_prefix: prefix,
        first_number: first,
        count: caps.length,
        created: created.slice(0, MAX_LIST),
        updated: updated.slice(0, MAX_LIST),
        removed: removed.slice(0, MAX_LIST),
        created_count: created.length,
        updated_count: updated.length,
        removed_count: removed.length,
        names_truncated: created.length > MAX_LIST || updated.length > MAX_LIST || removed.length > MAX_LIST,
        timings: timings,
        highlight_keys: highlightKeyCount,
        boxes: boxCount,
        font_size: st.fontSize,
        font_check: fontCheck === null ? undefined : fontCheck,
        justification: st.justification,
        safe: { left: safe.left, right: safe.right, top: safe.top, bottom: comp.height - safe.bottomY, width: safe.width },
        warnings: warnings
      };
      if (mode === "words") result.word_layers = wordLayerCount;
      if (lookKind !== "none") result.look = { kind: lookKind, layers: lookLayers, keys: lookKeys, duration_frames: lookSp.frames };
      if (looksRemoved > 0) result.looks_removed = looksRemoved;
      if (base.anyColor) result.colored = true;
      if (mode === "template") result.template = { comp_id: tplComp.id, name: tplComp.name, fields: tplFields.length };
      if (oldOf) result.renamed = renamed;
      if (parentOn) result.control = { name: controlName, id: controlId, created: controlMade };
      if (precompOut) result.precomp = precompOut;
      return result;
    });
  };
  // ---------- fit: captions measured wider than the safe area ----------

  // Rebreaks and/or shrinks the captions ae_captions measured too wide, one undo group. Node did the arithmetic from a
  // measurement made in a separate evalScript; this only writes. items: [{ layer_id, number, lines?, font_size? }] (layers)
  // or [{ key, lines?, font_size? }] on the one layer (single). A caption's position moves by the change in where its
  // first baseline belongs, so a layer the user placed keeps its offset. Paragraph (box) text is skipped: it wraps itself.
  A.captionsFit = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var mode = args.mode;
    if (mode !== "layers" && mode !== "single") fail("bad_args", "fit applies to layers and single mode");
    var items = args.items;
    if (!items || typeof items.length !== "number" || items.length < 1 || items.length > MAX_CAPTIONS) fail("bad_args", "give 1.." + MAX_CAPTIONS + " items to fit");
    var layout = args.layout || {};
    var position = layout.position || "bottom";
    if (position !== "bottom" && position !== "middle" && position !== "top") fail("bad_args", "layout.position must be bottom, middle or top");
    var safe = safeArea(comp, layout, args.default_margins, args.platform_margins);
    var place = safe;
    var pad = isNum(args.box_padding) ? args.box_padding : 0;
    if (pad > 0) place = { left: safe.left + pad, right: safe.right + pad, topY: safe.topY + pad, bottomY: safe.bottomY - pad, width: safe.width - pad * 2 };

    var layers = [];
    var i;
    var it;
    var layer;
    if (mode === "single") {
      layer = null;
      for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).id === args.layer_id) layer = comp.layer(i);
      }
      if (!layer) fail("not_found", "No layer with id " + args.layer_id + " in comp " + comp.id);
      if (!isTextLayer(layer)) fail("bad_args", "Layer \"" + layer.name + "\" is not a text layer");
      if (layer.locked === true) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first");
    } else {
      for (i = 0; i < items.length; i++) {
        it = items[i];
        if (!it || !isNum(it.layer_id)) fail("bad_args", "item " + (i + 1) + " needs a layer_id");
        layer = null;
        for (var li = 1; li <= comp.numLayers; li++) {
          if (comp.layer(li).id === it.layer_id) layer = comp.layer(li);
        }
        if (!layer) fail("not_found", "No layer with id " + it.layer_id + " in comp " + comp.id);
        if (!isTextLayer(layer)) fail("bad_args", "Layer \"" + layer.name + "\" is not a text layer");
        if (layer.locked === true) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first");
        if (sourceTextProp(layer).numKeys > 0) fail("bad_args", "Layer \"" + layer.name + "\" has Source Text keyframes; remove them before fitting");
        layers.push(layer);
      }
    }
    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (it.font_size !== undefined && it.font_size !== null) checkRange(it.font_size, 1, 1296, "items[" + i + "].font_size");
      if (it.lines !== undefined && it.lines !== null && (typeof it.lines.length !== "number" || it.lines.length < 1 || it.lines.length > 8)) fail("bad_args", "items[" + i + "].lines must be 1..8 lines");
    }

    return A.withUndo(args.label || "Fit captions", function () {
      var fitted = [];
      var skipped = [];
      var joinLines = function (lines) {
        var parts = [];
        for (var q = 0; q < lines.length; q++) parts.push(String(lines[q]).split("\r").join(" ").split("\n").join(" "));
        return parts.join("\r");
      };
      var firstBaseline = function (fs, n, just) {
        return pointPosition(comp, place, fs, n, just, position)[1];
      };
      var scaleStroke = function (d, oldFs, newFs) {
        try {
          if (d.applyStroke === true && isNum(d.strokeWidth) && oldFs > 0) d.strokeWidth = Math.max(0, d.strokeWidth * newFs / oldFs);
        } catch (eSt) {}
      };
      var k;
      if (mode === "single") {
        var src = sourceTextProp(layer);
        for (k = 0; k < items.length; k++) {
          it = items[k];
          if (!isNum(it.key) || it.key < 1 || it.key > src.numKeys) fail("bad_args", "items[" + k + "].key " + it.key + " is not a key of \"" + layer.name + "\" (it has " + src.numKeys + ")");
          var kd = src.keyValue(it.key);
          var kt = src.keyTime(it.key);
          var oldKFs = Number(kd.fontSize);
          if (it.lines) kd.text = joinLines(it.lines);
          if (isNum(it.font_size)) {
            kd.fontSize = it.font_size;
            scaleStroke(kd, oldKFs, it.font_size);
          }
          src.setValueAtTime(kt, kd);
          fitted.push({ key: it.key, time: kt, lines: it.lines ? it.lines.length : null, font_size: isNum(it.font_size) ? it.font_size : oldKFs });
        }
        holdKeys(src);
        return { comp_id: comp.id, mode: mode, fitted: fitted, skipped: skipped };
      }
      for (k = 0; k < items.length; k++) {
        it = items[k];
        layer = layers[k];
        var s2 = sourceTextProp(layer);
        var d = s2.value;
        var boxed = false;
        try { boxed = d.boxText === true; } catch (eBx) {}
        if (boxed) {
          skipped.push(layer.name);
          continue;
        }
        var oldFs = Number(d.fontSize);
        var oldN = String(d.text).split("\r").length;
        var just = "center";
        try { just = justificationName(d.justification); } catch (eJu) {}
        var newFs = oldFs;
        var newN = oldN;
        if (it.lines) {
          d.text = joinLines(it.lines);
          newN = it.lines.length;
        }
        if (isNum(it.font_size)) {
          newFs = it.font_size;
          d.fontSize = newFs;
          scaleStroke(d, oldFs, newFs);
        }
        s2.setValue(d);
        var pos = layer.property("ADBE Transform Group").property("ADBE Position").value;
        var dy = firstBaseline(newFs, newN, just) - firstBaseline(oldFs, oldN, just);
        if (Math.abs(dy) > 1e-6) setPosition(layer, [pos[0], pos[1] + dy]);
        fitted.push({ number: it.number, name: layer.name, lines: newN, font_size: newFs });
      }
      return { comp_id: comp.id, mode: mode, fitted: fitted, skipped: skipped };
    });
  };

  // ---------- ae_transcribe: is the comp's sound one untouched footage file? ----------

  // Read only. True (`eligible`) when exactly one layer is audible, it is footage from a file, and nothing changes its sound:
  // no time remap, no stretch, no effects, Audio Levels unkeyed at 0 dB. Then the file itself is the comp's audio, and its
  // times plus the layer's start time are comp times. `reasons` lists why not, for the caller to say.
  A.captionsAudioSource = function (args) {
    var comp = requireComp(args.comp_id);
    var reasons = [];
    var anySolo = false;
    var li;
    for (li = 1; li <= comp.numLayers; li++) {
      try { if (comp.layer(li).solo === true) anySolo = true; } catch (eS) {}
    }
    var audible = [];
    for (li = 1; li <= comp.numLayers; li++) {
      var l = comp.layer(li);
      var sounds = false;
      try { sounds = l.hasAudio === true && l.audioEnabled === true; } catch (eA) { sounds = false; }
      if (sounds && anySolo) {
        try { if (l.solo !== true) sounds = false; } catch (eS2) {}
      }
      if (sounds) audible.push(l);
    }
    var out = { comp_id: comp.id, name: comp.name, eligible: false, reasons: reasons, audible_layers: audible.length };
    if (audible.length !== 1) {
      reasons.push(audible.length === 0 ? "no layer has audio switched on" : audible.length + " layers have audio on (the file shortcut needs exactly one)");
      return out;
    }
    var layer = audible[0];
    out.layer = { id: layer.id, index: layer.index, name: layer.name, in_point: layer.inPoint, out_point: layer.outPoint, start_time: layer.startTime, stretch: layer.stretch };
    var src = null;
    try { src = layer.source; } catch (eSrc) { src = null; }
    if (!src || !(src instanceof FootageItem)) {
      reasons.push("the layer's source is not a footage item (a precomp or a solid has no file to send)");
    } else {
      var fsrc = null;
      try { fsrc = src.mainSource; } catch (eMs) { fsrc = null; }
      var file = null;
      try { if (fsrc && fsrc instanceof FileSource) file = src.file; } catch (eFile) { file = null; }
      if (!file) {
        reasons.push("the layer's footage is not a file on disk");
      } else {
        try { out.file = { path: file.fsName, name: src.name }; } catch (eFn) { reasons.push("could not read the footage file's path"); }
        try { if (!file.exists) reasons.push("the footage file is missing"); } catch (eEx) {}
        try { out.footage_duration = src.duration; } catch (eDu) {}
      }
    }
    var remap = false;
    try { remap = layer.timeRemapEnabled === true; } catch (eTr) {}
    if (remap) reasons.push("the layer has time remapping on");
    if (isNum(layer.stretch) && Math.abs(layer.stretch - 100) > 1e-6) reasons.push("the layer is time-stretched to " + layer.stretch + "%");
    var nfx = 0;
    try { nfx = layer.property("ADBE Effect Parade").numProperties; } catch (eFx) { nfx = 0; }
    if (nfx > 0) reasons.push("the layer has " + nfx + " effect" + (nfx === 1 ? "" : "s") + " (they may change its sound)");
    var levels = null;
    try { levels = layer.property("ADBE Audio Group").property("ADBE Audio Levels"); } catch (eLv) { levels = null; }
    if (!levels) {
      reasons.push("could not read the layer's Audio Levels");
    } else {
      var keyed = false;
      try { keyed = levels.numKeys > 0; } catch (eK) {}
      var expr = false;
      try { expr = levels.expressionEnabled === true; } catch (eEx2) {}
      var lv = null;
      try { lv = levels.value; } catch (eV) { lv = null; }
      if (keyed) reasons.push("Audio Levels has keyframes");
      else if (expr) reasons.push("Audio Levels has an expression");
      else if (!lv || Math.abs(lv[0]) > 1e-6 || Math.abs(lv[1]) > 1e-6) reasons.push("Audio Levels is not 0 dB");
    }
    out.eligible = reasons.length === 0;
    return out;
  };

  // ---------- caption template for Premiere (Essential Graphics) ----------

  // Adds a property to a comp's Essential Graphics under a name; true when AE took the name (AE 23+ has ...As).
  function addToEssential(prop, comp, name) {
    var can = true;
    try { can = prop.canAddToMotionGraphicsTemplate(comp); } catch (e0) { can = false; }
    if (!can) fail("runtime", "After Effects will not add \"" + name + "\" to Essential Graphics");
    if (typeof prop.addToMotionGraphicsTemplateAs === "function") {
      prop.addToMotionGraphicsTemplateAs(comp, name);
      return true;
    }
    prop.addToMotionGraphicsTemplate(comp);
    return false;
  }

  A.captionsTemplate = function (args) {
    assertGuard(args.expect);
    var target = requireComp(args.comp_id);
    if (typeof target.motionGraphicsTemplateControllerCount !== "number") fail("bad_args", "This After Effects has no Essential Graphics API (AE 22 or later is needed for make_template)");
    var warnings = [];
    var mt = args.make_template || {};
    var name = mt.name;
    if (typeof name !== "string" || name.length < 1 || name.length > 100) fail("bad_args", "make_template.name must be a string of 1..100 characters");
    var w = mt.width === undefined || mt.width === null ? target.width : mt.width;
    var h = mt.height === undefined || mt.height === null ? target.height : mt.height;
    var dur = mt.duration_s === undefined || mt.duration_s === null ? 5 : mt.duration_s;
    checkRange(w, 4, 30000, "make_template.width");
    checkRange(h, 4, 30000, "make_template.height");
    checkRange(dur, 0.1, 10800, "make_template.duration_s");
    if (Math.floor(w) !== w || Math.floor(h) !== h) fail("bad_args", "make_template width and height must be whole numbers");
    for (var ni = 1; ni <= app.project.numItems; ni++) {
      var other = app.project.item(ni);
      if (other && other.name === name && other instanceof CompItem) warnings.push("a comp named \"" + name + "\" already exists; the new comp has the same name");
    }
    var s = args.style || {};
    var st = {
      font: s.font,
      fontSize: s.font_size,
      fill: s.fill_color || [1, 1, 1],
      stroke: s.stroke_color || null,
      strokeWidth: s.stroke_width,
      justification: s.justification || "center"
    };
    if (st.font !== undefined && st.font !== null && (typeof st.font !== "string" || st.font.length < 1 || st.font.length > 200)) fail("bad_args", "style.font must be a PostScript font name of 1..200 characters");
    // The size ae_captions would use for the comp the template is for (6% of its short side), not the template comp's own.
    if (st.fontSize === undefined || st.fontSize === null) st.fontSize = Math.round(Math.min(target.width, target.height) * 0.06);
    checkRange(st.fontSize, 1, 1296, "style.font_size");
    checkColor(st.fill, "style.fill_color");
    if (st.stroke) {
      checkColor(st.stroke, "style.stroke_color");
      if (st.strokeWidth === undefined || st.strokeWidth === null) st.strokeWidth = Math.max(1, Math.round(st.fontSize / 12));
      checkRange(st.strokeWidth, 0, 200, "style.stroke_width");
      warnings.push("the Caption Color control is a Fill effect, which recolours the stroke too");
    }
    // Room for the lines a caption has: the first baseline is placed so `lines` lines end on the safe area's bottom, and the comp must hold them.
    var tplLines = mt.lines === undefined || mt.lines === null ? 2 : mt.lines;
    checkRange(tplLines, 1, 4, "make_template.lines");
    var needH = Math.ceil(tplLines * st.fontSize * 1.2 + st.fontSize * 1.0 + (args.box ? 2 * args.box.padding : 0));
    if (h < needH) {
      warnings.push("the template comp was " + h + " px tall, too small for " + tplLines + " lines at " + st.fontSize + " px; made " + needH + " px tall");
      h = needH;
    }
    justificationValue(st.justification);
    if (s.text_box) fail("bad_args", "make_template makes point text; style.text_box does not apply");
    var layout = args.layout || {};
    var position = layout.position || "bottom";
    if (position !== "bottom" && position !== "middle" && position !== "top") fail("bad_args", "layout.position must be bottom, middle or top");
    var size = { width: w, height: h };
    var safe = safeArea(size, layout, args.default_margins, args.platform_margins);
    var place = safe;
    var box = args.box;
    if (box) {
      checkColor(box.color, "box.color");
      checkRange(box.opacity, 0, 100, "box.opacity");
      checkRange(box.padding, 0, 1000, "box.padding");
      checkRange(box.roundness, 0, 1000, "box.roundness");
      place = { left: safe.left + box.padding, right: safe.right + box.padding, topY: safe.topY + box.padding, bottomY: safe.bottomY - box.padding, width: safe.width - box.padding * 2 };
      if (place.width < 1 || place.bottomY - place.topY < 1) fail("bad_args", "box.padding (" + box.padding + ") leaves no room inside the safe area");
    }
    var fps = target.frameRate;
    var lookKind = args.look === undefined || args.look === null ? "none" : args.look;
    if (lookKind !== "none" && lookKind !== "pop") fail("bad_args", "a template takes look none or pop (pill_slide and fill_sweep need the word times of a real caption)");
    var lookSp = null;
    if (lookKind === "pop") lookSp = lookSpec("pop", args.look_options, st.fontSize, 1 / fps);
    else if (args.look_options) fail("bad_args", "look_options need a look");
    var sample = typeof mt.sample_text === "string" && mt.sample_text.length > 0 ? mt.sample_text : "Caption text";
    if (st.font) checkStyleFont(st.font, [{ text: sample }], args.allow_substitute === true, warnings);
    if (typeof app.project.items === "undefined" || typeof app.project.items.addComp !== "function") fail("not_found", "This After Effects has no project.items.addComp");

    return A.withUndo(args.label || "Caption template", function () {
      var nc = null;
      var names = [];
      var named = true;
      try {
        nc = app.project.items.addComp(name, w, h, 1, dur, fps);
        var tl = nc.layers.addText(sample);
        tl.name = "Caption";
        var src = sourceTextProp(tl);
        var doc = src.value;
        doc.text = sample;
        styleDoc(doc, st, true);
        src.setValue(doc);
        setPosition(tl, pointPosition(size, place, st.fontSize, tplLines, st.justification, position));
        var boxLayer = null;
        if (box) boxLayer = makeBox(nc, tl, "Caption Box", box, true);
        if (lookKind === "pop") applyPopWord(tl, 0, lookSp.dur, lookSp.sf);
        // The Fill effect is the colour control: Source Text cannot expose its fill on its own.
        tl.property("ADBE Effect Parade").addProperty("ADBE Fill");
        var fx = function () { return tl.property("ADBE Effect Parade").property("ADBE Fill"); };
        if (!fx() || !fx().property("ADBE Fill-0002")) fail("runtime", "The Fill effect did not take (no Color property)");
        fx().property("ADBE Fill-0002").setValue([st.fill[0], st.fill[1], st.fill[2], 1]);
        if (!addToEssential(sourceTextProp(tl), nc, "Caption Text")) named = false;
        if (!addToEssential(fx().property("ADBE Fill-0002"), nc, "Caption Color")) named = false;
        if (boxLayer) {
          var bfill = function () { return boxLayer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group").property("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color"); };
          if (!addToEssential(bfill(), nc, "Box Color")) named = false;
          if (!addToEssential(boxLayer.property("ADBE Transform Group").property("ADBE Opacity"), nc, "Box Opacity")) named = false;
        }
        try { nc.motionGraphicsTemplateName = name; } catch (eN) {}
        names = controllerNames(nc) || [];
      } catch (e) {
        if (nc) {
          try { nc.remove(); } catch (eRm) {}
        }
        throw e;
      }
      var result = {
        comp_id: nc.id,
        name: name,
        width: w,
        height: h,
        duration_s: dur,
        frame_rate: fps,
        font_size: st.fontSize,
        lines: tplLines,
        controllers: names,
        controllers_named: named,
        has_box: !!box,
        look: lookKind,
        warnings: warnings
      };
      return result;
    });
  };

  // The new template comp as it is: its controllers and layers.
  // Template mode, fit: how wide each caption's lines set in the template's caption style, in the template's own pixels.
  // The text layer inside a template is shared by every instance (an instance only overrides its Essential Property), so the
  // instances can't be measured one by one. A temporary text layer in the template comp takes the caption layer's text
  // document (font, size, tracking...) and each line is set in it in turn; the layer is removed again before the call ends
  // (one undo group, nothing is left behind). args: { comp_id, texts: [[line, ...], ...] }. Returns
  // { comp_id, width, height, font_size, scale, box_padding, method: "measured" | "estimated", widths: [widest line per caption] }.
  // When no temporary layer can be made, widths are estimated from the pixels per character of the caption layer's own sample text.
  A.captionsTemplateMeasure = function (args) {
    var comp = requireComp(args.comp_id);
    var texts = args.texts;
    if (!texts || typeof texts.length !== "number" || texts.length < 1 || texts.length > MAX_CAPTIONS) fail("bad_args", "give 1.." + MAX_CAPTIONS + " captions to measure");
    var cl = findNamedLayer(comp, "Caption");
    if (!cl || !isTextLayer(cl)) {
      cl = null;
      for (var q = 1; q <= comp.numLayers; q++) {
        if (isTextLayer(comp.layer(q))) {
          cl = comp.layer(q);
          break;
        }
      }
    }
    if (!cl) fail("bad_args", "The template comp \"" + comp.name + "\" has no text layer to measure the captions with");
    var baseDoc = sourceTextProp(cl).value;
    var sc = 1;
    try {
      var csc = cl.property("ADBE Transform Group").property("ADBE Scale").value;
      if (isNum(csc[0]) && csc[0] > 0) sc = csc[0] / 100;
    } catch (eSc) {}
    var out = { comp_id: comp.id, name: comp.name, width: comp.width, height: comp.height, font_size: Number(baseDoc.fontSize) * sc, scale: sc, box_padding: 0, method: "measured", widths: [] };
    var bl = findNamedLayer(comp, "Caption Box");
    if (bl && isShapeLayer(bl)) out.box_padding = boxPadding(bl);
    var lineOf = function (t) { return String(t).split("\r").join(" ").split("\n").join(" "); };
    var tmp = null;
    var measured = null;
    return A.withUndo(args.label || "Measure template captions", function () {
      try {
        try {
          tmp = comp.layers.addText("x");
          tmp.enabled = false;
          var tsrc = sourceTextProp(tmp);
          measured = [];
          for (var ci = 0; ci < texts.length; ci++) {
            var widest = 0;
            for (var li = 0; li < texts[ci].length; li++) {
              var d = baseDoc;
              d.text = lineOf(texts[ci][li]);
              tsrc.setValue(d);
              var w = tmp.sourceRectAtTime(0, false).width;
              if (!isNum(w) || w < 0) throw new Error("no width for \"" + d.text + "\"");
              if (w > widest) widest = w;
            }
            measured.push(widest * sc);
          }
        } catch (eMeasure) {
          measured = null;
        }
        if (measured === null) {
          // Estimate from the sample text the caption layer holds.
          var sample = String(baseDoc.text).split("\r").join("\n").split("\n");
          var longest = 0;
          for (var sl = 0; sl < sample.length; sl++) {
            if (sample[sl].length > longest) longest = sample[sl].length;
          }
          var sw = cl.sourceRectAtTime(0, false).width;
          if (!isNum(sw) || sw <= 0 || longest < 1) fail("unmeasurable", "Could not measure text in the template comp \"" + comp.name + "\"");
          var perChar = (sw * sc) / longest;
          out.method = "estimated";
          measured = [];
          for (var ei = 0; ei < texts.length; ei++) {
            var most = 0;
            for (var ej = 0; ej < texts[ei].length; ej++) {
              var n = lineOf(texts[ei][ej]).length;
              if (n > most) most = n;
            }
            measured.push(most * perChar);
          }
        }
      } finally {
        if (tmp) {
          try { tmp.remove(); } catch (eRm) {}
        }
      }
      out.widths = measured;
      return out;
    });
  };

  A.captionsTemplateRead = function (args) {
    var comp = requireComp(args.comp_id);
    var out = {
      comp_id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      frameRate: comp.frameRate,
      controllers: controllerNames(comp) || [],
      layers: []
    };
    try { out.template_name = String(comp.motionGraphicsTemplateName); } catch (e0) {}
    for (var i = 1; i <= comp.numLayers && i <= MAX_LIST; i++) {
      var l = comp.layer(i);
      var item = { name: l.name, id: l.id };
      if (isTextLayer(l)) {
        item.kind = "text";
        try {
          var d = sourceTextProp(l).value;
          item.text = boundString(d.text);
          docStyle(d, item);
        } catch (e1) {}
        item.look = lookMarkOf(l) !== "" ? { present: true, kind: lookMarkOf(l) } : { present: false };
        try { item.has_fill_effect = !!l.property("ADBE Effect Parade").property("ADBE Fill"); } catch (e2) {}
      } else if (isShapeLayer(l)) {
        item.kind = "shape";
        try { item.opacity = l.property("ADBE Transform Group").property("ADBE Opacity").value; } catch (e3) {}
      } else {
        item.kind = "other";
      }
      out.layers.push(item);
    }
    return out;
  };
})($.global);
