/**
 * server/src/tools/ext/ask.ts
 *
 * ae_ask_user: asks the user a question in the Chroma AE MCP panel and waits
 * for the answer. With kind "ease", each option is a cubic-bezier the panel
 * draws and previews, and the user can drag its handles before answering.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { AskAnswer, AskQuestion } from "../../asks.js";
import { BezierCurveSchema, type ToolDefinition } from "../common.js";

export const PANEL_EXTENSION_ID = "london.chroma.aemcp.panel";
export const DEFAULT_WAIT_SECONDS = 120;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const AskOptionSchema = z.object({
  id: z.string().min(1).max(40).describe("Short id returned when the user picks this option."),
  label: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
  curve: BezierCurveSchema.optional().describe(
    "cubic-bezier [x1, y1, x2, y2] (CSS convention). Required on every option of an ease question."
  ),
  image_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute path of a PNG or JPEG shown with the option, such as an ae_contact_sheet or ae_snapshot_frame of that variant."
    ),
});

export const AeAskUserSchema = z
  .object({
    ask_id: z
      .string()
      .min(1)
      .optional()
      .describe("Keep waiting for a question asked earlier (its ask_id) instead of asking a new one."),
    question: z.string().min(1).max(500).optional(),
    kind: z
      .enum(["choice", "ease"])
      .optional()
      .describe(
        "'choice' (default) shows buttons. 'ease' draws each option's curve with a moving preview and lets the user drag the handles; the answer then carries the final curve."
      ),
    options: z.array(AskOptionSchema).min(2).max(8).optional(),
    multi_select: z.boolean().optional().describe("Allow several options. Default false."),
    allow_other: z.boolean().optional().describe("Let the user type their own answer. Default true."),
    context: z
      .string()
      .max(300)
      .optional()
      .describe("One line under the question, such as which layer and keys it is about."),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(600)
      .optional()
      .describe(
        `How long to wait for the answer (default ${DEFAULT_WAIT_SECONDS}). If it runs out, the result is status 'waiting' with the ask_id; the question stays in the panel.`
      ),
  })
  .refine((v) => v.ask_id !== undefined || (v.question !== undefined && v.options !== undefined), {
    message: "Give a question and options, or the ask_id of an earlier question.",
  })
  .refine((v) => v.kind !== "ease" || (v.options ?? []).every((o) => o.curve !== undefined), {
    message: "Every option of an ease question needs a curve.",
  })
  .refine((v) => new Set((v.options ?? []).map((o) => o.id)).size === (v.options ?? []).length, {
    message: "Option ids must be unique.",
  });

export function checkImagePath(p: string): string | null {
  if (!path.isAbsolute(p)) return `image_path must be absolute: ${p}`;
  if (!/\.(png|jpe?g)$/i.test(p)) return `image_path must be a PNG or JPEG: ${p}`;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return `image_path is not a file: ${p}`;
    if (st.size > MAX_IMAGE_BYTES) return `image_path is over 8 MB: ${p}`;
  } catch {
    return `image_path does not exist: ${p}`;
  }
  return null;
}

/** What the agent gets back for a question and its answer, if any. */
export function presentAnswer(q: AskQuestion, a: AskAnswer | undefined | null) {
  if (!a) {
    return {
      status: "waiting" as const,
      ask_id: q.id,
      question: q.question,
      message:
        "No answer yet; the question stays in the panel. Call ae_ask_user with this ask_id to keep waiting, or carry on and check back later.",
    };
  }
  if (a.status === "dismissed") {
    return {
      status: "dismissed" as const,
      ask_id: q.id,
      question: q.question,
      message: "The user dismissed the question. Don't ask it again unprompted; go on with a sensible default and say which.",
    };
  }
  const byId = new Map(q.options.map((o) => [o.id, o]));
  return {
    status: "answered" as const,
    ask_id: q.id,
    question: q.question,
    chosen: a.choice_ids.map((id) => ({ id, label: byId.get(id)?.label ?? id })),
    ...(a.other ? { other: a.other } : {}),
    ...(a.curve
      ? {
          curve: a.curve,
          edited: !a.choice_ids.some((id) => sameCurve(byId.get(id)?.curve, a.curve)),
          next: "Apply it with ae_set_keyframe_ease { ease: { curve } }. Ask whether it should become the user's default; if so, save it with ae_taste.",
        }
      : {}),
    answered_after_s: Math.round((a.answered_at - q.asked_at) / 100) / 10,
  };
}

function sameCurve(a: number[] | undefined, b: number[] | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
}

export const askTools: ToolDefinition<any>[] = [
  {
    name: "ae_ask_user",
    description:
      "Ask the user a question in the Chroma AE MCP panel inside After Effects and wait for the answer. Opens the panel if it is closed. " +
      "Use it when a choice is the user's to make (a look, a timing, which variant), and show rather than describe: give each option an image (an ae_contact_sheet of that variant) or, with kind 'ease', a curve. " +
      "For eases, offer 3 or 4 distinct curves (for example gentle [0.25,0.1,0.25,1], snappy [0.2,0,0,1], expo out [0.16,1,0.3,1], anticipate [0.6,-0.28,0.74,0.05] on non-spatial properties); the user can also drag the handles, and the answer's curve goes straight into ae_set_keyframe_ease. " +
      "Ask one thing at a time. Results: 'answered' (chosen options, free text, curve), 'dismissed', or 'waiting' (call again with ask_id). Never touches the project.",
    schema: AeAskUserSchema,
    handler: async (args, ctx) => {
      const asks = ctx.asks;
      if (!asks) {
        return {
          ok: false,
          error: "panel_unavailable",
          message: "ae_ask_user needs the MCP that runs inside the After Effects panel; ask in the chat instead.",
        };
      }
      const waitMs = (args.wait_seconds ?? DEFAULT_WAIT_SECONDS) * 1000;

      if (args.ask_id) {
        const found = asks.get(args.ask_id);
        if (!found) {
          return {
            ok: false,
            error: "unknown_ask_id",
            message: "No such question. Answered questions are kept for an hour, and restarting AE clears them.",
          };
        }
        const answer = found.answer ?? (await asks.wait(args.ask_id, waitMs));
        return presentAnswer(found.question, answer);
      }

      for (const o of args.options) {
        if (o.image_path) {
          const problem = checkImagePath(o.image_path);
          if (problem) return { ok: false, error: "bad_image", message: problem };
        }
      }

      const question = asks.ask({
        question: args.question,
        kind: args.kind ?? "choice",
        options: args.options,
        multi_select: args.multi_select ?? false,
        allow_other: args.allow_other ?? true,
        ...(args.context ? { context: args.context } : {}),
      });
      if (ctx.cep) {
        try {
          await ctx.cep.openExtension(PANEL_EXTENSION_ID);
        } catch {
          // The panel may already be open; the question is queued either way.
        }
      }
      const answer = await asks.wait(question.id, waitMs);
      return presentAnswer(question, answer);
    },
  },
];
