import type { ToolDefinition } from "./common.js";
import { extTools } from "./ext/index.js";
import { mutateTools } from "./mutate.js";
import { quarantineTools } from "./quarantine.js";
import { readTools } from "./read.js";
import { renderTools } from "./render.js";

/** Every tool the server exposes. Tool groups in tools/ext/ register through ext/index.ts. */
export const ALL_TOOLS: ToolDefinition<any>[] = [
  ...readTools,
  ...mutateTools,
  ...renderTools,
  ...quarantineTools,
  ...extTools,
];
