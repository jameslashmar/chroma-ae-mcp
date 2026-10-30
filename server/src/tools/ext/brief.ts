/**
 * server/src/tools/ext/brief.ts
 *
 * Context that makes results land the first time:
 * - ae_brief: the project's brief (goal, audience, format, feel, references,
 *   brand, what not to touch), kept next to the .aep as <name>.brief.json so
 *   it travels with the project. Missing fields come back with questions to
 *   ask, ready for ae_ask_user.
 * - ae_taste: the user's own motion taste, kept across projects in
 *   settings.json; ae_motion_review follows it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { buildJsxCall, normalizeGuardPath } from "../../jsx.js";
import { BezierCurveSchema, type ToolContext, type ToolDefinition } from "../common.js";

// ---------- brief ----------

export const BriefFieldsSchema = z.object({
  goal: z.string().max(1000).optional().describe("What the piece is for and the one thing it must get across."),
  audience: z.string().max(500).optional().describe("Who watches it, and where (platform, screen)."),
  format: z
    .object({
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().positive().optional(),
      duration_s: z.number().positive().optional(),
    })
    .optional()
    .describe("Delivery size, frame rate and length."),
  feel: z.array(z.string().min(1).max(40)).max(6).optional().describe("A few words for the feel, e.g. ['confident', 'clean', 'snappy']."),
  references: z.array(z.string().min(1).max(500)).max(20).optional().describe("Links, file paths, or descriptions of work to match."),
  brand_colors: z
    .array(z.string().regex(/^#[0-9a-fA-F]{6}$/, "colors are #rrggbb"))
    .max(12)
    .optional()
    .describe("Brand colours as #rrggbb."),
  fonts: z.array(z.string().min(1).max(100)).max(6).optional(),
  do_not_change: z.array(z.string().min(1).max(300)).max(20).optional().describe("Layers, comps or decisions to leave alone."),
  notes: z.string().max(4000).optional(),
});

export type BriefFields = z.infer<typeof BriefFieldsSchema>;
export type Brief = BriefFields & { updated_at?: string };

export const AeBriefSchema = z
  .object({
    set: BriefFieldsSchema.optional().describe(
      "Fields to save. Omitted fields keep their value; an empty string or list clears one. Save only what the user said or confirmed."
    ),
    expect: z
      .object({ project_path: z.string().min(1) })
      .optional()
      .describe("Required with `set`: the open project's path, so the brief lands next to the right .aep."),
  })
  .refine((v) => !v.set || v.expect !== undefined, { message: "Saving a brief needs expect.project_path." });

const BRIEF_FIELDS = ["goal", "audience", "format", "feel", "references", "brand_colors", "fonts", "do_not_change"] as const;

/** Questions for missing fields, shaped for ae_ask_user where a choice fits and for the chat otherwise. */
export const BRIEF_QUESTIONS: Record<(typeof BRIEF_FIELDS)[number], { question: string; options?: Array<{ id: string; label: string }>; multi_select?: boolean }> = {
  goal: { question: "What is this piece for, and what is the one thing it must get across?" },
  audience: {
    question: "Who will watch it, and where?",
    options: [
      { id: "social_vertical", label: "Social, vertical (Reels, TikTok, Shorts)" },
      { id: "web_16x9", label: "YouTube or web, 16:9" },
      { id: "broadcast", label: "Broadcast or TV" },
      { id: "event", label: "Event screen or presentation" },
    ],
  },
  format: { question: "What size, frame rate and length should it be delivered at?" },
  feel: {
    question: "Which words fit the feel?",
    options: [
      { id: "calm", label: "Calm" },
      { id: "energetic", label: "Energetic" },
      { id: "playful", label: "Playful" },
      { id: "premium", label: "Premium" },
      { id: "technical", label: "Technical" },
      { id: "bold", label: "Bold" },
    ],
    multi_select: true,
  },
  references: { question: "Is there any work (links or files) it should feel like?" },
  brand_colors: { question: "Which brand colours should it use (hex codes)?" },
  fonts: { question: "Which fonts should it use?" },
  do_not_change: { question: "Is there anything I must leave alone?" },
};

export function briefPath(projectPath: string): string {
  return path.join(path.dirname(projectPath), `${path.basename(projectPath, path.extname(projectPath))}.brief.json`);
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export function readBrief(file: string): Brief | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Brief) : null;
  } catch {
    return null;
  }
}

/** Merges `patch` into `current`; empty values clear a field. */
export function mergeBrief(current: Brief | null, patch: BriefFields, now: Date): Brief {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (isEmpty(v)) delete next[k];
    else next[k] = v;
  }
  next.updated_at = now.toISOString();
  return next as Brief;
}

