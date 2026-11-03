/**
 * server/src/tools/ext/interpret.ts
 *
 * Footage interpretation and proxies, without the Interpret Footage dialog:
 * - ae_get_footage_interpretation: read-only audit of every footage item's
 *   alpha, field, pulldown, frame rate, loop, pixel aspect and proxy settings,
 *   with findings for the usual causes of fringing and stutter
 * - ae_set_footage_interpretation: guarded write of those settings on one
 *   item, in dependency order (fields, then pulldown, then conform rate),
 *   with guessAlphaMode / guessPulldown
 * - ae_footage_proxy: guarded write that sets a file, sequence or solid as an
 *   item's proxy, clears it, or switches useProxy
 *
 * Not built, because the Scripting Guide has no API for them: per-footage
 * colour profiles (only the project's working space is scriptable) and
 * "Create Proxy" (a menu command that does nothing through CEP). Stage a
 * proxy by queueing a render with ae_render_queue_add, checking it with
 * ae_verify_render, then pointing ae_footage_proxy at the output.
 */

import { z } from "zod";
import type { ReceiptMismatch } from "../../receipts.js";
import { AGENT_SAFETY_GUIDANCE, ExpectSchema, type ToolDefinition } from "../common.js";
import { expectThat, runGuardedWrite } from "./write-runner.js";

// ---------- read shape ----------

export interface ProxyInfo {
  kind: string;
  file?: string;
  missing?: boolean;
  color?: number[];
  is_still?: boolean;
  has_alpha?: boolean;
}

export interface FootageInterp {
  id: number;
  name?: string;
  error?: string;
  kind?: string;
  width?: number;
  height?: number;
  file?: string;
  missing?: boolean;
  has_video?: boolean;
  is_still?: boolean;
  has_alpha?: boolean;
  alpha_mode?: string;
  premul_color?: number[];
  invert_alpha?: boolean;
  field_separation?: string;
  high_quality_field_separation?: boolean;
  remove_pulldown?: string;
  conform_frame_rate?: number;
  native_frame_rate?: number;
  display_frame_rate?: number;
  loop?: number;
  pixel_aspect?: number;
  use_proxy?: boolean;
  proxy?: ProxyInfo | null;
  /** Fields this AE build would not let the host read. */
  unreadable?: string[];
}

export interface RenderQueueProxy {
  key_found: boolean;
  truncated: boolean;
  error?: string;
  items: Array<{ index: number; comp?: string; status?: string; proxy_use?: string; settings_unreadable?: boolean }>;
}

export interface InterpretRead {
  items: FootageInterp[];
  total_items?: number;
  truncated?: boolean;
  skipped?: { solid: number; placeholder: number };
  render_queue?: RenderQueueProxy;
  colour_probe?: { checked: number; matches: string[]; error?: string };
}

const readOf = (v: unknown): InterpretRead | null => (v && typeof v === "object" && Array.isArray((v as InterpretRead).items) ? (v as InterpretRead) : null);
const itemOf = (read: InterpretRead | null, id: unknown) => read?.items.find((i) => i.id === id);

// ---------- findings (pure) ----------

export interface Finding {
  code: string;
  severity: "warn" | "info";
  message: string;
  fix?: { tool: string; args: Record<string, unknown> };
}

/** Pairs where a clip is conformed to its rounded-off rate, which drifts out of sync or stutters. */
const ROUNDED_RATES: Array<[number, number]> = [
  [23.976, 24],
  [29.97, 30],
  [59.94, 60],
  [47.952, 48],
  [119.88, 120],
];

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** Frame sizes that are square-pixel in practice; a non-square pixel aspect on these is nearly always a mistake. */
const SQUARE_SIZES = new Set(["1920x1080", "3840x2160", "1280x720", "4096x2160", "2560x1440", "7680x4320", "1080x1920", "2160x3840", "720x1280"]);

