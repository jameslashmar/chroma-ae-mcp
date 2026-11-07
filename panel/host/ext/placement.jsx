// panel/host/ext/placement.jsx
//
// Host functions for ae_layout_apply:
// - layoutFacts (read): what the server needs to plan a layout - the target
//   comp, the content items (kind, size, pixel aspect, whether a comp holds the
//   target), the layers a spec names (locked, keyed, 3D, parented, effects) and
//   project folders. Nothing is written.
// - layoutRead (read): per comp, its layers with id, name, index, enabled,
//   camera flag and comp-space box, for the receipt's before / after.
// - layoutApply (guarded write): builds the layout from a plan the server
//   worked out (rectangles, scales, positions already computed): creates the
//   master comp and feed comps, adds or finds the layers, sets name, anchor,
//   position and scale, adds the clip masks, stacks, and copies layers
//   (cameras) between comps with copyToComp. One undo group; everything is
//   checked before it opens; if a step throws, what this call made is removed.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Validate before A.withUndo. Reads change nothing. The read-back runs in a
//   separate evalScript from the server.
// - Layers are looked up again by id after every add / addProperty / move.
// - No dialogs are suppressed.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_REGIONS = 100;
  var MAX_COPIES = 100;
  var MAX_ITEMS = 300;
  var MAX_LAYERS = 500;
  var MAX_HOLD_VISITS = 2000;
  // 100 regions with feeds, 100 copies with a source and a destination each, and the target.
  var MAX_READ_COMPS = 400;

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
      fail("guard", "Target guard refused mutation: the open project or comp does not match expect. Stop and re-read state.", {
        expected: expect,
        actual: { project_path: g.project_path, comp_id: g.comp_id, comp_is_valid: g.comp_is_valid }
      });
    }
  }

  function r2(x) {
    return Math.round(x * 100) / 100;
  }

  function clip(s, n) {
    var str = String(s);
    if (str.length > n) return str.substring(0, n) + "...";
    return str;
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function hasVal(v) {
    return v !== undefined && v !== null;
  }

  function itemById(id) {
    var item = null;
    try {
      item = app.project.itemByID(id);
    } catch (e) {
      item = null;
    }
    return item;
  }

  function compById(id) {
    var item = itemById(id);
    if (!item) return null;
    try {
      if (item instanceof CompItem) return item;
    } catch (e) {}
    return null;
  }

  function folderById(id) {
    var item = itemById(id);
    if (!item) return null;
    try {
      if (item instanceof FolderItem) return item;
    } catch (e) {}
    return null;
  }

  // The layer with this id, looked up from the comp every time (indexes shift
  // and references go stale after adds, moves and addProperty).
  function layerById(comp, id) {
    var n = 0;
    try { n = comp.numLayers; } catch (e0) { return null; }
    for (var i = 1; i <= n; i++) {
      var l = null;
      try { l = comp.layer(i); } catch (e1) { l = null; }
      if (l && l.id === id) return l;
    }
    return null;
  }

  function reflectName(l) {
    try {
      if (l.reflect && l.reflect.name) return String(l.reflect.name);
    } catch (e) {}
    return "";
  }

  function isCamera(l) {
    return reflectName(l) === "CameraLayer";
  }

  function isLight(l) {
    return reflectName(l) === "LightLayer";
  }

  function transformProp(l, matchName) {
    var p = null;
    try { p = l.property("ADBE Transform Group").property(matchName); } catch (e) { p = null; }
    return p;
  }

  // ---------- facts (read) ----------

  // Whether `comp` is `targetId` or holds it through layer sources (bounded).
  function holdsComp(comp, targetId, state) {
    if (comp.id === targetId) return true;
    if (state.seen[comp.id] === true) return false;
    state.seen[comp.id] = true;
    var n = 0;
    try { n = comp.numLayers; } catch (e0) { return false; }
    for (var i = 1; i <= n; i++) {
      if (state.visits >= MAX_HOLD_VISITS) {
        state.truncated = true;
        return false;
      }
      state.visits++;
      var src = null;
      try { src = comp.layer(i).source; } catch (e1) { src = null; }
      if (!src) continue;
      var isComp = false;
      try { isComp = src instanceof CompItem; } catch (e2) { isComp = false; }
      if (isComp && holdsComp(src, targetId, state)) return true;
    }
    return false;
  }

  function itemFacts(it, targetId) {
    var f = { id: it.id, name: clip(it.name, 200), kind: "other" };
    var isComp = false;
    var isFootage = false;
    var isFolder = false;
    try { isComp = it instanceof CompItem; } catch (e0) {}
    try { isFootage = it instanceof FootageItem; } catch (e1) {}
    try { isFolder = it instanceof FolderItem; } catch (e2) {}
    if (isFolder) {
      f.kind = "folder";
      return f;
    }
    if (!isComp && !isFootage) return f;
    f.kind = isComp ? "comp" : "footage";
    try { f.width = it.width; f.height = it.height; } catch (e3) {}
    try { f.pixel_aspect = it.pixelAspect; } catch (e4) {}
    try { f.has_video = it.hasVideo === true; } catch (e5) {}
    if (isFootage) {
      try { f.missing = it.footageMissing === true; } catch (e6) {}
      try {
        if (it.mainSource instanceof PlaceholderSource) f.placeholder = true;
      } catch (e7) {}
    }
    if (isComp && hasVal(targetId)) {
      var state = { seen: {}, visits: 0, truncated: false };
      f.contains_target = holdsComp(it, targetId, state);
      if (state.truncated) f.contains_unknown = true;
    }
    return f;
  }

  // The layer a selector {id, index, name} names; `ambiguous` when a name fits several.
  function findBySelector(comp, sel) {
    var n = comp.numLayers;
    var i;
    var l;
    if (hasVal(sel.id)) return { layer: layerById(comp, sel.id), ambiguous: false };
    if (hasVal(sel.index)) {
      if (sel.index < 1 || sel.index > n) return { layer: null, ambiguous: false };
      return { layer: comp.layer(sel.index), ambiguous: false };
    }
    var found = null;
    var count = 0;
    for (i = 1; i <= n && i <= MAX_LAYERS; i++) {
      l = comp.layer(i);
      if (l.name === sel.name) {
        count++;
        if (!found) found = l;
      }
    }
    return { layer: found, ambiguous: count > 1 };
  }

  function keyedCount(l) {
    var names = ["ADBE Anchor Point", "ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Scale", "ADBE Rotate Z"];
    var n = 0;
    for (var i = 0; i < names.length; i++) {
      var p = transformProp(l, names[i]);
      try {
        if (p && p.numKeys > 0) n++;
      } catch (e) {}
    }
    return n;
  }

  function effectCount(l) {
    try {
      var ep = l.property("ADBE Effect Parade");
      if (ep) return ep.numProperties;
    } catch (e) {}
    return 0;
  }

  // Whether Position is split into X and Y (a plain setValue on ADBE Position would not apply).
  function isSeparated(l) {
    var p = transformProp(l, "ADBE Position");
    try {
      if (p && p.dimensionsSeparated === true) return true;
    } catch (e) {}
    return false;
  }

  // Whether any layer of the comp has this layer as its parent (moving the parent would move them).
  function isParentOf(comp, l) {
    var n = 0;
    try { n = comp.numLayers; } catch (e0) { return false; }
    for (var i = 1; i <= n && i <= MAX_LAYERS; i++) {
      try {
        var other = comp.layer(i);
        if (other.parent && other.parent.id === l.id) return true;
      } catch (e1) {}
    }
    return false;
  }

  function layerFacts(l, comp) {
    var f = { id: l.id, index: l.index, name: clip(l.name, 200), locked: false, three_d: false, parent: null, kind: "layer", keyed: 0, effects: effectCount(l) };
    try { f.locked = l.locked === true; } catch (e0) {}
    try { f.three_d = l.threeDLayer === true; } catch (e1) {}
    try { if (l.parent) f.parent = l.parent.index; } catch (e2) {}
    if (isCamera(l)) f.kind = "camera";
    else if (isLight(l)) f.kind = "light";
    f.keyed = keyedCount(l);
    f.separated = isSeparated(l);
    f.is_parent = comp ? isParentOf(comp, l) : false;
    try {
      var ro = transformProp(l, "ADBE Rotate Z").value;
      f.rotation = ro;
    } catch (e4) {}
    try {
      var sc = transformProp(l, "ADBE Scale").value;
      f.flipped = sc[0] < 0 || sc[1] < 0;
    } catch (e5) {}
    try {
      var src = l.source;
      if (src) {
        f.source_width = src.width;
        f.source_height = src.height;
        f.source_pixel_aspect = src.pixelAspect;
      }
    } catch (e3) {}
    return f;
  }

  function compFacts(c) {
    return {
      id: c.id,
      name: clip(c.name, 200),
      width: c.width,
      height: c.height,
      pixel_aspect: c.pixelAspect,
      fps: c.frameRate,
      duration: c.duration,
      num_layers: c.numLayers
    };
  }

  // args: { expect, comp_id?, items?: [ids], folders?: [ids], layers?: [{ key, comp_id, selector }] }
  A.layoutFacts = function (args) {
    assertGuard(args.expect);
    var out = { target: null, items: {}, layers: [], folders: {} };
    var targetId = null;
    var i;
    if (hasVal(args.comp_id)) {
      var tc = compById(args.comp_id);
      if (!tc) fail("not_found", "No CompItem with id " + args.comp_id);
      out.target = compFacts(tc);
      targetId = tc.id;
    }
    var ids = args.items || [];
    if (ids.length > MAX_ITEMS) fail("bad_args", "At most " + MAX_ITEMS + " items");
    for (i = 0; i < ids.length; i++) {
      var it = itemById(ids[i]);
      if (!it) {
        out.items[ids[i]] = { id: ids[i], kind: "missing" };
      } else {
        out.items[ids[i]] = itemFacts(it, targetId);
      }
    }
    var fl = args.folders || [];
    for (i = 0; i < fl.length && i < MAX_ITEMS; i++) {
      out.folders[fl[i]] = folderById(fl[i]) !== null;
    }
    var ls = args.layers || [];
    for (i = 0; i < ls.length && i < MAX_ITEMS; i++) {
      var req = ls[i];
      var entry = { key: req.key, comp_id: req.comp_id, found: false };
      var comp = compById(req.comp_id);
      if (!comp) {
        entry.comp_found = false;
      } else {
        entry.comp_found = true;
        var hit = null;
        try { hit = findBySelector(comp, req.selector || {}); } catch (e0) { hit = null; }
        if (hit && hit.layer) {
          entry.found = true;
          entry.ambiguous = hit.ambiguous === true;
          var facts = layerFacts(hit.layer, comp);
          var k;
          for (k in facts) {
            if (facts.hasOwnProperty(k)) entry[k] = facts[k];
          }
        }
      }
      out.layers.push(entry);
    }
    return out;
  };

  // ---------- layout read (receipt) ----------

  function boxOf(l) {
    var tr = l.property("ADBE Transform Group");
    var an = tr.property("ADBE Anchor Point").valueAtTime(0, false);
    var po = tr.property("ADBE Position").valueAtTime(0, false);
    var sc = tr.property("ADBE Scale").valueAtTime(0, false);
    var ro = tr.property("ADBE Rotate Z").valueAtTime(0, false);
    var rad = (ro * Math.PI) / 180;
    var cs = Math.cos(rad);
    var sn = Math.sin(rad);
    var a = (cs * sc[0]) / 100;
    var b = (-sn * sc[1]) / 100;
    var d = (sn * sc[0]) / 100;
    var e = (cs * sc[1]) / 100;
    var c = po[0] - (a * an[0] + b * an[1]);
    var f = po[1] - (d * an[0] + e * an[1]);
    var r = l.sourceRectAtTime(0, false);
    var xs = [r.left, r.left + r.width];
    var ys = [r.top, r.top + r.height];
    var x0 = 1e12;
    var y0 = 1e12;
    var x1 = -1e12;
    var y1 = -1e12;
    for (var i = 0; i < 2; i++) {
      for (var j = 0; j < 2; j++) {
        var x = a * xs[i] + b * ys[j] + c;
        var y = d * xs[i] + e * ys[j] + f;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    return [r2(x0), r2(y0), r2(x1 - x0), r2(y1 - y0)];
  }

  function roundList(v) {
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(Math.round(v[i] * 1000) / 1000);
    return out;
  }

  // The point of interest's match name is documented nowhere: try
  // "ADBE Point of Interest", then the Anchor Point stream, as camera.jsx does.
  function poiProp(l) {
    var p = transformProp(l, "ADBE Point of Interest");
    if (p) return p;
    return transformProp(l, "ADBE Anchor Point");
  }

  function keysOf(p) {
    try { return p.numKeys; } catch (e) { return 0; }
  }

  // Values are read at time 0 (valueAtTime), never .value: .value follows each
  // comp's own current time, so the same camera would read differently in two comps.
  function cameraFacts(l) {
    var cam = { keys: {} };
    var p = transformProp(l, "ADBE Position");
    try { if (p) { cam.position = roundList(p.valueAtTime(0, false)); cam.keys.position = keysOf(p); } } catch (e0) {}
    var poi = poiProp(l);
    try { if (poi) { cam.point_of_interest = roundList(poi.valueAtTime(0, false)); cam.keys.point_of_interest = keysOf(poi); } } catch (e1) {}
    try {
      var z = l.property("ADBE Camera Options Group").property("ADBE Camera Zoom");
      if (z) { cam.zoom = Math.round(z.valueAtTime(0, false) * 1000) / 1000; cam.keys.zoom = keysOf(z); }
    } catch (e2) {}
    try {
      if (typeof AutoOrientType !== "undefined") cam.two_node = l.autoOrient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
    } catch (e3) {}
    return cam;
  }

  // args: { comp_ids: [ids] } -> { comps: [{ id, name, width, height, num_layers, layers: [...], truncated }] }
  A.layoutRead = function (args) {
    var ids = args.comp_ids || [];
    var comps = [];
    for (var ci = 0; ci < ids.length && ci < MAX_READ_COMPS; ci++) {
      var c = compById(ids[ci]);
      if (!c) {
        comps.push({ id: ids[ci], found: false, layers: [] });
        continue;
      }
      var rec = compFacts(c);
      rec.found = true;
      rec.layers = [];
      rec.truncated = false;
      var n = c.numLayers;
      for (var i = 1; i <= n; i++) {
        if (i > MAX_LAYERS) {
          rec.truncated = true;
          break;
        }
        var l = c.layer(i);
        var lr = { id: l.id, index: l.index, name: clip(l.name, 200), enabled: true, camera: false, rect: null };
        try { lr.enabled = l.enabled !== false; } catch (e0) {}
        lr.camera = isCamera(l);
        var plain = true;
        try { if (l.threeDLayer === true || l.parent || lr.camera || isLight(l)) plain = false; } catch (e1) { plain = false; }
        if (plain) {
          try { lr.rect = boxOf(l); } catch (e2) { lr.rect = null; }
        }
        if (lr.camera) lr.camera_facts = cameraFacts(l);
        rec.layers.push(lr);
      }
      comps.push(rec);
    }
    return { comps: comps };
  };

  // ---------- apply ----------

  function checkPlace(place, what, problems) {
    var ok = place && place.scale && place.position && place.anchor && place.scale.length === 2 && place.position.length === 2 && place.anchor.length === 2;
    if (ok) {
      for (var i = 0; i < 2; i++) {
        if (!isNum(place.scale[i]) || place.scale[i] <= 0 || !isNum(place.position[i]) || !isNum(place.anchor[i])) ok = false;
      }
    }
    if (!ok) problems.push(what + ": the placement (scale, position, anchor) is not valid");
  }

  function sizeMatches(it, size) {
    return size && size.length === 2 && it.width === size[0] && it.height === size[1];
  }

  // Everything that depends on the project's state, checked before the group.
  // Returns a list of problems; empty means the plan can be written.
  function validate(args) {
    var problems = [];
    var target = null;
    var i;
    var r;
    var it;
    if (!args.regions || typeof args.regions.length !== "number") args.regions = [];
    if (!args.copies || typeof args.copies.length !== "number") args.copies = [];
    if (args.regions.length > MAX_REGIONS) problems.push("At most " + MAX_REGIONS + " regions");
    if (args.copies.length > MAX_COPIES) problems.push("At most " + MAX_COPIES + " copies");
    if (args.regions.length + args.copies.length === 0) problems.push("Nothing to do: no regions and no copies");
    if (!isNum(args.feed_fps) || args.feed_fps < 1 || args.feed_fps > 99 || !isNum(args.feed_duration) || args.feed_duration <= 0 || args.feed_duration > 10800) problems.push("feed_fps (1..99) and feed_duration (up to 10800) are missing or out of range");
    if (problems.length > 0) return problems;

    var t = args.target;
    if (!t) {
      problems.push("No target given");
      return problems;
    }
    if (hasVal(t.comp_id)) {
      target = compById(t.comp_id);
      if (!target) problems.push("The target comp " + t.comp_id + " does not exist");
      else if (target.pixelAspect !== 1) problems.push("The target comp has pixel aspect " + target.pixelAspect + "; only square pixels are supported");
    } else if (t.create) {
      var cr = t.create;
      if (typeof cr.name !== "string" || cr.name.length < 1) problems.push("create_master.name is missing");
      if (!isNum(cr.width) || !isNum(cr.height) || cr.width < 4 || cr.height < 4 || cr.width > 30000 || cr.height > 30000) problems.push("create_master width and height must be numbers in 4..30000");
      if (!isNum(cr.fps) || cr.fps < 1 || cr.fps > 99) problems.push("create_master.fps must be a number in 1..99");
      if (!isNum(cr.duration) || cr.duration <= 0 || cr.duration > 10800) problems.push("create_master.duration must be above 0 and at most 10800 seconds");
      if (hasVal(cr.folder_id) && !folderById(cr.folder_id)) problems.push("create_master.target_folder_id is not a project folder");
    } else {
      problems.push("The target is neither an existing comp nor create_master");
    }

    var names = {};
    var usedLayers = {};
    for (i = 0; i < args.regions.length; i++) {
      r = args.regions[i];
      var what = "Region \"" + (r && r.name) + "\"";
      if (!r || typeof r.name !== "string" || r.name.length < 1) {
        problems.push("Region " + (i + 1) + " has no name");
        continue;
      }
      if (names[r.name] === true) problems.push(what + ": the name is used twice");
      names[r.name] = true;
      checkPlace(r.place, what, problems);
      var c = r.content;
      if (!c) {
        problems.push(what + ": no content");
        continue;
      }
      if (c.kind === "comp" || c.kind === "footage") {
        it = itemById(c.item_id);
        if (!it) {
          problems.push(what + ": item " + c.item_id + " does not exist");
        } else {
          if (!sizeMatches(it, c.size)) problems.push(what + ": the item changed size since it was planned");
          if (it.pixelAspect !== 1) problems.push(what + ": the item has pixel aspect " + it.pixelAspect + "; only square pixels are supported");
          if (c.kind === "comp") {
            var cIsComp = false;
            try { cIsComp = it instanceof CompItem; } catch (e0) {}
            if (!cIsComp) problems.push(what + ": item " + c.item_id + " is not a comp");
            else if (target && holdsComp(it, target.id, { seen: {}, visits: 0, truncated: false })) problems.push(what + ": the comp would contain itself");
          }
        }
      } else if (c.kind === "feed") {
        it = itemById(c.footage_id);
        if (!it) problems.push(what + ": footage " + c.footage_id + " does not exist");
        else if (!sizeMatches(it, c.size)) problems.push(what + ": the footage changed size since it was planned");
        else if (it.pixelAspect !== 1) problems.push(what + ": the footage has pixel aspect " + it.pixelAspect + "; only square pixels are supported");
        if (!c.feed || typeof c.feed.name !== "string" || !isNum(c.feed.width) || !isNum(c.feed.height) || c.feed.width < 4 || c.feed.height < 4) problems.push(what + ": the feed comp is not valid");
        else {
          checkPlace(c.feed.place, what + " (feed)", problems);
          if (hasVal(c.feed.folder_id) && !folderById(c.feed.folder_id)) problems.push(what + ": the feed's folder does not exist");
        }
      } else if (c.kind === "layer") {
        if (!target) {
          problems.push(what + ": an existing layer needs an existing target comp");
        } else {
          var ex = layerById(target, c.layer_id);
          if (!ex) {
            problems.push(what + ": the layer is not in the target comp");
          } else {
            if (ex.locked === true) problems.push(what + ": layer \"" + ex.name + "\" is locked");
            if (ex.threeDLayer === true) problems.push(what + ": layer \"" + ex.name + "\" is 3D");
            if (ex.parent) problems.push(what + ": layer \"" + ex.name + "\" is parented");
            if (isCamera(ex) || isLight(ex)) problems.push(what + ": layer \"" + ex.name + "\" is a camera or light");
            if (keyedCount(ex) > 0) problems.push(what + ": layer \"" + ex.name + "\" has keyframes on anchor, position, scale or rotation");
            if (isSeparated(ex)) problems.push(what + ": layer \"" + ex.name + "\" has Position separated into X and Y");
            if (isParentOf(target, ex)) problems.push(what + ": layer \"" + ex.name + "\" is the parent of other layers, which would move with it");
            if (usedLayers[c.layer_id] === true) problems.push(what + ": layer \"" + ex.name + "\" is already filled by another region");
            usedLayers[c.layer_id] = true;
            if (ex.source && !sizeMatches(ex.source, c.size)) problems.push(what + ": the layer's source changed size since it was planned");
          }
        }
      } else {
        problems.push(what + ": unknown content kind");
      }
      if (hasVal(r.above) && target && !layerById(target, r.above)) problems.push(what + ": the layer to stack above is not in the target comp");
      if (hasVal(r.below) && target && !layerById(target, r.below)) problems.push(what + ": the layer to stack below is not in the target comp");
    }

    for (i = 0; i < args.copies.length; i++) {
      var cp = args.copies[i];
      var cw = "Copy " + (i + 1);
      var from = compById(cp.from_comp_id);
      var to = compById(cp.to_comp_id);
      if (!from) problems.push(cw + ": the source comp does not exist");
      if (!to) problems.push(cw + ": the destination comp does not exist");
      if (from && to) {
        if (from.id === to.id) problems.push(cw + ": the source and destination comp are the same");
        var sl = layerById(from, cp.from_layer_id);
        if (!sl) {
          problems.push(cw + ": the layer is not in the source comp");
        } else if (effectCount(sl) > 0) {
          problems.push(cw + ": layer \"" + sl.name + "\" has effects; copying such a layer can crash After Effects on undo");
        }
      }
    }
    return problems;
  }

  function setValueSafe(l, matchName, value) {
    var p = transformProp(l, matchName);
    if (!p) fail("not_found", "Layer \"" + l.name + "\" has no " + matchName);
    p.setValue(value);
  }

  function place(comp, layerId, pl) {
    // Look the layer up again before each property: setValue on one can invalidate the others.
    var l = layerById(comp, layerId);
    setValueSafe(l, "ADBE Anchor Point", [pl.anchor[0], pl.anchor[1]]);
    l = layerById(comp, layerId);
    setValueSafe(l, "ADBE Scale", [pl.scale[0], pl.scale[1]]);
    l = layerById(comp, layerId);
    setValueSafe(l, "ADBE Rotate Z", 0);
    l = layerById(comp, layerId);
    setValueSafe(l, "ADBE Position", [pl.position[0], pl.position[1]]);
  }

  function maskShape(corners) {
    var shape = new Shape();
    shape.vertices = corners;
    shape.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
    shape.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
    shape.closed = true;
    return shape;
  }

  // Adds a mask and names it. The mask group changes with every add, so the
  // layer and the group are looked up again before each step.
  function writeMask(comp, layerId, shape, maskName, mode, inverted) {
    var l = layerById(comp, layerId);
    var parade = l.property("ADBE Mask Parade");
    parade.addProperty("ADBE Mask Atom");
    l = layerById(comp, layerId);
    parade = l.property("ADBE Mask Parade");
    var mask = parade.property(parade.numProperties);
    mask.property("ADBE Mask Shape").setValue(shape);
    l = layerById(comp, layerId);
    parade = l.property("ADBE Mask Parade");
    mask = parade.property(parade.numProperties);
    mask.name = maskName;
    try { mask.maskMode = mode; } catch (e0) {}
    try { if (inverted === true) mask.inverted = true; } catch (e1) {}
  }

  function maskIndexByName(comp, layerId, name) {
    var l = layerById(comp, layerId);
    var parade = l.property("ADBE Mask Parade");
    var n = parade.numProperties;
    for (var i = 1; i <= n; i++) {
      if (parade.property(i).name === name) return i;
    }
    return 0;
  }

  function maskCount(comp, layerId) {
    return layerById(comp, layerId).property("ADBE Mask Parade").numProperties;
  }

  // Removes the mask of that name and returns what it held (to put it back), or null.
  function removeMaskNamed(comp, layerId, name) {
    var idx = maskIndexByName(comp, layerId, name);
    if (idx === 0) return null;
    var l = layerById(comp, layerId);
    var m = l.property("ADBE Mask Parade").property(idx);
    var saved = { name: name, mode: null, inverted: false, shape: null };
    try { saved.mode = m.maskMode; } catch (e0) {}
    try { saved.inverted = m.inverted === true; } catch (e1) {}
    try { saved.shape = m.property("ADBE Mask Shape").valueAtTime(0, false); } catch (e2) {}
    l = layerById(comp, layerId);
    l.property("ADBE Mask Parade").property(idx).remove();
    return saved;
  }

  // The region clip: replaces an earlier mask of the same name, and
  // intersects when the layer has other masks (an ADD mask would reveal more).
  function addClipMask(comp, layerId, corners, maskName) {
    var mode = MaskMode.ADD;
    if (maskCount(comp, layerId) > 0) mode = MaskMode.INTERSECT;
    writeMask(comp, layerId, maskShape(corners), maskName, mode, false);
  }

  function topCamera(comp) {
    var n = comp.numLayers;
    for (var i = 1; i <= n; i++) {
      var l = comp.layer(i);
      var on = true;
      try { on = l.enabled !== false; } catch (e) {}
      if (isCamera(l) && on) return l;
    }
    return null;
  }

  function topCameraExcept(comp, skipId) {
    var n = comp.numLayers;
    for (var i = 1; i <= n; i++) {
      var l = comp.layer(i);
      var on = true;
      try { on = l.enabled !== false; } catch (e) {}
      if (isCamera(l) && on && l.id !== skipId) return l;
    }
    return null;
  }

  // args: { expect, label?, target: { comp_id } | { create: {...} }, regions: [...], copies: [...] }
  // Returns { refused, no_op, problems } without opening a group when the plan cannot be written.
  A.layoutApply = function (args) {
    assertGuard(args.expect);
    var problems = validate(args);
    if (problems.length > 0) {
      return { refused: true, no_op: true, problems: problems.slice(0, 50), problems_total: problems.length };
    }
    var created = [];
    var addedMasks = [];
    var restores = [];
    var snaps = [];
    var placed = [];
    var copied = [];
    var warnings = [];
    var rbFail = [];
    var comp = null;
    var compId = null;
    var i;
    var r;
    var c;

    function snapComp(id) {
      var cm = compById(id);
      var ids = {};
      var order = [];
      var k;
      if (!cm) return;
      for (k = 1; k <= cm.numLayers; k++) {
        ids[cm.layer(k).id] = true;
        order.push(cm.layer(k).id);
      }
      snaps.push({ comp_id: id, ids: ids, order: order });
    }

    // The 1-based index a layer had when the call started (0 if unknown).
    function originalIndex(id, layerId) {
      var k;
      var j;
      for (k = 0; k < snaps.length; k++) {
        if (snaps[k].comp_id !== id) continue;
        for (j = 0; j < snaps[k].order.length; j++) {
          if (snaps[k].order[j] === layerId) return j + 1;
        }
      }
      return 0;
    }

    function moveToIndex(cm, id, idx) {
      var l = layerById(cm, id);
      if (!l || idx < 1 || idx > cm.numLayers || l.index === idx) return;
      if (l.index > idx) l.moveBefore(cm.layer(idx));
      else l.moveAfter(cm.layer(idx));
    }

    // Takes out what this call made and puts changed layers back. Every step is
    // tried on its own; a step that fails is listed in rbFail.
    function rollback() {
      var k;
      var j;
      var l;
      var cm;
      var ids;
      for (k = addedMasks.length - 1; k >= 0; k--) {
        try {
          cm = compById(addedMasks[k].comp_id);
          if (cm && layerById(cm, addedMasks[k].layer_id)) removeMaskNamed(cm, addedMasks[k].layer_id, addedMasks[k].name);
        } catch (e0) { rbFail.push("clip mask " + addedMasks[k].name); }
      }
      // Every layer that was not there when the call started.
      for (k = 0; k < snaps.length; k++) {
        try {
          cm = compById(snaps[k].comp_id);
          if (!cm) continue;
          ids = [];
          for (j = 1; j <= cm.numLayers; j++) {
            if (snaps[k].ids[cm.layer(j).id] !== true) ids.push(cm.layer(j).id);
          }
          for (j = 0; j < ids.length; j++) {
            l = layerById(cm, ids[j]);
            if (l) l.remove();
          }
        } catch (e1) { rbFail.push("added layers of comp " + snaps[k].comp_id); }
      }
      for (k = restores.length - 1; k >= 0; k--) {
        try {
          cm = compById(restores[k].comp_id);
          l = cm ? layerById(cm, restores[k].layer_id) : null;
          if (l) {
            l.name = restores[k].name;
            transformProp(l, "ADBE Anchor Point").setValue(restores[k].anchor);
            transformProp(l, "ADBE Scale").setValue(restores[k].scale);
            transformProp(l, "ADBE Rotate Z").setValue(restores[k].rotation);
            transformProp(l, "ADBE Position").setValue(restores[k].position);
            if (restores[k].mask && restores[k].mask.shape) {
              writeMask(cm, restores[k].layer_id, restores[k].mask.shape, restores[k].mask.name, restores[k].mask.mode, restores[k].mask.inverted);
            }
            moveToIndex(cm, restores[k].layer_id, restores[k].index);
          }
        } catch (e2) { rbFail.push("layer " + restores[k].name); }
      }
      for (k = created.length - 1; k >= 0; k--) {
        try {
          cm = itemById(created[k].id);
          if (cm) cm.remove();
        } catch (e3) { rbFail.push("comp " + created[k].name); }
      }
    }

    return A.withUndo(args.label || "Chroma AE MCP: layout", function () {
      var newId;
      var feedId;
      var feed;
      var fl;
      var flId;
      var fd;
      var item;
      var l;
      var row;
      var src;
      var dest;
      var beforeIds;
      var k;
      var fresh;
      var freshId;
      var extra;
      var cp;
      var srcName;
      var srcIsCamera;
      var topCam;
      var other;
      var active;
      var anchorNow;
      var scaleNow;
      var positionNow;
      var rotationNow;
      var removedMask;
      var maskName;
      var folder;
      try {
        if (args.target.create) {
          var cr = args.target.create;
          comp = app.project.items.addComp(cr.name, cr.width, cr.height, 1, cr.duration, cr.fps);
          compId = comp.id;
          created.push({ kind: "comp", role: "master", id: compId, name: cr.name });
          comp = compById(compId);
          if (cr.bg_color && cr.bg_color.length === 3) comp.bgColor = [cr.bg_color[0], cr.bg_color[1], cr.bg_color[2]];
          if (hasVal(cr.folder_id)) {
            folder = folderById(cr.folder_id);
            comp.parentFolder = folder;
          }
          comp = compById(compId);
        } else {
          compId = args.target.comp_id;
          snapComp(compId);
        }
        for (i = 0; i < args.copies.length; i++) snapComp(args.copies[i].to_comp_id);

        for (i = 0; i < args.regions.length; i++) {
          r = args.regions[i];
          c = r.content;
          comp = compById(compId);
          maskName = r.name + " region";
          if (c.kind === "layer") {
            l = layerById(comp, c.layer_id);
            anchorNow = transformProp(l, "ADBE Anchor Point").value;
            scaleNow = transformProp(l, "ADBE Scale").value;
            positionNow = transformProp(l, "ADBE Position").value;
            rotationNow = transformProp(l, "ADBE Rotate Z").value;
            // An earlier clip of this region is replaced, not stacked.
            removedMask = removeMaskNamed(comp, c.layer_id, maskName);
            l = layerById(comp, c.layer_id);
            restores.push({ comp_id: compId, layer_id: c.layer_id, name: l.name, index: originalIndex(compId, c.layer_id), anchor: [anchorNow[0], anchorNow[1]], scale: [scaleNow[0], scaleNow[1]], position: [positionNow[0], positionNow[1]], rotation: rotationNow, mask: removedMask });
            if (Math.abs(rotationNow) > 1e-6) warnings.push("Region \"" + r.name + "\": layer \"" + l.name + "\" was rotated " + rotationNow + " degrees; the placement sets rotation to 0.");
            if (scaleNow[0] < 0 || scaleNow[1] < 0) warnings.push("Region \"" + r.name + "\": layer \"" + l.name + "\" was flipped (negative scale); the placement writes a positive scale, so the flip is lost.");
            newId = c.layer_id;
          } else {
            if (c.kind === "feed") {
              fd = c.feed;
              feed = app.project.items.addComp(fd.name, fd.width, fd.height, 1, args.feed_duration, args.feed_fps);
              feedId = feed.id;
              created.push({ kind: "comp", role: "feed", id: feedId, name: fd.name });
              if (hasVal(fd.folder_id)) {
                feed = compById(feedId);
                feed.parentFolder = folderById(fd.folder_id);
              }
              feed = compById(feedId);
              fl = feed.layers.add(itemById(c.footage_id));
              flId = fl.id;
              feed = compById(feedId);
              place(feed, flId, fd.place);
              item = compById(feedId);
            } else {
              item = itemById(c.item_id);
            }
            l = comp.layers.add(item);
            newId = l.id;
          }
          comp = compById(compId);
          l = layerById(comp, newId);
          l.name = r.name;
          place(comp, newId, r.place);
          if (r.clip && r.clip.length === 4) {
            addClipMask(comp, newId, r.clip, maskName);
            if (c.kind === "layer") addedMasks.push({ comp_id: compId, layer_id: newId, name: maskName });
          }
          comp = compById(compId);
          if (hasVal(r.above)) {
            l = layerById(comp, newId);
            l.moveBefore(layerById(comp, r.above));
          } else if (hasVal(r.below)) {
            l = layerById(comp, newId);
            l.moveAfter(layerById(comp, r.below));
          }
          row = { name: r.name, layer_id: newId };
          if (c.kind === "feed") row.feed_comp_id = feedId;
          row.clip = r.clip ? true : false;
          placed.push(row);
        }

        for (i = 0; i < args.copies.length; i++) {
          cp = args.copies[i];
          src = layerById(compById(cp.from_comp_id), cp.from_layer_id);
          dest = compById(cp.to_comp_id);
          beforeIds = {};
          for (k = 1; k <= dest.numLayers; k++) beforeIds[dest.layer(k).id] = true;
          srcName = src.name;
          srcIsCamera = isCamera(src);
          src.copyToComp(dest);
          dest = compById(cp.to_comp_id);
          fresh = null;
          extra = 0;
          for (k = 1; k <= dest.numLayers; k++) {
            if (beforeIds[dest.layer(k).id] !== true) {
              extra++;
              if (!fresh) fresh = dest.layer(k);
            }
          }
          if (!fresh || extra !== 1) {
            fail("not_found", "Copy " + (i + 1) + ": could not tell which layer copyToComp added to the destination (" + extra + " new layers); stopped");
          }
          freshId = fresh.id;
          if (cp.name) {
            fresh = layerById(dest, freshId);
            fresh.name = cp.name;
          }
          if (srcIsCamera) {
            dest = compById(cp.to_comp_id);
            topCam = topCamera(dest);
            if (cp.as_active_camera !== false) {
              if (topCam && topCam.id !== freshId) layerById(dest, freshId).moveToBeginning();
            } else if (topCam && topCam.id === freshId) {
              // Keep the camera that was active: put the copy below it.
              other = topCameraExcept(dest, freshId);
              if (other) layerById(dest, freshId).moveAfter(layerById(dest, other.id));
            }
          }
          dest = compById(cp.to_comp_id);
          active = topCamera(dest);
          copied.push({
            to_comp_id: cp.to_comp_id,
            from_layer_id: cp.from_layer_id,
            layer_id: freshId,
            name: layerById(dest, freshId).name,
            camera: srcIsCamera,
            active_camera: active ? active.id === freshId : false
          });
        }
      } catch (err) {
        rollback();
        if (!err.__kind) err.__kind = "runtime";
        if (rbFail.length === 0) {
          err.message = String(err.message) + " (rolled back: the layers and comps this call added were removed and the layers it changed were put back; its undo step may remain, Ctrl+Z once clears it)";
        } else {
          err.message = String(err.message) + " (rollback INCOMPLETE, " + rbFail.length + " step(s) failed: " + rbFail.slice(0, 3).join("; ") + ". Inspect the project; Ctrl+Z once undoes this call)";
        }
        throw err;
      }

      // Final indexes, after every add and move.
      comp = compById(compId);
      for (i = 0; i < placed.length; i++) {
        l = layerById(comp, placed[i].layer_id);
        if (l) placed[i].index = l.index;
      }
      return {
        comp_id: compId,
        created: created,
        placed: placed,
        copies: copied,
        warnings: warnings
      };
    });
  };
})($.global);
