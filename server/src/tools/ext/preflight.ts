/**
 * server/src/tools/ext/preflight.ts
 *
 * ae_preflight: one read-only check before a render, with two scopes.
 * - delivery: the gate. Missing or placeholder footage, proxies left on,
 *   missing fonts, effects that are not installed, expressions in error,
 *   text outside title safe, default or badly named items, render-queue
 *   outputs without a file or folder, unsaved changes. Each finding is a
 *   blocker, warning or note and names the tool that fixes it.
 * - health: the scale map. Counts per comp, the heaviest comps, deep
 *   nesting, duplicate footage paths, huge comps, the renderer per comp and
 *   the project's colour settings (against a spec when one is given).
 *
 * The host reads in slices (items, then layers comp by comp), so no single
 * evalScript runs long; this file drives the slices, keeps the scan between
 * calls under a short cursor, and applies the rules in Node.
 *
 * `runPreflightGate` is the same scan for ae_render_queue_add and
 * ae_aerender_start (their `preflight: true` option); it runs inside the
 * caller's queue lease.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { BridgeError } from "../../host.js";
import { buildJsxCall } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import type { ToolContext, ToolDefinition } from "../common.js";

// ---------- host shapes ----------

export interface RqOutput {
  file: string | null;
  folder: string | null;
  folder_exists: boolean | null;
}

export interface RqItem {
  index: number;
  comp_id: number | null;
  comp_name: string | null;
  status: string;
  render: boolean;
  outputs: RqOutput[];
}

export interface ProjectInfo {
  aeVersion: string;
  project_path: string;
  saved: boolean;
  dirty: boolean | null;
  numItems: number;
  bits_per_channel: number | null;
  working_space: string | null;
  linear_blending: boolean | null;
  expression_engine: string | null;
  installed_effects: number;
  effects_check: "available" | "unavailable";
  missing_fonts: string[];
  fonts_check: "available" | "unavailable";
  render_queue: { numItems: number; rendering: boolean; items: RqItem[]; truncated: boolean };
}

export interface CompInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  layers: number;
  renderer: string | null;
  used_n: number;
  used_in: number[];
  proxy?: { use: boolean; file: string | null; missing: boolean } | null;
}

export interface FootageInfo {
  id: number;
  name: string;
  kind: "footage" | "solid" | "placeholder";
  file: string | null;
  missing: boolean;
  width: number;
  height: number;
  used_n: number;
  used_in: number[];
  proxy: { use: boolean; file: string | null; missing: boolean } | null;
}

export interface ItemsPage {
  offset: number;
  total: number;
  next_offset: number | null;
  comps: CompInfo[];
  footage: FootageInfo[];
  folders: number;
}

export interface Counts {
  layers: number;
  effects: number;
  expressions: number;
  keys: number;
  three_d: number;
  text: number;
  precomp: number;
}

export interface HostLayerIssue {
  type: string;
  index: number;
  layer_id: number;
  layer: string;
  kind: string;
  path?: string;
  detail?: string;
  effect?: string;
  match_name?: string;
  /** glyphs_missing: the font, the characters it lacks (at most 20) and AE's default font for their script. */
  font?: string;
  missing?: string[];
  suggested?: string[];
}

export interface LayersPage {
  comp_id: number;
  name: string;
  width: number;
  height: number;
  time: number;
  renderer: string | null;
  num_layers: number;
  from: number;
  to: number;
  next_from: number | null;
  layers: Array<{ index: number; name: string; kind: string; enabled: boolean }>;
  counts: Counts;
  precomp_ids: number[];
  texts: Array<{ index: number; id: number; name: string }>;
  issues: HostLayerIssue[];
  issues_overflow: number;
  forced_evals: number;
  /** Expressions the host did not force because it hit its per-slice cap. */
  force_capped?: number;
  fonts_unchecked: number;
  /** Glyph coverage (AE 25.1): runs of one font checked, runs that could not be, runs cut at the character cap, texts checked whole against one font. Absent from older hosts. */
  glyphs_checked?: number;
  glyphs_unchecked?: number;
  glyphs_truncated?: number;
  glyphs_whole_only?: number;
  glyphs_reason?: string;
  effects_check: "available" | "unavailable";
}

/** What `layerBoundsAt` in motion.jsx returns. */
export interface BoundsResult {
  layer: { index: number; id: number; name: string };
  kind: string;
  checkable: boolean;
  reason: string | null;
  samples: Array<{ time: number; visible: boolean; rect: [number, number, number, number] | null }>;
}

// ---------- findings ----------

export type Severity = "blocker" | "warning" | "note";

export interface Fix {
  /** The ae_* tool that fixes it; absent when only AE's own UI can. */
  tool?: string;
  hint: string;
  /** Ready arguments, when the finding holds all of them (a write still needs `expect`). */
  args?: Record<string, unknown>;
}

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  where?: {
    comp_id?: number;
    comp?: string;
    layer_index?: number;
    layer_id?: number;
    layer?: string;
    item_id?: number;
    item?: string;
    path?: string;
    rq_index?: number;
  };
  /** low: a heuristic that has not been confirmed against a live AE. */
  confidence?: "high" | "low";
  count?: number;
  fix?: Fix;
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, warning: 1, note: 2 };

export function sortFindings(list: Finding[]): Finding[] {
  return list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
}

export function countSeverities(list: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { blocker: 0, warning: 0, note: 0 };
  for (const f of list) c[f.severity]++;
  return c;
}

// ---------- naming ----------

const DEFAULT_NAME = /^(?:Comp|Pre-comp|Shape Layer|Null|Adjustment Layer|Camera|Light|Layer|Text|Solid|Footage) \d+$|^.+ Solid \d+$/;

/** AE's own English default names ("Comp 1", "Solid 2", "Shape Layer 3", "Medium Gray-Royal Blue Solid 1"). */
export function isDefaultName(name: string): boolean {
  return DEFAULT_NAME.test(name);
}

const TEMPLATE_TOKENS: Record<string, string> = {
  word: "[A-Za-z0-9]+",
  n: "\\d+",
  ver: "v\\d+",
  date: "\\d{4}-?\\d{2}-?\\d{2}",
  any: ".+",
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");

/** "{word}_{word}_{ver}" becomes an anchored regex. Throws on an unknown token. */
export function templateToRegex(template: string): RegExp {
  let source = "";
  let last = 0;
  const tokenRe = /\{([A-Za-z]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(template)) !== null) {
    const token = TEMPLATE_TOKENS[m[1]];
    if (token === undefined) throw new Error(`Unknown token {${m[1]}}. Tokens: ${Object.keys(TEMPLATE_TOKENS).map((t) => `{${t}}`).join(", ")}.`);
    source += escapeRegex(template.slice(last, m.index)) + token;
    last = m.index + m[0].length;
  }
  source += escapeRegex(template.slice(last));
  return new RegExp(`^${source}$`);
}

export interface NamingOptions {
  template?: string;
  pattern?: string;
  apply_to?: Array<"comps" | "footage" | "layers">;
  allow_default_names?: boolean;
  forbid_spaces?: boolean;
}

/** The reasons a name breaks the rules, empty when it is fine. */
export function buildNameChecker(n: NamingOptions): (name: string) => string[] {
  let re: RegExp | null = null;
  if (n.pattern !== undefined) re = new RegExp(n.pattern);
  else if (n.template !== undefined) re = templateToRegex(n.template);
  return (name: string) => {
    const reasons: string[] = [];
    if (!n.allow_default_names && isDefaultName(name)) reasons.push("default name");
    if (n.forbid_spaces && /\s/.test(name)) reasons.push("contains spaces");
    if (re && !re.test(name)) reasons.push(n.template !== undefined ? `does not match template "${n.template}"` : `does not match /${n.pattern}/`);
    return reasons;
  };
}

// ---------- title safe ----------

export interface SafeHit {
  comp_id: number;
  comp: string;
  layer: { index: number; id: number; name: string };
  time: number;
  bounds: [number, number, number, number];
  past: string[];
  shift: [number, number];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Text that rests partly outside the title-safe box at the check time.
 * Layers filling most of the frame and layers parked fully off-frame (an
 * exit) are left alone, as ae_house_style_check does.
 */
export function titleSafeHit(b: BoundsResult, comp: { id: number; name: string; width: number; height: number }, share: number): SafeHit | null {
  if (!b.checkable || b.kind !== "text") return null;
  const W = comp.width;
  const H = comp.height;
  const box: [number, number, number, number] = [(W * share) / 2, (H * share) / 2, W - (W * share) / 2, H - (H * share) / 2];
  for (const s of b.samples) {
    if (!s.visible || !s.rect) continue;
    const [l, t, r, bt] = s.rect;
    const area = (r - l) * (bt - t);
    if (area <= 0 || area >= 0.8 * W * H) continue;
    const iw = Math.max(0, Math.min(r, W) - Math.max(l, 0));
    const ih = Math.max(0, Math.min(bt, H) - Math.max(t, 0));
    if ((iw * ih) / area <= 0.001) continue;
    const past: string[] = [];
    if (l < box[0] - 0.5) past.push(`left by ${Math.round(box[0] - l)} px`);
    if (r > box[2] + 0.5) past.push(`right by ${Math.round(r - box[2])} px`);
    if (t < box[1] - 0.5) past.push(`top by ${Math.round(box[1] - t)} px`);
    if (bt > box[3] + 0.5) past.push(`bottom by ${Math.round(bt - box[3])} px`);
    if (past.length === 0) continue;
    const dx = l < box[0] - 0.5 ? box[0] - l : r > box[2] + 0.5 ? box[2] - r : 0;
    const dy = t < box[1] - 0.5 ? box[1] - t : bt > box[3] + 0.5 ? box[3] - bt : 0;
    return { comp_id: comp.id, comp: comp.name, layer: b.layer, time: s.time, bounds: [r1(l), r1(t), r1(r), r1(bt)], past, shift: [r1(dx), r1(dy)] };
  }
  return null;
}

// ---------- nesting and weight ----------

/** The longest chain of nested comps below each comp (0: no precomps). Cycle-safe. */
export function nestingDepths(edges: Map<number, number[]>): Map<number, number> {
  const memo = new Map<number, number>();
  const visiting = new Set<number>();
  const depth = (id: number): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const child of edges.get(id) ?? []) d = Math.max(d, 1 + depth(child));
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const id of edges.keys()) depth(id);
  return memo;
}

