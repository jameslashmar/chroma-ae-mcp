/**
 * Following a render the user started by hand in After Effects' Render Queue.
 *
 * ae_render_queue_status adds, for each item that is RENDERING or QUEUED (at most 20), the
 * state of its output files on disk: exists, bytes, mtime and grew_since_last_check (null on
 * the first call). The file part is Node-side (statOutput from rqrender.ts); the item list and
 * the named statuses come from AE (rqStatus plus rqeditRead, each with a short wait). When AE
 * does not answer in time (it may be busy rendering), the answer is built from the output
 * paths of the last successful read, with a note saying so. Memory only; nothing is written.
 */
import type { ToolContext } from "../common.js";
import type { QueueRead } from "./rqedit.js";
import { statOutput, type OutputStat } from "./rqrender.js";

export const MAX_FOLLOW_ITEMS = 20;
const MAX_FOLLOW_MODULES = 8;
/** How long each AE read may take before the file facts are answered from the last successful read. */
export const followDeps = { answerTimeoutMs: 6000, now: () => Date.now() };

export interface FollowOutput extends OutputStat {
  grew_since_last_check: boolean | null;
}

export interface FollowItem {
  index: number;
  comp_name?: string;
  status: string;
  outputs: FollowOutput[];
}

interface FollowSource {
  index: number;
  comp_name?: string;
  status: string;
  files: Array<{ module: number; file: string }>;
}

/** Sizes seen by the last status call and the item/output list of the last successful AE read. Memory only. */
export const followState: {
  lastSeen: Map<string, { bytes: number; at: number }>;
  lastRead: { at: number; sources: FollowSource[]; truncated: boolean } | null;
} = { lastSeen: new Map(), lastRead: null };

/** For tests: forget everything, as a service restart does. */
export function resetFollowState(): void {
  followState.lastSeen.clear();
  followState.lastRead = null;
}

/** The RENDERING and QUEUED items of a queue read, with their output files, bounded. */
export function followSources(read: QueueRead | null | undefined): { sources: FollowSource[]; truncated: boolean } {
  const sources: FollowSource[] = [];
  let truncated = false;
  for (const it of read?.items ?? []) {
    const status = (it.status ?? "").toLowerCase();
    if (status !== "rendering" && status !== "queued") continue;
    if (sources.length >= MAX_FOLLOW_ITEMS) {
      truncated = true;
      break;
    }
    const files: Array<{ module: number; file: string }> = [];
    for (const m of it.output_modules ?? []) {
      if (typeof m.file === "string" && m.file !== "" && files.length < MAX_FOLLOW_MODULES) files.push({ module: m.index, file: m.file });
    }
    sources.push({ index: it.index, ...(it.comp_name ? { comp_name: it.comp_name } : {}), status, files });
  }
  return { sources, truncated };
}

/** Stats the files of the sources now and compares with the sizes seen last time. */
export function statFollow(sources: FollowSource[], nowMs: number): FollowItem[] {
  return sources.map((s) => ({
    index: s.index,
    ...(s.comp_name ? { comp_name: s.comp_name } : {}),
    status: s.status,
    outputs: s.files.map((f) => {
      const st = statOutput({ item_index: s.index, module: f.module, file: f.file });
      const before = followState.lastSeen.get(f.file);
      followState.lastSeen.set(f.file, { bytes: st.bytes, at: nowMs });
      return { ...st, grew_since_last_check: before ? st.bytes > before.bytes : null };
    }),
  }));
}

/**
 * Adds `follow` to the answer of rqStatus. `status` is what the rqStatus read gave (or null when AE did not
 * answer). Never throws for a slow AE: with an earlier read it answers from that; without one it returns null
 * and the caller rethrows its own error.
 */
export async function followQueue(
  ctx: ToolContext,
  status: Record<string, unknown> | null,
  toolName: string
): Promise<{ follow: Record<string, unknown>; read_now: boolean } | null> {
  const nowMs = followDeps.now();
  let fresh: { sources: FollowSource[]; truncated: boolean } | null = null;
  let problem = "";
  if (status !== null) {
    const num = typeof status.numItems === "number" ? status.numItems : 0;
    if (num === 0) {
      fresh = { sources: [], truncated: false };
    } else {
      try {
        const res = await ctx.bridge.callHost<QueueRead>(
          "rqeditRead",
          {},
          { label: `${toolName} (follow)`, mutates: false, toolName, timeoutMs: followDeps.answerTimeoutMs }
        );
        fresh = followSources(res.result);
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
      }
    }
  }
  if (fresh) {
    followState.lastRead = { at: nowMs, sources: fresh.sources, truncated: fresh.truncated };
    return {
      read_now: true,
      follow: {
        items: statFollow(fresh.sources, nowMs),
        ...(fresh.truncated ? { truncated: true, truncated_note: `Only the first ${MAX_FOLLOW_ITEMS} RENDERING or QUEUED items are followed.` } : {}),
        note: "Output files of the RENDERING and QUEUED items, checked on disk now. After Effects gives no percentage; a growing file (grew_since_last_check true) is a sign of life, null means this is the first check. A movie may only be written at the end.",
      },
    };
  }
  const last = followState.lastRead;
  if (!last) return null;
  const ageSeconds = Math.max(0, Math.round((nowMs - last.at) / 1000));
  return {
    read_now: false,
    follow: {
      items: statFollow(last.sources, nowMs),
      from_earlier_read: true,
      earlier_read_seconds_ago: ageSeconds,
      ...(last.truncated ? { truncated: true } : {}),
      note:
        `After Effects did not answer in time${problem ? ` (${problem.slice(0, 160)})` : ""}; it may be busy rendering. The item list and statuses are from the last successful read ${ageSeconds} s ago and may be out of date; the file facts (exists, bytes, mtime, grew_since_last_check) were taken from disk just now.`,
    },
  };
}
