import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_SKILLS, SKILL_TEXT } from "../src/guidance/content.generated.js";
import { getMcpSkill, listMcpSkills, readMcpSkillFile, SKILL_URI_SCHEME } from "../src/guidance/mcp-skills.js";
// @ts-expect-error plain ESM without types
import * as fm from "../../scripts/skill-frontmatter.mjs";

const { parseFrontmatter, normaliseFrontmatter, quoteYamlString, validateSkillFrontmatter } = fm as {
  parseFrontmatter: (t: string) => { frontmatter: Record<string, unknown>; body: string };
  normaliseFrontmatter: (t: string) => { text: string; changed: string[] };
  quoteYamlString: (s: string) => string;
  validateSkillFrontmatter: (f: unknown) => string[];
};

const guidanceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "guidance");

function walk(d: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(d, e.name), rel));
    else if (e.name.endsWith(".md")) out.push(rel);
  }
  return out.sort();
}

const sha = (s: string) => crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/**
 * Relative references that do not resolve against the skill root (the folder holding SKILL.md),
 * per the Skills spec, but are known and left as they are (upstream content). Format:
 * "<skill name>|<file>|<reference>".
 */
const KNOWN_UNRESOLVED: string[] = [
  // `MOTION.md` is the per-project spec file the skill tells the agent to write, not a skill file.
  "chroma-motion-director|SKILL.md|MOTION.md",
  "chroma-motion-director|references/review.md|MOTION.md",
  "chroma-motion-director|references/spec.md|MOTION.md",
  // Points at another skill (chroma-motion-director) by its in-skill path.
  "captions|SKILL.md|references/sound-and-captions.md",
  // Sibling references written relative to their own folder (references/), not to the skill root.
  "captions|references/chroma-ae-workflow.md|asr.md",
  "captions|references/social-and-platforms.md|sdh-and-speakers.md",
  "captions|references/standards.md|timing-and-breaks.md",
  "captions|references/standards.md|asr.md",
];

function relativeRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) refs.add(m[1]);
  for (const m of text.matchAll(/`([^`\s]+\.md)`/g)) refs.add(m[1]);
  return [...refs]
    .map((r) => r.split("#")[0])
    .filter((r) => r !== "" && r.endsWith(".md"))
    .filter((r) => !/^[a-z][a-z0-9+.-]*:/i.test(r) && !r.startsWith("/") && !r.startsWith("~") && !r.includes("*"));
}

describe("mcp skills: manifest and text", () => {
  const skills = listMcpSkills();

  it("serves every skill folder, sorted by name", () => {
    const dirs = fs
      .readdirSync(guidanceRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(guidanceRoot, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
    expect(MCP_SKILLS.map((s) => s.dir).sort()).toEqual(dirs);
    const names = skills.map((s) => s.frontmatter.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("chroma-motion-director");
    expect(names).toContain("captions");
  });

  it("names are unique", () => {
    const names = skills.map((s) => s.frontmatter.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const manifest of MCP_SKILLS) {
    describe(manifest.dir, () => {
      const entry = skills.find((s) => s.frontmatter.name === manifest.name)!;
      const folder = path.join(guidanceRoot, manifest.dir);

      it("has a SKILL.md uri named after the frontmatter name", () => {
        expect(entry.uri).toBe(`${SKILL_URI_SCHEME}${manifest.name}/SKILL.md`);
        const segments = entry.uri.slice(SKILL_URI_SCHEME.length).split("/");
        expect(segments[0]).toBe(entry.frontmatter.name);
        expect(segments[segments.length - 1]).toBe("SKILL.md");
      });

      it("frontmatter equals the parsed SKILL.md and is valid", () => {
        const disk = fs.readFileSync(path.join(folder, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
        expect(entry.frontmatter).toEqual(parseFrontmatter(disk).frontmatter);
        expect(validateSkillFrontmatter(entry.frontmatter)).toEqual([]);
      });

      it("manifest is complete: exactly the folder's files, SKILL.md first, each once", () => {
        const paths = entry.resources.map((r) => r.uri.slice(`${SKILL_URI_SCHEME}${manifest.name}/`.length));
        expect(paths[0]).toBe("SKILL.md");
        expect([...paths].sort()).toEqual(walk(folder));
        expect(new Set(paths).size).toBe(paths.length);
      });

      it("digests and sizes match the text readMcpSkillFile returns, and the disk", () => {
        for (const r of entry.resources) {
          const f = readMcpSkillFile(r.uri);
          expect(f, r.uri).toBeDefined();
          expect(f!.uri).toBe(r.uri);
          expect(f!.mimeType).toBe(r.uri.endsWith(".md") ? "text/markdown" : "text/plain");
          expect(r.digest, r.uri).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(r.digest, r.uri).toBe(`sha256:${sha(f!.text)}`);
          expect(r.size, r.uri).toBe(Buffer.byteLength(f!.text, "utf8"));
          const rel = r.uri.slice(`${SKILL_URI_SCHEME}${manifest.name}/`.length);
          const disk = fs.readFileSync(path.join(folder, rel), "utf8").replace(/\r\n/g, "\n");
          expect(f!.text, r.uri).toBe(disk);
          expect(SKILL_TEXT[manifest.dir][rel]).toBe(disk);
        }
      });

      it("is within the Skills extension limits", () => {
        expect(entry.resources.length).toBeLessThanOrEqual(512);
        expect(entry.resources.reduce((n, r) => n + r.size, 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
      });

      it("every relative reference resolves against the skill root to a manifest file", () => {
        const known = new Set(entry.resources.map((r) => r.uri));
        const unresolved: string[] = [];
        for (const r of entry.resources) {
          const rel = r.uri.slice(`${SKILL_URI_SCHEME}${manifest.name}/`.length);
          const text = readMcpSkillFile(r.uri)!.text;
          for (const ref of relativeRefs(text)) {
            const target = path.posix.normalize(ref);
            const uri = `${SKILL_URI_SCHEME}${manifest.name}/${target}`;
            if (!known.has(uri)) unresolved.push(`${manifest.name}|${rel}|${ref}`);
          }
        }
        expect(unresolved.filter((u) => !KNOWN_UNRESOLVED.includes(u))).toEqual([]);
        // Known exceptions must still exist, so the list cannot go stale.
        const stale = KNOWN_UNRESOLVED.filter((u) => u.startsWith(`${manifest.name}|`) && !unresolved.includes(u));
        expect(stale).toEqual([]);
      });
    });
  }
});

describe("mcp skills: lookups", () => {
  it("unknown and near-miss uris return undefined", () => {
    const good = "skill://chroma-motion-director/SKILL.md";
    expect(getMcpSkill(good)).toBeDefined();
    const bad = [
      "",
      "skill://",
      "skill://chroma-motion-director",
      "skill://chroma-motion-director/",
      "skill://chroma-motion-director/SKILL.md/",
      "skill://chroma-motion-director/skill.md",
      "skill://Chroma-Motion-Director/SKILL.md",
      "SKILL://chroma-motion-director/SKILL.md",
      "skill://motion-director/SKILL.md",
      "skill://chroma-motion-director/../captions/SKILL.md",
      "skill://chroma-motion-director/references/../SKILL.md",
      "skill://chroma-motion-director/./SKILL.md",
      "skill://chroma-motion-director/references/nope.md",
      "skill://chroma-motion-director/SKILL.md ",
      "skill://captions/references/spec.md",
      "chroma-ae://guidance/motion-director/SKILL.md",
    ];
    for (const uri of bad) {
      expect(getMcpSkill(uri), uri).toBeUndefined();
      expect(readMcpSkillFile(uri), uri).toBeUndefined();
    }
    // getMcpSkill is for SKILL.md uris only; a reference file is not a skill entry.
    expect(getMcpSkill("skill://chroma-motion-director/references/spec.md")).toBeUndefined();
    expect(readMcpSkillFile("skill://chroma-motion-director/references/spec.md")).toBeDefined();
  });

  it("returns copies: mutating one does not change the next call", () => {
    const a = listMcpSkills();
    const d0 = a[0].frontmatter.description;
    a[0].frontmatter.description = "changed";
    a[0].frontmatter.extra = "x";
    a[0].resources[0].digest = "sha256:bad";
    a[0].resources.pop();
    a.pop();
    const b = listMcpSkills();
    expect(b[0].frontmatter.description).toBe(d0);
    expect(b[0].frontmatter.extra).toBeUndefined();
    expect(b[0].resources[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.length).toBe(MCP_SKILLS.length);

    const g = getMcpSkill(b[0].uri)!;
    g.resources.length = 0;
    (g.frontmatter.metadata as Record<string, string> | undefined) && ((g.frontmatter.metadata as Record<string, string>).version = "zzz");
    const g2 = getMcpSkill(b[0].uri)!;
    expect(g2.resources.length).toBe(b[0].resources.length);
    expect(g2).toEqual(b[0]);
  });
});

describe("skill-frontmatter: parseFrontmatter", () => {
  const doc = (inner: string) => `---\n${inner}\n---\nbody\n`;

  it("accepts plain, double-quoted, single-quoted values, a nested map, comments and blanks", () => {
    const r = parseFrontmatter(
      doc(
        [
          "# a comment",
          "name: my-skill",
          'description: "Has: colons, \\"quotes\\", \\\\ and \\u00e9 \\n."',
          "other: 'it''s fine: really'",
          "",
          "metadata:",
          "  version: \"1.0.0\"",
          "  sources: see NOTICE.md",
        ].join("\n")
      )
    );
    expect(r.frontmatter).toEqual({
      name: "my-skill",
      description: 'Has: colons, "quotes", \\ and \u00e9 \n.',
      other: "it's fine: really",
      metadata: { version: "1.0.0", sources: "see NOTICE.md" },
    });
    expect(r.body).toBe("body\n");
  });

  it("accepts plain scalars that merely look odd but are portable strings", () => {
    const r = parseFrontmatter(doc(["a: v1.0.0","b: a:b", "c: x#y", "d: -dash", "e: yesterday", "f: 12abc"].join("\n")));
    expect(r.frontmatter).toEqual({ a: "v1.0.0", b: "a:b", c: "x#y", d: "-dash", e: "yesterday", f: "12abc" });
  });

  it("rejects what a YAML parser could reject or retype", () => {
    const bad: Array<[string, RegExp]> = [
      ["description: Use for X: do Y", /contains ": "/],
      ["a: foo #bar", /" #"/],
      ["a: foo:", /ends with ":"/],
      ["a: true", /boolean/],
      ["a: Yes", /boolean/],
      ["a: NO", /boolean/],
      ["a: on", /boolean/],
      ["a: y", /boolean/],
      ["a: null", /boolean or null/],
      ["a: ~", /boolean or null/],
      ["a: 1.0", /number/],
      ["a: 1.0.0", /number/],
      ["a: 42", /number/],
      ["a: 0x1F", /number/],
      ["a: 0o17", /number/],
      ["a: .inf", /number/],
      ["a: .NaN", /number/],
      ["a: 1:20", /number/],
      ["a: 2026-11-28", /date/],
      ["a: [x]", /indicator/],
      ["a: {x}", /indicator/],
      ["a: &x", /indicator/],
      ["a: *x", /indicator/],
      ["a: !x", /indicator/],
      ["a: |", /indicator/],
      ["a: >", /indicator/],
      ["a: @x", /indicator/],
      ["a: `x", /indicator/],
      ["a: %x", /indicator/],
      ["a: ,x", /indicator/],
      ["a: - x", /indicator/],
      ["a: ? x", /indicator/],
      ["a:", /empty value/],
      ["a: ''\nb:", /empty value/],
      ['a: "x" tail', /after the closing double quote/],
      ['a: "unterminated', /unterminated/],
      ["a: 'unterminated", /unterminated/],
      ['a: "bad \\x escape"', /unsupported escape/],
      ['a: "bad \\u12 escape"', /unsupported escape/],
      ["a: x\na: y", /duplicate key "a"/],
      ["m:\n  k: x\n  k: y", /duplicate key "m.k"/],
      ["a:\tx", /tabs/],
      ["a: x\n\tb: y", /tabs/],
      ["a: x\n   b: y", /exactly two spaces/],
      ["  a: x", /without a parent/],
      ["m:\n    k: x", /exactly two spaces|expected/],
      ["a: x\nb:value", /expected "key: value"/],
      ["-bad: x", /expected "key: value"/],
      ["not a pair", /expected "key: value"/],
    ];
    for (const [inner, re] of bad) {
      expect(() => parseFrontmatter(doc(inner)), inner).toThrow(re);
    }
  });

  it("rejects keys a YAML parser would retype, and control characters inside quoted values", () => {
    for (const key of ["yes", "on", "true", "null", "1", "1.5", "0x1", "2026-11-28"]) {
      expect(() => parseFrontmatter(doc(`${key}: v`)), key).toThrow(/use a word key/);
      expect(() => parseFrontmatter(doc(`m:\n  ${key}: v`)), `nested ${key}`).toThrow(/use a word key/);
    }
    for (const inner of ['a: "x\\u0000"', 'a: "\\u007f"', 'a: "\\u0085"', 'a: "\\u2028"', 'a: "\\ufeffx"', "a: 'x\u0001'", "a: 'x\u0085'"]) {
      expect(() => parseFrontmatter(doc(inner)), JSON.stringify(inner)).toThrow(/control character/);
    }
    expect(() => parseFrontmatter(doc("a: x\u0085y"))).toThrow(/control character/);
  });

  it("reports line numbers", () => {
    expect(() => parseFrontmatter("---\nname: x\ndescription: a: b\n---\n")).toThrow(/^line 3:/);
  });

  it("rejects a missing opening or closing ---", () => {
    expect(() => parseFrontmatter("name: x\n---\n")).toThrow(/must start with/);
    expect(() => parseFrontmatter("---\nname: x\n")).toThrow(/closing/);
    expect(() => parseFrontmatter("---\nname: x\n---x\n")).toThrow(/closing/);
  });

  it("reads CRLF input", () => {
    expect(parseFrontmatter("---\r\nname: x\r\n---\r\nbody").frontmatter).toEqual({ name: "x" });
  });
});

