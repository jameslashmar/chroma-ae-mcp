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
  var MAX_INCLUDE = 50;

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
    if (reflectName === "ThreeDModelLayer") return "model_3d";
    if (reflectName === "ParametricMeshLayer") return "parametric_mesh";
    try {
      if (typeof ThreeDModelLayer !== "undefined" && l instanceof ThreeDModelLayer) return "model_3d";
    } catch (eM1) {}
    try {
      if (typeof ParametricMeshLayer !== "undefined" && l instanceof ParametricMeshLayer) return "parametric_mesh";
    } catch (eM2) {}
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

  function hasEnvironmentLight() {
    try {
      return typeof LightType !== "undefined" && LightType.ENVIRONMENT !== undefined;
    } catch (e) {
      return false;
    }
  }

  function lightTypeName(t) {
    if (t === LightType.PARALLEL) return "parallel";
    if (t === LightType.SPOT) return "spot";
    if (t === LightType.POINT) return "point";
    if (t === LightType.AMBIENT) return "ambient";
    if (hasEnvironmentLight() && t === LightType.ENVIRONMENT) return "environment";
    return null;
  }

  function lightTypeValue(name) {
    if (name === "parallel") return LightType.PARALLEL;
    if (name === "spot") return LightType.SPOT;
    if (name === "point") return LightType.POINT;
    if (name === "ambient") return LightType.AMBIENT;
    if (name === "environment") {
      if (!hasEnvironmentLight()) fail("unsupported", "Environment lights need After Effects 24.3 or later (LightType.ENVIRONMENT is missing here)");
      return LightType.ENVIRONMENT;
    }
    fail("bad_args", "Unknown light type \"" + name + "\"");
    return null;
  }

  // ---------- 3D additions: light options, parametric meshes ----------

  // The Light Options children by the match names the Guide lists; the
  // alternatives cover names that differ between versions. Falloff and radius
  // are not on the Guide's list and are left alone.
  var LIGHT_OPTION_KEYS = ["intensity", "color", "cone_angle", "cone_feather", "casts_shadows", "shadow_darkness", "shadow_diffusion"];
  var LIGHT_OPTION_NAMES = {
    intensity: ["ADBE Light Intensity"],
    color: ["ADBE Light Color"],
    cone_angle: ["ADBE Light Cone Angle"],
    cone_feather: ["ADBE Light Cone Feather 2", "ADBE Light Cone Feather"],
    casts_shadows: ["ADBE Casts Shadows"],
    shadow_darkness: ["ADBE Light Shadow Darkness"],
    shadow_diffusion: ["ADBE Light Shadow Diffusion"]
  };

  // Field names exactly as the ParametricMeshLayer page spells them; "n" is a
  // number, "b" a boolean.
  var MESH_TYPES = ["cube", "sphere", "plane", "torus", "cone", "cylinder"];
  var MESH_FIELDS = {
    cube: { width: "n", height: "n", depth: "n", smoothingAngle: "n" },
    sphere: { radius: "n", sides: "n", sliceCaps: "b", sliceStart: "n", sliceEnd: "n", smoothingAngle: "n" },
    plane: { width: "n", length: "n", cornerRadius: "n", cornerSides: "n" },
    torus: { ringRadius: "n", pipeRadius: "n", ringSides: "n", pipeSides: "n", caps: "b", sliceStart: "n", sliceEnd: "n", smoothingAngle: "n" },
    cone: { topRadius: "n", bottomRadius: "n", height: "n", sides: "n", topCap: "b", bottomCap: "b", sliceCaps: "b", sliceStart: "n", sliceEnd: "n", smoothingAngle: "n" },
    cylinder: { radius: "n", height: "n", sides: "n", topCap: "b", bottomCap: "b", sliceCaps: "b", sliceStart: "n", sliceEnd: "n", smoothingAngle: "n" }
  };
  var MESH_BEVEL_FIELDS = {
    cube: { radius: "n", sides: "n" },
    cone: { topRadius: "n", topSides: "n", bottomRadius: "n", bottomSides: "n" },
    cylinder: { radius: "n", sides: "n" }
  };

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function hasVal(v) {
    return v !== undefined && v !== null;
  }

  // [major, minor] of app.version, or null when it can't be read.
  function aeVersion() {
    try {
      var parts = String(app.version).split(".");
      var major = parseInt(parts[0], 10);
      var minor = 0;
      if (parts.length > 1) minor = parseInt(parts[1], 10);
      if (isNaN(major)) return null;
      if (isNaN(minor)) minor = 0;
      return [major, minor];
    } catch (e) {
      return null;
    }
  }

  function versionBefore(major, minor) {
    var v = aeVersion();
    if (v === null) return false;
    if (v[0] !== major) return v[0] < major;
    return v[1] < minor;
  }

  function meshEnumValue(typeName) {
    if (typeof ParametricMeshType === "undefined") return undefined;
    try {
      return ParametricMeshType[typeName.toUpperCase()];
    } catch (e) {
      return undefined;
    }
  }

  function meshTypeNameOf(value) {
    for (var i = 0; i < MESH_TYPES.length; i++) {
      var ev = meshEnumValue(MESH_TYPES[i]);
      if (ev !== undefined && ev === value) return MESH_TYPES[i];
    }
    return null;
  }

  function firstProp(group, names) {
    if (!group) return null;
    for (var i = 0; i < names.length; i++) {
      try {
        var p = group.property(names[i]);
        if (p) return p;
      } catch (e) {}
    }
    return null;
  }

  function lightOptionsGroup(l) {
    try {
      return l.property("ADBE Light Options Group");
    } catch (e) {
      return null;
    }
  }

  // What a light's options read now (keys whose property is missing are left out).
  function readLightOptions(l) {
    var out = {};
    var g = lightOptionsGroup(l);
    if (!g) return out;
    for (var i = 0; i < LIGHT_OPTION_KEYS.length; i++) {
      var key = LIGHT_OPTION_KEYS[i];
      var p = firstProp(g, LIGHT_OPTION_NAMES[key]);
      if (!p) continue;
      try {
        var v = p.value;
        if (key === "color") {
          if (v && typeof v.length === "number") out.color = [v[0], v[1], v[2]];
        } else if (key === "casts_shadows") {
          out.casts_shadows = v === true || (typeof v === "number" && v >= 0.5);
        } else if (isNum(v)) {
          out[key] = v;
        }
      } catch (e2) {}
    }
    return out;
  }

  function readMesh(l) {
    var out = { type: null, options: {}, bevel: {} };
    var tn = null;
    try {
      tn = meshTypeNameOf(l.parametricMeshType);
    } catch (e0) {}
    out.type = tn;
    if (tn === null) return out;
    var k;
    try {
      var o = l.parametricMeshOptions;
      if (o) {
        for (k in MESH_FIELDS[tn]) {
          if (MESH_FIELDS[tn].hasOwnProperty(k) && o[k] !== undefined) out.options[k] = o[k];
        }
      }
    } catch (e1) {}
    if (MESH_BEVEL_FIELDS[tn]) {
      try {
        var b = l.parametricBevelOptions;
        if (b) {
          for (k in MESH_BEVEL_FIELDS[tn]) {
            if (MESH_BEVEL_FIELDS[tn].hasOwnProperty(k) && b[k] !== undefined) out.bevel[k] = b[k];
          }
        }
      } catch (e2) {}
    }
    return out;
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

  // true / false when the comp's renderer can be read, null when it can't.
  function rendererIsAdvanced(comp) {
    var r = "";
    try {
      r = String(comp.renderer).toLowerCase();
    } catch (e) {
      return null;
    }
    if (r === "" || r === "undefined") return null;
    // Only "ADBE Calder" is Advanced 3D; "ADBE Advanced 3d" is the Classic 3D renderer.
    return r.indexOf("calder") >= 0;
  }

  function layerById(comp, id) {
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).id === id) return comp.layer(i);
    }
    return null;
  }

  // Checks the options a light type allows, before anything is added.
  function planLightOptions(lightName, opts) {
    var plan = {};
    if (!hasVal(opts)) return plan;
    if (typeof opts !== "object") fail("bad_args", "light_options must be an object");
    var k;
    var allowed = {};
    for (var a = 0; a < LIGHT_OPTION_KEYS.length; a++) allowed[LIGHT_OPTION_KEYS[a]] = true;
    for (k in opts) {
      if (opts.hasOwnProperty(k) && opts[k] !== undefined && !allowed[k]) fail("bad_args", "Unknown light option \"" + k + "\"");
    }
    var ln = lightName;
    if (!ln) ln = "point";
    var cone = ln === "spot";
    var shadows = ln === "spot" || ln === "point" || ln === "parallel" || ln === "environment";
    for (var i = 0; i < LIGHT_OPTION_KEYS.length; i++) {
      var key = LIGHT_OPTION_KEYS[i];
      var v = opts[key];
      if (v === undefined || v === null) continue;
      if (key === "color") {
        if (typeof v.length !== "number" || v.length !== 3) fail("bad_args", "light_options.color must be [r, g, b]");
        for (var c = 0; c < 3; c++) {
          if (!isNum(v[c]) || v[c] < 0 || v[c] > 1) fail("bad_args", "light_options.color values must be numbers in 0..1");
        }
      } else if (key === "casts_shadows") {
        if (typeof v !== "boolean") fail("bad_args", "light_options.casts_shadows must be true or false");
      } else if (!isNum(v)) {
        fail("bad_args", "light_options." + key + " must be a number");
      }
      if ((key === "cone_angle" || key === "cone_feather") && !cone) fail("bad_args", "light_options." + key + " applies to spot lights only (this is a " + ln + " light)");
      if ((key === "casts_shadows" || key === "shadow_darkness" || key === "shadow_diffusion") && !shadows) {
        fail("bad_args", "light_options." + key + " applies to spot, point, parallel and environment lights only (this is a " + ln + " light)");
      }
      plan[key] = v;
    }
    return plan;
  }

  // Checks a mesh request against the type's field table, before anything is added.
  function planMesh(args) {
    var tn = args.mesh_type;
    if (typeof tn !== "string" || !MESH_FIELDS[tn]) fail("bad_args", "mesh_type must be one of " + MESH_TYPES.join(", "));
    var plan = { type: tn, options: {}, bevel: {} };
    var k;
    var sets = [
      ["mesh_options", args.mesh_options, MESH_FIELDS[tn], plan.options],
      ["bevel_options", args.bevel_options, MESH_BEVEL_FIELDS[tn], plan.bevel]
    ];
    for (var s = 0; s < sets.length; s++) {
      var label = sets[s][0];
      var given = sets[s][1];
      var table = sets[s][2];
      if (!hasVal(given)) continue;
      if (typeof given !== "object") fail("bad_args", label + " must be an object");
      var any = false;
      for (k in given) {
        if (given.hasOwnProperty(k) && given[k] !== undefined) any = true;
      }
      if (any && !table) fail("bad_args", "A " + tn + " has no bevel options");
      for (k in given) {
        if (!given.hasOwnProperty(k) || given[k] === undefined) continue;
        if (!table[k]) fail("bad_args", label + " has no field \"" + k + "\" for a " + tn);
        if (table[k] === "n" && !isNum(given[k])) fail("bad_args", label + "." + k + " must be a number");
        if (table[k] === "b" && typeof given[k] !== "boolean") fail("bad_args", label + "." + k + " must be true or false");
        sets[s][3][k] = given[k];
      }
    }
    return plan;
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
    // Only lights have a lightType; elsewhere the read gives undefined.
    if (s.kind === "light") {
      try {
        var lt = lightTypeName(l.lightType);
        if (lt !== null) s.lightType = lt;
      } catch (e5) {}
      // lightSource and the light options are read here: ae_set_property can't reach the source.
      try {
        var lsrc = l.lightSource;
        if (lsrc) s.lightSource = { index: lsrc.index, id: lsrc.id, name: lsrc.name };
        else if (lsrc === null) s.lightSource = null;
      } catch (e5b) {}
      s.lightOptions = readLightOptions(l);
    }
    if (s.kind === "parametric_mesh") {
      s.mesh = readMesh(l);
    }
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
      try {
        var td = l.property("ADBE Text Properties").property("ADBE Text Document").value;
        if (td.font !== undefined) s.font = String(td.font);
        if (td.fontObject && td.fontObject.isSubstitute !== undefined) s.fontIsSubstitute = td.fontObject.isSubstitute === true;
      } catch (e8b) {}
    }
    return s;
  }

  // A list of numbers from args, bounded, for include_ids / include_indexes.
  function numberList(v) {
    var out = [];
    if (!v || typeof v.length !== "number") return out;
    for (var i = 0; i < v.length && out.length < MAX_INCLUDE; i++) {
      if (typeof v[i] === "number" && isFinite(v[i])) out.push(v[i]);
    }
    return out;
  }

  // The layers past the cap that the caller asked for by id or index, so a
  // read-back can still find a layer created or changed at the bottom of a
  // big comp.
  function includedBeyondCap(comp, include) {
    var extra = [];
    var total = comp.numLayers;
    if (total <= MAX_LAYERS || !include) return extra;
    var wantIds = numberList(include.ids);
    var wantIndexes = numberList(include.indexes);
    var picked = {};
    var i;
    for (i = 0; i < wantIndexes.length; i++) {
      if (wantIndexes[i] > MAX_LAYERS && wantIndexes[i] <= total) picked[wantIndexes[i]] = true;
    }
    if (wantIds.length > 0) {
      for (i = MAX_LAYERS + 1; i <= total; i++) {
        var lid = comp.layer(i).id;
        for (var k = 0; k < wantIds.length; k++) {
          if (wantIds[k] === lid) picked[i] = true;
        }
      }
    }
    for (i = MAX_LAYERS + 1; i <= total; i++) {
      if (picked[i]) extra.push(stackEntry(comp.layer(i)));
    }
    return extra;
  }

  function stackOf(comp, include) {
    var layers = [];
    var n = comp.numLayers;
    if (n > MAX_LAYERS) n = MAX_LAYERS;
    for (var i = 1; i <= n; i++) layers.push(stackEntry(comp.layer(i)));
    var extra = includedBeyondCap(comp, include);
    for (var e = 0; e < extra.length; e++) layers.push(extra[e]);
    return {
      comp_id: comp.id,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      frameDuration: comp.frameDuration,
      numLayers: comp.numLayers,
      layers: layers,
      truncated: comp.numLayers > MAX_LAYERS
    };
  }

  A.layerStack = function (args) {
    // include_ids / include_indexes: layers past the 500 cap to list as well.
    var out = stackOf(requireComp(args.comp_id), { ids: args.include_ids, indexes: args.include_indexes });
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
    // Everything that can fail is checked here, before anything is added.
    var knownTypes = { solid: 1, "null": 1, adjustment: 1, text: 1, shape: 1, camera: 1, light: 1, footage: 1, precomp: 1, mesh: 1 };
    if (typeof type !== "string" || knownTypes[type] !== 1) fail("bad_args", "Unknown layer type \"" + type + "\"");
    var warnings = [];
    if (type === "mesh" && (name === undefined || name === null) && typeof args.mesh_type === "string" && args.mesh_type.length > 0) {
      name = args.mesh_type.charAt(0).toUpperCase() + args.mesh_type.substring(1);
    }
    if (type !== "mesh" && (hasVal(args.mesh_type) || hasVal(args.mesh_options) || hasVal(args.bevel_options))) fail("bad_args", "mesh_type, mesh_options and bevel_options apply to mesh layers only");
    if (type !== "light" && (hasVal(args.light_source) || hasVal(args.light_options))) fail("bad_args", "light_source and light_options apply to light layers only");
    if (type !== "text" && (hasVal(args.orientation) || hasVal(args.font))) fail("bad_args", "orientation and font apply to text layers only");
    if (name !== null && name !== undefined && (typeof name !== "string" || name.length > 200)) fail("bad_args", "name must be a string of at most 200 characters");
    if (args.duration !== undefined && args.duration !== null) {
      if (typeof args.duration !== "number" || !isFinite(args.duration) || args.duration <= 0) fail("bad_args", "duration must be a positive number of seconds");
    }
    if (args.start_time !== undefined && args.start_time !== null) {
      if (typeof args.start_time !== "number" || !isFinite(args.start_time)) fail("bad_args", "start_time must be a number of seconds");
    }
    if (args.color !== undefined && args.color !== null) {
      if (typeof args.color.length !== "number" || args.color.length !== 3) fail("bad_args", "color must be [r, g, b]");
      for (var ci = 0; ci < 3; ci++) {
        if (typeof args.color[ci] !== "number" || !isFinite(args.color[ci]) || args.color[ci] < 0 || args.color[ci] > 1) fail("bad_args", "color values must be numbers in 0..1");
      }
    }
    var sizeKeys = ["width", "height"];
    for (var si = 0; si < sizeKeys.length; si++) {
      var sz = args[sizeKeys[si]];
      if (sz !== undefined && sz !== null && (typeof sz !== "number" || !isFinite(sz) || sz < 1 || sz > 30000)) fail("bad_args", sizeKeys[si] + " must be a number in 1..30000");
    }
    if (args.text !== undefined && args.text !== null && String(args.text).length > 20000) fail("bad_args", "text is longer than 20000 characters");
    if (args.box_size) {
      if (typeof args.box_size.length !== "number" || args.box_size.length !== 2 || typeof args.box_size[0] !== "number" || typeof args.box_size[1] !== "number" || !(args.box_size[0] > 0) || !(args.box_size[1] > 0)) {
        fail("bad_args", "box_size must be [width, height] above 0");
      }
    }
    var lightValue = null;
    if (type === "light" && args.light_type) lightValue = lightTypeValue(args.light_type);
    // Light options are checked against a point light when no type is given, so the light is made a point light.
    else if (type === "light" && hasVal(args.light_options)) lightValue = lightTypeValue("point");
    var lightPlan = {};
    var lightSourceId = null;
    if (type === "light") {
      lightPlan = planLightOptions(args.light_type, args.light_options);
      if (hasVal(args.light_source) && args.light_type !== "environment") fail("bad_args", "light_source applies to environment lights only");
      if (args.light_type === "environment") {
        var src = null;
        if (hasVal(args.light_source)) src = findLayer(comp, args.light_source);
        if (src) {
          var srcKind = layerKind(src);
          if (srcKind === "text" || srcKind === "shape" || srcKind === "null" || srcKind === "adjustment" || srcKind === "model_3d" || srcKind === "parametric_mesh") {
            var srcArticle = "a ";
            if (srcKind === "adjustment") srcArticle = "an ";
            fail("bad_args", "\"" + src.name + "\" is " + srcArticle + srcKind + " layer; an environment light source must be a 2D video, still or precomp layer");
          }
          if (srcKind === "camera" || srcKind === "light" || srcKind === "audio") fail("bad_args", "\"" + src.name + "\" is a " + srcKind + " layer and can't be an environment light source");
          var srcIs3d = false;
          try { srcIs3d = src.threeDLayer === true; } catch (eS3) {}
          if (srcIs3d) fail("bad_args", "\"" + src.name + "\" is a 3D layer; an environment light source must be a 2D layer in the same comp (AE answers 'Invalid light source specified')");
          if (versionBefore(25, 2)) {
            // 24.3 to 25.1 take HDR and EXR footage layers only.
            var srcFile = "";
            try { srcFile = String(src.source.mainSource.file.name).toLowerCase(); } catch (eSf) {}
            if (!/\.(hdr|exr)$/.test(srcFile)) fail("bad_args", "This After Effects (before 25.2) takes only an HDR or EXR footage layer as an environment light source; \"" + src.name + "\" is not one");
          }
          lightSourceId = src.id;
        } else {
          warnings.push("No light_source was given, so the environment light has no image to light the scene with");
        }
        if (rendererIsAdvanced(comp) === false) {
          warnings.push("The comp's renderer (" + String(comp.renderer) + ") is not Advanced 3D; environment lights are likely to render only there. Check the 3D Renderer tab of Composition Settings.");
        }
      }
    }
    var meshPlan = null;
    if (type === "mesh") {
      if (!hasVal(args.mesh_type)) fail("bad_args", "mesh layers need mesh_type");
      if (typeof comp.layers.addParametricMesh !== "function") fail("unsupported", "Parametric mesh layers need After Effects 26.3 (comp.layers.addParametricMesh is missing here)");
      meshPlan = planMesh(args);
      if (meshEnumValue(meshPlan.type) === undefined) fail("unsupported", "ParametricMeshType." + meshPlan.type.toUpperCase() + " is missing in this After Effects");
    }
    var orientation = "horizontal";
    if (hasVal(args.orientation)) orientation = args.orientation;
    if (orientation !== "horizontal" && orientation !== "vertical") fail("bad_args", "orientation must be horizontal or vertical");
    if (orientation === "vertical") {
      if (args.box_size) {
        if (typeof comp.layers.addVerticalBoxText !== "function") fail("unsupported", "Vertical box text needs After Effects 24.2 (addVerticalBoxText is missing here)");
      } else if (typeof comp.layers.addVerticalText !== "function") {
        fail("unsupported", "Vertical text needs After Effects 24.2 (addVerticalText is missing here)");
      }
    }
    var fontPS = null;
    var fontInfo = null;
    if (hasVal(args.font)) {
      var spec = null;
      if (typeof args.font === "string") spec = { postscript: args.font };
      else if (typeof args.font === "object" && typeof args.font.family === "string" && typeof args.font.style === "string") spec = { family: args.font.family, style: args.font.style };
      else fail("bad_args", "font must be a PostScript name or {family, style}");
      if (typeof A.fontsResolve === "function") {
        var fr = A.fontsResolve(spec);
        if (fr.unchecked === true) {
          if (!spec.postscript) fail("bad_args", "This After Effects can't look up a font by family and style; give the PostScript name");
          fontPS = spec.postscript;
          warnings.push(fr.reason);
        } else if (fr.ok !== true) {
          var why = "Font not usable";
          if (fr.reason) why = String(fr.reason);
          fail("bad_args", why);
        } else {
          fontPS = fr.font.postscript;
          fontInfo = fr.font;
          if (fr.duplicates > 0) warnings.push((fr.duplicates + 1) + " installed fonts share this name; the first was used");
        }
      } else if (spec.postscript) {
        fontPS = spec.postscript;
        warnings.push("The font name was not checked (fontsResolve is not loaded)");
      } else {
        fail("bad_args", "The font lookup is not loaded; give the PostScript name");
      }
      if (!fontPS) fail("bad_args", "The font has no PostScript name to set");
    }
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
      // An audio-only layer has no 3D switch.
      if (type === "footage" && args.three_d === true) {
        var hasVideo = true;
        try { hasVideo = item.hasVideo; } catch (eHv) {}
        if (hasVideo === false) fail("bad_args", "Item " + args.item_id + " has no video, so its layer can't be 3D");
      }
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
          if (orientation === "vertical") layer = comp.layers.addVerticalBoxText([args.box_size[0], args.box_size[1]], text);
          else layer = comp.layers.addBoxText([args.box_size[0], args.box_size[1]], text);
        } else if (orientation === "vertical") {
          layer = comp.layers.addVerticalText(text);
        } else {
          layer = comp.layers.addText(text);
        }
      } else if (type === "mesh") {
        layer = comp.layers.addParametricMesh(name, meshEnumValue(meshPlan.type));
      } else if (type === "shape") {
        layer = comp.layers.addShape();
      } else if (type === "camera") {
        layer = comp.layers.addCamera(name, center);
      } else if (type === "light") {
        layer = comp.layers.addLight(name, center);
      } else if (type === "footage" || type === "precomp") {
        layer = comp.layers.add(item, duration);
      }

      // The layer exists from here: if a step below throws, take it (and the
      // solid item it added) back out in this same undo group, so a failed
      // call leaves nothing half-built.
      var out = null;
      var lightApplied = [];
      var lightSkipped = [];
      var meshWarnings = [];
      try {
        if (type === "light" && lightValue !== null) layer.lightType = lightValue;
        if (type === "light" && lightSourceId !== null) {
          var srcLayer = layerById(comp, lightSourceId);
          if (!srcLayer) fail("not_found", "The environment light source layer is gone");
          layer.lightSource = srcLayer;
        }
        if (type === "light") {
          var optGroup = lightOptionsGroup(layer);
          for (var li = 0; li < LIGHT_OPTION_KEYS.length; li++) {
            var lkey = LIGHT_OPTION_KEYS[li];
            if (lightPlan[lkey] === undefined) continue;
            var lprop = firstProp(optGroup, LIGHT_OPTION_NAMES[lkey]);
            if (!lprop) {
              lightSkipped.push(lkey);
              continue;
            }
            var lval = lightPlan[lkey];
            if (lkey === "color") {
              lprop.setValue([lval[0], lval[1], lval[2], 1]);
            } else if (lkey === "casts_shadows") {
              if (lval) lprop.setValue(1);
              else lprop.setValue(0);
            } else {
              checkLimits(lprop, lval, "light_options." + lkey);
              lprop.setValue(lval);
            }
            lightApplied.push(lkey);
          }
          if (lightSkipped.length > 0) warnings.push("These light options were not found on this light and were not applied: " + lightSkipped.join(", "));
        }
        if (type === "mesh") {
          var mk;
          var haveOpts = false;
          for (mk in meshPlan.options) {
            if (meshPlan.options.hasOwnProperty(mk)) haveOpts = true;
          }
          if (haveOpts) {
            // The options object is read, changed and assigned back whole.
            var mo = layer.parametricMeshOptions;
            for (mk in meshPlan.options) {
              if (meshPlan.options.hasOwnProperty(mk)) mo[mk] = meshPlan.options[mk];
            }
            try {
              layer.parametricMeshOptions = mo;
            } catch (eMo) {
              meshWarnings.push("Assigning the mesh options back failed (" + eMo.message + "); check the read-back");
            }
          }
          var haveBevel = false;
          for (mk in meshPlan.bevel) {
            if (meshPlan.bevel.hasOwnProperty(mk)) haveBevel = true;
          }
          if (haveBevel) {
            var mb = layer.parametricBevelOptions;
            for (mk in meshPlan.bevel) {
              if (meshPlan.bevel.hasOwnProperty(mk)) mb[mk] = meshPlan.bevel[mk];
            }
            try {
              layer.parametricBevelOptions = mb;
            } catch (eMb) {
              meshWarnings.push("Assigning the bevel options back failed (" + eMb.message + "); check the read-back");
            }
          }
        }
        if (type === "text" && fontPS !== null) {
          var docProp = layer.property("ADBE Text Properties").property("ADBE Text Document");
          var doc = docProp.value;
          doc.font = fontPS;
          docProp.setValue(doc);
        }
        if (name !== null && name !== undefined) layer.name = name;
        if (args.start_time !== undefined && args.start_time !== null) layer.startTime = args.start_time;
        if (args.duration !== undefined && args.duration !== null) {
          if (type === "text" || type === "shape" || type === "camera" || type === "light" || type === "mesh") {
            // These take the comp's length; trim them.
            layer.outPoint = layer.inPoint + args.duration;
          } else if (type === "footage" || type === "precomp") {
            // add() sizes stills only; trim video and comps. They can't be
            // lengthened past their source, so this only shortens.
            var wantOut = layer.inPoint + args.duration;
            if (wantOut < layer.outPoint) layer.outPoint = wantOut;
          }
        }
        if (args.three_d === true && type !== "camera" && type !== "light") {
          var alreadyThreeD = false;
          try { alreadyThreeD = layer.threeDLayer === true; } catch (eT) {}
          if (!alreadyThreeD) layer.threeDLayer = true;
        }
        if (parent) layer.parent = parent;
        if (target) {
          if (target.how === "before") layer.moveBefore(target.layer);
          else if (target.how === "after") layer.moveAfter(target.layer);
          else layer.moveToEnd();
        }
      } catch (ePost) {
        var madeSource = null;
        // Solids, adjustment layers and nulls each add a solid item to the project.
        if (type === "solid" || type === "adjustment" || type === "null") {
          try { madeSource = layer.source; } catch (eMs) {}
        }
        try { layer.remove(); } catch (eRm) {}
        try {
          if (madeSource && madeSource.usedIn.length === 0) madeSource.remove();
        } catch (eRs) {}
        throw ePost;
      }
      out = { index: layer.index, id: layer.id, name: layer.name, kind: type };
      try { if (layer.source) out.sourceId = layer.source.id; } catch (eSrc) {}
      if (type === "light") {
        out.light_options_applied = lightApplied;
        out.light_options_skipped = lightSkipped;
        if (lightSourceId !== null) out.light_source_id = lightSourceId;
      }
      if (type === "mesh") out.mesh_type = meshPlan.type;
      if (type === "text") {
        out.orientation = orientation;
        if (fontPS !== null) out.font = { postscript: fontPS, family: fontInfo ? fontInfo.family : undefined, style: fontInfo ? fontInfo.style : undefined };
      }
      for (var wi = 0; wi < meshWarnings.length; wi++) warnings.push(meshWarnings[wi]);
      out.warnings = warnings;
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
    // setTrackMatte / trackMatteType belong to AV layers; cameras and lights have neither.
    var layerK = layerKind(layer);
    if (layerK === "camera" || layerK === "light") {
      fail("bad_args", "Track mattes apply to AV layers only; \"" + layer.name + "\" is a " + layerK + " layer");
    }
    var modern = hasModernMatteApi(layer);
    var matte = null;
    if (type !== "none") {
      matte = findLayer(comp, args.matte);
      var matteK = layerKind(matte);
      if (matteK === "camera" || matteK === "light") fail("bad_args", "A " + matteK + " layer can't be a track matte");
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
