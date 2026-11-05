// panel/host/ext/rig.jsx
//
// Host functions for the rig tools (all prefixed "rig"):
// - rigState (read): the expression, enabled flag and expressionError of
//   named properties, the controls by name, and the expressions that name a
//   control; the receipt's read-back, run in its own evalScript
// - rigList (read): every Expression Control in a comp with the expressions
//   that reference it (a text search)
// - rigAddControls (guarded write): Expression Controls on a layer, or on a
//   null made for the purpose
// - rigLink (guarded write): link properties to controls with a generated,
//   locale-proof expression: effect("Name")(1), never the parameter's name
// - rigUnlink (guarded write): clear the expression of linked properties
// - rigRename (guarded write): rename a control, then repair the expressions
//   that named it
// - rigRecipe (guarded write): a curated expression recipe, with the
//   controls it needs
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - All mutations check the target guard first, validate everything that can
//   fail before the undo group opens, and wrap changes in A.withUndo.
// - Reads never touch time, selection or any other state: forcing an
//   expression to evaluate uses valueAtTime, which does not move the comp.
// - Before and after reads run in separate evalScript calls from the server.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_STATE = 200;
  var MAX_REFS = 50;
  var MAX_NODES = 20000;
  var MAX_STRING = 20000;
  // AE's Slider Control takes -1,000,000 to 1,000,000 (confirm live); angles are wider.
  var MAX_SLIDER = 1000000;
  var MAX_ANGLE = 1000000000;
  var MAX_ITEMS = 100;
  var MAX_REFS_TOTAL = 500;

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

  function layerRef(l) {
    return { index: l.index, id: l.id, name: l.name };
  }

  function clip(s, n) {
    s = String(s);
    if (s.length > n) return s.substring(0, n) + " ...[truncated]";
    return s;
  }

  // A string for the inside of a double-quoted expression string.
  function jsString(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  }

  function num(n) {
    return String(n);
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function plain(v, limit) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v.length === "number") {
      var out = [];
      var cap = limit ? limit : 16;
      for (var i = 0; i < v.length && i < cap; i++) out.push(plain(v[i]));
      return out;
    }
    return String(v);
  }

  // The same text with one kind of line break, for comparing expressions.
  function sameText(a, b) {
    return String(a).replace(/\r\n?|\n/g, "\n") === String(b).replace(/\r\n?|\n/g, "\n");
  }

  // ---------- control kinds ----------

  var KINDS = {
    slider: "ADBE Slider Control",
    angle: "ADBE Angle Control",
    checkbox: "ADBE Checkbox Control",
    color: "ADBE Color Control",
    point: "ADBE Point Control",
    point3d: "ADBE Point3D Control",
    layer: "ADBE Layer Control",
    dropdown: "ADBE Dropdown Control"
  };

  // The kind of Expression Control an effect is, or null. AE 26.2 reports the
  // dropdown it adds under ADBE Dropdown Control as a pseudo effect whose match
  // name (Pseudo/@@...) is not a constant and not a function of the items: it
  // changes between dropdowns and between runs, even for identical items (seen
  // live: the same items [A,B,C] got a different name on each run). Nothing may
  // depend on the name. A dropdown is recognised by its one parameter:
  // isDropdownEffect is true.
  function onlyParameter(fx) {
    for (var j = 2; j <= fx.numProperties; j++) {
      if (fx.property(j).matchName !== "ADBE Effect Built In Params") return false;
    }
    return true;
  }

  function kindOfEffect(fx) {
    var mn = "";
    try { mn = String(fx.matchName); } catch (e0) { return null; }
    for (var k in KINDS) {
      if (KINDS.hasOwnProperty(k) && KINDS[k] === mn) return k;
    }
    if (mn.indexOf("Pseudo/@@") === 0) {
      try {
        // One parameter (the effect also lists its Compositing Options group): a pseudo effect with more is a preset, not a control.
        if (fx.property(1).isDropdownEffect === true && onlyParameter(fx)) return "dropdown";
      } catch (e1) {}
    }
    return null;
  }

  function aeAtLeast(maj, min, patch) {
    var parts = String(app.version).split(".");
    var have = [parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10)];
    var want = [maj, min, patch];
    for (var i = 0; i < 3; i++) {
      var h = have[i];
      if (isNaN(h)) h = 0;
      if (h > want[i]) return true;
      if (h < want[i]) return false;
    }
    return true;
  }

  // Names go inside double quotes in expressions, so those and backslashes
  // (and line breaks) can't be in them.
  function checkName(name, what) {
    if (typeof name !== "string" || name.length < 1 || name.length > 200) fail("bad_args", what + " must be a string of 1 to 200 characters");
    if (/["\\\r\n\t]/.test(name)) fail("bad_args", what + " \"" + name + "\" has a quote, backslash or line break; expressions can't name it safely");
  }

  function parade(layer) {
    var par = null;
    try {
      par = layer.property("ADBE Effect Parade");
    } catch (e) {
      par = null;
    }
    return par;
  }

  function assertUnlocked(layer) {
    var locked = false;
    try { locked = layer.locked === true; } catch (e) { locked = false; }
    if (locked) fail("bad_args", "Layer \"" + layer.name + "\" is locked; unlock it first");
  }

  function requireParade(layer) {
    var par = parade(layer);
    if (!par) fail("bad_args", "Layer \"" + layer.name + "\" can't hold effects (cameras and lights can't)");
    return par;
  }

  // The effects on a layer with this name.
  function effectsNamed(par, name) {
    var out = [];
    for (var i = 1; i <= par.numProperties; i++) {
      var fx = par.property(i);
      if (fx && fx.name === name) out.push(fx);
    }
    return out;
  }

  // A control by name on a layer: one match, and one of the Expression Controls.
  function findControl(layer, name) {
    var par = requireParade(layer);
    var hits = effectsNamed(par, name);
    if (hits.length === 0) fail("not_found", "No effect named \"" + name + "\" on layer \"" + layer.name + "\"");
    if (hits.length > 1) fail("bad_args", hits.length + " effects on \"" + layer.name + "\" are named \"" + name + "\"; rename one first");
    var kind = kindOfEffect(hits[0]);
    if (kind === null) fail("bad_args", "Effect \"" + name + "\" on \"" + layer.name + "\" is not an Expression Control (" + hits[0].matchName + ")");
    return { effect: hits[0], kind: kind, index: hits[0].propertyIndex };
  }

  // Expressions name a layer by its name, so it must be the only one with it.
  function requireReferencableLayer(comp, layer) {
    checkName(layer.name, "Layer name");
    var count = 0;
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).name === layer.name) count++;
    }
    if (count > 1) fail("bad_args", count + " layers are named \"" + layer.name + "\"; an expression can't tell them apart. Rename one first");
  }

  // How an expression on `from` reaches a control on `holder`. Index 1 is the
  // control's value: its display name ("Slider") is translated by AE's language.
  function controlRef(comp, holder, from, controlName) {
    if (holder.id === from.id) return "effect(\"" + controlName + "\")(1)";
    requireReferencableLayer(comp, holder);
    return "thisComp.layer(\"" + holder.name + "\").effect(\"" + controlName + "\")(1)";
  }

  // ---------- properties ----------

  function dimOf(p) {
    var t = null;
    try {
      t = p.propertyValueType;
    } catch (e) {
      return "other";
    }
    if (t === PropertyValueType.OneD) return "1d";
    if (t === PropertyValueType.TwoD || t === PropertyValueType.TwoD_SPATIAL) return "2d";
    if (t === PropertyValueType.ThreeD || t === PropertyValueType.ThreeD_SPATIAL) return "3d";
    if (t === PropertyValueType.COLOR) return "color";
    if (t === PropertyValueType.TEXT_DOCUMENT) return "text";
    if (t === PropertyValueType.LAYER_INDEX) return "layer";
    return "other";
  }

  // Walks a path of names or match names; returns the property and its match-name path.
  function resolveProp(layer, path) {
    if (!path || typeof path.length !== "number" || path.length < 1) fail("bad_args", "path must name a property");
    var p = layer;
    var matchPath = [];
    for (var i = 0; i < path.length; i++) {
      var next = null;
      try {
        next = p.property(path[i]);
      } catch (e) {
        next = null;
      }
      if (!next) fail("not_found", "Property path not found at \"" + path[i] + "\" (" + path.join(" > ") + ")");
      matchPath.push(String(next.matchName));
      p = next;
    }
    if (p.propertyType !== PropertyType.PROPERTY) fail("bad_args", "Path resolves to a group, not a property");
    return { prop: p, matchPath: matchPath };
  }

  function forceable(p) {
    try {
      return !(p.propertyValueType === PropertyValueType.CUSTOM_VALUE || p.propertyValueType === PropertyValueType.NO_VALUE);
    } catch (e) {
      return false;
    }
  }

  // The expression, whether it is on, and AE's error for it. force evaluates
  // it first, because AE may fill in expressionError only once it has run.
  function exprState(p, force, time) {
    var s = { expression: "", enabled: false, error: "" };
    try {
      var ex = p.expression;
      if (ex !== undefined && ex !== null) s.expression = clip(ex, MAX_STRING);
    } catch (e1) {}
    try {
      s.enabled = p.expressionEnabled === true;
    } catch (e2) {}
    if (force && s.expression.length > 0 && s.enabled && forceable(p)) {
      try {
        p.valueAtTime(time, false);
      } catch (e3) {
        try {
          s.thrown = clip(e3.message ? e3.message : e3, 300);
        } catch (e4) {
          s.thrown = "Expression evaluation threw an error";
        }
      }
    }
    try {
      var pe = p.expressionError;
      if (pe && String(pe).length > 0) s.error = clip(pe, 300);
    } catch (e5) {}
    return s;
  }

  // ---------- reading expressions in a comp ----------

  function walkProps(group, visit, S, names, matches) {
    var n = 0;
    try {
      n = group.numProperties;
    } catch (e) {
      return;
    }
    for (var i = 1; i <= n; i++) {
      if (S.nodes >= MAX_NODES) {
        S.truncated = true;
        return;
      }
      var p = null;
      try {
        p = group.property(i);
      } catch (e1) {
        p = null;
      }
      if (!p) continue;
      S.nodes++;
      var nm = "";
      var mn = "";
      try { nm = String(p.name); } catch (e2) {}
      try { mn = String(p.matchName); } catch (e3) {}
      names.push(nm);
      matches.push(mn);
      var leaf = false;
      try { leaf = p.propertyType === PropertyType.PROPERTY; } catch (e4) {}
      if (leaf) visit(p, names, matches);
      else walkProps(p, visit, S, names, matches);
      names.pop();
      matches.pop();
    }
  }

  // Every property with an expression, on the given layers.
  function collectExpressions(layers, S) {
    var out = [];
    for (var li = 0; li < layers.length; li++) {
      var layer = layers[li];
      walkProps(layer, function (p, names, matches) {
        var ex = "";
        try {
          ex = p.expression;
          if (ex === undefined || ex === null) ex = "";
          ex = String(ex);
        } catch (e) {
          ex = "";
        }
        if (ex.length === 0) return;
        out.push({ layer: layer, prop: p, text: ex, names: names.slice(0), matches: matches.slice(0) });
      }, S, [], []);
      if (S.truncated) break;
    }
    return out;
  }

  // The first 500 layers; S.truncated is set when the comp has more.
  function allLayers(comp, S) {
    var out = [];
    var n = comp.numLayers;
    if (n > MAX_LIST) {
      n = MAX_LIST;
      if (S) S.truncated = true;
    }
    for (var i = 1; i <= n; i++) out.push(comp.layer(i));
    return out;
  }

  function mentionsEffect(text, name) {
    return text.indexOf("effect(\"" + name + "\")") >= 0 || text.indexOf("effect('" + name + "')") >= 0;
  }

  function mentionsLayer(text, name) {
    return text.indexOf("layer(\"" + name + "\")") >= 0 || text.indexOf("layer('" + name + "')") >= 0;
  }

  // A text search: the expression names the effect, and on another layer also names the layer.
  // The layer named just before a match, as in layer("X").effect(...):
  // { name, start } (start is where layer( begins), or null.
  function layerBefore(text, pos) {
    var m = /layer\((["'])((?:(?!\1)[\s\S])*)\1\)\s*\.\s*$/.exec(text.substring(0, pos));
    if (!m) return null;
    return { name: m[2], start: m.index };
  }

  // The name of the comp an expression runs in, or null when the host does not say.
  function ownCompName(entry) {
    try {
      return String(entry.layer.containingComp.name);
    } catch (e) {
      return null;
    }
  }

  // Which comp a name stands for: "this" (the expression's own), "other", "maybe".
  // thisComp is this one; comp("X") is this one only when X is its name.
  function compNamed(entry, name) {
    var own = ownCompName(entry);
    if (own === null) return "maybe";
    if (name === own) return "this";
    return "other";
  }

  // The comp the text in front of a layer( reaches, from the text alone: "this",
  // "other" or "maybe". prefix is what stands in front of layer( with its dot
  // removed; nothing in front (a bare layer( call) is this comp. A variable
  // is followed back to its assignments (var m = comp("X")).
  function compOfPrefix(entry, prefix) {
    var p = prefix.replace(/\s+$/, "");
    if (p.length === 0) return "this";
    if (/(?:^|[^\w$.])thisComp$/.test(p)) return "this";
    var named = /(?:^|[^\w$.])comp\((["'])((?:(?!\1)[\s\S])*)\1\)$/.exec(p);
    if (named) return compNamed(entry, named[2]);
    var v = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/.exec(p);
    if (!v) return "maybe";
    var re = new RegExp("(?:^|[^\\w$.])(?:var\\s+)?" + v[1].replace(/\$/g, "\\$") + "\\s*=(?!=)\\s*([^;\\n]*)", "g");
    var before = p.substring(0, v.index);
    var answer = null;
    var rhs;
    while ((rhs = re.exec(before)) !== null) {
      var value = rhs[1].replace(/\s+$/, "");
      var one = "maybe";
      if (value === "thisComp") {
        one = "this";
      } else {
        var cm = /^comp\((["'])((?:(?!\1)[\s\S])*)\1\)$/.exec(value);
        if (cm) one = compNamed(entry, cm[2]);
      }
      if (answer === null) answer = one;
      else if (answer !== one) answer = "maybe";
    }
    if (answer === null) return "maybe";
    return answer;
  }

  // Every place the text names the effect: [position, ...].
  function effectSpots(text, name) {
    var spots = [];
    var needles = ["effect(\"" + name + "\")", "effect('" + name + "')"];
    for (var n = 0; n < needles.length; n++) {
      var at = text.indexOf(needles[n]);
      while (at >= 0) {
        spots.push(at);
        at = text.indexOf(needles[n], at + 1);
      }
    }
    return spots;
  }

  // What a spot like c.effect("Name") reaches, from the text alone:
  // "yes" (the holder's control), "no" (another layer's), "maybe" (can't tell).
  // layer("X").effect(..) names its layer, and counts only in this comp
  // (thisComp.layer, a bare layer(, or a variable holding thisComp; comp("Y")
  // is another comp unless Y is this one's name); a bare effect( or thisLayer.effect(
  // is the expression's own layer; a variable is followed back to its one
  // assignment (var c = thisComp.layer("X")). Anything else is "maybe".
  function reachOfSpot(entry, holder, spot) {
    var lb = layerBefore(entry.text, spot);
    if (lb !== null) {
      if (lb.name !== holder.name) return "no";
      // The holder's name, but in which comp? Only this comp's layer is the holder.
      var pre = entry.text.substring(0, lb.start);
      var inComp = "this";
      if (/[\w$]$/.test(pre)) inComp = "maybe";
      else if (/\.\s*$/.test(pre)) inComp = compOfPrefix(entry, pre.replace(/\s*\.\s*$/, ""));
      if (inComp === "this") return "yes";
      if (inComp === "other") return "no";
      return "maybe";
    }
    var before = entry.text.substring(0, spot);
    if (/[\w$]$/.test(before)) return "no";
    var own = entry.layer.id === holder.id ? "yes" : "no";
    if (!/\.\s*$/.test(before)) return own;
    var m = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(before);
    if (!m) return "maybe";
    if (m[1] === "thisLayer") return own;
    var re = new RegExp("(?:^|[^\\w$.])(?:var\\s+)?" + m[1].replace(/\$/g, "\\$") + "\\s*=(?!=)\\s*([^;\\n]*)", "g");
    var answer = null;
    var rhs;
    while ((rhs = re.exec(before)) !== null) {
      var value = rhs[1].replace(/\s+$/, "");
      var one = "maybe";
      if (value === "thisLayer") {
        one = own;
      } else {
        var named = /^(?:thisComp\s*\.\s*)?layer\((["'])((?:(?!\1)[\s\S])*)\1\)$/.exec(value);
        if (named) one = named[2] === holder.name ? "yes" : "no";
      }
      if (answer === null) answer = one;
      else if (answer !== one) answer = "maybe";
    }
    if (answer === null) return "maybe";
    return answer;
  }

  // For reading: a "maybe" counts when the expression also names the holder layer.
  function spotReaches(entry, holder, spot) {
    var r = reachOfSpot(entry, holder, spot);
    if (r === "maybe") return mentionsLayer(entry.text, holder.name);
    return r === "yes";
  }

  function refersTo(entry, holder, name) {
    var spots = effectSpots(entry.text, name);
    for (var i = 0; i < spots.length; i++) {
      if (spotReaches(entry, holder, spots[i])) return true;
    }
    return false;
  }

  // For writing: only the spots that are surely the holder's control change.
  // The spots refersTo counts but could not be placed are counted in unresolved
  // and left as they are. effect("Old") is 8 characters before the name.
  function renamedText(entry, holder, oldName, newName) {
    var spots = effectSpots(entry.text, oldName);
    var keep = [];
    var unresolved = 0;
    for (var i = 0; i < spots.length; i++) {
      if (reachOfSpot(entry, holder, spots[i]) === "yes") keep.push(spots[i]);
      else if (spotReaches(entry, holder, spots[i])) unresolved++;
    }
    keep.sort(function (a, b) { return b - a; });
    var text = entry.text;
    for (var j = 0; j < keep.length; j++) {
      // The quote sits at keep[j] + 7. A control name may hold an apostrophe
      // (checkName forbids only the double quote and the backslash), so in a
      // single-quoted spot each one gets a backslash.
      var put = newName;
      if (text.charAt(keep[j] + 7) === "'") put = newName.replace(/'/g, "\\'");
      text = text.substring(0, keep[j] + 8) + put + text.substring(keep[j] + 8 + oldName.length);
    }
    return { text: text, changed: keep.length, unresolved: unresolved };
  }

  function refEntry(entry, withError, time) {
    var r = {
      layer_id: entry.layer.id,
      layer_name: entry.layer.name,
      path: entry.names.join(" > "),
      match_path: entry.matches,
      expression: clip(entry.text, 600)
    };
    if (withError) {
      // One evaluation per property, however many controls name it.
      if (!entry.st) entry.st = exprState(entry.prop, true, time);
      var st = entry.st;
      r.error = st.error.length > 0 ? st.error : null;
      if (st.thrown) r.thrown = st.thrown;
    }
    return r;
  }

  // ---------- reads ----------

  function controlInfo(fx, layer, comp) {
    var kind = kindOfEffect(fx);
    var info = {
      found: true,
      layer_id: layer.id,
      layer_name: layer.name,
      name: fx.name,
      index: fx.propertyIndex,
      kind: kind,
      match_name: String(fx.matchName)
    };
    var main = null;
    try { main = fx.property(1); } catch (e0) {}
    if (main) {
      try { info.value = plain(main.value); } catch (e1) {}
      if (kind === "dropdown") {
        // Property.propertyParameters is AE 26+; older AE can't read the items back.
        try {
          if (main.propertyParameters !== undefined) {
            info.items = plain(main.propertyParameters, MAX_ITEMS);
            if (main.propertyParameters && main.propertyParameters.length > MAX_ITEMS) info.items_truncated = true;
          }
        } catch (e2) {}
      } else if (kind === "layer" && comp && isNum(info.value) && info.value > 0) {
        // The value is the picked layer's index; say which layer that is.
        try {
          var tl = comp.layer(info.value);
          if (tl) info.layer_target = { index: tl.index, id: tl.id, name: tl.name };
        } catch (e3) {}
      }
    }
    return info;
  }

  // One entry's selector, or null when the layer is gone: reads report, they don't throw.
  function softLayer(comp, sel) {
    try {
      return findLayer(comp, sel);
    } catch (e) {
      return null;
    }
  }

  A.rigState = function (args) {
    var comp = requireComp(args.comp_id);
    var time = comp.time;
    var out = { props: [], controls: [], scans: [] };
    var i;
    var props = args.props || [];
    for (i = 0; i < props.length && i < MAX_STATE; i++) {
      var pe = { found: false, path: props[i].path };
      var layer = softLayer(comp, props[i].layer);
      if (layer) {
        pe.layer_id = layer.id;
        try {
          var rp = resolveProp(layer, props[i].path);
          var st = exprState(rp.prop, true, time);
          pe.found = true;
          pe.dims = dimOf(rp.prop);
          pe.expression = st.expression;
          pe.enabled = st.enabled;
          pe.error = null;
          if (st.error.length > 0) pe.error = st.error;
          else if (st.thrown) pe.error = st.thrown;
          try { pe.num_keys = rp.prop.numKeys; } catch (e1) {}
        } catch (e2) {
          pe.message = String(e2.message);
        }
      }
      out.props.push(pe);
    }
    var controls = args.controls || [];
    for (i = 0; i < controls.length && i < MAX_STATE; i++) {
      var ce = { found: false, name: controls[i].name };
      var cl = softLayer(comp, controls[i].layer);
      if (cl) {
        var par = parade(cl);
        var hits = par ? effectsNamed(par, controls[i].name) : [];
        ce.layer_id = cl.id;
        if (hits.length === 1) ce = controlInfo(hits[0], cl, comp);
        else if (hits.length > 1) ce.message = hits.length + " effects have this name";
      }
      out.controls.push(ce);
    }
    var scans = args.scans || [];
    if (scans.length > 0) {
      var S = { nodes: 0, truncated: false };
      var entries = collectExpressions(allLayers(comp, S), S);
      for (i = 0; i < scans.length && i < 20; i++) {
        var sc = { found: false, name: scans[i].name, count: 0, references: [], truncated: false };
        var sl = softLayer(comp, scans[i].layer);
        if (sl) {
          sc.found = true;
          sc.layer_id = sl.id;
          for (var k = 0; k < entries.length; k++) {
            if (!refersTo(entries[k], sl, scans[i].name)) continue;
            sc.count++;
            if (sc.references.length < MAX_REFS) sc.references.push(refEntry(entries[k], true, time));
            else sc.truncated = true;
          }
        }
        out.scans.push(sc);
      }
      out.scan_truncated = S.truncated;
    }
    return out;
  };

  A.rigList = function (args) {
    var comp = requireComp(args.comp_id);
    var time = comp.time;
    var layers = [];
    if (args.layer) layers.push(findLayer(comp, args.layer));
    else layers = allLayers(comp);
    var withRefs = args.include_references !== false;
    var entries = [];
    var S = { nodes: 0, truncated: false };
    if (withRefs) entries = collectExpressions(allLayers(comp, S), S);
    var controls = [];
    var refsListed = 0;
    var refsTruncated = false;
    var truncated = comp.numLayers > MAX_LIST && !args.layer;
    for (var li = 0; li < layers.length; li++) {
      var par = parade(layers[li]);
      if (!par) continue;
      for (var i = 1; i <= par.numProperties; i++) {
        var fx = par.property(i);
        if (!fx || kindOfEffect(fx) === null) continue;
        if (controls.length >= MAX_LIST) {
          truncated = true;
          break;
        }
        var info = controlInfo(fx, layers[li], comp);
        if (withRefs) {
          info.references = [];
          info.references_count = 0;
          for (var k = 0; k < entries.length; k++) {
            if (!refersTo(entries[k], layers[li], fx.name)) continue;
            info.references_count++;
            if (info.references.length < MAX_REFS && refsListed < MAX_REFS_TOTAL) {
              info.references.push(refEntry(entries[k], true, time));
              refsListed++;
            }
          }
          info.references_truncated = info.references_count > info.references.length;
          if (info.references_truncated) refsTruncated = true;
        }
        controls.push(info);
      }
    }
    var out = {
      comp_id: comp.id,
      layers_scanned: layers.length,
      controls: controls,
      truncated: truncated,
      references_by: withRefs ? "text search of expressions for effect(\"Name\") (and layer(\"Name\") across layers); variables and layer indexes are not followed" : null,
      scan_truncated: S.truncated,
      references_truncated: refsTruncated
    };
    if (S.truncated) out.warning = "The reference scan was capped (500 layers or 20000 properties); references past the cap are not listed";
    try { out.expression_engine = String(app.project.expressionEngine); } catch (e) { out.expression_engine = null; }
    return out;
  };

  // ---------- adding controls ----------

  // Everything about one control that can be checked without touching AE.
  function normaliseSpec(comp, spec) {
    if (!spec || typeof spec !== "object") fail("bad_args", "control spec missing");
    checkName(spec.name, "Control name");
    if (typeof spec.kind !== "string" || !KINDS.hasOwnProperty(spec.kind)) fail("bad_args", "Unknown control kind \"" + spec.kind + "\"");
    var kind = spec.kind;
    var out = { name: spec.name, kind: kind, match: KINDS[kind], hasValue: false, value: null, items: null, layerId: null };
    var v = spec.value;
    var has = v !== undefined && v !== null;
    var i;
    if (kind !== "dropdown" && spec.items !== undefined && spec.items !== null) fail("bad_args", "items apply to dropdown controls only (" + spec.name + ")");
    if (kind !== "layer" && spec.layer !== undefined && spec.layer !== null) fail("bad_args", "layer applies to layer controls only (" + spec.name + ")");
    if (kind === "slider" || kind === "angle") {
      if (has) {
        var lim = kind === "slider" ? MAX_SLIDER : MAX_ANGLE;
        if (!isNum(v) || Math.abs(v) > lim) fail("bad_args", "Control \"" + spec.name + "\" value must be a number within +-" + lim);
        out.hasValue = true;
        out.value = v;
      }
    } else if (kind === "checkbox") {
      if (has) {
        if (v === true || v === 1) out.value = 1;
        else if (v === false || v === 0) out.value = 0;
        else fail("bad_args", "Control \"" + spec.name + "\" value must be true or false");
        out.hasValue = true;
      }
    } else if (kind === "color") {
      if (has) {
        if (typeof v.length !== "number" || (v.length !== 3 && v.length !== 4)) fail("bad_args", "Control \"" + spec.name + "\" colour must be [r, g, b] or [r, g, b, a] in 0..1");
        for (i = 0; i < v.length; i++) {
          if (!isNum(v[i]) || v[i] < 0 || v[i] > 1) fail("bad_args", "Control \"" + spec.name + "\" colour values must be numbers in 0..1");
        }
        out.value = [v[0], v[1], v[2], v.length === 4 ? v[3] : 1];
        out.hasValue = true;
      }
    } else if (kind === "point" || kind === "point3d") {
      if (has) {
        var want = kind === "point" ? 2 : 3;
        if (typeof v.length !== "number" || v.length !== want) fail("bad_args", "Control \"" + spec.name + "\" value must be " + want + " numbers");
        for (i = 0; i < want; i++) {
          if (!isNum(v[i])) fail("bad_args", "Control \"" + spec.name + "\" value must be finite numbers");
        }
        out.value = v.slice(0, want);
        out.hasValue = true;
      }
    } else if (kind === "layer") {
      if (has) fail("bad_args", "Layer control \"" + spec.name + "\" takes a layer selector, not a value");
      if (spec.layer) {
        // The value is an index, and a null added later shifts every index: keep the id, look the index up after.
        out.layerId = findLayer(comp, spec.layer).id;
        out.hasValue = true;
      }
    } else if (kind === "dropdown") {
      var items = spec.items;
      if (!items || typeof items.length !== "number" || items.length < 1 || items.length > 100) fail("bad_args", "Dropdown \"" + spec.name + "\" needs 1 to 100 items");
      var seen = {};
      for (i = 0; i < items.length; i++) {
        if (typeof items[i] !== "string" || items[i].length < 1) fail("bad_args", "Dropdown items must be non-empty strings");
        if (items[i].indexOf("\\") >= 0) fail("bad_args", "Dropdown item \"" + items[i] + "\" has a backslash, which AE refuses");
        if (items[i] !== "(-") {
          if (seen["i:" + items[i]]) fail("bad_args", "Dropdown item \"" + items[i] + "\" appears twice; AE needs unique items");
          seen["i:" + items[i]] = true;
        }
      }
      if (!aeAtLeast(17, 0, 1)) fail("bad_args", "Dropdown items can be set from AE 17.0.1; this is " + app.version);
      out.items = items.slice(0);
      if (has) {
        if (!isNum(v) || Math.floor(v) !== v || v < 1 || v > items.length) fail("bad_args", "Dropdown \"" + spec.name + "\" value must be an item number from 1 to " + items.length);
        if (items[v - 1] === "(-") fail("bad_args", "Dropdown \"" + spec.name + "\" value points at a separator");
        out.hasValue = true;
        out.value = v;
      }
    }
    return out;
  }

  // Adds one control and sets it up. Looks the effect up again by index after
  // each step: adding an effect, and setting a dropdown's items, can make
  // earlier references invalid.
  function layerIndexById(comp, id) {
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).id === id) return comp.layer(i).index;
    }
    fail("not_found", "The layer to pick (id " + id + ") is gone");
    return 0;
  }

  function addControlEffect(comp, par, spec) {
    var fx = par.addProperty(spec.match);
    var idx = fx.propertyIndex;
    // Named at once so a failure part-way can find and take it back; a dropdown is named again after its items.
    fx.name = spec.name;
    if (spec.kind === "dropdown") {
      // Items first, then the name: AE may rebuild the effect when the items change.
      var ret = par.property(idx).property(1).setPropertyParameters(spec.items);
      try {
        if (ret && ret.propertyGroup) ret.propertyGroup(1).name = spec.name;
      } catch (eRet) {}
      if (par.property(idx).name !== spec.name) par.property(idx).name = spec.name;
    }
    if (spec.layerId !== null && spec.layerId !== undefined) {
      par.property(idx).property(1).setValue(layerIndexById(comp, spec.layerId));
    } else if (spec.hasValue) {
      par.property(idx).property(1).setValue(spec.value);
    }
    return idx;
  }

  function removeNamed(par, name) {
    for (var i = par.numProperties; i >= 1; i--) {
      var fx = par.property(i);
      if (fx && fx.name === name) {
        try { fx.remove(); } catch (e) {}
      }
    }
  }

  A.rigAddControls = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var sels = args.controls || [];
    if (sels.length < 1 || sels.length > 50) fail("bad_args", "Give 1 to 50 controls");
    var layer = null;
    var makeNull = false;
    var nullName = null;
    if (args.create_if_missing === true) {
      if (!args.layer || args.layer.name === undefined || args.layer.name === null) fail("bad_args", "create_if_missing needs the layer given by name");
      checkName(args.layer.name, "Layer name");
      var count = 0;
      for (var li = 1; li <= comp.numLayers; li++) {
        if (comp.layer(li).name === args.layer.name) count++;
      }
      if (count > 1) fail("bad_args", count + " layers are named \"" + args.layer.name + "\"; select by id or index");
      if (count === 0) {
        makeNull = true;
        nullName = args.layer.name;
      } else {
        layer = findLayer(comp, args.layer);
      }
    } else {
      layer = findLayer(comp, args.layer);
    }
    var specs = [];
    var taken = {};
    var par = null;
    if (layer) {
      assertUnlocked(layer);
      par = requireParade(layer);
    }
    for (var i = 0; i < sels.length; i++) {
      var spec = normaliseSpec(comp, sels[i]);
      if (taken["n:" + spec.name]) fail("bad_args", "Control name \"" + spec.name + "\" is given twice");
      taken["n:" + spec.name] = true;
      if (par && effectsNamed(par, spec.name).length > 0) {
        fail("bad_args", "Layer \"" + layer.name + "\" already has an effect named \"" + spec.name + "\"; expressions would not know which one");
      }
      specs.push(spec);
    }
    return A.withUndo(args.label || "Add expression controls", function () {
      var madeLayer = null;
      var madeSource = null;
      var added = [];
      var target = layer;
      try {
        if (makeNull) {
          madeLayer = comp.layers.addNull(comp.duration);
          try { madeSource = madeLayer.source; } catch (eSrc) {}
          madeLayer.name = nullName;
          target = madeLayer;
        }
        var p2 = requireParade(target);
        for (var j = 0; j < specs.length; j++) {
          added.push(specs[j].name);
          addControlEffect(comp, p2, specs[j]);
        }
      } catch (e) {
        // Take back what this call added, in the same undo group.
        try {
          if (target) {
            var p3 = parade(target);
            if (p3) for (var r = 0; r < added.length; r++) removeNamed(p3, added[r]);
          }
        } catch (eUndo) {}
        if (madeLayer) {
          try { madeLayer.remove(); } catch (eRm) {}
          try {
            if (madeSource && madeSource.usedIn.length === 0) madeSource.remove();
          } catch (eRs) {}
        }
        throw e;
      }
      var out = { layer: layerRef(target), created_layer: makeNull, controls: [] };
      var p4 = parade(target);
      for (var m = 0; m < specs.length; m++) {
        var hit = effectsNamed(p4, specs[m].name);
        out.controls.push({
          name: specs[m].name,
          kind: specs[m].kind,
          match_name: specs[m].match,
          index: hit.length === 1 ? hit[0].propertyIndex : null,
          target_layer_id: specs[m].layerId
        });
      }
      return out;
    });
  };

  // ---------- link expressions ----------

  var SCALAR_KINDS = { slider: 1, angle: 1, checkbox: 1, dropdown: 1 };

  function dimCount(dims) {
    if (dims === "2d") return 2;
    if (dims === "3d") return 3;
    return 1;
  }

  // The expression that drives a property of `dims` from a control of `kind`
  // read as `ref`. Throws bad_args for a pairing that makes no sense.
  function buildLink(kind, dims, ref, opts) {
    var warnings = [];
    var mult = opts.multiplier;
    var hasMult = isNum(mult) && mult !== 1;
    var remap = opts.remap;
    var axis = opts.axis;
    var hasAxis = axis !== undefined && axis !== null;
    var base = ref;
    if (SCALAR_KINDS[kind] === 1) {
      if (remap) {
        var parts = [remap.in_min, remap.in_max, remap.out_min, remap.out_max];
        for (var pi = 0; pi < 4; pi++) {
          if (!isNum(parts[pi])) fail("bad_args", "remap values must be finite numbers");
        }
        if (remap.in_min === remap.in_max) fail("bad_args", "remap in_min and in_max must differ");
        if (remap.clamp === false) {
          var slope = (remap.out_max - remap.out_min) / (remap.in_max - remap.in_min);
          base = "(" + num(remap.out_min) + " + (" + ref + " - " + num(remap.in_min) + ") * " + num(slope) + ")";
        } else {
          base = "linear(" + ref + ", " + num(remap.in_min) + ", " + num(remap.in_max) + ", " + num(remap.out_min) + ", " + num(remap.out_max) + ")";
        }
      }
      if (hasMult) base = base + " * " + num(mult);
      if (dims === "1d") {
        if (hasAxis) fail("bad_args", "axis applies to 2D and 3D properties only");
        return { expression: base, warnings: warnings };
      }
      if (dims === "2d" || dims === "3d") {
        var n = dimCount(dims);
        if (hasAxis && (!isNum(axis) || Math.floor(axis) !== axis || axis < 0 || axis >= n)) fail("bad_args", "axis must be 0.." + (n - 1) + " for this property");
        var comps = [];
        for (var c = 0; c < n; c++) {
          if (hasAxis && c !== axis) comps.push("value[" + c + "]");
          else comps.push("s");
        }
        return { expression: "var s = " + base + ";\n[" + comps.join(", ") + "]", warnings: warnings };
      }
      fail("bad_args", "A " + kind + " control can't drive a " + dims + " property; use a colour control for colours");
    }
    if (remap) fail("bad_args", "remap applies to slider, angle, checkbox and dropdown controls only");
    if (hasAxis) fail("bad_args", "axis applies to slider, angle, checkbox and dropdown controls only");
    if (kind === "color") {
      if (dims !== "color") fail("bad_args", "A colour control drives colour properties only");
      if (hasMult) fail("bad_args", "multiplier doesn't apply to colours");
      return { expression: ref, warnings: warnings };
    }
    if (kind === "point") {
      if (hasMult) base = ref + " * " + num(mult);
      if (dims === "2d") return { expression: base, warnings: warnings };
      if (dims === "3d") return { expression: "var p = " + base + ";\n[p[0], p[1], value[2]]", warnings: warnings };
      fail("bad_args", "A point control drives 2D and 3D properties only");
    }
    if (kind === "point3d") {
      if (hasMult) base = ref + " * " + num(mult);
      if (dims === "3d") return { expression: base, warnings: warnings };
      if (dims === "2d") return { expression: "var p = " + base + ";\n[p[0], p[1]]", warnings: warnings };
      fail("bad_args", "A 3D point control drives 2D and 3D properties only");
    }
    if (kind === "layer") {
      if (dims !== "layer") fail("bad_args", "A layer control drives layer-picker properties only");
      if (hasMult) fail("bad_args", "multiplier doesn't apply to layers");
      warnings.push("Layer control to layer-picker links hand AE the control's layer; this has not been confirmed on this AE, so check expressionError in the receipt");
      return { expression: ref, warnings: warnings };
    }
    fail("bad_args", "Unknown control kind " + kind);
    return null;
  }

  function checkLinkOptions(link) {
    var remap = link.remap;
    if (remap && remap.clamp !== undefined && remap.clamp !== null && typeof remap.clamp !== "boolean") fail("bad_args", "remap.clamp must be true or false");
    if (link.multiplier !== undefined && link.multiplier !== null && !isNum(link.multiplier)) fail("bad_args", "multiplier must be a finite number");
  }

  function prevExpression(p) {
    var ex = "";
    try {
      ex = p.expression;
      if (ex === undefined || ex === null) ex = "";
    } catch (e) {
      ex = "";
    }
    return String(ex);
  }

  function requireExpressionTarget(p, layer, path) {
    var ok = false;
    try { ok = p.canSetExpression === true; } catch (e) {}
    if (!ok) fail("bad_args", "Property " + path.join(" > ") + " on \"" + layer.name + "\" can't take an expression");
  }

  function requireWritableTarget(p, layer) {
    assertUnlocked(layer);
    var separated = false;
    try { separated = p.dimensionsSeparated === true; } catch (eSep) { separated = false; }
    if (separated) fail("bad_args", "\"" + layer.name + "\": that Position has separated dimensions; use X Position / Y Position (ADBE Position_0, ADBE Position_1)");
  }

  A.rigLink = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var links = args.links || [];
    if (links.length < 1 || links.length > 100) fail("bad_args", "Give 1 to 100 links");
    var plan = [];
    var seen = {};
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      checkLinkOptions(link);
      var layer = findLayer(comp, link.layer);
      var rp = resolveProp(layer, link.path);
      requireExpressionTarget(rp.prop, layer, link.path);
      requireWritableTarget(rp.prop, layer);
      var key = layer.id + "|" + rp.matchPath.join("/");
      if (seen[key]) fail("bad_args", "Property " + link.path.join(" > ") + " on \"" + layer.name + "\" is linked twice in this call");
      seen[key] = true;
      var holder = layer;
      if (link.control.layer) holder = findLayer(comp, link.control.layer);
      checkName(link.control.name, "Control name");
      var ctl = findControl(holder, link.control.name);
      var dims = dimOf(rp.prop);
      var built = buildLink(ctl.kind, dims, controlRef(comp, holder, layer, link.control.name), link);
      var prev = prevExpression(rp.prop);
      if (prev.length > 0 && args.replace !== true) {
        fail("bad_args", "Property " + link.path.join(" > ") + " on \"" + layer.name + "\" already has an expression; pass replace: true to overwrite it");
      }
      var warnings = built.warnings.slice(0);
      var keys = 0;
      try { keys = rp.prop.numKeys; } catch (eK) {}
      if (keys > 0) warnings.push("The property has keyframes; the expression overrides them (value still reads the keyframed value)");
      plan.push({
        layer: layer,
        prop: rp.prop,
        path: link.path,
        dims: dims,
        control: { layer_id: holder.id, name: link.control.name, kind: ctl.kind },
        expression: built.expression,
        previous: prev,
        warnings: warnings
      });
    }
    return A.withUndo(args.label || "Link properties to controls", function () {
      var done = [];
      try {
        for (var j = 0; j < plan.length; j++) {
          plan[j].prop.expression = plan[j].expression;
          done.push(j);
        }
      } catch (e) {
        // Put the expressions already set back, in the same undo group.
        for (var r = 0; r < done.length; r++) {
          try { plan[done[r]].prop.expression = plan[done[r]].previous; } catch (eR) {}
        }
        throw e;
      }
      var out = { links: [] };
      for (var m = 0; m < plan.length; m++) {
        out.links.push({
          layer_id: plan[m].layer.id,
          layer_name: plan[m].layer.name,
          path: plan[m].path,
          dims: plan[m].dims,
          control: plan[m].control,
          expression: plan[m].expression,
          previous_expression: clip(plan[m].previous, 600),
          warnings: plan[m].warnings
        });
      }
      return out;
    });
  };

  A.rigUnlink = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var targets = args.targets || [];
    if (targets.length < 1 || targets.length > 100) fail("bad_args", "Give 1 to 100 targets");
    var plan = [];
    var skipped = [];
    var seen = {};
    for (var i = 0; i < targets.length; i++) {
      var layer = findLayer(comp, targets[i].layer);
      var rp = resolveProp(layer, targets[i].path);
      requireExpressionTarget(rp.prop, layer, targets[i].path);
      var key = layer.id + "|" + rp.matchPath.join("/");
      if (seen[key]) fail("bad_args", "Property " + targets[i].path.join(" > ") + " is listed twice");
      seen[key] = true;
      var prev = prevExpression(rp.prop);
      var entry = { layer: layer, prop: rp.prop, path: targets[i].path, previous: prev };
      if (prev.length === 0) {
        entry.skip = "has no expression";
      } else if (targets[i].control_name !== undefined && targets[i].control_name !== null && !mentionsEffect(prev, targets[i].control_name)) {
        entry.skip = "its expression does not name the control \"" + targets[i].control_name + "\"";
      } else {
        requireWritableTarget(rp.prop, layer);
      }
      plan.push(entry);
    }
    return A.withUndo(args.label || "Unlink properties", function () {
      var out = { unlinked: [], skipped: skipped };
      for (var j = 0; j < plan.length; j++) {
        var e = plan[j];
        if (e.skip) {
          skipped.push({ layer_id: e.layer.id, path: e.path, reason: e.skip });
          continue;
        }
        e.prop.expression = "";
        out.unlinked.push({ layer_id: e.layer.id, layer_name: e.layer.name, path: e.path, previous_expression: clip(e.previous, 600) });
      }
      return out;
    });
  };

  // ---------- rename ----------

  A.rigRename = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    var layer = findLayer(comp, args.layer);
    checkName(args.control, "Control name");
    checkName(args.new_name, "New name");
    if (args.control === args.new_name) fail("bad_args", "The new name is the current name");
    var ctl = findControl(layer, args.control);
    assertUnlocked(layer);
    var par = requireParade(layer);
    if (effectsNamed(par, args.new_name).length > 0) fail("bad_args", "Layer \"" + layer.name + "\" already has an effect named \"" + args.new_name + "\"");
    var layerId = layer.id;
    var layerName = layer.name;
    var S0 = { nodes: 0, truncated: false };
    var before = [];
    var entries0 = collectExpressions(allLayers(comp, S0), S0);
    for (var i = 0; i < entries0.length; i++) {
      if (refersTo(entries0[i], layer, args.control)) before.push(entries0[i]);
    }
    return A.withUndo(args.label || "Rename control", function () {
      ctl.effect.name = args.new_name;
      var time = comp.time;
      var lay = findLayer(comp, { id: layerId });
      // AE 26.2 does not update the references when a script renames an effect,
      // and autoFixExpressions given effect("Old") did nothing either (seen live).
      // So the quoted name is swapped here, in this comp's expressions, at the
      // spots that surely reach this control. Setting an expression also
      // switches it back on if AE had disabled it. A spot that can't be placed
      // (a variable with several assignments, a layer index) is left as it is.
      var S1 = { nodes: 0, truncated: false };
      var entries1 = collectExpressions(allLayers(comp, S1), S1);
      var rewritten = 0;
      var unresolved = 0;
      var stuck = [];
      for (var k = 0; k < entries1.length; k++) {
        if (!refersTo(entries1[k], lay, args.control)) continue;
        var res = renamedText(entries1[k], lay, args.control, args.new_name);
        var left = res.unresolved;
        if (res.changed > 0) {
          try {
            entries1[k].prop.expression = res.text;
            rewritten++;
          } catch (eSet) {
            left += res.changed;
          }
        }
        if (left > 0) {
          unresolved += left;
          stuck.push(entries1[k]);
        }
      }
      var still = stuck.length;
      var attempted = 0;
      var autofix = "not needed";
      if (still > 0 || S1.truncated) {
        // What was left (or past the scan cap): AE's own repair. It rewrites only
        // expressions that error now, so the stuck ones are made to evaluate
        // first, and it must be given the bare names (seen live). It is
        // project-wide: any expression that errors and holds the old name changes.
        if (typeof app.project.autoFixExpressions !== "function") {
          autofix = "unavailable";
        } else {
          autofix = "attempted";
          for (var f = 0; f < stuck.length; f++) {
            if (forceable(stuck[f].prop)) {
              try { stuck[f].prop.valueAtTime(time, false); } catch (eF) {}
            }
          }
          try {
            app.project.autoFixExpressions(args.control, args.new_name);
            attempted++;
          } catch (eA) {}
        }
      }
      return {
        layer: { index: lay.index, id: layerId, name: layerName },
        old_name: args.control,
        new_name: args.new_name,
        references_before: before.length,
        references_left_after_rename: still,
        references_rewritten: rewritten,
        references_unresolved: unresolved,
        other_comps_scanned: false,
        scan_truncated: S1.truncated,
        autofix: autofix,
        autofix_calls: attempted
      };
    });
  };

  // ---------- recipes ----------

  function pstr(params, key, fallback) {
    var v = params ? params[key] : undefined;
    if (typeof v === "string") return v;
    return fallback;
  }

  function pnum(params, key, fallback) {
    var v = params ? params[key] : undefined;
    if (isNum(v)) return v;
    return fallback;
  }

  // A number or list of numbers for a property of `dims` as expression text.
  function literalFor(v, dims, what) {
    var n = dimCount(dims);
    var i;
    if (n === 1) {
      if (!isNum(v)) fail("bad_args", what + " must be a single number for this property");
      return num(v);
    }
    if (!v || typeof v.length !== "number" || v.length !== n) fail("bad_args", what + " must be a list of " + n + " numbers for this property");
    var parts = [];
    for (i = 0; i < n; i++) {
      if (!isNum(v[i])) fail("bad_args", what + " must hold finite numbers");
      parts.push(num(v[i]));
    }
    return "[" + parts.join(", ") + "]";
  }

  // The path of match names as chained lookups: ("ADBE Transform Group")("ADBE Position").
  function chain(matchPath) {
    var s = "";
    for (var i = 0; i < matchPath.length; i++) s += "(\"" + jsString(matchPath[i]) + "\")";
    return s;
  }

  function sourceLayerExpr(c) {
    if (!c.source) fail("bad_args", "This recipe needs a source layer");
    return "thisComp.layer(\"" + jsString(c.source.name) + "\")";
  }

  var RECIPES = {
    wiggle: {
      dims: { "1d": 1, "2d": 1, "3d": 1, color: 1 },
      build: function (c) {
        var amount = c.ref("amount");
        if (c.dims === "color") {
          c.warn("Colour wiggle uses the amount / 100, because colours run 0 to 1");
          amount = "(" + amount + " / 100)";
        }
        return ["wiggle(" + c.ref("frequency") + ", " + amount + ");"];
      }
    },
    overshoot: {
      dims: { "1d": 1, "2d": 1, "3d": 1, color: 1 },
      build: function (c) {
        return [
          "var amp = " + c.ref("amplitude") + ";",
          "var freq = " + c.ref("frequency") + ";",
          "var decay = " + c.ref("decay") + ";",
          "var n = 0;",
          "if (numKeys > 0) {",
          "  n = nearestKey(time).index;",
          "  if (key(n).time > time) { n--; }",
          "}",
          "if (n > 0) {",
          "  var t = time - key(n).time;",
          "  var v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);",
          "  value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);",
          "} else {",
          "  value;",
          "}"
        ];
      }
    },
    bounce: {
      dims: { "1d": 1, "2d": 1, "3d": 1 },
      build: function (c) {
        var vu = "var vu = (vl > 0) ? normalize(v) : v * 0;";
        var vlen = "var vl = length(v);";
        if (c.dims === "1d") {
          vu = "var vu = (v < 0) ? -1 : 1;";
          vlen = "var vl = Math.abs(v);";
        }
        return [
          "var e = Math.min(Math.max(" + c.ref("elasticity") + ", 0), 0.99);",
          "var g = Math.max(" + c.ref("gravity") + ", 1);",
          "var nMax = Math.round(" + c.ref("max_bounces") + ");",
          "var n = 0;",
          "if (numKeys > 0) {",
          "  n = nearestKey(time).index;",
          "  if (key(n).time > time) { n--; }",
          "}",
          "if (n > 0) {",
          "  var t = time - key(n).time;",
          "  var v = velocityAtTime(key(n).time - 0.001) * -e;",
          "  " + vlen,
          "  " + vu,
          "  var tCur = 0;",
          "  var segDur = 2 * vl / g;",
          "  var tNext = segDur;",
          "  var nb = 1;",
          "  while (tNext < t && nb <= nMax) {",
          "    vl *= e;",
          "    segDur *= e;",
          "    tCur = tNext;",
          "    tNext += segDur;",
          "    nb++;",
          "  }",
          "  if (nb <= nMax) {",
          "    var delta = t - tCur;",
          "    value + vu * delta * (vl - g * delta / 2);",
          "  } else {",
          "    value;",
          "  }",
          "} else {",
          "  value;",
          "}"
        ];
      }
    },
    loop: {
      dims: { "1d": 1, "2d": 1, "3d": 1, color: 1 },
      build: function (c) {
        var type = pstr(c.params, "loop_type", "cycle");
        var dir = pstr(c.params, "direction", "out");
        var keys = pnum(c.params, "keyframes", 0);
        if (type !== "cycle" && type !== "pingpong" && type !== "offset" && type !== "continue") fail("bad_args", "loop_type must be cycle, pingpong, offset or continue");
        if (dir !== "out" && dir !== "in") fail("bad_args", "direction must be out or in");
        if (Math.floor(keys) !== keys || keys < 0) fail("bad_args", "keyframes must be a whole number, 0 for all");
        var nk = 0;
        try { nk = c.prop.numKeys; } catch (e) {}
        if (nk < 2) c.warn("The property has " + nk + " keyframe(s); a loop needs at least two to do anything");
        var fn = "loopOut";
        if (dir === "in") fn = "loopIn";
        return [fn + "(\"" + type + "\", " + num(keys) + ");"];
      }
    },
    follow_delay: {
      dims: { "1d": 1, "2d": 1, "3d": 1, color: 1 },
      build: function (c) {
        return [
          "var src = " + sourceLayerExpr(c) + chain(c.matchPath) + ";",
          "var d = " + c.ref("delay") + ";",
          "src.valueAtTime(time - d);"
        ];
      }
    },
    auto_fade: {
      dims: { "1d": 1 },
      build: function (c) {
        if (c.matchPath[c.matchPath.length - 1] !== "ADBE Opacity") c.warn("auto_fade is meant for Opacity; it fades whatever this property is between 0 and its value");
        return [
          "var fi = Math.max(" + c.ref("fade_in") + ", 0.001);",
          "var fo = Math.max(" + c.ref("fade_out") + ", 0.001);",
          "var a = linear(time, inPoint, inPoint + fi, 0, value);",
          "var b = linear(time, outPoint - fo, outPoint, value, 0);",
          "Math.min(a, b);"
        ];
      }
    },
    count_up: {
      dims: { text: 1 },
      build: function (c) {
        var sep = pstr(c.params, "separator", ",");
        var prefix = pstr(c.params, "prefix", "");
        var suffix = pstr(c.params, "suffix", "");
        var easing = pstr(c.params, "easing", "linear");
        if (easing !== "linear" && easing !== "ease") fail("bad_args", "easing must be linear or ease");
        if (sep.length > 3 || prefix.length > 50 || suffix.length > 50) fail("bad_args", "separator is at most 3 characters; prefix and suffix at most 50");
        var lines = [
          "var s0 = " + c.ref("start") + ";",
          "var s1 = " + c.ref("end") + ";",
          "var dur = Math.max(" + c.ref("duration") + ", 0.001);",
          "var dec = Math.min(20, Math.max(0, Math.round(" + c.ref("decimals") + ")));",
          "var k = Math.min(Math.max((time - inPoint) / dur, 0), 1);"
        ];
        if (easing === "ease") lines.push("k = ease(k, 0, 1, 0, 1);");
        lines.push(
          "var n = s0 + (s1 - s0) * k;",
          "var fixed = Math.abs(n).toFixed(dec);",
          "var parts = fixed.split(\".\");",
          "var whole = parts[0];",
          "var out = \"\";",
          "while (whole.length > 3) {",
          "  out = \"" + jsString(sep) + "\" + whole.substring(whole.length - 3) + out;",
          "  whole = whole.substring(0, whole.length - 3);",
          "}",
          "out = whole + out;",
          "if (parts.length > 1) { out = out + \".\" + parts[1]; }",
          "if (n < 0 && parseFloat(fixed) > 0) { out = \"-\" + out; }",
          "\"" + jsString(prefix) + "\" + out + \"" + jsString(suffix) + "\";"
        );
        return lines;
      }
    },
    master_scale: {
      dims: { "1d": 1, "2d": 1, "3d": 1 },
      build: function (c) {
        return ["value * (" + c.ref("amount") + " / 100);"];
      }
    },
    tint_color: {
      dims: { color: 1 },
      build: function (c) {
        return ["linear(" + c.ref("amount") + ", 0, 100, value, " + c.ref("color") + ");"];
      }
    },
    ease_between: {
      dims: { "1d": 1, "2d": 1, "3d": 1 },
      build: function (c) {
        var from = literalFor(c.params ? c.params.from : undefined, c.dims, "from");
        var to = literalFor(c.params ? c.params.to : undefined, c.dims, "to");
        return ["ease(" + c.ref("progress") + ", 0, 100, " + from + ", " + to + ");"];
      }
    },
    follow_text: {
      dims: { "2d": 1 },
      build: function (c) {
        return [
          "var r = " + sourceLayerExpr(c) + ".sourceRectAtTime(time, false);",
          "var pad = " + c.ref("padding") + ";",
          "[r.width + pad * 2, r.height + pad * 2];"
        ];
      }
    },
    follow_text_position: {
      dims: { "2d": 1, "3d": 1 },
      build: function (c) {
        var lines = [
          "var L = " + sourceLayerExpr(c) + ";",
          "var r = L.sourceRectAtTime(time, false);",
          "var p = L.toComp([r.left + r.width / 2, r.top + r.height / 2]);",
          "if (hasParent) { p = parent.fromComp(p); }"
        ];
        if (c.dims === "3d") lines.push("[p[0], p[1], value[2]];");
        else lines.push("[p[0], p[1]];");
        return lines;
      }
    }
  };

  A.rigRecipe = function (args) {
    assertGuard(args.expect);
    var comp = requireComp(args.comp_id);
    if (typeof args.recipe !== "string" || !RECIPES.hasOwnProperty(args.recipe)) fail("bad_args", "Unknown recipe \"" + args.recipe + "\"");
    var recipe = RECIPES[args.recipe];
    var layer = findLayer(comp, args.layer);
    var rp = resolveProp(layer, args.path);
    requireExpressionTarget(rp.prop, layer, args.path);
    requireWritableTarget(rp.prop, layer);
    var dims = dimOf(rp.prop);
    if (recipe.dims[dims] !== 1) {
      var ok = [];
      for (var dk in recipe.dims) {
        if (recipe.dims.hasOwnProperty(dk)) ok.push(dk);
      }
      fail("bad_args", "Recipe " + args.recipe + " doesn't fit a " + dims + " property (it takes " + ok.join(", ") + ")");
    }
    var controller = layer;
    if (args.controller) controller = findLayer(comp, args.controller);
    var source = null;
    if (args.source) {
      source = findLayer(comp, args.source);
      requireReferencableLayer(comp, source);
    }
    var specs = args.controls || [];
    var par = null;
    if (specs.length > 0) par = requireParade(controller);
    var make = [];
    var reuse = [];
    var byKey = {};
    var taken = {};
    var i;
    for (i = 0; i < specs.length; i++) {
      var spec = normaliseSpec(comp, specs[i]);
      if (typeof specs[i].key !== "string" || specs[i].key.length < 1) fail("bad_args", "control key missing");
      if (taken["n:" + spec.name]) fail("bad_args", "Control name \"" + spec.name + "\" is used twice by this recipe");
      taken["n:" + spec.name] = true;
      var hits = effectsNamed(par, spec.name);
      if (hits.length > 1) fail("bad_args", hits.length + " effects on \"" + controller.name + "\" are named \"" + spec.name + "\"");
      if (hits.length === 1) {
        var have = kindOfEffect(hits[0]);
        if (have !== spec.kind) fail("bad_args", "\"" + spec.name + "\" on \"" + controller.name + "\" exists but is not a " + spec.kind + " control");
        reuse.push(spec.name);
      } else {
        make.push(spec);
      }
      byKey[specs[i].key] = spec.name;
    }
    if (make.length > 0) assertUnlocked(controller);
    var warnings = [];
    var ctx = {
      dims: dims,
      prop: rp.prop,
      matchPath: rp.matchPath,
      params: args.params || {},
      source: source,
      ref: function (key) {
        if (!byKey.hasOwnProperty(key)) fail("bad_args", "Recipe " + args.recipe + " needs a control \"" + key + "\" that was not given");
        return controlRef(comp, controller, layer, byKey[key]);
      },
      warn: function (m) { warnings.push(m); }
    };
    var lines = recipe.build(ctx);
    var expression = lines.join("\n");
    var prev = prevExpression(rp.prop);
    if (prev.length > 0 && args.replace !== true) {
      fail("bad_args", "Property " + args.path.join(" > ") + " on \"" + layer.name + "\" already has an expression; pass replace: true to overwrite it");
    }
    var engine = null;
    try { engine = String(app.project.expressionEngine); } catch (eEng) {}
    var controllerId = controller.id;
    return A.withUndo(args.label || "Apply expression recipe", function () {
      var added = [];
      try {
        var p2 = null;
        if (make.length > 0) p2 = requireParade(controller);
        for (var j = 0; j < make.length; j++) {
          added.push(make[j].name);
          addControlEffect(comp, p2, make[j]);
        }
        // Adding an effect can invalidate earlier references on the layer: look the property up again.
        resolveProp(layer, args.path).prop.expression = expression;
      } catch (e) {
        try {
          var p3 = parade(controller);
          if (p3) for (var r = 0; r < added.length; r++) removeNamed(p3, added[r]);
        } catch (eUndo) {}
        try { resolveProp(layer, args.path).prop.expression = prev; } catch (eRestore) {}
        throw e;
      }
      var controls = [];
      for (var m = 0; m < specs.length; m++) {
        controls.push({ layer_id: controllerId, name: byKey[specs[m].key], kind: specs[m].kind, key: specs[m].key });
      }
      var created = [];
      for (var q = 0; q < make.length; q++) created.push(make[q].name);
      return {
        recipe: args.recipe,
        engine: engine,
        dims: dims,
        target: { layer_id: layer.id, layer_name: layer.name, path: args.path },
        controller: layerRef(controller),
        controls: controls,
        controls_created: created,
        controls_reused: reuse,
        expression: expression,
        previous_expression: clip(prev, 600),
        warnings: warnings
      };
    });
  };
})($.global);