/** Everything wrong or worth knowing about one item's interpretation. Pure: no AE needed. */
export function interpretationFindings(it: FootageInterp): Finding[] {
  const out: Finding[] = [];
  if (it.error || it.kind !== "file") {
    if (it.proxy && it.use_proxy) {
      out.push({ code: "proxy_in_use", severity: "warn", message: `"${it.name}" has its proxy switched on${it.proxy.file ? ` (${it.proxy.file})` : ""}. Switch it off before the final render.`, fix: { tool: "ae_footage_proxy", args: { item_ids: [it.id], action: "use_off" } } });
    }
    return out;
  }
  const name = it.name ?? `#${it.id}`;
  if (it.has_alpha && it.alpha_mode === "ignore") {
    out.push({
      code: "alpha_ignored",
      severity: "warn",
      message: `"${name}" has an alpha channel but AE is set to ignore it, so it renders as an opaque plate.`,
      fix: { tool: "ae_set_footage_interpretation", args: { item_id: it.id, alpha: { mode: "guess" } } },
    });
  }
  if (it.has_alpha && it.invert_alpha && it.alpha_mode !== "ignore") {
    out.push({ code: "alpha_inverted", severity: "info", message: `"${name}" has its alpha inverted. Right only if the matte was exported that way.`, fix: { tool: "ae_set_footage_interpretation", args: { item_id: it.id, alpha: { invert: false } } } });
  }
  const native = it.native_frame_rate;
  const conform = it.conform_frame_rate;
  if (native !== undefined && conform !== undefined && conform > 0 && !near(native, conform, 0.0005)) {
    const rounded = ROUNDED_RATES.some(([n, c]) => near(native, n, 0.01) && near(conform, c, 0.0005));
    if (rounded) {
      out.push({
        code: "conform_rounded",
        severity: "warn",
        message: `"${name}" is ${native} fps but conformed to ${conform}: it plays ${((conform / native - 1) * 100).toFixed(2)}% fast and drifts from its audio.`,
        fix: { tool: "ae_set_footage_interpretation", args: { item_id: it.id, conform_frame_rate: 0 } },
      });
    } else {
      out.push({ code: "conform_changed", severity: "info", message: `"${name}" is ${native} fps but conformed to ${conform}, which changes its length.` });
    }
  }
  if (it.loop !== undefined && it.loop > 1) {
    out.push({ code: "loop_set", severity: "info", message: `"${name}" loops ${it.loop} times, so it is ${it.loop}x as long in comps.`, fix: { tool: "ae_set_footage_interpretation", args: { item_id: it.id, loop: 1 } } });
  }
  if (it.field_separation !== undefined && it.field_separation !== "off") {
    const tall = (it.height ?? 0) >= 2160;
    out.push({
      code: tall ? "fields_on_uhd" : "fields_on",
      severity: tall ? "warn" : "info",
      message: tall ? `"${name}" has field separation on at ${it.width}x${it.height}, which is almost never interlaced.` : `"${name}" is field-separated (${it.field_separation}). Right only for interlaced footage.`,
      fix: tall ? { tool: "ae_set_footage_interpretation", args: { item_id: it.id, field_separation: "off" } } : undefined,
    });
  }
  if (it.remove_pulldown !== undefined && it.remove_pulldown !== "off") {
    out.push({ code: "pulldown_removed", severity: "info", message: `"${name}" has a pulldown removed (${it.remove_pulldown}); its displayed frame rate is ${it.display_frame_rate ?? "unknown"}.` });
  }
  if (it.pixel_aspect !== undefined && it.pixel_aspect !== 1 && it.width && it.height && SQUARE_SIZES.has(`${it.width}x${it.height}`)) {
    out.push({
      code: "pixel_aspect_non_square",
      severity: "warn",
      message: `"${name}" is ${it.width}x${it.height} but has pixel aspect ${it.pixel_aspect}; media at this size is square-pixel.`,
      fix: { tool: "ae_set_footage_interpretation", args: { item_id: it.id, pixel_aspect: 1 } },
    });
  }
  if (it.proxy && it.use_proxy) {
    out.push({ code: "proxy_in_use", severity: "warn", message: `"${name}" has its proxy switched on${it.proxy.file ? ` (${it.proxy.file})` : ""}. Switch it off before the final render.`, fix: { tool: "ae_footage_proxy", args: { item_ids: [it.id], action: "use_off" } } });
  }
  if (it.proxy?.missing) {
    out.push({ code: "proxy_missing", severity: "warn", message: `The proxy file of "${name}" is missing${it.proxy.file ? `: ${it.proxy.file}` : ""}.` });
  }
  if (it.missing) {
    out.push({ code: "footage_missing", severity: "warn", message: `"${name}" is missing its file.` });
  }
  return out;
}

