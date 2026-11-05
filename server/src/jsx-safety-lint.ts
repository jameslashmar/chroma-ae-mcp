/**
 * server/src/jsx-safety-lint.ts
 *
 * A static guard rail for code that reaches After Effects from outside the
 * repo (ae_run_jsx, ae_skill_save, ae_skill_run). It refuses calls to members
 * that break the project's hard limits and names the dedicated tool to use
 * instead:
 * - no outside programs (system.callSystem, File.execute, sockets);
 * - never open or suppress dialogs (alert, File.openDialog, ScriptUI, app.beginSuppressDialogs);
 * - never wedge the bridge ($.sleep, renderQueue.render, app.quit, scheduleTask);
 * - no files created, written or deleted anywhere (File/Folder remove, write, ...);
 * - projects open, close and save through the tools that check for unsaved work.
 * In code run with mutates:false it also flags writes (setValue, addProperty, ...)
 * because that path has no undo group, guard or receipt.
 *
 * It is NOT a sandbox. It strips comments, strings and regex literals first
 * (so `// never call app.quit()` and "alert" in a string do not trigger) and
 * then matches names, so code can dodge it: eval() of a built string,
 * obj["callSystem"], aliasing a method (var f = system.callSystem), or
 * files reached through a chain it cannot follow.
 */

import { stripForLint } from "./es3-lint.js";

export type SafetySeverity = "refuse" | "needs_mutates";

export interface SafetyFinding {
  line: number;
  /** The member as written in the rule, e.g. "system.callSystem". */
  member: string;
  message: string;
  /** The dedicated tool to use instead, or "none" when there is no route. */
  use_instead: string;
  severity: SafetySeverity;
}

const NONE = "none";