/** A rough cost of a comp: layers plus what makes each one slow to evaluate. */
export function compWeight(c: Counts): number {
  return r1(c.layers + 2 * c.effects + 3 * c.expressions + c.keys / 20);
}

// ---------- options and scan state ----------

const BATCH_ITEMS = 150;
const BATCH_LAYERS = 30;
const SAFE_AREA_MAX = 50;
const MAX_FINDINGS = 500;
const MAX_STORED_ISSUES = 5000;
const MAX_STORED_FOOTAGE = 20000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 4;

export interface ScanOptions {
  scope: "delivery" | "health";
  comp_ids?: number[];
  comp_names?: string[];
  force_eval: boolean;
  check_title_safe: boolean;
  title_safe: number;
  naming: NamingOptions;
  project_spec?: { bits_per_channel?: number; working_space?: string; linear_blending?: boolean; expression_engine?: string };
  top: number;
  max_nesting: number;
  /** The output file a tool is about to add to the queue: its folder is checked too. */
  planned_output?: string;
  /** false (the render tools' gate): skip output checks on items already in the queue; only planned_output is checked. Default true. */
  check_queue_outputs?: boolean;
}

interface CompStats {
  counts: Counts;
  scanned_layers: number;
  num_layers: number;
}

interface NameProblems {
  count: number;
  examples: string[];
}

interface StoredIssue extends HostLayerIssue {
  comp_id: number;
  comp: string;
}

type Phase = "project" | "items" | "layers" | "safe" | "done";

export interface ScanState {
  id: string;
  created: number;
  /** Last call that used this scan; the 15 minute expiry counts from here. */
  last_used: number;
  opts: ScanOptions;
  namer: (name: string) => string[];
  phase: Phase;
  project: ProjectInfo | null;
  items_offset: number;
  items_total: number;
  folders: number;
  comps: Map<number, CompInfo>;
  footage: FootageInfo[];
  footage_dropped: number;
  roots: number[];
  finals: Set<number>;
  queue: Array<{ comp_id: number; from: number; force: boolean }>;
  seen: Set<number>;
  stats: Map<number, CompStats>;
  edges: Map<number, number[]>;
  issues: StoredIssue[];
  issues_dropped: number;
  layer_names: Map<number, NameProblems>;
  safe_candidates: Array<{ comp_id: number; comp: string; width: number; height: number; time: number; index: number; id: number; name: string }>;
  safe_total: number;
  safe_index: number;
  safe_hits: SafeHit[];
  safe_unchecked: string[];
  unresolved: string[];
  duplicate_roots: string[];
  skipped_comps: string[];
  fonts_unchecked: number;
  glyphs_checked: number;
  glyphs_unchecked: number;
  glyphs_truncated: number;
  glyphs_whole_only: number;
  glyphs_reason: string | null;
  forced_evals: number;
  force_capped: number;
  slices: number;
}

export function newScanState(opts: ScanOptions, now = Date.now()): ScanState {
  return {
    id: `pf_${crypto.randomBytes(5).toString("hex")}`,
    created: now,
    last_used: now,
    opts,
    namer: buildNameChecker(opts.naming),
    phase: "project",
    project: null,
    items_offset: 0,
    items_total: 0,
    folders: 0,
    comps: new Map(),
    footage: [],
    footage_dropped: 0,
    roots: [],
    finals: new Set(),
    queue: [],
    seen: new Set(),
    stats: new Map(),
    edges: new Map(),
    issues: [],
    issues_dropped: 0,
    layer_names: new Map(),
    safe_candidates: [],
    safe_total: 0,
    safe_index: 0,
    safe_hits: [],
    safe_unchecked: [],
    unresolved: [],
    duplicate_roots: [],
    skipped_comps: [],
    fonts_unchecked: 0,
    glyphs_checked: 0,
    glyphs_unchecked: 0,
    glyphs_truncated: 0,
    glyphs_whole_only: 0,
    glyphs_reason: null,
    forced_evals: 0,
    force_capped: 0,
    slices: 0,
  };
}

const appliesTo = (s: ScanState, what: "comps" | "footage" | "layers") => (s.opts.naming.apply_to ?? ["comps", "footage", "layers"]).includes(what);

// ---------- the scan ----------

/** One evalScript on a host function; the caller decides how (callHost, or evalRaw inside its lease). */
export type ScanCall = <T>(host: string, args: Record<string, unknown>, what: string) => Promise<T>;

export function makeScanCall(ctx: ToolContext, opId: string, toolName: string): ScanCall {
  let n = 0;
  return async <T,>(host: string, args: Record<string, unknown>, what: string) => {
    const res = await ctx.bridge.evalRaw<T>({
      id: `${opId}_pf${n++}`,
      script: buildJsxCall(host, args),
      label: `${toolName} (${what})`,
      mutates: false,
      toolName,
    });
    return res.result;
  };
}

function resolveRoots(s: ScanState): void {
  const o = s.opts;
  const project = s.project as ProjectInfo;
  const byName = (name: string) => [...s.comps.values()].filter((c) => c.name === name);
  let explicit = false;
  let ids: number[] = [];
  if (o.comp_ids && o.comp_ids.length > 0) {
    explicit = true;
    for (const id of o.comp_ids) {
      if (s.comps.has(id)) ids.push(id);
      else s.unresolved.push(`comp id ${id}`);
    }
  }
  if (o.comp_names && o.comp_names.length > 0) {
    explicit = true;
    for (const name of o.comp_names) {
      const matches = byName(name);
      if (matches.length === 0) s.unresolved.push(`comp "${name}"`);
      else {
        // aerender's -comp takes the first comp of that name.
        ids.push(matches[0].id);
        if (matches.length > 1) s.duplicate_roots.push(name);
      }
    }
  }
  let finals: Set<number>;
  if (explicit) {
    finals = new Set(ids);
  } else {
    const queued = project.render_queue.items.filter((it) => (it.render || it.status === "needs_output") && it.status !== "done" && it.comp_id !== null && s.comps.has(it.comp_id));
    if (o.scope === "delivery" && queued.length > 0) {
      ids = queued.map((it) => it.comp_id as number);
      finals = new Set(ids);
    } else {
      ids = [...s.comps.keys()];
      // With no queue to go by, the final comps are the ones no other comp uses.
      finals = new Set([...s.comps.values()].filter((c) => c.used_n === 0).map((c) => c.id));
    }
  }
  s.roots = [...new Set(ids)];
  s.finals = finals;
  for (const id of s.roots) {
    s.seen.add(id);
    s.queue.push({ comp_id: id, from: 1, force: o.force_eval });
  }
}

