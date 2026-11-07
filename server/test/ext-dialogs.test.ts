import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostTransport } from "../src/host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  describeBlockingDialogs,
  dialogsTools,
  evaluateRespondPolicy,
  getCurrentInFlightOp,
  isDestructiveButton,
  locateDialogsPs1Script,
  noteOpFinished,
  noteOpStarted,
  parsePs1JsonOutput,
  resetDialogsState,
  setDialogsTestOverrides,
  type Ps1ListOutput,
  type Ps1RespondOutput,
} from "../src/tools/ext/dialogs.js";
import type { OcrLine, PngPixels } from "../src/tools/ext/dialog-geometry.js";
import { H, line, makeImage, TALL_BODY, W, word, type Pill } from "./support/dialog-fixtures.js";

describe("ext/dialogs tools (Task G5)", () => {
  const tmpDirs: string[] = [];
  let tempDialogsDir: string;
  let fakeCtx: ToolContext;

  function makeTempDir(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }

  function getTool(name: string) {
    const t = dialogsTools.find((tool) => tool.name === name);
    if (!t) throw new Error(`Tool not found: ${name}`);
    return t;
  }

  beforeEach(() => {
    resetDialogsState();
    tempDialogsDir = makeTempDir("chroma-ae-dialogs-test-");
    const qDir = makeTempDir("chroma-ae-dialogs-q-");
    const fakeBridge: HostTransport = {
      newOpId: () => "op_fake_1",
      evalRaw: async () => ({
        id: "op_fake_1",
        ok: true as const,
        result: {},
        durationMs: 1,
      }),
      callHost: async () => ({
        id: "op_fake_1",
        result: {} as never,
        durationMs: 1,
      }),
    };
    fakeCtx = {
      bridge: fakeBridge,
      queue: new SingleWriterQueue(),
      quarantine: new QuarantineStore(path.join(qDir, "quarantine.json")),
    };
  });

  afterEach(() => {
    resetDialogsState();
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("includes Jay's dialog rules in tool descriptions and locates ae-dialogs.ps1", () => {
    for (const tool of dialogsTools) {
      expect(tool.description).toMatch(/never suppress/i);
      expect(tool.description).toMatch(/caused_by_op|own operation caused/i);
      expect(tool.description).toMatch(/destructive/i);
    }

    const located = locateDialogsPs1Script();
    expect(located).not.toBeNull();
    expect(located).toMatch(/ae-dialogs\.ps1$/);
    expect(fs.existsSync(located!)).toBe(true);
  });

  it("parses sample ps1 JSON outputs for list, respond, and error envelopes", () => {
    const sampleListStdout = JSON.stringify({
      ok: true,
      ae_pid: 18420,
      dialogs: [
        {
          handle: 658122,
          title: "After Effects Warning",
          class: "#32770",
          isModal: true,
          text: "After Effects warning: 1 file is missing since you last saved this project.",
          buttons: [{ name: "OK", automationId: "2", enabled: true }],
          checkboxes: [
            { name: "Don't show again in this session", checked: false },
          ],
          boundingRect: { x: 420, y: 310, width: 480, height: 190 },
          screenshot: "C:\\Temp\\dialog_658122.png",
        },
      ],
    });

    const parsedList = parsePs1JsonOutput<Ps1ListOutput>(sampleListStdout);
    expect(parsedList.ok).toBe(true);
    if (parsedList.ok) {
      expect(parsedList.ae_pid).toBe(18420);
      expect(parsedList.dialogs).toHaveLength(1);
      expect(parsedList.dialogs[0].handle).toBe(658122);
      expect(parsedList.dialogs[0].buttons?.[0].name).toBe("OK");
    }

    const sampleRespondStdout =
      '{"ok":true,"handle":658122,"pressed":"OK","checked":null,"closed":true}\r\n';
    const parsedRespond =
      parsePs1JsonOutput<Ps1RespondOutput>(sampleRespondStdout);
    expect(parsedRespond).toEqual({
      ok: true,
      handle: 658122,
      pressed: "OK",
      checked: null,
      closed: true,
    });

    const sampleGoneStdout = '{"ok":false,"error":"dialog_gone"}';
    const parsedGone = parsePs1JsonOutput<Ps1RespondOutput>(sampleGoneStdout);
    expect(parsedGone).toEqual({
      ok: false,
      error: "dialog_gone",
    });
  });

  it("tracks caused_by_op and preserves first_seen across polls via noteOpStarted / noteOpFinished", async () => {
    let fakeClockTick = 0;
    const sampleDialog = {
      handle: 900100,
      title: "After Effects",
      class: "#32770",
      isModal: true,
      text: "Missing footage item 'logo.png'.",
      buttons: [{ name: "OK", automationId: "1", enabled: true }],
      checkboxes: [],
      boundingRect: { x: 100, y: 100, width: 400, height: 160 },
      screenshot: path.join(tempDialogsDir, "dialog_900100.png"),
    };

    let openDialogs = [sampleDialog];

    setDialogsTestOverrides({
      platform: "win32",
      dialogsDir: tempDialogsDir,
      nowIso: () => {
        fakeClockTick += 1;
        return `2026-10-27T14:00:0${fakeClockTick}.000Z`;
      },
      ps1Runner: async (args) => {
        expect(args).toContain("-Mode");
        expect(args).toContain("list");
        return JSON.stringify({
          ok: true,
          ae_pid: 4444,
          dialogs: openDialogs,
        });
      },
    });

    expect(getCurrentInFlightOp()).toBeNull();
    noteOpStarted("op_import_77");
    expect(getCurrentInFlightOp()).toBe("op_import_77");

    const aeDialogsTool = getTool("ae_dialogs");
    const firstPoll = (await aeDialogsTool.handler(
      { screenshots: true },
      fakeCtx
    )) as {
      ok: boolean;
      dialogs: Array<{
        handle: number;
        first_seen: string;
        caused_by_op: string | null;
      }>;
    };

    expect(firstPoll.ok).toBe(true);
    expect(firstPoll.dialogs).toHaveLength(1);
    expect(firstPoll.dialogs[0].handle).toBe(900100);
    expect(firstPoll.dialogs[0].caused_by_op).toBe("op_import_77");
    expect(firstPoll.dialogs[0].first_seen).toBe("2026-10-27T14:00:01.000Z");

    // Finish the operation; while the same dialog handle stays open, it must keep its original first_seen and caused_by_op
    noteOpFinished("op_import_77");
    expect(getCurrentInFlightOp()).toBeNull();

    const secondPoll = (await aeDialogsTool.handler(
      { screenshots: true },
      fakeCtx
    )) as typeof firstPoll;
    expect(secondPoll.dialogs[0].caused_by_op).toBe("op_import_77");
    expect(secondPoll.dialogs[0].first_seen).toBe("2026-10-27T14:00:01.000Z");

    // When the dialog closes and later a new dialog appears with no op in flight, caused_by_op is null
    openDialogs = [];
    await aeDialogsTool.handler({ screenshots: false }, fakeCtx);

    openDialogs = [{ ...sampleDialog, handle: 900200 }];
    const thirdPoll = (await aeDialogsTool.handler(
      { screenshots: false },
      fakeCtx
    )) as typeof firstPoll;
    expect(thirdPoll.dialogs[0].handle).toBe(900200);
    expect(thirdPoll.dialogs[0].caused_by_op).toBeNull();
  });

  it("enforces refusal rules: refuses dialogs not caused by our op and destructive buttons without instruction", async () => {
    // 1. Pure policy checks
    expect(
      evaluateRespondPolicy({
        button: "OK",
        caused_by_op: null,
      })
    ).toMatchObject({
      allowed: false,
      error: "refused_not_caused_by_our_op",
    });

    expect(
      evaluateRespondPolicy({
        button: "OK",
        caused_by_op: null,
        user_instruction: "Jay: click OK on the warning popup",
      })
    ).toEqual({ allowed: true });

    for (const destructiveBtn of [
      "Save",
      "Don't Save",
      "Dont Save",
      "Replace",
      "Delete",
      "Overwrite",
      "Discard",
      "Remove",
      "Revert",
    ]) {
      expect(isDestructiveButton(destructiveBtn)).toBe(true);

      // Refused when allow_destructive is false even if caused_by_op is set and user_instruction is given
      expect(
        evaluateRespondPolicy({
          button: destructiveBtn,
          caused_by_op: "op_123",
          allow_destructive: false,
          user_instruction: "Jay said do it",
        })
      ).toMatchObject({
        allowed: false,
        error: "refused_destructive_button",
      });

      // Refused when allow_destructive is true but user_instruction is missing/empty
      expect(
        evaluateRespondPolicy({
          button: destructiveBtn,
          caused_by_op: "op_123",
          allow_destructive: true,
          user_instruction: "   ",
        })
      ).toMatchObject({
        allowed: false,
        error: "refused_destructive_button",
      });

      // Allowed when BOTH allow_destructive: true AND non-empty user_instruction are provided
      expect(
        evaluateRespondPolicy({
          button: destructiveBtn,
          caused_by_op: "op_123",
          allow_destructive: true,
          user_instruction: `Jay: "Please click ${destructiveBtn}"`,
        })
      ).toEqual({ allowed: true });
    }

    // 2. Full tool handler integration check (refuses external dialog, allows our dialog and logs to responses.jsonl)
    const ps1Calls: string[][] = [];
    setDialogsTestOverrides({
      platform: "win32",
      dialogsDir: tempDialogsDir,
      nowIso: () => "2026-10-27T14:05:00.000Z",
      ps1Runner: async (args) => {
        ps1Calls.push(args);
        if (args.includes("list")) {
          return JSON.stringify({
            ok: true,
            ae_pid: 5000,
            dialogs: [
              {
                handle: 111,
                title: "Save Changes",
                class: "#32770",
                isModal: true,
                text: "Save changes to Untitled Project.aep before closing?",
                buttons: [
                  { name: "Save", automationId: "1", enabled: true },
                  { name: "Don't Save", automationId: "2", enabled: true },
                  { name: "Cancel", automationId: "3", enabled: true },
                ],
                checkboxes: [],
                boundingRect: { x: 10, y: 10, width: 300, height: 120 },
              },
            ],
          });
        }
        return JSON.stringify({
          ok: true,
          handle: 111,
          pressed: args[args.indexOf("-Button") + 1],
          checked: null,
          closed: true,
        });
      },
    });

    const aeDialogsTool = getTool("ae_dialogs");
    const aeRespondTool = getTool("ae_dialog_respond");

    // Discover dialog 111 with no op in flight -> caused_by_op: null
    await aeDialogsTool.handler({ screenshots: false }, fakeCtx);

    const refusedExternal = (await aeRespondTool.handler(
      {
        handle: 111,
        button: "Cancel",
        reason: "Dismiss external save dialog",
      },
      fakeCtx
    )) as { ok: boolean; error: string };
    expect(refusedExternal.ok).toBe(false);
    expect(refusedExternal.error).toBe("refused_not_caused_by_our_op");

    // Refused destructive button when user_instruction is present but allow_destructive is false
    const refusedDestructive = (await aeRespondTool.handler(
      {
        handle: 111,
        button: "Don't Save",
        reason: "Discard project",
        allow_destructive: false,
        user_instruction: "Jay: discard it",
      },
      fakeCtx
    )) as { ok: boolean; error: string };
    expect(refusedDestructive.ok).toBe(false);
    expect(refusedDestructive.error).toBe("refused_destructive_button");

    // Allowed when both allow_destructive: true and user_instruction are provided; writes responses.jsonl
    const allowedDestructive = (await aeRespondTool.handler(
      {
        handle: 111,
        button: "Don't Save",
        reason: "Jay explicitly instructed not to save the scratch project",
        allow_destructive: true,
        user_instruction: 'Jay: "Click Don\'t Save on the closing prompt"',
      },
      fakeCtx
    )) as { ok: boolean; pressed: string; closed: boolean };

    expect(allowedDestructive).toEqual({
      ok: true,
      handle: 111,
      pressed: "Don't Save",
      checked: null,
      closed: true,
    });

    const logPath = path.join(tempDialogsDir, "responses.jsonl");
    expect(fs.existsSync(logPath)).toBe(true);
    const logLines = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l));
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toMatchObject({
      time: "2026-10-27T14:05:00.000Z",
      handle: 111,
      title: "Save Changes",
      text_excerpt: "Save changes to Untitled Project.aep before closing?",
      button: "Don't Save",
      reason: "Jay explicitly instructed not to save the scratch project",
      op: null,
      allow_destructive: true,
      user_instruction: 'Jay: "Click Don\'t Save on the closing prompt"',
    });
  });

  it("OK or Yes on a real-button dialog whose text talks about losing or replacing needs both destructive flags (UI Automation and macOS)", async () => {
    const dlg = (handle: number, text: string, names: string[]) => ({
      handle,
      title: "After Effects",
      class: "#32770",
      isModal: true,
      text,
      buttons: names.map((name, i) => ({ name, automationId: String(i + 1), enabled: true })),
      checkboxes: [],
      boundingRect: { x: 10, y: 10, width: 300, height: 120 },
    });
    const calls: string[][] = [];
    const dialogs = [dlg(8001, "Any unsaved changes will be lost.", ["OK", "Cancel"]), dlg(8002, "Replace the existing file?", ["Yes", "No"]), dlg(8003, "The queue was saved.", ["OK", "Cancel"])];
    setDialogsTestOverrides({
      platform: "win32",
      dialogsDir: tempDialogsDir,
      ps1Runner: async (args) => {
        calls.push(args);
        if (args.includes("list")) return JSON.stringify({ ok: true, ae_pid: 5000, dialogs });
        return JSON.stringify({ ok: true, handle: Number(args[args.indexOf("-Handle") + 1]), pressed: args[args.indexOf("-Button") + 1], checked: null, closed: true });
      },
    });
    await getTool("ae_dialogs").handler({ screenshots: false }, fakeCtx);
    const respond = getTool("ae_dialog_respond");
    const jay = { reason: "r", user_instruction: "Jay: dismiss it" };
    // 8001 is not the topmost dialog, so list order is irrelevant to the gate: ask with the one that is.
    const first: any = await respond.handler({ handle: 8001, button: "OK", ...jay }, fakeCtx);
    expect(first).toMatchObject({ ok: false, error: "refused_destructive_dialog" });
    const yes: any = await respond.handler({ handle: 8002, button: "Yes", ...jay }, fakeCtx);
    expect(yes).toMatchObject({ ok: false, error: "refused_destructive_dialog" });
    expect(calls.some((a) => a.includes("respond"))).toBe(false);
    // Cancel and No need no flags; a harmless text is not gated; both flags let OK through.
    const cancelled: any = await respond.handler({ handle: 8001, button: "Cancel", ...jay }, fakeCtx);
    expect(cancelled.error).not.toBe("refused_destructive_dialog");
    const calm: any = await respond.handler({ handle: 8003, button: "OK", ...jay }, fakeCtx);
    expect(calm.error).not.toBe("refused_destructive_dialog");
    const both: any = await respond.handler({ handle: 8002, button: "Yes", ...jay, allow_destructive: true }, fakeCtx);
    expect(both.error).not.toBe("refused_destructive_dialog");

    // macOS: the same gate, before the script runs.
    const macCalls: string[][] = [];
    setDialogsTestOverrides({
      platform: "darwin",
      dialogsDir: tempDialogsDir,
      ps1Runner: async () => {
        throw new Error("PowerShell must not run on macOS");
      },
      macRunner: async (args) => {
        macCalls.push(args);
        if (args[0] === "list") return JSON.stringify({ ok: true, ae_pid: 501, dialogs: [dlg(301, "This will remove 3 items.", ["OK", "Cancel"])] });
        return JSON.stringify({ ok: true, handle: 301, pressed: args[2], checked: null, closed: true });
      },
    });
    await getTool("ae_dialogs").handler({ screenshots: false }, fakeCtx);
    const mac: any = await respond.handler({ handle: 301, button: "OK", ...jay }, fakeCtx);
    expect(mac).toMatchObject({ ok: false, error: "refused_destructive_dialog" });
    expect(macCalls.map((c) => c[0])).toEqual(["list"]);
  });

  it("a dialog with real buttons is answered only when it is the topmost one", async () => {
    const dlg = (handle: number, title: string) => ({
      handle,
      title,
      class: "#32770",
      isModal: true,
      text: "A message.",
      buttons: [{ name: "OK", automationId: "1", enabled: true }],
      checkboxes: [],
      boundingRect: { x: 10, y: 10, width: 300, height: 120 },
    });
    const ps1Calls: string[][] = [];
    setDialogsTestOverrides({
      platform: "win32",
      dialogsDir: tempDialogsDir,
      ps1Runner: async (args) => {
        ps1Calls.push(args);
        if (args.includes("list")) return JSON.stringify({ ok: true, ae_pid: 5000, dialogs: [dlg(7001, "Top"), dlg(7002, "Below")] });
        return JSON.stringify({ ok: true, handle: Number(args[args.indexOf("-Handle") + 1]), pressed: "OK", checked: null, closed: true });
      },
    });
    await getTool("ae_dialogs").handler({ screenshots: false }, fakeCtx);
    const respond = getTool("ae_dialog_respond");
    const below: any = await respond.handler({ handle: 7002, button: "OK", reason: "r", user_instruction: "Jay: dismiss it" }, fakeCtx);
    expect(below).toMatchObject({ ok: false, error: "dialog_not_topmost" });
    expect(ps1Calls.some((a) => a.includes("respond"))).toBe(false);
    const top: any = await respond.handler({ handle: 7001, button: "OK", reason: "r", user_instruction: "Jay: dismiss it" }, fakeCtx);
    expect(top.ok).toBe(true);
    expect(ps1Calls.some((a) => a.includes("respond"))).toBe(true);
  });

  it("reads and answers dialogs on macOS through ae-dialogs-mac.js", async () => {
    const macCalls: string[][] = [];
    const sheet = {
      handle: 101,
      title: "",
      class: "AXSheet",
      isModal: true,
      text: "Save changes to Show.aep?",
      buttons: [
        { name: "Cancel", automationId: "", enabled: true },
        { name: "Don't Save", automationId: "", enabled: true },
      ],
      checkboxes: [],
      boundingRect: { x: 10, y: 20, width: 300, height: 120 },
      screenshot: null,
    };
    setDialogsTestOverrides({
      platform: "darwin",
      dialogsDir: tempDialogsDir,
      ps1Runner: async () => {
        throw new Error("PowerShell must not run on macOS");
      },
      macRunner: async (args) => {
        macCalls.push(args);
        if (args[0] === "list") return JSON.stringify({ ok: true, ae_pid: 501, dialogs: [sheet] });
        return JSON.stringify({ ok: true, handle: 101, pressed: args[2], checked: null, closed: true });
      },
    });

    noteOpStarted("op_close_1");
    const listRes = (await getTool("ae_dialogs").handler({ screenshots: true }, fakeCtx)) as {
      ok: boolean;
      ae_pid: number;
      dialogs: Array<{ handle: number; text: string; caused_by_op: string | null; screenshot: string | null }>;
    };
    noteOpFinished("op_close_1");
    expect(listRes.ok).toBe(true);
    expect(listRes.ae_pid).toBe(501);
    expect(listRes.dialogs[0]).toMatchObject({ handle: 101, text: "Save changes to Show.aep?", caused_by_op: "op_close_1", screenshot: null });

    const res = await getTool("ae_dialog_respond").handler({ handle: 101, button: "Cancel", reason: "Our close caused it" }, fakeCtx);
    expect(res).toMatchObject({ ok: true, pressed: "Cancel", closed: true });
    expect(macCalls).toEqual([["list"], ["respond", "101", "Cancel", "", "", "Save changes to Show.aep?"]]);
  });

  it("passes the title and text guards to the macOS script and relays dialog_changed", async () => {
    const macCalls: string[][] = [];
    const win = {
      handle: 200,
      title: "Render Settings",
      class: "AXDialog",
      isModal: true,
      text: "x".repeat(300),
      buttons: [{ name: "Cancel", automationId: "", enabled: true }],
      checkboxes: [],
      boundingRect: { x: 0, y: 0, width: 10, height: 10 },
      screenshot: null,
    };
    setDialogsTestOverrides({
      platform: "darwin",
      dialogsDir: tempDialogsDir,
      macRunner: async (args) => {
        macCalls.push(args);
        if (args[0] === "list") return JSON.stringify({ ok: true, ae_pid: 1, dialogs: [win] });
        return JSON.stringify({ ok: false, error: "dialog_changed: the text of the window at this handle is different now; list the dialogs again" });
      },
    });
    noteOpStarted("op_mac_2");
    await getTool("ae_dialogs").handler({ screenshots: false }, fakeCtx);
    noteOpFinished("op_mac_2");
    const res = (await getTool("ae_dialog_respond").handler({ handle: 200, button: "Cancel", reason: "Our op caused it" }, fakeCtx)) as { ok: boolean; error: string };
    expect(macCalls[1]).toEqual(["respond", "200", "Cancel", "", "Render Settings", "x".repeat(200)]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^dialog_changed/);
  });

  it("passes a macOS permission error through", async () => {
    setDialogsTestOverrides({
      platform: "darwin",
      dialogsDir: tempDialogsDir,
      macRunner: async () => JSON.stringify({ ok: false, error: "accessibility_permission_needed: allow After Effects" }),
    });
    const listRes = await getTool("ae_dialogs").handler({ screenshots: false }, fakeCtx);
    expect(listRes).toEqual({ ok: false, error: "accessibility_permission_needed: allow After Effects" });
  });

  it("returns not_implemented_on_this_os on other platforms", async () => {
    setDialogsTestOverrides({
      platform: "linux",
      dialogsDir: tempDialogsDir,
    });

    const aeDialogsTool = getTool("ae_dialogs");
    const aeRespondTool = getTool("ae_dialog_respond");

    const listRes = await aeDialogsTool.handler({ screenshots: true }, fakeCtx);
    expect(listRes).toEqual({
      ok: false,
      error: "not_implemented_on_this_os",
    });

    const respondRes = await aeRespondTool.handler(
      {
        handle: 12345,
        button: "OK",
        reason: "Dismiss warning",
      },
      fakeCtx
    );
    expect(respondRes).toEqual({
      ok: false,
      error: "not_implemented_on_this_os",
    });

    const blocking = await describeBlockingDialogs();
    expect(blocking).toEqual([]);
  });
});

