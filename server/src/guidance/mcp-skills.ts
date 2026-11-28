// Skills extension data (skill:// URIs), built from the generated manifest and file text.
// No file reads at runtime and no Node APIs: this ships in the CEP panel bundle.
import { MCP_SKILLS, SKILL_TEXT } from "./content.generated.js";
import { GUIDANCE_DESCRIPTIONS_BY_DIR } from "./index.js";

export const SKILL_URI_SCHEME = "skill://";

export interface McpSkillResource {
  uri: string;
  /** "sha256:" followed by 64 lowercase hex characters. */
  digest: string;
  size: number;
}

export interface McpSkillEntry {
  /** The uri of the skill's SKILL.md. */
  uri: string;
  frontmatter: { name: string; description: string; [k: string]: unknown };
  /** Every file of the skill exactly once, SKILL.md first. */
  resources: McpSkillResource[];
}

interface Index {
  entries: McpSkillEntry[]; // sorted by name
  byUri: Map<string, McpSkillEntry>;
  files: Map<string, { mimeType: string; text: string }>;
  listing: McpSkillResourceListing[];
}

/** One resources/list entry for a skill file (ext-skills "Resource Metadata"). */
export interface McpSkillResourceListing {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  size: number;
}

let index: Index | undefined;

function build(): Index {
  const entries: McpSkillEntry[] = [];
  const byUri = new Map<string, McpSkillEntry>();
  const files = new Map<string, { mimeType: string; text: string }>();
  const listing: McpSkillResourceListing[] = [];
  try {
    const skills = [...MCP_SKILLS].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const s of skills) {
      const root = `${SKILL_URI_SCHEME}${s.name}/`;
      const texts = SKILL_TEXT[s.dir] ?? {};
      const resources: McpSkillResource[] = [];
      for (const f of s.files) {
        const uri = root + f.path;
        resources.push({ uri, digest: `sha256:${f.sha256}`, size: f.size });
        const mimeType = f.path.endsWith(".md") ? "text/markdown" : "text/plain";
        const text = texts[f.path] ?? "";
        files.set(uri, { mimeType, text });
        if (f.path === "SKILL.md") {
          listing.push({ uri, name: String(s.frontmatter.name), description: String(s.frontmatter.description), mimeType, size: f.size });
        } else {
          const heading = /^# +(.+?)\s*$/m.exec(text);
          const description = GUIDANCE_DESCRIPTIONS_BY_DIR[s.dir]?.[f.path];
          listing.push({
            uri,
            name: f.path,
            ...(heading ? { title: heading[1] } : {}),
            ...(description ? { description } : {}),
            mimeType,
            size: f.size,
          });
        }
      }
      const entry: McpSkillEntry = {
        uri: `${root}SKILL.md`,
        frontmatter: JSON.parse(JSON.stringify(s.frontmatter)) as McpSkillEntry["frontmatter"],
        resources,
      };
      entries.push(entry);
      byUri.set(entry.uri, entry);
    }
  } catch {
    // Never throw: serve whatever was indexed so far.
  }
  return { entries, byUri, files, listing };
}

function idx(): Index {
  if (!index) index = build();
  return index;
}

function copyEntry(e: McpSkillEntry): McpSkillEntry {
  return {
    uri: e.uri,
    frontmatter: JSON.parse(JSON.stringify(e.frontmatter)) as McpSkillEntry["frontmatter"],
    resources: e.resources.map((r) => ({ uri: r.uri, digest: r.digest, size: r.size })),
  };
}

/** Every skill, sorted by name. Fresh copies on each call. */
export function listMcpSkills(): McpSkillEntry[] {
  return idx().entries.map(copyEntry);
}

/** The entry whose SKILL.md uri is exactly `uri`. */
export function getMcpSkill(uri: string): McpSkillEntry | undefined {
  const e = idx().byUri.get(uri);
  return e ? copyEntry(e) : undefined;
}

/** The text of the file at exactly `uri`, if it is in a skill's manifest. */
export function readMcpSkillFile(uri: string): { uri: string; mimeType: string; text: string } | undefined {
  const f = idx().files.get(uri);
  return f ? { uri, mimeType: f.mimeType, text: f.text } : undefined;
}

/** Every file of every skill as a resources/list entry: skills sorted by name, SKILL.md first, then manifest order. */
export function listMcpSkillResources(): McpSkillResourceListing[] {
  return idx().listing.map((r) => ({ ...r }));
}
