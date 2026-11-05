/**
 * server/src/es3-lint.ts
 *
 * Checks ExtendScript source for syntax AE's ES3 engine rejects or misreads,
 * with the same rules as scripts/lint-jsx.mjs:
 * - let, const, class, arrow functions and backtick strings;
 * - chained ternaries (`a ? b : c ? d : e`), which ExtendScript parses
 *   left-associatively, silently changing the logic.
 *
 * Used on code that reaches AE from outside the repo (saved skills), where
 * the repo's lint never runs.
 */

export interface Es3Finding {
  line: number;
  message: string;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

const REGEX_AFTER_PUNCT = /^[([{:;,=+\-*!&|?~^%<>]$/;
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "in", "instanceof", "new", "delete", "void", "throw", "else", "do"]);

/** A `/` starts a regex literal at the start, after an operator, or after a keyword; otherwise it divides. */
function startsRegex(prev: string, postfix: boolean): boolean {
  if (prev === "") return true;
  if (postfix) return false;
  return REGEX_AFTER_PUNCT.test(prev) || REGEX_AFTER_WORD.has(prev);
}

/** Blanks out comments, strings and regex literals, keeping newlines so line numbers hold. */
function strip(source: string, findings: Es3Finding[]): string {
  const out: string[] = [];
  const len = source.length;
  let i = 0;
  // The previous significant token: a word, a number, or one punctuation char.
  let prev = "";
  let postfix = false; // prev is the second char of a postfix ++ or --

  const skipQuoted = (quote: string) => {
    out.push(" ");
    i++;
    while (i < len) {
      const c = source[i];
      if (c === "\\") {
        out.push(" ");
        i++;
        if (i < len) {
          out.push(source[i] === "\n" ? "\n" : " ");
          i++;
        }
        continue;
      }
      if (c === quote) {
        out.push(" ");
        i++;
        break;
      }
      out.push(c === "\n" ? "\n" : " ");
      i++;
    }
    prev = quote;
    postfix = false;
  };

  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < len && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < len) {
        if (source[i] === "*" && source[i + 1] === "/") {
          out.push(" ", " ");
          i += 2;
          break;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      skipQuoted(ch);
      continue;
    }
    if (ch === "`") {
      findings.push({ line: lineAt(source, i), message: "backtick template strings are not ES3; use quotes and +" });
      skipQuoted("`");
      continue;
    }
    if (ch === "/" && startsRegex(prev, postfix)) {
      out.push(" ");
      i++;
      let inClass = false;
      while (i < len) {
        const c = source[i];
        if (c === "\\") {
          out.push(" ");
          i++;
          if (i < len) {
            out.push(source[i] === "\n" ? "\n" : " ");
            i++;
          }
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          out.push(" ");
          i++;
          while (i < len && /[a-z]/i.test(source[i])) {
            out.push(" ");
            i++;
          }
          break;
        }
        out.push(c === "\n" ? "\n" : " ");
        i++;
      }
      prev = "/";
      postfix = false;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let end = i;
      while (end < len && /[A-Za-z0-9_$]/.test(source[end])) end++;
      out.push(source.substring(i, end));
      prev = source.substring(i, end);
      postfix = false;
      i = end;
      continue;
    }
    out.push(ch);
    if (!/\s/.test(ch)) {
      postfix = (ch === "+" || ch === "-") && prev === ch && !postfix;
      prev = ch;
    }
    i++;
  }
  return out.join("");
}

const FORBIDDEN: Array<{ regex: RegExp; message: string }> = [
  { regex: /\blet\b/g, message: "'let' is not ES3; use var" },
  { regex: /\bconst\b/g, message: "'const' is not ES3; use var" },
  { regex: /\bclass\b/g, message: "'class' is not ES3; use functions" },
  { regex: /=>/g, message: "arrow functions are not ES3; use function () {}" },
];

const STATEMENT_STARTERS = new Set([
  "var", "function", "return", "throw", "if", "else", "while", "for", "do",
  "switch", "case", "default", "try", "catch", "finally",
]);

function chainedTernaries(stripped: string, findings: Es3Finding[]): void {
  let parens = 0;
  let brackets = 0;
  let active: Array<{ depth: number; hasColon: boolean }> = [];
  const len = stripped.length;
  let i = 0;
  while (i < len) {
    const ch = stripped[i];
    if (/[a-zA-Z_$]/.test(ch)) {
      let end = i;
      while (end < len && /[a-zA-Z0-9_$]/.test(stripped[end])) end++;
      if (STATEMENT_STARTERS.has(stripped.substring(i, end))) active = [];
      i = end;
      continue;
    }
    const depth = parens + brackets;
    if (ch === "(") parens++;
    else if (ch === "[") brackets++;
    else if (ch === ")" || ch === "]") {
      if (ch === ")" && parens > 0) parens--;
      if (ch === "]" && brackets > 0) brackets--;
      const d = parens + brackets;
      active = active.filter((t) => t.depth <= d);
    } else if (ch === "{" || ch === "}" || ch === ";") {
      active = [];
    } else if (ch === ",") {
      active = active.filter((t) => !(t.hasColon && t.depth >= depth));
    } else if (ch === "?") {
      if (active.some((t) => t.hasColon)) {
        findings.push({ line: lineAt(stripped, i), message: "chained ternary: ExtendScript parses it left to right; use if / else" });
      }
      active.push({ depth, hasColon: false });
    } else if (ch === ":") {
      for (let j = active.length - 1; j >= 0; j--) {
        if (!active[j].hasColon) {
          active[j].hasColon = true;
          break;
        }
      }
    }
    i++;
  }
}

/**
 * The source with comments, strings and regex literals blanked to spaces
 * (newlines kept), so the result has the same length and line numbers as the
 * input. Other static checks (jsx-safety-lint.ts) match against it so a name
 * inside a string or comment never triggers.
 */
export function stripForLint(source: string): string {
  return strip(source, []);
}

export function lintEs3(source: string): Es3Finding[] {
  const findings: Es3Finding[] = [];
  const stripped = strip(source, findings);
  for (const { regex, message } of FORBIDDEN) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(stripped)) !== null) findings.push({ line: lineAt(stripped, m.index), message });
  }
  chainedTernaries(stripped, findings);
  return findings.sort((a, b) => a.line - b.line);
}
