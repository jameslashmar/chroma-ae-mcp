/**
 * Reads the button row and the default button of a dialog that After Effects painted itself
 * (UI Automation sees nothing in it), from OCR word boxes and, when there is one, the screenshot.
 *
 * Pure: no files, no processes. The caller decodes the PNG (pngjs) and passes the pixels.
 * All coordinates are pixels of the unscaled screenshot (the OCR boxes are divided by their upscale
 * factor in ae-dialogs.ps1).
 *
 * Every threshold is a named constant. They were calibrated on two screenshots of AE 26 (a two-button
 * dialog and a three-button dialog, dark UI) and are guesses elsewhere: when a signal is missing the
 * answer is "unknown" (no default, no buttons), never a guessed button.
 */

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLine {
  text: string;
  words: OcrWord[];
}

export interface PaintedButton {
  name: string;
  /** The label's box in the screenshot. */
  x: number;
  y: number;
  w: number;
  h: number;
  default?: boolean;
}

export interface PaintedAnalysis {
  buttons: PaintedButton[];
  default_index: number | null;
  /** "ring": the outlined default button was found; "only_button": one button read and the row shows no other pill; null: unknown. */
  default_source: "ring" | "only_button" | null;
  /** The OCR text above the button row (the whole text when no button row was accepted). */
  body_text: string;
  /** One button was read and the row shows another pill (or label) that OCR did not read: the dialog has more buttons than listed. */
  other_pill_unread?: boolean;
}

