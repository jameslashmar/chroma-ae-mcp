// panel/host/ext/track.jsx
//
// Host function for ae_track_point:
// - createTrackNull: a new null whose Position follows the tracked path,
//   one linear key per frame (guarded, one undo group)
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or ternaries.
// - All mutations check the target guard first and wrap changes in A.withUndo.
// - The server reads the keys back in a separate evalScript.

(function (G) {
  var A = G.__chromaAe;
  if (!A) {
    return;
  }

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

  A.createTrackNull = function (args) {
    assertGuard(args.expect);
    var c = null;
    try {
      c = app.project.itemByID(args.comp_id);
    } catch (e) {
      c = null;
    }
    if (!c || !(c instanceof CompItem)) fail("not_found", "No CompItem with id " + args.comp_id);
    var times = args.times;
    var values = args.values;
    if (!(times instanceof Array) || !(values instanceof Array) || times.length !== values.length || times.length < 1) {
      fail("bad_args", "times and values must be non-empty arrays of the same length");
    }
    return A.withUndo("Chroma AE MCP: track null " + args.name, function () {
      var n = c.layers.addNull(c.duration);
      n.name = args.name;
      var pos = n.property("ADBE Transform Group").property("ADBE Position");
      pos.setValuesAtTimes(times, values);
      var lin = KeyframeInterpolationType.LINEAR;
      for (var k = 1; k <= pos.numKeys; k++) {
        pos.setInterpolationTypeAtKey(k, lin, lin);
      }
      return { layer_id: n.id, layer_index: n.index, name: n.name, numKeys: pos.numKeys };
    });
  };
})($.global);
