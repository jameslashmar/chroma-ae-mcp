import { afterEach, describe, expect, it } from "vitest";
import { AskStore } from "../src/asks.js";
import { followUpFor, PopupCenter, popupButtons, popupSaid, type PopupDeps } from "../src/popups.js";
import { callTool } from "../src/tool-call.js";
import type { ToolContext } from "../src/tools/common.js";
import { resetDialogsState, setDialogsTestOverrides, type EnrichedDialog } from "../src/tools/ext/dialogs.js";

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function dlg(over: Partial<EnrichedDialog> = {}): EnrichedDialog {
  return {
    handle: 100,
    title: "After Effects",
    class: "#32770",
    isModal: true,
    text: "The font Inter-Bold is missing. It was replaced with a default font.",
    buttons: [{ name: "OK", automationId: "2", enabled: true }],
    checkboxes: [],
    boundingRect: { x: 0, y: 0, width: 320, height: 140 },
    screenshot: "C:\\data\\dialogs\\dialog_100.png",
    first_seen: "2026-11-27T13:00:00.000Z",
    caused_by_op: null,
    kind: "info",
    ...over,
  };
}

/** A popup center with a scripted list and a respond that closes whatever it is asked to press. */
function rig(opts: { respondResult?: Record<string, unknown>; channel?: PopupDeps["clientChannel"] } = {}) {
  let current: EnrichedDialog[] = [];
  const responded: Array<Record<string, unknown>> = [];
  const shown: number[] = [];
  const logs: string[] = [];
  const asks = new AskStore();
  const center = new PopupCenter({
    list: async () => ({ ok: true, dialogs: current }),
    markShown: (ds) => shown.push(...ds.map((d) => d.handle)),
    respond: async (args) => {
      responded.push(args);
      const r = opts.respondResult ?? { ok: true, closed: true, pressed: args.button };
      if (r.ok === true && r.closed === true) current = current.filter((d) => d.handle !== args.handle);
      return r;
    },
    asks,
    clientChannel: opts.channel,
    log: (level, msg) => logs.push(`${level} ${msg}`),
  });
  return {
    center,
    asks,
    responded,
    shown,
    logs,
    set: (ds: EnrichedDialog[]) => {
      current = ds;
    },
    refresh: async () => {
      await center.refresh();
      await flush();
    },
  };
}

