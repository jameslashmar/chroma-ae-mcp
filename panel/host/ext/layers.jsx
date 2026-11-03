// panel/host/ext/layers.jsx
//
// Host functions for the layer tools:
// - layerStack (read): a comp's layers with kind, parent, 3D, visibility and
//   track matte, and optionally a second comp's (a new precomp)
// - createLayer (guarded write): solid, null, adjustment, text, shape,
//   camera, light, footage or precomp layer, placed in the stack
// - precomposeLayers (guarded write): comp.layers.precompose
// - setTrackMatte (guarded write): AE 23+ setTrackMatte / removeTrackMatte,
//   or the old "layer above" trackMatteType on older AE
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;

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

  function matteTypeName(t) {
    if (t === TrackMatteType.ALPHA) return "alpha";
    if (t === TrackMatteType.ALPHA_INVERTED) return "alpha_inverted";
    if (t === TrackMatteType.LUMA) return "luma";
    if (t === TrackMatteType.LUMA_INVERTED) return "luma_inverted";
    if (t === TrackMatteType.NO_TRACK_MATTE) return "none";
    return String(t);
  }

  function matteTypeValue(name) {
    if (name === "alpha") return TrackMatteType.ALPHA;
    if (name === "alpha_inverted") return TrackMatteType.ALPHA_INVERTED;
    if (name === "luma") return TrackMatteType.LUMA;
    if (name === "luma_inverted") return TrackMatteType.LUMA_INVERTED;
    if (name === "none") return TrackMatteType.NO_TRACK_MATTE;
    fail("bad_args", "Unknown track matte type \"" + name + "\"");
    return null;
  }

  function lightTypeName(t) {
    if (t === LightType.PARALLEL) return "parallel";
    if (t === LightType.SPOT) return "spot";
    if (t === LightType.POINT) return "point";
    if (t === LightType.AMBIENT) return "ambient";
    return String(t);
  }

  function lightTypeValue(name) {
    if (name === "parallel") return LightType.PARALLEL;
    if (name === "spot") return LightType.SPOT;
    if (name === "point") return LightType.POINT;
    if (name === "ambient") return LightType.AMBIENT;
    fail("bad_args", "Unknown light type \"" + name + "\"");
    return null;
  }

  // AE 23 made the matte a layer reference (setTrackMatte); before, the
  // matte was always the layer directly above.
  function hasModernMatteApi(layer) {
    try {
      return layer.setTrackMatte !== undefined && layer.setTrackMatte !== null;
    } catch (e) {
      return false;
    }
  }

  function stackEntry(l) {
    var s = {
      index: l.index,
      id: l.id,
      name: l.name,
      kind: layerKind(l),
      enabled: l.enabled,
      inPoint: l.inPoint,
      outPoint: l.outPoint,
      parent: null
    };
    try { if (l.parent) s.parent = l.parent.index; } catch (e1) {}
    try { s.threeD = l.threeDLayer === true; } catch (e2) {}
    try { s.adjustment = l.adjustmentLayer === true; } catch (e3) {}
    try { if (l.source) s.sourceId = l.source.id; } catch (e4) {}
    try { s.lightType = lightTypeName(l.lightType); } catch (e5) {}
    try {
      var tm = l.trackMatteType;
      if (tm !== undefined) {
        s.trackMatte = { type: matteTypeName(tm), layer: null };
        if (l.trackMatteLayer) {
          s.trackMatte.layer = { index: l.trackMatteLayer.index, id: l.trackMatteLayer.id, name: l.trackMatteLayer.name };
        } else if (tm !== TrackMatteType.NO_TRACK_MATTE && l.index > 1 && !hasModernMatteApi(l)) {
          var above = l.containingComp.layer(l.index - 1);
          s.trackMatte.layer = { index: above.index, id: above.id, name: above.name };
        }
      }
    } catch (e6) {}
    try { s.isTrackMatte = l.isTrackMatte === true; } catch (e7) {}
    if (s.kind === "text") {
      try {
        var t = String(l.property("ADBE Text Properties").property("ADBE Text Document").value.text);
        if (t.length > 200) t = t.substring(0, 200) + " ...[truncated]";
        s.text = t;
      } catch (e8) {}
    }
    return s;
  }

  function stackOf(comp) {
    var layers = [];
    var n = comp.numLayers;
    if (n > MAX_LAYERS) n = MAX_LAYERS;
    for (var i = 1; i <= n; i++) layers.push(stackEntry(comp.layer(i)));
    return {
      comp_id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      numLayers: comp.numLayers,
      layers: layers,
      truncated: comp.numLayers > MAX_LAYERS
    };
  }

  A.layerStack = function (args) {
    var out = stackOf(requireComp(args.comp_id));
    if (args.with_comp_id !== undefined && args.with_comp_id !== null) {
      out.with_comp = stackOf(requireComp(args.with_comp_id));
    }
    return out;
  };

  // The layer the new one goes above, resolved before anything is added
  // (indexes shift once it is).
  function placementTarget(comp, placement) {
    if (!placement) return null;
    if (placement.above) return { how: "before", layer: findLayer(comp, placement.above) };
    if (placement.below) return { how: "after", layer: findLayer(comp, placement.below) };
    if (placement.index !== undefined && placement.index !== null) {
      if (placement.index === 1) return null;
      if (placement.index > comp.numLayers) return { how: "end", layer: null };
      return { how: "before", layer: comp.layer(placement.index) };
    }
    if (placement.bottom === true) return { how: "end", layer: null };
    return null;
  }

  function defaultName(type) {
    if (type === "solid") return "Solid";
    if (type === "null") return "Null";
    if (type === "adjustment") return "Adjustment Layer";
    if (type === "shape") return "Shape Layer";
    if (type === "camera") return "Camera";
    if (type === "light") return "Light";
    return null;
  }

  A.createLayer = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var type = args.type;
    var name = args.name;
    if (name === undefined || name === null) name = defaultName(type);
    var duration = comp.duration;
    if (args.duration !== undefined && args.duration !== null) duration = args.duration;
    var target = placementTarget(comp, args.placement);
    var parent = null;
    if (args.parent) parent = findLayer(comp, args.parent);
    var item = null;
    if (type === "footage" || type === "precomp") {
      try {
        item = app.project.itemByID(args.item_id);
      } catch (eItem) {
        item = null;
      }
      if (!item) fail("not_found", "No project item with id " + args.item_id);
      if (type === "precomp" && !(item instanceof CompItem)) fail("bad_args", "Item " + args.item_id + " is not a composition");
      if (type === "footage" && !(item instanceof FootageItem)) fail("bad_args", "Item " + args.item_id + " is not footage");
      if (item.id === comp.id) fail("bad_args", "A comp can't contain itself");
    }

    return A.withUndo(args.label || "Create layer", function () {
      var layer = null;
      var center = [comp.width / 2, comp.height / 2];
      if (type === "solid" || type === "adjustment") {
        var color = args.color;
        if (!color) color = [1, 1, 1];
        var w = comp.width;
        var h = comp.height;
        if (args.width) w = args.width;
        if (args.height) h = args.height;
        layer = comp.layers.addSolid([color[0], color[1], color[2]], name, w, h, comp.pixelAspect, duration);
        if (type === "adjustment") layer.adjustmentLayer = true;
      } else if (type === "null") {
        layer = comp.layers.addNull(duration);
      } else if (type === "text") {
        var text = "";
        if (args.text !== undefined && args.text !== null) text = String(args.text);
        if (args.box_size) {
          layer = comp.layers.addBoxText([args.box_size[0], args.box_size[1]], text);
        } else {
          layer = comp.layers.addText(text);
        }
      } else if (type === "shape") {
        layer = comp.layers.addShape();
      } else if (type === "camera") {
        layer = comp.layers.addCamera(name, center);
      } else if (type === "light") {
        layer = comp.layers.addLight(name, center);
        if (args.light_type) layer.lightType = lightTypeValue(args.light_type);
      } else if (type === "footage" || type === "precomp") {
        layer = comp.layers.add(item, duration);
      } else {
        fail("bad_args", "Unknown layer type \"" + type + "\"");
      }

      if (name !== null && name !== undefined) layer.name = name;
      if (args.start_time !== undefined && args.start_time !== null) layer.startTime = args.start_time;
      // Text, shape, camera and light layers take the comp's length; trim them.
      if (args.duration !== undefined && args.duration !== null) {
        if (type === "text" || type === "shape" || type === "camera" || type === "light") {
          layer.outPoint = layer.inPoint + args.duration;
        }
      }
      if (args.three_d === true && type !== "camera" && type !== "light") layer.threeDLayer = true;
      if (parent) layer.parent = parent;
      if (target) {
        if (target.how === "before") layer.moveBefore(target.layer);
        else if (target.how === "after") layer.moveAfter(target.layer);
        else layer.moveToEnd();
      }
      var out = { index: layer.index, id: layer.id, name: layer.name, kind: type };
      try { if (layer.source) out.sourceId = layer.source.id; } catch (eSrc) {}
      return out;
    });
  };

  function uniqueCompName(base) {
    var taken = {};
    for (var i = 1; i <= app.project.numItems; i++) taken[app.project.item(i).name] = true;
    for (var n = 1; n < 10000; n++) {
      if (!taken[base + " " + n]) return base + " " + n;
    }
    return base;
  }

  A.precomposeLayers = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var sels = args.layers || [];
    if (sels.length === 0) fail("bad_args", "Give at least one layer to precompose");
    var seen = {};
    var indexes = [];
    var names = [];
    for (var i = 0; i < sels.length; i++) {
      var l = findLayer(comp, sels[i]);
      if (seen[l.index]) continue;
      seen[l.index] = true;
      indexes.push(l.index);
    }
    indexes.sort(function (a, b) { return a - b; });
    for (var j = 0; j < indexes.length; j++) names.push(comp.layer(indexes[j]).name);
    var moveAll = args.move_all_attributes !== false;
    if (!moveAll && indexes.length > 1) {
      fail("bad_args", "Leaving the attributes in the comp works for one layer only (AE's rule); precompose " + indexes.length + " layers with move_all_attributes true");
    }
    var name = args.name;
    if (!name) name = uniqueCompName("Pre-comp");
    return A.withUndo(args.label || "Precompose", function () {
      var created = null;
      try {
        created = comp.layers.precompose(indexes, name, moveAll);
      } catch (e) {
        fail("bad_args", "AE refused to precompose: " + e.message);
      }
      return {
        new_comp_id: created.id,
        new_comp_name: created.name,
        layer_indexes: indexes,
        layer_names: names,
        move_all_attributes: moveAll
      };
    });
  };

  A.setTrackMatte = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    var type = args.type;
    var modern = hasModernMatteApi(layer);
    var matte = null;
    if (type !== "none") {
      matte = findLayer(comp, args.matte);
      if (matte.index === layer.index) fail("bad_args", "A layer can't be its own track matte");
      if (!modern && matte.index !== layer.index - 1) {
        fail(
          "bad_args",
          "This AE (before 23) uses the layer directly above as the matte; move \"" + matte.name + "\" to index " + (layer.index - 1) + " first"
        );
      }
    }
    var value = matteTypeValue(type);
    return A.withUndo(args.label || "Set track matte", function () {
      var previous = null;
      try {
        if (layer.trackMatteLayer) previous = layer.trackMatteLayer;
      } catch (ePrev) {}
      if (!previous && !modern && layer.index > 1 && layer.trackMatteType !== TrackMatteType.NO_TRACK_MATTE) {
        previous = comp.layer(layer.index - 1);
      }
      var out = { layer: { index: layer.index, id: layer.id, name: layer.name }, type: type, api: "legacy" };
      if (modern) out.api = "setTrackMatte";
      if (type === "none") {
        if (modern) layer.removeTrackMatte();
        else layer.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
        if (previous && args.show_matte === true) previous.enabled = true;
        if (previous) out.previous_matte = { index: previous.index, id: previous.id, name: previous.name };
        return out;
      }
      if (modern) layer.setTrackMatte(matte, value);
      else layer.trackMatteType = value;
      if (args.hide_matte !== false) matte.enabled = false;
      out.matte = { index: matte.index, id: matte.id, name: matte.name };
      // AE hands out a new wrapper per lookup, so compare by index.
      if (previous && previous.index !== matte.index) out.previous_matte = { index: previous.index, id: previous.id, name: previous.name };
      return out;
    });
  };
})($.global);