async function step(s: ScanState, call: ScanCall): Promise<void> {
  const o = s.opts;
  if (s.phase === "project") {
    s.project = await call<ProjectInfo>("preflightProject", {}, "project");
    s.phase = "items";
    return;
  }
  if (s.phase === "items") {
    const page = await call<ItemsPage>("preflightItems", { offset: s.items_offset, limit: BATCH_ITEMS }, `items from ${s.items_offset}`);
    s.items_total = page.total;
    s.folders += page.folders;
    for (const c of page.comps) s.comps.set(c.id, c);
    for (const f of page.footage) {
      if (s.footage.length < MAX_STORED_FOOTAGE) s.footage.push(f);
      else s.footage_dropped++;
    }
    if (page.next_offset === null) {
      resolveRoots(s);
      s.phase = s.queue.length > 0 ? "layers" : "safe";
    } else {
      s.items_offset = page.next_offset;
    }
    return;
  }
  if (s.phase === "layers") {
    const head = s.queue[0];
    let page: LayersPage;
    try {
      page = await call<LayersPage>(
        "preflightLayers",
        {
          comp_id: head.comp_id,
          from: head.from,
          limit: BATCH_LAYERS,
          force_eval: head.force,
          text_candidates: o.check_title_safe && s.finals.has(head.comp_id),
        },
        `layers of comp ${head.comp_id} from ${head.from}`
      );
    } catch (err) {
      // A comp deleted while the scan ran: skip it. Anything else (a timeout, a stuck bridge) stops the scan.
      if (err instanceof BridgeError && err.kind === "evalscript_error" && /No CompItem/.test(err.message)) {
        s.skipped_comps.push(s.comps.get(head.comp_id)?.name ?? String(head.comp_id));
        s.queue.shift();
        if (s.queue.length === 0) s.phase = "safe";
        return;
      }
      throw err;
    }
    absorbLayers(s, head, page);
    if (page.next_from !== null) head.from = page.next_from;
    else s.queue.shift();
    if (s.queue.length === 0) s.phase = "safe";
    return;
  }
  if (s.phase === "safe") {
    const cands = s.safe_candidates;
    if (!o.check_title_safe || s.safe_index >= cands.length || s.safe_index >= SAFE_AREA_MAX) {
      s.phase = "done";
      return;
    }
    const c = cands[s.safe_index];
    try {
      const b = await call<BoundsResult>("layerBoundsAt", { comp_id: c.comp_id, layer: { id: c.id }, times: [c.time] }, `bounds ${c.name}`);
      const hit = titleSafeHit(b, { id: c.comp_id, name: c.comp, width: c.width, height: c.height }, o.title_safe);
      if (hit) s.safe_hits.push(hit);
    } catch (err) {
      // Only a failure the host reported for this layer is "unchecked"; a timeout means the bridge is stuck.
      if (!(err instanceof BridgeError) || err.kind !== "evalscript_error") throw err;
      s.safe_unchecked.push(`${c.comp} > ${c.name}: ${err.message}`);
    }
    s.safe_index++;
    return;
  }
}

function absorbLayers(s: ScanState, head: { comp_id: number; force: boolean }, page: LayersPage): void {
  const st = s.stats.get(page.comp_id) ?? { counts: { layers: 0, effects: 0, expressions: 0, keys: 0, three_d: 0, text: 0, precomp: 0 }, scanned_layers: 0, num_layers: page.num_layers };
  for (const k of Object.keys(st.counts) as Array<keyof Counts>) st.counts[k] += page.counts[k] ?? 0;
  st.scanned_layers += page.layers.length;
  st.num_layers = page.num_layers;
  s.stats.set(page.comp_id, st);
  s.fonts_unchecked += page.fonts_unchecked;
  s.glyphs_checked += page.glyphs_checked ?? 0;
  s.glyphs_unchecked += page.glyphs_unchecked ?? 0;
  s.glyphs_truncated += page.glyphs_truncated ?? 0;
  s.glyphs_whole_only += page.glyphs_whole_only ?? 0;
  if (page.glyphs_reason) s.glyphs_reason = page.glyphs_reason;
  s.forced_evals += page.forced_evals;
  s.force_capped += page.force_capped ?? 0;
  s.issues_dropped += page.issues_overflow;
  for (const i of page.issues) {
    if (s.issues.length < MAX_STORED_ISSUES) s.issues.push({ ...i, comp_id: page.comp_id, comp: page.name });
    else s.issues_dropped++;
  }
  if (appliesTo(s, "layers")) {
    const np = s.layer_names.get(page.comp_id) ?? { count: 0, examples: [] };
    for (const l of page.layers) {
      if (s.namer(l.name).length > 0) {
        np.count++;
        if (np.examples.length < 5) np.examples.push(l.name);
      }
    }
    if (np.count > 0) s.layer_names.set(page.comp_id, np);
  }
  const edges = s.edges.get(page.comp_id) ?? [];
  for (const id of page.precomp_ids) {
    if (!edges.includes(id)) edges.push(id);
    if (!s.seen.has(id) && s.comps.has(id)) {
      s.seen.add(id);
      s.queue.push({ comp_id: id, from: 1, force: head.force });
    }
  }
  s.edges.set(page.comp_id, edges);
  for (const t of page.texts) {
    s.safe_total++;
    if (s.safe_candidates.length < SAFE_AREA_MAX) {
      s.safe_candidates.push({ comp_id: page.comp_id, comp: page.name, width: page.width, height: page.height, time: page.time, index: t.index, id: t.id, name: t.name });
    }
  }
}

export interface ScanLimits {
  maxSlices: number;
  /** Checked between slices; an evalScript in flight is never abandoned. */
  deadline: number;
}

/** Runs slices until the scan is done or a limit is reached. Always runs at least one. */
export async function runScan(s: ScanState, call: ScanCall, limits: ScanLimits): Promise<{ complete: boolean; slices: number }> {
  let slices = 0;
  while (s.phase !== "done") {
    if (slices > 0 && (slices >= limits.maxSlices || Date.now() >= limits.deadline)) break;
    await step(s, call);
    slices++;
    s.slices++;
  }
  return { complete: s.phase === "done", slices };
}

// ---------- rules ----------

function cap(out: Finding[], list: Finding[], limit: number, overflow: (n: number) => Finding): void {
  out.push(...list.slice(0, limit));
  if (list.length > limit) out.push(overflow(list.length - limit));
}

const inScope = (s: ScanState, ids: number[]) => ids.some((id) => s.seen.has(id));
const fileOf = (f: FootageInfo) => f.file ?? "(path unknown)";

function projectFindings(s: ScanState): Finding[] {
  const p = s.project;
  const out: Finding[] = [];
  if (!p) return out;
  if (!p.saved) {
    out.push({
      severity: "warning",
      code: "project_unsaved",
      message: "The project has never been saved. aerender and Collect Files need a file on disk.",
      fix: { tool: "ae_save", hint: "Give it a name once: ae_save with save_as: { path } (an absolute path ending in .aep). A plain ae_save needs a project that already has a file." },
    });
  } else if (p.dirty === true) {
    out.push({
      severity: "warning",
      code: "unsaved_changes",
      message: "The project has unsaved changes. aerender renders the file on disk, not what is open.",
      fix: { tool: "ae_save", hint: "Save first.", args: { expect: { project_path: p.project_path } } },
    });
  }
  const spec = s.opts.project_spec;
  if (spec) {
    // key: the field of ae_project_settings `set` that changes it; absent where that tool has no setter.
    const diff = (what: string, want: unknown, have: unknown, key?: "bits_per_channel" | "working_space" | "linear_blending" | "expression_engine") => {
      if (want !== undefined && want !== have) {
        out.push({
          severity: "warning",
          code: "project_setting_differs",
          message: `${what} is ${JSON.stringify(have)}; the spec says ${JSON.stringify(want)}.`,
          fix: key
            ? {
                tool: "ae_project_settings",
                hint: `Set it with ae_project_settings and set: { ${key}: ${JSON.stringify(want)} } (add expect).`,
                args: { set: { [key]: want }, expect: { project_path: p.project_path } },
              }
            : { hint: "Change it in Project Settings (File > Project Settings)." },
        });
      }
    };
    diff("Bit depth (bits per channel)", spec.bits_per_channel, p.bits_per_channel, "bits_per_channel");
    diff("Working colour space", spec.working_space, p.working_space, "working_space");
    diff("Linearize blending", spec.linear_blending, p.linear_blending, "linear_blending");
    diff("Expression engine", spec.expression_engine, p.expression_engine, "expression_engine");
  }
  return out;
}

