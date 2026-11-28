// Strict parser, normaliser and validator for SKILL.md frontmatter.
//
// The frontmatter is limited to a portable YAML subset, so that every value reads as the same
// string under any YAML 1.1 or 1.2 parser (the Skills extension serves it to arbitrary hosts):
//
//   ---
//   name: some-skill
//   description: "Double quoted, with \" and \\ escapes."
//   other: 'single quoted, '' escapes a quote'
//   metadata:
//     version: "1.0.0"
//   ---
//
// Top-level `key: value` lines, `key:` followed by lines indented by exactly two spaces (a
// one-level map of strings), `#` comment lines and blank lines. Nothing else. Plain (unquoted)
// scalars are accepted only when no YAML parser could reject them or read them as a non-string.
// Plain ESM, no dependencies. Used by scripts/sync-guidance.mjs and server/test.

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const KEY_LINE_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(?: +(.*))?$/;

// Characters some YAML parser rejects or rewrites in a scalar (C0 and C1 controls, NEL, BOM, line and paragraph
// separators). Tab, line feed and carriage return are allowed only as \t \n \r escapes in a double-quoted value.
const UNSAFE_CHARS = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\ufeff" + String.fromCharCode(0x2028, 0x2029) + "]");

/** Why a plain (unquoted) scalar is not portable, or null if it is. */
export function plainScalarProblem(v) {
  if (v === "") return "is empty";
  if (/[\u0000-\u001f\u007f]/.test(v) || UNSAFE_CHARS.test(v)) return "contains a control character";
  if (/^\s|\s$/.test(v)) return "has leading or trailing whitespace";
  if (v.includes(": ")) return 'contains ": "';
  if (v.includes(" #")) return 'contains " #"';
  if (v.endsWith(":")) return 'ends with ":"';
  if ("[]{}#&*!|>'\"%@`,".includes(v[0])) return `starts with the YAML indicator "${v[0]}"`;
  if (/^(-|\?|:)( |$)/.test(v)) return `starts with the YAML indicator "${v[0]}"`;
  if (v === "=" || v === "<<") return "is a YAML special value";
  if (/^(true|false|yes|no|on|off|y|n|null|~)$/i.test(v)) return "would be read as a boolean or null";
  if (
    /^[-+]?(\.[0-9]|[0-9])[0-9._]*([eE][-+]?[0-9]+)?$/.test(v) ||
    /^[-+]?0[xXoObB][0-9a-fA-F_]+$/.test(v) ||
    /^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+(\.[0-9_]*)?$/.test(v) ||
    /^[-+]?\.(inf|nan)$/i.test(v)
  ) {
    return "would be read as a number";
  }
  if (/^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}([Tt ].*)?$/.test(v)) return "would be read as a date";
  return null;
}

/** A double-quoted YAML scalar for s, using only the escapes the subset allows. */
export function quoteYamlString(s) {
  let out = JSON.stringify(String(s)); // \" \\ \b \f \n \r \t \uXXXX
  out = out.replace(new RegExp("[\\u007f-\\u009f" + String.fromCharCode(0x2028, 0x2029) + "]", "g"), (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return out;
}

const SIMPLE_ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function parseDoubleQuoted(raw, lineNo) {
  let out = "";
  let i = 1;
  for (;;) {
    if (i >= raw.length) throw new Error(`line ${lineNo}: unterminated double-quoted string`);
    const c = raw[i];
    if (c === '"') {
      if (i !== raw.length - 1) throw new Error(`line ${lineNo}: unexpected text after the closing double quote`);
      return out;
    }
    if (c === "\\") {
      const e = raw[i + 1];
      if (e !== undefined && Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, e)) {
        out += SIMPLE_ESCAPES[e];
        i += 2;
      } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        throw new Error(
          `line ${lineNo}: unsupported escape "\\${e ?? ""}" (allowed: \\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX)`
        );
      }
    } else {
      out += c;
      i += 1;
    }
  }
}

function parseSingleQuoted(raw, lineNo) {
  let out = "";
  let i = 1;
  for (;;) {
    if (i >= raw.length) throw new Error(`line ${lineNo}: unterminated single-quoted string`);
    if (raw[i] === "'") {
      if (raw[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      if (i !== raw.length - 1) throw new Error(`line ${lineNo}: unexpected text after the closing single quote`);
      return out;
    }
    out += raw[i];
    i += 1;
  }
}

/** The string value of the text after "key:", or throws. */
function parseValue(raw, lineNo, key) {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`line ${lineNo}: "${key}" has an empty value`);
  }
  const v = raw.trim();
  if (v[0] === '"' || v[0] === "'") {
    const s = v[0] === '"' ? parseDoubleQuoted(v, lineNo) : parseSingleQuoted(v, lineNo);
    if (UNSAFE_CHARS.test(s) || (v[0] === "'" && /[\t\n\r]/.test(s))) {
      throw new Error(`line ${lineNo}: the value of "${key}" contains a control character that some YAML parsers reject`);
    }
    return s;
  }
  const problem = plainScalarProblem(v);
  if (problem) {
    throw new Error(
      `line ${lineNo}: the plain value of "${key}" ${problem}; quote it, e.g. ${key}: ${quoteYamlString(v)}`
    );
  }
  return v;
}

function splitDocument(text) {
  const src = String(text).replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) throw new Error('line 1: a SKILL.md must start with a "---" line');
  const lines = src.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('missing closing "---" line of the frontmatter');
  return { lines, end };
}

