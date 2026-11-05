// panel/host/ext/patchcheck.jsx
//
// Host functions for the patch-check and region-stats tools (a patch, removal
// or insert measured against the plate under it):
// - patchcheckRead (read): the comp's timing and the layers asked for, if any (the patch
//   layers, or the layers to isolate), each with its flags and, at the given
//   times, whether it shows and its footprint as a quad in comp pixels. The pixel
//   work is done on the Node side.
// - patchcheckState (read): item counts, to prove the check left nothing behind
// - patchcheckBegin (guarded write): duplicate the comp and switch the listed
//   layers OFF in the COPY, in one undo group. The server renders the original
//   and the copy at the same times: the copy is the plate with the patch off.
// - patchcheckEnd (guarded write): remove that copy, in its own undo group
//
// A layer's footprint is its source rectangle through its transforms and parents.
// When the layer has Add-mode masks, their outline (the bezier curves sampled, through
// the same matrix) comes back too as mask_polygon, because that is the part of the
// layer that shows: a full-frame clean plate masked to a small area is that area.
//
// A Corner Pin or CC Power Pin on the layer moves the footprint (and the mask outline) to
// the pinned quad. Any other geometry effect (Transform, Motion Tile, warps) gives no
// footprint, with the reason, so the caller gives a region. A mask's expansion and
// feather come back as mask_expand_px and mask_feather_px (comp pixels).
//
// Not covered (said in the tool's notes): a footprint of a 3D layer or a layer
// parented to one (it depends on the camera), and effects other than the ones above.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - The read never changes time, selection, solo, resolution or the active item:
//   valueAtTime and sourceRectAtTime take a time and don't move the time indicator.
// - The writes check the guard first, validate before A.withUndo, and begin and
//   end their undo group in the same call. The read-back is a separate call.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 50;
  var MAX_TIMES = 120;
  var MAX_NAME = 200;
  var MAX_PARENT_DEPTH = 20;
  var MAX_MASKS = 20;
  // Points sampled along all masks of one layer, at most.
  var MAX_MASK_POINTS = 160;
  // The temporary comp carries this prefix; patchcheckEnd only ever removes a comp that does.
  var COPY_PREFIX = "chroma-patchcheck-copy ";

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

  function kindOf(l) {
    try {
      return String(l.reflect.name);
    } catch (e) {
      return "Layer";
    }
  }

  // ---------- the layer's footprint in comp pixels (2D only) ----------

  // The comp being read (set by patchcheckRead), for the pixel aspect.
  var readComp = null;

  // Source pixel aspect over the comp's pixel aspect; 1 when either is unknown.
  function pixelAspectRatio(l) {
    var r = 1;
    try {
      var sp = l.source ? l.source.pixelAspect : 0;
      var cp = readComp ? readComp.pixelAspect : 0;
      if (typeof sp === "number" && typeof cp === "number" && sp > 0 && cp > 0) r = sp / cp;
    } catch (e) {
      r = 1;
    }
    return r;
  }

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
    // Layer pixels are source pixels: a source whose pixel aspect differs from the comp's is stretched sideways.
    sx = sx * pixelAspectRatio(l);
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

  // Null when the layer or a parent is 3D (its footprint depends on the camera) or has no transform.
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

  // The four corners of a rect through the matrix: top-left, top-right, bottom-right, bottom-left.
  function quadOf(m, r) {
    var xs = [r.left, r.left + r.width, r.left + r.width, r.left];
    var ys = [r.top, r.top, r.top + r.height, r.top + r.height];
    var out = [];
    for (var i = 0; i < 4; i++) {
      out.push([round2(m[0] * xs[i] + m[1] * ys[i] + m[2]), round2(m[3] * xs[i] + m[4] * ys[i] + m[5])]);
    }
    return out;
  }

  // The mask's closed bezier path, sampled, in LAYER pixels (the caller maps them to the comp). Null for a shape with fewer than 2 vertices or an open path.
  function maskPoints(shape, steps) {
    var v = null;
    var it = null;
    var ot = null;
    var closed = true;
    try {
      v = shape.vertices;
      it = shape.inTangents;
      ot = shape.outTangents;
      closed = shape.closed !== false;
    } catch (e0) {
      return null;
    }
    // An open path does not cut transparency in AE; it is only a path for strokes and the like.
    if (!closed) return null;
    var n = v ? v.length : 0;
    if (n < 2) return null;
    var pts = [];
    var i;
    var k;
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var p0 = v[i];
      var p3 = v[j];
      var o0 = ot && ot[i] ? ot[i] : [0, 0];
      var i3 = it && it[j] ? it[j] : [0, 0];
      var x1 = p0[0] + o0[0];
      var y1 = p0[1] + o0[1];
      var x2 = p3[0] + i3[0];
      var y2 = p3[1] + i3[1];
      for (k = 0; k < steps; k++) {
        var u = k / steps;
        var w = 1 - u;
        var b0 = w * w * w;
        var b1 = 3 * w * w * u;
        var b2 = 3 * w * u * u;
        var b3 = u * u * u;
        pts.push([b0 * p0[0] + b1 * x1 + b2 * x2 + b3 * p3[0], b0 * p0[1] + b1 * y1 + b2 * y2 + b3 * p3[1]]);
      }
    }
    return pts;
  }

  // At most max points (every k-th).
  function thin(pts, max) {
    if (pts.length <= max) return pts;
    var stepK = Math.ceil(pts.length / max);
    var out = [];
    for (var i = 0; i < pts.length; i += stepK) out.push(pts[i]);
    return out;
  }

  // Unit square (0,0) (1,0) (1,1) (0,1) to the quad q (4 points in that order): [a, b, c, d, e, f, g, h]. Null when degenerate.
  function squareToQuad(q) {
    var x0 = q[0][0];
    var y0 = q[0][1];
    var x1 = q[1][0];
    var y1 = q[1][1];
    var x2 = q[2][0];
    var y2 = q[2][1];
    var x3 = q[3][0];
    var y3 = q[3][1];
    var dx1 = x1 - x2;
    var dx2 = x3 - x2;
    var dx3 = x0 - x1 + x2 - x3;
    var dy1 = y1 - y2;
    var dy2 = y3 - y2;
    var dy3 = y0 - y1 + y2 - y3;
    if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
      return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
    }
    var den = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(den) < 1e-12) return null;
    var g = (dx3 * dy2 - dy3 * dx2) / den;
    var h = (dx1 * dy3 - dy1 * dx3) / den;
    return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
  }

  function quadAreaAbs(q) {
    var a = 0;
    for (var i = 0; i < 4; i++) {
      var j = (i + 1) % 4;
      a += q[i][0] * q[j][1] - q[j][0] * q[i][1];
    }
    return Math.abs(a) / 2;
  }

  // A layer-space point to comp pixels: through the pin warp (when there is one), then the matrix m.
  function mapPoint(m, pin, x, y) {
    var px = x;
    var py = y;
    if (pin) {
      var u = (x - pin.rect.left) / pin.rect.width;
      var v = (y - pin.rect.top) / pin.rect.height;
      var hh = pin.h;
      var den = hh[6] * u + hh[7] * v + 1;
      if (Math.abs(den) < 1e-9) den = 1e-9;
      px = (hh[0] * u + hh[1] * v + hh[2]) / den;
      py = (hh[3] * u + hh[4] * v + hh[5]) / den;
    }
    return [round2(m[0] * px + m[1] * py + m[2]), round2(m[3] * px + m[4] * py + m[5])];
  }

  // The outline of the layer's Add-mode masks at time t in comp pixels: one mask gives its curve, several give the bounding box of all.
  // { polygon, expand_px, feather_px }, or null when the layer has no usable mask (none, only other modes, an inverted or open one, or the paths could not be read).
  // pin: { rect, h, area_ratio } when a Corner Pin warps the layer after the masks.
  function maskPolygonAt(l, m, t, pin) {
    var mp = child(l, "ADBE Mask Parade");
    if (!mp) return null;
    var count = 0;
    try {
      count = mp.numProperties;
    } catch (e0) {
      count = 0;
    }
    if (count > MAX_MASKS) count = MAX_MASKS;
    var all = [];
    var hull = [];
    var steps = 8;
    var exps = [];
    var feather = 0;
    var i;
    for (i = 1; i <= count; i++) {
      var mk = null;
      try {
        mk = mp.property(i);
      } catch (e1) {
        mk = null;
      }
      if (!mk) continue;
      try {
        if (typeof MaskMode !== "undefined" && mk.maskMode !== MaskMode.ADD) continue;
        if (mk.inverted === true) return null;
      } catch (e2) {
        continue;
      }
      var shape = valueAt(child(mk, "ADBE Mask Shape"), t);
      if (!shape) continue;
      var nv = 0;
      try {
        nv = shape.vertices.length;
      } catch (e3) {
        nv = 0;
      }
      if (nv > 0) steps = Math.max(1, Math.min(8, Math.floor(MAX_MASK_POINTS / nv / Math.max(1, count))));
      var pts = maskPoints(shape, steps);
      if (pts) {
        all.push(pts);
        hull = hull.concat(pts);
        var ex = num(valueAt(child(mk, "ADBE Mask Offset"), t), 0);
        var fe = valueAt(child(mk, "ADBE Mask Feather"), t);
        var fv = 0;
        if (fe && typeof fe.length === "number") fv = Math.max(num(fe[0], 0), num(fe[1], 0));
        else fv = num(fe, 0);
        exps.push(ex);
        if (fv > feather) feather = fv;
      }
    }
    if (all.length === 0) return null;
    // One mask keeps its signed expansion (a negative one chokes it); the bounding box of several grows by the largest, never shrinks.
    var expand = 0;
    if (exps.length === 1) expand = exps[0];
    else {
      for (i = 0; i < exps.length; i++) if (exps[i] > expand) expand = exps[i];
    }
    // Layer pixels to comp pixels: the matrix' scale, and the pin's area change.
    var sc = Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3]));
    if (pin) sc = sc * pin.area_ratio;
    var out = { polygon: null, expand_px: round2(expand * sc), feather_px: round2(feather * sc) };
    var k;
    if (all.length === 1) {
      var one = thin(all[0], MAX_MASK_POINTS);
      var poly = [];
      for (k = 0; k < one.length; k++) poly.push(mapPoint(m, pin, one[k][0], one[k][1]));
      out.polygon = poly;
      return out;
    }
    var x0 = null;
    var y0 = null;
    var x1b = null;
    var y1b = null;
    for (i = 0; i < hull.length; i++) {
      var q = mapPoint(m, pin, hull[i][0], hull[i][1]);
      if (x0 === null) {
        x0 = q[0];
        x1b = q[0];
        y0 = q[1];
        y1b = q[1];
      }
      if (q[0] < x0) x0 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[0] > x1b) x1b = q[0];
      if (q[1] > y1b) y1b = q[1];
    }
    out.polygon = [[x0, y0], [x1b, y0], [x1b, y1b], [x0, y1b]];
    return out;
  }

  // Geometry effects. The pins are handled; the others make the footprint unknown.
  var OTHER_GEOMETRY = {
    "ADBE Geometry2": "Transform",
    "ADBE Tile": "Motion Tile",
    "ADBE MESH WARP": "Mesh Warp",
    "ADBE BEZMESH": "Bezier Warp",
    "ADBE Offset": "Offset",
    "ADBE Mirror": "Mirror",
    "CC Tiler": "CC Tiler"
  };

  // Display names of the four points, in the order UL, UR, LL, LR.
  var CORNER_PIN_NAMES = ["Upper Left", "Upper Right", "Lower Left", "Lower Right"];
  var POWER_PIN_NAMES = ["Top Left", "Top Right", "Bottom Left", "Bottom Right"];

  // The enabled geometry effects of a layer: { pin: [UL, UR, LR, LL] in layer pixels or null, other: name or null, count }.
  function geometryEffects(l, t) {
    var res = { pin: null, other: null, count: 0 };
    var parade = child(l, "ADBE Effect Parade");
    if (!parade) return res;
    var n = 0;
    try {
      n = parade.numProperties;
    } catch (e0) {
      n = 0;
    }
    for (var i = 1; i <= n && i <= 50; i++) {
      var fx = null;
      var mn = "";
      try {
        fx = parade.property(i);
        mn = String(fx.matchName);
        if (fx.enabled === false) continue;
      } catch (e1) {
        continue;
      }
      var isPin = mn === "ADBE Corner Pin" || mn === "CC Power Pin";
      if (!isPin && OTHER_GEOMETRY[mn] === undefined) continue;
      res.count++;
      if (!isPin) {
        if (res.other === null) res.other = OTHER_GEOMETRY[mn];
        continue;
      }
      var pts = [];
      var ok = true;
      var pinNames = mn === "ADBE Corner Pin" ? CORNER_PIN_NAMES : POWER_PIN_NAMES;
      for (var r = 0; r < 4; r++) {
        // Same order as ae_track_apply (planar.jsx pinParams): match name (Corner Pin), display name, then position.
        var prop = null;
        if (mn === "ADBE Corner Pin") prop = child(fx, "ADBE Corner Pin-000" + (r + 1));
        if (!prop) prop = child(fx, pinNames[r]);
        if (!prop) {
          try {
            prop = fx.property(r + 1);
          } catch (e2) {
            prop = null;
          }
        }
        var v = valueAt(prop, t);
        if (!v || typeof v.length !== "number" || v.length < 2 || typeof v[0] !== "number" || typeof v[1] !== "number") {
          ok = false;
          break;
        }
        pts.push([v[0], v[1]]);
      }
      if (!ok) {
        if (res.other === null) res.other = "pin (its points could not be read)";
        continue;
      }
      // AE order is UL, UR, LL, LR; the quad goes round: UL, UR, LR, LL.
      res.pin = [pts[0], pts[1], pts[3], pts[2]];
    }
    return res;
  }

  function hasSoloVideoLayer(c) {
    var n = c.numLayers;
    for (var i = 1; i <= n; i++) {
      try {
        var sl = c.layer(i);
        if (sl.solo !== true) continue;
        var rn = kindOf(sl);
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

  function footprintAt(l, t, soloAny) {
    var s = { time: t, visible: false, polygon: null, reason: null };
    var tr = child(l, "ADBE Transform Group");
    var op = valueAt(child(tr, "ADBE Opacity"), t);
    var opacity = op === null ? null : num(op, null);
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
    } catch (e3) {}
    s.visible = on && inRange && soloOk && !guide && (opacity === null || opacity > 0);
    if (!on) s.reason = "the layer's video switch is off";
    else if (!inRange) s.reason = "the time is outside the layer's in and out points";
    else if (guide) s.reason = "the layer is a guide layer (not rendered)";
    else if (opacity !== null && opacity <= 0) s.reason = "the layer's opacity is 0";
    else if (!soloOk) s.reason = "another layer is soloed";
    var m = compMatrix(l, t);
    if (m === null) {
      if (s.reason === null) s.reason = "3D layer, or parented to one: its footprint depends on the camera";
      return s;
    }
    var r = null;
    try {
      r = l.sourceRectAtTime(t, false);
    } catch (e4) {
      if (s.reason === null) s.reason = "sourceRectAtTime failed: " + String(e4.message || e4);
      return s;
    }
    if (!r || !(r.width > 0) || !(r.height > 0)) {
      if (s.reason === null) s.reason = "the layer has no area at this time";
      return s;
    }
    var geo = geometryEffects(l, t);
    if (geo.other !== null || geo.count > 1) {
      if (s.reason === null) {
        if (geo.other !== null) s.reason = "the layer has a " + geo.other + " effect that moves or warps it: give region";
        else s.reason = "the layer has more than one pin effect: give region";
      }
      return s;
    }
    var pin = null;
    if (geo.pin) {
      var hm = squareToQuad(geo.pin);
      if (!hm) {
        if (s.reason === null) s.reason = "the layer's pin points are degenerate: give region";
        return s;
      }
      // A pin maps the layer's own rectangle (0, 0, width, height), not the content box sourceRectAtTime gives for text and shape layers.
      var pr = r;
      var lw = 0;
      var lh = 0;
      try {
        lw = l.width;
        lh = l.height;
      } catch (e6) {}
      if (typeof lw === "number" && typeof lh === "number" && lw > 0 && lh > 0) pr = { left: 0, top: 0, width: lw, height: lh };
      pin = { rect: pr, h: hm, area_ratio: Math.sqrt(quadAreaAbs(geo.pin) / (pr.width * pr.height)) };
      s.polygon = [];
      for (var pi = 0; pi < 4; pi++) s.polygon.push(mapPoint(m, null, geo.pin[pi][0], geo.pin[pi][1]));
    } else {
      s.polygon = quadOf(m, r);
    }
    var mask = null;
    try {
      mask = maskPolygonAt(l, m, t, pin);
    } catch (e5) {
      mask = null;
    }
    if (mask && mask.polygon) {
      s.mask_polygon = mask.polygon;
      if (mask.expand_px !== 0) s.mask_expand_px = mask.expand_px;
      if (mask.feather_px > 0) s.mask_feather_px = mask.feather_px;
    }
    return s;
  }

  function clampTime(c, t) {
    var last = c.duration - c.frameDuration;
    if (last < 0) last = 0;
    if (t > last) t = last;
    if (t < 0) t = 0;
    return t;
  }

  // args: { comp_id, layers: [selector], times? }. Without times only the comp and the
  // layers' flags come back (the server plans its sample times from the comp's timing first).
  A.patchcheckRead = function (args) {
    var c = requireComp(args.comp_id);
    readComp = c;
    var i;
    var sel = args.layers;
    // Without `layers` only the comp's timing comes back; an empty list is a mistake.
    if (sel === undefined || sel === null) sel = [];
    else if (sel.length === 0) fail("bad_args", "Give at least one layer, or leave layers out");
    if (sel.length > MAX_LAYERS) fail("bad_args", "At most " + MAX_LAYERS + " layers per call");
    var picked = [];
    var seen = {};
    for (i = 0; i < sel.length; i++) {
      var pick = findLayer(c, sel[i]);
      if (seen[pick.id] === true) fail("bad_args", "Layer " + pick.index + " \"" + pick.name + "\" is listed twice");
      seen[pick.id] = true;
      picked.push(pick);
    }

    var times = null;
    var raw = args.times;
    if (raw !== undefined && raw !== null) {
      if (raw.length > MAX_TIMES) fail("bad_args", "At most " + MAX_TIMES + " times per call");
      times = [];
      for (i = 0; i < raw.length; i++) {
        if (typeof raw[i] !== "number" || raw[i] !== raw[i] || raw[i] < 0) fail("bad_args", "times must be numbers of seconds, 0 or more");
        times.push(clampTime(c, raw[i]));
      }
    }

    var soloAny = hasSoloVideoLayer(c);
    var layers = [];
    for (i = 0; i < picked.length; i++) {
      var l = picked[i];
      var name = String(l.name);
      if (name.length > MAX_NAME) name = name.substring(0, MAX_NAME);
      var parentId = null;
      try {
        if (l.parent) parentId = l.parent.id;
      } catch (e0) {}
      var entry = {
        index: l.index,
        id: l.id,
        name: name,
        kind: kindOf(l),
        enabled: l.enabled === true,
        locked: l.locked === true,
        guide: l.guideLayer === true,
        three_d: l.threeDLayer === true,
        in_point: l.inPoint,
        out_point: l.outPoint,
        parent_id: parentId,
        footprints: []
      };
      if (times !== null) {
        for (var k = 0; k < times.length; k++) entry.footprints.push(footprintAt(l, times[k], soloAny));
      }
      layers.push(entry);
    }

    var res = null;
    try {
      res = [c.resolutionFactor[0], c.resolutionFactor[1]];
    } catch (e1) {}
    var linear = null;
    try {
      linear = app.project.linearBlending === true;
    } catch (e2) {}
    return {
      comp: {
        id: c.id,
        name: String(c.name),
        width: c.width,
        height: c.height,
        duration: c.duration,
        frame_duration: c.frameDuration,
        frame_rate: c.frameRate,
        work_area_start: c.workAreaStart,
        work_area_duration: c.workAreaDuration,
        pixel_aspect: c.pixelAspect,
        resolution_factor: res
      },
      linear_blending: linear,
      solo_active: soloAny,
      times: times,
      layers: layers,
      total_layers: c.numLayers
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

  // args (optional): { comp_id, layer_ids }. With them the state also lists whether
  // each of those layers is switched on in the ORIGINAL comp, so the receipt can show
  // the check did not touch the original's patch layers.
  A.patchcheckState = function (args) {
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
        for (k = 0; k < args.layer_ids.length && k < MAX_LAYERS; k++) want[String(args.layer_ids[k])] = true;
        for (k = 1; k <= comp.numLayers; k++) {
          var l = comp.layer(k);
          if (want[String(l.id)] === true) layers.push({ id: l.id, enabled: l.enabled === true });
        }
      }
      st.layers = layers;
    }
    return st;
  };

  // args: { comp_id, layers: [{ index, id, name }], expect }. The listed layers are
  // switched off in a duplicate of the comp. A duplicated comp's layers get new ids
  // but keep their indexes, so the copy is addressed by index.
  A.patchcheckBegin = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var want = args.layers;
    var i;
    // Everything that can fail is checked here, before the duplicate exists.
    if (!want || want.length === 0) fail("bad_args", "No layers to switch off");
    if (want.length > MAX_LAYERS) fail("bad_args", "At most " + MAX_LAYERS + " layers per call");
    var seen = {};
    for (i = 0; i < want.length; i++) {
      var w = want[i];
      if (!w || typeof w.index !== "number" || typeof w.id !== "number") fail("bad_args", "Each layer needs an index and an id");
      if (seen[w.index] === true) fail("bad_args", "Layer index " + w.index + " is listed twice");
      seen[w.index] = true;
      if (w.index < 1 || w.index > comp.numLayers) fail("not_found", "Layer index " + w.index + " out of range");
      var l = comp.layer(w.index);
      if (l.id !== w.id) fail("guard", "Layer " + w.index + " is not the layer read earlier (id " + w.id + "); the stack changed. Re-read and retry.");
    }
    var before = projectState();
    var made = A.withUndo("Chroma AE MCP: patch check (copy)", function () {
      var copy = comp.duplicate();
      try {
        copy.name = COPY_PREFIX + comp.name;
        var off = 0;
        for (var k = 0; k < want.length; k++) {
          var cl = copy.layer(want[k].index);
          if (!cl || cl.name !== comp.layer(want[k].index).name) {
            fail("not_found", "The copy's layer " + want[k].index + " is not the layer it should be");
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
  A.patchcheckEnd = function (args) {
    assertGuard(args.expect);
    var item = null;
    try {
      item = app.project.itemByID(args.copy_id);
    } catch (e) {
      item = null;
    }
    if (!item) return { removed: false, already_gone: true, copy_id: args.copy_id };
    if (!(item instanceof CompItem) || String(item.name).indexOf(COPY_PREFIX) !== 0) {
      fail("guard", "Refused: item " + args.copy_id + " is not a patch-check copy, so it was not removed.");
    }
    A.withUndo("Chroma AE MCP: patch check (remove copy)", function () {
      item.remove();
    });
    return { removed: true, copy_id: args.copy_id };
  };
})($.global);
