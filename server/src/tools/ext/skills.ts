/**
 * server/src/tools/ext/skills.ts
 *
 * AE skills: house rigs, lower thirds, kinetic type and other recipes kept as
 * SKILL.md plus numbered ExtendScript steps (see ../../skills.ts).
 * - ae_skill_list: the skills of the open project and the global ones
 * - ae_skill_save: writes a skill, from code or from ae_run_jsx calls that worked
 * - ae_skill_run:  runs a skill's steps in one evalScript (one undo group),
 *   guarded, with an auto checkpoint and a receipt read back separately
 */

import { z } from "zod";
import { BridgeError } from "../../host.js";
import { lintEs3 } from "../../es3-lint.js";
import { lintJsxSafety, describeSafetyFinding } from "../../jsx-safety-lint.js";
import { buildJsxCall, normalizeGuardPath } from "../../jsx.js";
import { QueueWaitError } from "../../queue.js";
import { buildReceipt } from "../../receipts.js";
import {
  findSkill,
  globalSkillsRoot,
  isValidSkillName,
  listSkills,
  oversizedSteps,
  projectSkillsRoot,
  recentRunJsx,
  recordedRunJsx,
  SKILL_NAME_RE,
  writeSkill,
  type Skill,
  type SkillScope,
} from "../../skills.js";
import {
  AGENT_SAFETY_GUIDANCE,
  dataDirOf,
  ExpectSchema,
  type ToolContext,
  type ToolDefinition,
} from "../common.js";
import { autoCheckpoint, verifyTargetGuard } from "../mutate.js";
import { readAfterWrite } from "../read-back.js";

const SkillNameSchema = z
  .string()
  .regex(SKILL_NAME_RE, "lowercase letters, digits and dashes, up to 64 characters")
  .refine(isValidSkillName, "not a Windows device name (con, prn, aux, nul, com1-9, lpt1-9)")
  .describe("Skill name, e.g. 'lower-third' (lowercase letters, digits, dashes).");

export const AeSkillListSchema = z.object({
  name: SkillNameSchema.optional().describe("Give a name to get that skill in full: instructions and the code of every step."),
  recent_jsx: z
    .boolean()
    .optional()
    .describe("Also list the recent successful ae_run_jsx calls (op_id, label), for ae_skill_save from_op_ids."),
});

export const AeSkillSaveSchema = z
  .object({
    name: SkillNameSchema,
    description: z.string().min(1).max(300).describe("One line: what the skill makes and when to use it."),
    instructions: z
      .string()
      .max(20000)
      .optional()
      .describe("Markdown for whoever runs it next: what args it takes, what it builds, what to check afterwards."),
    steps: z
      .array(z.string().min(1).max(200000))
      .min(1)
      .max(20)
      .optional()
      .describe("ExtendScript function bodies, run in order; each sees `args`, `prev` (the previous step's return) and `results`."),
    from_op_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .optional()
      .describe("op_ids of ae_run_jsx calls that worked in this session (in step order); their code becomes the steps."),
    mutates: z
      .boolean()
      .optional()
      .describe("False for a skill that only reads. Default: true, or for from_op_ids, true if any of the calls wrote."),
    args_example: z.record(z.unknown()).optional().describe("Example arguments, saved so the next caller sees the shape."),
    scope: z.enum(["project", "global"]).describe("project: next to the open .aep (ae-skills/); global: every project on this machine."),
    overwrite: z.boolean().optional().describe("Replace a skill with the same name in that scope."),
    expect: z
      .object({ project_path: z.string().min(1) })
      .optional()
      .describe("Required for scope 'project': the open project's path, so the skill lands next to the right .aep."),
  })
  .refine((v) => (v.steps === undefined) !== (v.from_op_ids === undefined), {
    message: "Give either steps or from_op_ids.",
  })
  .refine((v) => v.scope !== "project" || v.expect !== undefined, {
    message: "A project skill needs expect.project_path.",
  });

export const AeSkillRunSchema = z.object({
  name: SkillNameSchema,
  scope: z.enum(["project", "global"]).optional().describe("Where to look. Default: the project's skills first, then global."),
  args: z.record(z.unknown()).optional().describe("Arguments the steps read as `args`; see the skill's instructions and args_example."),
  expect: ExpectSchema.optional().describe("Required for skills that write. comp_id also picks the comp for the receipt."),
});

