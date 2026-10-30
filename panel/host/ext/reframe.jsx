// panel/host/ext/reframe.jsx
//
// Host functions for ae_reframe:
// - reframeComp: copies a comp to other sizes (16:9, 1:1, 4:5, 9:16 ...) and
//   re-lays its top-level layers out (guarded, one undo group for every size)
// - reframeReport: layer bounds against the safe area, for the server's
//   read-back (a separate evalScript)
//
// Layout, per top-level (unparented) layer:
// - background (footage, solid, adjustment or shape layer covering the
//   frame): scaled to cover the new frame, centred
// - 3D layers, cameras and lights: moved by the change of the frame's centre
// - layers with no picture (audio only) or no Transform group: left as is
// - a track matte follows its target: same scale factor, and a shift that
//   keeps it aligned with the target
// - everything else, controller nulls included: pinned to the nearest edge
//   or the centre of the safe area, keeping its margin, and shrunk if it no
//   longer fits. A layer's pin zone and shrink come from the union box of it
//   and all its (2D) descendants, which follow their parent.
//
// Boxes are measured at a "rest time": of nine times across the layer's (or
// group's) span, the one where most of the box is inside the frame (ties go to
// the time nearest the middle), so slide-ins do not decide the layout.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var GUIDE_NAME = "Safe area (guide)";
  var REST_SAMPLES = 9;

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

  function safeRect(w, h, m) {
    return { left: w * m.left, top: h * m.top, right: w * (1 - m.right), bottom: h * (1 - m.bottom) };
  }

  function isNull(layer) {
    try { return layer.nullLayer === true; } catch (e) { return false; }
  }

  function isCameraOrLight(layer) {
    return (layer instanceof CameraLayer) || (layer instanceof LightLayer);
  }

  function is3d(layer) {
    try { return layer.threeDLayer === true; } catch (e) { return false; }
  }

  function hasVisuals(layer) {
    if (isCameraOrLight(layer) || isNull(layer)) return false;
    try {
      if (layer instanceof AVLayer && !layer.hasVideo) return false;
    } catch (e) {}
    return true;
  }

  // A layer with nothing to lay out: audio only (no Transform group at all).
  function noPicture(layer) {
    if (isCameraOrLight(layer) || isNull(layer)) return false;
    try {
      if (layer instanceof AVLayer && !layer.hasVideo) return true;
    } catch (e) {}
    return false;
  }

  function transformOf(layer) {
    var tr = null;
    try { tr = layer.property("ADBE Transform Group"); } catch (e) { tr = null; }
    if (!tr) return null;
    var hasPos = null;
    try { hasPos = tr.property("ADBE Position"); } catch (e2) { hasPos = null; }
    if (!hasPos) return null;
    return tr;
  }

  function activeAt(layer, t) {
    return t >= layer.inPoint - 0.0001 && t <= layer.outPoint;
  }

  // ---------- comp-space geometry through the parent chain ----------

  // One link per layer from `layer` up through its parents: position, anchor,
  // scale and Z rotation at time t. Null when a link is 3D, a camera or a light
  // (not supported), or has no Transform group.
  function chainLinks(layer, t) {
    var links = [];
    var cur = layer;
    var guard = 0;
    while (cur && guard < 64) {
      if (isCameraOrLight(cur) || is3d(cur)) return null;
      var tr = transformOf(cur);
      if (!tr) return null;
      var pos = tr.property("ADBE Position").valueAtTime(t, false);
      var anc = tr.property("ADBE Anchor Point").valueAtTime(t, false);
      var sc = tr.property("ADBE Scale").valueAtTime(t, false);
      var rot = 0;
      try { rot = tr.property("ADBE Rotate Z").valueAtTime(t, false); } catch (e) {}
      var rad = rot * Math.PI / 180;
      links.push({
        px: pos[0], py: pos[1], ax: anc[0], ay: anc[1],
        sx: sc[0] / 100, sy: sc[1] / 100, cs: Math.cos(rad), sn: Math.sin(rad)
      });
      var par = null;
      try { par = cur.parent; } catch (e1) { par = null; }
      cur = par;
      guard++;
    }
    return links;
  }

  // A point in the layer's own space to comp space: for the layer, then each
  // ancestor, subtract the anchor, scale, rotate, add the position.
  function mapPoint(links, x, y) {
    for (var i = 0; i < links.length; i++) {
      var L = links[i];
      var lx = (x - L.ax) * L.sx;
      var ly = (y - L.ay) * L.sy;
      var nx = L.px + lx * L.cs - ly * L.sn;
      var ny = L.py + lx * L.sn + ly * L.cs;
      x = nx;
      y = ny;
    }
    return [x, y];
  }

  // Comp-space bounding box of a 2D layer at time t, through its parents.
  // Null for an unsupported chain. A layer with no picture is a point (its anchor).
  function layerBox(layer, t) {
    var links = chainLinks(layer, t);
    if (!links) return null;
    var pt;
    if (!hasVisuals(layer)) {
      pt = mapPoint(links, links[0].ax, links[0].ay);
      return { left: pt[0], top: pt[1], right: pt[0], bottom: pt[1], point: true };
    }
    var r = null;
    try { r = layer.sourceRectAtTime(t, false); } catch (e) { r = null; }
    if (!r) {
      pt = mapPoint(links, links[0].ax, links[0].ay);
      return { left: pt[0], top: pt[1], right: pt[0], bottom: pt[1], point: true };
    }
    var xs = [r.left, r.left + r.width];
    var ys = [r.top, r.top + r.height];
    var box = null;
    for (var i = 0; i < 2; i++) {
      for (var j = 0; j < 2; j++) {
        var p = mapPoint(links, xs[i], ys[j]);
        if (!box) {
          box = { left: p[0], top: p[1], right: p[0], bottom: p[1], point: false };
        } else {
          if (p[0] < box.left) box.left = p[0];
          if (p[0] > box.right) box.right = p[0];
          if (p[1] < box.top) box.top = p[1];
          if (p[1] > box.bottom) box.bottom = p[1];
        }
      }
    }
    return box;
  }

  // Union box of a layer and its visual, enabled, active 2D descendants at t.
  // A point when neither the layer nor any descendant has a picture.
  function groupBox(root, desc, t) {
    var rootBox = layerBox(root, t);
    if (!rootBox) return null;
    var box = null;
    if (!rootBox.point) {
      box = { left: rootBox.left, top: rootBox.top, right: rootBox.right, bottom: rootBox.bottom, point: false };
    }
    for (var i = 0; i < desc.length; i++) {
      var d = desc[i];
      if (!hasVisuals(d)) continue;
      var on = true;
      try { on = d.enabled; } catch (e) { on = true; }
      if (!on) continue;
      if (!activeAt(d, t)) continue;
      var b = layerBox(d, t);
      if (!b || b.point) continue;
      if (!box) {
        box = { left: b.left, top: b.top, right: b.right, bottom: b.bottom, point: false };
      } else {
        if (b.left < box.left) box.left = b.left;
        if (b.top < box.top) box.top = b.top;
        if (b.right > box.right) box.right = b.right;
        if (b.bottom > box.bottom) box.bottom = b.bottom;
      }
    }
    if (!box) return rootBox;
    return box;
  }

  function insideArea(box, w, h) {
    if (box.point) {
      if (box.left >= 0 && box.left <= w && box.top >= 0 && box.top <= h) return 1;
      return 0;
    }
    var iw = Math.min(box.right, w) - Math.max(box.left, 0);
    var ih = Math.min(box.bottom, h) - Math.max(box.top, 0);
    if (iw <= 0 || ih <= 0) return 0;
    return iw * ih;
  }

  // The rest time of a layer and its descendants: of REST_SAMPLES times across
  // their span, the one where the group's box has the most area inside the
  // frame (fw x fh); ties go to the time nearest the middle.
  function restTime(comp, root, desc, fw, fh) {
    var t0 = root.inPoint;
    if (t0 < 0) t0 = 0;
    var t1 = root.outPoint;
    for (var i = 0; i < desc.length; i++) {
      var d = desc[i];
      if (!hasVisuals(d)) continue;
      var s = d.inPoint;
      if (s < 0) s = 0;
      if (s < t0) t0 = s;
      if (d.outPoint > t1) t1 = d.outPoint;
    }
    if (t1 > comp.duration) t1 = comp.duration;
    t1 = t1 - comp.frameDuration;
    if (t1 < t0) t1 = t0;
    var mid = (t0 + t1) / 2;
    var best = mid;
    var bestArea = -1;
    var bestDist = 0;
    for (var k = 0; k < REST_SAMPLES; k++) {
      var t = t0 + (t1 - t0) * k / (REST_SAMPLES - 1);
      var box = groupBox(root, desc, t);
      if (!box) continue;
      var area = insideArea(box, fw, fh);
      var dist = Math.abs(t - mid);
      var take = false;
      if (bestArea < 0) {
        take = true;
      } else if (area > bestArea + 0.5) {
        take = true;
      } else if (area >= bestArea - 0.5 && dist < bestDist) {
        take = true;
      }
      if (take) {
        best = t;
        if (area > bestArea) bestArea = area;
        bestDist = dist;
      }
    }
    return best;
  }

  function isBackground(layer, box, w, h) {
    if (layer instanceof TextLayer) return false;
    var kind = false;
    try { if (layer.adjustmentLayer) kind = true; } catch (e1) {}
    try { if (layer.source instanceof FootageItem) kind = true; } catch (e2) {}
    try { if (layer instanceof ShapeLayer) kind = true; } catch (e3) {}
    if (!kind) return false;
    return box.left <= w * 0.02 && box.top <= h * 0.02 && box.right >= w * 0.98 && box.bottom >= h * 0.98;
  }

  // ---------- layer index maps ----------

  function parentIndexes(comp) {
    var out = [0];
    for (var i = 1; i <= comp.numLayers; i++) {
      var p = null;
      try { p = comp.layer(i).parent; } catch (e) { p = null; }
      if (p) {
        out.push(p.index);
      } else {
        out.push(0);
      }
    }
    return out;
  }

  function rootIndex(idx, parentIdx) {
    var cur = idx;
    var guard = 0;
    while (parentIdx[cur] && guard < 64) {
      cur = parentIdx[cur];
      guard++;
    }
    return cur;
  }

  function descendantsOf(comp, rootIdx, parentIdx) {
    var out = [];
    for (var j = 1; j <= comp.numLayers; j++) {
      if (j === rootIdx) continue;
      var cur = parentIdx[j];
      var guard = 0;
      while (cur && guard < 64) {
        if (cur === rootIdx) {
          out.push(comp.layer(j));
          break;
        }
        cur = parentIdx[cur];
        guard++;
      }
    }
    return out;
  }

  // out[m] = index of the target that uses unparented 2D layer m as its track
  // matte (0 when none). Uses trackMatteLayer (AE 23+), else the layer above.
  function matteMap(comp, parentIdx) {
    var n = comp.numLayers;
    var out = [];
    for (var z = 0; z <= n; z++) out.push(0);
    for (var i = 1; i <= n; i++) {
      var target = comp.layer(i);
      var has = false;
      try {
        has = target.trackMatteType !== TrackMatteType.NO_TRACK_MATTE;
      } catch (e0) {
        has = false;
      }
      if (!has) continue;
      var ml = null;
      try { ml = target.trackMatteLayer; } catch (e1) { ml = null; }
      var mIdx = 0;
      if (ml) {
        mIdx = ml.index;
      } else if (i > 1) {
        mIdx = i - 1;
      }
      if (!mIdx || mIdx === i) continue;
      if (parentIdx[mIdx]) continue;
      var m = comp.layer(mIdx);
      if (isCameraOrLight(m) || is3d(m) || !transformOf(m)) continue;
      if (out[mIdx] === 0) out[mIdx] = i;
    }
    return out;
  }

  // ---------- moving things ----------

  // Adds (dx, dy) to a position-like property, keys included.
  function shiftPosition(tr, dx, dy) {
    var pos = tr.property("ADBE Position");
    if (pos.dimensionsSeparated) {
      shiftScalar(tr.property("ADBE Position_0"), dx);
      shiftScalar(tr.property("ADBE Position_1"), dy);
      return;
    }
    shiftVector(pos, dx, dy);
  }

  function shiftScalar(p, d) {
    if (d === 0) return;
    if (p.numKeys === 0) {
      p.setValue(p.value + d);
      return;
    }
    for (var k = 1; k <= p.numKeys; k++) p.setValueAtKey(k, p.keyValue(k) + d);
  }

  function shifted(v, dx, dy) {
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(v[i]);
    out[0] += dx;
    out[1] += dy;
    return out;
  }

  function shiftVector(p, dx, dy) {
    if (dx === 0 && dy === 0) return;
    if (p.numKeys === 0) {
      p.setValue(shifted(p.value, dx, dy));
      return;
    }
    for (var k = 1; k <= p.numKeys; k++) p.setValueAtKey(k, shifted(p.keyValue(k), dx, dy));
  }

  function scaled(v, f) {
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(v[i] * f);
    return out;
  }

  function scaleBy(tr, f) {
    if (f === 1) return;
    var p = tr.property("ADBE Scale");
    if (p.numKeys === 0) {
      p.setValue(scaled(p.value, f));
      return;
    }
    for (var k = 1; k <= p.numKeys; k++) p.setValueAtKey(k, scaled(p.keyValue(k), f));
  }

  function hasExpression(p) {
    try { return p.expressionEnabled && p.expression !== ""; } catch (e) { return false; }
  }

  function zoneX(cx, s) {
    var third = (s.right - s.left) / 3;
    if (cx < s.left + third) return "left";
    if (cx > s.right - third) return "right";
    return "center";
  }

  function zoneY(cy, s) {
    var third = (s.bottom - s.top) / 3;
    if (cy < s.top + third) return "top";
    if (cy > s.bottom - third) return "bottom";
    return "middle";
  }

  // New start of a box of size `len` (already scaled by k) on one axis.
  function pinStart(zone, start, end, k, s0, s1, t0, t1) {
    var len = (end - start) * k;
    if (zone === "left" || zone === "top") return t0 + (start - s0) * k;
    if (zone === "right" || zone === "bottom") return t1 - (s1 - end) * k - len;
    var c = (start + end) / 2;
    return (t0 + t1) / 2 + (c - (s0 + s1) / 2) * k - len / 2;
  }

  function clampStart(start, len, lo, hi) {
    if (len > hi - lo) return start;
    if (start < lo) return lo;
    if (start + len > hi) return hi - len;
    return start;
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function relayout(comp, src, dst, opts) {
    var out = [];
    var n = comp.numLayers;
    var dcx = (dst.w - src.w) / 2;
    var dcy = (dst.h - src.h) / 2;
    var parentIdx = parentIndexes(comp);
    var matteOf = matteMap(comp, parentIdx);
    var done = [];
    var entries = [];
    var i;
    for (i = 0; i <= n; i++) {
      done.push(null);
      entries.push(null);
    }

    // First pass: every unparented layer except track mattes.
    for (i = 1; i <= n; i++) {
      var layer = comp.layer(i);
      var entry = { index: i, name: layer.name };
      entries[i] = entry;
      out.push(entry);
      if (parentIdx[i]) {
        entry.action = "follows parent \"" + comp.layer(parentIdx[i]).name + "\"";
        continue;
      }
      var tr = transformOf(layer);
      if (!tr || noPicture(layer)) {
        entry.action = "no picture: left as is";
        continue;
      }
      if (matteOf[i]) {
        entry.action = "matte: follows " + comp.layer(matteOf[i]).name;
        continue;
      }
      if (isCameraOrLight(layer) || is3d(layer)) {
        shiftPosition(tr, dcx, dcy);
        if (isCameraOrLight(layer)) {
          try { shiftVector(tr.property("ADBE Anchor Point"), dcx, dcy); } catch (e1) {}
        }
        entry.action = "3D: moved with the frame's centre";
        done[i] = { k: 1, dx: dcx, dy: dcy, px: 0, py: 0, t: 0 };
        continue;
      }
      if (hasExpression(tr.property("ADBE Position"))) {
        entry.note = "Position has an expression, which may override the move";
      }
      var desc = descendantsOf(comp, i, parentIdx);
      var t = restTime(comp, layer, desc, src.w, src.h);
      var own = layerBox(layer, t);
      if (!own) {
        entry.action = "unsupported: left as is";
        continue;
      }
      var pos = tr.property("ADBE Position").valueAtTime(t, false);
      var k = 1;
      var newLeft;
      var newTop;
      var box = own;
      if (!own.point && isBackground(layer, own, src.w, src.h)) {
        k = Math.max(dst.w / (own.right - own.left), dst.h / (own.bottom - own.top));
        if (k < 1) k = 1;
        newLeft = pinStart("center", own.left, own.right, k, 0, src.w, 0, dst.w);
        newTop = pinStart("middle", own.top, own.bottom, k, 0, src.h, 0, dst.h);
        entry.action = "background: scaled to cover";
      } else {
        box = groupBox(layer, desc, t);
        if (!box) box = own;
        var bw = box.right - box.left;
        var bh = box.bottom - box.top;
        var sw = dst.safe.right - dst.safe.left;
        var sh = dst.safe.bottom - dst.safe.top;
        if (!box.point && opts.shrink) {
          if (bw > sw) k = sw / bw;
          if (bh * k > sh) k = sh / bh;
        }
        var zx = zoneX((box.left + box.right) / 2, src.safe);
        var zy = zoneY((box.top + box.bottom) / 2, src.safe);
        newLeft = pinStart(zx, box.left, box.right, k, src.safe.left, src.safe.right, dst.safe.left, dst.safe.right);
        newTop = pinStart(zy, box.top, box.bottom, k, src.safe.top, src.safe.bottom, dst.safe.top, dst.safe.bottom);
        if (box.left >= 0 && box.right <= src.w) newLeft = clampStart(newLeft, bw * k, dst.safe.left, dst.safe.right);
        if (box.top >= 0 && box.bottom <= src.h) newTop = clampStart(newTop, bh * k, dst.safe.top, dst.safe.bottom);
        entry.action = "pinned " + zx + " " + zy;
        if (isNull(layer)) entry.action += " (controller null; its children move with it)";
        if (desc.length > 0) entry.group = desc.length + " layer(s) follow, measured together";
      }
      // Scaling happens about the layer's position, so the box's start moves
      // to pos + (start - pos) * k before the shift.
      var dx = newLeft - (pos[0] + (box.left - pos[0]) * k);
      var dy = newTop - (pos[1] + (box.top - pos[1]) * k);
      if (k !== 1) {
        scaleBy(tr, k);
        entry.scale_factor = Math.round(k * 1000) / 1000;
      }
      shiftPosition(tr, dx, dy);
      entry.moved = [round1(dx), round1(dy)];
      done[i] = { k: k, dx: dx, dy: dy, px: pos[0], py: pos[1], t: t };
    }

    // Second pass: track mattes follow the (root of their) target.
    for (i = 1; i <= n; i++) {
      var tIdx = matteOf[i];
      if (!tIdx || parentIdx[i]) continue;
      var me = entries[i];
      var mLayer = comp.layer(i);
      var mtr = transformOf(mLayer);
      var r = rootIndex(tIdx, parentIdx);
      var hops = 0;
      while (matteOf[r] && hops < 10) {
        r = rootIndex(matteOf[r], parentIdx);
        hops++;
      }
      var rr = null;
      if (!matteOf[r]) rr = done[r];
      if (!rr || !mtr) {
        me.action = "matte: left as is (its target did not move)";
        continue;
      }
      var mpos = mtr.property("ADBE Position").valueAtTime(rr.t, false);
      var mdx = rr.dx + (rr.px - mpos[0]) * (1 - rr.k);
      var mdy = rr.dy + (rr.py - mpos[1]) * (1 - rr.k);
      if (rr.k !== 1) {
        scaleBy(mtr, rr.k);
        me.scale_factor = Math.round(rr.k * 1000) / 1000;
      }
      shiftPosition(mtr, mdx, mdy);
      me.moved = [round1(mdx), round1(mdy)];
      me.action = "matte: follows " + comp.layer(tIdx).name;
    }
    return out;
  }

  function addGuide(comp, safe) {
    var layer = comp.layers.addShape();
    layer.name = GUIDE_NAME;
    layer.guideLayer = true;
    try { layer.label = 2; } catch (e0) {}
    var tr = layer.property("ADBE Transform Group");
    tr.property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
    var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
    group.name = "Safe area";
    var vectors = group.property("ADBE Vectors Group");
    var rect = vectors.addProperty("ADBE Vector Shape - Rect");
    rect.property("ADBE Vector Rect Size").setValue([safe.right - safe.left, safe.bottom - safe.top]);
    rect.property("ADBE Vector Rect Position").setValue([
      (safe.left + safe.right) / 2 - comp.width / 2,
      (safe.top + safe.bottom) / 2 - comp.height / 2
    ]);
    var stroke = vectors.addProperty("ADBE Vector Graphic - Stroke");
    stroke.property("ADBE Vector Stroke Color").setValue([1, 0.2, 0.6, 1]);
    stroke.property("ADBE Vector Stroke Width").setValue(Math.max(2, Math.round(comp.width / 540)));
    layer.moveToBeginning();
    return layer;
  }

  A.reframeComp = function (args) {
    assertGuard(args.expect);
    var source = requireComp(args.comp_id);
    var srcInfo = { w: source.width, h: source.height, safe: safeRect(source.width, source.height, args.source_margins) };
    return A.withUndo("Chroma AE MCP: reframe " + source.name, function () {
      var made = [];
      for (var i = 0; i < args.targets.length; i++) {
        var tg = args.targets[i];
        var comp = source.duplicate();
        comp.name = tg.name;
        comp.width = tg.width;
        comp.height = tg.height;
        var dst = { w: tg.width, h: tg.height, safe: safeRect(tg.width, tg.height, tg.margins) };
        var layers = relayout(comp, srcInfo, dst, { shrink: args.shrink });
        var guideId = null;
        if (args.guide) guideId = addGuide(comp, dst.safe).id;
        made.push({ comp_id: comp.id, name: comp.name, width: comp.width, height: comp.height, safe: dst.safe, guide_layer_id: guideId, layers: layers });
      }
      return { source: { comp_id: source.id, name: source.name, width: source.width, height: source.height }, comps: made };
    });
  };

  function outsideSafe(layer, index, box, safe, comp) {
    if (box.left < safe.left - 0.5 || box.top < safe.top - 0.5 || box.right > safe.right + 0.5 || box.bottom > safe.bottom + 0.5) {
      return {
        index: index,
        name: layer.name,
        box: { left: round1(box.left), top: round1(box.top), right: round1(box.right), bottom: round1(box.bottom) },
        off_frame: box.left < -0.5 || box.top < -0.5 || box.right > comp.width + 0.5 || box.bottom > comp.height + 0.5
      };
    }
    return null;
  }

  A.reframeReport = function (args) {
    var out = [];
    for (var c = 0; c < args.comps.length; c++) {
      var spec = args.comps[c];
      var comp = requireComp(spec.comp_id);
      var safe = spec.safe;
      var outside = [];
      var parentIdx = parentIndexes(comp);
      for (var i = 1; i <= comp.numLayers; i++) {
        if (parentIdx[i]) continue;
        var root = comp.layer(i);
        if (root.name === GUIDE_NAME) continue;
        if (isCameraOrLight(root) || is3d(root) || !transformOf(root) || noPicture(root)) continue;
        var desc = descendantsOf(comp, i, parentIdx);
        var t = restTime(comp, root, desc, comp.width, comp.height);
        var members = [root];
        for (var d = 0; d < desc.length; d++) members.push(desc[d]);
        for (var mI = 0; mI < members.length; mI++) {
          var layer = members[mI];
          if (!hasVisuals(layer)) continue;
          var on = true;
          try { on = layer.enabled; } catch (e0) { on = true; }
          if (!on) continue;
          if (mI > 0 && !activeAt(layer, t)) continue;
          var box = layerBox(layer, t);
          if (!box || box.point) continue;
          if (isBackground(layer, box, comp.width, comp.height)) continue;
          var hit = outsideSafe(layer, layer.index, box, safe, comp);
          if (hit) {
            if (mI > 0) hit.parent = layer.parent.name;
            outside.push(hit);
          }
        }
      }
      out.push({ comp_id: comp.id, name: comp.name, width: comp.width, height: comp.height, outside_safe: outside });
    }
    return { comps: out };
  };
})($.global);
