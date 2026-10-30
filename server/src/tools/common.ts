import { z } from "zod";
import type { AskStore } from "../asks.js";
import { BridgeError, type HostTransport } from "../host.js";
import { QuarantineBlockedError, type QuarantineStore } from "../quarantine.js";
import { boundOutput } from "../receipts.js";
import { QueueWaitError, type SingleWriterQueue } from "../queue.js";
import type { SettingsStore } from "../settings.js";

export const AGENT_SAFETY_GUIDANCE =
  "IMPORTANT: (1) Always re-read project/comp state before writing. " +
  "(2) Long synchronous loops in ExtendScript freeze After Effects' UI. " +
  "(3) Jay may be editing live in After Effects, so a target guard failure (kind: 'guard') means STOP and re-read state—do NOT retry with stale expectations.";

export const ExpectSchema = z
  .object({
    project_path: z
      .string()
      .min(1)
      .describe(
        "Expected absolute path to the open .aep project file, or '<unsaved>' if the project has not been saved yet."
      ),
    comp_id: z
      .number()
      .int()
      .optional()
      .describe(
        "Optional expected CompItem ID. If provided, app.project.itemByID(comp_id) must be a CompItem."
      ),
  })
  .describe(
    "Target guard verified before any mutation runs. Refuses with kind:'guard' on mismatch."
  );

export type ExpectGuard = z.infer<typeof ExpectSchema>;

/**
 * A CSS cubic-bezier [x1, y1, x2, y2]: x is time and y is progress across one
 * segment, both 0..1 for x; y may leave 0..1 for anticipation/overshoot. Shared
 * so animate.ts (ae_set_keyframe_ease), ask.ts (ae_ask_user's ease options) and
 * brief.ts (ae_taste's preferred_ease) validate the same bezier the same way.
 */
export const BezierCurveSchema = z
  .array(z.number())
  .length(4)
  .refine((c) => c[0] >= 0 && c[0] <= 1 && c[2] >= 0 && c[2] <= 1, {
    message: "curve x1 and x2 must be within 0..1",
  });

export const LayerSelectorSchema = z
  .object({
    index: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based layer index in the composition."),
    name: z.string().min(1).optional().describe("Layer name."),
    id: z.number().int().optional().describe("Unique layer ID."),
  })
  .refine(
    (val) =>
      val.index !== undefined || val.name !== undefined || val.id !== undefined,
    {
      message: "Layer selector must specify at least one of: index, name, or id.",
    }
  )
  .describe("Identifies a layer within a composition by id, index, or name.");

export type LayerSelector = z.infer<typeof LayerSelectorSchema>;

export interface CepExtensionInfo {
  id: string;
  name: string;
  mainPath?: string;
  type?: string;
}

export interface CepBridge {
  listExtensions(): Promise<CepExtensionInfo[]> | CepExtensionInfo[];
  openExtension(id: string): Promise<boolean> | boolean;
}

export interface ToolContext {
  bridge: HostTransport;
  queue: SingleWriterQueue;
  quarantine: QuarantineStore;
  cep?: CepBridge;
  /** Server settings (auto checkpoints). Without it, the defaults apply. */
  settings?: SettingsStore;
  /** Questions for the user, shown in the panel. Only the panel-hosted MCP has it. */
  asks?: AskStore;
}

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (
    args: z.infer<TSchema>,
    ctx: ToolContext
  ) => Promise<Record<string, unknown> | unknown>;
}

export function formatToolResponse(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const bounded = boundOutput(data);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(bounded, null, 2),
      },
    ],
  };
}

export function formatToolError(err: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  if (err instanceof BridgeError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(err.toJSON(), null, 2),
        },
      ],
    };
  }
  if (err instanceof QuarantineBlockedError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              kind: err.kind,
              message: err.message,
              quarantine: err.entries,
            },
            null,
            2
          ),
        },
      ],
    };
  }
  if (err instanceof QueueWaitError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              kind: err.kind,
              message: err.message,
              op: err.op,
              waitedMs: err.waitedMs,
              behindOp: err.behindOp,
            },
            null,
            2
          ),
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            kind: "error",
            message,
          },
          null,
          2
        ),
      },
    ],
  };
}