// ---------- AE-painted dialogs: button row, default button, posted keys ----------

describe("ae_dialogs / ae_dialog_respond on AE-painted dialogs (OCR boxes and screenshot)", () => {
  const dirs: string[] = [];
  let dir: string;
  const ctx = {} as ToolContext;
  const tool = (name: string) => dialogsTools.find((t) => t.name === name)!;

  beforeEach(() => {
    resetDialogsState();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-dlgpaint-"));
    dirs.push(dir);
  });
  afterEach(() => {
    resetDialogsState();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function writePng(name: string, img: PngPixels): string {
    const png = new PNG({ width: img.width, height: img.height });
    Buffer.from(img.data).copy(png.data);
    const file = path.join(dir, name);
    fs.writeFileSync(file, PNG.sync.write(png));
    return file;
  }

  interface Fixture {
    handle?: number;
    title?: string;
    lines: OcrLine[];
    pills: Pill[];
    analysisOnly?: boolean;
    rect?: string;
  }

  /** The list entry ae-dialogs.ps1 returns for a painted dialog: OCR lines with boxes, no buttons. */
  function listed(f: Fixture) {
    const handle = f.handle ?? 5150;
    const shot = writePng(`dialog_${handle}${f.analysisOnly ? "_analysis" : ""}.png`, makeImage(f.pills));
    return {
      handle,
      title: f.title ?? "After Effects",
      class: "#32770",
      isModal: true,
      text: f.lines.map((l) => l.text).join("\n"),
      text_source: "ocr",
      buttons: [],
      checkboxes: [],
      boundingRect: { x: 0, y: 0, width: W, height: H },
      screenshot: f.analysisOnly ? null : shot,
      analysis_png: f.analysisOnly ? shot : null,
      ocr_lines: f.lines,
      win_rect: f.rect ?? "",
    };
  }

  const calls: string[][] = [];
  function install(current: () => unknown, respond?: (args: string[]) => unknown) {
    calls.length = 0;
    setDialogsTestOverrides({
      platform: "win32",
      dialogsDir: dir,
      nowIso: () => "2026-11-07T10:00:00.000Z",
      ps1Runner: async (args) => {
        calls.push(args);
        if (args.includes("list")) return JSON.stringify({ ok: true, ae_pid: 1, dialogs: [current()] });
        const out = respond
          ? respond(args)
          : { ok: true, handle: 5150, pressed: args[args.indexOf("-Button") + 1], method: args.includes("escape") ? "post_escape" : "post_enter", checked: null, closed: true };
        return JSON.stringify(out);
      },
    });
  }
  const respondCalls = () => calls.filter((a) => a.includes("respond"));

  async function listOwn(op: string) {
    noteOpStarted(op);
    const res: any = await tool("ae_dialogs").handler({ screenshots: true }, ctx);
    noteOpFinished(op);
    return res;
  }

  const OK_ONLY: Fixture = { lines: [...TALL_BODY, line(word("OK", 300, 250, 22))], pills: [{ cx: 311, cy: 257, w: 70, ring: true }] };
  const okCancel = (ringOn: "ok" | "cancel" | "none"): Fixture => ({
    lines: [...TALL_BODY.slice(0, 3), line(word("OK", 300, 250, 22)), line(word("Cancel", 380, 250, 44))],
    pills: [
      { cx: 311, cy: 257, w: 70, ring: ringOn === "ok" },
      { cx: 400, cy: 257, w: 80, ring: ringOn === "cancel" },
    ],
  });
  const saveDialog: Fixture = {
    lines: [
      line(word("Save", 40, 120, 30), word("changes", 74, 120, 56)),
      line(word("Save", 117, 250, 26), word("Don't", 207, 250, 30), word("Save", 240, 250, 26), word("Cancel", 330, 250, 40)),
    ],
    pills: [
      { cx: 130, cy: 257, w: 70, ring: true },
      { cx: 235, cy: 257, w: 90 },
      { cx: 350, cy: 257, w: 80 },
    ],
  };

  it("the tall dialog lists exactly one button, OK, as the default, kind info, and the body keeps its last wrapped line", async () => {
    install(() => listed(OK_ONLY));
    const res: any = await tool("ae_dialogs").handler({ screenshots: true }, ctx);
    const d = res.dialogs[0];
    expect(d.buttons).toEqual([{ name: "OK", automationId: "", enabled: true, source: "ocr", default: true }]);
    expect(d.default_button).toBe("OK");
    expect(d.default_source).toBe("ring");
    expect(d.kind).toBe("info");
    expect(d.unattended.answerable).toEqual(["OK"]);
    expect(d.text.split("\n").pop()).toBe("preferences.");
  });

  it("respond OK on the tall dialog posts Enter and returns what the dialog said", async () => {
    install(() => listed(OK_ONLY));
    await listOwn("op_import_1");
    const res: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "OK", reason: "our import raised it" }, ctx);
    const sent = respondCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(expect.arrayContaining(["-Key", "enter", "-ExpectTitle", "After Effects"]));
    expect(sent[0].join(" ")).not.toMatch(/Focus|SendKeys/i);
    expect(res).toMatchObject({ ok: true, method: "post_enter", closed: true, default_button: "OK", dialog: { title: "After Effects" } });
    expect(res.dialog.text).toContain("preferences.");
    expect(res.message).toMatch(/Tell the user/);
  });

  it("OK + Cancel with the ring on OK: OK is pressed with Enter, Cancel with Escape", async () => {
    install(() => listed(okCancel("ok")));
    await listOwn("op_a");
    const ok: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "OK", reason: "r" }, ctx);
    expect(ok.ok).toBe(true);
    expect(respondCalls()[0]).toEqual(expect.arrayContaining(["-Key", "enter"]));

    install(() => listed(okCancel("ok")));
    await listOwn("op_b");
    const cancel: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "Cancel", reason: "r" }, ctx);
    expect(cancel.ok).toBe(true);
    expect(respondCalls()[0]).toEqual(expect.arrayContaining(["-Key", "escape"]));
  });

  it("OK + Cancel with the ring on Cancel: asking for OK returns button_not_default and nothing is sent", async () => {
    install(() => listed(okCancel("cancel")));
    await listOwn("op_c");
    const res: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "OK", reason: "r" }, ctx);
    expect(res).toMatchObject({ ok: false, error: "button_not_default", default_button: "Cancel" });
    expect(res.message).toMatch(/NOT pressed/);
    expect(res.message).toMatch(/default, outlined button is "Cancel"/);
    expect(respondCalls()).toHaveLength(0);
  });

  it("no ring found: the default is unknown, OK is not answerable and nothing is sent; Cancel still is", async () => {
    install(() => listed(okCancel("none")));
    const list = await listOwn("op_d");
    expect(list.dialogs[0].default_button).toBeNull();
    expect(list.dialogs[0].buttons.map((b: any) => b.default)).toEqual([undefined, undefined]);
    const res: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "OK", reason: "r" }, ctx);
    expect(res).toMatchObject({ ok: false, error: "button_not_answerable" });
    expect(res.message).toMatch(/could not be identified/);
    expect(respondCalls()).toHaveLength(0);
    const cancel: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "Cancel", reason: "r" }, ctx);
    expect(cancel.ok).toBe(true);
    expect(respondCalls()[0]).toEqual(expect.arrayContaining(["-Key", "escape"]));
  });

  it("refuses with dialog_changed when the dialog is not the one that was listed, and sends nothing", async () => {
    let cur: Fixture = OK_ONLY;
    install(() => listed(cur));
    await listOwn("op_e");
    // a different dialog takes the handle: other text, other title
    cur = { ...OK_ONLY, title: "Other", lines: [line(word("Something", 40, 60, 80), word("else", 124, 60, 40)), line(word("OK", 300, 250, 22))] };
    const res: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "OK", reason: "r" }, ctx);
    expect(res).toMatchObject({ ok: false, error: "dialog_changed" });
    expect(res.message).toMatch(/NOT pressed/);
    expect(respondCalls()).toHaveLength(0);
  });

  it("refuses with dialog_changed when the default button moved between the list and the answer", async () => {
    let cur: Fixture = okCancel("ok");
    install(() => listed(cur));
    await listOwn("op_f");
    cur = okCancel("cancel");
    const moved: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "OK", reason: "r" }, ctx);
    expect(moved).toMatchObject({ ok: false, error: "dialog_changed" });
    expect(respondCalls()).toHaveLength(0);
  });

  it("the policy still decides first: a painted dialog not caused by our op needs a user_instruction", async () => {
    install(() => listed(OK_ONLY));
    await tool("ae_dialogs").handler({ screenshots: true }, ctx); // no op in flight: caused_by_op null
    const refused: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "OK", reason: "r" }, ctx);
    expect(refused).toMatchObject({ ok: false, error: "refused_not_caused_by_our_op" });
    expect(respondCalls()).toHaveLength(0);
    const allowed: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "OK", reason: "r", user_instruction: "Jay: dismiss the frames warning" }, ctx);
    expect(allowed.ok).toBe(true);
    expect(respondCalls()).toHaveLength(1);
  });

  it("a destructive button needs both flags, and even then only the default can be answered, and only when it is OK-like", async () => {
    install(() => listed(saveDialog));
    const list = await listOwn("op_g");
    expect(list.dialogs[0].buttons.map((b: any) => b.name)).toEqual(["Save", "Don't Save", "Cancel"]);
    expect(list.dialogs[0].kind).toBe("destructive");
    const noFlags: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "Don't Save", reason: "r" }, ctx);
    expect(noFlags.error).toBe("refused_destructive_button");
    const both = { allow_destructive: true, user_instruction: 'Jay: "do not save"' };
    const notDefault: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "Don't Save", reason: "r", ...both }, ctx);
    expect(notDefault).toMatchObject({ ok: false, error: "button_not_default", default_button: "Save" });
    const saveDefault: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "Save", reason: "r", ...both }, ctx);
    expect(saveDefault).toMatchObject({ ok: false, error: "button_not_answerable" }); // default, but not OK/Yes/Continue
    expect(respondCalls()).toHaveLength(0);
  });

  it("when the posted key does not close the dialog the result says so and no second attempt is made", async () => {
    install(() => listed(OK_ONLY), () => ({ ok: true, handle: 5150, pressed: "OK", method: "post_enter", checked: null, closed: false }));
    await listOwn("op_h");
    const res: any = await tool("ae_dialog_respond").handler({ handle: 5150, button: "OK", reason: "r" }, ctx);
    expect(res).toMatchObject({ ok: true, closed: false });
    expect(res.message).toMatch(/did not close within 3 s/);
    expect(res.message).toMatch(/ask the user/);
    expect(respondCalls()).toHaveLength(1);
  });

  it("an empty title is guarded with -ExpectEmptyTitle", async () => {
    install(() => listed({ ...OK_ONLY, title: "" }));
    await listOwn("op_i");
    await tool("ae_dialog_respond").handler({ handle: 5150, button: "OK", reason: "r" }, ctx);
    expect(respondCalls()[0]).toContain("-ExpectEmptyTitle");
    expect(respondCalls()[0]).not.toContain("-ExpectTitle");
  });

  it("a screenshot kept only for the analysis is read and then deleted", async () => {
    const f = listed({ ...OK_ONLY, analysisOnly: true });
    install(() => f);
    const res: any = await tool("ae_dialogs").handler({ screenshots: false }, ctx);
    expect(res.dialogs[0].default_source).toBe("ring");
    expect(fs.existsSync(f.analysis_png as string)).toBe(false);
  });

  it("kind: OK with a checkbox is a question", async () => {
    const withBox = { ...listed(OK_ONLY), checkboxes: [{ name: "Do not show again", checked: false }] };
    install(() => withBox);
    const res: any = await tool("ae_dialogs").handler({ screenshots: true }, ctx);
    expect(res.dialogs[0].kind).toBe("question");
  });

  // ---- repair round ----

  const same = (f: Fixture, over: Partial<Fixture>): Fixture => ({ ...f, ...over });
  const answer = (button = "OK", extra: Record<string, unknown> = {}) =>
    tool("ae_dialog_respond").handler({ handle: 5150, button, reason: "r", ...extra }, ctx) as Promise<any>;

  it("dialog_changed fires on a change of ONLY the title, ONLY the text, ONLY the buttons or ONLY the position", async () => {
    const body = TALL_BODY.slice(0, 3);
    const base: Fixture = { lines: [...body, line(word("OK", 300, 250, 22))], pills: [{ cx: 311, cy: 257, w: 70, ring: true }], rect: "0,0,480,300" };
    const variants: Array<[string, Fixture]> = [
      ["title", same(base, { title: "After Effects Warning" })],
      ["text", same(base, { lines: [line(word("Different", 40, 60, 80), word("words", 124, 60, 50)), ...body.slice(1), line(word("OK", 300, 250, 22))] })],
      [
        "buttons",
        same(base, { lines: [...body, line(word("OK", 300, 250, 22)), line(word("Cancel", 380, 250, 44))], pills: [{ cx: 311, cy: 257, w: 70, ring: true }, { cx: 400, cy: 257, w: 80 }] }),
      ],
      ["rect", same(base, { rect: "10,0,490,300" })],
    ];
    for (const [what, changed] of variants) {
      let cur: Fixture = base;
      install(() => listed(cur));
      await listOwn("op_v_" + what);
      cur = changed;
      const res = await answer("OK");
      expect(res, what).toMatchObject({ ok: false, error: "dialog_changed" });
      expect(respondCalls(), what).toHaveLength(0);
    }
  });

  it("a letter outside ASCII counts in the text compare", async () => {
    const mk = (w: string): Fixture => ({ lines: [line(word(w, 40, 60, 80)), line(word("OK", 300, 250, 22))], pills: [{ cx: 311, cy: 257, w: 70, ring: true }] });
    let cur = mk("café");
    install(() => listed(cur));
    await listOwn("op_u");
    cur = mk("cafè");
    expect(await answer("OK")).toMatchObject({ ok: false, error: "dialog_changed" });
  });

  it("only ae_dialogs sets the baseline: a background list of a changed dialog does not make it answerable", async () => {
    let cur: Fixture = OK_ONLY;
    install(() => listed(cur));
    await listOwn("op_bg");
    cur = { ...OK_ONLY, title: "Something Else", lines: [line(word("Other", 40, 60, 60)), line(word("OK", 300, 250, 22))] };
    await describeBlockingDialogs(); // diagnostics read it in the background (and it is a new dialog: caused_by_op restarts)
    const res = await answer("OK", { user_instruction: "Jay: dismiss it" });
    expect(res).toMatchObject({ ok: false, error: "dialog_changed" });
    expect(respondCalls()).toHaveLength(0);
  });

  it("a dialog never shown by ae_dialogs is not answered (dialog_not_listed)", async () => {
    install(() => listed(OK_ONLY));
    noteOpStarted("op_nl");
    await describeBlockingDialogs(); // only the background list has seen it
    const res = await answer("OK");
    noteOpFinished("op_nl");
    expect(res).toMatchObject({ ok: false, error: "dialog_not_listed" });
    expect(respondCalls()).toHaveLength(0);
  });

  it("a handle that is not an open dialog is dialog_gone and nothing is sent, even with an op in flight", async () => {
    install(() => listed({ ...OK_ONLY, handle: 999 }));
    noteOpStarted("op_gone");
    const res = await answer("OK");
    noteOpFinished("op_gone");
    expect(res).toMatchObject({ ok: false, error: "dialog_gone" });
    expect(respondCalls()).toHaveLength(0);
  });

  it("dialog_gone when the fresh read no longer lists it, and a failed fresh read is passed on", async () => {
    let mode: "ok" | "empty" | "fail" = "ok";
    calls.length = 0;
    setDialogsTestOverrides({
      platform: "win32",
      dialogsDir: dir,
      ps1Runner: async (args) => {
        calls.push(args);
        if (!args.includes("list")) return JSON.stringify({ ok: true, closed: true, method: "post_enter", pressed: "OK" });
        if (mode === "fail") return JSON.stringify({ ok: false, error: "list_broke" });
        return JSON.stringify({ ok: true, ae_pid: 1, dialogs: mode === "empty" ? [] : [listed(OK_ONLY)] });
      },
    });
    await listOwn("op_gf");
    mode = "empty";
    expect(await answer("OK")).toMatchObject({ ok: false, error: "dialog_gone" });
    mode = "ok";
    await listOwn("op_gf2");
    mode = "fail";
    expect(await answer("OK")).toMatchObject({ ok: false, error: "list_broke" });
    expect(respondCalls()).toHaveLength(0);
  });

  it("a painted dialog that comes back with no OCR (or with real buttons) is dialog_changed and no key is sent", async () => {
    let mode: "painted" | "bare" | "uia" = "painted";
    install(() => {
      if (mode === "painted") return listed(OK_ONLY);
      const base = { ...listed(OK_ONLY), ocr_lines: null };
      if (mode === "bare") return { ...base, buttons: [] };
      return { ...base, text_source: "uia", buttons: [{ name: "OK", automationId: "1", enabled: true }] };
    });
    await listOwn("op_n1");
    const jay = { user_instruction: "Jay: dismiss it" };
    mode = "bare";
    expect(await answer("OK", jay)).toMatchObject({ ok: false, error: "dialog_changed" });
    mode = "uia";
    expect(await answer("OK", jay)).toMatchObject({ ok: false, error: "dialog_changed" });
    expect(respondCalls()).toHaveLength(0);
  });

  it("a real-button dialog with the same title, text and buttons as the painted one listed is still refused (no key to a window that is not painted)", async () => {
    const painted = listed(okCancel("none"));
    let uia = false;
    install(() => (uia ? { ...painted, text_source: "uia", ocr_lines: null, buttons: [{ name: "OK", automationId: "1", enabled: true }, { name: "Cancel", automationId: "2", enabled: true }] } : painted));
    const list = await listOwn("op_same");
    painted.text = list.dialogs[0].text; // the UIA read says exactly what the painted read said
    uia = true;
    const res = await answer("Cancel");
    expect(res).toMatchObject({ ok: false, error: "dialog_changed" });
    expect(respondCalls()).toHaveLength(0);
  });

  it("stacked dialogs: only the topmost one is answered", async () => {
    const top = listed({ ...OK_ONLY, handle: 6001, title: "Verifying" });
    const under = listed(OK_ONLY);
    calls.length = 0;
    setDialogsTestOverrides({
      platform: "win32",
      dialogsDir: dir,
      ps1Runner: async (args) => {
        calls.push(args);
        if (args.includes("list")) return JSON.stringify({ ok: true, ae_pid: 1, dialogs: [listed({ ...OK_ONLY, handle: 6001, title: "Verifying" }), listed(OK_ONLY)] });
        return JSON.stringify({ ok: true, closed: true, method: "post_enter", pressed: "OK", handle: args[args.indexOf("-Handle") + 1] });
      },
    });
    expect(top.handle).toBe(6001);
    expect(under.handle).toBe(5150);
    await listOwn("op_st");
    const blocked = await answer("OK");
    expect(blocked).toMatchObject({ ok: false, error: "dialog_not_topmost" });
    expect(respondCalls()).toHaveLength(0);
    const ok = (await tool("ae_dialog_respond").handler({ handle: 6001, button: "OK", reason: "r" }, ctx)) as any;
    expect(ok.ok).toBe(true);
    expect(respondCalls()).toHaveLength(1);
  });

  it.each([
    ["Any unsaved changes will be lost.", ["Any", "unsaved", "changes", "will", "be", "lost."]],
    ["This will remove 3 items.", ["This", "will", "remove", "3", "items."]],
    ["All changes will be erased.", ["All", "changes", "will", "be", "erased."]],
  ])("OK on a dialog saying '%s' needs both destructive flags", async (_text, words) => {
    const body = [line(...words.map((w, i) => word(w, 40 + i * 60, 60, 54)))];
    install(() => listed({ lines: [...body, line(word("OK", 300, 250, 22)), line(word("Cancel", 380, 250, 44))], pills: [{ cx: 311, cy: 257, w: 70, ring: true }, { cx: 400, cy: 257, w: 80 }] }));
    await listOwn("op_pat");
    expect(await answer("OK")).toMatchObject({ ok: false, error: "refused_destructive_dialog" });
    expect(respondCalls()).toHaveLength(0);
  });

  it("a ring on OK with a second pill whose label was not read (Cancel unread) is gated like a multi-button dialog", async () => {
    const body = [line(word("Replace", 40, 60, 60), word("file?", 104, 60, 40))];
    install(() => listed({ lines: [...body, line(word("OK", 300, 250, 22))], pills: [{ cx: 311, cy: 257, w: 70, ring: true }, { cx: 400, cy: 257, w: 80 }] }));
    const list = await listOwn("op_ring1");
    expect(list.dialogs[0].default_source).toBe("ring");
    expect(list.dialogs[0].buttons).toHaveLength(1);
    expect(list.dialogs[0].other_pill_unread).toBe(true);
    expect(await answer("OK")).toMatchObject({ ok: false, error: "refused_destructive_dialog" });
    expect(respondCalls()).toHaveLength(0);
  });

  it("a lone ringed OK whose text says 'removed from the queue' is answered: nothing else is hidden on the row", async () => {
    const body = [line(word("Item", 40, 60, 40), word("removed", 90, 60, 60), word("from", 160, 60, 36), word("the", 206, 60, 26), word("queue.", 242, 60, 50))];
    install(() => listed({ lines: [...body, line(word("OK", 300, 250, 22))], pills: [{ cx: 311, cy: 257, w: 70, ring: true }] }));
    const list = await listOwn("op_ring2");
    expect(list.dialogs[0].default_source).toBe("ring");
    expect(list.dialogs[0].other_pill_unread).toBe(false);
    const res = await answer("OK");
    expect(res.ok).toBe(true);
    expect(respondCalls()[0]).toEqual(expect.arrayContaining(["-Key", "enter"]));
  });

  it("OK on a multi-button dialog whose text talks about replacing needs both destructive flags; 'saved' does not", async () => {
    const replaceBody = [line(word("Replace", 40, 60, 60), word("existing", 104, 60, 60), word("file?", 168, 60, 36))];
    const savedBody = [line(word("Project", 40, 60, 60), word("was", 104, 60, 30), word("saved.", 138, 60, 50))];
    const dlg = (body: OcrLine[]): Fixture => ({
      lines: [...body, line(word("OK", 300, 250, 22)), line(word("Cancel", 380, 250, 44))],
      pills: [{ cx: 311, cy: 257, w: 70, ring: true }, { cx: 400, cy: 257, w: 80 }],
    });
    install(() => listed(dlg(replaceBody)));
    await listOwn("op_r");
    const refused = await answer("OK");
    expect(refused).toMatchObject({ ok: false, error: "refused_destructive_dialog" });
    expect(respondCalls()).toHaveLength(0);
    expect(await answer("OK", { allow_destructive: true })).toMatchObject({ ok: false, error: "refused_destructive_dialog" });
    expect(await answer("Cancel")).toMatchObject({ ok: true }); // cancelling needs no flags
    install(() => listed(dlg(replaceBody)));
    await listOwn("op_r2");
    const both = await answer("OK", { allow_destructive: true, user_instruction: 'Jay: "replace it"' });
    expect(both.ok).toBe(true);
    expect(respondCalls()[0]).toEqual(expect.arrayContaining(["-Key", "enter"]));

    install(() => listed(dlg(savedBody)));
    await listOwn("op_r3");
    expect((await answer("OK")).ok).toBe(true);
  });

  it("No or Close is refused when a Cancel is on the row (Escape would answer Cancel); Cancel itself still goes", async () => {
    const yesNoCancel: Fixture = {
      lines: [...TALL_BODY.slice(0, 2), line(word("Yes", 150, 250, 26), word("No", 240, 250, 18), word("Cancel", 330, 250, 40))],
      pills: [{ cx: 163, cy: 257, w: 70, ring: true }, { cx: 249, cy: 257, w: 70 }, { cx: 350, cy: 257, w: 80 }],
    };
    install(() => listed(yesNoCancel));
    const list = await listOwn("op_ync");
    expect(list.dialogs[0].buttons.map((b: any) => b.name)).toEqual(["Yes", "No", "Cancel"]);
    expect(list.dialogs[0].unattended.answerable).toEqual(["Cancel", "Yes"]);
    expect(await answer("No")).toMatchObject({ ok: false, error: "button_not_answerable" });
    expect(respondCalls()).toHaveLength(0);
    expect((await answer("Cancel")).ok).toBe(true);
    expect(respondCalls()[0]).toEqual(expect.arrayContaining(["-Key", "escape"]));
  });

  it("a moving percent does not block Cancel, but does block OK; title, buttons and rect still count for Cancel", async () => {
    const progress = (pct: string, rect = "0,0,480,300"): Fixture => ({
      lines: [line(word("Saving", 40, 60, 50), word("project", 94, 60, 50), word(pct, 148, 60, 30)), line(word("Cancel", 380, 250, 44))],
      pills: [{ cx: 400, cy: 257, w: 80, ring: true }],
      rect,
    });
    let cur = progress("40%");
    install(() => listed(cur));
    await listOwn("op_p");
    cur = progress("41%");
    expect((await answer("Cancel")).ok).toBe(true);
    install(() => listed(cur));
    await listOwn("op_p2");
    cur = progress("42%");
    expect(await answer("Cancel")).toMatchObject({ ok: true });
    cur = progress("43%", "5,5,485,305");
    install(() => listed(cur));
    // rect differs from the baseline taken before: Cancel is refused too
    cur = progress("44%");
    install(() => listed(progress("44%")));
    await listOwn("op_p3");
    cur = progress("45%", "5,5,485,305");
    install(() => listed(cur));
    expect(await answer("Cancel")).toMatchObject({ ok: false, error: "dialog_changed" });
  });

  it("-ExpectRect from the listing is passed to the script", async () => {
    install(() => listed({ ...OK_ONLY, rect: "1,2,481,302" }));
    await listOwn("op_rect");
    await answer("OK");
    expect(respondCalls()[0]).toEqual(expect.arrayContaining(["-ExpectRect", "1,2,481,302"]));
  });

  it("new content behind a known handle restarts first_seen and caused_by_op", async () => {
    let cur: Fixture = OK_ONLY;
    install(() => listed(cur));
    const first = await listOwn("op_first");
    expect(first.dialogs[0].caused_by_op).toBe("op_first");
    cur = { ...OK_ONLY, title: "Another", lines: [line(word("Totally", 40, 60, 60), word("new", 104, 60, 30)), line(word("OK", 300, 250, 22))] };
    const second = (await tool("ae_dialogs").handler({ screenshots: true }, ctx)) as any; // no op in flight now
    expect(second.dialogs[0].caused_by_op).toBeNull();
    const refused = await answer("OK");
    expect(refused).toMatchObject({ ok: false, error: "refused_not_caused_by_our_op" });
  });

  it("a number that changes does not make a new dialog (progress text)", async () => {
    let n = 40;
    const mk = (): Fixture => ({ lines: [line(word("Progress", 40, 60, 60), word(`${n}%`, 104, 60, 30)), line(word("Cancel", 380, 250, 44))], pills: [{ cx: 400, cy: 257, w: 80, ring: true }] });
    install(() => listed(mk()));
    const a = await listOwn("op_n");
    n = 41;
    const b = (await tool("ae_dialogs").handler({ screenshots: true }, ctx)) as any;
    expect(b.dialogs[0].caused_by_op).toBe(a.dialogs[0].caused_by_op);
    expect(b.dialogs[0].first_seen).toBe(a.dialogs[0].first_seen);
  });

  it("tool descriptions keep the three dialog rules and name the default button", () => {
    for (const t of dialogsTools) {
      expect(t.description).toMatch(/never suppress/i);
      expect(t.description).toMatch(/caused_by_op|own operation caused/i);
      expect(t.description).toMatch(/destructive/i);
      expect(t.description).toMatch(/default/i);
    }
  });
});