/** Whether a render queue "Proxy Use" value lets proxies into the render. */
const rendersWithProxies = (v: string | undefined) => v !== undefined && !/no proxies/i.test(v);
const compsOnly = (v: string | undefined) => v !== undefined && /comp proxies only/i.test(v);
/** Statuses of render queue items that will actually render; unqueued, needs-output, stopped and done ones will not. */
const WILL_RENDER = new Set(["queued", "rendering", "will_continue"]);

/** Render queue items that would render with proxies while some footage has its proxy on. */
export function renderQueueFindings(read: InterpretRead): Finding[] {
  const rq = read.render_queue;
  if (!rq) return [];
  const out: Finding[] = [];
  const anyOn = read.items.some((i) => i.use_proxy === true && i.proxy);
  const anyCompOn = read.items.some((i) => i.kind === "comp" && i.use_proxy === true && i.proxy);
  if (rq.items.length > 0 && !rq.key_found) {
    out.push({ code: "proxy_use_unreadable", severity: "info", message: "This AE did not answer to the 'Proxy Use' render setting, so queued renders could not be checked for proxies." });
    return out;
  }
  if (!anyOn) return out;
  for (const q of rq.items) {
    if (!rendersWithProxies(q.proxy_use) || (q.status !== undefined && !WILL_RENDER.has(q.status.toLowerCase()))) continue;
    // "Use Comp Proxies Only" ignores footage proxies.
    if (compsOnly(q.proxy_use) && !anyCompOn) continue;
    {
      out.push({ code: "queue_uses_proxies", severity: "warn", message: `Render queue item ${q.index}${q.comp ? ` ("${q.comp}")` : ""} has Proxy Use "${q.proxy_use}" while footage has its proxy on: it would render from proxies.` });
    }
  }
  return out;
}

// ---------- schemas ----------

const ALPHA_MODES = ["ignore", "straight", "premultiplied", "guess"] as const;
const FIELD_MODES = ["off", "upper_field_first", "lower_field_first"] as const;
const PULLDOWN_PHASES = [
  "off",
  "wssww",
  "sswww",
  "swwws",
  "wwwss",
  "wwssw",
  "wssww_24p_advance",
  "sswww_24p_advance",
  "swwws_24p_advance",
  "wwwss_24p_advance",
  "wwssw_24p_advance",
] as const;
const PULLDOWN_CHOICES = [...PULLDOWN_PHASES, "guess_3_2", "guess_24p_advance"] as const;
const PROXY_ACTIONS = ["set_file", "set_sequence", "set_solid", "clear", "use_on", "use_off"] as const;

const Color = z.array(z.number().min(0).max(1)).length(3);

export const AeGetFootageInterpretationSchema = z.object({
  item_ids: z
    .array(z.number().int())
    .min(1)
    .max(500)
    .optional()
    .describe("Project item ids to read (footage, or comps to see their proxy). Default: every footage item that comes from a file, plus comps that carry a proxy."),
  only_findings: z.boolean().optional().describe("List only the items that have findings."),
  include_render_queue: z.boolean().optional().describe("Also read each render queue item's 'Proxy Use' setting. Default true."),
  probe_colour: z
    .boolean()
    .optional()
    .describe("Probe only: list properties on the first footage source whose names look like colour-profile settings. The Scripting Guide documents none, so expect an empty list."),
});

