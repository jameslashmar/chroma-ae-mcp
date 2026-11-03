// panel/host/ext/explain.jsx
//
// Host functions for the explain tools ("why isn't this layer showing?"):
// - explainLayer (read): a layer at a time, or a pixel on the frame, checked
//   against every DOM-visible cause of "not shown" or "looks wrong", as a list
//   of findings with evidence. Looks into the precomp a layer plays. Reads
//   only: valueAtTime and sourceRectAtTime don't move the time indicator.
// - explainProofState (read): item counts, to prove the proof left nothing behind
// - explainProofBegin (guarded write): duplicate the comp and undo the suspect
//   in the COPY (top-level layers only; a duplicated comp shares its nested
//   precomps with the original), in one undo group
// - explainProofEnd (guarded write): remove that copy, in its own undo group
//
// What AE can't tell the DOM, and so is not checked (and said so in `limits`):
// - A parent's opacity: AE parenting passes transform, not opacity.
// - A camera clipping plane: AE cameras have none. Only "behind the camera" is
//   worked out here, with our own vector maths.
// - Effects that fail or whose plug-in is missing: only the effect switches and
//   expressionError are readable.
// - Shy: it only hides a layer in the Timeline panel, so it is reported as info.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - The reads never change time, selection, solo, resolution or the active item.
// - The writes check the guard first, validate before A.withUndo, and begin and
//   end their undo group in the same call. The read-back is a separate call.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var MAX_MASKS = 50;
  var MAX_EFFECTS = 100;
  var MAX_PARENT_DEPTH = 20;
  var MAX_EXPR_ERRORS = 20;
  var MAX_VISITED = 5000;
  var MAX_PROP_DEPTH = 10;
  var MAX_INNER = 50;
  var MAX_ABOVE_LIST = 10;
  var MAX_TEXT = 300;
  // The temporary comp of the pixel proof carries this prefix; explainProofEnd
  // only ever removes a comp that does.
  var PROOF_PREFIX = "chroma-explain-proof ";

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

  // ---------- small readers (all null-safe, none changes anything) ----------

  function prop(group, name) {
    try {
      if (!group) return null;
      return group.property(name);
    } catch (e) {
      return null;
    }
  }

  function valueAt(p, t) {
    try {
      if (!p) return null;
      return p.valueAtTime(t, false);
    } catch (e) {
      return null;
    }
  }

  function clip(s, n) {
    var str = String(s);
    var max = n || MAX_TEXT;
    if (str.length > max) return str.substring(0, max) + " ...[truncated]";
    return str;
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  // AE's enum objects expose no enumerable keys, so names come from explicit
  // key lists and values are compared against the constants directly.
  var BLEND_KEYS = [
    "NORMAL", "DISSOLVE", "DANCING_DISSOLVE", "DARKEN", "MULTIPLY", "COLOR_BURN", "CLASSIC_COLOR_BURN",
    "LINEAR_BURN", "DARKER_COLOR", "ADD", "LIGHTEN", "SCREEN", "COLOR_DODGE", "CLASSIC_COLOR_DODGE",
    "LINEAR_DODGE", "LIGHTER_COLOR", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "LINEAR_LIGHT", "VIVID_LIGHT",
    "PIN_LIGHT", "HARD_MIX", "DIFFERENCE", "CLASSIC_DIFFERENCE", "EXCLUSION", "SUBTRACT", "DIVIDE", "HUE",
    "SATURATION", "COLOR", "LUMINOSITY", "STENCIL_ALPHA", "STENCIL_LUMA", "SILHOUETE_ALPHA",
    "SILHOUETTE_ALPHA", "SILHOUETTE_LUMA", "ALPHA_ADD", "LUMINESCENT_PREMUL"
  ];
  var MATTE_KEYS = ["NO_TRACK_MATTE", "ALPHA", "ALPHA_INVERTED", "LUMA", "LUMA_INVERTED"];
  var MASK_KEYS = ["NONE", "ADD", "SUBTRACT", "INTERSECT", "LIGHTEN", "DARKEN", "DIFFERENCE"];
  var STENCIL_KEYS = ["STENCIL_ALPHA", "STENCIL_LUMA", "SILHOUETE_ALPHA", "SILHOUETTE_ALPHA", "SILHOUETTE_LUMA"];
  var INVERTED_MATTE_KEYS = ["ALPHA_INVERTED", "LUMA_INVERTED"];

  // The name of an AE enum value ("NORMAL" for BlendingMode.NORMAL), looked up by key.
  function enumName(E, keys, v) {
    if (E === undefined || E === null) return String(v);
    for (var i = 0; i < keys.length; i++) {
      if (E[keys[i]] !== undefined && E[keys[i]] === v) return keys[i];
    }
    return String(v);
  }

  function enumIn(E, keys, v) {
    if (E === undefined || E === null || v === undefined) return false;
    for (var i = 0; i < keys.length; i++) {
      if (E[keys[i]] !== undefined && E[keys[i]] === v) return true;
    }
    return false;
  }

  function blendEnum() {
    return typeof BlendingMode === "undefined" ? undefined : BlendingMode;
  }

  function maskEnum() {
    return typeof MaskMode === "undefined" ? undefined : MaskMode;
  }

  function matteEnum() {
    return typeof TrackMatteType === "undefined" ? undefined : TrackMatteType;
  }

  function reflectName(l) {
    try {
      if (l.reflect && l.reflect.name) return String(l.reflect.name);
    } catch (e) {}
    return "";
  }

  function layerKind(l) {
    var r = reflectName(l);
    if (r === "TextLayer") return "text";
    if (r === "ShapeLayer") return "shape";
    if (r === "CameraLayer") return "camera";
    if (r === "LightLayer") return "light";
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
    return "footage";
  }

  function ref(l) {
    return { index: l.index, id: l.id, name: l.name };
  }

  function opacityOf(l, t) {
    var tr = prop(l, "ADBE Transform Group");
    var v = valueAt(prop(tr, "ADBE Opacity"), t);
    if (typeof v === "number") return v;
    return null;
  }

  function isTrue(fn) {
    try {
      return fn() === true;
    } catch (e) {
      return false;
    }
  }

  // ---------- 2D geometry (a copy of the maths behind ae_check_layer_bounds) ----------

  function localMatrix(l, t) {
    var tr = prop(l, "ADBE Transform Group");
    var an = valueAt(prop(tr, "ADBE Anchor Point"), t);
    var po = valueAt(prop(tr, "ADBE Position"), t);
    var sc = valueAt(prop(tr, "ADBE Scale"), t);
    var ro = valueAt(prop(tr, "ADBE Rotate Z"), t);
    if (!an || !po || !sc || ro === null) return null;
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

  // Null when a layer in the parent chain is 3D (its box depends on the camera)
  // or a transform can't be read.
  function compMatrix(l, t) {
    var m = null;
    var cur = l;
    for (var depth = 0; cur && depth < MAX_PARENT_DEPTH; depth++) {
      if (cur.threeDLayer === true) return null;
      var local = localMatrix(cur, t);
      if (local === null) return null;
      if (m === null) m = local;
      else m = compose(local, m);
      cur = cur.parent;
    }
    return m;
  }

  // [minX, minY, maxX, maxY] of the layer's source rect in comp space, or null.
  // axisAligned is true when the box is exact (no rotation or skew).
  function boundsAt(l, t) {
    var m = compMatrix(l, t);
    if (m === null) return null;
    var r = null;
    try {
      r = l.sourceRectAtTime(t, false);
    } catch (e) {
      return null;
    }
    if (!r) return null;
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
    return {
      rect: [round(minX), round(minY), round(maxX), round(maxY)],
      empty: r.width === 0 || r.height === 0,
      axisAligned: Math.abs(m[1]) < 1e-6 && Math.abs(m[3]) < 1e-6
    };
  }

  // ---------- comp scan and quick reasons ----------

  // Which layers are soloed, and whether the list was cut short.
  function scanComp(comp) {
    var out = { soloAny: false, soloLayers: [], truncated: false };
    var n = comp.numLayers;
    if (n > MAX_LAYERS) {
      n = MAX_LAYERS;
      out.truncated = true;
    }
    for (var i = 1; i <= n; i++) {
      var l = comp.layer(i);
      if (isTrue(function () { return l.solo; })) {
        out.soloAny = true;
        if (out.soloLayers.length < MAX_ABOVE_LIST) out.soloLayers.push(ref(l));
      }
    }
    return out;
  }

  // The plain reasons a layer renders nothing at t, as short strings. Used for
  // the layers inside a precomp and for the layers at a point.
  function quickReasons(l, t, scan) {
    var out = [];
    var kind = layerKind(l);
    if (kind === "camera" || kind === "light") out.push(kind + " layers render no picture");
    if (kind === "null") out.push("null layers render nothing");
    if (kind === "audio" || l.hasVideo === false) out.push("no video");
    if (l.enabled === false) out.push("video switch off");
    if (scan && scan.soloAny && l.solo !== true) out.push("another layer is soloed");
    if (t < l.inPoint || t >= l.outPoint) out.push("outside its in and out points");
    if (isTrue(function () { return l.guideLayer; })) out.push("guide layer (not in the render)");
    var op = opacityOf(l, t);
    if (op !== null && op === 0) out.push("opacity 0");
    return out;
  }

  // ---------- findings ----------

  // severity: blocks (it cannot show), likely, possible, info.
  // order ranks within a severity; the server sorts on both.
  function add(list, id, severity, order, title, detail, evidence) {
    var f = { id: id, severity: severity, order: order, title: title, detail: detail };
    if (evidence !== undefined) f.evidence = evidence;
    list.push(f);
  }

  // Effects and expressions: the effect switches, and every expression that
  // errors when evaluated at t (valueAtTime first, then expressionError).
  function walkExpressions(group, path, depth, t, state) {
    if (!group || depth > MAX_PROP_DEPTH) return;
    var n = 0;
    try {
      n = group.numProperties;
    } catch (e) {
      return;
    }
    for (var i = 1; i <= n; i++) {
      if (state.visited >= MAX_VISITED) {
        state.truncated = true;
        return;
      }
      state.visited++;
      var p = prop(group, i);
      if (!p) continue;
      var name = "";
      try {
        name = String(p.name);
      } catch (e1) {}
      var here = path ? path + " > " + name : name;
      var isProp = false;
      try {
        isProp = p.propertyType === PropertyType.PROPERTY;
      } catch (e2) {}
      if (!isProp) {
        walkExpressions(p, here, depth + 1, t, state);
        continue;
      }
      var expr = "";
      try {
        expr = p.canSetExpression ? String(p.expression) : "";
      } catch (e3) {
        expr = "";
      }
      if (expr === "") continue;
      state.expressions++;
      var enabled = true;
      try {
        enabled = p.expressionEnabled !== false;
      } catch (e4) {}
      if (!enabled) continue;
      try {
        p.valueAtTime(t, false);
      } catch (e5) {}
      var err = "";
      try {
        err = p.expressionError ? String(p.expressionError) : "";
      } catch (e6) {}
      if (err !== "") {
        if (state.errors.length < MAX_EXPR_ERRORS) {
          state.errors.push({ path: here, error: clip(err), expression: clip(expr) });
        } else {
          state.errorsTruncated = true;
        }
      }
    }
  }

  function isStencilOrSilhouette(mode) {
    return enumIn(blendEnum(), STENCIL_KEYS, mode);
  }

  // Camera facts at t: position and the direction it looks along, or why not.
  function cameraForward(cam, t) {
    var tr = prop(cam, "ADBE Transform Group");
    var pos = valueAt(prop(tr, "ADBE Position"), t);
    if (!pos || pos.length < 3) return { ok: false, reason: "the camera's position can't be read" };
    var camParent = null;
    try {
      camParent = cam.parent;
    } catch (eP) {
      camParent = null;
    }
    if (camParent) return { ok: false, reason: "the camera has a parent, so its world position is not worked out" };
    // Orientation and X/Y/Z rotation turn the view, whatever the camera's nodes.
    var turn = ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z"];
    for (var ti = 0; ti < turn.length; ti++) {
      var tv = valueAt(prop(tr, turn[ti]), t);
      if (tv === null) continue;
      var tparts = typeof tv === "number" ? [tv] : tv;
      for (var tk = 0; tk < tparts.length; tk++) {
        if (tparts[tk] !== 0) return { ok: false, reason: "the camera has orientation or rotation, so its view direction is not worked out" };
      }
    }
    var poi = prop(tr, "ADBE Point of Interest");
    var twoNode = false;
    if (typeof AutoOrientType !== "undefined") {
      try {
        twoNode = cam.autoOrient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
      } catch (e) {}
    } else {
      twoNode = poi !== null;
    }
    if (twoNode) {
      var pv = valueAt(poi, t);
      if (!pv || pv.length < 3) return { ok: false, reason: "the camera's point of interest can't be read" };
      var f = [pv[0] - pos[0], pv[1] - pos[1], pv[2] - pos[2]];
      if (f[0] === 0 && f[1] === 0 && f[2] === 0) return { ok: false, reason: "the camera sits on its point of interest" };
      return { ok: true, position: pos, forward: f, nodes: 2 };
    }
    // One-node camera: it looks down +Z unless it is rotated. Rotated cameras
    // are not worked out (the rotation order is not measured), so say so.
    var names = ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z"];
    for (var i = 0; i < names.length; i++) {
      var v = valueAt(prop(tr, names[i]), t);
      if (v === null) continue;
      var parts = typeof v === "number" ? [v] : v;
      for (var k = 0; k < parts.length; k++) {
        if (parts[k] !== 0) return { ok: false, reason: "a one-node camera with rotation or orientation: its direction is not worked out" };
      }
    }
    return { ok: true, position: pos, forward: [0, 0, 1], nodes: 1 };
  }

  // ---------- explain one layer ----------

  function explainOne(comp, l, t, scan, opts) {
    var findings = [];
    var facts = {};
    var unchecked = [];
    var kind = layerKind(l);
    var i;
    var m;

    facts.kind = kind;
    facts.enabled = l.enabled === true;
    facts.solo = isTrue(function () { return l.solo; });
    facts.shy = isTrue(function () { return l.shy; });
    facts.in_point = l.inPoint;
    facts.out_point = l.outPoint;
    facts.three_d = isTrue(function () { return l.threeDLayer; });
    facts.parent = null;
    try {
      if (l.parent) facts.parent = ref(l.parent);
    } catch (eP) {}
    var activeNow = null;
    try {
      activeNow = l.activeAtTime(t);
    } catch (eA) {
      activeNow = null;
    }
    // activeAtTime = enabled, no other solo, and between in and out (documented).
    facts.active_at_time = activeNow;

    // Layers that draw nothing, whatever their settings.
    if (kind === "camera" || kind === "light") {
      add(findings, "no_picture", "blocks", 5, "A " + kind + " layer renders no picture of its own", "Cameras and lights shape how other layers look; they are never visible themselves.");
    } else if (kind === "null") {
      add(findings, "null_layer", "blocks", 5, "A null layer renders nothing", "Null layers are controllers: give them a parent role, they never show in the frame.");
    }
    if (kind === "audio" || l.hasVideo === false) {
      add(findings, "audio_only", "blocks", 6, "The layer has no video", "hasVideo is false: only its audio plays.");
    }

    // 1. The video switch.
    if (l.enabled === false) {
      add(findings, "disabled", "blocks", 10, "The layer's video switch (eyeball) is off", "layer.enabled is false.", { enabled: false });
    }
    // 2. In and out points.
    if (t < l.inPoint || t >= l.outPoint) {
      add(
        findings,
        "outside_in_out",
        "blocks",
        20,
        "The time is outside the layer's in and out points",
        "The layer is on the timeline from " + round(l.inPoint) + "s to " + round(l.outPoint) + "s; the time asked about is " + round(t) + "s.",
        { time: t, in_point: l.inPoint, out_point: l.outPoint }
      );
    }
    // 3. Solo on other layers.
    if (scan.soloAny && l.solo !== true) {
      add(
        findings,
        "solo_elsewhere",
        "blocks",
        30,
        "Another layer is soloed",
        "With a solo on, every layer without one is hidden. Soloed: " + scan.soloLayers.length + " layer(s).",
        { soloed: scan.soloLayers }
      );
    }
    // 4. Own opacity. A parent's opacity is not inherited in AE, so it is not looked at.
    var op = opacityOf(l, t);
    facts.opacity = op;
    if (op !== null) {
      if (op === 0) {
        add(findings, "opacity_zero", "blocks", 40, "The layer's own opacity is 0%", "Opacity at " + round(t) + "s is 0.", { opacity: op });
      } else if (op < 10) {
        add(findings, "opacity_low", "likely", 205, "The layer's own opacity is only " + round(op) + "%", "It is on, but nearly invisible.", { opacity: op });
      }
    }
    // Parents: scale 0 hides the children. Parent opacity does not, so say it.
    var cur = l;
    var zeroScale = null;
    var parentOpacityZero = null;
    for (i = 0; cur && i < MAX_PARENT_DEPTH; i++) {
      var tr = prop(cur, "ADBE Transform Group");
      var sc = valueAt(prop(tr, "ADBE Scale"), t);
      if (sc && zeroScale === null && (sc[0] === 0 || sc[1] === 0)) zeroScale = { layer: ref(cur), scale: sc };
      if (i > 0 && parentOpacityZero === null) {
        var pop = opacityOf(cur, t);
        if (pop === 0) parentOpacityZero = ref(cur);
      }
      cur = cur.parent;
    }
    if (zeroScale) {
      var own = zeroScale.layer.id === l.id;
      add(
        findings,
        "scale_zero",
        "blocks",
        50,
        own ? "The layer's scale is 0" : "A parent's scale is 0, so the layer collapses with it",
        "Scale on layer " + zeroScale.layer.index + " (" + zeroScale.layer.name + ") is [" + zeroScale.scale.join(", ") + "] at " + round(t) + "s.",
        zeroScale
      );
    }
    if (parentOpacityZero) {
      add(
        findings,
        "parent_opacity_not_inherited",
        "info",
        900,
        "A parent has 0% opacity, which does not hide this layer",
        "AE parenting passes transform to children, never opacity. Parent: " + parentOpacityZero.name + ".",
        { parent: parentOpacityZero }
      );
    }

    // 5. Shy: Timeline only.
    if (facts.shy) {
      add(
        findings,
        "shy",
        "info",
        910,
        "The layer is shy",
        "Shy hides it in the Timeline panel when Hide Shy Layers is on (comp.hideShyLayers). It does not affect the picture."
      );
    }
    if (isTrue(function () { return l.guideLayer; })) {
      add(findings, "guide_layer", "likely", 120, "The layer is a guide layer", "Guide layers show in the viewer but are left out of renders.");
    }

    // 6. Track mattes: this layer's, and whether it is one.
    var matteTypeName = "none";
    var matteLayer = null;
    var matteType;
    try {
      matteType = l.trackMatteType;
    } catch (eM) {
      matteType = undefined;
    }
    var noMatte = typeof TrackMatteType === "undefined" ? undefined : TrackMatteType.NO_TRACK_MATTE;
    if (matteType !== undefined && matteType !== noMatte) {
      matteTypeName = enumName(matteEnum(), MATTE_KEYS, matteType);
      try {
        matteLayer = l.trackMatteLayer;
      } catch (eML) {
        matteLayer = null;
      }
      if (!matteLayer) {
        // Before AE 23 the matte was always the layer above.
        var modern = false;
        try {
          modern = l.setTrackMatte !== undefined && l.setTrackMatte !== null;
        } catch (eMo) {}
        if (!modern && l.index > 1) matteLayer = comp.layer(l.index - 1);
      }
      facts.track_matte = { type: matteTypeName, layer: matteLayer ? ref(matteLayer) : null };
      var inverted = enumIn(matteEnum(), INVERTED_MATTE_KEYS, matteType);
      var matteEmpty = false;
      var emptyWhy = "";
      if (matteLayer) {
        var mop = opacityOf(matteLayer, t);
        if (t < matteLayer.inPoint || t >= matteLayer.outPoint) {
          matteEmpty = true;
          emptyWhy = "the matte layer has nothing at " + round(t) + "s (outside its in and out points)";
        } else if (mop !== null && mop === 0) {
          matteEmpty = true;
          emptyWhy = "the matte layer's opacity is 0%";
        }
      }
      if (matteEmpty && !inverted) {
        add(
          findings,
          "matte_empty",
          "blocks",
          80,
          "The track matte is empty, which hides the layer",
          "A " + matteTypeName + " matte keeps only what the matte layer covers, and " + emptyWhy + ".",
          { matte: matteLayer ? ref(matteLayer) : null, type: matteTypeName }
        );
      } else {
        add(
          findings,
          "track_matte",
          "possible",
          230,
          "The layer is cut by a " + matteTypeName + " track matte",
          "Only the part the matte layer " + (inverted ? "leaves uncovered" : "covers") + " shows." + (matteLayer ? " Matte: " + matteLayer.name + "." : ""),
          { matte: matteLayer ? ref(matteLayer) : null, type: matteTypeName }
        );
      }
    }
    if (isTrue(function () { return l.isTrackMatte; })) {
      var users = [];
      var scanN = comp.numLayers > MAX_LAYERS ? MAX_LAYERS : comp.numLayers;
      for (i = 1; i <= scanN; i++) {
        var cand = comp.layer(i);
        var cm = null;
        try {
          cm = cand.trackMatteLayer;
        } catch (eCM) {
          cm = null;
        }
        if (cm && cm.id === l.id && users.length < MAX_ABOVE_LIST) users.push(ref(cand));
      }
      facts.is_track_matte = true;
      add(
        findings,
        "is_track_matte",
        "info",
        920,
        "The layer is used as a track matte",
        "A matte layer is usually shown only through the layer it mattes, so its own video switch is normally off." +
          (users.length ? " Used by: " + users.length + " layer(s)." : ""),
        users.length ? { used_by: users } : undefined
      );
    }

    // 7. Blend mode: this layer's, and stencils or silhouettes above it.
    var blendMode;
    try {
      blendMode = l.blendingMode;
    } catch (eB) {
      blendMode = undefined;
    }
    if (blendMode !== undefined) {
      var bname = enumName(blendEnum(), BLEND_KEYS, blendMode);
      facts.blend_mode = bname;
      var isNormalBlend = enumIn(blendEnum(), ["NORMAL"], blendMode);
      if (isStencilOrSilhouette(blendMode)) {
        add(
          findings,
          "blend_stencil",
          "likely",
          140,
          "The layer's blend mode is " + bname,
          "Stencil and silhouette modes cut a hole in everything below instead of drawing the layer.",
          { blend_mode: bname }
        );
      } else if (blendEnum() !== undefined && !isNormalBlend) {
        add(
          findings,
          "blend_mode",
          "possible",
          240,
          "The blend mode is " + bname + ", not Normal",
          "Over a black or empty background some modes (Multiply, Add, Screen, Overlay and others) show little or nothing.",
          { blend_mode: bname }
        );
      }
    }

    // 8. Masks.
    var masks = prop(l, "ADBE Mask Parade");
    var maskInfo = [];
    var maskCount = 0;
    try {
      maskCount = masks ? masks.numProperties : 0;
    } catch (eMc) {
      maskCount = 0;
    }
    var noneMode = typeof MaskMode === "undefined" ? undefined : MaskMode.NONE;
    var activeMasks = 0;
    var degenerateActive = 0;
    var anyInvertedActive = false;
    var allActiveOpacityZero = true;
    var firstActiveSubtracts = false;
    for (i = 1; i <= maskCount && i <= MAX_MASKS; i++) {
      var mk = prop(masks, i);
      if (!mk) continue;
      var mmode;
      try {
        mmode = mk.maskMode;
      } catch (eMm) {
        mmode = undefined;
      }
      var minv = isTrue(function () { return mk.inverted; });
      var mopv = valueAt(prop(mk, "ADBE Mask Opacity"), t);
      var shp = valueAt(prop(mk, "ADBE Mask Shape"), t);
      var verts = null;
      try {
        if (shp && shp.vertices) verts = shp.vertices.length;
      } catch (eV) {}
      var mname = enumName(maskEnum(), MASK_KEYS, mmode);
      var entry = { index: i, name: String(mk.name), mode: mname, inverted: minv, opacity: mopv, vertices: verts };
      maskInfo.push(entry);
      if (mmode !== undefined && mmode !== noneMode) {
        activeMasks++;
        if (verts !== null && verts < 3) degenerateActive++;
        if (minv) anyInvertedActive = true;
        if (mopv === null || mopv !== 0) allActiveOpacityZero = false;
        if (activeMasks === 1 && enumIn(maskEnum(), ["SUBTRACT"], mmode)) firstActiveSubtracts = true;
      }
    }
    facts.masks = maskInfo;
    if (maskCount > MAX_MASKS) facts.masks_truncated = true;
    if (activeMasks > 0 && degenerateActive === activeMasks && !anyInvertedActive && !firstActiveSubtracts) {
      add(
        findings,
        "mask_empty",
        "blocks",
        90,
        "Every mask on the layer is empty, which hides the layer",
        "The masks have fewer than 3 vertices, so they enclose no area, and a layer with masks shows only inside them.",
        { masks: maskInfo }
      );
    } else if (activeMasks > 0 && allActiveOpacityZero && !firstActiveSubtracts) {
      add(findings, "mask_opacity_zero", "likely", 150, "Every mask has 0% opacity", "A mask at 0% opacity covers nothing.", { masks: maskInfo });
    } else if (activeMasks > 0) {
      if (anyInvertedActive) {
        add(findings, "mask_inverted", "possible", 250, "A mask is inverted", "An inverted mask shows what is outside its shape.", { masks: maskInfo });
      } else {
        add(findings, "masks", "info", 930, "The layer has " + activeMasks + " active mask(s)", "Only the area the masks enclose shows.", { masks: maskInfo });
      }
    }

    // 9. Effects: switches, then expression errors.
    var fxGroup = prop(l, "ADBE Effect Parade");
    var fxCount = 0;
    try {
      fxCount = fxGroup ? fxGroup.numProperties : 0;
    } catch (eFc) {
      fxCount = 0;
    }
    var fxInfo = [];
    var fxOff = [];
    for (i = 1; i <= fxCount && i <= MAX_EFFECTS; i++) {
      var fx = prop(fxGroup, i);
      if (!fx) continue;
      var fxOn = true;
      try {
        fxOn = fx.enabled !== false;
      } catch (eFe) {}
      fxInfo.push({ index: i, name: String(fx.name), match_name: String(fx.matchName), enabled: fxOn });
      if (!fxOn) fxOff.push(String(fx.name));
    }
    facts.effects = fxInfo;
    if (fxCount > MAX_EFFECTS) facts.effects_truncated = true;
    var effectsActive = true;
    try {
      if (l.effectsActive === false) effectsActive = false;
    } catch (eEa) {}
    facts.effects_active = effectsActive;
    if (fxCount > 0 && !effectsActive) {
      add(findings, "effects_switch_off", "possible", 260, "The layer's effects switch (fx) is off", "None of its " + fxCount + " effect(s) is applied.", { effects: fxInfo });
    } else if (fxOff.length > 0) {
      add(findings, "effect_disabled", "possible", 261, fxOff.length + " effect(s) are switched off", "Off: " + fxOff.join(", ") + ".", { effects: fxInfo });
    }
    var ex = { visited: 0, truncated: false, errors: [], errorsTruncated: false, expressions: 0 };
    walkExpressions(l, "", 0, t, ex);
    facts.expressions = ex.expressions;
    if (ex.errors.length > 0) {
      add(
        findings,
        "expression_error",
        "likely",
        160,
        ex.errors.length + (ex.errorsTruncated ? "+" : "") + " expression(s) report an error",
        "AE shows the property's own value instead of the expression's, so the layer can look wrong. First: " + ex.errors[0].path + ".",
        { errors: ex.errors, truncated: ex.errorsTruncated }
      );
    }
    if (ex.truncated) unchecked.push("expression sweep stopped after " + MAX_VISITED + " properties");

    // 10. Source: missing footage, time remap, and a precomp's own time.
    var src = null;
    try {
      src = l.source;
    } catch (eS) {
      src = null;
    }
    var sourceTime = null;
    var stretch = 100;
    try {
      stretch = l.stretch;
    } catch (eSt) {}
    if (typeof stretch === "number" && stretch !== 0) {
      sourceTime = ((t - l.startTime) * 100) / stretch;
    }
    if (src && src instanceof FootageItem) {
      var missing = false;
      try {
        missing = src.footageMissing === true;
      } catch (eFm) {}
      if (missing) {
        var placeholder = false;
        try {
          placeholder = src.mainSource instanceof PlaceholderSource;
        } catch (ePh) {}
        add(
          findings,
          "footage_missing",
          "likely",
          130,
          placeholder ? "The layer plays a placeholder" : "The layer's footage file is missing",
          "AE draws colour bars where the picture should be. Source: " + src.name + ".",
          { source: String(src.name), placeholder: placeholder }
        );
      }
    }
    var remapOn = isTrue(function () { return l.timeRemapEnabled; });
    var srcDur = null;
    try {
      if (src && typeof src.duration === "number") srcDur = src.duration;
    } catch (eD) {}
    if (remapOn) {
      var rv = valueAt(prop(l, "ADBE Time Remapping"), t);
      if (typeof rv === "number") {
        sourceTime = rv;
        facts.time_remap_value = rv;
        if (srcDur !== null && srcDur > 0 && (rv > srcDur + 1e-6 || rv < 0)) {
          add(
            findings,
            "time_remap_out_of_range",
            "likely",
            170,
            "Time remapping points outside the source",
            "The remapped time is " + round(rv) + "s, and the source runs from 0 to " + round(srcDur) + "s.",
            { time_remap: rv, source_duration: srcDur }
          );
        }
      }
    }
    facts.source_time = sourceTime === null ? null : round(sourceTime);

    // 11. Collapse transformations, adjustment layers and stencils above.
    if (isTrue(function () { return l.collapseTransformation; })) {
      add(
        findings,
        "collapse_transformations",
        "info",
        940,
        "Collapse Transformations is on",
        "The layer's contents are drawn in this comp's own space, so masks, effects and blend modes inside can act differently than on a flat precomp."
      );
    }
    var adjAbove = [];
    var stencilAbove = [];
    var covering = null;
    var ownBounds = null;
    var ownIs2D = !facts.three_d && kind !== "camera" && kind !== "light" && kind !== "null" && kind !== "audio";
    if (ownIs2D) ownBounds = boundsAt(l, t);
    for (i = 1; i < l.index && i <= MAX_LAYERS; i++) {
      var up = comp.layer(i);
      if (!up || up.enabled === false) continue;
      if (t < up.inPoint || t >= up.outPoint) continue;
      if (scan.soloAny && up.solo !== true) continue;
      if (isTrue(function () { return up.adjustmentLayer; })) {
        var upFx = prop(up, "ADBE Effect Parade");
        var upFxN = 0;
        try {
          upFxN = upFx ? upFx.numProperties : 0;
        } catch (eU) {}
        if (upFxN > 0 && up.effectsActive !== false && adjAbove.length < MAX_ABOVE_LIST) adjAbove.push(ref(up));
        continue;
      }
      var ubm;
      try {
        ubm = up.blendingMode;
      } catch (eUb) {
        ubm = undefined;
      }
      if (ubm !== undefined && isStencilOrSilhouette(ubm) && stencilAbove.length < MAX_ABOVE_LIST) stencilAbove.push(ref(up));
      // A guess: a plain opaque solid above that covers this layer's box.
      if (covering === null && ownIs2D && coversLayer(up, t, ownBounds, comp)) covering = ref(up);
    }
    if (adjAbove.length > 0) {
      add(
        findings,
        "adjustment_above",
        "possible",
        270,
        adjAbove.length + " adjustment layer(s) above apply effects to this layer",
        "Adjustment layers change everything below them; check them if the layer looks wrong.",
        { layers: adjAbove }
      );
    }
    if (stencilAbove.length > 0) {
      add(
        findings,
        "stencil_above",
        "possible",
        271,
        "A layer above uses a stencil or silhouette blend mode",
        "Stencil and silhouette modes cut holes in the layers beneath them.",
        { layers: stencilAbove }
      );
    }
    if (covering) {
      add(
        findings,
        "covered_guess",
        "possible",
        280,
        "A plain opaque solid above may cover the layer (a guess)",
        "The DOM can't read pixels. Layer " + covering.index + " (" + covering.name + ") is a 100% Normal solid with no masks, matte or effects and its box covers this layer's. The pixel proof (ae_explain_layer_proof, suspect layers_above) can confirm it.",
        { layer: covering }
      );
    }

    // 12. 2D position: off canvas, or nothing to draw.
    if (ownIs2D) {
      if (ownBounds === null) {
        unchecked.push("position on canvas: the box depends on a 3D parent or can't be read");
      } else {
        facts.bounds = ownBounds.rect;
        var W = comp.width;
        var H = comp.height;
        var r = ownBounds.rect;
        if (ownBounds.empty) {
          add(
            findings,
            "no_extent",
            "likely",
            110,
            "The layer has no extent to draw",
            "sourceRectAtTime is empty at " + round(t) + "s: an empty text layer, a shape layer with no contents, or a source with no size.",
            { rect: r }
          );
        } else if (r[2] <= 0 || r[0] >= W || r[3] <= 0 || r[1] >= H) {
          add(
            findings,
            "off_canvas",
            "blocks",
            70,
            "The layer is entirely off the canvas",
            "Its box in comp space is [" + r.join(", ") + "]; the comp is " + W + " x " + H + ".",
            { rect: r, comp: [W, H] }
          );
        }
      }
    } else if (facts.three_d && kind !== "camera" && kind !== "light" && kind !== "null") {
      unchecked.push("position on canvas for a 3D layer: needs a camera projection");
    }

    // 13. 3D: behind the camera. AE cameras have no clipping plane, so that is not checked.
    if (facts.three_d && kind !== "camera" && kind !== "light") {
      var cam = null;
      try {
        cam = comp.activeCamera;
      } catch (eC) {
        cam = null;
      }
      var renderer = "";
      try {
        if (comp.renderer !== undefined) renderer = String(comp.renderer);
      } catch (eR) {}
      if (renderer !== "") facts.renderer = renderer;
      if (!cam) {
        unchecked.push("camera: the comp has no active camera, so 3D layers use the default view");
      } else if (l.parent) {
        unchecked.push("behind the camera: the layer has a parent, so its world position is not worked out");
      } else {
        var cf = cameraForward(cam, t);
        if (!cf.ok) {
          unchecked.push("behind the camera: " + cf.reason);
        } else {
          var lpos = valueAt(prop(prop(l, "ADBE Transform Group"), "ADBE Position"), t);
          if (lpos && lpos.length >= 3) {
            var d = [lpos[0] - cf.position[0], lpos[1] - cf.position[1], lpos[2] - cf.position[2]];
            var len = Math.sqrt(cf.forward[0] * cf.forward[0] + cf.forward[1] * cf.forward[1] + cf.forward[2] * cf.forward[2]);
            var depth = (d[0] * cf.forward[0] + d[1] * cf.forward[1] + d[2] * cf.forward[2]) / len;
            facts.camera = { layer: String(cam.name), depth: round(depth), nodes: cf.nodes };
            if (depth <= 0) {
              add(
                findings,
                "behind_camera",
                "likely",
                100,
                "The 3D layer is behind the active camera",
                "Along the camera's view direction the layer's position is " + round(depth) + " units away (zero or less is behind or level with the lens). comp.activeCamera is the camera at the comp's current time, " + round(comp.time) + "s.",
                { camera: String(cam.name), depth: round(depth) }
              );
            }
          }
        }
      }
    }

    // 14. A precomp: is anything inside active at the time it plays?
    var inside = null;
    if (kind === "precomp" && opts.inside && src instanceof CompItem && sourceTime !== null) {
      inside = explainInside(src, sourceTime);
      if (inside.time_outside) {
        add(
          findings,
          "precomp_time_outside",
          "likely",
          102,
          "The precomp has no frame at this time",
          "The layer plays the nested comp at " + round(sourceTime) + "s, and it lasts " + round(src.duration) + "s.",
          { inner_time: round(sourceTime), inner_duration: src.duration }
        );
      } else if (inside.layers === 0) {
        add(findings, "precomp_empty", "likely", 103, "The precomp is empty", "Nested comp \"" + src.name + "\" has no layers.");
      } else if (inside.active_layers === 0) {
        add(
          findings,
          "precomp_nothing_active",
          "likely",
          104,
          "Nothing inside the precomp is active at this time",
          "None of the " + inside.layers + " layer(s) in \"" + src.name + "\" renders at " + round(sourceTime) + "s; see `inside` for each layer's reason.",
          { comp_id: src.id }
        );
      }
      if (inside.missing_footage > 0) {
        add(
          findings,
          "precomp_missing_footage",
          "possible",
          131,
          inside.missing_footage + " footage item(s) inside the precomp are missing",
          "The cause is often inside the nested comp: open `inside` and the nested comp's own layers.",
          { comp_id: src.id }
        );
      }
    }

    return { facts: facts, findings: findings, unchecked: unchecked, inside: inside };
  }

  // A plain, fully opaque solid that covers `target` (a box), or false. It is a
  // guess: the DOM reads no pixels.
  function coversLayer(up, t, target, comp) {
    if (target === null || target.empty) return false;
    if (layerKind(up) !== "solid") return false;
    if (isTrue(function () { return up.threeDLayer; })) return false;
    if (isTrue(function () { return up.guideLayer; })) return false;
    var op = opacityOf(up, t);
    if (op === null || op !== 100) return false;
    var bm;
    try {
      bm = up.blendingMode;
    } catch (e) {
      bm = undefined;
    }
    if (bm !== undefined && blendEnum() !== undefined && !enumIn(blendEnum(), ["NORMAL"], bm)) return false;
    var m = prop(up, "ADBE Mask Parade");
    var mn = 0;
    try {
      mn = m ? m.numProperties : 0;
    } catch (e1) {}
    if (mn > 0) return false;
    var fx = prop(up, "ADBE Effect Parade");
    var fn = 0;
    try {
      fn = fx ? fx.numProperties : 0;
    } catch (e2) {}
    if (fn > 0) return false;
    var tm;
    try {
      tm = up.trackMatteType;
    } catch (e3) {
      tm = undefined;
    }
    if (tm !== undefined && typeof TrackMatteType !== "undefined" && tm !== TrackMatteType.NO_TRACK_MATTE) return false;
    var b = boundsAt(up, t);
    if (b === null || !b.axisAligned) return false;
    return b.rect[0] <= target.rect[0] && b.rect[1] <= target.rect[1] && b.rect[2] >= target.rect[2] && b.rect[3] >= target.rect[3];
  }

  // The layers of a nested comp at its own time: how many render, and why not.
  function explainInside(inner, innerTime) {
    var out = {
      comp_id: inner.id,
      name: inner.name,
      time: round(innerTime),
      duration: inner.duration,
      time_outside: innerTime < 0 || innerTime >= inner.duration,
      layers: inner.numLayers,
      active_layers: 0,
      missing_footage: 0,
      summary: [],
      truncated: false
    };
    var scan = scanComp(inner);
    var n = inner.numLayers;
    if (n > MAX_LAYERS) {
      n = MAX_LAYERS;
      out.truncated = true;
    }
    for (var i = 1; i <= n; i++) {
      var il = inner.layer(i);
      var reasons = quickReasons(il, innerTime, scan);
      var renders = reasons.length === 0;
      if (renders) out.active_layers++;
      try {
        if (il.source && il.source instanceof FootageItem && il.source.footageMissing === true) out.missing_footage++;
      } catch (e) {}
      if (out.summary.length < MAX_INNER) {
        out.summary.push({ index: il.index, id: il.id, name: il.name, kind: layerKind(il), renders: renders, reasons: reasons });
      } else {
        out.truncated = true;
      }
    }
    return out;
  }

  // ---------- a pixel on the frame ----------

  // Layers whose box holds the point, top to bottom, and the first that renders.
  function explainPoint(comp, t, point, scan) {
    var out = { point: point, candidates: [], topmost_rendering: null, unlocated_3d: 0, truncated: false };
    var n = comp.numLayers;
    if (n > MAX_LAYERS) {
      n = MAX_LAYERS;
      out.truncated = true;
    }
    for (var i = 1; i <= n; i++) {
      var l = comp.layer(i);
      var kind = layerKind(l);
      if (kind === "camera" || kind === "light" || kind === "null") continue;
      if (isTrue(function () { return l.threeDLayer; })) {
        out.unlocated_3d++;
        continue;
      }
      var b = boundsAt(l, t);
      if (b === null || b.empty) continue;
      var r = b.rect;
      if (point[0] < r[0] || point[0] > r[2] || point[1] < r[1] || point[1] > r[3]) continue;
      var reasons = quickReasons(l, t, scan);
      var renders = reasons.length === 0;
      var op = opacityOf(l, t);
      out.candidates.push({
        index: l.index,
        id: l.id,
        name: l.name,
        kind: kind,
        renders: renders,
        reasons: reasons,
        opacity: op,
        bounds: r,
        exact: b.axisAligned
      });
      if (renders && out.topmost_rendering === null) out.topmost_rendering = l.index;
    }
    return out;
  }

  // args: { comp_id, layer?, point?: [x, y], time?, inside? }. Read-only.
  A.explainLayer = function (args) {
    var comp = requireComp(args.comp_id);
    var t = args.time;
    if (t === undefined || t === null) t = comp.time;
    if (typeof t !== "number" || !isFinite(t)) fail("bad_args", "time must be a finite number");
    var hasPoint = args.point !== undefined && args.point !== null;
    var hasLayer = args.layer !== undefined && args.layer !== null;
    if (!hasPoint && !hasLayer) fail("bad_args", "give a layer, a point, or both");
    if (hasPoint) {
      if (typeof args.point.length !== "number" || args.point.length !== 2 || typeof args.point[0] !== "number" || typeof args.point[1] !== "number") {
        fail("bad_args", "point must be [x, y] in comp pixels");
      }
    }
    var out = {
      comp: { id: comp.id, name: comp.name, width: comp.width, height: comp.height },
      time: t,
      comp_time: comp.time
    };
    var scan = scanComp(comp);
    if (scan.truncated) out.truncated = true;
    out.solo_layers = scan.soloLayers;
    if (hasLayer) {
      var l = findLayer(comp, args.layer);
      out.layer = ref(l);
      var one = explainOne(comp, l, t, scan, { inside: args.inside !== false });
      out.facts = one.facts;
      out.findings = one.findings;
      out.unchecked = one.unchecked;
      if (one.inside) out.inside = one.inside;
    } else {
      out.findings = [];
      out.unchecked = [];
    }
    if (hasPoint) {
      out.at_point = explainPoint(comp, t, args.point, scan);
      if (hasLayer) {
        var covers = false;
        for (var i = 0; i < out.at_point.candidates.length; i++) {
          if (out.at_point.candidates[i].id === out.layer.id) covers = true;
        }
        out.at_point.layer_covers_point = covers;
        if (!covers && out.facts && out.facts.bounds) {
          add(
            out.findings,
            "point_outside_layer",
            "info",
            950,
            "The layer's box does not hold that point",
            "The point [" + args.point.join(", ") + "] is outside the layer's box at " + round(t) + "s.",
            { bounds: out.facts.bounds }
          );
        }
      }
    }
    out.limits = [
      "A parent's opacity is not inherited in AE, so it is not a cause and is not checked.",
      "AE cameras have no clipping plane; only 'behind the camera' is worked out, with our own maths.",
      "Effects that fail or are missing a plug-in can't be read; only effect switches and expression errors are.",
      "'Covered by a layer above' is a guess from the DOM; only the pixel proof confirms it."
    ];
    return out;
  };

  // ---------- the pixel proof ----------

  var SUSPECTS = { enabled: true, solo: true, opacity: true, track_matte: true, masks: true, layers_above: true, adjustment_above: true };

  function projectState() {
    var total = app.project.numItems;
    var proofComps = 0;
    var comps = 0;
    for (var i = 1; i <= total; i++) {
      var it = app.project.item(i);
      if (it instanceof CompItem) {
        comps++;
        if (String(it.name).indexOf(PROOF_PREFIX) === 0) proofComps++;
      }
    }
    return { num_items: total, comps: comps, proof_comps: proofComps };
  }

  A.explainProofState = function () {
    return projectState();
  };

  function activeMaskCount(l) {
    var masks = prop(l, "ADBE Mask Parade");
    var n = 0;
    var active = 0;
    try {
      n = masks ? masks.numProperties : 0;
    } catch (e) {}
    for (var i = 1; i <= n && i <= MAX_MASKS; i++) {
      var mk = prop(masks, i);
      if (!mk) continue;
      try {
        if (typeof MaskMode === "undefined" || mk.maskMode !== MaskMode.NONE) active++;
      } catch (e1) {}
    }
    return active;
  }

  // What the suspect would change on this layer, or a reason it doesn't apply.
  // Pure reads: runs before anything is duplicated.
  function planSuspect(comp, l, suspect, t) {
    var plan = { applies: false, reason: "", what: "" };
    var scan = scanComp(comp);
    var i;
    if (suspect === "enabled") {
      if (l.enabled !== false) plan.reason = "the layer's video switch is already on";
      else {
        plan.applies = true;
        plan.what = "turn the layer's video switch on";
      }
    } else if (suspect === "solo") {
      if (!scan.soloAny || l.solo === true) plan.reason = "no other layer is soloed";
      else {
        plan.applies = true;
        plan.what = "solo the layer in the copy too, so it shows beside the layers that are soloed";
      }
    } else if (suspect === "opacity") {
      var p = prop(prop(l, "ADBE Transform Group"), "ADBE Opacity");
      var v = valueAt(p, t);
      var animated = false;
      var expr = false;
      try {
        animated = p.numKeys > 0;
      } catch (e) {}
      try {
        expr = p.expressionEnabled === true && String(p.expression) !== "";
      } catch (e1) {}
      if (v === null || v !== 0) plan.reason = "the layer's own opacity is not 0 at this time";
      else if (animated || expr) plan.reason = "opacity is animated or driven by an expression; it can't be set to a plain value in the copy";
      else {
        plan.applies = true;
        plan.what = "set the layer's opacity to 100";
      }
    } else if (suspect === "track_matte") {
      var tm;
      try {
        tm = l.trackMatteType;
      } catch (e2) {
        tm = undefined;
      }
      if (tm === undefined || typeof TrackMatteType === "undefined" || tm === TrackMatteType.NO_TRACK_MATTE) plan.reason = "the layer has no track matte";
      else {
        plan.applies = true;
        plan.what = "remove the layer's track matte";
      }
    } else if (suspect === "masks") {
      if (activeMaskCount(l) === 0) plan.reason = "the layer has no active masks";
      else {
        plan.applies = true;
        plan.what = "set every mask on the layer to None";
      }
    } else if (suspect === "layers_above") {
      var anyAbove = false;
      for (i = 1; i < l.index; i++) {
        var ab0 = comp.layer(i);
        if (ab0.enabled !== false && proofSwitchable(ab0)) anyAbove = true;
      }
      if (!anyAbove) plan.reason = "no enabled layer above that draws (cameras, lights and track mattes are left alone)";
      else {
        plan.applies = true;
        plan.what = "switch off the layers above that draw (cameras, lights and track mattes stay as they are)";
      }
    } else if (suspect === "adjustment_above") {
      var anyAdj = false;
      for (i = 1; i < l.index; i++) {
        var up = comp.layer(i);
        if (up.enabled !== false && isTrue(function () { return up.adjustmentLayer; })) anyAdj = true;
      }
      if (!anyAdj) plan.reason = "no enabled adjustment layer above";
      else {
        plan.applies = true;
        plan.what = "switch off the adjustment layers above";
      }
    }
    return plan;
  }

  // A layer that "layers_above" may switch off: it draws, and is not a camera, a
  // light or a track matte source (switching those changes more than the layer's own picture).
  function proofSwitchable(l) {
    var k = layerKind(l);
    if (k === "camera" || k === "light") return false;
    if (isTrue(function () { return l.isTrackMatte; })) return false;
    return true;
  }

  // The target's box in comp pixels, clamped to the comp: [x0, y0, x1, y1], or
  // null when the layer is 3D (or has a 3D parent) or the box can't be read.
  function proofRegion(comp, l, t) {
    var k = layerKind(l);
    if (k === "camera" || k === "light" || k === "null" || k === "audio") return null;
    if (isTrue(function () { return l.threeDLayer; })) return null;
    var b = boundsAt(l, t);
    if (b === null || b.empty) return null;
    var r = b.rect;
    var x0 = Math.max(0, r[0]);
    var y0 = Math.max(0, r[1]);
    var x1 = Math.min(comp.width, r[2]);
    var y1 = Math.min(comp.height, r[3]);
    return [round(x0), round(y0), round(x1), round(y1)];
  }

  // Applies the plan to the copy's layer. Top-level layers only.
  function applySuspect(copy, cl, suspect) {
    var i;
    var changed = 0;
    if (suspect === "enabled") {
      cl.enabled = true;
      changed = 1;
    } else if (suspect === "solo") {
      // Only the target is added to the soloed set; the other layers keep their solo.
      cl.solo = true;
      changed = 1;
    } else if (suspect === "opacity") {
      prop(prop(cl, "ADBE Transform Group"), "ADBE Opacity").setValue(100);
      changed = 1;
    } else if (suspect === "track_matte") {
      var removed = false;
      try {
        if (cl.removeTrackMatte) {
          cl.removeTrackMatte();
          removed = true;
        }
      } catch (e) {
        removed = false;
      }
      if (!removed) cl.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
      changed = 1;
    } else if (suspect === "masks") {
      var masks = prop(cl, "ADBE Mask Parade");
      for (i = 1; i <= masks.numProperties && i <= MAX_MASKS; i++) {
        var mk = masks.property(i);
        if (mk && mk.maskMode !== MaskMode.NONE) {
          mk.maskMode = MaskMode.NONE;
          changed++;
        }
      }
    } else if (suspect === "layers_above") {
      for (i = 1; i < cl.index; i++) {
        var ab = copy.layer(i);
        if (ab.enabled !== false && proofSwitchable(ab)) {
          ab.enabled = false;
          changed++;
        }
      }
    } else if (suspect === "adjustment_above") {
      for (i = 1; i < cl.index; i++) {
        var aj = copy.layer(i);
        if (aj.enabled !== false && aj.adjustmentLayer === true) {
          aj.enabled = false;
          changed++;
        }
      }
    }
    return changed;
  }

  // args: { comp_id, layer, suspect, time? }. Read-only: refuses when the suspect
  // does not apply, so the server can say no before it takes a checkpoint.
  A.explainProofPlan = function (args) {
    var comp = requireComp(args.comp_id);
    var suspect = String(args.suspect);
    if (!SUSPECTS.hasOwnProperty(suspect)) fail("bad_args", "Unknown suspect \"" + suspect + "\"");
    var l = findLayer(comp, args.layer);
    var t = args.time;
    if (t === undefined || t === null) t = comp.time;
    if (typeof t !== "number" || !isFinite(t)) fail("bad_args", "time must be a finite number");
    var plan = planSuspect(comp, l, suspect, t);
    if (!plan.applies) fail("bad_args", "Nothing to toggle for suspect " + suspect + ": " + plan.reason + ".");
    return { applies: true, what: plan.what, layer_index: l.index, time: t };
  };

  // args: { comp_id, layer, suspect, time?, expect }. Duplicates the comp and
  // undoes the suspect in the copy; explainProofEnd removes the copy. The
  // server renders both between the two calls.
  A.explainProofBegin = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var suspect = String(args.suspect);
    if (!SUSPECTS.hasOwnProperty(suspect)) fail("bad_args", "Unknown suspect \"" + suspect + "\"");
    var l = findLayer(comp, args.layer);
    var t = args.time;
    if (t === undefined || t === null) t = comp.time;
    if (typeof t !== "number" || !isFinite(t)) fail("bad_args", "time must be a finite number");
    // Everything that can fail is checked here, before the duplicate exists.
    var plan = planSuspect(comp, l, suspect, t);
    if (!plan.applies) fail("bad_args", "Nothing to toggle for suspect " + suspect + ": " + plan.reason + ".");
    var layerIndex = l.index;
    var layerName = l.name;
    var region = proofRegion(comp, l, t);
    var before = projectState();
    var made = A.withUndo("Chroma AE MCP: explain proof (copy)", function () {
      var copy = comp.duplicate();
      try {
        copy.name = PROOF_PREFIX + comp.name;
        var cl = copy.layer(layerIndex);
        if (!cl || cl.name !== layerName) fail("not_found", "The copy's layer " + layerIndex + " is not \"" + layerName + "\"");
        var changed = applySuspect(copy, cl, suspect);
        return { copy_id: copy.id, copy_name: copy.name, changed: changed };
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
      layer_index: layerIndex,
      suspect: suspect,
      what: plan.what,
      layers_changed: made.changed,
      time: t,
      region: region,
      comp_size: [comp.width, comp.height],
      items_before: before.num_items
    };
  };

  // args: { copy_id, expect }. Removes the proof copy, and only a proof copy.
  A.explainProofEnd = function (args) {
    assertGuard(args.expect);
    var item = null;
    try {
      item = app.project.itemByID(args.copy_id);
    } catch (e) {
      item = null;
    }
    if (!item) return { removed: false, already_gone: true, copy_id: args.copy_id };
    if (!(item instanceof CompItem) || String(item.name).indexOf(PROOF_PREFIX) !== 0) {
      fail("guard", "Refused: item " + args.copy_id + " is not an explain proof copy, so it was not removed.");
    }
    A.withUndo("Chroma AE MCP: explain proof (remove copy)", function () {
      item.remove();
    });
    return { removed: true, copy_id: args.copy_id };
  };
})($.global);
