#!/usr/bin/env node
// Syncs the guidance skills into the repo and regenerates the TS module.
//
//   node scripts/sync-guidance.mjs
//
// Every folder under server/guidance/ holding a SKILL.md is a skill. Two of them are synced from
// an upstream skill folder first (the rest are repo-owned, with no upstream):
//   motion-director  ~/.claude/skills/chroma-motion-director (CHROMA_MOTION_SKILL_DIR)
//                    -> server/guidance/motion-director/
//   captions         ~/.claude/skills/captions (CHROMA_CAPTIONS_SKILL_DIR)
//                    -> server/guidance/captions/
//
// 1. For each upstream-synced skill, if its source folder exists, copies SKILL.md, NOTICE.md and
//    references/*.md into the committed folder (quoting any frontmatter value that is not
//    portable YAML, see scripts/skill-frontmatter.mjs). Otherwise it keeps the committed copy
//    and says so. If there is neither, it exits with an error.
// 2. For every skill folder: lists its .md files, parses and validates the SKILL.md frontmatter
//    (exit 1 on any problem), checks skill names are unique and the Skills extension limits
//    (512 files, 16 MiB per skill), and computes each file's sha256 and size.
// 3. Regenerates server/src/guidance/content.generated.ts: the text of every file (SKILL_TEXT),
//    the Skills extension manifest (MCP_SKILLS) and the legacy GUIDANCE_FILES /
//    CAPTIONS_GUIDANCE_FILES, so the text ships inside both the tsc build and the esbuild bundle
//    (no runtime file reads).
// No network. server/test/guidance.test.ts fails if the generated module drifts.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseFrontmatter, parseFrontmatter, validateSkillFrontmatter } from "./skill-frontmatter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "server", "src", "guidance", "content.generated.ts");
const guidanceRoot = path.join(root, "server", "guidance");
const home = os.homedir();

const MAX_FILES = 512;
const MAX_BYTES = 16 * 1024 * 1024;

const UPSTREAM = [
  {
    name: "motion-director",
    src: process.env.CHROMA_MOTION_SKILL_DIR || path.join(home, ".claude", "skills", "chroma-motion-director"),
    dest: path.join(guidanceRoot, "motion-director"),
  },
  {
    name: "captions",
    src: process.env.CHROMA_CAPTIONS_SKILL_DIR || path.join(home, ".claude", "skills", "captions"),
    dest: path.join(guidanceRoot, "captions"),
  },
];

const norm = (s) => s.replace(/\r\n/g, "\n");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function listMd(dir, prefix = "") {
  const found = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) found.push(...listMd(path.join(dir, e.name), rel));
    else if (e.name.endsWith(".md")) found.push(rel);
  }
  return found.sort();
}

function syncSkill({ name, src, dest }) {
  if (fs.existsSync(path.join(src, "SKILL.md"))) {
    const rels = listMd(src).filter(
      (r) => r === "SKILL.md" || r === "NOTICE.md" || r.startsWith("references/")
    );
    // Read, normalise and check everything first: a source this script cannot serve must not replace the
    // committed copy.
    const texts = {};
    for (const rel of rels) {
      let text = norm(fs.readFileSync(path.join(src, rel), "utf8"));
      if (rel === "SKILL.md") {
        let n;
        try {
          n = normaliseFrontmatter(text);
          const problems = validateSkillFrontmatter(parseFrontmatter(n.text).frontmatter);
          if (problems.length) throw new Error(problems.join("; "));
        } catch (e) {
          console.error(`[${name}] ${path.join(src, "SKILL.md")} frontmatter: ${e.message}. The committed copy in ${path.relative(root, dest)}/ was left as it is.`);
          process.exit(1);
        }
        text = n.text;
        for (const key of n.changed) console.log(`[${name}] Quoted the frontmatter value of "${key}" (not portable YAML as a plain scalar)`);
      }
      texts[rel] = text;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    for (const rel of rels) {
      const to = path.join(dest, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, texts[rel]);
    }
    console.log(`[${name}] Copied ${rels.length} files from ${src}`);
  } else if (fs.existsSync(path.join(dest, "SKILL.md"))) {
    console.log(`[${name}] Skill source not found at ${src}; keeping the committed copy in ${path.relative(root, dest)}/.`);
  } else {
    console.error(`[${name}] No skill source at ${src} and no committed copy in ${dest}. Nothing to do.`);
    process.exit(1);
  }
}

for (const skill of UPSTREAM) syncSkill(skill);

// ---- Collect every skill folder -------------------------------------------------------------

const dirs = fs
  .readdirSync(guidanceRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(guidanceRoot, e.name, "SKILL.md")))
  .map((e) => e.name)
  .sort();

