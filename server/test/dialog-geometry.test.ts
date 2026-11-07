import { describe, expect, it } from "vitest";
import {
  analysePaintedDialog,
  findRings,
  otherPillOnRow,
  type OcrLine,
  type PngPixels,
} from "../src/tools/ext/dialog-geometry.js";
import { H, line, makeImage, TALL_BODY, W, word, type Pill } from "./support/dialog-fixtures.js";

/** The way ae-dialogs.ps1 Get-OcrButtons decided before (1-3 words, at most 24 characters, in the lower 45 percent). */
function legacyButtons(lines: OcrLine[], height: number): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.words.length < 1 || l.words.length > 3) continue;
    const t = l.text.trim();
    if (t.length < 1 || t.length > 24) continue;
    const y1 = Math.min(...l.words.map((w) => w.y));
    if (y1 < height * 0.55) continue;
    out.push(t);
  }
  return out;
}

describe("analysePaintedDialog", () => {
  it("a wrapped body line above a lone OK is body text: exactly one button, OK (the old rule read two)", () => {
    const lines = [...TALL_BODY, line(word("OK", 300, 250, 22))];
    // The old rule: "preferences." (y 200 of 300) and "OK" both qualify.
    expect(legacyButtons(lines, H)).toEqual(["preferences.", "OK"]);

    const png = makeImage([{ cx: 311, cy: 257, w: 70, ring: true }]);
    const res = analysePaintedDialog(lines, png);
    expect(res.buttons.map((b) => b.name)).toEqual(["OK"]);
    expect(res.default_index).toBe(0);
    expect(res.default_source).toBe("ring");
    expect(res.buttons[0].default).toBe(true);
    expect(res.body_text.split("\n").pop()).toBe("preferences.");
  });

  it("a lone label with no ring is its own default only when the screenshot shows no other pill on the row", () => {
    const lines = [...TALL_BODY, line(word("OK", 300, 250, 22))];
    const alone = analysePaintedDialog(lines, makeImage([{ cx: 311, cy: 257, w: 70 }]));
    expect(alone.buttons.map((b) => b.name)).toEqual(["OK"]);
    expect(alone.default_source).toBe("only_button");
    expect(alone.default_index).toBe(0);
    expect(alone.buttons[0].default).toBe(true);

    // another pill OCR did not read sits on the same row: the lone label proves nothing
    const withUnread = analysePaintedDialog(lines, makeImage([{ cx: 311, cy: 257, w: 70 }, { cx: 400, cy: 257, w: 80 }]));
    expect(withUnread.buttons.map((b) => b.name)).toEqual(["OK"]);
    expect(withUnread.default_index).toBeNull();
    expect(withUnread.default_source).toBeNull();
    expect(withUnread.buttons[0].default).toBe(false);

    // no screenshot: cannot be confirmed, unknown
    const noPng = analysePaintedDialog(lines, null, { width: W, height: H });
    expect(noPng.buttons.map((b) => b.name)).toEqual(["OK"]);
    expect(noPng.default_index).toBeNull();
    expect(noPng.default_source).toBeNull();
  });

  it("a ring on no read label proves an unread default: the lone read label is NOT the default", () => {
    const lines = [...TALL_BODY, line(word("Cancel", 380, 250, 44))];
    // the ring is on a pill whose label OCR did not read (left of Cancel)
    const png = makeImage([{ cx: 311, cy: 257, w: 70, ring: true }, { cx: 400, cy: 257, w: 80 }]);
    expect(findRings(png)).toHaveLength(1);
    const res = analysePaintedDialog(lines, png);
    expect(res.buttons.map((b) => b.name)).toEqual(["Cancel"]);
    expect(res.default_index).toBeNull();
    expect(res.default_source).toBeNull();
    expect(res.buttons[0].default).toBe(false);
  });

  it("a button-shaped ring elsewhere in the picture still means the default is unread, even with no other pill on the label's row", () => {
    const lines = [...TALL_BODY, line(word("OK", 300, 250, 22))];
    const png = makeImage([{ cx: 311, cy: 257, w: 70 }], { rects: [{ x1: 60, y1: 100, x2: 135, y2: 139, t: 2 }] });
    expect(findRings(png)).toHaveLength(1);
    const res = analysePaintedDialog(lines, png);
    expect(res.buttons.map((b) => b.name)).toEqual(["OK"]);
    expect(res.default_index).toBeNull();
    expect(res.default_source).toBeNull();
  });

  it("several ring-coloured outlines are unknown even for a lone label, and findRings tells none from several", () => {
    const lines = [...TALL_BODY, line(word("OK", 300, 250, 22))];
    const png = makeImage([{ cx: 311, cy: 257, w: 70, ring: true }, { cx: 400, cy: 257, w: 80, ring: true }]);
    expect(findRings(png)).toHaveLength(2);
    expect(findRings(makeImage([{ cx: 311, cy: 257, w: 70 }]))).toHaveLength(0);
    const res = analysePaintedDialog(lines, png);
    expect(res.default_index).toBeNull();
  });

  it("otherPillOnRow ignores the label's own pill and sees anything else on the row", () => {
    const label = { x1: 300, y1: 250, x2: 322, y2: 264 };
    expect(otherPillOnRow(makeImage([{ cx: 311, cy: 257, w: 70, ring: true }]), label, 14)).toBe(false);
    expect(otherPillOnRow(makeImage([{ cx: 311, cy: 257, w: 70 }, { cx: 420, cy: 257, w: 60 }]), label, 14)).toBe(true);
  });

  it("OK and Cancel: the ring decides which one is the default; no ring means unknown", () => {
    const lines = [...TALL_BODY.slice(0, 3), line(word("OK", 300, 250, 22)), line(word("Cancel", 380, 250, 44))];
    const okPill = { cx: 311, cy: 257, w: 70 };
    const cancelPill = { cx: 400, cy: 257, w: 80 };

    const onOk = analysePaintedDialog(lines, makeImage([{ ...okPill, ring: true }, cancelPill]));
    expect(onOk.buttons.map((b) => b.name)).toEqual(["OK", "Cancel"]);
    expect(onOk.default_index).toBe(0);
    expect(onOk.default_source).toBe("ring");

    const onCancel = analysePaintedDialog(lines, makeImage([okPill, { ...cancelPill, ring: true }]));
    expect(onCancel.buttons.map((b) => b.name)).toEqual(["OK", "Cancel"]);
    expect(onCancel.default_index).toBe(1);
    expect(onCancel.buttons[1].default).toBe(true);
    expect(onCancel.buttons[0].default).toBeUndefined();

    const none = analysePaintedDialog(lines, makeImage([okPill, cancelPill]));
    expect(none.buttons).toHaveLength(2);
    expect(none.default_index).toBeNull();
    expect(none.default_source).toBeNull();

    const noPng = analysePaintedDialog(lines, null, { width: W, height: H });
    expect(noPng.buttons).toHaveLength(2);
    expect(noPng.default_index).toBeNull();
  });

  it("Save, Don't Save and Cancel read as one OCR line are split into three buttons", () => {
    const merged = line(
      word("Save", 117, 250, 26),
      word("Don't", 207, 250, 30),
      word("Save", 240, 250, 26),
      word("Cancel", 330, 250, 40)
    );
    const lines = [line(word("Save", 40, 120, 30), word("changes", 74, 120, 56), word("before", 134, 120, 44), word("closing?", 182, 120, 56)), merged];
    const png = makeImage([
      { cx: 130, cy: 257, w: 70, ring: true },
      { cx: 235, cy: 257, w: 90 },
      { cx: 350, cy: 257, w: 80 },
    ]);
    const res = analysePaintedDialog(lines, png);
    expect(res.buttons.map((b) => b.name)).toEqual(["Save", "Don't Save", "Cancel"]);
    expect(res.default_index).toBe(0);
    expect(res.body_text).toBe("Save changes before closing?");
  });

  it("a body line at the left margin as the bottom-most row gives no buttons (margin rule, with and without a screenshot)", () => {
    const withPng = analysePaintedDialog(TALL_BODY, makeImage([]));
    expect(withPng.buttons).toEqual([]);
    expect(withPng.default_index).toBeNull();
    const noPng = analysePaintedDialog(TALL_BODY, null, { width: W, height: H });
    expect(noPng.buttons).toEqual([]);
    expect(noPng.body_text).toContain("preferences.");
    expect(noPng.body_text).toContain("After Effects");
  });

  it("a short label low in the dialog but away from the margin is a button only when pill borders are in the picture (the pill check)", () => {
    const lines = [...TALL_BODY.slice(0, 3), line(word("Done", 200, 250, 36))];
    // no screenshot: the margin and size rules pass, so it is accepted
    expect(analysePaintedDialog(lines, null, { width: W, height: H }).buttons.map((b) => b.name)).toEqual(["Done"]);
    // a screenshot without any pill around it: dropped
    const flat = analysePaintedDialog(lines, makeImage([]));
    expect(flat.buttons).toEqual([]);
    expect(flat.body_text).toContain("Done");
    // a pill on one side only: dropped
    const lopsided = analysePaintedDialog(lines, makeImage([], { rects: [{ x1: 170, y1: 240, x2: 172, y2: 274, t: 2, rgb: [135, 135, 135] }] }));
    expect(lopsided.buttons).toEqual([]);
    // pills on both sides: accepted
    expect(analysePaintedDialog(lines, makeImage([{ cx: 218, cy: 257, w: 76 }])).buttons.map((b) => b.name)).toEqual(["Done"]);
  });

  it("a row that is not in the lower part of the window is not a button row", () => {
    const lines = [line(word("OK", 300, 60, 22))];
    const res = analysePaintedDialog(lines, null, { width: W, height: H });
    expect(res.buttons).toEqual([]);
  });

  it("a label of more than three words or 24 characters is not a button", () => {
    const four = analysePaintedDialog([...TALL_BODY.slice(0, 2), line(word("Click", 300, 250, 30), word("to", 335, 250, 12), word("go", 352, 250, 14), word("on", 370, 250, 14))], null, { width: W, height: H });
    expect(four.buttons).toEqual([]);
    const long = analysePaintedDialog([...TALL_BODY.slice(0, 2), line(word("Averyveryverylongbuttonlabel", 250, 250, 200))], null, { width: W, height: H });
    expect(long.buttons).toEqual([]);
  });

  it("the light band on top, a 0K misread and a blue progress bar do not matter; two ring-coloured outlines give no default", () => {
    const lines = [...TALL_BODY.slice(0, 3), line(word("0K", 300, 250, 22)), line(word("Cancel", 380, 250, 44))];
    const pills: Pill[] = [
      { cx: 311, cy: 257, w: 70, ring: true },
      { cx: 400, cy: 257, w: 80, ring: true },
    ];
    const two = analysePaintedDialog(lines, makeImage(pills, { bar: true }));
    expect(two.buttons.map((b) => b.name)).toEqual(["0K", "Cancel"]); // the label is passed on unchanged; dialogs.ts corrects 0K
    expect(two.default_index).toBeNull();
    expect(two.default_source).toBeNull();

    const one = makeImage([{ cx: 311, cy: 257, w: 70, ring: true }, { cx: 400, cy: 257, w: 80 }], { bar: true });
    expect(findRings(one)).toHaveLength(1);
    expect(analysePaintedDialog(lines, one).default_index).toBe(0);
  });

  it("empty or broken OCR gives nothing, not an error", () => {
    expect(analysePaintedDialog([], null)).toEqual({ buttons: [], default_index: null, default_source: null, body_text: "" });
    const odd = analysePaintedDialog([{ text: "x", words: [] }, { text: "y", words: [{ text: "", x: 1, y: 2, w: 3, h: 4 }] }] as OcrLine[], null);
    expect(odd.buttons).toEqual([]);
  });
});

