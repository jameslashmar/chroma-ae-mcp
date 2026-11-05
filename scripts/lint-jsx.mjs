#!/usr/bin/env node

/**
 * scripts/lint-jsx.mjs
 *
 * Scans panel/host/**\/*.jsx for syntax forbidden in After Effects ExtendScript (ES3):
 * 1. Chained ternaries: '?' ... ':' ... '?' within one expression
 *    (ExtendScript parses chained ternaries left-associatively, producing silent logic corruption).
 * 2. ES5+ syntax: let, const, =>, backtick template strings, class.
 * 3. Non-ASCII characters anywhere (ExtendScript may read the file in the
 *    system code page, and U+2028/U+2029 end a string literal).
 * 4. ES3 reserved words (including the future reserved words) used as
 *    (a) a variable, function, parameter or catch name, or
 *    (b) an unquoted object-literal key or a property name after a dot.
 *    node:vm accepts these, ExtendScript refuses to parse the file ("Illegal use of
 *    reserved word"), and a file that fails to parse takes its whole tool group down.
 *    Use a rename, a quoted key ({ "delete": 0 }) or bracket notation (x["default"]).
 *
 * Usage: node scripts/lint-jsx.mjs [dir-or-file.jsx ...]   (default: panel/host)
 *
 * Strips comments and strings first, preserving original line numbers.
 * Exits with code 1 if any findings are discovered.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultTargetDir = path.join(repoRoot, 'panel', 'host');
const cliTargets = process.argv.slice(2).map((p) => path.resolve(p));
const targets = cliTargets.length > 0 ? cliTargets : [defaultTargetDir];

const findings = [];

function findJsxFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  if (fs.statSync(dir).isFile()) {
    return [dir];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsxFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsx')) {
      results.push(fullPath);
    }
  }
  return results;
}

const REGEX_AFTER_PUNCT = /^[([{:;,=+\-*!&|?~^%<>]$/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'else', 'do']);

// A '/' starts a regex literal at the start, after an operator, or after a keyword; otherwise it divides.
function startsRegex(prev, postfix) {
  if (prev === '') return true;
  if (postfix) return false;
  return REGEX_AFTER_PUNCT.test(prev) || REGEX_AFTER_WORD.has(prev);
}

function getLineNumber(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) { // '\n'
      line++;
    }
  }
  return line;
}

/**
 * Strips comments and strings while preserving all newline positions.
 * Also flags backtick template strings as ES5+ violations immediately.
 */