const AlphaSchema = z
  .object({
    mode: z
      .enum(ALPHA_MODES)
      .optional()
      .describe("ignore, straight, premultiplied (with premul_color as the matte colour), or guess (AE's guessAlphaMode, which also sets the colour and invert)."),
    premul_color: Color.optional().describe("Matte colour [r, g, b] in 0..1 for premultiplied alpha. Needs mode premultiplied (or footage already premultiplied)."),
    invert: z.boolean().optional().describe("Invert the alpha. Has no effect while alpha is ignored."),
  })
  .refine((a) => a.mode !== undefined || a.premul_color !== undefined || a.invert !== undefined, { message: "Give at least one of mode, premul_color or invert." })
  .refine((a) => a.mode !== "guess" || (a.premul_color === undefined && a.invert === undefined), { message: "mode 'guess' sets the colour and invert itself; give it alone." })
  .refine((a) => a.premul_color === undefined || a.mode === undefined || a.mode === "premultiplied", { message: "premul_color goes with mode 'premultiplied'." })
  .refine((a) => a.invert === undefined || a.mode !== "ignore", { message: "invert has no effect while alpha is ignored." })
  .describe("Alpha interpretation. Only for footage that has an alpha channel.");

export const AeSetFootageInterpretationSchema = z
  .object({
    item_id: z.number().int().describe("Project item id of the footage (from a file; not a solid or placeholder)."),
    alpha: AlphaSchema.optional(),
    field_separation: z.enum(FIELD_MODES).optional().describe("Field order of interlaced footage. Not for stills."),
    high_quality_field_separation: z.boolean().optional().describe("High quality field separation. Needs field separation on."),
    pulldown: z
      .enum(PULLDOWN_CHOICES)
      .optional()
      .describe(
        "Pulldown phase to remove ('off' removes none), or 'guess_3_2' / 'guess_24p_advance' to let AE guess (it sets the fields and frame rate itself, so run it alone). " +
          "A phase needs field separation on; the tool sets the order fields, then pulldown, then conform rate."
      ),
    conform_frame_rate: z.number().min(0).max(99).optional().describe("Conform to this frame rate; 0 = the footage's own rate (not while a pulldown is removed). 29.97 footage conformed to 30 plays fast."),
    loop: z.number().int().min(1).max(9999).optional().describe("How many times the footage loops. Not for stills."),
    pixel_aspect: z.number().min(0.01).max(100).optional().describe("Pixel aspect ratio, 1 = square."),
    expect: ExpectSchema,
  })
  .refine(
    (v) =>
      v.alpha !== undefined ||
      v.field_separation !== undefined ||
      v.high_quality_field_separation !== undefined ||
      v.pulldown !== undefined ||
      v.conform_frame_rate !== undefined ||
      v.loop !== undefined ||
      v.pixel_aspect !== undefined,
    { message: "Give at least one setting to change." }
  )
  .refine(
    (v) =>
      !(v.pulldown === "guess_3_2" || v.pulldown === "guess_24p_advance") ||
      (v.field_separation === undefined && v.high_quality_field_separation === undefined && v.conform_frame_rate === undefined),
    { message: "A pulldown 'guess' sets the fields and frame rate itself; run it alone, then adjust in a second call." }
  );

