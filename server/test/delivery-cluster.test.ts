/**
 * Fixes from the first live smoke in After Effects 26.2.1 (delivery cluster):
 * - ae_export_mogrt hung the queue behind a "fonts were not synced from Adobe" dialog
 * - ae_dialogs showed the OK button of an AE-painted dialog as "0K"; ae_dialog_respond cannot press OK
 *   on a two-button AE-painted dialog and must say so
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import type { ToolContext } from "../src/tools/common.js";
import {
  describeBlockingDialogs,
  dialogsTools,
  normalizeOcrLabel,
  resetDialogsState,
  setDialogsTestOverrides,
  unattendedAnswers,
} from "../src/tools/ext/dialogs.js";
import { layoutTools } from "../src/tools/ext/layout.js";
import { GUARD, FakeProject, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
afterEach(() => {
  resetDialogsState();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

// ---------- ae_export_mogrt: fonts that are not from Adobe Fonts ----------

function mogrtScene(fontFlag: boolean | undefined, opts: { nested?: boolean } = {}) {
  const project = new FakeProject();
  const comp = project.addComp("Title", 640, 360, 4);
  const { A } = loadHost(project, ["layers.jsx", "layout.jsx"]);
  A.createLayer({ comp_id: comp.id, type: "text", text: "Hello", name: "Head", expect: GUARD });
  const layer = comp.layer("Head")!;
  const doc = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
  doc.font = "SpaceGrotesk-Regular";
  doc.fontFamily = "Space Grotesk";
  doc.fontStyle = "Regular";
  // The Font object AE 24+ gives: isFromAdobeFonts is absent when this AE does not report it.
  doc.fontObject = fontFlag === undefined ? { isSubstitute: false } : { isSubstitute: false, isFromAdobeFonts: fontFlag };
  comp.controllers.push("Headline");
  project.file = { fsName: "C:/jobs/x.aep" };
  project.dirty = false;
  return { project, comp, A, saved: { project_path: "C:/jobs/x.aep" } };
}

describe("exportMogrt fonts (host)", () => {
  it("refuses a font that is not from Adobe Fonts, names it, and does not export", () => {
    const { comp, A, saved } = mogrtScene(false);
    const out = path.join(tmp("chroma-mogrt-fonts-"), "t.mogrt");
    expect(() => A.exportMogrt({ comp_id: comp.id, path: out, overwrite: true, expect: saved })).toThrow(/Space Grotesk Regular.*Title > Head/);
    expect(() => A.exportMogrt({ comp_id: comp.id, path: out, overwrite: true, expect: saved })).toThrow(/allow_font_dialog/);
    expect(comp.exported).toEqual([]);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("exports when allow_font_dialog says the user is there, and reports the fonts", () => {
    const { comp, A, saved } = mogrtScene(false);
    const out = path.join(tmp("chroma-mogrt-fonts-"), "t.mogrt");
    const r = A.exportMogrt({ comp_id: comp.id, path: out, overwrite: true, allow_font_dialog: true, expect: saved });
    expect(r).toMatchObject({ exported: true, fonts_checked: 1 });
    expect(r.fonts_not_from_adobe[0]).toMatchObject({ label: "Space Grotesk Regular", origin: "local" });
    expect(comp.exported).toHaveLength(1);
  });

  it("exports an Adobe Fonts font without asking", () => {
    const { comp, A, saved } = mogrtScene(true);
    const r = A.exportMogrt({ comp_id: comp.id, expect: saved });
    expect(r).toMatchObject({ exported: true, fonts_checked: 1, fonts_origin_unknown: 0 });
    expect(r.fonts_not_from_adobe).toBeUndefined();
  });

  it("does not refuse a font whose origin this AE does not report, and counts it", () => {
    const { comp, A, saved } = mogrtScene(undefined);
    const r = A.exportMogrt({ comp_id: comp.id, expect: saved });
    expect(r).toMatchObject({ exported: true, fonts_checked: 1, fonts_origin_unknown: 1 });
  });
});

/**
 * Mixed fonts the way AE 26.2.1 reported them live: td.font is the first run's font, and
 * td.characterRange(a, b) gives a range whose font is undefined while the range is mixed and the
 * run's font once it is uniform; a range outside the text throws.
 */
