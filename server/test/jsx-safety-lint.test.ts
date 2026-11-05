import { describe, expect, it } from "vitest";
import { lintJsxSafety, safetyRefusalMessage } from "../src/jsx-safety-lint.js";
import { mutateTools } from "../src/tools/mutate.js";
import { lintStepsSafety, skillsTools } from "../src/tools/ext/skills.js";

const refuse = (code: string, mutates = true) => lintJsxSafety(code, { mutates }).filter((f) => f.severity === "refuse");
const members = (code: string, mutates = true) => lintJsxSafety(code, { mutates }).map((f) => f.member);

describe("jsx safety lint: refused members", () => {
  const cases: Array<[string, string, string]> = [
    ["system.callSystem('dir');", "system.callSystem", "none"],
    ["var f = new File('a.txt'); f.execute();", ".execute()", "none"],
    ["new Folder('c:/x').execute();", ".execute()", "none"],
    ["var p = File.openDialog('x');", "file dialog", "ae_ask_user"],
    ["var p = File.saveDialog('x');", "file dialog", "ae_ask_user"],
    ["var p = Folder.selectDialog('x');", "file dialog", "ae_ask_user"],
    ["var p = f.openDlg('x');", "file dialog", "ae_ask_user"],
    ["alert('hi');", "alert/confirm/prompt", "ae_ask_user"],
    ["if (confirm('sure?')) return 1;", "alert/confirm/prompt", "ae_ask_user"],
    ["var n = prompt('name');", "alert/confirm/prompt", "ae_ask_user"],
    ["Window.alert('x');", "Window.alert/confirm/prompt", "ae_ask_user"],
    ["var w = new Window('dialog');", "ScriptUI / new Window", "none"],
    ["app.beginSuppressDialogs();", "app.beginSuppressDialogs", "ae_dialogs"],
    ["app.endSuppressDialogs(false);", "app.beginSuppressDialogs", "ae_dialogs"],
    ["var s = new Socket();", "Socket", "none"],
    ["$.evalFile('x.jsx');", "$.evalFile", "ae_skill_run (a saved skill's steps)"],
    ["#include 'x.jsx'\nreturn 1;", "#include", "ae_skill_run (a saved skill's steps)"],
    ["//@include 'x.jsx'\nreturn 1;", "//@include", "ae_skill_run (a saved skill's steps)"],
    ["$.sleep(1000);", "$.sleep", "none"],
    ["app.quit();", "app.quit / app.restart", "none"],
    ["app.restart();", "app.quit / app.restart", "none"],
    ["app.scheduleTask('x()', 100, false);", "app.scheduleTask / cancelTask / onError", "none"],
    ["app.onError = function () {};", "app.scheduleTask / cancelTask / onError", "none"],
    ["app.watchFolder(new Folder('c:/x'));", "app.watchFolder / exitAfterLaunchAndEval / exitCode / setSavePreferencesOnQuit", "none"],
    ["app.exitCode = 1;", "app.watchFolder / exitAfterLaunchAndEval / exitCode / setSavePreferencesOnQuit", "none"],
    ["app.preferences.deletePref('s', 'k');", "deletePref", "none"],
    ["app.purge(PurgeTarget.ALL_CACHES);", "app.purge", "ae_memory_purge"],
    ["app.newProject();", "app.newProject / app.open / app.openFast", "ae_project_session"],
    ["app.open(new File('x.aep'));", "app.newProject / app.open / app.openFast", "ae_project_session"],
    ["app.openFast(f);", "app.newProject / app.open / app.openFast", "ae_project_session"],
    ["app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);", "project.close", "ae_project_session"],
    ["var pr = app.project; pr.close(CloseOptions.PROMPT_TO_SAVE_CHANGES);", "project.close", "ae_project_session"],
    ["app.project.save(new File('c:/x.aep'));", "project.save()", "ae_save (save_as: { path } for another file)"],
    ["var proj = app.project;\nproj.save(f);", "project.save()", "ae_save (save_as: { path } for another file)"],
    ["app.project.save();", "project.save()", "ae_save (save_as: { path } for another file)"],
    ["var p = app.project; p.save();", "project.save()", "ae_save (save_as: { path } for another file)"],
    ["app.project.file.remove();", "File.remove", "none"],
    ["app.project.item(1).file.remove();", "File.remove", "none"],
    ["app.project.item(1).mainSource.file.rename('x');", "File.rename", "none"],
    ["var f = item.mainSource.file; f.remove();", "File.remove", "none"],
    ["app.project.saveWithDialog();", "saveWithDialog", "ae_save with save_as: { path }"],
    ["app.project.importFileWithDialog();", "importFileWithDialog", "ae_import_footage"],
    ["app.project.renderQueue.render();", "renderQueue.render", "ae_aerender_start"],
    ["var rq = app.project.renderQueue; rq.stopRendering();", "renderQueue.render", "ae_aerender_start"],
    ["item.onStatusChanged = function () {};", "onStatusChanged", "ae_aerender_start"],
    ["app.project.renderQueue.queueInAME(true);", "queueInAME", "none"],
    ["app.newTeamProject({});", "Team Project methods", "none"],
    ["app.project.listTeamProjects();", "Team Project methods", "none"],
  ];
  for (const [code, member, use] of cases) {
    it(`refuses ${code.split("\n")[0]}`, () => {
      const found = refuse(code);
      const hit = found.find((f) => f.member === member);
      expect(hit, JSON.stringify(found)).toBeDefined();
      expect(hit!.use_instead).toBe(use);
      expect(hit!.severity).toBe("refuse");
    });
  }

  it("reports the line and sorts by line", () => {
    const found = refuse("var a = 1;\n\napp.quit();\nvar b = 2;\n$.sleep(5);");
    expect(found.map((f) => f.line)).toEqual([3, 5]);
  });

  it("refuses in mutates:true code too", () => {
    expect(refuse("app.quit();", true)).toHaveLength(1);
    expect(refuse("app.quit();", false)).toHaveLength(1);
  });
});

