// panel/host/ext/legibility.jsx
//
// Host functions for the legibility tools (text against what is behind it):
// - legibilityRead (read): every text layer of a comp (or the ones asked for)
//   with, at each time, whether it shows, its box in comp pixels, its screen
//   font size, opacity and the fill and stroke the DOM reports, plus flags for
//   what makes that DOM colour untrustworthy (animators, effects, layer styles,
//   mixed fill). The pixel work is done on the Node side.
// - legibilityState (read): item counts, to prove the check left nothing behind
// - legibilityBegin (guarded write): duplicate the comp and switch the tested
//   text layers OFF in the COPY, in one undo group. The server renders the
//   original and the copy at the same times and diffs them: the changed pixels
//   are the glyphs, the copy's pixels are what is behind them.
// - legibilityEnd (guarded write): remove that copy, in its own undo group
//
// Not covered (said in the tool's notes): text inside precomps (the duplicate
// shares nested comps with the original), 3D text and text parented to a 3D
// layer (its box depends on the camera).
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - The reads never change time, selection, solo, resolution or the active item:
//   valueAtTime and sourceRectAtTime take a time and don't move the time indicator.
// - The writes check the guard first, validate before A.withUndo, and begin and
//   end their undo group in the same call. The read-back is a separate call.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var MAX_TIMES = 12;
  var MAX_TEST = 100;
  var MAX_TEXT = 200;
  var MAX_PARENT_DEPTH = 20;
  // The temporary comp carries this prefix; legibilityEnd only ever removes a comp that does.
  var COPY_PREFIX = "chroma-legibility-copy ";

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

  // By id, index, or a name only one layer has.
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

  function isTextLayer(l) {
    try {
      return !!l.reflect && String(l.reflect.name) === "TextLayer";
    } catch (e) {
      return false;
    }
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

  function valueAt(p, t) {
    if (!p) return null;
    try {
      return p.valueAtTime(t, false);
    } catch (e) {
      return null;
    }
  }

  function num(v, fill) {
    if (typeof v === "number" && v === v) return v;
    return fill;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  // ---------- the layer's box in comp pixels (2D only) ----------

  // [a, b, c, d, e, f]: layer (x, y) to parent (a*x + b*y + c, d*x + e*y + f).
  function localMatrix(l, t) {
    var tr = child(l, "ADBE Transform Group");
    if (!tr) return null;
    var an = valueAt(child(tr, "ADBE Anchor Point"), t);
    var po = valueAt(child(tr, "ADBE Position"), t);
    var sc = valueAt(child(tr, "ADBE Scale"), t);
    var ro = num(valueAt(child(tr, "ADBE Rotate Z"), t), 0);
    if (!an || !po || !sc) return null;
    var rad = (ro * Math.PI) / 180;
    var cs = Math.cos(rad);
    var sn = Math.sin(rad);
    var sx = sc[0] / 100;
    var sy = sc[1] / 100;
    var a = cs * sx;
    var b = -sn * sy;
    var d = sn * sx;
    var e = cs * sy;
    return [a, b, po[0] - (a * an[0] + b * an[1]), d, e, po[1] - (d * an[0] + e * an[1])];
  }

  function compose(m, n) {
    return [
      m[0] * n[0] + m[1] * n[3],
      m[0] * n[1] + m[1] * n[4],
      m[0] * n[2] + m[1] * n[5] + m[2],
      m[3] * n[0] + m[4] * n[3],
      m[3] * n[1] + m[4] * n[4],
      m[3] * n[2] + m[4] * n[5] + m[5]
    ];
  }

  // Null when the layer or a parent is 3D (its box depends on the camera) or has no transform.
  function compMatrix(l, t) {
    var m = null;
    var cur = l;
    for (var depth = 0; cur && depth < MAX_PARENT_DEPTH; depth++) {
      try {
        if (cur.threeDLayer === true) return null;
      } catch (e0) {}
      var local = localMatrix(cur, t);
      if (local === null) return null;
      if (m === null) m = local;
      else m = compose(local, m);
      cur = cur.parent;
    }
    return m;
  }

  // The axis-aligned bounds [left, top, right, bottom] of a rect through the matrix.
  function boundsOf(m, r) {
    var xs = [r.left, r.left + r.width];
    var ys = [r.top, r.top + r.height];
    var minX = 1e12;
    var minY = 1e12;
    var maxX = -1e12;
    var maxY = -1e12;
    for (var xi = 0; xi < 2; xi++) {
      for (var yi = 0; yi < 2; yi++) {
        var px = m[0] * xs[xi] + m[1] * ys[yi] + m[2];
        var py = m[3] * xs[xi] + m[4] * ys[yi] + m[5];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
    return [round2(minX), round2(minY), round2(maxX), round2(maxY)];
  }

  // ---------- text style ----------

  function rgb3(v) {
    if (!v || typeof v.length !== "number" || v.length < 3) return null;
    return [num(v[0], 0), num(v[1], 0), num(v[2], 0)];
  }

  function isBold(td) {
    try {
      if (td.fauxBold === true) return true;
    } catch (e0) {}
    var style = "";
    try {
      style = String(td.fontStyle || "");
    } catch (e1) {}
    var font = "";
    try {
      font = String(td.font || "");
    } catch (e2) {}
    var s = (style + " " + font).toLowerCase();
    if (s.indexOf("semi") >= 0 || s.indexOf("demi") >= 0) return false;
    return s.indexOf("bold") >= 0 || s.indexOf("black") >= 0 || s.indexOf("heavy") >= 0;
  }

  // True when the characters have different fill colours (CharacterRange, AE 24.3+), false when one,
  // null when AE can't say. The index base of characterRange is unmeasured, so a failure reads as null.
  function mixedFill(td) {
    try {
      if (typeof td.characterRange !== "function") return null;
      var len = String(td.text).length;
      if (len < 2) return false;
      var cr = td.characterRange(0, len);
      var f = cr.fillColor;
      return f === undefined || f === null;
    } catch (e) {
      return null;
    }
  }

  function textOf(td) {
    var s = "";
    try {
      s = String(td.text);
    } catch (e) {}
    if (s.length > MAX_TEXT) s = s.substring(0, MAX_TEXT);
    return s;
  }

  function countOf(group) {
    if (!group) return 0;
    try {
      return group.numProperties;
    } catch (e) {
      return 0;
    }
  }

  // True when an enabled layer style is found; null when the group can't be read. Unmeasured on AE 26.
  function layerStylesOn(l) {
    var g = child(l, "ADBE Layer Styles");
    if (!g) return false;
    try {
      // The group can be toggled only when at least one style exists; its slots list whether or not a style is applied.
      if (g.canSetEnabled !== true) return false;
      for (var i = 1; i <= g.numProperties; i++) {
        var p = g.property(i);
        if (!p || String(p.matchName) === "ADBE Blend Options Group") continue;
        if (p.canSetEnabled === true && p.enabled === true) return true;
      }
    } catch (e) {
      return null;
    }
    return false;
  }

  function matteName(t) {
    try {
      if (t === TrackMatteType.NO_TRACK_MATTE) return null;
      if (t === TrackMatteType.ALPHA) return "alpha";
      if (t === TrackMatteType.ALPHA_INVERTED) return "alpha_inverted";
      if (t === TrackMatteType.LUMA) return "luma";
      if (t === TrackMatteType.LUMA_INVERTED) return "luma_inverted";
    } catch (e) {}
    return null;
  }

  function hasSoloVideoLayer(c) {
    var n = c.numLayers;
    for (var i = 1; i <= n; i++) {
      try {
        var sl = c.layer(i);
        if (sl.solo !== true) continue;
        var rn = "";
        try {
          rn = String(sl.reflect.name);
        } catch (e0) {}
        if (rn === "CameraLayer" || rn === "LightLayer") continue;
        var vid = true;
        try {
          if (sl.hasVideo === false) vid = false;
        } catch (e1) {}
        if (vid) return true;
      } catch (e2) {}
    }
    return false;
  }

  function readSample(l, t, soloAny) {
    var s = {
      time: t,
      visible: false,
      opacity: null,
      box: null,
      box_reason: null,
      screen_font_px: null,
      font_size: null,
      bold: false,
      apply_fill: null,
      fill_rgb: null,
      apply_stroke: null,
      stroke_rgb: null,
      mixed_fill: null,
      text: ""
    };
    var tr = child(l, "ADBE Transform Group");
    var op = valueAt(child(tr, "ADBE Opacity"), t);
    s.opacity = op === null ? null : num(op, null);
    var inRange = false;
    try {
      inRange = t >= l.inPoint && t < l.outPoint;
    } catch (e0) {}
    var soloOk = !soloAny;
    try {
      if (soloAny && l.solo === true) soloOk = true;
    } catch (e1) {}
    var on = false;
    try {
      on = l.enabled === true;
    } catch (e2) {}
    var guide = false;
    try {
      guide = l.guideLayer === true;
    } catch (eg) {}
    s.guide = guide;
    s.visible = on && inRange && soloOk && !guide && (s.opacity === null || s.opacity > 0);

    var td = null;
    var tp = child(l, "ADBE Text Properties");
    var doc = child(tp, "ADBE Text Document");
    td = valueAt(doc, t);
    if (td) {
      s.text = textOf(td);
      s.font_size = num(td.fontSize, null);
      s.bold = isBold(td);
      try {
        s.apply_fill = td.applyFill === true;
        if (s.apply_fill) s.fill_rgb = rgb3(td.fillColor);
      } catch (e3) {}
      try {
        s.apply_stroke = td.applyStroke === true;
        if (s.apply_stroke) s.stroke_rgb = rgb3(td.strokeColor);
      } catch (e4) {}
      if (s.apply_fill) s.mixed_fill = mixedFill(td);
    }

    var m = compMatrix(l, t);
    if (m === null) {
      s.box_reason = "3D layer, or parented to one: its box depends on the camera";
      return s;
    }
    var r = null;
    try {
      r = l.sourceRectAtTime(t, false);
    } catch (e5) {
      s.box_reason = "sourceRectAtTime failed: " + String(e5.message || e5);
      return s;
    }
    if (!r || !(r.width > 0) || !(r.height > 0)) {
      s.box_reason = "the text has no area at this time (empty text)";
      return s;
    }
    s.box = boundsOf(m, r);
    // Geometric mean of the matrix scale: the font size as it lands on the frame.
    var det = Math.abs(m[0] * m[4] - m[1] * m[3]);
    if (s.font_size !== null) s.screen_font_px = round2(s.font_size * Math.sqrt(det));
    return s;
  }

  function clampTime(c, t) {
    var last = c.duration - c.frameDuration;
    if (last < 0) last = 0;
    if (t > last) t = last;
    if (t < 0) t = 0;
    return t;
  }

  // args: { comp_id, times?, layers? }. Without times, the comp's current time.
  A.legibilityRead = function (args) {
    var c = requireComp(args.comp_id);
    var times = [];
    var raw = args.times;
    var i;
    if (raw === undefined || raw === null || raw.length === 0) {
      times.push(clampTime(c, num(c.time, 0)));
    } else {
      if (raw.length > MAX_TIMES) fail("bad_args", "At most " + MAX_TIMES + " times per call");
      for (i = 0; i < raw.length; i++) {
        if (typeof raw[i] !== "number" || raw[i] !== raw[i] || raw[i] < 0) fail("bad_args", "times must be numbers of seconds, 0 or more");
        times.push(clampTime(c, raw[i]));
      }
    }

    // Selectors resolve first, so a bad one fails before anything is read.
    var wanted = null;
    if (args.layers && args.layers.length > 0) {
      wanted = {};
      for (i = 0; i < args.layers.length; i++) {
        var pick = findLayer(c, args.layers[i]);
        if (!isTextLayer(pick)) fail("bad_args", "Layer " + pick.index + " \"" + pick.name + "\" is not a text layer");
        wanted[pick.id] = true;
      }
    }

    var soloAny = hasSoloVideoLayer(c);
    var layers = [];
    var textTotal = 0;
    var n = c.numLayers;
    var truncated = false;
    for (i = 1; i <= n; i++) {
      var l = c.layer(i);
      if (!isTextLayer(l)) continue;
      if (wanted !== null && wanted[l.id] !== true) continue;
      textTotal++;
      if (layers.length >= MAX_LAYERS) {
        truncated = true;
        continue;
      }
      var name = String(l.name);
      if (name.length > MAX_TEXT) name = name.substring(0, MAX_TEXT);
      var parentId = null;
      try {
        if (l.parent) parentId = l.parent.id;
      } catch (e0) {}
      var matte = null;
      try {
        matte = matteName(l.trackMatteType);
      } catch (e1) {}
      var isMatte = false;
      try {
        isMatte = l.isTrackMatte === true;
      } catch (e2) {}
      var tp = child(l, "ADBE Text Properties");
      var entry = {
        index: l.index,
        id: l.id,
        name: name,
        enabled: l.enabled === true,
        in_point: l.inPoint,
        out_point: l.outPoint,
        parent_id: parentId,
        animators: countOf(child(tp, "ADBE Text Animators")),
        effects: countOf(child(l, "ADBE Effect Parade")),
        layer_styles: layerStylesOn(l),
        track_matte: matte,
        is_track_matte: isMatte,
        samples: []
      };
      for (var k = 0; k < times.length; k++) entry.samples.push(readSample(l, times[k], soloAny));
      layers.push(entry);
    }

    var res = null;
    try {
      res = [c.resolutionFactor[0], c.resolutionFactor[1]];
    } catch (e3) {}
    return {
      comp: {
        id: c.id,
        name: String(c.name),
        width: c.width,
        height: c.height,
        duration: c.duration,
        frame_duration: c.frameDuration,
        pixel_aspect: c.pixelAspect,
        resolution_factor: res
      },
      times: times,
      layers: layers,
      total_layers: n,
      text_layers: textTotal,
      truncated: truncated || textTotal > layers.length,
      solo_active: soloAny
    };
  };

  // ---------- the temporary comp ----------

  function projectState() {
    var total = app.project.numItems;
    var temps = 0;
    var comps = 0;
    for (var i = 1; i <= total; i++) {
      var it = app.project.item(i);
      if (it instanceof CompItem) {
        comps++;
        if (String(it.name).indexOf(COPY_PREFIX) === 0) temps++;
      }
    }
    return { num_items: total, comps: comps, temp_comps: temps };
  }

  // args (optional): { comp_id, layer_ids }. With them the state also lists
  // whether each of those layers is switched on in the ORIGINAL comp, so the
  // receipt can show the check did not touch the original's text layers.
  A.legibilityState = function (args) {
    var st = projectState();
    if (args && args.comp_id !== undefined && args.layer_ids && args.layer_ids.length > 0) {
      var comp = null;
      try {
        comp = app.project.itemByID(args.comp_id);
      } catch (e) {
        comp = null;
      }
      var layers = [];
      if (comp && comp instanceof CompItem) {
        var want = {};
        var k;
        for (k = 0; k < args.layer_ids.length && k < MAX_TEST; k++) want[String(args.layer_ids[k])] = true;
        for (k = 1; k <= comp.numLayers; k++) {
          var l = comp.layer(k);
          if (want[String(l.id)] === true) layers.push({ id: l.id, enabled: l.enabled === true });
        }
      }
      st.layers = layers;
    }
    return st;
  };

  // args: { comp_id, layers: [{ index, id, name }], expect }. The listed text
  // layers are switched off in a duplicate of the comp. A duplicated comp's
  // layers get new ids but keep their indexes, so the copy is addressed by index.
  A.legibilityBegin = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var want = args.layers;
    var i;
    // Everything that can fail is checked here, before the duplicate exists.
    if (!want || want.length === 0) fail("bad_args", "No text layers to test");
    if (want.length > MAX_TEST) fail("bad_args", "At most " + MAX_TEST + " text layers per call");
    var seen = {};
    for (i = 0; i < want.length; i++) {
      var w = want[i];
      if (!w || typeof w.index !== "number" || typeof w.id !== "number") fail("bad_args", "Each layer needs an index and an id");
      if (seen[w.index] === true) fail("bad_args", "Layer index " + w.index + " is listed twice");
      seen[w.index] = true;
      if (w.index < 1 || w.index > comp.numLayers) fail("not_found", "Layer index " + w.index + " out of range");
      var l = comp.layer(w.index);
      if (l.id !== w.id) fail("guard", "Layer " + w.index + " is not the layer read earlier (id " + w.id + "); the stack changed. Re-read and retry.");
      if (!isTextLayer(l)) fail("bad_args", "Layer " + w.index + " is not a text layer");
    }
    var before = projectState();
    var made = A.withUndo("Chroma AE MCP: legibility check (copy)", function () {
      var copy = comp.duplicate();
      try {
        copy.name = COPY_PREFIX + comp.name;
        var off = 0;
        for (var k = 0; k < want.length; k++) {
          var cl = copy.layer(want[k].index);
          if (!cl || !isTextLayer(cl) || cl.name !== comp.layer(want[k].index).name) {
            fail("not_found", "The copy's layer " + want[k].index + " is not the text layer it should be");
          }
          // The copy is our own throwaway: unlock it so the switch can change (the original keeps its lock).
          if (cl.locked === true) cl.locked = false;
          cl.enabled = false;
          off++;
        }
        return { copy_id: copy.id, copy_name: copy.name, switched_off: off };
      } catch (e) {
        // Never leave a half-made copy in the project.
        try {
          copy.remove();
        } catch (e2) {}
        throw e;
      }
    });
    return {
      copy_id: made.copy_id,
      copy_name: made.copy_name,
      original_id: comp.id,
      switched_off: made.switched_off,
      comp_size: [comp.width, comp.height],
      items_before: before.num_items
    };
  };

  // args: { copy_id, expect }. Removes the temporary copy, and only such a copy.
  A.legibilityEnd = function (args) {
    assertGuard(args.expect);
    var item = null;
    try {
      item = app.project.itemByID(args.copy_id);
    } catch (e) {
      item = null;
    }
    if (!item) return { removed: false, already_gone: true, copy_id: args.copy_id };
    if (!(item instanceof CompItem) || String(item.name).indexOf(COPY_PREFIX) !== 0) {
      fail("guard", "Refused: item " + args.copy_id + " is not a legibility copy, so it was not removed.");
    }
    A.withUndo("Chroma AE MCP: legibility check (remove copy)", function () {
      item.remove();
    });
    return { removed: true, copy_id: args.copy_id };
  };
})($.global);