export const AeFootageProxySchema = z
  .object({
    item_ids: z.array(z.number().int()).min(1).max(100).describe("Project item ids (footage or comps). Setting a proxy takes exactly one."),
    action: z
      .enum(PROXY_ACTIONS)
      .describe("set_file: a file is the proxy. set_sequence: the first file of an image sequence. set_solid: a solid placeholder. clear: no proxy. use_on / use_off: switch useProxy."),
    file: z.string().min(1).max(4000).optional().describe("Absolute path of the proxy file (set_file, set_sequence). It must exist."),
    force_alphabetical: z.boolean().optional().describe("set_sequence: import in alphabetical order. Default false: numbered order, as AE's Import dialog does."),
    solid: z
      .object({
        color: Color,
        width: z.number().int().min(1).max(30000),
        height: z.number().int().min(1).max(30000),
        name: z.string().min(1).max(200).optional(),
        pixel_aspect: z.number().min(0.01).max(100).optional(),
      })
      .optional()
      .describe("set_solid: the solid's colour and size."),
    use_proxy: z.boolean().optional().describe("With a set_ action: also switch useProxy to this. Default: After Effects switches useProxy ON for any set_ action (SetProxy* sets it true), so the new proxy is in use at once; pass false to keep it off."),
    expect: ExpectSchema,
  })
  .refine((v) => (v.action === "set_file" || v.action === "set_sequence" ? v.file !== undefined : true), { message: "set_file and set_sequence need file." })
  .refine((v) => v.action !== "set_solid" || v.solid !== undefined, { message: "set_solid needs solid." })
  .refine((v) => v.file === undefined || v.action === "set_file" || v.action === "set_sequence", { message: "file applies to set_file and set_sequence only." })
  .refine((v) => v.solid === undefined || v.action === "set_solid", { message: "solid applies to set_solid only." })
  .refine((v) => (v.action.startsWith("set_") ? v.item_ids.length === 1 : true), { message: "A proxy is set on one item at a time." })
  .refine((v) => v.use_proxy === undefined || v.action.startsWith("set_"), { message: "use_proxy goes with a set_ action; use use_on / use_off otherwise." });

// ---------- receipt checks (pure) ----------

type SetArgs = z.infer<typeof AeSetFootageInterpretationSchema>;
type ProxyArgs = z.infer<typeof AeFootageProxySchema>;

const sameColor = (a: number[] | undefined, b: number[]) => !!a && a.length >= 3 && b.every((v, i) => Math.abs(a[i] - v) <= 1e-3);

