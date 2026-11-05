// panel/host/ext/multicomp.jsx
//
// Read-only host functions for ae_multi_comp_apply (the server loops the
// existing guarded write tools over many comps; each of those brings its own
// guard, undo group and read-back):
// - multicompResolve: which comps a selector names (ids, a folder walked
//   recursively, the comps nested inside a comp, or every comp), filtered by
//   a name pattern
// - multicompProbe: for each comp, whether it still exists and how many
//   layers carry each of the given names (a missing layer means "skip this
//   comp", found before anything is written)
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Read only: nothing here changes the project, the selection or the time.
//   A comp's nesting comes from its layers' sources (AVItem.usedIn points the
//   other way: it lists the comps that use an item, not the ones inside it).

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_LIST = 500;
  var MAX_NAMES = 50;
  var MAX_LAYER_VISITS = 50000;
  var MAX_ITEM_VISITS = 50000;
  var MAX_FOLDER_DEPTH = 50;

  function fail(kind, message) {
    var e = new Error(message);
    e.__kind = kind;
    throw e;
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

  function folderName(comp) {
    try {
      if (comp.parentFolder) return String(comp.parentFolder.name);
    } catch (e) {}
    return null;
  }

  function describeComp(c) {
    return {
      id: c.id,
      name: c.name,
      folder: folderName(c),
      width: c.width,
      height: c.height,
      duration: c.duration,
      num_layers: c.numLayers
    };
  }

  // Every comp below a folder, subfolders included, in project order.
  function compsInFolder(folder, state) {
    var out = [];
    function walk(f, depth) {
      if (depth > MAX_FOLDER_DEPTH) {
        state.partial = true;
        return;
      }
      var n = 0;
      try {
        n = f.numItems;
      } catch (eN) {
        n = 0;
      }
      for (var i = 1; i <= n; i++) {
        if (state.visits >= MAX_ITEM_VISITS) {
          state.partial = true;
          return;
        }
        state.visits++;
        var it = null;
        try {
          it = f.item(i);
        } catch (eI) {
          it = null;
        }
        if (!it) continue;
        if (it instanceof CompItem) out.push(it);
        else if (it instanceof FolderItem) walk(it, depth + 1);
      }
    }
    walk(folder, 1);
    return out;
  }

  // Every comp nested inside a comp, at any depth (the root itself is left
  // out). Follows layer sources, so a precomp used twice is listed once.
  function compsNestedIn(root, state) {
    var out = [];
    var seen = {};
    seen[root.id] = true;
    var queue = [root];
    var visits = 0;
    while (queue.length > 0) {
      var c = queue.shift();
      for (var j = 1; j <= c.numLayers; j++) {
        if (visits >= MAX_LAYER_VISITS) {
          state.partial = true;
          return out;
        }
        visits++;
        var src = null;
        try {
          src = c.layer(j).source;
        } catch (eSrc) {
          src = null;
        }
        if (src && src instanceof CompItem && !seen[src.id]) {
          seen[src.id] = true;
          out.push(src);
          queue.push(src);
        }
      }
    }
    return out;
  }

  function allComps(state) {
    var out = [];
    var n = app.project.numItems;
    for (var i = 1; i <= n; i++) {
      if (state.visits >= MAX_ITEM_VISITS) {
        state.partial = true;
        break;
      }
      state.visits++;
      var it = app.project.item(i);
      if (it instanceof CompItem) out.push(it);
    }
    return out;
  }

  // args: ids (explicit comp ids), folder_id, nested_in (a comp id), or none
  // of them (every comp); name_pattern (a regular expression source, with
  // case_insensitive) and exclude_ids narrow the result.
  // When args.expect is given, the project is checked in this same call, so
  // the comp ids returned belong to the project the caller meant.
  function guardRefusal(args) {
    if (!args || !args.expect) return null;
    var g = A.checkGuard({ expect: { project_path: args.expect.project_path } });
    if (g.ok) return null;
    return { guard_failed: true, project_path: g.project_path };
  }

  A.multicompResolve = function (args) {
    args = args || {};
    var refused = guardRefusal(args);
    if (refused) return refused;
    var state = { partial: false, visits: 0 };
    var candidates = [];
    var missing = [];
    var i;
    var hasIds = args.ids !== undefined && args.ids !== null;
    var hasFolder = args.folder_id !== undefined && args.folder_id !== null;
    var hasNested = args.nested_in !== undefined && args.nested_in !== null;
    if ((hasIds ? 1 : 0) + (hasFolder ? 1 : 0) + (hasNested ? 1 : 0) > 1) {
      fail("bad_args", "Give at most one of ids, folder_id and nested_in.");
    }

    if (hasIds) {
      for (i = 0; i < args.ids.length; i++) {
        var it = itemById(args.ids[i]);
        if (it && it instanceof CompItem) candidates.push(it);
        else missing.push(args.ids[i]);
      }
    } else if (hasFolder) {
      var folder = itemById(args.folder_id);
      if (!folder || !(folder instanceof FolderItem)) fail("not_found", "No folder with id " + args.folder_id);
      candidates = compsInFolder(folder, state);
    } else if (hasNested) {
      var root = itemById(args.nested_in);
      if (!root || !(root instanceof CompItem)) fail("not_found", "No CompItem with id " + args.nested_in);
      candidates = compsNestedIn(root, state);
    } else {
      candidates = allComps(state);
    }

    var re = null;
    if (args.name_pattern !== undefined && args.name_pattern !== null && args.name_pattern !== "") {
      try {
        re = new RegExp(args.name_pattern, args.case_insensitive === true ? "i" : "");
      } catch (eRe) {
        fail("bad_args", "name_pattern is not a valid regular expression: " + eRe.message);
      }
    }
    var excluded = {};
    if (args.exclude_ids) {
      for (i = 0; i < args.exclude_ids.length; i++) excluded[args.exclude_ids[i]] = true;
    }

    var comps = [];
    var matched = 0;
    var seenIds = {};
    for (i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (seenIds[c.id] || excluded[c.id]) continue;
      seenIds[c.id] = true;
      if (re && !re.test(String(c.name))) continue;
      matched++;
      if (comps.length < MAX_LIST) comps.push(describeComp(c));
    }
    return {
      comps: comps,
      matched: matched,
      missing_ids: missing,
      truncated: matched > MAX_LIST,
      // The folder or layer scan was cut short, so the list may be incomplete.
      partial: state.partial
    };
  };

  // args: comp_ids, layer_names. Per comp: whether it is still a comp, and
  // how many of its layers carry each name.
  A.multicompProbe = function (args) {
    args = args || {};
    var refusedProbe = guardRefusal(args);
    if (refusedProbe) return refusedProbe;
    var ids = args.comp_ids || [];
    var names = args.layer_names || [];
    if (names.length > MAX_NAMES) fail("bad_args", "At most " + MAX_NAMES + " layer names can be probed.");
    var wanted = {};
    var i;
    for (i = 0; i < names.length; i++) wanted["n:" + names[i]] = names[i];
    var out = [];
    var truncated = ids.length > MAX_LIST;
    var n = ids.length;
    if (n > MAX_LIST) n = MAX_LIST;
    for (i = 0; i < n; i++) {
      var comp = itemById(ids[i]);
      if (!comp || !(comp instanceof CompItem)) {
        out.push({ id: ids[i], exists: false, name: null, found: {} });
        continue;
      }
      var found = {};
      for (var k = 0; k < names.length; k++) found[names[k]] = 0;
      if (names.length > 0) {
        for (var j = 1; j <= comp.numLayers; j++) {
          var ln = null;
          try {
            ln = comp.layer(j).name;
          } catch (eL) {
            ln = null;
          }
          if (ln !== null && wanted.hasOwnProperty("n:" + ln)) found[ln] = found[ln] + 1;
        }
      }
      out.push({ id: comp.id, exists: true, name: comp.name, found: found });
    }
    return { comps: out, truncated: truncated };
  };
})($.global);