export interface PngPixels {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

/** Lines whose vertical centre is this close (times the bottom line's height) to the bottom line's centre are the button row. */
export const ROW_TOLERANCE = 0.6;
/** Words in one row further apart than this many word heights belong to different buttons. */
export const BUTTON_GAP_FACTOR = 2;
/** The button row's centre must be at or below this fraction of the window height. */
export const ROW_MIN_CENTER_FRACTION = 0.6;
export const MAX_LABEL_WORDS = 3;
export const MAX_LABEL_CHARS = 24;
/** A lone candidate this close (px) to the body's left margin is a body line, not a button. */
export const BODY_MARGIN_TOLERANCE = 8;
/** The pill border is looked for this many word heights left and right of the label. */
export const OUTLINE_NEAR_FACTOR = 0.8;
export const OUTLINE_FAR_FACTOR = 2.2;
/** Smallest brightness difference (0-255) between the border or fill and the dialog background. A disabled button measured 19. */
export const OUTLINE_MIN_CONTRAST = 15;
/** The default button's ring colour (AE 26, dark UI) and the tolerance per channel. */
export const RING_RGB: readonly [number, number, number] = [64, 150, 243];
export const RING_TOLERANCE = 14;
export const RING_MIN_PIXELS = 150;
/** Extra pixels beyond the label's border reach that still belong to its own pill (the ring sits 3 px outside it). */
export const OWN_PILL_SLACK = 6;
export const RING_MIN_ASPECT = 1.5;
export const RING_MAX_ASPECT = 6;
export const RING_MIN_HEIGHT = 22;
export const RING_MAX_HEIGHT = 70;

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface LineInfo {
  line: OcrLine;
  words: OcrWord[];
  box: Box;
  cy: number;
  h: number;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function usableWords(line: OcrLine): OcrWord[] {
  const words = Array.isArray(line?.words) ? line.words : [];
  return words.filter(
    (w) => w && typeof w.text === "string" && w.text.trim().length > 0 && finite(w.x) && finite(w.y) && finite(w.w) && finite(w.h)
  );
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function infoOf(line: OcrLine): LineInfo | null {
  const words = usableWords(line);
  if (words.length === 0) return null;
  const x1 = Math.min(...words.map((w) => w.x));
  const y1 = Math.min(...words.map((w) => w.y));
  const x2 = Math.max(...words.map((w) => w.x + w.w));
  const y2 = Math.max(...words.map((w) => w.y + w.h));
  return { line, words, box: { x1, y1, x2, y2 }, cy: (y1 + y2) / 2, h: Math.max(1, y2 - y1) };
}

function lum(png: PngPixels, x: number, y: number): number {
  const i = (y * png.width + x) * 4;
  return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
}

/** True when the pixels in the strip [xa, xb] at the label's mid-height are not flat: a pill border or fill sits there. */
function stripHasEdge(png: PngPixels, xa: number, xb: number, y: number): boolean {
  const lo = Math.max(0, Math.floor(Math.min(xa, xb)));
  const hi = Math.min(png.width - 1, Math.ceil(Math.max(xa, xb)));
  if (hi - lo < 2 || y < 0 || y >= png.height) return false;
  let min = 255;
  let max = 0;
  for (let x = lo; x <= hi; x++) {
    const l = lum(png, x, Math.round(y));
    if (l < min) min = l;
    if (l > max) max = l;
  }
  return max - min >= OUTLINE_MIN_CONTRAST;
}

function hasPillBorders(png: PngPixels, label: Box, wordHeight: number): boolean {
  const y = (label.y1 + label.y2) / 2;
  const near = OUTLINE_NEAR_FACTOR * wordHeight;
  const far = OUTLINE_FAR_FACTOR * wordHeight;
  const left = stripHasEdge(png, label.x1 - far, label.x1 - near, y);
  const right = stripHasEdge(png, label.x2 + near, label.x2 + far, y);
  return left && right;
}

function nearRing(r: number, g: number, b: number): boolean {
  return (
    Math.abs(r - RING_RGB[0]) <= RING_TOLERANCE &&
    Math.abs(g - RING_RGB[1]) <= RING_TOLERANCE &&
    Math.abs(b - RING_RGB[2]) <= RING_TOLERANCE
  );
}

/** Every connected ring-coloured cluster that looks like a button's outline (none, one or several). */
export function findRings(png: PngPixels, scale = 1): Box[] {
  const { width, height, data } = png;
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    if (nearRing(data[i], data[i + 1], data[i + 2])) mask[p] = 1;
  }
  const seen = new Uint8Array(width * height);
  const found: Box[] = [];
  const stack: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (!mask[start] || seen[start]) continue;
    let count = 0;
    let x1 = width;
    let y1 = height;
    let x2 = -1;
    let y2 = -1;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop() as number;
      const px = p % width;
      const py = (p - px) / width;
      count++;
      if (px < x1) x1 = px;
      if (px > x2) x2 = px;
      if (py < y1) y1 = py;
      if (py > y2) y2 = py;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    const w = x2 - x1 + 1;
    const h = y2 - y1 + 1;
    const aspect = w / h;
    // The pixel limits are for 100 % display scaling; the capture is in physical pixels, so they grow with it.
    if (count >= RING_MIN_PIXELS * scale && aspect >= RING_MIN_ASPECT && aspect <= RING_MAX_ASPECT && h >= RING_MIN_HEIGHT * scale && h <= RING_MAX_HEIGHT * scale) {
      found.push({ x1, y1, x2, y2 });
    }
  }
  return found;
}

/**
 * True when the row at the label's mid-height shows something besides this label and its own pill: another
 * pill or label that OCR did not read. The columns within the label's pill reach are ignored.
 */
export function otherPillOnRow(png: PngPixels, label: Box, wordHeight: number, scale = 1): boolean {
  const y = Math.round((label.y1 + label.y2) / 2);
  if (y < 0 || y >= png.height) return true;
  const values: number[] = [];
  const hist = new Map<number, number>();
  for (let x = 0; x < png.width; x++) {
    const l = Math.round(lum(png, x, y));
    values.push(l);
    hist.set(l, (hist.get(l) ?? 0) + 1);
  }
  let bg = values[0];
  let best = -1;
  hist.forEach((n, l) => {
    if (n > best) {
      best = n;
      bg = l;
    }
  });
  const reach = OUTLINE_FAR_FACTOR * wordHeight + OWN_PILL_SLACK * scale;
  const from = label.x1 - reach;
  const to = label.x2 + reach;
  // Skip the window's own edge: the capture can include the near-black resize border Windows draws outside
  // the dialog (about 7 px at 100 %), which is not a pill. Only a short run at each edge is trimmed.
  const edgeMax = Math.max(2, Math.round(0.05 * png.width));
  let left = 2;
  while (left < edgeMax && Math.abs(values[left] - bg) >= OUTLINE_MIN_CONTRAST) left++;
  let right = png.width - 3;
  while (right > png.width - 1 - edgeMax && Math.abs(values[right] - bg) >= OUTLINE_MIN_CONTRAST) right--;
  for (let x = left; x <= right; x++) {
    if (x >= from && x <= to) continue;
    if (Math.abs(values[x] - bg) >= OUTLINE_MIN_CONTRAST) return true;
  }
  return false;
}

function noButtons(infos: LineInfo[]): PaintedAnalysis {
  const body = infos
    .slice()
    .sort((a, b) => a.cy - b.cy)
    .map((i) => i.line.text.trim())
    .filter((t) => t.length > 0)
    .join("\n");
  return { buttons: [], default_index: null, default_source: null, body_text: body };
}

/**
 * Finds the button row of an AE-painted dialog and the default button.
 *
 * The button row is the bottom-most OCR row and nothing else: a wrapped body line such as
 * "preferences." above a lone OK is body text however short and however low it sits.
 * `size` is the window size, used when there is no screenshot.
 */
export function analysePaintedDialog(
  lines: OcrLine[],
  png: PngPixels | null,
  size?: { width: number; height: number; scale?: number }
): PaintedAnalysis {
  const scale = size && finite(size.scale) && size.scale >= 1 && size.scale <= 5 ? size.scale : 1;
  const infos: LineInfo[] = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const info = infoOf(l);
    if (info) infos.push(info);
  }
  if (infos.length === 0) return { buttons: [], default_index: null, default_source: null, body_text: "" };