async function openProjectPath(ctx: ToolContext, toolName: string): Promise<string> {
  const res = await ctx.bridge.evalRaw<{ project_path: string }>({
    id: `${ctx.bridge.newOpId()}_skills_status`,
    script: buildJsxCall("status", {}),
    label: `${toolName} (project path)`,
    mutates: false,
    toolName,
  });
  return res.result?.project_path ?? "<unsaved>";
}

function roots(ctx: ToolContext, projectPath: string, only?: SkillScope): Array<{ scope: SkillScope; root: string }> {
  const out: Array<{ scope: SkillScope; root: string }> = [];
  if (projectPath !== "<unsaved>" && only !== "global") out.push({ scope: "project", root: projectSkillsRoot(projectPath) });
  if (only !== "project") out.push({ scope: "global", root: globalSkillsRoot(dataDirOf(ctx)) });
  return out;
}

function summary(s: Skill) {
  return {
    name: s.name,
    display_name: s.display_name,
    description: s.description,
    error: s.error,
    scope: s.scope,
    mutates: s.mutates,
    steps: s.steps.length,
    args_example: s.args_example,
    dir: s.dir,
  };
}

function unreadable(skill: Skill) {
  return { ok: false as const, error: "unreadable_skill", message: `Skill "${skill.name}" in ${skill.dir} can't be read: ${skill.error}` };
}

/** ES3 problems in a skill's steps, as "2.jsx line 4: ..." strings. */
export function lintSteps(steps: Array<{ file: string; code: string }>): string[] {
  const problems: string[] = [];
  for (const step of steps) {
    for (const f of lintEs3(step.code)) problems.push(`${step.file} line ${f.line}: ${f.message}`);
  }
  return problems;
}

/**
 * Hard-limit problems in a skill's steps (see jsx-safety-lint.ts), as
 * "2.jsx line 4: ..." strings. `mutates` is whether the skill runs as a
 * writing skill: a step that writes in a read-only skill is a problem.
 */
export function lintStepsSafety(steps: Array<{ file: string; code: string }>, mutates: boolean): string[] {
  const problems: string[] = [];
  for (const step of steps) {
    for (const f of lintJsxSafety(step.code, { mutates })) problems.push(`${step.file} ${describeSafetyFinding(f)}`);
  }
  return problems;
}