/** What the glyph check covered, from its counts and the reason it gave. */
function glyphsCheckedText(s: ScanState): string {
  if (s.glyphs_checked > 0) return `${s.glyphs_checked} runs of text checked against their font's glyphs (AE 25.1)`;
  if (s.glyphs_unchecked > 0) return `not checked: ${s.glyphs_reason ?? "this After Effects cannot check it (FontObject.hasGlyphsFor needs 25.1)"}`;
  return "no text checked (the scanned comps have no text layers to check)";
}

/** Writable is best effort: Node's access() ignores Windows ACLs. */
function folderWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function renderQueueFindings(s: ScanState): Finding[] {
  const p = s.project;
  const out: Finding[] = [];
  if (!p) return out;
  const explicit = Boolean((s.opts.comp_ids && s.opts.comp_ids.length) || (s.opts.comp_names && s.opts.comp_names.length));
  const items = s.opts.check_queue_outputs === false ? [] : p.render_queue.items.filter((it) => (it.render || it.status === "needs_output") && it.status !== "done" && (!explicit || (it.comp_id !== null && s.roots.includes(it.comp_id))));
  for (const it of items) {
    const where = { rq_index: it.index, ...(it.comp_id !== null ? { comp_id: it.comp_id } : {}), ...(it.comp_name ? { comp: it.comp_name } : {}) };
    if (it.status === "needs_output" || it.outputs.length === 0 || it.outputs.every((o) => o.file === null)) {
      out.push({
        severity: "blocker",
        code: "output_missing",
        message: `Render queue item ${it.index} (${it.comp_name ?? "?"}) has no output file.`,
        where,
        fix: { tool: "ae_run_jsx", hint: "Set the output module's file (`item.outputModule(1).file = new File(path)`), or remove the item." },
      });
      continue;
    }
    for (const o of it.outputs) {
      if (o.file === null || o.folder === null) continue;
      if (o.folder_exists === false) {
        out.push({
          severity: "warning",
          code: "output_folder_missing",
          message: `Render queue item ${it.index} writes to ${o.file}, but the folder ${o.folder} does not exist.`,
          where,
          confidence: "low",
          fix: { tool: "ae_run_jsx", hint: "Create the folder, or point the output at an existing one. AE may create a missing folder at render time (not measured), so this is a warning." },
        });
      } else if (o.folder_exists === true && !folderWritable(o.folder)) {
        out.push({
          severity: "note",
          code: "output_folder_not_writable",
          message: `The folder ${o.folder} for render queue item ${it.index} may not be writable (best effort: Node does not read Windows permissions).`,
          where,
          confidence: "low",
        });
      }
    }
    if (it.status === "err_stopped") {
      out.push({ severity: "note", code: "queue_item_failed_before", message: `Render queue item ${it.index} stopped with an error last time.`, where, fix: { tool: "ae_render_queue_status", hint: "Read the queue status and the AE log." } });
    }
  }
  if (s.opts.planned_output) {
    const dir = path.dirname(s.opts.planned_output);
    if (dir !== "." && dir !== "" && !fs.existsSync(dir)) {
      out.push({
        severity: "warning",
        code: "output_folder_missing",
        message: `The planned output ${s.opts.planned_output} is in a folder that does not exist (${dir}).`,
        confidence: "low",
        fix: { hint: "Create the folder first. AE may create it at render time (not measured)." },
      });
    }
  }
  return out;
}

function footageFindings(s: ScanState): Finding[] {
  const out: Finding[] = [];
  const unused: FootageInfo[] = [];
  for (const f of s.footage) {
    const used = f.used_n > 0 && (inScope(s, f.used_in) || f.used_in.length < f.used_n);
    const where = { item_id: f.id, item: f.name };
    if (f.kind === "placeholder") {
      out.push({
        severity: used ? "blocker" : "note",
        code: "footage_placeholder",
        message: used ? `"${f.name}" is still a placeholder and is used in the comps being checked.` : `"${f.name}" is a placeholder that no checked comp uses.`,
        where,
        fix: used ? { tool: "ae_replace_footage", hint: `Replace item ${f.id} with the real file.` } : { tool: "ae_purge_unused", hint: "Remove unused items." },
      });
    } else if (f.missing && f.kind === "footage") {
      const unknown = f.used_n > 0 && !inScope(s, f.used_in) && f.used_in.length >= f.used_n;
      out.push({
        severity: used ? "blocker" : "note",
        code: "footage_missing",
        message: used
          ? `Footage "${f.name}" is missing: ${fileOf(f)}`
          : unknown
          ? `Footage "${f.name}" is missing (${fileOf(f)}), but only comps outside this check use it.`
          : `Footage "${f.name}" is missing (${fileOf(f)}) and nothing uses it.`,
        where,
        fix: used ? { tool: "ae_replace_footage", hint: `Point item ${f.id} at the real file.` } : { tool: "ae_purge_unused", hint: "Remove unused items." },
      });
    }
    if (f.proxy && used) {
      if (f.proxy.use) {
        out.push({
          severity: "warning",
          code: "proxy_in_use",
          message: `"${f.name}" has its proxy switched on${f.proxy.file ? ` (${f.proxy.file})` : ""}. Renders use proxies only if the render settings allow it.`,
          where,
          fix: { tool: "ae_run_jsx", hint: `Run \`app.project.itemByID(${f.id}).useProxy = false\` in an undo group, or set the render settings' Proxy Use to "Use No Proxies".` },
        });
      }
      if (f.proxy.missing) {
        out.push({
          severity: "warning",
          code: "proxy_file_missing",
          message: `The proxy file of "${f.name}" is missing${f.proxy.file ? `: ${f.proxy.file}` : ""}.`,
          where,
          fix: { tool: "ae_run_jsx", hint: `Remove the proxy (\`app.project.itemByID(${f.id}).setProxyToNone()\`) or relink it.` },
        });
      }
    }
    if (f.used_n === 0) unused.push(f);
  }
  // A comp can carry a proxy too (Set Proxy > File).
  for (const c of s.comps.values()) {
    if (!c.proxy || !s.seen.has(c.id)) continue;
    const where = { item_id: c.id, item: c.name, comp_id: c.id, comp: c.name };
    if (c.proxy.use) {
      out.push({
        severity: "warning",
        code: "proxy_in_use",
        message: `Comp "${c.name}" has its proxy switched on${c.proxy.file ? ` (${c.proxy.file})` : ""}. Renders use proxies only if the render settings allow it.`,
        where,
        fix: { tool: "ae_run_jsx", hint: `Run \`app.project.itemByID(${c.id}).useProxy = false\` in an undo group, or set the render settings' Proxy Use to "Use No Proxies".` },
      });
    }
    if (c.proxy.missing) {
      out.push({
        severity: "warning",
        code: "proxy_file_missing",
        message: `The proxy file of comp "${c.name}" is missing${c.proxy.file ? `: ${c.proxy.file}` : ""}.`,
        where,
        fix: { tool: "ae_run_jsx", hint: `Remove the proxy (\`app.project.itemByID(${c.id}).setProxyToNone()\`) or relink it.` },
      });
    }
  }
  if (s.footage_dropped > 0) {
    out.push({ severity: "note", code: "footage_not_checked", message: `${s.footage_dropped} footage items beyond the first ${MAX_STORED_FOOTAGE} were not checked.` });
  }
  if (unused.length > 0 && s.opts.scope === "delivery") {
    out.push({
      severity: "note",
      code: "unused_items",
      message: `${unused.length} footage items are not used by any comp (e.g. ${unused.slice(0, 3).map((u) => `"${u.name}"`).join(", ")}).`,
      count: unused.length,
      fix: { tool: "ae_purge_unused", hint: "List them, then remove with apply: true." },
    });
  }
  return out;
}