const skills = []; // { dir, name, frontmatter, texts: {rel: text}, files: [{path, sha256, size}] }
for (const dir of dirs) {
  const base = path.join(guidanceRoot, dir);
  const rels = listMd(base);
  const texts = {};
  for (const rel of rels) texts[rel] = norm(fs.readFileSync(path.join(base, rel), "utf8"));

  let frontmatter;
  try {
    frontmatter = parseFrontmatter(texts["SKILL.md"]).frontmatter;
  } catch (e) {
    fail(`[${dir}] SKILL.md frontmatter: ${e.message}`);
  }
  const problems = validateSkillFrontmatter(frontmatter);
  if (problems.length) fail(`[${dir}] SKILL.md frontmatter: ${problems.join("; ")}`);

  const files = [];
  let total = 0;
  for (const rel of ["SKILL.md", ...rels.filter((r) => r !== "SKILL.md")]) {
    const bytes = Buffer.from(texts[rel], "utf8");
    total += bytes.length;
    files.push({ path: rel, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
  }
  if (files.length > MAX_FILES) fail(`[${dir}] ${files.length} files exceeds the Skills extension limit of ${MAX_FILES}`);
  if (total > MAX_BYTES) fail(`[${dir}] ${total} bytes exceeds the Skills extension limit of ${MAX_BYTES}`);
  skills.push({ dir, name: frontmatter.name, frontmatter, texts, files });
}

const seen = new Map();
for (const s of skills) {
  if (seen.has(s.name)) fail(`Skill name "${s.name}" is used by both ${seen.get(s.name)}/ and ${s.dir}/`);
  seen.set(s.name, s.dir);
}
for (const required of UPSTREAM) {
  if (!dirs.includes(required.name)) fail(`Missing skill folder server/guidance/${required.name}/`);
}

// ---- Generate the TS module -----------------------------------------------------------------

let ts =
  "// GENERATED by scripts/sync-guidance.mjs from every skill folder under server/guidance/ (each holds a\n" +
  "// SKILL.md). Do not edit.\n" +
  "// Shipped as strings so it works in the tsc build and in the esbuild panel bundle.\n" +
  "//   SKILL_TEXT   folder -> relative path -> file text (CRLF normalised to LF)\n" +
  "//   MCP_SKILLS   the Skills extension manifest per skill, sorted by skill name: parsed frontmatter and\n" +
  "//                per file sha256 (lowercase hex of the UTF-8 bytes) and size (UTF-8 bytes), SKILL.md first\n" +
  "//   GUIDANCE_FILES / CAPTIONS_GUIDANCE_FILES  the motion-director and captions entries of SKILL_TEXT\n" +
  "\n" +
  "export interface McpSkillFile {\n" +
  "  path: string;\n" +
  "  sha256: string;\n" +
  "  size: number;\n" +
  "}\n" +
  "\n" +
  "export interface McpSkillManifest {\n" +
  "  /** Folder under server/guidance/. */\n" +
  "  dir: string;\n" +
  "  /** The frontmatter name; the skill is served at skill://<name>/. */\n" +
  "  name: string;\n" +
  "  frontmatter: { name: string; description: string; [key: string]: unknown };\n" +
  "  files: McpSkillFile[];\n" +
  "}\n" +
  "\n" +
  "export const SKILL_TEXT: Record<string, Record<string, string>> = {\n";
for (const s of skills) {
  ts += `  ${JSON.stringify(s.dir)}: {\n`;
  for (const rel of Object.keys(s.texts)) ts += `    ${JSON.stringify(rel)}: ${JSON.stringify(s.texts[rel])},\n`;
  ts += "  },\n";
}
ts += "};\n\n";

const byName = [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
ts += "export const MCP_SKILLS: McpSkillManifest[] = [\n";
for (const s of byName) {
  ts += "  {\n";
  ts += `    dir: ${JSON.stringify(s.dir)},\n`;
  ts += `    name: ${JSON.stringify(s.name)},\n`;
  ts += `    frontmatter: ${JSON.stringify(s.frontmatter)},\n`;
  ts += "    files: [\n";
  for (const f of s.files) ts += `      ${JSON.stringify(f)},\n`;
  ts += "    ],\n  },\n";
}
ts += "];\n\n";
ts += 'export const GUIDANCE_FILES: Record<string, string> = SKILL_TEXT["motion-director"];\n';
ts += 'export const CAPTIONS_GUIDANCE_FILES: Record<string, string> = SKILL_TEXT["captions"];\n';

for (const s of skills) console.log(`[${s.dir}] ${s.files.length} files, skill name ${s.name}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ts);
console.log(`Wrote ${path.relative(root, out)}`);
