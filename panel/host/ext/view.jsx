// panel/host/ext/view.jsx
//
// Host functions for ae_view, the tool that hands work back to the user:
// - viewState (read): the UI state an agent can change and later restore
//   (active item, comp time, selected layers / properties / keys / project
//   items, the active viewer and its view options)
// - viewApply (UI-state write): open an item in the viewer, the Layer panel
//   or Essential Graphics, park the comp time, select layers / properties /
//   keys / items, set view options. It changes no project data, so it opens
//   NO undo group (an undo entry for it would be empty or misleading).
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - The target guard is checked first. Everything that can fail is resolved and
//   validated before the first change; after that each step is caught and
//   reported, never thrown, so a half-applied call is described, not hidden.
// - Nothing here calls openInViewer, Viewer.setActive or View.setActive unless
//   args.open is given or args.focus is true: they steal focus while the user works.
// - Read-back is a separate viewState call from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LAYERS = 500;
  var MAX_ITEMS = 500;
  var MAX_PROPS = 100;
  var MAX_KEYS = 200;
  var MAX_DESELECT = 2000;

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

  function round4(n) {
    if (typeof n !== "number" || isNaN(n) || !isFinite(n)) return null;
    return Math.round(n * 10000) / 10000;
  }

  function shortError(e) {
    var m = "";
    try { m = String(e && e.message ? e.message : e); } catch (e1) { m = "error"; }
    if (m.length > 160) m = m.substring(0, 160);
    return m;
  }

  function requireItem(id) {
    var item = null;
    try { item = app.project.itemByID(id); } catch (e) { item = null; }
    if (!item) fail("not_found", "No project item with id " + id);
    return item;
  }

  function requireComp(id) {
    var item = requireItem(id);
    if (!(item instanceof CompItem)) fail("not_found", "Item " + id + " is not a CompItem");
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

  function itemKind(it) {
    try {
      if (it instanceof CompItem) return "comp";
      if (it instanceof FolderItem) return "folder";
      if (it instanceof FootageItem) return "footage";
    } catch (e) {}
    return "item";
  }

  // ---------- viewer and view options ----------

  var CHANNEL_NAMES = [
    ["rgb", "CHANNEL_RGB"],
    ["red", "CHANNEL_RED"],
    ["green", "CHANNEL_GREEN"],
    ["blue", "CHANNEL_BLUE"],
    ["alpha", "CHANNEL_ALPHA"],
    ["rgb_straight", "CHANNEL_RGB_STRAIGHT"],
    ["red_colorize", "CHANNEL_RED_COLORIZE"],
    ["green_colorize", "CHANNEL_GREEN_COLORIZE"],
    ["blue_colorize", "CHANNEL_BLUE_COLORIZE"],
    ["alpha_boundary", "CHANNEL_ALPHA_BOUNDARY"],
    ["alpha_overlay", "CHANNEL_ALPHA_OVERLAY"]
  ];

  var FAST_NAMES = [
    ["off", "FP_OFF"],
    ["adaptive_resolution", "FP_ADAPTIVE_RESOLUTION"],
    ["draft", "FP_DRAFT"],
    ["fast_draft", "FP_FAST_DRAFT"],
    ["wireframe", "FP_WIREFRAME"]
  ];

  // key = the tool's name, member = ViewOptions member, kind = number | bool | channels | fast
  var OPTION_TABLE = [
    { key: "zoom", member: "zoom", kind: "number", since: "" },
    { key: "exposure", member: "exposure", kind: "number", since: "" },
    { key: "channels", member: "channels", kind: "channels", since: "" },
    { key: "checkerboards", member: "checkerboards", kind: "bool", since: "" },
    { key: "fast_preview", member: "fastPreview", kind: "fast", since: " (AE 12.0)" },
    { key: "guides_visibility", member: "guidesVisibility", kind: "bool", since: " (AE 16.1)" },
    { key: "guides_locked", member: "guidesLocked", kind: "bool", since: " (AE 16.1)" },
    { key: "guides_snap", member: "guidesSnap", kind: "bool", since: " (AE 16.1)" },
    { key: "rulers", member: "rulers", kind: "bool", since: " (AE 16.1)" }
  ];

  function enumObject(name) {
    var e = null;
    try { e = G[name]; } catch (e1) { e = null; }
    if (e === undefined) e = null;
    return e;
  }

  function enumToName(E, table, v) {
    if (!E) return null;
    for (var i = 0; i < table.length; i++) {
      try { if (E[table[i][1]] === v) return table[i][0]; } catch (e) {}
    }
    return null;
  }

  function enumFromName(E, table, name) {
    if (!E) return undefined;
    for (var i = 0; i < table.length; i++) {
      if (table[i][0] === name) {
        try { return E[table[i][1]]; } catch (e) { return undefined; }
      }
    }
    return undefined;
  }

  function activeViewer() {
    var v = null;
    try { v = app.activeViewer; } catch (e) { v = null; }
    if (v === undefined) v = null;
    return v;
  }

  function viewerKind(viewer) {
    var VT = enumObject("ViewerType");
    if (!VT) return "unknown";
    try {
      if (viewer.type === VT.VIEWER_COMPOSITION) return "comp";
      if (viewer.type === VT.VIEWER_LAYER) return "layer";
      if (viewer.type === VT.VIEWER_FOOTAGE) return "footage";
    } catch (e) {}
    return "unknown";
  }

  function viewCount(viewer) {
    var n = null;
    try { n = viewer.views.length; } catch (e) { n = null; }
    return n;
  }

  function viewAt(viewer, idx) {
    var v = null;
    try { v = viewer.views[idx]; } catch (e) { v = null; }
    if (v === undefined) v = null;
    return v;
  }

  function activeIndex(viewer) {
    var n = null;
    try { n = viewer.activeViewIndex; } catch (e) { n = null; }
    if (typeof n !== "number") return null;
    return n;
  }

  function optionsOf(view) {
    var o = null;
    try { o = view.options; } catch (e) { o = null; }
    if (o === undefined) o = null;
    return o;
  }

  // One option as plain data: undefined when this AE has no such member.
  function readOption(o, spec) {
    var v;
    try { v = o[spec.member]; } catch (e) { return undefined; }
    if (v === undefined) return undefined;
    if (spec.kind === "number") return round4(v);
    if (spec.kind === "bool") return v === true;
    if (spec.kind === "channels") return enumToName(enumObject("ChannelType"), CHANNEL_NAMES, v);
    if (spec.kind === "fast") return enumToName(enumObject("FastPreviewType"), FAST_NAMES, v);
    return undefined;
  }

  function readOptions(view, missing, kind) {
    var o = optionsOf(view);
    if (!o) {
      missing.push("View.options");
      return null;
    }
    var out = {};
    for (var i = 0; i < OPTION_TABLE.length; i++) {
      var spec = OPTION_TABLE[i];
      if (spec.kind === "fast" && (kind === "layer" || kind === "footage")) {
        out[spec.key] = null;
        missing.push("ViewOptions.fastPreview (not available in a Layer/Footage viewer)");
        continue;
      }
      var v = readOption(o, spec);
      if (v === undefined) {
        out[spec.key] = null;
        missing.push("ViewOptions." + spec.member + spec.since);
      } else {
        out[spec.key] = v;
      }
    }
    return out;
  }

  // ---------- state ----------

  // Selected properties with the layer each belongs to (CompItem.selectedProperties
  // has no layer, so selected layers are scanned first, then the rest).
  function selectedPropertyEntries(comp, out) {
    var total = 0;
    try { total = comp.selectedProperties.length; } catch (e0) { total = 0; }
    if (total === 0) return;
    var order = [];
    var seen = {};
    var i;
    try {
      var sl = comp.selectedLayers;
      for (i = 0; i < sl.length; i++) {
        order.push(sl[i]);
        seen[sl[i].index] = true;
      }
    } catch (e1) {}
    var n = comp.numLayers;
    for (i = 1; i <= n && order.length < MAX_LAYERS; i++) {
      if (seen[i] !== true) order.push(comp.layer(i));
    }
    var found = 0;
    var keysUsed = 0;
    for (var j = 0; j < order.length && found < total; j++) {
      var layer = order[j];
      var lp = null;
      try { lp = layer.selectedProperties; } catch (e2) { lp = null; }
      if (!lp) continue;
      for (var k = 0; k < lp.length; k++) {
        found++;
        if (out.selected_properties.length >= MAX_PROPS) {
          out.selected_properties_truncated = true;
          continue;
        }
        var prop = lp[k];
        var entry = { layer_id: layer.id, layer_index: layer.index, path: [], name: "", is_group: false, selected_keys: [] };
        try { entry.path = A.propertyPath(prop).path; } catch (e3) {}
        try { entry.name = String(prop.name); } catch (e4) {}
        try { entry.is_group = prop.propertyType !== PropertyType.PROPERTY; } catch (e5) {}
        if (!entry.is_group) {
          try {
            var keys = prop.selectedKeys;
            for (var q = 0; keys && q < keys.length; q++) {
              if (keysUsed >= MAX_KEYS) {
                out.selected_keys_truncated = true;
                break;
              }
              keysUsed++;
              entry.selected_keys.push(keys[q]);
            }
          } catch (e6) {}
        }
        out.selected_properties.push(entry);
      }
    }
    if (found < total) out.selected_properties_truncated = true;
  }

  // args: { comp_id?, view_index? }. A read: no setActive, no openInViewer, nothing that moves focus.
  A.viewState = function (args) {
    args = args || {};
    var out = {
      active_item: null,
      comp: null,
      selected_layers: [],
      selected_properties: [],
      selected_items: [],
      viewer: null,
      view_options: null,
      dirty: null,
      missing: []
    };
    var i;
    try { out.dirty = app.project.dirty === true; } catch (e0) {}
    var ai = null;
    try { ai = app.project.activeItem; } catch (e1) { ai = null; }
    if (ai) out.active_item = { id: ai.id, name: ai.name, kind: itemKind(ai) };

    var comp = null;
    if (args.comp_id !== undefined && args.comp_id !== null) {
      var found = null;
      try { found = app.project.itemByID(args.comp_id); } catch (e2) { found = null; }
      if (found && found instanceof CompItem) {
        comp = found;
      } else {
        out.missing.push("item " + args.comp_id + " is not a CompItem");
      }
    } else if (ai && ai instanceof CompItem) {
      comp = ai;
    }

    if (comp) {
      var c = { id: comp.id, name: comp.name, time: null, frame: null, frame_rate: null };
      try { c.time = round4(comp.time); } catch (e3) {}
      try {
        c.frame_rate = comp.frameRate;
        c.frame = Math.round(comp.time / comp.frameDuration);
      } catch (e4) {}
      out.comp = c;
      try {
        var sel = comp.selectedLayers;
        for (i = 0; i < sel.length; i++) {
          if (i >= MAX_LAYERS) {
            out.selected_layers_truncated = true;
            break;
          }
          out.selected_layers.push(sel[i].id);
        }
      } catch (e5) {
        out.missing.push("CompItem.selectedLayers");
      }
      try {
        selectedPropertyEntries(comp, out);
      } catch (e6) {
        out.missing.push("CompItem.selectedProperties");
      }
    }

    try {
      var psel = app.project.selection;
      for (i = 0; i < psel.length; i++) {
        if (i >= MAX_ITEMS) {
          out.selected_items_truncated = true;
          break;
        }
        out.selected_items.push(psel[i].id);
      }
    } catch (e7) {
      out.missing.push("app.project.selection");
    }

    var viewer = activeViewer();
    if (viewer) {
      var vw = { type: viewerKind(viewer), maximized: null, view_count: viewCount(viewer), active_view_index: activeIndex(viewer), options_view_index: null };
      try { vw.maximized = viewer.maximized === true; } catch (e8) {}
      out.viewer = vw;
      var idx = args.view_index;
      if (idx === undefined || idx === null) idx = vw.active_view_index;
      if (typeof idx === "number") {
        var view = viewAt(viewer, idx);
        if (view) {
          vw.options_view_index = idx;
          out.view_options = readOptions(view, out.missing, vw.type);
        } else {
          out.missing.push("Viewer.views[" + idx + "]");
        }
      }
    } else {
      out.missing.push("app.activeViewer (no active viewer; the panel may have focus)");
    }
    return out;
  };

  // ---------- write ----------

  function inList(list, v) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === v) return true;
    }
    return false;
  }

  function sameNumber(a, b, tol) {
    return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;
  }

  // Resolves path -> Property/PropertyGroup of a layer (the path format of ae_set_property).
  function resolveProp(layer, path) {
    if (Object.prototype.toString.call(path) !== "[object Array]" || path.length === 0) fail("bad_args", "property path must be a non-empty array");
    if (typeof A.resolvePropertyPath !== "function") fail("unsupported", "This host build has no A.resolvePropertyPath.");
    return A.resolvePropertyPath(layer, path);
  }

  A.viewApply = function (args) {
    args = args || {};
    assertGuard(args.expect);
    var i;
    var j;
    var out = {
      comp_id: null,
      opened: null,
      time: null,
      layers: null,
      properties: null,
      keys: null,
      items: null,
      deselect_others: null,
      options_applied: null,
      skipped: [],
      warnings: [],
      changed: 0
    };

    // ----- resolve and validate everything first (nothing is changed yet) -----
    var lenient = args.restore === true;
    var comp = null;
    var compGone = false;
    if (args.comp_id !== undefined && args.comp_id !== null) {
      if (lenient) {
        try {
          comp = requireComp(args.comp_id);
        } catch (eRc0) {
          comp = null;
          compGone = true;
          out.skipped.push({ what: "comp " + args.comp_id, reason: shortError(eRc0) });
        }
      } else {
        comp = requireComp(args.comp_id);
      }
    }

    var openSpec = args.open || null;
    if (lenient && openSpec) {
      // a restore reopens the previous item only if it still exists and still opens
      try {
        var probe = requireItem(openSpec.item_id);
        if (!(probe instanceof CompItem) && !(probe instanceof FootageItem)) fail("bad_args", "not a comp or footage item");
        if (typeof probe.openInViewer !== "function") fail("unsupported", "openInViewer is not available");
      } catch (eOp0) {
        out.skipped.push({ what: "open item " + openSpec.item_id, reason: shortError(eOp0) });
        openSpec = null;
      }
    }
    var openKind = null;
    var openItem = null;
    var openLayer = null;
    if (openSpec) {
      openKind = openSpec["in"];
      if (openKind === "layer") {
        var layerComp = comp;
        if (openSpec.item_id !== undefined && openSpec.item_id !== null) layerComp = requireComp(openSpec.item_id);
        if (!layerComp) fail("bad_args", "Opening a layer needs its comp (open.item_id or comp_id).");
        openLayer = findLayer(layerComp, openSpec.layer);
        if (typeof openLayer.openInViewer !== "function") {
          fail("unsupported", "This layer type has no openInViewer (cameras and lights cannot open in the Layer panel).");
        }
        if (!comp && !compGone) comp = layerComp;
      } else if (openKind === "viewer" || openKind === "essential_graphics") {
        var openId = openSpec.item_id;
        if (openId === undefined || openId === null) openId = args.comp_id;
        if (openId === undefined || openId === null) fail("bad_args", "open needs item_id (or comp_id).");
        openItem = requireItem(openId);
        if (openKind === "viewer") {
          if (!(openItem instanceof CompItem) && !(openItem instanceof FootageItem)) {
            fail("bad_args", "Only comps and footage items open in a viewer (item " + openId + " is a " + itemKind(openItem) + ").");
          }
          if (typeof openItem.openInViewer !== "function") fail("unsupported", "openInViewer is not available in this AE version.");
        } else {
          if (!(openItem instanceof CompItem)) fail("bad_args", "Essential Graphics opens a comp (item " + openId + " is a " + itemKind(openItem) + ").");
          if (typeof openItem.openInEssentialGraphics !== "function") {
            fail("unsupported", "openInEssentialGraphics needs AE 15.0 or newer.");
          }
        }
        // a restore whose own comp is gone must not move another comp's time or selection
        if (!comp && !compGone && openItem instanceof CompItem) comp = openItem;
      } else {
        fail("bad_args", "open.in must be viewer, layer or essential_graphics.");
      }
    }

    // time
    var timePlan = null;
    var wantTime = args.time;
    if (wantTime && !comp && lenient) {
      out.skipped.push({ what: "time", reason: "the comp no longer exists" });
      wantTime = null;
    }
    if (wantTime) {
      if (!comp) fail("bad_args", "time needs a comp (comp_id).");
      var fd = comp.frameDuration;
      if (!(fd > 0)) fd = 1 / comp.frameRate;
      var req = null;
      if (wantTime.frame !== undefined && wantTime.frame !== null) {
        req = wantTime.frame * fd;
      } else {
        req = wantTime.time;
      }
      if (typeof req !== "number" || isNaN(req) || !isFinite(req)) fail("bad_args", "time needs a finite time or frame.");
      var lastFrame = Math.round(comp.duration / fd) - 1;
      if (lastFrame < 0) lastFrame = 0;
      var frameNo = Math.round(req / fd);
      var clamped = false;
      if (frameNo < 0) {
        frameNo = 0;
        clamped = true;
      }
      if (frameNo > lastFrame) {
        frameNo = lastFrame;
        clamped = true;
      }
      timePlan = { requested: round4(req), frame: frameNo, applied: frameNo * fd, clamped: clamped };
    }

    // selection
    var sel = args.select || null;
    var deselect = true;
    if (sel && sel.deselect_others === false) deselect = false;
    var layerTargets = null;
    var propTargets = null;
    var keyTargets = null;
    var itemTargets = null;
    if (sel) {
      var needsComp = (sel.layers !== undefined && sel.layers !== null) ||
        (sel.properties !== undefined && sel.properties !== null) ||
        (sel.keys !== undefined && sel.keys !== null);
      var skipCompSel = false;
      if (needsComp && !comp) {
        if (lenient) {
          skipCompSel = true;
          out.skipped.push({ what: "layer, property and key selection", reason: "the comp no longer exists" });
        } else {
          fail("bad_args", "Selecting layers, properties or keys needs a comp (comp_id).");
        }
      }
      var seen;
      var ent;
      var lay;
      var prop;
      if (sel.layers !== undefined && sel.layers !== null && !skipCompSel) {
        layerTargets = [];
        seen = {};
        for (i = 0; i < sel.layers.length; i++) {
          try {
            lay = findLayer(comp, sel.layers[i]);
          } catch (eL0) {
            if (!lenient) throw eL0;
            out.skipped.push({ what: "layer " + (sel.layers[i] && sel.layers[i].id), reason: shortError(eL0) });
            continue;
          }
          if (seen[lay.id] !== true) {
            seen[lay.id] = true;
            layerTargets.push(lay);
          }
        }
      }
      if (sel.properties !== undefined && sel.properties !== null && !skipCompSel) {
        propTargets = [];
        for (i = 0; i < sel.properties.length; i++) {
          ent = sel.properties[i];
          try {
            lay = findLayer(comp, ent.layer);
            prop = resolveProp(lay, ent.path);
          } catch (eP0) {
            if (!lenient) throw eP0;
            out.skipped.push({ what: "property on layer " + (ent.layer && ent.layer.id), reason: shortError(eP0) });
            continue;
          }
          propTargets.push({ layer: lay, prop: prop });
        }
      }
      if (sel.keys !== undefined && sel.keys !== null && !skipCompSel) {
        keyTargets = [];
        for (i = 0; i < sel.keys.length; i++) {
          ent = sel.keys[i];
          try {
            lay = findLayer(comp, ent.layer);
            prop = resolveProp(lay, ent.path);
          } catch (eK0) {
            if (!lenient) throw eK0;
            out.skipped.push({ what: "keys on layer " + (ent.layer && ent.layer.id), reason: shortError(eK0) });
            continue;
          }
          var isLeaf = false;
          try { isLeaf = prop.propertyType === PropertyType.PROPERTY; } catch (eT) { isLeaf = false; }
          if (!isLeaf) {
            if (lenient) {
              out.skipped.push({ what: "keys on layer " + lay.id, reason: "the path now names a property group, not a property with keyframes" });
              continue;
            }
            fail("bad_args", "keys[" + i + "]: the path names a property group, not a property with keyframes.");
          }
          if (typeof prop.setSelectedAtKey !== "function") {
            if (lenient) {
              out.skipped.push({ what: "keys on layer " + lay.id, reason: "Property.setSelectedAtKey is not available" });
              continue;
            }
            fail("unsupported", "Property.setSelectedAtKey is not available.");
          }
          var nk = prop.numKeys;
          if (!(nk > 0)) {
            if (lenient) {
              out.skipped.push({ what: "keys on layer " + lay.id, reason: "the property has no keyframes any more" });
              continue;
            }
            fail("bad_args", "keys[" + i + "]: the property has no keyframes.");
          }
          var idxs = [];
          for (j = 0; j < ent.indexes.length; j++) {
            var kx = ent.indexes[j];
            if (typeof kx !== "number" || kx !== Math.floor(kx) || kx < 1 || kx > nk) {
              if (lenient) {
                out.skipped.push({ what: "key " + kx + " on layer " + lay.id, reason: "key index is outside 1.." + nk });
                continue;
              }
              fail("bad_args", "keys[" + i + "]: key index " + kx + " is outside 1.." + nk + ".");
            }
            if (!inList(idxs, kx)) idxs.push(kx);
          }
          keyTargets.push({ layer: lay, prop: prop, indexes: idxs });
        }
      }
      if (sel.items !== undefined && sel.items !== null) {
        itemTargets = [];
        seen = {};
        for (i = 0; i < sel.items.length; i++) {
          var it;
          try {
            it = requireItem(sel.items[i]);
          } catch (eI0) {
            if (!lenient) throw eI0;
            out.skipped.push({ what: "item " + sel.items[i], reason: shortError(eI0) });
            continue;
          }
          if (seen[it.id] !== true) {
            seen[it.id] = true;
            itemTargets.push(it);
          }
        }
      }
    }

    // viewer options
    var vo = args.viewer_options || null;
    var optPlan = [];
    var optBlock = null;
    if (vo) {
      var viewerNow = activeViewer();
      if (!viewerNow && !openSpec && lenient) {
        optBlock = "no active viewer (the panel may have focus)";
      } else if (!viewerNow && !openSpec) {
        fail("unavailable", "There is no active viewer to set options on (the panel may have focus). Give `open` to open an item first, or click a viewer in After Effects.");
      }
      if (viewerNow && !openSpec && vo.view_index !== undefined && vo.view_index !== null) {
        var vc = viewCount(viewerNow);
        if (vc !== null && (vo.view_index < 0 || vo.view_index >= vc) && lenient) {
          optBlock = "view_index " + vo.view_index + " is outside the current viewer's " + vc + " view(s)";
        } else if (vc !== null && (vo.view_index < 0 || vo.view_index >= vc)) {
          fail("bad_args", "view_index " + vo.view_index + " is outside 0.." + (vc - 1) + " (the viewer has " + vc + " view" + (vc === 1 ? "" : "s") + ").");
        }
      }
      var expectedKind = null;
      if (openSpec) {
        if (openKind === "layer") expectedKind = "layer";
        else if (openKind === "viewer" && openItem instanceof CompItem) expectedKind = "comp";
        else if (openKind === "viewer") expectedKind = "footage";
      }
      if (expectedKind === null && viewerNow && !(openSpec && openKind === "essential_graphics")) expectedKind = viewerKind(viewerNow);
      for (i = 0; i < OPTION_TABLE.length; i++) {
        var spec = OPTION_TABLE[i];
        var want = vo[spec.key];
        if (want === undefined || want === null) continue;
        var value = want;
        if (spec.kind === "number") {
          if (typeof want !== "number" || isNaN(want) || !isFinite(want)) fail("bad_args", spec.key + " must be a number.");
          if (spec.key === "zoom" && (want < 0.01 || want > 16)) fail("bad_args", "zoom must be between 0.01 and 16 (1 is 100%).");
          if (spec.key === "exposure" && (want < -40 || want > 40)) fail("bad_args", "exposure must be between -40 and 40.");
        } else if (spec.kind === "bool") {
          if (want !== true && want !== false) fail("bad_args", spec.key + " must be true or false.");
        } else if (spec.kind === "channels") {
          if (!enumObject("ChannelType")) fail("unsupported", "ChannelType is not available in this AE version.");
          value = enumFromName(enumObject("ChannelType"), CHANNEL_NAMES, want);
          if (value === undefined) fail("bad_args", "Unknown or unsupported channels value \"" + want + "\".");
        } else if (spec.kind === "fast") {
          if (!enumObject("FastPreviewType")) fail("unsupported", "FastPreviewType is not available in this AE version (needs AE 12.0).");
          value = enumFromName(enumObject("FastPreviewType"), FAST_NAMES, want);
          if (value === undefined) fail("bad_args", "Unknown or unsupported fast_preview value \"" + want + "\".");
          if (lenient && expectedKind !== null && expectedKind !== "comp" && expectedKind !== "unknown") {
            out.skipped.push({ what: "fast_preview", reason: "fast_preview only applies to a Composition viewer" });
            continue;
          }
          if (expectedKind !== null && expectedKind !== "comp" && expectedKind !== "unknown") {
            fail("bad_args", "fast_preview can only be set on a Composition viewer; AE throws in the Layer and Footage panels.");
          }
          if (want === "draft") {
            // the renderer of the comp the options will land on: the opened comp, else the comp the active viewer shows
            var rc = null;
            if (openSpec) {
              if (openKind === "viewer" && openItem instanceof CompItem) rc = openItem;
            } else if (viewerNow && viewerKind(viewerNow) === "comp") {
              try { rc = app.project.activeItem; } catch (eRc) { rc = null; }
            }
            if (!(rc instanceof CompItem) && !(openSpec && openKind === "viewer")) rc = comp;
            var renderer = "";
            try { if (rc && rc instanceof CompItem) renderer = String(rc.renderer); } catch (eRn) { renderer = ""; }
            if (renderer === "ADBE Advanced 3d") {
              if (lenient) {
                out.skipped.push({ what: "fast_preview", reason: "Draft preview is refused in a Classic 3D comp" });
                continue;
              }
              fail("bad_args", "Draft preview is refused in a Classic 3D comp. Use adaptive_resolution, off or wireframe.");
            }
          }
        }
        optPlan.push({ spec: spec, value: value, want: want });
      }
    }

    out.comp_id = comp ? comp.id : null;

    // ----- apply (UI state only: no undo group) -----
    var opened = false;
    var openedViewer = null;

    // project items first: it can change the active item, and `open` should have the last word
    if (itemTargets !== null) {
      try {
        var wantItem = {};
        out.items = [];
        for (i = 0; i < itemTargets.length; i++) {
          wantItem[itemTargets[i].id] = true;
          out.items.push(itemTargets[i].id);
        }
        if (deselect) {
          var cur = app.project.selection;
          var drop = [];
          for (i = 0; i < cur.length && i < MAX_DESELECT; i++) {
            if (wantItem[cur[i].id] !== true) drop.push(cur[i]);
          }
          for (i = 0; i < drop.length; i++) {
            drop[i].selected = false;
            out.changed++;
          }
        }
        for (i = 0; i < itemTargets.length; i++) {
          if (itemTargets[i].selected !== true) {
            itemTargets[i].selected = true;
            out.changed++;
          }
        }
      } catch (eItems) {
        out.warnings.push("Selecting project items stopped: " + shortError(eItems));
      }
    }

    if (openSpec) {
      var rec = { "in": openKind, item_id: null, layer_id: null, opened: false };
      if (openItem) rec.item_id = openItem.id;
      if (openLayer) {
        rec.layer_id = openLayer.id;
        try { rec.item_id = openLayer.containingComp.id; } catch (eLc) {}
      }
      var skipOpen = false;
      if (openSpec.if_not_active === true && openKind === "viewer") {
        var activeNow = null;
        try { activeNow = app.project.activeItem; } catch (eAn) { activeNow = null; }
        if (activeNow && openItem && activeNow.id === openItem.id) {
          skipOpen = true;
          rec.skipped = "already the active item";
        }
      }
      if (!skipOpen) {
        try {
          var res = null;
          if (openKind === "layer") {
            res = openLayer.openInViewer();
            if (res) {
              rec.opened = true;
              openedViewer = res;
            } else {
              rec.reason = "openInViewer returned null (AE does not open text and shape layers in the Layer panel).";
            }
          } else if (openKind === "essential_graphics") {
            openItem.openInEssentialGraphics();
            rec.opened = true;
          } else {
            res = openItem.openInViewer();
            if (res) {
              rec.opened = true;
              openedViewer = res;
            } else {
              rec.reason = "openInViewer returned null (no viewer was opened).";
            }
          }
        } catch (eOpen) {
          rec.reason = "open failed: " + shortError(eOpen);
        }
        if (rec.opened) {
          out.changed++;
          opened = true;
        } else {
          out.warnings.push(rec.reason);
        }
      }
      out.opened = rec;
    }

    if (timePlan !== null) {
      out.time = { requested: timePlan.requested, frame: timePlan.frame, applied: round4(timePlan.applied), clamped: timePlan.clamped };
      try {
        if (!sameNumber(comp.time, timePlan.applied, 1e-6)) {
          comp.time = timePlan.applied;
          out.changed++;
        }
      } catch (eTime) {
        out.time.error = shortError(eTime);
        out.warnings.push("Setting the comp time failed: " + shortError(eTime));
      }
    }

    if (layerTargets !== null) {
      try {
        var wantLayer = {};
        out.layers = [];
        for (i = 0; i < layerTargets.length; i++) {
          wantLayer[layerTargets[i].id] = true;
          out.layers.push(layerTargets[i].id);
        }
        if (deselect) {
          for (i = 1; i <= comp.numLayers; i++) {
            var other = comp.layer(i);
            if (other.selected === true && wantLayer[other.id] !== true) {
              other.selected = false;
              out.changed++;
            }
          }
        }
        for (i = 0; i < layerTargets.length; i++) {
          if (layerTargets[i].selected !== true) {
            layerTargets[i].selected = true;
            out.changed++;
          }
        }
      } catch (eLayers) {
        out.warnings.push("Selecting layers stopped: " + shortError(eLayers));
      }
    }

    if (propTargets !== null || keyTargets !== null) {
      try {
        // properties named by `keys` are selected too
        var wantProps = [];
        out.properties = [];
        if (propTargets !== null) {
          for (i = 0; i < propTargets.length; i++) wantProps.push(propTargets[i]);
        }
        if (keyTargets !== null) {
          for (i = 0; i < keyTargets.length; i++) wantProps.push(keyTargets[i]);
        }
        var uniqProps = [];
        var seenProps = {};
        for (i = 0; i < wantProps.length; i++) {
          var pk = wantProps[i].layer.id + "|" + A.propertyPath(wantProps[i].prop).path.join("");
          if (seenProps[pk] !== true) {
            seenProps[pk] = true;
            uniqProps.push(wantProps[i]);
          }
        }
        wantProps = uniqProps;
        for (i = 0; i < wantProps.length; i++) {
          out.properties.push({ layer_id: wantProps[i].layer.id, path: A.propertyPath(wantProps[i].prop).path });
        }
        if (deselect) {
          var curProps = [];
          try { curProps = comp.selectedProperties; } catch (eCp) { curProps = []; }
          var allSelected = true;
          for (i = 0; i < wantProps.length; i++) {
            if (wantProps[i].prop.selected !== true) allSelected = false;
          }
          if (!(allSelected && curProps.length === wantProps.length)) {
            for (i = 0; i < curProps.length && i < MAX_DESELECT; i++) {
              try {
                if (curProps[i].selected === true) {
                  curProps[i].selected = false;
                  out.changed++;
                }
              } catch (eDp) {}
            }
          }
        }
        for (i = 0; i < wantProps.length; i++) {
          if (wantProps[i].prop.selected !== true) {
            wantProps[i].prop.selected = true;
            out.changed++;
          }
        }
        if (keyTargets !== null) {
          out.keys = [];
          for (i = 0; i < keyTargets.length; i++) {
            var kt = keyTargets[i];
            var curKeys = [];
            try { curKeys = kt.prop.selectedKeys; } catch (eSk) { curKeys = []; }
            if (deselect) {
              var dropKeys = [];
              for (j = 0; j < curKeys.length; j++) {
                if (!inList(kt.indexes, curKeys[j])) dropKeys.push(curKeys[j]);
              }
              for (j = 0; j < dropKeys.length; j++) {
                kt.prop.setSelectedAtKey(dropKeys[j], false);
                out.changed++;
              }
            }
            var haveKeys = [];
            for (j = 0; j < curKeys.length; j++) haveKeys.push(curKeys[j]);
            for (j = 0; j < kt.indexes.length; j++) {
              if (!inList(haveKeys, kt.indexes[j])) {
                kt.prop.setSelectedAtKey(kt.indexes[j], true);
                out.changed++;
              }
            }
            out.keys.push({ layer_id: kt.layer.id, path: A.propertyPath(kt.prop).path, indexes: kt.indexes });
          }
        }
      } catch (eProps) {
        out.warnings.push("Selecting properties or keys stopped: " + shortError(eProps));
      }
    }
    if (sel) out.deselect_others = deselect;

    var viewer = null;
    var view = null;
    if (vo || args.focus === true) {
      var targetKind = "active_viewer";
      if (openedViewer) {
        viewer = openedViewer;
        targetKind = "opened_viewer";
      } else {
        viewer = activeViewer();
      }
      if (vo) out.options_target = targetKind;
      if (viewer) {
        var useIdx = null;
        if (vo && vo.view_index !== undefined && vo.view_index !== null) {
          useIdx = vo.view_index;
        } else {
          useIdx = activeIndex(viewer);
        }
        if (typeof useIdx === "number") {
          view = viewAt(viewer, useIdx);
          if (!view && vo && vo.view_index !== undefined && vo.view_index !== null) {
            out.warnings.push("view_index " + useIdx + " does not exist in the viewer that is active now.");
          }
        }
      }
    }

    if (vo) {
      out.options_applied = {};
      if (openedViewer) {
        // wrappers are not compared by identity; the read-back runs on app.activeViewer, so check that it shows what was opened
        var nowActive = activeViewer();
        var verifiable = false;
        try {
          var actItem = app.project.activeItem;
          if (nowActive && viewerKind(nowActive) === viewerKind(openedViewer)) {
            if (openKind === "layer") verifiable = true;
            else if (actItem && openItem && actItem.id === openItem.id) verifiable = true;
          }
        } catch (eVf) {
          verifiable = false;
        }
        out.options_verifiable = verifiable;
      }
      if (viewer && optBlock === null && lenient && args.viewer_type && viewerKind(viewer) !== "unknown" && viewerKind(viewer) !== args.viewer_type) {
        optBlock = "the current viewer is a " + viewerKind(viewer) + " viewer, the saved options belong to a " + args.viewer_type + " viewer";
      }
      if (optBlock !== null) {
        for (i = 0; i < optPlan.length; i++) out.skipped.push({ what: optPlan[i].spec.key, reason: optBlock });
        out.warnings.push("View options were not restored: " + optBlock + ".");
      } else if (!viewer || !view) {
        for (i = 0; i < optPlan.length; i++) {
          out.skipped.push({ what: optPlan[i].spec.key, reason: viewer ? "no such view" : "no active viewer after the open" });
        }
        if (!viewer) out.warnings.push("No active viewer, so no view options were set (the panel may have focus).");
      } else {
        var opts = optionsOf(view);
        if (!opts) {
          for (i = 0; i < optPlan.length; i++) out.skipped.push({ what: optPlan[i].spec.key, reason: "View.options is not available" });
        } else {
          for (i = 0; i < optPlan.length; i++) {
            var p = optPlan[i];
            var currentValue;
            try { currentValue = opts[p.spec.member]; } catch (eRead) { currentValue = undefined; }
            if (currentValue === undefined) {
              out.skipped.push({ what: p.spec.key, reason: "ViewOptions." + p.spec.member + " is not available in this AE version" + p.spec.since });
              continue;
            }
            var same = false;
            if (p.spec.kind === "number") same = sameNumber(currentValue, p.value, 1e-6);
            else same = currentValue === p.value;
            if (same) {
              out.options_applied[p.spec.key] = p.want;
              continue;
            }
            try {
              opts[p.spec.member] = p.value;
              out.options_applied[p.spec.key] = p.want;
              out.changed++;
            } catch (eSet) {
              out.skipped.push({ what: p.spec.key, reason: shortError(eSet) });
            }
          }
        }
      }
    }

    if (args.focus === true && !opened) {
      if (!viewer) {
        out.warnings.push("focus: there is no active viewer to activate.");
      } else {
        try {
          viewer.setActive();
          if (view && vo && vo.view_index !== undefined && vo.view_index !== null) view.setActive();
          out.focused = true;
          out.changed++;
        } catch (eFocus) {
          out.warnings.push("focus failed: " + shortError(eFocus));
        }
      }
    }

    if (out.changed === 0) out.no_op = true;
    return out;
  };
})($.global);
