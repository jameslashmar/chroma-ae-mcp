/**
 * server/src/skills.ts
 *
 * AE skills on disk: a folder per skill holding SKILL.md (frontmatter plus
 * instructions) and numbered ExtendScript steps (1.jsx, 2.jsx, ...), each the
 * body of a function, like ae_run_jsx code.
 *
 * Two places:
 * - project: <folder of the .aep>/ae-skills/<name>/, travels with the project
 * - global:  <data dir>/skills/<name>/, for every project on this machine
 * A project skill hides a global one with the same name.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SkillScope = "project" | "global";

export interface SkillMeta {
  name: string;
  description: string;
  /** False for skills that only read; they run without a guard or undo group. */
  mutates: boolean;
  /** Example arguments, as JSON text, so callers see the expected shape. */
  args_example?: string;
}

export interface SkillStep {
  file: string;
  code: string;
}

export interface Skill extends SkillMeta {
  /** Set when the folder could not be read; the skill is listed but cannot run. */
  error?: string;
  /** The name in SKILL.md when it differs from the folder name (the folder name is the identity). */
  display_name?: string;
  scope: SkillScope;
  dir: string;
  instructions: string;
  steps: SkillStep[];
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Windows device names can't be folder names there, whatever the extension. */
export const RESERVED_SKILL_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && !RESERVED_SKILL_NAME_RE.test(name);
}
export const PROJECT_SKILLS_DIR = "ae-skills";
const STEP_RE = /^(\d{1,3})\.jsx$/i;
export const MAX_STEP_BYTES = 256 * 1024;

/** Steps over the size a skill can be read back at, as "2.jsx is 300 KB ..." strings. */
export function oversizedSteps(steps: string[]): string[] {
  const out: string[] = [];
  steps.forEach((code, i) => {
    const bytes = Buffer.byteLength(code, "utf8");
    if (bytes > MAX_STEP_BYTES) {
      out.push(`${i + 1}.jsx is ${Math.ceil(bytes / 1024)} KB; a step can be at most ${MAX_STEP_BYTES / 1024} KB (UTF-8)`);
    }
  });
  return out;
}

export function projectSkillsRoot(projectPath: string): string {
  return path.join(path.dirname(projectPath), PROJECT_SKILLS_DIR);
}

export function globalSkillsRoot(dataDir: string): string {
  return path.join(dataDir, "skills");
}

/** Reads `---` frontmatter of `key: value` lines; the rest is the instructions. */
export function parseSkillMd(text: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!m) return { meta, body: normalized.trim() };
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: normalized.slice(m[0].length).trim() };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** U+2028/U+2029 can sit raw in JSON text but the line parser can't match them, so write them as JSON escapes. */
function escapeLineSeparators(json: string): string {
  const bs = String.fromCharCode(92);
  return json
    .split(String.fromCharCode(0x2028))
    .join(bs + "u2028")
    .split(String.fromCharCode(0x2029))
    .join(bs + "u2029");
}

export function formatSkillMd(meta: SkillMeta, instructions: string): string {
  const lines = ["---", `name: ${meta.name}`, `description: ${oneLine(meta.description)}`, `mutates: ${meta.mutates}`];
  if (meta.args_example) lines.push(`args: ${escapeLineSeparators(meta.args_example)}`);
  lines.push("---", "", instructions.trim(), "");
  return lines.join("\n");
}

/** Reads a skill folder; one that can't be read comes back with `error` set instead of throwing. */
function readSkillDir(dir: string, scope: SkillScope): Skill | null {
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return null;
  try {
    return readSkillFiles(dir, scope);
  } catch (err) {
    return {
      name: path.basename(dir),
      description: "",
      mutates: true,
      scope,
      dir,
      instructions: "",
      steps: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readSkillFiles(dir: string, scope: SkillScope): Skill {
  const { meta, body } = parseSkillMd(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
  const name = path.basename(dir);
  const steps: SkillStep[] = fs
    .readdirSync(dir)
    .map((f) => ({ f, m: STEP_RE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map(({ f }) => {
      const full = path.join(dir, f);
      const size = fs.statSync(full).size;
      if (size > MAX_STEP_BYTES) throw new Error(`${full} is over ${MAX_STEP_BYTES / 1024} KB`);
      return { file: f, code: fs.readFileSync(full, "utf8").replace(/^﻿/, "") };
    });
  return {
    name,
    display_name: meta.name && meta.name !== name ? meta.name : undefined,
    description: meta.description ?? "",
    mutates: meta.mutates !== "false",
    args_example: meta.args || undefined,
    scope,
    dir,
    instructions: body,
    steps,
  };
}

export function listSkills(roots: Array<{ scope: SkillScope; root: string }>): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const { scope, root } of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const skill = readSkillDir(path.join(root, e.name), scope);
      if (!skill || seen.has(e.name)) continue;
      seen.add(e.name);
      out.push(skill);
    }
  }
  return out;
}

export function findSkill(roots: Array<{ scope: SkillScope; root: string }>, name: string): Skill | null {
  for (const { scope, root } of roots) {
    const dir = path.join(root, name);
    const skill = fs.existsSync(dir) ? readSkillDir(dir, scope) : null;
    if (skill) return skill;
  }
  return null;
}

/**
 * Writes a skill folder. Replacing an existing skill needs `overwrite`; its
 * old numbered steps are removed so a shorter skill doesn't keep stale ones.
 */
export function writeSkill(
  root: string,
  meta: SkillMeta,
  instructions: string,
  steps: string[],
  overwrite: boolean
): { dir: string; replaced: boolean; files: string[] } {
  if (!isValidSkillName(meta.name)) {
    throw new Error(`Bad skill name "${meta.name}": use lowercase letters, digits and dashes (not a Windows device name like con or nul).`);
  }
  const dir = path.join(root, meta.name);
  const exists = fs.existsSync(path.join(dir, "SKILL.md"));
  if (exists && !overwrite) {
    throw new Error(`A skill named "${meta.name}" already exists in ${root}. Pass overwrite: true to replace it.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  // Also when SKILL.md is missing: leftover numbered steps would run as part of the new skill.
  for (const f of fs.readdirSync(dir)) if (STEP_RE.test(f)) fs.unlinkSync(path.join(dir, f));
  const files: string[] = [];
  steps.forEach((code, i) => {
    const file = `${i + 1}.jsx`;
    fs.writeFileSync(path.join(dir, file), code.endsWith("\n") ? code : `${code}\n`, "utf8");
    files.push(file);
  });
  fs.writeFileSync(path.join(dir, "SKILL.md"), formatSkillMd(meta, instructions), "utf8");
  files.unshift("SKILL.md");
  return { dir, replaced: exists, files };
}

// ---------- recent ae_run_jsx code, so a working script can be saved as a skill ----------

export interface RecordedJsx {
  op_id: string;
  label: string;
  code: string;
  mutates: boolean;
  at: string;
}

const MAX_RECORDED = 50;
const recorded: RecordedJsx[] = [];

export function recordRunJsx(entry: RecordedJsx): void {
  recorded.push(entry);
  if (recorded.length > MAX_RECORDED) recorded.splice(0, recorded.length - MAX_RECORDED);
}

export function recordedRunJsx(opId: string): RecordedJsx | undefined {
  return recorded.find((r) => r.op_id === opId);
}

export function recentRunJsx(): RecordedJsx[] {
  return recorded.slice().reverse();
}

export function clearRecordedRunJsx(): void {
  recorded.length = 0;
}