describe("jsx safety lint: File and Folder", () => {
  it("refuses remove, rename, copy, create, write, writeln on a File variable", () => {
    for (const call of ["f.remove()", "f.rename('b')", "f.copy('c')", "f.create()", "f.write('x')", "f.writeln('x')"]) {
      const found = refuse(`var f = new File('c:/a.txt');\n${call};`);
      expect(found, call).toHaveLength(1);
      expect(found[0].line).toBe(2);
      expect(found[0].use_instead).toBe("none");
    }
  });

  it("refuses open in write, append and edit mode, and a non-literal mode", () => {
    for (const mode of ["'w'", '"a"', "'e'", "'W'"]) {
      expect(refuse(`var f = File('c:/a.txt'); f.open(${mode});`), mode).toHaveLength(1);
    }
    expect(refuse("var f = File('c:/a.txt'); var m = 'r'; f.open(m);")).toHaveLength(1);
  });

  it("allows reading: open('r'), open(), exists, read, fsName, parent", () => {
    const code =
      "var f = new File('c:/a.txt'); if (f.exists) { f.open('r'); var t = f.read(); f.close(); }\n" +
      "var g = new File('c:/b.txt'); g.open(); var l = g.readln(); g.close();\n" +
      "return f.fsName + g.parent.fsName;";
    expect(refuse(code)).toEqual([]);
  });

  it("follows a Folder constant, a parent, a file list and a direct chain", () => {
    expect(refuse("var t = Folder.temp; t.remove();")).toHaveLength(1);
    expect(refuse("var f = new File('a'); var d = f.parent; d.remove();")).toHaveLength(1);
    expect(refuse("var d = new Folder('c:/x'); var files = d.getFiles(); files[0].remove();")).toHaveLength(1);
    expect(refuse("new File('c:/a.txt').remove();")).toHaveLength(1);
    expect(refuse("File('c:/' + name + '.txt').remove();")).toHaveLength(1);
    expect(refuse("Folder.temp.remove();")).toHaveLength(1);
    expect(refuse("var f = File.decode('c%3A/a'); f.remove();")).toHaveLength(1);
  });

  it("does not take a property named file inside a call for a File variable", () => {
    expect(refuse("var lyr = comp.layers.add(app.project.importFile(new ImportOptions(src.file))); lyr.remove();")).toEqual([]);
    expect(refuse("var ok = check(item.file); ok.remove();")).toEqual([]);
    const found = refuse("var f = app.project.item(1).file; f.remove();");
    expect(found).toHaveLength(1);
    expect(found[0].member).toBe("File.remove");
  });

  it("does not refuse layer.remove(), mask.remove() or $.writeln in mutates:true code", () => {
    const code =
      "var layer = comp.layer(1); layer.remove();\n" +
      "var mask = layer.property('ADBE Mask Parade').property(1); mask.remove();\n" +
      "$.writeln('x'); $.write('y');\n" +
      "var f = new File('c:/a.txt');\n" +
      "var opts = new ImportOptions(f); app.project.importFile(opts);";
    expect(lintJsxSafety(code, { mutates: true })).toEqual([]);
  });

  it("does not refuse reads of app.project.file and new File(path) given to ImportOptions", () => {
    const code =
      "var p = app.project.file ? app.project.file.fsName : null;\n" +
      "var io = new ImportOptions(new File('c:/a.png'));\n" +
      "return [app.version, p, io.canImportAs(ImportAsType.FOOTAGE)];";
    expect(lintJsxSafety(code, { mutates: false })).toEqual([]);
  });
});

