import type { ToolDefinition } from "../common.js";
import { aerenderTools } from "./aerender.js";
import { animateTools } from "./animate.js";
import { askTools } from "./ask.js";
import { assetsTools } from "./assets.js";
import { audioTools } from "./audio.js";
import { briefTools } from "./brief.js";
import { dataTools } from "./data.js";
import { diagnosticsTools } from "./diagnostics.js";
import { dialogsTools } from "./dialogs.js";
import { effectsTools } from "./effects.js";
import { exploreTools } from "./explore.js";
import { framesTools } from "./frames.js";
import { inventoryTools } from "./inventory.js";
import { keyTools } from "./key.js";
import { keyframesTools } from "./keyframes.js";
import { layersTools } from "./layers.js";
import { markersTools } from "./markers.js";
import { motionTools } from "./motion.js";
import { panelsTools } from "./panels.js";
import { productionTools } from "./production.js";
import { receiptsTools } from "./receipts.js";
import { reframeTools } from "./reframe.js";
import { shapesTools } from "./shapes.js";
import { skillsTools } from "./skills.js";
import { trackTools } from "./track.js";

// Each tool group in this folder exports an array of tools; list it here.
export const extTools: ToolDefinition<any>[] = [
  ...exploreTools,
  ...receiptsTools,
  ...animateTools,
  ...effectsTools,
  ...dataTools,
  ...reframeTools,
  ...assetsTools,
  ...framesTools,
  ...motionTools,
  ...askTools,
  ...skillsTools,
  ...briefTools,
  ...aerenderTools,
  ...dialogsTools,
  ...diagnosticsTools,
  ...panelsTools,
  ...trackTools,
  ...keyTools,
  ...layersTools,
  ...markersTools,
  ...audioTools,
  ...keyframesTools,
  ...inventoryTools,
  ...shapesTools,
  ...productionTools,
];
