/**
 * ae_snapshot_frame `save_to`: full-resolution PNGs of chosen frames, copied into a folder the caller names.
 * The renders go through captureCompFrame (the stale-frame guard and its one retry); this file holds the
 * pure checks (folder, names, frames) and the copy. Nothing here touches After Effects.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_SAVE_FRAMES = 50;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A comp name as a file name part: no path separators or characters Windows refuses, no reserved device names, at most 80 characters. */
export function sanitizeCompName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let out = String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
  out = out.replace(/[. ]+$/, "").slice(0, 80).replace(/[. ]+$/, "");
  if (out === "" || /^\.+$/.test(out)) out = "comp";
  if (RESERVED.test(out)) out = `_${out}`;
  return out;
}

/** `<comp name>_<frame>.png`, the frame zero-padded to at least 4 digits (more for a comp with more frames). */
export function savedFrameName(compName: string, frame: number, lastFrame: number): string {
  const width = Math.max(4, String(Math.max(0, lastFrame)).length);
  return `${sanitizeCompName(compName)}_${String(frame).padStart(width, "0")}.png`;
}

export interface SaveFolderProblem {
  code: "folder_not_absolute" | "folder_missing" | "folder_not_a_folder";
  message: string;
}

/** The folder must be absolute and already exist: it is never created. */
export function checkSaveFolder(folder: string): SaveFolderProblem | null {
  if (!path.isAbsolute(folder)) {
    return { code: "folder_not_absolute", message: `save_to.folder must be an absolute path, got "${folder}". Nothing was rendered.` };
  }
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(folder);
  } catch {
    st = null;
  }
  if (!st) return { code: "folder_missing", message: `The folder ${folder} does not exist. It is not created for you: make it first. Nothing was rendered.` };
  if (!st.isDirectory()) return { code: "folder_not_a_folder", message: `${folder} is not a folder. Nothing was rendered.` };
  return null;
}

export interface FramePick {
  /** Frame number counted from the comp's first frame (0). */
  frame: number;
  /** Seconds, frame / fps. */
  time: number;
}

export interface FramePlan {
  picks: FramePick[];
  problem?: { code: "frames_out_of_range" | "no_frames"; message: string };
}

/** Turns `frames` or `times` into unique frame numbers (the first mention wins, order kept), all inside the comp. */
export function planFrames(input: { frames?: number[]; times?: number[] }, fps: number, duration: number): FramePlan {
  const total = Math.max(1, Math.round(duration * fps));
  const seen = new Set<number>();
  const picks: FramePick[] = [];
  const bad: string[] = [];
  const list = input.frames ?? input.times ?? [];
  for (const v of list) {
    const frame = input.frames ? v : Math.round(v * fps);
    if (!Number.isInteger(frame) || frame < 0 || frame >= total) {
      bad.push(input.frames ? `frame ${v}` : `time ${v}s`);
      continue;
    }
    if (seen.has(frame)) continue;
    seen.add(frame);
    picks.push({ frame, time: frame / fps });
  }
  if (bad.length > 0) {
    return {
      picks: [],
      problem: {
        code: "frames_out_of_range",
        message: `The comp has frames 0 to ${total - 1} (${fps} fps, ${duration}s); outside it: ${bad.slice(0, 10).join(", ")}${bad.length > 10 ? ", ..." : ""}. Nothing was rendered.`,
      },
    };
  }
  if (picks.length === 0) return { picks, problem: { code: "no_frames", message: "No frames to save. Nothing was rendered." } };
  return { picks };
}

export interface SavedFrame {
  path: string;
  bytes: number;
  frame: number;
  time: number;
}

/** Copies the rendered PNG to `dest` and removes the temporary one. Without `overwrite` an existing file is never replaced. */
export function moveRenderedFrame(src: string, dest: string, overwrite: boolean): number {
  fs.copyFileSync(src, dest, overwrite ? 0 : fs.constants.COPYFILE_EXCL);
  const bytes = fs.statSync(dest).size;
  try {
    fs.unlinkSync(src);
  } catch {
    // the copy is what matters; a leftover in the frames folder is harmless
  }
  return bytes;
}