function stripStringsAndComments(source, filePath) {
  const output = [];
  const len = source.length;
  let i = 0;
  // The previous significant token: a word, a number, or one punctuation char.
  let prevNonWhitespace = '';
  let postfix = false; // prev is the second char of a postfix ++ or --

  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : '';

    // 1. Single-line comment //
    if (ch === '/' && next === '/') {
      output.push(' ', ' ');
      i += 2;
      while (i < len && source[i] !== '\n') {
        output.push(' ');
        i++;
      }
      continue;
    }

    // 2. Multi-line comment /* ... */
    if (ch === '/' && next === '*') {
      output.push(' ', ' ');
      i += 2;
      while (i < len) {
        if (source[i] === '*' && i + 1 < len && source[i + 1] === '/') {
          output.push(' ', ' ');
          i += 2;
          break;
        }
        if (source[i] === '\n') {
          output.push('\n');
        } else {
          output.push(' ');
        }
        i++;
      }
      continue;
    }

    // 3. Single-quoted string '...'
    if (ch === "'") {
      output.push(' ');
      i++;
      while (i < len) {
        const c = source[i];
        if (c === '\\') {
          output.push(' ');
          i++;
          if (i < len) {
            output.push(source[i] === '\n' ? '\n' : ' ');
            i++;
          }
          continue;
        }
        if (c === "'") {
          output.push(' ');
          i++;
          break;
        }
        output.push(c === '\n' ? '\n' : ' ');
        i++;
      }
      prevNonWhitespace = "'";
      postfix = false;
      continue;
    }

    // 4. Double-quoted string "..."
    if (ch === '"') {
      output.push(' ');
      i++;
      while (i < len) {
        const c = source[i];
        if (c === '\\') {
          output.push(' ');
          i++;
          if (i < len) {
            output.push(source[i] === '\n' ? '\n' : ' ');
            i++;
          }
          continue;
        }
        if (c === '"') {
          output.push(' ');
          i++;
          break;
        }
        output.push(c === '\n' ? '\n' : ' ');
        i++;
      }
      prevNonWhitespace = '"';
      postfix = false;
      continue;
    }

    // 5. Backtick template string `...` (ES5+ forbidden!)
    if (ch === '`') {
      const line = getLineNumber(source, i);
      findings.push({
        file: filePath,
        line,
        message: 'ES5+ syntax forbidden: backtick template string (`...`)',
      });

      output.push(' ');
      i++;
      while (i < len) {
        const c = source[i];
        if (c === '\\') {
          output.push(' ');
          i++;
          if (i < len) {
            output.push(source[i] === '\n' ? '\n' : ' ');
            i++;
          }
          continue;
        }
        if (c === '`') {
          output.push(' ');
          i++;
          break;
        }
        output.push(c === '\n' ? '\n' : ' ');
        i++;
      }
      prevNonWhitespace = '`';
      postfix = false;
      continue;
    }

    // 6. Regular expression literal /.../
    // A '/' begins a regex if preceded by start of expression, operator, punctuation, or certain keywords
    if (ch === '/' && startsRegex(prevNonWhitespace, postfix)) {
      output.push(' ');
      i++;
      let inCharClass = false;
      while (i < len) {
        const c = source[i];
        if (c === '\\') {
          output.push(' ');
          i++;
          if (i < len) {
            output.push(source[i] === '\n' ? '\n' : ' ');
            i++;
          }
          continue;
        }
        if (c === '[') {
          inCharClass = true;
        } else if (c === ']') {
          inCharClass = false;
        } else if (c === '/' && !inCharClass) {
          output.push(' ');
          i++;
          // Consume regex flags (e.g. g, i, m)
          while (i < len && /[a-z]/i.test(source[i])) {
            output.push(' ');
            i++;
          }
          break;
        }
        output.push(c === '\n' ? '\n' : ' ');
        i++;
      }
      prevNonWhitespace = '/';
      postfix = false;
      continue;
    }

    if (/[A-Za-z0-9_$]/.test(ch)) {
      let end = i;
      while (end < len && /[A-Za-z0-9_$]/.test(source[end])) end++;
      output.push(source.substring(i, end));
      prevNonWhitespace = source.substring(i, end);
      postfix = false;
      i = end;
      continue;
    }

    output.push(ch);
    if (!/\s/.test(ch)) {
      postfix = (ch === '+' || ch === '-') && prevNonWhitespace === ch && !postfix;
      prevNonWhitespace = ch;
    }
    i++;
  }

  return output.join('');
}

/**
 * Checks for ES5+ keywords and operators in stripped source:
 * - let (\blet\b)
 * - const (\bconst\b)
 * - class (\bclass\b)
 * - => (arrow functions)
 */
function checkEs5Syntax(stripped, filePath) {
  const patterns = [
    { regex: /\blet\b/g, name: "let" },
    { regex: /\bconst\b/g, name: "const" },
    { regex: /\bclass\b/g, name: "class" },
    { regex: /=>/g, name: "=>" },
  ];

  for (const { regex, name } of patterns) {
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      const line = getLineNumber(stripped, match.index);
      findings.push({
        file: filePath,
        line,
        message: `ES5+ syntax forbidden: '${name}'`,
      });
    }
  }
}

/**
 * Detects chained ternaries within an expression:
 * i.e. a '?' ... ':' ... '?' within one expression.
 */
