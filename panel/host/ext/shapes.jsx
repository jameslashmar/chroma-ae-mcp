// panel/host/ext/shapes.jsx
//
// Host functions for the shape tool:
// - shapeContents (read): a shape layer's top-level contents, each group's
//   shapes, fill and stroke with their main values
// - shapeEdit (guarded write): add groups (rectangle, ellipse, star, polygon
//   or a free path, with fill and stroke) and remove top-level contents
//
// Adding a property invalidates references to its siblings (as with
// effects), so every step looks its target up again from the layer.
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

  var MAX_ITEMS = 200;

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

  function shapeLayer(comp, sel) {
    var l = findLayer(comp, sel);
    var isShape = false;
    try { isShape = String(l.reflect.name) === "ShapeLayer"; } catch (e) {}
    if (!isShape) fail("bad_args", "\"" + l.name + "\" is not a shape layer (create one with ae_create_layer type 'shape')");
    return l;
  }

  function contentsOf(layer) {
    return layer.property("ADBE Root Vectors Group");
  }

  function val(group, matchName) {
    try {
      var p = group.property(matchName);
      if (!p) return null;
      var v = p.value;
      if (v instanceof Array) {
        var out = [];
        for (var i = 0; i < v.length; i++) out.push(v[i]);
        return out;
      }
      if (typeof v === "number" || typeof v === "boolean") return v;
      return null;
    } catch (e) {
      return null;
    }
  }

  var KIND_BY_MATCH = {
    "ADBE Vector Shape - Rect": "rect",
    "ADBE Vector Shape - Ellipse": "ellipse",
    "ADBE Vector Shape - Star": "star",
    "ADBE Vector Shape - Group": "path",
    "ADBE Vector Graphic - Fill": "fill",
    "ADBE Vector Graphic - Stroke": "stroke",
    "ADBE Vector Group": "group"
  };

  function describeItem(p) {
    var kind = KIND_BY_MATCH[p.matchName];
    if (!kind) kind = "other";
    var d = { name: p.name, matchName: p.matchName, kind: kind };
    if (kind === "rect") {
      d.size = val(p, "ADBE Vector Rect Size");
      d.position = val(p, "ADBE Vector Rect Position");
      d.roundness = val(p, "ADBE Vector Rect Roundness");
    } else if (kind === "ellipse") {
      d.size = val(p, "ADBE Vector Ellipse Size");
      d.position = val(p, "ADBE Vector Ellipse Position");
    } else if (kind === "star") {
      var t = val(p, "ADBE Vector Star Type");
      d.star_kind = "star";
      if (t === 2) d.star_kind = "polygon";
      d.points = val(p, "ADBE Vector Star Points");
      d.outer_radius = val(p, "ADBE Vector Star Outer Radius");
      d.inner_radius = val(p, "ADBE Vector Star Inner Radius");
    } else if (kind === "path") {
      try {
        var sh = p.property("ADBE Vector Shape").value;
        d.vertices = sh.vertices.length;
        d.closed = sh.closed;
      } catch (eShape) {}
    } else if (kind === "fill") {
      d.color = val(p, "ADBE Vector Fill Color");
      d.opacity = val(p, "ADBE Vector Fill Opacity");
    } else if (kind === "stroke") {
      d.color = val(p, "ADBE Vector Stroke Color");
      d.width = val(p, "ADBE Vector Stroke Width");
      d.opacity = val(p, "ADBE Vector Stroke Opacity");
    } else if (kind === "group") {
      var items = [];
      try {
        var vectors = p.property("ADBE Vectors Group");
        for (var i = 1; i <= vectors.numProperties && items.length < MAX_ITEMS; i++) items.push(describeItem(vectors.property(i)));
      } catch (eGroup) {}
      d.items = items;
      try { d.group_position = val(p.property("ADBE Vector Transform Group"), "ADBE Vector Position"); } catch (eT) {}
    }
    return d;
  }

  A.shapeContents = function (args) {
    var comp = requireComp(args.comp_id);
    var layer = shapeLayer(comp, args.layer);
    var contents = contentsOf(layer);
    var out = { layer: { index: layer.index, id: layer.id, name: layer.name }, count: contents.numProperties, contents: [], truncated: false };
    for (var i = 1; i <= contents.numProperties; i++) {
      if (out.contents.length >= MAX_ITEMS) {
        out.truncated = true;
        break;
      }
      var d = describeItem(contents.property(i));
      d.index = i;
      out.contents.push(d);
    }
    return out;
  };

  function setIf(group, matchName, v) {
    if (v === undefined || v === null) return;
    var p = group.property(matchName);
    if (!p) fail("bad_args", "No " + matchName + " in " + group.name);
    p.setValue(v);
  }

  function color3(c) {
    if (!c) return null;
    var a = 1;
    if (c.length > 3) a = c[3];
    return [c[0], c[1], c[2], a];
  }

  // Adds one group with its shape, fill and stroke. Returns the group's index.
  function addGroup(layer, spec, n) {
    var contents = contentsOf(layer);
    contents.addProperty("ADBE Vector Group");
    var gi = contents.numProperties;
    var name = spec.name;
    if (!name) name = spec.type + " " + n;
    contentsOf(layer).property(gi).name = name;
    var shapeMatch = null;
    if (spec.type === "rect") shapeMatch = "ADBE Vector Shape - Rect";
    else if (spec.type === "ellipse") shapeMatch = "ADBE Vector Shape - Ellipse";
    else if (spec.type === "star" || spec.type === "polygon") shapeMatch = "ADBE Vector Shape - Star";
    else if (spec.type === "path") shapeMatch = "ADBE Vector Shape - Group";
    else fail("bad_args", "Unknown shape type \"" + spec.type + "\"");

    var vectors = function () { return contentsOf(layer).property(gi).property("ADBE Vectors Group"); };
    vectors().addProperty(shapeMatch);
    var shape = vectors().property(1);
    if (spec.type === "rect") {
      setIf(shape, "ADBE Vector Rect Size", spec.size);
      setIf(shape, "ADBE Vector Rect Position", spec.position);
      setIf(shape, "ADBE Vector Rect Roundness", spec.roundness);
    } else if (spec.type === "ellipse") {
      setIf(shape, "ADBE Vector Ellipse Size", spec.size);
      setIf(shape, "ADBE Vector Ellipse Position", spec.position);
    } else if (spec.type === "star" || spec.type === "polygon") {
      if (spec.type === "polygon") shape.property("ADBE Vector Star Type").setValue(2);
      else shape.property("ADBE Vector Star Type").setValue(1);
      setIf(shape, "ADBE Vector Star Points", spec.points);
      setIf(shape, "ADBE Vector Star Position", spec.position);
      setIf(shape, "ADBE Vector Star Rotation", spec.rotation);
      setIf(shape, "ADBE Vector Star Outer Radius", spec.outer_radius);
      if (spec.type === "star") setIf(shape, "ADBE Vector Star Inner Radius", spec.inner_radius);
    } else {
      var s = new Shape();
      s.vertices = spec.vertices;
      if (spec.in_tangents) s.inTangents = spec.in_tangents;
      if (spec.out_tangents) s.outTangents = spec.out_tangents;
      s.closed = spec.closed !== false;
      shape.property("ADBE Vector Shape").setValue(s);
    }
    if (spec.stroke) {
      vectors().addProperty("ADBE Vector Graphic - Stroke");
      var st = vectors().property(vectors().numProperties);
      setIf(st, "ADBE Vector Stroke Color", color3(spec.stroke.color));
      setIf(st, "ADBE Vector Stroke Width", spec.stroke.width);
      setIf(st, "ADBE Vector Stroke Opacity", spec.stroke.opacity);
    }
    if (spec.fill) {
      vectors().addProperty("ADBE Vector Graphic - Fill");
      var fl = vectors().property(vectors().numProperties);
      setIf(fl, "ADBE Vector Fill Color", color3(spec.fill.color));
      setIf(fl, "ADBE Vector Fill Opacity", spec.fill.opacity);
    }
    if (spec.group_position) {
      setIf(contentsOf(layer).property(gi).property("ADBE Vector Transform Group"), "ADBE Vector Position", spec.group_position);
    }
    return { index: gi, name: name };
  }

  A.shapeEdit = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = shapeLayer(comp, args.layer);
    var adds = args.add || [];
    var removes = args.remove || [];
    if (adds.length > MAX_ITEMS) fail("bad_args", "At most " + MAX_ITEMS + " shapes per call");
    // Resolve what to remove first, by index from the end, so names and indexes don't shift under us.
    var contents = contentsOf(layer);
    var drop = [];
    var r;
    for (r = 0; r < removes.length; r++) {
      var sel = removes[r];
      var idx = -1;
      if (sel.index !== undefined && sel.index !== null) {
        if (sel.index < 1 || sel.index > contents.numProperties) fail("not_found", "Content index " + sel.index + " out of range");
        idx = sel.index;
      } else {
        var hits = 0;
        for (var k = 1; k <= contents.numProperties; k++) {
          if (contents.property(k).name === sel.name) {
            hits++;
            idx = k;
          }
        }
        if (hits === 0) fail("not_found", "No content named \"" + sel.name + "\"");
        if (hits > 1) fail("bad_args", hits + " contents are named \"" + sel.name + "\"; remove by index");
      }
      // Two selectors for the same content remove it once; a second removal would take whatever shifted into its place.
      var dup = false;
      for (var d = 0; d < drop.length; d++) {
        if (drop[d] === idx) dup = true;
      }
      if (!dup) drop.push(idx);
    }
    drop.sort(function (a, b) { return b - a; });
    return A.withUndo(args.label || "Edit shapes", function () {
      var removed = [];
      for (r = 0; r < drop.length; r++) {
        var p = contentsOf(layer).property(drop[r]);
        removed.push({ index: drop[r], name: p.name });
        p.remove();
      }
      var added = [];
      for (var a = 0; a < adds.length; a++) added.push(addGroup(layer, adds[a], contentsOf(layer).numProperties + 1));
      return { removed: removed, added: added, count: contentsOf(layer).numProperties };
    });
  };
})($.global);