function layerIssueFindings(s: ScanState): Finding[] {
  const out: Finding[] = [];
  const fontLayers = new Map<string, StoredIssue[]>();
  const glyphLayers = new Map<string, StoredIssue[]>();
  const effectLayers = new Map<string, StoredIssue[]>();
  const errors: Finding[] = [];
  const disabled: Finding[] = [];
  const truncated: StoredIssue[] = [];
  const unchecked: StoredIssue[] = [];
  for (const i of s.issues) {
    const where = { comp_id: i.comp_id, comp: i.comp, layer_index: i.index, layer_id: i.layer_id, layer: i.layer, ...(i.path ? { path: i.path } : {}) };
    if (i.type === "font_missing") {
      const key = i.detail ?? "?";
      fontLayers.set(key, [...(fontLayers.get(key) ?? []), i]);
    } else if (i.type === "glyphs_missing") {
      const key = i.font ?? i.detail ?? "?";
      glyphLayers.set(key, [...(glyphLayers.get(key) ?? []), i]);
    } else if (i.type === "effect_unavailable") {
      const key = i.match_name ?? i.effect ?? "?";
      effectLayers.set(key, [...(effectLayers.get(key) ?? []), i]);
    } else if (i.type === "expression_error") {
      errors.push({
        severity: "blocker",
        code: "expression_error",
        message: `Expression error on ${i.comp} > ${i.layer} > ${i.path ?? "?"}: ${i.detail ?? ""}`,
        where,
        fix: { tool: "ae_validate_expressions", hint: `Read the full error and fix the expression (ae_set_property on ${i.path ?? "the property"}).`, args: { comp_id: i.comp_id, layer: { id: i.layer_id } } },
      });
    } else if (i.type === "expression_disabled") {
      disabled.push({
        severity: "warning",
        code: "expression_disabled",
        message: `An expression is switched off on ${i.comp} > ${i.layer} > ${i.path ?? "?"}. AE switches an expression off when it errors, so this may hide a broken one.`,
        where,
        fix: { tool: "ae_validate_expressions", hint: "Check it, then switch it on or clear it.", args: { comp_id: i.comp_id, layer: { id: i.layer_id } } },
      });
    } else if (i.type === "expression_unchecked") {
      unchecked.push(i);
    } else if (i.type === "properties_truncated") {
      truncated.push(i);
    }
  }
  for (const [font, list] of fontLayers) {
    const where = { comp_id: list[0].comp_id, comp: list[0].comp };
    out.push({
      severity: "blocker",
      code: "font_missing",
      message: `Font "${font}" is missing or substituted on ${list.length} layer${list.length === 1 ? "" : "s"}: ${list.slice(0, 5).map((l) => `${l.comp} > ${l.layer}`).join(", ")}${list.length > 5 ? ", ..." : ""}.`,
      where,
      count: list.length,
      fix: { tool: "ae_fonts", hint: "List the fonts in use, install the missing one, or change the text layers' font." },
    });
  }
  for (const [font, list] of glyphLayers) {
    const chars: string[] = [];
    const suggested: string[] = [];
    for (const l of list) {
      for (const c of l.missing ?? []) if (!chars.includes(c) && chars.length < 20) chars.push(c);
      for (const g of l.suggested ?? []) if (!suggested.includes(g) && suggested.length < 3) suggested.push(g);
    }
    const where = list.slice(0, 5).map((l) => `${l.comp} > ${l.layer}`).join(", ") + (list.length > 5 ? ", ..." : "");
    const alt = suggested.length ? `; AE's default font for that script is ${suggested.join(", ")}` : "";
    out.push({
      severity: "warning",
      code: "glyphs_missing",
      message: `Font "${font}" has no glyph for ${chars.join(" ") || "some characters"} used on ${list.length} layer${list.length === 1 ? "" : "s"}: ${where}. They render as empty boxes or fallback glyphs${alt}.`,
      where: { comp_id: list[0].comp_id, comp: list[0].comp, layer_index: list[0].index, layer_id: list[0].layer_id, layer: list[0].layer },
      count: list.length,
      fix: {
        tool: "ae_fonts",
        hint: "Check the real text with ae_fonts action check and text, then switch the layers to a font that has the glyphs (ae_set_text with style.font).",
        args: { action: "check", fonts: [font], text: chars.join("") },
      },
    });
  }
  const seenFonts = new Set(fontLayers.keys());
  for (const f of s.project?.missing_fonts ?? []) {
    if (!seenFonts.has(f)) {
      out.push({ severity: "note", code: "font_missing_elsewhere", message: `AE reports the font "${f}" as missing; none of the layers checked use it.`, fix: { tool: "ae_fonts", hint: "Find where it is used." } });
    }
  }
  for (const [match, list] of effectLayers) {
    // Built-in effects (ADBE ...) that AE hides from the Effect menu may be absent from app.effects (not measured): a note only.
    const builtIn = match.indexOf("ADBE ") === 0;
    out.push({
      severity: builtIn ? "note" : "warning",
      code: "effect_unavailable",
      message: `Effect "${list[0].effect ?? match}" (${match}) is not in the installed effects list; used on ${list.length} layer${list.length === 1 ? "" : "s"}: ${list.slice(0, 5).map((l) => `${l.comp} > ${l.layer}`).join(", ")}${list.length > 5 ? ", ..." : ""}.`,
      where: { comp_id: list[0].comp_id, comp: list[0].comp, layer_index: list[0].index, layer: list[0].layer },
      count: list.length,
      confidence: "low",
      fix: { tool: "ae_list_effects", hint: "Confirm in AE (an unavailable plug-in shows as missing); install the plug-in or remove the effect." },
    });
  }
  cap(out, errors, 100, (n) => ({ severity: "blocker", code: "expression_error", message: `${n} more expression errors not listed. Run ae_validate_expressions on the comps.`, count: n, fix: { tool: "ae_validate_expressions", hint: "Run it per comp." } }));
  cap(out, disabled, 50, (n) => ({ severity: "warning", code: "expression_disabled", message: `${n} more switched-off expressions not listed.`, count: n }));
  if (unchecked.length > 0) {
    out.push({
      severity: "note",
      code: "expression_unchecked",
      message: `${unchecked.length} expression${unchecked.length === 1 ? "" : "s"} could not be evaluated to check them (the property refuses to be read, e.g. a custom-value effect parameter): ${unchecked.slice(0, 3).map((l) => `${l.comp} > ${l.layer} > ${l.path ?? "?"}`).join(", ")}${unchecked.length > 3 ? ", ..." : ""}. They may be fine.`,
      count: unchecked.length,
      confidence: "low",
      fix: { tool: "ae_validate_expressions", hint: "Check them by hand." },
    });
  }
  if (truncated.length > 0) {
    out.push({
      severity: "note",
      code: "properties_truncated",
      message: `${truncated.length} layer${truncated.length === 1 ? " has" : "s have"} more properties than one read covers; expressions and effects past the limit were not checked (${truncated.slice(0, 3).map((l) => `${l.comp} > ${l.layer}`).join(", ")}).`,
      count: truncated.length,
    });
  }
  if (s.issues_dropped > 0) {
    out.push({ severity: "note", code: "issues_not_listed", message: `${s.issues_dropped} more layer-level issues were found than are kept; fix the ones above and run again.`, count: s.issues_dropped });
  }
  return out;
}

