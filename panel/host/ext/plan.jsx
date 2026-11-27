// panel/host/ext/plan.jsx: what ae_plan needs to know about the open project, in one read.
//
// planContext: the project (path, dirty), its comps (capped), and for the target comp (comp_id,
// else the active comp, else the only comp) its layers with kind, 3D, selection and which
// transform properties are keyed, the selected properties, the work area, the render queue, and
// the AE 26.3 render hazard (core.jsx envLightRenderHazard). Read-only: nothing is changed.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_COMPS = 40;
  var MAX_LAYERS = 80;
  var KEYED_PROPS = [
    ["position", "ADBE Position"],
    ["scale", "ADBE Scale"],
    ["rotation", "ADBE Rotate Z"],
    ["opacity", "ADBE Opacity"],
    ["anchor_point", "ADBE Anchor Point"]
  ];

  function round(v, places) {
    var m = Math.pow(10, places);
    return Math.round(v * m) / m;
  }

  function projectPathOf() {
    try {
      if (app.project.file) return String(app.project.file.fsName);
    } catch (e) {}
    return "<unsaved>";
  }

  function compSummary(c, activeId) {
    var o = { id: c.id, name: String(c.name), width: c.width, height: c.height, fps: round(c.frameRate, 3), duration: round(c.duration, 3), num_layers: c.numLayers, active: c.id === activeId };
    return o;
  }

  function kindOf(l) {
    var k = "Layer";
    try { k = String(l.reflect.name); } catch (e) {}
    if (k === "AVLayer") {
      try {
        if (l.nullLayer) return "null";
        if (l.adjustmentLayer) return "adjustment";
        if (l.source && l.source instanceof CompItem) return "precomp";
        if (l.source && l.source.mainSource && l.source.mainSource instanceof SolidSource) return "solid";
        if (l.source && l.source instanceof FootageItem) return "footage";
      } catch (e2) {}
      return "av";
    }
    if (k === "TextLayer") return "text";
    if (k === "ShapeLayer") return "shape";
    if (k === "CameraLayer") return "camera";
    if (k === "LightLayer") return "light";
    if (k === "ParametricMeshLayer") return "mesh";
    if (k === "ThreeDModelLayer") return "model_3d";
    return k;
  }

  function keyedOf(l) {
    var out = [];
    var tr = null;
    try { tr = l.property("ADBE Transform Group"); } catch (e) { tr = null; }
    if (!tr) return out;
    for (var i = 0; i < KEYED_PROPS.length; i++) {
      try {
        var p = tr.property(KEYED_PROPS[i][1]);
        if (p && p.numKeys > 0) out.push(KEYED_PROPS[i][0]);
      } catch (e2) {}
    }
    return out;
  }

  function effectCount(l) {
    try {
      var fx = l.property("ADBE Effect Parade");
      if (fx) return fx.numProperties;
    } catch (e) {}
    return 0;
  }

  A.planContext = function (args) {
    args = args || {};
    var proj = app.project;
    var activeId = null;
    try {
      if (proj.activeItem && proj.activeItem instanceof CompItem) activeId = proj.activeItem.id;
    } catch (e0) {}
    var comps = [];
    var compsTotal = 0;
    var only = null;
    for (var i = 1; i <= proj.numItems; i++) {
      var it = proj.item(i);
      if (!(it instanceof CompItem)) continue;
      compsTotal++;
      only = it;
      if (comps.length < MAX_COMPS) comps.push(compSummary(it, activeId));
    }
    var target = null;
    var targetWhy = null;
    if (typeof args.comp_id === "number") {
      try { target = proj.itemByID(args.comp_id); } catch (e1) { target = null; }
      if (!(target instanceof CompItem)) {
        target = null;
        targetWhy = "not_found";
      } else {
        targetWhy = "given";
      }
    } else if (activeId !== null) {
      target = proj.itemByID(activeId);
      targetWhy = "active";
    } else if (compsTotal === 1) {
      target = only;
      targetWhy = "only";
    }
    var comp = null;
    if (target) {
      var layers = [];
      var selected = [];
      for (var j = 1; j <= target.numLayers; j++) {
        var l = target.layer(j);
        var sel = false;
        try { sel = l.selected === true; } catch (e3) {}
        if (sel) selected.push(j);
        if (layers.length >= MAX_LAYERS) continue;
        var three = false;
        try { three = l.threeDLayer === true; } catch (e4) {}
        var on = true;
        try { on = l.enabled === true; } catch (e5) {}
        var locked = false;
        try { locked = l.locked === true; } catch (e6) {}
        layers.push({ index: j, id: l.id, name: String(l.name), kind: kindOf(l), three_d: three, enabled: on, locked: locked, selected: sel, keyed: keyedOf(l), effects: effectCount(l) });
      }
      var props = [];
      try {
        var sp = target.selectedProperties;
        for (var k = 0; k < sp.length && props.length < 20; k++) {
          var pr = sp[k];
          if (pr.propertyType !== PropertyType.PROPERTY) continue;
          var owner = null;
          try { owner = pr.propertyGroup(pr.propertyDepth); } catch (e7) { owner = null; }
          props.push({ layer: owner ? String(owner.name) : null, name: String(pr.name), match_name: String(pr.matchName), keys: pr.numKeys });
        }
      } catch (e8) {}
      var hazard = null;
      if (typeof A.envLightRenderHazard === "function") hazard = A.envLightRenderHazard(target);
      comp = {
        id: target.id,
        name: String(target.name),
        why: targetWhy,
        width: target.width,
        height: target.height,
        fps: round(target.frameRate, 3),
        duration: round(target.duration, 3),
        work_area: [round(target.workAreaStart, 3), round(target.workAreaDuration, 3)],
        time: round(target.time, 3),
        renderer: String(target.renderer),
        layers: layers,
        layers_total: target.numLayers,
        selected_layers: selected,
        selected_properties: props,
        render_hazard: hazard
      };
    }
    var rq = { items: 0, queued: 0 };
    try {
      rq.items = proj.renderQueue.numItems;
      for (var r = 1; r <= rq.items; r++) {
        if (proj.renderQueue.item(r).status === RQItemStatus.QUEUED) rq.queued++;
      }
    } catch (e9) {}
    var dirty = null;
    try { dirty = proj.dirty === true; } catch (e10) {}
    return {
      project_path: projectPathOf(),
      dirty: dirty,
      ae_version: String(app.version),
      comps: comps,
      comps_total: compsTotal,
      comp: comp,
      comp_not_found: targetWhy === "not_found",
      render_queue: rq
    };
  };
})($.global);
