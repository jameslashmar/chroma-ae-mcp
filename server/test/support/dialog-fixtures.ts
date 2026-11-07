// Synthetic dialog pictures for the dialog tests: dark dialog, 38 px light band on top, grey pill outlines, a blue ring on the default button.
import type { OcrLine, OcrWord, PngPixels } from "../../src/tools/ext/dialog-geometry.js";

export interface Pill {
  cx: number;
  cy: number;
  w: number;
  ring?: boolean;
}

export const BG = 29;
export const BORDER = 135;
export const W = 480;
export const H = 300;

export function makeImage(pills: Pill[], opts: { width?: number; height?: number; bar?: boolean; rects?: Array<{ x1: number; y1: number; x2: number; y2: number; t: number; rgb?: [number, number, number] }> } = {}): PngPixels {
  const width = opts.width ?? W;
  const height = opts.height ?? H;
  const data = new Uint8Array(width * height * 4);
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < 38) put(x, y, 243, 243, 243);
      else put(x, y, BG, BG, BG);
    }
  }
  const rect = (x1: number, y1: number, x2: number, y2: number, t: number, r: number, g: number, b: number) => {
    for (let k = 0; k < t; k++) {
      for (let x = x1 + k; x <= x2 - k; x++) {
        put(x, y1 + k, r, g, b);
        put(x, y2 - k, r, g, b);
      }
      for (let y = y1 + k; y <= y2 - k; y++) {
        put(x1 + k, y, r, g, b);
        put(x2 - k, y, r, g, b);
      }
    }
  };
  for (const p of pills) {
    const x1 = p.cx - Math.round(p.w / 2);
    const x2 = x1 + p.w;
    rect(x1, p.cy - 17, x2, p.cy + 17, 2, BORDER, BORDER, BORDER);
    if (p.ring) rect(x1 - 3, p.cy - 20, x2 + 3, p.cy + 20, 2, 64, 150, 243);
  }
  for (const r of opts.rects ?? []) {
    const c = r.rgb ?? [64, 150, 243];
    rect(r.x1, r.y1, r.x2, r.y2, r.t, c[0], c[1], c[2]);
  }
  if (opts.bar) {
    // a progress bar in the same blue: wide and thin, never a button ring
    for (let y = 100; y < 106; y++) for (let x = 40; x < 400; x++) put(x, y, 64, 150, 243);
  }
  return { width, height, data };
}

export function word(text: string, x: number, y: number, w: number, h = 14): OcrWord {
  return { text, x, y, w, h };
}
export function line(...words: OcrWord[]): OcrLine {
  return { text: words.map((w) => w.text).join(" "), words };
}

/** The body of a tall dialog: its last line wraps and holds one short word at the left margin. */
export const TALL_BODY: OcrLine[] = [
  line(word("After", 40, 60, 40), word("Effects", 84, 60, 50)),
  line(word("Some", 40, 110, 34), word("footage", 78, 110, 52), word("is", 134, 110, 12), word("missing", 150, 110, 56), word("since", 210, 110, 36)),
  line(word("you", 40, 150, 24), word("last", 68, 150, 28), word("saved.", 100, 150, 44)),
  line(word("preferences.", 40, 200, 80)),
];