function namingFindings(s: ScanState): Finding[] {
  const out: Finding[] = [];
  const custom = s.opts.naming.template !== undefined || s.opts.naming.pattern !== undefined;
  const rename = (what: string, compId?: number): Fix => {
    if (what === "layers") {
      return {
        tool: "ae_layer_ops",
        hint: 'Rename the layers with ae_layer_ops action "rename" (find/replace or a template).',
        args: { action: "rename", ...(compId !== undefined ? { comp_id: compId } : {}) },
      };
    }
    return { tool: "ae_run_jsx", hint: `Rename the ${what} (\`item.name = ...\`) inside an undo group; ae_layer_ops renames layers only.` };
  };
  const code = custom ? "name_rule_broken" : "default_name";
  if (appliesTo(s, "comps")) {
    const finalHits: Finding[] = [];
    const otherHits: CompInfo[] = [];
    for (const id of s.seen) {
      const c = s.comps.get(id);
      if (!c) continue;
      const reasons = s.namer(c.name);
      if (reasons.length === 0) continue;
      if (s.finals.has(id)) {
        finalHits.push({ severity: "warning", code, message: `Comp "${c.name}" (id ${c.id}): ${reasons.join(", ")}.`, where: { comp_id: c.id, comp: c.name }, fix: rename("comp") });
      } else otherHits.push(c);
    }
    cap(out, finalHits, 50, (n) => ({ severity: "warning", code, message: `${n} more comps break the naming rules.`, count: n }));
    if (otherHits.length > 0) {
      out.push({
        severity: "note",
        code,
        message: `${otherHits.length} nested comps break the naming rules (e.g. ${otherHits.slice(0, 5).map((c) => `"${c.name}"`).join(", ")}).`,
        count: otherHits.length,
        fix: rename("comps"),
      });
    }
  }
  if (appliesTo(s, "footage")) {
    const hits = s.footage.filter((f) => f.used_n > 0 && inScope(s, f.used_in) && s.namer(f.name).length > 0);
    if (hits.length > 0) {
      out.push({
        severity: "note",
        code,
        message: `${hits.length} footage items break the naming rules (e.g. ${hits.slice(0, 5).map((f) => `"${f.name}"`).join(", ")}).`,
        count: hits.length,
        fix: rename("footage items"),
      });
    }
  }
  if (appliesTo(s, "layers")) {
    const list = [...s.layer_names.entries()];
    cap(
      out,
      list.map(([id, np]) => ({
        severity: "note" as const,
        code,
        message: `${np.count} layer${np.count === 1 ? "" : "s"} in "${s.comps.get(id)?.name ?? id}" break the naming rules (e.g. ${np.examples.map((e) => `"${e}"`).join(", ")}).`,
        where: { comp_id: id, comp: s.comps.get(id)?.name },
        count: np.count,
        fix: rename("layers", id),
      })),
      30,
      (n) => ({ severity: "note", code, message: `${n} more comps have layers that break the naming rules.`, count: n })
    );
  }
  // Two comps with one name: aerender -comp picks the first, and so does anyone reading the log.
  const byName = new Map<string, CompInfo[]>();
  for (const c of s.comps.values()) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    if (s.duplicate_roots.includes(name)) continue; // already reported from the requested names
    const involvesFinal = list.some((c) => s.finals.has(c.id));
    if (!involvesFinal && s.opts.scope === "delivery") continue;
    out.push({
      severity: involvesFinal ? "warning" : "note",
      code: "duplicate_comp_name",
      message: `${list.length} comps are named "${name}" (ids ${list.map((c) => c.id).join(", ")}). Anything that picks a comp by name, aerender included, takes the first.`,
      count: list.length,
      fix: rename("comps"),
    });
  }
  return out;
}

function titleSafeFindings(s: ScanState): Finding[] {
  const out: Finding[] = [];
  for (const h of s.safe_hits) {
    const [dx, dy] = h.shift;
    let align: string;
    if (dx !== 0) align = dx > 0 ? "left" : "right";
    else align = dy > 0 ? "top" : "bottom";
    out.push({
      severity: "warning",
      code: "text_outside_title_safe",
      message: `Text "${h.layer.name}" in ${h.comp} rests outside the title-safe area at ${h.time}s: past it on the ${h.past.join(", ")}.`,
      where: { comp_id: h.comp_id, comp: h.comp, layer_index: h.layer.index, layer_id: h.layer.id, layer: h.layer.name },
      fix: {
        tool: "ae_align",
        hint: `Move it by [${h.shift[0]}, ${h.shift[1]}] px; ae_align to title_safe handles one axis per call (add expect).`,
        args: { comp_id: h.comp_id, layers: [{ id: h.layer.id }], align, to: "title_safe" },
      },
    });
  }
  if (s.safe_total > SAFE_AREA_MAX) {
    out.push({ severity: "note", code: "title_safe_partial", message: `Title safe was checked on the first ${SAFE_AREA_MAX} of ${s.safe_total} text layers.`, count: s.safe_total });
  }
  if (s.safe_unchecked.length > 0) {
    out.push({ severity: "note", code: "title_safe_unchecked", message: `${s.safe_unchecked.length} text layers could not be measured: ${s.safe_unchecked.slice(0, 3).join("; ")}`, count: s.safe_unchecked.length });
  }
  return out;
}

function healthFindings(s: ScanState): Finding[] {
  const out: Finding[] = [];
  const depths = nestingDepths(s.edges);
  const deep = [...depths.entries()].filter(([, d]) => d > s.opts.max_nesting).sort((a, b) => b[1] - a[1]);
  cap(
    out,
    deep.map(([id, d]) => ({
      severity: "note" as const,
      code: "deep_nesting",
      message: `Comp "${s.comps.get(id)?.name ?? id}" nests ${d} levels of comps (limit ${s.opts.max_nesting}).`,
      where: { comp_id: id, comp: s.comps.get(id)?.name },
      count: d,
      fix: { tool: "ae_comp_tree", hint: "Read the tree and flatten precomps that add nothing." },
    })),
    20,
    (n) => ({ severity: "note", code: "deep_nesting", message: `${n} more deeply nested comps.`, count: n })
  );
  const byPath = new Map<string, FootageInfo[]>();
  for (const f of s.footage) {
    if (f.kind !== "footage" || !f.file) continue;
    const key = process.platform === "win32" ? f.file.toLowerCase() : f.file;
    byPath.set(key, [...(byPath.get(key) ?? []), f]);
  }
  const dups = [...byPath.values()].filter((l) => l.length > 1);
  cap(
    out,
    dups.map((l) => ({
      severity: "note" as const,
      code: "duplicate_footage",
      message: `${l.length} project items point at ${l[0].file}: ${l.slice(0, 4).map((f) => `"${f.name}" (${f.id})`).join(", ")}.`,
      count: l.length,
      fix: { tool: "ae_run_jsx", hint: "Replace the copies' uses with one item (layer.replaceSource), then purge." },
    })),
    20,
    (n) => ({ severity: "note", code: "duplicate_footage", message: `${n} more footage files are imported more than once.`, count: n })
  );
  const huge = [...s.comps.values()].filter((c) => Math.max(c.width, c.height) > 8192 || c.width * c.height > 33_177_600);
  cap(
    out,
    huge.map((c) => ({
      severity: "note" as const,
      code: "huge_comp",
      message: `Comp "${c.name}" is ${c.width}x${c.height}: large frames use a lot of memory and cache.`,
      where: { comp_id: c.id, comp: c.name },
    })),
    20,
    (n) => ({ severity: "note", code: "huge_comp", message: `${n} more very large comps.`, count: n })
  );
  return out;
}

export function buildFindings(s: ScanState): Finding[] {
  const all: Finding[] = [];
  for (const u of s.unresolved) {
    all.push({ severity: "blocker", code: "comp_not_found", message: `The ${u} was not found in the project.`, fix: { tool: "ae_get_project", hint: "List the project's comps." } });
  }
  for (const name of s.duplicate_roots) {
    all.push({ severity: "warning", code: "duplicate_comp_name", message: `More than one comp is named "${name}"; the first was checked.`, fix: { tool: "ae_run_jsx", hint: "Rename the duplicates so a name picks one comp." } });
  }
  for (const name of s.skipped_comps) {
    all.push({ severity: "note", code: "comp_vanished", message: `Comp "${name}" was deleted while the scan ran and was skipped.` });
  }
  all.push(...projectFindings(s), ...renderQueueFindings(s), ...footageFindings(s), ...layerIssueFindings(s), ...titleSafeFindings(s), ...namingFindings(s));
  if (s.opts.force_eval && s.force_capped > 0) {
    all.push({
      severity: "note",
      code: "force_eval_partial",
      message: `Only ${s.forced_evals} of the ${s.forced_evals + s.force_capped} expressions in the forced comps were evaluated (the host forces at most 200 per read); the other ${s.force_capped} were checked by the error state AE already holds. Run ae_validate_expressions on the heaviest comps.`,
      count: s.force_capped,
      fix: { tool: "ae_validate_expressions", hint: "Run it per comp." },
    });
  }
  if (s.opts.scope === "health") all.push(...healthFindings(s));
  if (s.project && s.project.effects_check === "unavailable") {
    all.push({ severity: "note", code: "effects_check_skipped", message: "The installed-effects list could not be read, so effects that are not installed were not looked for." });
  }
  if (s.glyphs_checked === 0 && s.glyphs_unchecked > 0) {
    all.push({
      severity: "note",
      code: "glyphs_check_skipped",
      message: `Glyph coverage was not checked: ${s.glyphs_reason ?? "this After Effects cannot check it (FontObject.hasGlyphsFor needs 25.1)"}`,
      count: s.glyphs_unchecked,
    });
  } else if (s.glyphs_whole_only > 0 || s.glyphs_truncated > 0) {
    all.push({
      severity: "note",
      code: "glyphs_check_partial",
      message: `Glyph coverage was checked in part: ${s.glyphs_whole_only} text(s) against the first font only (mixed fonts not told apart) and ${s.glyphs_truncated} cut at the character cap.`,
      count: s.glyphs_whole_only + s.glyphs_truncated,
    });
  }
  if (s.fonts_unchecked > 0 && s.project?.fonts_check === "unavailable") {
    all.push({ severity: "note", code: "fonts_check_skipped", message: "This AE has no font object on text (before AE 24), so missing fonts were not checked.", count: s.fonts_unchecked });
  }
  return sortFindings(all);
}