describe("jsx safety lint: comments, strings, regex", () => {
  it("ignores names inside comments, strings and regex literals", () => {
    const code =
      "// never call app.quit() or system.callSystem\n" +
      "/* alert('x'); app.beginSuppressDialogs() */\n" +
      "var s = \"alert('hi') and app.quit()\";\n" +
      "var t = 'File.openDialog';\n" +
      "var r = /app\\.quit\\(\\)/;\n" +
      "var label = 'saving app.project.close()';\n" +
      "return s + t + label;";
    expect(lintJsxSafety(code, { mutates: false })).toEqual([]);
  });

  it("does not take a member call named alert for the global", () => {
    expect(refuse("obj.alert('x'); var o = {prompt: 1}; o.confirm(1);")).toEqual([]);
  });

  it("documents that eval of a built string is a known gap", () => {
    const code = "eval('app.' + 'quit()');";
    expect(lintJsxSafety(code, { mutates: true })).toEqual([]);
    const bracket = "system['callSystem']('x');";
    expect(lintJsxSafety(bracket, { mutates: true })).toEqual([]);
  });
});

describe("jsx safety lint: writes with mutates:false", () => {
  const writes = [
    "p.setValue(1)", "p.setValueAtTime(0, 1)", "p.setValuesAtTimes([0], [1])", "p.setValueAtKey(1, 2)", "p.removeKey(1)",
    "layer.remove()", "g.addProperty('ADBE Mask Atom')", "app.project.items.addComp('a', 1, 1, 1, 1, 24)",
    "app.project.items.addFolder('a')", "comp.layers.addSolid([1, 1, 1], 'a', 1, 1, 1)", "comp.layers.addNull()",
    "comp.layers.addText('a')", "comp.layers.addBoxText([1, 1])", "comp.layers.addShape()", "comp.layers.addCamera('a', [0, 0])",
    "comp.layers.addLight('a', [0, 0])", "p.addKey(1)", "layer.duplicate()", "layer.moveTo(1)", "layer.moveBefore(l)",
    "layer.moveAfter(l)", "layer.moveToBeginning()", "layer.moveToEnd()", "layer.replaceSource(s, true)", "layer.applyPreset(f)",
    "app.project.importFile(o)", "p.setInterpolationTypeAtKey(1, a, b)", "p.setTemporalEaseAtKey(1, [e])",
    "comp.layers.add(item)", "app.project.items.add(x)",
  ];
  for (const call of writes) {
    it(`needs mutates: ${call}`, () => {
      const found = lintJsxSafety(`${call};`, { mutates: false });
      expect(found.length, call).toBeGreaterThan(0);
      expect(found.every((f) => f.severity === "needs_mutates"), call).toBe(true);
      expect(lintJsxSafety(`${call};`, { mutates: true }).filter((f) => f.severity === "needs_mutates")).toEqual([]);
    });
  }

  it("does not flag property assignments or plain reads", () => {
    const code = "var out = {}; out.name = comp.name; out.n = comp.numLayers; layer.name = 'x'; return out;";
    expect(lintJsxSafety(code, { mutates: false })).toEqual([]);
  });

  it("reports a File remove once, as a refusal", () => {
    const found = lintJsxSafety("var f = new File('a'); f.remove();", { mutates: false });
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("refuse");
  });

  it("formats a refusal naming each line and tool", () => {
    const msg = safetyRefusalMessage(lintJsxSafety("alert(1);\nlayer.remove();", { mutates: false }), "ae_run_jsx code");
    expect(msg).toContain("line 1: alert/confirm/prompt");
    expect(msg).toContain("ae_ask_user");
    expect(msg).toContain("line 2:");
    expect(msg).toContain("mutates: true");
  });
});