function mixedRuns(doc: any, text: string, fontOf: (i: number) => { ps: string; family: string; adobe: boolean }) {
  const obj = (i: number) => {
    const f = fontOf(i);
    return { ps: f.ps, family: f.family, fo: { isSubstitute: false, isFromAdobeFonts: f.adobe } };
  };
  doc.text = text;
  doc.font = fontOf(0).ps;
  doc.fontFamily = fontOf(0).family;
  doc.fontStyle = "Regular";
  doc.fontObject = obj(0).fo;
  doc.characterRange = (a: number, b: number) => {
    if (a < 0 || b > text.length || a > b) throw new Error("Character index range is outside of TextDocument bounds.");
    const first = obj(a);
    for (let i = a + 1; i < b; i++) if (obj(i).ps !== first.ps) return { text: text.slice(a, b) };
    return { font: first.ps, fontFamily: first.family, fontStyle: "Regular", fontObject: first.fo };
  };
}
const ADOBE = { ps: "AdobeClean-Regular", family: "Adobe Clean", adobe: true };
const LOCAL = { ps: "ArialMT", family: "Arial", adobe: false };

describe("exportMogrt fonts per run (host)", () => {
  it("refuses a local font in a later run of a text layer whose first run is an Adobe font", () => {
    const { comp, A, saved } = mogrtScene(true);
    const doc = comp.layer("Head")!.property("ADBE Text Properties").property("ADBE Text Document").value;
    mixedRuns(doc, "Hello World", (i) => (i < 6 ? ADOBE : LOCAL));
    // td.font alone says Adobe Fonts, which is what the old scan trusted.
    expect(doc.fontObject.isFromAdobeFonts).toBe(true);
    expect(() => A.exportMogrt({ comp_id: comp.id, expect: saved })).toThrow(/Arial.*Title > Head/);
    expect(comp.exported).toEqual([]);
  });

  it("exports when every run is from Adobe Fonts, and says the scan was complete", () => {
    const { comp, A, saved } = mogrtScene(true);
    const doc = comp.layer("Head")!.property("ADBE Text Properties").property("ADBE Text Document").value;
    mixedRuns(doc, "Hello World", (i) => (i < 6 ? ADOBE : { ...ADOBE, ps: "AdobeClean-Bold", family: "Adobe Clean Bold" }));
    const r = A.exportMogrt({ comp_id: comp.id, expect: saved });
    expect(r).toMatchObject({ exported: true, fonts_checked: 2, fonts_scan_complete: true });
    expect(r.fonts_scan_gaps).toBeUndefined();
  });

  it("refuses a text with more font runs than the scan follows, and exports with allow_font_dialog while reporting the gap", () => {
    const { comp, A, saved } = mogrtScene(true);
    const doc = comp.layer("Head")!.property("ADBE Text Properties").property("ADBE Text Document").value;
    // 1000 characters alternating between two Adobe fonts: far more runs than the call budget.
    mixedRuns(doc, "x".repeat(1000), (i) => (i % 2 === 0 ? ADOBE : { ...ADOBE, ps: "AdobeClean-Bold", family: "Adobe Clean Bold" }));
    expect(() => A.exportMogrt({ comp_id: comp.id, expect: saved })).toThrow(/could not cover everything.*more font runs/);
    expect(comp.exported).toEqual([]);
    const r = A.exportMogrt({ comp_id: comp.id, allow_font_dialog: true, expect: saved });
    expect(r).toMatchObject({ exported: true, fonts_scan_complete: false });
    expect(r.fonts_scan_gaps[0]).toMatch(/more font runs/);
  });
});