function checkChainedTernaries(stripped, filePath) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let activeTernaries = []; // { startDepth: number, hasColon: boolean, line: number }

  const len = stripped.length;
  let i = 0;

  function resetExpression() {
    activeTernaries = [];
  }

  while (i < len) {
    const ch = stripped[i];

    // Check for statement keywords that reset expression
    if (/[a-zA-Z_$]/.test(ch)) {
      let end = i;
      while (end < len && /[a-zA-Z0-9_$]/.test(stripped[end])) {
        end++;
      }
      const word = stripped.substring(i, end);
      const statementStarters = new Set([
        'var', 'function', 'return', 'throw', 'if', 'else',
        'while', 'for', 'do', 'switch', 'case', 'default',
        'try', 'catch', 'finally'
      ]);
      if (statementStarters.has(word)) {
        resetExpression();
      }
      i = end;
      continue;
    }

    if (ch === '(') {
      parenDepth++;
    } else if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
      const curDepth = parenDepth + bracketDepth;
      // Remove ternaries that were fully enclosed inside the closed parentheses
      activeTernaries = activeTernaries.filter(t => t.startDepth <= curDepth);
    } else if (ch === '[') {
      bracketDepth++;
    } else if (ch === ']') {
      if (bracketDepth > 0) bracketDepth--;
      const curDepth = parenDepth + bracketDepth;
      activeTernaries = activeTernaries.filter(t => t.startDepth <= curDepth);
    } else if (ch === '{' || ch === '}' || ch === ';') {
      resetExpression();
    } else if (ch === ',') {
      const curDepth = parenDepth + bracketDepth;
      // A comma at or shallower than the ternary's depth closes completed ternaries
      activeTernaries = activeTernaries.filter(t => !(t.hasColon && t.startDepth >= curDepth));
    } else if (ch === '?') {
      const curDepth = parenDepth + bracketDepth;
      const line = getLineNumber(stripped, i);

      // If any active ternary has already seen its ':', seeing another '?' is a chained ternary!
      const hasActiveColonTernary = activeTernaries.some(t => t.hasColon);
      if (hasActiveColonTernary) {
        findings.push({
          file: filePath,
          line,
          message: "chained ternary operator forbidden (found '?' ... ':' ... '?')",
        });
      }

      activeTernaries.push({
        startDepth: curDepth,
        hasColon: false,
        line,
      });
    } else if (ch === ':') {
      // Find the most recent active ternary that doesn't yet have a colon
      for (let j = activeTernaries.length - 1; j >= 0; j--) {
        if (!activeTernaries[j].hasColon) {
          activeTernaries[j].hasColon = true;
          break;
        }
      }
    }

    i++;
  }
}

// ES3 reserved words: the keywords plus the "future reserved words" of ES3 (abstract, boolean, ...).
// ExtendScript implements ES3, so every one of these is illegal as an identifier.
const ES3_RESERVED = new Set((
  'abstract boolean break byte case catch char class const continue debugger default delete do ' +
  'double else enum export extends false final finally float for function goto if implements ' +
  'import in instanceof int interface long native new null package private protected public ' +
  'return short static super switch synchronized this throw throws transient true try typeof ' +
  'var void volatile while with'
).split(' '));

// Reserved words that may follow a dot because the After Effects / ExtendScript API itself
// spells a member that way. Keep this short and add an entry only with a reason.
// Currently empty: no AE DOM member used in this repo is a reserved word (layer.source,
// item.parentFolder and friends are not reserved). Where code merely wants such a name,
// use bracket notation (x["default"]) or rename instead of adding to this list.
const AE_API_RESERVED_AFTER_DOT = new Set([
]);

// A '{' opens an object literal (not a block) when it follows one of these tokens.
const OBJECT_LITERAL_AFTER = new Set(['(', ',', '=', ':', '[', '?', '!', '&', '|', '+', '-', '*', '/', '%', '<', '>', '~', '^', 'return', 'typeof', 'in', 'case', 'throw', 'new', 'void', 'delete']);

function tokenize(stripped) {
  const tokens = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*|\d[A-Za-z0-9_.]*|\S/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    tokens.push({ text: m[0], index: m.index, isWord: /^[A-Za-z_$]/.test(m[0]) });
  }
  return tokens;
}

/**
 * Flags ES3 reserved words used as names: variable / function / parameter / catch names,
 * unquoted object-literal keys, and property names after a dot. Strings and comments are
 * already stripped, so quoted keys ({ "delete": 0 }) and bracket access (x["default"]) pass.
 */
