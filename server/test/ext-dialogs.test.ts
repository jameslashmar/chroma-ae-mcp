import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

  it("returns not_implemented_on_this_os on non-Windows platforms", async () => {
    setDialogsTestOverrides({
      platform: "darwin",
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