describe("ae_export_mogrt fonts (tool)", () => {
  const tool = layoutTools.find((t) => t.name === "ae_export_mogrt")!;

  it("describes the refusal and the allow_font_dialog argument", () => {
    expect(tool.description).toMatch(/not from Adobe Fonts/);
    expect(tool.description).toMatch(/allow_font_dialog/);
    expect(tool.description).toMatch(/blocks the whole queue/);
    expect(tool.schema.parse({ comp_id: 1, expect: { project_path: "x" }, allow_font_dialog: true })).toMatchObject({ allow_font_dialog: true });
  });

  it("passes allow_font_dialog to the host and returns the fonts it found", async () => {
    const out = path.join(tmp("chroma-mogrt-tool-"), "t.mogrt");
    const sent: string[] = [];
    const queue = new SingleWriterQueue();
    const quarantine = new QuarantineStore(path.join(tmp("chroma-q-"), "quarantine.json"));
    const host = new PanelHost({
      evalScript: async (script) => {
        if (script.startsWith("__chromaAe.checkGuard")) return { ok: true, result: { ok: true, project_path: "<unsaved>", comp_id: 1, comp_is_valid: true, dirty: false }, durationMs: 1 };
        sent.push(script);
        fs.writeFileSync(out, "mogrt");
        return {
          ok: true,
          result: { exported: true, controllers: 1, template_name: "T", fonts_checked: 1, fonts_origin_unknown: 0, fonts_not_from_adobe: [{ label: "Space Grotesk Regular" }] },
          durationMs: 1,
        };
      },
      queue,
      quarantine,
    });
    const ctx: ToolContext = { bridge: host, queue, quarantine };
    const args = tool.schema.parse({ comp_id: 1, path: out, allow_font_dialog: true, expect: { project_path: "<unsaved>" } });
    const res: any = await tool.handler(args, ctx);
    expect(sent[0]).toMatch(/"allow_font_dialog":true/);
    expect(res).toMatchObject({ ok: true, fonts_checked: 1, fonts_not_from_adobe: [{ label: "Space Grotesk Regular" }] });
  });
});

// ---------- ae_dialogs: OCR 0K, and what can be answered unattended ----------

const ocrDialog = (buttons: string[]) => ({
  handle: 4242,
  title: "",
  class: "#32770",
  isModal: true,
  text: "The following 1 fonts were not synced from Adobe",
  text_source: "ocr",
  buttons: buttons.map((name) => ({ name, automationId: "", enabled: true, source: "ocr" })),
  checkboxes: [],
  boundingRect: { x: 0, y: 0, width: 400, height: 200 },
  screenshot: null,
});

function useDialogs(listed: unknown[], respondWith?: unknown) {
  const dir = tmp("chroma-dlg-");
  setDialogsTestOverrides({
    platform: "win32",
    dialogsDir: dir,
    nowIso: () => "2026-11-05T10:00:00.000Z",
    ps1Runner: async (args) => {
      if (args.includes("list")) return JSON.stringify({ ok: true, ae_pid: 1, dialogs: listed });
      return JSON.stringify(respondWith ?? { ok: false, error: "not_set" });
    },
  });
}
const dtool = (name: string) => dialogsTools.find((t) => t.name === name)!;
const noCtx = {} as ToolContext;