// ---------- health section ----------

export function buildHealth(s: ScanState) {
  const totals: Counts = { layers: 0, effects: 0, expressions: 0, keys: 0, three_d: 0, text: 0, precomp: 0 };
  for (const st of s.stats.values()) for (const k of Object.keys(totals) as Array<keyof Counts>) totals[k] += st.counts[k];
  const depths = nestingDepths(s.edges);
  const ranked = [...s.stats.entries()]
    .map(([id, st]) => ({
      comp_id: id,
      comp: s.comps.get(id)?.name ?? String(id),
      weight: compWeight(st.counts),
      layers: st.num_layers,
      effects: st.counts.effects,
      expressions: st.counts.expressions,
      keys: st.counts.keys,
      nesting_depth: depths.get(id) ?? 0,
      width: s.comps.get(id)?.width,
      height: s.comps.get(id)?.height,
      renderer: s.comps.get(id)?.renderer ?? null,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, s.opts.top);
  const renderers: Record<string, number> = {};
  for (const c of s.comps.values()) {
    const r = c.renderer ?? "unknown";
    renderers[r] = (renderers[r] ?? 0) + 1;
  }
  const threeD = [...s.stats.entries()]
    .filter(([, st]) => st.counts.three_d > 0)
    .map(([id, st]) => ({ comp_id: id, comp: s.comps.get(id)?.name ?? String(id), three_d_layers: st.counts.three_d, renderer: s.comps.get(id)?.renderer ?? null }))
    .slice(0, 50);
  const unusedFootage = s.footage.filter((f) => f.used_n === 0).length;
  const unusedComps = [...s.comps.values()].filter((c) => c.used_n === 0 && !s.project?.render_queue.items.some((it) => it.comp_id === c.id)).length;
  return {
    settings: s.project
      ? {
          bits_per_channel: s.project.bits_per_channel,
          working_space: s.project.working_space,
          linear_blending: s.project.linear_blending,
          expression_engine: s.project.expression_engine,
          note: "These are project-level; comps and footage carry no settings of their own to compare. Pass project_spec to check them against a brief.",
        }
      : null,
    totals: { items: s.items_total, comps: s.comps.size, footage: s.footage.length, folders: s.folders, ...totals },
    weight_formula: "layers + 2*effects + 3*expressions + keys/20",
    heaviest_comps: ranked,
    renderers,
    comps_with_3d_layers: threeD,
    unused: { footage: unusedFootage, comps_not_in_queue_or_used: unusedComps },
    max_nesting_depth: Math.max(0, ...depths.values()),
  };
}

// ---------- report ----------

export function buildReport(s: ScanState, complete: boolean, slicesThisCall: number) {
  const all = buildFindings(s);
  const counts = countSeverities(all);
  const shown = all.slice(0, MAX_FINDINGS);
  let verdict: "blocked" | "warnings" | "clear" | "incomplete";
  if (counts.blocker > 0) verdict = "blocked";
  else if (!complete) verdict = "incomplete";
  else if (counts.warning > 0) verdict = "warnings";
  else verdict = "clear";
  const forced = s.opts.force_eval;
  return {
    ok: true as const,
    scope: s.opts.scope,
    verdict,
    complete,
    ...(complete ? {} : { cursor: s.id, next: "Call ae_preflight again with this cursor to continue; findings so far are listed." }),
    counts,
    progress: {
      phase: s.phase,
      items_scanned: s.phase === "project" ? 0 : s.phase === "items" ? s.items_offset : s.items_total,
      items_total: s.items_total,
      comps_scanned: s.stats.size,
      comps_queued: s.queue.length,
      slices_this_call: slicesThisCall,
      slices_total: s.slices,
    },
    project: s.project
      ? { path: s.project.project_path, saved: s.project.saved, dirty: s.project.dirty, ae_version: s.project.aeVersion, render_queue_items: s.project.render_queue.numItems }
      : null,
    checked: {
      comps: [...s.seen].map((id) => ({ id, name: s.comps.get(id)?.name ?? String(id) })).slice(0, 100),
      comps_checked_count: s.seen.size,
      final_comps: [...s.finals].slice(0, 50),
      expressions: forced
        ? `forced evaluation at each comp's current time (valueAtTime), then expressionError: ${s.forced_evals} of ${s.forced_evals + s.force_capped} expressions in the forced comps were forced` + (s.force_capped > 0 ? `; ${s.force_capped} were only read the cheap way (per-read cap)` : "")
        : "the error state AE already holds (expressionError). Expressions AE has not evaluated yet can be missed: pass force_eval for the comps in the render queue.",
      effects: s.project?.effects_check === "available" ? "matched against app.effects (heuristic, unconfirmed against a live uninstalled plug-in)" : "skipped: app.effects was not readable",
      glyphs: glyphsCheckedText(s),
      fonts: s.project?.fonts_check === "available" ? "text layers' font objects plus app.fonts.missingOrSubstitutedFonts" : "text layers' font objects only",
      output_folders: "existence checked in ExtendScript; writability is best effort (Node ignores Windows permissions)",
      title_safe: s.opts.check_title_safe ? `text layers of the final comps, at each comp's current time, ${Math.round(s.opts.title_safe * 100)}% margin` : "skipped",
    },
    findings: shown,
    ...(all.length > shown.length ? { truncated: true, findings_total: all.length } : {}),
    ...(s.opts.scope === "health" ? { health: buildHealth(s) } : {}),
  };
}

// ---------- sessions ----------

const sessions = new Map<string, ScanState>();

function expireSessions(now: number): void {
  for (const [id, st] of sessions) if (now - st.last_used > SESSION_TTL_MS) sessions.delete(id);
}

/** Room for one more stored scan: the oldest goes. */
function makeRoom(): void {
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

/** Test hook: forget every stored scan. */
export function clearPreflightSessions(): void {
  sessions.clear();
}

// ---------- schemas ----------

const NamingSchema = z
  .object({
    template: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("A name template with tokens {word} (letters and digits), {n} (digits), {ver} (v + digits), {date} (YYYYMMDD or YYYY-MM-DD) and {any}; everything else is literal. E.g. \"{word}_{word}_{ver}\"."),
    pattern: z.string().min(1).max(200).optional().describe("A regular expression (JavaScript syntax) every checked name must match. Give this or template, not both."),
    apply_to: z.array(z.enum(["comps", "footage", "layers"])).min(1).optional().describe("Which names the rules apply to. Default all three; layer problems are listed once per comp."),
    allow_default_names: z.boolean().optional().describe("Skip the default-name check (\"Comp 1\", \"Solid 2\", \"Shape Layer 3\", \"Null 4\", \"<colour> Solid 5\": AE's English defaults). Default false."),
    forbid_spaces: z.boolean().optional().describe("Flag names that contain whitespace. Default false."),
  })
  .refine((n) => !(n.template !== undefined && n.pattern !== undefined), { message: "Give template or pattern, not both." })
  .refine(
    (n) => {
      try {
        if (n.pattern !== undefined) new RegExp(n.pattern);
        if (n.template !== undefined) templateToRegex(n.template);
        return true;
      } catch {
        return false;
      }
    },
    { message: "pattern is not a valid regular expression, or template has an unknown {token} (known: {word}, {n}, {ver}, {date}, {any})." }
  );

const ProjectSpecSchema = z
  .object({
    bits_per_channel: z.union([z.literal(8), z.literal(16), z.literal(32)]).optional(),
    working_space: z.string().min(1).max(100).optional().describe("The working colour space's name as AE reports it (e.g. \"sRGB IEC61966-2.1\")."),
    linear_blending: z.boolean().optional(),
    expression_engine: z.string().min(1).max(50).optional().describe("\"extendscript\" or \"javascript-1.0\"."),
  })
  .describe("What the project's colour and expression settings should be (from the brief or the render template). Differences become warnings. Comps and footage have no settings of their own, so these project-level values are all there is to check.");

export const AePreflightSchema = z.object({
  scope: z
    .enum(["delivery", "health"])
    .optional()
    .describe("delivery (default): the gate before a render, with blockers, warnings and notes. health: the scale map (counts per comp, heaviest comps, nesting, duplicate footage, huge comps, renderers) plus the same findings."),
  comp_ids: z.array(z.number().int()).min(1).max(50).optional().describe("Check only these comps and the comps they nest. Default: the comps in the render queue (delivery, when the queue has items) or every comp."),
  comp_names: z.array(z.string().min(1).max(200)).min(1).max(50).optional().describe("Same as comp_ids, by name (the first comp of that name; a duplicate name is reported)."),
  force_eval: z
    .boolean()
    .optional()
    .describe("Force every expression to evaluate at its comp's current time before reading its error (slower; time is not moved). Without it only the error state AE already holds is read, which can miss expressions AE has not run yet. Use it for the comps you are about to render."),
  check_title_safe: z.boolean().optional().describe("Check text layers of the final comps against title safe at the comp's current time. Default true for delivery, false for health."),
  title_safe: z.number().min(0).max(0.5).optional().describe("Share of width and height left as margin, both sides together. Default 0.2, AE's."),
  naming: NamingSchema.optional().describe("Naming rules. Default: flag AE's default names (\"Comp 1\", \"Solid 2\") on comps, footage and layers."),
  project_spec: ProjectSpecSchema.optional(),
  top: z.number().int().min(1).max(50).optional().describe("How many of the heaviest comps health lists. Default 10."),
  max_nesting: z.number().int().min(1).max(20).optional().describe("Comps that nest more levels of comps than this are noted (health). Default 5."),
  cursor: z
    .string()
    .regex(/^pf_[0-9a-f]{10}$/)
    .optional()
    .describe("Continue an unfinished scan with the cursor an earlier call returned. Every other option except max_slices and budget_ms is then taken from that scan."),
  max_slices: z.number().int().min(1).max(400).optional().describe("Most host reads in this call (each reads up to 150 items or 30 layers). Default 60. A bigger project returns a cursor."),
  budget_ms: z.number().int().min(1000).max(110000).optional().describe("Stop starting new reads after this many milliseconds. A read in flight is never abandoned. Default 40000."),
});

export type AePreflightArgs = z.infer<typeof AePreflightSchema>;

export function normaliseOptions(args: Pick<AePreflightArgs, "scope" | "comp_ids" | "comp_names" | "force_eval" | "check_title_safe" | "title_safe" | "naming" | "project_spec" | "top" | "max_nesting">, planned_output?: string): ScanOptions {
  const scope = args.scope ?? "delivery";
  return {
    scope,
    comp_ids: args.comp_ids,
    comp_names: args.comp_names,
    force_eval: args.force_eval === true,
    check_title_safe: args.check_title_safe ?? scope === "delivery",
    title_safe: args.title_safe ?? 0.2,
    naming: args.naming ?? {},
    project_spec: args.project_spec,
    top: args.top ?? 10,
    max_nesting: args.max_nesting ?? 5,
    planned_output,
  };
}

// ---------- the gate for the render tools ----------

export interface GateOptions {
  toolName: string;
  opId: string;
  comp_ids?: number[];
  comp_names?: string[];
  planned_output?: string;
}

export interface GateSummary {
  verdict: "blocked" | "warnings" | "clear" | "incomplete";
  complete: boolean;
  counts: Record<Severity, number>;
  blockers: Finding[];
  warnings: Finding[];
  comps_checked: number;
  expressions: string;
  note?: string;
}

/**
 * The delivery scan for ae_render_queue_add and ae_aerender_start. Runs
 * inside the caller's queue lease (evalRaw, not callHost) and never writes.
 * A scan that does not finish in its limits is reported incomplete, not blocked.
 */
export async function runPreflightGate(ctx: ToolContext, o: GateOptions): Promise<{ blocked: boolean; summary: GateSummary }> {
  // Items already in the queue are not the caller's concern here: the tool brings its own output (aerender's -output overrides too).
  const opts: ScanOptions = { ...normaliseOptions({ scope: "delivery", comp_ids: o.comp_ids, comp_names: o.comp_names, force_eval: true }, o.planned_output), check_queue_outputs: false };
  const state = newScanState(opts);
  const call = makeScanCall(ctx, o.opId, o.toolName);
  const { complete } = await runScan(state, call, { maxSlices: 300, deadline: Date.now() + 60_000 });
  const findings = buildFindings(state);
  const counts = countSeverities(findings);
  const summary: GateSummary = {
    verdict: counts.blocker > 0 ? "blocked" : !complete ? "incomplete" : counts.warning > 0 ? "warnings" : "clear",
    complete,
    counts,
    blockers: findings.filter((f) => f.severity === "blocker").slice(0, 20),
    warnings: findings.filter((f) => f.severity === "warning").slice(0, 20),
    comps_checked: state.seen.size,
    expressions: `forced evaluation of the root comps' expressions, then expressionError (${state.forced_evals} forced${state.force_capped > 0 ? `, ${state.force_capped} only read the cheap way (cap)` : ""})`,
    ...(complete ? {} : { note: "The preflight did not finish within its limits; run ae_preflight to read the rest." }),
  };
  return { blocked: counts.blocker > 0, summary };
}

/** What a render tool returns when preflight found a blocker; nothing was changed. */
export function preflightRefusal(toolName: string, summary: GateSummary) {
  return {
    ok: false as const,
    error: "preflight_blocked",
    kind: "preflight",
    applied: false as const,
    message: `${toolName} refused: preflight found ${summary.counts.blocker} blocker${summary.counts.blocker === 1 ? "" : "s"}. Nothing was changed. Fix them (each names its tool) or call again without preflight.`,
    preflight: summary,
  };
}

// ---------- tool ----------

export const preflightTools: ToolDefinition<any>[] = [
  {
    name: "ae_preflight",
    description:
      "One read-only check before a render. scope 'delivery' (default) is the gate: missing or placeholder footage, proxies left on, missing fonts, glyphs a text's font lacks (code glyphs_missing, a warning: missing characters such as Turkish letters would render as empty boxes; AE 25.1+, otherwise reported as not checked), effects that are not installed (heuristic, low confidence), expressions in error, text outside title safe, " +
      "default or badly named comps, footage and layers (AE's English defaults like 'Comp 1', or your template/pattern), duplicate comp names, render-queue items without an output file or whose folder is missing, and unsaved changes. " +
      "Each finding is a blocker, warning or note with the layer/item it is on and the tool that fixes it. scope 'health' is the scale map: counts per comp, the heaviest comps, nesting depth, duplicate footage paths, huge comps, the renderer per comp, " +
      "the project's colour settings (checked against project_spec when given). It reads in slices and keeps going under a cursor, so a 5000-item project never runs one long script; if the result has a cursor, call again with it. " +
      "Expressions: by default only the error state AE already holds is read; force_eval makes AE evaluate each one first. ae_render_queue_add and ae_aerender_start take preflight: true to run this and refuse on a blocker. " +
      "Changes nothing in After Effects.",
    schema: AePreflightSchema,
    handler: async (args: AePreflightArgs, ctx: ToolContext) => {
      const opId = ctx.bridge.newOpId();
      const limits: ScanLimits = { maxSlices: args.max_slices ?? 60, deadline: Date.now() + (args.budget_ms ?? 40000) };
      try {
        return await ctx.queue.run("ae_preflight", async () => {
          const call = makeScanCall(ctx, opId, "ae_preflight");
          let state: ScanState;
          if (args.cursor !== undefined) {
            expireSessions(Date.now());
            const stored = sessions.get(args.cursor);
            if (!stored) {
              return { ok: false, error: "cursor_unknown", message: "No scan with that cursor (it finished, expired after 15 minutes, or the panel restarted). Start again without a cursor." };
            }
            const here = await call<{ project_path: string }>("status", {}, "status");
            if (stored.project && here.project_path !== stored.project.project_path) {
              sessions.delete(args.cursor);
              return { ok: false, error: "cursor_stale", message: `The open project changed (was ${stored.project.project_path}, now ${here.project_path}). Start again without a cursor.` };
            }
            state = stored;
            state.last_used = Date.now();
            // Re-insert so the Map order is least recently used first.
            sessions.delete(state.id);
            sessions.set(state.id, state);
          } else {
            state = newScanState(normaliseOptions(args));
          }
          const { complete, slices } = await runScan(state, call, limits);
          if (complete) sessions.delete(state.id);
          else {
            state.last_used = Date.now();
            if (!sessions.has(state.id)) {
              expireSessions(Date.now());
              makeRoom();
            }
            sessions.delete(state.id);
            sessions.set(state.id, state);
          }
          return buildReport(state, complete, slices);
        });
      } catch (err) {
        if (err instanceof QueueWaitError) throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        throw err;
      }
    },
  },
];