export function interpretMismatches(args: SetArgs, beforeRaw: unknown, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = itemOf(readOf(beforeRaw), args.item_id);
  const after = itemOf(readOf(afterRaw), args.item_id);
  if (!after || after.error) {
    m.push({ path: "item", expected: args.item_id, actual: undefined, message: "The footage item is not in the read-back" });
    return m;
  }
  const unread = (field: string) => after.unreadable?.includes(field) === true;
  const a = args.alpha;
  if (a && a.mode !== "guess") {
    if (a.mode !== undefined) expectThat(m, after.alpha_mode === a.mode, "alpha_mode", a.mode, after.alpha_mode, "Alpha mode differs");
    if (a.premul_color !== undefined) expectThat(m, sameColor(after.premul_color, a.premul_color), "premul_color", a.premul_color, after.premul_color, "Premultiply colour differs");
    if (a.invert !== undefined) expectThat(m, after.invert_alpha === a.invert, "invert_alpha", a.invert, after.invert_alpha, "Alpha invert differs");
  }
  if (args.field_separation !== undefined) expectThat(m, after.field_separation === args.field_separation, "field_separation", args.field_separation, after.field_separation, "Field separation differs");
  if (args.high_quality_field_separation !== undefined) {
    expectThat(m, after.high_quality_field_separation === args.high_quality_field_separation, "high_quality_field_separation", args.high_quality_field_separation, after.high_quality_field_separation, "High quality field separation differs");
  }
  if (args.pulldown !== undefined && !args.pulldown.startsWith("guess_")) {
    expectThat(m, after.remove_pulldown === args.pulldown, "remove_pulldown", args.pulldown, after.remove_pulldown, "Pulldown differs");
  }
  if (args.conform_frame_rate !== undefined) {
    // The Scripting Guide doesn't say what 0 reads back as: accept 0 or the native rate.
    const nativeOk = args.conform_frame_rate === 0 && after.conform_frame_rate !== undefined && after.native_frame_rate !== undefined && Math.abs(after.conform_frame_rate - after.native_frame_rate) <= 1e-3;
    expectThat(m, nativeOk || (after.conform_frame_rate !== undefined && Math.abs(after.conform_frame_rate - args.conform_frame_rate) <= 1e-3), "conform_frame_rate", args.conform_frame_rate, after.conform_frame_rate, "Conform frame rate differs");
  }
  if (args.loop !== undefined) expectThat(m, after.loop === args.loop, "loop", args.loop, after.loop, "Loop count differs");
  if (args.pixel_aspect !== undefined) {
    expectThat(m, after.pixel_aspect !== undefined && Math.abs(after.pixel_aspect - args.pixel_aspect) <= 1e-4, "pixel_aspect", args.pixel_aspect, after.pixel_aspect, "Pixel aspect differs (AE may refuse it on this footage)");
  }
  // What was not asked for stays as it was. Fields the host could not read are skipped.
  if (before && !before.error) {
    if (args.loop === undefined && !unread("loop") && before.loop !== after.loop) m.push({ path: "loop", expected: before.loop, actual: after.loop, message: "The loop count changed though it was not asked for" });
    if (args.pixel_aspect === undefined && !unread("pixel_aspect") && before.pixel_aspect !== after.pixel_aspect) {
      m.push({ path: "pixel_aspect", expected: before.pixel_aspect, actual: after.pixel_aspect, message: "The pixel aspect changed though it was not asked for" });
    }
    if (!args.alpha && !unread("alpha_mode") && before.alpha_mode !== after.alpha_mode) m.push({ path: "alpha_mode", expected: before.alpha_mode, actual: after.alpha_mode, message: "The alpha mode changed though it was not asked for" });
    if (!args.alpha) {
      if (!unread("invert_alpha") && before.invert_alpha !== after.invert_alpha) m.push({ path: "invert_alpha", expected: before.invert_alpha, actual: after.invert_alpha, message: "The alpha invert changed though it was not asked for" });
      if (!unread("premul_color") && before.premul_color !== undefined && after.premul_color !== undefined && !sameColor(after.premul_color, before.premul_color)) {
        m.push({ path: "premul_color", expected: before.premul_color, actual: after.premul_color, message: "The premultiply colour changed though it was not asked for" });
      }
    }
    // Fields, pulldown and conform rate can move each other, so they are only frozen when none of them was asked for.
    if (args.field_separation === undefined && args.pulldown === undefined && args.conform_frame_rate === undefined) {
      if (!unread("field_separation") && before.field_separation !== after.field_separation) m.push({ path: "field_separation", expected: before.field_separation, actual: after.field_separation, message: "Field separation changed though it was not asked for" });
      if (!unread("remove_pulldown") && before.remove_pulldown !== after.remove_pulldown) m.push({ path: "remove_pulldown", expected: before.remove_pulldown, actual: after.remove_pulldown, message: "The pulldown changed though it was not asked for" });
      if (!unread("conform_frame_rate") && before.conform_frame_rate !== undefined && after.conform_frame_rate !== undefined && Math.abs(before.conform_frame_rate - after.conform_frame_rate) > 1e-3) {
        m.push({ path: "conform_frame_rate", expected: before.conform_frame_rate, actual: after.conform_frame_rate, message: "The conform frame rate changed though it was not asked for" });
      }
    }
    if (before.use_proxy !== after.use_proxy) m.push({ path: "use_proxy", expected: before.use_proxy, actual: after.use_proxy, message: "useProxy changed though it was not asked for" });
  }
  return m;
}

const normPath = (p: string | undefined) => (p ?? "").replace(/\\/g, "/").toLowerCase();

