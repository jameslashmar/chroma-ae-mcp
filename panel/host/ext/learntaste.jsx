// panel/host/ext/learntaste.jsx
//
// Host function for the taste-learning tools (ae_taste_baseline, ae_learn_taste):
// - learntasteRead (read): what a person edits after the agent finishes, in one
//   compact shape: per layer the in/out points and start time, the transform
//   properties (static value, or every key with its time, value, temporal ease
//   speed and influence, and interpolation type) and, for text layers, the font
//   size and fill colour. The server keeps one of these as the baseline after
//   the agent's work and diffs a later one against it.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Read only: it sets nothing, so it never lands on the user's undo stack and needs no guard.
// - Bounded: 500 layers, 200 keys per property, 20000 keys in all, 3000 properties; `truncated` says when a cap hit.
// - A property with separated dimensions is marked `separated` and carries no value or keys: its
//   .value would be the value at the comp's current time, which moves with the playhead. Position
//   is then read through its follower properties (ADBE Position_0 / _1 / _2) as position_x,
//   position_y and position_z, each a plain property with its own value or keys.
// - Values read here are the stored ones: an expression's result is not, and `expr` marks it.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var MAX_KEYS = 200;
  var MAX_PROPS = 3000;
  var MAX_TOTAL_KEYS = 20000;
  var MAX_STRING = 200;
  var PRECISION = 10000;

  // Transform properties by match name, and the short kind the server diffs on.
  var TRANSFORM_PROPS = [
    ["ADBE Anchor Point", "anchor"],
    ["ADBE Position", "position"],
    ["ADBE Scale", "scale"],
    ["ADBE Rotate Z", "rotation"],
    ["ADBE Opacity", "opacity"]
  ];

  function fail(kind, message) {
    var e = new Error(message);
    e.__kind = kind;
    throw e;
  }

  function roundNum(n) {
    if (typeof n !== "number") return n;
    if (isNaN(n) || !isFinite(n)) return null;
    return Math.round(n * PRECISION) / PRECISION;
  }

  function plainValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return roundNum(v);
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v;
    var out = [];
    try {
      var n = v.length;
      if (typeof n === "number") {
        if (n > 4) n = 4;
        for (var i = 0; i < n; i++) out.push(roundNum(v[i]));
        return out;
      }
    } catch (e) {}
    return null;
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
    var name = "";
    try {
      if (l.reflect && l.reflect.name) name = String(l.reflect.name);
    } catch (e0) {}
    if (name === "TextLayer") return "text";
    if (name === "ShapeLayer") return "shape";
    if (name === "CameraLayer") return "camera";
    if (name === "LightLayer") return "light";
    if (name === "ThreeDModelLayer") return "model_3d";
    if (name === "ParametricMeshLayer") return "parametric_mesh";
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
      if (l.source && l.source instanceof CompItem) return "precomp";
    } catch (e2) {}
    return "av";
  }

  function interpName(t) {
    if (t === KeyframeInterpolationType.LINEAR) return "linear";
    if (t === KeyframeInterpolationType.BEZIER) return "bezier";
    if (t === KeyframeInterpolationType.HOLD) return "hold";
    return "other";
  }

  // A key's temporal ease as [{s: speed, i: influence}], one entry per dimension (at most three).
  function easeList(list) {
    var out = [];
    try {
      var n = list.length;
      if (n > 3) n = 3;
      for (var i = 0; i < n; i++) out.push({ s: roundNum(list[i].speed), i: roundNum(list[i].influence) });
    } catch (e) {}
    return out;
  }

  function readProp(prop, kind, state) {
    if (state.props >= MAX_PROPS) {
      state.truncated = true;
      return null;
    }
    state.props += 1;
    var out = { kind: kind, value: null, keys: [] };
    var sep = false;
    try {
      sep = prop.dimensionsSeparated === true;
    } catch (eS) {
      sep = false;
    }
    if (sep) {
      out.separated = true;
      return out;
    }
    var nk = 0;
    try {
      nk = prop.numKeys;
    } catch (e0) {
      nk = 0;
    }
    try {
      if (prop.canSetExpression && prop.expressionEnabled) out.expr = true;
    } catch (e1) {}
    if (nk > 0) {
      var limit = nk;
      if (limit > MAX_KEYS) {
        limit = MAX_KEYS;
        out.truncated = true;
        state.truncated = true;
      }
      if (limit > MAX_TOTAL_KEYS - state.keys) {
        limit = MAX_TOTAL_KEYS - state.keys;
        if (limit < 0) limit = 0;
        out.truncated = true;
        state.truncated = true;
      }
      state.keys += limit;
      for (var k = 1; k <= limit; k++) {
        var key = { t: null, v: null, inE: [], outE: [], inT: "other", outT: "other" };
        try { key.t = roundNum(prop.keyTime(k)); } catch (e2) {}
        try { key.v = plainValue(prop.keyValue(k)); } catch (e3) {}
        try { key.inE = easeList(prop.keyInTemporalEase(k)); } catch (e4) {}
        try { key.outE = easeList(prop.keyOutTemporalEase(k)); } catch (e5) {}
        try { key.inT = interpName(prop.keyInInterpolationType(k)); } catch (e6) {}
        try { key.outT = interpName(prop.keyOutInterpolationType(k)); } catch (e7) {}
        out.keys.push(key);
      }
      out.numKeys = nk;
    } else {
      try { out.value = plainValue(prop.value); } catch (e8) {}
    }
    return out;
  }

  // Font size and fill colour of the first character (TextDocument reads only that). Reading
  // fillColor throws when the layer has no fill, so each read stands alone.
  function readText(layer) {
    var group = null;
    var doc = null;
    try {
      group = layer.property("ADBE Text Properties");
      if (group) {
        var src = group.property("ADBE Text Document");
        if (src) {
          // A keyed Source Text reads the document at the comp's current time; key 1 does not move with the playhead.
          var nkt = 0;
          try { nkt = src.numKeys; } catch (eN) { nkt = 0; }
          if (nkt > 0) doc = src.keyValue(1);
          else doc = src.value;
        }
      }
    } catch (e0) {
      doc = null;
    }
    if (!doc) return null;
    var out = { fontSize: null, fillColor: null, text: "" };
    try { out.fontSize = roundNum(doc.fontSize); } catch (e1) {}
    try {
      if (doc.applyFill) out.fillColor = plainValue(doc.fillColor);
    } catch (e2) {}
    try {
      var s = String(doc.text);
      if (s.length > MAX_STRING) s = s.substring(0, MAX_STRING);
      out.text = s;
    } catch (e3) {}
    return out;
  }

  // The separated-dimension followers of Position, read as props of their own.
  var FOLLOWERS = [
    ["ADBE Position_0", "position_x"],
    ["ADBE Position_1", "position_y"],
    ["ADBE Position_2", "position_z"]
  ];

  function readLayer(layer, state) {
    var out = {
      id: layer.id,
      index: layer.index,
      name: String(layer.name),
      kind: layerKind(layer),
      inPoint: roundNum(layer.inPoint),
      outPoint: roundNum(layer.outPoint),
      startTime: roundNum(layer.startTime),
      props: {},
      text: null,
      parented: false,
      threeD: false
    };
    try { out.parented = !!layer.parent; } catch (eP) {}
    try { out.threeD = layer.threeDLayer === true; } catch (eT) {}
    var tg = null;
    try {
      tg = layer.property("ADBE Transform Group");
    } catch (e0) {
      tg = null;
    }
    if (tg) {
      for (var i = 0; i < TRANSFORM_PROPS.length; i++) {
        var p = null;
        try {
          p = tg.property(TRANSFORM_PROPS[i][0]);
        } catch (e1) {
          p = null;
        }
        if (p) {
          var rp = readProp(p, TRANSFORM_PROPS[i][1], state);
          if (rp) out.props[TRANSFORM_PROPS[i][1]] = rp;
          if (rp && rp.separated && TRANSFORM_PROPS[i][1] === "position") {
            var nf = out.threeD ? 3 : 2;
            for (var f = 0; f < nf; f++) {
              var fp = null;
              try {
                fp = tg.property(FOLLOWERS[f][0]);
              } catch (eF) {
                fp = null;
              }
              if (fp) {
                var rf = readProp(fp, FOLLOWERS[f][1], state);
                if (rf) out.props[FOLLOWERS[f][1]] = rf;
              }
            }
          }
        }
      }
    }
    if (out.kind === "text") out.text = readText(layer);
    return out;
  }

  // args: { comp_id, layers?: [selector], tolerate_missing?: bool, header_only?: bool }.
  // With layers, only those; otherwise the first 500. With tolerate_missing, a selector by id that
  // matches no layer is listed in `missing` instead of failing. header_only reads the comp's fields and no layers.
  A.learntasteRead = function (args) {
    if (!args || args.comp_id === undefined || args.comp_id === null) fail("bad_args", "comp_id is required");
    var comp = requireComp(args.comp_id);
    var picked = [];
    var missing = [];
    var headerOnly = args.header_only === true;
    var i;
    if (headerOnly) {
      picked = [];
    } else if (args.layers && args.layers.length) {
      if (args.layers.length > MAX_LAYERS) fail("bad_args", "At most " + MAX_LAYERS + " layers can be named");
      // Resolve every selector first so a bad one fails before anything is read.
      for (i = 0; i < args.layers.length; i++) {
        var sel = args.layers[i];
        if (args.tolerate_missing === true && sel && sel.id !== undefined && sel.id !== null) {
          var hit = null;
          for (var j = 1; j <= comp.numLayers; j++) {
            if (comp.layer(j).id === sel.id) {
              hit = comp.layer(j);
              break;
            }
          }
          if (hit) picked.push(hit);
          else missing.push(sel.id);
        } else {
          picked.push(findLayer(comp, sel));
        }
      }
    } else {
      var n = comp.numLayers;
      if (n > MAX_LAYERS) n = MAX_LAYERS;
      for (i = 1; i <= n; i++) picked.push(comp.layer(i));
    }
    var state = { props: 0, keys: 0, truncated: false };
    if (!headerOnly && !(args.layers && args.layers.length) && comp.numLayers > MAX_LAYERS) state.truncated = true;
    var layers = [];
    var seen = {};
    for (i = 0; i < picked.length; i++) {
      if (seen[picked[i].id]) continue;
      seen[picked[i].id] = true;
      layers.push(readLayer(picked[i], state));
    }
    var projectPath = "<unsaved>";
    try {
      if (app.project && app.project.file) projectPath = app.project.file.fsName;
    } catch (e1) {}
    var revision = null;
    try {
      if (typeof app.project.revision === "number") revision = app.project.revision;
    } catch (e2) {}
    var result = {
      project_path: projectPath,
      revision: revision,
      comp_id: comp.id,
      name: String(comp.name),
      width: comp.width,
      height: comp.height,
      fps: roundNum(comp.frameRate),
      duration: roundNum(comp.duration),
      numLayers: comp.numLayers,
      truncated: state.truncated,
      layers: layers
    };
    if (args.tolerate_missing === true) result.missing = missing;
    return result;
  };
})($.global);