export function missingFields(brief: Brief | null) {
  return BRIEF_FIELDS.filter((f) => isEmpty(brief?.[f]));
}

async function openProjectPath(ctx: ToolContext): Promise<string> {
  const res = await ctx.bridge.evalRaw<{ project_path: string }>({
    id: `${ctx.bridge.newOpId()}_brief_status`,
    script: buildJsxCall("status", {}),
    label: "ae_brief (project path)",
    mutates: false,
    toolName: "ae_brief",
  });
  return res.result.project_path;
}

// ---------- taste ----------

export const AeTasteSchema = z.object({
  set: z
    .object({
      preferred_ease: BezierCurveSchema.optional().describe(
        "The user's default cubic-bezier [x1, y1, x2, y2], e.g. the one they picked with ae_ask_user. [0, 0, 1, 1] (linear) clears it."
      ),
      allow_linear_non_motion: z
        .boolean()
        .optional()
        .describe("Linear timing on opacity and effect parameters is on purpose: the review stops flagging it."),
      avoid_overshoot: z.boolean().optional().describe("The user doesn't want overshoot: the review reports it as low instead of info."),
      notes: z.string().max(2000).optional().describe("What the user has said about their taste, in their words. Replaces the earlier notes."),
    })
    .optional()
    .describe("Fields to change. Save only what the user said or confirmed."),
});

function isLinear(c: number[]): boolean {
  return c[0] === 0 && c[1] === 0 && c[2] === 1 && c[3] === 1;
}

// ---------- tools ----------

export const briefTools: ToolDefinition<any>[] = [
  {
    name: "ae_brief",
    description:
      "Read or save the open project's brief: goal, audience, format, feel, references, brand colours and fonts, and what not to change. It lives next to the .aep as <name>.brief.json, so it travels with the project. " +
      "Call it at the start of any creative job. The result lists `missing` fields with `questions`; ask the ones that matter for the task, choices through ae_ask_user (pass the question and options as given) and open questions in the chat, then save the answers with `set`. " +
      "Respect `do_not_change` in everything you do. Unsaved projects have no brief until they are saved. Never touches the AE project.",
    schema: AeBriefSchema,
    handler: async (args: z.infer<typeof AeBriefSchema>, ctx) => {
      const projectPath = await openProjectPath(ctx);
      if (projectPath === "<unsaved>") {
        return {
          ok: false,
          error: "unsaved_project",
          message: "The project has not been saved, so there is nowhere to keep a brief yet. Ask the user to save it (or keep the brief in the chat for now).",
        };
      }
      const file = briefPath(projectPath);
      let brief = readBrief(file);
      let saved = false;
      if (args.set) {
        if (normalizeGuardPath(args.expect!.project_path) !== normalizeGuardPath(projectPath)) {
          return {
            ok: false,
            error: "guard",
            message: `The open project is ${projectPath}, not ${args.expect!.project_path}. Re-read state; nothing was saved.`,
          };
        }
        brief = mergeBrief(brief, args.set, new Date());
        const tmp = `${file}.tmp-${process.pid}`;
        // Match settings.ts/quarantine.ts's tmp+rename stores: restrictive permissions,
        // not the process umask default.
        fs.writeFileSync(tmp, JSON.stringify(brief, null, 2), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, file);
        saved = true;
      }
      const missing = missingFields(brief);
      return {
        ok: true,
        project_path: projectPath,
        brief_path: file,
        exists: brief !== null,
        saved,
        brief,
        missing,
        questions: missing.map((field) => ({ field, ...BRIEF_QUESTIONS[field] })),
      };
    },
  },
  {
    name: "ae_taste",
    description:
      "Read or change the user's motion taste, kept across projects: a preferred ease curve, whether linear opacity and effect timing is deliberate, whether overshoot is unwanted, and notes in their words. " +
      "ae_motion_review follows it (its fixes use the preferred curve's handle lengths). Read it before animating so first passes already match. " +
      "Change it only on the user's word: after they pick an ease with ae_ask_user, ask whether it should become their default. Call with no arguments to read.",
    schema: AeTasteSchema,
    handler: async (args: z.infer<typeof AeTasteSchema>, ctx) => {
      if (!ctx.settings) {
        return { ok: false, error: "no_settings", message: "This server has no settings store, so taste can't be kept." };
      }
      let saved = false;
      if (args.set) {
        const patch = { ...args.set };
        if (patch.preferred_ease && isLinear(patch.preferred_ease)) {
          (patch as { preferred_ease: number[] | null }).preferred_ease = null;
        }
        ctx.settings.updateTaste(patch);
        saved = true;
      }
      return { ok: true, saved, taste: ctx.settings.get().taste, settings_path: ctx.settings.path };
    },
  },
];