export function proxyMismatches(args: ProxyArgs, beforeRaw: unknown, afterRaw: unknown): ReceiptMismatch[] {
  const m: ReceiptMismatch[] = [];
  const before = readOf(beforeRaw);
  const after = readOf(afterRaw);
  if (!after) return m;
  for (const id of args.item_ids) {
    const now = itemOf(after, id);
    if (!now || now.error) {
      m.push({ path: `items[${id}]`, expected: id, actual: undefined, message: "The item is not in the read-back" });
      continue;
    }
    const was = itemOf(before, id);
    // Items already in the wanted state were skipped on purpose; they still have to be in that state.
    if (args.action === "use_on") expectThat(m, now.use_proxy === true, `items[${id}].use_proxy`, true, now.use_proxy, "useProxy is not on");
    else if (args.action === "use_off") expectThat(m, now.use_proxy === false, `items[${id}].use_proxy`, false, now.use_proxy, "useProxy is not off");
    else if (args.action === "clear") expectThat(m, !now.proxy, `items[${id}].proxy`, null, now.proxy, "The item still has a proxy");
    else {
      if (args.action === "set_solid") {
        expectThat(m, now.proxy?.kind === "solid", `items[${id}].proxy.kind`, "solid", now.proxy?.kind, "The proxy is not a solid");
      } else {
        expectThat(m, now.proxy?.kind === "file", `items[${id}].proxy.kind`, "file", now.proxy?.kind, "The item has no file proxy");
        if (args.action === "set_file" && now.proxy?.file !== undefined) {
          expectThat(m, normPath(now.proxy.file) === normPath(args.file), `items[${id}].proxy.file`, args.file, now.proxy.file, "The proxy is another file");
        }
      }
      if (args.use_proxy !== undefined) expectThat(m, now.use_proxy === args.use_proxy, `items[${id}].use_proxy`, args.use_proxy, now.use_proxy, "useProxy differs");
    }
    // Switching useProxy never removes the proxy.
    if (was && (args.action === "use_on" || args.action === "use_off") && was.proxy && !now.proxy) {
      m.push({ path: `items[${id}].proxy`, expected: was.proxy, actual: now.proxy, message: "The proxy was removed though it was not asked for" });
    }
  }
  return m;
}

// ---------- tools ----------

const readCall = (itemIds: number[]) => ({ host: "interpretRead", args: { item_ids: itemIds, include_render_queue: false } });

