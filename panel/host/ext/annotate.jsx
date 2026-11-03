// panel/host/ext/annotate.jsx
//
// Host function for ae_annotate_frame:
// - annotateRead (read): every layer's transform values, source rect, parent,
//   3D flag, visibility and selection at one time, plus the camera, in a
//   single evalScript. The outlines are worked out on the Node side from
//   these numbers; the frame itself is rendered by snapshotFrame in a
//   separate call.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Read only. valueAtTime and sourceRectAtTime take a time argument and do
//   not move the time indicator; nothing here changes time, selection,
//   resolutionFactor or solo, since any of those lands on the undo stack.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var MAX_NAME = 200;

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

  function layerKind(l) {
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

  // A property's post-expression value at t, or null when it is missing or unreadable.
  function valueAt(p, t) {
    if (!p) return null;
    try {
      return p.valueAtTime(t, false);
    } catch (e) {
      return null;
    }
  }

  // n numbers from a scalar or array value; missing entries take `fill`.
  function vec(v, n, fill) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var x = fill;
      if (v !== null && v !== undefined) {
        if (typeof v === "number") {
          if (i === 0) x = v;
        } else if (typeof v[i] === "number") {
          x = v[i];
        }
      }
      if (x !== x) x = fill;
      out.push(x);
    }
    return out;
  }

  function scalar(v, fill) {
    if (typeof v === "number" && v === v) return v;
    return fill;
  }

  function readTransform(l, t) {
    var tr = child(l, "ADBE Transform Group");
    if (!tr) return null;
    var out = {
      anchor: vec(valueAt(child(tr, "ADBE Anchor Point"), t), 3, 0),
      position: vec(valueAt(child(tr, "ADBE Position"), t), 3, 0),
      scale: vec(valueAt(child(tr, "ADBE Scale"), t), 3, 100),
      rotation_z: scalar(valueAt(child(tr, "ADBE Rotate Z"), t), 0),
      orientation: vec(valueAt(child(tr, "ADBE Orientation"), t), 3, 0),
      rotation_x: scalar(valueAt(child(tr, "ADBE Rotate X"), t), 0),
      rotation_y: scalar(valueAt(child(tr, "ADBE Rotate Y"), t), 0),
      point_of_interest: null
    };
    var poi = child(tr, "ADBE Point of Interest");
    if (poi) out.point_of_interest = vec(valueAt(poi, t), 3, 0);
    return out;
  }

  function readLayer(l, t, includeExtents, soloAny, selected) {
    var kind = layerKind(l);
    var name = String(l.name);
    if (name.length > MAX_NAME) name = name.substring(0, MAX_NAME);
    var o = {
      index: l.index,
      id: l.id,
      name: name,
      kind: kind,
      enabled: l.enabled === true,
      solo: false,
      selected: selected[l.id] === true,
      three_d: false,
      parent_id: null,
      in_point: l.inPoint,
      out_point: l.outPoint,
      visible: false,
      guide: false,
      active_at_time: null,
      rect: null,
      skip_reason: null,
      transform: null
    };
    try {
      o.solo = l.solo === true;
    } catch (e0) {}
    if (kind === "camera" || kind === "light") {
      o.three_d = true;
    } else {
      try {
        o.three_d = l.threeDLayer === true;
      } catch (e1) {}
    }
    try {
      if (l.parent) o.parent_id = l.parent.id;
    } catch (e2) {}
    var hasVideo = true;
    try {
      if (l.hasVideo === false) hasVideo = false;
    } catch (e3) {}
    try {
      o.guide = l.guideLayer === true;
    } catch (eg) {}
    // Guide layers do not render, so they are not "visible" in the frame.
    o.visible = o.enabled && hasVideo && !o.guide && t >= l.inPoint && t < l.outPoint && (!soloAny || o.solo);
    try {
      o.active_at_time = l.activeAtTime(t) === true;
    } catch (e4) {
      o.active_at_time = null;
    }
    o.transform = readTransform(l, t);
    if (o.transform === null) o.skip_reason = "no transform group";

    if (kind === "camera" || kind === "light") {
      o.skip_reason = "cameras and lights have no picture";
    } else if (!hasVideo) {
      o.skip_reason = "no video";
    } else if (o.skip_reason === null) {
      try {
        var r = l.sourceRectAtTime(t, includeExtents === true);
        o.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      } catch (e5) {
        o.skip_reason = "sourceRectAtTime failed: " + String(e5.message || e5);
      }
    }
    if (kind === "camera") {
      var opts = child(l, "ADBE Camera Options Group");
      var zoom = valueAt(child(opts, "ADBE Camera Zoom"), t);
      var hasPoi = o.transform !== null && o.transform.point_of_interest !== null;
      var twoNode = hasPoi;
      try {
        if (hasPoi && typeof AutoOrientType !== "undefined") {
          twoNode = l.autoOrient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
        }
      } catch (e6) {}
      o.camera = { zoom: typeof zoom === "number" ? zoom : null, two_node: twoNode };
    }
    return o;
  }

  // args: { comp_id, time, include_extents }. Returns the layers (up to 500)
  // with what the Node side needs to place their outlines at `time`.
  A.annotateRead = function (args) {
    var c = requireComp(args.comp_id);
    var t = scalar(args.time, 0);
    var last = c.duration - c.frameDuration;
    if (t > last) t = last;
    if (t < 0) t = 0;

    var selected = {};
    try {
      var sel = c.selectedLayers;
      for (var si = 0; si < sel.length; si++) selected[sel[si].id] = true;
    } catch (e0) {}

    var soloAny = false;
    var n = c.numLayers;
    var i;
    for (i = 1; i <= n; i++) {
      try {
        var sl = c.layer(i);
        if (sl.solo === true) {
          // Solo only hides layers of the same kind: a soloed camera, light or
          // audio-only layer does not hide the picture layers.
          var slKind = layerKind(sl);
          var slVideo = true;
          try {
            if (sl.hasVideo === false) slVideo = false;
          } catch (eh) {}
          if (slKind !== "camera" && slKind !== "light" && slVideo) {
            soloAny = true;
            break;
          }
        }
      } catch (e1) {}
    }

    var layers = [];
    var activeCam = null;
    for (i = 1; i <= n && layers.length < MAX_LAYERS; i++) {
      var l = c.layer(i);
      var o = readLayer(l, t, args.include_extents === true, soloAny, selected);
      if (o.kind === "camera" && activeCam === null && o.enabled && t >= o.in_point && t < o.out_point) {
        activeCam = o.id;
      }
      layers.push(o);
    }
    // A camera past the 500th layer can still be the active one.
    for (i = layers.length + 1; i <= n && activeCam === null; i++) {
      var more = c.layer(i);
      if (layerKind(more) === "camera" && more.enabled && t >= more.inPoint && t < more.outPoint) activeCam = more.id;
    }

    var compCam = null;
    try {
      if (c.activeCamera) compCam = c.activeCamera.id;
    } catch (e2) {}
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
        pixel_aspect: c.pixelAspect,
        fps: c.frameRate,
        duration: c.duration,
        resolution_factor: res
      },
      time: t,
      layers: layers,
      total_layers: n,
      truncated: n > layers.length,
      active_camera_id: activeCam,
      comp_active_camera_id: compCam,
      solo_active: soloAny
    };
  };
})($.global);
