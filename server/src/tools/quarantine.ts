import { z } from "zod";
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
];
