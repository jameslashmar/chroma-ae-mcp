import type { ToolDefinition } from "../common.js";
import { aerenderTools } from "./aerender.js";
import { animateTools } from "./animate.js";
import { askTools } from "./ask.js";
import { dialogsTools } from "./dialogs.js";
import { effectsTools } from "./effects.js";
import { exploreTools } from "./explore.js";
import { framesTools } from "./frames.js";
import { motionTools } from "./motion.js";
import { panelsTools } from "./panels.js";
import { receiptsTools } from "./receipts.js";

// Each tool group in this folder exports an array of tools; list it here.
export const extTools: ToolDefinition<any>[] = [
  ...exploreTools,
  ...receiptsTools,
  ...animateTools,
  ...effectsTools,
  ...framesTools,
  ...motionTools,
  ...askTools,
  ...aerenderTools,
  ...dialogsTools,
  ...panelsTools,
];
