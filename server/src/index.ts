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
import { convertFieldSchema, zodToJsonSchema } from "./schema.js";
import { SettingsStore } from "./settings.js";
import {
  formatToolError,
  formatToolResponse,
  type ToolContext,
  type ToolDefinition,
} from "./tools/common.js";
import { ALL_TOOLS } from "./tools/registry.js";

export { convertFieldSchema, zodToJsonSchema };

export { ALL_TOOLS };

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

  const settings = customCtx?.settings ?? new SettingsStore();
  const ctx: ToolContext = { bridge, queue, quarantine, settings };
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
