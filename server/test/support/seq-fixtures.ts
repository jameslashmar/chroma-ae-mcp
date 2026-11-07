import * as fs from "node:fs";
import * as path from "node:path";
import { nodeSeqIo, seqscanDeps, type SeqIo } from "../../src/seqscan.js";

/** Writes A_beauty.0001.exr ... in `dir`, leaving out the frames in `skip`. Returns the first frame's path. */
export function makeSequence(dir: string, opts: { prefix?: string; from?: number; to?: number; skip?: number[]; ext?: string } = {}): string {
  const prefix = opts.prefix ?? "A_beauty.";
  const ext = opts.ext ?? "exr";
  fs.mkdirSync(dir, { recursive: true });
  let first = "";
  for (let n = opts.from ?? 1; n <= (opts.to ?? 20); n++) {
    if ((opts.skip ?? []).includes(n)) continue;
    const p = path.join(dir, `${prefix}${String(n).padStart(4, "0")}.${ext}`);
    fs.writeFileSync(p, "x");
    if (!first) first = p;
  }
  return first;
}

/** A project items page (what the host's preflightItems returns) with the given footage files. */
export function footagePage(files: Array<{ file: string; id?: number; name?: string; sequence?: boolean; missing?: boolean; used_n?: number }>) {
  return {
    offset: 0,
    total: files.length,
    next_offset: null,
    comps: [],
    folders: 0,
    footage: files.map((f, i) => ({
      id: f.id ?? i + 1,
      name: f.name ?? path.basename(f.file),
      kind: "footage",
      file: f.file,
      missing: f.missing === true,
      width: 1920,
      height: 1080,
      used_n: f.used_n ?? 1,
      used_in: [],
      proxy: null,
      sequence: f.sequence !== false,
    })),
  };
}

/** Makes every sequence check see old files (a fresh temp file would count as being written) and counts the reads. */
export function useOldFiles(ageS = 3600): { log: { readdir: string[]; stat: string[] }; restore: () => void } {
  const before = seqscanDeps.io;
  const log = { readdir: [] as string[], stat: [] as string[] };
  const io: SeqIo = {
    readdir: async (d, limit) => {
      log.readdir.push(d);
      return nodeSeqIo.readdir(d, limit);
    },
    stat: async (f) => {
      log.stat.push(f);
      const t = Date.now() - ageS * 1000;
      return { mtimeMs: t, ctimeMs: t, birthtimeMs: t };
    },
    now: () => Date.now(),
  };
  seqscanDeps.io = io;
  return {
    log,
    restore: () => {
      seqscanDeps.io = before;
    },
  };
}