describe("ae_dialogs OCR labels", () => {
  it("reads OCR 0K as OK and keeps the original as raw_name", async () => {
    useDialogs([ocrDialog(["0K", "Cancel"])]);
    const res: any = await dtool("ae_dialogs").handler({ screenshots: false }, noCtx);
    expect(res.dialogs[0].buttons.map((b: any) => b.name)).toEqual(["OK", "Cancel"]);
    expect(res.dialogs[0].buttons[0]).toMatchObject({ source: "ocr", raw_name: "0K" });
    expect(res.dialogs[0].buttons[1].raw_name).toBeUndefined();
  });

  it("does not rewrite a real UI Automation button", async () => {
    const d = { ...ocrDialog(["0K"]), text_source: "uia", buttons: [{ name: "0K", automationId: "1", enabled: true }] };
    useDialogs([d]);
    const res: any = await dtool("ae_dialogs").handler({ screenshots: false }, noCtx);
    expect(res.dialogs[0].buttons[0].name).toBe("0K");
    expect(res.dialogs[0].unattended).toBeUndefined();
  });

  it("says a two-button AE-painted dialog can only be cancelled unattended", async () => {
    useDialogs([ocrDialog(["0K", "Cancel"])]);
    const res: any = await dtool("ae_dialogs").handler({ screenshots: false }, noCtx);
    expect(res.dialogs[0].unattended.answerable).toEqual(["Cancel"]);
    expect(res.dialogs[0].unattended.note).toMatch(/only be cancelled unattended/);
  });

  it("lists the single OK of a one-button painted dialog as answerable", () => {
    expect(unattendedAnswers([{ name: "0K", automationId: "", enabled: true }]).answerable).toEqual(["OK"]);
  });

  // ae-dialogs.ps1 (Get-NormalizedLabel): lower-case, 0 read as o, anything but letters and spaces dropped;
  // Cancel/No/Close go out as Escape (No and Close only when no Cancel is on the row); OK/Yes/Continue go out as Enter only when it is the default button (outlined, or the lone button).
  const btn = (name: string) => ({ name, automationId: "", enabled: true });

  it("a lone Cancel, No or Close is answered with Escape, not Enter", () => {
    for (const name of ["Cancel", "No", "Close"]) {
      const u = unattendedAnswers([btn(name)]);
      expect(u.answerable).toEqual([name]);
      expect(u.note).toMatch(/Escape/);
      expect(u.note).not.toMatch(/Enter/);
    }
  });

  it("a lone OK or Yes is answered with Enter", () => {
    expect(unattendedAnswers([btn("Yes")]).note).toMatch(/Enter/);
    expect(unattendedAnswers([btn("OK")]).note).toMatch(/Enter/);
  });

  it("reads labels the way the PowerShell does: 0 is o, punctuation is dropped", () => {
    expect(unattendedAnswers([btn("N0")]).answerable).toEqual(["N0"]);
    expect(unattendedAnswers([btn("Cl0se")]).answerable).toEqual(["Cl0se"]);
    expect(unattendedAnswers([btn("OK"), btn("C4ncel")]).answerable).toEqual([]);
    expect(unattendedAnswers([btn("OK"), btn("C0ncel")]).answerable).toEqual([]);
    expect(unattendedAnswers([btn("[Cancel]"), btn("OK")]).answerable).toEqual(["[Cancel]"]);
    expect(unattendedAnswers([btn("Y0u")]).answerable).toEqual([]);
  });

  it("the timeout note names the button OK, not 0K", async () => {
    useDialogs([ocrDialog(["0K", "Cancel"])]);
    const blocking: any[] = await describeBlockingDialogs();
    expect(blocking[0].buttons.map((b: any) => b.name)).toEqual(["OK", "Cancel"]);
  });

  it("normalizeOcrLabel changes only the OK misread", () => {
    expect(normalizeOcrLabel("0K")).toBe("OK");
    expect(normalizeOcrLabel("0k")).toBe("OK");
    expect(normalizeOcrLabel("Cancel")).toBe("Cancel");
    expect(normalizeOcrLabel("100")).toBe("100");
  });
});

describe("ae_dialog_respond on an AE-painted two-button dialog", () => {
  it("returns an honest message with the answerable buttons when OK cannot be pressed", async () => {
    useDialogs([ocrDialog(["0K", "Cancel"])], {
      ok: false,
      error: "button_not_answerable",
      ocr_buttons: ["0K", "Cancel"],
      hint: "AE-painted dialog: only Escape ...",
    });
    // The dialog is listed first so that it counts as caused by our operation.
    await dtool("ae_dialogs").handler({ screenshots: false }, noCtx);
    const res: any = await dtool("ae_dialog_respond").handler(
      { handle: 4242, button: "OK", reason: "test", user_instruction: "Jay: answer the font dialog" },
      noCtx
    );
    expect(res).toMatchObject({ ok: false, error: "button_not_answerable", ocr_buttons: ["OK", "Cancel"] });
    expect(res.unattended.answerable).toEqual(["Cancel"]);
    expect(res.message).toMatch(/NOT pressed/);
    expect(res.message).toMatch(/only be cancelled unattended/);
  });

  it("says so in the description", () => {
    // Wording changed with the default-button work: the default (outlined) button or Cancel, not "the only button".
    const d = dtool("ae_dialog_respond").description;
    expect(d).toMatch(/DEFAULT button/);
    expect(d).toMatch(/button_not_default/);
    expect(d).toMatch(/dialog_changed/);
    expect(dtool("ae_dialogs").description).toMatch(/0K is corrected to OK/);
  });
});

