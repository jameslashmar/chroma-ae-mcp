import type { ToolDefinition } from "../common.js";
import { captionsTools } from "./captions.js";
import { transcribeTools } from "./transcribe.js";
import { captionsioTools } from "./captionsio.js";
import { rigTools } from "./rig.js";
import { fittextTools } from "./fittext.js";
import { staggerTools } from "./stagger.js";
import { timeremapTools } from "./timeremap.js";
import { cameraTools } from "./camera.js";
import { explainTools } from "./explain.js";
import { describeTools } from "./describe.js";
import { scrubTools } from "./scrub.js";
import { interpretTools } from "./interpret.js";
import { pathsTools } from "./paths.js";
import { memoryTools } from "./memory.js";
import { rqeditTools } from "./rqedit.js";
import { rqrenderTools } from "./rqrender.js";
import { renderbatchTools } from "./renderbatch.js";
import { collectTools } from "./collect.js";
import { deliverTools } from "./deliver.js";
import { loudnessTools } from "./loudness.js";
import { legibilityTools } from "./legibility.js";
import { timingTools } from "./timing.js";
import { variantsTools } from "./variants.js";
import { learntasteTools } from "./learntaste.js";
import { projectsessionTools } from "./projectsession.js";
import { planarTools } from "./planar.js";
import { patchcheckTools } from "./patchcheck.js";
import { stabilizeTools } from "./stabilize.js";
import { cleanplateTools } from "./cleanplate.js";
import { inpaintTools } from "./inpaint.js";
import { mattesTools } from "./mattes.js";
import { patchfitTools } from "./patchfit.js";
import { screenrepTools } from "./screenrep.js";
import { projectitemsTools } from "./projectitems.js";
import { projectsettingsTools } from "./projectsettings.js";
import { viewTools } from "./view.js";
import { timelineTools } from "./timeline.js";
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
import { placementTools } from "./placement.js";
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
  ...placementTools,
  ...verifyTools,
  ...layeropsTools,
  ...multicompTools,
  ...annotateTools,
  ...compsettingsTools,
  ...preflightTools,
  ...sessionTools,
  ...captionsTools,
  ...transcribeTools,
  ...captionsioTools,
  ...rigTools,
  ...fittextTools,
  ...staggerTools,
  ...timeremapTools,
  ...cameraTools,
  ...explainTools,
  ...describeTools,
  ...scrubTools,
  ...interpretTools,
  ...pathsTools,
  ...memoryTools,
  ...rqeditTools,
  ...rqrenderTools,
  ...renderbatchTools,
  ...collectTools,
  ...deliverTools,
  ...loudnessTools,
  ...legibilityTools,
  ...timingTools,
  ...variantsTools,
  ...learntasteTools,
  ...projectsessionTools,
  ...planarTools,
  ...patchcheckTools,
  ...stabilizeTools,
  ...cleanplateTools,
  ...inpaintTools,
  ...mattesTools,
  ...patchfitTools,
  ...screenrepTools,
  ...projectitemsTools,
  ...projectsettingsTools,
  ...viewTools,
  ...timelineTools,
];