interface Rule {
  re: RegExp;
  member: string;
  message: string;
  use: string;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function escapeRe(s: string): string {
  return s.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&");
}

// Not preceded by a member dot or an identifier character: a global call or a bare name.
const BARE = "(?<![.\\w$])";

const REFUSE_RULES: Rule[] = [
  { re: /\bsystem\s*\.\s*callSystem\b/g, member: "system.callSystem", message: "launches outside programs; everything here runs inside After Effects", use: NONE },
  { re: /\.\s*execute\s*\(/g, member: ".execute()", message: "File.execute / Folder.execute opens a file or folder with an outside program", use: NONE },
  { re: new RegExp(BARE + "(?:new\\s+)?Socket\\s*\\(|\\bnew\\s+Socket\\b", "g"), member: "Socket", message: "network sockets reach outside After Effects", use: NONE },
  { re: /\$\s*\.\s*evalFile\b/g, member: "$.evalFile", message: "runs a file that is not linted or recorded", use: "ae_skill_run (a saved skill's steps)" },
  { re: /^[ \t]*#include(?:path)?\b/gm, member: "#include", message: "pulls in files that are not linted or recorded", use: "ae_skill_run (a saved skill's steps)" },
  { re: /\$\s*\.\s*sleep\b/g, member: "$.sleep", message: "blocks the bridge: After Effects stops answering until it returns", use: NONE },

  // Dialogs
  { re: /\bFile\s*\.\s*(?:openDialog|saveDialog)\b|\bFolder\s*\.\s*selectDialog\b|\.\s*(?:openDlg|saveDlg|selectDlg)\s*\(/g, member: "file dialog", message: "opens a dialog; the user is never made to answer a popup the agent started", use: "ae_ask_user" },
  { re: new RegExp(BARE + "(alert|confirm|prompt)\\s*\\(", "g"), member: "alert/confirm/prompt", message: "opens a dialog", use: "ae_ask_user" },
  { re: /\bWindow\s*\.\s*(?:alert|confirm|prompt)\b/g, member: "Window.alert/confirm/prompt", message: "opens a dialog", use: "ae_ask_user" },
  { re: new RegExp("\\bnew\\s+Window\\b|" + BARE + "Window\\s*\\(|\\bScriptUI\\b", "g"), member: "ScriptUI / new Window", message: "builds a window inside After Effects", use: NONE },
  { re: /\bapp\s*\.\s*(?:beginSuppressDialogs|endSuppressDialogs)\b/g, member: "app.beginSuppressDialogs", message: "hides dialogs; popups are read and answered, never suppressed", use: "ae_dialogs" },

  // App control
  { re: /\bapp\s*\.\s*(?:quit|restart)\s*\(/g, member: "app.quit / app.restart", message: "ends After Effects and with it the panel and this server", use: NONE },
  { re: /\bapp\s*\.\s*(?:scheduleTask|cancelTask|onError)\b/g, member: "app.scheduleTask / cancelTask / onError", message: "runs code later, outside the eval queue and the undo group", use: NONE },
  { re: /\bapp\s*\.\s*(?:watchFolder|pauseWatchFolder|endWatchFolder|exitAfterLaunchAndEval|exitCode|setSavePreferencesOnQuit)\b/g, member: "app.watchFolder / exitAfterLaunchAndEval / exitCode / setSavePreferencesOnQuit", message: "changes how After Effects runs or exits", use: NONE },
  { re: /\.\s*deletePref\s*\(/g, member: "deletePref", message: "deletes a preference", use: NONE },
  { re: /\bapp\s*\.\s*purge\s*\(/g, member: "app.purge", message: "purges caches without a report", use: "ae_memory_purge" },

  // Project open / save
  { re: /\bapp\s*\.\s*(?:newProject|open|openFast)\s*\(/g, member: "app.newProject / app.open / app.openFast", message: "swaps the open project without the unsaved-changes check", use: "ae_project_session" },
  { re: /\bproject\s*\.\s*close\s*\(/g, member: "project.close", message: "DO_NOT_SAVE_CHANGES throws the user's work away and PROMPT_TO_SAVE_CHANGES opens a dialog", use: "ae_project_session" },
  { re: /\bproject\s*\.\s*save\s*\(/g, member: "project.save()", message: "save() on an untitled project opens the Save dialog, and any save skips the backup copy, the path and overwrite checks and the session record", use: "ae_save (save_as: { path } for another file)" },
  { re: /\.\s*saveWithDialog\s*\(/g, member: "saveWithDialog", message: "opens a dialog", use: "ae_save with save_as: { path }" },
  { re: /\.\s*importFileWithDialog\s*\(/g, member: "importFileWithDialog", message: "opens a dialog", use: "ae_import_footage" },

  // Render queue
  { re: /\brenderQueue\s*\.\s*(?:render|pauseRendering|stopRendering)\s*\(/g, member: "renderQueue.render", message: "render() blocks the bridge for the whole render", use: "ae_aerender_start" },
  { re: /\.\s*onStatusChanged\b/g, member: "onStatusChanged", message: "only fires during an in-app render, which blocks the bridge", use: "ae_aerender_start" },
  { re: /\.\s*(?:queueInAME|canQueueInAME)\b/g, member: "queueInAME", message: "hands the render to a program outside After Effects", use: NONE },
  { re: /\.\s*\w*Team[Pp]roject\w*\s*\(/g, member: "Team Project methods", message: "Team Projects are out of scope", use: NONE },
];

const WRITE_METHODS = [
  "setValue", "setValueAtTime", "setValuesAtTimes", "setValueAtKey", "removeKey", "remove", "addProperty",
  "addComp", "addFolder", "addSolid", "addNull", "addText", "addBoxText", "addShape", "addCamera", "addLight",
  "addKey", "duplicate", "moveTo", "moveBefore", "moveAfter", "moveToBeginning", "moveToEnd", "replaceSource",
  "applyPreset", "save", "importFile", "setInterpolationTypeAtKey", "setTemporalEaseAtKey",
];

const WRITE_RE = new RegExp("\\.\\s*(" + WRITE_METHODS.join("|") + ")\\s*\\(", "g");
const ADD_RE = /\b(?:layers|items)\s*\.\s*add\s*\(/g;

const FILE_METHODS = "remove|rename|copy|create|write|writeln|open";

/** Names that hold a File or Folder in this code, found by how they are assigned. */
function fileVariables(stripped: string): string[] {
  const names = new Set<string>();
  const add = (re: RegExp, group = 1) => {
    for (const m of stripped.matchAll(re)) names.add(m[group]);
  };
  add(/([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?(?:File|Folder)\s*\(/g);
  add(/([A-Za-z_$][\w$]*)\s*=\s*Folder\s*\.\s*[A-Za-z]+(?!\s*[(\w$])/g);
  add(/([A-Za-z_$][\w$]*)\s*=\s*File\s*\.\s*decode\s*\(/g);
  add(/([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$.\s]|\([^()]*\)|\[[^\]]*\])*?\.\s*file(?![\w$])(?!\s*[(\w$.])/g);
  // One step of propagation: a parent folder, a list of files, one entry of it.
  for (let pass = 0; pass < 3; pass++) {
    if (names.size === 0) break;
    const alt = [...names].map(escapeRe).join("|");
    add(new RegExp("([A-Za-z_$][\\w$]*)\\s*=\\s*(?:" + alt + ")(?![\\w$])\\s*(?:\\.\\s*(?:parent|getFiles)\\b|\\[)", "g"));
  }
  return [...names];
}

/** Names assigned straight from `app.project` / a renderQueue. */
function aliasNames(stripped: string, re: RegExp): string[] {
  const out = new Set<string>();
  for (const m of stripped.matchAll(re)) out.add(m[1]);
  return [...out];
}

function modeProblem(raw: string, openParenEnd: number): string | null {
  // Reads are 'r' (the default). Anything that is not a literal r mode is refused.
  const m = /^\s*(?:(['"])([^'"]*)\1\s*[,)]|\))/.exec(raw.slice(openParenEnd, openParenEnd + 80));
  if (!m) return "the mode is not a string literal, so it cannot be checked";
  if (m[2] === undefined) return null; // open() with no argument reads
  const mode = m[2].charAt(0).toLowerCase();
  if (mode === "w" || mode === "a" || mode === "e") return "opens the file for writing";
  return null;
}

/**
 * Checks `code` and returns every finding, sorted by line. `mutates` is whether
 * the caller declared the code as writing: writes in code that is not declared
 * as mutating are findings of severity needs_mutates.
 */
export function lintJsxSafety(code: string, opts: { mutates: boolean }): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  const stripped = stripForLint(code);
  const aligned = stripped.length === code.length;
  const taken: Array<[number, number]> = [];
  const seen = new Set<string>();

  const push = (index: number, length: number, member: string, message: string, use: string, severity: SafetySeverity) => {
    const line = lineAt(stripped, index);
    const key = `${line}|${member}|${severity}`;
    taken.push([index, index + length]);
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ line, member, message, use_instead: use, severity });
  };

  for (const rule of REFUSE_RULES) {
    for (const m of stripped.matchAll(rule.re)) {
      push(m.index ?? 0, m[0].length, rule.member, rule.message, rule.use, "refuse");
    }
  }

  // //@include is a comment to the strip, so look for it in the raw source.
  for (const m of code.matchAll(/^[ \t]*\/\/@include(?:path)?\b/gm)) {
    push(m.index ?? 0, m[0].length, "//@include", "pulls in files that are not linted or recorded", "ae_skill_run (a saved skill's steps)", "refuse");
  }

  // A renderQueue or a project held in a variable.
  const rqNames = aliasNames(stripped, /([A-Za-z_$][\w$]*)\s*=\s*[\w$.\s]*\brenderQueue(?![\w$])(?!\s*\.)/g);
  if (rqNames.length > 0) {
    const re = new RegExp(BARE + "(?:" + rqNames.map(escapeRe).join("|") + ")\\s*\\.\\s*(?:render|pauseRendering|stopRendering)\\s*\\(", "g");
    for (const m of stripped.matchAll(re)) push(m.index ?? 0, m[0].length, "renderQueue.render", "render() blocks the bridge for the whole render", "ae_aerender_start", "refuse");
  }
  const projNames = aliasNames(stripped, /([A-Za-z_$][\w$]*)\s*=\s*app\s*\.\s*project(?![\w$])(?!\s*\.)/g);
  if (projNames.length > 0) {
    const alt = projNames.map(escapeRe).join("|");
    for (const m of stripped.matchAll(new RegExp(BARE + "(?:" + alt + ")\\s*\\.\\s*close\\s*\\(", "g"))) {
      push(m.index ?? 0, m[0].length, "project.close", "DO_NOT_SAVE_CHANGES throws the user's work away and PROMPT_TO_SAVE_CHANGES opens a dialog", "ae_project_session", "refuse");
    }
    for (const m of stripped.matchAll(new RegExp(BARE + "(?:" + alt + ")\\s*\\.\\s*save\\s*\\(", "g"))) {
      push(m.index ?? 0, m[0].length, "project.save()", "save() on an untitled project opens the Save dialog, and any save skips the backup copy, the path and overwrite checks and the session record", "ae_save (save_as: { path } for another file)", "refuse");
    }
  }

  // File and Folder: writes, deletes and renames anywhere on disk.
  const fileMsg: Record<string, string> = {
    remove: "deletes a file or folder",
    rename: "renames a file or folder",
    copy: "copies a file or folder",
    create: "creates a file or folder",
    write: "writes a file",
    writeln: "writes a file",
  };
  const reportFile = (idx: number, matched: string, method: string) => {
    if (method === "open") {
      const problem = aligned ? modeProblem(code, idx + matched.length) : "the mode cannot be checked";
      if (problem === null) return;
      push(idx, matched.length, "File.open", `${problem}; tools write their own files`, NONE, "refuse");
      return;
    }
    push(idx, matched.length, `File.${method}`, `${fileMsg[method] ?? "changes a file"}; tools write their own files and nothing outside the allowed locations`, NONE, "refuse");
  };
  const fileNames = fileVariables(stripped);
  if (fileNames.length > 0) {
    const alt = fileNames.map(escapeRe).join("|");
    const re = new RegExp(BARE + "(?:" + alt + ")(?:\\s*\\[[^\\]]*\\])*(?:\\s*\\.\\s*parent)*\\s*\\.\\s*(" + FILE_METHODS + ")\\s*\\(", "g");
    for (const m of stripped.matchAll(re)) reportFile(m.index ?? 0, m[0], m[1]);
  }
  const chain = new RegExp(
    "(?<![\\w$])(?:new\\s+)?(?:File|Folder)\\s*\\((?:[^()]|\\([^()]*\\))*\\)(?:\\s*\\.\\s*parent)*\\s*\\.\\s*(" + FILE_METHODS + ")\\s*\\(" +
      "|\\bFolder\\s*\\.\\s*[A-Za-z]+(?:\\s*\\.\\s*parent)*\\s*\\.\\s*(" + FILE_METHODS + ")\\s*\\(",
    "g"
  );
  for (const m of stripped.matchAll(chain)) reportFile(m.index ?? 0, m[0], m[1] ?? m[2]);
  // A File reached through a property: app.project.file, item.file, item.mainSource.file.
  const propFile = new RegExp("\\.\\s*file\\s*(?:\\.\\s*parent\\s*)*\\.\\s*(" + FILE_METHODS + ")\\s*\\(", "g");
  for (const m of stripped.matchAll(propFile)) reportFile(m.index ?? 0, m[0], m[1]);

  // Writes in code that was not declared as mutating.
  if (!opts.mutates) {
    const inRefused = (i: number) => taken.some(([a, b]) => i >= a && i < b);
    for (const m of stripped.matchAll(WRITE_RE)) {
      if (inRefused(m.index ?? 0)) continue;
      push(m.index ?? 0, m[0].length, `.${m[1]}()`, "changes the project, but mutates is false: this path has no undo group, no guard and no receipt", "ae_run_jsx with mutates: true and expect", "needs_mutates");
    }
    for (const m of stripped.matchAll(ADD_RE)) {
      if (inRefused(m.index ?? 0)) continue;
      push(m.index ?? 0, m[0].length, "layers.add() / items.add()", "changes the project, but mutates is false: this path has no undo group, no guard and no receipt", "ae_run_jsx with mutates: true and expect", "needs_mutates");
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

/** One line per finding, for error messages. */
export function describeSafetyFinding(f: SafetyFinding): string {
  const route =
    f.severity === "needs_mutates"
      ? "set mutates: true and pass expect"
      : f.use_instead === NONE
        ? "no tool does this; it is not available through this MCP"
        : `use ${f.use_instead}`;
  return `line ${f.line}: ${f.member} ${f.message}. Instead: ${route}.`;
}

/** The refusal text for a list of findings. */
export function safetyRefusalMessage(findings: SafetyFinding[], what: string): string {
  const lines = findings.map(describeSafetyFinding);
  return `${what} refused by the safety lint (a guard rail, not a sandbox). Nothing ran.\n${lines.join("\n")}`;
}
