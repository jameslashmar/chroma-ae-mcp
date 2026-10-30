#!/usr/bin/env node

/**
 * scripts/lint-jsx.mjs
 *
 * Scans panel/host/**\/*.jsx for syntax forbidden in After Effects ExtendScript (ES3):
 * 1. Chained ternaries: '?' ... ':' ... '?' within one expression
 *    (ExtendScript parses chained ternaries left-associatively, producing silent logic corruption).
 * 2. ES5+ syntax: let, const, =>, backtick template strings, class.
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
const targetDir = path.join(repoRoot, 'panel', 'host');

const findings = [];

function findJsxFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) {
    return results;
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

function main() {
  const files = findJsxFiles(targetDir);

  if (files.length === 0) {
    console.log(`No .jsx files found in ${path.relative(repoRoot, targetDir)}.`);
    process.exit(0);
  }

  for (const file of files) {
    const relativePath = path.relative(repoRoot, file).replace(/\\/g, '/');
    const source = fs.readFileSync(file, 'utf8');

    const stripped = stripStringsAndComments(source, relativePath);
    checkEs5Syntax(stripped, relativePath);
    checkChainedTernaries(stripped, relativePath);
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

  console.log(`JSX Lint Passed: ${files.length} file(s) scanned in ${path.relative(repoRoot, targetDir)}, 0 issues.`);
  process.exit(0);
}

main();
