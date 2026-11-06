import { CAPTIONS_GUIDANCE_FILES, GUIDANCE_FILES } from "./content.generated.js";

export const GUIDANCE_URI_PREFIX = "chroma-ae://guidance/motion-director/";
export const CAPTIONS_GUIDANCE_URI_PREFIX = "chroma-ae://guidance/captions/";

export interface GuidanceResource {
  uri: string;
  name: string;
  description: string;
  mimeType: "text/markdown";
  text: string;
}

const DESCRIPTIONS: Record<string, string> = {
  "SKILL.md": "Chroma motion director: workflow from brief to delivery, with the numbers.",
  "NOTICE.md": "Sources and licences behind the motion guidance.",
  "references/choreography.md": "Choreography: stagger, hierarchy, camera and layer motion rules.",
  "references/review.md": "Review checklist: measure first, then look.",
  "references/sound-and-captions.md": "Sound design, music sync and caption rules.",
  "references/spec.md": "The numeric motion spec: fields and register defaults.",
  "references/story-and-pacing.md": "Story beats and pacing for motion pieces.",
  "references/timing-and-easing.md": "Durations, easing curves and timing numbers.",
  "references/type-and-layout.md": "Type, layout and safe-zone rules for motion.",
};

const CAPTIONS_DESCRIPTIONS: Record<string, string> = {
  "SKILL.md": "Captions skill: workflow from transcript to delivered file, with the standards' numbers.",
  "NOTICE.md": "Sources and licences behind the captions guidance.",
  "references/asr.md": "Speech to text: which tool to use, and the failure modes to clean up.",
  "references/chroma-ae-workflow.md": "Making captions with the chroma-ae MCP tools, step by step.",
  "references/formats.md": "Caption file formats (SRT, WebVTT, TTML/IMSC, SCC) and their gotchas.",
  "references/sdh-and-speakers.md": "SDH, sound events, speaker identification and caption contrast.",
  "references/social-and-platforms.md": "Social captions and 9:16 layout: chunk size, type size and safe zones.",
  "references/standards.md": "Caption standards compared: Netflix, BBC, DCMP, Ofcom and WCAG numbers.",
  "references/timing-and-breaks.md": "Timing, line breaks and shot-change rules, in order of operations.",
};

function titleOf(rel: string, text: string): string {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : rel;
}

function resourcesOf(
  files: Record<string, string>,
  prefix: string,
  descriptions: Record<string, string>,
  label: string
): GuidanceResource[] {
  return Object.keys(files)
    .sort()
    .map((rel) => ({
      uri: prefix + rel,
      name: titleOf(rel, files[rel]),
      description: descriptions[rel] ?? `${label} guidance file ${rel}.`,
      mimeType: "text/markdown" as const,
      text: files[rel],
    }));
}

/** Motion-director resources first, then captions. */
export function listGuidanceResources(): GuidanceResource[] {
  return [
    ...resourcesOf(GUIDANCE_FILES, GUIDANCE_URI_PREFIX, DESCRIPTIONS, "Motion"),
    ...resourcesOf(CAPTIONS_GUIDANCE_FILES, CAPTIONS_GUIDANCE_URI_PREFIX, CAPTIONS_DESCRIPTIONS, "Captions"),
  ];
}

export function readGuidance(uri: string): GuidanceResource | undefined {
  return listGuidanceResources().find((r) => r.uri === uri);
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

/** SKILL.md without its YAML frontmatter. */
export function skillBody(): string {
  return stripFrontmatter(GUIDANCE_FILES["SKILL.md"]);
}

/** Captions SKILL.md without its YAML frontmatter. */
export function captionsSkillBody(): string {
  return stripFrontmatter(CAPTIONS_GUIDANCE_FILES["SKILL.md"]);
}

export function reviewBody(): string {
  return GUIDANCE_FILES["references/review.md"];
}