describe("skill-frontmatter: quoting and normalising", () => {
  it("quoteYamlString round-trips through parseFrontmatter", () => {
    const samples = ['a "b" c\\d', "tab\there", "line\nbreak", "caf\u00e9 \ud83d\ude00", "x: y #z"];
    for (const s of samples) {
      const q = quoteYamlString(s);
      expect(q.startsWith('"') && q.endsWith('"')).toBe(true);
      expect(parseFrontmatter(`---\nk: ${q}\n---\n`).frontmatter.k).toBe(s);
    }
  });

  it("normaliseFrontmatter quotes only the non-portable plain scalars", () => {
    const src = [
      "---",
      "name: my-skill",
      "description: Use it for: X, and \"Y\"",
      "metadata:",
      "  version: 1.0",
      "  sources: see NOTICE.md",
      '  ok: "already: quoted"',
      "---",
      "# Body: unchanged",
      "",
    ].join("\n");
    const n = normaliseFrontmatter(src);
    expect(n.changed).toEqual(["description", "metadata.version"]);
    expect(n.text).toBe(
      [
        "---",
        "name: my-skill",
        'description: "Use it for: X, and \\"Y\\""',
        "metadata:",
        '  version: "1.0"',
        "  sources: see NOTICE.md",
        '  ok: "already: quoted"',
        "---",
        "# Body: unchanged",
        "",
      ].join("\n")
    );
    const p = parseFrontmatter(n.text).frontmatter as any;
    expect(p.description).toBe('Use it for: X, and "Y"');
    expect(p.metadata.version).toBe("1.0");
    expect(normaliseFrontmatter(n.text)).toEqual({ text: n.text, changed: [] });
  });

  it("normaliseFrontmatter refuses a plain value holding \" #\" (YAML reads the rest as a comment)", () => {
    expect(() => normaliseFrontmatter("---\nname: x\ndescription: Use it for: X # a note\n---\n")).toThrow(/line 3: .*" #"/);
    // Inside quotes it is ordinary text and stays as it is.
    expect(normaliseFrontmatter('---\nname: x\ndescription: "a # b"\n---\n').changed).toEqual([]);
  });

  it("the old unquoted motion description normalises to the same string", () => {
    const current = fs.readFileSync(path.join(guidanceRoot, "motion-director", "SKILL.md"), "utf8");
    const want = parseFrontmatter(current).frontmatter.description as string;
    const old = current.replace(/^description: .*$/m, `description: ${want}`);
    expect(old).not.toBe(current);
    expect(() => parseFrontmatter(old)).toThrow(/contains ": "/);
    const n = normaliseFrontmatter(old);
    expect(n.changed).toEqual(["description"]);
    expect(n.text).toBe(current);
    expect(parseFrontmatter(n.text).frontmatter.description).toBe(want);
  });

  it("keeps CRLF line endings", () => {
    const n = normaliseFrontmatter("---\r\nname: x\r\ndescription: a: b\r\n---\r\nbody\r\n");
    expect(n.text).toBe('---\r\nname: x\r\ndescription: "a: b"\r\n---\r\nbody\r\n');
  });
});