// ---------- ring limits (findRings) ----------

describe("findRings limits", () => {
  const ring = (w: number, h: number, t = 2) => makeImage([], { rects: [{ x1: 100, y1: 100, x2: 100 + w - 1, y2: 100 + h - 1, t }] });

  it("accepts a button-shaped outline", () => {
    expect(findRings(ring(76, 40))).toHaveLength(1);
  });
  it("rejects an outline with too few pixels", () => {
    expect(findRings(ring(40, 25, 1))).toHaveLength(0); // 1 px thick, about 126 pixels, aspect 1.6, height 25: only the count fails
  });
  it("rejects aspect ratios below 1.5 and above 6", () => {
    expect(findRings(ring(40, 30))).toHaveLength(0); // 1.33
    expect(findRings(ring(200, 30))).toHaveLength(0); // 6.7
  });
  it("rejects heights below 22 and above 70", () => {
    expect(findRings(ring(70, 20))).toHaveLength(0);
    expect(findRings(ring(150, 75))).toHaveLength(0); // aspect 2.0, height 75
  });
  it("the progress-bar blue is not a ring", () => {
    expect(findRings(makeImage([], { bar: true }))).toHaveLength(0);
  });
  it("scales its pixel limits with the display: the 152x80 ring of a 250 % capture is found only at scale 2.5", () => {
    // Measured live on PRISM (AE 26.3, 240 dpi): the lone OK's ring was 152x80, 5 px thick.
    const big = makeImage([], { width: 1222, height: 684, rects: [{ x1: 984, y1: 518, x2: 1135, y2: 597, t: 5 }] });
    expect(findRings(big)).toHaveLength(0);
    expect(findRings(big, 2.5)).toHaveLength(1);
    // and a 100 % ring is not lost at scale 1
    expect(findRings(ring(76, 40), 1)).toHaveLength(1);
  });
});

