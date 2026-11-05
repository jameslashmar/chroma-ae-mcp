import { GUIDANCE_FILES } from "./content.generated.js";

export const GUIDANCE_URI_PREFIX = "chroma-ae://guidance/motion-director/";

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

function titleOf(rel: string, text: string): string {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : rel;
}

export function listGuidanceResources(): GuidanceResource[] {
  return Object.keys(GUIDANCE_FILES)
    .sort()
    .map((rel) => ({
      uri: GUIDANCE_URI_PREFIX + rel,
      name: titleOf(rel, GUIDANCE_FILES[rel]),
      description: DESCRIPTIONS[rel] ?? `Motion guidance file ${rel}.`,
      mimeType: "text/markdown" as const,
      text: GUIDANCE_FILES[rel],
    }));
}

export function readGuidance(uri: string): GuidanceResource | undefined {
  return listGuidanceResources().find((r) => r.uri === uri);
}

/** SKILL.md without its YAML frontmatter. */
export function skillBody(): string {
  return GUIDANCE_FILES["SKILL.md"].replace(/^---\n[\s\S]*?\n---\n+/, "");
}

export function reviewBody(): string {
  return GUIDANCE_FILES["references/review.md"];
}