describe("popups: every After Effects popup is seen, asked about, and reported", () => {
  it("presses a one-button popup our own operation raised at once, and reports what it said (a missing font: check_files)", async () => {
    const r = rig();
    r.set([dlg({ caused_by_op: "op_7" })]);
    await r.refresh();
    expect(r.responded).toHaveLength(1);
    expect(r.responded[0]).toMatchObject({ handle: 100, button: "OK" });
    expect(r.responded[0].user_instruction).toBeUndefined();
    expect(r.shown).toEqual([100]);
    expect(r.asks.open()).toHaveLength(0);
    const report = r.center.takeReport() as any;
    expect(report.pressed_for_you).toEqual([expect.objectContaining({ pressed: "OK", said: expect.stringContaining("Inter-Bold is missing") })]);
    expect(report.next).toContain("Tell the user");
    expect(report.next).toContain("ae_fonts check_files");
    expect(r.logs.some((l) => /pressed "OK" \(automatically/.test(l))).toBe(true);
    // Once only.
    expect(r.center.takeReport()).toBeNull();
  });

  it("asks the user about a one-button popup that is not ours (in the panel, with its screenshot), and presses their pick", async () => {
    const r = rig();
    r.set([dlg()]);
    await r.refresh();
    expect(r.responded).toHaveLength(0);
    const q = r.asks.open()[0];
    expect(q).toMatchObject({
      source: "popup",
      question: "The font Inter-Bold is missing. It was replaced with a default font.",
      context: '"After Effects"',
      image_path: "C:\\data\\dialogs\\dialog_100.png",
      allow_other: false,
    });
    expect(q.options.map((o) => o.label)).toEqual(["OK", "Leave it"]);
    // The agent hears about it before the user answers.
    const before = r.center.takeReport() as any;
    expect(before.open[0]).toMatchObject({ handle: 100, asked_in: ["panel"], caused_by_us: false });
    r.asks.answer(q.id, { choice_ids: ["b0"] });
    await flush();
    expect(r.responded[0]).toMatchObject({ handle: 100, button: "OK" });
    expect(String(r.responded[0].user_instruction)).toContain('chose "OK" in the Chroma panel');
    const after = r.center.takeReport() as any;
    expect(after.answered_by_user).toEqual([expect.objectContaining({ pressed: "OK", where: "panel" })]);
  });

  it("offers every button of a Save question, marks Don't Save as destructive, and presses it only with the user's pick", async () => {
    const r = rig();
    const save = dlg({
      title: "After Effects",
      text: "Save changes to Untitled Project.aep before closing?",
      buttons: [
        { name: "Save", automationId: "6", enabled: true },
        { name: "Don't Save", automationId: "7", enabled: true },
        { name: "Cancel", automationId: "2", enabled: true },
      ],
      kind: "destructive",
      caused_by_op: "op_9",
    });
    r.set([save]);
    await r.refresh();
    // Ours, but a question: never pressed by the rule.
    expect(r.responded).toHaveLength(0);
    const q = r.asks.open()[0];
    expect(q.options.map((o) => [o.label, o.description ?? ""])).toEqual([
      ["Save", "Loses or replaces something."],
      ["Don't Save", "Loses or replaces something."],
      ["Cancel", ""],
      ["Leave it", "I'll answer it in After Effects myself."],
    ]);
    r.asks.answer(q.id, { choice_ids: ["b1"] });
    await flush();
    expect(r.responded[0]).toMatchObject({ button: "Don't Save", allow_destructive: true });
    expect(String(r.responded[0].user_instruction)).toContain("Don't Save");
  });

  it("offers only the buttons Claude can press on a popup AE painted itself, and names the others", async () => {
    const r = rig();
    const crash = dlg({
      title: "",
      text: "Crash Repair Options We detected a crash in your last session.",
      buttons: [
        { name: "Start in Safe Mode", automationId: "", enabled: true, source: "ocr" },
        { name: "Continue", automationId: "", enabled: true, source: "ocr", default: true },
      ],
      unattended: { answerable: ["Continue"], default_button: "Continue", note: "" },
      default_button: "Continue",
      kind: "question",
    });
    r.set([crash]);
    await r.refresh();
    const q = r.asks.open()[0];
    expect(q.options.map((o) => o.label)).toEqual(["Continue", "Leave it"]);
    expect(q.context).toContain('Click "Start in Safe Mode" in After Effects yourself');
    const report = r.center.takeReport() as any;
    expect(report.open[0].buttons).toEqual([
      { name: "Start in Safe Mode", only_in_after_effects: true },
      { name: "Continue", default: true },
    ]);
    expect(report.next).toContain("only_in_after_effects");
  });

  it("reports a popup that closed before anyone answered here (the user clicked it in After Effects) and drops its question", async () => {
    const r = rig();
    r.set([dlg()]);
    await r.refresh();
    expect(r.asks.open()).toHaveLength(1);
    r.center.takeReport();
    r.set([]);
    await r.refresh();
    expect(r.asks.open()).toHaveLength(0);
    const report = r.center.takeReport() as any;
    expect(report.closed_in_after_effects).toEqual([expect.objectContaining({ said: expect.stringContaining("Inter-Bold") })]);
    expect(r.responded).toHaveLength(0);
  });

  it("leaves progress windows alone (only Cancel / Stop): no question, no report", async () => {
    const r = rig();
    r.set([dlg({ title: "Saving", text: "Saving project 42%", buttons: [{ name: "Cancel", automationId: "2", enabled: true }], caused_by_op: "op_1" })]);
    await r.refresh();
    r.set([dlg({ title: "Saving", text: "Saving project 87%", buttons: [{ name: "Cancel", automationId: "2", enabled: true }], caused_by_op: "op_1" })]);
    await r.refresh();
    expect(r.responded).toHaveLength(0);
    expect(r.asks.open()).toHaveLength(0);
    expect(r.center.takeReport()).toBeNull();
  });

  it("asks in the client too while a call can take questions, and the first answer wins", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const channel = () => async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, ...params });
      return { result: { action: "accept", content: { choice: "b0" } } };
    };
    const r = rig({ channel });
    r.set([dlg()]);
    await r.refresh();
    expect(requests[0]).toMatchObject({ method: "elicitation/create" });
    expect(String(requests[0].message)).toContain("After Effects asks");
    expect(r.responded[0]).toMatchObject({ button: "OK" });
    expect(String(r.responded[0].user_instruction)).toContain("in the client");
    // The panel's copy of the question is withdrawn.
    expect(r.asks.open()).toHaveLength(0);
    expect((r.center.takeReport() as any).answered_by_user[0]).toMatchObject({ where: "client" });
  });

  it("does not report a popup the agent answered itself with ae_dialog_respond", async () => {
    const r = rig();
    r.set([dlg()]);
    await r.refresh();
    r.center.takeReport();
    r.center.noteAnswered(100, "OK", "agent");
    expect(r.asks.open()).toHaveLength(0);
    r.set([]);
    await r.refresh();
    expect(r.center.takeReport()).toBeNull();
  });

  it("asks the user after all when the one-button press fails, and says why", async () => {
    const r = rig({ respondResult: { ok: false, error: "dialog_changed", message: "this dialog is not the one shown" } });
    r.set([dlg({ caused_by_op: "op_3" })]);
    await r.refresh();
    expect(r.responded).toHaveLength(1);
    expect(r.asks.open()).toHaveLength(1);
    const report = r.center.takeReport() as any;
    expect(report.open[0].problem).toContain("could not be pressed");
  });

  it("treats new content behind the same window as a new popup", async () => {
    const r = rig();
    r.set([dlg({ text: "First warning about a missing effect plug-in." })]);
    await r.refresh();
    r.set([dlg({ text: "Second warning: 3 files are missing." })]);
    await r.refresh();
    const report = r.center.takeReport() as any;
    expect(report.closed_in_after_effects).toHaveLength(1);
    expect(report.open).toHaveLength(1);
    expect(report.open[0].said).toContain("3 files are missing");
    expect(report.next).toContain("ae_collect_relink");
    expect(r.asks.open()).toHaveLength(1);
  });

  it("ignores a window with no button while an operation of ours runs, and one of the user's that comes and goes", async () => {
    let t = 1_000_000;
    const asks = new AskStore();
    let current: EnrichedDialog[] = [];
    const center = new PopupCenter({ list: async () => ({ ok: true, dialogs: current }), markShown: () => {}, respond: async () => ({ ok: true, closed: true }), asks, now: () => t });
    current = [dlg({ title: "Save Project", text: "Saving project complete", buttons: [], caused_by_op: "op_5" })];
    await center.refresh();
    current = [dlg({ handle: 101, title: "Save Project", text: "Saving project", buttons: [], caused_by_op: null })];
    await center.refresh();
    expect(center.takeReport()).toBeNull(); // too young to tell
    t += 1000;
    current = [];
    await center.refresh();
    expect(center.takeReport()).toBeNull();
    // One that stays is reported (the user answers it in After Effects).
    current = [dlg({ handle: 102, title: "Something", text: "A message AE painted whose buttons OCR missed", buttons: [] })];
    await center.refresh();
    t += 3000;
    expect((center.takeReport() as any).open[0]).toMatchObject({ handle: 102, buttons: [] });
    expect(asks.open()).toHaveLength(0);
  });

  it("lets the result of the call that raised a one-button popup carry its report (waits for the press under way)", async () => {
    let release: () => void = () => {};
    let current = [dlg({ caused_by_op: "op_2" })];
    const center = new PopupCenter({
      list: async () => ({ ok: true, dialogs: current }),
      markShown: () => {},
      respond: () =>
        new Promise((resolve) => {
          release = () => {
            current = [];
            resolve({ ok: true, closed: true, pressed: "OK" });
          };
        }),
      asks: new AskStore(),
    });
    await center.refresh();
    expect(center.takeReport()).toBeNull(); // the press has not landed yet
    // The key closed the window before the press returned: the watch sees it gone. That is our press, not the user.
    current = [];
    await center.refresh();
    setTimeout(() => release(), 20);
    await center.settle(1000);
    const report = center.takeReport() as any;
    expect(report.pressed_for_you).toEqual([expect.objectContaining({ pressed: "OK" })]);
    expect(report.closed_in_after_effects).toBeUndefined();
  });

  it("says what the popup said without its title read again in front", () => {
    expect(popupSaid("Script Alert", "Script Alert\nThe font Inter-Bold is missing.")).toBe("The font Inter-Bold is missing.");
    expect(popupSaid("After Effects", "After Effects After Effects: 1 file is missing")).toBe("1 file is missing");
    expect(popupSaid("", "1 file is missing")).toBe("1 file is missing");
    expect(popupSaid("Only a title", "")).toBe("Only a title");
  });

  it("names the next step for fonts, missing files and missing effects", () => {
    expect(followUpFor("Unknown BIB Error. cannot access font")).toContain("ae_fonts check_files");
    expect(followUpFor("2 files are missing from the project")).toContain("ae_collect_relink");
    expect(followUpFor("The effect 'Foo' is missing: the plug-in is not installed")).toContain("install");
    expect(followUpFor("Save changes?")).toBeUndefined();
  });

  it("marks OK as destructive on a popup with several buttons that talks about replacing", () => {
    const b = popupButtons(dlg({ text: "A file with this name exists. Replace it?", buttons: [{ name: "OK", automationId: "1", enabled: true }, { name: "Cancel", automationId: "2", enabled: true }] }));
    expect(b.map((x) => [x.name, x.destructive])).toEqual([
      ["OK", true],
      ["Cancel", false],
    ]);
  });
});

describe("popups: the report rides on the agent's next tool result", () => {
  afterEach(() => {
    setDialogsTestOverrides({});
    resetDialogsState();
  });

  it("adds `popups` once to a JSON result", async () => {
    setDialogsTestOverrides({ platform: "win32", ps1Runner: async () => JSON.stringify({ ok: true, ae_pid: 1, dialogs: [] }) });
    const r = rig();
    r.set([dlg({ caused_by_op: "op_1" })]);
    await r.refresh();
    const ctx = { popups: r.center } as unknown as ToolContext;
    const first = await callTool("ae_dialogs", { screenshots: false }, ctx);
    const body = JSON.parse(first.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.popups.pressed_for_you[0]).toMatchObject({ pressed: "OK" });
    const second = await callTool("ae_dialogs", { screenshots: false }, ctx);
    expect(JSON.parse(second.content[0].text).popups).toBeUndefined();
  });
});