describe.skipIf(process.platform !== "win32")("ae-dialogs.ps1 (parsed only, never run)", () => {
  const script = locateDialogsPs1Script() as string;

  it("has no syntax errors", () => {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:CHROMA_PS1_UNDER_TEST,[ref]$t,[ref]$e);$e.Count"],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, CHROMA_PS1_UNDER_TEST: script } }
    );
    expect(out.trim()).toBe("0");
  });

  it("takes -Key, -ExpectTitle and -ExpectEmptyTitle, and builds no focus-taking fallback", () => {
    const text = fs.readFileSync(script, "utf8");
    expect(text).toMatch(/\[string\]\$Key\b/);
    expect(text).toMatch(/\[string\]\$ExpectTitle\b/);
    expect(text).toMatch(/\[switch\]\$ExpectEmptyTitle\b/);
    const code = text
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).not.toMatch(/SendKeys|AppActivate|SetForegroundWindow|SendInput/i);
  });
});

describe.skipIf(process.platform !== "win32")("ae-dialogs.ps1 -Key path, executed with handles that must be refused (no After Effects involved)", () => {
  const script = locateDialogsPs1Script() as string;
  const run = (psArgs: string[]) => {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...psArgs], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    return JSON.parse(out.trim().split(/\r?\n/).pop() as string);
  };
  const desktop = () =>
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Add-Type 'public class ChromaTestU { [System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern System.IntPtr GetDesktopWindow(); }'; [ChromaTestU]::GetDesktopWindow().ToInt64()"],
      { encoding: "utf8", windowsHide: true, timeout: 60_000 }
    ).trim();

  it("refuses a dead handle with dialog_gone and posts nothing", () => {
    expect(run(["-Mode", "respond", "-Handle", "1", "-Button", "OK", "-Key", "enter", "-ExpectTitle", "x"])).toEqual({ ok: false, error: "dialog_gone" });
  });

  it("refuses a live window that is not After Effects (the desktop) with dialog_changed", () => {
    const res = run(["-Mode", "respond", "-Handle", desktop(), "-Button", "OK", "-Key", "enter", "-ExpectTitle", "x"]);
    expect(res).toMatchObject({ ok: false, error: "dialog_changed" });
    expect(res.detail).toMatch(/not an After Effects window/);
  });

  it("without -Key it never posts: an unknown window gets button_not_answerable or dialog_gone, not a key", () => {
    const dead = run(["-Mode", "respond", "-Handle", "1", "-Button", "OK"]);
    expect(dead.ok).toBe(false);
  });

  it("Write-JsonOut escapes everything outside ASCII (stdout may be ibm850)", () => {
    const src = fs.readFileSync(script, "utf8");
    const fn = /function Write-JsonOut[\s\S]*?\r?\n\}/.exec(src);
    expect(fn).not.toBeNull();
    const code = `${(fn as RegExpExecArray)[0]}\nWrite-JsonOut @{ t = "caf$([char]0xE9) $([char]0x2014) $([char]0xD83D)$([char]0xDE00)"; n = 1 }`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", code], { encoding: "utf8", windowsHide: true, timeout: 60_000 }).trim();
    expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
    expect(JSON.parse(out)).toEqual({ n: 1, t: "café — 😀" });
  });
});