describe("otherPillOnRow and the window edge", () => {
  it("the near-black resize border at each edge of the capture is not another pill", () => {
    const png = makeImage([{ cx: 311, cy: 257, w: 70 }]);
    const label = { x1: 300, y1: 250, x2: 322, y2: 264 };
    expect(otherPillOnRow(png, label, 14)).toBe(false);
    // paint a 7 px near-black frame on both sides, as a capture of the whole window rect can show
    for (let y = 0; y < png.height; y++) {
      for (const x of [0, 1, 2, 3, 4, 5, 6, png.width - 7, png.width - 6, png.width - 5, png.width - 4, png.width - 3, png.width - 2, png.width - 1]) {
        const i = (y * png.width + x) * 4;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = 0;
      }
    }
    expect(otherPillOnRow(png, label, 14)).toBe(false);
  });
});

describe("analysePaintedDialog at a scaled display", () => {
  it("a lone OK at 250 %: default by its ring with scale 2.5, unknown at scale 1", () => {
    const lines = [
      line(word("After", 100, 170, 90, 35), word("Effects", 200, 170, 130, 35)),
      line(word("After", 100, 285, 70, 30), word("warning:", 180, 285, 120, 30), word("missing", 310, 285, 120, 30)),
      line(word("1021).", 100, 330, 80, 30), word("preferences.", 190, 330, 160, 30)),
      line(word("0K", 1039, 549, 39, 21)),
    ];
    const png = makeImage([], { width: 1222, height: 684, rects: [{ x1: 984, y1: 518, x2: 1135, y2: 597, t: 5 }, { x1: 996, y1: 526, x2: 1123, y2: 589, t: 3, rgb: [200, 200, 200] }] });
    const at1 = analysePaintedDialog(lines, png, { width: 1222, height: 684 });
    expect(at1.default_index).toBeNull();
    const at25 = analysePaintedDialog(lines, png, { width: 1222, height: 684, scale: 2.5 });
    expect(at25.buttons.map((b) => b.name)).toEqual(["0K"]);
    expect(at25.default_source).toBe("ring");
    expect(at25.buttons[0].default).toBe(true);
    expect(at25.other_pill_unread).toBe(false);
  });
});

