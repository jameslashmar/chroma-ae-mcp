import { z } from "zod";
import { recentOps, RECENT_OPS_MAX } from "../idempotency.js";
import { AGENT_SAFETY_GUIDANCE, type ToolDefinition } from "./common.js";

export const AeQuarantineStatusSchema = z.object({});

export const AeAcknowledgeSchema = z.object({
  op_id: z
    .string()
    .min(1)
    .describe("The quarantined operation ID (`op_id`) to acknowledge and clear."),
  note: z
    .string()
    .min(1)
    .describe(
      "Explanation of what read tools showed about the operation's actual outcome in After Effects."
    ),
});

export const AeRecentOpsSchema = z.object({
  limit: z.number().int().min(1).max(RECENT_OPS_MAX).optional().describe("How many to list, newest first (default 20)."),
  tool: z.string().min(1).max(80).optional().describe("Only this tool's writes."),
});

export const quarantineTools: ToolDefinition<any>[] = [
  {
    name: "ae_quarantine_status",
    description:
      "Read the list of uncertain-outcome mutating operations currently in quarantine (`%LOCALAPPDATA%\\chroma-ae-mcp\\quarantine.json`). " +
      "While any op is quarantined, all mutating tools refuse to run. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeQuarantineStatusSchema,
    handler: async (_args, ctx) => {
      const entries = ctx.quarantine.list();
      return {
        quarantined: entries.length > 0,
        count: entries.length,
        entries,
      };
    },
  },
  {
    name: "ae_acknowledge",
    description:
      "Remove a timed-out operation from quarantine after calling `ae_status` and inspecting the project/comp state with read tools. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeAcknowledgeSchema,
    handler: async (args, ctx) => {
      return ctx.quarantine.acknowledge(args.op_id, args.note);
    },
  },
  {
    name: "ae_recent_ops",
    description:
      "READ-ONLY, never touches After Effects. The last writes this server ran (since it started, at most 200), newest first: tool, time, how long, outcome " +
      "(applied, no_op, partial, not_applied, unknown), op_id, the error, the idempotency_key and whether the answer was a replay. " +
      "Use it after a lost reply or a timeout to see whether a write already ran before sending it again (a resend with the same idempotency_key is safe either way).",
    schema: AeRecentOpsSchema,
    handler: async (args: z.infer<typeof AeRecentOpsSchema>) => {
      const ops = recentOps({ limit: args.limit, tool: args.tool });
      return { count: ops.length, ops };
    },
  },
];
