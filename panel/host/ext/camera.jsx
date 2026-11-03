// panel/host/ext/camera.jsx
//
// Host functions for the camera tools:
// - cameraRead (read): the comp's cameras (lens, depth of field, node type,
//   expressions and their errors) plus the layers asked for by id, for the
//   read-back after a rig
// - cameraSceneRead (read): every layer's transform at a time, for the Node
//   side to work out depth, behind-camera and out-of-frame layers
// - cameraRig (guarded write): a one- or two-node camera, a controller null
//   with sliders driving it by expression (push-in, dolly, orbit, parallax),
//   depth of field focused on a layer, and "make these 3D with a Z spread"
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - cameraRig checks the target guard first, validates everything that can
//   fail before A.withUndo, and wraps the change in A.withUndo.
// - Reads change nothing: not comp time, selection, solo or resolution.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var MAX_CAMERAS = 50;
  // Room for the camera, the controller and every spread layer.
  var MAX_INCLUDE = 202;
  var MAX_EFFECTS = 20;
  var MAX_SPREAD = 200;
  var MAX_EXPR = 2000;
  var MAX_SLIDER = 1000000;
  var DEG = Math.PI / 180;

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

  function has(v) {
    return v !== undefined && v !== null;
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function layerKind(l) {
    var r = "";
    try {
      if (l.reflect && l.reflect.name) r = String(l.reflect.name);
    } catch (e0) {}
    if (r === "CameraLayer") return "camera";
    if (r === "LightLayer") return "light";
    if (r === "TextLayer") return "text";
    if (r === "ShapeLayer") return "shape";
    try {
      if (l.nullLayer) return "null";
    } catch (e1) {}
    try {
      if (l.source && l.source instanceof CompItem) return "precomp";
    } catch (e2) {}
    try {
      if (l.hasAudio && !l.hasVideo) return "audio";
    } catch (e3) {}
    return "av";
  }

  // A property or group by match name, or null (property() returns null for a
  // missing one, but a hidden one can throw).
  function child(group, name) {
    if (!group) return null;
    try {
      var p = group.property(name);
      if (p) return p;
    } catch (e) {}
    return null;
  }

  // The value after expressions, at a time; null when the property is missing.
  function valueAt(prop, t) {
    if (!prop) return null;
    try {
      return prop.valueAtTime(t, false);
    } catch (e0) {}
    try {
      return prop.value;
    } catch (e1) {}
    return null;
  }

  function vec(v, n, fill) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var x = fill;
      if (v !== null && v !== undefined && typeof v === "object" && typeof v.length === "number") {
        if (typeof v[i] === "number" && isFinite(v[i])) x = v[i];
      } else if (i === 0 && typeof v === "number" && isFinite(v)) {
        x = v;
      }
      out.push(x);
    }
    return out;
  }

  function scalar(v) {
    if (typeof v === "number" && isFinite(v)) return v;
    return null;
  }

  function clip(s) {
    if (s.length > MAX_EXPR) return s.substring(0, MAX_EXPR) + " ...[truncated]";
    return s;
  }

  function expressionOf(prop) {
    if (!prop) return null;
    try {
      if (prop.expression) return clip(String(prop.expression));
    } catch (e) {}
    return null;
  }

  function expressionError(prop) {
    if (!prop) return null;
    try {
      if (prop.expressionError) return clip(String(prop.expressionError));
    } catch (e) {}
    return null;
  }

  // The point of interest's match name is documented nowhere. Try
  // "ADBE Point of Interest" first; the SDK has no separate stream for it and
  // the camera's anchor stream is its point of interest, so on a camera or
  // light fall back to "ADBE Anchor Point".
  function poiLookup(l, tr) {
    var p = child(tr, "ADBE Point of Interest");
    if (p) return { prop: p, viaAnchor: false };
    var k = layerKind(l);
    if (k === "camera" || k === "light") {
      var a = child(tr, "ADBE Anchor Point");
      if (a) return { prop: a, viaAnchor: true };
    }
    return { prop: null, viaAnchor: false };
  }

  function poiOf(l, tr) {
    return poiLookup(l, tr).prop;
  }

  // Two nodes is the layer's auto-orient, not whether a POI property was found.
  function twoNodeOf(l, poi) {
    try {
      if (typeof AutoOrientType !== "undefined") {
        return l.autoOrient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
      }
    } catch (e) {}
    return poi !== null;
  }

  // The front-most enabled camera at a time. comp.activeCamera follows the
  // comp's own time, which a read must not move.
  function activeCameraId(comp, t, limit) {
    var top = comp.numLayers;
    if (has(limit) && limit < top) top = limit;
    for (var i = 1; i <= top; i++) {
      var l = comp.layer(i);
      if (layerKind(l) === "camera" && l.enabled === true && t >= l.inPoint && t < l.outPoint) return l.id;
    }
    return null;
  }

  // ---------- reads ----------

  function cameraInfo(l, comp, t, activeId) {
    var tr = child(l, "ADBE Transform Group");
    var opts = child(l, "ADBE Camera Options Group");
    var pos = child(tr, "ADBE Position");
    var poi = poiOf(l, tr);
    var zoomP = child(opts, "ADBE Camera Zoom");
    var dofP = child(opts, "ADBE Camera Depth of Field");
    var focusP = child(opts, "ADBE Camera Focus Distance");
    var apertureP = child(opts, "ADBE Camera Aperture");
    var blurP = child(opts, "ADBE Camera Blur Level");
    var zoom = scalar(valueAt(zoomP, t));
    var aov = null;
    if (zoom !== null && zoom > 0) aov = (2 * Math.atan((comp.width / 2) / zoom)) / DEG;
    var dofV = valueAt(dofP, t);
    var info = {
      id: l.id,
      index: l.index,
      name: String(l.name),
      enabled: l.enabled === true,
      two_node: twoNodeOf(l, poi),
      zoom: zoom,
      angle_of_view: aov,
      dof: dofV === 1 || dofV === true,
      focus_distance: scalar(valueAt(focusP, t)),
      aperture: scalar(valueAt(apertureP, t)),
      blur_level: scalar(valueAt(blurP, t)),
      parent_id: null,
      in_point: l.inPoint,
      out_point: l.outPoint,
      is_active: activeId === l.id,
      expressions: {},
      expression_errors: []
    };
    try {
      if (l.parent) info.parent_id = l.parent.id;
    } catch (e0) {}
    var watched = [
      ["position", pos],
      ["point_of_interest", poi],
      ["zoom", zoomP],
      ["focus_distance", focusP],
      ["aperture", apertureP]
    ];
    for (var w = 0; w < watched.length; w++) {
      // Evaluate first: AE may fill expressionError only on evaluation.
      if (watched[w][1]) valueAt(watched[w][1], t);
      var ex = expressionOf(watched[w][1]);
      if (ex !== null) info.expressions[watched[w][0]] = ex;
      var er = expressionError(watched[w][1]);
      if (er !== null) info.expression_errors.push({ property: watched[w][0], error: er });
    }
    return info;
  }

  function briefLayer(l, t) {
    var tr = child(l, "ADBE Transform Group");
    var kind = layerKind(l);
    var o = {
      id: l.id,
      index: l.index,
      name: String(l.name),
      kind: kind,
      enabled: l.enabled === true,
      three_d: kind === "camera" || kind === "light",
      parent_id: null,
      in_point: l.inPoint,
      out_point: l.outPoint,
      position: null,
      scale: null,
      effects: []
    };
    if (kind !== "camera" && kind !== "light") {
      try {
        o.three_d = l.threeDLayer === true;
      } catch (e0) {}
    }
    try {
      if (l.parent) o.parent_id = l.parent.id;
    } catch (e1) {}
    var pos = child(tr, "ADBE Position");
    var sc = child(tr, "ADBE Scale");
    if (pos) o.position = vec(valueAt(pos, t), 3, 0);
    if (sc) o.scale = vec(valueAt(sc, t), 3, 100);
    var parade = child(l, "ADBE Effect Parade");
    if (parade) {
      var n = 0;
      try {
        n = parade.numProperties;
      } catch (e2) {}
      for (var i = 1; i <= n && o.effects.length < MAX_EFFECTS; i++) {
        try {
          var fx = parade.property(i);
          var p1 = fx.property(1);
          var rec = { name: String(fx.name), match_name: String(fx.matchName), value: null, num_keys: 0 };
          if (p1) {
            rec.value = scalar(valueAt(p1, t));
            rec.num_keys = p1.numKeys;
          }
          o.effects.push(rec);
        } catch (e3) {}
      }
    }
    return o;
  }

  function wantedIds(v) {
    var out = [];
    if (!v || typeof v.length !== "number") return out;
    for (var i = 0; i < v.length && out.length < MAX_INCLUDE; i++) {
      if (typeof v[i] === "number" && isFinite(v[i])) out.push(v[i]);
    }
    return out;
  }

  function compInfo(comp) {
    var renderer = null;
    try {
      renderer = String(comp.renderer);
    } catch (e) {}
    return {
      id: comp.id,
      name: String(comp.name),
      width: comp.width,
      height: comp.height,
      numLayers: comp.numLayers,
      duration: comp.duration,
      renderer: renderer
    };
  }

  // args: { comp_id, ids? }. The comp's cameras and the layers asked for.
  A.cameraRead = function (args) {
    var comp = requireComp(args.comp_id);
    var t = 0;
    try {
      t = comp.time;
    } catch (e0) {}
    if (!isNum(t)) t = 0;
    var activeId = activeCameraId(comp, t);
    var ids = wantedIds(args.ids);
    var idsDropped = 0;
    if (args.ids && typeof args.ids.length === "number" && args.ids.length > ids.length) idsDropped = args.ids.length - ids.length;
    var cameras = [];
    var layers = [];
    var n = comp.numLayers;
    var truncated = false;
    for (var i = 1; i <= n; i++) {
      var l = comp.layer(i);
      if (layerKind(l) === "camera") {
        if (cameras.length < MAX_CAMERAS) cameras.push(cameraInfo(l, comp, t, activeId));
        else truncated = true;
      }
      for (var k = 0; k < ids.length; k++) {
        if (ids[k] === l.id) layers.push(briefLayer(l, t));
      }
    }
    var compActive = null;
    try {
      if (comp.activeCamera) compActive = comp.activeCamera.id;
    } catch (e1) {}
    return {
      comp: compInfo(comp),
      time: t,
      cameras: cameras,
      active_camera_id: activeId,
      comp_active_camera_id: compActive,
      layers: layers,
      ids_dropped: idsDropped,
      truncated: truncated
    };
  };

  function readTransform(l, t) {
    var tr = child(l, "ADBE Transform Group");
    if (!tr) return null;
    var out = {
      anchor: vec(valueAt(child(tr, "ADBE Anchor Point"), t), 3, 0),
      position: vec(valueAt(child(tr, "ADBE Position"), t), 3, 0),
      scale: vec(valueAt(child(tr, "ADBE Scale"), t), 3, 100),
      rotation_z: scalar(valueAt(child(tr, "ADBE Rotate Z"), t)),
      orientation: vec(valueAt(child(tr, "ADBE Orientation"), t), 3, 0),
      rotation_x: scalar(valueAt(child(tr, "ADBE Rotate X"), t)),
      rotation_y: scalar(valueAt(child(tr, "ADBE Rotate Y"), t)),
      point_of_interest: null
    };
    if (out.rotation_z === null) out.rotation_z = 0;
    if (out.rotation_x === null) out.rotation_x = 0;
    if (out.rotation_y === null) out.rotation_y = 0;
    var info = poiLookup(l, tr);
    if (info.prop) out.point_of_interest = vec(valueAt(info.prop, t), 3, 0);
    // On a camera or light the anchor stream is the point of interest, not an
    // anchor to offset children by.
    if (info.viaAnchor) out.anchor = [0, 0, 0];
    return out;
  }

  // args: { comp_id, time? }. Every layer's transform at the time (up to 500),
  // in the shape ae_annotate_frame's maths reads, plus each camera's lens and
  // depth-of-field state.
  A.cameraSceneRead = function (args) {
    var comp = requireComp(args.comp_id);
    var t = 0;
    if (has(args.time)) {
      t = args.time;
    } else {
      try {
        t = comp.time;
      } catch (e0) {}
    }
    if (!isNum(t)) t = 0;
    var last = comp.duration - comp.frameDuration;
    if (t > last) t = last;
    if (t < 0) t = 0;
    var layers = [];
    var n = comp.numLayers;
    var cap = n;
    if (cap > MAX_LAYERS) cap = MAX_LAYERS;
    var activeId = activeCameraId(comp, t, cap);
    var beyond = activeId === null && activeCameraId(comp, t) !== null;
    var soloActive = false;
    for (var si = 1; si <= n; si++) {
      try {
        if (comp.layer(si).solo === true) {
          soloActive = true;
          break;
        }
      } catch (eSolo) {}
    }
    for (var i = 1; i <= cap; i++) {
      var l = comp.layer(i);
      var kind = layerKind(l);
      var hasVideo = true;
      try {
        if (l.hasVideo === false) hasVideo = false;
      } catch (e1) {}
      var guide = false;
      try {
        guide = l.guideLayer === true;
      } catch (e2) {}
      var isSolo = false;
      try {
        isSolo = l.solo === true;
      } catch (eS) {}
      var o = {
        index: l.index,
        id: l.id,
        name: String(l.name),
        kind: kind,
        enabled: l.enabled === true,
        solo: isSolo,
        selected: false,
        three_d: kind === "camera" || kind === "light",
        parent_id: null,
        in_point: l.inPoint,
        out_point: l.outPoint,
        visible: false,
        guide: guide,
        active_at_time: null,
        rect: null,
        skip_reason: null,
        transform: readTransform(l, t)
      };
      if (kind !== "camera" && kind !== "light") {
        try {
          o.three_d = l.threeDLayer === true;
        } catch (e3) {}
      }
      // Auto-Orient is not modelled by the Node maths; flag it so chains through it are refused.
      o.auto_orient_active = false;
      if (kind !== "camera") {
        try {
          if (typeof AutoOrientType !== "undefined" && typeof l.autoOrient === "number") {
            o.auto_orient_active = l.autoOrient !== AutoOrientType.NO_AUTO_ORIENT;
          }
        } catch (eao) {}
      }
      try {
        if (l.parent) o.parent_id = l.parent.id;
      } catch (e4) {}
      o.visible = o.enabled && hasVideo && !guide && t >= l.inPoint && t < l.outPoint;
      try {
        o.active_at_time = l.activeAtTime(t) === true;
      } catch (e5) {}
      if (o.transform === null) o.skip_reason = "no transform group";
      if (kind === "camera") {
        var ci = cameraInfo(l, comp, t, activeId);
        o.camera = {
          zoom: ci.zoom,
          two_node: ci.two_node,
          dof: ci.dof,
          focus_distance: ci.focus_distance,
          focus_expression: has(ci.expressions.focus_distance),
          aperture: ci.aperture,
          blur_level: ci.blur_level
        };
      }
      layers.push(o);
    }
    var compActive = null;
    try {
      if (comp.activeCamera) compActive = comp.activeCamera.id;
    } catch (e6) {}
    return {
      comp: {
        id: comp.id,
        name: String(comp.name),
        width: comp.width,
        height: comp.height,
        pixel_aspect: comp.pixelAspect,
        fps: comp.frameRate,
        duration: comp.duration,
        resolution_factor: null,
        renderer: compInfo(comp).renderer
      },
      time: t,
      layers: layers,
      total_layers: n,
      truncated: n > layers.length,
      active_camera_id: activeId,
      comp_active_camera_id: compActive,
      active_camera_beyond_list: beyond,
      solo_active: soloActive
    };
  };

  // ---------- the rig ----------

  // Zoom in pixels for a lens: (comp width / 2) / tan(angle of view / 2).
  // Without a lens, AE's default 50 mm on a 36 mm film back.
  function lensZoom(comp, lens) {
    var w = comp.width;
    var dflt = (w * 50) / 36;
    if (!lens) return dflt;
    if (has(lens.zoom)) {
      if (!isNum(lens.zoom) || !(lens.zoom > 0)) fail("bad_args", "lens.zoom must be a number above 0");
      return lens.zoom;
    }
    var film = 36;
    if (has(lens.film_size)) {
      if (!isNum(lens.film_size) || !(lens.film_size > 0)) fail("bad_args", "lens.film_size must be a number above 0");
      film = lens.film_size;
    }
    var aov;
    if (has(lens.angle_of_view)) {
      if (!isNum(lens.angle_of_view) || !(lens.angle_of_view > 0) || !(lens.angle_of_view < 180)) {
        fail("bad_args", "lens.angle_of_view must be between 0 and 180 degrees");
      }
      aov = lens.angle_of_view * DEG;
    } else if (has(lens.focal_length)) {
      if (!isNum(lens.focal_length) || !(lens.focal_length > 0)) fail("bad_args", "lens.focal_length must be a number of mm above 0");
      aov = 2 * Math.atan(film / (2 * lens.focal_length));
    } else {
      return dflt;
    }
    return (w / 2) / Math.tan(aov / 2);
  }

  // A property's hard limits: AE throws "out of range" mid-write.
  function checkLimits(prop, v, label) {
    var lo = null;
    var hi = null;
    try {
      if (prop.hasMin) lo = prop.minValue;
      if (prop.hasMax) hi = prop.maxValue;
    } catch (e) {}
    if (lo !== null && v < lo) fail("bad_args", label + " " + v + " is below AE's minimum " + lo);
    if (hi !== null && v > hi) fail("bad_args", label + " " + v + " is above AE's maximum " + hi);
  }

  function controlsFor(preset, distance) {
    if (preset === "push_in") {
      return [{ name: "Distance", kind: "slider", value: distance }, { name: "Push", kind: "slider", value: 0 }];
    }
    if (preset === "dolly" || preset === "parallax") {
      return [{ name: "Distance", kind: "slider", value: distance }, { name: "Truck", kind: "slider", value: 0 }];
    }
    if (preset === "orbit") {
      return [
        { name: "Distance", kind: "slider", value: distance },
        { name: "Orbit Angle", kind: "angle", value: 0 },
        { name: "Tilt", kind: "angle", value: 0 }
      ];
    }
    return [];
  }

  function primaryControl(preset) {
    if (preset === "push_in") return "Push";
    if (preset === "dolly" || preset === "parallax") return "Truck";
    if (preset === "orbit") return "Orbit Angle";
    return null;
  }

  function sliderRef(ctrlName, name) {
    return "thisComp.layer(" + A.stringify(ctrlName) + ").effect(" + A.stringify(name) + ")(1)";
  }

  var CENTER_X = "thisComp.width / 2";
  var CENTER_Y = "thisComp.height / 2";

  // Camera Position expression for a preset. Positive Push moves toward the
  // subject, positive Truck moves right, positive Orbit Angle swings the
  // camera right, positive Tilt raises it. The camera sits at z = -Distance
  // looking at the comp's centre.
  function positionExpression(preset, ctrlName) {
    var d = sliderRef(ctrlName, "Distance");
    if (preset === "push_in") {
      return "[" + CENTER_X + ", " + CENTER_Y + ", -(" + d + " - " + sliderRef(ctrlName, "Push") + ")]";
    }
    if (preset === "dolly" || preset === "parallax") {
      return "[" + CENTER_X + " + " + sliderRef(ctrlName, "Truck") + ", " + CENTER_Y + ", -" + d + "]";
    }
    if (preset === "orbit") {
      return (
        "var a = " + sliderRef(ctrlName, "Orbit Angle") + " * Math.PI / 180; " +
        "var e = " + sliderRef(ctrlName, "Tilt") + " * Math.PI / 180; " +
        "var d = " + d + "; " +
        "[" + CENTER_X + " + d * Math.cos(e) * Math.sin(a), " + CENTER_Y + " - d * Math.sin(e), -d * Math.cos(e) * Math.cos(a)]"
      );
    }
    return null;
  }

  // The point of interest follows a truck so the camera slides instead of panning.
  function poiExpression(preset, ctrlName) {
    if (preset === "dolly" || preset === "parallax") {
      return "[" + CENTER_X + " + " + sliderRef(ctrlName, "Truck") + ", " + CENTER_Y + ", 0]";
    }
    return null;
  }

  // Depth of the target in camera space: the focal plane is perpendicular to
  // the view axis, so this beats the straight-line distance for a target off
  // centre. It names the target, never thisComp.activeCamera (circular).
  function focusExpression(targetName) {
    return "var t = thisComp.layer(" + A.stringify(targetName) + "); fromWorld(t.toWorld(t.anchorPoint))[2]";
  }

  function addControl(ctrl, spec) {
    var parade = ctrl.property("ADBE Effect Parade");
    var matchName = "ADBE Slider Control";
    if (spec.kind === "angle") matchName = "ADBE Angle Control";
    var fx = parade.addProperty(matchName);
    fx.name = spec.name;
    // Set the value now: adding the next effect invalidates this reference.
    fx.property(1).setValue(spec.value);
  }

  // New layers start at the comp's current time when the "Create Layers at
  // Composition Start Time" preference is off; the rig must cover the whole comp.
  function fullSpan(layer, comp) {
    try {
      layer.startTime = 0;
    } catch (e0) {}
    try {
      layer.inPoint = 0;
    } catch (e1) {}
    try {
      layer.outPoint = comp.duration;
    } catch (e2) {}
  }

  function nameTaken(comp, name) {
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).name === name) return true;
    }
    return false;
  }

  function dropLayer(layer) {
    var src = null;
    try {
      src = layer.source;
    } catch (e0) {}
    try {
      layer.remove();
    } catch (e1) {}
    // A null adds a solid item to the project; take it out too.
    try {
      if (src && src.usedIn.length === 0) src.remove();
    } catch (e2) {}
  }

  // Validates the layers to spread and works out each one's Z and scale.
  function planSpread(comp, spread, distance) {
    var out = [];
    if (!has(spread)) return out;
    var sels = spread.layers;
    if (!sels || typeof sels.length !== "number" || sels.length < 1) fail("bad_args", "spread.layers needs at least one layer");
    if (sels.length > MAX_SPREAD) fail("bad_args", "spread.layers takes at most " + MAX_SPREAD + " layers");
    if (!isNum(spread.near) || !isNum(spread.far)) fail("bad_args", "spread.near and spread.far must be numbers");
    var keepSize = spread.keep_size !== false;
    var seen = {};
    var n = sels.length;
    for (var i = 0; i < n; i++) {
      var l = findLayer(comp, sels[i]);
      if (seen[l.id]) fail("bad_args", "Layer \"" + l.name + "\" is listed twice in spread.layers");
      seen[l.id] = true;
      var k = layerKind(l);
      if (k === "camera" || k === "light" || k === "audio") fail("bad_args", "\"" + l.name + "\" is a " + k + " layer; only picture layers can be spread in depth");
      var locked = false;
      try {
        locked = l.locked === true;
      } catch (e0) {}
      if (locked) fail("bad_args", "Layer \"" + l.name + "\" is locked");
      var hasParent = false;
      try {
        hasParent = !!l.parent;
      } catch (eP) {}
      if (hasParent) fail("bad_args", "Layer \"" + l.name + "\" has a parent, so its Z would be in the parent's space; unparent it first");
      var tr = child(l, "ADBE Transform Group");
      var pos = child(tr, "ADBE Position");
      var sc = child(tr, "ADBE Scale");
      if (!pos || !sc) fail("bad_args", "Layer \"" + l.name + "\" has no Position or Scale to set");
      var separated = false;
      try {
        separated = pos.dimensionsSeparated === true;
      } catch (e1) {}
      if (separated) fail("bad_args", "Layer \"" + l.name + "\" has separated position dimensions; join them first");
      if (pos.numKeys > 0 || expressionOf(pos) !== null) fail("bad_args", "Layer \"" + l.name + "\" has an animated or expression-driven Position; spread would overwrite it");
      if (keepSize && (sc.numKeys > 0 || expressionOf(sc) !== null)) {
        fail("bad_args", "Layer \"" + l.name + "\" has an animated or expression-driven Scale; use keep_size false or clear it");
      }
      var z = spread.near;
      if (n > 1) z = spread.near + ((spread.far - spread.near) * i) / (n - 1);
      if (!(z > -distance)) fail("bad_args", "z " + z + " would put \"" + l.name + "\" at or behind the camera (it sits at -" + distance + ")");
      var factor = 1;
      if (keepSize) factor = (distance + z) / distance;
      out.push({ layer: l, z: z, factor: factor, scale_set: keepSize });
    }
    return out;
  }

  A.cameraRig = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);

    var presets = { "static": 1, push_in: 1, dolly: 1, orbit: 1, parallax: 1 };
    var preset = "static";
    if (has(args.preset)) preset = args.preset;
    if (typeof preset !== "string" || presets[preset] !== 1) fail("bad_args", "Unknown preset \"" + preset + "\"");
    var nodes = "two";
    if (has(args.nodes)) nodes = args.nodes;
    if (nodes !== "one" && nodes !== "two") fail("bad_args", "nodes must be \"one\" or \"two\"");
    // An orbit swings the position around a fixed point of interest.
    if (preset === "orbit" && nodes !== "two") fail("bad_args", "The orbit preset aims at the point of interest, so it needs nodes: \"two\"");
    var name = "Camera";
    if (has(args.name)) name = args.name;
    if (typeof name !== "string" || name.length < 1 || name.length > 200) fail("bad_args", "name must be 1 to 200 characters");
    if (typeof AutoOrientType === "undefined") fail("bad_args", "AutoOrientType is not available in this After Effects");

    var zoom = lensZoom(comp, args.lens);
    var distance = zoom;
    if (has(args.distance)) {
      if (!isNum(args.distance) || !(args.distance > 0)) fail("bad_args", "distance must be a number of pixels above 0");
      distance = args.distance;
    }
    // Slider Control values are limited to +/-1,000,000; check before the undo group.
    if (distance > MAX_SLIDER) fail("bad_args", "distance " + distance + " is above the Slider Control limit of " + MAX_SLIDER);
    var center = [comp.width / 2, comp.height / 2];

    var controls = controlsFor(preset, distance);
    var ctrlName = null;
    if (preset !== "static") {
      ctrlName = name + " Controller";
      if (has(args.controller_name)) ctrlName = args.controller_name;
      if (typeof ctrlName !== "string" || ctrlName.length < 1 || ctrlName.length > 200) fail("bad_args", "controller_name must be 1 to 200 characters");
      // The expressions find the controller by name.
      if (nameTaken(comp, ctrlName)) fail("bad_args", "A layer named \"" + ctrlName + "\" exists; pick another controller_name");
      if (ctrlName === name) fail("bad_args", "The controller needs a different name from the camera");
    } else if (has(args.motion)) {
      fail("bad_args", "motion needs a preset other than static");
    }

    var motion = null;
    if (has(args.motion)) {
      var m = args.motion;
      if (!isNum(m.amount)) fail("bad_args", "motion.amount must be a number");
      var mStart = 0;
      if (has(m.start_time)) mStart = m.start_time;
      var mDur = 2;
      if (has(m.duration)) mDur = m.duration;
      if (!isNum(mStart) || mStart < 0) fail("bad_args", "motion.start_time must be 0 or more seconds");
      if (!isNum(mDur) || !(mDur > 0)) fail("bad_args", "motion.duration must be above 0 seconds");
      if (mStart >= comp.duration) fail("bad_args", "motion.start_time is past the end of the comp");
      if (Math.abs(m.amount) > MAX_SLIDER) fail("bad_args", "motion.amount must be between -" + MAX_SLIDER + " and " + MAX_SLIDER);
      // A two-node push-in leaves the point of interest at z = 0; reaching it flips or degenerates the aim.
      if (preset === "push_in" && nodes === "two" && m.amount >= distance) {
        fail("bad_args", "motion.amount " + m.amount + " would push the camera to or past its point of interest (distance " + distance + "); use a smaller amount or a larger distance");
      }
      motion = { control: primaryControl(preset), amount: m.amount, start_time: mStart, duration: mDur, ease: m.ease !== false };
    }

    var focus = null;
    var focusTarget = null;
    if (has(args.focus)) {
      var f = args.focus;
      focus = { aperture: null, blur_level: null, distance: null, layer: null };
      if (has(f.layer) && has(f.distance)) fail("bad_args", "focus takes a layer or a distance, not both");
      if (!has(f.layer) && !has(f.distance) && !has(f.aperture) && !has(f.blur_level)) fail("bad_args", "focus needs at least one of layer, distance, aperture, blur_level");
      if (has(f.layer)) {
        focusTarget = findLayer(comp, f.layer);
        var fk = layerKind(focusTarget);
        if (fk === "camera" || fk === "light") fail("bad_args", "The focus target can't be a " + fk + " layer");
        // The expression names the target, so the name must be unique.
        var same = 0;
        for (var fi = 1; fi <= comp.numLayers; fi++) {
          if (comp.layer(fi).name === focusTarget.name) same++;
        }
        if (same > 1) fail("bad_args", same + " layers are named \"" + focusTarget.name + "\"; rename the focus target first");
        // The new camera sits above the target, so a shared name would resolve to the camera itself.
        if (focusTarget.name === name) fail("bad_args", "The focus target is named \"" + name + "\", like the new camera; give the camera another name or rename the target");
        if (ctrlName !== null && focusTarget.name === ctrlName) fail("bad_args", "The focus target is named \"" + ctrlName + "\", like the controller; pick another controller_name");
        focus.layer = { id: focusTarget.id, name: String(focusTarget.name) };
      }
      if (has(f.distance)) {
        if (!isNum(f.distance) || f.distance < 0) fail("bad_args", "focus.distance must be a number of pixels, 0 or more");
        focus.distance = f.distance;
      }
      if (has(f.aperture)) {
        if (!isNum(f.aperture) || f.aperture < 0) fail("bad_args", "focus.aperture must be 0 or more");
        focus.aperture = f.aperture;
      }
      if (has(f.blur_level)) {
        if (!isNum(f.blur_level) || f.blur_level < 0 || f.blur_level > 1000) fail("bad_args", "focus.blur_level must be 0 to 1000 (percent)");
        focus.blur_level = f.blur_level;
      }
    }

    var spreadPlan = planSpread(comp, args.spread, distance);

    var warnings = [];
    var others = 0;
    for (var ci = 1; ci <= comp.numLayers; ci++) {
      var other = comp.layer(ci);
      if (layerKind(other) === "camera" && other.enabled === true) others++;
    }
    if (others > 0) warnings.push(others + " other enabled camera layer(s) exist; the new camera is on top, so it is the active one");
    if (preset === "parallax" && spreadPlan.length === 0) warnings.push("parallax needs layers at different depths: give spread, or set Z on the layers yourself");

    return A.withUndo(args.label || "Camera rig", function () {
      var created = [];
      var restore = [];
      try {
        var camera = comp.layers.addCamera(name, center);
        created.push(camera);
        fullSpan(camera, comp);
        if (camera.name !== name) camera.name = name;
        if (nodes === "one") camera.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
        else camera.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;

        var opts = child(camera, "ADBE Camera Options Group");
        var zoomP = child(opts, "ADBE Camera Zoom");
        if (!zoomP) fail("unsupported", "The camera has no Zoom property");
        checkLimits(zoomP, zoom, "zoom");
        zoomP.setValue(zoom);

        var tr = child(camera, "ADBE Transform Group");
        var posP = child(tr, "ADBE Position");
        if (!posP) fail("unsupported", "The camera has no Position property");
        posP.setValue([center[0], center[1], -distance]);
        var poiP = poiOf(camera, tr);
        if (nodes === "two") {
          if (poiP) poiP.setValue([center[0], center[1], 0]);
          else warnings.push("The point of interest property was not found; a dolly will pan instead of slide");
        }

        var ctrl = null;
        var expressions = {};
        if (preset !== "static") {
          ctrl = comp.layers.addNull(comp.duration);
          created.push(ctrl);
          fullSpan(ctrl, comp);
          ctrl.name = ctrlName;
          for (var c = 0; c < controls.length; c++) addControl(ctrl, controls[c]);
          if (motion) {
            var kp = ctrl.property("ADBE Effect Parade").property(motion.control).property(1);
            kp.setValueAtTime(motion.start_time, 0);
            kp.setValueAtTime(motion.start_time + motion.duration, motion.amount);
            if (motion.ease) {
              try {
                for (var ki = 1; ki <= 2; ki++) {
                  kp.setTemporalEaseAtKey(ki, [new KeyframeEase(0, 33.3333)], [new KeyframeEase(0, 33.3333)]);
                }
              } catch (eEase) {
                motion.ease = false;
              }
            }
          }
          var posEx = positionExpression(preset, ctrlName);
          posP.expression = posEx;
          expressions.position = posEx;
          var poiEx = poiExpression(preset, ctrlName);
          if (poiEx !== null && nodes === "two" && poiP) {
            poiP.expression = poiEx;
            expressions.point_of_interest = poiEx;
          }
        }

        if (focus) {
          var dofP = child(opts, "ADBE Camera Depth of Field");
          var focusP = child(opts, "ADBE Camera Focus Distance");
          var apP = child(opts, "ADBE Camera Aperture");
          var blurP = child(opts, "ADBE Camera Blur Level");
          if (!dofP || !focusP) fail("unsupported", "The camera has no Depth of Field or Focus Distance property");
          if (focus.distance !== null) checkLimits(focusP, focus.distance, "focus.distance");
          if (focus.aperture !== null && apP) checkLimits(apP, focus.aperture, "focus.aperture");
          if (focus.blur_level !== null && blurP) checkLimits(blurP, focus.blur_level, "focus.blur_level");
          dofP.setValue(1);
          if (focus.distance !== null) focusP.setValue(focus.distance);
          if (focusTarget) {
            var fx = focusExpression(focusTarget.name);
            focusP.expression = fx;
            expressions.focus_distance = fx;
          }
          if (focus.aperture !== null) {
            if (apP) apP.setValue(focus.aperture);
            else warnings.push("This camera has no Aperture property; focus.aperture was not applied");
          }
          if (focus.blur_level !== null) {
            if (blurP) blurP.setValue(focus.blur_level);
            else warnings.push("This camera has no Blur Level property; focus.blur_level was not applied");
          }
        }

        // Last: changes to existing layers, each one undone if a later one throws.
        var spreadOut = [];
        for (var s = 0; s < spreadPlan.length; s++) {
          var sp = spreadPlan[s];
          var layer = sp.layer;
          var ltr = child(layer, "ADBE Transform Group");
          var lpos = child(ltr, "ADBE Position");
          var lsc = child(ltr, "ADBE Scale");
          var was = { layer: layer, three_d: layer.threeDLayer === true, pos: null, scale: null, pos_prop: lpos, scale_prop: lsc };
          restore.push(was);
          layer.threeDLayer = true;
          was.pos = vec(lpos.value, 3, 0);
          was.scale = vec(lsc.value, 3, 100);
          lpos.setValue([was.pos[0], was.pos[1], sp.z]);
          if (sp.scale_set) lsc.setValue([was.scale[0] * sp.factor, was.scale[1] * sp.factor, was.scale[2]]);
          spreadOut.push({ id: layer.id, name: String(layer.name), z: sp.z, scale_factor: sp.factor });
        }

        var result = {
          camera: { id: camera.id, index: camera.index, name: String(camera.name) },
          controller: null,
          preset: preset,
          nodes: nodes,
          zoom: zoom,
          angle_of_view: (2 * Math.atan((comp.width / 2) / zoom)) / DEG,
          distance: distance,
          controls: controls,
          primary_control: primaryControl(preset),
          expressions: expressions,
          spread: spreadOut,
          focus: focus,
          motion: motion,
          warnings: warnings
        };
        if (ctrl) result.controller = { id: ctrl.id, index: ctrl.index, name: String(ctrl.name) };
        return result;
      } catch (err) {
        // Take back what this call did, in this same undo group, so a failure
        // leaves nothing half-built.
        for (var r = restore.length - 1; r >= 0; r--) {
          try {
            if (restore[r].pos !== null) restore[r].pos_prop.setValue(restore[r].pos);
            if (restore[r].scale !== null) restore[r].scale_prop.setValue(restore[r].scale);
          } catch (eRs) {}
          try {
            restore[r].layer.threeDLayer = restore[r].three_d;
          } catch (eRt) {}
        }
        for (var d = created.length - 1; d >= 0; d--) dropLayer(created[d]);
        throw err;
      }
    });
  };
})($.global);