// ---------- synthetic reproductions of the layouts measured on real AE 26 screenshots ----------
// (dark UI, 38 px light band on top; the ring is 76x40 around the default button; sizes of the measured pictures)

describe("layouts measured on real dialogs (synthetic reproductions)", () => {
  it("613x453, two buttons: the ring is exactly the OK button, the wrapped last body line is not a button", () => {
    const png = makeImage(
      [
        { cx: 448, cy: 388, w: 70, ring: true },
        { cx: 528, cy: 388, w: 70 },
      ],
      { width: 613, height: 453 }
    );
    expect(findRings(png)).toHaveLength(1);
    const box = findRings(png)[0];
    expect(box).toEqual({ x1: 410, y1: 368, x2: 486, y2: 408 });
    const lines: OcrLine[] = [
      line(word("not", 49, 258, 24), word("available", 78, 258, 70), word("from", 152, 258, 36), word("Adobe.", 192, 258, 52)),
      line(word("Click", 49, 296, 30), word("OK", 82, 296, 20), word("to", 106, 296, 14), word("continue.", 124, 296, 60)),
      line(word("OK", 438, 381, 20)),
      line(word("Cancel", 506, 381, 42)),
    ];
    const res = analysePaintedDialog(lines, png);
    expect(res.buttons.map((b) => b.name)).toEqual(["OK", "Cancel"]);
    expect(res.default_index).toBe(0);
    expect(res.default_source).toBe("ring");
  });

  it("478x298, three buttons where OCR read only the default's label: that one button, default by ring, the rest unread", () => {
    const png = makeImage(
      [
        { cx: 205, cy: 234, w: 70, ring: true },
        { cx: 297, cy: 234, w: 96 },
        { cx: 392, cy: 234, w: 72 },
      ],
      { width: 478, height: 298 }
    );
    const lines: OcrLine[] = [line(word("Save", 49, 146, 30), word("changes", 84, 146, 56)), line(word("Save", 191, 227, 30))];
    const res = analysePaintedDialog(lines, png);
    expect(res.buttons.map((b) => b.name)).toEqual(["Save"]);
    expect(res.default_source).toBe("ring");
    expect(res.default_index).toBe(0);
  });

  it("the same dialog with every label read gives three buttons", () => {
    const png = makeImage(
      [
        { cx: 205, cy: 234, w: 70, ring: true },
        { cx: 297, cy: 234, w: 96 },
        { cx: 392, cy: 234, w: 72 },
      ],
      { width: 478, height: 298 }
    );
    const lines: OcrLine[] = [
      line(word("Save", 49, 146, 30), word("changes", 84, 146, 56)),
      line(word("Save", 191, 227, 30), word("Don't", 265, 227, 32), word("Save", 301, 227, 30), word("Cancel", 372, 227, 42)),
    ];
    const res = analysePaintedDialog(lines, png);
    expect(res.buttons.map((b) => b.name)).toEqual(["Save", "Don't Save", "Cancel"]);
    expect(res.default_index).toBe(0);
  });
});