  const height = png ? png.height : size && finite(size.height) && size.height > 0 ? size.height : Math.max(...infos.map((i) => i.box.y2));

  // 1. The bottom-most row.
  let ref = infos[0];
  for (const i of infos) if (i.cy > ref.cy) ref = i;
  const rowInfos = infos.filter((i) => Math.abs(i.cy - ref.cy) <= ROW_TOLERANCE * ref.h);
  const bodyInfos = infos.filter((i) => rowInfos.indexOf(i) === -1);

  const rowWords: OcrWord[] = [];
  for (const i of rowInfos) for (const w of i.words) rowWords.push(w);
  rowWords.sort((a, b) => a.x - b.x);
  const wordHeight = median(rowWords.map((w) => w.h));
  const groups: OcrWord[][] = [];
  for (const w of rowWords) {
    const last = groups.length > 0 ? groups[groups.length - 1] : null;
    if (last) {
      const prev = last[last.length - 1];
      if (w.x - (prev.x + prev.w) <= BUTTON_GAP_FACTOR * wordHeight) {
        last.push(w);
        continue;
      }
    }
    groups.push([w]);
  }

  const candidates = groups.map((g) => {
    const x1 = Math.min(...g.map((w) => w.x));
    const y1 = Math.min(...g.map((w) => w.y));
    const x2 = Math.max(...g.map((w) => w.x + w.w));
    const y2 = Math.max(...g.map((w) => w.y + w.h));
    return { name: g.map((w) => w.text.trim()).join(" "), words: g.length, box: { x1, y1, x2, y2 } };
  });

  // 2. Plausibility.
  if (ref.cy < ROW_MIN_CENTER_FRACTION * height) return noButtons(infos);
  for (const c of candidates) {
    if (c.words < 1 || c.words > MAX_LABEL_WORDS || c.name.length < 1 || c.name.length > MAX_LABEL_CHARS) return noButtons(infos);
  }
  if (candidates.length < 2 && bodyInfos.length > 0) {
    const margin = median(bodyInfos.map((i) => Math.min(...i.words.map((w) => w.x))));
    if (Math.abs(candidates[0].box.x1 - margin) <= BODY_MARGIN_TOLERANCE * scale) return noButtons(infos);
  }

  // 3. The pill borders (second signal, needs the screenshot).
  if (png) {
    for (const c of candidates) {
      if (!hasPillBorders(png, c.box, wordHeight)) return noButtons(infos);
    }
  }

  const buttons: PaintedButton[] = candidates.map((c) => ({
    name: c.name,
    x: c.box.x1,
    y: c.box.y1,
    w: c.box.x2 - c.box.x1,
    h: c.box.y2 - c.box.y1,
  }));

  // 4. The default button. A ring on no read label proves a default that was not read, and several ring-coloured
  // outlines prove nothing: both leave the default unknown. A lone label is its own default only when the
  // screenshot is there, shows no ring, and the button row shows no other pill.
  let defaultIndex: number | null = null;
  let source: PaintedAnalysis["default_source"] = null;
  let ringCount = 0;
  if (png) {
    const rings = findRings(png, scale);
    ringCount = rings.length;
    if (rings.length === 1) {
      const ring = rings[0];
      const hits: number[] = [];
      buttons.forEach((b, idx) => {
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        if (cx >= ring.x1 && cx <= ring.x2 && cy >= ring.y1 && cy <= ring.y2) hits.push(idx);
      });
      if (hits.length === 1) {
        defaultIndex = hits[0];
        source = "ring";
      }
    }
  }
  // With one button read, does the row show another pill OCR missed? Computed for the ringed case too: a lone ringed OK is not
  // an unread Cancel.
  const otherPill = buttons.length === 1 && png ? otherPillOnRow(png, candidates[0].box, wordHeight, scale) : undefined;
  if (defaultIndex === null && buttons.length === 1 && png && ringCount === 0) {
    const c = candidates[0];
    if (!otherPill) {
      defaultIndex = 0;
      source = "only_button";
    }
  }
  if (defaultIndex !== null) buttons[defaultIndex].default = true;
  else if (buttons.length === 1) buttons[0].default = false;

  const body = bodyInfos
    .slice()
    .sort((a, b) => a.cy - b.cy)
    .map((i) => i.line.text.trim())
    .filter((t) => t.length > 0)
    .join("\n");
  return { buttons, default_index: defaultIndex, default_source: source, body_text: body, ...(otherPill !== undefined ? { other_pill_unread: otherPill } : {}) };
}