describe("skill-frontmatter: validateSkillFrontmatter", () => {
  const ok = { name: "good-name", description: "Fine." };
  it("accepts a valid frontmatter", () => {
    expect(validateSkillFrontmatter(ok)).toEqual([]);
    expect(validateSkillFrontmatter({ ...ok, compatibility: "x".repeat(500), metadata: { a: "b" } })).toEqual([]);
    expect(validateSkillFrontmatter({ name: "a".repeat(64), description: "x".repeat(1024) })).toEqual([]);
  });
  it("rejects bad names, descriptions, compatibility and metadata", () => {
    for (const name of ["", "A", "-a", "a-", "a--b", "a_b", "a".repeat(65), undefined, 5]) {
      expect(validateSkillFrontmatter({ ...ok, name }), String(name)).not.toEqual([]);
    }
    for (const description of ["", "  ", undefined, "x".repeat(1025), 3]) {
      expect(validateSkillFrontmatter({ ...ok, description }), String(description)).not.toEqual([]);
    }
    expect(validateSkillFrontmatter({ ...ok, compatibility: "x".repeat(501) })).not.toEqual([]);
    expect(validateSkillFrontmatter({ ...ok, metadata: "x" })).not.toEqual([]);
    expect(validateSkillFrontmatter({ ...ok, metadata: { a: 1 } })).not.toEqual([]);
  });
});
