import type { ToolDefinition } from "../common.js";
import { aerenderTools } from "./aerender.js";
import { animateTools } from "./animate.js";
import { annotateTools } from "./annotate.js";
import { askTools } from "./ask.js";
import { assetsTools } from "./assets.js";
import { audioTools } from "./audio.js";
import { briefTools } from "./brief.js";
import { compsettingsTools } from "./compsettings.js";
import { dataTools } from "./data.js";
import { diagnosticsTools } from "./diagnostics.js";
import { dialogsTools } from "./dialogs.js";
import { effectsTools } from "./effects.js";
import { exploreTools } from "./explore.js";
import { framesTools } from "./frames.js";
import { inventoryTools } from "./inventory.js";
import { keyTools } from "./key.js";
import { keyframesTools } from "./keyframes.js";
import { layeropsTools } from "./layerops.js";
import { layersTools } from "./layers.js";
import { layoutTools } from "./layout.js";
import { markersTools } from "./markers.js";
import { masksTools } from "./masks.js";
import { multicompTools } from "./multicomp.js";
import { motionTools } from "./motion.js";
import { panelsTools } from "./panels.js";
import { preflightTools } from "./preflight.js";
import { productionTools } from "./production.js";
import { receiptsTools } from "./receipts.js";
import { reframeTools } from "./reframe.js";
import { sessionTools } from "./session.js";
import { shapesTools } from "./shapes.js";
import { skillsTools } from "./skills.js";
import { trackTools } from "./track.js";
import { verifyTools } from "./verify.js";

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
  ...masksTools,
  ...layoutTools,
  ...verifyTools,
  ...layeropsTools,
  ...multicompTools,
  ...annotateTools,
  ...compsettingsTools,
  ...preflightTools,
  ...sessionTools,
];
