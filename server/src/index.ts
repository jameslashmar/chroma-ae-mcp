#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeClient } from "./bridge.js";
import { QuarantineStore } from "./quarantine.js";
import { SingleWriterQueue } from "./queue.js";
import {
  formatToolError,
  formatToolResponse,
  type ToolContext,
  type ToolDefinition,
} from "./tools/common.js";
import { mutateTools } from "./tools/mutate.js";
import { quarantineTools } from "./tools/quarantine.js";
import { readTools } from "./tools/read.js";
import { renderTools } from "./tools/render.js";

export const ALL_TOOLS: ToolDefinition<any>[] = [
  ...readTools,
  ...mutateTools,
  ...renderTools,
  ...quarantineTools,
];

/**
 * Converts a Zod schema into a JSON Schema object suitable for MCP `ListTools`.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
} {
  let current: z.ZodTypeAny = schema;
  while (
    current instanceof z.ZodEffects ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional
  ) {
    if (current instanceof z.ZodEffects) {
      current = current._def.schema;
    } else if (current instanceof z.ZodDefault) {
      current = current._def.innerType;
    } else if (current instanceof z.ZodOptional) {
      current = current._def.innerType;
    }
  }

  if (!(current instanceof z.ZodObject)) {
    return { type: "object", properties: {} };
  }

  const shape = current.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const { propSchema, isOptional } = convertFieldSchema(fieldSchema);
    properties[key] = propSchema;
    if (!isOptional) {
      required.push(key);
    }
  }

  const out: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  } = {
    type: "object",
    properties,
  };
  if (required.length > 0) {
    out.required = required;
  }
  return out;
}

function convertFieldSchema(schema: z.ZodTypeAny): {
  propSchema: Record<string, unknown>;
  isOptional: boolean;
} {
  let isOptional = false;
  let current: z.ZodTypeAny = schema;
  let description: string | undefined = current.description;

  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodEffects
  ) {
    if (!description && current.description) {
      description = current.description;
    }
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      isOptional = true;
      current = current._def.innerType;
    } else if (current instanceof z.ZodEffects) {
      current = current._def.schema;
    }
  }

  if (!description && current.description) {
    description = current.description;
  }

  let propSchema: Record<string, unknown> = {};

  if (current instanceof z.ZodString) {
    propSchema = { type: "string" };
  } else if (current instanceof z.ZodNumber) {
    propSchema = { type: "number" };
  } else if (current instanceof z.ZodBoolean) {
    propSchema = { type: "boolean" };
  } else if (current instanceof z.ZodEnum) {
    propSchema = { type: "string", enum: current._def.values };
  } else if (current instanceof z.ZodArray) {
    const elem = convertFieldSchema(current._def.type);
    propSchema = { type: "array", items: elem.propSchema };
  } else if (current instanceof z.ZodObject) {
    propSchema = zodToJsonSchema(current);
  } else {
    propSchema = {};
  }

  if (description) {
    propSchema.description = description;
  }

  return { propSchema, isOptional };
}

export function createMcpServer(customCtx?: Partial<ToolContext>): {
  server: Server;
  ctx: ToolContext;
} {
  const queue = customCtx?.queue ?? new SingleWriterQueue();
  const quarantine = customCtx?.quarantine ?? new QuarantineStore();
  const bridge =
    customCtx?.bridge ??
    new BridgeClient({
      queue,
      quarantine,
    });

  const ctx: ToolContext = { bridge, queue, quarantine };
  const toolMap = new Map<string, ToolDefinition<any>>(
    ALL_TOOLS.map((t) => [t.name, t])
  );

  const server = new Server(
    {
      name: "chroma-ae-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALL_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.schema),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = toolMap.get(toolName);
    if (!tool) {
      return formatToolError(new Error(`Unknown tool: ${toolName}`));
    }

    const parsed = tool.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return formatToolError(
        new Error(
          `Invalid arguments for ${toolName}: ${parsed.error.issues
            .map((i: z.ZodIssue) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")}`
        )
      );
    }

    try {
      const output = await tool.handler(parsed.data, ctx);
      return formatToolResponse(output);
    } catch (err) {
      return formatToolError(err);
    }
  });

  return { server, ctx };
}

export async function main(): Promise<void> {
  const { server } = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("index.js") ||
    process.argv[1].endsWith("index.ts"));

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`Fatal error in chroma-ae-mcp: ${String(err)}\n`);
    process.exit(1);
  });
}