// ---- wired into the tools ----

function fakeCtx() {
  const calls: string[] = [];
  const bridge = {
    newOpId: () => "op1",
    callHost: async (fn: string) => {
      calls.push(`callHost:${fn}`);
      return { id: "x", result: { ok: 1 } };
    },
    evalRaw: async (p: { script: string }) => {
      calls.push(`evalRaw:${p.script.slice(0, 30)}`);
      return { id: "x", result: {} };
    },
  };
  const ctx: any = {
    bridge,
    quarantine: { assertClear: () => {}, list: () => [] },
    queue: { run: async (_l: string, fn: () => Promise<unknown>) => fn() },
  };
  return { ctx, calls };
}

describe("ae_run_jsx wiring", () => {
  const tool = mutateTools.find((t) => t.name === "ae_run_jsx")!;

  it("refuses an unsafe read script before any eval", async () => {
    const { ctx, calls } = fakeCtx();
    await expect(tool.handler({ code: "system.callSystem('x');", mutates: false, label: "x" }, ctx)).rejects.toMatchObject({
      kind: "evalscript_error",
      message: expect.stringContaining("system.callSystem"),
    });
    expect(calls).toEqual([]);
  });

  it("refuses an unsafe mutating script before the guard and any eval", async () => {
    const { ctx, calls } = fakeCtx();
    await expect(
      tool.handler({ code: "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);", mutates: true, label: "x", expect: { project_path: "c:/a.aep" } }, ctx)
    ).rejects.toThrow(/ae_project_session/);
    expect(calls).toEqual([]);
  });

  it("refuses a write declared as a read, telling the caller to set mutates", async () => {
    const { ctx, calls } = fakeCtx();
    await expect(tool.handler({ code: "comp.layer(1).remove();", mutates: false, label: "x" }, ctx)).rejects.toThrow(/mutates: true/);
    expect(calls).toEqual([]);
  });

  it("lets a clean read through", async () => {
    const { ctx, calls } = fakeCtx();
    const res = await tool.handler({ code: "return app.version;", mutates: false, label: "x" }, ctx);
    expect(res.result).toEqual({ ok: 1 });
    expect(calls).toEqual(["callHost:runUserJsx"]);
  });

  it("describes the lint in the tool description", () => {
    expect(tool.description).toContain("safety lint");
    expect(tool.description).toContain("not a sandbox");
    expect(skillsTools.find((t) => t.name === "ae_skill_run")!.description).toContain("safety lint");
    expect(skillsTools.find((t) => t.name === "ae_skill_save")!.description).toContain("safety lint");
  });
});

describe("skills lint", () => {
  it("lintStepsSafety names the step file and line", () => {
    const problems = lintStepsSafety([{ file: "1.jsx", code: "return 1;" }, { file: "2.jsx", code: "var a = 1;\napp.quit();" }], true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^2\.jsx line 2: app\.quit/);
  });

  it("flags writes only in a read-only skill", () => {
    const steps = [{ file: "1.jsx", code: "layer.remove();" }];
    expect(lintStepsSafety(steps, true)).toEqual([]);
    expect(lintStepsSafety(steps, false)).toHaveLength(1);
  });

  it("ae_skill_save refuses unsafe steps and saves nothing", async () => {
    const save = skillsTools.find((t) => t.name === "ae_skill_save")!;
    const { ctx } = fakeCtx();
    const res = await save.handler(
      { name: "bad-skill", description: "x", steps: ["alert('x');"], scope: "global" },
      ctx
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unsafe_jsx");
    expect(res.problems[0]).toContain("ae_ask_user");
  });
});