/** A key that a YAML parser would read as a boolean, null, number or date (yes:, on:, 1:, 2026-11-28:) is refused. */
function checkKey(key, lineNo) {
  const problem = plainScalarProblem(key);
  if (problem) throw new Error(`line ${lineNo}: the key "${key}" ${problem}; use a word key`);
}

/** Parses the frontmatter of a SKILL.md. Returns { frontmatter, body }. Throws on anything outside the subset. */
export function parseFrontmatter(text) {
  const { lines, end } = splitDocument(text);
  const fm = {};
  let openKey = null; // top-level key awaiting a nested map
  let openMap = null;
  const closeOpen = (lineNo) => {
    if (openKey !== null && Object.keys(openMap).length === 0) {
      throw new Error(`line ${lineNo}: "${openKey}" has an empty value`);
    }
    openKey = null;
    openMap = null;
  };
  for (let i = 1; i < end; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (line.includes("\t")) throw new Error(`line ${lineNo}: tabs are not allowed`);
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const nested = /^ {2}(?! )/.test(line);
    if (/^ /.test(line) && !nested) {
      throw new Error(`line ${lineNo}: indentation must be exactly two spaces`);
    }
    if (nested) {
      if (openKey === null) throw new Error(`line ${lineNo}: indented line without a parent "key:"`);
      const m = KEY_LINE_RE.exec(line.slice(2));
      if (!m) throw new Error(`line ${lineNo}: expected "subkey: value"`);
      const sub = m[1];
      if (sub === "__proto__") throw new Error(`line ${lineNo}: key "__proto__" is not allowed`);
      checkKey(sub, lineNo);
      if (Object.prototype.hasOwnProperty.call(openMap, sub)) {
        throw new Error(`line ${lineNo}: duplicate key "${openKey}.${sub}"`);
      }
      openMap[sub] = parseValue(m[2], lineNo, sub);
      continue;
    }
    closeOpen(lineNo);
    const m = KEY_LINE_RE.exec(line);
    if (!m) throw new Error(`line ${lineNo}: expected "key: value" (keys match ${KEY_RE})`);
    const key = m[1];
    if (key === "__proto__") throw new Error(`line ${lineNo}: key "__proto__" is not allowed`);
    checkKey(key, lineNo);
    if (Object.prototype.hasOwnProperty.call(fm, key)) throw new Error(`line ${lineNo}: duplicate key "${key}"`);
    if (m[2] === undefined || m[2].trim() === "") {
      openKey = key;
      openMap = {};
      fm[key] = openMap;
    } else {
      fm[key] = parseValue(m[2], lineNo, key);
    }
  }
  closeOpen(end + 1);
  return { frontmatter: fm, body: lines.slice(end + 1).join("\n") };
}

/**
 * Rewrites each non-portable plain scalar (top-level or nested) as a double-quoted scalar and
 * leaves every other byte alone. Returns { text, changed } where changed lists the keys quoted
 * ("description", "metadata.version"). Throws for a plain value holding " #": YAML reads the rest as a
 * comment, so neither quoting it nor keeping it would serve what the author meant.
 */
export function normaliseFrontmatter(text) {
  const { lines, end } = splitDocument(text);
  const src = String(text);
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const raw = src.split(eol);
  const changed = [];
  let parent = "";
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const nested = /^ {2}(?! )/.test(line);
    const body = nested ? line.slice(2) : line;
    const m = KEY_LINE_RE.exec(body);
    if (!m) continue; // parseFrontmatter reports it
    if (!nested) parent = m[1];
    if (m[2] === undefined || m[2].trim() === "") continue;
    const v = m[2].trim();
    if (v[0] === '"' || v[0] === "'") continue;
    if (plainScalarProblem(v) === null) continue;
    // " #" starts a YAML comment, so quoting the whole text would turn the comment into part of the value.
    if (v.includes(" #")) {
      throw new Error(`line ${i + 1}: the value of "${m[1]}" contains " #", which YAML reads as a comment; quote the value or remove the comment in the source`);
    }
    const prefix = body.slice(0, body.length - m[2].length);
    raw[i] = (nested ? "  " : "") + prefix + quoteYamlString(v);
    changed.push(nested ? `${parent}.${m[1]}` : m[1]);
  }
  return { text: raw.join(eol), changed };
}

/** Problems (strings) with a parsed frontmatter object per the Agent Skills specification. */
export function validateSkillFrontmatter(fm) {
  const problems = [];
  const name = fm && fm.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 64) {
    problems.push("name must be a string of 1-64 characters");
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    problems.push(
      `name "${name}" must be lowercase letters, digits and single hyphens, not starting or ending with a hyphen`
    );
  }
  const d = fm && fm.description;
  if (typeof d !== "string" || d.trim() === "") problems.push("description must be a non-empty string");
  else if (d.length > 1024) problems.push(`description is ${d.length} characters (max 1024)`);
  if (fm && fm.compatibility !== undefined) {
    if (typeof fm.compatibility !== "string") problems.push("compatibility must be a string");
    else if (fm.compatibility.length > 500) {
      problems.push(`compatibility is ${fm.compatibility.length} characters (max 500)`);
    }
  }
  if (fm && fm.metadata !== undefined) {
    const md = fm.metadata;
    if (md === null || typeof md !== "object" || Array.isArray(md)) problems.push("metadata must be a map of strings");
    else if (Object.values(md).some((x) => typeof x !== "string")) problems.push("metadata values must all be strings");
  }
  return problems;
}