export const skillsTools: ToolDefinition<any>[] = [
  {
    name: "ae_skill_list",
    description:
      "List AE skills: reusable recipes (house rigs, lower thirds, kinetic type, cleanup passes) kept as SKILL.md plus numbered ExtendScript steps. " +
      "Project skills live next to the open .aep in ae-skills/ and travel with it; global skills are kept for every project on this machine. A project skill hides a global one with the same name. " +
      "Check here before building something by hand: the user may already have a skill for it. Give `name` to read one in full. Read-only.",
    schema: AeSkillListSchema,
    handler: async (args: z.infer<typeof AeSkillListSchema>, ctx) => {
      const projectPath = await openProjectPath(ctx, "ae_skill_list");
      const where = roots(ctx, projectPath);
      const recent = args.recent_jsx
        ? {
            recent_jsx: recentRunJsx().map((r) => ({
              op_id: r.op_id,
              label: r.label,
              mutates: r.mutates,
              at: r.at,
              first_line: r.code.split(/\r?\n/)[0].slice(0, 120),
            })),
          }
        : {};
      if (args.name) {
        const skill = findSkill(where, args.name);
        if (!skill) {
          return { ok: false, error: "not_found", message: `No skill named "${args.name}".`, roots: where, ...recent };
        }
        if (skill.error) return unreadable(skill);
        return { ok: true, skill: { ...summary(skill), instructions: skill.instructions, steps: skill.steps }, ...recent };
      }
      const skills = listSkills(where);
      return {
        ok: true,
        project_path: projectPath,
        roots: where,
        count: skills.length,
        skills: skills.map(summary),
        ...recent,
      };
    },
  },
  {
    name: "ae_skill_save",
    description:
      "Save an AE skill: a description, instructions, and ExtendScript steps that run in order. Steps come from `steps` (function bodies, as for ae_run_jsx) or from `from_op_ids`, the op_ids of ae_run_jsx calls that worked in this session, so a script that did the job is kept exactly as it ran. " +
      "Each step sees `args` (the run's arguments), `prev` (what the previous step returned) and `results`. Write steps that take what varies (text, colours, comp_id, layer names) from `args`, not hard-coded. " +
      "Steps are checked for ES3 (no let, const, arrow functions, template strings, class, or chained ternaries) and refused with the line if they break it. " +
      "They also pass the same best-effort safety lint as ae_run_jsx (a guard rail, not a sandbox): steps that call system.callSystem, File.execute, file writes or deletes, dialogs, ScriptUI, $.sleep, app.quit, renderQueue.render, project open/close and the like are refused with the dedicated tool to use instead, and in a skill with mutates false so are writes (setValue, addProperty, ...). " +
      "Save only when the user asks for it or agrees. Never touches the AE project.",
    schema: AeSkillSaveSchema,
    handler: async (args: z.infer<typeof AeSkillSaveSchema>, ctx) => {
      let steps: string[];
      let mutates = args.mutates;
      if (args.from_op_ids) {
        const found = args.from_op_ids.map((id) => ({ id, rec: recordedRunJsx(id) }));
        const missing = found.filter((f) => !f.rec).map((f) => f.id);
        if (missing.length > 0) {
          return {
            ok: false,
            error: "unknown_op_id",
            message: `No successful ae_run_jsx with op_id ${missing.join(", ")} in this session (the last 50 are kept). Pass the code as steps instead.`,
          };
        }
        steps = found.map((f) => f.rec!.code);
        if (mutates === undefined) mutates = found.some((f) => f.rec!.mutates);
      } else {
        steps = args.steps!;
      }
      const tooBig = oversizedSteps(steps);
      if (tooBig.length > 0) {
        return { ok: false, error: "step_too_large", message: "A step is too large for a skill. Nothing was saved.", problems: tooBig };
      }
      const problems = lintSteps(steps.map((code, i) => ({ file: `${i + 1}.jsx`, code })));
      if (problems.length > 0) {
        return { ok: false, error: "not_es3", message: "Steps use syntax After Effects' ExtendScript (ES3) can't run. Nothing was saved.", problems };
      }
      const unsafe = lintStepsSafety(steps.map((code, i) => ({ file: `${i + 1}.jsx`, code })), mutates ?? true);
      if (unsafe.length > 0) {
        return { ok: false, error: "unsafe_jsx", message: "Steps call members the safety lint refuses (a guard rail, not a sandbox). Nothing was saved.", problems: unsafe };
      }

      let root: string;
      if (args.scope === "project") {
        const projectPath = await openProjectPath(ctx, "ae_skill_save");
        if (projectPath === "<unsaved>") {
          return { ok: false, error: "unsaved_project", message: "The project has not been saved, so there is no folder for project skills. Save it, or use scope 'global'." };
        }
        if (normalizeGuardPath(args.expect!.project_path) !== normalizeGuardPath(projectPath)) {
          return { ok: false, error: "guard", message: `The open project is ${projectPath}, not ${args.expect!.project_path}. Re-read state; nothing was saved.` };
        }
        root = projectSkillsRoot(projectPath);
      } else {
        root = globalSkillsRoot(dataDirOf(ctx));
      }

      try {
        const written = writeSkill(
          root,
          {
            name: args.name,
            description: args.description,
            mutates: mutates ?? true,
            args_example: args.args_example ? JSON.stringify(args.args_example) : undefined,
          },
          args.instructions ?? `# ${args.name}\n\n${args.description}`,
          steps,
          args.overwrite === true
        );
        return { ok: true, scope: args.scope, name: args.name, mutates: mutates ?? true, steps: steps.length, ...written };
      } catch (err) {
        return { ok: false, error: "write_failed", message: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: "ae_skill_run",
    description:
      "Run an AE skill: its numbered steps run in order in one evalScript, so a writing skill is a single undo step (Edit > Undo takes it all back). " +
      "Writing skills need `expect` (guarded like every write, with an auto checkpoint and a before/after receipt of expect.comp_id read back separately). " +
      "Pass `expect` unless you have read the steps and they only read: with `expect` the skill always runs guarded, even if its SKILL.md says it only reads. " +
      "The steps pass the same best-effort safety lint as ae_run_jsx at run time (a guard rail, not a sandbox); a saved skill that now fails it is refused with the list, and needs editing. " +
      "Pass what varies in `args`; read the skill first with ae_skill_list { name } to see its instructions. Each step's return value comes back in `results`. " +
      "If a step fails, the error names the step and line; steps before it have already run inside the undo group. " +
      AGENT_SAFETY_GUIDANCE,
    schema: AeSkillRunSchema,
    handler: async (args: z.infer<typeof AeSkillRunSchema>, ctx) => {
      const projectPath = await openProjectPath(ctx, "ae_skill_run");
      const skill = findSkill(roots(ctx, projectPath, args.scope), args.name);
      if (!skill) {
        return { ok: false, error: "not_found", message: `No skill named "${args.name}". See ae_skill_list.` };
      }
      if (skill.error) return unreadable(skill);
      if (skill.steps.length === 0) {
        return { ok: false, error: "no_steps", message: `Skill "${skill.name}" has no numbered .jsx steps in ${skill.dir}.` };
      }
      const problems = lintSteps(skill.steps);
      if (problems.length > 0) {
        return { ok: false, error: "not_es3", message: "The skill's steps use syntax ExtendScript (ES3) can't run. Nothing ran.", problems };
      }
      // A skill that says it only reads still runs guarded when the caller gives expect.
      const unsafe = lintStepsSafety(skill.steps, skill.mutates || args.expect !== undefined);
      if (unsafe.length > 0) {
        return { ok: false, error: "unsafe_jsx", message: `The skill's steps call members the safety lint refuses (a guard rail, not a sandbox). Nothing ran. Edit the skill (ae_skill_save with overwrite).`, problems: unsafe };
      }
      const label = `Chroma AE MCP: skill ${skill.name}`;
      // A skill that says it only reads still runs guarded when the caller gives expect.
      const guarded = skill.mutates || args.expect !== undefined;
      const hostArgs = { steps: skill.steps, args: args.args ?? {}, label, mutates: guarded };
      const about = { skill: skill.name, scope: skill.scope, dir: skill.dir, steps: skill.steps.length };

      if (!guarded) {
        const res = await ctx.bridge.callHost("runSkill", hostArgs, { label: `ae_skill_run: ${skill.name}`, mutates: false, toolName: "ae_skill_run" });
        return { ok: true, ...about, ...(res.result as object) };
      }
      if (!args.expect) {
        return { ok: false, error: "needs_expect", message: `Skill "${skill.name}" writes to the project, so it needs expect (project_path, and comp_id for the receipt).` };
      }

      ctx.quarantine.assertClear();
      const expect = args.expect;
      const opId = ctx.bridge.newOpId();
      const snapshot = (suffix: string) =>
        ctx.bridge.evalRaw({
          id: `${opId}_${suffix}`,
          script: buildJsxCall("snapshotForReceipt", { comp_id: expect.comp_id }),
          label: `${label} (${suffix} snapshot)`,
          mutates: false,
          toolName: "ae_skill_run",
        });
      try {
        return await ctx.queue.run(`ae_skill_run: ${skill.name}`, async () => {
          ctx.quarantine.assertClear();
          const guard = await verifyTargetGuard(ctx, expect, opId);
          const checkpoint = await autoCheckpoint(ctx, guard, "ae_skill_run");
          const before = await snapshot("before");
          const write = await ctx.bridge.evalRaw<Record<string, unknown>>({
            id: opId,
            script: buildJsxCall("runSkill", { ...hostArgs, expect }),
            label,
            mutates: true,
            toolName: "ae_skill_run",
          });
          // Separate evalScript for the read-back. The skill has run from here
          // on, so a failed read is reported, never thrown.
          const afterRead = await readAfterWrite(opId, () => snapshot("after"));
          return {
            ok: true,
            op_id: opId,
            applied: true as const,
            ...about,
            ...(write.result ?? {}),
            checkpoint,
            receipt: buildReceipt({
              before: before.result,
              after: afterRead.value?.result ?? null,
              customMismatches: afterRead.failure ? [afterRead.failure] : undefined,
            }),
          };
        });
      } catch (err) {
        if (err instanceof QueueWaitError) {
          throw new BridgeError({ kind: "queued", op_id: opId, message: err.message });
        }
        throw err;
      }
    },
  },
];
