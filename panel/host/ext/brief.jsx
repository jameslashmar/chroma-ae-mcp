// panel/host/ext/brief.jsx
//
// Host function for ae_brief's import_swatches:
// - briefParseSwatches (read): app.parseSwatchFile(new File(path)) and the raw
//   swatch values, unchanged. The colour conversion to #rrggbb happens in Node.
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or chained ternaries.
// - Reads change nothing in the project: no undo group, no selection, no time.
// - Swatch types per the Scripting Guide: 'RGB' (r, g, b 0-1), 'CMYK' (c, m, y, k 0-1),
//   'LAB' (L 0-1, a, b -128..128) and 'Gray' (value 0-1). There is no name field.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

  var MAX_SWATCHES = 500;

  function fail(kind, message) {
    var e = new Error(message);
    e.__kind = kind;
    throw e;
  }

  function msgOf(e) {
    try {
      return String(e && e.message ? e.message : e);
    } catch (e2) {
      return "unknown error";
    }
  }

  function numOrNull(v) {
    if (typeof v === "number" && isFinite(v)) return v;
    return null;
  }

  A.briefParseSwatches = function (args) {
    if (!args || typeof args.path !== "string" || args.path.length === 0) fail("bad_args", "briefParseSwatches needs a path.");
    if (typeof app.parseSwatchFile !== "function") {
      fail("unsupported", "This After Effects build has no app.parseSwatchFile.");
    }
    var f = new File(args.path);
    var exists = false;
    try {
      exists = f.exists === true;
    } catch (e0) {
      exists = false;
    }
    if (!exists) fail("not_found", "No swatch file at " + args.path);

    var parsed;
    try {
      parsed = app.parseSwatchFile(f);
    } catch (e1) {
      fail("parse_failed", "After Effects could not read the swatch file: " + msgOf(e1));
    }
    if (!parsed) fail("parse_failed", "After Effects returned nothing for the swatch file.");

    var values = [];
    var truncated = false;
    var list = parsed.values;
    var total = 0;
    if (list && typeof list.length === "number") {
      total = list.length;
      for (var i = 0; i < list.length; i++) {
        if (values.length >= MAX_SWATCHES) {
          truncated = true;
          break;
        }
        var v = list[i];
        var o = { type: "" };
        try {
          o.type = String(v.type);
        } catch (e2) {
          o.type = "";
        }
        var names = ["r", "g", "b", "c", "m", "y", "k", "L", "a", "value"];
        for (var n = 0; n < names.length; n++) {
          var x = null;
          try {
            x = numOrNull(v[names[n]]);
          } catch (e3) {
            x = null;
          }
          if (x !== null) o[names[n]] = x;
        }
        values.push(o);
      }
    }
    return {
      path: args.path,
      majorVersion: numOrNull(parsed.majorVersion),
      minorVersion: numOrNull(parsed.minorVersion),
      count: total,
      truncated: truncated,
      values: values
    };
  };
})($.global);
