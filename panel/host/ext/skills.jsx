// panel/host/ext/skills.jsx
//
// Host function for ae_skill_run:
// - runSkill: runs a skill's numbered steps in order, in ONE evalScript, so a
//   writing skill is one undo group (begin and end in the same call).
//
// Each step is the body of a function, like ae_run_jsx code, and sees:
// - args:    the arguments given to ae_skill_run
// - prev:    what the previous step returned (live AE objects included)
// - results: everything the earlier steps returned, in order
//
// Rules:
// - ES3 only: no let, const, class, arrow functions, template strings, or ternaries.
// - A writing skill checks the target guard first; the server reads back in a
//   separate evalScript.

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
      if (extra.line !== undefined) e.__line = extra.line;
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

  // The step's code is compiled on the first line of the eval source, so an
  // error's line number is the line in the step file. It compiles in core's
  // scope, the same as ae_run_jsx code.
  function compileStep(code) {
    return A.compileInCore("(function (args, prev, results) { " + code + "\n})");
  }

  function stepLine(code, line) {
    var lines = String(code).split(/\r\n|\r|\n/);
    if (line >= 1 && line <= lines.length) return lines[line - 1].substring(0, 200);
    return undefined;
  }

  function runSteps(steps, input) {
    var raw = [];
    var plain = [];
    var prev = null;
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      var value;
      try {
        value = compileStep(step.code)(input, prev, raw);
      } catch (e) {
        var msg = "ExtendScript error";
        try { msg = String(e.message ? e.message : e); } catch (e1) {}
        var line;
        try { if (typeof e.line === "number") line = e.line; } catch (e2) {}
        var kind = "runtime";
        try { if (e.__kind) kind = e.__kind; } catch (e3) {}
        fail(kind, "Step " + (i + 1) + " (" + step.file + ") failed: " + msg, {
          line: line,
          actual: { step: i + 1, file: step.file, steps_done: i, source_line: stepLine(step.code, line) }
        });
      }
      raw.push(value);
      prev = value;
      plain.push({ step: i + 1, file: step.file, returned: A.plainResult(value) });
    }
    return { steps_run: steps.length, results: plain, value: A.plainResult(prev) };
  }

  A.runSkill = function (args) {
    var steps = args.steps;
    if (!(steps instanceof Array) || steps.length < 1) fail("bad_args", "runSkill needs at least one step");
    var input = args.args;
    if (input === undefined || input === null) input = {};
    if (!args.mutates) {
      return runSteps(steps, input);
    }
    assertGuard(args.expect);
    return A.withUndo(args.label || "Chroma AE MCP: skill", function () {
      return runSteps(steps, input);
    });
  };
})($.global);