export const interpretTools: ToolDefinition<any>[] = [
  {
    name: "ae_get_footage_interpretation",
    description:
      "Audit how After Effects interprets the project's footage, without opening Interpret Footage: alpha mode (ignore, straight, premultiplied with its matte colour), alpha invert, field separation and order, pulldown, conform / native / display frame rate, loop, pixel aspect, and each item's proxy (file, solid, missing) and whether it is switched on. " +
      "Each item carries `findings` for the usual causes of edge fringing and stutter: alpha ignored on a clip that has alpha, 29.97 conformed to 30 (or 23.976 to 24), a stray loop, fields on UHD, a non-square pixel aspect on HD or UHD media, and proxies left on. " +
      "With the render queue read (default), it also flags queued items whose 'Proxy Use' setting would render from proxies while footage has its proxy on. Fields a still or this AE build can't read are listed in `unreadable`. " +
      "Lists 500 items at most (`truncated`); solids and placeholders are counted in `skipped`. Changes nothing in After Effects. Colour profiles per footage are not scriptable (only the project's working space is); `probe_colour` lists any colour-looking property names on the first source.",
    schema: AeGetFootageInterpretationSchema,
    handler: async (args: z.infer<typeof AeGetFootageInterpretationSchema>, ctx) => {
      const res = await ctx.bridge.callHost<InterpretRead>(
        "interpretRead",
        { item_ids: args.item_ids, include_render_queue: args.include_render_queue, probe_colour: args.probe_colour },
        { label: "ae_get_footage_interpretation", mutates: false, toolName: "ae_get_footage_interpretation" }
      );
      const read = res.result;
      const rows = (read.items ?? []).map((item) => ({ ...item, findings: interpretationFindings(item) }));
      const shown = args.only_findings ? rows.filter((r) => r.findings.length > 0) : rows;
      const queueFindings = renderQueueFindings(read);
      const all = rows.flatMap((r) => r.findings).concat(queueFindings);
      return {
        ...read,
        items: shown,
        findings_total: all.length,
        warnings: all.filter((f) => f.severity === "warn").length,
        render_queue_findings: queueFindings,
      };
    },
  },
  {
    name: "ae_set_footage_interpretation",
    description:
      "Set a footage item's interpretation without the dialog, in one undo group guarded by `expect`: alpha (ignore, straight, premultiplied with matte colour, invert, or AE's guess), field separation and high quality, pulldown removal (a phase, or AE's 3:2 / 24p advance guess), conform frame rate, loop and pixel aspect. " +
      "Everything is checked before After Effects is touched: stills, items without alpha or video, missing files, ranges, and the order rules (a pulldown needs fields on, conform 0 needs the pulldown off). The writes then run in dependency order (fields, then pulldown, then conform), and if one throws the old values are put back. " +
      "The read-back (a separate evalScript) checks each setting and that loop, pixel aspect, alpha, fields, pulldown, conform rate and the proxy switch you did not ask for stayed as they were (conform 0 may read back as the native rate: both are accepted); the result lists `findings` for the item afterwards. " +
      "Guessing (alpha or pulldown) chooses values by looking at the footage: the receipt shows what it chose. Per-footage colour profiles are not scriptable. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSetFootageInterpretationSchema,
    handler: (args: SetArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_set_footage_interpretation",
        label: `ae_set_footage_interpretation(${args.item_id})`,
        expect: args.expect,
        read: () => readCall([args.item_id]),
        write: {
          host: "interpretApply",
          args: {
            item_id: args.item_id,
            alpha: args.alpha,
            field_separation: args.field_separation,
            high_quality_field_separation: args.high_quality_field_separation,
            pulldown: args.pulldown,
            conform_frame_rate: args.conform_frame_rate,
            loop: args.loop,
            pixel_aspect: args.pixel_aspect,
            label: "Interpret footage",
          },
        },
        check: (before, after) => interpretMismatches(args, before, after),
        present: (_before, after, w) => {
          const item = itemOf(readOf(after), args.item_id);
          return { item_id: args.item_id, changed: w.changed, no_change: w.no_change, item, findings: item ? interpretationFindings(item) : [] };
        },
      }),
  },
  {
    name: "ae_footage_proxy",
    description:
      "Set, use or clear proxies on footage or comp items, in one undo group guarded by `expect`: set_file (a file), set_sequence (an image sequence, numbered order unless force_alphabetical), set_solid (a coloured solid), clear (setProxyToNone), use_on / use_off (useProxy, for many items at once). " +
      "Like After Effects itself, any set_ action switches useProxy ON (SetProxy* sets it true) unless use_proxy: false is given, so a later render may come from the proxy until you use_off. The file must exist and the item must not be missing before After Effects is touched; use_on refuses an item with no proxy. Items already in the wanted state are skipped without an undo step. " +
      "The read-back (a separate evalScript) checks the proxy kind and file, and useProxy. " +
      "There is no scripting call for 'Create Proxy': stage a proxy by queueing a render with ae_render_queue_add, checking the output with ae_verify_render, then set_file here. Switch proxies off and run ae_preflight before the final render. " +
      "A proxy file AE can't read may raise a dialog: read it with ae_dialogs. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeFootageProxySchema,
    handler: (args: ProxyArgs, ctx) =>
      runGuardedWrite(ctx, {
        toolName: "ae_footage_proxy",
        label: `ae_footage_proxy(${args.action}, ${args.item_ids.length} item${args.item_ids.length === 1 ? "" : "s"})`,
        expect: args.expect,
        read: () => readCall(args.item_ids),
        write: {
          host: "interpretProxy",
          args: {
            item_ids: args.item_ids,
            action: args.action,
            file: args.file,
            force_alphabetical: args.force_alphabetical,
            solid: args.solid,
            use_proxy: args.use_proxy,
            label: "Footage proxy",
          },
        },
        check: (before, after) => proxyMismatches(args, before, after),
        present: (_before, after, w) => {
          const read = readOf(after);
          return {
            action: args.action,
            changed_ids: w.item_ids,
            skipped_ids: w.skipped_ids,
            no_change: w.no_change,
            items: read?.items.map((i) => ({ id: i.id, name: i.name, use_proxy: i.use_proxy, proxy: i.proxy ?? null })),
          };
        },
      }),
  },
];