function checkReservedWords(stripped, filePath) {
  const tokens = tokenize(stripped);
  const flagged = new Set();

  function flag(tok, why) {
    const line = getLineNumber(stripped, tok.index);
    if (flagged.has(tok.index)) return;
    flagged.add(tok.index);
    findings.push({
      file: filePath,
      line,
      message: `ES3 reserved word '${tok.text}' ${why} (ExtendScript: "Illegal use of reserved word")`,
    });
  }

  function checkName(tok, why) {
    if (tok && tok.isWord && ES3_RESERVED.has(tok.text)) flag(tok, why);
  }

  // Open braces, innermost last: true = object literal, false = block.
  const braces = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;
    const next = i + 1 < tokens.length ? tokens[i + 1] : null;

    if (tok.text === '{') {
      braces.push(prev !== null && OBJECT_LITERAL_AFTER.has(prev.text));
      continue;
    }
    if (tok.text === '}') {
      braces.pop();
      continue;
    }
    if (!tok.isWord) continue;

    // (b1) property name after a dot
    if (prev !== null && prev.text === '.' && ES3_RESERVED.has(tok.text)) {
      if (!AE_API_RESERVED_AFTER_DOT.has(tok.text)) {
        flag(tok, 'used as a property name after a dot; use bracket notation or a different name');
      }
      continue;
    }

    // (b2) unquoted object-literal key: '{' or ',' directly before and ':' directly after,
    // inside an object literal (so `default:` in a switch block is not flagged)
    if (
      ES3_RESERVED.has(tok.text) && prev !== null && next !== null && next.text === ':' &&
      (prev.text === '{' || prev.text === ',') && braces.length > 0 && braces[braces.length - 1]
    ) {
      flag(tok, 'used as an unquoted object-literal key; quote it');
      continue;
    }

    // (a) declarations
    if (tok.text === 'var') {
      // var a = 1, b = 2;  -- check each declarator name
      checkName(next, 'used as a variable name');
      let depth = 0;
      for (let j = i + 2; j < tokens.length; j++) {
        const t = tokens[j].text;
        if (t === '(' || t === '[' || t === '{') {
          depth++;
        } else if (t === ')' || t === ']' || t === '}') {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && (t === ';' || t === 'var' || t === 'in')) {
          break;
        } else if (depth === 0 && t === ',') {
          checkName(tokens[j + 1], 'used as a variable name');
        }
      }
    } else if (tok.text === 'function') {
      let j = i + 1;
      if (tokens[j] && tokens[j].isWord) {
        checkName(tokens[j], 'used as a function name');
        j++;
      }
      if (tokens[j] && tokens[j].text === '(') {
        for (j++; j < tokens.length && tokens[j].text !== ')'; j++) {
          if (tokens[j].isWord) checkName(tokens[j], 'used as a parameter name');
        }
      }
    } else if (tok.text === 'catch' && next !== null && next.text === '(') {
      checkName(tokens[i + 2], 'used as a catch variable name');
    }
  }
}

function checkAscii(source, filePath) {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /[^\x00-\x7F]/.exec(lines[i]);
    if (m) {
      const code = m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      findings.push({ file: filePath, line: i + 1, message: `Non-ASCII character U+${code}: use a \\u escape or plain ASCII` });
    }
  }
}

function main() {
  const files = targets.flatMap((t) => findJsxFiles(t));
  const targetLabel = targets.map((t) => path.relative(repoRoot, t).split(path.sep).join('/') || '.').join(', ');

  if (files.length === 0) {
    console.log(`No .jsx files found in ${targetLabel}.`);
    process.exit(0);
  }

  for (const file of files) {
    const relativePath = path.relative(repoRoot, file).replace(/\\/g, '/');
    const source = fs.readFileSync(file, 'utf8');

    checkAscii(source, relativePath);
    const stripped = stripStringsAndComments(source, relativePath);
    checkEs5Syntax(stripped, relativePath);
    checkChainedTernaries(stripped, relativePath);
    checkReservedWords(stripped, relativePath);
  }

  if (findings.length > 0) {
    // Sort findings by file and line
    findings.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    });

    console.error(`\nJSX Lint Failed: ${findings.length} issue(s) found:\n`);
    for (const f of findings) {
      console.error(`${f.file}:${f.line}: ${f.message}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log(`JSX Lint Passed: ${files.length} file(s) scanned in ${targetLabel}, 0 issues.`);
  process.exit(0);
}

main();
